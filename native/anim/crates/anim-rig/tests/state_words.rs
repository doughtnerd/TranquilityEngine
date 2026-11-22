//! The solver states' word codecs (T40, for the graph's state blob): a state written mid-run and
//! read back continues exactly as the original, bit for bit, for the spring chain, the damp
//! constraint and the grounder.

mod common;

use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_rig::constraints::{damp, Damp, DampState};
use anim_rig::grounder::{apply, solve, GrounderSettings, GrounderState, RayHit};
use anim_rig::spring::{spring, SpringChainState, SpringSettings};
use anim_rig::two_bone::TwoBone;
use common::*;

fn bits(r: &Rig) -> Vec<u32> {
    r.model
        .iter()
        .flat_map(|t| {
            [
                t.translation.x,
                t.translation.y,
                t.translation.z,
                t.rotation.x,
                t.rotation.y,
                t.rotation.z,
                t.rotation.w,
            ]
        })
        .map(f32::to_bits)
        .collect()
}

fn tail() -> Rig {
    Rig::new(
        vec![u16::MAX, 0, 1, 2],
        &[
            tr(0.0, 1.0, 0.0),
            tr(0.0, -0.1, 0.0),
            tr(0.0, -0.1, 0.0),
            tr(0.0, -0.1, 0.0),
        ],
    )
}

#[test]
fn spring_state_round_trips() {
    let s = SpringSettings::default();
    let mut st = SpringChainState::new();
    let ch = |k: usize| {
        AosTransform::new(
            v3(0.05 * k as f32, 0.0, 0.0),
            AosQuat::identity(),
            AosVec3::one(),
        )
    };
    for k in 0..20 {
        spring(
            &mut tail().pose(),
            &[0, 1, 2, 3],
            &[],
            ch(k),
            &s,
            &mut st,
            1.0 / 60.0,
        );
    }
    let mut words = vec![0u32; SpringChainState::WORDS];
    st.write_words(&mut words);
    let mut copy = SpringChainState::read_words(&words);
    let mut again = vec![0u32; SpringChainState::WORDS];
    copy.write_words(&mut again);
    assert_eq!(words, again);
    for k in 20..40 {
        let (mut a, mut b) = (tail(), tail());
        spring(
            &mut a.pose(),
            &[0, 1, 2, 3],
            &[],
            ch(k),
            &s,
            &mut st,
            1.0 / 60.0,
        );
        spring(
            &mut b.pose(),
            &[0, 1, 2, 3],
            &[],
            ch(k),
            &s,
            &mut copy,
            1.0 / 60.0,
        );
        assert_eq!(bits(&a), bits(&b));
    }
}

#[test]
fn damp_state_round_trips() {
    let d = Damp {
        bone: 3,
        position_half_life: 0.1,
        rotation_half_life: 0.2,
        weight: 1.0,
    };
    let mut st = DampState::new();
    let posed = |k: usize| {
        Rig::new(
            vec![u16::MAX, 0, 1, 2],
            &[
                tr(0.03 * k as f32, 1.0, 0.0),
                trq(0.0, -0.1, 0.0, axis_angle(0.0, 0.0, 1.0, 3.0 * k as f32)),
                tr(0.0, -0.1, 0.0),
                tr(0.0, -0.1, 0.0),
            ],
        )
    };
    for k in 0..10 {
        damp(&mut posed(k).pose(), &d, &mut st, 1.0 / 60.0);
    }
    let mut words = vec![0u32; DampState::WORDS];
    st.write_words(&mut words);
    let mut copy = DampState::read_words(&words);
    for k in 10..30 {
        let (mut a, mut b) = (posed(k), posed(k));
        damp(&mut a.pose(), &d, &mut st, 1.0 / 60.0);
        damp(&mut b.pose(), &d, &mut copy, 1.0 / 60.0);
        assert_eq!(bits(&a), bits(&b));
    }
}

#[test]
fn grounder_state_round_trips() {
    let limbs = [
        TwoBone {
            root: 1,
            mid: 2,
            tip: 3,
        },
        TwoBone {
            root: 4,
            mid: 5,
            tip: 6,
        },
    ];
    let s = GrounderSettings::default();
    let hit = |k: usize, x: f32| RayHit {
        point: v3(x, 0.02 * (k as f32 * 0.3).sin() + 0.1 * x, 0.0),
        normal: v3(-0.1, 1.0, 0.0),
        valid: true,
    };
    let run = |st: &mut GrounderState, k: usize| {
        let mut r = legs();
        let hits = [hit(k, 0.1), hit(k, -0.1)];
        let mut p = r.pose();
        let t = solve(&mut p, &limbs, &hits, &s, st, 1.0 / 60.0);
        apply(&mut p, 0, &limbs, &t, &s);
        drop(p);
        r
    };
    let mut st = GrounderState::new();
    for k in 0..10 {
        run(&mut st, k);
    }
    let mut words = vec![0u32; GrounderState::WORDS];
    st.write_words(&mut words);
    let mut copy = GrounderState::read_words(&words);
    for k in 10..30 {
        assert_eq!(bits(&run(&mut st, k)), bits(&run(&mut copy, k)));
    }
}
