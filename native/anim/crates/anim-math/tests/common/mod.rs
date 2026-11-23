//! Shared test helpers: a small deterministic PRNG (no dependency) and conversions from the f32
//! types to `anim-offline`'s f64 reference types.

#![allow(dead_code)]

use anim_math::{AosMat3x4, AosQuat, AosTransform, AosVec3, F32x4};
use anim_offline::math as r;

/// Unit roundoff of binary32, 2^-24. Error bounds below are stated in multiples of it.
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

    /// A unit quaternion (normalised in f64, then rounded), uniform-ish over the sphere, with
    /// either sign of `w`.
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

    /// Positive scale per axis in [0.25, 4), non-uniform.
    pub fn scale(&mut self) -> AosVec3 {
        self.vec3(0.25, 4.0)
    }

    pub fn transform(&mut self) -> AosTransform {
        AosTransform::new(self.vec3(-10.0, 10.0), self.quat(), self.scale())
    }

    /// A transform with uniform scale in [0.25, 4), negated with probability 1/4.
    pub fn uniform_transform(&mut self) -> AosTransform {
        let mut s = self.range(0.25, 4.0);
        if self.below(4) == 0 {
            s = -s;
        }
        AosTransform::new(self.vec3(-10.0, 10.0), self.quat(), AosVec3::new(s, s, s))
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

pub fn m64(m: AosMat3x4) -> r::Mat3x4 {
    r::Mat3x4 {
        m: m.m.map(|x| x as f64),
    }
}

/// Lanes of an F32x4 as f64.
pub fn lanes(x: F32x4) -> [f64; 4] {
    x.to_array().map(|v| v as f64)
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

/// Same rotation up to sign (q and −q).
#[track_caller]
pub fn close_rot(got: AosQuat, want: r::Quat, tol: f64, what: &str) {
    let want = if q64(got).dot(want) < 0.0 {
        -want
    } else {
        want
    };
    close_q(got, want, tol, what);
}

#[track_caller]
pub fn close_t(got: AosTransform, want: r::Transform, tol_t: f64, tol: f64, what: &str) {
    close_v(got.translation, want.translation, tol_t, what);
    close_rot(got.rotation, want.rotation, tol, what);
    close_v(got.scale, want.scale, tol, what);
}

/// Groups of four random items, as SoA input plus the AoS lanes.
pub fn four<T: Copy>(mut f: impl FnMut() -> T) -> [T; 4] {
    [f(), f(), f(), f()]
}
