# Input: actions, contexts and players

Myco's input system (ADR [0335](../decisions/0335-gamepads-come-from-a-native-sdl3-adapter-on-desktop-and-device-state-reaches-worlds-as-entities-in-an-input-phase.md), [0336](../decisions/0336-input-actions-are-data-components-and-contexts-are-node-components-evaluated-by-input-systems.md), [0337](../decisions/0337-input-players-are-entities-networked-actions-are-input-streams-and-rebinding-is-data.md)) turns keyboards, mice and gamepads into **actions**: "move", "jump", "aim". Your game reads the actions and never needs to know which key or button was pressed. `Input.getKey("space")` still works when you want raw keys.

## Declare actions

```ts
import { axis, axisOf, button, chordOf, defineActions, dpad, vec2 } from "myco";

export const PlayerActions = defineActions("game.PlayerActions", {
  move:  vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d"), "<Gamepad>/leftStick"),
  look:  vec2("<Pointer>/delta", "<Gamepad>/rightStick"),
  jump:  button("<Keyboard>/space", "<Gamepad>/buttonSouth"),
  heavy: button({ control: "<Gamepad>/buttonEast", triggers: [{ hold: { min: 0.4 } }] }),
  dash:  button(chordOf("<Keyboard>/shift", "<Keyboard>/b")),
  steer: axis(axisOf("<Keyboard>/a", "<Keyboard>/d"), "<Gamepad>/leftStickX"),
});
```

- **Action types:** `button` (0..1, pressed past 0.5), `axis` (-1..1), `vec2`, `vec3`.
- **Default controls:** the controls you list are the action's defaults. Together they make the **default context**, which is always on. A small game needs nothing else.
- **Directions:** sticks, the d-pad and pointer delta have **+Y up**.
- **Dead zone:** sticks get a 0.15 dead zone unless a mapping gives its own.

**Control paths** name a position, not a vendor's label:
- `<Keyboard>/<key>`: the key as `KeyboardEvent.key` reports it, lower-case, plus `space`, `enter` and `escape`.
- Pointer: `<Pointer>/button0`…, `<Pointer>/delta`, `<Pointer>/scroll`, `<Pointer>/position`.
- Gamepad buttons: `<Gamepad>/buttonSouth` (A / Cross), `buttonEast`, `buttonWest`, `buttonNorth`, `leftShoulder`, `rightTrigger`, `start`, `dpadUp`, …
- Gamepad sticks and motion: `<Gamepad>/leftStick`, `rightStick`, `leftStickX`, `dpad`, `gyro`, `accel`.

## Read them

In a behavior, `this.input` is the input of the player controlling the node:

```ts
update() {
  const move = this.input.vector2("move");
  if (this.input.performed("jump")) this.jump();
  this.charge = this.input.elapsed("heavy");
}
onEnable() {
  this.input.on("heavy", "performed", () => this.heavyAttack()); // dropped when the behavior is disabled
}
```

**Reading methods:**
- `value`, `vector2`, `vector3`: the action's value.
- `held`, `pressed`, `released`: whether it's actuated.
- `started`, `ongoing`, `triggered`, `performed`, `completed`, `canceled`: the trigger phases.
- `elapsed`: seconds held.

**One tick or one frame.** Reads are right for the phase you call them in:
- In `fixedUpdate`, `performed("jump")` is true in exactly one tick, even if the press happened in a frame with no fixed step.
- In `update`, it's true in exactly one frame.

**In systems**, query the action set like any data component:

```ts
defineSystem({ name: "game.Move", phase: "fixedUpdate", query: [Transform, PlayerActions], run(rows) {
  for (const r of rows) r.transform.position.x += r.playerActions.vector2("move").x * 0.1;
} });
```

## Contexts: vehicles, menus, modes

A context is a set of mappings. Write it as a `*.input.json` asset, or register it in code:

```json
{ "name": "vehicle", "mappings": [
  { "action": "honk", "control": "<Keyboard>/space" },
  { "action": "steer", "control": "<Gamepad>/leftStickX", "modifiers": [{ "curve": { "exponent": 2 } }] }
] }
```

**Switching it on:** add an **InputContext** component (Add Component › Input) to a node, with `context` set to the asset path or registered name and a `priority`. The context is on while the node is active.

**Priority and consumption:** higher priorities run first. A mapping there that's active takes its controls, so lower contexts don't see them. In the vehicle, Space honks instead of jumping.

**Chords:** inside one context, Shift+B takes B, so B alone doesn't also fire.

**Modifiers:**
- `deadzone`: `min`, `max`, axial or radial
- `negate`, `swizzle`, `scale`
- `curve`: an exponent
- `smooth`: a rate

**Triggers:**
- `down`, `pressed`, `released`
- `hold`: `min`, optionally `oneShot`
- `holdAndRelease`, `tap`, `multiTap`, `pulse`
- `chord`: another action must be triggered
- `combo`: a timed sequence of actions

Each trigger is explicit, implicit or a blocker, as in Unreal's Enhanced Input.

**Chords and combos see the same frame.** An action a chord or combo reads is worked out first, so Shift+F fires in the frame both keys go down. Actions that read each other in a circle get a warning in the console.

**Your own triggers:** register a trigger kind with a namespaced name, then use it in any context or inline mapping:

```ts
import { defineTrigger } from "myco";

defineTrigger<{ min: number }>("game.doubleHold", ({ min }) => {
  let held = 0;
  return {
    update(actuated, dt, others) {   // return 0 none, 1 ongoing, 2 triggered (or true / false)
      held = actuated ? held + dt : 0;
      return held >= min && others.triggered("guard") ? 2 : actuated ? 1 : 0;
    },
    reads: ["guard"],                // actions it asks about: worked out before this one
  };
});
```

```json
{ "action": "parry", "control": "<Gamepad>/buttonEast", "triggers": [{ "game.doubleHold": { "min": 0.3 } }] }
```

Each mapping gets its own trigger from the function, so it can keep state. An unknown trigger name is reported with the names that exist.

## Players and pawns

**Joining:** `project.json` `input.join` decides how players join:
- `single` (default): player 0 has every device.
- `onePerDevice`: the keyboard and mouse are one player, each gamepad another.
- `pressToJoin`: a device's first press makes it a new player.
- `manual`: you join players with `InputPlayers.join()` and `player.pair(device)`.

`input.maxPlayers` caps local players (default 4).

**Pawns:** put `ControlledBy { player: 0 }` on a pawn. Its player's actions are copied onto it every frame and tick, so systems query one node. An AI can drive the same controller by writing the action set on an NPC.

**Where things live:** players and devices are nodes under the World's `Input` node. The node types are:
- `InputPlayer` on players;
- `InputDevice` on devices, plus `GamepadState` on gamepads.

**Buffers:**
- `DeviceEvents`: raw presses this frame.
- `ActionEvents`: phase changes this frame.
- `PlayerJoined` and `PlayerLeft`.

## Rebinding, prompts, accessibility

```ts
const player = InputPlayers.get(0)!;
const result = await player.rebind("jump", { device: "keyboard" }); // the next key pressed (Escape cancels)
if (result.conflicts.length) showWarning(result.conflicts); // checked against every context the player could have, active or not
await player.saveBindings();                 // settings storage, input.player0.json
player.prompt("jump");                       // { label: "A" | "Cross" | "Space", icons: ["xbox/buttonSouth"], … } for the device last used
player.accessibility = { holdToToggle: ["aim"], invertY: ["look"], sensitivity: { look: 1.5 }, deadzone: 0.2,
  repeat: { delay: 0.4, interval: 0.1, actions: ["menuDown", "menuUp"] } }; // held buttons perform again, as key repeat
player.rumble(0.3, 0.8, 200);
```

## Multiplayer

`defineActions(id, spec, { networked: true })` also makes the set an input stream (ADR 0033).

**Server:** give the pawn the set's component (`pawn.addData(PlayerActions)`). Each tick the server fills it with the owning client's actions, so gameplay code reads the same component online and offline. `this.input.on(...)` works on server pawns too: the tick's started, performed, completed and canceled become `ActionEvents` with the pawn as `node` and the client's connection node as `player`. A tick whose input was lost repeats the last values, not the presses.

**Local co-op online:** a client sends every local player's actions over its one connection. On the server, add `ConnectionPlayer { index: 1 }` to the pawn the client's second player drives (no `ConnectionPlayer` means player 0). The same works for plain streams: `Move.write(values, 1)` on the client, `Move.of(connection, 1)` on the server.

**Client:** prediction replays each tick with that tick's actions.

**Quantization:** analog values travel as 32-bit floats. Quantize them with `encoding: { move: { quantize: 1 / 127 } }`. The client rounds the values before predicting, so client and server agree.

## Devices

- **Desktop:** gamepads come from SDL3 inside the Tauri app, in the editor and in exported games. That includes rumble, trigger rumble, light bars and gyro (`player.setSensors(true)`).
- **Web:** builds read the browser's Gamepad API. The engine applies the SDL controller database to pads the browser doesn't map, and detects each pad's family.
- **Your own devices:** `Input.inject` reports device events as an adapter does, for on-screen controls, automation and tests.
