//! Rough native solve timings, printed (not asserted: budgets are `anim-bench`'s job, T82r).
//! Run with `cargo test --release -p anim-rig --test timings -- --ignored --nocapture`.

#![cfg(not(target_arch = "wasm32"))]

mod common;

use anim_rig::aim::{look_at, AimAxes, AimGoal, AimJoint};
use anim_rig::chain::{ccd, fabrik, ChainGoal};
use anim_rig::full_body::{full_body, BodyChain, Effector, FullBodyGoal};
use anim_rig::grounder::{apply, solve, GrounderSettings, GrounderState, RayHit};
use anim_rig::spring::{spring, SpringChainState, SpringSettings};
use anim_rig::two_bone::{two_bone, TwoBone, TwoBoneGoal};
use anim_rig::ChainJoint;
use common::*;
use std::hint::black_box;
use std::time::Instant;

fn time(name: &str, n: u32, mut f: impl FnMut(u32)) {
    for i in 0..n / 10 {
        f(i);
    }
    let t = Instant::now();
    for i in 0..n {
        f(i);
    }
    let ns = t.elapsed().as_nanos() as f64 / n as f64;
    eprintln!("{name:<44} {:>9.0} ns", ns);
}

#[test]
#[ignore]
fn solve_timings() {
    let base = humanoid();
    let mut scratch = vec![ChainJoint::default(); 32];
    let legs = [
        TwoBone {
            root: 11,
            mid: 12,
            tip: 13,
        },
        TwoBone {
            root: 14,
            mid: 15,
            tip: 16,
        },
    ];
    let wobble = |i: u32| 0.05 * ((i % 17) as f32 / 17.0);
    time("two_bone (one leg, 17-bone pose)", 200_000, |i| {
        let mut rig = base.clone_rig();
        let t = base.pos(13) + v3(0.0, 0.1 + wobble(i), 0.05);
        two_bone(&mut rig.pose(), legs[0], &TwoBoneGoal::new(t));
        black_box(&rig.model);
    });
    time("ccd (4 bones, 16 iterations max)", 100_000, |i| {
        let mut rig = base.clone_rig();
        let mut g = ChainGoal::new(v3(0.5, 1.2 + wobble(i), 0.3));
        g.tolerance = 1e-4;
        ccd(&mut rig.pose(), &[2, 5, 6, 7], &[], &g, &mut scratch);
        black_box(&rig.model);
    });
    time("fabrik (4 bones, 16 iterations max)", 100_000, |i| {
        let mut rig = base.clone_rig();
        let mut g = ChainGoal::new(v3(0.5, 1.2 + wobble(i), 0.3));
        g.tolerance = 1e-4;
        fabrik(&mut rig.pose(), &[2, 5, 6, 7], &[], &g, &mut scratch);
        black_box(&rig.model);
    });
    let aj = [
        AimJoint {
            bone: 1,
            weight: 0.3,
            limit: 3.2,
            axes: AimAxes::default(),
        },
        AimJoint {
            bone: 2,
            weight: 0.5,
            limit: 3.2,
            axes: AimAxes::default(),
        },
        AimJoint {
            bone: 4,
            weight: 1.0,
            limit: 3.2,
            axes: AimAxes::default(),
        },
    ];
    time("look_at (spine, chest, head)", 200_000, |i| {
        let mut rig = base.clone_rig();
        look_at(
            &mut rig.pose(),
            &aj,
            &AimGoal::new(v3(1.0, 1.6 + wobble(i), 2.0)),
            &mut scratch,
        );
        black_box(&rig.model);
    });
    const SPINE: [u16; 3] = [0, 1, 2];
    const NECK: [u16; 3] = [2, 3, 4];
    const LARM: [u16; 4] = [2, 5, 6, 7];
    const RARM: [u16; 4] = [2, 8, 9, 10];
    const LLEG: [u16; 4] = [0, 11, 12, 13];
    const RLEG: [u16; 4] = [0, 14, 15, 16];
    let chains = [
        BodyChain {
            bones: &SPINE,
            parent: None,
        },
        BodyChain {
            bones: &NECK,
            parent: Some(0),
        },
        BodyChain {
            bones: &LARM,
            parent: Some(0),
        },
        BodyChain {
            bones: &RARM,
            parent: Some(0),
        },
        BodyChain {
            bones: &LLEG,
            parent: None,
        },
        BodyChain {
            bones: &RLEG,
            parent: None,
        },
    ];
    time(
        "full_body (6 chains, 2 hands + 2 feet, 8 it)",
        20_000,
        |i| {
            let mut rig = base.clone_rig();
            let mut e = [Effector::NONE; 6];
            e[2] = Effector::at(base.pos(7) + v3(0.0, 0.1 + wobble(i), 0.1));
            e[3] = Effector::at(base.pos(10) + v3(0.0, 0.1, 0.1));
            e[4] = Effector::at(base.pos(13));
            e[5] = Effector::at(base.pos(16));
            let g = FullBodyGoal {
                root: Effector::NONE,
                effectors: &e,
                centre_of_mass: None,
                body_pull: 0.0,
                iterations: 8,
                tolerance: 0.0,
                weight: 1.0,
            };
            full_body(&mut rig.pose(), 0, &chains, &g, &mut scratch);
            black_box(&rig.model);
        },
    );
    let gs = GrounderSettings::default();
    let mut st = GrounderState::new();
    let hits = [RayHit {
        point: v3(0.0, 0.1, 0.0),
        normal: v3(0.1, 1.0, 0.0),
        valid: true,
    }; 2];
    time("grounder solve + apply (2 legs)", 100_000, |_| {
        let mut rig = base.clone_rig();
        let mut p = rig.pose();
        let t = solve(&mut p, &legs, &hits, &gs, &mut st, 1.0 / 60.0);
        apply(&mut p, 0, &legs, &t, &gs);
        drop(p);
        black_box(&rig.model);
    });
    let ss = SpringSettings::default();
    let mut sst = SpringChainState::new();
    time("spring (3 bones, 1/60 s = 2 substeps)", 100_000, |i| {
        let mut rig = base.clone_rig();
        spring(
            &mut rig.pose(),
            &NECK,
            &[],
            tr(wobble(i), 0.0, 0.0),
            &ss,
            &mut sst,
            1.0 / 60.0,
        );
        black_box(&rig.model);
    });
    time("baseline: clone the 17-bone pose", 200_000, |_| {
        let rig = base.clone_rig();
        black_box(&rig.model);
    });
}
