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
	MERCHANT_TYPE,
	MODULE_ID,
	PRICE_FLAG,
	deductCoins,
	escapeHTML,
	formatPrice,
	fromCopper,
	getItemPrice,
	getItemRarity,
	getPurseCopper,
	isActiveGM,
	l,
	normalizePrice,
	parseCost,
	parseRarity,
	toCopper,
} from "./economy.js";
import {
	addToRepairCart,
	addToSellCart,
	clearSellCart,
	findPendingSellRequests,
	getMerchantBuyPrice,
	isSellPending,
	performRepair,
	registerMerchantTradeSocket,
	removeFromRepairCart,
	removeFromSellCart,
	resolveRepairCartLines,
	resolveSellCartLines,
	resolveUserCharacter,
	reviewSellRequest,
	setSellCartQty,
	submitSellCart,
	MerchantSettingsApp,
} from "./merchant-trade.js";

export { MERCHANT_TYPE };

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

/* -------------------------------------------- */
/*  Data model                                  */
/* -------------------------------------------- */

class MerchantData extends foundry.abstract.TypeDataModel {
	static defineSchema() {
		const fields = foundry.data.fields;
		return {
			description: new fields.HTMLField({ required: false, blank: true }),
			// Percent markup/discount, -100..100. sellModifier biases what this merchant
			// charges players (Goods tab + repair cost); buyModifier biases what it offers
			// players for their own items (Sell tab). Both default to 0 (no change).
			sellModifier: new fields.NumberField({
				required: true,
				nullable: false,
				initial: 0,
				min: -100,
				max: 100,
				step: 1,
			}),
			buyModifier: new fields.NumberField({
				required: true,
				nullable: false,
				initial: 0,
				min: -100,
				max: 100,
				step: 1,
			}),
			repairEnabled: new fields.BooleanField({ required: true, initial: false }),
		};
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
 * The character a Buy/Sell/Repair click should act with: the user's assigned character,
 * else the single controlled token's actor (which is also how a GM picks one). Anything
 * ambiguous resolves to nothing so we never guess with someone else's coins. Defined in
 * merchant-trade.js since the sell/repair flows need the identical resolution.
 */
const resolveBuyer = resolveUserCharacter;

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

	const price = getMerchantBuyPrice(item, merchant);
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

	const price = getMerchantBuyPrice(item, merchant);
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
			// 700, not 620: five columns of localized headers plus the GM's price inputs
			// do not fit comfortably below this.
			width: 700,
			height: 700,
			resizable: true,
			scrollY: [".merchant-goods .items"],
			tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "goods" }],
		});
	}

	/** GM-only "Merchant Settings" button, alongside the window's own Configure/Sheet/Ownership controls. */
	_getHeaderButtons() {
		const buttons = super._getHeaderButtons();
		if (game.user.isGM) {
			buttons.unshift({
				label: l("MERCHANT.SETTINGS.MENU_BUTTON"),
				class: "merchant-settings-open",
				icon: "fas fa-coins",
				onclick: () => new MerchantSettingsApp({ merchant: this.actor }).render(true),
			});
		}
		return buttons;
	}

	async getData(options) {
		const context = await super.getData(options);
		const isGM = game.user.isGM;
		const buyer = resolveBuyer();
		const buyerCopper = buyer ? getPurseCopper(buyer) : 0;

		const goods = this.actor.items.contents
			.map((item) => {
				// `price` is the raw, unmodified base price flag — the GM's editable inputs
				// read and write this directly. `buyPrice` is what the storefront actually
				// shows and charges, biased by this merchant's sellModifier; the two diverge
				// only once a modifier is set, and must stay in sync with performPurchase's
				// own getMerchantBuyPrice call so the display never promises a price the
				// purchase doesn't honour.
				const price = normalizePrice(getItemPrice(item) || {});
				const buyPrice = normalizePrice(getMerchantBuyPrice(item, this.actor) || {});
				const buyPriceCopper = toCopper(buyPrice);
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
					priceLabel: buyPriceCopper > 0 ? formatPrice(buyPrice) : "—",
					// Blocked covers every reason the button cannot act, so the template
					// stays declarative and activateListeners has a single source of truth.
					blocked: stock <= 0 || buyPriceCopper <= 0 || !buyer || buyerCopper < buyPriceCopper,
				};
			})
			// Sold-out rows stay visible to the GM (to restock) but vanish for players.
			.filter((entry) => isGM || !entry.soldOut)
			.sort((a, b) => a.name.localeCompare(b.name));

		const repairEnabled = !!this.actor.system?.repairEnabled;

		const sellLines = buyer ? resolveSellCartLines(buyer, this.actor, { includeUnavailable: true }) : [];
		const sellPending = buyer ? isSellPending(buyer, this.actor.id) : false;
		const sellTotal = sellLines.reduce((sum, line) => sum + (line.unavailable ? 0 : toCopper(line.price) * line.qty), 0);

		const repairLines = repairEnabled && buyer
			? resolveRepairCartLines(buyer, this.actor, { includeUnavailable: true })
			: [];
		const repairTotal = repairLines.reduce((sum, line) => sum + (line.unavailable ? 0 : line.costCopper), 0);

		const pendingSellRequests = isGM
			? findPendingSellRequests(this.actor).map((request) => ({
					sellerId: request.seller.id,
					sellerName: request.seller.name,
					itemCount: request.itemCount,
				}))
			: [];

		return foundry.utils.mergeObject(context, {
			isGM,
			goods,
			hasGoods: goods.length > 0,
			buyerName: buyer?.name ?? null,
			buyerPurse: buyer ? formatPrice(fromPurse(buyer)) : null,
			description: this.actor.system?.description ?? "",
			repairEnabled,
			sellModifier: this.actor.system?.sellModifier ?? 0,
			buyModifier: this.actor.system?.buyModifier ?? 0,
			sellLines,
			hasSellLines: sellLines.length > 0,
			sellPending,
			sellTotalLabel: formatPrice(fromCopper(sellTotal)),
			repairLines,
			hasRepairLines: repairLines.length > 0,
			repairTotalLabel: formatPrice(fromCopper(repairTotal)),
			pendingSellRequests,
			hasPendingSellRequests: pendingSellRequests.length > 0,
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

		// Sell/Repair tabs act on the acting player's own character, not the merchant, so
		// they're wired for everyone (including a GM playing a secondary character) rather
		// than gated behind the GM-only block below.
		this._activateSellListeners(html);
		this._activateRepairListeners(html);

		// Cosmetic highlight only — the drop itself already works via the inherited AppV1
		// dragDrop config (dragover is globally preventDefault-ed), this just shows where.
		html.find(".merchant-dropzone").on("dragenter", (event) => {
			event.currentTarget.classList.add("dragover");
		});
		html.find(".merchant-dropzone").on("dragleave drop", (event) => {
			event.currentTarget.classList.remove("dragover");
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
			const confirmed = await foundry.applications.api.DialogV2.confirm({
				window: { title: l("MERCHANT.CLEAR_ALL") },
				content: `<p>${l("MERCHANT.CLEAR_CONFIRM")}</p>`,
				modal: true,
				rejectClose: false,
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

		html.find("button.merchant-sell-review").on("click", (event) => {
			event.preventDefault();
			const sellerId = event.currentTarget.closest("[data-seller-id]")?.dataset?.sellerId;
			const seller = sellerId ? game.actors.get(sellerId) : null;
			if (seller) reviewSellRequest(this.actor, seller);
		});
	}

	/** Sell tab: everyone acts on their own resolved character's cart, never the merchant. */
	_activateSellListeners(html) {
		// Same FormApplication._disableFields() workaround as the Buy button above: these
		// controls act on the player's OWN actor, never the merchant, so they must stay
		// enabled even though the player is only an Observer (not Owner) on the merchant.
		html.find("button.merchant-sell-clear, button.merchant-sell-submit, .sell-cart-remove")
			.prop("disabled", false);
		html.find("input.qty-input").prop("disabled", false);

		html.find("button.merchant-sell-clear").on("click", async (event) => {
			event.preventDefault();
			const seller = resolveBuyer();
			if (seller) await clearSellCart(seller, this.actor);
		});

		html.find("button.merchant-sell-submit").on("click", async (event) => {
			event.preventDefault();
			const seller = resolveBuyer();
			if (seller) await submitSellCart(this.actor, seller);
		});

		html.find("input.qty-input").on("change", async (event) => {
			const seller = resolveBuyer();
			const itemId = event.currentTarget.closest("[data-item-id]")?.dataset?.itemId;
			if (!seller || !itemId) return;
			await setSellCartQty(seller, this.actor, itemId, event.currentTarget.value);
		});

		html.find(".sell-cart-remove").on("click", async (event) => {
			event.preventDefault();
			const seller = resolveBuyer();
			const itemId = event.currentTarget.closest("[data-item-id]")?.dataset?.itemId;
			if (seller && itemId) await removeFromSellCart(seller, this.actor, itemId);
		});
	}

	/** Repair tab: same acting-character rule as Sell, only rendered when repairEnabled. */
	_activateRepairListeners(html) {
		// Same FormApplication._disableFields() workaround as the Sell tab above.
		html.find("button.merchant-repair-confirm, .repair-cart-remove").prop("disabled", false);

		html.find("button.merchant-repair-confirm").on("click", async (event) => {
			event.preventDefault();
			const repairer = resolveBuyer();
			if (!repairer) return void ui.notifications?.warn(l("MERCHANT.NO_ACTIVE_CHARACTER"));
			const result = await performRepair(this.actor, repairer);
			if (!result.ok) ui.notifications?.warn(l(result.reason));
		});

		html.find(".repair-cart-remove").on("click", async (event) => {
			event.preventDefault();
			const repairer = resolveBuyer();
			const itemId = event.currentTarget.closest("[data-item-id]")?.dataset?.itemId;
			if (repairer && itemId) await removeFromRepairCart(repairer, this.actor, itemId);
		});
	}

	/**
	 * Core `DragDrop` checks this BEFORE a drop ever reaches `_onDrop` at all — the
	 * inherited implementation gates it on `this.isEditable`, which resolves false for
	 * every player (default Observer on a merchant), so drops onto the Sell/Repair zones
	 * silently did nothing: `_onDrop` below was never even called. Sell/Repair never
	 * touch the merchant document (only the dropping player's own actor), and the Goods
	 * tab's own `_onDropItem` re-checks `this.actor.isOwner` regardless — so it's safe to
	 * always allow the drop attempt through and let `_onDrop` decide.
	 */
	_canDragDrop() {
		return true;
	}

	/**
	 * Sell/Repair drop zones bypass the inherited AppV1 `_onDropItem`, which requires
	 * `this.actor.isOwner` on the MERCHANT — a permission players never have (default
	 * Observer). These drops never touch the merchant document at all: they add a
	 * reference into the dropping player's own private cart. Any other drop target (the
	 * Goods tab) falls through unchanged to the inherited GM-stocking behavior.
	 */
	async _onDrop(event) {
		const zone = event.target?.closest?.(".merchant-sell-drop, .merchant-repair-drop");
		if (!zone) return super._onDrop(event);

		event.preventDefault();
		event.stopPropagation();

		let data;
		try {
			data = JSON.parse(event.dataTransfer.getData("text/plain"));
		} catch (err) {
			return;
		}
		if (data?.type !== "Item") return;

		const item = await fromUuid(data.uuid);
		const actor = resolveBuyer();
		if (!item || !actor || item.parent?.id !== actor.id) {
			return void ui.notifications?.warn(l("MERCHANT.NO_ACTIVE_CHARACTER"));
		}

		if (zone.classList.contains("merchant-sell-drop")) {
			await addToSellCart(actor, this.actor, item);
		} else {
			await addToRepairCart(actor, this.actor, item);
		}
		this.render();
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

	// The Sell/Repair tabs (and the Goods tab's affordability check) render the acting
	// user's OWN character's cart flags and purse — not the merchant's — so AppV1's
	// built-in "re-render when `this.object` changes" behavior (which is what already
	// keeps the Goods tab's stock in sync) never fires for either. A sell accept/reject
	// mutates the seller's actor from the GM's client (unlocking the seller's own open
	// sheet without a manual reload); editing a character's coin purse directly on their
	// own sheet — not through a purchase — previously left every open merchant window
	// showing a stale "not enough coins" block until manually reopened. Both are cheap,
	// rare enough events to leave unguarded beyond the flag/currency check.
	Hooks.on("updateActor", (actor, changes) => {
		const tradeFlags = changes.flags?.[MODULE_ID];
		const touchesTrade =
			tradeFlags && ("sellCart" in tradeFlags || "sellPending" in tradeFlags || "repairCart" in tradeFlags);
		const touchesCurrency = !!changes.system?.currency;
		if (!touchesTrade && !touchesCurrency) return;
		for (const app of Object.values(ui.windows)) {
			if (app instanceof FblMerchantSheet) app.render(false);
		}
	});
}

Hooks.once("init", () => {
	CONFIG.Actor.dataModels[MERCHANT_TYPE] = MerchantData;

	// The bare `Actors` global is a deprecated backwards-compatibility reference in V14
	// (removed in V16); address the collection through its namespaced path only.
	foundry.documents.collections.Actors.registerSheet(MODULE_ID, FblMerchantSheet, {
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
	registerMerchantTradeSocket();
	if (isActiveGM()) void repairMerchantImages();
});
