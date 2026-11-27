//! The WebAssembly boundary of Myco's UI layout engine (ADR 0433): `LayoutTree` over layout-core's `UiLayout`.
//! Only numbers cross it. Computed boxes are written to a buffer in the module's memory (`outPtr`), which the
//! TypeScript adapter reads through a `Float32Array` view, so reading a box costs one call and no allocation.
//! A measured leaf's size comes from the JS function passed to `compute`, called as
//! `measure(handle, knownWidth, knownHeight, availableWidth, availableHeight)` (NaN for an unknown size;
//! `+Infinity` for max-content room, `-Infinity` for min-content), which answers with `setMeasured(w, h, baseline)`
//! (the first baseline down from the content box's top, NaN for none).
use std::cell::Cell;

use layout_core::{out, AvailableSpace, Measured, UiLayout};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// The measure callback: any JS function.
    pub type MeasureFn;
    #[wasm_bindgen(method, js_name = call)]
    fn call(this: &MeasureFn, this_arg: &JsValue, handle: u32, known_width: f32, known_height: f32, available_width: f32, available_height: f32);
}

thread_local! {
    static MEASURED: Cell<(f32, f32, f32)> = const { Cell::new((0.0, 0.0, f32::NAN)) };
}

/// The answer to a measure call: the leaf's content size and first baseline (NaN for none).
#[wasm_bindgen(js_name = setMeasured)]
pub fn set_measured(width: f32, height: f32, baseline: f32) {
    MEASURED.with(|m| m.set((width, height, baseline)));
}

fn space(s: AvailableSpace) -> f32 {
    match s {
        AvailableSpace::Definite(v) => v,
        AvailableSpace::MinContent => f32::NEG_INFINITY,
        AvailableSpace::MaxContent => f32::INFINITY,
    }
}

/// A layout tree whose nodes are `u32` handles.
#[wasm_bindgen]
pub struct LayoutTree {
    inner: UiLayout,
    buf: Box<[f32; out::LEN]>,
}

impl Default for LayoutTree {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl LayoutTree {
    #[wasm_bindgen(constructor)]
    pub fn new() -> LayoutTree {
        LayoutTree { inner: UiLayout::new(), buf: Box::new([0.0; out::LEN]) }
    }

    /// A new node; a `measured` one asks the measure callback for its size.
    pub fn create(&mut self, measured: bool) -> u32 {
        self.inner.create(measured)
    }

    pub fn remove(&mut self, handle: u32) {
        self.inner.remove(handle)
    }

    #[wasm_bindgen(js_name = setChildren)]
    pub fn set_children(&mut self, handle: u32, children: &[u32]) {
        self.inner.set_children(handle, children)
    }

    #[wasm_bindgen(js_name = setEnum)]
    pub fn set_enum(&mut self, handle: u32, prop: u8, value: u8) -> bool {
        self.inner.set_enum(handle, prop, value)
    }

    #[wasm_bindgen(js_name = setLength)]
    pub fn set_length(&mut self, handle: u32, prop: u8, kind: u8, value: f32) -> bool {
        self.inner.set_length(handle, prop, kind, value)
    }

    #[wasm_bindgen(js_name = setNumber)]
    pub fn set_number(&mut self, handle: u32, prop: u8, value: f32) -> bool {
        self.inner.set_number(handle, prop, value)
    }

    #[wasm_bindgen(js_name = markDirty)]
    pub fn mark_dirty(&mut self, handle: u32) {
        self.inner.mark_dirty(handle)
    }

    /// Lays out the tree under `root` (a finite size is definite, `+Infinity` max-content, `-Infinity` min-content).
    pub fn compute(&mut self, root: u32, width: f32, height: f32, measure: &MeasureFn) {
        self.inner.compute(root, width, height, |h, input| {
            set_measured(0.0, 0.0, f32::NAN);
            measure.call(
                &JsValue::NULL,
                h,
                input.known_width.unwrap_or(f32::NAN),
                input.known_height.unwrap_or(f32::NAN),
                space(input.available_width),
                space(input.available_height),
            );
            let (width, height, baseline) = MEASURED.with(|m| m.get());
            Measured { width, height, baseline: baseline.is_finite().then_some(baseline) }
        })
    }

    /// Writes `handle`'s box into the buffer at `outPtr` (layout-core's `out` order); false for an unknown handle.
    pub fn layout(&mut self, handle: u32) -> bool {
        self.inner.layout(handle, &mut self.buf[..])
    }

    /// The address of the box buffer in the module's memory (`out::LEN` floats).
    #[wasm_bindgen(js_name = outPtr)]
    pub fn out_ptr(&self) -> u32 {
        self.buf.as_ptr() as u32
    }
}
