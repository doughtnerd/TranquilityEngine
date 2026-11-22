// The Loop seam panel's model and other reads of a sample's decoded audio (the prototype's rules): the strip of a
// loop's end followed by its start (window `clamp((end − start) / 6, 40, 120 ms)`), the equal-power crossfade over it,
// the level jump in dB across the seam, and the nearest zero crossing for snapping. PCM is interleaved int16 or float.
// Pure.

export interface Pcm {
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
}

const frames = (p: Pcm) => Math.floor(p.pcm.length / p.channels);
const scaleOf = (p: Pcm) => (p.pcm instanceof Int16Array ? 1 / 32768 : 1);

/** Channel-mixed sample at frame `f` (0 outside the clip). */
export function sampleAt(p: Pcm, f: number): number {
  if (f < 0 || f >= frames(p)) return 0;
  let s = 0;
  for (let c = 0; c < p.channels; c++) s += p.pcm[f * p.channels + c];
  return (s / p.channels) * scaleOf(p);
}

/** The seam window, seconds. */
export const seamWindow = (start: number, end: number): number => Math.min(0.12, Math.max(0.04, (end - start) / 6));

/** RMS of frames [a, b), dBFS (−Infinity for silence). */
export function rmsDb(p: Pcm, a: number, b: number): number {
  const fa = Math.max(0, Math.floor(a * p.rate)), fb = Math.min(frames(p), Math.ceil(b * p.rate));
  if (fb <= fa) return -Infinity;
  let sum = 0;
  for (let f = fa; f < fb; f++) {
    const v = sampleAt(p, f);
    sum += v * v;
  }
  const ms = sum / (fb - fa);
  return ms > 0 ? 10 * Math.log10(ms) : -Infinity;
}

/**
 * The level jump across the seam: the RMS of the first 10 ms after the loop start minus that of the last 10 ms before
 * its end, dB (positive: the loop gets louder as it wraps). 0 when either side is silent.
 */
export function seamJump(p: Pcm, start: number, end: number): number {
  const w = Math.min(0.01, (end - start) / 4);
  if (!(w > 0)) return 0;
  const before = rmsDb(p, end - w, end), after = rmsDb(p, start, start + w);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return Math.round((after - before) * 10) / 10;
}

/** Equal-power crossfade gains at position `x` (0..1) through the fade: the outgoing and incoming. */
export const equalPower = (x: number): { out: number; in: number } => {
  const c = Math.min(1, Math.max(0, x));
  return { out: Math.cos((c * Math.PI) / 2), in: Math.sin((c * Math.PI) / 2) };
};

/**
 * The seam strip `points` wide: the window before the loop's end then the window after its start, as a −1..1 value
 * per point, with the crossfade (`crossfadeMs`, centred on the seam) applied. Returns the values and the seam's index.
 */
export function seamStrip(p: Pcm, start: number, end: number, crossfadeMs: number, points: number): { values: Float32Array; seam: number; window: number } {
  const w = seamWindow(start, end);
  const values = new Float32Array(Math.max(0, points));
  const half = Math.floor(points / 2);
  const xf = Math.min(w, crossfadeMs / 1000) / 2;
  for (let i = 0; i < points; i++) {
    // i < half: time before the end; i >= half: time after the start.
    const rel = ((i - half) / half) * w; // −w .. +w around the seam
    const out = sampleAt(p, Math.round((end + rel) * p.rate));
    const inc = sampleAt(p, Math.round((start + rel) * p.rate));
    let v: number;
    if (xf > 0 && Math.abs(rel) < xf) {
      const g = equalPower((rel + xf) / (2 * xf));
      v = out * g.out + inc * g.in;
    } else v = rel < 0 ? out : inc;
    values[i] = v;
  }
  return { values, seam: half, window: w };
}

/** The zero crossing nearest `t` within `within` seconds (default 5 ms), else `t`. */
export function nearestZeroCrossing(p: Pcm, t: number, within = 0.005): number {
  const f0 = Math.round(t * p.rate), reach = Math.round(within * p.rate);
  for (let d = 0; d <= reach; d++) {
    for (const f of d === 0 ? [f0] : [f0 - d, f0 + d]) {
      const a = sampleAt(p, f), b = sampleAt(p, f + 1);
      if (a === 0 || (a < 0) !== (b < 0)) return f / p.rate;
    }
  }
  return t;
}
