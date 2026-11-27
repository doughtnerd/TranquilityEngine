//! The tween table through the core's calls and views (`anim-wire` family `tween`): values over
//! time, easings by id, delay, loops and yoyo, relative and quaternion tweens, pause, kill and
//! destroyed records, time modes, Worlds, capacity and determinism. Times are binary fractions
//! (exact in f32 and f64), so counts and end values compare exactly.

mod common;

use anim_wasm::init::Core;
use anim_wire::core::{
    PASS_FIXED, PASS_NORMAL, STATUS_BAD_RECORD, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE,
};
use anim_wire::tween::*;
use anim_wire::WireRecord;
use common::core;
use myco_tween::ease::ease;

const DT: f32 = 0.25;

fn spec() -> TweenCreate {
    TweenCreate {
        world: 0,
        host_id: 1,
        column: 10,
        value_kind: KIND_VALUE,
        width: 1,
        ease: EASE_LINEAR,
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

fn create(core: &mut Core, c: &TweenCreate) -> u32 {
    let h = core.tween_create(&c.encode());
    assert_ne!(h, 0, "refused with status {}", core.last_status());
    h
}

fn control(core: &mut Core, handle: u32, op: u32) -> u32 {
    core.tween_control(&TweenControl { handle, op }.encode())
}

/// One frame: `write_inputs(0)` then the normal pass.
fn frame(core: &mut Core, dt: f32) {
    core.write_inputs(0);
    core.evaluate(0, PASS_NORMAL, dt, dt);
}

fn rows(core: &Core) -> Vec<(u32, [f32; 4])> {
    let t = core.tweens();
    (0..t.rows())
        .map(|i| {
            let v = &t.values()[i * 4..i * 4 + 4];
            (t.columns()[i], [v[0], v[1], v[2], v[3]])
        })
        .collect()
}

fn changes(core: &Core) -> Vec<TweenChange> {
    let t = core.tweens();
    let stride = TweenChange::STRIDE as usize;
    (0..t.change_count())
        .map(|i| TweenChange::decode(&t.changes()[i * stride..]).unwrap())
        .collect()
}

/// The first value of the only row each frame, for `n` frames.
fn run(core: &mut Core, n: usize) -> Vec<Option<f32>> {
    (0..n)
        .map(|_| {
            frame(core, DT);
            rows(core).first().map(|r| r.1[0])
        })
        .collect()
}

#[test]
fn a_linear_tween_runs_and_completes_with_its_exact_end_value() {
    let mut core = core(4, 16);
    let h = create(&mut core, &spec());
    let seen = run(&mut core, 4);
    assert_eq!(seen, [Some(2.0), Some(4.0), Some(6.0), Some(8.0)]);
    let ch = changes(&core);
    assert_eq!(ch.len(), 1, "completed on the frame it reached its end");
    assert_eq!(ch[0].kind, CHANGE_COMPLETED);
    assert_eq!((ch[0].host_id, ch[0].handle, ch[0].cycle), (1, h, 1));
    // Gone afterwards.
    frame(&mut core, DT);
    assert!(rows(&core).is_empty() && changes(&core).is_empty());
    assert_eq!(control(&mut core, h, OP_PAUSE), STATUS_STALE_HANDLE);
}

#[test]
fn rows_carry_the_host_column_and_width() {
    let mut core = core(4, 16);
    create(
        &mut core,
        &TweenCreate {
            column: 77,
            width: 3,
            from0: 1.0,
            from1: 2.0,
            from2: 3.0,
            to0: 5.0,
            to1: 2.0,
            to2: -1.0,
            to3: 99.0,
            ..spec()
        },
    );
    frame(&mut core, 0.5);
    assert_eq!(
        rows(&core),
        vec![(77, [3.0, 2.0, 1.0, 0.0])],
        "components past the width are 0"
    );
}

#[test]
fn easings_are_applied_by_id() {
    for id in [
        EASE_IN_QUAD,
        EASE_OUT_CUBIC,
        EASE_IN_OUT_SINE,
        EASE_OUT_BOUNCE,
        EASE_IN_OUT_ELASTIC,
    ] {
        let mut core = core(4, 16);
        create(
            &mut core,
            &TweenCreate {
                ease: id,
                to0: 1.0,
                ..spec()
            },
        );
        frame(&mut core, 0.25);
        let got = rows(&core)[0].1[0];
        assert_eq!(got, ease(id, 0.25), "id {id}");
    }
    // Spot values that pin the id order: out cubic, in quad, in-out quad.
    assert_eq!(ease(EASE_OUT_CUBIC, 0.5), 0.875);
    assert_eq!(ease(EASE_IN_QUAD, 0.5), 0.25);
    assert_eq!(ease(EASE_IN_OUT_QUAD, 0.25), 0.125);
    assert_eq!(EASE_NAMES.len(), 31);
    assert_eq!(EASE_NAMES[EASE_OUT_BACK as usize], "out_back");
    assert_eq!(EASE_NAMES[EASE_IN_OUT_BOUNCE as usize], "in_out_bounce");
}

#[test]
fn a_delay_holds_back_the_first_row() {
    let mut core = core(4, 16);
    create(
        &mut core,
        &TweenCreate {
            delay: 0.5,
            ..spec()
        },
    );
    let seen = run(&mut core, 7);
    assert_eq!(
        seen,
        [None, Some(0.0), Some(2.0), Some(4.0), Some(6.0), Some(8.0), None],
        "no row during the delay; the first row after it is `from` (delay elapsed, none of the cycle)"
    );
}

#[test]
fn loops_restart_and_report_each_cycle_then_complete() {
    let mut core = core(4, 16);
    create(
        &mut core,
        &TweenCreate {
            loops: 3,
            duration: 0.5,
            ..spec()
        },
    );
    let mut log = Vec::new();
    for _ in 0..6 {
        frame(&mut core, DT);
        log.push((
            rows(&core).first().map(|r| r.1[0]),
            changes(&core)
                .iter()
                .map(|c| (c.kind, c.cycle))
                .collect::<Vec<_>>(),
        ));
    }
    assert_eq!(
        log,
        vec![
            (Some(4.0), vec![]),
            (Some(0.0), vec![(CHANGE_LOOP, 1)]),
            (Some(4.0), vec![]),
            (Some(0.0), vec![(CHANGE_LOOP, 2)]),
            (Some(4.0), vec![]),
            (Some(8.0), vec![(CHANGE_COMPLETED, 3)]),
        ]
    );
}

#[test]
fn yoyo_runs_odd_cycles_backwards_and_ends_on_from_after_two() {
    // Up to 8 at t = 1, then back down, ending exactly on `from`.
    let mut core = core_with(&TweenCreate {
        loops: 2,
        flags: FLAG_YOYO,
        ..spec()
    });
    let v = run(&mut core, 8);
    assert_eq!(
        v,
        [
            Some(2.0),
            Some(4.0),
            Some(6.0),
            Some(8.0),
            Some(6.0),
            Some(4.0),
            Some(2.0),
            Some(0.0)
        ]
    );
    assert_eq!(
        changes(&core).iter().map(|c| c.kind).collect::<Vec<_>>(),
        [CHANGE_COMPLETED]
    );
}

fn core_with(c: &TweenCreate) -> Core {
    let mut core = core(4, 16);
    create(&mut core, c);
    core
}

#[test]
fn yoyo_with_an_easing_mirrors_through_the_same_curve() {
    let mut core = core_with(&TweenCreate {
        loops: 2,
        flags: FLAG_YOYO,
        ease: EASE_IN_QUAD,
        to0: 1.0,
        ..spec()
    });
    let v = run(&mut core, 8);
    let want: Vec<Option<f32>> = [0.25f32, 0.5, 0.75, 1.0, 0.75, 0.5, 0.25, 0.0]
        .iter()
        .map(|p| Some(ease(EASE_IN_QUAD, *p)))
        .collect();
    assert_eq!(v, want);
}

#[test]
fn infinite_loops_never_complete() {
    let mut core = core_with(&TweenCreate {
        loops: LOOPS_INFINITE,
        ..spec()
    });
    for _ in 0..400 {
        frame(&mut core, DT);
        assert_eq!(rows(&core).len(), 1);
        assert!(changes(&core).iter().all(|c| c.kind == CHANGE_LOOP));
    }
    assert_eq!(core.tweens().len(), 1);
}

#[test]
fn zero_duration_jumps_to_the_end_and_completes() {
    let mut core = core_with(&TweenCreate {
        duration: 0.0,
        delay: 0.25,
        ..spec()
    });
    frame(&mut core, 0.125);
    assert!(rows(&core).is_empty());
    frame(&mut core, 0.125);
    assert_eq!(rows(&core)[0].1[0], 8.0);
    assert_eq!(changes(&core)[0].kind, CHANGE_COMPLETED);
}

#[test]
fn relative_tweens_add_to_from_and_multiply_quaternions() {
    let mut core = core(4, 16);
    create(
        &mut core,
        &TweenCreate {
            flags: FLAG_RELATIVE,
            width: 2,
            from0: 1.0,
            from1: 5.0,
            to0: 2.0,
            to1: -1.0,
            ..spec()
        },
    );
    // A quarter turn about y by a quarter turn about y is a half turn.
    let s = std::f32::consts::FRAC_1_SQRT_2;
    create(
        &mut core,
        &TweenCreate {
            column: 2,
            flags: FLAG_RELATIVE,
            value_kind: KIND_QUAT_SLERP,
            width: 4,
            from1: s,
            from3: s,
            to0: 0.0,
            to1: s,
            to3: s,
            ..spec()
        },
    );
    for _ in 0..4 {
        frame(&mut core, DT);
    }
    // The last frame wrote the end values (the rows of the completing frame).
    let r = rows(&core);
    assert_eq!(r[0], (10, [3.0, 4.0, 0.0, 0.0]));
    let q = r[1].1;
    assert!(
        (q[1].abs() - 1.0).abs() < 1e-5 && q[3].abs() < 1e-5 && q[0] == 0.0 && q[2] == 0.0,
        "{q:?}"
    );
}

fn quat_y(angle: f32) -> [f32; 4] {
    let h = angle * 0.5;
    [0.0, h.sin(), 0.0, h.cos()]
}

#[test]
fn quaternion_tweens_slerp_and_nlerp_between_exact_endpoints() {
    for kind in [KIND_QUAT_SLERP, KIND_QUAT_NLERP] {
        let to = quat_y(std::f32::consts::FRAC_PI_2);
        let mut core = core_with(&TweenCreate {
            value_kind: kind,
            width: 4,
            from3: 1.0,
            to0: to[0],
            to1: to[1],
            to2: to[2],
            to3: to[3],
            duration: 2.0,
            ..spec()
        });
        frame(&mut core, 1.0);
        let q = rows(&core)[0].1;
        let want = quat_y(std::f32::consts::FRAC_PI_4);
        for i in 0..4 {
            assert!(
                (q[i] - want[i]).abs() < 1e-5,
                "kind {kind} component {i}: {q:?} vs {want:?}"
            );
        }
        frame(&mut core, 1.0);
        let end = rows(&core)[0].1;
        for i in 0..4 {
            assert!(
                (end[i] - to[i]).abs() < 1e-6,
                "the end value is `to`: {end:?}"
            );
        }
    }
}

#[test]
fn pause_and_resume_hold_the_clock() {
    let mut core = core(4, 16);
    let h = create(&mut core, &spec());
    frame(&mut core, DT);
    assert_eq!(control(&mut core, h, OP_PAUSE), STATUS_OK);
    for _ in 0..5 {
        frame(&mut core, DT);
        assert!(rows(&core).is_empty());
    }
    assert_eq!(control(&mut core, h, OP_RESUME), STATUS_OK);
    frame(&mut core, DT);
    assert_eq!(rows(&core)[0].1[0], 4.0);
}

#[test]
fn kill_stops_output_at_once_and_reports_next_frame() {
    let mut core = core(4, 16);
    let h = create(
        &mut core,
        &TweenCreate {
            host_id: 42,
            ..spec()
        },
    );
    frame(&mut core, DT);
    assert_eq!(control(&mut core, h, OP_KILL), STATUS_OK);
    assert_eq!(
        control(&mut core, h, OP_KILL),
        STATUS_STALE_HANDLE,
        "already dying"
    );
    frame(&mut core, DT);
    assert!(
        rows(&core).is_empty(),
        "a killed tween outputs nothing more"
    );
    let ch = changes(&core);
    assert_eq!(ch.len(), 1);
    assert_eq!(
        (ch[0].kind, ch[0].host_id, ch[0].handle),
        (CHANGE_KILLED, 42, h)
    );
    assert_eq!(core.tweens().len(), 0);
}

#[test]
fn a_destroyed_target_stops_the_tween_with_the_destroyed_reason() {
    let mut core = core(4, 16);
    let a = create(
        &mut core,
        &TweenCreate {
            host_id: 5,
            column: 1,
            ..spec()
        },
    );
    let b = create(
        &mut core,
        &TweenCreate {
            host_id: 6,
            column: 2,
            ..spec()
        },
    );
    frame(&mut core, DT);
    assert_eq!(control(&mut core, a, OP_DESTROYED), STATUS_OK);
    frame(&mut core, DT);
    let ch = changes(&core);
    assert_eq!(ch.len(), 1);
    assert_eq!(
        (ch[0].kind, ch[0].host_id),
        (CHANGE_DESTROYED, 5),
        "its promise resolves destroyed"
    );
    assert_eq!(
        rows(&core),
        vec![(2, [4.0, 0.0, 0.0, 0.0])],
        "the other tween is untouched"
    );
    assert_eq!(control(&mut core, a, OP_RESUME), STATUS_STALE_HANDLE);
    let _ = b;
}

#[test]
fn a_paused_tween_can_be_destroyed_and_killed() {
    let mut core = core(4, 16);
    let a = create(
        &mut core,
        &TweenCreate {
            host_id: 5,
            ..spec()
        },
    );
    let b = create(
        &mut core,
        &TweenCreate {
            host_id: 6,
            ..spec()
        },
    );
    control(&mut core, a, OP_PAUSE);
    control(&mut core, b, OP_PAUSE);
    control(&mut core, a, OP_DESTROYED);
    control(&mut core, b, OP_KILL);
    frame(&mut core, DT);
    let kinds: Vec<_> = changes(&core).iter().map(|c| (c.host_id, c.kind)).collect();
    assert_eq!(kinds, [(5, CHANGE_DESTROYED), (6, CHANGE_KILLED)]);
}

#[test]
fn time_modes_pick_their_clock_and_pass() {
    let mut core = core(8, 16);
    create(
        &mut core,
        &TweenCreate {
            column: 1,
            time_mode: TIME_SCALED,
            ..spec()
        },
    );
    create(
        &mut core,
        &TweenCreate {
            column: 2,
            time_mode: TIME_UNSCALED,
            ..spec()
        },
    );
    create(
        &mut core,
        &TweenCreate {
            column: 3,
            time_mode: TIME_FIXED,
            ..spec()
        },
    );
    // Scaled time stands still (time scale 0); unscaled runs; the fixed pass uses its own step.
    core.write_inputs(0);
    core.evaluate(0, PASS_NORMAL, 0.0, 0.5);
    assert_eq!(rows(&core), vec![(1, [0.0; 4]), (2, [4.0, 0.0, 0.0, 0.0])]);
    core.evaluate(0, PASS_FIXED, 0.25, 0.0);
    assert_eq!(
        rows(&core).last().copied(),
        Some((3, [2.0, 0.0, 0.0, 0.0])),
        "the fixed pass appends"
    );
    // The next frame's write_inputs clears.
    core.write_inputs(0);
    assert!(rows(&core).is_empty());
}

#[test]
fn tweens_run_only_in_their_world() {
    let mut core = core(4, 16);
    create(&mut core, &TweenCreate { world: 1, ..spec() });
    core.write_inputs(0);
    core.evaluate(0, PASS_NORMAL, 0.5, 0.5);
    assert!(rows(&core).is_empty());
    core.evaluate(1, PASS_NORMAL, 0.5, 0.5);
    assert_eq!(rows(&core)[0].1[0], 4.0);
}

#[test]
fn the_speed_scales_one_tweens_time() {
    let mut core = core_with(&TweenCreate {
        speed: 2.0,
        ..spec()
    });
    frame(&mut core, 0.25);
    assert_eq!(rows(&core)[0].1[0], 4.0);
}

#[test]
fn bad_records_and_a_full_table_are_refused() {
    let mut core = core(4, 16);
    assert_eq!(core.tween_create(&[1, 2, 3]), 0);
    assert_eq!(core.last_status(), STATUS_BAD_RECORD);
    assert_eq!(
        core.tween_create(&TweenCreate { width: 0, ..spec() }.encode()),
        0
    );
    assert_eq!(core.last_status(), STATUS_BAD_RECORD);
    assert_eq!(
        core.tween_create(&TweenCreate { width: 5, ..spec() }.encode()),
        0
    );
    assert_eq!(
        core.tween_create(
            &TweenCreate {
                value_kind: 9,
                ..spec()
            }
            .encode()
        ),
        0
    );
    assert_eq!(core.tweens_configure(2), STATUS_OK);
    create(&mut core, &spec());
    create(&mut core, &spec());
    assert_eq!(core.tween_create(&spec().encode()), 0);
    assert_eq!(core.last_status(), STATUS_FULL);
    // A finished tween frees its slot; the new handle differs (generation).
    let first = {
        frame(&mut core, 2.0);
        create(&mut core, &spec())
    };
    assert_eq!(first >> 16, 2, "the slot's generation moved on");
}

#[test]
fn non_finite_input_reads_as_zero() {
    let mut core = core_with(&TweenCreate {
        from0: f32::NAN,
        to0: f32::INFINITY,
        duration: f32::NAN,
        ..spec()
    });
    frame(&mut core, DT);
    assert_eq!(rows(&core)[0].1[0], 0.0);
    frame(&mut core, f32::NAN);
}

#[test]
fn the_same_input_gives_the_same_bits() {
    let run = || {
        let mut core = core(4, 16);
        for (i, id) in [
            EASE_IN_OUT_ELASTIC,
            EASE_OUT_BOUNCE,
            EASE_IN_EXPO,
            EASE_OUT_BACK,
        ]
        .iter()
        .enumerate()
        {
            create(
                &mut core,
                &TweenCreate {
                    column: i as u32,
                    ease: *id,
                    loops: 2,
                    flags: FLAG_YOYO,
                    duration: 0.7,
                    from0: 1.0,
                    to0: -3.0,
                    ..spec()
                },
            );
        }
        let mut bits = Vec::new();
        for _ in 0..12 {
            frame(&mut core, 0.0625 + 0.01);
            bits.extend(rows(&core).iter().map(|r| r.1[0].to_bits()));
        }
        bits
    };
    assert_eq!(run(), run());
}

#[test]
fn many_tweens_complete_in_slot_order() {
    let mut core = core(4, 16);
    let hs: Vec<u32> = (0..5)
        .map(|i| {
            create(
                &mut core,
                &TweenCreate {
                    host_id: i,
                    ..spec()
                },
            )
        })
        .collect();
    frame(&mut core, 2.0);
    let ids: Vec<u32> = changes(&core).iter().map(|c| c.host_id).collect();
    assert_eq!(ids, [0, 1, 2, 3, 4]);
    assert_eq!(
        changes(&core).iter().map(|c| c.handle).collect::<Vec<_>>(),
        hs
    );
}
