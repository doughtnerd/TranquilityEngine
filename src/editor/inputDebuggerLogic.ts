// What the Input debugger panel shows (ADR 0336, 0337), as text: which play World it follows, an action's value, the
// mapping that produced it, its phase flags split into levels and edges, and one line per logged event. Pure, so the
// panel's wording is unit-tested; `ui/InputDebuggerPanel.tsx` samples the World through the editor SDK and draws it.
import type { InputActionRow, InputLogEntry, InputSourceRow } from "../engine/editor";

/**
 * The World to follow: the one picked while it's still playing, else the first that takes local input (the only kind
 * with devices and actions), else the first; null with none.
 */
export function pickWorld(worlds: readonly { readonly name: string; readonly takesInput: boolean }[], picked: string | null): string | null {
  if (picked && worlds.some((w) => w.name === picked)) return picked;
  return (worlds.find((w) => w.takesInput) ?? worlds[0])?.name ?? null;
}

const num = (v: number) => (Math.abs(v) < 0.005 ? "0" : v.toFixed(2));

/** A button's or axis's value, or a vector's components: `0.75`, `(1, -0.5)`. */
export function formatValue(value: readonly number[]): string {
  return value.length === 1 ? num(value[0]) : `(${value.map(num).join(", ")})`;
}

/** The value's size 0..1, for the bar beside it: a button's value, an axis's or vector's length. */
export function valueMagnitude(value: readonly number[]): number {
  return Math.min(1, Math.sqrt(value.reduce((s, v) => s + v * v, 0)));
}

/** The flags that hold while a state lasts, and those that last one frame. */
const LEVELS = new Set(["held", "ongoing", "triggered"]);

/** An action's phase flags split into levels (held, ongoing, triggered) and edges (pressed, started, performed…). */
export function splitPhases(phases: readonly string[]): { levels: string[]; edges: string[] } {
  return { levels: phases.filter((p) => LEVELS.has(p)), edges: phases.filter((p) => !LEVELS.has(p)) };
}

/** A control path without its device, as the panel abbreviates it: `<Keyboard>/w` → `w`. */
const short = (path: string) => path.slice(path.indexOf("/") + 1);

/** Where an action's value came from: `onFoot #2 · W/S/A/D (dpad)`, `default #1 · <Gamepad>/buttonSouth`. */
export function sourceLabel(source: InputSourceRow | null): string {
  if (!source) return "—";
  const where = `${source.context} #${source.mapping + 1}`;
  if (source.composite === "single") return `${where} · ${source.controls[0]}`;
  if (source.composite === "modifier") return `${where} · ${source.controls.map(short).join("+")} (chord)`;
  return `${where} · ${source.controls.map(short).join("/")} (${source.composite})`;
}

/** An action's name as the panel lists it: bare, with its set when several sets are defined. */
export const actionLabel = (row: InputActionRow, sets: number) => (sets > 1 ? `${row.set}:${row.action}` : row.action);

/** One logged event as a line. */
export function logText(e: InputLogEntry): string {
  switch (e.kind) {
    case "action":
      return `P${e.player} ${e.action} ${e.phase}${e.value ? ` (${num(e.value)})` : ""}`;
    case "device":
      return `${e.device} ${e.control} ${num(e.value)}`;
    case "joined":
      return `Player ${e.player} joined`;
    case "left":
      return `Player ${e.player} left`;
    case "rebind":
      return e.canceled ? `P${e.player} rebind ${e.action} canceled` : `P${e.player} rebind ${e.action} → ${e.control}${e.conflicts.length ? ` (conflicts: ${e.conflicts.join(", ")})` : ""}`;
  }
}

/** Seconds as the panel shows them: `0.42 s`, `—` when infinite (a rebind without a timeout). */
export const seconds = (s: number) => (Number.isFinite(s) ? `${s.toFixed(2)} s` : "—");
