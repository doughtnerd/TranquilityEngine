//! C ABI for Node and the AudioWorklet. JS allocates the HRIR asset (`alloc`, copies
//! `myco_hrir.bin` in), calls `init_shared`, then `case_init` / `case_quantum` / `case_reset`.
#![allow(static_mut_refs)]
use crate::cases::*;

static mut SHARED: Option<Shared> = None;
static mut CASE: Option<Box<dyn Case>> = None;

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn init_shared(ptr: *const u8, len: usize) {
    let asset = std::slice::from_raw_parts(ptr, len);
    SHARED = Some(Shared::new(asset));
}

#[no_mangle]
pub extern "C" fn case_count() -> u32 { NAMES.len() as u32 }

/// Builds case `id` (index into `NAMES`); returns 0 on success.
#[no_mangle]
pub unsafe extern "C" fn case_init(id: u32) -> u32 {
    CASE = None; // free the previous case first
    match NAMES.get(id as usize).and_then(|n| make(n, SHARED.as_ref().unwrap())) {
        Some(c) => { CASE = Some(c); 0 }
        None => 1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn case_reset() { CASE.as_mut().unwrap().reset(); }

#[no_mangle]
pub unsafe extern "C" fn case_quantum() -> f32 { CASE.as_mut().unwrap().quantum() }

/// Left output (128 floats) then right, of the last quantum, for checksums.
#[no_mangle]
pub unsafe extern "C" fn case_out(ch: u32) -> *const f32 {
    let (l, r) = CASE.as_ref().unwrap().out();
    if ch == 0 { l.as_ptr() } else { r.as_ptr() }
}

#[no_mangle]
pub unsafe extern "C" fn sizes(which: u32) -> u32 {
    let s = SHARED.as_ref().unwrap();
    (match which { 0 => s.speakers.bytes(), 1 => s.sh_quad.bytes(), 2 => s.sh_ls.bytes(), 3 => s.sh_mag.bytes(), _ => 0 }) as u32
}
