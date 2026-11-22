/**
 * Control paths (ADR 0335): every control has a path naming its position, not a vendor's label:
 * `<Keyboard>/space`, `<Pointer>/button0`, `<Pointer>/delta`, `<Gamepad>/buttonSouth`,
 * `<Gamepad>/leftStick`, `<Gamepad>/gyro`. Paths are interned to small integer ids.
 *
 * Gamepad buttons and axes have wire indices shared by every adapter (the W3C "standard" gamepad
 * order, then extras): the DOM Gamepad API adapter, the Tauri SDL3 adapter (`src-tauri/src/gamepad.rs`)
 * and the mapping crate (`native/input/`) all use them.
 *
 * Value conventions in action space: sticks, the d-pad and pointer delta/scroll have +Y **up**
 * (the wire's gamepad axes are +Y down, as the W3C API reports them; reading a control flips them).
 */

/** Gamepad buttons in wire order. Triggers (6, 7) are analog, 0..1. */
export const GAMEPAD_BUTTONS = [
  "buttonSouth", "buttonEast", "buttonWest", "buttonNorth",
  "leftShoulder", "rightShoulder", "leftTrigger", "rightTrigger",
  "select", "start", "leftStickPress", "rightStickPress",
  "dpadUp", "dpadDown", "dpadLeft", "dpadRight",
  "home", "misc1", "rightPaddle1", "leftPaddle1", "rightPaddle2", "leftPaddle2", "touchpadPress",
] as const;

/** Gamepad axes in wire order: -1..1, +X right, +Y down on the wire. */
export const GAMEPAD_AXES = ["leftStickX", "leftStickY", "rightStickX", "rightStickY"] as const;

export type GamepadButtonName = (typeof GAMEPAD_BUTTONS)[number];
export type GamepadAxisName = (typeof GAMEPAD_AXES)[number];

/** A device family: what kind of device, for prompts (ADR 0337) and per-family bindings. */
export type DeviceFamily = "keyboard" | "pointer" | "xbox" | "playstation" | "switch" | "generic";

/** Gamepad families by the mapping crate's number (`native/input`, `Family`). */
export const GAMEPAD_FAMILIES: readonly DeviceFamily[] = ["generic", "xbox", "playstation", "switch"];

/** The analog value at which a button or trigger counts as pressed. */
export const PRESS_POINT = 0.5;

/** What a control reads: its device kind, and how. */
export type ControlSource =
  | { readonly device: "keyboard"; readonly key: string }
  | { readonly device: "pointer"; readonly read: "button"; readonly button: number }
  | { readonly device: "pointer"; readonly read: "delta" | "scroll" | "position" }
  | { readonly device: "gamepad"; readonly read: "button"; readonly index: number }
  | { readonly device: "gamepad"; readonly read: "axis"; readonly index: number }
  | { readonly device: "gamepad"; readonly read: "stick"; readonly x: number; readonly y: number }
  | { readonly device: "gamepad"; readonly read: "dpad" }
  | { readonly device: "gamepad"; readonly read: "gyro" | "accel" };

export interface Control {
  readonly id: number;
  /** The canonical path, e.g. `<Gamepad>/buttonSouth`. */
  readonly path: string;
  readonly source: ControlSource;
  /** How many components it reads: 1 (buttons, axes), 2 (sticks, pointer delta), 3 (gyro). */
  readonly dimensions: 1 | 2 | 3;
  /** A delta control (pointer delta, scroll): its values add up between fixed ticks instead of being sampled. */
  readonly additive: boolean;
}

const byPath = new Map<string, Control>();
const byId: Control[] = [];

const KEY_ALIASES: Record<string, string> = { " ": "space", spacebar: "space", esc: "escape", return: "enter" };

/** A key name as `Input` uses it: lower-case `KeyboardEvent.key`, with `space`, `escape` and `enter`. */
export function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  return KEY_ALIASES[k] ?? k;
}

function parse(path: string): Omit<Control, "id"> | null {
  const m = /^<(\w+)>\/(.+)$/.exec(path.trim());
  if (!m) return null;
  const device = m[1].toLowerCase();
  const name = m[2];
  if (device === "keyboard") {
    const key = normalizeKey(name);
    return { path: `<Keyboard>/${key}`, source: { device: "keyboard", key }, dimensions: 1, additive: false };
  }
  if (device === "pointer" || device === "mouse") {
    const button = /^button(\d+)$/.exec(name) ?? (name === "leftButton" ? ["", "0"] : name === "rightButton" ? ["", "2"] : name === "middleButton" ? ["", "1"] : null);
    if (button) return { path: `<Pointer>/button${button[1]}`, source: { device: "pointer", read: "button", button: Number(button[1]) }, dimensions: 1, additive: false };
    if (name === "delta" || name === "scroll") return { path: `<Pointer>/${name}`, source: { device: "pointer", read: name }, dimensions: 2, additive: true };
    if (name === "position") return { path: "<Pointer>/position", source: { device: "pointer", read: "position" }, dimensions: 2, additive: false };
    return null;
  }
  if (device === "gamepad") {
    const b = (GAMEPAD_BUTTONS as readonly string[]).indexOf(name);
    if (b >= 0) return { path: `<Gamepad>/${name}`, source: { device: "gamepad", read: "button", index: b }, dimensions: 1, additive: false };
    const a = (GAMEPAD_AXES as readonly string[]).indexOf(name);
    if (a >= 0) return { path: `<Gamepad>/${name}`, source: { device: "gamepad", read: "axis", index: a }, dimensions: 1, additive: false };
    if (name === "leftStick") return { path: "<Gamepad>/leftStick", source: { device: "gamepad", read: "stick", x: 0, y: 1 }, dimensions: 2, additive: false };
    if (name === "rightStick") return { path: "<Gamepad>/rightStick", source: { device: "gamepad", read: "stick", x: 2, y: 3 }, dimensions: 2, additive: false };
    if (name === "dpad") return { path: "<Gamepad>/dpad", source: { device: "gamepad", read: "dpad" }, dimensions: 2, additive: false };
    if (name === "gyro" || name === "accel") return { path: `<Gamepad>/${name}`, source: { device: "gamepad", read: name }, dimensions: 3, additive: false };
    return null;
  }
  return null;
}

/** The control a path names (interned: the same object for the same control), or null if the path names none. */
export function control(path: string): Control | null {
  const known = byPath.get(path);
  if (known) return known;
  const parsed = parse(path);
  if (!parsed) return null;
  let c = byPath.get(parsed.path);
  if (!c) {
    c = { ...parsed, id: byId.length };
    byId.push(c);
    byPath.set(parsed.path, c);
  }
  byPath.set(path, c);
  return c;
}

/** The control with an id. */
export function controlById(id: number): Control {
  return byId[id];
}

/** The control a path names; throws, naming `where`, if it names none. */
export function requireControl(path: string, where: string): Control {
  const c = control(path);
  if (!c) throw new Error(`${where}: "${path}" isn't a control path. Paths look like <Keyboard>/space, <Pointer>/button0, <Pointer>/delta, <Gamepad>/buttonSouth or <Gamepad>/leftStick.`);
  return c;
}
