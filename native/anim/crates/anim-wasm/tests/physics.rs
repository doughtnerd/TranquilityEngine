//! T44r through the core's calls: ragdoll descriptions (`ragdoll_build`, `ragdoll_create`), the
//! physics rows (`physics_configure`, `physics_attach`), drive targets in the output view (the
//! identity case, angular velocity from consecutive steps, strengths and pins), the
//! `PHYSICAL_POSE` round trip (drive bodies written back as simulated bodies give the animated
//! pose), `PHYSICS_BLEND` weights and masks, get-up facing, the capture into a pose snapshot, and
//! snapshot/restore exactness.
//!
//! Tolerances: matrices 1e-5 (f32 rounding through model space and back), rotations 1e-5.

mod common;
mod rigs;

use anim_format::graph::{family, ParamValue};
use anim_format::NONE;
use anim_graph::{mixing, physics as nodes, sources};
use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_wasm::init::Core;
use anim_wire::core::STATUS_OK;
use anim_wire::physics::{
    BodyIn, DriveOut, RagdollBone, RagdollInfo, RowControl, RowOut, BODY_SIMULATED, BONE_BODY,
    DRIVE_BODY, DRIVE_ROOT, DRIVE_VELOCITY, FACING_DOWN, FACING_UP, ROW_DRIVES, ROW_FACING,
    STATUS_NO_ROW,
};
use anim_wire::WireRecord;
use common::graph::*;
use common::*;
use rigs::*;

const DT: f32 = 1.0 / 60.0;
const MAX_BONES: u32 = 64;

struct Setup {
    core: Core,
    rig: Rig,
    file: Vec<u8>,
    h: u32,
    row: usize,
    /// Node indices: physical pose, blend, snapshot.
    physical: u32,
    snapshot: u32,
}

/// A graph: `blend2(physics_blend(player, physical_pose(player)), snapshot, snap)`, parameters
/// `w` (0, the blend weight) and `snap` (1, the snapshot's weight); `clip` the player's clip.
fn setup_with(clip: impl FnOnce(&Rig, &anim_format::skeleton::Skeleton) -> Vec<u8>, mask: bool) -> Setup {
    let rig = humanoid(Build {
        axes: Axes::XAlong,
        ..Build::default()
    });
    let (model, file) = skeleton_file(&rig, false, false);
    let mut core = core(8, MAX_BONES);
    let skel = core.load_skeleton(&file);
    let clip_handle = core.load_clip(&clip(&rig, &model));
    let mut b = Builder::new();
    let w = b.param("w", ParamValue::Float(0.0));
    let snap = b.param("snap", ParamValue::Float(0.0));
    let player = b.player("clip");
    let physical = b.node(family::PHYSICS, nodes::kind::PHYSICAL_POSE, &[player], &[]);
    let mask_id = if mask { b.s("mask") } else { NONE };
    let blend = b.node(
        family::PHYSICS,
        nodes::kind::PHYSICS_BLEND,
        &[player, physical],
        &[1.0f32.to_bits(), w, mask_id],
    );
    let snapshot = b.node(family::SOURCES, sources::kind::POSE_SNAPSHOT, &[], &[1]);
    let out = b.node(family::MIXING, mixing::kind::BLEND2, &[blend, snapshot], &[0, snap]);
    let bytes = b.build(out);
    let mut binds = vec![(b.s("clip"), clip_handle)];
    if mask {
        // Arms and legs follow physics (the bones after the head); the spine stays animated.
        let head = rig.index("Head");
        let weights: Vec<f32> = (0..rig.n()).map(|i| (i > head) as u32 as f32).collect();
        binds.push((b.s("mask"), core.load_mask(&weights)));
    }
    let (_, h) = instance(&mut core, &bytes, skel, &binds);
    let desc = core.ragdoll_build(&file, 0);
    assert!(!desc.is_empty());
    let ragdoll = core.ragdoll_create(skel, &desc);
    assert_ne!(ragdoll, 0, "ragdoll (status {})", core.last_status());
    assert_eq!(core.physics_configure(2), STATUS_OK);
    let row = core.physics_attach(h, ragdoll);
    assert_eq!(row, 0);
    Setup {
        core,
        rig,
        file,
        h,
        row: row as usize,
        physical,
        snapshot,
    }
}

fn setup(pose: &[AosTransform]) -> Setup {
    let p = pose.to_vec();
    setup_with(move |_, _| constant_clip(&p), false)
}

fn step(s: &mut Setup) {
    s.core.physics_read(0);
    frame(&mut s.core, DT);
    s.core.physics_drive(0);
}

fn out_row(s: &Setup) -> Vec<u8> {
    let n = s.core.physics_out_row_bytes() as usize;
    let words = s.core.physics_output();
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    bytes[s.row * n..(s.row + 1) * n].to_vec()
}

fn drives(s: &Setup) -> (RowOut, Vec<DriveOut>) {
    let row = out_row(s);
    let head = RowOut::decode(&row).unwrap();
    let d = (0..head.bone_count as usize)
        .map(|b| {
            DriveOut::decode(&row[RowOut::STRIDE as usize + b * DriveOut::STRIDE as usize..])
                .unwrap()
        })
        .collect();
    (head, d)
}

fn write_in(s: &mut Setup, at: usize, bytes: &[u8]) {
    let n = s.core.physics_in_row_bytes() as usize;
    let start = s.row * n + at;
    let words = s.core.physics_input_mut();
    for (i, &b) in bytes.iter().enumerate() {
        let k = start + i;
        let mut w = words[k / 4].to_le_bytes();
        w[k % 4] = b;
        words[k / 4] = u32::from_le_bytes(w);
    }
}

fn read_in(s: &mut Setup, at: usize, len: usize) -> Vec<u8> {
    let n = s.core.physics_in_row_bytes() as usize;
    let start = s.row * n + at;
    let words = s.core.physics_input_mut();
    (start..start + len)
        .map(|k| words[k / 4].to_le_bytes()[k % 4])
        .collect()
}

fn body_at(b: usize) -> usize {
    RowControl::STRIDE as usize + b * BodyIn::STRIDE as usize
}

fn set_body(s: &mut Setup, b: usize, pos: AosVec3, rot: AosQuat) {
    let mut rec = BodyIn::decode(&read_in(s, body_at(b), BodyIn::STRIDE as usize)).unwrap();
    rec.flags = BODY_SIMULATED;
    (rec.pos_x, rec.pos_y, rec.pos_z) = (pos.x, pos.y, pos.z);
    (rec.rot_x, rec.rot_y, rec.rot_z, rec.rot_w) = (rot.x, rot.y, rot.z, rot.w);
    write_in(s, body_at(b), &rec.encode());
}

fn set_control(s: &mut Setup, c: RowControl) {
    write_in(s, 0, &c.encode());
}

fn quat(d: &DriveOut) -> AosQuat {
    AosQuat::new(d.target_x, d.target_y, d.target_z, d.target_w)
}

#[test]
fn drive_targets_are_the_animated_local_rotations_with_identity_frames() {
    let rig = humanoid(Build {
        axes: Axes::XAlong,
        ..Build::default()
    });
    let pose = random_pose(&rig, 3, 0.5);
    let mut s = setup(&pose);
    step(&mut s);
    let (head, d) = drives(&s);
    assert_eq!(head.instance, s.h);
    assert_ne!(head.flags & ROW_DRIVES, 0);
    assert_eq!(d.len(), rig.n());
    let model = rt::model(&rig.parents, &pose);
    for (b, x) in d.iter().enumerate() {
        assert_ne!(x.flags & DRIVE_BODY, 0, "every bone has a body without ranges");
        let root = rig.parents[b] == anim_math::layout::NO_PARENT;
        assert_eq!(x.flags & DRIVE_ROOT != 0, root);
        assert_eq!(x.parent_body, if root { NONE } else { rig.parents[b] as u32 });
        assert!(
            rt::quat_close(quat(x), pose[b].rotation, 1e-5),
            "bone {b}: target is the local rotation"
        );
        // The body pose is the bone's animated model transform.
        let m = model[b];
        assert!((x.pos_x - m.translation.x).abs() < 1e-5);
        assert!((x.pos_y - m.translation.y).abs() < 1e-5);
        assert!(rt::quat_close(
            AosQuat::new(x.rot_x, x.rot_y, x.rot_z, x.rot_w),
            m.rotation,
            1e-5
        ));
        assert_eq!((x.vel_x, x.vel_y, x.vel_z), (0.0, 0.0, 0.0));
        assert_eq!(x.flags & DRIVE_VELOCITY, 0, "one pose: no velocity");
    }
    // A constant pose: two poses give a zero velocity.
    step(&mut s);
    let (_, d) = drives(&s);
    for x in &d {
        assert_ne!(x.flags & DRIVE_VELOCITY, 0);
        let v = (x.vel_x * x.vel_x + x.vel_y * x.vel_y + x.vel_z * x.vel_z).sqrt();
        assert!(v < 1e-3, "constant pose, |ω| = {v}");
    }
}

#[test]
fn angular_velocity_comes_from_consecutive_targets() {
    let mut s = setup_with(
        |_, model| raw_clip(model, &ClipSpec::new(1.0, true, 9)),
        false,
    );
    step(&mut s);
    let (_, mut before) = drives(&s);
    for _ in 0..5 {
        step(&mut s);
        let (_, now) = drives(&s);
        let mut moving = 0;
        for (b, (x, p)) in now.iter().zip(&before).enumerate() {
            let delta = (quat(x) * quat(p).conjugate()).normalize_or_identity();
            let delta = if delta.w < 0.0 { -delta } else { delta };
            let (axis, angle) = delta.to_axis_angle();
            let w = axis.scale(angle / DT);
            for (got, want) in [(x.vel_x, w.x), (x.vel_y, w.y), (x.vel_z, w.z)] {
                assert!(
                    (got - want).abs() <= 1e-3 * (1.0 + want.abs()),
                    "bone {b}: ω {got} vs {want}"
                );
            }
            moving += (angle > 1e-4) as usize;
        }
        assert!(moving > 10, "the clip moves most bones");
        before = now;
    }
}

#[test]
fn strengths_and_pins_scale_by_the_controls() {
    let rig = humanoid(Build::default());
    let mut s = setup(&rig.rest);
    let arm = s.rig.index("LeftArm");
    set_control(
        &mut s,
        RowControl {
            strength: 0.5,
            pin: 0.25,
            getup_from_back: NONE,
            getup_from_front: NONE,
        },
    );
    let mut rec = BodyIn::decode(&read_in(&mut s, body_at(arm), BodyIn::STRIDE as usize)).unwrap();
    rec.multiplier = 0.5;
    write_in(&mut s, body_at(arm), &rec.encode());
    step(&mut s);
    let (_, d) = drives(&s);
    let base = anim_physics::desc::BoneDesc::default();
    let close = |a: f32, b: f32| (a - b).abs() <= 1e-3 * b.abs().max(1.0);
    assert!(close(d[arm].stiffness, base.stiffness * 0.25));
    assert!(close(d[arm].damping, base.damping * 0.25));
    assert!(close(d[arm].max_force, base.max_force * 0.25));
    let spine = s.rig.index("Spine");
    assert!(close(d[spine].stiffness, base.stiffness * 0.5));
    // The root body is pinned at the global pin weight; the others not.
    assert!(close(d[0].pin, 0.25));
    assert_eq!(d[spine].pin, 0.0);
}

#[test]
fn physical_pose_round_trips_the_animated_pose() {
    let rig = humanoid(Build {
        axes: Axes::XAlong,
        ..Build::default()
    });
    let pose = random_pose(&rig, 11, 0.7);
    let mut s = setup(&pose);
    step(&mut s);
    let n = rig.n();
    let animated = matrices(&s.core, s.h, MAX_BONES as usize, n);
    let (_, d) = drives(&s);
    // Write the drive's body poses back as the simulation's, then show the physical pose only.
    for (b, x) in d.iter().enumerate() {
        set_body(
            &mut s,
            b,
            AosVec3::new(x.pos_x, x.pos_y, x.pos_z),
            AosQuat::new(x.rot_x, x.rot_y, x.rot_z, x.rot_w),
        );
    }
    send(&mut s.core, &[set_float(s.h, 0, 1.0)]);
    step(&mut s);
    let physical = matrices(&s.core, s.h, MAX_BONES as usize, n);
    let worst = animated
        .iter()
        .zip(&physical)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    assert!(worst < 1e-5, "round trip differs by {worst}");
    assert!(max_diff(&animated, &matrices_of(&s.file, &pose)) < 1e-5);
}

/// The model-space bone poses of `local` as simulated bodies (identity joint frames).
fn write_pose_as_bodies(s: &mut Setup, local: &[AosTransform]) {
    let model = rt::model(&s.rig.parents.clone(), local);
    for (b, m) in model.iter().enumerate() {
        set_body(s, b, m.translation, m.rotation);
    }
}

#[test]
fn physics_blend_weights_and_masks() {
    let rig = humanoid(Build {
        axes: Axes::XAlong,
        ..Build::default()
    });
    let animated = random_pose(&rig, 5, 0.6);
    let physical = random_pose(&rig, 6, 0.6);
    let n = rig.n();
    let expected = |w: f32, mask: Option<&dyn Fn(usize) -> f32>| {
        let a = rt::soa(&animated);
        let p = rt::soa(&physical);
        let mut out = a.clone();
        match mask {
            None => anim_pose::blend::lerp(&a, &p, w, &mut out),
            Some(m) => {
                let weights: Vec<f32> = (0..n).map(m).collect();
                let mut packed = vec![anim_math::F32x4::splat(0.0); a.len()];
                anim_pose::blend::pack_mask(&weights, &mut packed);
                anim_pose::blend::blend_masked(&a, &p, &packed, w, &mut out);
            }
        }
        rt::aos(&out, n)
    };
    for w in [0.0f32, 0.3, 1.0] {
        let mut s = setup(&animated);
        write_pose_as_bodies(&mut s, &physical);
        send(&mut s.core, &[set_float(s.h, 0, w)]);
        step(&mut s);
        let got = matrices(&s.core, s.h, MAX_BONES as usize, n);
        let want = matrices_of(&s.file, &expected(w, None));
        assert!(max_diff(&got, &want) < 1e-5, "w = {w}: {}", max_diff(&got, &want));
    }
    let p = animated.clone();
    let mut s = setup_with(move |_, _| constant_clip(&p), true);
    write_pose_as_bodies(&mut s, &physical);
    send(&mut s.core, &[set_float(s.h, 0, 0.8)]);
    step(&mut s);
    let head = rig.index("Head");
    let m = move |i: usize| (i > head) as u32 as f32;
    let got = matrices(&s.core, s.h, MAX_BONES as usize, n);
    let want = matrices_of(&s.file, &expected(0.8, Some(&m)));
    assert!(max_diff(&got, &want) < 1e-5, "masked: {}", max_diff(&got, &want));
}

#[test]
fn getup_facing_picks_the_state_and_the_capture_feeds_the_snapshot() {
    let rig = humanoid(Build {
        axes: Axes::XAlong,
        ..Build::default()
    });
    let mut s = setup(&random_pose(&rig, 2, 0.4));
    set_control(
        &mut s,
        RowControl {
            strength: 1.0,
            pin: 1.0,
            getup_from_back: 7,
            getup_from_front: 9,
        },
    );
    // No simulated pelvis: no facing.
    step(&mut s);
    assert_eq!(drives(&s).0.flags & ROW_FACING, 0);
    // The pelvis (hips) lying on its back: its front (+Z) turned to +Y.
    let lying = rt::q(AosVec3::new(1.0, 0.0, 0.0), -std::f32::consts::FRAC_PI_2);
    let rest_hips = rt::model(&rig.parents, &rig.rest)[0];
    set_body(&mut s, 0, AosVec3::new(0.0, 0.2, 0.0), lying * rest_hips.rotation);
    step(&mut s);
    let (head, _) = drives(&s);
    assert_ne!(head.flags & ROW_FACING, 0);
    assert_eq!((head.facing, head.getup), (FACING_UP, 7));
    let face_down = rt::q(AosVec3::new(1.0, 0.0, 0.0), std::f32::consts::FRAC_PI_2);
    set_body(&mut s, 0, AosVec3::new(0.0, 0.2, 0.0), face_down * rest_hips.rotation);
    step(&mut s);
    assert_eq!((drives(&s).0.facing, drives(&s).0.getup), (FACING_DOWN, 9));

    // Capture the physical pose (every bone simulated at the rest pose) into the snapshot and
    // show the snapshot only: the rest pose.
    write_pose_as_bodies(&mut s, &rig.rest);
    s.core.physics_read(0);
    assert_eq!(s.core.physics_capture(s.h, s.physical, s.snapshot), STATUS_OK);
    send(&mut s.core, &[set_float(s.h, 1, 1.0)]);
    frame(&mut s.core, DT);
    let n = rig.n();
    let got = matrices(&s.core, s.h, MAX_BONES as usize, n);
    assert!(max_diff(&got, &matrices_of(&s.file, &rig.rest)) < 1e-5);
    // Refusals: wrong node kinds, no row.
    assert_ne!(s.core.physics_capture(s.h, s.snapshot, s.physical), STATUS_OK);
    assert_eq!(s.core.physics_detach(s.h), STATUS_OK);
    assert_eq!(s.core.physics_detach(s.h), STATUS_NO_ROW);
}

#[test]
fn the_builder_puts_bodies_on_ranged_roles_and_create_validates() {
    let rig = humanoid(Build::default());
    let (_, with_roles) = skeleton_file(&rig, true, false);
    let mut core = core(2, MAX_BONES);
    let skel = core.load_skeleton(&with_roles);
    let bytes = core.ragdoll_build(&with_roles, 0);
    let info = RagdollInfo::decode(&bytes).unwrap();
    assert_eq!(info.bone_count as usize, rig.n());
    assert_eq!(info.pelvis, rig.index("Hips") as u32, "the profile's hips");
    let bone = |b: usize| {
        RagdollBone::decode(&bytes[RagdollInfo::STRIDE as usize + b * RagdollBone::STRIDE as usize..])
            .unwrap()
    };
    let profile = anim_retarget::Profile::humanoid();
    let roles = rig.map.to_roles(rig.n());
    // The pelvis (the hips bone, holding the profile's root role here) gets a body without a range;
    // every other bone has a body exactly when its role has a range.
    for b in 0..rig.n() {
        let range = profile.roles.get(roles[b] as usize).and_then(|r| r.range);
        assert_eq!(bone(b).flags & BONE_BODY != 0, range.is_some() || b == 0, "bone {b}");
        assert_eq!(bone(b).pin, (b == 0) as u32 as f32, "only the root body is pinned");
        if let Some(r) = range {
            assert_eq!((bone(b).swing_y, bone(b).twist_max), (r.swing_y, r.twist_max));
        }
    }
    assert_ne!(core.ragdoll_create(skel, &bytes), 0);
    // Wrong bone count, a bad value, no body at all.
    assert_eq!(core.ragdoll_create(skel, &bytes[..bytes.len() - 4]), 0);
    let mut bad = bytes.clone();
    let at = RagdollInfo::STRIDE as usize + 4 + 4 * 5; // bone 0's swing_y
    bad[at..at + 4].copy_from_slice(&500.0f32.to_le_bytes());
    assert_eq!(core.ragdoll_create(skel, &bad), 0);
    let mut none = RagdollInfo::decode(&bytes).unwrap().encode();
    for b in 0..rig.n() {
        let mut r = bone(b);
        r.flags = 0;
        none.extend_from_slice(&r.encode());
    }
    assert_eq!(core.ragdoll_create(skel, &none), 0);
}

#[test]
fn rows_run_out_and_snapshots_stay_exact() {
    let mut s = setup_with(
        |_, model| raw_clip(model, &ClipSpec::new(1.0, true, 21)),
        false,
    );
    // Both rows taken: a third instance is refused.
    let skel = s.core.load_skeleton(&s.file.clone());
    let desc = s.core.ragdoll_build(&s.file.clone(), 0);
    let rd = s.core.ragdoll_create(skel, &desc);
    let mut b = Builder::new();
    let p = b.player("x");
    let g = s.core.load_graph(&b.build(p));
    let h2 = s.core.create_instance(0, skel, g);
    let h3 = s.core.create_instance(0, skel, g);
    assert_eq!(s.core.physics_attach(h2, rd), 1);
    assert_eq!(s.core.physics_attach(h3, rd), NONE);
    assert_eq!(s.core.last_status(), STATUS_NO_ROW);

    let n = s.rig.n();
    send(&mut s.core, &[set_float(s.h, 0, 0.5)]);
    let rest = s.rig.rest.clone();
    write_pose_as_bodies(&mut s, &rest);
    for _ in 0..4 {
        step(&mut s);
    }
    let mut snap = vec![0u8; s.core.snapshot_bytes(s.h) as usize];
    assert_eq!(s.core.snapshot(s.h, &mut snap), STATUS_OK);
    let mut seen = Vec::new();
    for _ in 0..4 {
        step(&mut s);
        seen.push((matrices(&s.core, s.h, MAX_BONES as usize, n), out_row(&s)));
    }
    assert_eq!(s.core.restore(s.h, &snap), STATUS_OK);
    for (m, row) in seen {
        step(&mut s);
        assert_eq!(matrices(&s.core, s.h, MAX_BONES as usize, n), m);
        assert_eq!(out_row(&s), row, "drives after a restore");
    }
}
