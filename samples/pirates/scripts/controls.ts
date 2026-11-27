// King of Pirates' controls (ADR 0336, 0337): the captain's actions, bound to the keyboard and mouse
// and to a gamepad as their defaults (the default context). The client reads them each tick and
// turns them into the `Helm` it sends (client.ts); the HUD names them in its help line with the
// player's own bindings (`controlsHelp`), following the device they last used.
import { button, defineActions, vec2, type DeviceFamily, type PlayerInput } from "myco";

export const CaptainActions = defineActions("pirates.Captain", {
  /** A gamepad's heading: push the stick the way to sail (north is up on screen). The mouse steers by pointing instead. */
  steer: vec2("<Gamepad>/leftStick"),
  /** Pick the port battery (it stays picked). */
  port: button("<Keyboard>/a", "<Keyboard>/arrowleft", "<Gamepad>/leftShoulder"),
  /** Pick the starboard battery (it stays picked). */
  starboard: button("<Keyboard>/d", "<Keyboard>/arrowright", "<Gamepad>/rightShoulder"),
  /** Fire the picked battery while held. */
  fire: button("<Keyboard>/space", "<Gamepad>/rightTrigger", "<Gamepad>/buttonSouth"),
  /** A ghost ship drops a fog cloud. */
  drop: button("<Keyboard>/f", "<Gamepad>/buttonWest"),
  /** Open (or close) the "Leave the match?" dialog. */
  leave: button("<Keyboard>/escape", "<Gamepad>/start"),
});

/** True for a gamepad family: the stick steers, and the help line names its buttons. */
export function isGamepad(family: DeviceFamily): boolean {
  return family === "xbox" || family === "playstation" || family === "switch" || family === "generic";
}

/** How far ahead of the ship a gamepad's stick puts the helm's point, in metres. */
export const STICK_REACH = 30;
/** How far the stick must be pushed before it steers; below it the ship holds its course. */
export const STICK_STEER = 0.3;

/**
 * The helm's point for a gamepad: `STICK_REACH` ahead of the ship along the stick (+Y up is north,
 * -Z), or null while the stick rests (the ship holds its course).
 */
export function stickAim(shipX: number, shipZ: number, stickX: number, stickY: number): { x: number; z: number } | null {
  const length = Math.hypot(stickX, stickY);
  if (length < STICK_STEER) return null;
  return { x: shipX + (stickX / length) * STICK_REACH, z: shipZ - (stickY / length) * STICK_REACH };
}

/**
 * The label of an action's binding for the player's last-used gamepad, else for the keyboard (the
 * mouse and touch steer by pointing), or `fallback` when it has none (or there's no local player).
 */
function label(input: PlayerInput, action: string, fallback: string): string {
  if (!input.player) return fallback;
  const family = input.lastFamily;
  return input.prompt(action, isGamepad(family) ? family : "keyboard")?.label ?? fallback;
}

/** The two battery labels, with the player's bindings for the device they last used: "[A] Port", "Starboard [D]". */
export function batteryLabels(input: PlayerInput): { port: string; starboard: string } {
  return { port: `[${label(input, "port", "A")}] Port`, starboard: `Starboard [${label(input, "starboard", "D")}]` };
}

/** The HUD's help line, naming the player's own bindings for the device they last used. */
export function controlsHelp(input: PlayerInput): string {
  const pad = isGamepad(input.lastFamily);
  const steer = pad ? `${label(input, "steer", "Left stick")}: steer` : "Mouse: steer";
  return [
    steer,
    `${label(input, "port", "A")} / ${label(input, "starboard", "D")}: battery`,
    `${label(input, "fire", "Space")}: fire`,
    `${label(input, "drop", "F")}: fog cloud (ghost ship)`,
    `${label(input, "leave", "Esc")}: leave the match`,
  ].join("   |   ");
}
