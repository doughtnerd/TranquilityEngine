// Source time and timeline time (ADR 0328): every time in a sample block is seconds in the source file, and closing
// a gap (`closedGaps`, `[sourceStart, length]`) removes that span from what plays. The timeline shows the edited
// sample, so it draws at `toView(source)` and turns a pointer back with `toSource(view)` (the prototype's `toSrc`).
// Pure.
import type { SampleEdits } from "../../../engine/audio/sample/types";

type Gaps = readonly (readonly [number, number])[];

const sorted = (gaps: Gaps): (readonly [number, number])[] => [...gaps].sort((a, b) => a[0] - b[0]);

/** Seconds removed by closed gaps. */
export const removedSeconds = (gaps: Gaps): number => gaps.reduce((n, g) => n + g[1], 0);

/** The edited sample's length: the source's minus the closed gaps. */
export const editedLength = (sourceLength: number, gaps: Gaps): number => Math.max(0, sourceLength - removedSeconds(gaps));

/** A source time on the timeline. A time inside a closed gap sits at the join. */
export function toView(t: number, gaps: Gaps): number {
  let shift = 0;
  for (const [start, len] of sorted(gaps)) {
    if (t >= start + len) shift += len;
    else if (t > start) shift += t - start;
  }
  return t - shift;
}

/** A timeline time in the source. The join of a closed gap is the audio after it. */
export function toSource(v: number, gaps: Gaps): number {
  let t = v;
  for (const [start, len] of sorted(gaps)) {
    if (start <= t) t += len;
    else break;
  }
  return t;
}

/** True when the source time `t` lies in a closed gap (its audio no longer plays). */
export const inClosedGap = (t: number, gaps: Gaps): boolean => gaps.some(([s, l]) => t > s && t < s + l);

/** The trim as source seconds (the whole file when there's none). */
export const trimOf = (e: Pick<SampleEdits, "trim">, sourceLength: number): readonly [number, number] => e.trim ?? [0, sourceLength];
