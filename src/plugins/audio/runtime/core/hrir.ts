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
// H2: the HRIR table (IRCAM IRC_Composite_C, Chromium's `Composite.flac`) as a lazily fetched asset beside the wasm,
// loaded into the core as a CLIP_BEGIN/CLIP_CHUNK format = 2 clip under a reserved id (api-and-models 4.1 and 5). The clip
// registry keeps the blob, so a rebuild re-sends it with the other resident clips. Voices stay equal-power until the
// core reports clip event 4 (hrtfReady). The table isn't counted in clipMemoryMB.
//
// H5: the asset is the 10 x 24 responses of 256 frames at 44.1 kHz as Chromium decodes them, leading delays still in
// (tools/hrir/convert.mjs; layout at `HrirHeader`). At load each response goes through Chromium's own pipeline for the
// context rate (`CalculateKernelsForAzimuthElevation` in hrtf_elevation.cc, then the `HRTFKernel` constructor):
// resampled on its own by `AudioBus::TryCreateBySampleRateConverting` (media's `SincResampler`: 32-tap Blackman sinc, 33
// kernel offsets, cutoff 0.9, 64-frame requests; ported below in f32), zero-padded to `fft_size / 2` if shorter, and
// its average group delay extracted at the context rate (`ExtractAverageGroupDelay`, over the first `fft_size / 2`
// frames). The result is the wire's format 2 ("already at the context rate"; layout: audio-dsp's hrtf/database.rs):
// `fft_size / 2` frames per response, all the kernel reads (it truncates there and fades out), and the delays at the
// context rate.

import { MAGLS_CLIP_ID } from "../wire.generated";
import type { ClipRegistry } from "./clipRegistry";

/** The reserved HRIR clip id (generation 0xFF, index 0xFF0000); the range is 0xFFFF0000..0xFFFF00FF. */
export const HRIR_CLIP_ID = 0xffff0000;

const HEADER_BYTES = 16;
const FORMAT_HRIR = 2;

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

/** Where the asset is served: beside this module in the dev server and the app builds, beside the bundle in the engine library. */
export function hrirUrl(): URL {
  return new URL("../wasm/myco_hrir.bin", import.meta.url);
}

export interface HrirLoaderDeps {
  /** The registry the table is loaded through (reserved id `HRIR_CLIP_ID`). */
  readonly clips: ClipRegistry;
  /** The context's sample rate. */
  readonly sampleRate: number;
  /** Fetches the asset (default: `fetch(hrirUrl())`). */
  readonly fetchBytes?: () => Promise<ArrayBuffer>;
  /** The single warning on failure (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

export interface HrirLoader {
  /** Starts the lazy fetch on the first spatial play; later calls do nothing (a failed load is not retried). */
  ensure(): void;
  /** True once the core reported hrtfReady for the table (clip event 4). */
  readonly ready: boolean;
  /** H3: true once the fetch (or the resampling) failed: STATUS-style `hrtfLoadFailure` 1 on main. Optional so fakes satisfy it. */
  readonly failed?: boolean;
  /** H3: true once `ensure` started the load (`audio.spatial: "equalPower"` never starts it). Optional so fakes satisfy it. */
  readonly started?: boolean;
  /**
   * A3.4c, a rebuild into a context at `sampleRate`: the table is resampled again from the original asset for the new
   * rate and the registry's kept blob replaced (`updateReserved`), so the rebuild's re-send carries it. A fetch still
   * under way resamples for the new rate when it lands. Optional so fakes satisfy it.
   */
  retarget?(sampleRate: number): void;
}

export function createHrirLoader(deps: HrirLoaderDeps): HrirLoader {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const fetchBytes =
    deps.fetchBytes ??
    (async () => {
      const response = await fetch(hrirUrl());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  let started = false;
  let failed = false;
  let rate = deps.sampleRate;
  /** The asset as fetched (at its own rate), kept for a rebuild at another rate (A3.4c). */
  let original: ArrayBuffer | null = null;
  const fail = (err: unknown): void => warn(`audio: the HRTF data failed to load, spatial voices stay equal-power (${err instanceof Error ? err.message : String(err)})`);
  return {
    ensure() {
      if (started) return;
      started = true;
      void (async () => {
        try {
          original = await fetchBytes();
          const bytes = resampleHrir(original, rate);
          deps.clips.acquireReserved(HRIR_CLIP_ID, { bytes, sampleRate: readHrirHeader(bytes).rate, format: FORMAT_HRIR });
        } catch (err) {
          original = null;
          failed = true;
          fail(err);
        }
      })();
    },
    get ready() {
      return deps.clips.state(HRIR_CLIP_ID) === "ready";
    },
    get failed() {
      return failed;
    },
    get started() {
      return started;
    },
    retarget(sampleRate) {
      if (Math.abs(sampleRate - rate) < 0.5) return;
      rate = sampleRate;
      if (!original || deps.clips.state(HRIR_CLIP_ID) === "idle") return;
      try {
        const bytes = resampleHrir(original, rate);
        deps.clips.updateReserved?.(HRIR_CLIP_ID, { bytes, sampleRate: readHrirHeader(bytes).rate, format: FORMAT_HRIR });
      } catch (err) {
        fail(err);
      }
    },
  };
}

// --- ADR 0162 A3: the MagLS bed filters (clip format 4) -----------------------------------------------------------------
//
// The asset `src/engine/audio/magls-o3.bin` (made by `native/audio/tools/bake-magls`, designed from the HRIR set above,
// so the IRCAM licence carries over) is the 32-byte `MaglsHeader` ("MYBD", version 1, order 3, taps 256, the HRIR's rate
// 44.1 kHz, 12 reserved bytes) then f32 time responses `[16 channels][2 ears][taps]` (api-and-models 4.5, contract C6):
// 32,800 B. Main resamples it for the context rate as it does the HRIR (C6: 256 taps up to 48 kHz, 512 from 88.2 kHz)
// and loads it through the clip registry as CLIP_BEGIN format 4 under `MAGLS_CLIP_ID` (0xFFFF0100), `channels` 1,
// `frames` = bytes / 4 (header included), on the first bed use; the registry keeps the blob so a rebuild re-sends it
// (S5). Until the core reports it resident, or if it fails to load, beds decode through the baked 16 -> 2 matrix (R9).
// `audio.spatial: "equalPower"` never fetches it.

export { MAGLS_CLIP_ID };

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
  void asset;
  void rate;
  throw new Error("not implemented: L-A3a");
}

/** Where the MagLS asset is served from (`src/engine/audio/magls-o3.bin`, resolved from this module). */
export function maglsUrl(): URL {
  return new URL("../../../../engine/audio/magls-o3.bin", import.meta.url);
}

export interface MaglsLoaderDeps {
  /** The registry the filters are loaded through (reserved id `MAGLS_CLIP_ID`, format 4). */
  readonly clips: ClipRegistry;
  /** The context's sample rate. */
  readonly sampleRate: number;
  /** Fetches the asset (default: `fetch(maglsUrl())`). */
  readonly fetchBytes?: () => Promise<ArrayBuffer>;
  /** The single warning on failure (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

export interface MaglsLoader {
  /** Starts the lazy fetch on the first bed use; later calls do nothing (a failed load is not retried). */
  ensure(): void;
  /** True once the core reported the filters resident (the registry's state for `MAGLS_CLIP_ID` is "ready"). */
  readonly ready: boolean;
  /** True once the fetch or the resampling failed (beds stay on the matrix decode). */
  readonly failed: boolean;
  /** True once `ensure` started the load. */
  readonly started: boolean;
  /**
   * A rebuild into a context at `sampleRate`: the filters are resampled again from the original asset and the
   * registry's kept blob replaced (`updateReserved`), so the rebuild's re-send carries them. A fetch still under way
   * resamples for the new rate when it lands. A change under 0.5 Hz does nothing.
   */
  retarget(sampleRate: number): void;
}

/**
 * The MagLS loader: `createHrirLoader`'s lifecycle for format 4. `ensure` fetches once, resamples with
 * `resampleMagls(asset, rate)` and calls `clips.acquireReserved(MAGLS_CLIP_ID, { bytes, sampleRate, format: 4 })`
 * (`sampleRate` read back from the blob's header); a failure sets `failed`, drops the kept asset and warns once:
 * `audio: the MagLS bed filters failed to load, beds decode through the equal-power matrix (<message>)`.
 */
export function createMaglsLoader(deps: MaglsLoaderDeps): MaglsLoader {
  void deps;
  throw new Error("not implemented: L-A3a");
}
