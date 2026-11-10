// Measuring and comparing parity renders (task A2.2c). Everything is in dB, and everything works on the f32 renders
// of one scene, so the same code digests the Chromium reference (the spec, and `reference.json`'s generation) and the
// core (the spec, and the Node test against the committed digests).
//
// A digest is what `reference.json` commits per scene: compact (a few hundred numbers, plus short sample windows for
// the scenes that carry them) yet enough to compare a render without a browser:
// - `bands`: the level of each 1/3-octave band from 63 Hz to 16 kHz (dBFS of the band's mean square) over the
//   analysed part of the render, per channel: the filter responses and the reverb's colour, the pan law's L and R;
// - `env`: the RMS of each 50 ms window of both channels (dBFS): the compressor's envelope, the reverb's decay;
// - `rmsDb`, `peakDb` per channel, and `peakIndex`: the pre-delay (a click's position);
// - `edc`: the reverb's energy decay curve, Schroeder's backward integral, every 100 ms;
// - `windows`: 64 samples from the start and 128 from half a second in, per channel, as base64 f32: the sample-level
//   check (a biquad's output matches to float precision, a compressor's to a fraction of a dB).
import type { Scene } from "./scenes";

// --- The tolerance ---------------------------------------------------------------------------------------------------

/**
 * ADR 0157 says parity is a null test "within the ADR's dB tolerance" (architecture §8, api-and-models §8) but states no
 * figure anywhere in the record or the design. These are the figures the harness enforces: 0.1 dB (a 1.2% amplitude
 * step, below what a listener hears as a level change) for every level measure, and a null of -90 dB (-80 for the
 * reverb, whose FFT convolution rounds differently) for the waveforms. Measured against Chromium 156 the core is
 * bit-identical for the biquad and compressor scenes (the ports run the same f32 operations), within 0.01 dB for the
 * reverb and the pan, so each ceiling leaves at least 10x room for another engine's rounding. Each is a ceiling on the
 * largest difference over the scene, in dB.
 *
 * - `levelDb`: an RMS or peak level, a band, an envelope window, a decay-curve point;
 * - `nullDb`: the residual of the sample windows relative to the reference (a null test: core minus reference), a
 *   ceiling in dB (more negative is closer);
 * - `peakFrames`: the position of the largest sample, in frames.
 */
export interface Tolerance {
  levelDb: number;
  nullDb: number;
  peakFrames: number;
}

export const TOLERANCES: Record<Scene["profile"], Tolerance> = {
  biquad: { levelDb: 0.1, nullDb: -90, peakFrames: 0 },
  compressor: { levelDb: 0.1, nullDb: -90, peakFrames: 0 },
  reverb: { levelDb: 0.1, nullDb: -80, peakFrames: 0 },
  pan: { levelDb: 0.1, nullDb: -90, peakFrames: 0 },
};

/** Differences below this in a stopband or a silent window are float noise, not parity: levels under it are not compared. */
export const FLOOR_DB = -90;

// --- Digest ----------------------------------------------------------------------------------------------------------

export interface Windows {
  onset: { l: string; r: string };
  mid: { l: string; r: string };
}

export interface Digest {
  rate: number;
  frames: number;
  bands: { l: number[]; r: number[] };
  env: number[];
  rmsDb: [number, number];
  peakDb: [number, number];
  peakIndex: number;
  edc?: number[];
  windows?: Windows;
}

export const BAND_CENTRES = Array.from({ length: 25 }, (_, i) => 1000 * Math.pow(2, (i - 12) / 3));
const FFT_SIZE = 8192;
const ENV_SECONDS = 0.05;
const EDC_STEP_SECONDS = 0.1;
export const ONSET_FRAMES = 64;
export const MID_FRAMES = 128;
export const MID_SECONDS = 0.5;

const round2 = (x: number): number => Math.round(x * 100) / 100;
const db = (power: number): number => 10 * Math.log10(Math.max(power, 1e-20));

/** In-place radix-2 complex FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** The 1/3-octave band levels (dBFS of the band's mean square) of `x[from..]`: averaged Hann periodograms, half overlap. */
export function bandLevels(x: Float32Array, from: number, rate: number): number[] {
  const hann = new Float64Array(FFT_SIZE);
  let energy = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
    energy += hann[i]! * hann[i]!;
  }
  const half = FFT_SIZE / 2;
  const power = new Float64Array(half + 1);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let blocks = 0;
  for (let at = from; at + FFT_SIZE <= x.length; at += half) {
    for (let i = 0; i < FFT_SIZE; i++) re[i] = x[at + i]! * hann[i]!;
    im.fill(0);
    fft(re, im);
    for (let k = 0; k <= half; k++) power[k]! += ((re[k]! * re[k]! + im[k]! * im[k]!) / (FFT_SIZE * energy)) * (k === 0 || k === half ? 1 : 2);
    blocks++;
  }
  const hz = rate / FFT_SIZE;
  const out: number[] = [];
  for (const fc of BAND_CENTRES) {
    const lo = fc * Math.pow(2, -1 / 6);
    const hi = fc * Math.pow(2, 1 / 6);
    let sum = 0;
    for (let k = 1; k < half; k++) {
      const f = k * hz;
      if (f >= lo && f < hi) sum += power[k]!;
    }
    out.push(round2(db(blocks ? sum / blocks : 0)));
  }
  return out;
}

const toBase64 = (a: Float32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
export const fromBase64 = (s: string): Float32Array => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/** Digest of one render. */
export function digest(scene: Scene, left: Float32Array, right: Float32Array): Digest {
  const rate = scene.rate;
  const frames = left.length;
  const from = Math.round(scene.analyzeFrom * rate);
  const win = Math.round(ENV_SECONDS * rate);
  const env: number[] = [];
  for (let at = 0; at + win <= frames; at += win) {
    let p = 0;
    for (let i = at; i < at + win; i++) p += left[i]! * left[i]! + right[i]! * right[i]!;
    env.push(round2(db(p / (2 * win))));
  }
  const rms = (x: Float32Array): number => {
    let p = 0;
    for (let i = from; i < x.length; i++) p += x[i]! * x[i]!;
    return db(p / Math.max(1, x.length - from));
  };
  let peakL = 0;
  let peakR = 0;
  let peakIndex = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.abs(left[i]!);
    if (a > peakL) {
      peakL = a;
      peakIndex = i;
    }
    peakR = Math.max(peakR, Math.abs(right[i]!));
  }
  const d: Digest = {
    rate,
    frames,
    bands: { l: bandLevels(left, from, rate), r: bandLevels(right, from, rate) },
    env,
    rmsDb: [round2(rms(left)), round2(rms(right))],
    peakDb: [round2(db(peakL * peakL)), round2(db(peakR * peakR))],
    peakIndex,
  };
  if (scene.edcFrom !== undefined) {
    const start = Math.round(scene.edcFrom * rate);
    const total = new Float64Array(frames + 1);
    for (let i = frames - 1; i >= 0; i--) total[i] = total[i + 1]! + (left[i]! * left[i]! + right[i]! * right[i]!) / 2;
    const ref = total[start]!;
    d.edc = [];
    for (let at = start; at < frames; at += Math.round(EDC_STEP_SECONDS * rate)) d.edc.push(round2(db(total[at]! / ref)));
  }
  if (scene.windows) {
    const mid = Math.round(MID_SECONDS * rate);
    d.windows = {
      onset: { l: toBase64(left.slice(0, ONSET_FRAMES)), r: toBase64(right.slice(0, ONSET_FRAMES)) },
      mid: { l: toBase64(left.slice(mid, mid + MID_FRAMES)), r: toBase64(right.slice(mid, mid + MID_FRAMES)) },
    };
  }
  return d;
}

// --- Comparison ------------------------------------------------------------------------------------------------------

/** Residual of `x` against reference `r` in dB: `10 log10(sum (x - r)^2 / sum r^2)`; `-Infinity` for an exact match (two silences too), `+Infinity` when only the reference is silent. */
export function nullDb(x: Float32Array, r: Float32Array): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < r.length; i++) {
    const d = x[i]! - r[i]!;
    num += d * d;
    den += r[i]! * r[i]!;
  }
  // A silent reference (below -200 dB) matches a render that is silent too: the equal-power gains at +-90 degrees leave 1e-17 in the far channel.
  if (den < 1e-20) return num < 1e-20 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (num === 0) return Number.NEGATIVE_INFINITY;
  return 10 * Math.log10(num / den);
}

export interface Measured {
  /** Largest |difference| over the compared bands (levels at or above `FLOOR_DB` in the reference), dB. */
  bandsDb: number;
  envDb: number;
  /** RMS and peak per channel. */
  levelsDb: number;
  edcDb: number;
  /** Worst (highest) null of the sample windows, dB; `-Infinity` for exact, NaN when the digests carry no windows. */
  windowsNullDb: number;
  peakFrames: number;
  /** The largest difference of all level measures (bands, env, levels, edc). */
  worstLevelDb: number;
}

const maxAbs = (xs: number[]): number => xs.reduce((m, x) => Math.max(m, x), 0);

/** Differences between a digest and the reference digest of the same scene. */
export function measure(got: Digest, ref: Digest): Measured {
  const bandDiffs: number[] = [];
  for (const ch of ["l", "r"] as const) {
    ref.bands[ch].forEach((level, i) => {
      if (level >= FLOOR_DB) bandDiffs.push(Math.abs(got.bands[ch][i]! - level));
    });
  }
  const envDiffs: number[] = [];
  ref.env.forEach((level, i) => {
    if (level >= FLOOR_DB) envDiffs.push(Math.abs((got.env[i] ?? -200) - level));
  });
  const levelDiffs: number[] = [];
  for (const k of [0, 1] as const) {
    if (ref.rmsDb[k] >= FLOOR_DB) levelDiffs.push(Math.abs(got.rmsDb[k] - ref.rmsDb[k]));
    if (ref.peakDb[k] >= FLOOR_DB) levelDiffs.push(Math.abs(got.peakDb[k] - ref.peakDb[k]));
  }
  const edcDiffs: number[] = [];
  ref.edc?.forEach((level, i) => {
    // The backward integral's last points are a sum of a few float-noise samples: compare to 50 dB down.
    if (level >= -50) edcDiffs.push(Math.abs((got.edc?.[i] ?? -200) - level));
  });
  let worstNull = Number.NaN; // NaN: the digests carry no windows
  if (ref.windows && got.windows) {
    for (const w of ["onset", "mid"] as const) {
      for (const ch of ["l", "r"] as const) {
        const n = nullDb(fromBase64(got.windows[w][ch]), fromBase64(ref.windows[w][ch]));
        worstNull = Number.isNaN(worstNull) ? n : Math.max(worstNull, n);
      }
    }
  }
  const m: Measured = {
    bandsDb: maxAbs(bandDiffs),
    envDb: maxAbs(envDiffs),
    levelsDb: maxAbs(levelDiffs),
    edcDb: maxAbs(edcDiffs),
    windowsNullDb: worstNull,
    peakFrames: Math.abs(got.peakIndex - ref.peakIndex),
    worstLevelDb: 0,
  };
  m.worstLevelDb = Math.max(m.bandsDb, m.envDb, m.levelsDb, m.edcDb);
  return m;
}

/** The failures of `m` against the scene's tolerance, as readable lines (empty when it passes). */
export function violations(scene: Scene, m: Measured): string[] {
  const tol = TOLERANCES[scene.profile];
  const out: string[] = [];
  const level = (what: string, v: number): void => {
    if (v > tol.levelDb) out.push(`${what} differs by ${v.toFixed(3)} dB (tolerance ${tol.levelDb})`);
  };
  level("band level", m.bandsDb);
  level("envelope", m.envDb);
  level("RMS or peak", m.levelsDb);
  level("decay curve", m.edcDb);
  if (m.windowsNullDb > tol.nullDb) out.push(`sample windows null at ${m.windowsNullDb.toFixed(1)} dB (tolerance ${tol.nullDb})`);
  if (scene.peakPosition && m.peakFrames > tol.peakFrames) out.push(`the peak is ${m.peakFrames} frames off (tolerance ${tol.peakFrames})`);
  return out;
}
