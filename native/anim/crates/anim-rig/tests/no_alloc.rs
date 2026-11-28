//! No solve function allocates: a counting global allocator sees no allocation while every
//! solver runs (after the fixtures, scratch and state are set up).

mod common;

use anim_format::frames::FrameClock;
use anim_math::AosTransform;
use anim_rig::aim::{aim, look_at, AimAxes, AimGoal, AimJoint};
use anim_rig::chain::{ccd, fabrik, ChainGoal};
use anim_rig::constraints::{
    copy, damp, limit_position, limit_rotation, CopyTransform, Damp, DampState, PositionLimit,
    Space,
};
use anim_rig::full_body::{full_body, BodyChain, CentreOfMass, Effector, FullBodyGoal};
use anim_rig::grounder::{
    apply, ray_requests, solve, GrounderSettings, GrounderState, RayHit, RayRequest,
};
use anim_rig::spring::{spring, ColliderShape, SpringChainState, SpringCollider, SpringSettings};
use anim_rig::two_bone::{two_bone, Pole, TipRotation, TwoBone, TwoBoneGoal};
use anim_rig::warp::{
    motion_warp_delta, orientation_warp, stride_warp, DistanceCurve, MotionWarp, OrientationWarp,
    RootCurve, StrideWarp,
};
use anim_rig::{ChainJoint, JointLimit};
use common::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::SeqCst);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const SPINE: [u16; 3] = [0, 1, 2];
const NECK: [u16; 3] = [2, 3, 4];
const LARM: [u16; 4] = [2, 5, 6, 7];
const RARM: [u16; 4] = [2, 8, 9, 10];
const LLEG: [u16; 4] = [0, 11, 12, 13];
const RLEG: [u16; 4] = [0, 14, 15, 16];

#[test]
fn solvers_do_not_allocate() {
    // Setup (allocates).
    let mut body = humanoid();
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
    let mut effectors = [Effector::NONE; 6];
    effectors[2] = Effector::at(body.pos(7) + v3(0.0, 0.1, 0.1));
    effectors[4] = Effector::at(body.pos(13));
    effectors[5] = Effector::at(body.pos(16));
    let limits = [
        JointLimit::FREE,
        JointLimit {
            swing_y: 0.5,
            ..JointLimit::FREE
        },
        JointLimit::FREE,
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
    let hits = [
        RayHit {
            point: v3(0.0, 0.1, 0.0),
            normal: v3(0.1, 1.0, 0.0),
            valid: true,
        },
        RayHit::MISS,
    ];
    let mut requests = [RayRequest {
        origin: v3(0.0, 0.0, 0.0),
        direction: v3(0.0, -1.0, 0.0),
        length: 0.0,
    }; 2];
    let gs = GrounderSettings::default();
    let mut gstate = GrounderState::new();
    let ss = SpringSettings::default();
    let mut sstate = SpringChainState::new();
    let colliders = [
        SpringCollider {
            bone: 2,
            shape: ColliderShape::Sphere {
                center: v3(0.0, 0.1, 0.1),
                radius: 0.1,
            },
        },
        SpringCollider {
            bone: 0,
            shape: ColliderShape::Capsule {
                a: v3(0.0, 0.0, 0.0),
                b: v3(0.0, -0.4, 0.0),
                radius: 0.05,
            },
        },
    ];
    let mut dstate = DampState::new();
    let roots: Vec<AosTransform> = (0..30).map(|i| tr(0.0, 0.0, i as f32 * 0.05)).collect();
    let distance: Vec<f32> = (0..30).map(|i| i as f32 * 0.05).collect();
    let spine = [1u16, 2];
    let aim_joints = [
        AimJoint {
            bone: 1,
            weight: 0.3,
            limit: 1.0,
            axes: AimAxes::default(),
        },
        AimJoint {
            bone: 2,
            weight: 0.5,
            limit: 1.0,
            axes: AimAxes::default(),
        },
        AimJoint {
            bone: 4,
            weight: 1.0,
            limit: 1.0,
            axes: AimAxes::default(),
        },
    ];

    ALLOCS.store(0, Ordering::SeqCst);
    for frame in 0..3 {
        let mut p = body.pose();
        let mut g = TwoBoneGoal::new(v3(0.6, 1.3, 0.3));
        g.pole = Pole::Position(v3(0.5, 1.4, -1.0));
        g.tip_rotation = TipRotation::Maintain;
        g.soft = 0.05;
        g.max_stretch = 1.1;
        two_bone(
            &mut p,
            TwoBone {
                root: 5,
                mid: 6,
                tip: 7,
            },
            &g,
        );
        ccd(
            &mut p,
            &LARM[1..],
            &limits,
            &ChainGoal::new(v3(0.5, 1.2, 0.2)),
            &mut scratch,
        );
        fabrik(
            &mut p,
            &RARM[1..],
            &limits,
            &ChainGoal::new(v3(-0.5, 1.2, 0.2)),
            &mut scratch,
        );
        let mut ag = AimGoal::new(v3(1.0, 1.6, 2.0));
        ag.up = v3(0.0, 1.0, 0.0);
        ag.up_weight = 0.5;
        look_at(&mut p, &aim_joints, &ag, &mut scratch);
        aim(
            &mut p,
            &aim_joints[..2],
            7,
            AimAxes::default(),
            &ag,
            &mut scratch,
        );
        let fb = FullBodyGoal {
            root: Effector::NONE,
            effectors: &effectors,
            centre_of_mass: Some(CentreOfMass {
                target: v3(0.05, 1.0, 0.0),
                weight: 0.5,
                masses: &[],
                up: v3(0.0, 1.0, 0.0),
            }),
            body_pull: 0.3,
            iterations: 8,
            tolerance: 1e-4,
            weight: 1.0,
        };
        full_body(&mut p, 0, &chains, &fb, &mut scratch);
        ray_requests(&mut p, &legs, &gs, &mut requests);
        let targets = solve(&mut p, &legs, &hits, &gs, &mut gstate, 1.0 / 60.0);
        apply(&mut p, 0, &legs, &targets, &gs);
        spring(
            &mut p,
            &NECK,
            &colliders,
            tr(frame as f32 * 0.1, 0.0, 0.0),
            &ss,
            &mut sstate,
            1.0 / 30.0,
        );
        copy(
            &mut p,
            &CopyTransform {
                space: Space::Model,
                ..CopyTransform::new(5, 8)
            },
        );
        limit_rotation(&mut p, 6, &limits[1], 1.0);
        limit_position(
            &mut p,
            7,
            &PositionLimit::Sphere {
                center: v3(0.0, 1.4, 0.0),
                radius: 0.5,
            },
            Space::Model,
            1.0,
        );
        damp(
            &mut p,
            &Damp {
                bone: 4,
                position_half_life: 0.1,
                rotation_half_life: 0.1,
                weight: 1.0,
            },
            &mut dstate,
            1.0 / 60.0,
        );
        stride_warp(
            &mut p,
            &legs,
            &StrideWarp {
                pelvis: 0,
                direction: v3(0.0, 0.0, 1.0),
                scale: 1.1,
                up: v3(0.0, 1.0, 0.0),
                pelvis_weight: 1.0,
                max_pelvis_drop: 0.2,
                max_reach: 0.999,
                weight: 1.0,
            },
        );
        orientation_warp(
            &mut p,
            &OrientationWarp {
                pelvis: 0,
                spine: &spine,
                spine_weights: &[],
                angle: 0.3,
                max_angle: 1.0,
                up: v3(0.0, 1.0, 0.0),
                weight: 1.0,
            },
            &mut scratch,
        );
        let curve = RootCurve {
            samples: &roots,
            clock: FrameClock::uniform(30.0, roots.len() as u32),
        };
        let mw = MotionWarp {
            t0: 0.1,
            t1: 0.6,
            start: tr(0.0, 0.0, 0.0),
            target: tr(1.0, 0.0, 1.0),
            up: v3(0.0, 1.0, 0.0),
        };
        let d = motion_warp_delta(&curve, &mw, 0.2, 0.25);
        let dc = DistanceCurve {
            distance: &distance,
            clock: FrameClock::uniform(30.0, distance.len() as u32),
        };
        let rate = dc.playback_rate(0.3, 1.0 / 60.0, 0.02, 0.5, 2.0) + dc.time_before(0.9, 0.2);
        assert!(d.translation.z.is_finite() && rate.is_finite());
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), 0, "a solver allocated");
    assert_finite(&body);
}
