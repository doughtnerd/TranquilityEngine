// Lanes for overlapping time spans (ADR 0172, the profiler's lane tracks): each span gets a row so that spans on one row
// never overlap. Greedy over spans sorted by start, the first row free at a span's start; a span past the row cap shares
// the last row and is counted. Pure.

/** A span on the time axis; `end` null runs on forever (an instance still playing). */
export interface LaneSpan {
  readonly start: number;
  readonly end: number | null;
}

/** The row of each span (in order), the rows used, and how many spans had to share the last row because of `max`. */
export function assignLanes(spans: readonly LaneSpan[], max: number): { lane: number[]; lanes: number; overflow: number } {
  const free: number[] = [];
  const lane: number[] = [];
  let overflow = 0;
  for (const s of spans) {
    let k = free.findIndex((end) => end <= s.start);
    if (k < 0) {
      if (free.length < max) {
        k = free.length;
        free.push(0);
      } else {
        k = free.length - 1;
        overflow++;
      }
    }
    free[k] = Math.max(free[k]!, s.end ?? Infinity);
    lane.push(k);
  }
  return { lane, lanes: free.length, overflow };
}
