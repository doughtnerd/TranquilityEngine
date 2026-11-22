/**
 * Device entities (ADR 0335): each World that takes local input mirrors the Engine's device
 * snapshot into ECS data in its `input` phase. Every device is a node under the World's `Input`
 * node with `InputDevice`, gamepads also with `GamepadState`; this frame's raw device events are
 * the `DeviceEvents` buffer. A World that doesn't take input (a server, `input: false`, an editor
 * tile without focus) has no device nodes: gating is the system not running there.
 */
import { World } from "../core/World";
import { defineBuffer, defineComponent, f32, i32, u8, type DataView } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, type DeviceFamily } from "./controls";
import { KEYBOARD_DEVICE, POINTER_DEVICE, devices, type GamepadSnapshot } from "./devices";

/** `InputDevice.kind`. */
export const DeviceKind = { keyboard: 0, pointer: 1, gamepad: 2 } as const;

/** `InputDevice.family`, by index. */
export const DEVICE_FAMILIES: readonly DeviceFamily[] = ["keyboard", "pointer", "generic", "xbox", "playstation", "switch"];

/**
 * A device this World sees. `device` is the adapter's id (`-1` keyboard, `-2` pointer, gamepads ≥ 0),
 * `slot` the gamepad's order of connection (0 first; keyboard and pointer 0), `player` the index of
 * the player it's paired with (ADR 0337), -1 for none. `connected` drops to 0 for the frame a gamepad
 * is unplugged, then its node is destroyed.
 */
export const InputDevice = defineComponent("engine.InputDevice", { device: i32, kind: u8, family: u8, slot: i32, player: i32, connected: u8 });

const gamepadSchema: Record<string, typeof f32 | typeof i32> = {};
GAMEPAD_BUTTONS.forEach((_, i) => (gamepadSchema[`b${i}`] = f32));
GAMEPAD_AXES.forEach((_, i) => (gamepadSchema[`a${i}`] = f32));
for (const f of ["held", "down", "up"]) gamepadSchema[f] = i32;
for (const f of ["gyroX", "gyroY", "gyroZ", "accelX", "accelY", "accelZ"]) gamepadSchema[f] = f32;

/**
 * A gamepad's state this frame: buttons `b0`…`b22` (0..1) and axes `a0`…`a3` (-1..1, +Y down) by
 * wire index (`controls.ts`), `held`/`down`/`up` bitmasks (bit i: button i), gyro (rad/s) and
 * accelerometer (m/s²) where the device has them.
 */
export const GamepadState = defineComponent("engine.GamepadState", gamepadSchema);

/** One raw device event this frame: a key, a pointer button, a gamepad button, or an axis crossing the press point. */
export interface DeviceEvent {
  /** The device's node. */
  readonly device: GameObject;
  /** The control path, e.g. `<Keyboard>/space`, `<Gamepad>/buttonSouth`, `<Gamepad>/leftStickX`. */
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
