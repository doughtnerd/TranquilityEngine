//! The master limiter's budget (A2.8; architecture §6's per-quantum budget):
//! - `process` and `reset` never allocate (every allocation on this thread is counted);
//! - the cost per quantum while limiting (the per-frame path) and while bypassed (the scan only).
//!   The timing test is `#[ignore]`d (it needs a release build and an idle machine):
//!   `cargo test --release -p audio-dsp --test limiter_budget -- --ignored --nocapture`.

use audio_dsp::limiter::Limiter;
use std::alloc::{GlobalAlloc, System};
use std::cell::Cell;
use std::time::Instant;

const QUANTUM: usize = 128;

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

/// Quanta of four summed full-scale tones (about +10 dBFS peaks), scaled by `amp`.
fn inputs(amp: f32, quanta: usize) -> Vec<([f32; QUANTUM], [f32; QUANTUM])> {
    let tone = |hz: f32, i: usize| libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / 48_000.0);
    (0..quanta)
        .map(|q| {
            let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
            for k in 0..QUANTUM {
                let i = q * QUANTUM + k;
                l[k] = amp * (tone(110.0, i) + tone(330.0, i) + tone(440.0, i) + tone(997.0, i));
                r[k] = amp * (tone(165.0, i) + tone(330.0, i) + tone(550.0, i) + tone(1_201.0, i));
            }
            (l, r)
        })
        .collect()
}

#[test]
fn process_and_reset_never_allocate() {
    let blocks = inputs(1.0, 64);
    let mut lim = Limiter::new(48_000.0);
    let before = allocations();
    for (l, r) in &blocks {
        let (mut l, mut r) = (*l, *r);
        lim.process(&mut l, &mut r);
    }
    lim.reset();
    assert_eq!(allocations(), before);
}

/// Average and p99.9 of `process` per quantum over `blocks`, in ms.
fn time(blocks: &[([f32; QUANTUM], [f32; QUANTUM])]) -> (f64, f64, f64) {
    let mut lim = Limiter::new(48_000.0);
    let mut times = Vec::with_capacity(blocks.len());
    let mut sink = 0.0f32;
    for (l, r) in blocks {
        let (mut l, mut r) = (*l, *r);
        let t = Instant::now();
        lim.process(&mut l, &mut r);
        times.push(t.elapsed().as_secs_f64() * 1e3);
        sink += l[0] + r[QUANTUM - 1];
    }
    assert!(sink.is_finite());
    let avg = times.iter().sum::<f64>() / times.len() as f64;
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (avg, times[times.len() * 999 / 1000], times[times.len() - 1])
}

#[test]
#[ignore = "timing: release build on an idle machine"]
fn cost_per_quantum() {
    const N: usize = 20_000;
    let (avg, p999, max) = time(&inputs(1.0, N));
    println!("limiter, limiting 48 kHz stereo: average {avg:.5} ms, p99.9 {p999:.5} ms, max {max:.4} ms over {N} quanta");
    let (bavg, bp999, bmax) = time(&inputs(0.2, N));
    println!("limiter, bypassed (under the ceiling): average {bavg:.5} ms, p99.9 {bp999:.5} ms, max {bmax:.4} ms over {N} quanta");
    // A quantum at 48 kHz is 2.67 ms; the limiter is a few hundred flops of it.
    assert!(avg <= 0.01, "average {avg} ms");
    assert!(bavg <= avg, "the bypass is cheaper than limiting");
}
