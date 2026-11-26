//! The tween table and the curve store through the crate's interface, with no animation core: the
//! standalone module's configuration (`CurveStore` as the curve lookup). The full behaviour suite
//! runs through the animation core (`native/anim/crates/anim-wasm/tests/tweens.rs`, `timeline.rs`,
//! `curves.rs`), which links this crate.

use myco_tween::curves::CurveStore;
use myco_tween::host::{PASS_FIXED, PASS_NORMAL, STATUS_OK, STATUS_STALE_HANDLE};
use myco_tween::seq::{self, Member};
use myco_tween::wire::*;
use myco_tween::{Spec, Tweens};
use myco_wire::WireRecord;

fn create(ease: u32, time_mode: u32) -> Vec<u8> {
    TweenCreate {
        world: 0,
        host_id: 7,
        column: 3,
        value_kind: KIND_VALUE,
        width: 1,
        ease,
        flags: 0,
        time_mode,
        loops: 1,
        duration: 1.0,
        delay: 0.0,
        speed: 1.0,
        to0: 10.0,
        ..Default::default()
    }
    .encode()
}

fn change(t: &Tweens, i: usize) -> TweenChange {
    TweenChange::decode(&t.changes()[i * TweenChange::STRIDE as usize..]).unwrap()
}

#[test]
fn a_tween_runs_to_its_end_and_reports_it() {
    let mut t = Tweens::new(4);
    let h = t.create(&create(EASE_LINEAR, TIME_SCALED)).unwrap();
    assert!(h >= 1 << 16);
    t.begin_frame();
    t.update(&(), 0, PASS_NORMAL, 0.25, 0.0);
    assert_eq!((t.rows(), t.columns()[0], t.values()[0]), (1, 3, 2.5));
    t.begin_frame();
    t.update(&(), 0, PASS_FIXED, 0.25, 0.0); // a scaled tween ignores the fixed pass
    assert_eq!(t.rows(), 0);
    t.begin_frame();
    t.update(&(), 0, PASS_NORMAL, 1.0, 0.0);
    assert_eq!((t.rows(), t.values()[0], t.change_count()), (1, 10.0, 1));
    assert_eq!(change(&t, 0).kind, CHANGE_COMPLETED);
    assert!(t.is_empty());
}

#[test]
fn curve_easing_reads_the_store_and_a_released_curve_is_linear() {
    let mut curves = CurveStore::default();
    // Two step keys (0, 0) and (1, 1): the eased progress is 0 until x reaches 1.
    let c = curves
        .load(&[
            0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ])
        .unwrap();
    assert!(c > EASE_IN_OUT_BOUNCE);
    let mut t = Tweens::new(4);
    t.create(&create(c, TIME_UNSCALED)).unwrap();
    t.begin_frame();
    t.update(&curves, 0, PASS_NORMAL, 0.0, 0.5);
    assert_eq!(t.values()[0], 0.0, "a step curve holds 0 until x = 1");
    assert_eq!(curves.release(c), STATUS_OK);
    assert_eq!(curves.release(c), STATUS_STALE_HANDLE);
    t.begin_frame();
    t.update(&curves, 0, PASS_NORMAL, 0.0, 0.25);
    assert_eq!(t.values()[0], 7.5, "released: linear");
}

#[test]
fn sequence_members_complete_in_end_order() {
    let spec =
        |d: f32| Spec::new(KIND_VALUE, 1, EASE_LINEAR, 0, 1, d, 0.0, [0.0; 4], [1.0; 4]).unwrap();
    let mut members = vec![
        Member::new(spec(2.0), 0.0, 10),
        Member::new(spec(0.5), 1.0, 11),
    ];
    assert_eq!(seq::duration(&members), 2.0);
    let mut order = Vec::with_capacity(members.len());
    let mut seen = Vec::new();
    seq::eval(&(), &mut members, 3.0, true, &mut order, |i, v| {
        seen.push((i, v.map(|v| v[0])))
    });
    assert_eq!(seen, vec![(0, Some(1.0)), (1, Some(1.0))]);
    assert_eq!(order, vec![1, 0], "member 1 ends at 1.5 s, member 0 at 2 s");
}
