//! S1 loudness spike: correctness checks (`mode=check`) and the per-quantum cost bench (`mode=cost`), native and wasm.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

pub mod loud;
pub mod signals;
#[cfg(feature = "ebur")]
pub mod ebur;
mod checks;

use loud::{Loudness, TpMode, QUANTUM};

// --- allocation counter (every alloc/realloc counts; own code must show 0) ---
pub struct Counting;
pub static ALLOCS: AtomicU64 = AtomicU64::new(0);
pub static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
// SAFETY: forwards to System.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        ALLOC_BYTES.fetch_add(l.size() as u64, Relaxed);
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        ALLOC_BYTES.fetch_add(n as u64, Relaxed);
        System.realloc(p, l, n)
    }
}
#[cfg(not(feature = "no-alloc-count"))]
#[global_allocator]
static A: Counting = Counting;

#[cfg(target_arch = "wasm32")]
mod platform {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn bench_now() -> f64;
        fn bench_print(ptr: *const u8, len: usize);
    }
    pub fn now_us() -> f64 {
        unsafe { bench_now() * 1000.0 }
    }
    pub fn print(s: &str) {
        unsafe { bench_print(s.as_ptr(), s.len()) }
    }
    pub const TARGET: &str = "wasm";
}
#[cfg(not(target_arch = "wasm32"))]
mod platform {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    pub fn now_us() -> f64 {
        T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e6
    }
    pub fn print(s: &str) {
        println!("{s}");
    }
    pub const TARGET: &str = "native";
}
pub use platform::{now_us, print, TARGET};

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn bench_main(ptr: *const u8, len: usize) {
    let args = unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(ptr, len)) };
    main(args);
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn bench_alloc(len: usize) -> *mut u8 {
    Box::leak(vec![0u8; len].into_boxed_slice()).as_mut_ptr()
}

fn arg<'a>(args: &'a str, k: &str) -> Option<&'a str> {
    args.split_whitespace().find_map(|a| a.strip_prefix(k)?.strip_prefix('='))
}

pub fn main(args: &str) {
    match arg(args, "mode").unwrap_or("check") {
        "check" => {
            let ok = checks::run(true);
            print(&format!("{{\"check\":\"ALL\",\"target\":\"{TARGET}\",\"pass\":{ok}}}"));
        }
        "cost" => cost(args),
        m => print(&format!("{{\"error\":\"unknown mode {m}\"}}")),
    }
}

// --- cost bench ---
const RATE: f64 = 48_000.0;
const NQ: usize = 1024; // quanta of pre-generated signal per bus, cycled

fn make_signal(sig: &str, seed: u64) -> signals::Stereo {
    let secs = NQ as f64 * QUANTUM as f64 / RATE;
    match sig {
        // a typical -23 LUFS-ish mix: peaks around -9..-12 dBFS, loud swings reach about -6
        "music" => signals::music(RATE, secs, 0.5, seed),
        // a loud master: peaks near 0 dBFS (every quantum is over any sane gate)
        "hot" => signals::music(RATE, secs, 0.99, seed),
        // 200 ms tone bursts and digital silence (denormal path)
        "burst" => signals::burst(RATE, secs, 0.5),
        _ => (vec![0.0; NQ * QUANTUM], vec![0.0; NQ * QUANTUM]),
    }
}

fn pct(v: &[f64], p: f64) -> f64 {
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

fn cost(args: &str) {
    let case = arg(args, "case").unwrap_or("both");
    let sig = arg(args, "sig").unwrap_or("music");
    let k: usize = arg(args, "k").and_then(|s| s.parse().ok()).unwrap_or(1);
    let runs: usize = arg(args, "runs").and_then(|s| s.parse().ok()).unwrap_or(5);
    let quanta: usize = arg(args, "quanta").and_then(|s| s.parse().ok()).unwrap_or(30_000);
    let warm = quanta / 10;
    let sigs: Vec<signals::Stereo> = (0..k).map(|b| make_signal(sig, 11 + b as u64 * 7)).collect();
    let gate = TpMode::Gated(0.5);
    for run in 0..runs {
        let mut buses: Vec<Loudness> = (0..k)
            .map(|_| Loudness::new(RATE, match case { "tp" | "both" => TpMode::Full, "both_gated" => gate, _ => TpMode::Off }))
            .collect();
        #[cfg(feature = "ebur")]
        let mut refs: Vec<ebur::Ref> = (0..k)
            .map(|_| match case {
                "ebur_i" => ebur::Ref::new(48000, ebur128::Mode::I),
                "ebur_tp" => ebur::Ref::new(48000, ebur128::Mode::TRUE_PEAK),
                _ => ebur::Ref::full(48000),
            })
            .collect();
        let mut peaks: Vec<audio_core::meters::Meter> = vec![Default::default(); k];
        let decay = audio_core::meters::decay_per_block(48000.0, QUANTUM);
        let mut samples = Vec::with_capacity(quanta);
        let mut sink = 0.0f64;
        let mut a0 = 0;
        for q in 0..warm + quanta {
            if q == warm {
                a0 = ALLOCS.load(Relaxed);
            }
            let t0 = now_us();
            for b in 0..k {
                let o = ((q + b * 37) % NQ) * QUANTUM;
                let (l, r) = (&sigs[b].0[o..o + QUANTUM], &sigs[b].1[o..o + QUANTUM]);
                match case {
                    "floor" => {}
                    "peak" => peaks[b].update(l, r, decay),
                    "kw" => buses[b].process_energy(l, r),
                    "tp" | "both" | "both_gated" => buses[b].process(l, r),
                    #[cfg(feature = "ebur")]
                    "ebur_add" | "ebur_i" | "ebur_tp" => refs[b].add(l, r),
                    #[cfg(feature = "ebur")]
                    "ebur_full" => {
                        refs[b].add(l, r);
                        if q % 6 == 5 {
                            // what a STATUS take would read
                            sink += refs[b].m.loudness_momentary().unwrap_or(0.0) + refs[b].m.true_peak(0).unwrap_or(0.0);
                        }
                    }
                    _ => {}
                }
                if case.starts_with("kw") || case.starts_with("both") || case == "tp" {
                    if q % 6 == 5 {
                        sink += buses[b].take_peak()[0] as f64; // STATUS take
                    }
                }
            }
            let t1 = now_us();
            if q >= warm {
                samples.push(t1 - t0);
            }
        }
        let allocs = ALLOCS.load(Relaxed) - a0;
        let ran: f64 = buses.iter().map(|b| b.tp_ran as f64).sum::<f64>() / (k * (warm + quanta)) as f64;
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        print(&format!(
            "{{\"target\":\"{TARGET}\",\"case\":\"{case}\",\"sig\":\"{sig}\",\"k\":{k},\"run\":{run},\"quanta\":{quanta},\"p50\":{:.3},\"p99\":{:.3},\"p999\":{:.3},\"max\":{:.3},\"mean\":{:.3},\"allocs\":{allocs},\"tp_ran\":{ran:.3},\"sink\":{}}}",
            pct(&samples, 0.5),
            pct(&samples, 0.99),
            pct(&samples, 0.999),
            samples[samples.len() - 1],
            mean,
            (sink as i64 & 1),
        ));
    }
}
