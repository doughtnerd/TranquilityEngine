/**
 * An in-place radix-2 complex FFT over split real and imaginary arrays, and the magnitude spectrum of a real frame.
 * The sample analysers (tempo's onset envelope, ADR 0328 "detection of what's missing") use it; it is generic.
 *
 * Pure; no plugin, no DOM.
 */

/** True when `n` is a power of two ≥ 1. */
export const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/** The smallest power of two ≥ `n` (1 for n ≤ 1). */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Forward FFT of `re` + i·`im` in place (both of the same power-of-two length). Throws on a bad length. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (!isPowerOfTwo(n) || im.length !== n) throw new Error(`fft: length ${n} is not a power of two matching both arrays`);
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = (-2 * Math.PI) / size;
    const wr = Math.cos(step), wi = Math.sin(step);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** A reusable magnitude-spectrum analyser for real frames of a fixed power-of-two size, with a Hann window. */
export class MagnitudeSpectrum {
  readonly size: number;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (!isPowerOfTwo(size)) throw new Error(`MagnitudeSpectrum: ${size} is not a power of two`);
    this.size = size;
    this.window = new Float64Array(size);
    for (let i = 0; i < size; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /** The magnitudes of bins 0..size/2 of `input[from .. from + size)` (zero past the end) into `out`. */
  analyse(input: Float32Array | Float64Array, from: number, out: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const k = from + i;
      this.re[i] = k >= 0 && k < input.length ? input[k] * this.window[i] : 0;
      this.im[i] = 0;
    }
    fftInPlace(this.re, this.im);
    const bins = Math.min(out.length, n / 2 + 1);
    for (let i = 0; i < bins; i++) out[i] = Math.hypot(this.re[i], this.im[i]);
  }
}
