# 0335. Gamepads come from a native SDL3 adapter on desktop, device state reaches Worlds as entities in an `input` phase

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0011, 0017, 0032, 0041, 0065, 0069, 0238, 0310, 0336, 0337

## Context

Input today is a keyboard and pointer snapshot (`input/devices.ts`, ADR 0310) fed by a DOM adapter
(`input/domDevices.ts`) and read through Unity-legacy-style getters (`Input.getKey`, `mouseDelta`). There is no gamepad,
touch or pen support, and the snapshot lives outside every World: a World without input (`World._takesInput`, ADR 0032)
is gated by a flag the getters check, not by the ECS.

This record is the device layer of a new input system, designed after comparing Unity's Input System, Unreal's Enhanced
Input, Godot's InputMap and their best plugins (Rewired, Common UI, G.U.I.D.E, Input Helper). Actions and contexts are
[0336](0336-input-actions-are-data-components-and-contexts-are-node-components-evaluated-by-input-systems.md); players,
netcode and rebinding are [0337](0337-input-players-are-entities-networked-actions-are-input-streams-and-rebinding-is-data.md).
The owner's constraint: the system is built on the engine's ECS stack.

Gamepad sources considered:

- **Browser Gamepad API.** Support varies by WebView: WebView2 (Windows) is decent; WKWebView (macOS) identifies fewer
  controllers; WebKitGTK (Linux) depends on its version and its libmanette build. No HD rumble, trigger effects, gyro,
  touchpad, light bar, or reliable names.
- **SDL3 or gilrs compiled to wasm.** Both libraries' web backends *are* the Gamepad API (SDL's `emscripten` joystick
  driver; gilrs's wasm backend). Wasm cannot reach HID devices, so SDL's HIDAPI drivers (gyro, DualSense, Switch Pro)
  don't work in a browser. A wasm build adds megabytes and gives the same data.
- **Native SDL3 in the Tauri process.** The controller database Godot and Steam use, gyro and accelerometer, HD rumble,
  DualSense and Switch Pro features, hot-plug. About 2–3 MB and a C build dependency.
- **Native gilrs.** Pure Rust, light, same SDL mapping database; basic force feedback only, no gyro, touchpad or trigger
  effects.
- **WebHID.** Direct HID access to DualSense, DualShock 4 and Switch Pro: Chromium desktop only, a permission prompt
  per device after a click, no Xbox over USB (not HID), and our own report parsers per family.

## Decision

**Desktop gamepads are native SDL3.**

- `src-tauri` gains a gamepad module using SDL3 through Rust bindings, initialised for the gamepad, sensor and haptic
  subsystems only (no windowing, audio or events loop beyond what those need). A Rust thread polls controllers and
  streams batched state changes to the page over a **Tauri channel**; output (rumble, trigger effects, LEDs) goes back
  as commands. IPC adds about a millisecond, under a 16 ms frame.
- Under Tauri this is the **only** gamepad source; the browser Gamepad API is never read there.
- Exported desktop games (ADR 0041's generated Tauri project) include the same module, so a game's gamepads behave the
  same in the editor and the exported app.

**Web gamepads use the Gamepad API for raw state only.** The DOM adapter reads raw axes and buttons and nothing else.
Everything above that is the engine's and shared with desktop.

**Mapping is one engine crate.** `native/input/` is a Rust crate (beside `native/nav/` and `native/audio/`): the SDL
controller database matched by vendor and product id, device-family detection (xbox, playstation, switch, generic),
deadzones and calibration, and the control-path table. It is linked into `src-tauri` natively and compiled to wasm by
`npm run build:input` into `src/engine/input/wasm/`, committed like nav's output so the engine builds without Rust.
On desktop SDL already maps controllers; the crate still owns families, control paths and calibration so both platforms
name controls the same way.

**Control paths.** Every control has a path: `<Keyboard>/space`, `<Pointer>/delta`, `<Pointer>/button0`,
`<Gamepad>/buttonSouth`, `<Gamepad>/leftStick`, `<Gamepad>/leftTrigger`, `<Gamepad>/gyro`, `<Gamepad>/touchpad`,
`<Touch>/primary`. Paths name a control's position, not a vendor label. A control a device lacks (gyro on the web)
simply doesn't exist on that device. Paths are interned to `u16` control ids by a control registry.

**The device snapshot grows.** `devices.ts` keeps its shape (input end, snapshot, routing, reading end) and gains:

- gamepads (axes `f32`, buttons as held/down/up bitmasks), touch and pen;
- device connect and disconnect, each device with a `kind`, `family`, `slot` and stable id;
- a timestamp on each queued event, so triggers (0336) measure time exactly;
- `DeviceEventSink` methods for the new devices, implemented by the DOM adapter and the Tauri adapter.

The snapshot stays Engine-level (one set of hardware shared by every World) and keeps UI-first routing (ADR 0069).

**Device state reaches Worlds as ECS data.**

- **A per-World `input` phase** runs right after the Engine's snapshot (ADR 0011 step 2) and before `start()` and the
  fixed steps. It amends 0011: the phases become `input`, `fixedUpdate`, `update`, `lateUpdate`. Built-in input systems
  run there; user systems may too (custom triggers, AI or replays writing actions).
- **`engine.InputDevices`** (`input` phase) mirrors the snapshot into each World that takes local input. Each device is
  an entity with `InputDevice { kind, family, slot, connected }` and, for gamepads, `GamepadState` (axes `f32`, button
  bitmasks `u32`). Connecting spawns the entity; disconnecting sets `connected = 0` for one frame, then destroys it.
- **`DeviceEvents`** is a buffer of `{ device, control, value, time }`, cleared at end of frame, for rebinding,
  "press any button", and recording.
- **Gating is scheduling.** The `World._takesInput` check in the getters is replaced by the device system not running
  in that World: a server World has no device entities. The view allocator (ADR 0238) decides which Worlds get which
  devices, which covers the editor's tiled play views.
- `Input.getKey` and the pointer getters stay as the raw layer, now reading the World's mirrored devices.

**Later, not v1: WebHID enhanced mode** in Chromium for DualSense, DualShock 4 and Switch Pro (gyro, touchpad, trigger
effects, LEDs), as another adapter with the Gamepad API as fallback.

## Alternatives considered

- **Browser Gamepad API everywhere.** One code path, but weak on Linux and macOS WebViews and without the features
  Rewired-level games need (gyro, HD rumble, trigger effects, correct names).
- **SDL3 or gilrs as wasm.** Wraps the Gamepad API; adds download size and no capability.
- **gilrs natively.** Lighter and pure Rust, but no gyro, touchpad or trigger effects; we would outgrow it.
- **Keep devices outside the ECS.** Less work now, but players, contexts and netcode (0336, 0337) would then join ECS
  state to a global, and World gating stays a special flag.
- **Evaluate input inside `fixedUpdate` instead of a new phase.** `update` would see stale action state on frames that
  run no fixed step.

## Consequences

**Positive**
- Desktop games get the full controller feature set; the web gets the best each browser allows, through the same
  mapping and the same control paths.
- Device state is ordinary ECS data: systems query it, the editor can show it, World gating needs no flag.
- The `input` phase gives AI, replays and tests one place to write input before the simulation reads it.

**Negative / costs**
- SDL3 is a C dependency in `src-tauri` and every exported desktop app (about 2–3 MB), and needs a C toolchain in CI on
  each platform.
- A new Rust crate with committed wasm output (`native/input/`), like nav's.
- An amendment to ADR 0011's phase list; the scheduler and editor system lists learn a fourth phase.
- Web and desktop differ in which controls exist (gyro, trigger effects); games must treat them as optional.

## Deprecates

- The `World._takesInput` checks inside `Input`'s getters (replaced by the device system's World filter).
- Nothing else: `Input`'s getters and the DOM adapter stay, extended.

## Build notes (2026-11-22)

- `Input`'s getters keep the `World._takesInput` check: the editor's World reads raw input for its tools, but gets no device entities. Device entities follow the stricter filter (not editor or server Worlds).
- `Input.inject` is the public input end (`DeviceEventSink`): virtual devices, automation, tests.
- Touch and pen aren't devices of their own yet; touches arrive as the pointer.
- The mapping table can't express the ~40 SDL database entries that drive a stick from two buttons.

## Build notes (2026-11-22, touch, pen and composed axes)

These supersede the last two notes above.

- **Touch and pen are devices.** The DOM adapter reads `pointerType`. It reports fingers by `pointerId` (`touchStart`, `touchMove`, `touchEnd`) and the pen's position, pressure, tilt, twist and buttons (`penAt`, `penButtonDown`/`Up`, `penLeave`). These sink methods are on `DeviceEventSink` and so on `Input.inject`.
- **The primary finger and the pen are still the pointer.** The DOM adapter reports the primary one (`isPrimary`) as the pointer too, as browsers emulate the mouse, so `Input.getMouseButton`, `mousePosition` and UI routing work by touch. A second finger no longer moves the pointer. Injected touches don't move the pointer.
- **Routing.** A primary touch or pen button pressed in a frame the pointer is over claimed UI is the UI's until released: it is missing from the device state and `DeviceEvents`. Other fingers aren't routed, because routers only see the pointer.
- **Device nodes.** `Touchscreen` (`DeviceKind.touch`, family `touch`, `TouchState`) and `Pen` (`DeviceKind.pen`, family `pen`, `PenState`) appear the first time an adapter reports them. Their device ids are -3 and -4.
- **Fingers take slots 0–9.** A finger takes the lowest free slot and keeps it until it lifts. The primary touch is bit 10 of the touch bitmasks.
- **Control paths.** `<Touch>/primary`, `primaryPosition`, `primaryDelta`, `touch0`…`touch9`, `touch0Position`…, `pinch`, `swipe`, `count`; `<Pen>/tip`, `barrel`, `eraser`, `pressure`, `position`, `delta`, `tilt`, `twist`, `inRange`.
- **Joining.** Touch and pen join the keyboard+pointer group. A device that appears after its group is paired joins the group's player.
- **Gestures.** Pinch and swipe are controls, derived from finger positions the way `leftStick` is derived from axes. `<Touch>/pinch` is the change in distance between the two lowest-slot fingers each frame. `<Touch>/swipe` is the primary touch's stroke in the frame it lifts, when it lifted within `SWIPE_MAX_SECONDS` (0.5) and at least `SWIPE_MIN_DISTANCE` (40 px) away. Both add up between ticks like `<Pointer>/delta`. Long press and multi-finger tap need no new code: a `hold` trigger on `<Touch>/primary` and a `tap` trigger on `<Touch>/touch1`.
- **Composed axes.** The mapping table is `[kind, index, kind2, index2]` per control: the value is the first source's minus the second's. A half-axis target (`+rightx:b9,-rightx:b4`, or `+leftx:h0.2,-leftx:h0.8`) fills one half, so the ~50 such database entries (N64-style pads, Joy-Cons) now map their sticks. In `input-map` this is `Binding { positive, negative }`.

## Build notes: WebHID enhanced mode (2026-11-22)

The "later, not v1" WebHID adapter is built, at the owner's request (`src/engine/input/webHid/`).

- **Devices:** DualSense and DualSense Edge, DualShock 4 (both models and Sony's USB wireless adapter), Switch Pro
  Controller; USB and Bluetooth. Report parsing and output encoding are ported from SDL's HIDAPI drivers, one module per
  family (`dualSense.ts`, `dualShock4.ts`, `switchPro.ts`): Bluetooth CRC-32s, the Switch USB handshake and
  subcommands, factory motion calibration (Sony feature reports, Switch SPI flash). Gyro and accelerometer arrive in
  SDL's units and axes, as on desktop.
- **Permission:** `Input.requestHidGamepads()` opens the browser's chooser from a user gesture; devices granted
  before are reopened at start and on `connect`. Where WebHID is missing (Firefox, Safari, Node) or under Tauri it
  resolves 0 and nothing else changes.
- **Ownership and fallback:** HID pads get their own device ids (from 0x4000). The Gamepad API adapter takes a skip
  predicate and skips, per vendor and product, as many pads (in index order) as the HID adapter has announced; when a
  HID device fails to open, fails to start or disconnects, its pad stops being skipped and the Gamepad API reports it
  again. Output is routed by id: HID pads' to their drivers, any other pad's to the Gamepad API's output.
- **Adaptive triggers:** `GamepadOutput` gains an optional `triggerEffect`, and `PlayerInput.setTriggerEffect(trigger,
  effect)` with a public `TriggerEffect` type (`off`, `resistance`, `weapon`, `vibration`). Only the DualSense through
  WebHID implements it so far; SDL could send the same blocks on desktop (`SDL_SendGamepadEffect`) later.
  `rumbleTriggers` on a DualSense plays a low-frequency trigger vibration over the game's effect.
- **Not yet:** touchpad touch points (the snapshot has no touch-surface controls; the touchpad click is reported),
  battery level, HD rumble frequencies on the Switch Pro (both bands at SDL's fixed frequencies), Joy-Cons.
- **Later the same day:** touchpad points (DualSense, DualShock 4; normalized as SDL scales them, 1920 × 1070 and
  1920 × 920) and battery (those and Switch controllers) reach the input end as `gamepadTouch` and `gamepadBattery`,
  on change. Joy-Cons over Bluetooth (`joyCon.ts`, sharing setup, calibration and rumble with the Pro in
  `nintendo.ts`): one alone is SDL's sideways mini pad; a left and a right open together join automatically into one
  pad (product 0x2008) under the left's id, as SDL's combined Joy-Cons default does, with no option to keep them
  apart; the pair's motion is the right's, rumble splits low band left and high band right. Switch rumble uses SDL's
  amplitude table at SDL's band frequencies (about 150 Hz; SDL has no frequency table, only these fixed codes), is
  written at most once per 30 ms per device and re-sent every 50 ms while playing. Still not: the charging grip, per-side
  motion of a pair (the sink has one gyro per pad).

## Open questions

- Which SDL3 Rust binding (`sdl3` crate versus our own thin bindings) and whether SDL is linked statically.
- Whether Steam Input should be allowed to take over controllers in Steam builds.
- ~~Touch gestures (pinch, swipe) as controls or as triggers in 0336.~~ Controls (pinch, swipe); long press and multi-finger tap are triggers on touch controls.

## References

- SDL3 gamepad API: https://wiki.libsdl.org/SDL3/CategoryGamepad
- SDL controller database: https://github.com/mdqinc/SDL_GameControllerDB
- gilrs: https://gitlab.com/gilrs-project/gilrs
- Gamepad API: https://w3c.github.io/gamepad/ · WebHID: https://wicg.github.io/webhid/
- Tauri channels: https://v2.tauri.app/develop/calling-frontend/#channels
- `src/engine/input/devices.ts`, `src/engine/input/domDevices.ts`, `native/nav/` (the committed-wasm pattern)
