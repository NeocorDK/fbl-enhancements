/**
 * Forbidden Lands Enhancements — Economy (prices & rarity)
 *
 * The Forbidden Lands system stores an item's price as a single free-text
 * `system.cost` string ("5 copper", "8 silver") and its rarity as a free-text
 * `system.supply` ("Common"/"Uncommon"/"Rare"). Neither is machine-readable, and a
 * module cannot extend the system's `template.json`, so this module keeps its own
 * structured values in item flags and leaves the system fields untouched:
 *
 *   flags["fbl-enhancements"].price       = { gold, silver, copper }
 *   flags["fbl-enhancements"].priceSource = the system.cost text we parsed
 *   flags["fbl-enhancements"].rarity      = "common" | "uncommon" | "rare"
 *
 * This module is both an entry point (listed in module.json's esmodules) and the
 * dependency of `merchant.js`; ES module semantics evaluate it exactly once.
 */

export const MODULE_ID = "fbl-enhancements";

export const PRICE_FLAG = "price";
export const PRICE_SOURCE_FLAG = "priceSource";
export const RARITY_FLAG = "rarity";
export const RARITY_SOURCE_FLAG = "raritySource";

const SETTING_PRICE_MIGRATION_VERSION = "priceMigrationVersion";

/**
 * Bumping this re-runs the automatic startup migration once per world.
 * v2 repairs items whose rarity flag was stamped "common" from an empty Supply field.
 */
const PRICE_MIGRATION_VERSION = 2;

export const l = (key) => game.i18n.localize(`FBL_ENHANCEMENTS.${key}`);

/** Item types that carry a `system.cost` / `system.supply` pair. */
export const PRICEABLE_TYPES = ["gear", "weapon", "armor", "rawMaterial"];

export const RARITIES = ["common", "uncommon", "rare"];

const RARITY_LABELS = {
	common: "PRICE.RARITY_COMMON",
	uncommon: "PRICE.RARITY_UNCOMMON",
	rare: "PRICE.RARITY_RARE",
};

/* -------------------------------------------- */
/*  Shared helpers                              */
/* -------------------------------------------- */

/**
 * True only on the one GM client Foundry designates as active. Mirrors the helper of
 * the same name in main.js — ES modules do not share scope, and main.js exports nothing.
 * Every world mutation driven by a broadcast hook must be gated on this or it would run
 * once per connected GM.
 */
export function isActiveGM() {
	if (!game.user?.isGM) return false;
	const activeGM = game.users?.activeGM;
	return !!activeGM && activeGM.id === game.user.id;
}

/* -------------------------------------------- */
/*  Price model                                 */
/* -------------------------------------------- */

/** 1 gold = 10 silver = 100 copper, matching the system's own currency buttons. */
export function toCopper(price) {
	if (!price) return 0;
	const gold = Number(price.gold) || 0;
	const silver = Number(price.silver) || 0;
	const copper = Number(price.copper) || 0;
	return gold * 100 + silver * 10 + copper;
}

/** Greedy 100/10/1 split. Display only — stored prices keep whatever the GM typed. */
export function fromCopper(total) {
	const n = Math.max(0, Math.round(Number(total) || 0));
	const gold = Math.floor(n / 100);
	const rest = n % 100;
	return { gold, silver: Math.floor(rest / 10), copper: rest % 10 };
}

/** Normalize an arbitrary object into a complete, non-negative price triple. */
export function normalizePrice(price) {
	return {
		gold: Math.max(0, Math.round(Number(price?.gold) || 0)),
		silver: Math.max(0, Math.round(Number(price?.silver) || 0)),
		copper: Math.max(0, Math.round(Number(price?.copper) || 0)),
	};
}

/**
 * Map a denomination word to a currency key. Covers the five shipped locales plus the
 * common abbreviations that appear in community compendia.
 */
function matchDenomination(word) {
	const w = String(word || "").toLowerCase();
	if (!w) return null;
	if (/^(gold|golden|golds|gp|g|зм|золот|goldm|oro|ouro|or)/.test(w)) return "gold";
	if (/^(silver|silber|sp|s|см|серебр|plata|prata)/.test(w)) return "silver";
	if (/^(copper|kupfer|cp|c|мм|медн|медь|cobre)/.test(w)) return "copper";
	return null;
}

/**
 * Tolerant parser over `system.cost`. Scans every `<number><word>` pair so compound
 * strings like "1 silver 5 copper" add up. A bare number with no denomination word is
 * read as COPPER — the system's own `armor.cost` defaults to the number 0, and loose
 * numbers in compendia are overwhelmingly copper.
 *
 * @returns {{gold:number,silver:number,copper:number}|null} null when nothing usable
 *   was found (empty, non-numeric, or a total of zero).
 */
export function parseCost(str) {
	if (str === null || str === undefined) return null;
	const s = String(str).toLowerCase().trim();
	if (!s) return null;

	const price = { gold: 0, silver: 0, copper: 0 };
	const re = /(\d+)\s*(\p{L}*)/gu;
	let match;
	while ((match = re.exec(s)) !== null) {
		const amount = Number(match[1]);
		if (!Number.isFinite(amount)) continue;
		const denomination = matchDenomination(match[2]) || "copper";
		price[denomination] += amount;
	}

	return toCopper(price) > 0 ? price : null;
}

/**
 * Parse `system.supply` into one of our three rarity keys. "uncommon" MUST be tested
 * before "common" (and "poco común" before "común") — otherwise the substring match
 * silently downgrades every uncommon item.
 */
export function parseRarity(str) {
	const s = String(str ?? "").toLowerCase().trim();
	if (!s) return "common";
	if (/uncommon|необычн|ungewöhnlich|poco común|poco comun|incomum/.test(s)) return "uncommon";
	if (/rare|редк|selten|raro|rara/.test(s)) return "rare";
	return "common";
}

export function normalizeRarity(value, fallback = "common") {
	const rarity = String(value ?? "").toLowerCase().trim();
	return RARITIES.includes(rarity) ? rarity : fallback;
}

export function getRarityLabel(rarity) {
	return l(RARITY_LABELS[normalizeRarity(rarity)]);
}

/** Short localized price label ("1 gp 2 sp"), for chat lines and tooltips. */
export function formatPrice(price) {
	const p = normalizePrice(price);
	const parts = [];
	if (p.gold) parts.push(`${p.gold} ${l("PRICE.GOLD_SHORT")}`);
	if (p.silver) parts.push(`${p.silver} ${l("PRICE.SILVER_SHORT")}`);
	if (p.copper) parts.push(`${p.copper} ${l("PRICE.COPPER_SHORT")}`);
	if (!parts.length) return `0 ${l("PRICE.COPPER_SHORT")}`;
	return parts.join(" ");
}

/** The item's stored price flag, falling back to a fresh parse of `system.cost`. */
export function getItemPrice(item) {
	const flagged = item?.getFlag?.(MODULE_ID, PRICE_FLAG);
	if (flagged && toCopper(flagged) > 0) return normalizePrice(flagged);
	return parseCost(item?.system?.cost);
}

/** The item's stored rarity flag, falling back to a fresh parse of `system.supply`. */
export function getItemRarity(item) {
	const flagged = item?.getFlag?.(MODULE_ID, RARITY_FLAG);
	if (flagged) return normalizeRarity(flagged);
	return parseRarity(item?.system?.supply);
}

/* -------------------------------------------- */
/*  Item sheet field injection                  */
/* -------------------------------------------- */

/**
 * Build the price/rarity block. Inputs are named `flags.fbl-enhancements.price.gold`
 * etc., so the sheet's own AppV1 form submit persists them: FormDataExtended honours
 * `data-dtype="Number"` and `expandObject` splits on dots only, leaving the dashed
 * module id intact as a single key.
 */
function buildPriceBlock(item, editable) {
	const price = normalizePrice(item.getFlag(MODULE_ID, PRICE_FLAG) || parseCost(item.system?.cost));
	const rarity = getItemRarity(item);

	const block = document.createElement("div");
	block.className = "fbl-enh-price-block";

	const priceLabel = document.createElement("label");
	priceLabel.textContent = l("PRICE.LABEL");
	block.appendChild(priceLabel);

	const row = document.createElement("div");
	row.className = "fbl-enh-price-row";
	for (const [key, shortKey] of [
		["gold", "PRICE.GOLD_SHORT"],
		["silver", "PRICE.SILVER_SHORT"],
		["copper", "PRICE.COPPER_SHORT"],
	]) {
		const cell = document.createElement("div");
		cell.className = "fbl-enh-price-cell";

		const input = document.createElement("input");
		input.type = "number";
		input.min = "0";
		input.step = "1";
		input.dataset.dtype = "Number";
		input.name = `flags.${MODULE_ID}.${PRICE_FLAG}.${key}`;
		input.value = String(price[key]);
		input.title = l(`PRICE.${key.toUpperCase()}`);
		if (!editable) input.disabled = true;

		const unit = document.createElement("span");
		unit.className = "fbl-enh-price-unit";
		unit.textContent = l(shortKey);

		cell.appendChild(input);
		cell.appendChild(unit);
		row.appendChild(cell);
	}
	block.appendChild(row);

	const rarityLabel = document.createElement("label");
	rarityLabel.textContent = l("PRICE.RARITY");
	block.appendChild(rarityLabel);

	const select = document.createElement("select");
	select.name = `flags.${MODULE_ID}.${RARITY_FLAG}`;
	if (!editable) select.disabled = true;
	for (const value of RARITIES) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = getRarityLabel(value);
		if (value === rarity) option.selected = true;
		select.appendChild(option);
	}
	block.appendChild(select);

	return block;
}

/**
 * Place the price/rarity block into an already-rendered item sheet.
 * Idempotent: sheets re-render constantly, so a second call must be a no-op.
 */
function injectPriceFields(app, html) {
	const document_ = app?.document ?? app?.object;
	if (document_?.documentName !== "Item") return;
	if (!PRICEABLE_TYPES.includes(document_.type)) return;

	const root = html?.[0] || html;
	if (!root?.querySelector) return;
	if (root.querySelector(`[name^="flags.${MODULE_ID}.${PRICE_FLAG}"]`)) return;

	const block = buildPriceBlock(document_, app.isEditable !== false);

	// Preferred anchors: the shared supply tab (gear/weapon/armor) and the raw material
	// sheet's cost field. Both can be absent — the system hides the supply tab entirely
	// when its showCost/showSupply settings are off — so fall back to appending a
	// bordered block to the form.
	const supply = root.querySelector(".supply");
	if (supply) {
		supply.appendChild(block);
		return;
	}

	const cost = root.querySelector(".cost");
	if (cost) {
		(cost.closest(".flex.row") || cost).after(block);
		return;
	}

	const form = root.matches?.("form") ? root : root.querySelector("form");
	if (!form) return;
	block.classList.add("border");
	form.appendChild(block);
}

/**
 * Patch the registered item sheet classes directly.
 *
 * This does NOT go through a render hook. The system registers a separate leaf sheet
 * class per item type (ForbiddenLandsGearSheet, ...WeaponSheet, ...ArmorSheet,
 * ...RawMaterialSheet), and AppV1 dispatches `render<LeafClassName>` — so a listener on
 * the generic `renderApplication` never fires for these sheets, which is why the fields
 * were silently missing. Patching `activateListeners` on the prototype is the same
 * approach `patchItemSheetsResizable` in main.js uses, and it is immune to both hook
 * naming and bundler class-name mangling.
 */
export function patchItemSheetsForPrices() {
	const patched = [];

	for (const type of PRICEABLE_TYPES) {
		for (const entry of Object.values(CONFIG.Item?.sheetClasses?.[type] || {})) {
			const cls = entry?.cls;
			if (!cls?.prototype) continue;
			// hasOwnProperty, not a plain lookup: a subclass would otherwise inherit the
			// marker from an already-patched parent and be skipped.
			if (Object.prototype.hasOwnProperty.call(cls.prototype, "__fblEnhPricePatched")) continue;

			const original = cls.prototype.activateListeners;
			if (typeof original !== "function") continue;

			cls.prototype.activateListeners = function fblEnhActivateListeners(html, ...rest) {
				const result = original.call(this, html, ...rest);
				try {
					injectPriceFields(this, html);
				} catch (err) {
					console.warn(`${MODULE_ID} | economy: price field injection failed`, err);
				}
				return result;
			};

			cls.prototype.__fblEnhPricePatched = true;
			patched.push(cls.name);
		}
	}

	if (!patched.length) {
		console.warn(
			`${MODULE_ID} | economy: no priceable item sheet classes found; price fields not injected`,
		);
	} else {
		console.log(`${MODULE_ID} | economy: price fields patched into ${patched.join(", ")}`);
	}
}

/**
 * Belt-and-braces fallback for any item sheet that is not one of the system's registered
 * classes (a third-party sheet, or a core ItemSheet left registered). Harmless alongside
 * the prototype patch above — injectPriceFields refuses to inject twice.
 */
export function registerItemSheetInjection() {
	Hooks.on("renderApplication", (app, html) => {
		try {
			injectPriceFields(app, html);
		} catch (err) {
			console.warn(`${MODULE_ID} | economy: price field injection failed`, err);
		}
	});
}

/* -------------------------------------------- */
/*  Migration                                   */
/* -------------------------------------------- */

/**
 * Decide the flag updates for one item. Returns null when nothing needs to change.
 * `overwrite` forces a re-parse; otherwise the price is refreshed only when it is
 * missing, or when `system.cost` changed since we last parsed it (`priceSource`).
 */
function buildPriceUpdate(item, overwrite) {
	const cost = item.system?.cost;
	const costText = cost === null || cost === undefined ? "" : String(cost);

	const currentPrice = item.getFlag(MODULE_ID, PRICE_FLAG);
	const currentSource = item.getFlag(MODULE_ID, PRICE_SOURCE_FLAG);
	const currentRarity = item.getFlag(MODULE_ID, RARITY_FLAG);

	const flags = {};

	const needsPrice =
		overwrite || !currentPrice || toCopper(currentPrice) <= 0 || currentSource !== costText;
	let failed = false;
	if (needsPrice && costText.trim()) {
		const parsed = parseCost(costText);
		if (parsed) {
			flags[PRICE_FLAG] = parsed;
			flags[PRICE_SOURCE_FLAG] = costText;
		} else {
			failed = true;
		}
	}

	// The Supply text is the source of record for rarity, exactly as `system.cost` is for
	// price above — hence the symmetric `raritySource` bookkeeping.
	//
	// An EMPTY Supply field carries no information and must NOT be recorded. Writing
	// parseRarity("")'s "common" default into the flag pins the item to common forever and
	// kills the live fallback in getItemRarity() — which is precisely why an item created
	// first and typed "Rare" afterwards kept being stocked as common: the flag had already
	// been stamped "common" at creation time, and nothing ever re-read the text.
	const supplyText = String(item.system?.supply ?? "");
	const currentRaritySource = item.getFlag(MODULE_ID, RARITY_SOURCE_FLAG);
	if (supplyText.trim() && (overwrite || !currentRarity || currentRaritySource !== supplyText)) {
		const rarity = parseRarity(supplyText);
		if (rarity !== currentRarity) flags[RARITY_FLAG] = rarity;
		if (currentRaritySource !== supplyText) flags[RARITY_SOURCE_FLAG] = supplyText;
	}

	if (!Object.keys(flags).length) return { update: null, failed };
	return { update: { _id: item.id, flags: { [MODULE_ID]: flags } }, failed };
}

/**
 * Parse `system.cost` / `system.supply` into module flags across the world.
 * Batched per parent so each collection takes a single database round trip.
 *
 * @returns {Promise<{scanned:number, updated:number, skipped:number, failed:string[]}>}
 */
export async function migratePrices({ worldItems = true, actorItems = true, overwrite = false } = {}) {
	const report = { scanned: 0, updated: 0, skipped: 0, failed: [] };

	const collections = [];
	if (worldItems) collections.push({ parent: null, items: game.items?.contents ?? [] });
	if (actorItems) {
		for (const actor of game.actors?.contents ?? []) {
			collections.push({ parent: actor, items: actor.items?.contents ?? [] });
		}
	}

	for (const { parent, items } of collections) {
		const updates = [];
		for (const item of items) {
			if (!PRICEABLE_TYPES.includes(item.type)) continue;
			report.scanned += 1;

			let result;
			try {
				result = buildPriceUpdate(item, overwrite);
			} catch (err) {
				console.warn(`${MODULE_ID} | economy: failed to read "${item.name}"`, err);
				report.failed.push(item.name);
				continue;
			}

			if (result.failed) report.failed.push(item.name);
			if (result.update) updates.push(result.update);
			else report.skipped += 1;
		}

		if (!updates.length) continue;
		try {
			if (parent) await parent.updateEmbeddedDocuments("Item", updates);
			else await Item.updateDocuments(updates);
			report.updated += updates.length;
		} catch (err) {
			console.warn(
				`${MODULE_ID} | economy: price migration failed for ${parent ? `actor "${parent.name}"` : "world items"}`,
				err,
			);
			for (const update of updates) report.failed.push(update._id);
		}
	}

	return report;
}

/* -------------------------------------------- */
/*  Manual migration form (ApplicationV2)       */
/* -------------------------------------------- */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FblPriceMigrationApp extends HandlebarsApplicationMixin(ApplicationV2) {
	static DEFAULT_OPTIONS = {
		id: "fbl-price-migration",
		tag: "form",
		classes: ["fbl-price-migration", "forbidden-lands", "standard-form"],
		position: { width: 480, height: "auto" },
		window: {
			title: "FBL_ENHANCEMENTS.SETTINGS.PRICE_MIGRATION.TITLE",
			icon: "fas fa-coins",
			contentClasses: ["standard-form"],
			resizable: false,
		},
		form: {
			handler: FblPriceMigrationApp.onSubmit,
			submitOnChange: false,
			closeOnSubmit: true,
		},
	};

	static PARTS = {
		body: { template: `modules/${MODULE_ID}/templates/price-migration.hbs` },
		footer: { template: "templates/generic/form-footer.hbs" },
	};

	async _prepareContext() {
		return {
			buttons: [
				{
					type: "submit",
					icon: "fas fa-coins",
					label: "FBL_ENHANCEMENTS.SETTINGS.PRICE_MIGRATION.RUN",
				},
			],
		};
	}

	static async onSubmit(event, form, formData) {
		const data = foundry.utils.expandObject(formData.object);
		const report = await migratePrices({
			worldItems: data.worldItems !== false,
			actorItems: data.actorItems !== false,
			overwrite: !!data.overwrite,
		});
		notifyMigrationReport(report);
	}
}

function notifyMigrationReport(report) {
	console.log(`${MODULE_ID} | price migration`, report);
	const message = l("SETTINGS.PRICE_MIGRATION.RESULT")
		.replace("{scanned}", report.scanned)
		.replace("{updated}", report.updated)
		.replace("{skipped}", report.skipped)
		.replace("{failed}", report.failed.length);
	ui.notifications?.info(message);
}

/* -------------------------------------------- */
/*  Settings & lifecycle                        */
/* -------------------------------------------- */

function registerEconomySettings() {
	game.settings.register(MODULE_ID, SETTING_PRICE_MIGRATION_VERSION, {
		scope: "world",
		config: false,
		type: Number,
		default: 0,
	});

	game.settings.registerMenu(MODULE_ID, "priceMigration", {
		name: "FBL_ENHANCEMENTS.SETTINGS.PRICE_MIGRATION.NAME",
		hint: "FBL_ENHANCEMENTS.SETTINGS.PRICE_MIGRATION.HINT",
		label: "FBL_ENHANCEMENTS.SETTINGS.PRICE_MIGRATION.MENU_LABEL",
		icon: "fas fa-coins",
		type: FblPriceMigrationApp,
		restricted: true,
	});
}

/** Keep newly created items in sync without re-running the whole migration. */
function registerItemCreationHook() {
	Hooks.on("createItem", async (item) => {
		if (!isActiveGM()) return;
		if (!PRICEABLE_TYPES.includes(item.type)) return;
		// Compendium imports and duplicates already carry our flags; only fill the gaps.
		const { update } = buildPriceUpdate(item, false);
		if (!update) return;
		try {
			await item.update({ flags: update.flags });
		} catch (err) {
			console.warn(`${MODULE_ID} | economy: failed to price new item "${item.name}"`, err);
		}
	});
}

/**
 * Keep the flags in step with later edits of the system's own Cost / Supply text fields.
 * Without this, those fields were read exactly once — at item creation — so typing a
 * rarity into Supply after the fact never reached the stock rolls.
 *
 * Only a change to the source text triggers a re-parse (the same approach the critical
 * injury countdown uses for `healingTime`), so a rarity picked from the injected dropdown
 * is never clobbered by a later Cost edit.
 */
function registerItemUpdateHook() {
	Hooks.on("updateItem", async (item, changes) => {
		if (!isActiveGM()) return;
		if (!PRICEABLE_TYPES.includes(item.type)) return;

		const flags = {};

		if (changes.system?.cost !== undefined) {
			const costText = String(item.system?.cost ?? "");
			const parsed = parseCost(costText);
			if (parsed) {
				flags[PRICE_FLAG] = parsed;
				flags[PRICE_SOURCE_FLAG] = costText;
			}
		}

		if (changes.system?.supply !== undefined) {
			const supplyText = String(item.system?.supply ?? "");
			if (supplyText.trim()) {
				flags[RARITY_FLAG] = parseRarity(supplyText);
				flags[RARITY_SOURCE_FLAG] = supplyText;
			}
		}

		// A rarity chosen from the dropdown stamps the current Supply text as its source,
		// so a later migration treats the manual choice as up to date and leaves it alone.
		const flagChanges = changes.flags?.[MODULE_ID];
		if (flagChanges?.[RARITY_FLAG] !== undefined && changes.system?.supply === undefined) {
			const supplyText = String(item.system?.supply ?? "");
			if (item.getFlag(MODULE_ID, RARITY_SOURCE_FLAG) !== supplyText) {
				flags[RARITY_SOURCE_FLAG] = supplyText;
			}
		}

		if (!Object.keys(flags).length) return;
		// No feedback loop: this writes flags only, so the resulting update carries no
		// system.cost/supply change, and the rarity-source stamp above is skipped once the
		// stored source already matches.
		try {
			await item.update({ flags: { [MODULE_ID]: flags } });
		} catch (err) {
			console.warn(`${MODULE_ID} | economy: failed to reconcile "${item.name}"`, err);
		}
	});
}

async function runStartupMigration() {
	if (!isActiveGM()) return;
	const stored = Number(game.settings.get(MODULE_ID, SETTING_PRICE_MIGRATION_VERSION)) || 0;
	if (stored >= PRICE_MIGRATION_VERSION) return;

	const report = await migratePrices({ worldItems: true, actorItems: true, overwrite: false });
	await game.settings.set(MODULE_ID, SETTING_PRICE_MIGRATION_VERSION, PRICE_MIGRATION_VERSION);
	notifyMigrationReport(report);
}

Hooks.once("init", () => {
	registerEconomySettings();
});

Hooks.once("ready", () => {
	patchItemSheetsForPrices();
	registerItemSheetInjection();
	registerItemCreationHook();
	registerItemUpdateHook();
	void runStartupMigration();
});
