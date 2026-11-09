//! DSP kernels for Myco's audio core (ADR 0157, api-and-models §5).
//!
//! Empty in M1a.0. Later tasks add their own modules here, one file each, so they never collide:
//! - written here: `resample`, `ramp` (A1.2), `meter` (A2.1), `limiter`, `workunits` (A3.3);
//! - ported from Chromium Blink (`third_party/blink/renderer/platform/audio/`), each keeping its
//!   BSD-3-Clause notice and an SPDX header naming the upstream path and commit: `pan`
//!   (`equal_power_panner`, A1.2), `biquad` and `compressor` (A2.2a), `convolver` (A2.2b, on
//!   `microfft`), `hrtf` (H1).
//!
//! Rules for every module: transcendentals go through `libm` (never `f32::sin` and friends), so
//! native tests and the wasm build give bit-identical results; nothing allocates while processing.

pub mod pan;
pub mod ramp;
pub mod resample;
