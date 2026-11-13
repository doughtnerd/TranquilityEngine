//! L-B4a (0171/0172 M5-0, task B4): the biquad's per-quantum coefficient blend, the scheme the
//! bus's snapshot low-pass uses (`biquad.rs` module notes "The per-quantum coefficient blend";
//! `audio-core`'s `fx::snapshot_lowpass`; spike S4 `spikes/audio-mix/mix-core/src/lib.rs` `blend`).
//!
//! A ramping cut-off is blended by calling `Biquad::set_lowpass` (or `set_highpass`) once per
//! 128-frame quantum with the ramp's value at the quantum's start, then `Biquad::process` on that
//! quantum: coefficients recomputed, history kept.
//!
//! The glitch measure is S4's: the largest second difference |y[n] - 2 y[n-1] + y[n-2]| over the
//! transition window (from 64 frames before the ramp starts to 256 after it ends), compared as a
//! ratio between two runs on the same input. Input: three tones, 0.25 × 300 Hz + 0.15 × 3 kHz +
//! 0.05 × 9 kHz at 48 kHz, 0.5 s, the ramp starting at 0.1 s (a quantum boundary: frame 4,800).
//! S4's measured numbers: per-quantum step on a linear-Hz ramp 1.19× its own per-sample recompute
//! (worst case); an unblended (hard) switch up to 3.5× the exact log-Hz per-sample sweep.

use audio_dsp::biquad::Biquad;

/// Frames per quantum.
const Q: usize = 128;
/// The context rate.
const RATE: f32 = 48_000.0;
/// S4's input length: 0.5 s at [`RATE`].
const N: usize = 24_000;
/// The ramp's start frame: 0.1 s, a quantum boundary.
const T0: usize = 4_800;
/// S4's cases: (name, highpass, from Hz, to Hz). Each runs at Q 1 and 12 dB over 20 and 100 ms.
const CASES: [(&str, bool, f32, f32); 3] = [
    ("lowpass 18k->500", false, 18_000.0, 500.0),
    ("lowpass 500->18k", false, 500.0, 18_000.0),
    ("highpass 40->2k", true, 40.0, 2_000.0),
];

/// S4's input: 0.25 × 300 Hz + 0.15 × 3 kHz + 0.05 × 9 kHz, `n` frames at [`RATE`]
/// (`libm::sinf(2π f i / RATE)`, as S4).
fn tones(n: usize) -> Vec<f32> {
    let tone = |hz: f32, i: usize| libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / RATE);
    (0..n).map(|i| 0.25 * tone(300.0, i) + 0.15 * tone(3000.0, i) + 0.05 * tone(9000.0, i)).collect()
}

/// S4's glitch measure: the largest |x[n] - 2 x[n-1] + x[n-2]| (in f64).
fn max_d2(x: &[f32]) -> f64 {
    x.windows(3).map(|w| (w[2] as f64 - 2.0 * w[1] as f64 + w[0] as f64).abs()).fold(0.0, f64::max)
}

/// Runs `x` (mono, fed to both channels) through a fresh lowpass (`highpass` false) or highpass
/// at Q `q_db`, calling `set_*` with `hz(i)` before frame `i` whenever `i` is a multiple of
/// `every` (128: the per-quantum blend; 1: the per-sample recompute of the same trajectory) and
/// processing the frames up to the next call; returns the left channel.
fn run(x: &[f32], highpass: bool, q_db: f32, every: usize, hz: impl Fn(usize) -> f32) -> Vec<f32> {
    let mut filter = Biquad::default();
    let mut out = Vec::with_capacity(x.len());
    let mut i = 0;
    while i < x.len() {
        let end = (i + every).min(x.len());
        let f = hz(i);
        if highpass {
            filter.set_highpass(RATE, f, q_db);
        } else {
            filter.set_lowpass(RATE, f, q_db);
        }
        let mut left = x[i..end].to_vec();
        let mut right = left.clone();
        filter.process(&mut left, &mut right);
        out.extend_from_slice(&left);
        i = end;
    }
    out
}

/// The ramp: `from` before `start`, linear in Hz to `to` at `start + len`, `to` after.
fn linear_hz(from: f32, to: f32, start: usize, len: usize) -> impl Fn(usize) -> f32 {
    move |i| {
        let u = (i.saturating_sub(start) as f32 / len as f32).min(1.0);
        from + (to - from) * u
    }
}

/// The hard switch: `from` before `start`, `to` from `start` on (one `set_*` call).
fn step_hz(from: f32, to: f32, start: usize) -> impl Fn(usize) -> f32 {
    move |i| if i < start { from } else { to }
}

/// S4's transition window: 64 frames before the ramp starts to 256 after it ends.
fn window(len: usize) -> std::ops::Range<usize> {
    T0 - 64..(T0 + len + 256).min(N)
}

#[test]
fn a_per_quantum_blend_is_click_free_against_its_own_per_sample_version() {
    // For lowpass 18 kHz -> 500 Hz, lowpass 500 Hz -> 18 kHz and highpass 40 Hz -> 2 kHz, each at
    // Q 1 and 12 dB, each over 20 ms and 100 ms (S4's twelve cases), the cut-off ramping linearly
    // in Hz from the start frame: the per-quantum blend's max_d2 over the window is at most 1.5×
    // the per-sample recompute's (S4 measured 1.19× worst). Print each case's ratio.
    let x = tones(N);
    let mut worst = 0.0f64;
    for (name, highpass, from, to) in CASES {
        for q_db in [1.0f32, 12.0] {
            for dur_ms in [20.0f32, 100.0] {
                let len = (dur_ms * RATE / 1000.0) as usize;
                let w = window(len);
                let own = run(&x, highpass, q_db, 1, linear_hz(from, to, T0, len));
                let blend = run(&x, highpass, q_db, Q, linear_hz(from, to, T0, len));
                let ratio = max_d2(&blend[w.clone()]) / max_d2(&own[w]);
                println!("blend {name} Q {q_db} dB {dur_ms} ms: {ratio:.3}x its per-sample recompute");
                assert!(ratio <= 1.5, "{name} Q {q_db} dB {dur_ms} ms: blend glitch {ratio:.3}x its per-sample recompute, bound 1.5x");
                worst = worst.max(ratio);
            }
        }
    }
    println!("blend worst {worst:.3}x");
}

#[test]
fn an_unblended_switch_glitches_more_than_the_blend() {
    // The control: the same twelve cases with the cut-off switched from start to end at the
    // start frame (one `set_*` call). Its worst max_d2 ratio against the per-sample recompute
    // exceeds the per-quantum blend's worst (S4: the hard switch reaches 3.5× an exact sweep).
    // Print both worst ratios.
    let x = tones(N);
    let (mut blend_worst, mut hard_worst) = (0.0f64, 0.0f64);
    for (name, highpass, from, to) in CASES {
        for q_db in [1.0f32, 12.0] {
            for dur_ms in [20.0f32, 100.0] {
                let len = (dur_ms * RATE / 1000.0) as usize;
                let w = window(len);
                let own = run(&x, highpass, q_db, 1, linear_hz(from, to, T0, len));
                let blend = run(&x, highpass, q_db, Q, linear_hz(from, to, T0, len));
                let hard = run(&x, highpass, q_db, 1, step_hz(from, to, T0));
                let own_d2 = max_d2(&own[w.clone()]);
                let blend_ratio = max_d2(&blend[w.clone()]) / own_d2;
                let hard_ratio = max_d2(&hard[w]) / own_d2;
                println!("{name} Q {q_db} dB {dur_ms} ms: blend {blend_ratio:.3}x, hard switch {hard_ratio:.3}x");
                blend_worst = blend_worst.max(blend_ratio);
                hard_worst = hard_worst.max(hard_ratio);
            }
        }
    }
    println!("blend worst {blend_worst:.3}x, hard switch worst {hard_worst:.3}x");
    assert!(hard_worst > blend_worst, "hard switch worst {hard_worst:.3}x does not exceed blend worst {blend_worst:.3}x");
}

#[test]
fn a_settled_cut_off_set_every_quantum_is_bit_identical_to_one_set() {
    // A cut-off that doesn't move costs nothing and changes nothing: set_lowpass(RATE, 2000, 1)
    // every quantum for 0.5 s gives output bit-identical (assert_eq!) to one call before the
    // first quantum, and the coefficients never change.
    let x = tones(N);
    let mut once = Biquad::default();
    once.set_lowpass(RATE, 2000.0, 1.0);
    let coefficients = once.coefficients;
    let mut every = Biquad::default();
    let (mut out_once, mut out_every) = (Vec::with_capacity(N), Vec::with_capacity(N));
    for chunk in x.chunks(Q) {
        every.set_lowpass(RATE, 2000.0, 1.0);
        assert_eq!(every.coefficients, coefficients, "a settled set changed the coefficients");
        let (mut l1, mut r1) = (chunk.to_vec(), chunk.to_vec());
        once.process(&mut l1, &mut r1);
        let (mut l2, mut r2) = (chunk.to_vec(), chunk.to_vec());
        every.process(&mut l2, &mut r2);
        out_once.extend_from_slice(&l1);
        out_every.extend_from_slice(&l2);
    }
    let bits = |v: &[f32]| v.iter().map(|s| s.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&out_every), bits(&out_once));
    assert_eq!(every, once);
}

/// The largest |sample| of `y`, infinite when one isn't finite.
fn peak_of(y: &[f32]) -> f32 {
    y.iter().fold(0.0f32, |m, v| if v.is_finite() { m.max(v.abs()) } else { f32::INFINITY })
}

#[test]
fn the_products_blend_stays_finite_and_bounded() {
    // Every per-quantum cut-off ramp in the product runs at Q 1 dB: the bus's snapshot low-pass
    // (`audio-core` `fx::SNAPSHOT_Q_DB` = 1, Web Audio's default Q) and the voice filters
    // (`fxfilter::Q_DB`). An effect slot's Q is the user's, but its frequency and Q edits are
    // direct (R7: `FxChain::configure` calls `set_*` once with the new values; nothing ramps
    // them), so a resonant Q never meets a per-quantum ramp: that path is the next test.
    // Lowpass 18 kHz -> 500 Hz and 500 Hz -> 18 kHz over 20 ms per quantum at Q 1 dB: every output
    // sample is finite and its magnitude stays under 4 × the input's peak.
    assert_eq!(audio_dsp::fxfilter::Q_DB, 1.0, "the voice filters' Q");
    let x = tones(N);
    let peak = peak_of(&x);
    let len = (20.0 * RATE / 1000.0) as usize;
    for (from, to) in [(18_000.0f32, 500.0f32), (500.0, 18_000.0)] {
        let worst = peak_of(&run(&x, false, 1.0, Q, linear_hz(from, to, T0, len)));
        println!("blend Q 1 dB lowpass {from} -> {to}: output peak {worst:.3} ({:.2}x the input's)", worst / peak);
        assert!(worst < 4.0 * peak, "lowpass {from} -> {to}: output peak {worst} exceeds 4 x input peak {peak}");
    }
    // For the record (not reachable, see above): the same blend at Q 12 dB. Measured (L-B4a):
    // 18k -> 500 peaks at 2.062 (5.28x the input; the per-sample recompute 0.802), about 18
    // frames after the ramp ends; 500 -> 18k 1.54x.
    for (from, to) in [(18_000.0f32, 500.0f32), (500.0, 18_000.0)] {
        let y = run(&x, false, 12.0, Q, linear_hz(from, to, T0, len));
        println!("blend Q 12 dB lowpass {from} -> {to} (unreachable): output peak {:.3}", peak_of(&y));
    }
}

#[test]
fn a_resonant_direct_edit_stays_finite_and_bounded() {
    // The resonant path the product has: an effect slot's low-pass edited in place at Q 12 dB
    // (one `set_lowpass`, history kept), 18 kHz -> 500 Hz and back. Every output sample is finite
    // and the transient's peak stays under 4 × the input's peak.
    let x = tones(N);
    let peak = peak_of(&x);
    for (from, to) in [(18_000.0f32, 500.0f32), (500.0, 18_000.0)] {
        let y = run(&x, false, 12.0, 1, step_hz(from, to, T0));
        let worst = peak_of(&y);
        let settled = peak_of(&y[N - 4_800..]);
        println!("direct edit Q 12 dB lowpass {from} -> {to}: output peak {worst:.3} ({:.2}x the input's), settled {settled:.3}", worst / peak);
        assert!(worst < 4.0 * peak, "lowpass {from} -> {to}: output peak {worst} exceeds 4 x input peak {peak}");
    }
}
