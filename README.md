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

### 9. Built-in Forbidden Lands calendar
A calendar that models the in-world human calendar and tracks the passage of time. It is the
foundation for future time-based features.

- **Year structure:** a 365-day year of 8 phases (45–46 days each). Each phase opens with a named
  holiday day: Winter Wane (Midwinter Day), Spring Rise (Day of Awakening), Spring Fall (Spring Turn),
  Summer Rise (Day of Greening), Summer Fall (Midsummer Day), Autumn Rise (Harvest Day),
  Autumn Fall (Autumn Turn), Winter Rise (Day of the Dead).
- **Moon phases:** the moon follows the real synodic cycle. A phase that contains two full moons is
  flagged as a **strong phase**, matching the lore that such phases strongly influence the year.
- **Time of day:** the day is divided into quarters — Morning, Daytime, Evening, Night (6h each),
  each split into quarter-of-quarters (1.5h), each hour into quarter-hours (15 min).
- **Time controls (GM only):** a granularity selector (quarter of day / quarter of quarter / quarter
  of hour) and forward / back buttons advance the world time by the selected step. Players can open
  and view the calendar but cannot change the time.
- **Setup:** the GM can configure phase lengths, the lunar cycle, and the starting year, and set the
  current date and time, from **Calendar Setup** in the module settings.
- **Access:** open the calendar with the calendar button in the scene controls (Token tools).
- Time is stored in Foundry's core world time, so all connected clients stay in sync automatically.

### 10. Automatic critical-injury healing
Critical injuries no longer have to be tracked by hand — the module counts their healing time down
as in-game days pass on the calendar.

- **On add:** when a critical injury is dropped onto a player character, its free-text *Healing Time*
  (e.g. `1d6 days`, `2 days`) is read once. Any dice are rolled to a concrete number and the field is
  rewritten to a plain `N days` counter.
- **Each new day:** every tracked injury's remaining days drop by the number of in-game days that
  elapsed. Advancing several days at once (travel, a rest, a date correction) is handled correctly.
- **On recovery:** when the counter reaches zero the injury is removed from the sheet and a public
  chat message announces that the character has recovered.
- **Manual adjustments are respected:** editing the healing-time field on the injury (for example
  when an ally uses the Healing skill to halve the remaining time) re-syncs the countdown to the
  value you enter. Setting it to a non-numeric value (`-`, `Permanent`) stops the automatic countdown.
- Injuries whose healing time has no number (`-`, `Permanent`, empty) are left untouched.
- All changes are made by the active GM only; rewinding the calendar never re-heals or resurrects an
  injury. Injuries that already existed before this feature was installed are initialized on world load.

## Module settings
The module adds world settings (checkboxes):
- `Combat automation in chat`
- `Rest confirmation dialog`
- `Critical injury healing countdown`
- `Enable calendar`
- `Calendar visible to players`
- `Calendar Setup` (menu) — configure phases, lunar cycle, starting year, and set the current date/time

## How it works (technical overview)
- Uses runtime patches/hooks only (no direct modifications to base Forbidden Lands system files).
- Overrides YZ roll chat template with module template for combat card UI.
- Patches roll handling to preserve attack metadata (damage type, attack category/ammo, target ids).
- Stores attack state in message flags and synchronizes state updates via active GM when needed.
- Adds localized UI strings through module language files (`lang/en.json`, `lang/ru.json`).

## Project structure
- `module.json` - Foundry module manifest
- `scripts/main.js` - module runtime patches, hooks, automation logic
- `scripts/calendar.js` - built-in calendar: date/moon engine, calendar window, setup form
- `templates/roll.hbs` - custom roll chat card template
- `templates/dialog.hbs` - custom roll dialog template (with damage type selection)
- `templates/calendar.hbs`, `templates/calendar-config.hbs` - calendar window and setup form
- `styles/fbl-enhancements.css` - chat card/button styling
- `styles/fbl-calendar.css` - calendar styling (Forbidden Lands theme)
- `lang/*.json` - localization files (en, ru, es, de, pt-BR). The calendar is fully translatable
  through these files — adding a language needs only a new JSON file and a `languages` entry in
  `module.json`, with no code changes.
