//! Shared test fixtures: small skeletons, a pose holder, conversions to `anim-offline`'s f64
//! types, and comparison helpers.

#![allow(dead_code)]

use anim_math::layout::{pack_pose, soa_len, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_offline::math as r;
use anim_pose::model::model_space;
use anim_rig::RigPose;

/// A skeleton's parents, its local pose (SoA) and the model-space cache.
pub struct Rig {
    pub parents: Vec<u16>,
    pub local: Vec<SoaTransform>,
    pub model: Vec<AosTransform>,
}

impl Rig {
    pub fn new(parents: Vec<u16>, locals: &[AosTransform]) -> Self {
        assert_eq!(parents.len(), locals.len());
        let mut local = vec![SoaTransform::identity(); soa_len(locals.len())];
        pack_pose(locals, &mut local);
        let mut model = vec![AosTransform::identity(); locals.len()];
        model_space(&parents, &local, &mut model);
        Self {
            parents,
            local,
            model,
        }
    }

    pub fn pose(&mut self) -> RigPose<'_> {
        RigPose::new(&self.parents, &mut self.local, &mut self.model)
    }

    pub fn pos(&self, i: usize) -> AosVec3 {
        self.model[i].translation
    }

    pub fn rot(&self, i: usize) -> AosQuat {
        self.model[i].rotation
    }

    pub fn local(&self, i: usize) -> AosTransform {
        anim_pose::bone(&self.local, i)
    }

    pub fn locals(&self) -> Vec<AosTransform> {
        (0..self.parents.len()).map(|i| self.local(i)).collect()
    }

    /// The model cache recomputed from scratch (to check the lazy cache).
    pub fn fresh_model(&self) -> Vec<AosTransform> {
        let mut m = vec![AosTransform::identity(); self.parents.len()];
        model_space(&self.parents, &self.local, &mut m);
        m
    }

    pub fn clone_rig(&self) -> Rig {
        Rig {
            parents: self.parents.clone(),
            local: self.local.clone(),
            model: self.model.clone(),
        }
    }
}

pub fn v3(x: f32, y: f32, z: f32) -> AosVec3 {
    AosVec3::new(x, y, z)
}

pub fn tr(x: f32, y: f32, z: f32) -> AosTransform {
    AosTransform::new(v3(x, y, z), AosQuat::identity(), AosVec3::one())
}

pub fn trq(x: f32, y: f32, z: f32, q: AosQuat) -> AosTransform {
    AosTransform::new(v3(x, y, z), q, AosVec3::one())
}

pub fn axis_angle(x: f32, y: f32, z: f32, deg: f32) -> AosQuat {
    let l = (x * x + y * y + z * z).sqrt();
    AosQuat::from_axis_angle(v3(x / l, y / l, z / l), deg.to_radians())
}

pub fn v64(v: AosVec3) -> r::Vec3 {
    r::Vec3::new(v.x as f64, v.y as f64, v.z as f64)
}

pub fn q64(q: AosQuat) -> r::Quat {
    r::Quat::new(q.x as f64, q.y as f64, q.z as f64, q.w as f64)
}

pub fn t64(t: AosTransform) -> r::Transform {
    r::Transform {
        translation: v64(t.translation),
        rotation: q64(t.rotation),
        scale: v64(t.scale),
    }
}

pub fn dist(a: AosVec3, b: AosVec3) -> f32 {
    (a - b).length()
}

pub fn dist64(a: AosVec3, b: r::Vec3) -> f64 {
    (v64(a) - b).length()
}

/// The angle in radians between two rotations (0 for `q` and `−q`).
pub fn quat_angle(a: AosQuat, b: AosQuat) -> f32 {
    let d = (a.conjugate() * b).normalize_or_identity();
    anim_rig::geom::rotation_angle(d)
}

pub fn quat_angle64(a: AosQuat, b: r::Quat) -> f64 {
    let a = q64(a);
    let d = a.dot(b).abs().min(1.0);
    2.0 * d.acos()
}

pub fn assert_close(a: AosVec3, b: AosVec3, tol: f32, what: &str) {
    let d = dist(a, b);
    assert!(d <= tol, "{what}: {a:?} vs {b:?} (distance {d}, tolerance {tol})");
}

pub fn assert_finite(rig: &Rig) {
    for (i, m) in rig.model.iter().enumerate() {
        let ok = [
            m.translation.x,
            m.translation.y,
            m.translation.z,
            m.rotation.x,
            m.rotation.y,
            m.rotation.z,
            m.rotation.w,
        ]
        .iter()
        .all(|v| v.is_finite());
        assert!(ok, "bone {i} not finite: {m:?}");
    }
}

pub fn same_pose(a: &Rig, b: &Rig) -> bool {
    a.locals().iter().zip(b.locals().iter()).all(|(x, y)| {
        x.translation.x.to_bits() == y.translation.x.to_bits()
            && x.translation.y.to_bits() == y.translation.y.to_bits()
            && x.translation.z.to_bits() == y.translation.z.to_bits()
            && x.rotation.x.to_bits() == y.rotation.x.to_bits()
            && x.rotation.y.to_bits() == y.rotation.y.to_bits()
            && x.rotation.z.to_bits() == y.rotation.z.to_bits()
            && x.rotation.w.to_bits() == y.rotation.w.to_bits()
    })
}

/// An arm: 0 base (root, at the origin), 1 upper arm, 2 forearm (1 along +X, bent 20° about
/// +Z, so the arm bends in the XY plane), 3 hand (1 along +X).
pub fn arm() -> Rig {
    Rig::new(
        vec![NO_PARENT, 0, 1, 2],
        &[
            tr(0.0, 0.0, 0.0),
            tr(0.0, 0.0, 0.0),
            trq(1.0, 0.0, 0.0, axis_angle(0.0, 0.0, 1.0, 20.0)),
            tr(1.0, 0.0, 0.0),
        ],
    )
}

/// A straight arm (a singular configuration).
pub fn straight_arm() -> Rig {
    Rig::new(
        vec![NO_PARENT, 0, 1, 2],
        &[
            tr(0.0, 0.0, 0.0),
            tr(0.0, 0.0, 0.0),
            tr(1.0, 0.0, 0.0),
            tr(1.0, 0.0, 0.0),
        ],
    )
}

/// A chain of `n` bones of length `len` along +X, each bent `bend_deg` about +Z, under a root at
/// the origin. Bone 0 is the root; the chain is bones 1..=n (the last is the tip).
pub fn bent_chain(n: usize, len: f32, bend_deg: f32) -> Rig {
    let mut parents = vec![NO_PARENT];
    let mut locals = vec![tr(0.0, 0.0, 0.0)];
    for i in 0..n {
        parents.push(i as u16);
        let t = if i == 0 { 0.0 } else { len };
        locals.push(trq(t, 0.0, 0.0, axis_angle(0.0, 0.0, 1.0, bend_deg)));
    }
    Rig::new(parents, &locals)
}

/// A biped's lower body: 0 pelvis at (0, 1, 0); legs 1 thigh (x = ±0.1), 2 shin (0.45 down, knee
/// bent 10° about X), 3 foot (0.45 down) for the left (1..=3) and right (4..=6) leg.
pub fn legs() -> Rig {
    let knee = axis_angle(1.0, 0.0, 0.0, 10.0);
    let unknee = axis_angle(1.0, 0.0, 0.0, -10.0);
    Rig::new(
        vec![NO_PARENT, 0, 1, 2, 0, 4, 5],
        &[
            tr(0.0, 1.0, 0.0),
            trq(0.1, 0.0, 0.0, axis_angle(1.0, 0.0, 0.0, -5.0)),
            trq(0.0, -0.45, 0.0, knee),
            trq(0.0, -0.45, 0.0, unknee),
            trq(-0.1, 0.0, 0.0, axis_angle(1.0, 0.0, 0.0, -5.0)),
            trq(0.0, -0.45, 0.0, knee),
            trq(0.0, -0.45, 0.0, unknee),
        ],
    )
}

/// A small humanoid: 0 hips, 1 spine, 2 chest, 3 neck, 4 head, 5–7 left arm, 8–10 right arm,
/// 11–13 left leg, 14–16 right leg.
pub fn humanoid() -> Rig {
    let elbow = axis_angle(0.0, 1.0, 0.0, 15.0);
    let knee = axis_angle(1.0, 0.0, 0.0, 10.0);
    let unknee = axis_angle(1.0, 0.0, 0.0, -10.0);
    Rig::new(
        vec![
            NO_PARENT, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15,
        ],
        &[
            tr(0.0, 1.0, 0.0),
            tr(0.0, 0.15, 0.0),
            tr(0.0, 0.2, 0.0),
            tr(0.0, 0.15, 0.0),
            tr(0.0, 0.1, 0.0),
            tr(0.18, 0.05, 0.0),
            trq(0.28, 0.0, 0.0, elbow),
            tr(0.25, 0.0, 0.0),
            tr(-0.18, 0.05, 0.0),
            trq(-0.28, 0.0, 0.0, elbow.conjugate()),
            tr(-0.25, 0.0, 0.0),
            trq(0.1, -0.05, 0.0, axis_angle(1.0, 0.0, 0.0, -5.0)),
            trq(0.0, -0.45, 0.0, knee),
            trq(0.0, -0.45, 0.0, unknee),
            trq(-0.1, -0.05, 0.0, axis_angle(1.0, 0.0, 0.0, -5.0)),
            trq(0.0, -0.45, 0.0, knee),
            trq(0.0, -0.45, 0.0, unknee),
        ],
    )
}
