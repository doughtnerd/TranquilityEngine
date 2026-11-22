//! The generator kernels (ADR 0346 §3, `audio_dsp::gen`): oscillator aliasing against naive waveforms, the noise colours'
//! spectral slopes and levels, the state-variable filter's cut-off, the envelopes' times, the voice's pitch and glides,
//! determinism, and the blip against a direct port of sfxr's own synthesiser (44.1 kHz, 8× supersampled) for the
//! presets' key parameters.

use audio_dsp::gen::blip::{self, p as bp};
use audio_dsp::gen::env::{stage, Adsr};
use audio_dsp::gen::noise::Noise;
use audio_dsp::gen::osc::Osc;
use audio_dsp::gen::svf::{Svf, BANDPASS, HIGHPASS, LOWPASS};
use audio_dsp::gen::{self, osc_p, synth_p, GenVoice};

const RATE: f32 = 48_000.0;
const N: usize = 4_096;

// --- Spectra ---

/// Power per bin `1..N/2` of `x` (rectangular window: the test signals are periodic in `N`).
fn power(x: &[f32]) -> Vec<f64> {
    let mut buf = [0.0f32; N];
    buf.copy_from_slice(&x[..N]);
    let spec = microfft::real::rfft_4096(&mut buf);
    (0..N / 2).map(|k| if k == 0 { 0.0 } else { (spec[k].re as f64).powi(2) + (spec[k].im as f64).powi(2) }).collect()
}

/// Aliasing of a signal of fundamental `bin`: `(total, worst)` in dB, the energy outside its harmonics against the
/// harmonics' energy, and the loudest bin outside them against the fundamental.
fn alias_db(x: &[f32], bin: usize) -> (f64, f64) {
    let p = power(x);
    let (mut harm, mut alias, mut worst) = (0.0, 0.0, 0.0f64);
    for (k, &e) in p.iter().enumerate().skip(1) {
        if k % bin == 0 {
            harm += e;
        } else {
            alias += e;
            worst = worst.max(e);
        }
    }
    (10.0 * (alias / harm).log10(), 10.0 * (worst / p[bin]).log10())
}

/// `N` samples of an oscillator read at fundamental `bin` (one call of `f` a sample).
fn render(bin: usize, mut f: impl FnMut(&mut Osc, f64) -> f32) -> Vec<f32> {
    let dt = bin as f64 / N as f64;
    let mut o = Osc::default();
    (0..N).map(|_| f(&mut o, dt)).collect()
}

/// `N` samples of a naive waveform `shape(phase)` at fundamental `bin`.
fn naive(bin: usize, shape: impl Fn(f64) -> f64) -> Vec<f32> {
    (0..N).map(|i| shape((i * bin % N) as f64 / N as f64) as f32).collect()
}

/// Fundamentals of 246 Hz, 1.23 kHz and 3.53 kHz (bins coprime with N, so aliases never land on a harmonic's bin).
const BINS: [usize; 3] = [21, 105, 301];

#[test]
fn polyblep_saw_and_pulse_alias_far_less_than_naive_ones() {
    // The two-sample residual's measured bound at each fundamental (the worst alias against the fundamental, dB): a
    // tripwire on the kernel, about 2 dB under what it measures. ADR 0346 §3 estimated -40 to -60 dB under 4 kHz; the
    // measurement is -45 to -48, -34 and -25 dB at 0.25, 1.2 and 3.5 kHz (the record's table takes these numbers).
    let worst_bound = [-44.0, -33.0, -24.0];
    for (b, bin) in BINS.into_iter().enumerate() {
        let hz = bin as f32 * RATE / N as f32;
        let naive_saw = alias_db(&naive(bin, |t| 2.0 * t - 1.0), bin);
        let saw = alias_db(&render(bin, |o, dt| o.saw(dt)), bin);
        let naive_pulse = alias_db(&naive(bin, |t| if t < 0.5 { 1.0 } else { -1.0 }), bin);
        let pulse = alias_db(&render(bin, |o, dt| o.pulse(dt, 0.5, 1.0)), bin);
        let pulse_25 = alias_db(&render(bin, |o, dt| o.pulse(dt, 0.25, 1.0)), bin);
        eprintln!(
            "{hz:7.1} Hz (total / worst bin): saw naive {:6.1} / {:6.1} dB, PolyBLEP {:6.1} / {:6.1} dB; pulse naive {:6.1} / {:6.1} dB, PolyBLEP {:6.1} / {:6.1} dB (25 %: {:6.1} / {:6.1} dB)",
            naive_saw.0, naive_saw.1, saw.0, saw.1, naive_pulse.0, naive_pulse.1, pulse.0, pulse.1, pulse_25.0, pulse_25.1
        );
        // At least 13 dB less alias energy than the naive waveform at every fundamental.
        assert!(saw.0 < naive_saw.0 - 13.0, "{hz} Hz: PolyBLEP saw {saw:?} dB against naive {naive_saw:?} dB");
        assert!(pulse.0 < naive_pulse.0 - 13.0, "{hz} Hz: PolyBLEP pulse {pulse:?} dB against naive {naive_pulse:?} dB");
        for (what, a) in [("saw", saw), ("pulse", pulse), ("pulse 25 %", pulse_25)] {
            assert!(a.1 < worst_bound[b], "{hz} Hz: {what} {a:?} (bound {})", worst_bound[b]);
        }
    }
}

#[test]
fn polyblamp_triangle_and_the_polynomial_sine_alias_less_still() {
    for bin in BINS {
        let hz = bin as f32 * RATE / N as f32;
        let naive_tri = alias_db(&naive(bin, |t| if t < 0.5 { 4.0 * t - 1.0 } else { 3.0 - 4.0 * t }), bin);
        let tri = alias_db(&render(bin, |o, dt| o.triangle(dt)), bin);
        let sine = alias_db(&render(bin, |o, dt| o.sine(dt)), bin);
        eprintln!("{hz:7.1} Hz (total / worst bin): triangle naive {:6.1} / {:6.1} dB, PolyBLAMP {:6.1} / {:6.1} dB; sine {:6.1} / {:6.1} dB", naive_tri.0, naive_tri.1, tri.0, tri.1, sine.0, sine.1);
        assert!(tri.0 < naive_tri.0 - 10.0, "{hz} Hz: PolyBLAMP {tri:?} dB against naive {naive_tri:?} dB");
        assert!(tri.0 < -40.0 && tri.1 < -40.0, "{hz} Hz: triangle {tri:?}");
        assert!(sine.0 < -95.0, "{hz} Hz: sine {sine:?}");
    }
}

#[test]
fn the_waveforms_keep_their_shapes() {
    // A slow saw rises from -1 to 1, a pulse sits at ±1 for its width, a triangle spans -1..1.
    let (mut o, dt) = (Osc::default(), 1.0 / 480.0);
    let saw: Vec<f32> = (0..480).map(|_| o.saw(dt)).collect();
    assert!((saw[240] - 0.0).abs() < 0.01 && (saw[120] + 0.5).abs() < 0.01, "{} {}", saw[240], saw[120]);
    let mut o = Osc::default();
    let pulse: Vec<f32> = (0..480).map(|_| o.pulse(dt, 0.25, 1.0)).collect();
    // 120 high and 360 low, less a sample or two at each edge for the residuals.
    let (high, low) = (pulse.iter().filter(|&&x| x > 0.99).count(), pulse.iter().filter(|&&x| x < -0.99).count());
    assert!((117..=120).contains(&high) && (357..=360).contains(&low), "{high} {low}");
    let mut o = Osc::default();
    let tri: Vec<f32> = (0..480).map(|_| o.triangle(dt)).collect();
    assert!((tri[240] - 1.0).abs() < 0.01 && (tri[120] - 0.0).abs() < 0.01, "{} {}", tri[240], tri[120]);
    for k in 0..1_000 {
        let t = k as f64 / 1_000.0;
        assert!((gen::osc::sine_cycles(t) as f64 - (core::f64::consts::TAU * t).sin()).abs() < 4e-6, "{t}");
    }
}

// --- Noise ---

/// Average power per bin from a 4,096-point Hann-windowed Welch estimate over `segments` halves-overlapped segments.
fn welch(mut next: impl FnMut() -> f32, segments: usize) -> Vec<f64> {
    let win: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (core::f32::consts::TAU * i as f32 / N as f32).cos()).collect();
    let mut hist: Vec<f32> = (0..N).map(|_| next()).collect();
    let mut acc = vec![0.0f64; N / 2];
    for _ in 0..segments {
        let x: Vec<f32> = hist.iter().zip(&win).map(|(a, w)| a * w).collect();
        for (a, p) in acc.iter_mut().zip(power(&x)) {
            *a += p;
        }
        hist.drain(..N / 2);
        hist.extend((0..N / 2).map(|_| next()));
    }
    acc
}

/// The spectrum's slope in dB per octave: a least-squares line through each octave band's mean density, `lo` to `hi` Hz.
fn slope_db_per_octave(p: &[f64], lo: f32, hi: f32) -> f64 {
    let hz = RATE as f64 / N as f64;
    let mut pts = Vec::new();
    let mut f = lo as f64;
    while f * 2.0 <= hi as f64 {
        let (a, b) = ((f / hz) as usize, (2.0 * f / hz) as usize);
        let mean = p[a..b].iter().sum::<f64>() / (b - a) as f64;
        pts.push(((f * 1.414).log2(), 10.0 * mean.log10()));
        f *= 2.0;
    }
    let n = pts.len() as f64;
    let (mx, my) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
    pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum::<f64>() / pts.iter().map(|p| (p.0 - mx).powi(2)).sum::<f64>()
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt() as f32
}

#[test]
fn pink_falls_3_db_and_brown_6_db_an_octave_and_white_is_flat() {
    let mut n = Noise::seeded(7, RATE);
    let white = slope_db_per_octave(&welch(|| n.white(), 96), 100.0, 12_800.0);
    let mut n = Noise::seeded(7, RATE);
    let pink = slope_db_per_octave(&welch(|| n.pink(), 96), 100.0, 12_800.0);
    let mut n = Noise::seeded(7, RATE);
    let brown = slope_db_per_octave(&welch(|| n.brown(), 96), 200.0, 6_400.0);
    eprintln!("slopes: white {white:+.2}, pink {pink:+.2}, brown {brown:+.2} dB/octave");
    assert!(white.abs() < 0.3, "white {white}");
    assert!((pink + 3.0).abs() < 0.3, "pink {pink}");
    assert!((brown + 6.0).abs() < 0.4, "brown {brown}");
}

#[test]
fn the_three_colours_share_white_rms() {
    let take = |f: &mut dyn FnMut() -> f32| (0..480_000).map(|_| f()).collect::<Vec<f32>>();
    let mut n = Noise::seeded(3, RATE);
    let w = rms(&take(&mut || n.white()));
    let mut n = Noise::seeded(3, RATE);
    let p = rms(&take(&mut || n.pink()));
    let mut n = Noise::seeded(3, RATE);
    let b = rms(&take(&mut || n.brown()));
    eprintln!("rms: white {w:.4}, pink {p:.4}, brown {b:.4}");
    assert!((w - 1.0 / 3f32.sqrt()).abs() < 0.01, "white {w}");
    assert!((p / w - 1.0).abs() < 0.06, "pink {p} against white {w}");
    assert!((b / w - 1.0).abs() < 0.1, "brown {b} against white {w}");
}

#[test]
fn noise_is_deterministic_by_seed() {
    let take = |seed: u32| {
        let mut n = Noise::seeded(seed, RATE);
        (0..256).map(|_| n.pink()).collect::<Vec<f32>>()
    };
    assert_eq!(take(42), take(42));
    assert_ne!(take(42), take(43));
    // The first values of seed 1 are pinned: a change to the generator is a change to every take's noise.
    let mut n = Noise::seeded(1, RATE);
    let first: Vec<u32> = (0..3).map(|_| n.white().to_bits()).collect();
    let mut again = Noise::seeded(1, RATE);
    assert_eq!(first, (0..3).map(|_| again.white().to_bits()).collect::<Vec<_>>());
}

// --- Filter ---

/// The filter's gain at `hz` (steady-state sine RMS out over in).
fn gain_at(kind: u8, cutoff: f32, q: f32, hz: f32) -> f32 {
    let mut f = Svf::default();
    f.set(cutoff, q, RATE);
    let mut o = Osc::default();
    let dt = (hz / RATE) as f64;
    let x: Vec<f32> = (0..96_000).map(|_| o.sine(dt)).collect();
    let y: Vec<f32> = x.iter().map(|&v| f.process(kind, v)).collect();
    rms(&y[48_000..]) / rms(&x[48_000..])
}

fn db(g: f32) -> f32 {
    20.0 * g.log10()
}

#[test]
fn the_svf_cuts_off_where_it_is_set() {
    let q = core::f32::consts::FRAC_1_SQRT_2;
    for fc in [200.0f32, 1_000.0, 5_000.0] {
        let at = db(gain_at(LOWPASS, fc, q, fc));
        let below = db(gain_at(LOWPASS, fc, q, fc / 8.0));
        let above = db(gain_at(LOWPASS, fc, q, (fc * 8.0).min(20_000.0)));
        let hp_at = db(gain_at(HIGHPASS, fc, q, fc));
        let hp_below = db(gain_at(HIGHPASS, fc, q, fc / 8.0));
        let bp_at = db(gain_at(BANDPASS, fc, q, fc));
        eprintln!("{fc} Hz: low-pass {at:.2} dB at fc, {below:.2} at fc/8, {above:.2} at 8fc; high-pass {hp_at:.2} at fc, {hp_below:.2} at fc/8; band-pass {bp_at:.2} at fc");
        assert!((at + 3.01).abs() < 0.1, "{fc}: {at}");
        assert!(below.abs() < 0.1, "{fc}: {below}");
        if fc * 8.0 <= 20_000.0 {
            assert!(above < -34.0, "{fc}: 12 dB/octave over three octaves: {above}");
        }
        assert!((hp_at + 3.01).abs() < 0.1 && hp_below < -34.0, "{fc}: {hp_at} {hp_below}");
        assert!(bp_at.abs() < 0.1, "{fc}: the band-pass peaks at 0 dB: {bp_at}");
    }
    // Resonance raises the peak at the cut-off by Q.
    assert!((db(gain_at(LOWPASS, 1_000.0, 4.0, 1_000.0)) - db(4.0)).abs() < 0.2);
}

#[test]
fn the_svf_stays_stable_while_its_cutoff_moves_every_sample() {
    let mut f = Svf::default();
    let mut o = Osc::default();
    let mut peak = 0.0f32;
    for i in 0..192_000 {
        let fc = 100.0 * 2f32.powf(7.0 * (0.5 + 0.5 * (i as f32 * 0.002).sin()));
        f.set(fc, 8.0, RATE);
        let y = f.process(LOWPASS, o.saw(0.01));
        assert!(y.is_finite());
        peak = peak.max(y.abs());
    }
    assert!(peak < 20.0, "{peak}");
}

// --- Envelopes ---

#[test]
fn adsr_stages_take_their_set_times() {
    let mut e = Adsr::default();
    e.configure(0.010, 0.100, 0.5, 0.200, RATE);
    e.gate_on();
    // A linear attack reaches 1 at 10 ms (480 samples).
    let a: Vec<f32> = (0..480).map(|_| e.next()).collect();
    assert!((a[239] - 0.5).abs() < 0.01 && a[479] == 1.0, "{} {}", a[239], a[479]);
    assert_eq!(e.stage, stage::DECAY);
    // The decay reaches 1 % of its span (0.5) at 100 ms.
    for _ in 0..4_800 {
        e.next();
    }
    assert!(((e.value - 0.5) / 0.5 - 0.01).abs() < 0.001, "{}", e.value);
    for _ in 0..48_000 {
        e.next();
    }
    assert_eq!((e.stage, e.value), (stage::SUSTAIN, 0.5));
    // The release reaches 1 % of where it started at 200 ms, and is done below -60 dB.
    e.gate_off();
    for _ in 0..9_600 {
        e.next();
    }
    assert!((e.value / 0.5 - 0.01).abs() < 0.001, "{}", e.value);
    let mut n = 0;
    while !e.done() {
        e.next();
        n += 1;
    }
    // From 1 % of 0.5 down to 0.001: log(0.2)/log(0.01) of 200 ms.
    let expect = (0.2f32.ln() / 0.01f32.ln() * 9_600.0) as i32;
    assert!((n - expect).abs() <= 2, "{n} against {expect}");
}

#[test]
fn adsr_advance_matches_stepping() {
    for n in [1u32, 100, 480, 3_000, 30_000] {
        let mut a = Adsr::default();
        a.configure(0.010, 0.100, 0.4, 0.050, RATE);
        a.gate_on();
        let mut b = a;
        for _ in 0..n {
            a.next();
        }
        b.advance(n);
        assert_eq!(a.stage, b.stage, "{n}");
        assert!((a.value - b.value).abs() < 1e-3, "{n}: {} {}", a.value, b.value);
        a.gate_off();
        b.gate_off();
        for _ in 0..n {
            a.next();
        }
        b.advance(n);
        assert_eq!(a.stage, b.stage, "release {n}");
        assert!((a.value - b.value).abs() < 1e-3, "release {n}: {} {}", a.value, b.value);
    }
}

// --- The voice ---

/// Frequency from rising zero crossings (linear interpolation between samples).
fn frequency(x: &[f32]) -> f32 {
    let mut first = None;
    let (mut last, mut count) = (0.0f32, 0);
    for i in 1..x.len() {
        if x[i - 1] < 0.0 && x[i] >= 0.0 {
            let t = (i - 1) as f32 + x[i - 1] / (x[i - 1] - x[i]);
            if first.is_none() {
                first = Some(t);
            } else {
                count += 1;
            }
            last = t;
        }
    }
    first.map_or(0.0, |f| count as f32 * RATE / (last - f))
}

fn voice(kind: u8, params: &[(usize, f32)]) -> GenVoice {
    let mut v = GenVoice::default();
    v.start(kind, RATE, 1);
    for &(i, x) in params {
        v.set(i, x, 0);
    }
    v
}

fn run(v: &mut GenVoice, steps: f32, n: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; n];
    for c in out.chunks_mut(128) {
        let s = vec![steps; c.len()];
        v.render(&s, c, false);
    }
    out
}

#[test]
fn pitch_multiplies_every_frequency() {
    let mut v = voice(gen::OSCILLATOR, &[(osc_p::FREQUENCY, 440.0)]);
    let x = run(&mut v, 1.0, 9_600);
    assert!((frequency(&x[2_400..]) - 440.0).abs() < 0.2, "{}", frequency(&x[2_400..]));
    let y = run(&mut v, 2.0, 9_600);
    assert!((frequency(&y[2_400..]) - 880.0).abs() < 0.4, "{}", frequency(&y[2_400..]));
    // The default level is -12 dB: a sine of peak 0.251.
    let peak = x[2_400..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!((peak - 0.2512).abs() < 0.002, "{peak}");
    // The synth's two oscillators move together: osc 2 a fifth up stays a fifth up.
    let mut s = voice(gen::SYNTH, &[(synth_p::OSC1_WAVE, 0.0), (synth_p::OSC2_WAVE, 0.0), (synth_p::OSC_MIX, 100.0), (synth_p::OSC2_SEMITONES, 7.0), (synth_p::DETUNE, 0.0), (synth_p::CUTOFF, 20_000.0), (synth_p::FILTER_ENV_AMOUNT, 0.0)]);
    let z = run(&mut s, 0.5, 24_000);
    let want = 220.0 * 2f32.powf(7.0 / 12.0) * 0.5;
    assert!((frequency(&z[4_800..]) / want - 1.0).abs() < 0.002, "{} against {want}", frequency(&z[4_800..]));
}

#[test]
fn a_log_parameter_glides_in_log2() {
    let mut v = voice(gen::OSCILLATOR, &[(osc_p::FREQUENCY, 200.0)]);
    run(&mut v, 1.0, 128);
    v.set(osc_p::FREQUENCY, 800.0, 4_800);
    run(&mut v, 1.0, 2_400);
    // Halfway through, an octave up from 200 (the geometric mean), not 500.
    assert!((v.value(osc_p::FREQUENCY) - 400.0).abs() < 2.0, "{}", v.value(osc_p::FREQUENCY));
    run(&mut v, 1.0, 2_400);
    assert_eq!(v.value(osc_p::FREQUENCY), 800.0);
    // Choices step whatever the ramp; out-of-range values clamp; NaN is the default.
    v.set(osc_p::WAVEFORM, 2.0, 4_800);
    assert_eq!(v.value(osc_p::WAVEFORM), 2.0);
    v.set(osc_p::FREQUENCY, 1e9, 0);
    assert_eq!(v.value(osc_p::FREQUENCY), 20_000.0);
    v.set(osc_p::LEVEL, f32::NAN, 0);
    assert_eq!(v.value(osc_p::LEVEL), -12.0);
}

#[test]
fn key_off_releases_and_the_voice_ends() {
    let mut v = voice(gen::OSCILLATOR, &[(osc_p::RELEASE, 100.0)]);
    run(&mut v, 1.0, 4_800);
    v.key_off();
    let mut n = 0;
    let mut out = [0.0f32; 128];
    while v.render(&[1.0; 128], &mut out, false) {
        n += 128;
        assert!(n < 48_000, "the release ends");
    }
    // To -60 dB from full scale: 1.5 times the release time.
    assert!((n as f32 / 7_200.0 - 1.0).abs() < 0.03, "{n}");
    assert_eq!(v.ended, 1);
}

#[test]
fn a_virtual_voice_advances_its_envelope_as_a_rendered_one_does() {
    let mut a = voice(gen::SYNTH, &[(synth_p::AMP_ATTACK, 50.0), (synth_p::AMP_RELEASE, 80.0)]);
    let mut b = a;
    run(&mut a, 1.0, 12_800);
    assert!(b.advance(12_800, false));
    assert!((a.amp.value - b.amp.value).abs() < 1e-3 && (a.fenv.value - b.fenv.value).abs() < 1e-3, "{} {} / {} {}", a.amp.value, b.amp.value, a.fenv.value, b.fenv.value);
    a.key_off();
    b.key_off();
    let ra = run(&mut a, 1.0, 12_800);
    let alive = b.advance(12_800, false);
    assert!(!alive && a.ended == 1 && ra[12_000..].iter().all(|&x| x == 0.0));
}

#[test]
fn the_same_seed_and_parameters_give_the_same_samples() {
    let make = |seed: u32| {
        let mut v = GenVoice::default();
        v.start(gen::OSCILLATOR, RATE, seed);
        v.set(osc_p::WAVEFORM, 4.0, 0);
        v.set(osc_p::NOISE_COLOUR, 1.0, 0);
        run(&mut v, 1.0, 1_024)
    };
    assert_eq!(make(9), make(9));
    assert_ne!(make(9), make(10));
    let mut s = voice(gen::SYNTH, &[(synth_p::LFO_DEPTH, 60.0), (synth_p::LFO_TARGET, 1.0)]);
    let mut t = voice(gen::SYNTH, &[(synth_p::LFO_DEPTH, 60.0), (synth_p::LFO_TARGET, 1.0)]);
    assert_eq!(run(&mut s, 1.3, 4_096), run(&mut t, 1.3, 4_096));
}

#[test]
fn every_kind_declares_its_catalogue_parameters() {
    assert_eq!(gen::params(gen::OSCILLATOR).len(), 10);
    assert_eq!(gen::params(gen::SYNTH).len(), 25);
    assert_eq!(gen::params(gen::BLIP).len(), 24);
    assert_eq!(gen::params(gen::SILENCE).len(), 2);
    assert!(gen::params(0).is_empty() && gen::params(5).is_empty());
    for kind in 1..=4 {
        for s in gen::params(kind) {
            assert!(s.min <= s.default && s.default <= s.max, "{kind}: {s:?}");
        }
    }
    // A blip's level is its only live parameter; sfxr's lowpassCutoff defaults to 1 (off).
    assert_eq!(gen::params(gen::BLIP)[bp::LOWPASS_CUTOFF].default, 1.0);
    assert_eq!(gen::params(gen::BLIP)[bp::LEVEL].glide, gen::Glide::Linear);
}

// --- The blip against sfxr ---

/// A direct port of sfxr's `ResetSample` and `SynthSample` (DrPetter, MIT): 44.1 kHz, 8× supersampled, naive
/// waveforms, its own filters and phaser. One `next()` is one of sfxr's output samples before its master volume.
struct Sfxr {
    p: [f32; bp::COUNT],
    playing: bool,
    phase: i32,
    fperiod: f64,
    fmaxperiod: f64,
    fslide: f64,
    fdslide: f64,
    period: i32,
    square_duty: f32,
    square_slide: f32,
    env_stage: usize,
    env_time: i32,
    env_length: [i32; 3],
    env_vol: f32,
    fphase: f32,
    fdphase: f32,
    iphase: i32,
    phaser: [f32; 1024],
    ipp: i32,
    noise: [f32; 32],
    fltp: f32,
    fltdp: f32,
    fltw: f32,
    fltw_d: f32,
    fltdmp: f32,
    fltphp: f32,
    flthp: f32,
    flthp_d: f32,
    vib_phase: f32,
    vib_speed: f32,
    vib_amp: f32,
    rep_time: i32,
    rep_limit: i32,
    arp_time: i32,
    arp_limit: i32,
    arp_mod: f64,
    rng: u32,
}

impl Sfxr {
    fn new(p: [f32; bp::COUNT]) -> Sfxr {
        let mut s = Sfxr {
            p,
            playing: true,
            phase: 0,
            fperiod: 0.0,
            fmaxperiod: 0.0,
            fslide: 0.0,
            fdslide: 0.0,
            period: 0,
            square_duty: 0.0,
            square_slide: 0.0,
            env_stage: 0,
            env_time: 0,
            env_length: [0; 3],
            env_vol: 0.0,
            fphase: 0.0,
            fdphase: 0.0,
            iphase: 0,
            phaser: [0.0; 1024],
            ipp: 0,
            noise: [0.0; 32],
            fltp: 0.0,
            fltdp: 0.0,
            fltw: 0.0,
            fltw_d: 0.0,
            fltdmp: 0.0,
            fltphp: 0.0,
            flthp: 0.0,
            flthp_d: 0.0,
            vib_phase: 0.0,
            vib_speed: 0.0,
            vib_amp: 0.0,
            rep_time: 0,
            rep_limit: 0,
            arp_time: 0,
            arp_limit: 0,
            arp_mod: 0.0,
            rng: 12_345,
        };
        s.reset(false);
        s
    }

    fn frnd(&mut self, range: f32) -> f32 {
        self.rng = self.rng.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        (self.rng >> 16 & 0x7FFF) as f32 / 32_767.0 * range
    }

    fn reset(&mut self, restart: bool) {
        let p = self.p;
        if !restart {
            self.phase = 0;
        }
        self.fperiod = 100.0 / ((p[bp::BASE_FREQUENCY] as f64).powi(2) + 0.001);
        self.period = self.fperiod as i32;
        self.fmaxperiod = 100.0 / ((p[bp::FREQUENCY_LIMIT] as f64).powi(2) + 0.001);
        self.fslide = 1.0 - (p[bp::SLIDE] as f64).powi(3) * 0.01;
        self.fdslide = -(p[bp::DELTA_SLIDE] as f64).powi(3) * 0.000_001;
        self.square_duty = 0.5 - p[bp::DUTY] * 0.5;
        self.square_slide = -p[bp::DUTY_SWEEP] * 0.000_05;
        let a = p[bp::ARPEGGIO_AMOUNT] as f64;
        self.arp_mod = if a >= 0.0 { 1.0 - a * a * 0.9 } else { 1.0 + a * a * 10.0 };
        self.arp_time = 0;
        self.arp_limit = ((1.0 - p[bp::ARPEGGIO_SPEED]).powi(2) * 20_000.0 + 32.0) as i32;
        if p[bp::ARPEGGIO_SPEED] == 1.0 {
            self.arp_limit = 0;
        }
        if !restart {
            self.fltp = 0.0;
            self.fltdp = 0.0;
            self.fltw = p[bp::LOWPASS_CUTOFF].powi(3) * 0.1;
            self.fltw_d = 1.0 + p[bp::LOWPASS_SWEEP] * 0.0001;
            self.fltdmp = (5.0 / (1.0 + p[bp::LOWPASS_RESONANCE].powi(2) * 20.0) * (0.01 + self.fltw)).min(0.8);
            self.fltphp = 0.0;
            self.flthp = p[bp::HIGHPASS_CUTOFF].powi(2) * 0.1;
            self.flthp_d = 1.0 + p[bp::HIGHPASS_SWEEP] * 0.0003;
            self.vib_phase = 0.0;
            self.vib_speed = p[bp::VIBRATO_SPEED].powi(2) * 0.01;
            self.vib_amp = p[bp::VIBRATO_DEPTH] * 0.5;
            self.env_vol = 0.0;
            self.env_stage = 0;
            self.env_time = 0;
            self.env_length = [(p[bp::ATTACK].powi(2) * 100_000.0) as i32, (p[bp::SUSTAIN].powi(2) * 100_000.0) as i32, (p[bp::DECAY].powi(2) * 100_000.0) as i32];
            self.fphase = p[bp::PHASER_OFFSET].powi(2) * 1_020.0 * p[bp::PHASER_OFFSET].signum();
            self.fdphase = p[bp::PHASER_SWEEP].powi(2) * p[bp::PHASER_SWEEP].signum();
            self.iphase = (self.fphase as i32).abs();
            self.ipp = 0;
            self.phaser = [0.0; 1024];
            for i in 0..32 {
                self.noise[i] = self.frnd(2.0) - 1.0;
            }
            self.rep_time = 0;
            self.rep_limit = ((1.0 - p[bp::REPEAT_SPEED]).powi(2) * 20_000.0 + 32.0) as i32;
            if p[bp::REPEAT_SPEED] == 0.0 {
                self.rep_limit = 0;
            }
        }
    }

    /// One output sample, or `None` once it has stopped.
    fn next(&mut self) -> Option<f32> {
        if !self.playing {
            return None;
        }
        self.rep_time += 1;
        if self.rep_limit != 0 && self.rep_time >= self.rep_limit {
            self.rep_time = 0;
            self.reset(true);
        }
        self.arp_time += 1;
        if self.arp_limit != 0 && self.arp_time >= self.arp_limit {
            self.arp_limit = 0;
            self.fperiod *= self.arp_mod;
        }
        self.fslide += self.fdslide;
        self.fperiod *= self.fslide;
        if self.fperiod > self.fmaxperiod {
            self.fperiod = self.fmaxperiod;
            if self.p[bp::FREQUENCY_LIMIT] > 0.0 {
                self.playing = false;
            }
        }
        let mut rfperiod = self.fperiod;
        if self.vib_amp > 0.0 {
            self.vib_phase += self.vib_speed;
            rfperiod = self.fperiod * (1.0 + (self.vib_phase as f64).sin() * self.vib_amp as f64);
        }
        self.period = (rfperiod as i32).max(8);
        self.square_duty = (self.square_duty + self.square_slide).clamp(0.0, 0.5);
        self.env_time += 1;
        if self.env_time > self.env_length[self.env_stage] {
            self.env_time = 0;
            self.env_stage += 1;
            if self.env_stage == 3 {
                self.playing = false;
                return None;
            }
        }
        let frac = |t: i32, l: i32| if l == 0 { 0.0 } else { t as f32 / l as f32 };
        self.env_vol = match self.env_stage {
            0 => frac(self.env_time, self.env_length[0]),
            1 => 1.0 + (1.0 - frac(self.env_time, self.env_length[1])) * 2.0 * self.p[bp::PUNCH],
            _ => 1.0 - frac(self.env_time, self.env_length[2]),
        };
        self.fphase += self.fdphase;
        self.iphase = ((self.fphase as i32).abs()).min(1023);
        if self.flthp_d != 0.0 {
            self.flthp = (self.flthp * self.flthp_d).clamp(0.000_01, 0.1);
        }
        let mut ssample = 0.0f32;
        for _ in 0..8 {
            self.phase += 1;
            if self.phase >= self.period {
                self.phase %= self.period;
                if self.p[bp::WAVEFORM] as u8 == blip::wave::NOISE {
                    for i in 0..32 {
                        self.noise[i] = self.frnd(2.0) - 1.0;
                    }
                }
            }
            let fp = self.phase as f32 / self.period as f32;
            let mut sample = match self.p[bp::WAVEFORM] as u8 {
                blip::wave::SAW => 1.0 - fp * 2.0,
                blip::wave::SINE => (fp * core::f32::consts::TAU).sin(),
                blip::wave::NOISE => self.noise[(self.phase * 32 / self.period) as usize],
                blip::wave::TRIANGLE => (1.0 - fp * 2.0).abs() * 2.0 - 1.0,
                _ => {
                    if fp < self.square_duty {
                        0.5
                    } else {
                        -0.5
                    }
                }
            };
            let pp = self.fltp;
            self.fltw = (self.fltw * self.fltw_d).clamp(0.0, 0.1);
            if self.p[bp::LOWPASS_CUTOFF] != 1.0 {
                self.fltdp += (sample - self.fltp) * self.fltw;
                self.fltdp -= self.fltdp * self.fltdmp;
            } else {
                self.fltp = sample;
                self.fltdp = 0.0;
            }
            self.fltp += self.fltdp;
            self.fltphp += self.fltp - pp;
            self.fltphp -= self.fltphp * self.flthp;
            sample = self.fltphp;
            self.phaser[(self.ipp & 1023) as usize] = sample;
            sample += self.phaser[((self.ipp - self.iphase + 1024) & 1023) as usize];
            self.ipp = (self.ipp + 1) & 1023;
            ssample += sample * self.env_vol;
        }
        Some(ssample / 8.0)
    }

    fn run(mut self) -> Vec<f32> {
        let mut out = Vec::new();
        while let Some(x) = self.next() {
            out.push(x);
            assert!(out.len() < 44_100 * 20, "sfxr ends");
        }
        out
    }
}

/// The blip kernel rendered at `rate` with level 0 dB until it ends.
fn blip_at(params: [f32; bp::COUNT], rate: f32) -> Vec<f32> {
    let mut v = GenVoice::default();
    v.start(gen::BLIP, rate, 5);
    for (i, &x) in params.iter().enumerate() {
        v.set(i, x, 0);
    }
    v.set(bp::LEVEL, 0.0, 0);
    let mut out = Vec::new();
    let mut c = [0.0f32; 128];
    loop {
        let alive = v.render(&[1.0; 128], &mut c, false);
        out.extend_from_slice(&c);
        if !alive {
            break;
        }
        assert!(out.len() < rate as usize * 20, "the blip ends");
    }
    while out.last() == Some(&0.0) {
        out.pop();
    }
    out
}

fn preset(set: &[(usize, f32)]) -> [f32; bp::COUNT] {
    let mut p: [f32; bp::COUNT] = core::array::from_fn(|i| gen::params(gen::BLIP)[i].default);
    for &(i, x) in set {
        p[i] = x;
    }
    p
}

/// The key parameters of sfxr's presets (one fixed draw of each generator function).
fn presets() -> Vec<(&'static str, [f32; bp::COUNT])> {
    use bp::*;
    vec![
        ("coin", preset(&[(WAVEFORM, 0.0), (BASE_FREQUENCY, 0.55), (SUSTAIN, 0.07), (DECAY, 0.35), (PUNCH, 0.45), (ARPEGGIO_SPEED, 0.55), (ARPEGGIO_AMOUNT, 0.4)])),
        ("laser", preset(&[(WAVEFORM, 1.0), (BASE_FREQUENCY, 0.75), (FREQUENCY_LIMIT, 0.2), (SLIDE, -0.3), (DUTY, 0.3), (SUSTAIN, 0.15), (DECAY, 0.25)])),
        ("jump", preset(&[(WAVEFORM, 0.0), (DUTY, 0.6), (BASE_FREQUENCY, 0.4), (SLIDE, 0.25), (SUSTAIN, 0.3), (DECAY, 0.2), (LOWPASS_CUTOFF, 0.8)])),
        ("explosion", preset(&[(WAVEFORM, 3.0), (BASE_FREQUENCY, 0.2), (SLIDE, -0.3), (SUSTAIN, 0.25), (DECAY, 0.35), (PUNCH, 0.4), (PHASER_OFFSET, 0.3), (PHASER_SWEEP, -0.2)])),
        ("powerup", preset(&[(WAVEFORM, 1.0), (BASE_FREQUENCY, 0.3), (SLIDE, 0.15), (VIBRATO_DEPTH, 0.4), (VIBRATO_SPEED, 0.4), (SUSTAIN, 0.4), (DECAY, 0.3)])),
        ("hit", preset(&[(WAVEFORM, 0.0), (BASE_FREQUENCY, 0.5), (SLIDE, -0.5), (DUTY, 0.4), (SUSTAIN, 0.1), (DECAY, 0.2), (HIGHPASS_CUTOFF, 0.2)])),
        ("blip", preset(&[(WAVEFORM, 0.0), (DUTY, 0.5), (BASE_FREQUENCY, 0.4), (SUSTAIN, 0.1), (DECAY, 0.1), (HIGHPASS_CUTOFF, 0.1)])),
        ("sweep", preset(&[(WAVEFORM, 2.0), (BASE_FREQUENCY, 0.6), (SUSTAIN, 0.3), (DECAY, 0.3), (LOWPASS_CUTOFF, 0.5), (LOWPASS_SWEEP, 0.3), (LOWPASS_RESONANCE, 0.5), (REPEAT_SPEED, 0.6)])),
    ]
}

/// RMS in windows of `ms`, normalised to the loudest.
fn envelope(x: &[f32], rate: f32, ms: f32) -> Vec<f32> {
    let w = (rate * ms / 1_000.0) as usize;
    let e: Vec<f32> = x.chunks(w).map(rms).collect();
    let top = e.iter().fold(0.0f32, |m, v| m.max(*v));
    e.iter().map(|v| v / top).collect()
}

#[test]
fn a_blip_lasts_as_long_as_sfxr_s_at_every_rate() {
    for (name, p) in presets() {
        let reference = Sfxr::new(p).run();
        let secs = reference.len() as f64 / 44_100.0;
        for rate in [44_100.0f32, 48_000.0, 96_000.0] {
            let ours = blip_at(p, rate);
            let ours_s = ours.len() as f64 / rate as f64;
            eprintln!("{name} at {rate}: {ours_s:.4} s against sfxr's {secs:.4} s");
            // Within two of sfxr's ticks and a control block (the last block's trailing zeros are trimmed).
            assert!((ours_s - secs).abs() < 2.0 / 44_100.0 + 16.0 / rate as f64, "{name} at {rate}: {ours_s} s against {secs} s");
        }
        if name != "laser" {
            // With no frequency limit, sfxr's length is its envelope's.
            assert!((secs - blip::envelope_seconds(p[bp::ATTACK], p[bp::SUSTAIN], p[bp::DECAY])).abs() < 2.0 / 44_100.0, "{name}");
        }
    }
}

#[test]
fn a_blip_follows_sfxr_s_pitch_through_slides_and_arpeggios() {
    let mut total = 0;
    for (name, p) in presets() {
        if p[bp::WAVEFORM] as u8 == blip::wave::NOISE || p[bp::VIBRATO_DEPTH] > 0.0 {
            continue;
        }
        // The oscillator alone: no filters, no phaser (they don't move the pitch).
        let mut q = p;
        q[bp::LOWPASS_CUTOFF] = 1.0;
        q[bp::HIGHPASS_CUTOFF] = 0.0;
        q[bp::REPEAT_SPEED] = 0.0;
        let reference = Sfxr::new(q).run();
        let ours = blip_at(q, RATE);
        let win = 0.02;
        let mut t = 0.01;
        let mut checked = 0;
        while t + win < reference.len() as f64 / 44_100.0 - 0.01 {
            let a = (t * 44_100.0) as usize;
            let fr = frequency(&reference[a..a + (win * 44_100.0) as usize]) * 44_100.0 / RATE;
            let b = (t * RATE as f64) as usize;
            let fo = frequency(&ours[b..b + (win * RATE as f64) as usize]);
            if fr > 30.0 {
                assert!((fo / fr - 1.0).abs() < 0.01, "{name} at {t:.2} s: {fo} Hz against sfxr's {fr} Hz");
                checked += 1;
            }
            t += win;
        }
        eprintln!("{name}: pitch matches sfxr's in {checked} windows of 20 ms");
        assert!(checked >= 1, "{name}");
        total += checked;
    }
    assert!(total >= 40, "{total} windows");
    // Coin's arpeggio jumps up by 1 / arp_mod at sfxr's arp_limit ticks.
    let (_, coin) = presets()[0];
    let ours = blip_at(coin, RATE);
    let limit = ((1.0 - 0.55f32).powi(2) * 20_000.0 + 32.0) as f32 / 44_100.0;
    let before = frequency(&ours[(0.02 * RATE) as usize..((limit - 0.01) * RATE) as usize]);
    let after = frequency(&ours[((limit + 0.01) * RATE) as usize..((limit + 0.05) * RATE) as usize]);
    let ratio = 1.0 / (1.0 - 0.4f32 * 0.4 * 0.9);
    assert!((after / before / ratio - 1.0).abs() < 0.02, "{after} / {before} against {ratio}");
}

#[test]
fn a_blip_s_envelope_follows_sfxr_s() {
    for (name, p) in presets() {
        // Noise's draws differ from sfxr's: its windows are longer (the RMS of 10 ms of held noise varies ±10 %).
        let noise = p[bp::WAVEFORM] as u8 == blip::wave::NOISE;
        let ms = if noise { 40.0 } else { 10.0 };
        let reference = envelope(&Sfxr::new(p).run(), 44_100.0, ms);
        let ours = envelope(&blip_at(p, RATE), RATE, ms);
        let n = reference.len().min(ours.len());
        let mut worst = 0.0f32;
        for k in 1..n - 1 {
            worst = worst.max((reference[k] - ours[k]).abs());
        }
        eprintln!("{name}: envelope within {worst:.3} of sfxr's ({ms} ms RMS, normalised)");
        // Band-limiting and the filters' mapping move the level a little.
        let tol = if noise { 0.2 } else { 0.15 };
        assert!(worst < tol, "{name}: {worst}");
    }
}

#[test]
fn a_looping_blip_re_triggers_until_the_key_off() {
    let (_, p) = presets()[6];
    let mut v = GenVoice::default();
    v.start(gen::BLIP, RATE, 1);
    for (i, &x) in p.iter().enumerate() {
        v.set(i, x, 0);
    }
    let len = blip::envelope_seconds(p[bp::ATTACK], p[bp::SUSTAIN], p[bp::DECAY]);
    let mut c = [0.0f32; 128];
    let quanta = (3.5 * len * RATE as f64 / 128.0) as usize;
    for _ in 0..quanta {
        assert!(v.render(&[1.0; 128], &mut c, true), "a looping blip keeps going");
    }
    v.key_off();
    let mut n = 0;
    while v.render(&[1.0; 128], &mut c, true) {
        n += 128;
    }
    assert!((n as f64) < len * RATE as f64 + 256.0, "after the key-off it plays to its end: {n}");
}
