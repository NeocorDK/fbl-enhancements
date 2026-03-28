const MODULE_ID = "fbl-enhancements";

Hooks.once("init", () => {
	console.log(`${MODULE_ID} | Initializing module`);
});

Hooks.once("ready", () => {
	console.log(`${MODULE_ID} | Module ready`);
});

Hooks.once("setup", () => {
	game.modules.get(MODULE_ID)?.api = {
		MODULE_ID,
	};
});
