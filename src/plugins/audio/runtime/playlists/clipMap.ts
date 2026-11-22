/**
 * A sequence clip's time → sample time (ADR 0329 "Sequence"; the prototype's `geo`/`mapU`, SQ:1076–1083): the clip
 * plays its sample's **pickup** (from the offset to the first loop's start), the **first pass** (to the loop's end),
 * **further passes of the first loop** filling the clip's length, then the **tail** (from the loop's end to the sample's
 * end). So the clip's length sets the number of passes and the tail always ends the clip; a remainder too short for a
 * pass is silence after the tail. Without a loop (or with an offset past it) the clip plays the sample straight. A hold
 * point (a zero-length loop) holds at its time for the passes' share of the clip.
 *
 * The map is piecewise linear: each **piece** is a stretch of clip time that plays the sample without a jump (the pickup
 * with the first pass, each further pass, the tail), which is what one voice plays.
 *
 * Pure; no plugin state.
 */

/** Float noise allowed comparing seconds. */
const EPS = 1e-9;

export interface ClipGeometry {
  /** Clip length, seconds (resolved: a length of 0 is the rest of the sample from the offset, one pass). */
  readonly length: number;
  /** Sample seconds the clip starts at. */
  readonly offset: number;
  /** The sample's playable end (seconds); Infinity while unknown. */
  readonly sampleEnd: number;
  /** The first loop in sample seconds when the clip reaches it before its end; null: none. */
  readonly loop: { readonly start: number; readonly end: number } | null;
  /** Clip time the first pass ends at (the second pass or the tail starts). Equal to `length` without a loop. */
  readonly firstPassEnd: number;
  /** Further passes after the first (a hold point: 1 for the hold, or 0). */
  readonly extraPasses: number;
  /** Clip time the tail starts at. */
  readonly tailStart: number;
}

/** One stretch the sample plays without a jump: clip time `[from, to)` plays sample time from `sample` (null: silence or a hold). */
export interface ClipPiece {
  from: number;
  to: number;
  sample: number | null;
  /** The pass of the first loop it is (1 = the first pass with its pickup; 0 = no loop, the tail or silence). */
  pass: number;
}

/**
 * The geometry of a clip of `length` seconds (0: to the end) from sample `offset`, over a sample that ends at
 * `sampleEnd` (null: unknown) whose first loop is `loop` (null: none).
 */
export function clipGeometry(length: number, offset: number, sampleEnd: number | null, loop: { start: number; end: number } | null): ClipGeometry {
  const end = sampleEnd ?? Number.POSITIVE_INFINITY;
  const reached = loop !== null && (loop.end > loop.start ? offset < loop.end - EPS : offset <= loop.start + EPS);
  const usable = reached && loop!.end >= loop!.start && loop!.start < end ? loop : null;
  if (!usable) {
    const len = length > 0 ? length : Math.max(0, end - offset);
    return { length: len, offset, sampleEnd: end, loop: null, firstPassEnd: len, extraPasses: 0, tailStart: len };
  }
  const passLen = usable.end - usable.start;
  const firstPassEnd = Math.max(0, usable.end - offset); // pickup and the first pass
  const tail = Math.max(0, end - usable.end);
  const len = length > 0 ? length : firstPassEnd + (Number.isFinite(tail) ? tail : 0);
  const avail = len - firstPassEnd - (Number.isFinite(tail) ? tail : 0);
  let extra = 0;
  let holdFor = 0;
  if (passLen > EPS) extra = avail > 0 ? Math.floor(avail / passLen + 1e-9) : 0;
  else if (avail > 0) { extra = 1; holdFor = avail; }
  const tailStart = firstPassEnd + (passLen > EPS ? extra * passLen : holdFor);
  return { length: len, offset, sampleEnd: end, loop: { start: usable.start, end: usable.end }, firstPassEnd, extraPasses: extra, tailStart };
}

/** Sample seconds at clip time `u`, or null where the clip plays nothing (before it, past it, past the sample, a hold). */
export function sampleAt(g: ClipGeometry, u: number): number | null {
  const p = pieceAt(g, u);
  if (!p || p.sample === null) return null;
  return p.sample + (u - p.from);
}

/** The piece holding clip time `u` (null outside the clip). Writes into `out` when given. */
export function pieceAt(g: ClipGeometry, u: number, out: ClipPiece = { from: 0, to: 0, sample: null, pass: 0 }): ClipPiece | null {
  if (u < -EPS || u >= g.length - EPS) return null;
  const set = (from: number, to: number, sample: number | null, pass: number): ClipPiece => {
    out.from = from; out.to = Math.min(to, g.length); out.sample = sample; out.pass = pass;
    // Past the sample's end: silence to the clip's end.
    if (sample !== null && sample + (out.to - from) > g.sampleEnd + EPS) {
      const audible = g.sampleEnd - sample;
      if (u - from >= audible - EPS) { out.from = from + Math.max(0, audible); out.sample = null; out.pass = 0; }
      else out.to = from + audible;
    }
    return out;
  };
  const loop = g.loop;
  if (!loop) return set(0, g.length, g.offset, 0);
  if (u < g.firstPassEnd - EPS) return set(0, g.firstPassEnd, g.offset, 1);
  if (u < g.tailStart - EPS) {
    const passLen = loop.end - loop.start;
    if (passLen <= EPS) return set(g.firstPassEnd, g.tailStart, null, 2); // a hold: nothing plays while held
    const k = Math.floor((u - g.firstPassEnd) / passLen + 1e-9);
    const from = g.firstPassEnd + k * passLen;
    return set(from, from + passLen, loop.start, k + 2);
  }
  return set(g.tailStart, g.length, loop.end, 0);
}

/**
 * Every clip time in `[from, to)` at which the sample plays sample time `s` (a marker), in order, into `out`. A time in
 * the loop is heard once per pass.
 */
export function clipTimesOf(g: ClipGeometry, s: number, from: number, to: number, out: number[]): number[] {
  const push = (u: number): void => { if (u >= from - EPS && u < to - EPS && u < g.length - EPS) out.push(u); };
  const loop = g.loop;
  if (!loop) {
    if (s >= g.offset - EPS && s < g.sampleEnd) push(s - g.offset);
    return out;
  }
  if (s >= g.offset - EPS && s < loop.end - EPS) push(s - g.offset);
  const passLen = loop.end - loop.start;
  if (passLen > EPS && s >= loop.start - EPS && s < loop.end - EPS) {
    for (let k = 0; k < g.extraPasses; k++) push(g.firstPassEnd + k * passLen + (s - loop.start));
  }
  if (s >= loop.end - EPS && s < g.sampleEnd) push(g.tailStart + (s - loop.end));
  return out;
}
