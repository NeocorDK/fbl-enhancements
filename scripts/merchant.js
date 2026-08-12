/**
 * Forbidden Lands Enhancements — Merchants
 *
 * Adds a module actor sub-type (`fbl-enhancements.merchant`) whose sheet doubles as a
 * GM stock editor and a player storefront. The GM drops items or a whole folder onto
 * the sheet; the module rolls availability and quantity from the item's rarity, carries
 * the price over, and players buy with one click — coins are deducted with denomination
 * borrowing, and the goods land in the buyer's carried inventory.
 *
 * A module cannot extend the system's `template.json`, so prices, rarity, and stock all
 * live in module flags (see economy.js). Players have no write access to the merchant
 * actor, so every mutation is funnelled through the socket to the active GM.
 */

import {
	MODULE_ID,
	PRICE_FLAG,
	formatPrice,
	getItemPrice,
	getItemRarity,
	isActiveGM,
	l,
	normalizePrice,
	parseCost,
	parseRarity,
	toCopper,
} from "./economy.js";

/** Module sub-types are always namespaced by the module id. */
export const MERCHANT_TYPE = `${MODULE_ID}.merchant`;

const STOCK_FLAG = "stock";
const STOCK_ROLLED_FLAG = "stockRolled";

const SETTING_MERCHANT_AUTOMATION = "merchantAutomation";
const SETTING_MERCHANT_ANNOUNCE = "merchantAnnouncePurchases";

// The system's own character portrait placeholder, so a new merchant looks like the
// rest of the actor directory instead of a broken image.
const DEFAULT_MERCHANT_IMG = "systems/forbidden-lands/assets/fbl-character.webp";

/**
 * The path the system stamps onto every actor it creates:
 * `ForbiddenLandsActor.create()` sets `data.img = systems/forbidden-lands/assets/fbl-<type>.webp`
 * before delegating to `super.create()`. For a module sub-type that resolves to
 * `fbl-fbl-enhancements.merchant.webp`, a file that cannot exist — and because the system
 * assigns it *before* `preCreateActor` fires, a plain `if (!data.img)` guard never runs.
 * The bogus value therefore has to be recognised by name and replaced.
 */
const SYSTEM_TYPE_IMG = `systems/forbidden-lands/assets/fbl-${MERCHANT_TYPE}.webp`;

/** True for any image we are entitled to replace — never a portrait the GM chose. */
const isPlaceholderImg = (src) => !src || src === SYSTEM_TYPE_IMG || src === CONST.DEFAULT_TOKEN;

/**
 * Availability and quantity per rarity, per the Forbidden Lands supply rules.
 * `minRoll` is the lowest 1d6 result that keeps the item in stock.
 */
const STOCK_RULES = {
	common: { minRoll: 2, quantity: "2d12" },
	uncommon: { minRoll: 4, quantity: "1d6" },
	rare: { minRoll: 6, quantity: "1" },
};

const isAutomationEnabled = () => !!game.settings.get(MODULE_ID, SETTING_MERCHANT_AUTOMATION);

/** Item names reach chat as raw HTML; escape them locally rather than trusting a helper. */
const escapeHTML = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	);

/* -------------------------------------------- */
/*  Data model                                  */
/* -------------------------------------------- */

class MerchantData extends foundry.abstract.TypeDataModel {
	static defineSchema() {
		const fields = foundry.data.fields;
		return { description: new fields.HTMLField({ required: false, blank: true }) };
	}
}

/* -------------------------------------------- */
/*  Stock helpers                               */
/* -------------------------------------------- */

/**
 * Units of an item a merchant has left. Items placed while the automation was off carry
 * no flag at all; those default to 1 so a hand-curated merchant still works.
 */
function getStock(item) {
	const raw = item?.getFlag?.(MODULE_ID, STOCK_FLAG);
	const stock = Number(raw);
	return Number.isFinite(stock) ? Math.max(0, Math.round(stock)) : 1;
}

/** Total worth of an actor's purse in copper. */
function getPurseCopper(actor) {
	const currency = actor?.system?.currency;
	if (!currency) return 0;
	return toCopper({
		gold: currency.gold?.value,
		silver: currency.silver?.value,
		copper: currency.copper?.value,
	});
}

/* -------------------------------------------- */
/*  Availability rolls                          */
/* -------------------------------------------- */

/**
 * Roll availability and quantity for one rarity.
 * @returns {Promise<{available: boolean, stock: number}>}
 */
async function rollStockValues(rarity) {
	const rule = STOCK_RULES[rarity] ?? STOCK_RULES.common;

	const availability = await new Roll("1d6").evaluate();
	if (availability.total < rule.minRoll) return { available: false, stock: 0 };

	const quantity = await new Roll(rule.quantity).evaluate();
	return { available: true, stock: Math.max(1, Math.round(quantity.total)) };
}

/**
 * Roll stock for a set of a merchant's items and write the result in one batch.
 *
 * Used for three paths that share the same rules: a single item dropped on the sheet, a
 * re-dropped item that the merchant already carries, and the GM's "Supply reroll" button.
 * Items that come up unavailable are removed, exactly as on a first drop, so re-dropping a
 * folder yields the same kind of fresh assortment as stocking the merchant from scratch.
 *
 * Deliberately silent: stock rolls used to whisper a summary to the GM, which was noise.
 *
 * @param {Actor} merchant
 * @param {Item[]} items
 * @param {{reroll?: boolean}} [options] `reroll` re-rolls entries that already have stock.
 */
async function stockItems(merchant, items, { reroll = false } = {}) {
	if (!merchant || !items?.length) return;

	const updates = [];
	const deletions = [];

	for (const item of items) {
		if (!reroll && item.getFlag(MODULE_ID, STOCK_ROLLED_FLAG)) continue;

		// getItemRarity already falls back to parsing system.supply when the flag is unset.
		const { available, stock } = await rollStockValues(getItemRarity(item));
		if (!available) {
			deletions.push(item.id);
			continue;
		}

		const flags = { [STOCK_FLAG]: stock, [STOCK_ROLLED_FLAG]: true };
		// Carry the price across so the storefront has something to charge even when the
		// source item was never touched by the price migration.
		if (!item.getFlag(MODULE_ID, PRICE_FLAG)) {
			const price = parseCost(item.system?.cost);
			if (price) flags[PRICE_FLAG] = price;
		}
		updates.push({ _id: item.id, flags: { [MODULE_ID]: flags } });
	}

	try {
		if (updates.length) await merchant.updateEmbeddedDocuments("Item", updates);
		if (deletions.length) await merchant.deleteEmbeddedDocuments("Item", deletions);
	} catch (err) {
		console.warn(`${MODULE_ID} | merchant: failed to write stock for "${merchant.name}"`, err);
	}
}

/**
 * The entry a merchant already carries for the same goods, if any. Matched on type plus
 * name because that is what survives a drag from a folder: re-dropping the same folder is
 * meant to restock the shop, not to pile up duplicate rows.
 */
function findExistingStockEntry(item) {
	const name = item.name?.toLowerCase();
	return (
		item.parent?.items?.find(
			(other) =>
				other.id !== item.id && other.type === item.type && other.name?.toLowerCase() === name,
		) ?? null
	);
}

/** Remove a merchant's entire assortment. */
async function clearMerchantStock(merchant) {
	const ids = merchant.items.map((item) => item.id);
	if (!ids.length) return;
	try {
		await merchant.deleteEmbeddedDocuments("Item", ids);
	} catch (err) {
		console.warn(`${MODULE_ID} | merchant: failed to clear "${merchant.name}"`, err);
	}
}

/* -------------------------------------------- */
/*  Buyer resolution and purchases              */
/* -------------------------------------------- */

/**
 * The character a Buy click should spend from: the user's assigned character, else the
 * single controlled token's actor (which is also how a GM picks a buyer). Anything
 * ambiguous resolves to nothing so we never guess with someone else's coins.
 */
function resolveBuyer() {
	const assigned = game.user.character;
	if (assigned?.type === "character") return assigned;

	const controlled = canvas?.tokens?.controlled ?? [];
	if (controlled.length === 1 && controlled[0].actor?.type === "character") {
		return controlled[0].actor;
	}
	return null;
}

/**
 * Subtract a price from a purse, breaking a higher denomination into 10 of the next one
 * whenever the current denomination runs short — the same borrowing the system's own
 * currency buttons perform. Preserves the rest of the purse instead of re-normalizing
 * it: 5 silver + 2 copper paying 12 copper leaves 4 silver + 0 copper.
 *
 * @returns {{gold:number,silver:number,copper:number}|null} null when unaffordable.
 */
function deductCoins(actor, price) {
	const currency = actor.system?.currency ?? {};
	const coins = [
		Number(currency.gold?.value) || 0,
		Number(currency.silver?.value) || 0,
		Number(currency.copper?.value) || 0,
	];
	const cost = [price.gold, price.silver, price.copper];
	for (let i = 0; i < coins.length; i++) coins[i] -= cost[i];

	for (let i = coins.length - 1; i > 0; i--) {
		if (coins[i] >= 0) continue;
		const borrowed = Math.ceil(-coins[i] / 10);
		coins[i - 1] -= borrowed;
		coins[i] += borrowed * 10;
	}

	if (coins[0] < 0) return null;
	return { gold: coins[0], silver: coins[1], copper: coins[2] };
}

// Purchases are serialized so two players racing for the last unit cannot both win:
// the second request re-reads the stock only after the first has written it back.
let _purchaseQueue = Promise.resolve();

function enqueuePurchase(task) {
	const run = () =>
		task().catch((err) => {
			console.error(`${MODULE_ID} | merchant: purchase failed`, err);
			return { ok: false, reason: "MERCHANT.PURCHASE_FAILED" };
		});
	_purchaseQueue = _purchaseQueue.then(run, run);
	return _purchaseQueue;
}

/**
 * Authoritative purchase, executed only on the active GM's client.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function performPurchase({ merchantUuid, itemUuid, buyerUuid }) {
	if (!isAutomationEnabled()) return { ok: false, reason: "MERCHANT.PURCHASE_FAILED" };

	const merchant = await fromUuid(merchantUuid);
	const item = await fromUuid(itemUuid);
	const buyer = await fromUuid(buyerUuid);

	if (merchant?.type !== MERCHANT_TYPE) return { ok: false, reason: "MERCHANT.PURCHASE_FAILED" };
	if (!item || item.parent?.uuid !== merchant.uuid) return { ok: false, reason: "MERCHANT.OUT_OF_STOCK" };
	if (buyer?.type !== "character") return { ok: false, reason: "MERCHANT.NO_BUYER" };

	const stock = getStock(item);
	if (stock <= 0) return { ok: false, reason: "MERCHANT.OUT_OF_STOCK" };

	const price = getItemPrice(item);
	if (!price) return { ok: false, reason: "MERCHANT.NO_PRICE" };

	const purse = deductCoins(buyer, normalizePrice(price));
	if (!purse) return { ok: false, reason: "MERCHANT.NOT_ENOUGH_COINS" };

	await buyer.update({
		"system.currency.gold.value": purse.gold,
		"system.currency.silver.value": purse.silver,
		"system.currency.copper.value": purse.copper,
	});

	const itemData = item.toObject();
	delete itemData._id;
	delete itemData.folder;
	delete itemData.sort;
	// Merchant bookkeeping must not follow the goods into the buyer's inventory.
	const moduleFlags = itemData.flags?.[MODULE_ID];
	if (moduleFlags) {
		delete moduleFlags[STOCK_FLAG];
		delete moduleFlags[STOCK_ROLLED_FLAG];
	}
	if (itemData.system && Object.hasOwn(itemData.system, "quantity")) itemData.system.quantity = 1;
	// Land the purchase in the character's carried list rather than the unsorted pile.
	foundry.utils.setProperty(itemData, "flags.forbidden-lands.state", "carried");

	await buyer.createEmbeddedDocuments("Item", [itemData]);

	// Keep the row at 0 rather than deleting it: the GM still sees it as sold out and
	// can restock, while players stop seeing it entirely.
	await item.setFlag(MODULE_ID, STOCK_FLAG, stock - 1);

	if (game.settings.get(MODULE_ID, SETTING_MERCHANT_ANNOUNCE)) {
		const content = l("MERCHANT.PURCHASED")
			.replace("{actor}", escapeHTML(buyer.name))
			.replace("{item}", escapeHTML(item.name))
			.replace("{price}", escapeHTML(formatPrice(price)))
			.replace("{merchant}", escapeHTML(merchant.name));
		await ChatMessage.create({ content, speaker: { alias: buyer.name } });
	}

	return { ok: true };
}

/** Client-side entry point: pre-validate for instant feedback, then hand off to the GM. */
async function requestPurchase(merchant, item) {
	if (!isAutomationEnabled()) return;

	const buyer = resolveBuyer();
	if (!buyer) return void ui.notifications?.warn(l("MERCHANT.NO_BUYER"));
	if (getStock(item) <= 0) return void ui.notifications?.warn(l("MERCHANT.OUT_OF_STOCK"));

	const price = getItemPrice(item);
	if (!price) return void ui.notifications?.warn(l("MERCHANT.NO_PRICE"));
	if (getPurseCopper(buyer) < toCopper(price)) {
		return void ui.notifications?.warn(l("MERCHANT.NOT_ENOUGH_COINS"));
	}

	const payload = {
		operation: "merchantPurchase",
		merchantUuid: merchant.uuid,
		itemUuid: item.uuid,
		buyerUuid: buyer.uuid,
		userId: game.user.id,
	};

	// game.socket.emit never loops back to the sender, so an active GM must run it here.
	if (isActiveGM()) {
		const result = await enqueuePurchase(() => performPurchase(payload));
		if (!result.ok) ui.notifications?.warn(l(result.reason));
		return;
	}

	if (!game.users.activeGM) return void ui.notifications?.warn(l("MERCHANT.NO_ACTIVE_GM"));
	game.socket.emit(`module.${MODULE_ID}`, payload);
}

/**
 * A second listener on the module's socket channel is additive — it does not disturb
 * main.js's attack-state relay, and each listener ignores the other's operations.
 */
function registerMerchantSocket() {
	game.socket.on(`module.${MODULE_ID}`, async (data) => {
		if (data?.operation === "merchantPurchase") {
			if (!isActiveGM()) return;
			const result = await enqueuePurchase(() => performPurchase(data));
			game.socket.emit(`module.${MODULE_ID}`, {
				operation: "merchantPurchaseResult",
				userId: data.userId,
				ok: result.ok,
				reason: result.reason ?? null,
			});
			return;
		}

		if (data?.operation === "merchantPurchaseResult") {
			if (data.userId !== game.user.id || data.ok) return;
			ui.notifications?.warn(l(data.reason || "MERCHANT.PURCHASE_FAILED"));
		}
	});
}

/* -------------------------------------------- */
/*  Sheet                                       */
/* -------------------------------------------- */

class FblMerchantSheet extends foundry.appv1.sheets.ActorSheet {
	static get defaultOptions() {
		return foundry.utils.mergeObject(super.defaultOptions, {
			classes: ["forbidden-lands", "sheet", "actor", "fbl-merchant"],
			template: `modules/${MODULE_ID}/templates/merchant-sheet.hbs`,
			width: 620,
			height: 700,
			resizable: true,
			scrollY: [".merchant-goods .items"],
		});
	}

	async getData(options) {
		const context = await super.getData(options);
		const isGM = game.user.isGM;
		const buyer = resolveBuyer();
		const buyerCopper = buyer ? getPurseCopper(buyer) : 0;

		const goods = this.actor.items.contents
			.map((item) => {
				const price = normalizePrice(getItemPrice(item) || {});
				const priceCopper = toCopper(price);
				const stock = getStock(item);
				return {
					id: item.id,
					name: item.name,
					img: item.img,
					typeLabel: game.i18n.localize(CONFIG.Item.typeLabels?.[item.type] ?? item.type),
					rarityLabel: l(`PRICE.RARITY_${getItemRarity(item).toUpperCase()}`),
					stock,
					soldOut: stock <= 0,
					price,
					priceLabel: priceCopper > 0 ? formatPrice(price) : "—",
					// Blocked covers every reason the button cannot act, so the template
					// stays declarative and activateListeners has a single source of truth.
					blocked: stock <= 0 || priceCopper <= 0 || !buyer || buyerCopper < priceCopper,
				};
			})
			// Sold-out rows stay visible to the GM (to restock) but vanish for players.
			.filter((entry) => isGM || !entry.soldOut)
			.sort((a, b) => a.name.localeCompare(b.name));

		return foundry.utils.mergeObject(context, {
			isGM,
			goods,
			hasGoods: goods.length > 0,
			buyerName: buyer?.name ?? null,
			buyerPurse: buyer ? formatPrice(fromPurse(buyer)) : null,
			description: this.actor.system?.description ?? "",
		});
	}

	activateListeners(html) {
		super.activateListeners(html);

		// FormApplication._disableFields() disables every control when the sheet is not
		// editable — which is exactly the player storefront case (players are Observers).
		// Re-enable the Buy buttons and let `data-blocked` be the only thing that gates them.
		html.find("button.merchant-buy").each((_index, element) => {
			element.disabled = element.dataset.blocked === "true";
		});

		html.find("button.merchant-buy").on("click", (event) => {
			event.preventDefault();
			const item = this._itemFromEvent(event);
			if (item) void requestPurchase(this.actor, item);
		});

		if (!game.user.isGM) return;

		html.find("button.merchant-reroll").on("click", async (event) => {
			event.preventDefault();
			await stockItems(this.actor, [...this.actor.items], { reroll: true });
		});

		html.find("button.merchant-clear").on("click", async (event) => {
			event.preventDefault();
			// Wiping the whole assortment cannot be undone, so it is the one action here
			// that asks first. The reroll is not guarded: re-dropping the folder restores it.
			const confirmed = await Dialog.confirm({
				title: l("MERCHANT.CLEAR_ALL"),
				content: `<p>${l("MERCHANT.CLEAR_CONFIRM")}</p>`,
			});
			if (confirmed) await clearMerchantStock(this.actor);
		});

		html.find(".item-edit").on("click", (event) => {
			event.preventDefault();
			this._itemFromEvent(event)?.sheet?.render(true);
		});

		html.find(".item-delete").on("click", (event) => {
			event.preventDefault();
			void this._itemFromEvent(event)?.delete();
		});

		html.find("input.stock").on("change", (event) => {
			const item = this._itemFromEvent(event);
			if (!item) return;
			const value = Math.max(0, Math.round(Number(event.currentTarget.value) || 0));
			void item.setFlag(MODULE_ID, STOCK_FLAG, value);
		});

		html.find("input.price-part").on("change", (event) => {
			const item = this._itemFromEvent(event);
			if (!item) return;
			const part = event.currentTarget.dataset.part;
			if (!part) return;
			const price = normalizePrice(getItemPrice(item) || {});
			price[part] = Math.max(0, Math.round(Number(event.currentTarget.value) || 0));
			void item.setFlag(MODULE_ID, PRICE_FLAG, price);
		});
	}

	_itemFromEvent(event) {
		const id = event.currentTarget.closest("[data-item-id]")?.dataset?.itemId;
		return id ? this.actor.items.get(id) : null;
	}
}

/** The buyer's purse as a price triple, so formatPrice can render it. */
function fromPurse(actor) {
	const currency = actor.system?.currency ?? {};
	return normalizePrice({
		gold: currency.gold?.value,
		silver: currency.silver?.value,
		copper: currency.copper?.value,
	});
}

/* -------------------------------------------- */
/*  Settings & lifecycle                        */
/* -------------------------------------------- */

function registerMerchantSettings() {
	game.settings.register(MODULE_ID, SETTING_MERCHANT_AUTOMATION, {
		name: "FBL_ENHANCEMENTS.SETTINGS.MERCHANT_AUTOMATION.NAME",
		hint: "FBL_ENHANCEMENTS.SETTINGS.MERCHANT_AUTOMATION.HINT",
		scope: "world",
		config: true,
		type: Boolean,
		default: true,
	});

	game.settings.register(MODULE_ID, SETTING_MERCHANT_ANNOUNCE, {
		name: "FBL_ENHANCEMENTS.SETTINGS.MERCHANT_ANNOUNCE.NAME",
		hint: "FBL_ENHANCEMENTS.SETTINGS.MERCHANT_ANNOUNCE.HINT",
		scope: "world",
		config: true,
		type: Boolean,
		default: true,
	});
}

function registerMerchantHooks() {
	// Both single-item and folder drops arrive here as individual createItem events.
	Hooks.on("createItem", async (item) => {
		if (item.parent?.type !== MERCHANT_TYPE) return;
		if (!isActiveGM() || !isAutomationEnabled()) return;

		const merchant = item.parent;
		const existing = findExistingStockEntry(item);

		// Dropping goods the merchant already carries refreshes that entry instead of
		// adding a second row — this is what lets a GM re-drop a whole folder onto a
		// recurring merchant to restock it.
		if (existing) {
			try {
				await item.delete();
			} catch (err) {
				console.warn(`${MODULE_ID} | merchant: failed to drop duplicate "${item.name}"`, err);
				return;
			}
			await stockItems(merchant, [existing], { reroll: true });
			return;
		}

		await stockItems(merchant, [item]);
	});

	Hooks.on("preCreateActor", (actor, data) => {
		if (data?.type !== MERCHANT_TYPE) return;
		const updates = {};

		// Read from the document, not from `data`: by the time this hook runs both the
		// system's create() override and core's _preCreate have already written to it.
		if (isPlaceholderImg(actor.img)) updates.img = DEFAULT_MERCHANT_IMG;

		// Core copies the actor image into the prototype token during _preCreate, which
		// has also already happened — so the broken path must be cleared there as well,
		// otherwise the token keeps it and fails to load on the canvas.
		if (isPlaceholderImg(actor.prototypeToken?.texture?.src)) {
			updates["prototypeToken.texture.src"] = DEFAULT_MERCHANT_IMG;
		}
		// Observer by default so players can browse the storefront without the GM
		// configuring permissions on every merchant.
		if (!data.ownership?.default) {
			updates["ownership.default"] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
		}
		// Linked tokens share one stock pool; unlinked copies would each sell their own.
		if (data.prototypeToken?.actorLink === undefined) {
			updates["prototypeToken.actorLink"] = true;
		}
		actor.updateSource(updates);
	});
}

Hooks.once("init", () => {
	CONFIG.Actor.dataModels[MERCHANT_TYPE] = MerchantData;

	const actors = foundry.documents?.collections?.Actors ?? Actors;
	actors.registerSheet(MODULE_ID, FblMerchantSheet, {
		types: [MERCHANT_TYPE],
		makeDefault: true,
		label: "FBL_ENHANCEMENTS.MERCHANT.SHEET",
	});

	registerMerchantSettings();
	registerMerchantHooks();
});

/**
 * Repair merchants that were created before the portrait fix and still carry the
 * system's non-existent `fbl-<type>.webp` path. Only that one exact value is replaced,
 * so a portrait the GM picked themselves is never touched.
 */
async function repairMerchantImages() {
	const updates = [];
	for (const actor of game.actors ?? []) {
		if (actor.type !== MERCHANT_TYPE) continue;

		const update = { _id: actor.id };
		if (actor.img === SYSTEM_TYPE_IMG) update.img = DEFAULT_MERCHANT_IMG;
		if (actor.prototypeToken?.texture?.src === SYSTEM_TYPE_IMG) {
			update["prototypeToken.texture.src"] = DEFAULT_MERCHANT_IMG;
		}
		if (Object.keys(update).length > 1) updates.push(update);
	}

	if (!updates.length) return;
	try {
		await Actor.updateDocuments(updates);
		console.log(`${MODULE_ID} | merchant: repaired ${updates.length} placeholder portrait(s)`);
	} catch (err) {
		console.warn(`${MODULE_ID} | merchant: failed to repair merchant portraits`, err);
	}
}

Hooks.once("ready", () => {
	registerMerchantSocket();
	if (isActiveGM()) void repairMerchantImages();
});
