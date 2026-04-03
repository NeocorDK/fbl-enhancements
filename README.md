# fbl-enhancements
Optional enhancements module for the Forbidden Lands system in Foundry VTT.

## Goal
Keep all custom automation in a separate add-on module so it can be enabled or disabled independently of the base system.

## Install (manifest)
Use this manifest URL in Foundry:

`https://raw.githubusercontent.com/NeocorDK/fbl-enhancements/main/module.json`

## What this module adds

### 1. Combat automation buttons in attack chat cards
For attack rolls, the module adds action buttons directly to chat:
- `Apply damage`
- `Dodge`
- `Parry`
- `Armor`

These buttons are shown in a vertical stack and use the Forbidden Lands visual style.

### 2. Target-owner access control
Combat action buttons are available only to users who own the target actor/token.
If the attacker does not own the target, they cannot trigger target-side defense actions.

### 3. Attack state sync (owner-safe flow)
When a user cannot directly update the attack chat message (permission limitations), the module uses a GM relay through socket updates to keep attack state synchronized.

### 4. Damage type support in roll flow
The module supports and propagates these damage types:
- `stab`
- `slash`
- `blunt`
- `fire`
- `empathy`
- `endurance`
- `fear`
- `other`

Damage type is shown in the attack chat card and used when applying damage.

### 5. Attribute mapping for applied damage
When `Apply damage` is used, damage is applied to actor attributes by damage type:
- `stab`, `slash`, `blunt`, `fire`, `other` -> `strength`
- `empathy` -> `empathy`
- `fear` -> `wits`
- `endurance` -> `agility`

### 6. Trauma table trigger on break (characters)
When applied damage drops an attribute from above 0 to 0, the module attempts to roll on trauma tables:
- `wits` break -> `Horror Trauma`
- `strength` break:
  - `stab` -> `Critical Injuries - Stab Wounds`
  - `slash` -> `Critical Injuries - Slash Wounds`
  - `blunt` -> `Critical Injuries - Blunt Wounds`

Monster actors are excluded from trauma table rolls.

### 7. Armor side effects (gear damage)
If armor defense roll produces banes/failures and incoming attack is still successful, armor item bonuses are reduced:
- helmet first
- then body armor

Monsters are excluded from armor item degradation.

### 8. Parry restrictions
- Ranged attacks cannot be parried unless the defender has an equipped shield.
- Parry requires an equipped melee weapon with the `parrying` feature.

## Module settings
The module adds world settings (checkboxes):
- `Combat automation in chat`

## How it works (technical overview)
- Uses runtime patches/hooks only (no direct modifications to base Forbidden Lands system files).
- Overrides YZ roll chat template with module template for combat card UI.
- Patches roll handling to preserve attack metadata (damage type, attack category/ammo, target ids).
- Stores attack state in message flags and synchronizes state updates via active GM when needed.
- Adds localized UI strings through module language files (`lang/en.json`, `lang/ru.json`).

## Project structure
- `module.json` - Foundry module manifest
- `scripts/main.js` - module runtime patches, hooks, automation logic
- `templates/roll.hbs` - custom roll chat card template
- `templates/dialog.hbs` - custom roll dialog template (with damage type selection)
- `styles/fbl-enhancements.css` - chat card/button styling
- `lang/en.json`, `lang/ru.json` - localization files
