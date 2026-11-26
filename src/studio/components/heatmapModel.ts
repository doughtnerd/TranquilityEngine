// Play-count heat (experimental; the Take and Profiler timelines' Heatmap toggle): how often each sound played in one
// recording, placed between the least and the most played, so the timeline can recolour its bars from cold (played
// fewest times) to hot (played most). A sound is whatever key the caller groups by (a take's playlist path, a capture's clip). Pure.

/** One sound's play count and its heat, 0 (fewest) to 1 (most). */
export interface Heat {
  readonly count: number;
  readonly heat: number;
}

/**
 * The heat of each key in `keys` (one entry per play): where its count falls between the least played key's (0) and the
 * most played key's (1). With every key played equally often there is nothing to tell apart, and each is 0.
 */
export function heatByKey(keys: Iterable<string>): ReadonlyMap<string, Heat> {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return heatOfCounts(counts);
}

/** The heat of keys whose counts are already known. */
export function heatOfCounts(counts: ReadonlyMap<string, number>): ReadonlyMap<string, Heat> {
  let min = Infinity;
  let max = 0;
  for (const c of counts.values()) {
    min = Math.min(min, c);
    max = Math.max(max, c);
  }
  const out = new Map<string, Heat>();
  for (const [k, count] of counts) out.set(k, { count, heat: max > min ? (count - min) / (max - min) : 0 });
  return out;
}

/** "played 12 times" for a tooltip. */
export const heatText = (h: Heat): string => `played ${h.count === 1 ? "once" : `${h.count} times`}`;
