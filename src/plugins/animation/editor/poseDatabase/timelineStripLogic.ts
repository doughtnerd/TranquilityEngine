// The pose database tool's timeline strip (ADR 0373 "pick clips and tag ranges"; T55): one clip's length as a bar with its
// tagged ranges on it, drawn and dragged by percent of the clip's duration. The pure part: positions, the drag of a
// range's start, end or whole, time snapping, and which colour a tag gets.
import type { PoseRange } from "../../../../engine/animation/poseDatabase";

/** The seconds a dragged time snaps to. */
export const SNAP = 0.01;

/** `time` rounded to the snap step. */
export const snapTime = (time: number): number => Math.round(time / SNAP) * SNAP;

/** Where `time` is on a bar of `duration` seconds, percent (clamped to the bar). */
export function percentOf(time: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.min(100, Math.max(0, (time / duration) * 100));
}

/** The time at `fraction` (0..1) of a bar of `duration` seconds, snapped. */
export const timeAt = (fraction: number, duration: number): number => snapTime(Math.min(1, Math.max(0, fraction)) * duration);

/** What a drag of a range moves. */
export type RangeDrag = "start" | "end" | "move";

/**
 * `range` after dragging its `part` by `delta` seconds on a clip of `duration` seconds (0 or unknown: unbounded above):
 * the start can't pass the end nor go below 0, the end can't pass the start nor the clip's end, a move keeps the length and
 * stops at the ends. Snapped.
 */
export function dragRange(range: Pick<PoseRange, "from" | "to">, part: RangeDrag, delta: number, duration: number): { readonly from: number; readonly to: number } {
  const top = duration > 0 ? duration : Infinity;
  if (part === "start") return { from: snapTime(Math.min(Math.max(0, range.from + delta), range.to)), to: range.to };
  if (part === "end") return { from: range.from, to: snapTime(Math.max(range.from, Math.min(range.to + delta, top))) };
  const length = range.to - range.from;
  const from = Math.min(Math.max(0, range.from + delta), Math.max(0, top - length));
  return { from: snapTime(from), to: snapTime(from) + length };
}

/** The distinct tags of `sources` in order of first use: a tag's colour is its place here (`--series-N`). */
export function tagOrder(sources: readonly { readonly ranges: readonly PoseRange[] }[]): string[] {
  const out: string[] = [];
  for (const s of sources) for (const g of s.ranges) for (const t of g.tags) if (!out.includes(t)) out.push(t);
  return out;
}

/** The number of `--series-N` colours the theme has. */
export const TAG_COLORS = 7;

/** The colour slot (1..7) of a range: its first tag's place in `order`, or 0 for an untagged range. */
export const colorSlot = (order: readonly string[], range: Pick<PoseRange, "tags">): number => {
  const first = range.tags[0];
  if (first === undefined) return 0;
  const at = order.indexOf(first);
  return at < 0 ? 0 : (at % TAG_COLORS) + 1;
};

/** A range as text: "1.20–2.50 s" with its tags. */
export const rangeLabel = (r: PoseRange): string => `${r.from.toFixed(2)}–${r.to.toFixed(2)} s${r.tags.length ? ` ${r.tags.join(" ")}` : ""}`;

/** A time as the text of a number field (two decimals, no trailing zeros). */
export const timeText = (t: number): string => String(Math.round(t * 100) / 100);
