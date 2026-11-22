/**
 * Root note detection for a sample (ADR 0328 "detection of what's missing"; the Samples screen's Detect and the import's
 * "Detect what's missing"): YIN pitch tracking (de Cheveigné and Kawahara, 2002) over the sustained part of the sound.
 *
 * 1. The mono signal is low-passed and decimated to about 11 kHz (plenty for the 2 kHz top a root note is looked for
 *    under).
 * 2. Frames of 2× the longest period searched (40 Hz) step by 10 ms. Each frame's level is measured; frames quieter
 *    than 30 dB under the loudest, and the first 30 ms after the sound starts (the attack), are skipped; at most 120 of
 *    the rest, spread evenly, are tracked.
 * 3. On each frame YIN's cumulative mean normalised difference picks the first dip under 0.15 (else the deepest one)
 *    as the period, refined by parabolic interpolation and then on the full-rate signal (high notes have periods of a
 *    few decimated samples). A dip of 0.25 or more is unvoiced and skipped.
 * 4. The voiced frames' pitches, as fractional MIDI notes, give the root by their median: the nearest note and the
 *    cents from it (always within ±50).
 * 5. **Confidence** multiplies how many of the loud frames were voiced, how clean their dips were, and how steady
 *    their pitch was (the median distance from the median, in semitones): a held tone scores near 1, noise near 0.
 *
 * Pure; no plugin, no DOM.
 */
import { midiToNoteName } from "../noteNames";
import { monoOf, type InterleavedPcm } from "./mono";

export interface RootDetection {
  /** The nearest note, `C4` style (sharps). */
  readonly note: string;
  /** MIDI note number of `note`. */
  readonly midi: number;
  /** Fine tune from `note`, whole cents, −50..50. */
  readonly cents: number;
  /** The measured fundamental, Hz. */
  readonly hz: number;
  /** 0..1. */
  readonly confidence: number;
}

/** Below this the import's "Detect what's missing" leaves the root note unset. */
export const ROOT_CONFIDENCE_FLOOR = 0.5;

const MIN_HZ = 40;
const MAX_HZ = 2000;
const THRESHOLD = 0.15;
const UNVOICED = 0.25;
const MAX_SECONDS = 30;

/** The rate the analysis runs at, at least: decimation stops above it. */
const ANALYSIS_RATE = 11025;
/** At most this many frames are tracked, spread evenly over the loud ones. */
const MAX_FRAMES = 120;

/**
 * `mono` decimated by an integer factor to no less than `ANALYSIS_RATE`, with the rate it ends up at: a windowed-sinc
 * low-pass (31 taps, Blackman, cut at 0.45 of the new Nyquist) before keeping every factor-th sample.
 */
function decimate(mono: Float32Array, rate: number): { x: Float32Array; rate: number } {
  const factor = Math.max(1, Math.floor(rate / ANALYSIS_RATE));
  if (factor === 1) return { x: mono, rate };
  const taps = 31, mid = (taps - 1) / 2;
  const cut = 0.45 / factor; // cycles per input sample
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  const out = new Float32Array(Math.floor(mono.length / factor));
  for (let o = 0; o < out.length; o++) {
    const c = o * factor;
    let s = 0;
    for (let i = 0; i < taps; i++) {
      const k = c + i - mid;
      if (k >= 0 && k < mono.length) s += mono[k] * h[i];
    }
    out[o] = s / sum;
  }
  return { x: out, rate: rate / factor };
}

/** YIN on `x[from .. from + 2·maxLag)`: the period in samples and its dip, or null. `d` is scratch of maxLag + 1. */
function yinFrame(x: Float32Array, from: number, minLag: number, maxLag: number, d: Float64Array): { period: number; dip: number } | null {
  const w = maxLag;
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const diff = x[from + j] - x[from + j + tau];
      s += diff * diff;
    }
    running += s;
    d[tau] = running > 0 ? (s * tau) / running : 1;
  }
  let tau = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (d[t] < THRESHOLD) {
      while (t + 1 <= maxLag && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = minLag;
    for (let t = minLag + 1; t <= maxLag; t++) if (d[t] < d[best]) best = t;
    tau = best;
  }
  const dip = d[tau];
  if (dip >= UNVOICED) return null;
  let period = tau;
  if (tau > 1 && tau < maxLag) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const den = a - 2 * b + c;
    if (den > 1e-12) period = tau + (0.5 * (a - c)) / den;
  }
  return { period, dip };
}

/**
 * A period found at the decimated rate, refined on the full-rate signal `y` (frame start `from`, in full-rate samples):
 * the plain difference function's minimum within ±2 decimated samples of it, parabolically interpolated. High notes
 * have periods of a few decimated samples, too coarse alone.
 */
function refinePeriod(y: Float32Array, from: number, period: number, factor: number, window: number): number {
  if (factor === 1) return period;
  const centre = period * factor;
  const lo = Math.max(2, Math.floor(centre - 2 * factor)), hi = Math.ceil(centre + 2 * factor);
  if (from + window + hi + 1 >= y.length) return centre;
  const diff = (tau: number) => {
    let s = 0;
    for (let j = 0; j < window; j++) {
      const d = y[from + j] - y[from + j + tau];
      s += d * d;
    }
    return s;
  };
  const values: number[] = [];
  for (let tau = lo; tau <= hi; tau++) values.push(diff(tau));
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] < values[best]) best = i;
  if (best === 0 || best === values.length - 1) return lo + best;
  const a = values[best - 1], b = values[best], c = values[best + 1];
  const den = a - 2 * b + c;
  return lo + best + (den > 1e-12 ? (0.5 * (a - c)) / den : 0);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The root note of `input` (see the file header); null when no frame is loud and pitched enough to tell. */
export function detectRoot(input: InterleavedPcm): RootDetection | null {
  if (!(input.rate > 0)) return null;
  const full = monoOf(input, MAX_SECONDS);
  const { x, rate } = decimate(full, input.rate);
  const factor = Math.round(input.rate / rate);
  const maxLag = Math.ceil(rate / MIN_HZ);
  const minLag = Math.max(2, Math.floor(rate / MAX_HZ));
  const span = 2 * maxLag;
  const hop = Math.max(1, Math.round(rate * 0.01));
  if (x.length < span + 1) return null;

  // Frame levels (RMS over the analysis window), the loudest, and where the sound starts.
  const starts: number[] = [];
  const levels: number[] = [];
  for (let from = 0; from + span < x.length; from += hop) {
    let s = 0;
    for (let j = 0; j < maxLag; j++) s += x[from + j] * x[from + j];
    starts.push(from);
    levels.push(Math.sqrt(s / maxLag));
  }
  const loudest = Math.max(...levels);
  if (!(loudest > 1e-4)) return null;
  const floor = loudest * Math.pow(10, -30 / 20);
  const onset = starts[levels.findIndex((l) => l >= floor)] ?? 0;
  const attackEnd = onset + Math.round(rate * 0.03);

  const d = new Float64Array(maxLag + 1);
  const pitches: number[] = [];
  const dips: number[] = [];
  const candidates = starts.filter((s, i) => levels[i] >= floor && s >= attackEnd);
  const picked = candidates.length <= MAX_FRAMES ? candidates : Array.from({ length: MAX_FRAMES }, (_, k) => candidates[Math.floor((k * candidates.length) / MAX_FRAMES)]);
  const loud = picked.length;
  for (const from of picked) {
    const f = yinFrame(x, from, minLag, maxLag, d);
    if (!f) continue;
    const hz = input.rate / refinePeriod(full, from * factor, f.period, factor, maxLag * factor);
    if (hz < MIN_HZ || hz > MAX_HZ) continue;
    pitches.push(69 + 12 * Math.log2(hz / 440));
    dips.push(f.dip);
  }
  if (pitches.length === 0 || loud === 0) return null;
  const midiFloat = median(pitches);
  const spread = median(pitches.map((p) => Math.abs(p - midiFloat)));
  let midi = Math.round(midiFloat);
  let cents = Math.round((midiFloat - midi) * 100);
  if (cents > 50) (midi++, (cents -= 100));
  if (cents < -50) (midi--, (cents += 100));
  const note = midiToNoteName(midi);
  if (!note) return null;
  const voiced = pitches.length / loud;
  const clean = 1 - median(dips) / UNVOICED;
  const steady = Math.max(0, 1 - spread / 0.5);
  const confidence = Math.round(Math.max(0, Math.min(1, voiced * clean * steady)) * 100) / 100;
  return { note, midi, cents, hz: Math.round(440 * Math.pow(2, (midiFloat - 69) / 12) * 100) / 100, confidence };
}
