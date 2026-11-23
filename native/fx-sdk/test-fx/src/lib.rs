//! The SDK's test plugin (ADR 0352 B1): built to `native/fx-sdk/wasm/test_fx.wasm`, which the engine's tests validate,
//! instrument and run (`src/plugins/audio/runtime/effectPlugins/validate.test.ts`, `src/engine/wasm/fuel.test.ts`).
//!
//! Kinds:
//! - 0 `gain`: p[0] linear gain, ramped from p0 to p1 per sample.
//! - 1 `biquad8`: an 8-stage stereo TDF-II low-pass cascade, p[0] cutoff (Hz), p[1] Q (a heavy, realistic kernel for
//!   the fuel overhead measurement).
//! - 2 `hog`: allocates 256 KiB in `new` and passes audio through (the allocator must give it back on destroy).
//! - 3 `trap` (ADR 0352 B4, the glue's fault tests): `p1[0]` picks what `process` does: 0 halves the block (so a test
//!   tells it from the dry block a fault leaves), 1 executes `unreachable`, 2 writes a NaN, 3 grows its memory by a page (a
//!   module fault: `process` must never grow), 4 loops for ever (its fuel runs out), 5 writes a sample of 1000 (beyond ±64).
//!   Each fault happens once, on the block whose parameters changed to it (`Flags::params_changed`); later blocks halve.
#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use core::f32::consts::PI;
use myco_fx::{math, Effect, Flags, Status, PARAMS};

pub struct Gain;

impl Effect for Gain {
    fn new(_sample_rate: f32, _max_frames: usize) -> Self {
        Gain
    }
    fn reset(&mut self) {}
    fn process(&mut self, l: &mut [f32], r: &mut [f32], p0: &[f32; PARAMS], p1: &[f32; PARAMS], flags: Flags) -> Status {
        let n = l.len();
        let (g0, dg) = (p0[0], (p1[0] - p0[0]) / n.max(1) as f32);
        for i in 0..n {
            let g = g0 + dg * i as f32;
            l[i] *= g;
            r[i] *= g;
        }
        if flags.input_silent() {
            Status::Silent
        } else {
            Status::Ok
        }
    }
}

pub struct Biquad8 {
    sr: f32,
    coef: [f32; 5],
    z: [[f32; 2]; 16],
    ready: bool,
}

impl Effect for Biquad8 {
    fn new(sample_rate: f32, _max_frames: usize) -> Self {
        Biquad8 { sr: sample_rate, coef: [1.0, 0.0, 0.0, 0.0, 0.0], z: [[0.0; 2]; 16], ready: false }
    }
    fn reset(&mut self) {
        self.z = [[0.0; 2]; 16];
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], _p0: &[f32; PARAMS], p1: &[f32; PARAMS], flags: Flags) -> Status {
        if flags.params_changed() || !self.ready {
            let f = p1[0].clamp(20.0, self.sr * 0.45);
            let q = p1[1].max(0.1);
            let w = 2.0 * PI * f / self.sr;
            let (s, c) = (math::sin(w), math::cos(w));
            let alpha = s / (2.0 * q);
            let a0 = 1.0 + alpha;
            let b0 = (1.0 - c) * 0.5 / a0;
            self.coef = [b0, (1.0 - c) / a0, b0, -2.0 * c / a0, (1.0 - alpha) / a0];
            self.ready = true;
        }
        let [b0, b1, b2, a1, a2] = self.coef;
        for (ch, buf) in [l, r].into_iter().enumerate() {
            for s in 0..8 {
                let z = &mut self.z[s * 2 + ch];
                let (mut z1, mut z2) = (z[0], z[1]);
                for x in buf.iter_mut() {
                    let y = b0 * *x + z1;
                    z1 = b1 * *x - a1 * y + z2;
                    z2 = b2 * *x - a2 * y;
                    *x = y;
                }
                *z = [z1, z2];
            }
        }
        Status::Ok
    }
}

pub struct Trap;

impl Effect for Trap {
    fn new(_sample_rate: f32, _max_frames: usize) -> Self {
        Trap
    }
    fn reset(&mut self) {}
    fn process(&mut self, l: &mut [f32], r: &mut [f32], _p0: &[f32; PARAMS], p1: &[f32; PARAMS], flags: Flags) -> Status {
        // A fault happens once, on the block its mode arrives in (`params_changed`); later blocks are halved.
        let mode = if flags.params_changed() { p1[0] as u32 } else { 0 };
        match mode {
            1 => trap(),
            2 => l[0] = f32::NAN,
            3 => grow(),
            4 => spin(l),
            5 => r[0] = 1000.0,
            _ => {
                // A healthy block is halved, so a test tells the plugin's output from the dry block a fault leaves.
                for x in l.iter_mut().chain(r.iter_mut()) {
                    *x *= 0.5;
                }
            }
        }
        Status::Ok
    }
}

#[cfg(target_arch = "wasm32")]
fn trap() {
    core::arch::wasm32::unreachable()
}
#[cfg(not(target_arch = "wasm32"))]
fn trap() {
    panic!("trap")
}

#[cfg(target_arch = "wasm32")]
fn grow() {
    core::arch::wasm32::memory_grow(0, 1);
}
#[cfg(not(target_arch = "wasm32"))]
fn grow() {}

/// Never returns: an endless loop the optimiser can't remove (each pass writes the block).
fn spin(l: &mut [f32]) {
    let mut x = 0.0f32;
    loop {
        x += 1.0;
        // SAFETY: a valid element of the block; volatile so the loop has an effect.
        unsafe { core::ptr::write_volatile(&mut l[0], x) };
    }
}

pub struct Hog {
    held: Vec<u8>,
}

impl Effect for Hog {
    fn new(_sample_rate: f32, _max_frames: usize) -> Self {
        Hog { held: vec![1; 256 * 1024] }
    }
    fn reset(&mut self) {
        self.held.fill(1);
    }
    fn process(&mut self, _l: &mut [f32], _r: &mut [f32], _p0: &[f32; PARAMS], _p1: &[f32; PARAMS], _flags: Flags) -> Status {
        Status::Ok
    }
}

myco_fx::export_effects!(Gain, Biquad8, Hog, Trap);

#[cfg(test)]
mod tests {
    use super::MYCO_FX_KINDS;

    /// Drives kind `k` through the ABI's dispatch: create, fill the I/O block, process, read back, destroy.
    fn run(k: usize, input: f32, p0: [f32; 16], p1: [f32; 16], frames: u32) -> (Vec<f32>, Vec<f32>, i32) {
        let kind = &MYCO_FX_KINDS[k];
        let h = kind.create(48_000.0, 128);
        assert_ne!(h, 0);
        unsafe {
            let io = kind.io(h) as *mut f32;
            let block = std::slice::from_raw_parts_mut(io, 2 * 128 + 32);
            block[..256].fill(input);
            block[256..272].copy_from_slice(&p0);
            block[272..288].copy_from_slice(&p1);
            let status = kind.process(h, frames, 1);
            let (l, r) = (block[..128].to_vec(), block[128..256].to_vec());
            kind.destroy(h);
            (l, r, status)
        }
    }

    fn params(v: &[f32]) -> [f32; 16] {
        let mut p = [0.0; 16];
        p[..v.len()].copy_from_slice(v);
        p
    }

    #[test]
    fn gain_ramps_from_p0_to_p1_in_place_on_both_channels() {
        let (l, r, status) = run(0, 1.0, params(&[0.0]), params(&[1.0]), 128);
        assert_eq!(status, 0);
        assert_eq!(l[0], 0.0);
        assert!((l[64] - 0.5).abs() < 1e-6);
        assert_eq!(l, r);
    }

    #[test]
    fn frames_above_max_are_clamped_and_shorter_blocks_leave_the_rest() {
        let (l, _, _) = run(0, 1.0, params(&[0.5]), params(&[0.5]), 64);
        assert_eq!(l[63], 0.5);
        assert_eq!(l[64], 1.0);
        let (l, _, _) = run(0, 1.0, params(&[0.5]), params(&[0.5]), 10_000);
        assert_eq!(l[127], 0.5);
    }

    #[test]
    fn biquad_low_pass_settles_to_unity_on_dc() {
        let kind = &MYCO_FX_KINDS[1];
        let h = kind.create(48_000.0, 128);
        unsafe {
            let io = std::slice::from_raw_parts_mut(kind.io(h) as *mut f32, 288);
            io[256..288].copy_from_slice(&[[1000.0, 0.707].as_slice(), &[0.0; 14], &[1000.0, 0.707], &[0.0; 14]].concat());
            for _ in 0..200 {
                io[..256].fill(1.0);
                kind.process(h, 128, 0);
            }
            assert!((io[127] - 1.0).abs() < 1e-3, "{}", io[127]);
            kind.destroy(h);
        }
    }

    #[test]
    fn trap_mode_0_halves_the_block_and_5_writes_out_of_range() {
        let (l, r, status) = run(3, 0.25, params(&[0.0]), params(&[0.0]), 128);
        assert_eq!(status, 0);
        assert!(l.iter().chain(r.iter()).all(|&x| x == 0.125));
        let (l, r, _) = run(3, 0.25, params(&[5.0]), params(&[5.0]), 128);
        assert_eq!((l[0], r[0]), (0.25, 1000.0));
        let (l, _, _) = run(3, 0.25, params(&[2.0]), params(&[2.0]), 128);
        assert!(l[0].is_nan());
    }

    #[test]
    fn create_refuses_a_bad_kind_setup() {
        assert_eq!(MYCO_FX_KINDS[0].create(48_000.0, 0), 0);
        assert_eq!(MYCO_FX_KINDS[0].create(48_000.0, myco_fx::MAX_FRAMES + 1), 0);
        assert_eq!(MYCO_FX_KINDS[0].create(f32::NAN, 128), 0);
    }
}
