// Measuring the core's HRTF against Chromium's (H4; ADR 0157, api-and-models §8 "Web Audio parity"). Built on
// `analysis.ts`: the same digest (band levels, envelope, RMS and peak per ear), plus what an HRTF is for:
// - the interaural level difference (ILD, dB): left RMS minus right RMS;
// - the interaural time difference (ITD, frames): the lag of the right ear behind the left, from the cross-correlation
//   of the two ears' noise (parabolic peak, so a fraction of a frame);
// - a sample window of each ear, committed with the digest, for the null test (core minus reference, relative to the
//   reference) without a browser.
// Both renders are already aligned by the scene's `referenceLatency` (see `hrtfScenes.ts`).
import { digest, fromBase64, measure, nullDb, type Digest } from "./analysis";
import type { Scene } from "./scenes";

/** Frames of the committed sample window, taken from `WINDOW_SECONDS` into the render (past the crossfade). */
export const HRTF_WINDOW_FRAMES = 2048;
export const HRTF_WINDOW_SECONDS = 0.3;
/** The ITD search range, frames either way (the largest ITD of the table is about 40 frames at 48 kHz). */
const MAX_LAG = 80;

export interface HrtfDigest {
  digest: Digest;
  /** Right ear behind left, in frames (negative: the right ear leads). */
  itdFrames: number;
  /** Left RMS minus right RMS, dB, over the analysed part. */
  ildDb: number;
  window: { l: string; r: string };
}

const toBase64 = (a: Float32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

/** The lag, in frames, at which `r` best matches `l` delayed (`r[n] ~ l[n - lag]`), by cross-correlation over `from..` with a parabolic peak. */
export function itdFrames(l: Float32Array, r: Float32Array, from: number): number {
  const n = Math.min(l.length, r.length) - MAX_LAG;
  const corr = new Float64Array(2 * MAX_LAG + 1);
  for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
    let sum = 0;
    for (let i = from + MAX_LAG; i < n; i++) sum += r[i]! * l[i - lag]!;
    corr[lag + MAX_LAG] = sum;
  }
  let best = 0;
  for (let k = 1; k < corr.length; k++) if (corr[k]! > corr[best]!) best = k;
  if (best === 0 || best === corr.length - 1) return best - MAX_LAG;
  const a = corr[best - 1]!;
  const b = corr[best]!;
  const c = corr[best + 1]!;
  const denom = a - 2 * b + c;
  return best - MAX_LAG + (denom === 0 ? 0 : (0.5 * (a - c)) / denom);
}

const rmsDb = (x: Float32Array, from: number): number => {
  let p = 0;
  for (let i = from; i < x.length; i++) p += x[i]! * x[i]!;
  return 10 * Math.log10(Math.max(p / Math.max(1, x.length - from), 1e-20));
};

/** What `hrtf-reference.json` commits per scene (and what the core's render is reduced to for comparison). */
export function hrtfDigest(scene: Scene, left: Float32Array, right: Float32Array): HrtfDigest {
  const from = Math.round(scene.analyzeFrom * scene.rate);
  const at = Math.round(HRTF_WINDOW_SECONDS * scene.rate);
  // The digest covers the analysed part only: the core's voice crossfades from equal-power into HRTF over the first 45 ms,
  // which would show in the envelope and peak, and the reference has no such start.
  const analysed = { ...scene, analyzeFrom: 0, windows: false, edcFrom: undefined };
  return {
    digest: digest(analysed, left.slice(from), right.slice(from)),
    itdFrames: Math.round(itdFrames(left, right, from) * 1000) / 1000,
    ildDb: Math.round((rmsDb(left, from) - rmsDb(right, from)) * 1000) / 1000,
    window: { l: toBase64(left.slice(at, at + HRTF_WINDOW_FRAMES)), r: toBase64(right.slice(at, at + HRTF_WINDOW_FRAMES)) },
  };
}

/**
 * The HRTF parity tolerances. Each is a ceiling on a difference between the core and Chromium for one scene:
 * - `levelDb`: any band, envelope window, RMS or peak level (dB), as `analysis.ts`;
 * - `ildDb`: the interaural level difference;
 * - `itdFrames`: the interaural time difference;
 * - `nullDb`: the residual of the committed sample window (and, in the spec, of the whole aligned render), worse ear,
 *   relative to the reference (dB).
 *
 * The owner's figures (0.1 dB, -90 dB: `TOLERANCES` in `analysis.ts`) hold for the biquad, compressor and pan scenes, which
 * run the same f32 operations in both engines. They do not hold for HRTF, which differs from Chromium's in two ways (build
 * log, H4): at 44.1 kHz, the table's own rate, the levels, ILD and ITD agree to 0.01 dB and 0.001 frames but the waveforms
 * null only to -40...-73 dB; at 48 kHz (the table is resampled, Chromium and the core by different resamplers) the response
 * differs by up to 5.7 dB in a band, 3.2 dB in ILD (median 0.8), 1.1 frames in ITD, and the waveforms null to only -5...-21 dB.
 * So the HRTF tolerance is per rate, `HRTF_TOLERANCES`: 44.1 kHz at 0.1 dB / 0.1 frames / -35 dB (the owner's level figure,
 * a looser null), 48 kHz a regression guard a little above what was measured (it fails if the core moves further from
 * Chromium, not if it matches better). The coordinator decides whether these stand.
 */
export interface HrtfTolerance {
  levelDb: number;
  ildDb: number;
  itdFrames: number;
  nullDb: number;
}

export const HRTF_TOLERANCES: Record<number, HrtfTolerance> = {
  44_100: { levelDb: 0.1, ildDb: 0.1, itdFrames: 0.1, nullDb: -35 },
  48_000: { levelDb: 8, ildDb: 4, itdFrames: 1.5, nullDb: -3 },
};

/** The core's tolerance for a scene's rate. */
export const hrtfTolerance = (rate: number): HrtfTolerance => HRTF_TOLERANCES[rate] ?? HRTF_TOLERANCES[48_000]!;

/** Chromium against its own committed digest (same engine, same build): the owner's figures. */
export const HRTF_DRIFT_TOLERANCE: HrtfTolerance = { levelDb: 0.1, ildDb: 0.1, itdFrames: 0.1, nullDb: -90 };

export interface HrtfMeasured {
  /** `analysis.ts`'s `worstLevelDb` (bands, envelope, RMS and peak). */
  worstLevelDb: number;
  bandsDb: number;
  levelsDb: number;
  ildDb: number;
  itdFrames: number;
  /** Worst ear's null of the committed window, dB. */
  windowNullDb: number;
  /** Per ear nulls of the window, dB. */
  windowNullLR: [number, number];
}

export function hrtfMeasure(got: HrtfDigest, ref: HrtfDigest): HrtfMeasured {
  const m = measure(got.digest, ref.digest);
  const nl = nullDb(fromBase64(got.window.l), fromBase64(ref.window.l));
  const nr = nullDb(fromBase64(got.window.r), fromBase64(ref.window.r));
  return {
    worstLevelDb: m.worstLevelDb,
    bandsDb: m.bandsDb,
    levelsDb: m.levelsDb,
    ildDb: Math.abs(got.ildDb - ref.ildDb),
    itdFrames: Math.abs(got.itdFrames - ref.itdFrames),
    windowNullDb: Math.max(nl, nr),
    windowNullLR: [nl, nr],
  };
}

export function hrtfViolations(m: HrtfMeasured, tol: HrtfTolerance): string[] {
  const out: string[] = [];
  if (m.worstLevelDb > tol.levelDb) out.push(`a level differs by ${m.worstLevelDb.toFixed(3)} dB (tolerance ${tol.levelDb})`);
  if (m.ildDb > tol.ildDb) out.push(`the interaural level difference differs by ${m.ildDb.toFixed(3)} dB (tolerance ${tol.ildDb})`);
  if (m.itdFrames > tol.itdFrames) out.push(`the interaural time difference differs by ${m.itdFrames.toFixed(3)} frames (tolerance ${tol.itdFrames})`);
  if (m.windowNullDb > tol.nullDb) out.push(`the sample window null is ${m.windowNullDb.toFixed(1)} dB (tolerance ${tol.nullDb})`);
  return out;
}
