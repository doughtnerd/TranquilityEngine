//! Audio M3 spike: what do reverb zones cost on M1's staged convolver? See README.md.
//! Throwaway code; nothing here ships.

pub mod cases;
pub mod checks;
pub mod conv;
pub mod util;

use cases::{make, specs, Case, Kind};
use std::cell::RefCell;

/// The case catalogue as JSON (shared by the native and wasm runners).
pub fn catalog_json() -> String {
    let rows: Vec<String> = specs()
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{{\"id\":{i},\"name\":\"{}\",\"group\":\"{}\",\"units\":{},\"per_quantum\":{}}}", s.name, s.group, s.units, !matches!(s.kind, Kind::PrepAtOnce { .. })))
        .collect();
    format!("[{}]", rows.join(","))
}

// ---- wasm C ABI (single-threaded; the Node and browser runners drive it) ----------------------

thread_local! {
    static CASES: RefCell<Vec<Option<Box<dyn Case>>>> = const { RefCell::new(Vec::new()) };
    static TEXT: RefCell<String> = const { RefCell::new(String::new()) };
}

fn set_text(s: String) -> u32 {
    TEXT.with(|t| {
        *t.borrow_mut() = s;
        t.borrow().len() as u32
    })
}

#[no_mangle]
pub extern "C" fn text_ptr() -> *const u8 {
    TEXT.with(|t| t.borrow().as_ptr())
}

/// Writes the catalogue JSON to the text buffer; returns its length.
#[no_mangle]
pub extern "C" fn catalog() -> u32 {
    set_text(catalog_json())
}

#[no_mangle]
pub extern "C" fn make_case(id: u32, run: u32) -> u32 {
    let c = make(&specs()[id as usize], run);
    CASES.with(|v| {
        let mut v = v.borrow_mut();
        v.push(Some(c));
        v.len() as u32 - 1
    })
}

fn with_case<R>(h: u32, f: impl FnOnce(&mut dyn Case) -> R) -> R {
    CASES.with(|v| f(v.borrow_mut()[h as usize].as_deref_mut().unwrap()))
}

#[no_mangle]
pub extern "C" fn prepare(h: u32) {
    with_case(h, |c| c.prepare())
}

#[no_mangle]
pub extern "C" fn step(h: u32) -> f32 {
    with_case(h, |c| c.step())
}

#[no_mangle]
pub extern "C" fn mem_bytes(h: u32) -> u32 {
    with_case(h, |c| c.mem_bytes() as u32)
}

#[no_mangle]
pub extern "C" fn samples(h: u32, quanta: u32) -> u32 {
    with_case(h, |c| c.samples(quanta as usize) as u32)
}

/// Writes the case's note to the text buffer; returns its length.
#[no_mangle]
pub extern "C" fn note(h: u32) -> u32 {
    set_text(with_case(h, |c| c.note()))
}

#[no_mangle]
pub extern "C" fn free_case(h: u32) {
    CASES.with(|v| v.borrow_mut()[h as usize] = None)
}

/// Runs the correctness checks (`secs_mask` bit 0/1/2 = 1/2/4 s IRs in the direct-convolution
/// check, `stride` = every n-th output sample compared); writes the report to the text buffer
/// (`text_ptr`, `text_len`) and returns the failure count.
#[no_mangle]
pub extern "C" fn run_checks(stride: u32, secs_mask: u32) -> u32 {
    let secs: Vec<u32> = [1u32, 2, 4].into_iter().filter(|s| secs_mask & s != 0).collect();
    let r = checks::run_all(stride as usize, &secs);
    set_text(r.lines.join("\n"));
    r.fails
}

#[no_mangle]
pub extern "C" fn text_len() -> u32 {
    TEXT.with(|t| t.borrow().len() as u32)
}
