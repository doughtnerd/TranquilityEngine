//! Ambisonic files through the decoder (ADR 0162 B2): 4, 9 and 16-channel WAV decode exactly,
//! other multichannel counts are refused at open, and a FuMa file read with
//! `set_convention(FuMa)` comes out as its AmbiX twin (scaled into int16 headroom before the
//! rounding, the import gain undoing the scale).

mod common;

use std::sync::Arc;

use common::*;
use myco_audio_decode::{Convention, DecodeError, Decoder, FormatHint};

fn open_bytes(b: Vec<u8>) -> Result<Decoder, DecodeError> {
    Decoder::open(Arc::new(b), FormatHint::Wav)
}

/// A distinct int16 value per frame and channel.
fn tag(f: u32, c: u16) -> i16 {
    ((f as i32 * 37 + i32::from(c) * 1999) % 60_000 - 30_000) as i16
}

#[test]
fn four_nine_and_sixteen_channel_wavs_decode_exactly() {
    for channels in [4u16, 9, 16] {
        let frames = 10_000u32;
        let mut d = open_bytes(pcm16_wav(channels, frames, tag)).unwrap();
        let info = d.info();
        assert_eq!((info.channels, info.frames, info.sample_rate), (u32::from(channels), Some(u64::from(frames)), 48_000));
        let ch = usize::from(channels);
        let mut got = Vec::new();
        let mut buf = vec![0i16; 4096 * ch];
        loop {
            let n = d.read_i16(&mut buf).unwrap();
            got.extend_from_slice(&buf[..n * ch]);
            if n == 0 {
                break;
            }
        }
        assert_eq!(got.len(), frames as usize * ch);
        for (k, &s) in got.iter().enumerate() {
            assert_eq!(s, tag((k / ch) as u32, (k % ch) as u16), "{channels} channels: sample {k}");
        }
    }
}

#[test]
fn other_multichannel_counts_are_refused() {
    for channels in [3u16, 5, 6, 7, 8, 10, 15, 17] {
        match open_bytes(pcm16_wav(channels, 64, |_, _| 0)) {
            Err(DecodeError::Codec(m)) => assert!(m.contains(&format!("{channels}-channel")) && m.contains("ADR 0162"), "{m}"),
            Err(e) => panic!("{channels} channels: {e:?}"),
            Ok(_) => panic!("{channels} channels opened"),
        }
    }
    for channels in [1u16, 2] {
        assert!(open_bytes(pcm16_wav(channels, 64, |_, _| 0)).is_ok());
    }
}

// --- FuMa twins ------------------------------------------------------------------------------

/// FuMa (MaxN) gains of a plane wave from azimuth `a`, elevation `e`, in FuMa order
/// W X Y Z R S T U V K L M N O P Q.
fn fuma(a: f64, e: f64) -> [f64; 16] {
    let (sa, ca, se, ce) = (a.sin(), a.cos(), e.sin(), e.cos());
    let (s2a, c2a, s3a, c3a, s2e) = ((2.0 * a).sin(), (2.0 * a).cos(), (3.0 * a).sin(), (3.0 * a).cos(), (2.0 * e).sin());
    let k135 = (135.0f64 / 256.0).sqrt();
    let k27 = (27.0f64 / 4.0).sqrt();
    [
        std::f64::consts::FRAC_1_SQRT_2,
        ca * ce,
        sa * ce,
        se,
        (3.0 * se * se - 1.0) / 2.0,
        ca * s2e,
        sa * s2e,
        c2a * ce * ce,
        s2a * ce * ce,
        se * (5.0 * se * se - 3.0) / 2.0,
        k135 * ca * ce * (5.0 * se * se - 1.0),
        k135 * sa * ce * (5.0 * se * se - 1.0),
        k27 * c2a * se * ce * ce,
        k27 * s2a * se * ce * ce,
        c3a * ce * ce * ce,
        s3a * ce * ce * ce,
    ]
}

/// AmbiX (ACN, SN3D) gains of the same plane wave.
fn ambix(a: f64, e: f64) -> [f64; 16] {
    let (sa, ca, se, ce) = (a.sin(), a.cos(), e.sin(), e.cos());
    let (s2a, c2a, s3a, c3a, s2e) = ((2.0 * a).sin(), (2.0 * a).cos(), (3.0 * a).sin(), (3.0 * a).cos(), (2.0 * e).sin());
    let r3 = 3.0f64.sqrt() / 2.0;
    let r58 = (5.0f64 / 8.0).sqrt();
    let r15 = 15.0f64.sqrt() / 2.0;
    let r38 = (3.0f64 / 8.0).sqrt();
    [
        1.0,
        sa * ce,
        se,
        ca * ce,
        r3 * s2a * ce * ce,
        r3 * sa * s2e,
        (3.0 * se * se - 1.0) / 2.0,
        r3 * ca * s2e,
        r3 * c2a * ce * ce,
        r58 * s3a * ce * ce * ce,
        r15 * s2a * se * ce * ce,
        r38 * sa * ce * (5.0 * se * se - 1.0),
        se * (5.0 * se * se - 3.0) / 2.0,
        r38 * ca * ce * (5.0 * se * se - 1.0),
        r15 * c2a * se * ce * ce,
        r58 * c3a * ce * ce * ce,
    ]
}

/// Frame `f`'s direction and amplitude: azimuths in 15° steps, seven elevations, a sine amplitude.
fn wave(f: u32) -> (f64, f64, f64) {
    let a = f64::from(f % 24) * 15f64.to_radians();
    let e = f64::from((f / 24) % 7) * 30f64.to_radians() - std::f64::consts::FRAC_PI_2;
    let s = 0.7 * (f64::from(f) * 0.013).sin();
    (a, e, s)
}

#[test]
fn a_fuma_file_reads_as_its_ambix_twin_within_1e_6() {
    for (order, channels) in [(1, 4u16), (2, 9), (3, 16)] {
        let frames = 5_000u32;
        let file = built_wav(channels, frames, 32, |f, c| {
            let (a, e, s) = wave(f);
            (s * fuma(a, e)[usize::from(c)]) as f32
        });
        let mut d = open_bytes(file).unwrap();
        let gain = d.set_convention(Convention::FuMa).unwrap();
        assert_eq!(gain, std::f32::consts::SQRT_2, "order {order}");
        // Seek first: the packet a seek decodes is converted too.
        assert_eq!(d.seek(700).unwrap(), 700);
        let ch = usize::from(channels);
        let mut out = vec![0f32; frames as usize * ch];
        let n = d.read_f32(&mut out).unwrap();
        assert_eq!(n, (frames - 700) as usize);
        for f in 0..n {
            let (a, e, s) = wave(f as u32 + 700);
            let want = ambix(a, e);
            for c in 0..ch {
                let got = f64::from(out[f * ch + c] * gain);
                assert!((got - s * want[c]).abs() <= 1e-6, "order {order}: frame {f} ACN {c}: {got} vs {}", s * want[c]);
            }
        }
    }
}

#[test]
fn the_headroom_scale_comes_before_the_int16_rounding() {
    // A full-scale FuMa W (0.999): AmbiX W is √2 × that, past full scale, but the headroom scale
    // brings it back to 0.999, so read_i16 holds it unclipped and the import gain restores it.
    let file = built_wav(4, 256, 32, |f, c| match c {
        0 => 0.999,
        1 => 0.5 * (f as f32 * 0.1).sin(),
        _ => -0.25,
    });
    let mut d = open_bytes(file).unwrap();
    let gain = d.set_convention(Convention::FuMa).unwrap();
    let mut out = vec![0i16; 256 * 4];
    assert_eq!(d.read_i16(&mut out).unwrap(), 256);
    let r = |x: f32| (x * 32768.0).round() as i16;
    for f in 0..256 {
        let x = 0.5 * (f as f32 * 0.1).sin();
        // ACN W Y Z X from FuMa W X Y Z: W × √2 / √2, Y, Z, X × 1 / √2.
        let want = [r(0.999), r(-0.25 / gain), r(-0.25 / gain), r(x / gain)];
        for c in 0..4 {
            assert!((i32::from(out[f * 4 + c]) - i32::from(want[c])).abs() <= 1, "frame {f} ACN {c}: {} vs {}", out[f * 4 + c], want[c]);
        }
    }
}

#[test]
fn ambix_and_non_ambisonic_files_are_left_as_decoded() {
    for (channels, convention) in [(4u16, Convention::AmbiX), (2, Convention::FuMa), (1, Convention::FuMa)] {
        let mut d = open_bytes(pcm16_wav(channels, 512, tag)).unwrap();
        assert_eq!(d.set_convention(convention).unwrap(), 1.0);
        let ch = usize::from(channels);
        let mut out = vec![0i16; 512 * ch];
        assert_eq!(d.read_i16(&mut out).unwrap(), 512);
        for (k, &s) in out.iter().enumerate() {
            assert_eq!(s, tag((k / ch) as u32, (k % ch) as u16));
        }
    }
}
