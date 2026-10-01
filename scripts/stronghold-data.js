/**
 * Forbidden Lands Enhancements — Stronghold rule data.
 *
 * Pure data and name matching: no Foundry globals, no side effects, so it is safe to
 * import from anywhere. Numbers come from the Player's Handbook, chapter 8 "The Stronghold"
 * (pp.158-178) and the raw-material / animal tables (pp.192-195).
 *
 * Items in a stronghold are identified by a *key* (e.g. "bakery", "baker", "meat") rather
 * than by name, so the automation works in any language. Keys are stored in item flags;
 * `matchKey()` guesses one from an item's name (any of the five shipped locales) when the
 * flag is missing, and the GM can override the guess on the item sheet.
 */

/** Day-quarters per day / days per week — the book counts production in Quarter Days. */
export const QUARTERS_PER_DAY = 4;
export const WEEK_DAYS = 7;

/** A converter or extractor building serves at most this many units / workers per copy. */
export const MAX_PER_COPY = 12;

/** Index (in the calendar's phase list) of the phases whose holidays drive yearly events. */
export const HARVEST_PHASE = 5; // Harvest Day — Fields yield their grain
export const AWAKENING_PHASE = 1; // Day of Awakening — livestock give birth

/** Sheep can be sheared twice a year; one batch becomes available again after this long. */
export const SHEAR_COOLDOWN_DAYS = 182;

/** Hirelings are paid per day for two Quarter Days of work; a third costs double. */
export const OVERTIME_SALARY_FACTOR = 2;

/* -------------------------------------------- */
/*  Resources                                   */
/* -------------------------------------------- */

/**
 * `shelfLifeDays: null` = never spoils. `rootCellar` = shelf life x10 in a Root Cellar
 * (book: Grain, Flour, Meat, Vegetables). `priceCopper` = book price per unit; 0 = unknown.
 * "Food" has no printed shelf life — a week is assumed (cooked food, like bread).
 */
export const RESOURCES = {
	ironOre: { priceCopper: 4, shelfLifeDays: null, aliases: ["iron ore", "eisenerz", "железная руда", "железной руды", "железную руду", "mineral de hierro", "minério de ferro", "minerio de ferro"] },
	iron: { priceCopper: 10, shelfLifeDays: null, aliases: ["iron", "eisen", "железо", "hierro", "ferro"] },
	stone: { priceCopper: 2, shelfLifeDays: null, aliases: ["stone", "stein", "камень", "камни", "камня", "piedra", "pedra"] },
	wood: { priceCopper: 3, shelfLifeDays: null, aliases: ["wood", "holz", "дерево", "древесина", "madera", "madeira"] },
	glass: { priceCopper: 80, shelfLifeDays: null, aliases: ["glass", "glas", "стекло", "vidrio", "vidro"] },
	leather: { priceCopper: 12, shelfLifeDays: null, aliases: ["leather", "leder", "кожа", "кожи", "cuero", "couro"] },
	cloth: { priceCopper: 8, shelfLifeDays: null, aliases: ["cloth", "stoff", "ткань", "ткани", "tela", "tecido"] },
	tallow: { priceCopper: 6, shelfLifeDays: null, aliases: ["tallow", "talg", "сало", "sebo"] },
	wool: { priceCopper: 4, shelfLifeDays: 30, aliases: ["wool", "wolle", "шерсть", "шерсти", "lana", "lã"] },
	grain: { priceCopper: 3, shelfLifeDays: 30, rootCellar: true, aliases: ["grain", "getreide", "зерно", "зерна", "grano", "grão", "grao"] },
	flour: { priceCopper: 6, shelfLifeDays: 30, rootCellar: true, aliases: ["flour", "mehl", "мука", "муки", "harina", "farinha"] },
	meat: { priceCopper: 6, shelfLifeDays: 1, rootCellar: true, aliases: ["meat", "fleisch", "мясо", "мяса", "carne"] },
	vegetables: { priceCopper: 4, shelfLifeDays: 1, rootCellar: true, aliases: ["vegetable", "gemüse", "овощ", "verdura", "legume", "vegetais"] },
	fish: { priceCopper: 5, shelfLifeDays: 1, aliases: ["fish", "fisch", "рыба", "рыбы", "pescado", "peixe", "pez"] },
	pelt: { priceCopper: 8, shelfLifeDays: 7, aliases: ["pelt", "fur", "fell", "pelz", "шкура", "шкуры", "пушнина", "piel", "pele"] },
	bread: { priceCopper: 10, shelfLifeDays: 7, aliases: ["bread", "brot", "хлеб", "pan", "pão", "pao"] },
	herbs: { priceCopper: 20, shelfLifeDays: 7, aliases: ["herb", "kräuter", "kraut", "трава", "травы", "hierbas", "ervas"] },
	food: { priceCopper: 0, shelfLifeDays: 7, aliases: ["food", "nahrung", "еда", "провизия", "comida", "alimento"] },
};

/* -------------------------------------------- */
/*  Animals                                     */
/* -------------------------------------------- */

/**
 * `meat` = Meat per head when slaughtered. The Pasture entry gives a cow 8 Meat while the
 * animal price table says 6; the function entry (8) is used. `birth` = yearly offspring dice,
 * `needsBull` = only if the Pasture is flagged as having a bull.
 */
export const ANIMALS = {
	cow: { meat: 8, birth: "1d6", needsBull: true, aliases: ["cow", "kuh", "корова", "коровы", "коров", "vaca"] },
	pig: { meat: 6, birth: "2d6", aliases: ["pig", "schwein", "свинья", "свиньи", "свин", "cerdo", "porco"] },
	sheep: { meat: 5, birth: "1d6", wool: 2, aliases: ["sheep", "schaf", "овца", "овцы", "овец", "oveja", "ovelha"] },
};

/* -------------------------------------------- */
/*  Buildings (book "functions")                */
/* -------------------------------------------- */

/**
 * kind:
 *   converter  — turns `inputs` (or one of `inputsAny`) into `outputs`, 1:1, up to 12 per
 *                copy per working Quarter Day when staffed by a hireling of role `staff`.
 *   extractor  — no input; `perWorker` units per worker per working Quarter Day (<=12 workers per copy).
 *   field      — yearly harvest at the Harvest holiday.
 *   garden     — weekly Vegetables/Herbs in Spring and Summer.
 *   livestock  — a pen for `animal` (capacity 12 per copy).
 *   passive    — no production; may add Defense and/or Reputation.
 */
export const BUILDINGS = {
	bakery: { kind: "converter", staff: "baker", inputs: { flour: 1 }, outputs: { bread: 1 }, aliases: ["bakery", "bäckerei", "пекарня", "panadería", "panaderia", "padaria"] },
	forge: { kind: "converter", staff: "smith", inputs: { ironOre: 1 }, outputs: { iron: 1 }, reputation: 1, aliases: ["forge", "schmiede", "кузница", "herrería", "herreria", "forja"] },
	mill: { kind: "converter", staff: "miller", inputs: { grain: 1 }, outputs: { flour: 1 }, aliases: ["mill", "mühle", "мельница", "molino", "moinho"] },
	inn: { kind: "converter", staff: "innkeeper", inputsAny: [{ meat: 1 }, { vegetables: 1 }], outputs: { food: 1 }, reputation: 1, aliases: ["inn", "gasthaus", "трактир", "постоялый двор", "posada", "estalagem"] },
	tailorShop: { kind: "converter", staff: "tailor", inputs: { wool: 1 }, outputs: { cloth: 1 }, aliases: ["tailor shop", "schneiderei", "швейная мастерская", "портняжная", "sastrería", "sastreria", "alfaiataria"] },
	tannery: { kind: "converter", staff: "tanner", inputs: { pelt: 1 }, outputs: { leather: 1 }, aliases: ["tannery", "gerberei", "дубильня", "curtiduría", "curtiduria", "curtume"] },
	quarry: { kind: "extractor", staff: "quarryWorker", perWorker: 2, outputs: { stone: 1 }, aliases: ["quarry", "steinbruch", "каменоломня", "каменоломни", "cantera", "pedreira"] },
	mine: { kind: "extractor", staff: "miner", perWorker: 2, outputs: { ironOre: 1 }, reminder: "mineCollapse", reputation: 1, aliases: ["mine", "bergwerk", "шахта", "шахты", "mina"] },
	field: { kind: "field", staff: "farmer", yearly: { outputs: { grain: 300 } }, aliases: ["field", "feld", "acker", "поле", "campo"] },
	garden: { kind: "garden", staff: "farmer", weekly: { total: 10, seasons: ["spring", "summer"] }, aliases: ["garden", "garten", "огород", "сад", "huerto", "jardín", "jardim"] },
	pasture: { kind: "livestock", staff: "farmer", animal: "cow", daily: { food: 1 }, aliases: ["pasture", "weide", "пастбище", "pastizal", "pasto"] },
	pigsty: { kind: "livestock", staff: "farmer", animal: "pig", aliases: ["pigsty", "schweinestall", "свинарник", "pocilga", "chiqueiro"] },
	sheepfold: { kind: "livestock", staff: "farmer", animal: "sheep", aliases: ["sheepfold", "schafstall", "овчарня", "redil", "aprisco"] },
	rootCellar: { kind: "passive", aliases: ["root cellar", "wurzelkeller", "погреб", "bodega de raíces", "porão de raízes", "adega"] },
	ramparts: { kind: "passive", defense: 2, reputation: 1, aliases: ["ramparts", "rampart", "wehrmauer", "festungswall", "крепостная стена", "стена", "muralla", "muralha"] },
	portcullis: { kind: "passive", defense: 1, aliases: ["portcullis", "fallgitter", "решетка", "rastrillo", "porta levadiça", "porta levadica"] },
	guardTower: { kind: "passive", defense: 1, aliases: ["guard tower", "wachturm", "сторожевая башня", "torre de guardia", "torre de guarda"] },
	moat: { kind: "passive", defense: 1, reputation: 1, aliases: ["moat", "wassergraben", "ров", "foso"] },
	dovecote: { kind: "passive", reputation: 1, aliases: ["dovecote", "taubenschlag", "голубятня", "palomar", "pombal"] },
	dungeon: { kind: "passive", reputation: 1, aliases: ["dungeon", "verlies", "темница", "подземелье", "mazmorra", "masmorra"] },
	gallows: { kind: "passive", reputation: 1, aliases: ["gallows", "galgen", "виселица", "horca", "forca"] },
	library: { kind: "passive", reputation: 1, aliases: ["library", "bibliothek", "библиотека", "biblioteca"] },
	marketplace: { kind: "passive", reputation: 1, aliases: ["marketplace", "marktplatz", "рынок", "рыночная площадь", "mercado"] },
	scriptorium: { kind: "passive", reputation: 1, aliases: ["scriptorium", "skriptorium", "скрипторий"] },
	shrine: { kind: "passive", reputation: 1, aliases: ["shrine", "schrein", "святилище", "santuario", "santuário"] },
};

/* -------------------------------------------- */
/*  Hirelings                                   */
/* -------------------------------------------- */

/**
 * `salaryCopper` = book salary per day (used when the item's own salary text is empty or
 * unparsable). `perEvent` = paid per job, never charged daily. `field` = works outside the
 * stronghold while "deployed", producing `outputs` per working Quarter Day.
 */
export const HIRELINGS = {
	baker: { salaryCopper: 6, aliases: ["baker", "bäcker", "пекарь", "пекаря", "panadero", "padeiro"] },
	bowyer: { salaryCopper: 10, aliases: ["bowyer", "bogenbauer", "лучный мастер", "arquero artesano"] },
	carpenter: { salaryCopper: 7, aliases: ["carpenter", "zimmermann", "плотник", "carpintero", "carpinteiro"] },
	executioner: { salaryCopper: 10, perEvent: true, aliases: ["executioner", "henker", "палач", "verdugo", "carrasco"] },
	farmer: { salaryCopper: 5, aliases: ["farmer", "bauer", "фермер", "земледелец", "granjero", "agricultor", "fazendeiro"] },
	guard: { salaryCopper: 10, aliases: ["guard", "wache", "wächter", "стражник", "страж", "guardia", "guarda"] },
	handyman: { salaryCopper: 3, aliases: ["handyman", "hausmeister", "handwerker", "разнорабочий", "manitas", "faz-tudo"] },
	hunter: { salaryCopper: 6, field: { outputs: { meat: 1, pelt: 1 } }, reminder: "hunterAttack", aliases: ["hunter", "jäger", "охотник", "cazador", "caçador", "cacador"] },
	innkeeper: { salaryCopper: 12, aliases: ["innkeeper", "wirt", "трактирщик", "хозяин таверны", "posadero", "estalajadeiro"] },
	jailer: { salaryCopper: 8, aliases: ["jailer", "kerkermeister", "тюремщик", "carcelero", "carcereiro"] },
	lumberjack: { salaryCopper: 4, field: { outputs: { wood: 2 } }, aliases: ["lumberjack", "holzfäller", "лесоруб", "лесорубы", "leñador", "lenador", "lenhador"] },
	masterBuilder: { salaryCopper: 20, aliases: ["master builder", "baumeister", "мастер-строитель", "мастер строитель", "maestro constructor", "mestre construtor"] },
	miller: { salaryCopper: 8, aliases: ["miller", "müller", "мельник", "molinero", "moleiro"] },
	miner: { salaryCopper: 4, aliases: ["miner", "bergmann", "шахтер", "шахтёр", "minero", "mineiro"] },
	quarryWorker: { salaryCopper: 3, aliases: ["quarry worker", "steinbrecher", "каменотес", "каменолом", "cantero", "pedreiro"] },
	smith: { salaryCopper: 10, aliases: ["smith", "schmied", "кузнец", "herrero", "ferreiro"] },
	tanner: { salaryCopper: 6, aliases: ["tanner", "gerber", "дубильщик", "curtidor"] },
	tailor: { salaryCopper: 8, aliases: ["tailor", "schneider", "портной", "sastre", "alfaiate"] },
};

/* -------------------------------------------- */
/*  Name matching                               */
/* -------------------------------------------- */

const normalize = (s) =>
	String(s ?? "")
		.toLowerCase()
		.replace(/ё/g, "е")
		.replace(/\s+/g, " ")
		.trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const _reCache = new Map();

/**
 * Aliases match at the START of a word (so Russian stems like "кузнец" cover "кузнеца");
 * aliases shorter than 4 characters must match a whole word ("pig", "inn", "ров").
 */
function aliasRegExp(alias) {
	let re = _reCache.get(alias);
	if (!re) {
		const tail = alias.length < 4 ? "(?![\\p{L}\\p{N}])" : "";
		re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(alias)}${tail}`, "u");
		_reCache.set(alias, re);
	}
	return re;
}

/**
 * Find the registry key whose alias best matches `name` — the longest matching alias wins
 * ("iron ore" over "iron", "master builder" over "builder"). `labelOf(key)` may return the
 * current-language display name, which is tried as an additional alias.
 *
 * @param {Record<string, {aliases: string[]}>} registry
 * @param {string} name
 * @param {(key: string) => string} [labelOf]
 * @returns {string|null}
 */
export function matchKey(registry, name, labelOf) {
	const text = normalize(name);
	if (!text) return null;
	let best = null;
	let bestLen = 0;
	for (const [key, def] of Object.entries(registry)) {
		const aliases = def.aliases.map(normalize);
		const label = labelOf ? normalize(labelOf(key)) : "";
		if (label) {
			if (label === text) return key; // exact localized name always wins
			aliases.push(label);
		}
		for (const alias of aliases) {
			if (alias.length > bestLen && aliasRegExp(alias).test(text)) {
				best = key;
				bestLen = alias.length;
			}
		}
	}
	return best;
}
