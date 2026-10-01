/**
 * Forbidden Lands Enhancements — Stronghold automation engine.
 *
 * Layers the Player's Handbook stronghold rules (ch. 8) on the system's own `stronghold`
 * actor and its `building` / `hireling` items. Nothing here changes the system's data model:
 * all module state lives in `fbl-enhancements` flags on the stronghold and its items.
 *
 * Time comes from the built-in calendar. On every `updateWorldTime` the ACTIVE GM's client
 * simulates every elapsed Quarter Day in memory (production, wages, spoilage, livestock,
 * reminders) and then writes the result in one batch, so a long jump never produces a write
 * (or a chat card) per quarter. Rewinding the clock never undoes or repeats production: the
 * stored `lastTickQ` anchor only ever moves forward.
 *
 * Items are identified by a key (see stronghold-data.js), not by name, so the automation
 * works in any language.
 */

import {
	MODULE_ID,
	PRICE_FLAG,
	addToPurse,
	creditCoins,
	deductCoins,
	deductFromPurse,
	formatPrice,
	fromCopper,
	isActiveGM,
	l,
	normalizePrice,
	parseCost,
	toCopper,
} from "./economy.js";
import {
	ANIMALS,
	AWAKENING_PHASE,
	BUILDINGS,
	HARVEST_PHASE,
	HIRELINGS,
	MAX_PER_COPY,
	OVERTIME_SALARY_FACTOR,
	QUARTERS_PER_DAY,
	RESOURCES,
	SHEAR_COOLDOWN_DAYS,
	WEEK_DAYS,
	matchKey,
} from "./stronghold-data.js";

export const ACTOR_TYPE = "stronghold";

const SETTING_AUTOMATION = "strongholdAutomation";
const SETTING_REQUIRE_STAFF = "strongholdRequireStaff";
const SETTING_CHAT_MODE = "strongholdChatMode";
const SETTING_CHAT_GM_ONLY = "strongholdChatGMOnly";
const SETTING_REMINDERS = "strongholdReminders";
const SETTING_EVENT_TABLE = "strongholdEventTable";
const SETTING_SPOILAGE = "strongholdSpoilage";
const SETTING_SPOILAGE_WARN = "strongholdSpoilageWarnDays";
const SETTING_AUTO_DEFENSE = "autoDefenseRating";

const KEY_FLAG = "strongholdKey";
const QUARTER_SECONDS = 21600;
const WEEK_QUARTERS = WEEK_DAYS * QUARTERS_PER_DAY;

/** A jump longer than this many Quarter Days asks the GM what to do (4 days). */
const JUMP_THRESHOLD_QUARTERS = 16;

/** Day-quarter indices as the calendar reports them. */
const Q_NIGHT = 0;
const Q_MORNING = 1;
const Q_DAY = 2;
const Q_EVENING = 3;

const setting = (key) => game.settings.get(MODULE_ID, key);
const num = (v) => Number(v) || 0;
const lk = (group, key) => game.i18n.localize(`FBL_ENHANCEMENTS.STRONGHOLD.${group}.${key}`);
const calendarApi = () => game.modules.get(MODULE_ID)?.api?.calendar;
const normalizeName = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").trim();

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

function registerStrongholdSettings() {
	const reg = (key, extra) =>
		game.settings.register(MODULE_ID, key, {
			name: `FBL_ENHANCEMENTS.STRONGHOLD.SETTINGS.${key}.NAME`,
			hint: `FBL_ENHANCEMENTS.STRONGHOLD.SETTINGS.${key}.HINT`,
			scope: "world",
			config: true,
			...extra,
		});

	reg(SETTING_AUTOMATION, { type: Boolean, default: true });
	reg(SETTING_REQUIRE_STAFF, { type: Boolean, default: true });
	reg(SETTING_CHAT_MODE, {
		type: String,
		default: "advance",
		choices: {
			off: "FBL_ENHANCEMENTS.STRONGHOLD.SETTINGS.CHAT_MODE.OFF",
			advance: "FBL_ENHANCEMENTS.STRONGHOLD.SETTINGS.CHAT_MODE.ADVANCE",
			daily: "FBL_ENHANCEMENTS.STRONGHOLD.SETTINGS.CHAT_MODE.DAILY",
		},
	});
	reg(SETTING_CHAT_GM_ONLY, { type: Boolean, default: false });
	reg(SETTING_REMINDERS, { type: Boolean, default: true });
	reg(SETTING_EVENT_TABLE, { type: String, default: "" });
	reg(SETTING_SPOILAGE, { type: Boolean, default: true });
	reg(SETTING_SPOILAGE_WARN, {
		type: new foundry.data.fields.NumberField({ min: 0, max: 5, step: 1, integer: true, nullable: false }),
		default: 1,
	});
	reg(SETTING_AUTO_DEFENSE, {
		type: Boolean,
		default: true,
		onChange: (value) => {
			if (value && isActiveGM()) void backfillDefense();
		},
	});
}

/* -------------------------------------------- */
/*  Item identification                         */
/* -------------------------------------------- */

/** The registry an item type's key lives in. Gear is tried as livestock first, then as a resource. */
function registriesFor(item) {
	switch (item.type) {
		case "building":
			return [[BUILDINGS, "BUILDINGS"]];
		case "hireling":
			return [[HIRELINGS, "HIRELINGS"]];
		case "rawMaterial":
			return [[RESOURCES, "RESOURCES"]];
		case "gear":
			return [
				[ANIMALS, "ANIMALS"],
				[RESOURCES, "RESOURCES"],
			];
		default:
			return [];
	}
}

/** Key guessed from the item's name in any shipped language, ignoring any override flag. */
export function guessKey(item) {
	for (const [registry, group] of registriesFor(item)) {
		const key = matchKey(registry, item.name, (k) => lk(group, k));
		if (key) return key;
	}
	return null;
}

/** Key from the item's override flag, else guessed from its name. */
export function keyOf(item) {
	return item.getFlag?.(MODULE_ID, KEY_FLAG) || guessKey(item);
}

/** Selectable keys (with localized labels) for an item type's role dropdown. */
export function keyOptions(itemType) {
	const [registry, group] = registriesFor({ type: itemType })[0] ?? [];
	if (!registry) return [];
	return Object.keys(registry)
		.map((key) => ({ key, label: lk(group, key) }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

export const itemFlags = (item) => item.flags?.[MODULE_ID] ?? {};

export function buildingMax(def, copies) {
	if (!def) return 0;
	switch (def.kind) {
		case "converter":
			return MAX_PER_COPY * copies;
		case "extractor":
			return MAX_PER_COPY * def.perWorker * copies;
		case "garden":
			return def.weekly.total * copies;
		case "livestock":
			return MAX_PER_COPY * copies;
		case "field":
			return def.yearly.outputs.grain * copies;
		default:
			return 0;
	}
}

/* -------------------------------------------- */
/*  Stronghold queries                          */
/* -------------------------------------------- */

const strongholds = () => (game.actors?.contents ?? []).filter((a) => a.type === ACTOR_TYPE);
const lastTickOf = (actor) => actor.getFlag(MODULE_ID, "lastTickQ");

export function getTreasury(actor) {
	return normalizePrice(actor.getFlag(MODULE_ID, "treasury"));
}

/** Total quantity of items of a livestock key. */
export function headCount(actor, animalKey) {
	let total = 0;
	for (const item of actor.items) {
		if ((item.type === "gear" || item.type === "rawMaterial") && keyOf(item) === animalKey) {
			total += Math.max(0, num(item.system.quantity));
		}
	}
	return total;
}

function hirelingQty(actor, roleKey, { includeDeployed = true } = {}) {
	let total = 0;
	for (const item of actor.items) {
		if (item.type !== "hireling" || keyOf(item) !== roleKey) continue;
		if (!includeDeployed && itemFlags(item).deployed) continue;
		total += Math.max(0, num(item.system.quantity));
	}
	return total;
}

/** Daily wage of a hireling item in copper (own salary text first, then the book rate). */
export function hirelingDailyCopper(item) {
	const def = HIRELINGS[keyOf(item)];
	if (def?.perEvent) return 0;
	const parsed = parseCost(item.system?.salary);
	const rate = parsed ? toCopper(parsed) : (def?.salaryCopper ?? 0);
	const factor = itemFlags(item).overtime ? OVERTIME_SALARY_FACTOR : 1;
	return rate * Math.max(0, num(item.system?.quantity)) * factor;
}

export function totalDailyCopper(actor) {
	return actor.items.filter((i) => i.type === "hireling").reduce((sum, i) => sum + hirelingDailyCopper(i), 0);
}

/** How many staff a building can use, how many it has, for the sheet indicator. */
export function staffInfo(actor, building) {
	const key = keyOf(building);
	const def = BUILDINGS[key];
	if (!def?.staff) return null;
	const copies = Math.max(1, num(building.system.quantity));
	const need =
		def.kind === "converter" ? copies : def.kind === "extractor" ? MAX_PER_COPY * copies : 1;
	const pc = itemFlags(building).pcStaffed ? 1 : 0;
	const have = hirelingQty(actor, def.staff, { includeDeployed: false }) + pc;
	return { need, have, ok: have >= (def.kind === "converter" || def.kind === "extractor" ? 1 : need) };
}

/* -------------------------------------------- */
/*  Defense                                     */
/* -------------------------------------------- */

/** Stronghold Defense Rating per the book (p.175-176), with a per-line breakdown. */
export function computeDefense(actor) {
	const flags = actor.flags?.[MODULE_ID] ?? {};
	const parts = [];
	if (flags.defense?.pcsPresent) parts.push({ label: l("STRONGHOLD.DEFENSE.PCS"), value: 1 });

	const guards = hirelingQty(actor, "guard", { includeDeployed: false });
	if (guards > 0) {
		parts.push({
			label: l("STRONGHOLD.DEFENSE.GUARDS").replace("{n}", String(guards)),
			value: Math.min(5, Math.ceil(guards / 10)),
		});
	}
	if (flags.defense?.guardsHungry) parts.push({ label: l("STRONGHOLD.DEFENSE.HUNGRY"), value: -1 });

	const seen = new Set();
	for (const item of actor.items) {
		if (item.type !== "building") continue;
		const key = keyOf(item);
		const def = BUILDINGS[key];
		if (!def?.defense || seen.has(key)) continue;
		seen.add(key);
		parts.push({ label: lk("BUILDINGS", key), value: def.defense });
	}
	return { total: Math.max(0, parts.reduce((s, p) => s + p.value, 0)), parts };
}

/** Reputation bonus the stronghold's functions grant (each function counts once). */
export function computeReputation(actor) {
	const parts = [];
	const seen = new Set();
	for (const item of actor.items) {
		if (item.type !== "building") continue;
		const key = keyOf(item);
		const def = BUILDINGS[key];
		if (!def?.reputation || seen.has(key)) continue;
		seen.add(key);
		parts.push({ label: lk("BUILDINGS", key), value: def.reputation });
	}
	return { total: parts.reduce((s, p) => s + p.value, 0), parts };
}

async function updateDefense(actor) {
	if (!setting(SETTING_AUTO_DEFENSE) || !isActiveGM() || actor?.type !== ACTOR_TYPE) return;
	const { total } = computeDefense(actor);
	if (num(actor.system?.defenseRating) === total) return;
	await actor.update({ "system.defenseRating": total }, { fblStrongholdDefense: true });
}

async function backfillDefense() {
	for (const actor of strongholds()) {
		try {
			await updateDefense(actor);
		} catch (err) {
			console.warn(`${MODULE_ID} | stronghold: defense backfill failed for ${actor.name}`, err);
		}
	}
}

/* -------------------------------------------- */
/*  Simulation state                            */
/* -------------------------------------------- */

const newReport = () => ({
	produced: {}, // who -> { key: n }
	consumed: {}, // key -> n
	spoiled: {}, // key -> n
	soon: [], // { key, qty, days }
	births: [], // { animal, count, formula, head, cap }
	harvest: [], // { who, outputs }
	notes: [], // plain localized lines
	salaryPaid: 0, // copper
	unpaid: [], // { name, qty, owed }
});

const tally = (map, key, n) => {
	if (n) map[key] = (map[key] ?? 0) + n;
};

/** Read every stronghold fact the simulation needs into plain objects. */
function readState(actor, lastQ) {
	const flags = actor.flags?.[MODULE_ID] ?? {};
	const st = {
		actor,
		lastQ,
		treasury: { ...getTreasury(actor) },
		anchors: { events: flags.anchors?.events, upkeep: flags.anchors?.upkeep, unguarded: flags.anchors?.unguarded },
		pcsPresent: !!flags.defense?.pcsPresent,
		stock: new Map(), // key -> { initial, current, items: [] }
		cohorts: new Map(), // key -> [{ qty, createdQ, warned }]
		buildings: [],
		hirelings: [],
		hasRootCellar: false,
		report: newReport(),
		reminders: new Map(), // "kind|name" -> count
		nonpay: new Set(),
		unpaid: new Map(), // hireling id -> { name, qty, owed }
	};

	for (const item of actor.items) {
		const key = keyOf(item);
		if (item.type === "building") {
			const def = BUILDINGS[key];
			if (key === "rootCellar") st.hasRootCellar = true;
			const itemFlagsCopy = foundry.utils.deepClone(itemFlags(item));
			st.buildings.push({
				item,
				key,
				def,
				copies: Math.max(1, num(item.system.quantity)),
				flags: itemFlagsCopy,
				orig: JSON.stringify(itemFlagsCopy),
			});
		} else if (item.type === "hireling") {
			const flagsCopy = foundry.utils.deepClone(itemFlags(item));
			st.hirelings.push({
				item,
				key,
				def: HIRELINGS[key],
				qty: Math.max(0, num(item.system.quantity)),
				overtime: !!flagsCopy.overtime,
				deployed: !!flagsCopy.deployed,
				flags: flagsCopy,
				orig: JSON.stringify(flagsCopy),
			});
		} else if ((item.type === "rawMaterial" || item.type === "gear") && key && (RESOURCES[key] || ANIMALS[key])) {
			const entry = stockEntry(st, key);
			const qty = Math.max(0, num(item.system.quantity));
			entry.initial += qty;
			entry.current += qty;
			entry.items.push(item);
		}
	}

	// Cohorts: stored as a flat array so a write replaces them instead of merging stale keys.
	for (const c of flags.cohorts ?? []) {
		if (!c?.key || !(c.qty > 0)) continue;
		if (!st.cohorts.has(c.key)) st.cohorts.set(c.key, []);
		st.cohorts.get(c.key).push({ qty: c.qty, createdQ: c.createdQ, warned: !!c.warned });
	}
	for (const [key, entry] of st.stock) {
		if (!RESOURCES[key]?.shelfLifeDays) continue;
		const list = st.cohorts.get(key) ?? [];
		const sum = list.reduce((s, c) => s + c.qty, 0);
		if (sum > entry.initial) trimCohorts(list, sum - entry.initial);
		else if (sum < entry.initial) list.push({ qty: entry.initial - sum, createdQ: lastQ, warned: false });
		st.cohorts.set(key, list);
	}
	for (const key of [...st.cohorts.keys()]) if (!st.stock.has(key)) st.cohorts.delete(key);

	return st;
}

function stockEntry(st, key) {
	let entry = st.stock.get(key);
	if (!entry) {
		entry = { initial: 0, current: 0, items: [] };
		st.stock.set(key, entry);
	}
	return entry;
}

const stockOf = (st, key) => st.stock.get(key)?.current ?? 0;

/** Remove `n` units from the oldest cohorts first. */
function trimCohorts(list, n) {
	let left = n;
	for (const c of list) {
		const take = Math.min(c.qty, left);
		c.qty -= take;
		left -= take;
		if (left <= 0) break;
	}
	for (let i = list.length - 1; i >= 0; i--) if (list[i].qty <= 0) list.splice(i, 1);
}

function addStock(st, key, n, q) {
	if (!(n > 0)) return;
	stockEntry(st, key).current += n;
	if (RESOURCES[key]?.shelfLifeDays) {
		if (!st.cohorts.has(key)) st.cohorts.set(key, []);
		st.cohorts.get(key).push({ qty: n, createdQ: q, warned: false });
	}
}

/** Take up to `n` units; returns how many were actually taken. */
function takeStock(st, key, n) {
	const entry = st.stock.get(key);
	if (!entry || !(n > 0)) return 0;
	const taken = Math.min(n, entry.current);
	entry.current -= taken;
	if (st.cohorts.has(key)) trimCohorts(st.cohorts.get(key), taken);
	return taken;
}

/* -------------------------------------------- */
/*  Quarter simulation                          */
/* -------------------------------------------- */

/**
 * Wages are due once a day. They are attempted every morning for everyone, and again in any
 * later quarter for a hireling who is about to work but has not been paid for the day (a clock
 * that starts mid-day, or a treasury funded after the morning). A hireling who cannot be paid is
 * flagged `unpaid` and does not work until the treasury covers the wage.
 */
function paySalaries(st, q, date) {
	const dq = date.dayQuarterIndex;
	const day = date.dayIndex;
	const working = dq === Q_MORNING || dq === Q_DAY;
	for (const h of st.hirelings) {
		if (h.def?.perEvent || h.qty <= 0 || h.flags.paidDay === day) continue;
		if (dq !== Q_MORNING && !(working || (dq === Q_EVENING && h.overtime))) continue;

		const parsed = parseCost(h.item.system?.salary);
		const rate = parsed ? toCopper(parsed) : (h.def?.salaryCopper ?? 0);
		if (!rate) continue;
		const owed = rate * h.qty * (h.overtime ? OVERTIME_SALARY_FACTOR : 1);

		const purse = deductFromPurse(st.treasury, fromCopper(owed));
		if (purse) {
			st.treasury = purse;
			st.report.salaryPaid += owed;
			h.flags.paidDay = day;
			if (h.flags.unpaid) {
				h.flags.unpaid = null;
				h.flags.unpaidSinceQ = null;
				h.flags.lastNonPayQ = null;
			}
			continue;
		}

		st.unpaid.set(h.item.id, { name: h.item.name, qty: h.qty, owed });
		if (!h.flags.unpaid) {
			h.flags.unpaid = true;
			h.flags.unpaidSinceQ = q;
			h.flags.lastNonPayQ = q;
			st.nonpay.add(h.item.name);
		} else if (q - num(h.flags.lastNonPayQ) >= WEEK_QUARTERS) {
			h.flags.lastNonPayQ = q;
			st.nonpay.add(h.item.name);
		}
	}
}

/** Pick the `inputsAny` variant that allows the most runs; plain `inputs` pass through. */
function resolveInputs(st, def) {
	const variants = def.inputsAny ?? [def.inputs ?? {}];
	let best = { inputs: variants[0], runs: -1 };
	for (const inputs of variants) {
		const entries = Object.entries(inputs);
		const runs = entries.length
			? Math.min(...entries.map(([key, n]) => Math.floor(stockOf(st, key) / n)))
			: Infinity;
		if (runs > best.runs) best = { inputs, runs };
	}
	return best;
}

function produce(st, who, outputs, q, factor = 1) {
	for (const [key, n] of Object.entries(outputs)) {
		const amount = n * factor;
		if (!(amount > 0)) continue;
		addStock(st, key, amount, q);
		st.report.produced[who] ??= {};
		tally(st.report.produced[who], key, amount);
	}
}

function remind(st, kind, name = "") {
	const id = `${kind}|${name}`;
	st.reminders.set(id, (st.reminders.get(id) ?? 0) + 1);
}

async function rollTotal(formula) {
	const roll = await new Roll(formula).evaluate();
	return roll.total;
}

async function simulateQuarter(st, q, date, season) {
	const requireStaff = setting(SETTING_REQUIRE_STAFF);
	const dq = date.dayQuarterIndex;
	const working = dq === Q_MORNING || dq === Q_DAY;
	const evening = dq === Q_EVENING;
	const report = st.report;

	paySalaries(st, q, date);

	// Staff available this quarter by role. Evening: only hirelings on overtime.
	const pool = {};
	let farmers = 0;
	for (const h of st.hirelings) {
		if (!h.key || h.def?.field || h.flags.unpaid) continue;
		if (h.key === "farmer") farmers += h.qty;
		const n = working ? h.qty : evening && h.overtime ? h.qty : 0;
		pool[h.key] = (pool[h.key] ?? 0) + n;
	}
	const paid = st.hirelings.filter((h) => !h.flags.unpaid);
	const guards = paid.filter((h) => h.key === "guard").reduce((s, h) => s + h.qty, 0);
	const handymen = paid.filter((h) => h.key === "handyman").reduce((s, h) => s + h.qty, 0);

	const headLeft = {};

	for (const b of st.buildings) {
		const def = b.def;
		if (!def || !b.flags.active) continue;
		const who = b.item.name;

		if (def.kind === "converter" || def.kind === "extractor") {
			if (!(working || evening)) continue;
			const slots = def.kind === "extractor" ? MAX_PER_COPY * b.copies : b.copies;
			const fromPool = Math.min(pool[def.staff] ?? 0, slots);
			pool[def.staff] = (pool[def.staff] ?? 0) - fromPool;
			const pc = working && b.flags.pcStaffed ? 1 : 0;
			let staffed = Math.min(slots, fromPool + pc);
			if (!requireStaff && working) staffed = slots;
			if (staffed <= 0) continue;

			const unit = def.kind === "extractor" ? def.perWorker : MAX_PER_COPY;
			const target = b.flags.target > 0 ? b.flags.target : buildingMax(def, b.copies);
			const cap = Math.min(target, staffed * unit);

			if (def.kind === "extractor") {
				produce(st, who, def.outputs, q, cap);
			} else {
				const { inputs, runs: maxRuns } = resolveInputs(st, def);
				const runs = Math.min(cap, maxRuns);
				if (!(runs > 0)) continue;
				for (const [key, n] of Object.entries(inputs)) {
					tally(report.consumed, key, takeStock(st, key, n * runs));
				}
				produce(st, who, def.outputs, q, runs);
			}

			if (def.reminder === "mineCollapse") {
				if (b.flags.reminderAnchorQ == null) b.flags.reminderAnchorQ = q;
				else if (q - b.flags.reminderAnchorQ >= WEEK_QUARTERS) {
					b.flags.reminderAnchorQ = q;
					remind(st, "mineCollapse", who);
				}
			}
			continue;
		}

		// Periodic jobs are short (a Quarter Day a day or a week): one farmer or a PC is enough.
		const staffed = !requireStaff || farmers > 0 || b.flags.pcStaffed;

		if (def.kind === "field") {
			if (dq !== Q_MORNING || date.phaseIndex !== HARVEST_PHASE || date.dayInPhase !== 0) continue;
			const yearKey = `${date.year}:harvest`;
			if (b.flags.lastYearlyKey === yearKey) continue;
			b.flags.lastYearlyKey = yearKey;
			if (!staffed) {
				report.notes.push(l("STRONGHOLD.CARD.NO_HARVEST").replace("{name}", who));
				continue;
			}
			produce(st, who, def.yearly.outputs, q, b.copies);
			report.harvest.push({ who, outputs: Object.fromEntries(Object.entries(def.yearly.outputs).map(([k, n]) => [k, n * b.copies])) });
			continue;
		}

		if (def.kind === "garden") {
			if (b.flags.gardenAnchorQ == null) {
				b.flags.gardenAnchorQ = q;
				continue;
			}
			if (q - b.flags.gardenAnchorQ < WEEK_QUARTERS) continue;
			const inSeason = def.weekly.seasons.includes(season);
			b.flags.gardenAnchorQ = inSeason ? b.flags.gardenAnchorQ + WEEK_QUARTERS : q;
			if (!inSeason || !staffed) continue;
			const total = def.weekly.total * b.copies;
			const veg = Math.max(0, Math.min(total, b.flags.garden?.veg ?? total));
			const herbs = Math.max(0, Math.min(total - veg, b.flags.garden?.herbs ?? 0));
			produce(st, who, { vegetables: veg, herbs }, q);
			continue;
		}

		if (def.kind === "livestock") {
			const animal = ANIMALS[def.animal];
			headLeft[def.animal] ??= stockOf(st, def.animal);
			const capacity = MAX_PER_COPY * b.copies;
			const head = Math.min(headLeft[def.animal], capacity);
			headLeft[def.animal] -= head;
			if (dq !== Q_MORNING || !staffed || head <= 0) continue;

			if (def.daily) produce(st, who, def.daily, q, head);

			if (date.phaseIndex === AWAKENING_PHASE && date.dayInPhase === 0) {
				const yearKey = `${date.year}:birth`;
				if (b.flags.lastBirthKey === yearKey) continue;
				b.flags.lastBirthKey = yearKey;
				if (animal.needsBull && !b.flags.hasBull) continue;
				const count = await rollTotal(animal.birth);
				addStock(st, def.animal, count, q);
				report.births.push({ animal: def.animal, count, formula: animal.birth, head: head + count, cap: capacity });
			}
		}
	}

	// Hirelings working outside the stronghold.
	for (const h of st.hirelings) {
		if (!h.def?.field || !h.deployed || h.qty <= 0 || h.flags.unpaid) continue;
		const factor = working ? h.qty : evening && h.overtime ? h.qty : 0;
		if (factor) produce(st, h.item.name, h.def.field.outputs, q, factor);
		if (h.def.reminder === "hunterAttack" && (working || evening || dq === Q_NIGHT)) {
			if (h.flags.reminderAnchorQ == null) h.flags.reminderAnchorQ = q;
			else if (q - h.flags.reminderAnchorQ >= WEEK_QUARTERS) {
				h.flags.reminderAnchorQ = q;
				remind(st, "hunterAttack", `${h.item.name} (${h.qty})`);
			}
		}
	}

	if (setting(SETTING_SPOILAGE)) spoil(st, q);

	// Weekly stronghold reminders.
	const guarded = guards > 0 || st.pcsPresent;
	for (const kind of ["events", "upkeep", "unguarded"]) {
		if (st.anchors[kind] == null) {
			st.anchors[kind] = q;
			continue;
		}
		if (q - st.anchors[kind] < WEEK_QUARTERS) continue;
		st.anchors[kind] = q;
		if (kind === "events" && guarded) remind(st, "events");
		if (kind === "upkeep" && handymen <= 0) remind(st, "upkeep");
		if (kind === "unguarded" && !guarded) remind(st, "unguarded");
	}
}

function spoil(st, q) {
	const warnDays = num(setting(SETTING_SPOILAGE_WARN));
	for (const [key, list] of st.cohorts) {
		const def = RESOURCES[key];
		if (!def?.shelfLifeDays || !list.length) continue;
		const life = def.shelfLifeDays * QUARTERS_PER_DAY * (def.rootCellar && st.hasRootCellar ? 10 : 1);

		let lost = 0;
		for (const c of list) {
			if (q - c.createdQ >= life) {
				lost += c.qty;
				c.qty = 0;
			}
		}
		if (lost > 0) {
			for (let i = list.length - 1; i >= 0; i--) if (list[i].qty <= 0) list.splice(i, 1);
			stockEntry(st, key).current -= lost;
			tally(st.report.spoiled, key, lost);
		}

		if (warnDays > 0 && life >= WEEK_QUARTERS) {
			for (const c of list) {
				if (c.warned || q - c.createdQ + warnDays * QUARTERS_PER_DAY < life) continue;
				c.warned = true;
				st.report.soon.push({ key, qty: c.qty, days: Math.max(1, Math.ceil((life - (q - c.createdQ)) / QUARTERS_PER_DAY)) });
			}
		}
	}
}

/** Run every elapsed quarter in memory. */
async function simulate(st, toQ) {
	const cal = calendarApi();
	const config = cal.getConfig();
	for (let q = st.lastQ + 1; q <= toQ; q++) {
		const date = cal.worldTimeToDate(q * QUARTER_SECONDS, config);
		await simulateQuarter(st, q, date, cal.getSeason(date.phaseIndex));
	}
}

/* -------------------------------------------- */
/*  Commit                                      */
/* -------------------------------------------- */

const templateCache = new Map();

async function stockItemData(key) {
	const isAnimal = !!ANIMALS[key];
	const label = isAnimal ? lk("ANIMALS", key) : lk("RESOURCES", key);
	const types = ["rawMaterial", "gear"];

	let source = game.items.find(
		(i) => types.includes(i.type) && (i.getFlag(MODULE_ID, KEY_FLAG) === key || normalizeName(i.name) === normalizeName(label)),
	);
	if (!source) {
		for (const pack of game.packs.filter((p) => p.documentName === "Item")) {
			const entry = pack.index.find((e) => types.includes(e.type) && normalizeName(e.name) === normalizeName(label));
			if (entry) {
				source = await pack.getDocument(entry._id);
				break;
			}
		}
	}

	const data = source
		? source.toObject()
		: { name: label, type: isAnimal ? "gear" : "rawMaterial", system: {}, flags: {} };
	delete data._id;
	delete data.folder;
	delete data.ownership;
	data.flags ??= {};
	data.flags[MODULE_ID] = { ...(data.flags[MODULE_ID] ?? {}), [KEY_FLAG]: key };
	const priceCopper = RESOURCES[key]?.priceCopper;
	if (priceCopper && !data.flags[MODULE_ID][PRICE_FLAG]) data.flags[MODULE_ID][PRICE_FLAG] = fromCopper(priceCopper);
	return data;
}

async function commit(st, { toQ } = {}) {
	const actor = st.actor;
	const options = { fblStrongholdTick: true };
	const updates = [];
	const deletes = [];
	const creates = [];

	for (const b of [...st.buildings, ...st.hirelings]) {
		if (JSON.stringify(b.flags) !== b.orig) updates.push({ _id: b.item.id, flags: { [MODULE_ID]: b.flags } });
	}

	for (const [key, entry] of st.stock) {
		const delta = entry.current - entry.initial;
		if (!delta) continue;
		if (delta > 0) {
			if (entry.items.length) {
				const first = entry.items[0];
				updates.push({ _id: first.id, "system.quantity": Math.max(0, num(first.system.quantity)) + delta });
			} else {
				let data = templateCache.get(key);
				if (!data) templateCache.set(key, (data = await stockItemData(key)));
				const copy = foundry.utils.deepClone(data);
				copy.system = { ...(copy.system ?? {}), quantity: delta };
				creates.push(copy);
			}
		} else {
			let remaining = -delta;
			for (const item of entry.items) {
				if (remaining <= 0) break;
				const have = Math.max(0, num(item.system.quantity));
				const take = Math.min(have, remaining);
				remaining -= take;
				if (have - take <= 0) deletes.push(item.id);
				else updates.push({ _id: item.id, "system.quantity": have - take });
			}
		}
	}

	// The anchor and treasury go first: if an item write fails afterwards, a quarter is lost
	// rather than replayed (and its wages charged again) on the next clock step.
	const cohorts = [];
	for (const [key, list] of st.cohorts) for (const c of list) cohorts.push({ key, ...c });
	const anchors = Object.fromEntries(Object.entries(st.anchors).filter(([, v]) => v != null));
	const flagUpdate = { treasury: st.treasury, cohorts, anchors };
	if (toQ !== undefined) flagUpdate.lastTickQ = toQ;
	await actor.update({ flags: { [MODULE_ID]: flagUpdate } }, options);

	if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, options);
	if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes, options);
	if (creates.length) await actor.createEmbeddedDocuments("Item", creates, options);
}

/* -------------------------------------------- */
/*  Chat output                                 */
/* -------------------------------------------- */

const { renderTemplate } = foundry.applications.handlebars;

const resourceLabel = (key) => (ANIMALS[key] ? lk("ANIMALS", key) : lk("RESOURCES", key));

function formatMap(map) {
	return Object.entries(map)
		.filter(([, n]) => n > 0)
		.map(([key, n]) => `${n} ${resourceLabel(key)}`)
		.join(", ");
}

function reportIsEmpty(r) {
	return (
		!Object.keys(r.produced).length &&
		!Object.keys(r.consumed).length &&
		!Object.keys(r.spoiled).length &&
		!r.soon.length &&
		!r.births.length &&
		!r.harvest.length &&
		!r.notes.length &&
		!r.salaryPaid &&
		!r.unpaid.length
	);
}

function mergeReports(a, b) {
	const out = newReport();
	for (const src of [a, b]) {
		for (const [who, map] of Object.entries(src.produced)) {
			out.produced[who] ??= {};
			for (const [k, n] of Object.entries(map)) tally(out.produced[who], k, n);
		}
		for (const [k, n] of Object.entries(src.consumed)) tally(out.consumed, k, n);
		for (const [k, n] of Object.entries(src.spoiled)) tally(out.spoiled, k, n);
		out.soon.push(...src.soon);
		out.births.push(...src.births);
		out.harvest.push(...src.harvest);
		out.notes.push(...src.notes);
		out.salaryPaid += src.salaryPaid;
		out.unpaid.push(...src.unpaid);
	}
	return out;
}

async function postChat(actor, content) {
	const data = { content, speaker: { alias: actor.name } };
	if (setting(SETTING_CHAT_GM_ONLY)) data.whisper = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
	return ChatMessage.create(data);
}

async function postReport(actor, report, title) {
	const unit = (key) => resourceLabel(key);
	const context = {
		title: `${actor.name} — ${title ?? l("STRONGHOLD.CARD.TITLE")}`,
		production: Object.entries(report.produced).map(([who, map]) => ({ who, text: formatMap(map) })),
		consumed: formatMap(report.consumed),
		salaryPaid: report.salaryPaid ? formatPrice(fromCopper(report.salaryPaid)) : "",
		unpaid: report.unpaid.map((u) => `${u.name} ×${u.qty}: ${formatPrice(fromCopper(u.owed))}`),
		spoiled: formatMap(report.spoiled),
		soon: report.soon.map((s) => l("STRONGHOLD.CARD.SOON_LINE").replace("{n}", String(s.qty)).replace("{name}", unit(s.key)).replace("{days}", String(s.days))),
		births: report.births.map((b) => {
			const line = l("STRONGHOLD.CARD.BIRTH_LINE")
				.replace("{n}", String(b.count))
				.replace("{name}", lk("ANIMALS", b.animal))
				.replace("{formula}", b.formula)
				.replace("{head}", String(b.head))
				.replace("{cap}", String(b.cap));
			return { text: line, over: b.head > b.cap };
		}),
		harvest: report.harvest.map((h) => ({ who: h.who, text: formatMap(h.outputs) })),
		notes: report.notes,
	};
	await postChat(actor, await renderTemplate(`modules/${MODULE_ID}/templates/stronghold-card.hbs`, context));
}

async function postReminders(st) {
	if (!setting(SETTING_REMINDERS) && !st.nonpay.size) return;
	const post = async (kind, { names = "", table = null, link = "", count = 1 } = {}) => {
		const rows = table ? [1, 2, 3, 4, 5, 6].map((i) => lk(`TABLE.${table}`, String(i))) : [];
		const content = await renderTemplate(`modules/${MODULE_ID}/templates/stronghold-reminder.hbs`, {
			title: `${st.actor.name} — ${lk(`REMINDER.${kind}`, "TITLE")}${count > 1 ? ` ×${count}` : ""}`,
			body: lk(`REMINDER.${kind}`, "BODY"),
			names,
			table: rows,
			link,
		});
		await postChat(st.actor, content);
	};

	if (st.nonpay.size) await post("NONPAY", { names: [...st.nonpay].join(", "), table: "NONPAY" });
	if (!setting(SETTING_REMINDERS)) return;

	const tables = { upkeep: "UPKEEP", unguarded: "UNGUARDED" };
	for (const [id, count] of st.reminders) {
		const [kind, name] = id.split("|");
		let link = "";
		if (kind === "events") {
			const uuid = String(setting(SETTING_EVENT_TABLE) || "").trim();
			if (uuid) link = await foundry.applications.ux.TextEditor.implementation.enrichHTML(`@UUID[${uuid}]`);
		}
		await post(kind.toUpperCase().replace("MINECOLLAPSE", "MINE_COLLAPSE").replace("HUNTERATTACK", "HUNTER_ATTACK"), {
			names: name,
			table: tables[kind] ?? null,
			link,
			count,
		});
	}
}

/** Deliver a finished simulation according to the chat-mode setting. */
async function publish(st, toQ) {
	st.report.unpaid = [...st.unpaid.values()];
	const mode = setting(SETTING_CHAT_MODE);
	if (mode !== "off" && !reportIsEmpty(st.report)) {
		if (mode === "daily") {
			// Stored as a string: building names may contain dots, which break flag-key paths.
			const stored = st.actor.getFlag(MODULE_ID, "digest");
			const digest = stored ? JSON.parse(stored) : null;
			const merged = digest ? mergeReports(digest.report, st.report) : st.report;
			const fromQ = digest?.fromQ ?? st.lastQ;
			if (Math.floor(toQ / QUARTERS_PER_DAY) > Math.floor(fromQ / QUARTERS_PER_DAY)) {
				await postReport(st.actor, merged, l("STRONGHOLD.CARD.DAILY_TITLE"));
				await st.actor.update({ [`flags.${MODULE_ID}.-=digest`]: null }, { fblStrongholdTick: true });
			} else {
				await st.actor.update({ [`flags.${MODULE_ID}.digest`]: JSON.stringify({ fromQ, report: merged }) }, { fblStrongholdTick: true });
			}
		} else {
			await postReport(st.actor, st.report);
		}
	}
	await postReminders(st);
}

/* -------------------------------------------- */
/*  Ticking                                     */
/* -------------------------------------------- */

const queues = new Map();

/** Serialize work per stronghold so quick successive clock steps never overlap. */
function enqueue(actor, task) {
	const next = (queues.get(actor.id) ?? Promise.resolve()).catch(() => {}).then(task);
	queues.set(actor.id, next);
	return next;
}

/** Highest quarter already simulated this session, per stronghold (guards against a failed persist). */
const processedQ = new Map();

async function tickActor(actor, nowQ) {
	const stored = lastTickOf(actor);
	if (typeof stored !== "number") {
		await actor.setFlag(MODULE_ID, "lastTickQ", nowQ);
		processedQ.set(actor.id, nowQ);
		return;
	}
	// Rewinding never repeats or reverts anything: the anchor only moves forward.
	const last = Math.max(stored, processedQ.get(actor.id) ?? stored);
	if (nowQ <= last) return;
	processedQ.set(actor.id, nowQ);

	console.log(`${MODULE_ID} | stronghold: ${actor.name} quarters ${last} -> ${nowQ}`);
	const st = readState(actor, last);
	await simulate(st, nowQ);
	await commit(st, { toQ: nowQ });
	await publish(st, nowQ);
	await updateDefense(actor);
}

let jumpDialogOpen = false;

async function askLargeJump(days) {
	const { DialogV2 } = foundry.applications.api;
	return DialogV2.wait({
		window: { title: l("STRONGHOLD.JUMP.TITLE") },
		content: `<p>${l("STRONGHOLD.JUMP.BODY").replace("{days}", String(days))}</p><p><i>${l("STRONGHOLD.JUMP.HINT")}</i></p>`,
		buttons: [
			{ action: "simulate", label: l("STRONGHOLD.JUMP.SIMULATE"), icon: "fas fa-play" },
			{ action: "skip", label: l("STRONGHOLD.JUMP.SKIP"), icon: "fas fa-forward", default: true },
			{ action: "cancel", label: l("STRONGHOLD.JUMP.CANCEL"), icon: "fas fa-rotate-left" },
		],
		rejectClose: false,
	});
}

async function onWorldTime(now, dt) {
	if (!setting(SETTING_AUTOMATION)) return;
	const nowQ = Math.floor(now / QUARTER_SECONDS);
	const actors = strongholds();

	const gaps = actors
		.map((a) => (typeof lastTickOf(a) === "number" ? nowQ - lastTickOf(a) : 0))
		.filter((gap) => gap > JUMP_THRESHOLD_QUARTERS);

	if (dt > 0 && gaps.length) {
		if (jumpDialogOpen) return;
		jumpDialogOpen = true;
		let choice = null;
		try {
			choice = await askLargeJump(Math.floor(Math.max(...gaps) / QUARTERS_PER_DAY));
		} finally {
			jumpDialogOpen = false;
		}
		if (choice === "cancel") return void (await game.time.advance(-dt));
		if (choice === "skip") {
			const target = Math.floor(game.time.worldTime / QUARTER_SECONDS);
			for (const actor of actors) {
				processedQ.set(actor.id, target);
				await enqueue(actor, () => actor.setFlag(MODULE_ID, "lastTickQ", target));
			}
			return;
		}
		if (choice !== "simulate") return;
	}

	const targetQ = Math.floor(game.time.worldTime / QUARTER_SECONDS);
	for (const actor of actors) {
		enqueue(actor, () => tickActor(actor, targetQ)).catch((err) => {
			console.error(`${MODULE_ID} | stronghold: tick failed for ${actor.name}`, err);
			ui.notifications?.error(l("STRONGHOLD.ERROR.TICK").replace("{name}", actor.name));
		});
	}
}

/* -------------------------------------------- */
/*  Manual actions (livestock)                  */
/* -------------------------------------------- */

/** Run a one-off change against a freshly-read state, commit it and post a card. */
function runManual(actor, title, fn) {
	return enqueue(actor, async () => {
		const q = Math.floor(game.time.worldTime / QUARTER_SECONDS);
		const st = readState(actor, lastTickOf(actor) ?? q);
		const ok = await fn(st, q);
		if (ok === false) return false;
		await commit(st);
		st.report.unpaid = [];
		if (!reportIsEmpty(st.report)) await postReport(actor, st.report, title);
		await updateDefense(actor);
		return true;
	});
}

export function slaughter(actor, building, count) {
	const def = BUILDINGS[keyOf(building)];
	const animal = ANIMALS[def?.animal];
	if (!animal) return Promise.resolve(false);
	return runManual(actor, l("STRONGHOLD.CARD.SLAUGHTER"), (st, q) => {
		const taken = takeStock(st, def.animal, count);
		if (!taken) return false;
		produce(st, building.name, { meat: animal.meat }, q, taken);
		st.report.notes.push(l("STRONGHOLD.CARD.SLAUGHTERED").replace("{n}", String(taken)).replace("{name}", lk("ANIMALS", def.animal)));
		return true;
	});
}

/** Sheep that can be sheared now: the flock minus batches still on cooldown. */
export function shearableCount(actor, building) {
	const today = Math.floor(game.time.worldTime / 86400);
	const cooling = (itemFlags(building).shear?.cooldowns ?? [])
		.filter((c) => c.availableAtDay > today)
		.reduce((s, c) => s + c.count, 0);
	return Math.max(0, headCount(actor, "sheep") - cooling);
}

export function shear(actor, building, count) {
	const animal = ANIMALS.sheep;
	return runManual(actor, l("STRONGHOLD.CARD.SHEAR"), (st, q) => {
		const today = Math.floor(game.time.worldTime / 86400);
		const target = st.buildings.find((b) => b.item.id === building.id);
		if (!target) return false;
		const cooldowns = (target.flags.shear?.cooldowns ?? []).filter((c) => c.availableAtDay > today);
		const cooling = cooldowns.reduce((s, c) => s + c.count, 0);
		const n = Math.min(count, Math.max(0, stockOf(st, "sheep") - cooling));
		if (n <= 0) return false;
		cooldowns.push({ count: n, availableAtDay: today + SHEAR_COOLDOWN_DAYS });
		target.flags.shear = { cooldowns };
		produce(st, building.name, { wool: animal.wool }, q, n);
		st.report.notes.push(l("STRONGHOLD.CARD.SHEARED").replace("{n}", String(n)));
		return true;
	});
}

/* -------------------------------------------- */
/*  Treasury                                    */
/* -------------------------------------------- */

/**
 * GM-side treasury transfer between a character's purse and the stronghold's treasury.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function performTreasury({ strongholdUuid, characterUuid, direction, price, userId }) {
	const stronghold = await fromUuid(strongholdUuid);
	const character = await fromUuid(characterUuid);
	if (stronghold?.type !== ACTOR_TYPE || character?.type !== "character") {
		return { ok: false, reason: "STRONGHOLD.TREASURY.INVALID" };
	}
	const user = game.users.get(userId);
	if (user && !user.isGM) {
		const allowed =
			character.testUserPermission(user, "OWNER") && stronghold.testUserPermission(user, "OBSERVER");
		if (!allowed) return { ok: false, reason: "STRONGHOLD.TREASURY.DENIED" };
	}
	const amount = normalizePrice(price);
	if (!toCopper(amount)) return { ok: false, reason: "STRONGHOLD.TREASURY.EMPTY" };

	const currencyUpdate = (purse) => ({
		"system.currency.gold.value": purse.gold,
		"system.currency.silver.value": purse.silver,
		"system.currency.copper.value": purse.copper,
	});

	return enqueue(stronghold, async () => {
		const treasury = getTreasury(stronghold);
		if (direction === "deposit") {
			const purse = deductCoins(character, amount);
			if (!purse) return { ok: false, reason: "STRONGHOLD.TREASURY.NO_FUNDS" };
			await character.update(currencyUpdate(purse));
			await stronghold.setFlag(MODULE_ID, "treasury", addToPurse(treasury, amount));
		} else {
			const next = deductFromPurse(treasury, amount);
			if (!next) return { ok: false, reason: "STRONGHOLD.TREASURY.NO_TREASURY" };
			await stronghold.setFlag(MODULE_ID, "treasury", next);
			await character.update(currencyUpdate(creditCoins(character, amount)));
		}
		return { ok: true };
	});
}

const notifyTreasury = (result) => {
	if (!result?.ok) ui.notifications?.warn(l(result?.reason ?? "STRONGHOLD.TREASURY.INVALID"));
};

/** Deposit into / withdraw from the treasury, relaying through the active GM when needed. */
export async function requestTreasury(stronghold, character, direction, price) {
	const payload = {
		operation: "strongholdTreasury",
		strongholdUuid: stronghold.uuid,
		characterUuid: character.uuid,
		direction,
		price: normalizePrice(price),
		userId: game.user.id,
	};
	if (isActiveGM()) return notifyTreasury(await performTreasury(payload));
	if (!game.users.activeGM) return void ui.notifications?.warn(l("STRONGHOLD.TREASURY.NO_GM"));
	game.socket.emit(`module.${MODULE_ID}`, payload);
}

function registerStrongholdSocket() {
	game.socket.on(`module.${MODULE_ID}`, async (data) => {
		if (data?.operation === "strongholdTreasury" && isActiveGM()) {
			let result;
			try {
				result = await performTreasury(data);
			} catch (err) {
				console.warn(`${MODULE_ID} | stronghold: treasury transfer failed`, err);
				result = { ok: false, reason: "STRONGHOLD.TREASURY.INVALID" };
			}
			game.socket.emit(`module.${MODULE_ID}`, { operation: "strongholdTreasuryResult", userId: data.userId, ...result });
		} else if (data?.operation === "strongholdTreasuryResult" && data.userId === game.user.id) {
			notifyTreasury(data);
		}
	});
}

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

const isStrongholdItem = (item) =>
	item?.parent?.type === ACTOR_TYPE && (item.type === "building" || item.type === "hireling");

Hooks.once("init", () => {
	registerStrongholdSettings();
});

Hooks.once("ready", () => {
	registerStrongholdSocket();

	const api = game.modules.get(MODULE_ID);
	if (api) {
		api.api = Object.assign(api.api || {}, {
			stronghold: { computeDefense, computeReputation, getTreasury, keyOf },
		});
	}

	// Our own clock tracking: the hook's dt argument is not reliable across Foundry builds.
	let lastWorldTime = game.time.worldTime;
	Hooks.on("updateWorldTime", (worldTime) => {
		const now = Number.isFinite(worldTime) ? worldTime : game.time.worldTime;
		const dt = now - lastWorldTime;
		lastWorldTime = now;
		if (!isActiveGM()) return;
		void onWorldTime(now, dt).catch((err) => console.warn(`${MODULE_ID} | stronghold: time handler failed`, err));
	});

	// Defense follows the stronghold's contents (only the active GM writes).
	const refresh = (item) => {
		if (isStrongholdItem(item)) void updateDefense(item.parent);
	};
	Hooks.on("createItem", refresh);
	Hooks.on("updateItem", refresh);
	Hooks.on("deleteItem", refresh);
	Hooks.on("updateActor", (actor, changes, options) => {
		if (options?.fblStrongholdDefense || actor.type !== ACTOR_TYPE) return;
		if (changes?.flags?.[MODULE_ID]?.defense) void updateDefense(actor);
	});

	if (isActiveGM()) void backfillDefense();
});
