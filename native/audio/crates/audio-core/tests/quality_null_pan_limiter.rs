//! Objective quality: unity null, pan power law and limiter ceiling (ADR 0157, api-and-models
//! section 8 "Objective quality": "unity null (< -120 dBFS), pan power constant within 0.01 dB,
//! limiter at or below 0 dBFS").
//!
//! These live in `audio-core/tests/` (not `audio-dsp/tests/`) because they drive the whole core
//! (voices, bus tree, MASTER) through the wire path, and `audio-dsp` cannot depend on `audio-core`.
//! The pan law is also checked on the bare `audio_dsp::pan` kernel.
//!
//! Thresholds, quoted from the section: null residual below -120 dBFS; `L^2 + R^2` of a panned
//! unit signal within 0.01 dB of unity over the whole azimuth range; output peak at or below
//! 0 dBFS. The master limiter (`audio_dsp::limiter`, A2.8) runs on the output after MASTER; its
//! tests here drive it through the core at 44.1, 48 and 96 kHz (its own unit tests are in
//! `audio-dsp`). Its look-ahead (A2.9) delays all output by `bus::output_latency_frames` (72 frames
//! at 48 kHz for the default 1.5 ms): the nulls compare the clip with the output that many frames
//! later, and the first frames of a render are the delay line's silence.
mod common;
use audio_core::bus;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::Core;
use audio_dsp::limiter;
use audio_dsp::pan::EqualPowerPanner;
use common::*;

/// Deterministic white-ish noise in [-0.5, 0.5): an LCG, so the test needs no RNG crate.
fn noise(n: usize) -> Vec<f32> {
    let mut s: u32 = 0x1234_5678;
    (0..n)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        })
        .collect()
}

fn db_power(p: f64) -> f64 {
    10.0 * p.max(1e-300).log10()
}

/// Residual of `out` against `want` in dBFS (RMS), and the largest absolute difference.
fn residual(out: &[f32], want: &[f32]) -> (f64, f32) {
    let mut sum = 0.0f64;
    let mut max = 0.0f32;
    for (&o, &w) in out.iter().zip(want) {
        let d = o - w;
        sum += (d as f64) * (d as f64);
        max = max.max(d.abs());
    }
    (db_power(sum / want.len() as f64), max)
}

const NULL_LIMIT_DBFS: f64 = -120.0;
const PAN_LIMIT_DB: f64 = 0.01;
const CLIP: u32 = 7;
const V1: u32 = 0x0001_0001;
const FRAMES: usize = 8 * 128;

/// Plays the noise clip (non-spatial, mixed, pitch 1, gain 1) on `bus` of a tree of `parents`
/// with MASTER at `master`; returns the residual of both channels against the clip.
fn null_through(parents: &[u16], bus: u16, master_volume: Option<f32>) -> ((f64, f32), (f64, f32)) {
    let clip = noise(FRAMES);
    let mut m = Mixer::new(parents.len().max(1) as u32);
    m.load_clip(CLIP, &clip);
    let mut recs = vec![config(parents)];
    if let Some(v) = master_volume {
        recs.push(master(v, false, 0));
    }
    recs.push(play(V1, CLIP, bus, MIXED));
    m.submit(&recs);
    let (l, r) = m.render_n(FRAMES / 128);
    let d = m.latency();
    assert!(l[..d].iter().chain(&r[..d]).all(|x| *x == 0.0), "the limiter's delay line starts silent");
    (residual(&l[d..], &clip[..FRAMES - d]), residual(&r[d..], &clip[..FRAMES - d]))
}

#[test]
fn a_unity_voice_through_the_root_bus_nulls_against_the_clip() {
    let (l, r) = null_through(&[ROOT], 0, None);
    println!("unity null, root bus: L {:.1} dBFS (max {:e}), R {:.1} dBFS (max {:e})", l.0, l.1, r.0, r.1);
    assert!(l.0 < NULL_LIMIT_DBFS && r.0 < NULL_LIMIT_DBFS, "residual {} / {} dBFS", l.0, r.0);
}

#[test]
fn a_unity_voice_through_nested_buses_and_master_nulls_against_the_clip() {
    // bus 2 -> bus 1 -> bus 0 -> root, MASTER at an explicit unity.
    let (l, r) = null_through(&[ROOT, 0, 1], 2, Some(1.0));
    println!("unity null, three nested buses + MASTER 1.0: L {:.1} dBFS (max {:e}), R {:.1} dBFS (max {:e})", l.0, l.1, r.0, r.1);
    assert!(l.0 < NULL_LIMIT_DBFS && r.0 < NULL_LIMIT_DBFS, "residual {} / {} dBFS", l.0, r.0);
}

#[test]
fn a_unity_voice_nulls_after_gains_ramp_away_and_back() {
    // Bus 0 and MASTER go to 0.25 and back to 1.0 over a few quanta, then the clip plays: the
    // ramps must land exactly on unity (no residual gain error).
    let clip = noise(FRAMES);
    let mut m = Mixer::new(1);
    m.load_clip(CLIP, &clip);
    m.submit(&[config(&[ROOT]), gains(100, &[0.25]), master(0.25, false, 100)]);
    m.render_n(2);
    m.submit(&[gains(300, &[1.0]), master(1.0, false, 300)]);
    m.render_n(4);
    m.submit(&[play(V1, CLIP, 0, MIXED)]);
    let (l, _) = m.render_n(FRAMES / 128);
    // Heard the limiter's latency later; before it, the end of the (silent) ramps.
    let d = m.latency();
    assert!(l[..d].iter().all(|x| *x == 0.0));
    let r = residual(&l[d..], &clip[..FRAMES - d]);
    println!("unity null after ramps: {:.1} dBFS (max {:e})", r.0, r.1);
    assert!(r.0 < NULL_LIMIT_DBFS, "residual {} dBFS", r.0);
}

/// Gains of the bare kernel over the whole range: `gL^2 + gR^2` within 0.01 dB of 1 (mono source).
#[test]
fn the_equal_power_kernel_holds_constant_power_over_every_azimuth() {
    let mut worst = 0.0f64;
    let mut panner = EqualPowerPanner::new();
    let mut az = -180.0f64;
    while az <= 180.0 {
        panner.update_desired_gain(az, 1);
        let (gl, gr) = panner.desired_gains();
        worst = worst.max(db_power(gl * gl + gr * gr).abs());
        az += 0.25;
    }
    println!("pan power (kernel, mono): worst {worst:.2e} dB");
    assert!(worst <= PAN_LIMIT_DB, "power varies by {worst} dB");
}

/// A stereo source keeps constant power per input channel (a signal on one side only), as Blink's
/// stereo law is built: the identity channel passes at 1 and the other is panned with the law.
#[test]
fn the_stereo_kernel_holds_constant_power_per_input_channel() {
    let (zero, one) = ([0.0f32; 4], [1.0f32; 4]);
    let mut worst = 0.0f64;
    let mut panner = EqualPowerPanner::new();
    let mut az = -90.0f64;
    while az <= 90.0 {
        for (l, r) in [(&one, &zero), (&zero, &one)] {
            let (mut dl, mut dr) = ([0.0f32; 4], [0.0f32; 4]);
            panner.pan(az, l, Some(r), &mut dl, &mut dr, 4);
            // Power of the destination pair for a unit signal on one input channel.
            let p = (dl[0] as f64).powi(2) + (dr[0] as f64).powi(2);
            // A signal on the identity side reaches one output at 1: total power 1 either way.
            worst = worst.max(db_power(p).abs());
        }
        az += 0.25;
    }
    println!("pan power (kernel, stereo): worst {worst:.2e} dB");
    assert!(worst <= PAN_LIMIT_DB, "power varies by {worst} dB");
}

/// The whole core: a spatial looping DC voice at azimuths around the horizontal circle; after one
/// quantum the matrix is settled (PLAY sets it at once) so the last frame is the steady output.
#[test]
fn a_spatial_voice_holds_constant_power_through_the_core() {
    let mut worst = 0.0f64;
    let mut az = -180.0f64;
    while az < 180.0 {
        let mut m = Mixer::new(1);
        let rad = az.to_radians();
        let Rec::Play(mut p) = play(V1, DC, 0, MIXED | LOOP | SPATIAL) else { unreachable!() };
        p.dir_x = rad.sin() as f32;
        p.dir_z = -(rad.cos() as f32);
        m.submit(&[config(&[ROOT]), Rec::Play(p)]);
        let (l, r) = m.render();
        let (gl, gr) = (l[127] as f64, r[127] as f64);
        worst = worst.max(db_power(gl * gl + gr * gr).abs());
        az += 7.5;
    }
    println!("pan power (core, DC voice, 48 azimuths): worst {worst:.2e} dB");
    assert!(worst <= PAN_LIMIT_DB, "power varies by {worst} dB");
}

/// One full-scale voice stays at or below 0 dBFS: nothing in the unity path adds level.
#[test]
fn a_single_full_scale_voice_peaks_at_or_below_zero_dbfs() {
    let mut m = Mixer::new(1);
    m.submit(&[config(&[ROOT]), dc(V1, 0, 0.0)]);
    let (l, r) = m.render_n(4);
    let peak = l.iter().chain(&r).fold(0.0f32, |a, &v| a.max(v.abs()));
    println!("single full-scale voice peak: {peak}");
    assert!(peak <= 1.0, "peak {peak}");
}

/// The ceiling: four full-scale voices sum to +12 dBFS before the master limiter (A2.8), which
/// holds the output at or below 0 dBFS; the steady DC sits on the ceiling exactly.
#[test]
fn the_master_limiter_holds_summed_voices_at_or_below_zero_dbfs() {
    let mut m = Mixer::new(1);
    m.submit(&[config(&[ROOT]), dc(V1, 0, 0.0), dc(V1 + 1, 0, 0.0), dc(V1 + 2, 0, 0.0), dc(V1 + 3, 0, 0.0)]);
    let (l, r) = m.render_n(4);
    let peak = l.iter().chain(&r).fold(0.0f32, |a, &v| a.max(v.abs()));
    println!("four full-scale voices: peak {peak} ({:.2} dBFS)", db_power((peak as f64).powi(2)));
    assert!(peak <= 1.0, "peak {peak} is above 0 dBFS");
    let d = m.latency();
    assert!(l[d..].iter().chain(&r[d..]).all(|&x| x == limiter::CEILING), "the summed DC is held on the ceiling once heard");
    assert_eq!(bus::area(&m.core).limited, 4, "the limiter acted in every quantum");
}

/// A core at `rate` with the DC clip loaded.
fn mixer_at(rate: f32) -> Mixer {
    let p = InitParams { sample_rate: rate, ..params(4) };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    Mixer::over(unsafe { Core::new(p, layout, base) })
}

/// One period-aligned full-scale sine clip at 48 kHz (`period` frames), looped by the voice.
fn sine_clip(period: usize) -> Vec<f32> {
    (0..period).map(|i| (2.0 * std::f64::consts::PI * i as f64 / period as f64).sin() as f32).collect()
}

/// Four full-scale looping tones (100, 300, 400, 1,000 Hz at 48 kHz, resampled to the context
/// rate), one hard left, one hard right, two centred, for a second at 44.1, 48 and 96 kHz: the
/// output never exceeds 0 dBFS, and the limiter really worked (the sum goes far over).
#[test]
fn the_master_limiter_holds_summed_tones_at_every_rate() {
    for rate in [44_100.0f32, 48_000.0, 96_000.0] {
        let mut m = mixer_at(rate);
        let mut recs = vec![config(&[ROOT])];
        for (k, period) in [480usize, 160, 120, 48].into_iter().enumerate() {
            let clip = 100 + k as u32;
            m.load_clip(clip, &sine_clip(period));
            let Rec::Play(mut p) = play(V1 + k as u32, clip, 0, MIXED | LOOP | if k < 2 { SPATIAL } else { 0 }) else { unreachable!() };
            if k < 2 {
                p.dir_x = if k == 0 { -1.0 } else { 1.0 };
                p.dir_z = 0.0;
            }
            recs.push(Rec::Play(p));
        }
        m.submit(&recs);
        let quanta = rate as usize / 128;
        let (l, r) = m.render_n(quanta);
        let peak = l.iter().chain(&r).fold(0.0f32, |a, &v| a.max(v.abs()));
        let limited = bus::area(&m.core).limited;
        println!("{rate} Hz: four full-scale tones, output peak {peak}, limited in {limited} of {quanta} quanta");
        assert!(peak <= 1.0, "{rate}: peak {peak}");
        assert!(peak > 0.99, "{rate}: the limiter keeps the level up to the ceiling ({peak})");
        assert!(limited as usize > quanta / 2, "{rate}: the sum is over the ceiling most of the time");
    }
}

/// The limiter is after MASTER: four DC voices at MASTER 0.25 sum to exactly 1.0 and pass
/// untouched (bit-exact, no limiting, only delayed); at MASTER 0.5 the same voices are limited to
/// the ceiling, the gain gliding down over the look-ahead before the louder signal is heard.
#[test]
fn the_master_limiter_comes_after_master() {
    let mut m = Mixer::new(1);
    let d = m.latency();
    assert_eq!(d, 72, "1.5 ms at 48 kHz");
    m.submit(&[config(&[ROOT]), master(0.25, false, 0), dc(V1, 0, 0.0), dc(V1 + 1, 0, 0.0), dc(V1 + 2, 0, 0.0), dc(V1 + 3, 0, 0.0)]);
    m.render_n(2);
    m.expect(L, 0.0, "MASTER 0.25: exactly 1.0", |_| 1.0);
    m.expect(R, 0.0, "MASTER 0.25: exactly 1.0, right", |_| 1.0);
    assert_eq!(bus::area(&m.core).limited, 0, "nothing limited under the ceiling");
    m.submit(&[master(0.5, false, 0)]);
    let (l, _) = m.render();
    // The last D frames at 1.0 (MASTER 0.25) are heard in this quantum, ramped down by the
    // look-ahead toward the 0.5 the next frames need: a linear ramp landing on the ceiling.
    for k in 0..d {
        let g = 1.0 - 0.5 * (k + 1) as f32 / (d + 1) as f32;
        assert!((l[k] - g).abs() < 1e-6, "look-ahead ramp at frame {k}: {} vs {g}", l[k]);
    }
    assert!(l[d..].iter().all(|&x| x == limiter::CEILING), "MASTER 0.5: on the ceiling");
    assert_eq!(bus::area(&m.core).limited, 1);
}

/// With the look-ahead set to 0 ms the core has no output latency and the limiter is A2.8's: the
/// same voices come out at once, held on the ceiling from the first frame (instant attack).
#[test]
fn zero_ms_look_ahead_has_no_latency() {
    let mut m = Mixer::new(1);
    m.set_lookahead(0.0);
    assert_eq!(m.latency(), 0);
    m.submit(&[config(&[ROOT]), master(0.25, false, 0), dc(V1, 0, 0.0), dc(V1 + 1, 0, 0.0), dc(V1 + 2, 0, 0.0), dc(V1 + 3, 0, 0.0)]);
    let (l, r) = m.render();
    assert!(l.iter().chain(&r).all(|&x| x == 1.0), "no delay: 1.0 from frame 0");
    m.submit(&[master(0.5, false, 0)]);
    let (l, _) = m.render();
    assert!(l.iter().all(|&x| x == limiter::CEILING), "instant attack: on the ceiling at once");
}

/// The look-ahead is fixed when the core starts: `set_limiter_lookahead` works before the first
/// quantum (5 ms is 240 frames at 48 kHz) and is refused after it, leaving the latency alone.
#[test]
fn the_look_ahead_is_set_before_the_first_quantum_only() {
    let mut m = Mixer::new(1);
    m.set_lookahead(5.0);
    assert_eq!(m.latency(), 240);
    assert!(bus::set_limiter_lookahead(&mut m.core, 9.0), "still before the first quantum");
    assert_eq!(bus::output_latency_frames(&m.core), 240, "clamped to 5 ms");
    m.submit(&[config(&[ROOT]), dc(V1, 0, 0.0)]);
    m.render_n(3);
    m.expect(L, 0.0, "a DC voice, 240 frames late", |_| 1.0);
    assert!(!bus::set_limiter_lookahead(&mut m.core, 0.0), "refused once rendering");
    assert_eq!(bus::output_latency_frames(&m.core), 240);
    assert_eq!(bus::area(&m.core).limiter_lookahead_ms, 5.0);
}

/// RESET returns the limiter to its pass-through: after a loud passage and RESET, a voice at 0.5 comes
/// out exactly (no gain reduction carried over, no release tail).
#[test]
fn reset_clears_the_limiters_gain_reduction() {
    let mut m = Mixer::new(1);
    m.submit(&[config(&[ROOT]), dc(V1, 0, 0.0), dc(V1 + 1, 0, 0.0), dc(V1 + 2, 0, 0.0), dc(V1 + 3, 0, 0.0)]);
    m.render_n(2);
    assert!(!bus::area(&m.core).limiter.is_bypassed());
    m.submit(&[reset(true)]);
    assert!(bus::area(&m.core).limiter.is_bypassed(), "RESET clears it");
    let Rec::Play(mut p) = dc(V1 + 10, 0, 0.0) else { unreachable!() };
    p.gain = 0.5;
    m.submit(&[Rec::Play(p)]);
    // RESET also cleared the delay line: its D frames of silence, then the voice exactly.
    let (l, r) = m.render();
    let d = m.latency();
    assert!(l[..d].iter().chain(&r[..d]).all(|&x| x == 0.0), "the cleared delay line");
    assert!(l[d..].iter().chain(&r[d..]).all(|&x| x == 0.5), "{:?}", &l[d..d + 4]);
}
