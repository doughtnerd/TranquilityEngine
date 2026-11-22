//! Rig test helpers (T40): a small humanoid skeleton with roles and identity inverse binds (so a
//! bone's matrix is its model transform), a still clip with a root curve and cue markers, the
//! `rig` family's views and commands through the core, and parameter blocks laid out by
//! `anim_graph::rig`'s word constants.
#![allow(dead_code)]

use anim_format::clip::{Binding, Clip, Key, KeyData, MarkerKind, Track, TrackKind, CLIP_LOOP};
use anim_format::skeleton::{Bone, JointRange, Skeleton, NO_PARENT};
use anim_format::NONE;
use anim_graph::rig::{head, ROLE};
use anim_retarget::profile::humanoid as role;
use anim_wasm::init::Core;
use anim_wire::core::MATRIX_FLOATS;
use anim_wire::rig as wr;
use anim_wire::WireRecord;

pub const IDENTITY_BIND: [f32; 12] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];

/// Bone indices of [`rig_skeleton`].
pub mod b {
    pub const ROOT: u16 = 0;
    pub const HIPS: u16 = 1;
    pub const SPINE: u16 = 2;
    pub const CHEST: u16 = 3;
    pub const NECK: u16 = 4;
    pub const HEAD: u16 = 5;
    pub const L_THIGH: u16 = 6;
    pub const L_SHIN: u16 = 7;
    pub const L_FOOT: u16 = 8;
    pub const R_THIGH: u16 = 9;
    pub const R_SHIN: u16 = 10;
    pub const R_FOOT: u16 = 11;
    pub const L_SHOULDER: u16 = 12;
    pub const L_UPPER_ARM: u16 = 13;
    pub const L_LOWER_ARM: u16 = 14;
    pub const L_HAND: u16 = 15;
    pub const R_SHOULDER: u16 = 16;
    pub const R_UPPER_ARM: u16 = 17;
    pub const R_LOWER_ARM: u16 = 18;
    pub const R_HAND: u16 = 19;
    pub const TAIL: [u16; 4] = [20, 21, 22, 23];
    pub const COUNT: usize = 24;
}

/// A 24-bone humanoid with a tail: hips at 1 m, legs of 0.9 m with the knees bent slightly
/// forward (feet at y 0.1), arms along ±X, a four-bone tail behind the hips. Humanoid roles on
/// the body bones; identity inverse binds; the left shin has a locked joint range (no swing, no
/// twist) and every other bone a free one.
pub fn rig_skeleton() -> (Skeleton, Vec<u8>) {
    let mut bones = Vec::new();
    let mut roles = Vec::new();
    let mut push = |parent: u16, t: [f32; 3], r: u16| {
        bones.push(Bone {
            name: bones.len() as u32,
            parent,
            translation: t,
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0; 3],
            inverse_bind: IDENTITY_BIND,
        });
        roles.push(r);
    };
    let none = anim_format::skeleton::NO_ROLE;
    push(NO_PARENT, [0.0, 0.0, 0.0], role::ROOT);
    push(0, [0.0, 1.0, 0.0], role::HIPS);
    push(1, [0.0, 0.2, 0.0], role::SPINE);
    push(2, [0.0, 0.2, 0.0], role::CHEST);
    push(3, [0.0, 0.2, 0.0], role::NECK);
    push(4, [0.0, 0.1, 0.0], role::HEAD);
    push(1, [0.1, 0.0, 0.0], role::LEFT_UPPER_LEG);
    push(6, [0.0, -0.45, 0.03], role::LEFT_LOWER_LEG);
    push(7, [0.0, -0.45, -0.03], role::LEFT_FOOT);
    push(1, [-0.1, 0.0, 0.0], role::RIGHT_UPPER_LEG);
    push(9, [0.0, -0.45, 0.03], role::RIGHT_LOWER_LEG);
    push(10, [0.0, -0.45, -0.03], role::RIGHT_FOOT);
    push(3, [0.08, 0.15, 0.0], role::LEFT_SHOULDER);
    push(12, [0.1, 0.0, 0.0], role::LEFT_UPPER_ARM);
    push(13, [0.25, 0.0, 0.0], role::LEFT_LOWER_ARM);
    push(14, [0.25, 0.0, 0.0], role::LEFT_HAND);
    push(3, [-0.08, 0.15, 0.0], role::RIGHT_SHOULDER);
    push(16, [-0.1, 0.0, 0.0], role::RIGHT_UPPER_ARM);
    push(17, [-0.25, 0.0, 0.0], role::RIGHT_LOWER_ARM);
    push(18, [-0.25, 0.0, 0.0], role::RIGHT_HAND);
    push(1, [0.0, 0.0, -0.1], none);
    push(20, [0.0, 0.0, -0.15], none);
    push(21, [0.0, 0.0, -0.15], none);
    push(22, [0.0, 0.0, -0.15], none);
    let free = JointRange {
        swing_y: 180.0,
        swing_z: 180.0,
        twist_min: -180.0,
        twist_max: 180.0,
    };
    let mut ranges = vec![free; bones.len()];
    ranges[b::L_SHIN as usize] = JointRange {
        swing_y: 0.0,
        swing_z: 0.0,
        twist_min: 0.0,
        twist_max: 0.0,
    };
    let skel = Skeleton {
        name: NONE,
        profile: NONE,
        mirror_axis: 0,
        strings: (0..bones.len()).map(|i| format!("bone{i}")).collect(),
        bones,
        roles: Some(roles),
        joint_ranges: Some(ranges),
        mirror: None,
    };
    let bytes = skel.write().unwrap();
    (skel, bytes)
}

/// A still clip over `skel` at 30 Hz: every bone at rest, the root curve moving along +Z at
/// `speed` m/s (bone 0 too), with cue markers.
pub fn still_clip(
    skel: &Skeleton,
    seconds: f64,
    looping: bool,
    speed: f64,
    cues: &[(&str, f32)],
) -> Vec<u8> {
    let rate = 30.0f64;
    let frames = (seconds * rate).round() as u32 + 1;
    let duration = (frames - 1) as f64 / rate;
    let mut tracks = Vec::new();
    for (i, bone) in skel.bones.iter().enumerate() {
        let mut raw = Vec::with_capacity(frames as usize * 10);
        for f in 0..frames {
            let t = f as f64 / rate;
            let mut p = bone.translation;
            if i == 0 {
                p[2] += (speed * t) as f32;
            }
            raw.extend_from_slice(&[
                p[0],
                p[1],
                p[2],
                bone.rotation[0],
                bone.rotation[1],
                bone.rotation[2],
                bone.rotation[3],
                1.0,
                1.0,
                1.0,
            ]);
        }
        tracks.push(Track {
            kind: TrackKind::Bone,
            flags: 0,
            subtype: 0,
            binding: Binding::bone(i as u32),
            raw,
            keys: Vec::new(),
        });
    }
    let mut strings: Vec<String> = Vec::new();
    let mut keys = Vec::new();
    for &(name, t) in cues {
        strings.push(name.into());
        keys.push(Key {
            time: t,
            end: t,
            data: KeyData::Marker {
                kind: MarkerKind::Cue,
                name: strings.len() as u32 - 1,
            },
        });
    }
    if !keys.is_empty() {
        tracks.push(Track {
            kind: TrackKind::Marker,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: Vec::new(),
            keys,
        });
    }
    let root_curve = (0..frames)
        .map(|f| [0.0, 0.0, (speed * f as f64 / rate) as f32, 0.0])
        .collect();
    Clip {
        flags: if looping { CLIP_LOOP } else { 0 },
        name: NONE,
        duration: duration as f32,
        sample_rate: rate as f32,
        frame_count: frames,
        bone_count: skel.bones.len() as u32,
        root_bone: 0,
        strings,
        tracks,
        has_raw: true,
        root_curve: Some(root_curve),
        compressed: None,
    }
    .write()
    .unwrap()
}

/// A rig parameter block: the head (weight, weight parameter, weight curve, LOD skip) then
/// `words`.
pub fn block(weight: f32, weight_param: u32, lod_skip: u32, words: &[u32]) -> Vec<u32> {
    let mut v = vec![0u32; head::WORDS];
    v[head::WEIGHT] = weight.to_bits();
    v[head::WEIGHT_PARAM] = weight_param;
    v[head::WEIGHT_CURVE] = NONE;
    v[head::LOD_SKIP] = lod_skip;
    v.extend_from_slice(words);
    v
}

/// A block of `len` words after the head, set through `f` (unset words are 0).
pub fn block_with(weight: f32, len: usize, f: impl FnOnce(&mut [u32])) -> Vec<u32> {
    let mut v = block(weight, NONE, 0, &vec![0; len]);
    f(&mut v);
    v
}

pub fn fb(x: f32) -> u32 {
    x.to_bits()
}

/// A role bone word.
pub fn r(x: u16) -> u32 {
    ROLE | x as u32
}

fn rig_row(h: u32) -> usize {
    (h & 0xFFFF) as usize * (wr::RIG_INPUT_STRIDE / 4) as usize
}

fn put3(core: &mut Core, at: usize, v: [f32; 3]) {
    let w = core.rig_inputs_mut();
    for k in 0..3 {
        w[at + k] = v[k].to_bits();
    }
}

/// Writes target slot `slot`.
pub fn set_target(core: &mut Core, h: u32, slot: usize, p: [f32; 3], q: [f32; 4], pw: f32, rw: f32, world: bool) {
    let at = rig_row(h) + ((wr::RIG_TARGETS + slot as u32 * wr::TARGET_STRIDE) / 4) as usize;
    put3(core, at + (wr::TARGET_POSITION / 4) as usize, p);
    let w = core.rig_inputs_mut();
    for k in 0..4 {
        w[at + (wr::TARGET_ROTATION / 4) as usize + k] = q[k].to_bits();
    }
    w[at + (wr::TARGET_POSITION_WEIGHT / 4) as usize] = pw.to_bits();
    w[at + (wr::TARGET_ROTATION_WEIGHT / 4) as usize] = rw.to_bits();
    w[at + (wr::TARGET_FLAGS / 4) as usize] = if world { wr::TARGET_WORLD } else { 0 };
}

/// Writes the character's transform (unit scale).
pub fn set_character(core: &mut Core, h: u32, p: [f32; 3], q: [f32; 4]) {
    let at = rig_row(h);
    put3(core, at + (wr::RIG_CHARACTER_POSITION / 4) as usize, p);
    let w = core.rig_inputs_mut();
    for k in 0..4 {
        w[at + (wr::RIG_CHARACTER_ROTATION / 4) as usize + k] = q[k].to_bits();
    }
}

pub fn set_rig_lod(core: &mut Core, h: u32, lod: u32) {
    let at = rig_row(h) + (wr::RIG_LOD / 4) as usize;
    core.rig_inputs_mut()[at] = lod;
}

/// Writes hit `i` (model space).
pub fn set_hit(core: &mut Core, h: u32, i: usize, point: [f32; 3], normal: [f32; 3], valid: bool) {
    let at = rig_row(h) + ((wr::RIG_HITS + i as u32 * wr::HIT_STRIDE) / 4) as usize;
    put3(core, at + (wr::HIT_POINT / 4) as usize, point);
    put3(core, at + (wr::HIT_NORMAL / 4) as usize, normal);
    core.rig_inputs_mut()[at + (wr::HIT_FLAGS / 4) as usize] = valid as u32 * wr::HIT_VALID;
}

/// A ray request: origin, direction, length, valid.
#[derive(Clone, Copy, Debug)]
pub struct Ray {
    pub origin: [f32; 3],
    pub direction: [f32; 3],
    pub length: f32,
    pub valid: bool,
}

/// Instance `h`'s ray requests.
pub fn rays(core: &Core, h: u32) -> Vec<Ray> {
    let row = (h & 0xFFFF) as usize * (wr::RAY_ROW_STRIDE / 4) as usize;
    let w = core.rig_rays();
    (0..wr::RIG_MAX_RAYS as usize)
        .map(|i| {
            let at = row + (i as u32 * wr::RAY_STRIDE / 4) as usize;
            let f = |k: u32| f32::from_bits(w[at + (k / 4) as usize]);
            let v = |k: u32| [f(k), f(k + 4), f(k + 8)];
            Ray {
                origin: v(wr::RAY_ORIGIN),
                direction: v(wr::RAY_DIRECTION),
                length: f(wr::RAY_LENGTH),
                valid: w[at + (wr::RAY_FLAGS / 4) as usize] & wr::RAY_VALID != 0,
            }
        })
        .collect()
}

/// Bone `bone`'s model position from instance `h`'s matrices (identity inverse binds).
pub fn pos(core: &Core, h: u32, max_bones: usize, bone: u16) -> [f32; 3] {
    let at = ((h & 0xFFFF) as usize * max_bones + bone as usize) * MATRIX_FLOATS as usize;
    let m = &core.matrices()[at..at + 12];
    [m[3], m[7], m[11]]
}

/// Bone `bone`'s model axis `axis` (0 X, 1 Y, 2 Z).
pub fn axis(core: &Core, h: u32, max_bones: usize, bone: u16, axis: usize) -> [f32; 3] {
    let at = ((h & 0xFFFF) as usize * max_bones + bone as usize) * MATRIX_FLOATS as usize;
    let m = &core.matrices()[at..at + 12];
    [m[axis], m[4 + axis], m[8 + axis]]
}

pub fn dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

pub fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn norm(a: [f32; 3]) -> [f32; 3] {
    let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    [a[0] / l, a[1] / l, a[2] / l]
}

pub fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `WARP_TARGET`.
pub fn warp(instance: u32, node: u32, p: [f32; 3], yaw: f32) -> Vec<u8> {
    let (s, c) = (0.5 * yaw).sin_cos();
    wr::WarpTarget {
        instance,
        node,
        px: p[0],
        py: p[1],
        pz: p[2],
        rx: 0.0,
        ry: s,
        rz: 0.0,
        rw: c,
        flags: 0,
    }
    .encode()
}

/// `RIG_RESET`.
pub fn reset(instance: u32, node: u32) -> Vec<u8> {
    wr::RigReset { instance, node }.encode()
}

/// The reference-pose source node.
pub fn rest_source(bld: &mut super::graph::Builder) -> u32 {
    bld.node(
        anim_format::graph::family::SOURCES,
        anim_graph::sources::kind::REFERENCE_POSE,
        &[],
        &[],
    )
}

/// A rig node of `kind` over `input`.
pub fn rig_node(bld: &mut super::graph::Builder, kind: u16, input: u32, params: &[u32]) -> u32 {
    bld.node(anim_format::graph::family::RIG, kind, &[input], params)
}
