//! Determinism: a fixed run of every solver gives the same bits on every target (native and
//! wasm `simd128`, ADR 0370's rules), checked against one FNV-1a hash of the resulting local
//! pose. A change to any solver's arithmetic changes the hash; update it deliberately.

mod common;

use anim_rig::aim::{look_at, AimAxes, AimGoal, AimJoint};
use anim_rig::chain::{ccd, fabrik, ChainGoal};
use anim_rig::full_body::{full_body, BodyChain, CentreOfMass, Effector, FullBodyGoal};
use anim_rig::grounder::{apply, solve, GrounderSettings, GrounderState, RayHit};
use anim_rig::spring::{spring, SpringChainState, SpringSettings};
use anim_rig::two_bone::{two_bone, TwoBone, TwoBoneGoal};
use anim_rig::{ChainJoint, JointLimit};
use common::*;

const SPINE: [u16; 3] = [0, 1, 2];
const NECK: [u16; 3] = [2, 3, 4];
const LARM: [u16; 4] = [2, 5, 6, 7];
const RARM: [u16; 4] = [2, 8, 9, 10];
const LLEG: [u16; 4] = [0, 11, 12, 13];
const RLEG: [u16; 4] = [0, 14, 15, 16];

fn fnv(h: &mut u64, v: f32) {
    for b in v.to_bits().to_le_bytes() {
        *h ^= b as u64;
        *h = h.wrapping_mul(0x100_0000_01b3);
    }
}

#[test]
fn solver_bits_are_the_same_on_every_target() {
    let mut rig = humanoid();
    let mut scratch = vec![ChainJoint::default(); 32];
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
    let limit = JointLimit {
        swing_y: 0.6,
        swing_z: 0.9,
        twist_min: -0.2,
        twist_max: 0.3,
        ..JointLimit::FREE
    };
    let mut gstate = GrounderState::new();
    let mut sstate = SpringChainState::new();
    let hits = [
        RayHit {
            point: v3(0.0, 0.12, 0.0),
            normal: v3(0.2, 1.0, 0.1),
            valid: true,
        },
        RayHit {
            point: v3(0.0, -0.05, 0.0),
            normal: v3(0.0, 1.0, 0.0),
            valid: true,
        },
    ];
    for frame in 0..5 {
        let f = frame as f32;
        let mut p = rig.pose();
        let mut e = [Effector::NONE; 6];
        e[2] = Effector::at(v3(0.5, 1.4 + 0.02 * f, 0.2));
        e[4] = Effector::at(v3(0.1, 0.06, 0.02));
        let fb = FullBodyGoal {
            root: Effector::NONE,
            effectors: &e,
            centre_of_mass: Some(CentreOfMass {
                target: v3(0.03, 1.0, 0.0),
                weight: 0.5,
                masses: &[],
                up: v3(0.0, 1.0, 0.0),
            }),
            body_pull: 0.2,
            iterations: 6,
            tolerance: 0.0,
            weight: 0.9,
        };
        full_body(&mut p, 0, &chains, &fb, &mut scratch);
        two_bone(
            &mut p,
            TwoBone {
                root: 8,
                mid: 9,
                tip: 10,
            },
            &TwoBoneGoal {
                soft: 0.1,
                ..TwoBoneGoal::new(v3(-0.4, 1.2, 0.3))
            },
        );
        ccd(
            &mut p,
            &LARM[1..],
            &[limit; 3],
            &ChainGoal::new(v3(0.4, 1.1, 0.4)),
            &mut scratch,
        );
        fabrik(
            &mut p,
            &RARM[1..],
            &[limit; 3],
            &ChainGoal::new(v3(-0.4, 1.1, 0.4)),
            &mut scratch,
        );
        let aj = [
            AimJoint {
                bone: 1,
                weight: 0.3,
                limit: 0.8,
                axes: AimAxes::default(),
            },
            AimJoint {
                bone: 4,
                weight: 1.0,
                limit: 1.2,
                axes: AimAxes::default(),
            },
        ];
        look_at(
            &mut p,
            &aj,
            &AimGoal {
                up: v3(0.0, 1.0, 0.0),
                up_weight: 0.5,
                ..AimGoal::new(v3(1.0, 1.7, 2.0))
            },
            &mut scratch,
        );
        let gs = GrounderSettings::default();
        let t = solve(&mut p, &legs, &hits, &gs, &mut gstate, 1.0 / 60.0);
        apply(&mut p, 0, &legs, &t, &gs);
        spring(
            &mut p,
            &NECK,
            &[],
            tr(0.03 * f, 0.0, 0.0),
            &SpringSettings::default(),
            &mut sstate,
            1.0 / 45.0,
        );
    }
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for t in rig.locals() {
        for v in [
            t.translation.x,
            t.translation.y,
            t.translation.z,
            t.rotation.x,
            t.rotation.y,
            t.rotation.z,
            t.rotation.w,
        ] {
            fnv(&mut h, v);
        }
    }
    assert_eq!(h, GOLDEN, "solver bits changed: {h:#018x}");
}

const GOLDEN: u64 = 0x483d_d377_1e9a_b155;
