/**
 * Tempo detection for a sample (ADR 0342 "detection of what's missing"; the Samples screen's Detect and the import's
 * "Detect what's missing").
 *
 * 1. **Onset strength.** The mono signal's log-compressed magnitude spectrum (Hann frames of ~23 ms, a ~6 ms hop); the
 *    spectral flux (the sum of each bin's rise since the frame before) is the onset envelope. A moving average is taken
 *    off (what is left is how much louder than its surroundings a frame is), negatives cut, and it is smoothed a little.
 * 2. **Periodicity.** The envelope's autocorrelation (by FFT), normalised by its zero lag. A tempo `T` scores the mean
 *    autocorrelation at the first four multiples of its beat period (a comb filter), so a real pulse scores at every
 *    multiple and a half-tempo alias misses every other one.
 * 3. **Choosing.** The scores are weighted by a broad log-normal tempo prior around 120 BPM (σ = 1.5 octaves) to break
 *    the octave tie a comb leaves between `T` and `T/2`; the best is refined to 0.01 BPM. Half and double the tempo are
 *    returned as candidates with their own confidence, since the octave is a matter of feel.
 * 4. **Confidence** is how far the best comb score stands above the median score of every tempo tried, scaled to 0..1:
 *    a click track scores near 1, noise and one-shots near 0.
 * 5. **Tempo map.** For a file of 30 s or more, 10 s windows (5 s apart) are scored near the global tempo; when two or
 *    more confident windows in a row settle on a tempo more than 3 % away from the windows before them, the change goes
 *    into `map` (on the nearest beat of the tempo before it). One tempo throughout gives an empty map.
 *
 * Pure; no plugin, no DOM.
 */
import { SAMPLE_LIMITS } from "../format";
import type { TempoMarker } from "../types";
import { fftInPlace, MagnitudeSpectrum, nextPowerOfTwo } from "./fft";
import { monoOf, type InterleavedPcm } from "./mono";

export interface TempoCandidate {
  readonly bpm: number;
  /** 0..1, on the same scale as the detection's. */
  readonly confidence: number;
  readonly relation: "half" | "double";
}

export interface TempoDetection {
  /** Beats per minute, two decimals. */
  readonly bpm: number;
  /** 0..1: how clearly one pulse stands out. */
  readonly confidence: number;
  /** Half and double the tempo, where they are inside the sample format's tempo limits. */
  readonly candidates: readonly TempoCandidate[];
  /** Tempo changes after the start (empty when the file keeps one tempo, or is too short to tell). */
  readonly map: readonly TempoMarker[];
}

/** Below this the import's "Detect what's missing" leaves the tempo unset. */
export const TEMPO_CONFIDENCE_FLOOR = 0.35;

const MIN_BPM = 30;
const MAX_BPM = 300;
const PRIOR_CENTRE = 120;
const PRIOR_SIGMA_OCTAVES = 1.5;
const MULTIPLES = 4;
/** The longest stretch analysed, seconds. */
const MAX_SECONDS = 600;

interface Envelope {
  readonly values: Float64Array;
  /** Seconds per envelope frame. */
  readonly hop: number;
}

/** The onset strength envelope of `mono` at `rate`. */
function onsetEnvelope(mono: Float32Array, rate: number): Envelope {
  const size = nextPowerOfTwo(Math.max(256, Math.round(rate * 0.023)));
  const hopFrames = size / 4;
  const count = Math.max(0, Math.floor((mono.length - size) / hopFrames) + 1);
  const bins = size / 2 + 1;
  const spec = new MagnitudeSpectrum(size);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    spec.analyse(mono, f * hopFrames, cur);
    let sum = 0;
    for (let b = 1; b < bins; b++) {
      const v = Math.log1p(1000 * cur[b]);
      cur[b] = v;
      if (f > 0) {
        const d = v - prev[b];
        if (d > 0) sum += d;
      }
    }
    flux[f] = sum;
    const t = prev; prev = cur; cur = t;
  }
  // Take off a ~0.5 s moving average, keep the rises, smooth with a short Gaussian (σ ≈ 2 frames).
  const hop = hopFrames / rate;
  const half = Math.max(1, Math.round(0.25 / hop));
  const out = new Float64Array(count);
  let acc = 0;
  for (let i = 0; i < Math.min(count, half); i++) acc += flux[i];
  for (let i = 0; i < count; i++) {
    const hi = i + half, lo = i - half - 1;
    if (hi < count) acc += flux[hi];
    if (lo >= 0) acc -= flux[lo];
    const n = Math.min(count - 1, hi) - Math.max(0, i - half) + 1;
    out[i] = Math.max(0, flux[i] - acc / n);
  }
  const kernel = [0.054, 0.242, 0.399, 0.242, 0.054];
  const smooth = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < count) s += out[j] * kernel[k + 2];
    }
    smooth[i] = s;
  }
  return { values: smooth, hop };
}

/** The autocorrelation of `x` (mean removed) at lags 0..maxLag, normalised so lag 0 is 1 (all 0 for a flat signal). */
function autocorrelation(x: Float64Array, maxLag: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(maxLag + 1);
  if (n === 0) return out;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const size = nextPowerOfTwo(2 * n);
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = x[i] - mean;
  fftInPlace(re, im);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fftInPlace(re, im); // the power spectrum is real and even, so a forward transform is the inverse up to scale
  const zero = re[0];
  if (!(zero > 1e-12)) return out;
  for (let l = 0; l <= maxLag && l < size; l++) out[l] = re[l] / zero;
  return out;
}

/** `r` at a fractional lag, linearly interpolated (0 past the end). */
function at(r: Float64Array, lag: number): number {
  const i = Math.floor(lag);
  if (i < 0 || i + 1 >= r.length) return 0;
  const f = lag - i;
  return r[i] * (1 - f) + r[i + 1] * f;
}

/** The comb score of `bpm`: the mean autocorrelation at the first `MULTIPLES` beat periods. */
function comb(r: Float64Array, hop: number, bpm: number): number {
  const lag = 60 / (bpm * hop);
  let s = 0;
  for (let k = 1; k <= MULTIPLES; k++) s += Math.max(0, at(r, k * lag));
  return s / MULTIPLES;
}

const prior = (bpm: number, centre: number, sigma: number): number => {
  const o = Math.log2(bpm / centre) / sigma;
  return Math.exp(-0.5 * o * o);
};

interface Scored {
  readonly bpm: number;
  readonly score: number;
  readonly confidence: number;
}

/** The best tempo of an envelope stretch, between `lo` and `hi` BPM, with a prior around `centre`. */
function bestTempo(env: Float64Array, hop: number, lo: number, hi: number, centre: number, sigma: number): { best: Scored; r: Float64Array; scoreOf(bpm: number): number; confidenceOf(score: number): number } | null {
  const maxLag = Math.ceil((60 / (lo * hop)) * MULTIPLES) + 2;
  // A tempo needs at least two of its multiples inside the stretch to be judged.
  const usableHi = hi;
  const usableLo = Math.max(lo, 60 / ((env.length * hop) / 2));
  if (env.length < 8 || usableLo >= usableHi) return null;
  const r = autocorrelation(env, Math.min(maxLag, env.length - 1));
  const scores: number[] = [];
  let best = { bpm: 0, weighted: -1 };
  for (let bpm = usableLo; bpm <= usableHi; bpm += 0.25) {
    const s = comb(r, hop, bpm);
    scores.push(s);
    const w = s * prior(bpm, centre, sigma);
    if (w > best.weighted) best = { bpm, weighted: w };
  }
  if (best.weighted <= 0) return null;
  // Refine to 0.01 BPM around the best grid point.
  let refined = best.bpm, refinedScore = comb(r, hop, best.bpm);
  for (let bpm = Math.max(usableLo, best.bpm - 0.5); bpm <= Math.min(usableHi, best.bpm + 0.5); bpm += 0.01) {
    const s = comb(r, hop, bpm);
    if (s > refinedScore) {
      refinedScore = s;
      refined = bpm;
    }
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const confidenceOf = (score: number) => Math.max(0, Math.min(1, (score - median) / Math.max(1e-9, 0.6 * (1 - median))));
  return {
    best: { bpm: refined, score: refinedScore, confidence: confidenceOf(refinedScore) },
    r,
    scoreOf: (bpm) => comb(r, hop, bpm),
    confidenceOf,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The tempo changes the windows of `env` show around `global` BPM, and the tempo before the first change (null with no
 * clear change).
 */
function tempoMap(env: Envelope, global: number): { base: number; map: TempoMarker[] } | null {
  const total = env.values.length * env.hop;
  if (total < 30) return null;
  const win = Math.round(10 / env.hop), step = Math.round(5 / env.hop);
  const windows: { at: number; bpm: number; confident: boolean }[] = [];
  for (let from = 0; from + win <= env.values.length; from += step) {
    const found = bestTempo(env.values.subarray(from, from + win), env.hop, global / 1.5, global * 1.5, global, 0.3);
    if (found) windows.push({ at: from * env.hop, bpm: found.best.bpm, confident: found.best.confidence >= 0.5 });
  }
  // Runs of confident windows with one tempo (within 3 % of the run's first).
  const runs: { at: number; bpms: number[] }[] = [];
  for (const w of windows) {
    if (!w.confident) continue;
    const last = runs[runs.length - 1];
    if (last && Math.abs(w.bpm / last.bpms[0] - 1) <= 0.03) last.bpms.push(w.bpm);
    else runs.push({ at: w.at, bpms: [w.bpm] });
  }
  const steady = runs.filter((r) => r.bpms.length >= 2);
  if (steady.length < 2) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out: TempoMarker[] = [];
  let prevBpm = mean(steady[0].bpms), prevAt = 0;
  for (const run of steady.slice(1)) {
    const bpm = round2(mean(run.bpms));
    if (Math.abs(bpm / prevBpm - 1) <= 0.03) continue;
    // A window starting at `run.at` holds the change somewhere in its first half: put it at the window's middle-ish
    // start, on the previous tempo's nearest beat.
    const beat = 60 / prevBpm;
    const at = round2(prevAt + Math.round((run.at + 2.5 - prevAt) / beat) * beat);
    if (at <= prevAt) continue;
    out.push({ at, bpm, meter: "4/4" });
    prevBpm = bpm;
    prevAt = at;
  }
  return out.length ? { base: round2(mean(steady[0].bpms)), map: out } : null;
}

/** The tempo of `input` (see the file header); null when the audio is too short or silent to tell anything. */
export function detectTempo(input: InterleavedPcm): TempoDetection | null {
  if (!(input.rate > 0)) return null;
  const mono = monoOf(input, MAX_SECONDS);
  const env = onsetEnvelope(mono, input.rate);
  const found = bestTempo(env.values, env.hop, MIN_BPM, MAX_BPM, PRIOR_CENTRE, PRIOR_SIGMA_OCTAVES);
  if (!found) return null;
  const { best } = found;
  const candidates: TempoCandidate[] = [];
  for (const [relation, factor] of [["half", 0.5], ["double", 2]] as const) {
    const bpm = best.bpm * factor;
    if (bpm < SAMPLE_LIMITS.minBpm || bpm > SAMPLE_LIMITS.maxBpm) continue;
    candidates.push({ bpm: round2(bpm), confidence: round2(found.confidenceOf(found.scoreOf(bpm))), relation });
  }
  const clamped = Math.min(SAMPLE_LIMITS.maxBpm, Math.max(SAMPLE_LIMITS.minBpm, best.bpm));
  // With changes, the base tempo is the tempo before the first one.
  const changes = best.confidence >= 0.5 ? tempoMap(env, clamped) : null;
  return { bpm: changes ? changes.base : round2(clamped), confidence: round2(best.confidence), candidates, map: changes?.map ?? [] };
}
