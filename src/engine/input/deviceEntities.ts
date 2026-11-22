/**
 * Device entities (ADR 0335): each World that takes local input mirrors the Engine's device
 * snapshot into ECS data in its `input` phase. Every device is a node under the World's `Input`
 * node with `InputDevice`, gamepads also with `GamepadState`, the touchscreen with `TouchState`
 * and the pen with `PenState`; this frame's raw device events are
 * the `DeviceEvents` buffer. A World that doesn't take input (a server, `input: false`, an editor
 * tile without focus) has no device nodes: gating is the system not running there.
 */
import { World } from "../core/World";
import { defineBuffer, defineComponent, f32, i32, u8, type DataView } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, TOUCHPAD_FINGERS, TOUCH_SLOTS, type DeviceFamily } from "./controls";
import { KEYBOARD_DEVICE, PEN_DEVICE, POINTER_DEVICE, TOUCH_DEVICE, devices, type GamepadSnapshot, type PenSnapshot, type TouchscreenSnapshot } from "./devices";

/** `InputDevice.kind`. */
export const DeviceKind = { keyboard: 0, pointer: 1, gamepad: 2, touch: 3, pen: 4 } as const;

/** `InputDevice.family`, by index. */
export const DEVICE_FAMILIES: readonly DeviceFamily[] = ["keyboard", "pointer", "generic", "xbox", "playstation", "switch", "touch", "pen"];

/**
 * A device this World sees. `device` is the adapter's id (`-1` keyboard, `-2` pointer, `-3`
 * touchscreen, `-4` pen, gamepads ≥ 0),
 * `slot` the gamepad's order of connection (0 first; keyboard and pointer 0), `player` the index of
 * the player it's paired with (ADR 0337), -1 for none. `connected` drops to 0 for the frame a gamepad
 * is unplugged, then its node is destroyed.
 */
export const InputDevice = defineComponent("engine.InputDevice", { device: i32, kind: u8, family: u8, slot: i32, player: i32, connected: u8 });

const gamepadSchema: Record<string, typeof f32 | typeof i32 | typeof u8> = {};
GAMEPAD_BUTTONS.forEach((_, i) => (gamepadSchema[`b${i}`] = f32));
GAMEPAD_AXES.forEach((_, i) => (gamepadSchema[`a${i}`] = f32));
for (const f of ["held", "down", "up"]) gamepadSchema[f] = i32;
for (const f of ["gyroX", "gyroY", "gyroZ", "accelX", "accelY", "accelZ"]) gamepadSchema[f] = f32;
for (const f of ["tpHeld", "tpDown", "tpUp"]) gamepadSchema[f] = i32;
for (let i = 0; i < TOUCHPAD_FINGERS; i++) gamepadSchema[`tp${i}X`] = gamepadSchema[`tp${i}Y`] = f32;
gamepadSchema.battery = f32;
gamepadSchema.charging = u8;

/**
 * A gamepad's state this frame: buttons `b0`…`b22` (0..1) and axes `a0`…`a3` (-1..1, +Y down) by
 * wire index (`controls.ts`), `held`/`down`/`up` bitmasks (bit i: button i), gyro (rad/s) and
 * accelerometer (m/s²) where the device has them. Touchpad fingers (DualSense, DualShock 4):
 * `tpHeld`/`tpDown`/`tpUp` bitmasks (bit 0 finger 0, bit 1 finger 1) and each finger's position
 * `tp0X`/`tp0Y`, `tp1X`/`tp1Y` in 0..1 of the touchpad (origin top-left, +Y down; the last one
 * after it lifts). `battery` 0..1, or -1 when unknown or wired without one; `charging` 1 while
 * plugged in.
 */
export const GamepadState = defineComponent("engine.GamepadState", gamepadSchema);

const touchSchema: Record<string, typeof f32 | typeof i32> = { held: i32, down: i32, up: i32, count: i32 };
for (let i = 0; i < TOUCH_SLOTS; i++) touchSchema[`x${i}`] = touchSchema[`y${i}`] = f32;
for (const f of ["primaryX", "primaryY", "primaryDeltaX", "primaryDeltaY", "pinch", "swipeX", "swipeY"]) touchSchema[f] = f32;

/**
 * The touchscreen this frame (it appears with the first touch): `held`/`down`/`up` bitmasks (bits
 * 0–9: the finger in that slot; bit 10: the primary touch, the first finger down), `count` fingers
 * down, each slot's position `x0`/`y0`…`x9`/`y9` and the primary's (`primaryX`, `primaryY`) in
 * canvas pixels, the primary's movement this frame (`primaryDeltaX`/`Y`, +Y down), and `pinch`, how
 * much the distance between the two lowest-slot fingers grew this frame (pixels). A touch the UI
 * took (ADR 0069) isn't in the bitmasks.
 */
export const TouchState = defineComponent("engine.TouchState", touchSchema);

/**
 * The pen this frame (it appears when first sensed): `held`/`down`/`up` bitmasks (bit 0 the tip
 * touching, 1 the barrel button, 2 the eraser), position `x`/`y` in canvas pixels and movement
 * `deltaX`/`deltaY` (+Y down), `pressure` 0..1, `tiltX`/`tiltY` -1..1 (±90°, +Y toward the user),
 * `twist` 0..1 of a turn, and `inRange` 1 while hovering or touching.
 */
export const PenState = defineComponent("engine.PenState", { held: i32, down: i32, up: i32, x: f32, y: f32, deltaX: f32, deltaY: f32, pressure: f32, tiltX: f32, tiltY: f32, twist: f32, inRange: u8 });

/** One raw device event this frame: a key, a pointer button, a gamepad button, or an axis crossing the press point. */
export interface DeviceEvent {
  /** The device's node. */
  readonly device: GameObject;
  /** The control path, e.g. `<Keyboard>/space`, `<Gamepad>/buttonSouth`, `<Gamepad>/leftStickX`, `<Touch>/touch0`, `<Pen>/tip`. */
  readonly control: string;
  readonly value: number;
  /** `performance.now()` milliseconds. */
  readonly time: number;
}

/** This frame's raw device events (cleared at end of frame): rebinding, "press any button", recording. */
export const DeviceEvents = defineBuffer<DeviceEvent>("engine.DeviceEvents");

interface WorldDevices {
  /** The World's `Input` node: devices and players are its children. */
  root: GameObject | null;
  /** Device nodes by device id. */
  readonly nodes: Map<number, GameObject>;
  /** Gamepads unplugged last frame, destroyed this frame. */
  readonly leaving: GameObject[];
}

const perWorld = new WeakMap<World, WorldDevices>();

function stateOf(world: World): WorldDevices {
  let s = perWorld.get(world);
  if (!s) perWorld.set(world, (s = { root: null, nodes: new Map(), leaving: [] }));
  return s;
}

/** @internal Whether `world` takes local input (and so gets device nodes): not editor or server Worlds, and only where the view allocator gives it input. */
export function takesLocalInput(world: World): boolean {
  return world._takesInput && world.kind !== "editor" && world.kind !== "server";
}

/** @internal The World's `Input` node (created on first use): its devices and players are under it. */
export function inputRoot(world: World): GameObject {
  const s = stateOf(world);
  if (!s.root?.isValid) s.root = world._createNode("Input", world.root.entity, { transform: false });
  return s.root;
}

/** @internal The device node for an adapter device id in `world`, if it has one. */
export function deviceNode(world: World, device: number): GameObject | undefined {
  const node = perWorld.get(world)?.nodes.get(device);
  return node?.isValid ? node : undefined;
}

/** @internal Every device node in `world` (connected ones; a gamepad unplugged this frame is gone). */
export function deviceNodes(world: World): IterableIterator<GameObject> {
  return stateOf(world).nodes.values();
}

function familyCode(family: DeviceFamily): number {
  const i = DEVICE_FAMILIES.indexOf(family);
  return i < 0 ? 2 : i;
}

function writePad(view: DataView<Record<string, typeof f32>>, pad: GamepadSnapshot): void {
  const v = view as Record<string, number>;
  for (let i = 0; i < pad.buttons.length; i++) v[`b${i}`] = pad.buttons[i];
  for (let i = 0; i < pad.axes.length; i++) v[`a${i}`] = pad.axes[i];
  v.held = pad.held;
  v.down = pad.down;
  v.up = pad.up;
  v.gyroX = pad.gyro[0];
  v.gyroY = pad.gyro[1];
  v.gyroZ = pad.gyro[2];
  v.accelX = pad.accel[0];
  v.accelY = pad.accel[1];
  v.accelZ = pad.accel[2];
  v.tpHeld = pad.touchHeld;
  v.tpDown = pad.touchDown;
  v.tpUp = pad.touchUp;
  for (let i = 0; i < pad.touchX.length; i++) {
    v[`tp${i}X`] = pad.touchX[i];
    v[`tp${i}Y`] = pad.touchY[i];
  }
  v.battery = pad.battery;
  v.charging = pad.charging ? 1 : 0;
}

function writeTouch(view: Record<string, number>, touch: TouchscreenSnapshot): void {
  view.held = touch.held;
  view.down = touch.down;
  view.up = touch.up;
  view.count = touch.count;
  for (let i = 0; i < TOUCH_SLOTS; i++) {
    view[`x${i}`] = touch.x[i];
    view[`y${i}`] = touch.y[i];
  }
  view.primaryX = touch.primaryX;
  view.primaryY = touch.primaryY;
  view.primaryDeltaX = touch.primaryDeltaX;
  view.primaryDeltaY = touch.primaryDeltaY;
  view.pinch = touch.pinch;
  view.swipeX = touch.swipeX;
  view.swipeY = touch.swipeY;
}

function writePen(view: Record<string, number>, pen: PenSnapshot): void {
  view.held = pen.held;
  view.down = pen.down;
  view.up = pen.up;
  view.x = pen.x;
  view.y = pen.y;
  view.deltaX = pen.deltaX;
  view.deltaY = pen.deltaY;
  view.pressure = pen.pressure;
  view.tiltX = pen.tiltX;
  view.tiltY = pen.tiltY;
  view.twist = pen.twist;
  view.inRange = pen.inRange ? 1 : 0;
}

function sync(world: World): void {
  const s = stateOf(world);
  for (const node of s.leaving) if (node.isValid) world._destroyNode(node.entity);
  s.leaving.length = 0;
  if (!takesLocalInput(world)) {
    for (const node of s.nodes.values()) if (node.isValid) world._destroyNode(node.entity);
    s.nodes.clear();
    return;
  }
  const add = (device: number, name: string, kind: number, family: DeviceFamily, slot: number): GameObject => {
    const node = world._createNode(name, inputRoot(world).entity, { transform: false });
    node.addData(InputDevice, { device, kind, family: familyCode(family), slot, player: -1, connected: 1 });
    s.nodes.set(device, node);
    return node;
  };
  // The keyboard and pointer exist while an adapter reports them (Input.attach, or Input.inject).
  if (devices.hasKeyboardAndPointer) {
    if (!s.nodes.get(KEYBOARD_DEVICE)?.isValid) add(KEYBOARD_DEVICE, "Keyboard", DeviceKind.keyboard, "keyboard", 0);
    if (!s.nodes.get(POINTER_DEVICE)?.isValid) add(POINTER_DEVICE, "Pointer", DeviceKind.pointer, "pointer", 0);
  }
  // The touchscreen and pen exist once an adapter has reported them.
  if (devices.hasTouch) {
    let node = s.nodes.get(TOUCH_DEVICE);
    if (!node?.isValid) (node = add(TOUCH_DEVICE, "Touchscreen", DeviceKind.touch, "touch", 0)).addData(TouchState);
    writeTouch(node.getData(TouchState) as unknown as Record<string, number>, devices.touch);
  }
  if (devices.hasPen) {
    let node = s.nodes.get(PEN_DEVICE);
    if (!node?.isValid) (node = add(PEN_DEVICE, "Pen", DeviceKind.pen, "pen", 0)).addData(PenState);
    writePen(node.getData(PenState) as unknown as Record<string, number>, devices.pen);
  }
  // Gamepads: unplugged ones leave, new ones join with the lowest free slot.
  const live = new Set<number>();
  for (const pad of devices.gamepads()) live.add(pad.info.id);
  for (const [id, node] of [...s.nodes]) {
    if (id < 0 || live.has(id)) continue;
    s.nodes.delete(id);
    const data = node.isValid ? node.getData(InputDevice) : null;
    if (data) {
      data.connected = 0;
      s.leaving.push(node);
    }
  }
  for (const pad of devices.gamepads()) {
    let node = s.nodes.get(pad.info.id);
    if (!node?.isValid) {
      const used = new Set<number>();
      for (const [id, n] of s.nodes) if (id >= 0 && n.isValid) used.add(n.getData(InputDevice)!.slot);
      let slot = 0;
      while (used.has(slot)) slot++;
      node = add(pad.info.id, pad.info.name || `Gamepad ${slot + 1}`, DeviceKind.gamepad, pad.family, slot);
      node.addData(GamepadState);
    }
    writePad(node.getData(GamepadState)! as DataView<Record<string, typeof f32>>, pad);
  }
  for (const e of devices.events) {
    const node = s.nodes.get(e.device);
    if (node?.isValid) DeviceEvents.push({ device: node, control: e.control, value: e.value, time: e.time });
  }
}

defineBuiltinSystem({ name: "engine.InputDevices", phase: "input", run: (w) => sync(w) });
