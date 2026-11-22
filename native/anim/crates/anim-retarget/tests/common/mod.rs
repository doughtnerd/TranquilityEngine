//! Shared fixtures: humanoid skeletons built from model-space joint positions, with a choice of
//! bone-axis convention, arm rest pose, proportions and spine bone count; pose helpers; and
//! conversions to `anim-offline`'s f64 types.

#![allow(dead_code)]

use anim_math::layout::{local_to_model, pack_pose, soa_len, unpack_pose, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_offline::math as r;
use anim_retarget::{guess_bone_map, BoneMap, Profile, Side, Skeleton};

pub fn v(x: f32, y: f32, z: f32) -> AosVec3 {
    AosVec3::new(x, y, z)
}

pub fn q(axis: AosVec3, angle: f32) -> AosQuat {
    let a = axis.scale(1.0 / axis.length());
    let (s, c) = ((angle * 0.5).sin(), (angle * 0.5).cos());
    AosQuat::new(a.x * s, a.y * s, a.z * s, c)
}

/// How each bone's local axes sit relative to the bone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Axes {
    /// Every rest rotation identity (axes = model axes).
    Model,
    /// Local +Y points down the bone (Blender, Mixamo), with a per-bone roll.
    YAlong,
    /// Local +X points down the bone (Maya, Unreal).
    XAlong,
}

/// Fixture options.
#[derive(Clone, Copy, Debug)]
pub struct Build {
    pub axes: Axes,
    /// Arm angle below horizontal at rest, radians (0: T-pose).
    pub arm_drop: f32,
    /// Leg length scale (hips height ≈ 1.0 · leg).
    pub leg: f32,
    /// Upper body scale.
    pub body: f32,
    /// Spine bones between hips and neck (Spine, Spine1, Spine2… names).
    pub spine: usize,
}

impl Default for Build {
    fn default() -> Self {
        Build {
            axes: Axes::Model,
            arm_drop: 0.0,
            leg: 1.0,
            body: 1.0,
            spine: 3,
        }
    }
}

/// A skeleton: names, parents, rest locals and rest model positions.
pub struct Rig {
    pub names: Vec<String>,
    pub parents: Vec<u16>,
    pub rest: Vec<AosTransform>,
    pub map: BoneMap,
}

impl Rig {
    pub fn index(&self, name: &str) -> usize {
        self.names.iter().position(|n| n == name).unwrap_or_else(|| panic!("no bone {name}"))
    }
    pub fn n(&self) -> usize {
        self.names.len()
    }
    pub fn skeleton(&self) -> Skeleton<'_> {
        Skeleton {
            parents: &self.parents,
            rest: &self.rest,
        }
    }
    pub fn side<'a>(&'a self, profile: &'a Profile) -> Side<'a> {
        Side {
            skeleton: self.skeleton(),
            profile,
            map: &self.map,
        }
    }
    pub fn rest_model(&self) -> Vec<AosTransform> {
        model(&self.parents, &self.rest)
    }
}

pub fn soa(p: &[AosTransform]) -> Vec<SoaTransform> {
    let mut s = vec![SoaTransform::identity(); soa_len(p.len())];
    pack_pose(p, &mut s);
    s
}

pub fn aos(s: &[SoaTransform], n: usize) -> Vec<AosTransform> {
    let mut a = vec![AosTransform::identity(); n];
    unpack_pose(s, &mut a);
    a
}

pub fn model(parents: &[u16], local: &[AosTransform]) -> Vec<AosTransform> {
    let mut m = vec![AosTransform::identity(); local.len()];
    local_to_model(parents, &soa(local), &mut m);
    m
}

/// A rotation whose local `axis` (X or Y) points along unit `dir`, rolled by `roll` about it.
fn frame(axes: Axes, dir: AosVec3, roll: f32) -> AosQuat {
    let from = match axes {
        Axes::Model => return AosQuat::identity(),
        Axes::YAlong => v(0.0, 1.0, 0.0),
        Axes::XAlong => v(1.0, 0.0, 0.0),
    };
    let d = from.dot(dir);
    let base = if d < -0.9999 {
        AosQuat::new(0.0, 0.0, 1.0, 0.0)
    } else {
        let c = from.cross(dir);
        AosQuat::new(c.x, c.y, c.z, 1.0 + d).normalize_or_identity()
    };
    (base * q(from, roll)).normalize_or_identity()
}

/// Builds a rig from `(name, parent name, model position)` rows; each bone's rest rotation follows
/// `axes`, pointing at its first child (or continuing its parent's direction for a leaf).
pub fn rig_from(rows: &[(String, Option<String>, AosVec3)], axes: Axes) -> Rig {
    let n = rows.len();
    let names: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let parents: Vec<u16> = rows
        .iter()
        .map(|r| match &r.1 {
            None => NO_PARENT,
            Some(p) => names.iter().position(|x| x == p).unwrap() as u16,
        })
        .collect();
    let pos: Vec<AosVec3> = rows.iter().map(|r| r.2).collect();
    let mut rot = vec![AosQuat::identity(); n];
    for i in 0..n {
        let child = (0..n).find(|&c| parents[c] == i as u16);
        let dir = match child {
            Some(c) => pos[c] - pos[i],
            None if parents[i] != NO_PARENT => pos[i] - pos[parents[i] as usize],
            None => v(0.0, 1.0, 0.0),
        };
        let dir = if dir.length() > 1e-6 { dir.scale(1.0 / dir.length()) } else { v(0.0, 1.0, 0.0) };
        rot[i] = frame(axes, dir, 0.3 * i as f32);
    }
    let rest = (0..n)
        .map(|i| {
            let (pp, pr) = if parents[i] == NO_PARENT {
                (v(0.0, 0.0, 0.0), AosQuat::identity())
            } else {
                (pos[parents[i] as usize], rot[parents[i] as usize])
            };
            AosTransform::new(
                pr.conjugate().rotate(pos[i] - pp),
                (pr.conjugate() * rot[i]).normalize_or_identity(),
                AosVec3::one(),
            )
        })
        .collect();
    let names_ref: Vec<&str> = names.iter().map(String::as_str).collect();
    let map = guess_bone_map(&names_ref, &parents, &Profile::humanoid());
    Rig {
        names,
        parents,
        rest,
        map,
    }
}

/// A Mixamo-named humanoid (index and thumb fingers only).
pub fn humanoid(b: Build) -> Rig {
    let s = |x: &str| x.to_string();
    let l = b.leg;
    let k = b.body;
    let mut rows: Vec<(String, Option<String>, AosVec3)> = Vec::new();
    rows.push((s("Hips"), None, v(0.0, l, 0.0)));
    let mut prev = s("Hips");
    let spine_top = l + 0.45 * k;
    let mut spine_names = Vec::new();
    for i in 0..b.spine {
        let name = if i == 0 { s("Spine") } else { format!("Spine{i}") };
        let y = l + 0.1 * k + (0.35 * k) * i as f32 / (b.spine.max(2) - 1) as f32;
        let y = if b.spine == 1 { l + 0.25 * k } else { y };
        rows.push((name.clone(), Some(prev.clone()), v(0.0, y, 0.0)));
        prev = name.clone();
        spine_names.push(name);
    }
    let chest = prev.clone();
    rows.push((s("Neck"), Some(chest.clone()), v(0.0, spine_top + 0.12 * k, 0.0)));
    rows.push((s("Head"), Some(s("Neck")), v(0.0, spine_top + 0.22 * k, 0.0)));
    for (side, sx) in [("Left", 1.0f32), ("Right", -1.0f32)] {
        let n = |x: &str| format!("{side}{x}");
        let sh = v(0.05 * sx * k, spine_top + 0.05 * k, 0.0);
        let ua = v(0.17 * sx * k, spine_top + 0.05 * k, 0.0);
        let dir = v(sx * b.arm_drop.cos(), -b.arm_drop.sin(), 0.0);
        // A slight elbow bend backwards gives two-bone IK a bend plane.
        let fa = ua + dir.scale(0.28 * k) + v(0.0, 0.0, -0.02 * k);
        let hd = fa + dir.scale(0.26 * k) + v(0.0, 0.0, 0.02 * k);
        rows.push((n("Shoulder"), Some(chest.clone()), sh));
        rows.push((n("Arm"), Some(n("Shoulder")), ua));
        rows.push((n("ForeArm"), Some(n("Arm")), fa));
        rows.push((n("Hand"), Some(n("ForeArm")), hd));
        let mut p = n("Hand");
        for i in 1..=3 {
            let name = n(&format!("HandIndex{i}"));
            rows.push((name.clone(), Some(p.clone()), hd + dir.scale(0.06 * k + 0.03 * k * i as f32)));
            p = name;
        }
        let mut p = n("Hand");
        for i in 1..=3 {
            let name = n(&format!("HandThumb{i}"));
            rows.push((
                name.clone(),
                Some(p.clone()),
                hd + dir.scale(0.02 * k * i as f32) + v(0.0, 0.0, 0.03 * k * i as f32),
            ));
            p = name;
        }
        let ul = v(0.1 * sx, l - 0.03, 0.0);
        let ll = v(0.1 * sx, l * 0.52, 0.03 * l);
        let ft = v(0.1 * sx, 0.08 * l, 0.0);
        rows.push((n("UpLeg"), Some(s("Hips")), ul));
        rows.push((n("Leg"), Some(n("UpLeg")), ll));
        rows.push((n("Foot"), Some(n("Leg")), ft));
        rows.push((n("ToeBase"), Some(n("Foot")), ft + v(0.0, -0.06 * l, 0.12 * l)));
    }
    rig_from(&rows, b.axes)
}

/// A deterministic pseudo-random generator.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407))
    }
    pub fn unit(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.unit()
    }
    pub fn rot(&mut self, max: f32) -> AosQuat {
        let axis = v(self.range(-1.0, 1.0), self.range(-1.0, 1.0), self.range(-1.0, 1.0) + 0.01);
        q(axis, self.range(-max, max))
    }
}

/// A random pose of `rig`: each bone's rest local turned by up to `max` radians, the hips moved.
pub fn random_pose(rig: &Rig, rng: &mut Rng, max: f32) -> Vec<AosTransform> {
    let mut p = rig.rest.clone();
    for t in p.iter_mut() {
        t.rotation = (t.rotation * rng.rot(max)).normalize_or_identity();
    }
    p[0].translation = p[0].translation + v(rng.range(-0.3, 0.3), rng.range(-0.1, 0.1), rng.range(-0.3, 0.3));
    p
}

/// Whether `a` and `b` are the same rotation within `tol` per component (`q` and `-q` alike).
pub fn quat_close(a: AosQuat, b: AosQuat, tol: f32) -> bool {
    let b = if a.dot(b) < 0.0 { -b } else { b };
    [a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w].iter().all(|d| d.abs() <= tol)
}

// ---- f64 conversions -----------------------------------------------------------------------

pub fn t64(t: AosTransform) -> r::Transform {
    r::Transform {
        translation: r::Vec3::new(t.translation.x as f64, t.translation.y as f64, t.translation.z as f64),
        rotation: r::Quat::new(t.rotation.x as f64, t.rotation.y as f64, t.rotation.z as f64, t.rotation.w as f64),
        scale: r::Vec3::new(t.scale.x as f64, t.scale.y as f64, t.scale.z as f64),
    }
}

pub fn p64(p: &[AosTransform]) -> Vec<r::Transform> {
    p.iter().map(|&t| t64(t)).collect()
}

pub fn v64(a: AosVec3) -> r::Vec3 {
    r::Vec3::new(a.x as f64, a.y as f64, a.z as f64)
}
