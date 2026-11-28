//! `anim_format::frames`: the frame rule every writer and reader shares (ADR 0451).

use anim_format::frames::{frame_count, frame_time, FrameClock, FramePos};

#[test]
fn frame_count_is_ceil_plus_one() {
    assert_eq!(frame_count(1.0, 30.0), 31);
    assert_eq!(frame_count(1.01, 30.0), 32);
    assert_eq!(frame_count(0.8, 30.0), 25);
    // An f32 duration that is a whole number of frames up to float noise.
    assert_eq!(frame_count(0.1f32 as f64, 30.0), 4);
    assert_eq!(frame_count(0.0, 30.0), 1);
    assert_eq!(frame_count(1.0, 0.0), 1);
    assert_eq!(frame_count(f64::NAN, 30.0), 1);
    assert_eq!(frame_time(31, 30.0, 1.01), 1.01);
    assert_eq!(frame_time(15, 30.0, 1.01), 0.5);
}

#[test]
fn the_last_segment_ends_at_the_duration() {
    let c = FrameClock::new(1.01, 30.0, 32);
    let p = c.pos(1.005);
    assert_eq!((p.f0, p.f1), (30, 31));
    assert!((p.alpha - 0.5).abs() < 1e-3);
    let end = FramePos {
        f0: 31,
        f1: 31,
        alpha: 0.0,
    };
    assert_eq!(c.pos(1.01), end);
    assert_eq!(c.pos(9.0), end);
    assert!((c.end_time() - 1.01).abs() < 1e-6);
    // `time` inverts `pos`, inside the last segment too.
    for t in [0.0f32, 0.3, 0.999, 1.0, 1.004, 1.009] {
        let p = c.pos(t);
        assert!((c.time(p.f0 as f32 + p.alpha) - t).abs() < 1e-5, "t {t}");
    }
    let start = FramePos {
        f0: 0,
        f1: 1,
        alpha: 0.0,
    };
    assert_eq!(c.pos(-1.0), start);
    assert_eq!(c.pos(f32::NAN), start);
}

#[test]
fn uniform_grids_and_short_counts_are_unchanged() {
    // A whole number of frames, a uniform clock, and a count rounded down (31 frames for 1.01 s:
    // the grid ends at 1.0 s and holds from there).
    for c in [
        FrameClock::new(1.0, 30.0, 31),
        FrameClock::uniform(30.0, 31),
        FrameClock::new(1.01, 30.0, 31),
    ] {
        let p = c.pos(0.5);
        assert_eq!((p.f0, p.f1, p.alpha), (15, 16, 0.0));
        let p = c.pos(0.99);
        assert_eq!((p.f0, p.f1), (29, 30));
        assert!((p.alpha - 0.7).abs() < 1e-4);
        let end = FramePos {
            f0: 30,
            f1: 30,
            alpha: 0.0,
        };
        assert_eq!(c.pos(1.0), end);
        assert_eq!(c.end_time(), 1.0);
    }
    let one = FrameClock::new(0.0, 30.0, 1);
    let held = FramePos {
        f0: 0,
        f1: 0,
        alpha: 0.0,
    };
    assert_eq!(one.pos(0.5), held);
    assert_eq!(one.end_time(), 0.0);
}
