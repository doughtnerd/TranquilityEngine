//! The voice resampler's budget (A3.6; architecture §6's per-voice cost *c*_v):
//! - `lagrange`, `linear` and `advance` never allocate (every allocation on this thread is counted);
//! - the cost of one 128-frame quantum of one voice for the 4-point kernel and for linear, by
//!   format, channels and pitch (the kernel alone: the core adds ramps, the panner and the bus mix).
//!   The timing test is `#[ignore]`d (it needs a release build and an idle machine):
//!   `cargo test --release -p audio-dsp --test resample_budget -- --ignored --nocapture`.

use audio_dsp::resample::{advance, lagrange, linear, Samples, Source};
use std::alloc::{GlobalAlloc, System};
use std::cell::Cell;
use std::hint::black_box;
use std::time::Instant;

const QUANTUM: usize = 128;
/// One second at 48 kHz: big enough that pitch 16 walks through memory as a real clip would.
const CLIP_FRAMES: usize = 48_000;

thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

fn allocations() -> u64 {
    ALLOCATIONS.with(Cell::get)
}

/// Deterministic noise in [-1, 1), `n` values.
fn noise(n: usize) -> Vec<f32> {
    let mut s = 0x1234_5678u32;
    (0..n)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 8) as f32 / (1u32 << 23) as f32 - 1.0
        })
        .collect()
}

#[test]
fn rendering_never_allocates() {
    let f = noise(2 * CLIP_FRAMES);
    let i: Vec<i16> = f.iter().map(|&v| (v * 32767.0) as i16).collect();
    let sources = [
        Source { samples: Samples::F32(&f), channels: 1, frames: CLIP_FRAMES as u32 },
        Source { samples: Samples::I16(&i), channels: 2, frames: CLIP_FRAMES as u32 },
    ];
    let steps = [1.37f32; QUANTUM];
    let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
    let before = allocations();
    for src in &sources {
        for &looping in &[false, true] {
            let mut pos = (CLIP_FRAMES - 100) as f64;
            for _ in 0..4 {
                lagrange(src, &mut pos, &steps, looping, &mut l, &mut r);
                linear(src, &mut pos, &steps, looping, &mut l, &mut r);
                advance(&mut pos, &steps, src.frames, looping);
            }
        }
    }
    assert_eq!(allocations(), before, "the resampler allocated");
}

#[derive(Clone, Copy)]
enum Kernel {
    Lagrange,
    Linear,
}

/// Mean µs per 128-frame quantum of one looping voice.
fn time(kernel: Kernel, src: &Source<'_>, pitch: f32) -> f64 {
    let steps = [pitch; QUANTUM];
    let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
    let mut pos = 0.25f64;
    let quanta = 200_000;
    let run = |pos: &mut f64, l: &mut [f32; QUANTUM], r: &mut [f32; QUANTUM], n: usize| {
        for _ in 0..n {
            match kernel {
                Kernel::Lagrange => lagrange(black_box(src), pos, &steps, true, l, r),
                Kernel::Linear => linear(black_box(src), pos, &steps, true, l, r),
            };
            black_box((&l, &r));
        }
    };
    run(&mut pos, &mut l, &mut r, quanta / 10);
    let start = Instant::now();
    run(&mut pos, &mut l, &mut r, quanta);
    start.elapsed().as_secs_f64() * 1e6 / quanta as f64
}

#[test]
#[ignore = "timing: run in release on an idle machine"]
fn cost_per_voice_quantum() {
    let f = noise(2 * CLIP_FRAMES);
    let i: Vec<i16> = f.iter().map(|&v| (v * 32767.0) as i16).collect();
    let cases = [
        ("mono f32", Source { samples: Samples::F32(&f), channels: 1, frames: CLIP_FRAMES as u32 }),
        ("stereo f32", Source { samples: Samples::F32(&f), channels: 2, frames: CLIP_FRAMES as u32 }),
        ("mono i16", Source { samples: Samples::I16(&i), channels: 1, frames: CLIP_FRAMES as u32 }),
        ("stereo i16", Source { samples: Samples::I16(&i), channels: 2, frames: CLIP_FRAMES as u32 }),
    ];
    for (name, src) in &cases {
        for &pitch in &[1.0f32, 1.37, 4.0, 16.0] {
            let a = time(Kernel::Lagrange, src, pitch);
            let b = time(Kernel::Linear, src, pitch);
            println!("{name:>10} pitch {pitch:>5}: lagrange {a:.3} µs, linear {b:.3} µs per voice quantum (+{:.3})", a - b);
        }
    }
}
