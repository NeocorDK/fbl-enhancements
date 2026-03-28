# fbl-enhancements
Optional enhancements module for the Forbidden Lands system in Foundry VTT.

## Goal
Keep all custom automation in a separate add-on module so it can be enabled or disabled independently of the base system.

## Install (manifest)
Use this manifest URL in Foundry:

`https://raw.githubusercontent.com/NeocorDK/fbl-enhancements/main/module.json`

## Current structure
- `module.json` - Foundry module manifest
- `scripts/main.js` - module entry point
- `styles/fbl-enhancements.css` - module styles
- `lang/en.json`, `lang/ru.json` - localization files

## Next step
Move combat-rework features from the system fork into this module as hooks/overrides without editing base system files.
