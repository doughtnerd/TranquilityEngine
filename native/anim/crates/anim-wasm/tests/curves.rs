//! T70: engine curves in the core (`curves.rs`, the `tween` family's "Engine curves"): loading
//! and refusing curve assets, a curve as tween and sequence easing, and `curve_sample`. The curve
//! maths itself is `myco-curve`'s, held to `curve.ts` by its parity test; here the curves are
//! chosen so the expected values are exact (binary fractions), plus one Bézier read against the
//! shared evaluator to show the wiring. Times are binary fractions, so frames land exactly.

mod common;

use anim_sample::curve::{eval, parse_keys, KEY_FLOATS, MAX_KEYS};
use anim_wasm::init::Core;
use anim_wire::core::{
    PASS_NORMAL, STATUS_BAD_ASSET, STATUS_OK, STATUS_STALE_HANDLE, STATUS_TOO_LARGE,
    STATUS_WRONG_KIND,
};
use anim_wire::timeline::{SeqCreate, SeqMember, TimelineBlock, FLAG_PLAY, WRAP_ONCE};
use anim_wire::tween::*;
use anim_wire::WireRecord;
use common::core;

const DT: f32 = 0.25;

/// Keys `(x, y, interp, [inDx, inDy, outDx, outDy])` as `load_curve` takes them.
fn floats(keys: &[(f32, f32, u8, [f32; 4])]) -> Vec<f32> {
    keys.iter()
        .flat_map(|&(x, y, i, h)| [x, y, i as f32, h[0], h[1], h[2], h[3]])
        .collect()
}

fn load(core: &mut Core, keys: &[(f32, f32, u8, [f32; 4])]) -> u32 {
    let h = core.load_curve(&floats(keys));
    assert_ne!(h, 0, "refused with status {}", core.last_status());
    h
}

/// Linear keys `(x, y)`.
fn lin(keys: &[(f32, f32)]) -> Vec<(f32, f32, u8, [f32; 4])> {
    keys.iter().map(|&(x, y)| (x, y, 0, [0.0; 4])).collect()
}

fn tween(ease: u32) -> TweenCreate {
    TweenCreate {
        world: 0,
        host_id: 1,
        column: 10,
        value_kind: KIND_VALUE,
        width: 1,
        ease,
        flags: 0,
        time_mode: TIME_SCALED,
        loops: 1,
        duration: 1.0,
        delay: 0.0,
        speed: 1.0,
        from0: 0.0,
        to0: 8.0,
        ..TweenCreate::default()
    }
}

fn frame(core: &mut Core, dt: f32) {
    core.write_inputs(0);
    core.evaluate(0, PASS_NORMAL, dt, dt);
}

/// The first value of the only tween row each frame, for `n` frames.
fn run(core: &mut Core, n: usize) -> Vec<Option<f32>> {
    (0..n)
        .map(|_| {
            frame(core, DT);
            let t = core.tweens();
            (t.rows() > 0).then(|| t.values()[0])
        })
        .collect()
}

fn create(core: &mut Core, c: &TweenCreate) -> u32 {
    let h = core.tween_create(&c.encode());
    assert_ne!(h, 0, "refused with status {}", core.last_status());
    h
}

#[test]
fn the_key_layout_and_limits_are_the_wires() {
    assert_eq!(KEY_FLOATS as u32, CURVE_KEY_FLOATS);
    assert_eq!(MAX_KEYS as u32, MAX_CURVE_KEYS);
}

#[test]
fn malformed_keys_are_refused_with_a_status() {
    let mut core = core(4, 16);
    let one = floats(&lin(&[(0.0, 0.0), (1.0, 1.0)]));
    assert_eq!(core.load_curve(&one[..10]), 0, "not whole keys");
    assert_eq!(core.last_status(), STATUS_BAD_ASSET);
    let mut nan = one.clone();
    nan[1] = f32::NAN;
    assert_eq!(core.load_curve(&nan), 0, "a value that isn't finite");
    assert_eq!(core.last_status(), STATUS_BAD_ASSET);
    let mut handle = one.clone();
    handle[6] = f32::INFINITY;
    assert_eq!(core.load_curve(&handle), 0, "a handle that isn't finite");
    assert_eq!(core.last_status(), STATUS_BAD_ASSET);
    let unsorted = floats(&lin(&[(1.0, 0.0), (0.0, 1.0)]));
    assert_eq!(core.load_curve(&unsorted), 0, "keys out of x order");
    assert_eq!(core.last_status(), STATUS_BAD_ASSET);
    let many = floats(
        &(0..=MAX_KEYS)
            .map(|i| (i as f32, 0.0, 0, [0.0; 4]))
            .collect::<Vec<_>>(),
    );
    assert_eq!(core.load_curve(&many), 0, "more than MAX_CURVE_KEYS keys");
    assert_eq!(core.last_status(), STATUS_TOO_LARGE);
    // Empty, equal x (a jump) and an unknown interp code are fine.
    assert_ne!(core.load_curve(&[]), 0);
    let jump = floats(&[
        (0.0, 0.0, 9, [0.0; 4]),
        (0.5, 1.0, 0, [0.0; 4]),
        (0.5, 2.0, 0, [0.0; 4]),
    ]);
    assert_ne!(core.load_curve(&jump), 0);
}

#[test]
fn a_curve_eases_a_tween_in_the_core() {
    let mut core = core(4, 16);
    // A step to 1 at 0.5: the value holds `from` until halfway, then sits at `to`.
    let step = load(
        &mut core,
        &[
            (0.0, 0.0, 1, [0.0; 4]),
            (0.5, 1.0, 0, [0.0; 4]),
            (1.0, 1.0, 0, [0.0; 4]),
        ],
    );
    create(&mut core, &tween(step));
    assert_eq!(
        run(&mut core, 4),
        [Some(0.0), Some(8.0), Some(8.0), Some(8.0)]
    );
}

#[test]
fn a_curve_may_overshoot_and_end_off_its_target() {
    let mut core = core(4, 16);
    // Up to 2 at the middle, down to 0.5 at the end: the value passes `to` and ends at the
    // curve's last value, as the host's evalCurve mapping did (D114).
    let c = load(&mut core, &lin(&[(0.0, 0.0), (0.5, 2.0), (1.0, 0.5)]));
    let h = create(&mut core, &tween(c));
    assert_eq!(
        run(&mut core, 4),
        [Some(8.0), Some(16.0), Some(10.0), Some(4.0)]
    );
    assert_eq!(core.tweens().change_count(), 1, "completed");
    assert_eq!(
        core.tween_control(
            &TweenControl {
                handle: h,
                op: OP_PAUSE
            }
            .encode()
        ),
        STATUS_STALE_HANDLE
    );
}

#[test]
fn a_yoyo_cycle_runs_back_through_the_curve() {
    let mut core = core(4, 16);
    let c = load(&mut core, &lin(&[(0.0, 0.0), (0.5, 0.25), (1.0, 1.0)]));
    create(
        &mut core,
        &TweenCreate {
            loops: 2,
            flags: FLAG_YOYO,
            ..tween(c)
        },
    );
    // Forward: p 0.25, 0.5, 0.75, 1 → e 0.125, 0.25, 0.625, 1; back: p 0.75, 0.5, 0.25, then 0.
    assert_eq!(
        run(&mut core, 8),
        [
            Some(1.0),
            Some(2.0),
            Some(5.0),
            Some(8.0),
            Some(5.0),
            Some(2.0),
            Some(1.0),
            Some(0.0)
        ]
    );
}

#[test]
fn a_bezier_easing_reads_the_shared_evaluator() {
    let mut core = core(4, 16);
    let keys = [
        (0.0, 0.0, 5, [0.0, 0.0, 0.5, 0.0]),
        (1.0, 1.0, 5, [-0.125, -0.5, 0.0, 0.0]),
    ];
    let c = load(&mut core, &keys);
    create(&mut core, &tween(c));
    let reference = parse_keys(&floats(&keys)).unwrap();
    let seen = run(&mut core, 3);
    for (i, v) in seen.iter().enumerate() {
        let e = eval(&reference[..], (i + 1) as f32 * DT);
        assert_eq!(v.unwrap(), 0.0 * (1.0 - e) + 8.0 * e, "frame {i}");
    }
}

#[test]
fn a_released_curve_eases_linearly() {
    let mut core = core(4, 16);
    let c = load(&mut core, &lin(&[(0.0, 0.0), (0.5, 0.0), (1.0, 1.0)]));
    create(&mut core, &tween(c));
    assert_eq!(run(&mut core, 1), [Some(0.0)]);
    assert_eq!(core.release(c), STATUS_OK);
    assert_eq!(run(&mut core, 1), [Some(4.0)], "linear: p 0.5");
}

#[test]
fn a_handle_that_isnt_a_curve_eases_linearly() {
    let mut core = core(4, 16);
    let mask = core.load_mask(&[1.0, 0.5]);
    assert_ne!(mask, 0);
    create(&mut core, &tween(mask));
    assert_eq!(run(&mut core, 2), [Some(2.0), Some(4.0)]);
}

#[test]
fn a_sequence_member_takes_a_curve_easing() {
    let mut core = core(4, 16);
    let c = load(&mut core, &lin(&[(0.0, 0.0), (0.5, 0.75), (1.0, 1.0)]));
    let member = SeqMember {
        host_id: 7,
        column: 3,
        value_kind: KIND_VALUE,
        width: 1,
        ease: c,
        loops: 1,
        offset: 0.0,
        duration: 1.0,
        from0: 0.0,
        to0: 8.0,
        ..SeqMember::default()
    };
    let mut bytes = SeqCreate {
        world: 0,
        host_id: 1,
        time_mode: 0,
        wrap: WRAP_ONCE,
        flags: FLAG_PLAY,
        speed: 1.0,
        members: 1,
    }
    .encode();
    bytes.extend(member.encode());
    let h = core.timeline_create_sequence(&bytes);
    assert_ne!(h, 0, "refused with status {}", core.last_status());
    let info = core.timelines().info(h).expect("live");
    let mut blocks = vec![0u8; core.timeline_block_bytes(h) as usize];
    assert_eq!(core.timeline_blocks(h, &mut blocks) as usize, blocks.len());
    let block = TimelineBlock::decode(&blocks).unwrap();
    let mut seen = Vec::new();
    for _ in 0..2 {
        frame(&mut core, DT);
        let word = core.timelines().values()[(info.value_offset + block.offset) as usize];
        seen.push(f32::from_bits(word));
    }
    assert_eq!(seen, [3.0, 6.0], "e 0.375 and 0.75 of 8");
}

#[test]
fn curve_sample_writes_frames_clamped_to_the_end() {
    let mut core = core(4, 16);
    let c = load(
        &mut core,
        &[
            (0.0, 0.0, 0, [0.0; 4]),
            (1.0, 4.0, 1, [0.0; 4]),
            (2.0, 8.0, 0, [0.0; 4]),
        ],
    );
    assert_eq!(core.curve_sample(c, 4.0, 1.5, 8), STATUS_OK);
    // x = 0, 0.25 … 1.5 (clamped from 1.75): linear to 4, then the step holds 4.
    assert_eq!(
        core.curve_samples(),
        [0.0, 1.0, 2.0, 3.0, 4.0, 4.0, 4.0, 4.0]
    );
    assert_eq!(core.curve_sample(c, 0.0, 2.0, 3), STATUS_OK);
    assert_eq!(
        core.curve_samples(),
        [0.0, 0.0, 0.0],
        "a rate that isn't positive reads 0"
    );
    assert_eq!(
        core.curve_sample(c, 30.0, 1.0, MAX_CURVE_SAMPLES + 1),
        STATUS_TOO_LARGE
    );
    let mask = core.load_mask(&[1.0]);
    assert_eq!(core.curve_sample(mask, 30.0, 1.0, 2), STATUS_WRONG_KIND);
    assert_eq!(core.release(c), STATUS_OK);
    assert_eq!(core.curve_sample(c, 30.0, 1.0, 2), STATUS_STALE_HANDLE);
}
