//! T41/T44r test helpers: `anim-retarget`'s humanoid fixtures (Mixamo names, a choice of bone
//! axes, rest pose and proportions) as `myco.skel@1` files, constant clips, and the matrices a
//! local pose shows (the f64 reference, `common::Reference`).
#![allow(dead_code)]

#[path = "../../../anim-retarget/tests/common/mod.rs"]
pub mod rt;

use anim_format::clip::{Binding, Clip, Track, TrackKind};
use anim_format::skeleton::{Bone, JointRange, Skeleton};
use anim_format::NONE;
use anim_math::AosTransform;
use anim_offline::pose as offline;
use anim_retarget::Profile;
pub use rt::{humanoid, Axes, Build, Rig};

/// A rig as a skeleton file whose inverse binds invert its rest pose (so the rest pose skins to
/// identity): bone names, the guessed roles (`roles`), and the Humanoid profile's joint ranges per
/// role (`ranges`).
pub fn skeleton_file(rig: &Rig, roles: bool, ranges: bool) -> (Skeleton, Vec<u8>) {
    let n = rig.n();
    let profile = Profile::humanoid();
    let role_list = rig.map.to_roles(n);
    let mut skel = Skeleton {
        name: NONE,
        profile: NONE,
        mirror_axis: 0,
        strings: rig.names.clone(),
        bones: (0..n)
            .map(|i| {
                let t = rig.rest[i];
                Bone {
                    name: i as u32,
                    parent: rig.parents[i],
                    translation: [t.translation.x, t.translation.y, t.translation.z],
                    rotation: [t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w],
                    scale: [t.scale.x, t.scale.y, t.scale.z],
                    inverse_bind: [0.0; 12],
                }
            })
            .collect(),
        roles: roles.then(|| role_list.clone()),
        joint_ranges: ranges.then(|| {
            role_list
                .iter()
                .map(|&r| {
                    profile
                        .roles
                        .get(r as usize)
                        .and_then(|x| x.range)
                        .unwrap_or(JointRange {
                            swing_y: 10.0,
                            swing_z: 10.0,
                            twist_min: -5.0,
                            twist_max: 5.0,
                        })
                })
                .collect()
        }),
        mirror: None,
    };
    let (rest, parents) = super::common::synth::rest_and_parents(&skel);
    let model = offline::model_space(&parents, &rest);
    let inv = offline::inverse_bind_matrices(&model);
    for (b, m) in skel.bones.iter_mut().zip(&inv) {
        for (o, v) in b.inverse_bind.iter_mut().zip(m.m) {
            *o = v as f32;
        }
    }
    let bytes = skel.write().unwrap();
    (skel, bytes)
}

/// A raw two-frame clip (1 s) holding `pose` throughout, no root motion.
pub fn constant_clip(pose: &[AosTransform]) -> Vec<u8> {
    let tracks = pose
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let f = [
                t.translation.x,
                t.translation.y,
                t.translation.z,
                t.rotation.x,
                t.rotation.y,
                t.rotation.z,
                t.rotation.w,
                t.scale.x,
                t.scale.y,
                t.scale.z,
            ];
            let mut raw = f.to_vec();
            raw.extend_from_slice(&f);
            Track {
                kind: TrackKind::Bone,
                flags: 0,
                subtype: 0,
                binding: Binding::bone(i as u32),
                raw,
                keys: Vec::new(),
            }
        })
        .collect();
    Clip {
        flags: anim_format::clip::CLIP_LOOP,
        name: NONE,
        duration: 1.0,
        sample_rate: 1.0,
        frame_count: 2,
        bone_count: pose.len() as u32,
        root_bone: NONE,
        strings: Vec::new(),
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    }
    .write()
    .unwrap()
}

/// A random local pose of `rig` (rest rotations turned by up to `max` radians).
pub fn random_pose(rig: &Rig, seed: u64, max: f32) -> Vec<AosTransform> {
    let mut rng = rt::Rng::new(seed);
    rt::random_pose(rig, &mut rng, max)
}

/// The bone matrices (f64 reference) of a local pose on a skeleton file.
pub fn matrices_of(skel_bytes: &[u8], pose: &[AosTransform]) -> Vec<f64> {
    super::common::Reference::new(skel_bytes).matrices(&rt::p64(pose))
}
