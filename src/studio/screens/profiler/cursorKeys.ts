// The Profiler's cursor keys (ADR 0348 "keys to step between markers"; the prototype promised them in the At cursor
// tooltip and never wired them): ← and → step one STATUS block, Shift+← and Shift+→ jump to the previous or next marker,
// where markers are the capture's MARKER records and every warning and error the ruler shows. They move the editor
// profiler's `CursorModel` (its stepping and jumps), which is given the merged marker times. Pure.
import { cursorTargets, type CursorModel, type CursorTargets } from "../../../plugins/audio/editor/mix/cursorModel";
import type { CaptureMarkerAt, CaptureRangeColumns } from "../../../plugins/audio/runtime/capture/reader";
import type { RulerMark } from "./messagesModel";

export type CursorKeyAction = "stepBack" | "stepForward" | "markerBack" | "markerForward";

export interface CursorKey {
  readonly action: CursorKeyAction;
  readonly keys: readonly string[];
  readonly label: string;
}

/** The keys, in the shortcut list's order (keymap combos). */
export const CURSOR_KEYS: readonly CursorKey[] = [
  { action: "stepBack", keys: ["ArrowLeft"], label: "Cursor: step back one block" },
  { action: "stepForward", keys: ["ArrowRight"], label: "Cursor: step forward one block" },
  { action: "markerBack", keys: ["Shift+ArrowLeft"], label: "Cursor: previous marker or warning" },
  { action: "markerForward", keys: ["Shift+ArrowRight"], label: "Cursor: next marker or warning" },
];

/** The words the At cursor panel shows for the keys. */
export const CURSOR_KEYS_HINT = "← → step · Shift+← → jump to markers";

/** Two times this close are one target (a marker and its message, rebased by different sums). */
const SAME_TIME_S = 1e-6;

/** Sorted, without repeats. */
function sortedUnique(values: Iterable<number>): Float64Array {
  const a = Float64Array.from(values).sort();
  let n = 0;
  for (let i = 0; i < a.length; i++) if (n === 0 || a[i]! - a[n - 1]! > SAME_TIME_S) a[n++] = a[i]!;
  return a.slice(0, n);
}

/**
 * The cursor's targets: the STATUS times and jumps of `cursorTargets` (from a `statusColumns` answer of `CURSOR_COLUMNS`,
 * or empty columns), with the markers made of the capture's markers and the ruler's marks.
 */
export function profilerTargets(cols: CaptureRangeColumns, markers: readonly CaptureMarkerAt[], startSeconds: number, marks: readonly RulerMark[]): CursorTargets {
  const base = cursorTargets(cols, markers, startSeconds);
  return { ...base, marker: sortedUnique([...base.marker, ...marks.map((m) => m.time)]) };
}

/** Applies a key's action; true when the cursor moved (false: nowhere to go, nothing changed). */
export function runCursorKey(action: CursorKeyAction, cursor: Pick<CursorModel, "stepBack" | "stepForward" | "jump">): boolean {
  switch (action) {
    case "stepBack":
      return cursor.stepBack();
    case "stepForward":
      return cursor.stepForward();
    case "markerBack":
      return cursor.jump("marker", "previous");
    case "markerForward":
      return cursor.jump("marker", "next");
  }
}
