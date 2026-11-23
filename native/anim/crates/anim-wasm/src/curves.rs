//! Feature `curves` (T70): engine curves as assets, read by the shared `myco-curve` evaluator
//! (`anim_sample::curve`), the one the audio core links, held to `src/engine/core/curve.ts` by its
//! parity test (ADR 0370 "Crates"). Documented with the `tween` wire family (its constants).
//!
//! - `load_curve(keys)` copies a curve's keys (`CURVE_KEY_FLOATS` floats each: x, y, interp,
//!   inDx, inDy, outDx, outDy; sorted by x; at most `MAX_CURVE_KEYS`) into the arena and returns
//!   its handle (0: refused, `last_status` says why). `release` frees it, as any asset.
//! - **Easing:** a `TWEEN_CREATE` or sequence member whose `ease` is a curve handle reads the
//!   curve at the cycle's progress (`curve.ts`'s `evalCurve(curve, p)`), in the core.
//! - **Sampling:** `curve_sample(curve, rate, end, frames)` writes the curve at `frames` frames of
//!   `rate` Hz, clamped to `end` seconds, to the view at `curve_samples_ptr()` (`frames` f32,
//!   valid until the next call): runtime curve tracks a host builds into a raw clip, sampled by
//!   the core's evaluator. A setup call: it may allocate; `evaluate` never does.

use anim_sample::curve::sample_uniform;
use anim_wire::core::{STATUS_NOT_INITIALIZED, STATUS_OK, STATUS_TOO_LARGE};
use anim_wire::tween::MAX_CURVE_SAMPLES;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::init::{with, Core};

impl Core {
    /// Loads an engine curve (module docs); its handle, or 0 (see `last_status`).
    pub fn load_curve(&mut self, keys: &[f32]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.arena.load_curve(keys);
        self.handle(r)
    }

    /// Samples curve `curve` into the sample view (module docs); returns a status.
    pub fn curve_sample(&mut self, curve: u32, rate: f64, end: f64, frames: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        if frames > MAX_CURVE_SAMPLES {
            return STATUS_TOO_LARGE;
        }
        let keys = match self.arena.curve(curve) {
            Ok(k) => k,
            Err(e) => return e,
        };
        self.curve_samples.resize(frames as usize, 0.0);
        sample_uniform(keys, rate, end, &mut self.curve_samples);
        STATUS_OK
    }

    /// The last `curve_sample`'s values.
    pub fn curve_samples(&self) -> &[f32] {
        &self.curve_samples
    }
}

/// Loads an engine curve (`CURVE_KEY_FLOATS` floats per key, sorted by x); returns its handle, or
/// 0 (see `last_status`). Release it with `release`.
#[wasm_bindgen]
pub fn load_curve(keys: &[f32]) -> u32 {
    with(|c| c.load_curve(keys))
}

/// Samples a curve at `frames` frames of `rate` Hz, clamped to `end` seconds, into the view at
/// `curve_samples_ptr()`; returns a status.
#[wasm_bindgen]
pub fn curve_sample(curve: u32, rate: f64, end: f64, frames: u32) -> u32 {
    with(|c| c.curve_sample(curve, rate, end, frames))
}

/// The byte offset of the last `curve_sample`'s values (`f32` each).
#[wasm_bindgen]
pub fn curve_samples_ptr() -> u32 {
    with(|c| Core::addr(c.curve_samples()))
}
