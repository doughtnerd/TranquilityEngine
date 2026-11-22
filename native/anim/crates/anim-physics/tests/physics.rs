//! `anim-physics` through its public interface: the default builder, validation, drive targets
//! (identity case, joint frames and skipped bones, angular velocity, strengths and pins), the
//! body ↔ bone conversion and `bodies_to_local`, and get-up facing (no allocation: `no_alloc.rs`).
//!
//! Tolerances: 1e-5 on rotations and positions (f32 rounding through a few products); angular
//! velocity 1e-3 relative (the polynomial `atan2`).

use anim_format::skeleton::JointRange;
use anim_math::layout::{local_to_model, pack_pose, soa_len, unpack_pose, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_physics::desc::{DEFAULT_RANGE, DEFAULT_STIFFNESS};
use anim_physics::pose::{bodies_to_local, body_from_bone, bone_from_body};
use anim_physics::*;
fn q(axis: [f32; 3], angle: f32) -> AosQuat {
    let a = AosVec3::new(axis[0], axis[1], axis[2]);
    let a = a.scale(1.0 / a.length());
    let (s, c) = ((angle * 0.5).sin(), (angle * 0.5).cos());
    AosQuat::new(a.x * s, a.y * s, a.z * s, c)
}

fn close_q(a: AosQuat, b: AosQuat, tol: f32) -> bool {
    let b = if a.dot(b) < 0.0 { -b } else { b };
    [a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w]
        .iter()
        .all(|d| d.abs() <= tol)
}

fn close_v(a: AosVec3, b: AosVec3, tol: f32) -> bool {
    (a - b).length() <= tol
}

/// A branching skeleton: 0 root; 1, 2, 3 a chain; 4 a branch off 1; 5 off 4.
const PARENTS: [u16; 6] = [NO_PARENT, 0, 1, 2, 1, 4];

fn pose(seed: u32) -> Vec<AosTransform> {
    (0..PARENTS.len())
        .map(|i| {
            let k = (i as u32 + 1) * (seed + 3);
            let a = [
                ((k * 7) % 11) as f32 - 5.0,
                ((k * 5) % 7) as f32 - 3.0,
                ((k * 3) % 5) as f32 - 2.0 + 0.5,
            ];
            AosTransform::new(
                AosVec3::new(0.1 * i as f32, 0.3, -0.05 * i as f32),
                q(a, 0.2 + 0.1 * i as f32),
                AosVec3::one(),
            )
        })
        .collect()
}

fn soa(p: &[AosTransform]) -> Vec<SoaTransform> {
    let mut s = vec![SoaTransform::identity(); soa_len(p.len())];
    pack_pose(p, &mut s);
    s
}

fn model(p: &[AosTransform]) -> Vec<AosTransform> {
    let mut m = vec![AosTransform::identity(); p.len()];
    local_to_model(&PARENTS, &soa(p), &mut m);
    m
}

fn all_bodies() -> Ragdoll {
    let desc = RagdollDesc::from_skeleton(&PARENTS, &[], NO_BONE);
    Ragdoll::new(desc, &PARENTS).unwrap()
}

fn input<'a>(now: &'a [SoaTransform], prev: Option<&'a [SoaTransform]>) -> DriveInput<'a> {
    DriveInput {
        now,
        prev,
        dt: 1.0 / 60.0,
        strength: 1.0,
        pin: 1.0,
        multipliers: &[],
    }
}

#[test]
fn the_builder_puts_bodies_on_ranged_bones_and_pins_root_bodies() {
    // No ranges at all: every bone, the default range; the root body pinned and the pelvis.
    let d = RagdollDesc::from_skeleton(&PARENTS, &[], NO_BONE);
    assert!(d.bones.iter().all(|b| b.body && b.range == DEFAULT_RANGE));
    assert_eq!(d.pelvis, 0);
    let pins: Vec<f32> = d.bones.iter().map(|b| b.pin).collect();
    assert_eq!(pins, [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    // Ranges on 2, 3 and 5; pelvis 1 (no range) still gets a body.
    let r = JointRange {
        swing_y: 30.0,
        swing_z: 20.0,
        twist_min: -10.0,
        twist_max: 15.0,
    };
    let ranges = [None, None, Some(r), Some(r), None, Some(r)];
    let d = RagdollDesc::from_skeleton(&PARENTS, &ranges, 1);
    let bodies: Vec<bool> = d.bones.iter().map(|b| b.body).collect();
    assert_eq!(bodies, [false, true, true, true, false, true]);
    assert_eq!(d.pelvis, 1);
    assert_eq!(d.bones[2].range, r);
    let rd = Ragdoll::new(d, &PARENTS).unwrap();
    // 5's parent body skips 4 (no body) to 1.
    assert_eq!(rd.parent_body(5), 1);
    assert_eq!(rd.parent_body(1), NO_BONE);
    assert_eq!(rd.pelvis(), 1);
    assert_eq!(rd.desc().bones[1].pin, 1.0, "the root body is pinned");
}

#[test]
fn invalid_descriptions_are_refused() {
    let base = RagdollDesc::from_skeleton(&PARENTS, &[], NO_BONE);
    let with = |f: &dyn Fn(&mut RagdollDesc)| {
        let mut d = base.clone();
        f(&mut d);
        Ragdoll::new(d, &PARENTS).err()
    };
    assert_eq!(with(&|d| d.bones.truncate(3)), Some(DescError::BoneCount));
    assert_eq!(
        with(&|d| d.bones[2].range.swing_y = 200.0),
        Some(DescError::Value(2))
    );
    assert_eq!(
        with(&|d| d.bones[3].range.twist_max = -90.0),
        Some(DescError::Value(3))
    );
    assert_eq!(
        with(&|d| d.bones[1].stiffness = -1.0),
        Some(DescError::Value(1))
    );
    assert_eq!(with(&|d| d.bones[4].pin = 2.0), Some(DescError::Value(4)));
    assert_eq!(
        with(&|d| d.bones[0].joint_frame = AosQuat::new(0.0, 0.0, 0.0, 0.0)),
        Some(DescError::Value(0))
    );
    assert_eq!(
        with(&|d| d.bones.iter_mut().for_each(|b| b.body = false)),
        Some(DescError::NoBody)
    );
    assert_eq!(
        with(&|d| {
            d.bones[2].body = false;
            d.pelvis = 2;
        }),
        Some(DescError::Pelvis)
    );
    assert!(Ragdoll::new(base, &[1, NO_PARENT, 0, 1, 2, 3]).is_err());
}

#[test]
fn identity_frames_give_the_animated_local_rotations() {
    let rd = all_bodies();
    let p = pose(1);
    let now = soa(&p);
    let mut scratch = rd.scratch();
    let mut out = vec![Drive::default(); PARENTS.len()];
    rd.drive(&input(&now, None), &mut scratch, &mut out)
        .unwrap();
    let m = model(&p);
    for (b, d) in out.iter().enumerate() {
        assert!(close_q(d.target, p[b].rotation, 1e-5), "bone {b}");
        assert!(d.target.w >= 0.0, "canonical");
        assert_eq!(d.flags & DRIVE_ROOT != 0, b == 0);
        assert_eq!(d.flags & DRIVE_VELOCITY, 0);
        assert!(close_v(d.body.position, m[b].translation, 1e-6));
        assert!(close_q(d.body.rotation, m[b].rotation, 1e-6));
    }
}

#[test]
fn joint_frames_and_skipped_bones_give_relative_body_rotations() {
    let r = Some(DEFAULT_RANGE);
    let mut desc = RagdollDesc::from_skeleton(&PARENTS, &[r, r, None, r, r, r], NO_BONE);
    for (i, b) in desc.bones.iter_mut().enumerate() {
        b.joint_frame = q([1.0, i as f32, 0.5], 0.4 * i as f32);
    }
    let rd = Ragdoll::new(desc.clone(), &PARENTS).unwrap();
    assert_eq!(rd.parent_body(3), 1, "bone 2 has no body");
    let p = pose(2);
    let now = soa(&p);
    let mut out = vec![Drive::default(); PARENTS.len()];
    rd.drive(&input(&now, None), &mut rd.scratch(), &mut out)
        .unwrap();
    let m = model(&p);
    let body = |b: usize| body_from_bone(&m[b], desc.bones[b].joint_frame).rotation;
    assert_eq!(out[2].flags, 0, "no body, no drive");
    for b in [1usize, 3, 4, 5] {
        let pb = rd.parent_body(b) as usize;
        assert!(
            close_q(body(pb) * out[b].target, body(b), 1e-5),
            "bone {b}: parent body · target = body"
        );
    }
    assert!(
        close_q(out[0].target, body(0), 1e-5),
        "the root's target is its body rotation"
    );
}

#[test]
fn angular_velocity_is_the_rotation_between_steps_over_dt() {
    let rd = all_bodies();
    let prev_pose = pose(3);
    let mut now_pose = prev_pose.clone();
    let (axis, angle) = ([0.3, -0.8, 0.5], 0.05);
    let turn = q(axis, angle);
    now_pose[2].rotation = (turn * prev_pose[2].rotation).normalize_or_identity();
    let (now, prev) = (soa(&now_pose), soa(&prev_pose));
    let dt = 1.0 / 60.0;
    let mut out = vec![Drive::default(); PARENTS.len()];
    let inp = DriveInput {
        dt,
        ..input(&now, Some(&prev))
    };
    rd.drive(&inp, &mut rd.scratch(), &mut out).unwrap();
    let a = AosVec3::new(axis[0], axis[1], axis[2]);
    let want = a.scale(angle / dt / a.length());
    let got = out[2].angular_velocity;
    assert!(
        close_v(got, want, 1e-3 * want.length()),
        "{got:?} vs {want:?}"
    );
    assert_ne!(out[2].flags & DRIVE_VELOCITY, 0);
    // The child's local rotation didn't change, so its relative target didn't either.
    assert!(out[3].angular_velocity.length() < 1e-3);
    // No positive dt: no velocity.
    let inp = DriveInput {
        dt: 0.0,
        ..input(&now, Some(&prev))
    };
    rd.drive(&inp, &mut rd.scratch(), &mut out).unwrap();
    assert_eq!(out[2].flags & DRIVE_VELOCITY, 0);
    assert_eq!(out[2].angular_velocity.length(), 0.0);
}

#[test]
fn strengths_and_pins_scale_by_global_bone_and_multiplier() {
    let mut desc = RagdollDesc::from_skeleton(&PARENTS, &[], NO_BONE);
    desc.bones[2].strength = 2.0;
    desc.bones[3].pin = 0.5;
    let rd = Ragdoll::new(desc, &PARENTS).unwrap();
    let now = soa(&pose(4));
    let mult = [1.0, 1.0, 0.25, 1.0, f32::NAN];
    let inp = DriveInput {
        strength: 0.5,
        pin: 0.8,
        multipliers: &mult,
        ..input(&now, None)
    };
    let mut out = vec![Drive::default(); PARENTS.len()];
    rd.drive(&inp, &mut rd.scratch(), &mut out).unwrap();
    assert_eq!(out[1].stiffness, DEFAULT_STIFFNESS * 0.5);
    assert_eq!(out[2].stiffness, DEFAULT_STIFFNESS * 0.5 * 2.0 * 0.25);
    assert_eq!(out[4].stiffness, 0.0, "a NaN multiplier is 0");
    assert_eq!(
        out[5].stiffness,
        DEFAULT_STIFFNESS * 0.5,
        "a missing multiplier is 1"
    );
    assert_eq!(out[0].pin, 0.8);
    assert_eq!(out[3].pin, 0.4);
    assert_eq!(out[1].pin, 0.0);
    // Wrong sizes are refused.
    let short = vec![SoaTransform::identity(); 1];
    assert_eq!(
        rd.drive(&input(&short, None), &mut rd.scratch(), &mut out),
        Err(DriveError::PoseLength)
    );
    assert_eq!(
        rd.drive(&input(&now, None), &mut rd.scratch(), &mut out[..2]),
        Err(DriveError::OutLength)
    );
}

#[test]
fn bodies_back_to_the_local_pose() {
    let p = pose(5);
    let m = model(&p);
    let frame = q([0.0, 1.0, 1.0], 0.7);
    // Bones 1, 2 and 4 simulated (their bodies through a joint frame), the others from the fallback.
    let simulated = [false, true, true, false, true, false];
    let fallback = pose(6);
    let mut local = soa(&fallback);
    let mut scratch = vec![AosTransform::identity(); PARENTS.len()];
    bodies_to_local(
        &PARENTS,
        |b| simulated[b].then(|| bone_from_body(&body_from_bone(&m[b], frame), frame)),
        &mut local,
        &mut scratch,
    );
    let mut got = vec![AosTransform::identity(); PARENTS.len()];
    unpack_pose(&local, &mut got);
    let gm = model(&got);
    for b in 0..PARENTS.len() {
        if simulated[b] {
            assert!(
                close_v(gm[b].translation, m[b].translation, 1e-5),
                "bone {b} position"
            );
            assert!(
                close_q(gm[b].rotation, m[b].rotation, 1e-5),
                "bone {b} rotation"
            );
        } else {
            assert!(close_v(got[b].translation, fallback[b].translation, 1e-6));
            assert!(
                close_q(got[b].rotation, fallback[b].rotation, 1e-6),
                "bone {b} keeps its local"
            );
        }
    }
    // Everything simulated: the animated pose back.
    let mut local = soa(&fallback);
    bodies_to_local(
        &PARENTS,
        |b| Some(bone_from_body(&body_from_bone(&m[b], frame), frame)),
        &mut local,
        &mut scratch,
    );
    unpack_pose(&local, &mut got);
    for b in 0..PARENTS.len() {
        assert!(close_v(got[b].translation, p[b].translation, 1e-5));
        assert!(close_q(got[b].rotation, p[b].rotation, 1e-5));
    }
}

#[test]
fn facing_picks_the_get_up_state() {
    // Upright, the belly (+Z) is horizontal: not up, so down (on its front or side).
    assert_eq!(facing(AosQuat::identity(), FrontAxis::PosZ), Facing::Down);
    let back = q([1.0, 0.0, 0.0], -std::f32::consts::FRAC_PI_2);
    assert_eq!(facing(back, FrontAxis::PosZ), Facing::Up);
    assert_eq!(facing(back, FrontAxis::NegZ), Facing::Down);
    let front = q([1.0, 0.0, 0.0], std::f32::consts::FRAC_PI_2);
    assert_eq!(facing(front, FrontAxis::PosZ), Facing::Down);
    assert_eq!(facing(AosQuat::identity(), FrontAxis::PosY), Facing::Up);
    assert_eq!(getup_state(Facing::Up, 3, 4), 3);
    assert_eq!(getup_state(Facing::Down, 3, 4), 4);
    for v in 0..6 {
        assert_eq!(FrontAxis::from_u32(v).map(|a| a as u32), Some(v));
    }
    assert_eq!(FrontAxis::from_u32(6), None);
}
