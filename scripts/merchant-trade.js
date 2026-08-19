/**
 * Forbidden Lands Enhancements — Merchant trade (sell-to-merchant, repair, pricing)
 *
 * Owns everything the merchant's Sell and Repair tabs need: the pricing formulas (condition-
 * based discount, per-merchant buy/sell modifiers, repair cost), the player's private cart
 * storage, the GM's sale-review dialog, and the per-merchant settings dialog.
 *
 * Cart storage lives entirely on the *player's own character actor*
 * (`flags["fbl-enhancements"].{sellCart,sellPending,repairCart}`), never on the merchant and
 * never in client-scope settings: the player already has Owner permission on their own actor,
 * so building/editing a cart needs no socket at all, privacy falls straight out of Foundry's
 * existing document-permission system, and it survives reloads. A cart entry is a *reference*
 * (item id, plus quantity for sell) into the player's unchanged inventory — items are never
 * moved or duplicated while a cart is being built or is pending GM review.
 *
 * Sockets here are UX nudges only, never the authority: every mutation that changes money or
 * items runs on a client that already owns the actor being changed (the player's own client for
 * cart edits and repair; the GM's client for sell accept/reject, since a GM implicitly has full
 * permission on every actor — the same principle `performPurchase` in merchant.js already relies
 * on). See `registerMerchantTradeSocket` for the two operations.
 */

import {
	MERCHANT_TYPE,
	MODULE_ID,
	PRICEABLE_TYPES,
	applyModifier,
	creditCoins,
	deductCoins,
	escapeHTML,
	formatPrice,
	fromCopper,
	getItemPrice,
	getPurseCopper,
	isActiveGM,
	l,
	normalizePrice,
	toCopper,
} from "./economy.js";

const SELL_CART_FLAG = "sellCart";
const SELL_PENDING_FLAG = "sellPending";
const REPAIR_CART_FLAG = "repairCart";

// Same world setting the buy flow already gates its chat announcement on — reused here for
// the sold/repaired lines too, since it's the one existing "should this post to chat" toggle.
const SETTING_MERCHANT_ANNOUNCE = "merchantAnnouncePurchases";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* -------------------------------------------- */
/*  Acting-character resolution                 */
/* -------------------------------------------- */

/**
 * The character a Buy/Sell/Repair click should act with: the user's assigned character, else
 * the single controlled token's actor (which is also how a GM picks one). Anything ambiguous
 * resolves to nothing so we never guess with someone else's coins.
 */
export function resolveUserCharacter() {
	const assigned = game.user.character;
	if (assigned?.type === "character") return assigned;

	const controlled = canvas?.tokens?.controlled ?? [];
	if (controlled.length === 1 && controlled[0].actor?.type === "character") {
		return controlled[0].actor;
	}
	return null;
}

function findUserIdForCharacter(actor) {
	return (game.users?.contents ?? []).find((user) => user.character?.id === actor.id)?.id ?? null;
}

/* -------------------------------------------- */
/*  Pricing formulas                            */
/* -------------------------------------------- */

/**
 * Condition, as a price fraction: `system.bonus.{value,max}` is the same real system field
 * weapons/armor/gear/rawMaterial already use for their condition rating (confirmed against the
 * upstream `template.json` and `Item#isBroken`). Full condition → 1.0 (100%); zero → exactly
 * 0.1 (10%), proportional to the missing fraction in between. Items with no condition concept
 * (`max <= 0`) are never discounted.
 */
export function getConditionFactor(item) {
	const max = Number(item?.system?.bonus?.max) || 0;
	if (max <= 0) return 1;
	const value = Math.max(0, Math.min(max, Number(item?.system?.bonus?.value) || 0));
	return 0.1 + 0.9 * (value / max);
}

/**
 * The price the merchant *charges* a player — the storefront Goods tab and the authoritative
 * purchase both read this, so a non-zero `sellModifier` never lets the two drift apart.
 */
export function getMerchantBuyPrice(item, merchant) {
	const base = getItemPrice(item);
	if (!base) return null;
	const copper = applyModifier(toCopper(base), merchant?.system?.sellModifier ?? 0);
	return fromCopper(copper);
}

/** The price the merchant *offers* for a player's item, biased by condition and buyModifier. */
export function getSellOfferPrice(item, merchant) {
	const base = getItemPrice(item);
	if (!base) return null;
	const copper = applyModifier(
		toCopper(base) * getConditionFactor(item),
		merchant?.system?.buyModifier ?? 0,
	);
	return fromCopper(copper);
}

/**
 * Repair cost, exactly per the user's formula: price / max condition = cost per point, times
 * the missing points, biased by the merchant's *sell* modifier (repair is something the
 * merchant sells the player, not buys). `null` when the item isn't damaged, has no condition
 * concept, or has no price to base the cost on.
 */
export function computeRepairCost(item, merchant) {
	const max = Number(item?.system?.bonus?.max) || 0;
	const value = Math.max(0, Math.min(max, Number(item?.system?.bonus?.value) || 0));
	if (max <= 0 || value >= max) return null;
	const base = getItemPrice(item);
	if (!base) return null;
	const unitCopper = toCopper(base) / max;
	const rawCopper = unitCopper * (max - value);
	const copper = applyModifier(rawCopper, merchant?.system?.sellModifier ?? 0);
	return { copper, price: fromCopper(copper) };
}

/* -------------------------------------------- */
/*  Cart storage (flags on the player's actor)  */
/* -------------------------------------------- */

export function getSellCart(actor, merchantId) {
	return actor?.getFlag?.(MODULE_ID, SELL_CART_FLAG)?.[merchantId] ?? [];
}

export function getRepairCart(actor, merchantId) {
	return actor?.getFlag?.(MODULE_ID, REPAIR_CART_FLAG)?.[merchantId] ?? [];
}

export function isSellPending(actor, merchantId) {
	return !!actor?.getFlag?.(MODULE_ID, SELL_PENDING_FLAG)?.[merchantId];
}

/** Adds a dragged item to the seller's private sell cart for this merchant. No socket. */
export async function addToSellCart(seller, merchant, item) {
	if (!PRICEABLE_TYPES.includes(item.type)) return;
	if (!getItemPrice(item)) return void ui.notifications?.warn(l("MERCHANT.SELL_NO_PRICE_ITEM"));

	const cart = getSellCart(seller, merchant.id);
	if (cart.some((entry) => entry.itemId === item.id)) {
		return void ui.notifications?.info(l("MERCHANT.SELL_ALREADY_IN_CART"));
	}
	await seller.update({
		[`flags.${MODULE_ID}.${SELL_CART_FLAG}.${merchant.id}`]: [...cart, { itemId: item.id, qty: 1 }],
	});
}

export async function removeFromSellCart(seller, merchant, itemId) {
	const cart = getSellCart(seller, merchant.id).filter((entry) => entry.itemId !== itemId);
	await seller.update({ [`flags.${MODULE_ID}.${SELL_CART_FLAG}.${merchant.id}`]: cart });
}

export async function setSellCartQty(seller, merchant, itemId, qty) {
	const item = seller.items.get(itemId);
	const maxQty = Math.max(1, Number(item?.system?.quantity ?? 1));
	const clamped = Math.max(1, Math.min(maxQty, Math.round(Number(qty) || 1)));
	const cart = getSellCart(seller, merchant.id).map((entry) =>
		entry.itemId === itemId ? { ...entry, qty: clamped } : entry,
	);
	await seller.update({ [`flags.${MODULE_ID}.${SELL_CART_FLAG}.${merchant.id}`]: cart });
}

export async function clearSellCart(seller, merchant) {
	await seller.update({ [`flags.${MODULE_ID}.${SELL_CART_FLAG}.${merchant.id}`]: [] });
}

/** Adds a dragged item to the repairer's private repair cart. No socket. */
export async function addToRepairCart(repairer, merchant, item) {
	if (!PRICEABLE_TYPES.includes(item.type)) return;
	const max = Number(item.system?.bonus?.max) || 0;
	const value = Number(item.system?.bonus?.value) || 0;
	if (max <= 0 || !getItemPrice(item)) {
		return void ui.notifications?.warn(l("MERCHANT.REPAIR_NOT_REPAIRABLE"));
	}
	if (value >= max) return void ui.notifications?.info(l("MERCHANT.REPAIR_NOT_DAMAGED"));

	const cart = getRepairCart(repairer, merchant.id);
	if (cart.some((entry) => entry.itemId === item.id)) {
		return void ui.notifications?.info(l("MERCHANT.SELL_ALREADY_IN_CART"));
	}
	await repairer.update({
		[`flags.${MODULE_ID}.${REPAIR_CART_FLAG}.${merchant.id}`]: [...cart, { itemId: item.id }],
	});
}

export async function removeFromRepairCart(repairer, merchant, itemId) {
	const cart = getRepairCart(repairer, merchant.id).filter((entry) => entry.itemId !== itemId);
	await repairer.update({ [`flags.${MODULE_ID}.${REPAIR_CART_FLAG}.${merchant.id}`]: cart });
}

export async function clearRepairCart(repairer, merchant) {
	await repairer.update({ [`flags.${MODULE_ID}.${REPAIR_CART_FLAG}.${merchant.id}`]: [] });
}

/* -------------------------------------------- */
/*  Cart → renderable lines                     */
/* -------------------------------------------- */

/**
 * Resolves a seller's sell cart into live, priced rows. Stale entries (the item no longer
 * exists — moved, deleted, or sold elsewhere since being queued) are dropped unless
 * `includeUnavailable` is set, in which case they render as a disabled "unavailable" row so the
 * owner's own Sell tab can offer a Remove control instead of silently vanishing.
 */
export function resolveSellCartLines(seller, merchant, { includeUnavailable = false } = {}) {
	const cart = getSellCart(seller, merchant.id);
	const lines = [];
	for (const entry of cart) {
		const item = seller.items.get(entry.itemId);
		if (!item) {
			if (includeUnavailable) lines.push({ itemId: entry.itemId, unavailable: true });
			continue;
		}
		const maxQty = Math.max(1, Number(item.system?.quantity ?? 1));
		const qty = Math.max(1, Math.min(maxQty, Math.round(Number(entry.qty) || 1)));
		const price = normalizePrice(getSellOfferPrice(item, merchant) || {});
		lines.push({
			itemId: item.id,
			name: item.name,
			img: item.img,
			qty,
			maxQty,
			price,
			priceLabel: formatPrice(price),
			subtotalLabel: formatPrice(fromCopper(toCopper(price) * qty)),
			unavailable: false,
		});
	}
	return lines;
}

export function resolveRepairCartLines(repairer, merchant, { includeUnavailable = false } = {}) {
	const cart = getRepairCart(repairer, merchant.id);
	const lines = [];
	for (const entry of cart) {
		const item = repairer.items.get(entry.itemId);
		if (!item) {
			if (includeUnavailable) lines.push({ itemId: entry.itemId, unavailable: true });
			continue;
		}
		const max = Number(item.system?.bonus?.max) || 0;
		const value = Math.max(0, Math.min(max, Number(item.system?.bonus?.value) || 0));
		const cost = computeRepairCost(item, merchant);
		lines.push({
			itemId: item.id,
			name: item.name,
			img: item.img,
			conditionLabel: `${value}/${max}`,
			costLabel: cost ? formatPrice(cost.price) : "—",
			costCopper: cost?.copper ?? 0,
			unavailable: false,
		});
	}
	return lines;
}

/* -------------------------------------------- */
/*  Repair — direct, no GM step, no socket       */
/* -------------------------------------------- */

/**
 * Executes on the repairing player's own client: they already own the actor being mutated, and
 * nothing about repair needs GM discretion (unlike selling), so this runs straight through once
 * `repairEnabled` is confirmed for the given merchant.
 */
export async function performRepair(merchant, repairer) {
	if (!merchant.system?.repairEnabled) return { ok: false, reason: "MERCHANT.REPAIR_DISABLED" };

	const cart = getRepairCart(repairer, merchant.id);
	const items = cart.map((entry) => repairer.items.get(entry.itemId)).filter(Boolean);
	const repairable = items.filter((item) => computeRepairCost(item, merchant));
	if (!repairable.length) return { ok: false, reason: "MERCHANT.REPAIR_EMPTY" };

	let totalCopper = 0;
	for (const item of repairable) totalCopper += computeRepairCost(item, merchant).copper;

	if (getPurseCopper(repairer) < totalCopper) {
		return { ok: false, reason: "MERCHANT.REPAIR_NOT_ENOUGH_COINS" };
	}
	const purse = deductCoins(repairer, fromCopper(totalCopper));
	if (!purse) return { ok: false, reason: "MERCHANT.REPAIR_NOT_ENOUGH_COINS" };

	await repairer.updateEmbeddedDocuments(
		"Item",
		repairable.map((item) => ({ _id: item.id, "system.bonus.value": item.system.bonus.max })),
	);
	await repairer.update({
		"system.currency.gold.value": purse.gold,
		"system.currency.silver.value": purse.silver,
		"system.currency.copper.value": purse.copper,
		[`flags.${MODULE_ID}.${REPAIR_CART_FLAG}.${merchant.id}`]: [],
	});

	if (game.settings.get(MODULE_ID, SETTING_MERCHANT_ANNOUNCE)) {
		const content = l("MERCHANT.REPAIRED")
			.replace("{actor}", escapeHTML(repairer.name))
			.replace("{n}", String(repairable.length))
			.replace("{merchant}", escapeHTML(merchant.name))
			.replace("{price}", escapeHTML(formatPrice(fromCopper(totalCopper))));
		await ChatMessage.create({ content, speaker: { alias: repairer.name } });
	}

	return { ok: true };
}

/* -------------------------------------------- */
/*  Sell — cart submit + GM review              */
/* -------------------------------------------- */

const openReviewApps = new Map();
const reviewKey = (merchant, seller) => `${merchant.id}:${seller.id}`;

/** Opens (or refocuses) the GM's review dialog for one seller+merchant pair. */
async function openSellReview({ merchant, seller, sellerUserId = null, requestId = null } = {}) {
	const key = reviewKey(merchant, seller);
	const resolvedUserId = sellerUserId ?? findUserIdForCharacter(seller);

	const existing = openReviewApps.get(key);
	if (existing) {
		existing.sellerUserId = resolvedUserId;
		existing.requestId = requestId ?? existing.requestId;
		existing.lines = null; // force a fresh read of the live cart on next render
		existing.render(true);
		return existing;
	}

	const app = new MerchantSellReviewApp({ merchant, seller, sellerUserId: resolvedUserId, requestId });
	openReviewApps.set(key, app);
	app.render(true);
	return app;
}

/** GM-only helper for the Goods tab's "Pending Sell Requests" panel. */
export function findPendingSellRequests(merchant) {
	const requests = [];
	for (const actor of game.actors ?? []) {
		if (actor.type !== "character") continue;
		if (!isSellPending(actor, merchant.id)) continue;
		requests.push({ seller: actor, itemCount: getSellCart(actor, merchant.id).length });
	}
	return requests;
}

/** Reopens the review dialog for a pending request the GM clicks from the Goods tab panel. */
export function reviewSellRequest(merchant, seller) {
	void openSellReview({ merchant, seller });
}

/**
 * Client entry point for the seller. Locks the cart (the cart itself is the snapshot — nothing
 * is copied elsewhere, which is what makes "reject repopulates the exact submitted list"
 * trivial: reject just flips the lock back off) and nudges the GM to look.
 */
export async function submitSellCart(merchant, seller) {
	const cart = getSellCart(seller, merchant.id);
	if (!cart.length) return void ui.notifications?.warn(l("MERCHANT.SELL_NO_ITEMS"));

	const requestId = foundry.utils.randomID();
	await seller.update({ [`flags.${MODULE_ID}.${SELL_PENDING_FLAG}.${merchant.id}`]: true });
	ui.notifications?.info(l("MERCHANT.SELL_SUBMITTED"));

	// A GM playing a secondary character sells to their own merchant: open locally, no socket
	// (game.socket.emit never loops back to the sender).
	if (isActiveGM()) {
		void openSellReview({ merchant, seller, sellerUserId: game.user.id, requestId });
		return;
	}

	if (!game.users.activeGM) return void ui.notifications?.warn(l("MERCHANT.NO_ACTIVE_GM"));
	game.socket.emit(`module.${MODULE_ID}`, {
		operation: "merchantSellNotify",
		requestId,
		merchantUuid: merchant.uuid,
		sellerUuid: seller.uuid,
		userId: game.user.id,
	});
}

function notifySellDecision(sellerUserId, requestId, decision) {
	if (!sellerUserId) return;
	// Emitting to yourself never arrives (game.socket.emit doesn't loop back), so a GM
	// deciding on their own submitted offer needs a direct notification instead.
	if (sellerUserId === game.user.id) {
		ui.notifications?.info(l(decision === "accept" ? "MERCHANT.SELL_ACCEPTED" : "MERCHANT.SELL_REJECTED"));
		return;
	}
	game.socket.emit(`module.${MODULE_ID}`, {
		operation: "merchantSellDecision",
		requestId,
		decision,
		userId: sellerUserId,
	});
}

/**
 * Authoritative accept, run unconditionally on the GM's own client — this dialog only ever
 * exists there, so there's no isActiveGM branch to take (unlike performPurchase, which can also
 * be invoked over the socket from a player's client). `lines` is the dialog's own (possibly
 * GM-edited) working set: quantities and prices here are what actually gets charged/paid.
 */
export async function performSellAccept({ merchant, seller, lines, sellerUserId, requestId }) {
	const updateItems = [];
	const deleteItemIds = [];
	let totalCopper = 0;
	let count = 0;

	for (const line of lines ?? []) {
		const item = seller.items.get(line.itemId);
		if (!item) continue;
		const qty = Math.max(0, Math.round(Number(line.qty) || 0));
		if (qty <= 0) continue;

		const currentQty = Math.max(1, Number(item.system?.quantity ?? 1));
		const sellQty = Math.min(qty, currentQty);
		const unitCopper = toCopper(normalizePrice(line.price));
		totalCopper += unitCopper * sellQty;
		count += 1;

		if (sellQty >= currentQty) deleteItemIds.push(item.id);
		else updateItems.push({ _id: item.id, "system.quantity": currentQty - sellQty });
	}

	if (!count) return { ok: false, reason: "MERCHANT.REVIEW.EMPTY" };

	if (updateItems.length) await seller.updateEmbeddedDocuments("Item", updateItems);
	if (deleteItemIds.length) await seller.deleteEmbeddedDocuments("Item", deleteItemIds);

	const purse = creditCoins(seller, fromCopper(totalCopper));
	await seller.update({
		"system.currency.gold.value": purse.gold,
		"system.currency.silver.value": purse.silver,
		"system.currency.copper.value": purse.copper,
		[`flags.${MODULE_ID}.${SELL_PENDING_FLAG}.${merchant.id}`]: false,
		[`flags.${MODULE_ID}.${SELL_CART_FLAG}.${merchant.id}`]: [],
	});

	if (game.settings.get(MODULE_ID, SETTING_MERCHANT_ANNOUNCE)) {
		const content = l("MERCHANT.SOLD")
			.replace("{actor}", escapeHTML(seller.name))
			.replace("{n}", String(count))
			.replace("{merchant}", escapeHTML(merchant.name))
			.replace("{price}", escapeHTML(formatPrice(fromCopper(totalCopper))));
		await ChatMessage.create({ content, speaker: { alias: seller.name } });
	}

	notifySellDecision(sellerUserId, requestId, "accept");
	return { ok: true };
}

/** Authoritative reject — the cart flag is left untouched, only the pending lock clears. */
export async function performSellReject({ merchant, seller, sellerUserId, requestId }) {
	await seller.update({ [`flags.${MODULE_ID}.${SELL_PENDING_FLAG}.${merchant.id}`]: false });
	notifySellDecision(sellerUserId, requestId, "reject");
	return { ok: true };
}

/* -------------------------------------------- */
/*  GM sale-review dialog                       */
/* -------------------------------------------- */

class MerchantSellReviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
	constructor({ merchant, seller, sellerUserId = null, requestId = null } = {}) {
		super({ id: `fbl-merchant-sell-review-${merchant.id}-${seller.id}` });
		this.merchant = merchant;
		this.seller = seller;
		this.sellerUserId = sellerUserId;
		this.requestId = requestId;
		/** Populated once from the live cart, then mutated in place by GM edits. */
		this.lines = null;
	}

	static DEFAULT_OPTIONS = {
		classes: ["fbl-merchant-sell-review", "forbidden-lands"],
		position: { width: 480, height: "auto" },
		window: {
			title: "FBL_ENHANCEMENTS.MERCHANT.REVIEW.TITLE",
			icon: "fas fa-hand-holding-dollar",
			resizable: true,
		},
		actions: {
			accept: async function () {
				if (!this.lines?.length) return;
				const result = await performSellAccept({
					merchant: this.merchant,
					seller: this.seller,
					lines: this.lines,
					sellerUserId: this.sellerUserId,
					requestId: this.requestId,
				});
				if (!result.ok) return void ui.notifications?.warn(l(result.reason));
				await this.close();
			},
			reject: async function () {
				await performSellReject({
					merchant: this.merchant,
					seller: this.seller,
					sellerUserId: this.sellerUserId,
					requestId: this.requestId,
				});
				await this.close();
			},
			removeLine: function (event, target) {
				const itemId = target?.closest("[data-item-id]")?.dataset?.itemId;
				if (!itemId || !this.lines) return;
				this.lines = this.lines.filter((line) => line.itemId !== itemId);
				this.render();
			},
		},
	};

	static PARTS = {
		body: { template: `modules/${MODULE_ID}/templates/merchant-sell-review.hbs` },
	};

	async _prepareContext() {
		if (!this.lines) this.lines = resolveSellCartLines(this.seller, this.merchant);
		const lines = this.lines.map((line) => ({
			...line,
			subtotalLabel: formatPrice(fromCopper(toCopper(line.price) * line.qty)),
		}));
		const total = lines.reduce((sum, line) => sum + toCopper(line.price) * line.qty, 0);
		return {
			sellerName: this.seller.name,
			merchantName: this.merchant.name,
			lines,
			totalLabel: formatPrice(fromCopper(total)),
			empty: lines.length === 0,
		};
	}

	_onRender(context, options) {
		super._onRender?.(context, options);

		this.element.querySelectorAll("[data-item-id] .qty-input").forEach((input) => {
			input.addEventListener("change", (event) => {
				const itemId = event.currentTarget.closest("[data-item-id]")?.dataset?.itemId;
				const line = this.lines?.find((entry) => entry.itemId === itemId);
				if (!line) return;
				line.qty = Math.max(1, Math.min(line.maxQty, Math.round(Number(event.currentTarget.value) || 1)));
				this.render();
			});
		});

		this.element.querySelectorAll("[data-item-id] .price-part").forEach((input) => {
			input.addEventListener("change", (event) => {
				const row = event.currentTarget.closest("[data-item-id]");
				const itemId = row?.dataset?.itemId;
				const part = event.currentTarget.dataset.part;
				const line = this.lines?.find((entry) => entry.itemId === itemId);
				if (!line || !part) return;
				line.price[part] = Math.max(0, Math.round(Number(event.currentTarget.value) || 0));
				this.render();
			});
		});
	}

	async close(options) {
		openReviewApps.delete(reviewKey(this.merchant, this.seller));
		return super.close(options);
	}
}

/* -------------------------------------------- */
/*  Per-merchant settings dialog                */
/* -------------------------------------------- */

export class MerchantSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
	constructor({ merchant, ...options } = {}) {
		super({ ...options, id: `fbl-merchant-settings-${merchant.id}` });
		this.merchant = merchant;
	}

	static DEFAULT_OPTIONS = {
		tag: "form",
		classes: ["fbl-merchant-settings", "forbidden-lands", "standard-form"],
		position: { width: 420, height: "auto" },
		window: {
			title: "FBL_ENHANCEMENTS.MERCHANT.SETTINGS.TITLE",
			icon: "fas fa-coins",
			contentClasses: ["standard-form"],
			resizable: false,
		},
		form: {
			handler: MerchantSettingsApp.onSubmit,
			submitOnChange: false,
			closeOnSubmit: true,
		},
	};

	static PARTS = {
		body: { template: `modules/${MODULE_ID}/templates/merchant-settings.hbs` },
		footer: { template: "templates/generic/form-footer.hbs" },
	};

	async _prepareContext() {
		return {
			sellModifier: this.merchant.system.sellModifier,
			buyModifier: this.merchant.system.buyModifier,
			repairEnabled: this.merchant.system.repairEnabled,
			buttons: [{ type: "submit", icon: "fas fa-save", label: "FBL_ENHANCEMENTS.MERCHANT.SETTINGS.SAVE" }],
		};
	}

	_onRender(context, options) {
		super._onRender?.(context, options);
		this.element.querySelectorAll(".modifier-pair").forEach((pair) => {
			const range = pair.querySelector('input[type="range"]');
			const number = pair.querySelector('input[type="number"]');
			if (!range || !number) return;
			range.addEventListener("input", () => (number.value = range.value));
			number.addEventListener("input", () => {
				const clamped = Math.max(-100, Math.min(100, Math.round(Number(number.value) || 0)));
				range.value = String(clamped);
			});
		});
	}

	static async onSubmit(event, form, formData) {
		const data = foundry.utils.expandObject(formData.object);
		await this.merchant.update({
			"system.sellModifier": Math.max(-100, Math.min(100, Math.round(Number(data.sellModifier) || 0))),
			"system.buyModifier": Math.max(-100, Math.min(100, Math.round(Number(data.buyModifier) || 0))),
			"system.repairEnabled": !!data.repairEnabled,
		});
	}
}

/* -------------------------------------------- */
/*  Socket                                      */
/* -------------------------------------------- */

/**
 * A second `game.socket.on` registration on the shared channel is additive — it doesn't disturb
 * main.js's attack-state relay or merchant.js's purchase relay, and each listener ignores the
 * others' `operation` values.
 */
export function registerMerchantTradeSocket() {
	game.socket.on(`module.${MODULE_ID}`, async (data) => {
		if (data?.operation === "merchantSellNotify") {
			if (!isActiveGM()) return;
			const merchant = await fromUuid(data.merchantUuid);
			const seller = await fromUuid(data.sellerUuid);
			if (merchant?.type !== MERCHANT_TYPE || seller?.type !== "character") return;
			if (!isSellPending(seller, merchant.id)) return; // stale — already decided
			void openSellReview({ merchant, seller, sellerUserId: data.userId, requestId: data.requestId });
			return;
		}

		if (data?.operation === "merchantSellDecision") {
			if (data.userId !== game.user.id) return;
			ui.notifications?.info(l(data.decision === "accept" ? "MERCHANT.SELL_ACCEPTED" : "MERCHANT.SELL_REJECTED"));
		}
	});
}
