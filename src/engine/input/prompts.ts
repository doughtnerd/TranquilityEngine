/**
 * Button prompts (ADR 0335): which control performs an action for a player, named for the family
 * of the device they last used ("A" on an Xbox pad, "Cross" on a PlayStation one, "Space" on a
 * keyboard), with an icon key (`xbox/buttonSouth`, `keyboard/space`) a glyph set can draw.
 */
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { controlById, type Control, type DeviceFamily } from "./controls";
import { playerTable, resolveAction, type CompiledMapping } from "./evaluate";
import { InputPlayer, familyName } from "./players";

/** What a prompt shows. */
export interface InputPrompt {
  /** The family it's named for. */
  readonly family: DeviceFamily;
  /** The mapping's controls (several for a composite: up, down, left, right). */
  readonly controls: readonly string[];
  /** A label for each control, and all of them joined ("W/S/A/D"). */
  readonly labels: readonly string[];
  readonly label: string;
  /** An icon key for each control: `<family>/<control>`, e.g. `xbox/buttonSouth`, `keyboard/space`. */
  readonly icons: readonly string[];
}

const PAD_LABELS: Record<"xbox" | "playstation" | "switch" | "generic", Record<string, string>> = {
  xbox: { buttonSouth: "A", buttonEast: "B", buttonWest: "X", buttonNorth: "Y", leftShoulder: "LB", rightShoulder: "RB", leftTrigger: "LT", rightTrigger: "RT", select: "View", start: "Menu", leftStickPress: "LS", rightStickPress: "RS", home: "Xbox", misc1: "Share" },
  playstation: { buttonSouth: "Cross", buttonEast: "Circle", buttonWest: "Square", buttonNorth: "Triangle", leftShoulder: "L1", rightShoulder: "R1", leftTrigger: "L2", rightTrigger: "R2", select: "Create", start: "Options", leftStickPress: "L3", rightStickPress: "R3", home: "PS", misc1: "Mute", touchpadPress: "Touchpad" },
  switch: { buttonSouth: "B", buttonEast: "A", buttonWest: "Y", buttonNorth: "X", leftShoulder: "L", rightShoulder: "R", leftTrigger: "ZL", rightTrigger: "ZR", select: "-", start: "+", leftStickPress: "L Stick", rightStickPress: "R Stick", home: "Home", misc1: "Capture" },
  generic: { buttonSouth: "South", buttonEast: "East", buttonWest: "West", buttonNorth: "North", leftShoulder: "L1", rightShoulder: "R1", leftTrigger: "L2", rightTrigger: "R2", select: "Select", start: "Start", leftStickPress: "L3", rightStickPress: "R3", home: "Home", misc1: "Misc" },
};

const COMMON_PAD: Record<string, string> = {
  dpadUp: "D-pad Up", dpadDown: "D-pad Down", dpadLeft: "D-pad Left", dpadRight: "D-pad Right", dpad: "D-pad",
  leftStick: "Left Stick", rightStick: "Right Stick", leftStickX: "Left Stick", leftStickY: "Left Stick", rightStickX: "Right Stick", rightStickY: "Right Stick",
  rightPaddle1: "P1", leftPaddle1: "P2", rightPaddle2: "P3", leftPaddle2: "P4", touchpadPress: "Touchpad", gyro: "Gyro", accel: "Motion",
};

const KEY_LABELS: Record<string, string> = {
  space: "Space", enter: "Enter", escape: "Esc", tab: "Tab", backspace: "Backspace", shift: "Shift", control: "Ctrl", alt: "Alt", meta: "Meta",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", capslock: "Caps Lock", delete: "Del",
};

const POINTER_LABELS: Record<string, string> = { button0: "Left Click", button1: "Middle Click", button2: "Right Click", button3: "Back", button4: "Forward", delta: "Mouse", scroll: "Scroll Wheel", position: "Pointer" };

/** A control's label on a device of `family`. */
export function controlLabel(c: Control, family: DeviceFamily): string {
  const name = c.path.slice(c.path.indexOf("/") + 1);
  if (c.source.device === "keyboard") return KEY_LABELS[name] ?? (name.length === 1 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1));
  if (c.source.device === "pointer") return POINTER_LABELS[name] ?? name;
  const pad = family === "xbox" || family === "playstation" || family === "switch" ? family : "generic";
  return PAD_LABELS[pad][name] ?? COMMON_PAD[name] ?? name;
}

/** A control's icon key on a device of `family`. */
export function controlIcon(c: Control, family: DeviceFamily): string {
  const name = c.path.slice(c.path.indexOf("/") + 1);
  if (c.source.device === "gamepad") return `${family === "keyboard" || family === "pointer" ? "generic" : family}/${name}`;
  return `${c.source.device}/${name}`;
}

const isPadFamily = (f: DeviceFamily) => f !== "keyboard" && f !== "pointer";

/** Whether a mapping is for devices of `family` (keyboard and pointer go together). */
export function mappingFits(m: CompiledMapping, family: DeviceFamily): boolean {
  const pad = isPadFamily(family);
  return m.controls.every((id) => (controlById(id).source.device === "gamepad") === pad);
}

/** @internal The prompt for `action` for a player node, named for `family` (default: the family they last used). */
export function promptFor(world: World, player: GameObject, action: string, family?: DeviceFamily): InputPrompt | null {
  const target = resolveAction(action);
  if (!target) throw new Error(`prompt: there's no action "${action}".`);
  const fam = family ?? familyName(player.getData(InputPlayer)!.lastFamily);
  const table = playerTable(world, player);
  for (const ctx of table.contexts) {
    for (const m of ctx.mappings) {
      if (m.set !== target.set || m.action !== target.action || !mappingFits(m, fam)) continue;
      const controls = m.controls.map(controlById);
      // A chord shows its modifiers first ("Shift+B").
      const labels = controls.map((c) => controlLabel(c, fam));
      return {
        family: fam,
        controls: controls.map((c) => c.path),
        labels,
        label: labels.join(m.source.kind === "modifier" ? "+" : "/"),
        icons: controls.map((c) => controlIcon(c, fam)),
      };
    }
  }
  return null;
}
