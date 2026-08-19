# fbl-enhancements
Optional enhancements module for the Forbidden Lands system in Foundry VTT.

## Goal
Keep all custom automation in a separate add-on module so it can be enabled or disabled independently of the base system.

## Compatibility

This is the **Foundry VTT V14** line of the module (`0.14.x`), maintained on the `v14` branch.
It requires the Forbidden Lands system **14.0.0 or newer** and will not install on Foundry V13.

For Foundry V13 + Forbidden Lands 13.x, use the `main` branch (`0.4.x`) instead.

## Install (manifest)
Use this manifest URL in Foundry:

`https://raw.githubusercontent.com/NeocorDK/fbl-enhancements/v14/module.json`

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
- body armor first
- then helmet

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
- **Rewinding the calendar reverses the countdown:** if the GM moves time backwards, each injury's
  remaining days go back up (capped at its original healing time). Injuries that already healed away
  are not resurrected.
- All changes are made by the active GM only. Injuries that already existed before this feature was
  installed are initialized on world load.

### 11. Merchants
A merchant actor whose sheet is a stock editor for the GM and a storefront for players.

- **Creating one:** create an Actor of type **Merchant** and drop its token on the canvas. New
  merchants default to *Observer* permission for all players, so they can browse without any
  per-merchant permission setup, and to a linked token so every copy shares one stock pool.
- **Stocking it:** drag items — or a whole folder — onto the merchant sheet. Each item is rolled
  against its rarity:

  | Rarity | Available on `1d6` | Quantity |
  |---|---|---|
  | Common | 2+ | `2d12` |
  | Uncommon | 4+ | `1d6` |
  | Rare | 6 | 1 |

  Items that come up unavailable are removed from the merchant. Stock rolls are silent — nothing
  is posted to chat.
- **Restocking a recurring merchant:** dropping goods the merchant already carries re-rolls that
  entry instead of adding a duplicate row, so re-dropping the same folder refreshes the whole
  assortment. Two GM buttons above the goods list do the same thing without dragging:
  - **Supply reroll** — re-rolls availability and quantity for everything currently in stock.
    Entries that come up unavailable are removed, exactly as on a first drop; re-drop the folder
    to bring them back.
  - **Clear all** — empties the merchant completely. Asks for confirmation, since it cannot be undone.
- **Buying:** a player clicks *Buy*. The purchase is carried out by the active GM: coins are
  deducted with denomination borrowing (paying 12 copper from 5 silver + 2 copper leaves 4 silver
  and 0 copper — the rest of the purse is left alone), the item lands in the character's carried
  gear, the merchant's stock drops by one, and a chat message announces the sale. The buyer is the
  user's assigned character, or the single selected token if none is assigned.
- **Running out:** at zero stock the row stays visible to the GM, marked *Sold out* with an editable
  stock field for restocking, and disappears entirely for players.
- Two players clicking the last unit at the same moment resolve in order — exactly one succeeds.

### 12. Selling to a merchant
The **Sell** tab is private per player — nobody can see what another player has queued to sell.

- Drag items from your own inventory onto the Sell tab to add them to your list. The offered price
  starts from the item's price, reduced for a damaged item and adjusted by the merchant's buy-price
  modifier (see below). A fully broken item (0 condition) is offered at exactly 10% of full price;
  the discount scales proportionally in between.
- **Sell** sends your list to the GM for review and locks the tab until they decide. **Clear list**
  empties it instantly with no GM involvement.
- The GM's review window shows every item, quantity, and price, all editable — remove a line, change
  a quantity, or type a different price — before **Accept** or **Reject**.
  - **Accept:** you're paid the (possibly edited) total and the sold items/quantities leave your
    inventory. Nothing is added back to the merchant's own stock.
  - **Reject:** the lock lifts and your Sell tab shows the exact list you submitted, ready to edit
    and resend.

### 13. Repairing items
An optional **Repair** tab, enabled per merchant in its settings (see below).

- Drag a damaged or broken item onto the tab to see its repair cost, computed from the item's price
  and its current/maximum condition, adjusted by the merchant's sell-price modifier.
- **Repair** deducts the total cost from your character and restores every queued item to full
  condition. There is no GM approval step — you already own the character being charged and repaired.

### 14. Per-merchant settings
Each merchant has its own **Merchant Settings** (GM only, button above the goods list):

- **Sell price modifier** (-100% to +100%) — markup/discount on what this merchant charges players
  buying goods, and on the repair cost.
- **Buy price modifier** (-100% to +100%) — markup/discount on what this merchant offers players
  selling their own items to it.
- **Allow item repair** — toggles the Repair tab for this merchant.

Both modifiers are entered as a slider or a typed percentage; they only affect the one merchant
they're set on.

### 15. Item prices and rarity
The Forbidden Lands system stores an item's price as free text (`5 copper`, `8 silver`) and its
rarity as free text (`Common` / `Uncommon` / `Rare`), which nothing can compute with. The module
parses both into structured values stored in its own item flags — **the system's own Cost and
Supply fields are never modified.**

- Gear, weapon, armor, and raw-material sheets gain a gold / silver / copper price row and a rarity
  dropdown, both editable and saved with the rest of the sheet.
- Prices use 1 gold = 10 silver = 100 copper, matching the character sheet's currency fields. A
  bare number with no denomination word is read as copper.
- **Migration** runs once automatically on world load (active GM only) and reports its results. It
  can be re-run at any time from *Configure Settings → Price migration*, optionally limited to world
  items or actor-owned items, and optionally overwriting prices you have already set.
- Items created later (compendium imports, new gear) are priced as they are created.
- The system's Cost and Supply text fields stay the source of record: editing either one
  re-parses it into the structured value straight away, so typing `Rare` into Supply after an
  item already exists takes effect immediately. Picking a rarity from the dropdown instead
  overrides the text and is not overwritten by later migrations.

## Module settings
The module adds world settings (checkboxes):
- `Combat automation in chat`
- `Rest confirmation dialog`
- `Critical injury healing countdown`
- `Merchant automation`
- `Announce purchases in chat`
- `Enable calendar`
- `Calendar visible to players`
- `Calendar Setup` (menu) — configure phases, lunar cycle, starting year, and set the current date/time
- `Price migration` (menu) — re-run the Cost/Supply → price/rarity migration

## Disabling the module
Merchant actors are a module sub-type. If the module is disabled, the world still loads, but
existing merchants appear as unknown-subtype placeholders until it is re-enabled. Nothing is lost.

## How it works (technical overview)
- Uses runtime patches/hooks only (no direct modifications to base Forbidden Lands system files).
- Overrides YZ roll chat template with module template for combat card UI.
- Patches roll handling to preserve attack metadata (damage type, attack category/ammo, target ids).
- Stores attack state in message flags and synchronizes state updates via active GM when needed.
- Adds localized UI strings through module language files (`lang/*.json`: en, ru, es, de, pt-BR).
- Adds the merchant actor sub-type through the manifest's `documentTypes`, with a `TypeDataModel`
  and its own sheet, so the base system's `template.json` is never touched.
- Stores prices, rarity, and merchant stock in item flags rather than system fields, so nothing the
  module writes can collide with a system update.
- A player's sell/repair carts live in flags on their own character actor, never on the merchant —
  each player already owns their own actor, so no socket is needed to build or edit a cart, and
  Foundry's normal document permissions keep one player's cart invisible to another. Only the final
  sell decision (GM accept/reject) and its wake-up notification travel over the socket.

## Project structure
- `module.json` - Foundry module manifest
- `scripts/main.js` - module runtime patches, hooks, automation logic
- `scripts/calendar.js` - built-in calendar: date/moon engine, calendar window, setup form
- `scripts/economy.js` - price/rarity parsing, item sheet price fields, price migration
- `scripts/merchant.js` - merchant actor type, sheet, stock rolls, purchases
- `scripts/merchant-trade.js` - selling to a merchant, repairs, per-merchant price modifiers
- `templates/roll.hbs` - custom roll chat card template
- `templates/dialog.hbs` - custom roll dialog template (with damage type selection)
- `templates/calendar.hbs`, `templates/calendar-config.hbs` - calendar window and setup form
- `templates/merchant-sheet.hbs` - merchant sheet (GM stock editor / player storefront)
- `templates/merchant-sell-review.hbs` - GM review window for a player's sell offer
- `templates/merchant-settings.hbs` - per-merchant settings form (price modifiers, repair toggle)
- `templates/price-migration.hbs` - price migration form
- `styles/fbl-enhancements.css` - chat card/button styling
- `styles/fbl-calendar.css` - calendar styling (Forbidden Lands theme)
- `styles/fbl-merchant.css` - merchant sheet and item price field styling
- `lang/*.json` - localization files (en, ru, es, de, pt-BR). The calendar is fully translatable
  through these files — adding a language needs only a new JSON file and a `languages` entry in
  `module.json`, with no code changes.
