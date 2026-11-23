// Peaks and spectrogram from decoded PCM, for drawing a render the screen made itself (the waveform after the baked
// effects, spec §4.1.6) and the Spectrogram view: a peaks pyramid in the decoder's own shape (`PeakMips`, int16
// `[min, max]` pairs per bin, channel-major) and a short-time spectrum over a span, as magnitudes in log-spaced
// frequency bands scaled 0..1 (−80 dB to 0 dB). Pure.
import { buildMips, type PeakMips } from "../../../plugins/audio/editor/music/peaksMip";

/** Interleaved PCM: int16 or float (−1..1). */
export interface PcmFrames {
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
}

const sampleAt = (p: PcmFrames, i: number): number => (p.pcm instanceof Int16Array ? p.pcm[i] / 32768 : p.pcm[i]);

/** The peaks pyramid of `p`, `binFrames` frames to a base bin. */
export function peaksOfPcm(p: PcmFrames, binFrames = 256): PeakMips {
  const ch = Math.max(1, p.channels);
  const frames = Math.floor(p.pcm.length / ch);
  const bins = Math.ceil(frames / binFrames);
  const data = new Int16Array(ch * bins * 2);
  for (let c = 0; c < ch; c++) {
    for (let b = 0; b < bins; b++) {
      let lo = Infinity, hi = -Infinity;
      const end = Math.min(frames, (b + 1) * binFrames);
      for (let f = b * binFrames; f < end; f++) {
        const v = sampleAt(p, f * ch + c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const at = (c * bins + b) * 2;
      data[at] = Math.max(-32768, Math.min(32767, Math.round(lo * 32767)));
      data[at + 1] = Math.max(-32768, Math.min(32767, Math.round(hi * 32767)));
    }
  }
  return { rate: p.rate, channels: ch, frames, levels: buildMips({ binFrames, bins, channels: ch, data }) };
}

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export interface Spectrogram {
  readonly columns: number;
  /** Frequency bands, low to high. */
  readonly bands: number;
  /** `columns × bands`, column-major (column 0's bands, then column 1's), each 0..1. */
  readonly level: Float32Array;
}

/** The lowest band's lower edge, Hz. */
const LOW_HZ = 40;
const FLOOR_DB = -80;

/**
 * The spectrum of `p` over `[from, to]` seconds in `columns` columns and `bands` log-spaced bands (40 Hz to Nyquist):
 * each column a 1024-point Hann-windowed FFT of the channels' mix centred on it.
 */
export function spectrogram(p: PcmFrames, from: number, to: number, columns: number, bands: number, size = 1024): Spectrogram {
  const ch = Math.max(1, p.channels);
  const frames = Math.floor(p.pcm.length / ch);
  const level = new Float32Array(Math.max(0, columns * bands));
  const re = new Float64Array(size), im = new Float64Array(size);
  const nyquist = p.rate / 2;
  const edges = Array.from({ length: bands + 1 }, (_, i) => LOW_HZ * Math.pow(nyquist / LOW_HZ, i / bands));
  const binOf = (hz: number) => Math.min(size / 2, Math.max(1, Math.round((hz / p.rate) * size)));
  for (let c = 0; c < columns; c++) {
    const centre = Math.round((from + ((c + 0.5) / columns) * (to - from)) * p.rate);
    for (let k = 0; k < size; k++) {
      const f = centre - size / 2 + k;
      let v = 0;
      if (f >= 0 && f < frames) for (let j = 0; j < ch; j++) v += sampleAt(p, f * ch + j);
      re[k] = (v / ch) * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (size - 1)));
      im[k] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bands; b++) {
      const lo = binOf(edges[b]), hi = Math.max(lo + 1, binOf(edges[b + 1]));
      let peak = 0;
      for (let k = lo; k < hi && k <= size / 2; k++) peak = Math.max(peak, Math.hypot(re[k], im[k]));
      // A full-scale sine under a Hann window peaks at about size / 4.
      const db = 20 * Math.log10(Math.max(1e-9, peak / (size / 4)));
      level[c * bands + b] = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
    }
  }
  return { columns, bands, level };
}
