//! The bed probe (ADR 0162 A2, #120): the bit-identity digest and the bed timing of
//! api-and-models §10 row A2 ("bit-identical native and wasm; 256 voices decode within the spike's
//! 142 µs p50"), on the scene in `scenario.rs`.
//!
//! Native:
//! ```text
//! cargo run --release -p audio-dsp --example bed_probe -- digest
//! cargo run --release -p audio-dsp --example bed_probe -- bench [voices=256] [runs=5] [quanta=6000] [warm=500]
//! ```
//! Wasm (release, `+simd128` as the mixer; `run.mjs` builds it and runs it in Node):
//! ```text
//! node native/audio/crates/audio-dsp/examples/bed_probe/run.mjs digest|bench [voices runs quanta warm]
//! ```
//! Timing method (the bed spike's): one clock read around each quantum (`Instant` natively,
//! `performance.now()` in Node), the scene rebuilt and warmed up untimed before each run, nearest-rank
//! p50 and p99 per run, and the median over runs of each.
#![cfg_attr(target_arch = "wasm32", no_main)]

mod scenario;

#[cfg(not(target_arch = "wasm32"))]
use audio_dsp::ambisonic::QUANTUM;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::scenario::{self, Scene};
    use audio_dsp::ambisonic::QUANTUM;

    static mut SCENE: Option<Box<Scene>> = None;

    /// The identity digest.
    #[no_mangle]
    pub extern "C" fn probe_digest() -> u64 {
        scenario::digest()
    }

    /// Builds the bench scene with `voices` voices (no clip, as the spike's `bed256`).
    #[no_mangle]
    pub extern "C" fn probe_new(voices: u32) {
        // SAFETY: single-threaded module; nothing else holds a reference.
        unsafe { *core::ptr::addr_of_mut!(SCENE) = Some(Box::new(Scene::new(voices as usize, false))) };
    }

    /// Runs one quantum of the bench scene.
    #[no_mangle]
    pub extern "C" fn probe_quantum() {
        let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
        // SAFETY: as above.
        if let Some(s) = unsafe { (*core::ptr::addr_of_mut!(SCENE)).as_mut() } {
            s.quantum(&mut l, &mut r);
            core::hint::black_box((&l, &r));
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let num = |i: usize, d: usize| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    match args.first().map(String::as_str) {
        Some("digest") => println!("{:016x}", scenario::digest()),
        Some("bench") => {
            let (voices, runs, quanta, warm) = (num(1, 256), num(2, 5), num(3, 6000), num(4, 500));
            let mut p50s = Vec::new();
            let mut p99s = Vec::new();
            for run in 0..runs {
                let mut s = scenario::Scene::new(voices, false);
                let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
                for _ in 0..warm {
                    s.quantum(&mut l, &mut r);
                }
                let mut t = Vec::with_capacity(quanta);
                for _ in 0..quanta {
                    let t0 = std::time::Instant::now();
                    s.quantum(&mut l, &mut r);
                    t.push(t0.elapsed().as_secs_f64() * 1e6);
                    std::hint::black_box((&l, &r));
                }
                t.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let rank = |p: f64| t[((p * t.len() as f64).ceil() as usize).clamp(1, t.len()) - 1];
                let (p50, p99) = (rank(0.50), rank(0.99));
                println!("{{\"target\":\"native\",\"voices\":{voices},\"run\":{run},\"quanta\":{quanta},\"p50\":{p50:.2},\"p99\":{p99:.2}}}");
                p50s.push(p50);
                p99s.push(p99);
            }
            let median = |v: &mut Vec<f64>| {
                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                v[v.len() / 2]
            };
            println!("{{\"target\":\"native\",\"voices\":{voices},\"runs\":{runs},\"median_p50\":{:.2},\"median_p99\":{:.2}}}", median(&mut p50s), median(&mut p99s));
        }
        _ => {
            eprintln!("usage: bed_probe digest | bench [voices runs quanta warm]");
            std::process::exit(2);
        }
    }
}
