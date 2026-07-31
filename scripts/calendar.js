/**
 * Forbidden Lands Enhancements — Built-in Calendar
 *
 * Self-contained ES module (separate from main.js; esmodules do not share scope).
 * Models the in-world human calendar of the Forbidden Lands:
 *   - 365-day year of 8 phases (45-46 days each); each phase opens with a named holiday day.
 *   - Moon phases on the real synodic cycle; a phase is "strong" when it holds two full moons.
 *   - Time of day in quarters: day-quarter (6h) -> quarter-of-quarter (1.5h) -> quarter-hour (15m).
 *
 * Time is stored in Foundry core `game.time.worldTime` (seconds). Core gates
 * `game.time.advance()` to the GM and broadcasts `updateWorldTime` to every client,
 * so no custom socket relay is needed.
 *
 * Every user-facing string is an i18n key resolved at render time — the date engine
 * works purely in keys, so the whole feature is translatable through the lang JSON files.
 */

const MODULE_ID = "fbl-enhancements";

const SETTING_ENABLED = "calendarEnabled";
const SETTING_VISIBLE = "calendarVisibleToPlayers";
const SETTING_GRANULARITY = "calendarGranularity";
const SETTING_CONFIG = "calendarConfig";
const SETTING_COMPACT = "calendarCompactView";

const l = (key) => game.i18n.localize(`FBL_ENHANCEMENTS.${key}`);

const SECONDS_PER_DAY = 86400;
const SYNODIC_PERIOD = 29.530588; // mean synodic month in days

/** Forward/back step sizes (seconds) for the granularity selector. */
const GRANULARITY_SECONDS = {
	dayQuarter: 21600, // 6h
	quarter: 5400, // 1.5h
	hourQuarter: 900, // 15m
};

/**
 * The eight phases in calendar order, starting at Midwinter.
 * Each phase's FIRST day is its holiday. Lengths sum to 365.
 * `name` / `holiday` are i18n keys, never literal text.
 */
const DEFAULT_PHASES = [
	{ name: "PHASES.WINTER_WANE", holiday: "HOLIDAYS.MIDWINTER", length: 46 },
	{ name: "PHASES.SPRING_RISE", holiday: "HOLIDAYS.AWAKENING", length: 45 },
	{ name: "PHASES.SPRING_FALL", holiday: "HOLIDAYS.SPRING_TURN", length: 46 },
	{ name: "PHASES.SUMMER_RISE", holiday: "HOLIDAYS.GREENING", length: 45 },
	{ name: "PHASES.SUMMER_FALL", holiday: "HOLIDAYS.MIDSUMMER", length: 46 },
	{ name: "PHASES.AUTUMN_RISE", holiday: "HOLIDAYS.HARVEST", length: 45 },
	{ name: "PHASES.AUTUMN_FALL", holiday: "HOLIDAYS.AUTUMN_TURN", length: 46 },
	{ name: "PHASES.WINTER_RISE", holiday: "HOLIDAYS.DAY_OF_DEAD", length: 46 },
];

/** Day-quarters in chronological order from midnight. `start` is the start hour. */
const DAY_QUARTERS = [
	{ key: "QUARTERS.NIGHT", start: 0 },
	{ key: "QUARTERS.MORNING", start: 6 },
	{ key: "QUARTERS.DAY", start: 12 },
	{ key: "QUARTERS.EVENING", start: 18 },
];

/** Eight named moon phases, ordered from new moon. */
const MOON_PHASES = [
	"MOON.NEW",
	"MOON.WAXING_CRESCENT",
	"MOON.FIRST_QUARTER",
	"MOON.WAXING_GIBBOUS",
	"MOON.FULL",
	"MOON.WANING_GIBBOUS",
	"MOON.LAST_QUARTER",
	"MOON.WANING_CRESCENT",
];

const DEFAULT_CONFIG = {
	startingYear: 1165,
	lunarEpochDay: 0, // a day index that is a new moon; full moons fall half a period later
	phaseLengths: DEFAULT_PHASES.map((p) => p.length),
};

/**
 * Index into DEFAULT_PHASES that worldTime = 0 should land on (day 1 of that phase).
 * Phase 0 (Winter Wane) stays first in the array for holiday bookkeeping, but a fresh
 * world's epoch is shifted to open on Springrise, matching the setting's canonical start.
 */
const EPOCH_PHASE_INDEX = 1;

/** Positive modulo (handles negative day/second indices). */
const mod = (n, m) => ((n % m) + m) % m;

/** Days from the array's phase 0 to EPOCH_PHASE_INDEX, recomputed from the active config. */
function epochOffsetDays(config) {
	let offset = 0;
	for (let i = 0; i < EPOCH_PHASE_INDEX; i++) offset += config.phaseLengths[i];
	return offset;
}

/* -------------------------------------------- */
/*  Pure date engine (no Foundry dependencies)  */
/* -------------------------------------------- */

/** Merge stored config with defaults so missing fields are always populated. */
function getConfig() {
	const stored = game.settings?.get(MODULE_ID, SETTING_CONFIG) || {};
	const phaseLengths =
		Array.isArray(stored.phaseLengths) && stored.phaseLengths.length === DEFAULT_PHASES.length
			? stored.phaseLengths.map((n) => Number(n) || 1)
			: DEFAULT_CONFIG.phaseLengths.slice();
	return {
		startingYear: Number.isFinite(stored.startingYear)
			? stored.startingYear
			: DEFAULT_CONFIG.startingYear,
		lunarEpochDay: Number.isFinite(stored.lunarEpochDay)
			? stored.lunarEpochDay
			: DEFAULT_CONFIG.lunarEpochDay,
		phaseLengths,
	};
}

function yearLength(config) {
	return config.phaseLengths.reduce((sum, n) => sum + n, 0);
}

/** Map a 0-based day-of-year to its phase. Returns { phaseIndex, dayInPhase, phaseStartDay }. */
function getPhaseForDay(dayOfYear, config) {
	let start = 0;
	for (let i = 0; i < config.phaseLengths.length; i++) {
		const len = config.phaseLengths[i];
		if (dayOfYear < start + len) {
			return { phaseIndex: i, dayInPhase: dayOfYear - start, phaseStartDay: start };
		}
		start += len;
	}
	// Fallback (should not happen): clamp to last phase.
	const last = config.phaseLengths.length - 1;
	return { phaseIndex: last, dayInPhase: 0, phaseStartDay: start };
}

/** Convert worldTime seconds to a full date/time descriptor. */
function worldTimeToDate(seconds, config = getConfig()) {
	const days = yearLength(config);
	const dayIndex = Math.floor(seconds / SECONDS_PER_DAY) + epochOffsetDays(config);
	const secondsOfDay = mod(seconds, SECONDS_PER_DAY);

	const yearOffset = Math.floor(dayIndex / days);
	const dayOfYear = mod(dayIndex, days);
	const year = config.startingYear + yearOffset;

	const { phaseIndex, dayInPhase, phaseStartDay } = getPhaseForDay(dayOfYear, config);
	const phaseStartDayIndex = dayIndex - dayInPhase;
	const isHoliday = dayInPhase === 0;

	const hour = Math.floor(secondsOfDay / 3600);
	const minute = Math.floor((secondsOfDay % 3600) / 60);
	const dayQuarterIndex = Math.floor(secondsOfDay / 21600); // 0..3
	const quarterIndex = Math.floor((secondsOfDay % 21600) / 5400); // 0..3 (1.5h each)
	const hourQuarterIndex = Math.floor((secondsOfDay % 3600) / 900); // 0..3 (15m each)

	return {
		dayIndex,
		secondsOfDay,
		year,
		dayOfYear,
		phaseIndex,
		dayInPhase,
		phaseStartDay,
		phaseStartDayIndex,
		phaseLength: config.phaseLengths[phaseIndex],
		isHoliday,
		hour,
		minute,
		dayQuarterIndex,
		quarterIndex,
		hourQuarterIndex,
	};
}

/** Convert a date descriptor back to worldTime seconds. */
function dateToWorldTime(date, config = getConfig()) {
	const days = yearLength(config);
	let dayOfYear = 0;
	for (let i = 0; i < date.phaseIndex; i++) dayOfYear += config.phaseLengths[i];
	dayOfYear += date.dayInPhase || 0;
	const dayIndex = (date.year - config.startingYear) * days + dayOfYear - epochOffsetDays(config);
	return dayIndex * SECONDS_PER_DAY + (date.secondsOfDay || 0);
}

/** Moon phase for a given (possibly fractional) day index. */
function getMoonPhase(dayIndex, config = getConfig()) {
	const age = mod(dayIndex - config.lunarEpochDay, SYNODIC_PERIOD);
	const fraction = age / SYNODIC_PERIOD; // 0 = new, 0.5 = full
	const illumination = (1 - Math.cos(2 * Math.PI * fraction)) / 2;
	const bucket = Math.floor(fraction * 8 + 0.5) % 8; // nearest of 8 named phases
	return {
		age,
		fraction,
		illumination,
		phaseKey: MOON_PHASES[bucket],
	};
}

/** Count full moons whose instant falls within [phaseStartDayIndex, +length). */
function countFullMoons(phaseStartDayIndex, phaseLength, config = getConfig()) {
	const fullBase = config.lunarEpochDay + SYNODIC_PERIOD / 2;
	const lo = phaseStartDayIndex;
	const hi = phaseStartDayIndex + phaseLength; // exclusive
	const kMin = Math.ceil((lo - fullBase) / SYNODIC_PERIOD);
	const kMax = Math.ceil((hi - fullBase) / SYNODIC_PERIOD) - 1;
	return Math.max(0, kMax - kMin + 1);
}

/** A phase is "strong" when two or more full moons fall within it. */
function isStrongPhase(phaseStartDayIndex, phaseLength, config = getConfig()) {
	return countFullMoons(phaseStartDayIndex, phaseLength, config) >= 2;
}

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

function getGranularity() {
	const value = game.settings.get(MODULE_ID, SETTING_GRANULARITY);
	return GRANULARITY_SECONDS[value] ? value : "dayQuarter";
}

function registerCalendarSettings() {
	game.settings.register(MODULE_ID, SETTING_ENABLED, {
		name: "FBL_ENHANCEMENTS.CALENDAR.SETTINGS.ENABLED.NAME",
		hint: "FBL_ENHANCEMENTS.CALENDAR.SETTINGS.ENABLED.HINT",
		scope: "world",
		config: true,
		type: Boolean,
		default: true,
		onChange: () => ui.controls?.render(),
	});

	game.settings.register(MODULE_ID, SETTING_VISIBLE, {
		name: "FBL_ENHANCEMENTS.CALENDAR.SETTINGS.VISIBLE.NAME",
		hint: "FBL_ENHANCEMENTS.CALENDAR.SETTINGS.VISIBLE.HINT",
		scope: "world",
		config: true,
		type: Boolean,
		default: true,
		onChange: () => {
			ui.controls?.render();
			if (!game.user.isGM && !game.settings.get(MODULE_ID, SETTING_VISIBLE)) {
				calendarApp?.close();
			}
		},
	});

	game.settings.register(MODULE_ID, SETTING_GRANULARITY, {
		scope: "client",
		config: false,
		type: String,
		default: "dayQuarter",
	});

	game.settings.register(MODULE_ID, SETTING_COMPACT, {
		scope: "client",
		config: false,
		type: Boolean,
		default: true,
	});

	game.settings.register(MODULE_ID, SETTING_CONFIG, {
		scope: "world",
		config: false,
		type: Object,
		default: DEFAULT_CONFIG,
		onChange: () => calendarApp?.rendered && calendarApp.render(),
	});

	game.settings.registerMenu(MODULE_ID, "calendarSetup", {
		name: "FBL_ENHANCEMENTS.CALENDAR.CONFIG.MENU_NAME",
		hint: "FBL_ENHANCEMENTS.CALENDAR.CONFIG.MENU_HINT",
		label: "FBL_ENHANCEMENTS.CALENDAR.CONFIG.MENU_LABEL",
		icon: "fas fa-calendar-days",
		type: FblCalendarConfigApp,
		restricted: true,
	});
}

/* -------------------------------------------- */
/*  Calendar window (ApplicationV2)             */
/* -------------------------------------------- */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let calendarApp = null;

class FblCalendarApp extends HandlebarsApplicationMixin(ApplicationV2) {
	static DEFAULT_OPTIONS = {
		id: "fbl-calendar",
		classes: ["fbl-calendar", "forbidden-lands"],
		position: { width: 360, height: "auto" },
		window: {
			title: "FBL_ENHANCEMENTS.CALENDAR.TITLE",
			icon: "fas fa-calendar-days",
			resizable: false,
		},
		actions: {
			skipForward: function () {
				return this.skip(1);
			},
			skipBack: function () {
				return this.skip(-1);
			},
			openConfig: function () {
				new FblCalendarConfigApp().render(true);
			},
			setGranularity: function (event, target) {
				const value = target?.dataset?.value;
				if (!value) return;
				game.settings.set(MODULE_ID, SETTING_GRANULARITY, value).then(() => this.render());
			},
			toggleSize: function () {
				return this.toggleSize();
			},
		},
	};

	static PARTS = {
		body: { template: `modules/${MODULE_ID}/templates/calendar.hbs` },
	};

	get compact() {
		return game.settings.get(MODULE_ID, SETTING_COMPACT);
	}

	async _prepareContext() {
		const config = getConfig();
		const date = worldTimeToDate(game.time.worldTime, config);
		const phase = DEFAULT_PHASES[date.phaseIndex];
		const moon = getMoonPhase(date.dayIndex, config);
		const strong = isStrongPhase(date.phaseStartDayIndex, date.phaseLength, config);

		const granularity = getGranularity();
		const granularityOptions = Object.keys(GRANULARITY_SECONDS).map((value) => {
			const key = value === "dayQuarter" ? "DAY_QUARTER" : value === "quarter" ? "QUARTER" : "HOUR_QUARTER";
			return {
				value,
				label: l(`CALENDAR.GRANULARITY.${key}`),
				shortLabel: l(`CALENDAR.GRANULARITY.${key}_SHORT`),
				selected: value === granularity,
			};
		});

		const pad = (n) => String(n).padStart(2, "0");
		const compact = this.compact;
		const holidayName = l(`CALENDAR.${phase.holiday}`);
		const days = compact
			? []
			: Array.from({ length: date.phaseLength }, (_, i) => ({
					day: i + 1,
					isCurrent: i === date.dayInPhase,
					isHoliday: i === 0,
					holidayName: i === 0 ? holidayName : null,
				}));

		return {
			isGM: game.user.isGM,
			compact,
			days,
			year: date.year,
			phaseName: l(`CALENDAR.${phase.name}`),
			holidayName,
			isHoliday: date.isHoliday,
			dayInPhase: date.dayInPhase + 1,
			phaseLength: date.phaseLength,
			isStrong: strong,
			moonLabel: l(`CALENDAR.${moon.phaseKey}`),
			moonIllum: Math.round(moon.illumination * 100),
			dayQuarterLabel: l(`CALENDAR.${DAY_QUARTERS[date.dayQuarterIndex].key}`),
			clock: `${pad(date.hour)}:${pad(date.minute)}`,
			granularity,
			granularityOptions,
		};
	}

	async skip(direction) {
		if (!game.user.isGM) return;
		const seconds = GRANULARITY_SECONDS[getGranularity()] ?? GRANULARITY_SECONDS.dayQuarter;
		await game.time.advance(seconds * direction);
	}

	async toggleSize() {
		await game.settings.set(MODULE_ID, SETTING_COMPACT, !this.compact);
		this.render();
	}

	_onRender(context, options) {
		super._onRender?.(context, options);
		// Always re-request "auto" height alongside width: the expanded view adds the day-grid
		// section, and without nudging height too, ApplicationV2 keeps the smaller compact-mode
		// height, clipping the new content instead of growing the window.
		this.setPosition({ width: this.compact ? 360 : 480, height: "auto" });
	}
}

/* -------------------------------------------- */
/*  Calendar setup form (ApplicationV2 form)    */
/* -------------------------------------------- */

class FblCalendarConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
	static DEFAULT_OPTIONS = {
		id: "fbl-calendar-config",
		tag: "form",
		classes: ["fbl-calendar-config", "forbidden-lands", "standard-form"],
		position: { width: 480, height: 640 },
		window: {
			title: "FBL_ENHANCEMENTS.CALENDAR.CONFIG.TITLE",
			icon: "fas fa-calendar-days",
			contentClasses: ["standard-form"],
			resizable: true,
		},
		form: {
			handler: FblCalendarConfigApp.onSubmit,
			submitOnChange: false,
			closeOnSubmit: true,
		},
	};

	static PARTS = {
		body: { template: `modules/${MODULE_ID}/templates/calendar-config.hbs` },
		footer: { template: "templates/generic/form-footer.hbs" },
	};

	async _prepareContext() {
		const config = getConfig();
		const date = worldTimeToDate(game.time.worldTime, config);
		const phases = DEFAULT_PHASES.map((p, i) => ({
			index: i,
			label: l(`CALENDAR.${p.name}`),
			holiday: l(`CALENDAR.${p.holiday}`),
			length: config.phaseLengths[i],
			selected: i === date.phaseIndex,
		}));
		const quarters = DAY_QUARTERS.map((q, i) => ({
			index: i,
			label: l(`CALENDAR.${q.key}`),
			selected: i === date.dayQuarterIndex,
		}));
		return {
			startingYear: config.startingYear,
			lunarEpochDay: config.lunarEpochDay,
			phases,
			quarters,
			currentYear: date.year,
			currentDay: date.dayInPhase + 1,
			buttons: [{ type: "submit", icon: "fas fa-save", label: "FBL_ENHANCEMENTS.CALENDAR.CONFIG.SAVE" }],
		};
	}

	static async onSubmit(event, form, formData) {
		const data = foundry.utils.expandObject(formData.object);

		const phaseLengths = DEFAULT_PHASES.map((p, i) => {
			const n = Number(data.phaseLengths?.[i]);
			return Number.isFinite(n) && n > 0 ? Math.round(n) : p.length;
		});

		const config = {
			startingYear: Number(data.startingYear) || DEFAULT_CONFIG.startingYear,
			lunarEpochDay: Number(data.lunarEpochDay) || 0,
			phaseLengths,
		};
		await game.settings.set(MODULE_ID, SETTING_CONFIG, config);

		if (game.user.isGM) {
			const phaseIndex = Math.max(0, Math.min(phaseLengths.length - 1, Number(data.datePhase) || 0));
			const dayInPhase = Math.max(
				0,
				Math.min(phaseLengths[phaseIndex] - 1, (Number(data.dateDay) || 1) - 1),
			);
			const secondsOfDay = (Math.max(0, Number(data.dateQuarter) || 0)) * 21600;
			const target = dateToWorldTime(
				{ year: Number(data.dateYear) || config.startingYear, phaseIndex, dayInPhase, secondsOfDay },
				config,
			);
			await game.time.advance(target - game.time.worldTime);
		}

		calendarApp?.rendered && calendarApp.render();
	}
}

/* -------------------------------------------- */
/*  UI wiring                                   */
/* -------------------------------------------- */

function calendarVisibleToUser() {
	if (!game.settings.get(MODULE_ID, SETTING_ENABLED)) return false;
	if (game.user.isGM) return true;
	return game.settings.get(MODULE_ID, SETTING_VISIBLE);
}

function openCalendar() {
	if (!calendarVisibleToUser()) return;
	if (!calendarApp) calendarApp = new FblCalendarApp();
	if (calendarApp.rendered) calendarApp.close();
	else calendarApp.render(true);
}

function registerSceneControl() {
	Hooks.on("getSceneControlButtons", (controls) => {
		if (!calendarVisibleToUser()) return;

		// V13 passes an object keyed by control name, each with a `tools` object.
		const tokenControl = controls?.tokens;
		if (!tokenControl?.tools) {
			console.warn(`${MODULE_ID} | calendar: unexpected scene-control structure, skipping toggle`);
			return;
		}

		tokenControl.tools["fbl-calendar"] = {
			name: "fbl-calendar",
			title: l("CALENDAR.OPEN"),
			icon: "fas fa-calendar-days",
			button: true,
			order: 99,
			onChange: () => openCalendar(),
			onClick: () => openCalendar(),
		};
	});
}

/* -------------------------------------------- */
/*  Lifecycle                                    */
/* -------------------------------------------- */

// Registered immediately at module load (not deferred to "ready"): Foundry V13 builds the
// scene-control toolbar before "ready" fires, and does not reliably re-invoke
// "getSceneControlButtons" afterward. A listener attached inside Hooks.once("ready", ...)
// can miss that first build entirely, leaving the calendar toggle permanently absent.
registerSceneControl();

Hooks.once("init", () => {
	registerCalendarSettings();
});

Hooks.once("ready", () => {
	ui.controls?.render();

	Hooks.on("updateWorldTime", (worldTime, dt) => {
		if (calendarApp?.rendered) calendarApp.render();

		// Detect in-game day boundaries and broadcast a custom hook so other
		// features (in main.js or elsewhere) can drive day-based automation
		// without importing calendar internals. Fires on every client — the
		// dt arg is the just-applied delta; worldTime is the new value.
		const delta = Number(dt) || 0;
		const prevDayIndex = worldTimeToDate(worldTime - delta).dayIndex;
		const newDayIndex = worldTimeToDate(worldTime).dayIndex;
		if (newDayIndex !== prevDayIndex) {
			// elapsedDays is signed: negative when the calendar is rewound.
			Hooks.callAll("fbl-enhancements.dayChanged", {
				worldTime,
				dt: delta,
				prevDayIndex,
				newDayIndex,
				elapsedDays: newDayIndex - prevDayIndex,
			});
		}
	});

	// Expose the date engine for future features without clobbering main.js's api.
	const moduleData = game.modules.get(MODULE_ID);
	if (moduleData) {
		moduleData.api = Object.assign(moduleData.api || {}, {
			calendar: {
				worldTimeToDate,
				dateToWorldTime,
				getPhaseForDay,
				getMoonPhase,
				isStrongPhase,
				countFullMoons,
				getConfig,
				openCalendar,
				PHASES: DEFAULT_PHASES,
			},
		});
	}
});
