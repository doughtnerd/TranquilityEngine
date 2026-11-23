// The time maths of musical timing (ADR 0372; T72): which music boundary a play, travel or request waits for, when it
// is released, and how far into its clip a play starts. Pure functions over heard seconds (`Audio.time`'s base) and clip
// seconds; `../music.ts` reads the music through the audio plugin's public API and calls these.

/** Seconds of slack when comparing heard times (a float clock read twice gives the same boundary a hair apart). */
export const TIME_EPS = 1e-6;

/**
 * @internal The first point of a grid at or after `earliest`: `next` (the music's next grid point, heard seconds) moved on
 * by whole `period`s (seconds per beat or bar; the grid is taken as steady past `next`). NaN when there is none (a
 * non-finite `next`, or no usable period while `next` is too early).
 */
export function boundaryAtOrAfter(next: number, period: number, earliest: number): number {
  if (!Number.isFinite(next)) return Number.NaN;
  if (!Number.isFinite(earliest) || next >= earliest - TIME_EPS) return next;
  if (!Number.isFinite(period) || period <= 0) return Number.NaN;
  return next + Math.ceil((earliest - next) / period - TIME_EPS) * period;
}

/** @internal Seconds per `at` boundary: a beat at `tempo` (beats per minute), or a bar of `beatsPerBar` beats; NaN without a tempo. */
export function boundaryPeriod(at: "beat" | "bar", tempo: number, beatsPerBar: number): number {
  if (!Number.isFinite(tempo) || tempo <= 0) return Number.NaN;
  const beat = 60 / tempo;
  if (at === "beat") return beat;
  return Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beat * beatsPerBar : Number.NaN;
}

/**
 * @internal Seconds (heard) from a play's start to the first hit it reaches: the first hit at or after `start` playing
 * forward, the last at or before it playing backward. `hits` and `start` are clip seconds; null when it reaches none
 * (or `speed` is 0).
 */
export function hitLead(hits: readonly number[], start: number, speed: number): number | null {
  if (!Number.isFinite(speed) || speed === 0) return null;
  let best: number | null = null;
  for (const h of hits) {
    if (!Number.isFinite(h)) continue;
    const d = speed > 0 ? h - start : start - h;
    if (d >= -TIME_EPS && (best === null || d < best)) best = Math.max(0, d);
  }
  return best === null ? null : best / Math.abs(speed);
}

/** @internal Whether a play waiting for `target` (heard) and landing a point `lead` seconds into it is due at heard `now`. */
export function isDue(now: number, target: number, lead: number): boolean {
  return now >= target - lead - TIME_EPS;
}

/**
 * @internal Clip seconds to move a released play's start by: the heard seconds it is late (`now` past its release time
 * `releaseAt`) times `speed` (negative playing backward), plus `skip` heard seconds it starts in on purpose (a hit that
 * can't be waited for). 0 when it isn't late.
 */
export function startShift(now: number, releaseAt: number, speed: number, skip = 0): number {
  const late = Number.isFinite(now) && Number.isFinite(releaseAt) ? Math.max(0, now - releaseAt) : 0;
  const s = Number.isFinite(speed) ? speed : 1;
  return (late + Math.max(0, Number.isFinite(skip) ? skip : 0)) * s;
}
