//! Bit-for-bit agreement between the SoA path (`F32x4` lanes) and the scalar AoS path (`f32`),
//! for every pose-level function that is generic over the lane type.
//!
//! Natively `F32x4` is the portable fallback, so this checks that it runs exactly the scalar
//! operations. Built for `wasm32` with `simd128` (see `anim-math/wasm-test-runner.mjs`) `F32x4` is
//! `v128` and the AoS path is scalar wasm `f32`, so the same test checks the SIMD path against
//! scalar code.

mod common;

use anim_math::layout::soa_len;
use anim_math::{AosTransform, F32x4, SoaTransform};
use anim_pose::additive::{apply_additive, apply_additive_masked, make_additive};
use anim_pose::blend::{blend, blend_masked, lerp, pack_mask};
use common::*;

const CASES: usize = 1_000;

fn bone_count(rng: &mut Rng) -> usize {
    1 + rng.below(11) as usize
}

fn weights(rng: &mut Rng, k: usize) -> Vec<f32> {
    (0..k)
        .map(|_| match rng.below(6) {
            0 => 0.0,
            1 => -rng.unit(),
            _ => rng.range(0.05, 3.0),
        })
        .collect()
}

#[test]
fn lerp_soa_equals_scalar() {
    let mut rng = Rng::new(30);
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let (a, b) = (rng.pose(n), rng.pose(n));
        let t = rng.range(-0.2, 1.2);
        let mut s = soa_identity(n);
        lerp(&soa(&a), &soa(&b), t, &mut s);
        let mut aos = vec![AosTransform::identity(); n];
        lerp(&a, &b, t, &mut aos);
        assert_bits_eq(&unsoa(&s, n), &aos, "lerp");
    }
}

#[test]
fn blend_soa_equals_scalar() {
    let mut rng = Rng::new(31);
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let k = 1 + rng.below(5) as usize;
        let poses: Vec<Vec<AosTransform>> = (0..k).map(|_| rng.pose(n)).collect();
        let w = weights(&mut rng, k);
        let rest = rng.pose(n);
        let soas: Vec<Vec<SoaTransform>> = poses.iter().map(|p| soa(p)).collect();
        let sref: Vec<&[SoaTransform]> = soas.iter().map(|p| p.as_slice()).collect();
        let mut s = soa_identity(n);
        blend(&sref, &w, &soa(&rest), &mut s);
        let aref: Vec<&[AosTransform]> = poses.iter().map(|p| p.as_slice()).collect();
        let mut aos = vec![AosTransform::identity(); n];
        blend(&aref, &w, &rest, &mut aos);
        assert_bits_eq(&unsoa(&s, n), &aos, "blend");
    }
}

#[test]
fn masked_blend_soa_equals_scalar() {
    let mut rng = Rng::new(32);
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let (base, layer) = (rng.pose(n), rng.pose(n));
        let mask: Vec<f32> = (0..n)
            .map(|_| if rng.below(3) == 0 { 0.0 } else { rng.unit() })
            .collect();
        let w = rng.range(0.0, 1.0);
        let mut packed = vec![F32x4::splat(0.0); soa_len(n)];
        pack_mask(&mask, &mut packed);
        let mut s = soa_identity(n);
        blend_masked(&soa(&base), &soa(&layer), &packed, w, &mut s);
        let mut aos = vec![AosTransform::identity(); n];
        blend_masked(&base, &layer, &mask, w, &mut aos);
        assert_bits_eq(&unsoa(&s, n), &aos, "masked blend");
    }
}

#[test]
fn additive_soa_equals_scalar() {
    let mut rng = Rng::new(33);
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let (pose, reference, base) = (rng.pose(n), rng.pose(n), rng.pose(n));
        let w = rng.range(-0.5, 1.5);

        let mut sd = soa_identity(n);
        make_additive(&soa(&pose), &soa(&reference), &mut sd);
        let mut ad = vec![AosTransform::identity(); n];
        make_additive(&pose, &reference, &mut ad);
        assert_bits_eq(&unsoa(&sd, n), &ad, "make_additive");

        let mut s = soa_identity(n);
        apply_additive(&soa(&base), &sd, w, &mut s);
        let mut aos = vec![AosTransform::identity(); n];
        apply_additive(&base, &ad, w, &mut aos);
        assert_bits_eq(&unsoa(&s, n), &aos, "apply_additive");

        let mask: Vec<f32> = (0..n).map(|_| rng.unit()).collect();
        let mut packed = vec![F32x4::splat(0.0); soa_len(n)];
        pack_mask(&mask, &mut packed);
        let mut s = soa_identity(n);
        apply_additive_masked(&soa(&base), &sd, &packed, w, &mut s);
        let mut aos = vec![AosTransform::identity(); n];
        apply_additive_masked(&base, &ad, &mask, w, &mut aos);
        assert_bits_eq(&unsoa(&s, n), &aos, "apply_additive_masked");
    }
}
