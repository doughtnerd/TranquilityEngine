//! The shared reverb's budget (ADR 0157, api-and-models §9 row A2.2b; architecture §6.1):
//! - `process` and `reset` never allocate (every allocation on this thread is counted);
//! - the cost per quantum, at most 0.1 ms on average and 0.35 ms at p99.9. The timing test is
//!   `#[ignore]`d (it needs a release build and an idle machine):
//!   `cargo test --release -p audio-dsp --test convolver_budget -- --ignored --nocapture`.

use std::alloc::{GlobalAlloc, System};
use std::cell::Cell;
use std::time::Instant;

use audio_dsp::convolver::{self, QUANTUM};

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

fn region(sample_rate: f32) -> Vec<u64> {
    let mut r = vec![0u64; convolver::region_bytes(sample_rate).div_ceil(8)];
    convolver::init(bytes(&mut r), sample_rate);
    r
}

fn bytes(r: &mut [u64]) -> &mut [u8] {
    // SAFETY: a u64 buffer viewed as its bytes.
    unsafe { core::slice::from_raw_parts_mut(r.as_mut_ptr() as *mut u8, r.len() * 8) }
}

fn inputs() -> Vec<[f32; QUANTUM]> {
    let mut s = 0x9E37_79B9u32;
    (0..64)
        .map(|_| {
            core::array::from_fn(|_| {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                (s as f32 / u32::MAX as f32) - 0.5
            })
        })
        .collect()
}

#[test]
fn process_and_reset_never_allocate() {
    let mut r = region(48_000.0);
    let input = inputs();
    let (mut l, mut rr) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
    let before = allocations();
    // Three tail cycles, a reset, and more: every schedule slot runs.
    for q in 0..100 {
        convolver::process(bytes(&mut r), &input[q % 64], &input[(q + 7) % 64], &mut l, &mut rr);
        if q == 50 {
            convolver::reset(bytes(&mut r));
        }
    }
    assert_eq!(allocations(), before, "process or reset allocated");
}

#[test]
#[ignore = "timing: release build on an idle machine"]
fn cost_per_quantum() {
    let mut r = region(48_000.0);
    let input = inputs();
    let (mut l, mut rr) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
    for q in 0..1_000 {
        convolver::process(bytes(&mut r), &input[q % 64], &input[(q + 7) % 64], &mut l, &mut rr);
    }
    const N: usize = 200_000;
    let mut times = Vec::with_capacity(N);
    for q in 0..N {
        let t = Instant::now();
        convolver::process(bytes(&mut r), &input[q % 64], &input[(q + 7) % 64], &mut l, &mut rr);
        times.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let avg = times.iter().sum::<f64>() / N as f64;
    // Per schedule slot (quantum index mod 16): the average, to show the spread.
    let mut slots = [0.0f64; 16];
    for (q, t) in times.iter().enumerate() {
        slots[q % 16] += t / (N / 16) as f64;
    }
    times.sort_by(|a, b| a.total_cmp(b));
    let p999 = times[N * 999 / 1000];
    let max = times[N - 1];
    println!("reverb 48 kHz stereo, 1.8 s: average {avg:.4} ms, p99.9 {p999:.4} ms, max {max:.4} ms over {N} quanta");
    println!("per slot (ms): {}", slots.iter().map(|s| format!("{s:.4}")).collect::<Vec<_>>().join(" "));
    assert!(avg <= 0.1, "average {avg} ms");
    assert!(p999 <= 0.35, "p99.9 {p999} ms");
}
