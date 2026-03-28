const MODULE_ID = "fbl-enhancements";
const ATTACK_STATE_FLAG = "attackState";
const SETTING_AUTO_ARROWS = "autoArrowsResourceRoll";
const SETTING_COMBAT_AUTOMATION = "combatAutomation";

const l = (key) => game.i18n.localize(`FBL_ENHANCEMENTS.${key}`);
const isEnabled = (settingKey) => game.settings.get(MODULE_ID, settingKey);

function registerSettings() {
	game.settings.register(MODULE_ID, SETTING_AUTO_ARROWS, {
		name: "FBL_ENHANCEMENTS.SETTINGS.AUTO_ARROWS.NAME",
		hint: "FBL_ENHANCEMENTS.SETTINGS.AUTO_ARROWS.HINT",
		scope: "world",
		config: true,
		type: Boolean,
		default: true,
	});

	game.settings.register(MODULE_ID, SETTING_COMBAT_AUTOMATION, {
		name: "FBL_ENHANCEMENTS.SETTINGS.COMBAT_AUTOMATION.NAME",
		hint: "FBL_ENHANCEMENTS.SETTINGS.COMBAT_AUTOMATION.HINT",
		scope: "world",
		config: true,
		type: Boolean,
		default: true,
	});
}

function registerHandlebarsHelpers() {
	Handlebars.registerHelper("damageType", (type) => {
		const normalized = String(type || "")
			.toLowerCase()
			.trim();
		const map = {
			stab: "ATTACK.STAB",
			slash: "ATTACK.SLASH",
			blunt: "ATTACK.BLUNT",
			fire: "ATTACK.FIRE",
			empathy: "ATTACK.EMPATHY",
			endurance: "ATTACK.ENDURANCE",
			fear: "ATTACK.FEAR",
			other: "ATTACK.OTHER",
		};
		const key = map[normalized] || "ATTACK.OTHER";
		return game.i18n.localize(key);
	});
}

function getAttackState(message) {
	return message.getFlag(MODULE_ID, ATTACK_STATE_FLAG) || {};
}

function applyAttackStateToRoll(message, roll) {
	const state = getAttackState(message);
	return foundry.utils.mergeObject(roll.options, state, { inplace: true });
}

function getAttackStatePayload(roll) {
	return {
		attackApplied: !!roll.options.attackApplied,
		defenseUsed: !!roll.options.defenseUsed,
		defenseSuccess: Number(roll.options.defenseSuccess || 0),
		defenseType: roll.options.defenseType || null,
		armorUsed: !!roll.options.armorUsed,
		armorSuccess: Number(roll.options.armorSuccess || 0),
		armorFailure: Number(roll.options.armorFailure || 0),
		targetTokenId: roll.options.targetTokenId || null,
		targetSceneId: roll.options.targetSceneId || null,
	};
}

function isActiveGM() {
	const activeGM = game.users?.activeGM;
	if (!game.user?.isGM) return false;
	return !activeGM || activeGM.id === game.user.id;
}

async function refreshAttackMessage(message, roll) {
	const content = await roll.render();
	await message.update({ content });
}

async function saveAttackState(message, roll) {
	const state = getAttackStatePayload(roll);
	await message.setFlag(MODULE_ID, ATTACK_STATE_FLAG, state);
}

function requestGMAttackStateUpdate(messageId, state) {
	game.socket.emit(`module.${MODULE_ID}`, {
		operation: "updateAttackState",
		id: messageId,
		state,
	});
}

async function persistAttackMessageState(message, roll) {
	const state = getAttackStatePayload(roll);
	if (message.isOwner) {
		await saveAttackState(message, roll);
		await refreshAttackMessage(message, roll);
		return;
	}
	requestGMAttackStateUpdate(message.id, state);
}

function getTargetFromRollOptions(roll) {
	const tokenId = roll?.options?.targetTokenId;
	if (!tokenId) return null;
	const sceneId = roll?.options?.targetSceneId;
	const scene = sceneId ? game.scenes.get(sceneId) : null;
	const tokenDoc = scene?.tokens?.get(tokenId);
	return tokenDoc?.object || canvas.tokens?.get(tokenId) || null;
}

function getAuthorSelectedTargetToken(message) {
	const author =
		message.author ||
		game.users.get(message._source?.author) ||
		game.users.get(message.user?.id) ||
		game.users.get(message.user);
	if (!author) return null;
	const targetRef = Array.from(author.targets || [])[0] || null;
	if (!targetRef) return null;
	return typeof targetRef === "string" ? canvas.tokens?.get(targetRef) : targetRef;
}

function getAttackTarget(message, roll = message.rolls?.[0]) {
	const optionTarget = getTargetFromRollOptions(roll);
	if (optionTarget?.actor) return optionTarget.actor;

	return getAuthorSelectedTargetToken(message)?.actor || null;
}

async function ensureAttackTargetOnRoll(message, roll) {
	if (roll.options?.targetTokenId) return;
	const targetToken = getAuthorSelectedTargetToken(message);
	if (!targetToken) return;
	roll.options.targetTokenId = targetToken.id;
	roll.options.targetSceneId = targetToken.scene?.id || canvas.scene?.id || null;
	await persistAttackMessageState(message, roll);
}

function canCurrentUserUseAttackActions(message, roll) {
	const targetActor = getAttackTarget(message, roll);
	return !!targetActor?.isOwner;
}

async function postRollWarning(localizationKey) {
	return ChatMessage.create({
		content: `<div class="forbidden-lands chat-item"><p>${l(localizationKey)}</p></div>`,
	});
}

function getAttackItem(roll) {
	const attacker = game.actors.get(roll.options.actorId);
	if (!attacker) return null;
	const itemId = Array.isArray(roll.options.itemId)
		? roll.options.itemId[0]
		: roll.options.itemId;
	if (!itemId) return null;
	return attacker.items.get(itemId) || null;
}

function isRangedAttack(roll) {
	const optionCategory = String(roll?.options?.attackCategory || "")
		.toLowerCase()
		.trim();
	if (optionCategory.includes("ranged")) return true;

	const item = getAttackItem(roll);
	const itemCategory = String(item?.system?.category || "")
		.toLowerCase()
		.trim();
	return item?.type === "weapon" && itemCategory.includes("ranged");
}

function hasEquippedShield(actor) {
	return actor.items.some((item) => {
		if (item.state !== "equipped") return false;
		if (item.type === "armor" && item.system?.part === "shield") return true;
		return !!item.system?.features?.shield;
	});
}

function getParryItem(actor) {
	return (
		actor.items.find(
			(item) =>
				item.state === "equipped" &&
				item.type === "weapon" &&
				item.system?.category === "melee" &&
				item.system?.features?.parrying,
		) || null
	);
}

function getDamageAttribute(actor, damageType = "other") {
	const type = String(damageType || "").toLowerCase();
	if (type === "empathy") return "empathy";
	if (type === "fear") return "wits";
	if (type === "endurance") return "agility";
	if (["stab", "slash", "blunt", "fire", "other"].includes(type))
		return "strength";
	return null;
}

function getCriticalInjuryTableByDamageType(damageType = "blunt") {
	const type = String(damageType || "").toLowerCase();
	if (type === "stab" || type === "stabbing")
		return "Critical Injuries - Stab Wounds";
	if (type === "slash")
		return "Critical Injuries - Slash Wounds";
	if (type === "blunt") return "Critical Injuries - Blunt Wounds";
	return null;
}

async function tryRunRollOnTable(tableName) {
	try {
		if (typeof globalThis.rollOnTable === "function") {
			await globalThis.rollOnTable(tableName);
			return true;
		}
	} catch (_error) {}

	const macro = game.macros?.getName("rollOnTable");
	if (macro) {
		try {
			await macro.execute(tableName);
			return true;
		} catch (_error) {
			try {
				await macro.execute({ table: tableName, tableName });
				return true;
			} catch (_error2) {}
		}
	}

	try {
		const table = game.tables?.getName(tableName);
		if (!table) return false;
		await table.draw({ displayChat: true });
		return true;
	} catch (_error) {
		return false;
	}
}

async function tryTriggerTraumaTable(actor, attribute, damageType) {
	if (actor?.type === "monster") return;
	const currentValue = Number(actor.system?.attribute?.[attribute]?.value ?? 0);
	if (currentValue > 0) return;

	if (attribute === "wits") {
		await tryRunRollOnTable("Horror Trauma");
		return;
	}
	if (attribute !== "strength") return;

	const tableName = getCriticalInjuryTableByDamageType(damageType);
	if (!tableName) return;
	await tryRunRollOnTable(tableName);
}

async function applyDamageToTarget(actor, roll) {
	if (Number(roll.attackSuccess || 0) <= 0) return;
	const damage = Number(roll.damage || 0);
	if (!damage) return;

	const attribute = getDamageAttribute(actor, roll.options.damageType);
	if (!attribute) {
		await postRollWarning("ROLL.WARNING_INVALID_DAMAGE_TYPE");
		return;
	}
	if (
		!actor.system?.attribute ||
		!(attribute in actor.system.attribute) ||
		typeof actor.system.attribute?.[attribute]?.value !== "number"
	) {
		await postRollWarning("ROLL.WARNING_INVALID_DAMAGE_ATTRIBUTE");
		return;
	}

	const currentValue = Number(actor.system?.attribute?.[attribute]?.value ?? 0);
	const newValue = Math.max(currentValue - damage, 0);
	await actor.update({ [`system.attribute.${attribute}.value`]: newValue });

	if (currentValue > 0 && newValue <= 0) {
		await tryTriggerTraumaTable(actor, attribute, roll.options.damageType);
	}
}

async function applyArmorFailureDamage(actor, amount) {
	let remaining = Number(amount || 0);
	if (remaining <= 0) return;

	const priorities = { body: 0, head: 1 };
	const armorItems = actor.itemTypes.armor
		.filter((item) => {
			const part = item.system?.part;
			return (
				item.state === "equipped" &&
				(part === "body" || part === "head") &&
				(item.system?.bonus?.value ?? 0) > 0
			);
		})
		.sort((a, b) => priorities[a.system.part] - priorities[b.system.part]);

	const updates = [];
	for (const item of armorItems) {
		if (remaining <= 0) break;
		const value = Number(item.system?.bonus?.value || 0);
		const loss = Math.min(remaining, value);
		remaining -= loss;
		updates.push({
			_id: item.id,
			"system.bonus.value": value - loss,
		});
	}

	if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

async function applyAttackArmorDamage(targetActor, roll) {
	if (targetActor.type === "monster") return;
	const armorFailure = Number(roll.options?.armorFailure || 0);
	if (!armorFailure) return;
	if (roll.attackSuccess <= 0) return;
	await applyArmorFailureDamage(targetActor, armorFailure);
}

function getDefenseSourceRoll(roll) {
	if (roll.options?.linkedDefenseType === "armor")
		return {
			success: Number(roll.successCount || 0),
			failure: Number(roll.gearDamage || roll.baneCount || 0),
		};
	if (roll.options?.linkedDefenseType === "dodge")
		return { success: Number(roll.successCount || 0), failure: 0 };
	if (roll.options?.linkedDefenseType === "parry")
		return { success: Number(roll.successCount || 0), failure: 0 };
	return null;
}

async function syncLinkedAttackFromDefenseRoll(defenseRoll) {
	const linkedAttackMessageId = defenseRoll.options?.linkedAttackMessageId;
	if (!linkedAttackMessageId) return;
	const attackMessage = game.messages.get(linkedAttackMessageId);
	if (!attackMessage) return;
	const attackRoll = attackMessage.rolls?.[0];
	if (!attackRoll?.options?.isAttack) return;

	applyAttackStateToRoll(attackMessage, attackRoll);
	const source = getDefenseSourceRoll(defenseRoll);
	if (!source) return;

	switch (defenseRoll.options.linkedDefenseType) {
		case "armor":
			attackRoll.options.armorUsed = true;
			attackRoll.options.armorSuccess = source.success;
			attackRoll.options.armorFailure = source.failure;
			break;
		case "dodge":
		case "parry":
			attackRoll.options.defenseUsed = true;
			attackRoll.options.defenseType = defenseRoll.options.linkedDefenseType;
			attackRoll.options.defenseSuccess = source.success;
			break;
	}

	await persistAttackMessageState(attackMessage, attackRoll);
}

async function rollTargetDefense(actor, type, attackMessageId, itemId = null) {
	const result = await actor.sheet.rollAction(type, itemId);
	if (result?.roll) {
		result.roll.options.linkedAttackMessageId = attackMessageId;
		result.roll.options.linkedDefenseType = type;
		await result.message?.update({ content: await result.roll.render() });
	}
	return result;
}

async function rollTargetArmor(actor, attackMessageId) {
	const result = await actor.sheet.rollArmor?.();
	if (result?.roll) {
		result.roll.options.linkedAttackMessageId = attackMessageId;
		result.roll.options.linkedDefenseType = "armor";
		await result.message?.update({ content: await result.roll.render() });
	}
	return result;
}

function patchRollClass() {
	const rollClass =
		CONFIG.Dice.rolls?.find((cls) => cls?.name === "FBLRoll") ||
		CONFIG.Dice.rolls?.[CONFIG.YZUR?.ROLL?.index || 1];
	if (!rollClass?.prototype || rollClass.prototype.__fblEnhancementsPatched) return;

	const chatTemplate = `modules/${MODULE_ID}/templates/roll.hbs`;
	if (CONFIG.YZUR?.ROLL) CONFIG.YZUR.ROLL.chatTemplate = chatTemplate;
	rollClass.CHAT_TEMPLATE = chatTemplate;

	Object.defineProperty(rollClass.prototype, "attackSuccess", {
		configurable: true,
		get() {
			if (!this.options?.isAttack) return this.successCount;
			const defenseSuccess = Number(this.options?.defenseSuccess || 0);
			return Math.max(this.successCount - defenseSuccess, 0);
		},
	});

	Object.defineProperty(rollClass.prototype, "damage", {
		configurable: true,
		get() {
			const damageType = String(
				this.options?.damageType || this.options?.attack?.system?.damageType || "",
			)
				.toLowerCase()
				.trim();
			const armorSuccess = Number(this.options?.armorSuccess || 0);
			const isMonsterFear =
				damageType === "fear" &&
				(!!this.options?.isMonsterAttack || this.options?.actorType === "monster");
			if (isMonsterFear) return Math.max(this.attackSuccess - armorSuccess, 0);

			const modifier = this.type === "spell" ? 0 : -1;
			const baseDamage =
				Number(this.options?.damage || 0) +
				Math.max(Number(this.attackSuccess || 0) + modifier, 0);
			return Math.max(baseDamage - armorSuccess, 0);
		},
	});

	rollClass.prototype.__fblEnhancementsPatched = true;
}

function computeDamageTypeOptions(actor, itemId, actionName) {
	const defaults = [{ value: "other", label: "ATTACK.OTHER" }];
	if (!itemId) {
		if (actionName === "unarmed")
			return [{ value: "blunt", label: "ATTACK.BLUNT" }];
		return defaults;
	}

	const item = actor?.items?.get?.(itemId);
	if (!item || item.type !== "weapon") return defaults;

	const features = item.system?.features || {};
	const options = [];
	if (features.pointed) options.push({ value: "stab", label: "ATTACK.STAB" });
	if (features.edged) options.push({ value: "slash", label: "ATTACK.SLASH" });
	if (features.blunt) options.push({ value: "blunt", label: "ATTACK.BLUNT" });
	return options.length ? options : defaults;
}

function resolveRollActor(rollHandler) {
	const cls = globalThis.FBLRollHandler;
	if (cls?.resolveActor) {
		const actor = cls.resolveActor({
			actor: rollHandler.options?.actorId,
			scene: rollHandler.options?.sceneId,
			token: rollHandler.options?.tokenId,
		});
		if (actor) return actor;
	}
	return game.actors?.get(rollHandler.options?.actorId) || null;
}

async function tryRollArrowsForAttack(rollHandler) {
	if (!isEnabled(SETTING_AUTO_ARROWS)) return;
	if (!rollHandler?.options) return;
	if (rollHandler.options.__fblEnhArrowsRolled) return;
	if (rollHandler.options.actorType !== "character") return;
	if (!rollHandler.options.isAttack && !rollHandler.gear?.damage) return;

	const actor = resolveRollActor(rollHandler);
	if (!actor?.sheet?.rollConsumable) return;

	const itemId = Array.isArray(rollHandler.options.itemId)
		? rollHandler.options.itemId[0]
		: rollHandler.options.itemId;
	const item = itemId ? actor.items.get(itemId) : null;

	const gearCategory = String(rollHandler.gear?.category || "")
		.toLowerCase()
		.trim();
	const gearAmmo = String(rollHandler.gear?.ammo || "")
		.toLowerCase()
		.trim();
	const itemCategory = String(item?.system?.category || "")
		.toLowerCase()
		.trim();
	const itemAmmo = String(item?.system?.ammo || "")
		.toLowerCase()
		.trim();

	const isRangedAttack =
		gearCategory.includes("ranged") || itemCategory.includes("ranged");
	const usesArrows = gearAmmo === "arrows" || itemAmmo === "arrows";
	if (!isRangedAttack || !usesArrows) return;

	try {
		rollHandler.options.__fblEnhArrowsRolled = true;
		await actor.sheet.rollConsumable("arrows");
	} catch (error) {
		console.warn(`${MODULE_ID} | Could not roll arrows resource die`, error);
		rollHandler.options.__fblEnhArrowsRolled = false;
	}
}

function patchRollHandler() {
	const RollHandler = globalThis.FBLRollHandler;
	if (!RollHandler?.prototype || RollHandler.prototype.__fblEnhancementsPatched)
		return;

	const originalCreateRoll = RollHandler.createRoll;
	RollHandler.createRoll = async function createRollPatched(data = {}, options = {}) {
		const nextData = foundry.utils.deepClone(data);
		const nextOptions = foundry.utils.deepClone(options);
		const isSpellTemplate = String(nextOptions.template || "").includes(
			"spell-dialog.hbs",
		);
		if (!isSpellTemplate && !nextOptions.template) {
			nextOptions.template = `modules/${MODULE_ID}/templates/dialog.hbs`;
		}

		const hasDamage =
			Number(nextOptions.damage || nextData?.gear?.damage || 0) > 0 ||
			!!nextOptions.isAttack;
		if (hasDamage) {
			const actor = game.actors?.get(nextOptions.actorId) || null;
			const itemId = Array.isArray(nextOptions.itemId)
				? nextOptions.itemId[0]
				: nextOptions.itemId;
			const item = actor?.items?.get?.(itemId) || null;
			const actionName = String(nextData?.title || "").toLowerCase().trim();
			const typeOptions =
				nextOptions.damageTypeOptions ||
				computeDamageTypeOptions(actor, itemId, actionName);
			nextOptions.damageTypeOptions = typeOptions;
			nextOptions.damageType =
				nextOptions.damageType ||
				nextData?.gear?.damageType ||
				item?.system?.damageType ||
				typeOptions[0]?.value ||
				"other";
		}

		return originalCreateRoll.call(this, nextData, nextOptions);
	};

	const originalGetData = RollHandler.prototype.getData;
	RollHandler.prototype.getData = function getDataPatched(options = {}) {
		const data = originalGetData.call(this, options);
		const damageTypeOptions = this.options?.damageTypeOptions || [];
		return {
			...data,
			damageType: this.damageType || this.options?.damageType || "other",
			damageTypeOptions,
		};
	};

	const originalValidate = RollHandler.prototype._validateForm;
	RollHandler.prototype._validateForm = function validateFormPatched(
		event,
		formData,
	) {
		const copy = { ...formData };
		delete copy.damageType;
		return originalValidate.call(this, event, copy);
	};

	const originalHandleYZ = RollHandler.prototype._handleYZRoll;
	RollHandler.prototype._handleYZRoll = async function handleYZRollPatched(
		formData = {},
	) {
		const { damageType, ...rest } = formData;
		if (damageType) this.damageType = damageType;
		else if (!this.damageType) this.damageType = this.options?.damageType || "other";
		await tryRollArrowsForAttack(this);
		return originalHandleYZ.call(this, rest);
	};

	const originalGetRollOptions = RollHandler.prototype.getRollOptions;
	RollHandler.prototype.getRollOptions = function getRollOptionsPatched() {
		const options = originalGetRollOptions.call(this);
		const target = Array.from(game.user?.targets || [])[0] || null;
		const attackCategory = this.gear?.category || options.attackCategory || null;
		const attackAmmo = this.gear?.ammo || options.attackAmmo || null;
		return {
			...options,
			isAttack: !!(options.isAttack || this.damage || this.gear?.damage),
			damageType: this.damageType || options.damageType || "other",
			attackCategory,
			attackAmmo,
			__fblEnhArrowsRolled: !!this.options.__fblEnhArrowsRolled,
			targetTokenId: options.targetTokenId || target?.id || null,
			targetSceneId:
				options.targetSceneId ||
				target?.scene?.id ||
				target?.document?.parent?.id ||
				canvas.scene?.id ||
				null,
		};
	};

	RollHandler.prototype.__fblEnhancementsPatched = true;
}

function patchItemDocument() {
	const ItemClass = CONFIG.Item?.documentClass;
	if (!ItemClass?.prototype || ItemClass.prototype.__fblEnhancementsPatched) return;

	const originalGetRollData = ItemClass.prototype.getRollData;
	if (typeof originalGetRollData === "function") {
		ItemClass.prototype.getRollData = function getRollDataPatched(...args) {
			const data = originalGetRollData.apply(this, args) || {};
			const current = String(
				data.damageType || this.system?.damageType || "other",
			)
				.toLowerCase()
				.trim();
			const allowed = new Set([
				"stab",
				"slash",
				"blunt",
				"fire",
				"empathy",
				"endurance",
				"fear",
				"other",
			]);
			return {
				...data,
				damageType: allowed.has(current) ? current : "other",
			};
		};
	}

	ItemClass.prototype.__fblEnhancementsPatched = true;
}

function patchMonsterAttackSheet() {
	const classes = Object.values(CONFIG.Item?.sheetClasses || {});
	const monsterSheetClass = classes.find((sheetClass) => {
		const types = Object.keys(sheetClass?.types || {});
		return types.includes("monsterAttack");
	})?.cls;
	if (!monsterSheetClass?.prototype || monsterSheetClass.prototype.__fblEnhancementsPatched)
		return;

	const originalGetData = monsterSheetClass.prototype.getData;
	monsterSheetClass.prototype.getData = async function getDataPatched(options = {}) {
		const data = await originalGetData.call(this, options);
		data.damageTypeOptions = [
			{ value: "stab", label: "ATTACK.STAB" },
			{ value: "slash", label: "ATTACK.SLASH" },
			{ value: "blunt", label: "ATTACK.BLUNT" },
			{ value: "fire", label: "ATTACK.FIRE" },
			{ value: "empathy", label: "ATTACK.EMPATHY" },
			{ value: "endurance", label: "ATTACK.ENDURANCE" },
			{ value: "fear", label: "ATTACK.FEAR" },
			{ value: "other", label: "ATTACK.OTHER" },
		];
		return data;
	};

	monsterSheetClass.prototype.__fblEnhancementsPatched = true;
}

function patchMonsterSheet() {
	const classes = Object.values(CONFIG.Actor?.sheetClasses || {});
	const monsterSheetClass = classes.find((sheetClass) => {
		const types = Object.keys(sheetClass?.types || {});
		return types.includes("monster");
	})?.cls;
	if (!monsterSheetClass?.prototype || monsterSheetClass.prototype.__fblEnhancementsPatched)
		return;

	const originalRollSpecificAttack = monsterSheetClass.prototype.rollSpecificAttack;
	if (typeof originalRollSpecificAttack === "function") {
		monsterSheetClass.prototype.rollSpecificAttack = async function rollSpecificAttackPatched(
			attackId,
		) {
			if (!this.actor?.canAct) return originalRollSpecificAttack.call(this, attackId);
			const attack = this.actor.items.get(attackId);
			if (!attack || attack.type !== "monsterAttack")
				return originalRollSpecificAttack.call(this, attackId);

			const FBLRollClass =
				globalThis.FBLRoll ||
				CONFIG.Dice.rolls?.find((cls) => cls?.name === "FBLRoll");
			if (!FBLRollClass?.create) return originalRollSpecificAttack.call(this, attackId);

			const gear = attack.getRollData();
			const rollOptions =
				typeof this.getRollOptions === "function" ? this.getRollOptions() : {};
			const rawDamageType = String(
				attack.system?.damageType || gear.damageType || "other",
			)
				.toLowerCase()
				.trim();
			const allowed = new Set([
				"stab",
				"slash",
				"blunt",
				"fire",
				"empathy",
				"endurance",
				"fear",
				"other",
			]);
			const damageType = allowed.has(rawDamageType) ? rawDamageType : "other";
			const options = {
				name: attack.name,
				maxPush: rollOptions.unlimitedPush ? 10000 : "0",
				isAttack: true,
				isMonsterAttack: true,
				damage: Number(attack.system?.damage || attack.damage || 0),
				damageType,
				gear: { ...gear, damageType },
				attack,
				...rollOptions,
			};
			const dice = attack.system?.usingStrength
				? Number(this.actor.attributes?.strength?.value || 0)
				: Number(attack.system?.dice || 0);
			const roll = FBLRollClass.create(`${dice}db[${attack.name}]`, {}, options);
			await roll.roll();
			return roll.toMessage();
		};
	}

	monsterSheetClass.prototype.__fblEnhancementsPatched = true;
}

function registerSocket() {
	game.socket.on(`module.${MODULE_ID}`, async (data) => {
		if (data?.operation !== "updateAttackState") return;
		if (!isActiveGM()) return;

		const message = game.messages.get(data.id);
		const roll = message?.rolls?.[0];
		if (!message || !roll?.options?.isAttack) return;
		applyAttackStateToRoll(message, roll);
		foundry.utils.mergeObject(roll.options, data.state || {}, { inplace: true });
		await saveAttackState(message, roll);
		await refreshAttackMessage(message, roll);
	});
}

function registerChatHooks() {
	Hooks.on("createChatMessage", (message) => {
		if (!isEnabled(SETTING_AUTO_ARROWS)) return;
		const roll = message?.rolls?.[0];
		if (!roll?.options?.isAttack) return;
		if (roll.pushed) return;
		if (roll.options.__fblEnhArrowsRolled) return;

		const actor = game.actors?.get(roll.options?.actorId);
		if (!actor?.sheet?.rollConsumable) return;
		if (roll.options?.actorType !== "character") return;

		const category = String(roll.options?.attackCategory || "")
			.toLowerCase()
			.trim();
		const ammo = String(roll.options?.attackAmmo || "")
			.toLowerCase()
			.trim();

		const itemId = Array.isArray(roll.options?.itemId)
			? roll.options.itemId[0]
			: roll.options?.itemId;
		const item = itemId ? actor.items?.get?.(itemId) : null;
		const itemCategory = String(item?.system?.category || "")
			.toLowerCase()
			.trim();
		const itemAmmo = String(item?.system?.ammo || "")
			.toLowerCase()
			.trim();

		const isRanged = category.includes("ranged") || itemCategory.includes("ranged");
		const usesArrows = ammo === "arrows" || itemAmmo === "arrows";
		if (!isRanged || !usesArrows) return;

		roll.options.__fblEnhArrowsRolled = true;
		void actor.sheet.rollConsumable("arrows");
	});

	Hooks.on("createChatMessage", (message) => {
		if (!isEnabled(SETTING_COMBAT_AUTOMATION)) return;
		const roll = message?.rolls?.[0];
		if (!roll?.options?.linkedAttackMessageId) return;
		void syncLinkedAttackFromDefenseRoll(roll);
	});

	Hooks.on("renderChatMessageHTML", (message, htmlElement) => {
		if (!isEnabled(SETTING_COMBAT_AUTOMATION)) {
			htmlElement
				.querySelectorAll(".fbl-button.attack-action")
				.forEach((button) => button.remove());
			return;
		}

		const attackRoll = message.rolls?.[0];
		if (!attackRoll?.options?.isAttack) return;

		applyAttackStateToRoll(message, attackRoll);
		void ensureAttackTargetOnRoll(message, attackRoll);

		const attackButtons = htmlElement.querySelectorAll(".fbl-button.attack-action");
		if (!attackButtons.length) return;

		if (!canCurrentUserUseAttackActions(message, attackRoll)) {
			attackButtons.forEach((button) => button.remove());
			return;
		}

		attackButtons.forEach((button) => {
			button.addEventListener("click", async (ev) => {
				ev.stopPropagation();
				try {
					const roll = message.rolls?.[0];
					if (!roll?.options?.isAttack) return;
					applyAttackStateToRoll(message, roll);
					await ensureAttackTargetOnRoll(message, roll);

					const targetActor = getAttackTarget(message, roll);
					if (!targetActor) {
						await postRollWarning("ROLL.WARNING_NO_TARGET");
						return;
					}
					if (!targetActor.isOwner) {
						await postRollWarning("ROLL.WARNING_NOT_TARGET_OWNER");
						return;
					}

					switch (button.dataset.action) {
						case "apply-damage":
							if (roll.options.attackApplied) return;
							if (Number(roll.attackSuccess || 0) <= 0) return;
							await applyDamageToTarget(targetActor, roll);
							await applyAttackArmorDamage(targetActor, roll);
							roll.options.attackApplied = true;
							break;

						case "defense-dodge": {
							if (roll.options.defenseUsed) return;
							const result = await rollTargetDefense(targetActor, "dodge", message.id);
							if (!result?.roll) return;
							roll.options.defenseUsed = true;
							roll.options.defenseType = "dodge";
							roll.options.defenseSuccess = Number(result.roll.successCount || 0);
							break;
						}

						case "defense-parry": {
							if (roll.options.defenseUsed) return;
							if (isRangedAttack(roll) && !hasEquippedShield(targetActor)) {
								await postRollWarning("ROLL.WARNING_PARRY_NO_SHIELD_RANGED");
								return;
							}
							const parryItem = getParryItem(targetActor);
							if (!parryItem) {
								await postRollWarning("ROLL.WARNING_PARRY_NO_WEAPON");
								return;
							}
							const result = await rollTargetDefense(
								targetActor,
								"parry",
								message.id,
								parryItem.id,
							);
							if (!result?.roll) return;
							roll.options.defenseUsed = true;
							roll.options.defenseType = "parry";
							roll.options.defenseSuccess = Number(result.roll.successCount || 0);
							break;
						}

						case "defense-armor": {
							if (roll.options.armorUsed) return;
							const armorResult = await rollTargetArmor(targetActor, message.id);
							if (!armorResult?.roll) return;
							roll.options.armorUsed = true;
							roll.options.armorSuccess = Number(
								armorResult.roll.successCount || 0,
							);
							roll.options.armorFailure = Number(
								armorResult.roll.gearDamage || armorResult.roll.baneCount || 0,
							);
							break;
						}

						default:
							return;
					}

					await persistAttackMessageState(message, roll);
				} catch (error) {
					console.error(`${MODULE_ID} | Attack action failed`, error);
					await postRollWarning("ROLL.WARNING_ACTION_FAILED");
				}
			});
		});
	});
}

Hooks.once("init", () => {
	console.log(`${MODULE_ID} | Initializing module`);
	registerSettings();
	registerHandlebarsHelpers();
});

Hooks.once("setup", () => {
	game.modules.get(MODULE_ID).api = { MODULE_ID };
});

Hooks.once("ready", () => {
	console.log(`${MODULE_ID} | Module ready`);
	patchItemDocument();
	patchMonsterAttackSheet();
	patchMonsterSheet();
	patchRollClass();
	patchRollHandler();
	registerSocket();
	registerChatHooks();
});
