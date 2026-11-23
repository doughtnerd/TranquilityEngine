//! Spike B0 (ADR 0352): a test effect plugin written against a draft of the DSP ABI 1.0.
//!
//! Exports `myco_fx_abi`, `myco_fx_create`, `myco_fx_destroy`, `myco_fx_reset`, `myco_fx_io`, `myco_fx_process`,
//! `myco_fx_tail_frames` and its own `memory`; imports nothing (checked by the spike's driver). Kinds:
//!
//! - 0 `null`: returns at once (isolates the glue's own cost);
//! - 1 `gain`: p[0] linear gain, ramped from p0 to p1 per sample;
//! - 2 `tremolo`: p[0] rate in Hz, p[1] depth 0..1 (sine LFO);
//! - 3 `biquad8`: an 8-stage TDF-II low-pass cascade per channel, p[0] cutoff in Hz, p[1] Q;
//! - 4 `delay`: a 1 s stereo feedback delay, p[0] time in ms, p[1] feedback, p[2] mix (linear interpolation);
//! - 5 `faulty`: p1[0] picks a fault: 1 `unreachable`, 2 NaN output, 3 `memory.grow` in process, 4 an endless
//!   loop, 5 a sample of 1000; anything else is unity gain.

#![no_std]

extern crate alloc;

use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;
use core::f32::consts::PI;

// A bump allocator over `memory.grow`: `create` may allocate, `process` never does. Freed memory is not reused
// (the spike re-instantiates the module to recover, as the record's trap rule does).
mod bump {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;

    pub struct Bump(UnsafeCell<usize>);
    unsafe impl Sync for Bump {}

    unsafe impl GlobalAlloc for Bump {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let next = &mut *self.0.get();
            if *next == 0 {
                *next = core::arch::wasm32::memory_size(0) * 65536;
            }
            let start = (*next + layout.align() - 1) & !(layout.align() - 1);
            let end = start + layout.size();
            let have = core::arch::wasm32::memory_size(0) * 65536;
            if end > have {
                let pages = (end - have + 65535) / 65536;
                if core::arch::wasm32::memory_grow(0, pages) == usize::MAX {
                    return core::ptr::null_mut();
                }
            }
            *next = end;
            start as *mut u8
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    #[global_allocator]
    static ALLOC: Bump = Bump(UnsafeCell::new(0));
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const NPARAMS: usize = 16;

/// The I/O block: `l[max]`, `r[max]`, `p0[16]`, `p1[16]` in one allocation, so `myco_fx_io` is one pointer.
struct Io {
    buf: Vec<f32>,
    max: usize,
}

impl Io {
    fn new(max: usize) -> Self {
        Io { buf: vec![0.0; 2 * max + 2 * NPARAMS], max }
    }
    fn split(&mut self, frames: usize) -> (&mut [f32], &mut [f32], [f32; NPARAMS], [f32; NPARAMS]) {
        let max = self.max;
        let (lr, p) = self.buf.split_at_mut(2 * max);
        let (l, r) = lr.split_at_mut(max);
        let mut p0 = [0.0; NPARAMS];
        let mut p1 = [0.0; NPARAMS];
        p0.copy_from_slice(&p[..NPARAMS]);
        p1.copy_from_slice(&p[NPARAMS..2 * NPARAMS]);
        (&mut l[..frames], &mut r[..frames], p0, p1)
    }
}

struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z: [[f32; 2]; 16], // 8 stages × 2 channels
}

struct Delay {
    l: Vec<f32>,
    r: Vec<f32>,
    w: usize,
}

enum State {
    Null,
    Gain,
    Tremolo { phase: f32 },
    Biquad(Box<Biquad>),
    Delay(Delay),
    Faulty,
}

struct Instance {
    io: Io,
    sr: f32,
    state: State,
}

#[no_mangle]
pub extern "C" fn myco_fx_abi() -> u32 {
    0x0100
}

#[no_mangle]
pub extern "C" fn myco_fx_create(kind: u32, sample_rate: f32, max_frames: u32) -> u32 {
    let max = max_frames as usize;
    let state = match kind {
        0 => State::Null,
        1 => State::Gain,
        2 => State::Tremolo { phase: 0.0 },
        3 => State::Biquad(Box::new(Biquad { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z: [[0.0; 2]; 16] })),
        4 => {
            let n = sample_rate as usize + 1;
            State::Delay(Delay { l: vec![0.0; n], r: vec![0.0; n], w: 0 })
        }
        5 => State::Faulty,
        _ => return 0,
    };
    let inst = Box::new(Instance { io: Io::new(max), sr: sample_rate, state });
    Box::into_raw(inst) as u32
}

fn inst(state: u32) -> &'static mut Instance {
    unsafe { &mut *(state as *mut Instance) }
}

#[no_mangle]
pub extern "C" fn myco_fx_destroy(_kind: u32, state: u32) {
    unsafe { drop(Box::from_raw(state as *mut Instance)) }
}

#[no_mangle]
pub extern "C" fn myco_fx_reset(_kind: u32, state: u32) {
    match &mut inst(state).state {
        State::Tremolo { phase } => *phase = 0.0,
        State::Biquad(b) => b.z = [[0.0; 2]; 16],
        State::Delay(d) => {
            d.l.iter_mut().for_each(|x| *x = 0.0);
            d.r.iter_mut().for_each(|x| *x = 0.0);
        }
        _ => {}
    }
}

#[no_mangle]
pub extern "C" fn myco_fx_io(_kind: u32, state: u32) -> u32 {
    inst(state).io.buf.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn myco_fx_tail_frames(_kind: u32, state: u32) -> u32 {
    match &inst(state).state {
        State::Delay(d) => d.l.len() as u32 * 8,
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn myco_fx_process(_kind: u32, state: u32, frames: u32, flags: u32) -> i32 {
    let me = inst(state);
    let sr = me.sr;
    let n = frames as usize;
    let (l, r, p0, p1) = me.io.split(n);
    let inv = 1.0 / n.max(1) as f32;
    match &mut me.state {
        State::Null => {}
        State::Gain => {
            let (g0, dg) = (p0[0], (p1[0] - p0[0]) * inv);
            for i in 0..n {
                let g = g0 + dg * i as f32;
                l[i] *= g;
                r[i] *= g;
            }
        }
        State::Tremolo { phase } => {
            let (rate0, drate) = (p0[0], (p1[0] - p0[0]) * inv);
            let (d0, dd) = (p0[1], (p1[1] - p0[1]) * inv);
            let mut ph = *phase;
            for i in 0..n {
                let k = i as f32;
                let depth = d0 + dd * k;
                let m = 1.0 - depth * 0.5 * (1.0 - libm_sin(2.0 * PI * ph));
                l[i] *= m;
                r[i] *= m;
                ph += (rate0 + drate * k) / sr;
                if ph >= 1.0 {
                    ph -= 1.0;
                }
            }
            *phase = ph;
        }
        State::Biquad(b) => {
            if flags & 1 != 0 || b.b0 == 1.0 {
                let f = p1[0].clamp(20.0, sr * 0.45);
                let q = p1[1].max(0.1);
                let w = 2.0 * PI * f / sr;
                let (s, c) = (libm_sin(w), libm_sin(w + PI * 0.5));
                let alpha = s / (2.0 * q);
                let a0 = 1.0 + alpha;
                b.b0 = (1.0 - c) * 0.5 / a0;
                b.b1 = (1.0 - c) / a0;
                b.b2 = b.b0;
                b.a1 = -2.0 * c / a0;
                b.a2 = (1.0 - alpha) / a0;
            }
            let (b0, b1, b2, a1, a2) = (b.b0, b.b1, b.b2, b.a1, b.a2);
            for (ch, buf) in [l, r].into_iter().enumerate() {
                for s in 0..8 {
                    let z = &mut b.z[s * 2 + ch];
                    let (mut z1, mut z2) = (z[0], z[1]);
                    for x in buf.iter_mut() {
                        let y = b0 * *x + z1;
                        z1 = b1 * *x - a1 * y + z2;
                        z2 = b2 * *x - a2 * y;
                        *x = y;
                    }
                    z[0] = z1;
                    z[1] = z2;
                }
            }
        }
        State::Delay(d) => {
            let len = d.l.len();
            let (t0, dt) = (p0[0], (p1[0] - p0[0]) * inv);
            let fb = p1[1].clamp(0.0, 0.98);
            let mix = p1[2].clamp(0.0, 1.0);
            let mut w = d.w;
            for i in 0..n {
                let delay = ((t0 + dt * i as f32) * 0.001 * sr).clamp(1.0, (len - 2) as f32);
                let pos = w as f32 + len as f32 - delay;
                let i0 = pos as usize;
                let frac = pos - i0 as f32;
                let a = i0 % len;
                let b2 = (i0 + 1) % len;
                let yl = d.l[a] + (d.l[b2] - d.l[a]) * frac;
                let yr = d.r[a] + (d.r[b2] - d.r[a]) * frac;
                d.l[w] = l[i] + yl * fb;
                d.r[w] = r[i] + yr * fb;
                l[i] += (yl - l[i]) * mix;
                r[i] += (yr - r[i]) * mix;
                w += 1;
                if w == len {
                    w = 0;
                }
            }
            d.w = w;
        }
        State::Faulty => match p1[0] as u32 {
            1 => core::arch::wasm32::unreachable(),
            2 => l[n / 2] = f32::NAN,
            3 => {
                core::arch::wasm32::memory_grow(0, 1);
            }
            4 => {
                let mut x = 1u32;
                loop {
                    x = unsafe { core::ptr::read_volatile(&x) }.wrapping_mul(3);
                    if x == 0 {
                        break;
                    }
                }
            }
            5 => r[0] = 1000.0,
            _ => {}
        },
    }
    0
}

/// sin(x) for any x: range-reduced to [-pi, pi], then an odd polynomial (|error| < 2e-6). Pure wasm, no imports.
fn libm_sin(x: f32) -> f32 {
    let t = x * (1.0 / (2.0 * PI));
    let x = (t - floor(t + 0.5)) * 2.0 * PI;
    let x2 = x * x;
    x * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 + x2 * (1.0 / 362880.0 + x2 * (-1.0 / 39916800.0))))))
}

fn floor(x: f32) -> f32 {
    let i = x as i32 as f32;
    if i > x {
        i - 1.0
    } else {
        i
    }
}
