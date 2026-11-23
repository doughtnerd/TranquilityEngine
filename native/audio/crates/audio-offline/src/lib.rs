//! Myco's offline sample render (ADR 0342 "Baked effects are rendered offline", ADR 0345 level
//! "sample"): a sample's baked effect chain with its automation lanes, over the sample's edited
//! PCM, with the tails delay and reverb leave. Built by `npm run build:audio`
//! (`native/audio/build.mjs`) to `src/engine/audio/sample/wasm/myco_audio_offline.wasm`, which is
//! committed; `src/engine/audio/sample/sampleRender.ts` drives it. The mixer's wasm, size and ABI
//! are untouched: this is its own module, sharing the kernels (`audio_dsp::fx`) and the curve
//! evaluator (`audio_core::automation`).
//!
//! Like the decoder, it **exports** its memory and owns its allocator: it runs alone (a worker,
//! the Studio's page, Node). The C ABI ([`ABI_VERSION`] 1.1):
//!
//! 1. `p = myco_offline_alloc(bytes)` for the input (interleaved `f32`) and the spec (`f64`,
//!    `spec.rs`); copy them in.
//! 2. `h = myco_offline_render(pcm, frames, channels, rate, spec, specLen)`: 0 when an argument
//!    or the spec is malformed. The inputs stay the caller's (free them with `myco_offline_free`).
//! 3. `myco_offline_output_pcm(h)`, `_frames(h)` (the channels are the input's) and
//!    `_warnings(h)` (bits of `render::warn`); then `myco_offline_output_free(h)`.
//!
//! What runs and how is in `render.rs`; the offline-only kinds are fades, the envelope, reverse
//! and noise reduction (`nr.rs`).
//!
//! ABI 1.1 (ADR 0352 §7, B5): the module **imports** `myco_ext` (`audio_core::ext`'s five calls), which
//! the caller binds to the plugin glue (`effectGlue.ts`) so plugin effects in a spec (version 2,
//! 16 parameters per effect) run as they do in the core's chains. A caller with no plugins binds
//! stubs (`acquire` 0): plugin effects then pass through with `render::warn::PLUGIN_DRY`.

pub mod lane;
pub mod nr;
pub mod render;
pub mod spec;
pub mod timemap;

use std::alloc::{alloc, dealloc, Layout};

/// `(major << 8) | minor` of this ABI.
pub const ABI_VERSION: u32 = 0x101;
/// Alignment of every `myco_offline_alloc` block (f32 and f64 views).
pub const ALLOC_ALIGN: usize = 16;

static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

fn layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len, ALLOC_ALIGN).ok()
}

/// `(major << 8) | minor`.
#[no_mangle]
pub extern "C" fn myco_offline_abi_version() -> u32 {
    ABI_VERSION
}

/// 16 bytes: the audio core's source hash (the mixer's `myco_audio_source_hash` gives the same).
#[no_mangle]
pub extern "C" fn myco_offline_source_hash() -> *const u8 {
    SOURCE_HASH.as_ptr()
}

/// A block of `len` bytes aligned to 16, or 0 when `len` is 0 or memory can't grow.
#[no_mangle]
pub extern "C" fn myco_offline_alloc(len: u32) -> *mut u8 {
    match layout(len as usize) {
        // SAFETY: a non-zero size (checked) and a valid layout.
        Some(l) if len > 0 => unsafe { alloc(l) },
        _ => std::ptr::null_mut(),
    }
}

/// Frees a block from `myco_offline_alloc(len)` (the same `len`). Null is ignored.
///
/// # Safety
/// `ptr` must come from `myco_offline_alloc(len)` and not be freed already.
#[no_mangle]
pub unsafe extern "C" fn myco_offline_free(ptr: *mut u8, len: u32) {
    if let (false, Some(l)) = (ptr.is_null(), layout(len as usize)) {
        dealloc(ptr, l);
    }
}

/// Renders `frames` interleaved frames of `channels` at `rate` through the spec; returns the
/// output's handle, or 0 when an argument or the spec is malformed.
///
/// # Safety
/// `pcm` must point at `frames × channels` floats and `spec` at `spec_len` doubles, both aligned.
#[no_mangle]
pub unsafe extern "C" fn myco_offline_render(pcm: *const f32, frames: u32, channels: u32, rate: f32, spec: *const f64, spec_len: u32) -> *mut render::Output {
    let Some(samples) = (frames as usize).checked_mul(channels as usize) else { return std::ptr::null_mut() };
    if channels == 0 || !(rate > 0.0 && rate.is_finite()) || spec.is_null() || (samples > 0 && pcm.is_null()) {
        return std::ptr::null_mut();
    }
    let input: &[f32] = if samples == 0 { &[] } else { core::slice::from_raw_parts(pcm, samples) };
    let Some(spec) = spec::parse(core::slice::from_raw_parts(spec, spec_len as usize)) else { return std::ptr::null_mut() };
    Box::into_raw(Box::new(render::render(input, channels as usize, rate, &spec)))
}

/// The output's interleaved samples.
///
/// # Safety
/// `h` must be a live handle from `myco_offline_render`.
#[no_mangle]
pub unsafe extern "C" fn myco_offline_output_pcm(h: *const render::Output) -> *const f32 {
    (*h).pcm.as_ptr()
}

/// The output's frames.
///
/// # Safety
/// As [`myco_offline_output_pcm`].
#[no_mangle]
pub unsafe extern "C" fn myco_offline_output_frames(h: *const render::Output) -> u32 {
    (*h).frames as u32
}

/// The output's warning bits (`render::warn`).
///
/// # Safety
/// As [`myco_offline_output_pcm`].
#[no_mangle]
pub unsafe extern "C" fn myco_offline_output_warnings(h: *const render::Output) -> u32 {
    (*h).warnings
}

/// Frees an output. Null is ignored.
///
/// # Safety
/// `h` must be null or a live handle from `myco_offline_render`, not freed already.
#[no_mangle]
pub unsafe extern "C" fn myco_offline_output_free(h: *mut render::Output) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_abi_renders_through_its_own_allocations() {
        let input: [f32; 4] = [0.5, 0.25, 0.5, 0.25];
        // version, 1 effect, 0 lanes, 0 segments, cap; gain +6 dB (16 parameters).
        let mut spec = [0.0f64; 23];
        spec[..8].copy_from_slice(&[2.0, 1.0, 0.0, 0.0, 10.0, 7.0, 1.0, 6.0]);
        unsafe {
            let p = myco_offline_alloc(16) as *mut f32;
            core::ptr::copy_nonoverlapping(input.as_ptr(), p, 4);
            let s = myco_offline_alloc(23 * 8) as *mut f64;
            core::ptr::copy_nonoverlapping(spec.as_ptr(), s, 23);
            let h = myco_offline_render(p, 2, 2, 48_000.0, s, 23);
            assert!(!h.is_null());
            assert_eq!(myco_offline_output_frames(h), 2);
            let out = core::slice::from_raw_parts(myco_offline_output_pcm(h), 4);
            assert!((out[0] - 0.5 * libm::powf(10.0, 0.3)).abs() < 1e-6);
            assert_eq!(myco_offline_output_warnings(h), 0);
            myco_offline_output_free(h);
            assert!(myco_offline_render(p, 2, 2, 48_000.0, s, 22).is_null(), "a malformed spec");
            assert!(myco_offline_render(p, 2, 0, 48_000.0, s, 23).is_null(), "no channels");
            myco_offline_free(p as *mut u8, 16);
            myco_offline_free(s as *mut u8, 23 * 8);
        }
        assert_eq!(myco_offline_abi_version(), 0x101);
    }
}
