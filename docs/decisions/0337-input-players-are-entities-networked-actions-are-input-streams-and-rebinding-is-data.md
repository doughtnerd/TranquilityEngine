# 0337. Input players are entities, networked actions are input streams, and rebinding and prompts are data

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0017, 0024, 0032, 0033, 0069, 0311, 0335, 0336

## Context

0335 brings devices into Worlds and 0336 turns them into actions. Three things remain:

- **Who the input belongs to.** Godot's actions are global (local co-op means `p1_jump`, `p2_jump`); Unity's
  `PlayerInputManager` and Unreal's LocalPlayer work but are heavy. Rewired's model is the one games copy: a Player owns
  devices and maps, and player 0 needs no setup.
- **Netcode.** ADR 0033 already has per-tick input streams (`defineInput`, `net/input.ts`): redundancy, tick tagging,
  late and repeated counts, client history for prediction. Gameplay that reads input differently online and offline is
  a bug source.
- **Rebinding and prompts.** Every engine leaves the rebinding UI and button glyphs to plugins (Rewired's Control
  Mapper, Common UI, Input Helper, Controller Icons). They are the most common reason to buy one.

## Decision

**Players are entities.**

- A player is an entity with `InputPlayer { index, joinState, lastFamily }`, the game's action-set components (0336),
  and an internal `InputPlayerState` (trigger timers, consumed controls, latched edges, the compiled table).
- The bootstrap spawns **player 0** in each World that takes local input, paired with every device. A single-player
  game never sees this layer.
- **`engine.InputPairing`** (`input` phase) applies the project's join policy (`single`, `pressToJoin`,
  `onePerDevice`, `manual`), pairs device entities to players, and appends to `PlayerJoined` and `PlayerLeft` buffers.

**Possession copies actions onto the pawn.**

- `ControlledBy { player: ref }` on a node makes it that player's pawn. **`engine.InputPossess`** (`input` phase, after
  evaluation) copies each player's action-set values onto its pawns, so a pawn has its own `PlayerActions` row.
- Systems query one entity (`[Transform, PlayerActions, Mover]`) with no join, which is what predicted systems (ADR
  0033) assume.
- A behavior's `this.input` is the nearest `ControlledBy` up its hierarchy, else player 0.
- **Anything that writes an action-set component drives a pawn.** An AI system writes `PlayerActions` on an NPC (no
  `ControlledBy`), and the same controller code runs it.

**Networked action sets are input streams.**

- `defineActions(…, { networked: true })` defines the matching `defineInput` stream with the same schema. Only
  resolved actions travel; triggers and modifiers run on the client.
- Client: `engine.InputTick` writes the tick's values into the stream.
- Server: `engine.NetInputTick` writes each received tick into the **same component** on the connection's pawn
  (`Replicated.ownerId` resolves the connection, ADR 0311).
- Prediction re-simulation restores the component per tick from the client's input history (already kept by
  `net/input.ts`).
- Gameplay reads `PlayerActions` the same way on client, server and offline.
- **Analog values travel as `f32` by default.** A field may opt in to a quantize step with replication's vocabulary
  (`encoding: { move: { quantize: 1 / 127 } }`). Quantization is applied at the source: `engine.InputTick` writes the
  quantized value back into the local component before predicted systems read it, so client and server always agree.
  Measured cost of `f32`: two moving sticks are 4 fields × 4 bytes × 4 ticks per packet × 60 Hz ≈ 3.8 KB/s upstream per
  player; buttons and still sticks cost about nothing (the codec skips unchanged fields). `defineInput` gains the same
  `encoding` option.
- Editor thin clients' synthetic input (`_writeSyntheticInput`) becomes a bot writing the action set.

**Replays and tests use the same data.**

- A replay is the sequence of action-set values per tick per player.
- Tests inject raw device events through a public `Input.inject(...)`, or write action-set components through the
  public data API: both are what callers use.

**Rebinding is data.**

- Overrides are per player profile: control-path replacements per context mapping, saved with settings (ADR 0024) as
  `input.<profile>.json`.
- `player.rebind("jump", { cancel: "<Keyboard>/escape" })` adds a `RebindRequest` component. **`engine.InputRebind`**
  (`input` phase) watches `DeviceEvents`, checks conflicts against every context that can be active with the edited
  one, writes the override, marks the player for recompiling, and appends to `RebindResults`. The facade returns a
  promise resolved from that buffer.
- A rebinding UI component ships in the engine's UI library (Rewired's Control Mapper), built on these calls.

**Prompts are queries.**

- `engine.InputEvaluate` keeps `InputPlayer.lastFamily` up to date (the family of the device that last performed an
  action).
- `player.prompt("jump")` returns the control for that family from the compiled table, with an icon key; UI rebinds
  when `lastFamily` changes. A default glyph set (keyboard, xbox, playstation, switch, generic) ships with the engine.

**Accessibility per player** (Rewired's input behaviours): hold-to-toggle per action, repeat rate, sensitivity and
response curve, invert Y, deadzone override. Stored with the overrides, applied by the evaluator.

## Alternatives considered

- **Global actions (Godot).** Simplest, but local co-op and device pairing become game code.
- **Join through a reference instead of copying onto the pawn.** No copy, but every pawn query needs a join, and
  predicted systems would read state on another entity.
- **Send raw device state to the server.** The server would evaluate triggers, but bandwidth grows, prediction needs
  the same evaluation on both ends, and the server must know every device.
- **Quantize by default.** About 4× smaller for analog fields, but a wrong step causes mispredictions or bad feel;
  opt-in keeps correctness the default.
- **Rebinding and glyphs as a separate plugin.** That is the gap every other engine has.

## Consequences

**Positive**
- Single-player games need no setup; local co-op and AI-driven pawns use the same code.
- One component is the input on client, server, in prediction, replays and tests.
- Rebinding, prompts and accessibility come with the engine.

**Negative / costs**
- Copying actions onto pawns costs a write per pawn per frame (small: a few numbers per pawn).
- `defineInput` and replication's encoding vocabulary must agree; a shared codec option.
- A glyph set to ship and keep current with new controllers.

## Deprecates

Nothing. `defineInput` stays for input that isn't an action set.

## Build notes (2026-11-22)

- `InputContext.player` is a player index (-1: the player controlling the node), not a reference.
- Player 0 is created once an action set is defined, so Worlds of games without actions get no player node.
- The default glyph set ships as labels and icon keys per family; images are not included yet. Conflict checks cover the contexts active when rebinding.

## Build notes (2026-11-22, second pass)

- Supersedes the conflict-check note above: rebinding checks every context the player could have, compiled with the player's profile: the default context, every context registered with `defineInputContext`, and every context an `InputContext` component in the World names for that player, active or not.
- Repeat rate: `InputAccessibility.repeat = { delay, interval, actions? }`. A button action kept triggered performs again `delay` seconds after it first performed, then every `interval` (one repeat per frame at most); `actions` limits it, else every button action repeats.
- Server pawns get `ActionEvents`: when `engine.InputNetApply` writes a client's tick into a pawn's set, the tick's edge flags become events with `node` = the pawn, `player` = the owning connection's node and `index` = the client's local player. They're dispatched to `on` by `engine.InputTickEventScripts` (fixedUpdate, before scripts). A tick the server repeats because its input is missing keeps the values and level flags but clears the edges, so a press isn't performed twice.
- Several local players per connection: a client sends every local player's actions. `defineInput` streams gain an optional local player index (`write(values, player)`, `localOf(player)`, `of(node, player)`, `stats(node, player)`); each player's inputs travel in their own packets, with their own buffer and counters on the server. The wire is unchanged for player 0; another player's packet body starts with a varuint 0 (never a valid count) and the player's index. On the server a pawn names the client's local player with the data component `ConnectionPlayer { index }` (absent: player 0). It's separate from `ControlledBy`, which names a player of the World's own, so a host doesn't copy its local players' actions onto remote pawns. While a client re-simulates, a pawn without `ConnectionPlayer` takes its `ControlledBy` player's input.

## Build notes (2026-11-22, glyphs and the rebinding screen)

- **Glyph images** (`src/engine/input/glyphs.ts`, `InputGlyphs`): every icon key prompts give is drawn as an SVG from plain
  shapes, letters and symbols, no vendor artwork: keycaps with the key's label (so every key has one), the mouse with the
  button lit (and delta, scroll, position), and per family (xbox, playstation, switch, generic) face buttons
  (PlayStation's shapes, Xbox's coloured letters, Switch's letter layout, a position diamond for generic pads),
  shoulders, triggers, sticks and their axes and presses, the d-pad, menu buttons, home, touchpad, gyro, accelerometer
  and paddles. Keys outside those get a labelled badge.
- They're generated on first use rather than shipped as files: the generator is about 9.8 KB minified (3.4 KB gzipped)
  in the engine bundle, where the ~140 fixed glyphs as files would be about 70 KB and still couldn't cover every key.
  Nothing has to be copied into the player, exported games or the engine library.
- `InputGlyphs.get(icon)` gives `{ svg, width, height, url, asset }`. `asset` is `asset:@myco/glyphs/<icon key>.svg`,
  served by a built-in asset source (`Assets.addBuiltinSource`, internal: looked up after the game's sources and kept
  by `clearSources`), so `UIImage.image`, UI documents and sprites take glyphs like any texture.
- `InputPrompt` gains `parts` (each control's rebind part) and `context`, which a rebinding UI passes back to `rebind`.
- **The rebinding UI** is `UIControlMapper` (`src/engine/ui/controlMapper.ts`, exported from the engine index rather than claimed by the UI plugin, so loading it doesn't change the order input systems register in; it warns and does nothing with the UI plugin off): it builds UI
  elements as its node's children (not saved in the scene), a row per action or composite part
  with keyboard and gamepad cells (glyphs and labels, the gamepad column following `lastFamily`), rebinding on click or
  on Enter / the south button with arrow-key and d-pad selection, Escape and a timeout to cancel, conflicts in a status
  line and on the cells, Reset (`resetBindings`) and Save (`saveBindings`). Its system, `engine.UIControlMapper`, runs
  in `update` after `engine.UIDocumentEvents` and `engine.InputFrame`, and reads rebind results from `RebindResults`.
- Not done: rebinding a chord's modifier keys from the screen (a chord cell rebinds its main key), adding a binding
  where an action has none for a device (`rebind` only replaces existing controls), and accessibility settings on the
  screen.

## Build notes (2026-11-22, chord rebinding and accessibility on the screen)

- **Chord rebinding:** `RebindOptions.chord`, on by default for a modifier composite's `control` part. The rebind finishes at the first release of a control pressed during it. The chord is every control of the device group then held, plus Shift, Ctrl, Alt and Meta held as it started. The main control is the last one pressed (on the keyboard, the last key that isn't one of those four), and the rest are written as `modifier0`… overrides in press order. Finishing on release rather than on press lets a gamepad button be a modifier, and lets a modifier key alone be bound. A control already down at the start is ignored.
- **Modifier count:** a profile (format 1) replaces a mapping's controls but can't add or remove them. A chord whose modifier count differs from the mapping's is canceled with `reason: "modifierCount"`, and the binding is unchanged. Changing the count waits on the profile-format change (additions and removals).
- `RebindResult` gains `reason` (`cancel`, `timeout`, `replaced`, `modifierCount`; null when bound), `chord` (a chord rebind's controls, modifiers first) and `modifierCount`.
- A chord's conflicts are mappings of exactly the same controls; a plain mapping of its main key isn't one, since the chord claims it. `PendingRebind` gains `chord`.
- **UIControlMapper:** a chord is one cell, labelled with `text.chord` between the controls ("Shift + B") and showing every glyph, and its rebind captures the whole chord. `showAccessibility` adds a section with invert Y, sensitivity and hold-to-toggle rows for the actions listed in `invertYActions`, `sensitivityActions` and `holdToToggleActions`, plus repeat (on/off, delay and interval steppers, `repeatActions`) and the stick dead zone. The rows read and write `PlayerInput.accessibility` and are saved by Save. They sit in the screen's row and column selection, between the bindings and the buttons (a stepper's − and + are two columns), and are read through `settings`.
- Still not done: adding a binding where an action has none for a device.

## Build notes (2026-11-22, the screen on focus navigation)

- **UIControlMapper** no longer has a row and column selection: ADR 0340's focus navigation drives it. Its cells, the accessibility rows' toggles and − and + buttons, and Unbind, Reset and Save are focusable `UIButton`s; the arrows, d-pad and left stick move focus and `submit` clicks, and the mapper acts on clicks only. The `selected` getter is replaced by `focusedCell` (the focused binding cell, or null), and `UIControlMapperCell` gains `action`. Delete and Backspace unbind the focused cell; Unbind acts on the cell last focused. Details in ADR 0340's build notes.

## Open questions

- Maximum local players, and whether one World may host several local players' views (split screen).
- How a profile's overrides migrate when a game renames or removes an action.
- Whether the server may read a predicted pawn's action phase flags or only its values.

## References

- Rewired players and maps: https://guavaman.com/projects/rewired/docs/Players.html
- Unreal Enhanced Input user settings: https://dev.epicgames.com/documentation/en-us/unreal-engine/enhanced-input-in-unreal-engine
- Common UI input: https://dev.epicgames.com/documentation/en-us/unreal-engine/common-ui-plugin-for-advanced-user-interfaces-in-unreal-engine
- `src/engine/net/input.ts`, `src/engine/net/replication.ts` (per-field `quantize`)
