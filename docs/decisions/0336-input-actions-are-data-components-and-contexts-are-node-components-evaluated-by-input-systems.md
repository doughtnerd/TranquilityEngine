# 0336. Input actions are data components, contexts are node components, and built-in systems evaluate them

- **Status:** Accepted, amended by 0417 (action sets can also be `*.actions.json` assets; an asset set has no controls, and the default context is a real `default.input.json`)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0011, 0017, 0069, 0131, 0335, 0337, 0417

## Context

Games read raw keys (`Input.getKey("space")`). There are no actions, no bindings to rebind, no hold or tap detection,
and no way for a vehicle or a menu to take over some controls while others keep working.

What the engines do best:

- **Unity Input System:** typed actions, composites (WASD into a vector), processors, control paths.
- **Unreal Enhanced Input:** mapping contexts with a priority, added and removed at runtime; modifiers; triggers (hold,
  tap, pulse, chord, combo); a per-action "consume" flag; phases Started / Ongoing / Triggered / Completed / Canceled.
- **Godot:** the simplest start (an action with default keys in project settings), and an event model where a handled
  event stops propagating.
- **Plugins:** G.U.I.D.E brings Enhanced Input's model to Godot; Rewired adds per-action behaviours (gravity,
  sensitivity, double-press timing).

Unity's weaknesses to avoid: five ways to receive input, and no priority between maps. Unreal's: three assets for one
key. Godot's: global actions, no contexts, no triggers.

The system is built on the ECS stack (owner's constraint): data components and buffers (ADR 0017), systems in phases,
with GameBehaviors as a facade (ADR 0007). Devices come from 0335.

## Decision

**Actions are code: a data component per action set.**

```ts
export const PlayerActions = defineActions("game.PlayerActions", {
  move:  vec2,
  look:  vec2,
  jump:  button,
  heavy: button,
});
```

- Action types: `button`, `axis` (1D), `vec2`, `vec3`. Each expands to typed-array fields (ADR 0017): the value
  (`jump`, or `move.x`, `move.y`), a `u8` of phase flags (`jump$phase`: held, pressed, released, started, ongoing,
  performed, completed, canceled) and an `f32` elapsed time (`jump$time`, for hold progress and charge UI).
- Code-first gives type-safe names with no code generation; the editor lists registered action sets as it lists other
  registered types.

**Bindings are data: context assets.** A context (`*.input.json`) lists mappings from control paths (0335) to actions:

```json
{ "name": "onFoot", "mappings": [
  { "action": "move", "composite": "dpad", "up": "<Keyboard>/w", "down": "<Keyboard>/s", "left": "<Keyboard>/a", "right": "<Keyboard>/d" },
  { "action": "move", "control": "<Gamepad>/leftStick", "modifiers": [{ "deadzone": { "min": 0.15, "shape": "radial" } }] },
  { "action": "jump", "control": "<Gamepad>/buttonSouth" },
  { "action": "dodge", "control": "<Gamepad>/buttonEast", "triggers": [{ "tap": { "max": 0.2 } }] },
  { "action": "heavy", "control": "<Gamepad>/buttonEast", "triggers": [{ "hold": { "min": 0.4 } }] }
]}
```

- **Composites:** `dpad` (four buttons to a `vec2`), `axis` (two buttons to an `axis`), `modifier` (a key held with
  another, such as Shift+B).
- **Modifiers** (on a mapping or on the action): deadzone (axial or radial), negate, swizzle, scale, response curve,
  smooth, invert.
- **Triggers:** pressed, released, down, hold, holdAndRelease, tap, multiTap, pulse, chord (needs another action
  performed), combo (a timed sequence of actions). Each is explicit, implicit or a blocker, as in Enhanced Input.
- **Godot-level start:** `defineActions` may give default controls inline (`jump: button("<Keyboard>/space",
  "<Gamepad>/buttonSouth")`); these form the project's default context, so a small game never authors a context.

**Contexts are switched on by a component on a node.** `InputContext { context: assetRef, priority: i16, player: ref }`
can sit on any node. It is active while its node is active in the hierarchy.

- A vehicle prefab carries `InputContext(vehicle, priority 10)`; entering the vehicle enables that node and sets
  `player` to the driver. A pause menu carries the `menu` context. Nothing is pushed or popped by hand.
- Toggling a node's active flag applies at the next evaluation; adding or removing the component is a structural change
  applied at end of frame (ADR 0011).
- Contexts show in the hierarchy and inspector, so the live input debugger is the existing editor UI plus an overlay.

**Built-in systems evaluate it, in the `input` phase (0335).**

- **`engine.InputCompile`** flattens a player's active contexts and overrides (0337) into a table in typed arrays:
  control id to mappings, with modifier and trigger parameters. It recompiles only players marked changed.
- **`engine.InputEvaluate`**, per player:
  1. UI claims come first (ADR 0069's routing, unchanged); UI navigation becomes actions in a `ui` context (O7).
  2. Contexts run from highest priority to lowest. **Consumption:** a mapping that performs claims its controls, and
     lower contexts don't see them; within a context, a chord shadows its parts (Shift+B blocks B). An action may opt
     out with `consume: false`.
  3. Composites, then modifiers, then triggers, then the action's phase flags and value, written to the action-set
     component as the **frame** values.
  4. Phase changes are appended to the **`ActionEvents`** buffer (`{ player, set, action, phase, value }`).
- **`engine.InputTick`** (`fixedUpdate`, first): hands latched edges to the tick. Edges and pointer deltas collect in
  pending state; the first fixed step after them receives them, later steps of the same frame see them cleared, so a
  press during a frame with no fixed step is not lost.

**Reading.**

- **Behaviors (the facade):** `this.input.value("move")`, `this.input.performed("jump")`, `this.input.held("aim")`,
  `this.input.progress("heavy")`. Edge reads are phase-aware: in `fixedUpdate` they return the tick's flags, elsewhere
  the frame's.
- **Event style:** `this.input.on("heavy", "performed", fn)`, unsubscribed on disable, dispatched by the scripting
  system from `ActionEvents`, as `onCollisionEnter` is dispatched from `CollisionEvents`. There is no event bus (ADR
  0017).
- **Systems:** query the action-set component directly (`query: [Transform, PlayerActions, Mover]`); which node holds
  it is 0337's possession rule.
- Exactly two ways to receive input: polling and the `on` facade over a buffer.

## Alternatives considered

- **Actions as assets with generated TypeScript types (Unity's wrapper class, Unreal's assets).** Needs a code
  generator and a regenerate step; code-first `defineActions` is typed for free and matches `defineComponent`.
- **A context stack per player with push/pop (Unreal's subsystem).** Works, but hides state outside the scene; a
  component on a node makes contexts visible, prefab-able and tied to the node's lifetime.
- **Godot-style propagation through the node tree.** Simple, but ordering by tree position is fragile; explicit
  priorities say what wins.
- **Generic action records (one entity per action).** Flexible but many entities and string lookups; a typed component
  per action set is one row per player in typed arrays.

## Consequences

**Positive**
- Typed actions, Enhanced-Input-level triggers and contexts, and Godot's zero-setup start.
- All state is data: systems, prediction (0337) and the editor read it like any component.
- One consumption rule covers UI over gameplay, vehicles over walking, and chords over single keys.

**Negative / costs**
- A large evaluator (composites, eight modifiers, ten triggers) to build and test.
- Phase-aware edge reads are a rule users must know: the same call answers per tick in `fixedUpdate` and per frame
  elsewhere.
- Action sets are code, so adding an action means editing a script, not only an asset.

## Deprecates

Nothing. `Input.getKey` and the pointer getters stay as the raw layer.

## Build notes (2026-11-22)

- `<action>$phase` is an `i32`, not a `u8`: there are nine flags (held, pressed, released, started, ongoing, triggered, performed, completed, canceled).
- Instead of phase-aware read methods, the data itself is phase-correct: `engine.InputTick` writes the tick's values at the start of each fixed step and `engine.InputFrame` writes the frame's back before update, so every reader (systems, behaviors, the network stream) sees the right one.
- Chords and combos read the other action's state from the previous frame.

## Build notes (2026-11-22, second pass)

- Supersedes the last note above: chords, combos and custom triggers read the other action's state **this frame**. The compiled table orders actions in levels (an action after every action its triggers read); each level runs the priority pass with consumption, then settles its actions' flags. Controls claimed in a higher context stay hidden from lower contexts in later levels, but a mapping can't hide controls from an action settled in an earlier level. A dependency cycle is reported once (`console.warn`, naming the actions), and the action closing it reads the other as it was last frame.
- Triggers can be user-defined in v1 (answers the first open question): `defineTrigger(name, factory)` registers a namespaced trigger kind (`"game.doubleHold"`) that contexts and inline mappings name as `{ "game.doubleHold": params }`; the factory makes one instance per mapping (`{ type?, reads?, update(actuated, dt, others), pulsed? }`). Unknown names are reported with the known ones.
- `ActionEvent` gains `node` (where the action set changed: a local player's node, or a server's pawn) and `index` (the local player's index); `player` stays non-null. `on` matches events for its reader node as well as its player.

## Build notes: the editor (2026-11-22)

- **Input Debugger panel** (Window › Input Debugger, `src/editor/ui/InputDebuggerPanel.tsx`, on demand beside Network), Unreal's `showdebug enhancedinput`. While playing, for a chosen play World: its devices (kind, family, slot, paired player), players (last family, pawns), each player's active contexts by priority with the controls each consumed this frame, every action's value, phase flags (levels and edges) and elapsed time with the mapping that produced the value, a rebind in progress, the player's compile problems, and a log of `ActionEvents`, `DeviceEvents`, `PlayerJoined` / `PlayerLeft` and `RebindResults`. Read-only. It samples ten times a second; the log is recorded every frame by `engine.InputDebugLog` (lateUpdate), a built-in defined only while something watches, so it costs nothing otherwise.
- **Context asset editor**: `*.input.json` is a core asset kind (`inputContext`, New Input Context in the Assets panel, default folder `input/`), edited in the Inspector when selected and in the Input Context panel when opened. Action from the defined sets; composite and its parts; controls typed (with suggestions), picked by device, or captured with Bind (the next key, mouse button, or gamepad button/stick through the browser's Gamepad API; Escape cancels); modifiers and triggers with their parameters and trigger type; consume. Each mapping lists the evaluator's own problems for it. Edits are asset-document steps (undo, history), and saving reaches a playing World through `Assets.notifyChanged`.
- **Inspector:** `InputContext.context` is a dropdown (field choices, ADR 0152) of the project's `*.input.json` files and the contexts registered with `defineInputContext`.
- **Editor SDK** (`src/engine/editor/inputDebug.ts`): `inputState(world)`, `watchInput(world)`, `inputActionSets()`, `inputContextNames()`, `canonicalControlPath(path)`, `inputContextProblems(spec)`. They read `@internal` accessors of the input modules: `lastEvaluation` and `contextProblems` (added to `evaluate.ts`; the evaluator now remembers, per player, the mapping that gave each action its value and which context claimed each consumed control), `pendingRebind` (added to `rebind.ts`) and `registeredContexts` (`contexts.ts`).
- Not done: capture of SDL gamepads in the desktop editor's Bind (the webview's Gamepad API doesn't see them; type or pick the path instead), and a scene-view overlay of the debugger.
- **Later the same day, both done, plus hardware recording:** Bind reads the Engine's device snapshot through the editor SDK's `watchRawPresses(callback)` (presses from the snapshot's raw events, read by a snapshot poller at the start of the next frame; when no Engine steps, as in paused play, it takes snapshots itself every 50 ms after 200 ms without one), so SDL, WebHID and Gamepad API pads, touch and pen all bind, with or without a play World; the window's own key and pointer events still come first and are swallowed, Escape and a press on Cancel cancel. The debugger's **Overlay** draws a per-player block (last family, contexts by priority, action value bars and phase badges, last presses) in the game view's overlay layer beside Stats (`InputOverlay.tsx`), sharing one sampling with the panel (`inputDebugFeed.ts`). Its **Record** records the gamepad adapters' raw input (`src/engine/input/recording.ts`: one-line taps in `webHidGamepads.ts`, `tauriGamepads.ts` and `webGamepads.ts`; WebHID devices keep their setup exchange and feature replies so a later recording can replay them) into a `myco-input-recording` v1 file saved under `recordings/`; `src/engine/input/replay.ts` replays one through the same adapters (stand-in `HIDDevice`s, `applyNativeBatch`, a stand-in `navigator`), and fixtures go in `src/engine/tests/fixtures/input/` (docs/plans/2026-11-input-hardware-checklist.md, "Recording").

## Build notes: presses at low frame rates (2026-11-22)

A key, button or touch reads down in a frame it went down in, even when released before the frame ends (a tap isn't lost). Found by the browser spec `tests/e2e/ui-navigation.spec.ts` at the e2e frame cap (10 fps), two consequences were wrong: a key tapped in two consecutive frames (or released and pressed again between two frames) read held throughout, so the second press had no `released`, `pressed`, `performed` or `completed` edges; and a key released in the frame another went down read up, so Shift lifted in the frame Tab was tapped (Shift pressed a frame earlier) made Tab alone. The device snapshot (`devices.ts`) now applies its queue under two rules, for keys and pointer buttons, gamepad buttons and touchpad fingers, pen buttons and touches:

- **One press per control per frame, with a frame that reads it up between two.** A press of a control that read down this frame or last waits for the next frame. So every press shows as its own press, preceded by a frame that reads the control released: N presses inside one frame play out over the next 2N frames (one press, one release frame each), none merged or lost. `Input.getKey*`, actions and their triggers (`tap`, `multiTap` count each press), the UI's pointer routing and raw device events all see the same sequence.
- **Every press with what was held at that moment.** A key or button held when another went down this frame keeps reading held: its release waits for the next frame. So a chord's modifier released after its key was tapped still counts (the modifier composite and `Input.getKey("shift") && Input.getKeyDown("tab")` both see it), and the key never reads as pressed alone.
- An event that waits keeps its place: it and every event queued after it on that device kind are applied from the next frame, in order, so a chord's keys are never split. `releaseAll` (focus lost) also releases presses still waiting. The pointer's position isn't queued: a press that waits reads the pointer where it is when it's applied.
- A gamepad button pressed and released inside one frame reads fully pressed in that frame (its value is back to 0 by the frame's end); before, the evaluator read the value alone and lost the tap.
- The evaluator, its triggers and the tick latching are unchanged: they see a control actuated, then not, then actuated, so each press has its own edges; edges still collect until the next fixed step, so two presses with no fixed step between them reach that step as one.
- Behaviour change: a second press right after one (in the next frame, or the same one) reads one or two frames later than before, and a release in a frame where another key went down reads a frame later. Tests that clicked or pressed in back-to-back frames step a frame between.

## Open questions

- Whether triggers can be user-defined (a `defineTrigger` API) in v1 or later.
- Asset format details: one context per file or several.
- Gesture triggers for touch (0335's open question).

## References

- Unreal Enhanced Input: https://dev.epicgames.com/documentation/en-us/unreal-engine/enhanced-input-in-unreal-engine
- Unity Input System: https://docs.unity3d.com/Packages/com.unity.inputsystem@1.11/manual/index.html
- Godot InputEvent: https://docs.godotengine.org/en/stable/tutorials/inputs/inputevent.html
- G.U.I.D.E: https://github.com/godotneers/G.U.I.D.E
- `src/engine/core/data.ts`, `src/engine/core/systems.ts`
