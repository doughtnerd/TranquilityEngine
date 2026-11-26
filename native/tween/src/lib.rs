//! The standalone tween module (ADR 0420 spike): `myco-tween`'s table behind a wasm-bindgen
//! boundary, for UI animation in a game without the animation plugin.
//!
//! The calls are the animation core's tween calls (wire family `tween`, the same records, statuses
//! and views), minus what needs the core:
//!
//! - **Sizing:** there is no `init`. The table starts empty; `tweens_configure(max)` sizes it once
//!   (`tween_bytes_for(max)` says what that costs). Until then `tween_create` answers `STATUS_FULL`.
//! - **Frames:** `begin_frame()` does what the core's `write_inputs` does for tweens (clears the
//!   value rows and the change records); `update(world, pass, dt_scaled, dt_unscaled)` is the
//!   tween part of `evaluate`.
//! - **Curves:** `load_curve(keys)` / `release_curve(handle)` keep curve eases in
//!   `myco_tween::curves::CurveStore` (the core keeps them in its asset arena). Handles have the
//!   same layout, so a curve handle in a tween's `ease` reads the same way.
//!
//! Sequences and parallel groups (`myco_tween::seq`) are timeline instances in the animation core,
//! whose playback stays there; the spike doesn't export them.

use std::cell::RefCell;

use myco_tween::curves::CurveStore;
use myco_tween::host::{STATUS_OK, STATUS_TOO_LARGE};
use myco_tween::{Tweens, MAX_TWEENS};
use wasm_bindgen::prelude::wasm_bindgen;

/// The module's state: the tween table and its curve store.
#[derive(Default)]
pub struct Module {
    tweens: Tweens,
    curves: CurveStore,
    last_status: u32,
}

impl Module {
    /// Sizes the table for `max` tweens (drops every tween); a status.
    pub fn configure(&mut self, max: u32) -> u32 {
        if max as usize > MAX_TWEENS {
            return STATUS_TOO_LARGE;
        }
        self.tweens = Tweens::new(max as usize);
        STATUS_OK
    }

    fn handle(&mut self, r: Result<u32, u32>) -> u32 {
        match r {
            Ok(h) => {
                self.last_status = STATUS_OK;
                h
            }
            Err(e) => {
                self.last_status = e;
                0
            }
        }
    }

    /// Creates a tween from a `TWEEN_CREATE` record; its handle, or 0 (see [`Module::last_status`]).
    pub fn create(&mut self, record: &[u8]) -> u32 {
        let r = self.tweens.create(record);
        self.handle(r)
    }

    /// Applies a `TWEEN_CONTROL` record; a status.
    pub fn control(&mut self, record: &[u8]) -> u32 {
        self.tweens.control(record)
    }

    /// Clears the frame's rows and change records.
    pub fn begin_frame(&mut self) {
        self.tweens.begin_frame();
    }

    /// Advances `world`'s tweens in `pass`; the change records waiting.
    pub fn update(&mut self, world: u32, pass: u32, dt_scaled: f32, dt_unscaled: f32) -> u32 {
        self.tweens
            .update(&self.curves, world, pass, dt_scaled, dt_unscaled);
        self.tweens.change_count() as u32
    }

    /// Loads a curve (`CURVE_KEY_FLOATS` floats per key); its handle, or 0.
    pub fn load_curve(&mut self, keys: &[f32]) -> u32 {
        let r = self.curves.load(keys);
        self.handle(r)
    }

    /// Frees a curve; a status.
    pub fn release_curve(&mut self, handle: u32) -> u32 {
        self.curves.release(handle)
    }

    /// Why the last call returning a handle returned 0.
    pub fn last_status(&self) -> u32 {
        self.last_status
    }

    /// The tween table (its rows, values and change records).
    pub fn tweens(&self) -> &Tweens {
        &self.tweens
    }
}

thread_local! {
    static MODULE: RefCell<Module> = RefCell::new(Module::default());
}

fn with<R>(f: impl FnOnce(&mut Module) -> R) -> R {
    MODULE.with(|m| f(&mut m.borrow_mut()))
}

fn addr<T>(v: &[T]) -> u32 {
    v.as_ptr() as usize as u32
}

/// Bytes a table of `max` tweens takes.
#[wasm_bindgen]
pub fn tween_bytes_for(max: u32) -> f64 {
    Tweens::bytes_for(max as usize) as f64
}

/// Sizes the tween table (drops every tween); a status.
#[wasm_bindgen]
pub fn tweens_configure(max_tweens: u32) -> u32 {
    with(|m| m.configure(max_tweens))
}

/// Creates a tween from a `TWEEN_CREATE` record; its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn tween_create(record: &[u8]) -> u32 {
    with(|m| m.create(record))
}

/// Applies a `TWEEN_CONTROL` record (pause, resume, kill, destroyed); a status.
#[wasm_bindgen]
pub fn tween_control(record: &[u8]) -> u32 {
    with(|m| m.control(record))
}

/// Clears the frame's value rows and change records.
#[wasm_bindgen]
pub fn begin_frame() {
    with(|m| m.begin_frame())
}

/// Advances `world`'s tweens in `pass`; returns the change records waiting.
#[wasm_bindgen]
pub fn update(world: u32, pass: u32, dt_scaled: f32, dt_unscaled: f32) -> u32 {
    with(|m| m.update(world, pass, dt_scaled, dt_unscaled))
}

/// Loads a curve for curve easing; its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn load_curve(keys: &[f32]) -> u32 {
    with(|m| m.load_curve(keys))
}

/// Frees a curve; a status.
#[wasm_bindgen]
pub fn release_curve(handle: u32) -> u32 {
    with(|m| m.release_curve(handle))
}

/// Why the last call returning a handle returned 0 (`STATUS_*`).
#[wasm_bindgen]
pub fn last_status() -> u32 {
    with(|m| m.last_status())
}

/// Tween output rows this frame.
#[wasm_bindgen]
pub fn tween_values_count() -> u32 {
    with(|m| m.tweens.rows() as u32)
}

/// The byte offset of the rows' column ids (`u32` each).
#[wasm_bindgen]
pub fn tween_columns_ptr() -> u32 {
    with(|m| addr(m.tweens.columns()))
}

/// The byte offset of the rows' values (four `f32` each).
#[wasm_bindgen]
pub fn tween_values_ptr() -> u32 {
    with(|m| addr(m.tweens.values()))
}

/// `TWEEN_CHANGE` records this frame.
#[wasm_bindgen]
pub fn tween_changes_count() -> u32 {
    with(|m| m.tweens.change_count() as u32)
}

/// The byte offset of the change records.
#[wasm_bindgen]
pub fn tween_changes_ptr() -> u32 {
    with(|m| addr(m.tweens.changes()))
}

/// Changes dropped this frame because the buffer was full.
#[wasm_bindgen]
pub fn tween_changes_dropped() -> u32 {
    with(|m| m.tweens.dropped())
}
