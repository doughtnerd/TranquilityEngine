# Input: actions, contexts and players

Myco's input system (ADR [0335](../../decisions/0335-gamepads-come-from-a-native-sdl3-adapter-on-desktop-and-device-state-reaches-worlds-as-entities-in-an-input-phase.md), [0336](../../decisions/0336-input-actions-are-data-components-and-contexts-are-node-components-evaluated-by-input-systems.md), [0337](../../decisions/0337-input-players-are-entities-networked-actions-are-input-streams-and-rebinding-is-data.md)) turns keyboards, mice and gamepads into **actions**: "move", "jump", "aim". Your game reads the actions and never needs to know which key or button was pressed. `Input.getKey("space")` still works when you want raw keys.

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
- **Directions:** sticks, the d-pad, deltas and pen tilt have **+Y up**. Positions are canvas pixels, +Y down.
- **Dead zone:** sticks get a 0.15 dead zone unless a mapping gives its own.

**Control paths** name a position, not a vendor's label:
- `<Keyboard>/<key>`: the key as `KeyboardEvent.key` reports it, lower-case, plus `space`, `enter` and `escape`.
- Pointer: `<Pointer>/button0`…, `<Pointer>/delta`, `<Pointer>/scroll`, `<Pointer>/position`.
- Gamepad buttons: `<Gamepad>/buttonSouth` (A / Cross), `buttonEast`, `buttonWest`, `buttonNorth`, `leftShoulder`, `rightTrigger`, `start`, `dpadUp`, …
- Gamepad sticks and motion: `<Gamepad>/leftStick`, `rightStick`, `leftStickX`, `dpad`, `gyro`, `accel`.
- Touch: `<Touch>/primary` (the first finger down, pressed), `primaryPosition`, `primaryDelta`, `touch0`…`touch9` (each finger by slot), `touch0Position`…, `pinch` (how much two fingers spread this frame, in pixels), `swipe` (the stroke of a quick flick, in the frame the finger lifts: under 0.5 s and at least 40 px, +Y up), `count`. A long press is a `hold` trigger on `<Touch>/primary`; a two-finger tap is a `tap` trigger on `<Touch>/touch1`.
- Pen: `<Pen>/tip`, `barrel`, `eraser`, `pressure` (0..1), `position`, `delta`, `tilt` (-1..1), `twist`, `inRange`.

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

**The `ui` context:** the engine's own action set `engine.UIActions` (`navigate`, `submit`, `cancel`, `next`, `previous`) is bound in an engine context named `ui`, which is on for a player only while their World's UI has a focused element, at priority 1000 (`UI_CONTEXT_PRIORITY`), above your contexts. So a focused menu takes the arrows, d-pad, Enter, Space and Escape, and the game gets them back when nothing is focused. Players rebind it like any other context (`rebind("engine.UIActions:submit", { context: "ui" })`). See [Game UI](ui.md#keyboard-and-gamepad-navigation).

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
- `onePerDevice`: the keyboard and mouse are one player (with the touchscreen and pen), each gamepad another.
- `pressToJoin`: a device's first press makes it a new player.
- `manual`: you join players with `InputPlayers.join()` and `player.pair(device)`.

`input.maxPlayers` caps local players (default 4).

**Pawns:** put `ControlledBy { player: 0 }` on a pawn. Its player's actions are copied onto it every frame and tick, so systems query one node. An AI can drive the same controller by writing the action set on an NPC.

**Where things live:** players and devices are nodes under the World's `Input` node. The node types are:
- `InputPlayer` on players;
- `InputDevice` on devices, plus `GamepadState` on gamepads, `TouchState` on the touchscreen and `PenState` on the pen.

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

`prompt.parts` names each control's rebind part (`control`, `up`…, `modifier0`…) and `prompt.context` its context, the `part` and `context` options of `rebind`.

**Chords.** Rebinding a chord (`chordOf("<Keyboard>/shift", "<Keyboard>/b")`) takes the keys or buttons pressed together:

```ts
const r = await player.rebind("dash");       // hold Ctrl, press N, let go: dash is now Ctrl+N
r.chord;                                     // ["<Keyboard>/control", "<Keyboard>/n"]: modifiers first, then the main control
player.prompt("dash", "keyboard")!.label;    // "Ctrl+N"
await player.rebind("dash", { part: "modifier0" });  // only the modifier: the next key pressed
await player.rebind("dash", { chord: false });       // only the main key, keeping the modifier
await player.rebind("jump", { chord: true });        // a single control, captured the same way
```

- A chord rebind finishes when the player lets go of a control pressed during it. The chord is everything of that device group held at that moment, plus the Shift, Ctrl, Alt and Meta keys held when it started.
- The main control is the last one pressed. On the keyboard it's the last key that isn't Shift, Ctrl, Alt or Meta. The rest become `modifier0`, `modifier1`… in the order they were pressed.
- A control already down when the rebind started (the Enter or south button that opened it) isn't part of the chord, and letting go of it doesn't finish it.
- `chord` is the default for a chord's main control. It works on a single control and on a chord's `control` part; any other part throws.
- A chord conflicts with mappings of the same controls only. Shift+B doesn't conflict with a plain B mapping, because the chord claims its key.
- **A chord can change size.** Holding a different number of modifiers from the mapping's (a lone key for Shift+B, or Ctrl+Shift+B) replaces the mapping: the old one is removed and the new chord added, keeping the old mapping's modifiers, triggers and `consume`. A single control rebound with `chord: true` becomes a chord the same way.

Every canceled result has a `reason`: `cancel` (the cancel control), `timeout` or `replaced` (another rebind for the player started).

**Adding and unbinding.** A player can add a binding where an action has none for a device, or a second one beside it, and remove one:

```ts
await player.rebind("jump", { add: true, device: "gamepad" }); // the next button becomes a new mapping of jump
await player.rebind("fire", { add: true, device: "keyboard" }); // a second key for fire
player.unbind("bomb", { device: "keyboard" });                  // true if a mapping was removed
player.unbind("bomb", { device: "gamepad", context: "onFoot" }); // only that context's
player.resetBindings();                                          // every change undone
```

- An added mapping is a single control (with `chord: true`, the controls pressed together as a chord). It goes into the context that already holds the action's mappings (the first by priority), or the default context if none does; `context` picks another.
- `unbind` removes the device group's mapping for the action, the first by priority that has one. A mapping the player added is deleted; one from a context is recorded as removed, so `resetBindings` brings it back.
- Prompts and conflict checks see added mappings and skip removed ones. Rebinding an action with no mapping for that device throws; add one instead.

**What's saved.** `saveBindings` writes `input.<profile>.json` in format 2:

```json
{
  "format": 2,
  "overrides": { "onFoot/1/jump/control": "<Keyboard>/k" },
  "additions": { "onFoot": [{ "action": "game.Player:fire", "control": "<Gamepad>/rightTrigger" }] },
  "removals": { "default": [{ "index": 5, "action": "game.Player:bomb" }] },
  "accessibility": { "invertY": ["look"] }
}
```

- `overrides` replace one control: `"<context>/<mapping index>/<action>/<part>"`. `additions` are whole mappings, in a context asset's mapping shape; an added mapping's index is the context's mapping count plus its position among the additions. `removals` name a mapping of the context by index and action.
- Overrides and removals name their mapping's action. If a game update moves mappings so that the index no longer holds that action, the saved change is dropped, with one warning per profile and context: `Saved binding for "jump" in "onFoot" no longer matches the context; it was reset.`
- A format 1 file (from before adding and unbinding) still loads: each override gets the action of the mapping now at its index, and the next `saveBindings` writes format 2.

### Glyphs

The engine draws a glyph for every icon key a prompt gives: keycaps with the key's label, the mouse with the button lit, and each gamepad family's buttons, shoulders, triggers, sticks, d-pad, menu buttons, touchpad and gyro (PlayStation's shapes, Xbox's coloured letters, Switch's letters, positions for other pads). They're plain shapes and letters, built on first use, so nothing needs shipping with a game.

```ts
const prompt = this.input.prompt("jump")!;         // follows the device the player last used
const glyph = InputGlyphs.get(prompt.icons[0])!;   // or InputGlyphs.of(prompt) for every control
(view.query("#jump-hint")!.component as UIImage).image = glyph.asset; // "asset:@myco/glyphs/xbox/buttonSouth.svg"
img.src = glyph.url;                               // an HTML <img>; glyph.svg is the markup
```

`glyph.asset` works wherever a texture asset does: a component's `<img src="asset:@myco/glyphs/keyboard/space.svg">` (or a prop, `<img src={jumpGlyph}>` with `view.props.jumpGlyph = glyph.asset`), an image element's `image` field, sprites. Glyphs are 64 pixels high; keycaps with long labels are wider (`glyph.width`).

### A rebinding screen

**UIControlMapper** (Add Component › UI) is a ready-made controls screen, drawn by a built-in Svelte component (`@myco/ui/ControlMapper.svelte`) on a `UIView` it makes as its node's child. Put it on any node and it draws on a screen canvas of its own; under a game's canvas, its canvas takes that canvas's settings and draws just above it:

- One row per action (`actions`: a comma-separated list, empty for every action but the engine's UI actions), one per part for a d-pad or axis composite ("Move Up"…), with a **Keyboard** and a **Gamepad** cell. Each shows the binding's glyphs and label; the gamepad column follows the pad the player last used.
- Every cell and button is a focusable `UIButton`, so the game UI's [keyboard and gamepad navigation](ui.md#keyboard-and-gamepad-navigation) drives the screen: the arrow keys, d-pad or left stick move focus, and Enter, Space or the south button press the focused button. The screen takes focus when it appears, so a d-pad player can start without clicking. The focused button has an `accentColor` border, after mouse use too.
- Click a cell (or press Enter or the south button on it), then press the new key or button. While it waits, presses don't move focus. **Escape** cancels; after `timeout` seconds (default 10) it gives up.
- An empty cell ("—") on an action's row adds a binding for that device the same way (`rebind` with `add: true`).
- **Delete** or **Backspace** on the focused cell unbinds it, as does the **Unbind** button (which acts on the binding cell last focused). Unbinding one part of a d-pad or axis removes the device's whole binding.
- With no canvas above it, the mapper makes a screen canvas that takes focus when it appears, is driven only by the mapper's `player`, and keeps focus in the screen when `modal` is on. Inside a document's canvas, it focuses its first cell when it appears, unless something on that canvas already has focus; set that canvas's `modal` (`<Canvas modal>`) to keep focus in it.
- A chord is one cell ("Shift + B", with both glyphs). Its rebind takes the keys or buttons held together: hold them, then let go. A chord with a different number of modifiers replaces the binding.
- A conflict is shown in the status line ("B is also bound to Bomb.") and conflicting cells turn `warningColor`.
- **Reset to defaults** calls `resetBindings`; **Save** calls `saveBindings(profile)`. The button row's words are `text.unbind`, `text.reset` and `text.save`.

```ts
const mapper = menu.addComponent(UIControlMapper, { player: 0, actions: "move, jump, fire" });
mapper.actionLabels = { fire: "Shoot" };
mapper.text.save = "Speichern";                     // every word it shows is in `text`
```

**Accessibility section.** Turn on `showAccessibility` for a section below the bindings that edits `player.accessibility`:

| Row | Shown for | Control |
|---|---|---|
| Invert Y | each action in `invertYActions` | On/Off |
| Sensitivity | each action in `sensitivityActions` | − value + (0.1 to 5, steps of 0.1) |
| Press to toggle (hold-to-toggle) | each action in `holdToToggleActions` | On/Off |
| Repeat held buttons | always | On/Off. When on, it repeats the actions in `repeatActions`, or every button action if that's empty. |
| Repeat delay, repeat interval | always | − value + (seconds). They work only while repeat is on. |
| Stick dead zone | always | − value + (0 to 90%) |

```ts
const mapper = menu.addComponent(UIControlMapper, {
  actions: "move, look, jump", showAccessibility: true,
  invertYActions: "look", sensitivityActions: "look", holdToToggleActions: "aim",
});
```

The toggles and a stepper's − and + are focusable buttons like the cells: up and down go row by row, left and right between − and +, and Enter or the south button toggles or steps. Changes apply at once, **Save** writes them with the bindings, and **Reset to defaults** leaves them alone. Their words are in `text` too (`accessibility`, `invertY`, `on`, `off`, `seconds`…).

Colours, `fontSize`, `glyphSize` and `width` are fields. Scripts read:
- `rows`: each cell's action, label, icons, button and whether it's a `chord`;
- `settings`: each accessibility row's label, value and buttons;
- `rebinding`, `status`, `conflicts` and `focusedCell` (the focused binding cell, or null; focus a cell by setting its `button.focused`).

Load saved bindings with `player.loadBindings()` when the game starts.

## Multiplayer

`defineActions(id, spec, { networked: true })` also makes the set an input stream (ADR 0033).

**Server:** give the pawn the set's component (`pawn.addData(PlayerActions)`). Each tick the server fills it with the owning client's actions, so gameplay code reads the same component online and offline. `this.input.on(...)` works on server pawns too: the tick's started, performed, completed and canceled become `ActionEvents` with the pawn as `node` and the client's connection node as `player`. A tick whose input was lost repeats the last values, not the presses.

**Local co-op online:** a client sends every local player's actions over its one connection. On the server, add `ConnectionPlayer { index: 1 }` to the pawn the client's second player drives (no `ConnectionPlayer` means player 0). The same works for plain streams: `Move.write(values, 1)` on the client, `Move.of(connection, 1)` on the server.

**Client:** prediction replays each tick with that tick's actions.

**Quantization:** analog values travel as 32-bit floats. Quantize them with `encoding: { move: { quantize: 1 / 127 } }`. The client rounds the values before predicting, so client and server agree.

## Devices

- **Desktop:** gamepads come from SDL3 inside the Tauri app, in the editor and in exported games. That includes rumble, trigger rumble, light bars, gyro (`player.setSensors(true)`), touchpads, batteries and DualSense adaptive triggers (`player.setTriggerEffect(...)`).
- **Touchpads** (DualSense, DualShock 4): `<Gamepad>/touchpad0` and `<Gamepad>/touchpad1` are two fingers touching, and `<Gamepad>/touchpad0Position` and `touchpad1Position` are where they are. Positions run 0..1 across the touchpad from its top-left corner, with +Y **down** like other positions, and read 0, 0 while that finger is up. Pressing the touchpad in is still `touchpadPress`.

  ```ts
  defineActions("game.Menu", { cursor: vec2("<Gamepad>/touchpad0Position"), touching: button("<Gamepad>/touchpad0") });
  ```
- **Battery:** `player.battery` is `{ level, charging }`, with `level` 0..1, for the player's gamepad with the lowest charge. It is `null` when no gamepad reports one: a wired pad without a battery, or the browser's Gamepad API, which can't tell. Desktop builds and WebHID pads in Chrome can.
- **Web:** builds read the browser's Gamepad API. The engine applies the SDL controller database to pads the browser doesn't map, and detects each pad's family.
- **Touch and pen:** a touchscreen and a pen are devices of their own, which appear when first used. The first finger down and the pen also act as the mouse, so `Input.getMouseButton(0)` and UI buttons work by touch. A touch or pen press on a UI button goes to the UI, not the game.
- **Your own devices:** `Input.inject` reports device events as an adapter does, for on-screen controls, automation and tests.

## In the editor

- **The Input dialog** (File › Input…, or double-click an `.actions.json` or `.input.json` file) shows every action set and context. The list on the left has the sets (sets from scripts are read-only) and the contexts, A to Z; **+** adds one and leaves its name selected for typing. Right-click an entry, or press F2, to rename, duplicate, copy its id or delete it (`default` and sets from scripts can't be renamed or deleted).
- **New action sets:** **New Action Set** (the Assets panel's New… menu, or + in the dialog) writes an `*.actions.json` file with one button action and adds it to `project.json`'s `input.actionSets`.
- **An action set** lists its actions with their type and consume setting, and where each is mapped; click a context to go to the mapping. An action nothing maps is flagged, with **Map it in default**. Changing an action's type converts its controls in every context (a d-pad becomes an axis by keeping left and right, an axis becomes a d-pad, either becomes a single control for a button) and says what changed. **Networking** turns on sending the set to the server and sets the resent ticks and each analog action's precision, with the upload each costs.
- **A context** shows its name, the nodes whose InputContext turns it on, and its mappings. For each mapping, pick:
  - the action, from a searchable list grouped by set. Typing a name no set has offers **Create "name" in** each of your sets, or **New set…**: the action is made with a type that suits the mapping's control.
  - its controls: one control, a d-pad, an axis or a chord. Type a path, pick one from the list by device, or click **Bind** and press it: a key, a mouse button, a touch, a pen button, or a gamepad button or stick. Bind reads the engine's own devices, so every gamepad works, including the desktop editor's (SDL) and controllers opened over WebHID, while editing or playing. Escape, or clicking **Cancel**, cancels. A control that doesn't suit the action's type (a key as a vec2's only control) is flagged.
  - its modifiers, its triggers and their type, and whether it consumes its controls.

  Under each mapping are the problems Play would report: an unknown action, a bad control path, bad parameters. `default` also shows the controls scripts give in `defineActions`, read-only.
- **Undo** in the dialog covers every file it edits, as one history with branches (Undo, Redo and History in its header, or Ctrl+Z / Ctrl+Shift+Z). Edits are saved at once; while the game runs, the footer says **Live**: a running game picks up the saved files.
- **InputContext's `context` field** lists the project's `*.input.json` files and the contexts your scripts register.
- **Input Debugger panel** (Window › Input Debugger): while playing, pick a World to see:
  - its devices and players;
  - each player's active contexts by priority, and the controls each one consumed;
  - every action's value, phase flags and hold time, and the mapping that produced it;
  - rebinds in progress;
  - a log of recent action, device, join and rebind events.
- **Overlay** (in the Input Debugger's bar): while playing, a compact block per player over the game view, opposite Stats: the player and the device family it last used, its active contexts by priority, each action's value bar and phase badges, and its last few presses. It follows the World the debugger shows. Its × or the toggle hides it; the editor remembers the setting.
- **Record** (in the Input Debugger's bar, while editing or playing): records your controllers' raw input as it reaches the engine (WebHID reports, SDL batches in the desktop editor, Gamepad API readings) until **Stop**, which saves it as `recordings/input-<date>-<time>.input-recording.json` (downloaded from a read-only project). A test can replay the file through the same adapter code without the controller: see "Recording" in [the hardware checklist](../../plans/2026-11-input-hardware-checklist.md).

## Enhanced gamepads in Chrome (WebHID)

In Chrome, Edge and other Chromium browsers on desktop, PlayStation controllers, the Switch Pro Controller and Joy-Cons can do more on the web than the Gamepad API allows. The engine opens them as HID devices instead.

**What it adds:**
- gyro and accelerometer (`<Gamepad>/gyro`, `<Gamepad>/accel`, after `player.setSensors(true)`);
- adaptive triggers on DualSense: `player.rumbleTriggers(...)`, and `player.setTriggerEffect("right", { mode: "weapon", start: 0.3, end: 0.6, strength: 0.8 })` (also `resistance`, `vibration` and `off`);
- light bars (`player.setLight(r, g, b)`) and player lights;
- the touchpad click (`touchpadPress`) and the mute or capture button (`misc1`);
- touchpad finger positions (two fingers) on DualSense and DualShock 4, and the battery level and charging state on those and on Switch controllers, reported to the input end (`gamepadTouch`, `gamepadBattery`);
- HD rumble on Switch controllers, re-sent while it plays so it doesn't cut out.

**Controllers:** DualSense and DualSense Edge, DualShock 4 (and Sony's USB wireless adapter), and the Switch Pro Controller, over USB or Bluetooth; Joy-Cons over Bluetooth (not in the USB charging grip).

**Joy-Cons:** one Joy-Con on its own is a small pad held sideways: the face buttons by where they sit when held that way (the bottom one is `buttonSouth`), SL and SR as the shoulders, the stick turned to match, as SDL does. A left and a right open at the same time join into one pad, "Joy-Con (L/R)", laid out like a Pro Controller with SL and SR as paddles; its motion is the right Joy-Con's, and rumble's low band plays on the left and its high band on the right. If one of them goes, the other carries on as a small pad. There's no setting to keep a pair apart.

**The permission click:** the browser shows a controller only after the player picks it in its chooser, and the chooser opens only from a click or key press. Call `Input.requestHidGamepads()` from one, for example behind an "Enable full controller features" button. It resolves with how many controllers were opened. Controllers picked once reopen on their own on later visits, and when they're plugged back in.

```ts
enhanceButton.addEventListener("click", async () => {
  const opened = await Input.requestHidGamepads();
});
```

Desktop builds already have all of this through SDL, adaptive triggers included.

**Fallback:** until a controller is picked, or if it fails or is unplugged, the Gamepad API reports it as before, so the game never sees it twice. Firefox and Safari have no WebHID: `requestHidGamepads()` resolves `0` there, and in desktop builds, where SDL already gives all of this.
