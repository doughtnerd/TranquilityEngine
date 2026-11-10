// SPDX-License-Identifier: Apache-2.0 OR MIT
//! A2.2a acceptance (api-and-models §9: "sweeps ... equal Blink's reference values to float
//! tolerance"; task A2.2a-L3): the biquad port against references built here.
//!
//! The references are independent of the port: the Audio EQ Cookbook lowpass and highpass that
//! Blink's `SetLowpassParams`/`SetHighpassParams` implement, in `f64` with `std` math and Web
//! Audio's Q in dB (linear Q = 10^(Q/20)); a direct-form loop written from `Biquad::Process`
//! (double history, float output); and the analytic frequency response of the reference
//! coefficients. The sweeps cover cut-offs from 20 Hz to 20 kHz, Q from -10 to 20 dB, at 44.1 and
//! 48 kHz.

use std::f64::consts::PI;

use audio_dsp::biquad::{coeffs, Biquad, PASSTHROUGH};

const RATES: [f32; 2] = [44_100.0, 48_000.0];
const CUTOFFS: [f32; 11] = [20.0, 50.0, 100.0, 200.0, 500.0, 1_000.0, 2_000.0, 5_000.0, 10_000.0, 15_000.0, 20_000.0];
const Q_DB: [f32; 7] = [-10.0, 0.0, 1.0, 3.0, 6.0, 12.0, 20.0];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Lowpass,
    Highpass,
}

/// The cookbook coefficients `[b0, b1, b2, a1, a2] / a0`, Q in dB (Web Audio's lowpass and
/// highpass), with `f64` math throughout.
fn reference_coefficients(kind: Kind, rate: f32, freq: f32, q_db: f32) -> [f64; 5] {
    let w0 = 2.0 * PI * freq as f64 / rate as f64;
    let q = 10f64.powf(q_db as f64 / 20.0);
    let alpha = w0.sin() / (2.0 * q);
    let cos = w0.cos();
    let (b0, b1, b2) = match kind {
        Kind::Lowpass => ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0),
        Kind::Highpass => ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0),
    };
    let a0 = 1.0 + alpha;
    [b0 / a0, b1 / a0, b2 / a0, -2.0 * cos / a0, (1.0 - alpha) / a0]
}

/// `|H(e^{jw})|` of `c` at `freq`.
fn magnitude(c: &[f64; 5], rate: f32, freq: f64) -> f64 {
    let w = 2.0 * PI * freq / rate as f64;
    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
    let num = ((c[0] + c[1] * c1 + c[2] * c2).powi(2) + (c[1] * s1 + c[2] * s2).powi(2)).sqrt();
    let den = ((1.0 + c[3] * c1 + c[4] * c2).powi(2) + (c[3] * s1 + c[4] * s2).powi(2)).sqrt();
    num / den
}

/// `Biquad::Process` written out: double history, each output rounded to float.
fn reference_process(c: &[f64; 5], x: &[f32]) -> Vec<f32> {
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    x.iter()
        .map(|&xn| {
            let y = (c[0] * xn as f64 + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2) as f32;
            x2 = x1;
            x1 = xn as f64;
            y2 = y1;
            y1 = y as f64;
            y
        })
        .collect()
}

fn port(kind: Kind, rate: f32, freq: f32, q_db: f32) -> Biquad {
    let mut b = Biquad::default();
    match kind {
        Kind::Lowpass => b.set_lowpass(rate, freq, q_db),
        Kind::Highpass => b.set_highpass(rate, freq, q_db),
    }
    b
}

/// Runs `x` through `b` in 128-frame quanta, both channels, and checks they agree.
fn run(b: &mut Biquad, x: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(x.len());
    for block in x.chunks(128) {
        let mut l = block.to_vec();
        let mut r = block.to_vec();
        b.process(&mut l, &mut r);
        assert_eq!(l, r, "both channels filter alike");
        out.extend(l);
    }
    out
}

#[test]
fn the_port_is_in() {
    assert!(!PASSTHROUGH);
}

/// Sweep: every coefficient equals the cookbook's to float tolerance (the port's linear Q comes
/// from upstream's single-precision `pow10`, hence 1e-6 and not 1e-12).
#[test]
fn coefficient_sweep_matches_the_cookbook() {
    let mut worst = 0.0f64;
    for kind in [Kind::Lowpass, Kind::Highpass] {
        for rate in RATES {
            for freq in CUTOFFS {
                for q in Q_DB {
                    let want = reference_coefficients(kind, rate, freq, q);
                    let got = port(kind, rate, freq, q).coefficients;
                    for i in 0..5 {
                        let err = (got[i] - want[i]).abs() / want[i].abs().max(1.0);
                        worst = worst.max(err);
                        assert!(err < 1e-6, "{kind:?} {rate} Hz, {freq} Hz, Q {q} dB, coefficient {i}: {} vs {}", got[i], want[i]);
                    }
                }
            }
        }
    }
    println!("worst relative coefficient error: {worst:e}");
}

/// Web Audio's Q in dB for these two types: the response at the cut-off is Q (linear), so 0 dB of
/// Q gives unity there and 6 dB about 2.
#[test]
fn the_gain_at_the_cut_off_is_q_in_db() {
    for kind in [Kind::Lowpass, Kind::Highpass] {
        for q in Q_DB {
            let b = port(kind, 48_000.0, 1_000.0, q);
            let db = 20.0 * magnitude(&b.coefficients, 48_000.0, 1_000.0).log10();
            assert!((db - q as f64).abs() < 1e-4, "{kind:?} Q {q} dB: {db} dB at the cut-off");
        }
    }
}

/// Upstream's edges: at Nyquist a lowpass is a wire and a highpass silent; at 0 Hz the reverse;
/// a cut-off above Nyquist clamps to it.
#[test]
fn edges_at_zero_and_nyquist() {
    let x: Vec<f32> = (0..256).map(|n| ((n * 7919) % 200) as f32 / 100.0 - 1.0).collect();
    for (kind, freq, wire) in [(Kind::Lowpass, 24_000.0, true), (Kind::Lowpass, 30_000.0, true), (Kind::Highpass, 24_000.0, false), (Kind::Lowpass, 0.0, false), (Kind::Highpass, 0.0, true)] {
        let y = run(&mut port(kind, 48_000.0, freq, 1.0), &x);
        if wire {
            assert_eq!(y, x, "{kind:?} at {freq} Hz passes");
        } else {
            assert!(y.iter().all(|&v| v == 0.0), "{kind:?} at {freq} Hz is silent");
        }
    }
}

/// Impulse and noise responses equal the direct-form reference on the cookbook coefficients,
/// through quantum boundaries.
#[test]
fn processing_matches_the_direct_form_reference() {
    let mut seed = 0x2545_f491u32;
    let noise: Vec<f32> = (0..2_048)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as f32 / u32::MAX as f32 * 2.0 - 1.0
        })
        .collect();
    let mut impulse = vec![0.0f32; 2_048];
    impulse[0] = 1.0;
    for kind in [Kind::Lowpass, Kind::Highpass] {
        for rate in RATES {
            for freq in [50.0, 500.0, 5_000.0, 15_000.0] {
                for q in [-10.0, 0.0, 6.0, 20.0] {
                    let c = reference_coefficients(kind, rate, freq, q);
                    for x in [&impulse, &noise] {
                        let want = reference_process(&c, x);
                        let got = run(&mut port(kind, rate, freq, q), x);
                        let peak = want.iter().fold(1.0f32, |m, v| m.max(v.abs()));
                        for (n, (g, w)) in got.iter().zip(&want).enumerate() {
                            assert!((g - w).abs() <= 2e-5 * peak, "{kind:?} {rate} {freq} Q {q}: frame {n}: {g} vs {w}");
                        }
                    }
                }
            }
        }
    }
}

/// Frequency sweep: a settled sine through the port has the analytic amplitude and phase of the
/// reference filter (`A |H| sin(w n + arg H)`), sample by sample.
#[test]
fn sine_sweep_matches_the_analytic_response() {
    let rate = 48_000.0f32;
    for kind in [Kind::Lowpass, Kind::Highpass] {
        for cutoff in [200.0f32, 1_000.0, 5_000.0] {
            for q in [0.0f32, 6.0] {
                let c = reference_coefficients(kind, rate, cutoff, q);
                for ratio in [0.25f64, 0.5, 1.0, 2.0, 4.0] {
                    let f = cutoff as f64 * ratio;
                    let w = 2.0 * PI * f / rate as f64;
                    let x: Vec<f32> = (0..20_480).map(|n| (w * n as f64).sin() as f32).collect();
                    let y = run(&mut port(kind, rate, cutoff, q), &x);
                    // H(e^{jw}) as a complex number.
                    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
                    let (nr, ni) = (c[0] + c[1] * c1 + c[2] * c2, -(c[1] * s1 + c[2] * s2));
                    let (dr, di) = (1.0 + c[3] * c1 + c[4] * c2, -(c[3] * s1 + c[4] * s2));
                    let den = dr * dr + di * di;
                    let (hr, hi) = ((nr * dr + ni * di) / den, (ni * dr - nr * di) / den);
                    let (mag, phase) = ((hr * hr + hi * hi).sqrt(), hi.atan2(hr));
                    assert!((mag - magnitude(&c, rate, f)).abs() < 1e-9);
                    for n in 16_384..20_480 {
                        let want = mag * (w * n as f64 + phase).sin();
                        let got = y[n] as f64;
                        assert!((got - want).abs() < 1e-4, "{kind:?} {cutoff} Hz Q {q} dB at {f} Hz, frame {n}: {got} vs {want} (|H| {mag})");
                    }
                }
            }
        }
    }
}

/// The k-rate update the bus makes once per quantum: re-setting the same values keeps the output
/// identical to an uninterrupted run; a change keeps the history (no reset, so no click).
#[test]
fn re_setting_each_quantum_is_seamless() {
    let x: Vec<f32> = (0..1_024).map(|n| (n as f32 * 0.05).sin()).collect();
    let once = run(&mut port(Kind::Lowpass, 48_000.0, 800.0, 1.0), &x);
    let mut b = Biquad::default();
    let mut each = Vec::new();
    for block in x.chunks(128) {
        b.set_lowpass(48_000.0, 800.0, 1.0);
        let (mut l, mut r) = (block.to_vec(), block.to_vec());
        b.process(&mut l, &mut r);
        each.extend(l);
    }
    assert_eq!(each, once);
}

/// The coefficient module's normalisation is `BiquadDSPKernel`'s `frequency / nyquist`.
#[test]
fn frequency_is_normalised_by_nyquist() {
    assert_eq!(coeffs::normalize_frequency(48_000.0, 12_000.0), 0.5);
    assert_eq!(coeffs::normalize_frequency(44_100.0, 22_050.0), 1.0);
}
