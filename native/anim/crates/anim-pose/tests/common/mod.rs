//! Shared test helpers: a deterministic PRNG (no dependency), random poses, and conversions from
//! the f32 types to `anim-offline`'s f64 reference types.

#![allow(dead_code)]

use anim_math::layout::{pack_pose, soa_len};
use anim_math::{AosMat3x4, AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_offline::math as r;

/// Unit roundoff of binary32, 2^-24. Error bounds are stated in multiples of it.
pub const U: f64 = 1.0 / 16_777_216.0;

/// SplitMix64: deterministic, seedable, good enough for property tests.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// Uniform in [lo, hi).
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }

    pub fn vec3(&mut self, lo: f32, hi: f32) -> AosVec3 {
        AosVec3::new(self.range(lo, hi), self.range(lo, hi), self.range(lo, hi))
    }

    /// A unit quaternion (normalised in f64, then rounded), with either sign of `w`.
    pub fn quat(&mut self) -> AosQuat {
        loop {
            let v = [
                self.range(-1.0, 1.0) as f64,
                self.range(-1.0, 1.0) as f64,
                self.range(-1.0, 1.0) as f64,
                self.range(-1.0, 1.0) as f64,
            ];
            let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] + v[3] * v[3]).sqrt();
            if l > 0.1 && l <= 1.0 {
                return AosQuat::new(
                    (v[0] / l) as f32,
                    (v[1] / l) as f32,
                    (v[2] / l) as f32,
                    (v[3] / l) as f32,
                );
            }
        }
    }

    /// A rotation of up to `max_angle` radians about a random axis (near identity).
    pub fn small_quat(&mut self, max_angle: f32) -> AosQuat {
        let axis = loop {
            let v = self.vec3(-1.0, 1.0);
            let l = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
            if l > 0.1 && l <= 1.0 {
                break v.scale(1.0 / l);
            }
        };
        AosQuat::from_axis_angle(axis, self.range(0.0, max_angle))
    }

    /// Translation in [-10, 10], any rotation, scale per axis in [0.5, 2].
    pub fn transform(&mut self) -> AosTransform {
        AosTransform::new(self.vec3(-10.0, 10.0), self.quat(), self.vec3(0.5, 2.0))
    }

    pub fn pose(&mut self, n: usize) -> Vec<AosTransform> {
        (0..n).map(|_| self.transform()).collect()
    }

    /// A pose a small step away from `p` (what the previous frame looks like).
    pub fn nearby(&mut self, p: &[AosTransform]) -> Vec<AosTransform> {
        p.iter()
            .map(|t| {
                let d = self.vec3(-0.05, 0.05);
                AosTransform::new(
                    t.translation + d,
                    (self.small_quat(0.05) * t.rotation).normalize_or_identity(),
                    t.scale,
                )
            })
            .collect()
    }
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

pub fn pose64(p: &[AosTransform]) -> Vec<r::Transform> {
    p.iter().map(|&t| t64(t)).collect()
}

pub fn m64(m: AosMat3x4) -> r::Mat3x4 {
    r::Mat3x4 {
        m: m.m.map(|x| x as f64),
    }
}

/// An AoS pose as SoA groups (spare lanes identity).
pub fn soa(p: &[AosTransform]) -> Vec<SoaTransform> {
    let mut out = vec![SoaTransform::identity(); soa_len(p.len())];
    pack_pose(p, &mut out);
    out
}

/// Bone count `n` as SoA groups of identity.
pub fn soa_identity(n: usize) -> Vec<SoaTransform> {
    vec![SoaTransform::identity(); soa_len(n)]
}

pub fn unsoa(p: &[SoaTransform], n: usize) -> Vec<AosTransform> {
    let mut out = vec![AosTransform::identity(); n];
    anim_math::layout::unpack_pose(p, &mut out);
    out
}

#[track_caller]
pub fn close(got: f64, want: f64, tol: f64, what: &str) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: got {got}, want {want}, |err| {} > tol {tol}",
        (got - want).abs()
    );
}

#[track_caller]
pub fn close_v(got: AosVec3, want: r::Vec3, tol: f64, what: &str) {
    close(got.x as f64, want.x, tol, what);
    close(got.y as f64, want.y, tol, what);
    close(got.z as f64, want.z, tol, what);
}

#[track_caller]
pub fn close_q(got: AosQuat, want: r::Quat, tol: f64, what: &str) {
    close(got.x as f64, want.x, tol, what);
    close(got.y as f64, want.y, tol, what);
    close(got.z as f64, want.z, tol, what);
    close(got.w as f64, want.w, tol, what);
}

/// Same rotation up to sign (q and -q).
#[track_caller]
pub fn close_rot(got: AosQuat, want: r::Quat, tol: f64, what: &str) {
    let want = if q64(got).dot(want) < 0.0 {
        -want
    } else {
        want
    };
    close_q(got, want, tol, what);
}

/// Tolerances: translation, rotation (components), scale.
#[derive(Clone, Copy)]
pub struct Tol {
    pub t: f64,
    pub r: f64,
    pub s: f64,
}

#[track_caller]
pub fn close_t(got: AosTransform, want: r::Transform, tol: Tol, what: &str) {
    close_v(got.translation, want.translation, tol.t, what);
    close_rot(got.rotation, want.rotation, tol.r, what);
    close_v(got.scale, want.scale, tol.s, what);
}

#[track_caller]
pub fn close_pose(got: &[AosTransform], want: &[r::Transform], tol: Tol, what: &str) {
    assert_eq!(got.len(), want.len());
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        close_t(*g, *w, tol, &format!("{what}[{i}]"));
    }
}

pub fn bits_v(v: AosVec3) -> [u32; 3] {
    [v.x.to_bits(), v.y.to_bits(), v.z.to_bits()]
}

pub fn bits_q(q: AosQuat) -> [u32; 4] {
    [q.x.to_bits(), q.y.to_bits(), q.z.to_bits(), q.w.to_bits()]
}

pub fn bits_t(t: AosTransform) -> [u32; 10] {
    let (a, b, c) = (bits_v(t.translation), bits_q(t.rotation), bits_v(t.scale));
    [a[0], a[1], a[2], b[0], b[1], b[2], b[3], c[0], c[1], c[2]]
}

#[track_caller]
pub fn assert_bits_eq(a: &[AosTransform], b: &[AosTransform], what: &str) {
    assert_eq!(a.len(), b.len());
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        assert_eq!(bits_t(*x), bits_t(*y), "{what}: bone {i}");
    }
}

/// Spare lanes of the last group must still be identity (to 1e-6: a blend's normalised weights
/// can sum to one ulp under 1). Nothing reads them back.
#[track_caller]
pub fn assert_padding_identity(p: &[SoaTransform], n: usize, what: &str) {
    let id = AosTransform::identity();
    for i in n..p.len() * 4 {
        let t = p[i / 4].lane(i % 4);
        let pairs = [
            (t.translation.x, id.translation.x),
            (t.translation.y, id.translation.y),
            (t.translation.z, id.translation.z),
            (t.rotation.x, id.rotation.x),
            (t.rotation.y, id.rotation.y),
            (t.rotation.z, id.rotation.z),
            (t.rotation.w, id.rotation.w),
            (t.scale.x, id.scale.x),
            (t.scale.y, id.scale.y),
            (t.scale.z, id.scale.z),
        ];
        for (got, want) in pairs {
            assert!(
                (got - want).abs() <= 1e-6,
                "{what}: padding lane {i} must stay identity, got {t:?}"
            );
        }
    }
}
