//! Runtime-only module for the size measurement (feature `min`): the bed encoder, the SH decoder
//! with its filters loaded as data, and the rotation. No filter design, no HRTF panner.
#![allow(static_mut_refs)]
use crate::decoder::*;
use crate::encoder::*;
use crate::sh::*;

struct State { voices: BedVoices, bed: Bed, dec: Decoder, l: [f32; Q], r: [f32; Q], rb: RotBuilder, rot: Rot }
static mut S: Option<State> = None;

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// `filters`: the f32 dump (16 x 2 partitions x 128 bins, both ears).
#[no_mangle]
pub unsafe extern "C" fn min_init(ptr: *const f32, len: usize, voices: u32) {
    let raw = std::slice::from_raw_parts(ptr, len);
    S = Some(State { voices: BedVoices::new(voices as usize, 1000, true), bed: Bed::new(), dec: Decoder::new(Filters::from_raw(16, raw)), l: [0.0; Q], r: [0.0; Q], rb: RotBuilder::new(), rot: Rot::IDENTITY });
}

#[no_mangle]
pub unsafe extern "C" fn min_quantum() -> f32 {
    let s = S.as_mut().unwrap();
    s.bed.clear();
    s.voices.encode_all(&mut s.bed);
    s.dec.process(&s.bed, 16, &mut s.l, &mut s.r);
    s.l[0] + s.r[Q - 1]
}

/// Rotates the bed in place by yaw/pitch/roll (ramped from the previous call's matrix).
#[no_mangle]
pub unsafe extern "C" fn min_rotate(yaw: f32, pitch: f32, roll: f32) -> f32 {
    let s = S.as_mut().unwrap();
    let next = s.rb.build(&euler(yaw as f64, pitch as f64, roll as f64));
    let inp = s.bed.ch;
    let refs: Vec<&[f32]> = inp.iter().map(|c| &c[..]).collect();
    let mut out = vec![[0.0f32; Q]; 16];
    apply_rot_ramp(&refs, &mut out, 16, &s.rot, &next);
    s.rot = next;
    for c in 0..16 { s.bed.ch[c] = out[c]; }
    s.bed.ch[3][0]
}
