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

## Open questions

- Maximum local players, and whether one World may host several local players' views (split screen).
- How a profile's overrides migrate when a game renames or removes an action.
- Whether the server may read a predicted pawn's action phase flags or only its values.

## References

- Rewired players and maps: https://guavaman.com/projects/rewired/docs/Players.html
- Unreal Enhanced Input user settings: https://dev.epicgames.com/documentation/en-us/unreal-engine/enhanced-input-in-unreal-engine
- Common UI input: https://dev.epicgames.com/documentation/en-us/unreal-engine/common-ui-plugin-for-advanced-user-interfaces-in-unreal-engine
- `src/engine/net/input.ts`, `src/engine/net/replication.ts` (per-field `quantize`)
