/**
 * Forbidden Lands Enhancements — Stronghold sheet integration.
 *
 * Adds the automation controls straight into the system's own stronghold actor sheet
 * (treasury, defense flags, per-building and per-hireling toggles, livestock actions) and a
 * "stronghold role" dropdown into the building / hireling item sheets.
 *
 * The system's sheets are AppV1, rebuilt on every render, so injection runs from a patched
 * `activateListeners` (the same approach economy.js uses for price fields — the system
 * registers a separate leaf class per type, and a generic render hook does not reliably fire
 * for them). Every control is a plain DOM element carrying `data-*` attributes and NO `name`,
 * so the sheet's own form submission never sees it; changes are written explicitly.
 */

import { MODULE_ID, escapeHTML, formatPrice, fromCopper, l } from "./economy.js";
import { resolveUserCharacter } from "./merchant-trade.js";
import {
	ACTOR_TYPE,
	buildingMax,
	computeDefense,
	computeReputation,
	getTreasury,
	headCount,
	hirelingDailyCopper,
	itemFlags,
	guessKey,
	keyOf,
	keyOptions,
	requestTreasury,
	shear,
	shearableCount,
	slaughter,
	staffInfo,
	totalDailyCopper,
} from "./stronghold.js";
import { BUILDINGS, HIRELINGS, MAX_PER_COPY } from "./stronghold-data.js";

const lk = (group, key) => game.i18n.localize(`FBL_ENHANCEMENTS.STRONGHOLD.${group}.${key}`);
const num = (v) => Number(v) || 0;
const esc = escapeHTML;

const rootOf = (html) => (html instanceof HTMLElement ? html : (html?.[0] ?? html?.element));

const setFlags = (doc, patch) => doc.update({ flags: { [MODULE_ID]: patch } });

/** Run a write, turning a permission error into a notification instead of an unhandled rejection. */
async function safely(task) {
	try {
		return await task();
	} catch (err) {
		console.warn(`${MODULE_ID} | stronghold sheet: update failed`, err);
		ui.notifications?.warn(l("STRONGHOLD.SHEET.NO_PERMISSION"));
	}
}

/* -------------------------------------------- */
/*  Dialogs                                     */
/* -------------------------------------------- */

async function askCount(title, label, max) {
	const { DialogV2 } = foundry.applications.api;
	const value = await DialogV2.prompt({
		window: { title },
		content: `<div class="form-group"><label>${esc(label)}</label><input type="number" name="count" min="1" max="${max}" value="${max}" autofocus></div>`,
		ok: { label: l("STRONGHOLD.SHEET.CONFIRM"), callback: (event, button) => Number(button.form.elements.count.value) },
		rejectClose: false,
	});
	return Math.max(0, Math.min(max, Math.floor(num(value))));
}

async function askCoins(title) {
	const { DialogV2 } = foundry.applications.api;
	const field = (name, label) =>
		`<div class="form-group"><label>${esc(label)}</label><input type="number" name="${name}" min="0" value="0"></div>`;
	return DialogV2.prompt({
		window: { title },
		content: field("gold", l("PRICE.GOLD")) + field("silver", l("PRICE.SILVER")) + field("copper", l("PRICE.COPPER")),
		ok: {
			label: l("STRONGHOLD.SHEET.CONFIRM"),
			callback: (event, button) => {
				const e = button.form.elements;
				return { gold: num(e.gold.value), silver: num(e.silver.value), copper: num(e.copper.value) };
			},
		},
		rejectClose: false,
	});
}

async function treasuryDialog(actor, direction) {
	const character = resolveUserCharacter();
	if (!character) return void ui.notifications?.warn(l("STRONGHOLD.TREASURY.NO_CHARACTER"));
	const price = await askCoins(l(direction === "deposit" ? "STRONGHOLD.SHEET.DEPOSIT" : "STRONGHOLD.SHEET.WITHDRAW"));
	if (!price) return;
	await requestTreasury(actor, character, direction, price);
}

/* -------------------------------------------- */
/*  Stronghold actor sheet                      */
/* -------------------------------------------- */

const toggle = (action, on, title, icon, enabled) =>
	`<a class="fbl-enh-toggle ${on ? "on" : ""} ${enabled ? "" : "disabled"}" data-action="${action}" data-tooltip="${esc(title)}"><i class="fas ${icon}"></i></a>`;

const cell = (content = "", cls = "") => `<span class="fbl-enh-cell ${cls}">${content}</span>`;

function buildingControls(actor, item, editable) {
	const key = keyOf(item);
	const def = BUILDINGS[key];
	const flags = itemFlags(item);
	const copies = Math.max(1, num(item.system.quantity));
	const cells = ["", "", "", "", ""];

	if (def && def.kind !== "passive") {
		cells[0] = cell(toggle("active", !!flags.active, l("STRONGHOLD.SHEET.ACTIVE"), flags.active ? "fa-toggle-on" : "fa-toggle-off", editable));
	}

	const dis = editable ? "" : "disabled";
	switch (def?.kind) {
		case "converter":
		case "extractor": {
			const max = buildingMax(def, copies);
			const value = flags.target > 0 ? Math.min(flags.target, max) : max;
			cells[1] = cell(
				`<input type="number" class="fbl-enh-input" data-field="target" min="1" max="${max}" value="${value}" ${dis} data-tooltip="${esc(l("STRONGHOLD.SHEET.TARGET").replace("{max}", String(max)))}">`,
			);
			break;
		}
		case "garden": {
			const total = buildingMax(def, copies);
			const veg = Math.max(0, Math.min(total, flags.garden?.veg ?? total));
			const herbs = Math.max(0, Math.min(total - veg, flags.garden?.herbs ?? 0));
			cells[1] = cell(
				`<input type="number" class="fbl-enh-input small" data-field="veg" min="0" max="${total}" value="${veg}" ${dis} data-tooltip="${esc(lk("RESOURCES", "vegetables"))}">` +
					`<input type="number" class="fbl-enh-input small" data-field="herbs" min="0" max="${total}" value="${herbs}" ${dis} data-tooltip="${esc(lk("RESOURCES", "herbs"))}">`,
			);
			break;
		}
		case "livestock": {
			const head = headCount(actor, def.animal);
			const cap = MAX_PER_COPY * copies;
			cells[1] = cell(`${head}/${cap}`, head > cap ? "over" : "");
			if (def.animal === "cow") {
				cells[4] += toggle("bull", !!flags.hasBull, l("STRONGHOLD.SHEET.BULL"), "fa-mars", editable);
			}
			if (def.animal === "sheep") {
				const ready = shearableCount(actor, item);
				cells[4] += toggle("shear", false, l("STRONGHOLD.SHEET.SHEAR").replace("{n}", String(ready)), "fa-scissors", editable && ready > 0);
			}
			cells[4] += toggle("slaughter", false, l("STRONGHOLD.SHEET.SLAUGHTER"), "fa-drumstick-bite", editable && head > 0);
			cells[4] = cell(cells[4]);
			break;
		}
		case "field":
			cells[1] = cell(String(buildingMax(def, copies)), "dim");
			break;
	}

	const staff = def ? staffInfo(actor, item) : null;
	if (staff) {
		cells[2] = cell(`${staff.have}/${staff.need}`, staff.ok ? "ok" : "warn");
		cells[3] = cell(toggle("pc", !!flags.pcStaffed, l("STRONGHOLD.SHEET.PC_STAFFED"), "fa-user", editable));
	}

	return `<div class="fbl-enh-sh-controls buildings">${cells.map((c) => c || cell()).join("")}</div>`;
}

function hirelingControls(item, editable) {
	const key = keyOf(item);
	const def = HIRELINGS[key];
	const flags = itemFlags(item);
	const deploy = def?.field
		? toggle("deploy", !!flags.deployed, l("STRONGHOLD.SHEET.DEPLOYED"), "fa-person-hiking", editable)
		: "";
	const overtime = def && !def.perEvent ? toggle("overtime", !!flags.overtime, l("STRONGHOLD.SHEET.OVERTIME"), "fa-moon", editable) : "";
	const unpaid = flags.unpaid
		? `<i class="fas fa-triangle-exclamation fbl-enh-unpaid" data-tooltip="${esc(l("STRONGHOLD.SHEET.UNPAID"))}"></i>`
		: "";
	return `<div class="fbl-enh-sh-controls hirelings">${cell(deploy)}${cell(overtime)}${cell(unpaid)}</div>`;
}

function headerLabels(labels, cls) {
	return `<div class="fbl-enh-sh-controls ${cls} fbl-enh-sh-head">${labels.map((t) => cell(esc(t))).join("")}</div>`;
}

function injectStrongholdSheet(sheet, html) {
	const root = rootOf(html);
	const actor = sheet.actor;
	if (!root || actor?.type !== ACTOR_TYPE) return;
	const editable = actor.isOwner;

	/* --- Header bar: treasury + defense flags --- */
	const bio = root.querySelector(".bio");
	if (bio && !root.querySelector(".fbl-enh-sh-bar")) {
		const flags = actor.flags?.[MODULE_ID]?.defense ?? {};
		const bar = document.createElement("div");
		bar.className = "fbl-enh-sh-bar border";
		bar.innerHTML = `
			<div class="fbl-enh-treasury">
				<b>${esc(l("STRONGHOLD.SHEET.TREASURY"))}:</b>
				<span class="fbl-enh-treasury-amount">${esc(formatPrice(getTreasury(actor)))}</span>
				<button type="button" class="fbl-enh-btn" data-treasury="deposit">${esc(l("STRONGHOLD.SHEET.DEPOSIT"))}</button>
				<button type="button" class="fbl-enh-btn" data-treasury="withdraw">${esc(l("STRONGHOLD.SHEET.WITHDRAW"))}</button>
			</div>
			<div class="fbl-enh-wages">${esc(l("STRONGHOLD.SHEET.WAGES_PER_DAY"))}: <b>${esc(formatPrice(fromCopper(totalDailyCopper(actor))))}</b></div>
			<div class="fbl-enh-sh-flags">
				<label><input type="checkbox" data-flag="pcsPresent" ${flags.pcsPresent ? "checked" : ""} ${editable ? "" : "disabled"}> ${esc(l("STRONGHOLD.SHEET.PCS_PRESENT"))}</label>
				<label><input type="checkbox" data-flag="guardsHungry" ${flags.guardsHungry ? "checked" : ""} ${editable ? "" : "disabled"}> ${esc(l("STRONGHOLD.SHEET.GUARDS_HUNGRY"))}</label>
			</div>`;
		bio.after(bar);
	}

	/* --- Defense rating: read-only with a breakdown when automatic --- */
	if (game.settings.get(MODULE_ID, "autoDefenseRating")) {
		const field = root.querySelector('input[name="system.defenseRating"]');
		if (field) {
			const { parts } = computeDefense(actor);
			field.readOnly = true;
			field.dataset.tooltip = parts.length
				? parts.map((p) => `${p.label}: ${p.value > 0 ? "+" : ""}${p.value}`).join("\n")
				: l("STRONGHOLD.DEFENSE.NONE");
		}
	}

	/* --- Buildings tab --- */
	const buildingHeader = root.querySelector(".header.building");
	if (buildingHeader && !buildingHeader.querySelector(".fbl-enh-sh-head")) {
		buildingHeader
			.querySelector("b.quantity")
			?.before(
				...htmlNodes(
					headerLabels(
						[l("STRONGHOLD.SHEET.COL_ACTIVE"), l("STRONGHOLD.SHEET.COL_OUTPUT"), l("STRONGHOLD.SHEET.COL_STAFF"), l("STRONGHOLD.SHEET.COL_PC"), ""],
						"buildings",
					),
				),
			);
	}
	for (const row of root.querySelectorAll(".building.item[data-item-id]")) {
		const item = actor.items.get(row.dataset.itemId);
		if (!item || row.querySelector(".fbl-enh-sh-controls")) continue;
		row.querySelector("input.quantity")?.before(...htmlNodes(buildingControls(actor, item, editable)));
	}
	const buildingList = root.querySelector(".item-list.buildings");
	if (buildingList && !buildingList.querySelector(".fbl-enh-rep")) {
		const rep = computeReputation(actor);
		const footer = document.createElement("div");
		footer.className = "fbl-enh-rep";
		footer.dataset.tooltip = rep.parts.map((p) => `${p.label}: +${p.value}`).join("\n");
		footer.textContent = `${l("STRONGHOLD.SHEET.REPUTATION")}: +${rep.total}`;
		buildingList.append(footer);
	}

	/* --- Hirelings tab --- */
	const hirelingHeader = root.querySelector(".header.hireling");
	if (hirelingHeader && !hirelingHeader.querySelector(".fbl-enh-sh-head")) {
		hirelingHeader
			.querySelector("b.salary")
			?.before(...htmlNodes(headerLabels([l("STRONGHOLD.SHEET.COL_DEPLOY"), l("STRONGHOLD.SHEET.COL_OVERTIME"), ""], "hirelings")));
	}
	for (const row of root.querySelectorAll(".hireling.item[data-item-id]")) {
		const item = actor.items.get(row.dataset.itemId);
		if (!item || row.querySelector(".fbl-enh-sh-controls")) continue;
		row.querySelector(".salary")?.before(...htmlNodes(hirelingControls(item, editable)));
		const owed = hirelingDailyCopper(item);
		if (owed) row.querySelector(".salary")?.setAttribute("data-tooltip", formatPrice(fromCopper(owed)));
	}

	bindStrongholdEvents(root, actor);
}

function htmlNodes(html) {
	const template = document.createElement("template");
	template.innerHTML = html.trim();
	return [...template.content.childNodes];
}

function bindStrongholdEvents(root, actor) {
	// `root` can outlive a re-render; delegated listeners must only be attached once.
	if (root.dataset.fblEnhStrongholdBound) return;
	root.dataset.fblEnhStrongholdBound = "1";
	root.addEventListener("click", async (event) => {
		const treasury = event.target.closest("[data-treasury]");
		if (treasury) {
			event.preventDefault();
			return void (await treasuryDialog(actor, treasury.dataset.treasury));
		}

		const control = event.target.closest("[data-action]");
		if (!control || control.classList.contains("disabled")) return;
		const row = control.closest(".item[data-item-id]");
		const item = row ? actor.items.get(row.dataset.itemId) : null;
		if (!item) return;
		event.preventDefault();
		event.stopPropagation();
		const flags = itemFlags(item);

		switch (control.dataset.action) {
			case "active":
				return void (await safely(() =>
					setFlags(item, { active: !flags.active, gardenAnchorQ: null, reminderAnchorQ: null }),
				));
			case "pc":
				return void (await safely(() => setFlags(item, { pcStaffed: !flags.pcStaffed })));
			case "bull":
				return void (await safely(() => setFlags(item, { hasBull: !flags.hasBull })));
			case "deploy":
				return void (await safely(() => setFlags(item, { deployed: !flags.deployed, reminderAnchorQ: null })));
			case "overtime":
				return void (await safely(() => setFlags(item, { overtime: !flags.overtime })));
			case "slaughter": {
				const animal = BUILDINGS[keyOf(item)]?.animal;
				const head = headCount(actor, animal);
				const count = await askCount(l("STRONGHOLD.SHEET.SLAUGHTER"), l("STRONGHOLD.SHEET.HOW_MANY"), head);
				if (count) await safely(() => slaughter(actor, item, count));
				return;
			}
			case "shear": {
				const ready = shearableCount(actor, item);
				const count = await askCount(l("STRONGHOLD.SHEET.SHEAR_TITLE"), l("STRONGHOLD.SHEET.HOW_MANY"), ready);
				if (count) await safely(() => shear(actor, item, count));
				return;
			}
		}
	});

	root.addEventListener("change", async (event) => {
		const flag = event.target.closest("[data-flag]");
		if (flag) {
			event.stopPropagation();
			return void (await safely(() =>
				actor.update({ flags: { [MODULE_ID]: { defense: { [flag.dataset.flag]: flag.checked } } } }),
			));
		}

		const field = event.target.closest("[data-field]");
		if (!field) return;
		const row = field.closest(".item[data-item-id]");
		const item = row ? actor.items.get(row.dataset.itemId) : null;
		if (!item) return;
		event.stopPropagation();

		const max = num(field.max);
		const value = Math.max(0, Math.min(max, Math.floor(num(field.value))));
		switch (field.dataset.field) {
			case "target":
				return void (await safely(() => setFlags(item, { target: Math.max(1, value) })));
			case "veg":
				return void (await safely(() => setFlags(item, { garden: { veg: value, herbs: max - value } })));
			case "herbs":
				return void (await safely(() => setFlags(item, { garden: { veg: max - value, herbs: value } })));
		}
	});
}

/* -------------------------------------------- */
/*  Building / hireling item sheets             */
/* -------------------------------------------- */

function injectRoleSelect(sheet, html) {
	const root = rootOf(html);
	const item = sheet.item;
	if (!root || !item || root.querySelector(".fbl-enh-role")) return;

	const guessed = guessKey(item);
	const current = item.getFlag(MODULE_ID, "strongholdKey") ?? "";
	const options = keyOptions(item.type);
	const group = item.type === "building" ? "BUILDINGS" : "HIRELINGS";
	const autoLabel = l("STRONGHOLD.SHEET.ROLE_AUTO").replace("{name}", guessed ? lk(group, guessed) : l("STRONGHOLD.SHEET.ROLE_NONE"));

	const block = document.createElement("div");
	block.className = "fbl-enh-role";
	block.innerHTML = `
		<label>${esc(l("STRONGHOLD.SHEET.ROLE"))}</label>
		<select name="flags.${MODULE_ID}.strongholdKey" ${sheet.isEditable ? "" : "disabled"}>
			<option value="">${esc(autoLabel)}</option>
			${options.map((o) => `<option value="${esc(o.key)}" ${o.key === current ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
		</select>`;

	const form = root.matches?.("form") ? root : root.querySelector("form");
	if (!form) return;
	const header = form.querySelector(".header");
	if (header) header.after(block);
	else form.prepend(block);
}

/* -------------------------------------------- */
/*  Patching                                    */
/* -------------------------------------------- */

function patchSheetClasses(entries, inject, label) {
	const patched = [];
	for (const entry of entries) {
		const cls = entry?.cls;
		if (!cls?.prototype) continue;
		// hasOwnProperty, not a plain lookup: a subclass would otherwise inherit the marker.
		if (Object.prototype.hasOwnProperty.call(cls.prototype, "__fblEnhStrongholdPatched")) continue;
		const original = cls.prototype.activateListeners;
		if (typeof original !== "function") continue;

		cls.prototype.activateListeners = function fblEnhStrongholdListeners(html, ...rest) {
			const result = original.call(this, html, ...rest);
			try {
				inject(this, html);
			} catch (err) {
				console.warn(`${MODULE_ID} | stronghold: ${label} injection failed`, err);
			}
			return result;
		};
		cls.prototype.__fblEnhStrongholdPatched = true;
		patched.push(cls.name);
	}
	if (!patched.length) console.warn(`${MODULE_ID} | stronghold: no ${label} sheet class found; controls not injected`);
}

Hooks.once("ready", () => {
	patchSheetClasses(Object.values(CONFIG.Actor?.sheetClasses?.[ACTOR_TYPE] || {}), injectStrongholdSheet, "stronghold actor");
	for (const type of ["building", "hireling"]) {
		patchSheetClasses(Object.values(CONFIG.Item?.sheetClasses?.[type] || {}), injectRoleSelect, `${type} item`);
	}
});
