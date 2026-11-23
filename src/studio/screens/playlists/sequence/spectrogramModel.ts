// A clip's spectrogram as the Sequence timeline draws it (proto A4 "Spectrogram: 6 bands at stepped opacity", spec
// §4.2.9; decision: spectrogram is to be built): for each column of a span of the decoded sample, the level in six
// octave-wide bands (low to high), from a Hann-windowed FFT around the column's middle, as 0..1 over a 60 dB range.
// Pure (the view hands it the decoded PCM).
import type { Pcm } from "../../samples/seam";

/** The bands' lower edges in Hz (the last runs to Nyquist). */
export const SPECTRO_BANDS = [60, 250, 500, 1000, 2000, 4000] as const;
const WINDOW = 1024;
const FLOOR_DB = -60;

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
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
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi, xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

/**
 * Band levels for `columns` columns over file time `[start, end)` seconds: `columns × 6` values, column by column,
 * low band first, each 0 (−60 dB or quieter) .. 1 (full scale).
 */
export function spectrogramBands(p: Pcm, start: number, end: number, columns: number): Float32Array {
  const out = new Float32Array(Math.max(0, columns) * SPECTRO_BANDS.length);
  const frames = Math.floor(p.pcm.length / p.channels);
  if (columns <= 0 || frames === 0 || end <= start) return out;
  const scale = p.pcm instanceof Int16Array ? 1 / 32768 : 1;
  const re = new Float64Array(WINDOW), im = new Float64Array(WINDOW);
  const binHz = p.rate / WINDOW;
  for (let c = 0; c < columns; c++) {
    const mid = Math.floor((start + ((c + 0.5) / columns) * (end - start)) * p.rate);
    for (let i = 0; i < WINDOW; i++) {
      const f = mid - WINDOW / 2 + i;
      const v = f >= 0 && f < frames ? p.pcm[f * p.channels]! * scale : 0;
      re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < SPECTRO_BANDS.length; b++) {
      const lo = Math.max(1, Math.floor(SPECTRO_BANDS[b]! / binHz));
      const hi = b + 1 < SPECTRO_BANDS.length ? Math.floor(SPECTRO_BANDS[b + 1]! / binHz) : WINDOW / 2;
      let e = 0;
      for (let k = lo; k < Math.max(lo + 1, hi); k++) e = Math.max(e, Math.hypot(re[k]!, im[k]!));
      // A full-scale sine peaks at about WINDOW / 4 through the Hann window.
      const db = 20 * Math.log10(Math.max(1e-9, e / (WINDOW / 4)));
      out[c * SPECTRO_BANDS.length + b] = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
    }
  }
  return out;
}
