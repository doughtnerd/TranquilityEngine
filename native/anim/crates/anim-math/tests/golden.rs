//! Golden hash: a fixed run of every operation, hashed over the output bits.
//!
//! The expected value was recorded natively (portable lanes). The same test built for `wasm32` +
//! `simd128` (see `wasm-test-runner.mjs`) must give the same hash, which proves the SIMD path and
//! the portable path agree bit for bit. Any change to an operation's order or constants changes
//! the hash: that is a determinism change (client and server must update together), so update
//! the constant only on purpose and say so in the change.

mod common;

use anim_math::layout::{local_to_model, pack_pose, soa_len, NO_PARENT};
use anim_math::trig::{atan2, sin_cos};
use anim_math::{quant, AosTransform, F32x4, SoaMat3x4, SoaQuat, SoaTransform, SoaVec3};
use common::*;

/// FNV-1a over 32-bit words.
struct Hash(u64);

impl Hash {
    fn word(&mut self, w: u32) {
        for b in w.to_le_bytes() {
            self.0 ^= b as u64;
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn f(&mut self, x: F32x4) {
        for w in x.to_bits_array() {
            self.word(w);
        }
    }
    fn v(&mut self, v: SoaVec3) {
        self.f(v.x);
        self.f(v.y);
        self.f(v.z);
    }
    fn q(&mut self, q: SoaQuat) {
        self.f(q.x);
        self.f(q.y);
        self.f(q.z);
        self.f(q.w);
    }
    fn t(&mut self, t: SoaTransform) {
        self.v(t.translation);
        self.q(t.rotation);
        self.v(t.scale);
    }
}

const GOLDEN: u64 = 0xf427_a160_781a_5068;

#[test]
fn every_operation_hashes_to_the_recorded_value() {
    let mut rng = Rng::new(0x5eed);
    let mut h = Hash(0xcbf2_9ce4_8422_2325);
    for _ in 0..500 {
        let a = SoaVec3::from_aos(&four(|| rng.vec3(-10.0, 10.0)));
        let b = SoaVec3::from_aos(&four(|| rng.vec3(-10.0, 10.0)));
        let qa = SoaQuat::from_aos(&four(|| rng.quat()));
        let qb = SoaQuat::from_aos(&four(|| rng.quat()));
        let ta = SoaTransform::from_aos(&four(|| rng.transform()));
        let tb = SoaTransform::from_aos(&four(|| rng.transform()));
        let t = F32x4::from_array(four(|| rng.unit()));
        let x = F32x4::from_array(four(|| rng.range(-50.0, 50.0)));

        h.v(a + b);
        h.v(a - b);
        h.v(a * b);
        h.v(a.scale(x));
        h.f(a.dot(b));
        h.v(a.cross(b));
        h.f(a.length());
        h.v(a.normalize_or(SoaVec3::zero()));
        h.v(a.lerp(b, t));
        h.q(qa * qb);
        h.q(qa.conjugate());
        h.q(qa.nlerp(qb, t));
        h.q(qa.slerp(qb, t));
        h.v(qa.rotate(a));
        h.q(SoaQuat::from_axis_angle(a.normalize_or(SoaVec3::zero()), x));
        let (axis, angle) = qa.to_axis_angle();
        h.v(axis);
        h.f(angle);
        h.t(ta.compose(tb));
        h.t(ta.inverse());
        h.v(ta.transform_point(b));
        h.v(ta.transform_vector(b));
        let m = SoaMat3x4::from_transform(ta);
        for e in (m * SoaMat3x4::from_transform(tb)).m {
            h.f(e);
        }
        for e in m.inverse_or(SoaMat3x4::identity()).m {
            h.f(e);
        }
        h.v(m.transform_point(b));
        let (s, c) = sin_cos(x);
        h.f(s);
        h.f(c);
        h.f(atan2(x, a.x));
        for bits in [3u32, 10, 16, 19, 23] {
            let max = quant::unorm_max(bits) as u64 + 1;
            let codes: [u32; 4] = core::array::from_fn(|_| rng.below(max) as u32);
            h.f(quant::unpack_range4(codes, bits, x, t));
        }
    }
    // A 9-bone hierarchy (one padded group) through local→model.
    let parents = [NO_PARENT, 0, 1, 2, 1, 4, 0, 6, 7];
    let local: Vec<AosTransform> = (0..9).map(|_| rng.transform()).collect();
    let mut soa = [SoaTransform::identity(); soa_len(9)];
    pack_pose(&local, &mut soa);
    let mut model = [AosTransform::identity(); 9];
    local_to_model(&parents, &soa, &mut model);
    for m in model {
        h.t(SoaTransform::from_aos(&[m; 4]));
    }
    assert_eq!(h.0, GOLDEN, "golden hash changed: {:#018x}", h.0);
}
