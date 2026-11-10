// SPDX-License-Identifier: Apache-2.0 OR MIT
//! A2.2a acceptance (api-and-models §9: "... compressor curve equal Blink's reference values to
//! float tolerance"; task A2.2a): the compressor port against references built here.
//!
//! - `Blink` below is `DynamicsCompressor` written out from `dynamics_compressor.cc` at the pinned
//!   commit, member for member and in upstream's order, with `std` math (not the port's `libm`),
//!   upstream's 1,024-frame pre-delay ring, its metering, and none of the port's shortcuts. The
//!   port's output equals it sample for sample to float tolerance at 44.1 and 48 kHz with Web
//!   Audio's defaults and other settings.
//! - The static curve is also checked against its definition: the identity below the threshold,
//!   a slope of `1 / ratio` (dB over dB) past the knee, and a settled output level of
//!   `makeup * saturate(level)` for a steady input, with the makeup gain `(1 / saturate(1))^0.6`.
//! - A timing test (`#[ignore]`, release mode) measures 32 buses' effects per quantum.

use std::f32::consts::FRAC_PI_2;

use audio_dsp::biquad::Biquad;
use audio_dsp::compressor::{Compressor, Curve, MAX_PRE_DELAY_FRAMES, PASSTHROUGH};

/// `DynamicsCompressorNode` defaults: threshold, knee, ratio, attack, release.
const DEFAULTS: [f32; 5] = [-24.0, 30.0, 12.0, 0.003, 0.25];

/// Upstream `DynamicsCompressor`, written out.
struct Blink {
    params: [f32; 5],
    sample_rate: f32,
    detector_average: f32,
    compressor_gain: f32,
    metering_release_k: f32,
    metering_gain: f32,
    max_pre_delay_frames: usize,
    last_pre_delay_frames: usize,
    pre_delay_buffers: [Vec<f32>; 2],
    pre_delay_read_index: usize,
    pre_delay_write_index: usize,
    db_max_attack_compression_diff: f32,
    ratio: f32,
    slope: f32,
    linear_threshold: f32,
    db_threshold: f32,
    db_knee: f32,
    knee_threshold: f32,
    db_knee_threshold: f32,
    db_yknee_threshold: f32,
    knee: f32,
}

fn lin_to_db(x: f32) -> f32 {
    20.0 * x.log10()
}

fn db_to_lin(x: f32) -> f32 {
    10f32.powf(0.05 * x)
}

fn finite(x: f32, d: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        d
    }
}

fn flush(x: f32) -> f32 {
    if x.abs() < f32::MIN_POSITIVE {
        0.0
    } else {
        x
    }
}

const K_A: f32 = 0.9999999999999998 * 0.09 + 1.8432219684323923e-16 * 0.16 - 1.9373394351676423e-16 * 0.42 + 8.824516011816245e-18 * 0.98;
const K_B: f32 = -1.5788320352845888 * 0.09 + 2.3305837032074286 * 0.16 - 0.9141194204840429 * 0.42 + 0.1623677525612032 * 0.98;
const K_C: f32 = 0.5334142869106424 * 0.09 - 1.272736789213631 * 0.16 + 0.9258856042207512 * 0.42 - 0.18656310191776226 * 0.98;
const K_D: f32 = 0.08783463138207234 * 0.09 - 0.1694162967925622 * 0.16 + 0.08588057951595272 * 0.42 - 0.00429891410546283 * 0.98;
const K_E: f32 = -0.042416883008123074 * 0.09 + 0.1115693827987602 * 0.16 - 0.09764676325265872 * 0.42 + 0.028494263462021576 * 0.98;

impl Blink {
    /// The constructor, with `kMaxPreDelayFrames` as given (upstream: 1,024).
    fn new(sample_rate: f32, max_pre_delay_frames: usize) -> Blink {
        let mut b = Blink {
            params: DEFAULTS,
            sample_rate,
            detector_average: 0.0,
            compressor_gain: 1.0,
            metering_release_k: (1.0 - (-1.0 / (sample_rate as f64 * 0.325)).exp()) as f32,
            metering_gain: 1.0,
            max_pre_delay_frames,
            last_pre_delay_frames: 256,
            pre_delay_buffers: [vec![0.0; max_pre_delay_frames], vec![0.0; max_pre_delay_frames]],
            pre_delay_read_index: 0,
            pre_delay_write_index: 256,
            db_max_attack_compression_diff: -1.0,
            ratio: -1.0,
            slope: -1.0,
            linear_threshold: -1.0,
            db_threshold: -1.0,
            db_knee: -1.0,
            knee_threshold: -1.0,
            db_knee_threshold: -1.0,
            db_yknee_threshold: -1.0,
            knee: -1.0,
        };
        b.reset();
        b
    }

    fn reset(&mut self) {
        self.detector_average = 0.0;
        self.compressor_gain = 1.0;
        self.metering_gain = 1.0;
        for buf in &mut self.pre_delay_buffers {
            buf.fill(0.0);
        }
        self.pre_delay_read_index = 0;
        self.pre_delay_write_index = 256;
        self.db_max_attack_compression_diff = -1.0;
    }

    fn knee_curve(&self, x: f32, k: f32) -> f32 {
        if x < self.linear_threshold {
            return x;
        }
        self.linear_threshold + (1.0 - ((-k * (x - self.linear_threshold)) as f64).exp() as f32) / k
    }

    fn saturate(&self, x: f32, k: f32) -> f32 {
        if x < self.knee_threshold {
            return self.knee_curve(x, k);
        }
        let db_x = lin_to_db(x);
        let db_y = self.db_yknee_threshold + self.slope * (db_x - self.db_knee_threshold);
        db_to_lin(db_y)
    }

    fn k_at_slope(&self, desired_slope: f32) -> f32 {
        let db_x = self.db_threshold + self.db_knee;
        let x = db_to_lin(db_x);
        let mut x2 = 1.0f32;
        let mut db_x2 = 0.0f32;
        if !(x < self.linear_threshold) {
            x2 = (x as f64 * 1.001) as f32;
            db_x2 = lin_to_db(x2);
        }
        let (mut min_k, mut max_k, mut k) = (0.1f32, 10_000.0f32, 5.0f32);
        let mut slope = 1.0f32;
        for _ in 0..15 {
            if !(x < self.linear_threshold) {
                let db_y = lin_to_db(self.knee_curve(x, k));
                let db_y2 = lin_to_db(self.knee_curve(x2, k));
                slope = (db_y2 - db_y) / (db_x2 - db_x);
            }
            if slope < desired_slope {
                max_k = k;
            } else {
                min_k = k;
            }
            k = (min_k * max_k).sqrt();
        }
        k
    }

    fn update_static_curve_parameters(&mut self, db_threshold: f32, db_knee: f32, ratio: f32) -> f32 {
        if db_threshold != self.db_threshold || db_knee != self.db_knee || ratio != self.ratio {
            self.db_threshold = db_threshold;
            self.linear_threshold = db_to_lin(db_threshold);
            self.db_knee = db_knee;
            self.ratio = ratio;
            self.slope = 1.0 / self.ratio;
            let k = self.k_at_slope(1.0 / self.ratio);
            self.db_knee_threshold = db_threshold + db_knee;
            self.knee_threshold = db_to_lin(self.db_knee_threshold);
            self.db_yknee_threshold = lin_to_db(self.knee_curve(self.knee_threshold, k));
            self.knee = k;
        }
        self.knee
    }

    fn set_pre_delay_time(&mut self, t: f32) {
        let mut frames = (t * self.sample_rate) as usize;
        if frames > self.max_pre_delay_frames - 1 {
            frames = self.max_pre_delay_frames - 1;
        }
        if self.last_pre_delay_frames != frames {
            self.last_pre_delay_frames = frames;
            for buf in &mut self.pre_delay_buffers {
                buf.fill(0.0);
            }
            self.pre_delay_read_index = 0;
            self.pre_delay_write_index = frames;
        }
    }

    /// `Process` on a stereo source into a stereo destination.
    fn process(&mut self, src: [&[f32]; 2], dst: [&mut [f32]; 2]) {
        let [dl, dr] = dst;
        let frames = src[0].len();
        let [db_threshold, db_knee, ratio, attack_time, release_time] = self.params;
        let sample_rate = self.sample_rate;
        let k = self.update_static_curve_parameters(db_threshold, db_knee, ratio);
        let linear_post_gain = (1.0 / self.saturate(1.0, k)).powf(0.6);
        let attack_frames = 0.001f32.max(attack_time) * sample_rate;
        let release_frames = sample_rate * release_time;
        let sat_release_frames = 0.0025 * sample_rate;
        let (a, b, c, d, e) = (release_frames * K_A, release_frames * K_B, release_frames * K_C, release_frames * K_D, release_frames * K_E);
        self.set_pre_delay_time(0.006);
        let mask = self.max_pre_delay_frames; // the ring wraps at its length
        let mut frame_index = 0;
        while frame_index < frames {
            self.detector_average = finite(self.detector_average, 1.0);
            let desired_gain = self.detector_average;
            let scaled_desired_gain = desired_gain.asin() / FRAC_PI_2;
            let envelope_rate;
            let is_releasing = scaled_desired_gain > self.compressor_gain;
            let mut db_compression_diff = if scaled_desired_gain == 0.0 {
                if is_releasing {
                    -1.0
                } else {
                    1.0
                }
            } else {
                lin_to_db(self.compressor_gain / scaled_desired_gain)
            };
            if is_releasing {
                self.db_max_attack_compression_diff = -1.0;
                db_compression_diff = finite(db_compression_diff, -1.0);
                let mut x = db_compression_diff.clamp(-12.0, 0.0);
                x = 0.25 * (x + 12.0);
                let x2 = x * x;
                let x3 = x2 * x;
                let x4 = x2 * x2;
                let calc_release_frames = a + b * x + c * x2 + d * x3 + e * x4;
                let db_per_frame = 5.0 / calc_release_frames;
                envelope_rate = db_to_lin(db_per_frame);
            } else {
                db_compression_diff = finite(db_compression_diff, 1.0);
                if self.db_max_attack_compression_diff == -1.0 || self.db_max_attack_compression_diff < db_compression_diff {
                    self.db_max_attack_compression_diff = db_compression_diff;
                }
                let db_eff_atten_diff = 0.5f32.max(self.db_max_attack_compression_diff);
                let x = 0.25 / db_eff_atten_diff;
                envelope_rate = 1.0 - x.powf(1.0 / attack_frames);
            }
            let mut read = self.pre_delay_read_index;
            let mut write = self.pre_delay_write_index;
            let mut detector_average = self.detector_average;
            let mut compressor_gain = self.compressor_gain;
            let loop_frames = 32.min(frames - frame_index);
            for _ in 0..loop_frames {
                let mut compressor_input = 0.0f32;
                for j in 0..2 {
                    let undelayed = src[j][frame_index];
                    self.pre_delay_buffers[j][write] = undelayed;
                    let abs = if undelayed > 0.0 { undelayed } else { -undelayed };
                    if compressor_input < abs {
                        compressor_input = abs;
                    }
                }
                let scaled_input = compressor_input;
                let abs_input = if scaled_input > 0.0 { scaled_input } else { -scaled_input };
                let shaped_input = self.saturate(abs_input, k);
                let attenuation = if abs_input <= 0.0001 { 1.0 } else { shaped_input / abs_input };
                let db_attenuation = 2.0f32.max(-lin_to_db(attenuation));
                let db_per_frame = db_attenuation / sat_release_frames;
                let sat_release_rate = db_to_lin(db_per_frame) - 1.0;
                let is_release = attenuation > detector_average;
                let rate = if is_release { sat_release_rate } else { 1.0 };
                detector_average += (attenuation - detector_average) * rate;
                detector_average = 1.0f32.min(detector_average);
                detector_average = finite(detector_average, 1.0);
                if envelope_rate < 1.0 {
                    compressor_gain += (scaled_desired_gain - compressor_gain) * envelope_rate;
                } else {
                    compressor_gain *= envelope_rate;
                    compressor_gain = 1.0f32.min(compressor_gain);
                }
                let post_warp_compressor_gain = ((FRAC_PI_2 * compressor_gain) as f64).sin() as f32;
                let total_gain = linear_post_gain * post_warp_compressor_gain;
                let db_real_gain = lin_to_db(post_warp_compressor_gain);
                if db_real_gain < self.metering_gain {
                    self.metering_gain = db_real_gain;
                } else {
                    self.metering_gain += (db_real_gain - self.metering_gain) * self.metering_release_k;
                }
                dl[frame_index] = self.pre_delay_buffers[0][read] * total_gain;
                dr[frame_index] = self.pre_delay_buffers[1][read] * total_gain;
                frame_index += 1;
                read = (read + 1) % mask;
                write = (write + 1) % mask;
            }
            self.pre_delay_read_index = read;
            self.pre_delay_write_index = write;
            self.detector_average = flush(detector_average);
            self.compressor_gain = flush(compressor_gain);
        }
    }
}

fn port(rate: f32, p: [f32; 5]) -> Compressor {
    let mut c = Compressor::default();
    c.configure(rate, p[0], p[1], p[2], p[3], p[4]);
    c
}

/// A test signal: a 220 Hz tone on the left and 330 Hz on the right whose level steps through
/// quiet, loud, very loud and quiet again, so the run attacks and releases.
fn program(rate: f32, frames: usize) -> [Vec<f32>; 2] {
    let level = |n: usize| match n * 8 / frames {
        0 => 0.01,
        1 | 2 => 0.5,
        3 => 1.0,
        4 => 0.05,
        5 => 2.0,
        _ => 0.02,
    };
    let tone = |f: f32| (0..frames).map(|n| level(n) * (2.0 * std::f32::consts::PI * f * n as f32 / rate).sin()).collect();
    [tone(220.0), tone(330.0)]
}

/// Runs both in quanta of `quantum` frames; returns the largest difference relative to the
/// reference's peak (at least 1: the makeup gain of a low threshold reaches about 30).
fn compare(rate: f32, p: [f32; 5], blink_max_pre_delay: usize, quantum: usize, x: &[Vec<f32>; 2]) -> f32 {
    let mut ours = port(rate, p);
    let mut blink = Blink::new(rate, blink_max_pre_delay);
    blink.params = ours.params;
    let (mut worst, mut peak) = (0.0f32, 1.0f32);
    for (bl, br) in x[0].chunks(quantum).zip(x[1].chunks(quantum)) {
        let (mut l, mut r) = (bl.to_vec(), br.to_vec());
        ours.process(&mut l, &mut r);
        let (mut wl, mut wr) = (vec![0.0; bl.len()], vec![0.0; bl.len()]);
        blink.process([bl, br], [&mut wl, &mut wr]);
        for (g, w) in l.iter().chain(&r).zip(wl.iter().chain(&wr)) {
            worst = worst.max((g - w).abs());
            peak = peak.max(w.abs());
        }
    }
    worst / peak
}

#[test]
fn the_port_is_in() {
    assert!(!PASSTHROUGH);
}

/// The port equals upstream's `Process` frame for frame (1 s of program material), with the
/// defaults and other settings, at 44.1 and 48 kHz, in 128-frame quanta and in odd blocks.
#[test]
fn processing_matches_blink_frame_for_frame() {
    let settings = [DEFAULTS, [-40.0, 0.0, 20.0, 0.0, 0.05], [-12.0, 6.0, 4.0, 0.02, 0.5], [0.0, 40.0, 1.0, 1.0, 1.0], [-100.0, 10.0, 2.0, 0.001, 0.0]];
    let mut overall = 0.0f32;
    for rate in [44_100.0f32, 48_000.0] {
        let x = program(rate, rate as usize);
        for p in settings {
            for quantum in [128, 77] {
                let worst = compare(rate, p, 1_024, quantum, &x);
                assert!(worst < 1e-5, "{rate} Hz {p:?} blocks of {quantum}: worst difference {worst}");
                overall = overall.max(worst);
            }
        }
    }
    println!("worst difference from upstream, relative to the peak: {overall:e}");
}

/// Above 48 kHz the port holds the pre-delay at 288 frames (its documented difference); with
/// upstream's ring holding the same delay, the rest is still upstream's.
#[test]
fn above_48_khz_only_the_pre_delay_differs() {
    let x = program(96_000.0, 96_000);
    let worst = compare(96_000.0, DEFAULTS, MAX_PRE_DELAY_FRAMES as usize + 1, 128, &x);
    assert!(worst < 1e-5, "worst difference {worst}");
}

/// The pre-delay: a click comes out exactly 6 ms later (288 frames at 48 kHz, 264 at 44.1 kHz).
#[test]
fn a_click_comes_out_after_6_ms() {
    for (rate, delay) in [(48_000.0, 288), (44_100.0, 264)] {
        let mut c = port(rate, DEFAULTS);
        let mut l = vec![0.0f32; 512];
        l[10] = 0.001;
        let mut r = l.clone();
        let mut out = Vec::new();
        for (bl, br) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
            c.process(bl, br);
            out.extend_from_slice(bl);
        }
        let first = out.iter().position(|&v| v != 0.0);
        assert_eq!(first, Some(10 + delay), "{rate} Hz");
    }
}

/// The curve upstream builds for the parameters (a fresh `Curve` set up like the port's).
fn curve(p: [f32; 5]) -> (Curve, f32) {
    let mut c = Curve { ratio: -1.0, slope: -1.0, linear_threshold: -1.0, db_threshold: -1.0, db_knee: -1.0, knee_threshold: -1.0, db_knee_threshold: -1.0, db_yknee_threshold: -1.0, knee: -1.0 };
    let k = c.update(p[0], p[1], p[2]);
    (c, k)
}

/// The static curve equals upstream's (the written-out `Saturate`) from -60 to +12 dB, and has the
/// shape it is defined to have: the identity below the threshold, continuous at the knee's end,
/// and a slope of `1 / ratio` past it.
#[test]
fn the_static_curve_matches_blink_and_its_definition() {
    for p in [DEFAULTS, [-40.0, 0.0, 20.0, 0.0, 0.0], [-12.0, 6.0, 4.0, 0.0, 0.0], [-30.0, 10.0, 2.0, 0.0, 0.0]] {
        let (c, k) = curve(p);
        let mut blink = Blink::new(48_000.0, 1_024);
        let bk = blink.update_static_curve_parameters(p[0], p[1], p[2]);
        assert!((k - bk).abs() <= 1e-5 * bk, "{p:?}: k {k} vs {bk}");
        for step in 0..=720 {
            let db = -60.0 + step as f32 * 0.1;
            let x = db_to_lin(db);
            let got = c.saturate(x, k);
            let want = blink.saturate(x, bk);
            assert!((got - want).abs() <= 1e-5 * want.max(1e-3), "{p:?} at {db} dB: {got} vs {want}");
            if db < p[0] - 0.01 {
                assert_eq!(got, x, "{p:?}: identity below the threshold ({db} dB)");
            }
        }
        // Continuous at the knee's end, then a constant slope of 1 / ratio.
        let knee_end = c.knee_threshold;
        let below = c.knee_curve(knee_end * 0.9999, k);
        let above = c.saturate(knee_end * 1.0001, k);
        assert!((above / below - 1.0).abs() < 1e-3, "{p:?}: continuous at the knee's end");
        let (d1, d2) = (p[0] + p[1] + 3.0, p[0] + p[1] + 9.0);
        if d2 < 12.0 {
            let slope = (lin_to_db(c.saturate(db_to_lin(d2), k)) - lin_to_db(c.saturate(db_to_lin(d1), k))) / (d2 - d1);
            assert!((slope - 1.0 / p[2]).abs() < 1e-3, "{p:?}: slope {slope}");
        }
    }
}

/// The compressor curve through processing: a steady input (a square wave, so its level is
/// constant) settles at `makeup * saturate(level)`, with the makeup gain `(1 / saturate(1))^0.6`.
/// Swept from -50 to +6 dB with Web Audio's defaults.
#[test]
fn a_steady_input_settles_on_the_curve_with_makeup_gain() {
    let (c, k) = curve(DEFAULTS);
    let makeup = (1.0 / c.saturate(1.0, k)).powf(0.6);
    // Upstream's value for the defaults, from the written-out reference.
    let blink = {
        let mut b = Blink::new(48_000.0, 1_024);
        let bk = b.update_static_curve_parameters(-24.0, 30.0, 12.0);
        (1.0 / b.saturate(1.0, bk)).powf(0.6)
    };
    assert!((makeup - blink).abs() < 1e-5, "makeup {makeup} vs {blink}");
    println!("makeup gain with the defaults: {makeup} ({} dB)", lin_to_db(makeup));
    for db in [-50.0f32, -40.0, -30.0, -24.0, -20.0, -12.0, -6.0, 0.0, 6.0] {
        let level = db_to_lin(db);
        let mut comp = port(48_000.0, DEFAULTS);
        let mut last = 0.0;
        // 3 s: the release (0.25 s, adaptive) and the attack both settle.
        for q in 0..1_125 {
            let mut l: Vec<f32> = (0..128).map(|n| if (q * 128 + n) / 64 % 2 == 0 { level } else { -level }).collect();
            let mut r = l.clone();
            comp.process(&mut l, &mut r);
            last = l[127].abs();
        }
        let want = makeup * c.saturate(level, k);
        assert!((last - want).abs() <= 1e-4 * want, "{db} dB: settled at {last}, curve says {want}");
    }
}

/// Bad input never makes NaNs: extreme parameters, a huge signal, silence.
#[test]
fn extreme_settings_stay_finite() {
    for p in [[0.0, 0.0, 1.0, 0.0, 0.0], [-100.0, 40.0, 20.0, 1.0, 1.0], [-100.0, 0.0, 20.0, 0.0, 0.0]] {
        let mut c = port(48_000.0, p);
        for q in 0..200 {
            let v = match q % 3 {
                0 => 0.0,
                1 => 1e20,
                _ => 1e-30,
            };
            let (mut l, mut r) = ([v; 128], [-v; 128]);
            c.process(&mut l, &mut r);
            assert!(l.iter().chain(&r).all(|x| x.is_finite()), "{p:?} quantum {q}");
        }
    }
}

/// Memory: the compressor is the largest effect state, so it sizes every effect slot.
#[test]
fn the_effect_states_stay_small() {
    let comp = std::mem::size_of::<Compressor>();
    let biquad = std::mem::size_of::<Biquad>();
    println!("Compressor {comp} B, Biquad {biquad} B");
    assert!(comp <= 2_400, "Compressor is {comp} bytes");
    assert!(biquad <= 128, "Biquad is {biquad} bytes");
}

/// Per-quantum cost of 32 buses, each with a lowpass, a highpass, a compressor and the snapshot
/// low-pass, on 128-frame stereo quanta. Release mode: `cargo test --release -p audio-dsp --test
/// ports_compressor -- --ignored --nocapture`.
#[test]
#[ignore]
fn timing_32_buses_with_every_effect() {
    struct Bus {
        lp: Biquad,
        hp: Biquad,
        comp: Compressor,
        snap: Biquad,
    }
    let rate = 48_000.0;
    let mut buses: Vec<Bus> = (0..32)
        .map(|i| {
            let mut b = Bus { lp: Biquad::default(), hp: Biquad::default(), comp: port(rate, DEFAULTS), snap: Biquad::default() };
            b.lp.set_lowpass(rate, 4_000.0 + i as f32, 1.0);
            b.hp.set_highpass(rate, 80.0, 0.0);
            b
        })
        .collect();
    let x = program(rate, 128 * 64);
    let quanta = 4_000;
    let mut sink = 0.0f32;
    // 0: every effect; 1: the three biquads only; 2: the compressor only.
    for (mode, what) in [(0, "lowpass, highpass, compressor, snapshot low-pass"), (1, "the three biquads"), (2, "the compressor")] {
        let mut times = Vec::with_capacity(quanta);
        for q in 0..quanta {
            let at = (q % 64) * 128;
            let start = std::time::Instant::now();
            for (i, b) in buses.iter_mut().enumerate() {
                let mut l = [0.0f32; 128];
                let mut r = [0.0f32; 128];
                l.copy_from_slice(&x[0][at..at + 128]);
                r.copy_from_slice(&x[1][at..at + 128]);
                if mode != 2 {
                    b.lp.process(&mut l, &mut r);
                    b.hp.process(&mut l, &mut r);
                }
                if mode != 1 {
                    b.comp.process(&mut l, &mut r);
                }
                if mode != 2 {
                    b.snap.set_lowpass(rate, 1_000.0 + (q % 7) as f32 + i as f32, 1.0);
                    b.snap.process(&mut l, &mut r);
                }
                sink += l[0] + r[127];
            }
            times.push(start.elapsed().as_secs_f64() * 1e6);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        let p99 = times[times.len() * 99 / 100];
        println!("32 buses x ({what}): mean {mean:.1} us, p99 {p99:.1} us per quantum");
    }
    assert!(sink.is_finite());
}
