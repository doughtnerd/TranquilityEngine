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

import { MAGLS_CLIP_ID, readMaglsHeader } from "../wire.generated";
import type { ClipRegistry } from "./clipRegistry";
import { readHrirHeader, resampleHrir, resampleMagls } from "./hrirResample";

const FORMAT_HRIR = 2;

/** The reserved HRIR clip id (generation 0xFF, index 0xFF0000); the range is 0xFFFF0000..0xFFFF00FF. */
const HRIR_CLIP_ID = 0xffff0000;

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

/** Where the MagLS asset is served from (`src/engine/audio/magls-o3.bin`, resolved from this module). */
function maglsUrl(): URL {
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
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const fetchBytes =
    deps.fetchBytes ??
    (async () => {
      const response = await fetch(maglsUrl());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  let started = false;
  let failed = false;
  let rate = deps.sampleRate;
  /** The asset as fetched (at its own rate), kept for a rebuild at another rate. */
  let original: ArrayBuffer | null = null;
  const fail = (err: unknown): void =>
    warn(`audio: the MagLS bed filters failed to load, beds decode through the equal-power matrix (${err instanceof Error ? err.message : String(err)})`);
  const blobFor = (asset: ArrayBuffer): { bytes: ArrayBuffer; sampleRate: number; format: 4 } => {
    const bytes = resampleMagls(asset, rate);
    return { bytes, sampleRate: readMaglsHeader(new DataView(bytes), 0).sampleRate, format: 4 };
  };
  return {
    ensure() {
      if (started) return;
      started = true;
      void (async () => {
        try {
          original = await fetchBytes();
          deps.clips.acquireReserved(MAGLS_CLIP_ID, blobFor(original));
        } catch (err) {
          original = null;
          failed = true;
          fail(err);
        }
      })();
    },
    get ready() {
      return deps.clips.state(MAGLS_CLIP_ID) === "ready";
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
      if (!original || deps.clips.state(MAGLS_CLIP_ID) === "idle") return;
      try {
        deps.clips.updateReserved?.(MAGLS_CLIP_ID, blobFor(original));
      } catch (err) {
        fail(err);
      }
    },
  };
}
