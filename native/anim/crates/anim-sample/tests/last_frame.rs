//! ADR 0451, "As built: the clamped last frame": a clip whose duration isn't a whole number of
//! frames has `ceil(d · r − 1e-6) + 1` frames, the last at `d` (less than a frame after the one
//! before), and every sampler honours that spacing.
//!
//! The fixture's one float track holds `100 · time` of each frame's time (`min(i / r, d)`), so
//! sampling it right reads `100 · t` at every `t` up to `d`, and `100 · d` after.

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, ClipView, Track, TrackKind};
use anim_format::frames::{frame_count, frame_time};
use anim_format::NONE;
use anim_offline::sample as reference;
use anim_sample::{ClipBindings, ClipSampler, Form, FramePos, TrackSample};

fn linear_clip(duration: f32, rate: f32) -> Clip {
    let frames = frame_count(duration as f64, rate as f64);
    let raw = (0..frames)
        .map(|i| (100.0 * frame_time(i, rate as f64, duration as f64)) as f32)
        .collect();
    Clip {
        flags: 0,
        name: NONE,
        duration,
        sample_rate: rate,
        frame_count: frames,
        bone_count: 0,
        root_bone: NONE,
        strings: vec!["node".into()],
        tracks: vec![Track {
            kind: TrackKind::Float,
            flags: 0,
            subtype: 0,
            binding: Binding::property(0, NONE, NONE),
            raw,
            keys: Vec::new(),
        }],
        has_raw: true,
        root_curve: None,
        compressed: None,
    }
}

fn raw_value(s: &ClipSampler<'_>, t: f32) -> f32 {
    let mut out = [0.0f32; 1];
    assert_eq!(s.sample_track(0, t, &mut out), TrackSample::Written);
    out[0]
}

#[test]
fn a_clip_of_1_01_s_at_30_hz_ends_on_its_last_frame() {
    let clip = linear_clip(1.01, 30.0);
    assert_eq!(clip.frame_count, 32, "ceil(30.3) + 1");
    let bytes = clip.write().unwrap();
    let view = ClipView::parse(&bytes).unwrap();
    let s = ClipSampler::new(view, Form::Raw).unwrap();

    // Frame 30 is at 1.0 s, frame 31 at 1.01 s: 1.005 s is halfway between them.
    let p = s.frame_pos(1.005);
    assert_eq!((p.f0, p.f1), (30, 31));
    assert!((p.alpha - 0.5).abs() < 1e-3, "{p:?}");
    assert_eq!(
        s.frame_pos(1.01),
        FramePos {
            f0: 31,
            f1: 31,
            alpha: 0.0
        }
    );
    assert_eq!(s.frame_pos(5.0).f0, 31);

    // The value at t is 100 · t through the raw sampler, the bound sampler and the reference.
    let bindings = ClipBindings::new(&s);
    let bound = bindings.bind(&s).unwrap();
    for (t, want) in [
        (1.0f32, 100.0f32),
        (1.005, 100.5),
        (1.01, 101.0),
        (2.0, 101.0),
    ] {
        assert!(
            (raw_value(&s, t) - want).abs() < 2e-3,
            "raw at {t}: {}",
            raw_value(&s, t)
        );
        let mut out = [0.0f32; 1];
        assert_eq!(bound.sample_track(0, t, &mut out), TrackSample::Written);
        assert!((out[0] - want).abs() < 2e-3, "bound at {t}: {}", out[0]);
        let r = reference::sample_raw_track(&view, 0, t as f64).unwrap()[0];
        assert!((r - want as f64).abs() < 2e-3, "reference at {t}: {r}");
    }
}

#[test]
fn a_whole_number_of_frames_samples_as_before() {
    // 1 s at 30 Hz: 31 frames, uniformly spaced; x = t · rate, clamped to the last frame.
    let clip = linear_clip(1.0, 30.0);
    assert_eq!(clip.frame_count, 31);
    let bytes = clip.write().unwrap();
    let view = ClipView::parse(&bytes).unwrap();
    let s = ClipSampler::new(view, Form::Raw).unwrap();
    for t in [0.0f32, 0.25, 0.5, 0.875, 0.984375, 1.0, 1.5] {
        let x = (t * 30.0).min(30.0);
        let f0 = x.floor() as u32;
        let want = FramePos {
            f0,
            f1: (f0 + 1).min(30),
            alpha: x - f0 as f32,
        };
        assert_eq!(s.frame_pos(t), want, "t {t}");
        let r = reference::frame_pos(t as f64, 30.0, 31, 1.0);
        assert_eq!((r.f0, r.f1), (want.f0, want.f1), "reference t {t}");
        assert!(
            (r.alpha - want.alpha as f64).abs() < 1e-5,
            "reference t {t}"
        );
    }
}

#[test]
fn the_reference_places_the_last_frame_at_the_duration() {
    let at = |t| reference::frame_pos(t, 30.0, 32, 1.01);
    let p = at(1.0);
    assert_eq!((p.f0, p.f1, p.alpha), (30, 31, 0.0));
    let p = at(1.005);
    assert_eq!((p.f0, p.f1), (30, 31));
    assert!((p.alpha - 0.5).abs() < 1e-9);
    let p = at(1.01);
    assert_eq!((p.f0, p.f1, p.alpha), (31, 31, 0.0));
}

#[test]
fn the_compressor_resamples_to_the_same_frame_rule() {
    // Resampled to 20 Hz: ceil(20.2) + 1 = 22 frames, the last at 1.01 s (rounding gave 21 and
    // dropped the tail after 1.0 s).
    let clip = linear_clip(1.01, 30.0);
    let settings = Settings {
        sample_rate: Some(20.0),
        property_error: 1e-4,
        ..Settings::default()
    };
    let out = compress(&clip, None, &settings).unwrap();
    let view = ClipView::parse(&out.bytes).unwrap();
    assert_eq!(view.frame_count(), 22);
    assert_eq!(view.duration(), 1.01);
    let s = ClipSampler::new(view, Form::Compressed).unwrap();
    for (t, want) in [
        (0.5f32, 50.0f32),
        (1.0, 100.0),
        (1.005, 100.5),
        (1.01, 101.0),
    ] {
        assert!(
            (raw_value(&s, t) - want).abs() < 2e-3,
            "compressed at {t}: {}",
            raw_value(&s, t)
        );
    }
}
