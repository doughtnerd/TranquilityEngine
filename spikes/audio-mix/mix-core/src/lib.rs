//! SPIKE S4 (audio M5, "the mix in the core"): costs and correctness of sidechain ducking, sample-accurate bus ramps and
//! snapshot blending of effect parameters, on the real `audio-dsp` kernels. Native and wasm32 from the same source.
//!
//! Modes (`mode=`): `check` (assertions, no timing), `micro` (per-call timing, `calls=`), `zipper` (step pattern of
//! main-thread BUS_MIX updates vs a stamped ramp, dB), `delay` (what a one-quantum-late detector costs a duck), `blend`
//! (click and error of snapshot blending schemes). Every non-timing mode is deterministic.
pub mod blend;
pub mod busramp;
pub mod sidechain;

use audio_dsp::biquad::{coeffs, kernel, Biquad};
use audio_dsp::compressor::Compressor;
use audio_dsp::ramp::Ramp;
use core::hint::black_box;
use sidechain::{Detect, Params, Rule, Q};

#[cfg(target_arch = "wasm32")]
mod platform {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn bench_now() -> f64;
        fn bench_print(ptr: *const u8, len: usize);
    }
    pub fn now_us() -> f64 {
        // SAFETY: an import with no preconditions.
        unsafe { bench_now() * 1000.0 }
    }
    pub fn print(s: &str) {
        // SAFETY: `s` is valid for its length during the call.
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
use platform::{now_us, print, TARGET};

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn bench_main(ptr: *const u8, len: usize) {
    // SAFETY: the runner wrote `len` bytes at `ptr`, from `bench_alloc`.
    let args = unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(ptr, len)) };
    main(args);
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn bench_alloc(len: usize) -> *mut u8 {
    Box::leak(vec![0u8; len].into_boxed_slice()).as_mut_ptr()
}

const RATE: f32 = 48_000.0;

fn arg<'a>(args: &'a str, key: &str) -> Option<&'a str> {
    args.split_whitespace().find_map(|a| a.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
}
fn num(args: &str, key: &str, default: f64) -> f64 {
    arg(args, key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

struct Rng(u32);
impl Rng {
    fn unit(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32 - 0.5
    }
}

/// A bank of `n` stereo quanta of bursty noise (a loud/quiet pattern, so detectors and gain computers see both).
fn bank(n: usize, seed: u32) -> Vec<[f32; 2 * Q]> {
    let mut r = Rng(seed);
    (0..n)
        .map(|q| {
            let amp = if (q / 8) % 2 == 0 { 0.4 } else { 0.01 };
            let mut b = [0.0f32; 2 * Q];
            for i in 0..2 * Q {
                b[i] = r.unit() * amp;
            }
            b
        })
        .collect()
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    sorted[(((sorted.len() - 1) as f64) * p).round() as usize]
}

/// Times `f` (one quantum of work) `calls` times, each call on its own clock read; also the mean of blocks of 64 calls.
fn bench(group: &str, case: &str, calls: usize, f: &mut dyn FnMut(usize)) {
    for i in 0..calls.min(3000) {
        f(i);
    }
    let mut v = Vec::with_capacity(calls);
    let mut blocks = Vec::with_capacity(calls / 64 + 1);
    let mut i = 0;
    while i < calls {
        let b0 = now_us();
        for _ in 0..64.min(calls - i) {
            let t0 = now_us();
            f(i);
            v.push((now_us() - t0) * 1000.0);
            i += 1;
        }
        blocks.push((now_us() - b0) * 1000.0 / 64.0);
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    blocks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    print(&format!(
        "{{\"target\":\"{TARGET}\",\"group\":\"{group}\",\"case\":\"{case}\",\"unit\":\"ns/quantum\",\"calls\":{calls},\"p50\":{:.0},\"p99\":{:.0},\"p999\":{:.0},\"max\":{:.0},\"mean64_p50\":{:.0}}}",
        pct(&v, 0.5),
        pct(&v, 0.99),
        pct(&v, 0.999),
        v[v.len() - 1],
        pct(&blocks, 0.5)
    ));
}

fn split(b: &[f32; 2 * Q]) -> (&[f32], &[f32]) {
    b.split_at(Q)
}

fn micro(args: &str) {
    let calls = num(args, "calls", 100_000.0) as usize;
    let trig = bank(64, 1);
    let tgt = bank(64, 2);
    let p = |d| Params::sound_lab(d);
    // --- sidechain ---
    bench("sidechain", "timer-overhead", calls, &mut |i| {
        black_box(i);
    });
    for (dn, d) in [("peak", Detect::Peak), ("rms", Detect::Rms)] {
        let mut r = Rule::new(p(d));
        bench("sidechain", &format!("detector-{dn}"), calls, &mut |i| {
            let (l, rr) = split(&trig[i % 64]);
            black_box(r.detect(black_box(l), black_box(rr)));
        });
        for tick in [128usize, 16, 1] {
            let mut r = Rule::new(p(d));
            let mut g = [1.0f32; Q];
            bench("sidechain", &format!("rule-{dn}-tick{tick}"), calls, &mut |i| {
                let (l, rr) = split(&trig[i % 64]);
                r.process(black_box(l), black_box(rr), tick, &mut g);
                black_box(&g);
            });
        }
    }
    // The detector on silence after a loud passage (denormal check: the envelope decays toward 0).
    {
        let mut r = Rule::new(p(Detect::Peak));
        let silent = [0.0f32; Q];
        let loud = bank(1, 9);
        let (l, rr) = split(&loud[0]);
        r.detect(l, rr);
        bench("sidechain", "detector-peak-silence", calls, &mut |_| {
            black_box(r.detect(black_box(&silent), black_box(&silent)));
        });
    }
    {
        let g = [0.7f32; Q];
        let mut t = tgt.clone();
        bench("sidechain", "apply-curve", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            sidechain::apply(l, r, black_box(&g));
        });
    }
    // 8 rules on one target, each with its own trigger bank (tick 128, peak): process x8, combine x7, apply once.
    {
        let mut rules: Vec<Rule> = (0..8).map(|_| Rule::new(p(Detect::Peak))).collect();
        let mut gs = [[1.0f32; Q]; 8];
        let mut t = tgt.clone();
        bench("sidechain", "rules8-peak-tick128+apply", calls, &mut |i| {
            for (k, r) in rules.iter_mut().enumerate() {
                let (l, rr) = split(&trig[(i + k * 5) % 64]);
                r.process(l, rr, 128, &mut gs[k]);
            }
            let (first, rest) = gs.split_at_mut(1);
            for g in rest.iter() {
                sidechain::combine_min(&mut first[0], g);
            }
            let (l, r) = t[i % 64].split_at_mut(Q);
            sidechain::apply(l, r, &first[0]);
        });
    }
    // --- bus ramps ---
    {
        let mut t = tgt.clone();
        bench("busramp", "apply-settled-gain", calls, &mut |i| {
            let mut r = Ramp::at(0.8);
            let (l, rr) = t[i % 64].split_at_mut(Q);
            busramp::apply_ramp(&mut r, l, rr);
        });
        bench("busramp", "ramp-today-mid-ramp", calls, &mut |i| {
            let mut r = Ramp::at(1.0);
            r.set_target(0.0, 1 << 20);
            let (l, rr) = t[i % 64].split_at_mut(Q);
            busramp::apply_ramp(&mut r, l, rr);
        });
        let mut g = [1.0f32; Q];
        for (name, start, frames) in [("stamped-mid-ramp", 0u64, 1 << 20), ("stamped-starts-at-64", 64, 1 << 20), ("stamped-ends-at-64", 0, 64), ("stamped-2.7ms-ramp", 0, 128)] {
            let rec = busramp::Stamped { start, frames, from: 1.0, to: 0.0 };
            let q0 = if name == "stamped-mid-ramp" || name == "stamped-ends-at-64" { 0 } else { 0 };
            bench("busramp", name, calls, &mut |i| {
                let (l, rr) = t[i % 64].split_at_mut(Q);
                black_box(rec.fill(black_box(q0), &mut g));
                busramp::apply_curve(l, rr, &g);
            });
        }
        // 8 buses ramping at once, today's loop vs stamped.
        bench("busramp", "x8-ramp-today", calls, &mut |i| {
            for k in 0..8 {
                let mut r = Ramp::at(1.0);
                r.set_target(0.0, 1 << 20);
                let (l, rr) = t[(i + k) % 64].split_at_mut(Q);
                busramp::apply_ramp(&mut r, l, rr);
            }
        });
        let rec = busramp::Stamped { start: 0, frames: 1 << 20, from: 1.0, to: 0.0 };
        bench("busramp", "x8-stamped", calls, &mut |i| {
            for k in 0..8 {
                let (l, rr) = t[(i + k) % 64].split_at_mut(Q);
                rec.fill(0, &mut g);
                busramp::apply_curve(l, rr, &g);
            }
        });
    }
    // --- blending ---
    {
        let mut t = tgt.clone();
        let mut b = Biquad::default();
        b.set_lowpass(RATE, 2000.0, 1.0);
        bench("blend", "lowpass-settled", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            b.set_lowpass(RATE, 2000.0, 1.0);
            b.process(l, r);
        });
        let mut b = Biquad::default();
        let mut f = 2000.0f32;
        bench("blend", "lowpass-step-recompute-per-quantum", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            f = if f > 1990.0 { 500.0 } else { f + 1.0 };
            b.set_lowpass(RATE, f, 1.0);
            b.process(l, r);
        });
        let mut hist = [[0.0f64; 4]; 2];
        let (ca, cb) = (blend::coefs(blend::Kind::Lowpass, RATE, 18000.0, 1.0), blend::coefs(blend::Kind::Lowpass, RATE, 500.0, 1.0));
        bench("blend", "lowpass-coef-lerp-per-sample", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            let u0 = (i % 64) as f64 / 64.0;
            let du = 1.0 / 64.0 / Q as f64;
            let mut c = blend::lerp_coefs(&ca, &cb, u0);
            let dc = [(cb[0] - ca[0]) * du, (cb[1] - ca[1]) * du, (cb[2] - ca[2]) * du, (cb[3] - ca[3]) * du, (cb[4] - ca[4]) * du];
            let [mut lx1, mut lx2, mut ly1, mut ly2] = hist[0];
            let [mut rx1, mut rx2, mut ry1, mut ry2] = hist[1];
            for k in 0..Q {
                for j in 0..5 {
                    c[j] += dc[j];
                }
                let (xl, xr) = (l[k], r[k]);
                let yl = (c[0] * xl as f64 + c[1] * lx1 + c[2] * lx2 - c[3] * ly1 - c[4] * ly2) as f32;
                let yr = (c[0] * xr as f64 + c[1] * rx1 + c[2] * rx2 - c[3] * ry1 - c[4] * ry2) as f32;
                l[k] = yl;
                r[k] = yr;
                lx2 = lx1;
                lx1 = xl as f64;
                ly2 = ly1;
                ly1 = yl as f64;
                rx2 = rx1;
                rx1 = xr as f64;
                ry2 = ry1;
                ry1 = yr as f64;
            }
            hist = [[lx1, lx2, ly1, ly2], [rx1, rx2, ry1, ry2]];
        });
        let mut hist = [[0.0f64; 4]; 2];
        bench("blend", "lowpass-coef-lerp-per-quantum", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            let c = blend::lerp_coefs(&ca, &cb, (i % 64) as f64 / 64.0);
            kernel::process_stereo(&c, &mut hist, l, r);
        });
        let mut hist = [[0.0f64; 4]; 2];
        bench("blend", "lowpass-exact-recompute-per-sample", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            let f0 = blend::log_hz(18000.0, 500.0, (i % 64) as f32 / 64.0);
            for k in 0..Q {
                let f = f0 * libm::powf(500.0f32 / 18000.0, k as f32 / (64.0 * Q as f32));
                let c = blend::coefs(blend::Kind::Lowpass, RATE, f, 1.0);
                kernel::process_stereo(&c, &mut hist, &mut l[k..k + 1], &mut r[k..k + 1]);
            }
        });
        // Compressor: a threshold blended per quantum (configure each quantum) vs settled.
        let mut c = Compressor::default();
        c.configure(RATE, -24.0, 30.0, 8.0, 0.003, 0.25);
        bench("blend", "compressor-settled", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            c.process(l, r);
        });
        let mut c = Compressor::default();
        let mut th = -24.0f32;
        bench("blend", "compressor-threshold-blend-per-quantum", calls, &mut |i| {
            let (l, r) = t[i % 64].split_at_mut(Q);
            th = if th > -10.0 { -40.0 } else { th + 0.01 };
            c.configure(RATE, th, 30.0, 8.0, 0.003, 0.25);
            c.process(l, r);
        });
        let _ = coeffs::IDENTITY;
    }
}

// ---------------------------------------------------------------------------------------------------------------------

fn ok(check: &str, pass: bool, detail: String) {
    print(&format!("{{\"target\":\"{TARGET}\",\"check\":\"{check}\",\"pass\":{pass},\"detail\":\"{detail}\"}}"));
}

fn db(x: f64) -> f64 {
    20.0 * x.max(1e-30).log10()
}

fn check() {
    // 1. Peak detector: a step of 0.5 reaches 63% (+-4%) of 0.5 after the attack time (1 ms = 48 samples).
    {
        let mut r = Rule::new(Params::sound_lab(Detect::Peak));
        let (l, rr) = ([0.5f32; 48], [0.5f32; 48]);
        let e = r.detect(&l, &rr) / 0.5;
        ok("peak detector attack = 63% at 1 ms", (e - 0.632).abs() < 0.04, format!("{e:.3}"));
    }
    // 2. RMS detector reads A/sqrt2 for a sine of amplitude A (10 ms of 1 kHz after settling).
    {
        let mut p = Params::sound_lab(Detect::Rms);
        p.det_attack_ms = 10.0;
        p.det_release_ms = 10.0;
        let mut r = Rule::new(p);
        let mut e = 0.0;
        for q in 0..400 {
            let l: Vec<f32> = (0..Q).map(|i| 0.5 * libm::sinf(2.0 * core::f32::consts::PI * 1000.0 * (q * Q + i) as f32 / RATE)).collect();
            e = r.detect(&l, &l);
        }
        let want = 0.5 / 2f32.sqrt();
        ok("rms detector = A/sqrt2", ((e - want) / want).abs() < 0.02, format!("{e:.4} vs {want:.4}"));
    }
    // 3. Gate-mode computer: below threshold-knee/2 nothing, well over: the max reduction, in between: partial.
    {
        let p = Params::sound_lab(Detect::Peak);
        let (a, b, m) = (Rule::computer(&p, -60.0), Rule::computer(&p, -10.0), Rule::computer(&p, -40.0));
        ok("gain computer: none / max / knee midpoint", a == 0.0 && (b - p.max_reduction_db).abs() < 1e-4 && m > 0.0 && m < p.max_reduction_db, format!("{a} {b} {m}"));
    }
    // 4. Smoothing: from silence to a loud trigger, the reduction is 63% of max at the attack time (50 ms) and, after the
    //    trigger stops, 37% of max left at the release time (400 ms). The detector adds ~1 ms (its own attack) and ~30 ms release.
    for tick in [128usize, 16, 1] {
        let mut p = Params::sound_lab(Detect::Peak);
        p.det_release_ms = 1.0; // else the detector's own 30 ms release delays the start of the reduction's release
        let mut r = Rule::new(p);
        let mut g = [1.0f32; Q];
        let loud = [0.5f32; Q];
        let quiet = [0.0f32; Q];
        let max = r.p.max_reduction_db;
        let mut at_attack = 0.0;
        for _ in 0..(0.050 * RATE as f64 / Q as f64) as usize {
            r.process(&loud, &loud, tick, &mut g);
            at_attack = r.gr_db / max;
        }
        for _ in 0..200 {
            r.process(&loud, &loud, tick, &mut g);
        }
        let mut at_release = 0.0;
        for q in 0..(0.430 * RATE as f64 / Q as f64) as usize {
            r.process(&quiet, &quiet, tick, &mut g);
            if q == (0.404 * RATE as f64 / Q as f64) as usize {
                at_release = r.gr_db / max;
            }
        }
        // The attack figure is 0.63 of the way at ~50 ms of exponential; the detector's ~1 ms and the quantum granularity shift it a little.
        ok(&format!("duck attack 63% at 50 ms / release 37% at 400 ms (tick {tick})"), (at_attack - 0.632).abs() < 0.06 && (at_release - 0.368).abs() < 0.06, format!("attack {at_attack:.3} release {at_release:.3}"));
    }
    // 5. Ticks agree: the gain curve with the gain computer every 128 / 16 / 1 samples, on the bursty bank, max difference in dB.
    {
        let trig = bank(400, 5);
        let mut worst = [0.0f64; 2];
        let mut rs = [Rule::new(Params::sound_lab(Detect::Peak)), Rule::new(Params::sound_lab(Detect::Peak)), Rule::new(Params::sound_lab(Detect::Peak))];
        let mut gs = [[1.0f32; Q]; 3];
        for q in 0..400 {
            let (l, rr) = split(&trig[q]);
            for (k, tick) in [128usize, 16, 1].into_iter().enumerate() {
                rs[k].process(l, rr, tick, &mut gs[k]);
            }
            for i in 0..Q {
                for k in 0..2 {
                    worst[k] = worst[k].max(db(gs[k][i] as f64 / gs[2][i] as f64).abs());
                }
            }
        }
        ok("tick 128 and 16 vs per-sample: max |gain difference| dB", worst[0] < 0.25 && worst[1] < 0.05, format!("tick128 {:.4} dB, tick16 {:.4} dB", worst[0], worst[1]));
    }
    // 6. Stamped ramp == Ramp::next when it starts at the quantum start (bitwise), over several quanta.
    {
        let rec = busramp::Stamped { start: 0, frames: 700, from: 1.0, to: 0.25 };
        let mut r = Ramp::at(1.0);
        r.set_target(0.25, 700);
        let (mut vs_ramp, mut vs_exact, mut ramp_vs_exact) = (0.0f64, 0.0f64, 0.0f64);
        let mut g = [0.0f32; Q];
        for q in 0..7u64 {
            rec.fill(q * Q as u64, &mut g);
            for i in 0..Q {
                let k = q as usize * Q + i;
                let exact = if k >= 699 { 0.25 } else { 1.0 - 0.75 * (k + 1) as f64 / 700.0 };
                let rv = r.next() as f64;
                vs_ramp = vs_ramp.max((g[i] as f64 - rv).abs());
                vs_exact = vs_exact.max((g[i] as f64 - exact).abs());
                ramp_vs_exact = ramp_vs_exact.max((rv - exact).abs());
            }
        }
        ok("stamped ramp vs Ramp::next (start at quantum start): both within 1e-5 of the f64 line", vs_exact < 2e-6 && ramp_vs_exact < 2e-5, format!("stamped vs exact {vs_exact:.2e}, Ramp::next vs exact (f32 drift) {ramp_vs_exact:.2e}, stamped vs Ramp {vs_ramp:.2e}"));
    }
    // 7. Stamped ramp starting inside a quantum equals the f64 line, ends exactly on the target, holds before and after.
    {
        let rec = busramp::Stamped { start: 1000 + 37, frames: 301, from: 0.9, to: 0.1 };
        let mut worst = 0.0f64;
        let mut g = [0.0f32; Q];
        let mut last = 0.0;
        for q in 0..16u64 {
            let q0 = 896 + q * Q as u64;
            let done = rec.fill(q0, &mut g);
            for i in 0..Q {
                let f = q0 + i as u64;
                let k = f as i64 - rec.start as i64;
                let want = if k < 0 { 0.9 } else if k >= 300 { 0.1 } else { 0.9 + (0.1 - 0.9) * (k + 1) as f64 / 301.0 };
                worst = worst.max((g[i] as f64 - want).abs());
                last = g[i];
            }
            if q == 15 {
                assert!(done);
            }
        }
        ok("stamped ramp starting inside a quantum = exact line, ends on target", worst < 2e-6 && last == 0.1, format!("max diff {worst:.2e}, last {last}"));
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// zipper: the step pattern of main-thread BUS_MIX updates against a stamped ramp.

fn ideal_fade(t: f64, d: f64) -> f64 {
    // mixer.ts _fade: linear in volume from 1 to 0.1 over `d` seconds.
    if t <= 0.0 {
        1.0
    } else if t >= d {
        0.1
    } else {
        1.0 - 0.9 * t / d
    }
}
fn ideal_duck(t: f64) -> f64 {
    // mixer.ts ducking: exponential approach to `amount` 0.3 (tau 50 ms) for 0.5 s, then back to 1 (tau 400 ms).
    if t <= 0.0 {
        1.0
    } else if t < 0.5 {
        0.3 + 0.7 * (-t / 0.05).exp()
    } else {
        let g0 = 0.3 + 0.7 * (-0.5f64 / 0.05).exp();
        1.0 - (1.0 - g0) * (-(t - 0.5) / 0.4).exp()
    }
}

struct Zip {
    delay_ms: f64,
    err_rms_db: f64,
    err_peak_dbfs: f64,
    click_dbfs: f64,
}

/// `g` is the core's gain per sample; `ideal(t)` the true trajectory. Compared on a 1 kHz sine at 0.5 peak after removing
/// the best constant delay (0..`max_delay_ms`), so latency is reported apart from zipper.
fn compare(g: &[f32], ideal: &dyn Fn(f64) -> f64, max_delay_ms: f64) -> Zip {
    let fs = RATE as f64;
    let x: Vec<f64> = (0..g.len()).map(|n| 0.5 * (2.0 * core::f64::consts::PI * 1000.0 * n as f64 / fs).sin()).collect();
    let mut best = (f64::MAX, 0usize);
    let step = 5usize;
    for d in (0..(max_delay_ms * fs / 1000.0) as usize).step_by(step) {
        let mut e2 = 0.0;
        for n in (0..g.len()).step_by(3) {
            let want = ideal((n as f64 - d as f64) / fs);
            e2 += (g[n] as f64 - want).powi(2);
        }
        if e2 < best.0 {
            best = (e2, d);
        }
    }
    let d = best.1 as f64;
    let (mut e2, mut y2, mut emax) = (0.0, 0.0, 0.0f64);
    for n in 0..g.len() {
        let yi = x[n] * ideal((n as f64 - d) / fs);
        let e = x[n] * g[n] as f64 - yi;
        e2 += e * e;
        y2 += yi * yi;
        emax = emax.max(e.abs());
    }
    let mut smax = 0.0f64;
    for n in 1..g.len() {
        smax = smax.max((g[n] as f64 - g[n - 1] as f64).abs());
    }
    Zip { delay_ms: d / fs * 1000.0, err_rms_db: 10.0 * (e2 / y2).log10(), err_peak_dbfs: db(emax), click_dbfs: db(smax * 0.5) }
}

/// The core's gain when main sends `ideal(t_k)` as a BUS_MIX every 1/fps s with `ramp` frames, arriving on the quantum
/// boundary at or after t_k plus up to `jitter` quanta (a deterministic pattern), applied through the real `Ramp`.
fn main_updates(ideal: &dyn Fn(f64) -> f64, fps: f64, ramp: u32, jitter: u32, seconds: f64) -> Vec<f32> {
    let fs = RATE as f64;
    let n = (seconds * fs) as usize;
    let mut g = Vec::with_capacity(n);
    let mut r = Ramp::at(ideal(0.0) as f32);
    let mut k = 0usize;
    let mut prev_arrival = 0usize;
    let mut next = {
        let a = 0usize;
        (a, ideal(0.0))
    };
    let mut rng = Rng(7);
    let mut frame = 0usize;
    while frame < n {
        if frame == next.0 {
            r.set_target(next.1 as f32, ramp);
            k += 1;
            let t = k as f64 / fps;
            let j = if jitter == 0 { 0 } else { ((rng.unit() + 0.5) * (jitter + 1) as f32) as usize };
            let mut a = ((t * fs / Q as f64).ceil() as usize + j) * Q;
            a = a.max(prev_arrival + Q);
            prev_arrival = a;
            next = (a, ideal(t));
        }
        g.push(r.next());
        frame += 1;
    }
    g
}

fn zipper(_args: &str) {
    let fs = RATE as f64;
    for (shape, dur) in [("fade 1->0.1 over 250 ms (mixer _fade, linear)", 0.25), ("duck: exp to 0.3, tau 50 ms attack, 400 ms release (mixer ducking)", 0.0)] {
        let ideal: Box<dyn Fn(f64) -> f64> = if dur > 0.0 { Box::new(move |t| ideal_fade(t, dur)) } else { Box::new(ideal_duck) };
        let secs = if dur > 0.0 { 0.6 } else { 2.2 };
        for fps in [60.0f64, 30.0] {
            let interval_ramp = ((1000.0 / fps).clamp(5.0, 50.0) * fs / 1000.0).round() as u32;
            for (rname, ramp) in [("128 frames (2.7 ms)", 128u32), ("interval (rampFrames)", interval_ramp)] {
                for jitter in [0u32, 3] {
                    let g = main_updates(&*ideal, fps, ramp, jitter, secs);
                    let z = compare(&g, &*ideal, 80.0);
                    print(&format!(
                        "{{\"zipper\":\"main-updates\",\"shape\":\"{shape}\",\"fps\":{fps},\"ramp\":\"{rname}\",\"jitterQuanta\":{jitter},\"bestDelayMs\":{:.2},\"errRmsDb\":{:.1},\"errPeakDbfs\":{:.1},\"clickDbfs\":{:.1}}}",
                        z.delay_ms, z.err_rms_db, z.err_peak_dbfs, z.click_dbfs
                    ));
                }
            }
        }
        if dur > 0.0 {
            // A stamped linear ramp: one record, start frame on a sample, the whole fade inside the core.
            let n = (secs * fs) as usize;
            let rec = busramp::Stamped { start: 777, frames: (dur * fs) as u32, from: 1.0, to: 0.1 };
            let mut g = vec![0.0f32; n.div_ceil(Q) * Q];
            let mut q = [0.0f32; Q];
            for qi in 0..g.len() / Q {
                rec.fill((qi * Q) as u64, &mut q);
                g[qi * Q..(qi + 1) * Q].copy_from_slice(&q);
            }
            g.truncate(n);
            let shifted = |t: f64| ideal_fade(t - 777.0 / fs, dur);
            let z = compare(&g, &shifted, 5.0);
            print(&format!(
                "{{\"zipper\":\"stamped-linear\",\"shape\":\"{shape}\",\"bestDelayMs\":{:.2},\"errRmsDb\":{:.1},\"errPeakDbfs\":{:.1},\"clickDbfs\":{:.1}}}",
                z.delay_ms, z.err_rms_db, z.err_peak_dbfs, z.click_dbfs
            ));
        }
    }
    // The true linear fade's own step per sample, for scale: 0.9 / (0.25 s * 48000) per sample.
    print(&format!("{{\"zipper\":\"reference\",\"idealFadeStepPerSampleDbfs\":{:.1}}}", db(0.9 / (0.25 * fs) * 0.5)));
}

// ---------------------------------------------------------------------------------------------------------------------
// delay: a duck whose detector reads the trigger one quantum late.

fn delay(_args: &str) {
    let fs = RATE as usize;
    let n = 4 * fs / Q * Q;
    let mut r = Rng(11);
    // Dialogue-like trigger: 300 ms of noise at 0.3 every second, a 5 ms ramp in (a hard onset is the worst case).
    let trig: Vec<f32> = (0..n)
        .map(|i| {
            let t = i % fs;
            let on = t < (0.3 * fs as f32) as usize;
            if on {
                r.unit() * 0.6
            } else {
                0.0
            }
        })
        .collect();
    for (att, rel) in [(10.0f32, 100.0f32), (25.0, 250.0), (50.0, 400.0)] {
        for (dn, d) in [("peak", Detect::Peak), ("rms", Detect::Rms)] {
            let mut p = Params::sound_lab(d);
            p.attack_ms = att;
            p.release_ms = rel;
            let mut a = Rule::new(p);
            let mut b = Rule::new(p);
            let (mut ga, mut gb) = ([1.0f32; Q], [1.0f32; Q]);
            let mut worst = 0.0f64;
            let mut worst_rel = 0.0f64;
            let silent = [0.0f32; Q];
            let mut prev = &silent[..];
            for q in 0..n / Q {
                let cur = &trig[q * Q..(q + 1) * Q];
                a.process(cur, cur, 128, &mut ga);
                b.process(prev, prev, 128, &mut gb);
                prev = cur;
                for i in 0..Q {
                    let (da, db_) = (db(ga[i] as f64), db(gb[i] as f64));
                    worst = worst.max((da - db_).abs());
                }
                worst_rel = worst_rel.max((a.gr_db - b.gr_db).abs() as f64);
            }
            print(&format!(
                "{{\"delay\":\"one-quantum\",\"detector\":\"{dn}\",\"attackMs\":{att},\"releaseMs\":{rel},\"depthDb\":{:.2},\"maxGainDifferenceDb\":{:.2},\"percentOfDepth\":{:.1}}}",
                p.max_reduction_db,
                worst,
                worst / p.max_reduction_db as f64 * 100.0
            ));
        }
    }
    // The cost of the late trigger in what the listener hears: how much louder the target is, in the first 20 ms after an onset,
    // than the same duck with a zero-delay detector (the 'leak' of the 2.7 ms), integrated: energy of the difference.
}

// ---------------------------------------------------------------------------------------------------------------------
// blend: snapshot blending of biquad parameters, click and error against the exact per-sample reference.

/// Largest second difference |y[n] - 2 y[n-1] + y[n-2]|: a glitch (a step or a kink) shows here, a smooth tone barely does.
fn max_d2(x: &[f32]) -> f64 {
    x.windows(3).map(|w| (w[2] as f64 - 2.0 * w[1] as f64 + w[0] as f64).abs()).fold(0.0, f64::max)
}

fn blend(_args: &str) {
    let fs = RATE;
    let n = (0.5 * fs) as usize; // 0.1 s settled, the transition, then settled again
    // Input: three tones (300 Hz, 3 kHz, 9 kHz), no noise, so a glitch is not masked by the signal's own roughness.
    let tone = |hz: f32, i: usize| libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / fs);
    let x: Vec<f32> = (0..n).map(|i| 0.25 * tone(300.0, i) + 0.15 * tone(3000.0, i) + 0.05 * tone(9000.0, i)).collect();
    let t0 = (0.1 * fs) as usize;
    for (kind, name, a_hz, b_hz) in [(blend::Kind::Lowpass, "lowpass 18k->500", 18_000.0f32, 500.0f32), (blend::Kind::Lowpass, "lowpass 500->18k", 500.0, 18_000.0), (blend::Kind::Highpass, "highpass 40->2k", 40.0, 2_000.0)] {
        for q_db in [1.0f32, 12.0] {
            for dur_ms in [100.0f32, 20.0] {
                let len = (dur_ms * fs / 1000.0) as usize;
                let u = |i: usize| (((i as i64 - t0 as i64).max(0) as f64 / len as f64).min(1.0)) as f32;
                // Exact reference: coefficients from log-Hz parameters at every sample.
                let mut h = [0.0; 4];
                let refy = blend::run(&x, &mut h, |i| blend::coefs(kind, fs, blend::log_hz(a_hz, b_hz, u(i)), q_db));
                let mut out: Vec<(&str, Vec<f32>)> = vec![];
                let mut h = [0.0; 4];
                let lin = |i: usize| a_hz + (b_hz - a_hz) * u((i / Q) * Q);
                out.push(("step per quantum, linear Hz (today)", blend::run(&x, &mut h, |i| blend::coefs(kind, fs, lin(i), q_db))));
                let mut h = [0.0; 4];
                out.push(("step per quantum, log Hz", blend::run(&x, &mut h, |i| blend::coefs(kind, fs, blend::log_hz(a_hz, b_hz, u((i / Q) * Q)), q_db))));
                let (ca, cb) = (blend::coefs(kind, fs, a_hz, q_db), blend::coefs(kind, fs, b_hz, q_db));
                let mut h = [0.0; 4];
                out.push(("coefficient lerp per sample", blend::run(&x, &mut h, |i| blend::lerp_coefs(&ca, &cb, u(i) as f64))));
                let mut h = [0.0; 4];
                out.push(("coefficient lerp per quantum", blend::run(&x, &mut h, |i| blend::lerp_coefs(&ca, &cb, u((i / Q) * Q) as f64))));
                let mut h = [0.0; 4];
                out.push(("hard switch (no blend)", blend::run(&x, &mut h, |i| if i >= t0 { cb } else { ca })));
                // Largest pole radius along the coefficient-lerp path (< 1: stable all the way).
                let mut worst_pole = 0.0f64;
                for k in 0..=100 {
                    let c = blend::lerp_coefs(&ca, &cb, k as f64 / 100.0);
                    let (a1, a2) = (c[3], c[4]);
                    let disc = a1 * a1 - 4.0 * a2;
                    let rad = if disc < 0.0 { a2.max(0.0).sqrt() } else { ((-a1 + disc.sqrt()).abs() / 2.0).max((-a1 - disc.sqrt()).abs() / 2.0) };
                    worst_pole = worst_pole.max(rad);
                }
                let w = t0.saturating_sub(64)..(t0 + len + 256).min(n);
                let ref_d2 = max_d2(&refy[w.clone()]);
                let rms = |v: &[f32]| (v.iter().map(|&a| (a as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
                for (scheme, y) in out {
                    let e_tr = rms(&y[w.clone()].iter().zip(&refy[w.clone()]).map(|(a, b)| a - b).collect::<Vec<_>>());
                    let tail = (n - (0.05 * fs) as usize)..n;
                    let e_end = rms(&y[tail.clone()].iter().zip(&refy[tail.clone()]).map(|(a, b)| a - b).collect::<Vec<_>>());
                    print(&format!(
                        "{{\"blend\":\"{name}\",\"qDb\":{q_db},\"transitionMs\":{dur_ms},\"scheme\":\"{scheme}\",\"glitchRatioD2\":{:.2},\"errDuringDbVsExact\":{:.1},\"errAtEndDb\":{:.1},\"maxPoleRadiusOnLerpPath\":{:.4}}}",
                        max_d2(&y[w.clone()]) / ref_d2,
                        db(e_tr / rms(&refy[w.clone()])),
                        db(e_end / rms(&refy[tail])),
                        worst_pole
                    ));
                }
            }
        }
    }
}

pub fn main(args: &str) {
    match arg(args, "mode").unwrap_or("micro") {
        "check" => check(),
        "micro" => micro(args),
        "zipper" => zipper(args),
        "delay" => delay(args),
        "blend" => blend(args),
        m => print(&format!("{{\"error\":\"unknown mode {m}\"}}")),
    }
}
