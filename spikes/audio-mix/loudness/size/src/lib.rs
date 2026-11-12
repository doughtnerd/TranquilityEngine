//! Size probe: a wasm module that exports one entry using the own meter, the `ebur128` crate, or neither (base).
#![allow(clippy::missing_safety_doc)]
use loudspike::loud::{Loudness, TpMode};

/// Exported in every variant so the base module holds an equivalent shell.
#[no_mangle]
pub unsafe extern "C" fn probe(l: *const f32, r: *const f32, out: *mut f32, state: *mut u8) {
    let (l, r) = (core::slice::from_raw_parts(l, 128), core::slice::from_raw_parts(r, 128));
    #[cfg(feature = "own")]
    {
        let b = &mut *(state as *mut Loudness);
        b.process(l, r);
        *out = b.ring[0] + b.tp[0];
    }
    #[cfg(feature = "ebur")]
    {
        let m = &mut *(state as *mut loudspike::ebur::Ref);
        m.add(l, r);
        *out = (m.m.loudness_momentary().unwrap_or(0.0) + m.m.loudness_global().unwrap_or(0.0) + m.m.loudness_range().unwrap_or(0.0) + m.m.true_peak(0).unwrap_or(0.0)) as f32;
    }
    #[cfg(not(any(feature = "own", feature = "ebur")))]
    {
        let _ = state;
        *out = l[0] + r[0];
    }
}

#[cfg(feature = "own")]
#[no_mangle]
pub extern "C" fn probe_new() -> *mut Loudness {
    Box::into_raw(Box::new(Loudness::new(48000.0, TpMode::Full)))
}

#[cfg(feature = "ebur")]
#[no_mangle]
pub extern "C" fn probe_new_ebur() -> *mut loudspike::ebur::Ref {
    Box::into_raw(Box::new(loudspike::ebur::Ref::full(48000)))
}
