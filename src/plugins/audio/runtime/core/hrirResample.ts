// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_elevation.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_kernel.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/fft_frame.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_panner.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/audio_bus.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/media/base/sinc_resampler.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) 2010 Google Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
//
// 1.  Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
// 2.  Redistributions in binary form must reproduce the above copyright
//     notice, this list of conditions and the following disclaimer in the
//     documentation and/or other materials provided with the distribution.
// 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
//     its contributors may be used to endorse or promote products derived
//     from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
// THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// (hrtf_panner.cc: Copyright (C) 2010, Google Inc., the same text without clause 3.)
//
// media/base/sinc_resampler.cc: Copyright 2012 The Chromium Authors. Use of this source code is governed by a
// BSD-style license that can be found in Chromium's LICENSE file (native/audio/third_party/blink/CHROMIUM-LICENSE:
// Copyright 2015 The Chromium Authors; the same two first clauses, a third naming Google LLC, the same disclaimer).
//
// The HRIR and MagLS asset resampling (ADR 0157 H5, ADR 0162 A3), Chromium's pipeline in f32: media's `SincResampler`
// (`sincKernels`, `sincResample`), `HRTFKernel`'s `ExtractAverageGroupDelay`, `HRTFPanner::FftSizeForSampleRate`, and
// the two asset-to-blob conversions `resampleHrir` (the wire's format 2) and `resampleMagls` (format 4) for a context
// rate. Pure: an asset in, a new blob out. `hrir.ts` loads the blobs into the core.

import { MAGLS_HEADER_FIXED_END, MAGLS_MAGIC, MAGLS_ORDER, MAGLS_VERSION, readMaglsHeader, writeMaglsHeader } from "../wire.generated";

const HEADER_BYTES = 16;

/**
 * Header of the asset and of the wire blob (all little-endian): `u32 elevations; u32 azimuths; u32 irLength; f32 rate`.
 * The asset follows it with `i16[elevations * azimuths * irLength * 2]` (direction `d = azimuth * elevations +
 * elevation`, elevation counted from -45 degrees up, frames interleaved left, right; delays in). The wire blob puts the
 * `f32[elevations * azimuths * 2]` delay table between the two.
 */
export interface HrirHeader {
  readonly elevations: number;
  readonly azimuths: number;
  readonly irLength: number;
  readonly rate: number;
}

/** Reads the 16-byte header; throws on a short blob. */
export function readHrirHeader(blob: ArrayBuffer): HrirHeader {
  if (blob.byteLength < HEADER_BYTES) throw new Error("audio: the HRIR blob is shorter than its header");
  const view = new DataView(blob);
  return {
    elevations: view.getUint32(0, true),
    azimuths: view.getUint32(4, true),
    irLength: view.getUint32(8, true),
    rate: view.getFloat32(12, true),
  };
}

const f32 = Math.fround;

/** `HRTFPanner::FftSizeForSampleRate` (hrtf_panner.cc; audio-dsp's `fft_size_for_sample_rate`). */
export function hrtfFftSize(sampleRate: number): number {
  // `sample_rate / 44100` divides a float by an int: the ratio is a float.
  const ratio = f32(f32(sampleRate) / 44100);
  const exponent = Math.min(Math.max(0, Math.floor(Math.log2(256 * ratio))), 29);
  return 2 * Math.max(2, 2 ** exponent);
}

// --- media::SincResampler (media/base/sinc_resampler.cc), as AudioBus::TryCreateBySampleRateConverting runs it ---------

/** `request_frames` = 64, which selects the 32-tap kernel (`KernelSizeFromRequestFrames`). */
const SINC_REQUEST_FRAMES = 64;
const SINC_KERNEL_SIZE = 32;
const SINC_KERNEL_OFFSETS = 32;
const PI_F = f32(Math.PI);

/** `InitializeKernel`: the 33 Blackman-windowed sinc kernels (sub-sample offsets 0..1), in float as upstream keeps them. */
export function sincKernels(ioRatio: number): Float32Array {
  // `SincScaleFactor`: the normalised cutoff, lowered by 0.90 for the 32-tap kernel (both directions).
  const scale = (ioRatio > 1 ? 1 / ioRatio : 1) * 0.9;
  const kA0 = 0.5 * (1 - 0.16);
  const kA1 = 0.5;
  const kA2 = 0.5 * 0.16;
  const kernels = new Float32Array(SINC_KERNEL_SIZE * (SINC_KERNEL_OFFSETS + 1));
  for (let o = 0; o <= SINC_KERNEL_OFFSETS; o++) {
    const sub = f32(o / SINC_KERNEL_OFFSETS);
    for (let i = 0; i < SINC_KERNEL_SIZE; i++) {
      const preSinc = f32(PI_F * f32(i - SINC_KERNEL_SIZE / 2 - sub));
      const x = f32(f32(i - sub) / SINC_KERNEL_SIZE);
      const window = f32(kA0 - kA1 * Math.cos(2 * Math.PI * x) + kA2 * Math.cos(4 * Math.PI * x));
      kernels[o * SINC_KERNEL_SIZE + i] = window * (preSinc ? Math.sin(scale * preSinc) / preSinc : scale);
    }
  }
  return kernels;
}

/**
 * `AudioBus::TryCreateBySampleRateConverting` for one channel: `trunc(length / ioRatio)` frames from a
 * `SincResampler(ioRatio, 64, read)` whose read callback copies the source and then zeros. The region bookkeeping is
 * upstream's (`UpdateRegions`, `Resample`), so the input lines up with the kernel exactly as there; the convolution is
 * `Convolve_C`'s. `ioRatio` is the source rate over the destination rate.
 */
export function sincResample(source: Float32Array, ioRatio: number, kernels: Float32Array = sincKernels(ioRatio)): Float32Array {
  const K = SINC_KERNEL_SIZE;
  const out = new Float32Array(Math.trunc(source.length / ioRatio));
  const input = new Float32Array(SINC_REQUEST_FRAMES + K);
  let consumed = 0;
  const read = (at: number): void => {
    for (let i = 0; i < SINC_REQUEST_FRAMES; i++) input[at + i] = consumed < source.length ? source[consumed++]! : 0;
  };
  // r1 is input[0], r2 input[K / 2]; r0 moves right by K / 2 after the first load.
  const r2 = K / 2;
  let r0 = 0;
  let r3 = 0;
  let blockSize = 0;
  const updateRegions = (secondLoad: boolean): void => {
    r0 = secondLoad ? K : K / 2;
    r3 = r0 + SINC_REQUEST_FRAMES - K;
    blockSize = r0 + SINC_REQUEST_FRAMES - K / 2 - r2;
  };
  updateRegions(false);
  let virtualSourceIdx = 0;
  let remaining = out.length;
  let j = 0;
  if (remaining) read(r0);
  while (remaining) {
    while (virtualSourceIdx < blockSize) {
      const sourceIdx = Math.trunc(virtualSourceIdx);
      const virtualOffsetIdx = (virtualSourceIdx - sourceIdx) * SINC_KERNEL_OFFSETS;
      const offsetIdx = Math.trunc(virtualOffsetIdx);
      const k1 = offsetIdx * K;
      const k2 = k1 + K;
      let sum1 = 0;
      let sum2 = 0;
      for (let i = 0; i < K; i++) {
        const s = input[sourceIdx + i]!;
        sum1 = f32(sum1 + f32(s * kernels[k1 + i]!));
        sum2 = f32(sum2 + f32(s * kernels[k2 + i]!));
      }
      const blend = virtualOffsetIdx - offsetIdx;
      out[j++] = (1 - blend) * sum1 + blend * sum2;
      virtualSourceIdx += ioRatio;
      if (!--remaining) return out;
    }
    virtualSourceIdx -= blockSize;
    input.copyWithin(0, r3, r3 + K);
    if (r0 === r2) updateRegions(true);
    read(r0);
  }
  return out;
}

// --- HRTFKernel's ExtractAverageGroupDelay (hrtf_kernel.cc, fft_frame.cc) ---------------------------------------------

const twiddleCache = new Map<number, [Float64Array, Float64Array]>();

/** cos and sin of 2 pi k / n for k < n / 2, cached per size. */
function twiddles(n: number): [Float64Array, Float64Array] {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    t = [cos, sin];
    twiddleCache.set(n, t);
  }
  return t;
}

/** Radix-2 complex FFT in place, unnormalised; sign -1 forward, +1 inverse. */
function fft(re: Float64Array, im: Float64Array, sign: number): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  const [cos, sin] = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride]!;
        const wi = sign * sin[k * stride]!;
        const a = i + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/**
 * `ExtractAverageGroupDelay(channel, n)`: the magnitude-weighted average group delay of `ir[0..n)` (n a power of two)
 * from its packed spectrum (bin 0 read as the complex (DC, Nyquist)), less 20 frames of headroom when above 20, removed
 * as a linear phase from bins 1..n/2-1 with the DC term zeroed; `ir[0..n)` becomes the inverse transform. The spectrum
 * is kept in float between steps, as `FFTFrame` keeps it. Returns the delay in frames (a float); 0, leaving `ir` alone,
 * for a silent response (upstream would divide by zero; the table has none).
 */
export function extractAverageGroupDelay(ir: Float32Array, n: number): number {
  const half = n / 2;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = ir[i]!;
  fft(re, im, -1);
  const specRe = new Float32Array(half);
  const specIm = new Float32Array(half);
  specRe[0] = re[0]!;
  specIm[0] = re[half]!;
  for (let k = 1; k < half; k++) {
    specRe[k] = re[k]!;
    specIm[k] = im[k]!;
  }
  const TWO_PI = 2 * Math.PI;
  const samplePhaseDelay = TWO_PI / n;
  let aveSum = 0;
  let weightSum = 0;
  let lastPhase = 0;
  for (let k = 0; k < half; k++) {
    const mag = Math.sqrt(specRe[k]! * specRe[k]! + specIm[k]! * specIm[k]!);
    const phase = Math.atan2(specIm[k]!, specRe[k]!);
    let d = phase - lastPhase;
    lastPhase = phase;
    if (d < -Math.PI) d += TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    aveSum += mag * d;
    weightSum += mag;
  }
  if (weightSum === 0) return 0;
  let delay = -(aveSum / weightSum) / samplePhaseDelay;
  // Leave 20 sample headroom (for leading edge of impulse).
  if (delay > 20) delay -= 20;
  // AddConstantGroupDelay(-delay), then remove the DC offset.
  const phaseAdj = delay * samplePhaseDelay;
  for (let k = 1; k < half; k++) {
    const mag = Math.sqrt(specRe[k]! * specRe[k]! + specIm[k]! * specIm[k]!);
    const phase = Math.atan2(specIm[k]!, specRe[k]!) + k * phaseAdj;
    specRe[k] = mag * Math.cos(phase);
    specIm[k] = mag * Math.sin(phase);
  }
  specRe[0] = 0;
  re.fill(0);
  im.fill(0);
  re[0] = specRe[0]!;
  re[half] = specIm[0]!;
  for (let k = 1; k < half; k++) {
    re[k] = specRe[k]!;
    im[k] = specIm[k]!;
    re[n - k] = specRe[k]!;
    im[n - k] = -specIm[k]!;
  }
  fft(re, im, 1);
  for (let i = 0; i < n; i++) ir[i] = re[i]! / n;
  return f32(delay);
}

/** The wire's int16: round(x * 32768), half away from zero, clamped. */
function quantise(x: number): number {
  const v = x * 32768;
  const r = v < 0 ? -Math.round(-v) : Math.round(v);
  return Math.min(32767, Math.max(-32768, r));
}

/**
 * Turns the asset (responses at its own rate, delays in) into the wire's format 2 blob for a context at `rate` by
 * Chromium's pipeline (see the module comment): `fft_size / 2` frames per response, delays at `rate`. Returns a new
 * blob; throws on an asset that isn't the documented layout or a rate that isn't finite and positive.
 */
export function resampleHrir(asset: ArrayBuffer, rate: number): ArrayBuffer {
  const head = readHrirHeader(asset);
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`audio: bad HRIR target rate ${rate}`);
  const directions = head.elevations * head.azimuths;
  const inLen = head.irLength;
  if (directions === 0 || inLen === 0 || !(head.rate > 0) || asset.byteLength !== HEADER_BYTES + 4 * directions * inLen) {
    throw new Error("audio: the HRIR asset is not the documented layout (a header, then 16-bit responses with their delays in)");
  }
  // The context rate is a float upstream; `sample_rate_ratio = source_sample_rate / destination_sample_rate` in double.
  const contextRate = f32(rate);
  const ioRatio = head.rate / contextRate;
  const kernels = head.rate !== contextRate ? sincKernels(ioRatio) : null;
  const taps = hrtfFftSize(contextRate) / 2;
  const tableEnd = HEADER_BYTES + 8 * directions;
  const out = new ArrayBuffer(tableEnd + 4 * directions * taps);
  const outView = new DataView(out);
  outView.setUint32(0, head.elevations, true);
  outView.setUint32(4, head.azimuths, true);
  outView.setUint32(8, taps, true);
  outView.setFloat32(12, contextRate, true);
  const inView = new DataView(asset);
  const source = new Float32Array(inLen);
  for (let d = 0; d < directions; d++) {
    for (let ear = 0; ear < 2; ear++) {
      const inBase = HEADER_BYTES + d * inLen * 4 + ear * 2;
      for (let i = 0; i < inLen; i++) source[i] = inView.getInt16(inBase + i * 4, true) / 32768;
      const converted = kernels ? sincResample(source, ioRatio, kernels) : source;
      // Zero-padded to fft_size / 2 when shorter (`CalculateKernelsForAzimuthElevation`); the kernel reads no further.
      const response = new Float32Array(Math.max(taps, converted.length));
      response.set(converted);
      outView.setFloat32(HEADER_BYTES + (d * 2 + ear) * 4, extractAverageGroupDelay(response, taps), true);
      const outBase = tableEnd + d * taps * 4 + ear * 2;
      for (let j = 0; j < taps; j++) outView.setInt16(outBase + j * 4, quantise(response[j]!), true);
    }
  }
  return out;
}


/**
 * Turns the MagLS asset (responses at its own rate) into the format 4 blob for a context at `rate`: the header with
 * `taps` = `hrtfFftSize(rate) / 2` and `sampleRate` = `Math.fround(rate)`, then every response, in the asset's order,
 * resampled with `sincResample` (ratio = asset rate / context rate; skipped when the two rates are equal, so the blob
 * then equals the asset), zero-padded or cut to `taps`; a response longer than `taps` is cut with a linear fade over
 * its last `Math.trunc(rate / 4410)` frames (as the HRTF kernel, hrtf_kernel.cc). Returns a new blob; throws on an asset
 * that isn't the documented layout (magic, version 1, order 3, taps > 0, a finite positive rate, byte length
 * `32 + 16 * 2 * taps * 4`) or a rate that isn't finite and positive.
 */
export function resampleMagls(asset: ArrayBuffer, rate: number): ArrayBuffer {
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`audio: bad MagLS target rate ${rate}`);
  const bad = (why: string): never => {
    throw new Error(`audio: the MagLS asset is not the documented layout (${why})`);
  };
  if (asset.byteLength < MAGLS_HEADER_FIXED_END) bad("shorter than its header");
  const view = new DataView(asset);
  const head = readMaglsHeader(view, 0);
  if (head.magic !== MAGLS_MAGIC || head.version !== MAGLS_VERSION || head.order !== MAGLS_ORDER) bad("magic, version or order");
  if (!(head.taps > 0)) bad("no taps");
  const assetRate = head.sampleRate;
  if (!(assetRate > 0) || !Number.isFinite(assetRate)) bad("rate");
  const responses = 16 * 2; // [16 channels][2 ears]
  if (asset.byteLength !== MAGLS_HEADER_FIXED_END + responses * head.taps * 4) bad("byte length");

  const contextRate = Math.fround(rate);
  const taps = hrtfFftSize(contextRate) / 2;
  const out = new ArrayBuffer(MAGLS_HEADER_FIXED_END + responses * taps * 4);
  const outView = new DataView(out);
  writeMaglsHeader(outView, 0, { magic: MAGLS_MAGIC, version: MAGLS_VERSION, order: MAGLS_ORDER, taps, sampleRate: contextRate, reserved: [0, 0, 0] });
  const ioRatio = assetRate / contextRate;
  const kernels = assetRate === contextRate ? null : sincKernels(ioRatio);
  // The fade of the cut: the last trunc(rate / 4410) frames, as the HRTF kernel's raw_response.
  const fade = Math.trunc(rate / 4410);
  const source = new Float32Array(head.taps);
  for (let r = 0; r < responses; r++) {
    for (let i = 0; i < head.taps; i++) source[i] = view.getFloat32(MAGLS_HEADER_FIXED_END + (r * head.taps + i) * 4, true);
    const converted = kernels ? sincResample(source, ioRatio, kernels) : source;
    const length = converted.length;
    for (let j = 0; j < taps; j++) {
      let v = j < length ? converted[j]! : 0;
      if (length > taps && j >= taps - fade) v *= 1 - (j - (taps - fade)) / fade;
      outView.setFloat32(MAGLS_HEADER_FIXED_END + (r * taps + j) * 4, v, true);
    }
  }
  return out;
}
