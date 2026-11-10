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
//! 0 dBFS. The limiter does not exist yet (api section 5 lists `limiter` among the `audio-dsp`
//! modules to be written; MASTER is a plain gain), so its test is `#[ignore]`d with the numbers.
mod common;
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
    (residual(&l, &clip), residual(&r, &clip))
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
    let r = residual(&l, &clip);
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

/// The ceiling: the limiter is not written (the MASTER path is a gain), so four full-scale voices
/// sum to +12 dBFS. When `audio-dsp::limiter` is wired into MASTER, remove the `ignore`: the output
/// must stay at or below 0 dBFS. Run with `cargo test -- --ignored` to see the number.
#[test]
#[ignore = "no limiter yet: MASTER is a plain gain (api-and-models section 5 lists `limiter` as to be written)"]
fn the_master_limiter_holds_summed_voices_at_or_below_zero_dbfs() {
    let mut m = Mixer::new(1);
    m.submit(&[config(&[ROOT]), dc(V1, 0, 0.0), dc(V1 + 1, 0, 0.0), dc(V1 + 2, 0, 0.0), dc(V1 + 3, 0, 0.0)]);
    let (l, r) = m.render_n(4);
    let peak = l.iter().chain(&r).fold(0.0f32, |a, &v| a.max(v.abs()));
    println!("four full-scale voices: peak {peak} ({:.2} dBFS)", db_power((peak as f64).powi(2)));
    assert!(peak <= 1.0, "peak {peak} is above 0 dBFS");
}
