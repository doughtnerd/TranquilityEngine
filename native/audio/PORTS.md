# Ported Chromium files (`native/audio`)

ADR 0157, api-and-models §5 ("Ports and dependencies"), task A0.10.

**Pinned upstream:** Chromium `cbba46fd94646232cfd2318ac962138c2a98c1f9` (tip of `main` on 2026-11-09, 19:14 UTC), path `third_party/blink/renderer/platform/audio/`. Reference copies are staged unchanged in `native/audio/third_party/blink/` with `PROVENANCE.md` (paths, commit, fetch date 2026-11-09, SHA-256). Nothing compiles them. Use them as the source to port from, and only from the pinned commit; a later Chromium commit needs a new row and a new pin.

## Ports

| Upstream file(s) | Rust module (or TypeScript) | Task | Notes |
|---|---|---|---|
| `biquad.cc`, `biquad.h` | `native/audio/crates/audio-dsp/src/biquad.rs`, `biquad/coeffs.rs`, `biquad/kernel.rs` (each carries the header) | A2.2a | Q in dB as upstream (linear Q through upstream's single-precision `pow10`); lowpass and highpass only; k-rate coefficients |
| `dynamics_compressor.cc`, `dynamics_compressor.h` (the kernel is folded into these at the pinned commit; there is no `dynamics_compressor_kernel.*`) | `native/audio/crates/audio-dsp/src/compressor.rs` | A2.2a | makeup gain, knee, adaptive release, 6 ms pre-delay; pre-delay line sized for 48 kHz (held at 288 frames above), no metering, parameters clamped to the node's ranges |
| `reverb_convolver.cc`, `.h`; `reverb_convolver_stage.cc`, `.h`; `reverb_accumulation_buffer.cc`, `.h`; `fft_convolver.cc`, `.h`; `reverb.cc` (normalisation) | `native/audio/crates/audio-dsp/src/convolver.rs`, `native/audio/crates/audio-dsp/src/convolver/ir.rs` | A2.2b | zero-latency staged convolver: one 128-frame-partition head (256-point FFT) over 4,096 frames, then 2,048-frame tail stages sharing one frequency-domain delay line, staggered over 16 quanta; FFTs in `convolver/fft.rs` (Myco code) on microfft's 16-point transform; seeded IR (mulberry32) |
| `equal_power_panner.cc`, `.h` | `native/audio/crates/audio-dsp/src/pan.rs` | A1.2 | |
| `distance_effect.cc`, `.h`; `cone_effect.cc`, `.h` | `src/plugins/audio/runtime/core/spatial.ts` (TypeScript, main thread, not Rust) | A1.5 | the cone is ported but unused until `AudioSource` gains cone fields |
| `hrtf_panner.cc`, `.h`; `hrtf_kernel.cc`, `.h`; `hrtf_elevation.cc`, `.h`; `hrtf_database.cc`, `.h`; `fft_frame.cc`, `.h` (kernel interpolation, average group delay); `delay.cc`, `.h` and `audio_utilities.cc`, `.h` (the interaural delay line) | `native/audio/crates/audio-dsp/src/hrtf/` (every ported file under it carries the header) | H1 (data: H2) | the convolution is redone in uniform 128-frame partitions on a 256-point `microfft` FFT; the HRIR resources are not staged (H2, see `native/audio/third_party/blink/` notes in PROVENANCE.md) |
| `audio_bus.cc` (`TryCreateBySampleRateConverting`), `media/base/sinc_resampler.cc`, `.h`; `hrtf_elevation.cc` (`CalculateKernelsForAzimuthElevation`: per-response resampling, padding); `hrtf_kernel.cc`, `fft_frame.cc` (`ExtractAverageGroupDelay`); `hrtf_panner.cc` (`FftSizeForSampleRate`) | `src/plugins/audio/runtime/core/hrir.ts` (TypeScript, main thread, at load) | H5 | the HRIR asset keeps its delays; each response is resampled to the context rate by the `SincResampler` port (32-tap kernel, 64-frame requests, f32 as upstream's `Convolve_C`; upstream's SIMD paths sum in another order) and its delay extracted at that rate (FFT in f64, spectrum stored as f32 between steps); the result is quantised to the wire's int16 (`format = 2`) |
| `third_party/blink/renderer/modules/webaudio/panner_handler.cc` (`CalculateAzimuthElevation`); `ui/gfx/geometry/vector3d_f.cc`, `.h`; `base/numerics/angle_conversions.h` | `native/audio/crates/audio-dsp/src/hrtf/angles.rs` | H5 | the HRTF panner's azimuth and elevation in Blink's f32 arithmetic, for Web Audio's default listener (the core gets listener-space directions); `acosf` as f64 `acos` rounded to f32; the equal-power panner keeps its f64 `azimuth` in `audio-core/src/panner.rs` (Myco code) |

Crate dependencies (not ports, but in the same licence picture): what `myco_audio.wasm` contains besides Myco's own crates is `microfft` 0.6.0 (MIT), `libm` 0.2.16 (MIT), and microfft's own dependencies `num-complex` 0.4.6, `num-traits` 0.2.19, `cfg-if` 1.0.5 and `static_assertions` 1.1.0 (each MIT OR Apache-2.0); `cargo tree -p audio-wasm -e normal --target wasm32-unknown-unknown` lists them. All are credited in `THIRD_PARTY_NOTICES.md`. The decoder wasm's crates (Symphonia and others) are credited there too.

**Licence expression of `audio-dsp`:** `(Apache-2.0 OR MIT) AND BSD-3-Clause`. The Apache-2.0 OR MIT part is the crate's own code; the BSD-3-Clause part is every ported module.

## Header rule

Every ported file keeps Chromium's BSD-3-Clause notice. For a Rust module (`.rs`), the header is the first lines of the file, in this order:

```rust
// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/<file> @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) <year> Google Inc. All rights reserved.
//
// <the BSD-3-Clause conditions as the upstream file states them, clauses 1 to 3, each line prefixed with "//">
```

Rules for the header:

- The `SPDX-License-Identifier` line names `BSD-3-Clause` (a module that also has crate code keeps the crate's own SPDX line as a separate, second line; the Chromium line stays first).
- One `Ported from chromium/src/…` line for each upstream file the module draws on, each ending `@` followed by the pinned commit. The test in `src/plugins/audio/portsNotices.test.ts` requires the commit to match the pin above.
- The Chromium copyright lines are copied from the upstream file, not paraphrased (the files carry `Copyright (C) 2010 Google Inc.` or `2011`).
- Clause 3 of most upstream licences names **Apple Computer, Inc.** (the Blink audio files come from WebKit). Keep that wording; it is part of the licence text. Four upstream files (`audio_utilities`, `delay`, `equal_power_panner`, `hrtf_panner`) have only clauses 1 and 2, with the disclaimer in Apple Inc.'s name: a port of those reproduces that text, not clause 3. Files from outside the Blink audio directory (`panner_handler.cc`, `vector3d_f`, `angle_conversions.h`, `sinc_resampler`) carry `Copyright … The Chromium Authors` and Chromium's own LICENSE (clause 3 names Google LLC): a port notes each file's copyright line and the LICENSE text, as `angles.rs` and `hrir.ts` do.
- A TypeScript file (`spatial.ts`) uses the same lines with `//` comments.

The licence text for Chromium's files is in `native/audio/third_party/blink/CHROMIUM-LICENSE` (Chromium's own LICENSE) and in `THIRD_PARTY_NOTICES.md`.

## Check

`src/plugins/audio/portsNotices.test.ts` (Vitest, `node:fs`) checks, when `native/audio/` exists: every `.rs` under `native/audio/crates/` with a `// Ported from chromium` line carries the header; every module named in the table above that exists as a file carries it; every staged file in `native/audio/third_party/blink/` is listed in `PROVENANCE.md` with its SHA-256.
