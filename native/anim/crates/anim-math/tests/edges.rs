//! Edge cases: zero and tiny vectors, opposite quaternions, scale cases of the transform inverse,
//! large values, local→model ordering, and quantisation.

mod common;

use anim_math::layout::{local_to_model, pack_pose, soa_len, NO_PARENT};
use anim_math::{
    quant, AosMat3x4, AosQuat, AosTransform, AosVec3, F32x4, SoaQuat, SoaTransform, SoaVec3,
};
use anim_offline::math as r;
use common::*;

#[test]
fn zero_and_tiny_vectors_take_the_fallback() {
    let fb = AosVec3::new(0.0, 1.0, 0.0);
    for v in [
        AosVec3::zero(),
        AosVec3::new(1e-13, 0.0, 0.0),
        AosVec3::new(1e-40, -1e-40, 0.0),
        AosVec3::new(f32::NAN, 0.0, 0.0),
    ] {
        let n = v.normalize_or(fb);
        assert_eq!((n.x, n.y, n.z), (0.0, 1.0, 0.0), "{v:?}");
    }
    // Just above the threshold still normalises.
    let n = AosVec3::new(1e-11, 0.0, 0.0).normalize_or(fb);
    assert_eq!((n.x, n.y, n.z), (1.0, 0.0, 0.0));
    // Mixed lanes: only the zero lane falls back.
    let soa = SoaVec3::new(
        F32x4::new(0.0, 3.0, 0.0, 0.0),
        F32x4::new(0.0, 4.0, 0.0, 0.0),
        F32x4::new(0.0, 0.0, 2.0, 0.0),
    )
    .normalize_or(SoaVec3::broadcast(9.0, 9.0, 9.0));
    let l = soa.to_aos();
    assert_eq!((l[0].x, l[0].y, l[0].z), (9.0, 9.0, 9.0));
    close(l[1].x as f64, 0.6, 2.0 * U, "3-4-5");
    close(l[1].y as f64, 0.8, 2.0 * U, "3-4-5");
    assert_eq!((l[2].x, l[2].y, l[2].z), (0.0, 0.0, 1.0));
    // Zero quaternion normalises to identity.
    let q = AosQuat::new(0.0, 0.0, 0.0, 0.0).normalize_or_identity();
    assert_eq!((q.x, q.y, q.z, q.w), (0.0, 0.0, 0.0, 1.0));
}

#[test]
fn opposite_quaternions_are_the_same_rotation() {
    let mut rng = Rng::new(21);
    for _ in 0..500 {
        let q = rng.quat();
        let n = -q;
        let v = rng.vec3(-5.0, 5.0);
        // Rotation by q and −q: the formula is even in q, so bit-identical.
        let (a, b) = (q.rotate(v), n.rotate(v));
        assert_eq!((a.x, a.y, a.z), (b.x, b.y, b.z));
        // Axis-angle canonicalises the sign (w ≥ 0), so identical too.
        let ((ax, aa), (bx, ba)) = (q.to_axis_angle(), n.to_axis_angle());
        if q.w != 0.0 {
            assert_eq!((ax.x, ax.y, ax.z, aa), (bx.x, bx.y, bx.z, ba));
        }
        // Blending toward −q stays on q (the shortest path is no motion at all).
        let t = rng.unit();
        close_q(q.nlerp(n, t), q64(q), 4.0 * U, "nlerp(q, -q)");
        close_q(q.slerp(n, t), q64(q), 4.0 * U, "slerp(q, -q)");
        // Shortest path between q and a rotation r that's been negated: same result as with r.
        let r = rng.quat();
        let (x, y) = (q.nlerp(r, t), q.nlerp(-r, t));
        assert_eq!((x.x, x.y, x.z, x.w), (y.x, y.y, y.z, y.w), "nlerp sign fix");
    }
    // Exactly opposite rotations (180° apart): nlerp at t = 0.5 has a well-defined midpoint.
    let a = AosQuat::new(0.0, 0.0, 0.0, 1.0);
    let b = AosQuat::new(0.0, 0.0, 1.0, 0.0); // 180° about Z
    let m = a.nlerp(b, 0.5);
    close_q(
        m,
        r::Quat::new(0.0, 0.0, 0.5f64.sqrt(), 0.5f64.sqrt()),
        2.0 * U,
        "nlerp 180°",
    );
    let s = a.slerp(b, 0.5);
    close_q(
        s,
        r::Quat::new(0.0, 0.0, 0.5f64.sqrt(), 0.5f64.sqrt()),
        8.0 * U,
        "slerp 180°",
    );
    // Identical inputs: slerp takes the linear branch and returns the input exactly.
    let q = AosQuat::new(0.5, 0.5, 0.5, 0.5);
    let s = q.slerp(q, 0.3);
    close_q(s, q64(q), 2.0 * U, "slerp(q, q)");
}

#[test]
fn transform_inverse_scale_cases() {
    let mut rng = Rng::new(22);
    for _ in 0..500 {
        let p = rng.vec3(-10.0, 10.0);
        // Uniform positive or negative scale: exact both ways (up to rounding).
        let u = rng.uniform_transform();
        let id1 = u.inverse().compose(u);
        let id2 = u.compose(u.inverse());
        for id in [id1, id2] {
            close_t(id, r::Transform::IDENTITY, 2e-4, 2e-6, "uniform inverse");
        }
        // Non-uniform scale with identity rotation: still exact.
        let t = AosTransform::new(rng.vec3(-10.0, 10.0), AosQuat::identity(), rng.scale());
        let back = t.inverse().transform_point(t.transform_point(p));
        close_v(back, v64(p), 1e-4, "non-uniform, no rotation");
        // Non-uniform scale with a rotation: the TRS inverse is only a left inverse in TRS
        // algebra (Unreal semantics); the matrix inverse is exact.
        let t = rng.transform();
        close_t(
            t.inverse().compose(t),
            r::Transform::IDENTITY,
            2e-4,
            2e-6,
            "left inverse",
        );
        let m = AosMat3x4::from_transform(t);
        let mi = m.inverse_or(AosMat3x4::identity());
        close_v(
            mi.transform_point(m.transform_point(p)),
            v64(p),
            1e-4,
            "matrix inverse",
        );
        // Negative non-uniform scale (a mirror): the matrix inverse handles it too.
        let mirror = AosTransform::new(t.translation, t.rotation, AosVec3::new(-1.0, 2.0, 0.5));
        let m = AosMat3x4::from_transform(mirror);
        let mi = m.inverse_or(AosMat3x4::identity());
        close_v(
            mi.transform_point(m.transform_point(p)),
            v64(p),
            1e-4,
            "mirror inverse",
        );
    }
    // Zero scale: the inverse scale is 0 (no inf or NaN), and the matrix inverse falls back.
    let z = AosTransform::new(
        AosVec3::new(1.0, 2.0, 3.0),
        AosQuat::identity(),
        AosVec3::new(0.0, 2.0, 1e-9),
    );
    let i = z.inverse();
    assert_eq!((i.scale.x, i.scale.y, i.scale.z), (0.0, 0.5, 0.0));
    assert!(i.translation.x.is_finite() && i.translation.z.is_finite());
    let fb = AosMat3x4::from_rows([7.0; 12]);
    assert_eq!(AosMat3x4::from_transform(z).inverse_or(fb).m, [7.0; 12]);
}

#[test]
fn large_values() {
    // Translations of a large world (1e6 m) keep their relative precision through compose.
    let mut rng = Rng::new(23);
    for _ in 0..200 {
        let mut a = rng.transform();
        a.translation = a.translation.scale(1e5);
        let b = rng.transform();
        let got = a.compose(b);
        let want = t64(a).compose(t64(b));
        // Relative to 1e6: a few U of the magnitude.
        close_v(
            got.translation,
            want.translation,
            8.0 * U * 1.1e6,
            "large compose",
        );
    }
    // Vectors up to 1e18 per component normalise (|v|² stays below f32::MAX ≈ 3.4e38).
    let n = AosVec3::new(1e18, -1e18, 1e18).normalize_or(AosVec3::zero());
    let k = 1.0 / 3.0f64.sqrt();
    close_v(n, r::Vec3::new(k, -k, k), 4.0 * U, "1e18 normalise");
    // Large angles stay deterministic and accurate to the documented bound.
    let q = AosQuat::from_axis_angle(AosVec3::new(0.0, 0.0, 1.0), 1000.0);
    close_rot(
        q,
        r::Quat::from_axis_angle(r::Vec3::new(0.0, 0.0, 1.0), 1000.0),
        1e-6,
        "angle 1000",
    );
}

#[test]
fn local_to_model_parent_in_the_same_group() {
    // A chain 0 → 1 → 2 → 3 → 4 → 5: every parent is in the same SoA group as its child, or the
    // group before. Each bone moves +1 along its parent's X and turns 90° about Z.
    let turn = AosQuat::new(
        0.0,
        0.0,
        core::f32::consts::FRAC_1_SQRT_2,
        core::f32::consts::FRAC_1_SQRT_2,
    );
    let bone = AosTransform::new(AosVec3::new(1.0, 0.0, 0.0), turn, AosVec3::one());
    let parents = [NO_PARENT, 0, 1, 2, 3, 4];
    let local = [bone; 6];
    let mut soa = [SoaTransform::identity(); soa_len(6)];
    pack_pose(&local, &mut soa);
    let mut model = [AosTransform::identity(); 6];
    local_to_model(&parents, &soa, &mut model);
    // Positions walk a unit square: (1,0), (1,1), (0,1), (0,0), (1,0), (1,1).
    let want = [
        (1.0, 0.0),
        (1.0, 1.0),
        (0.0, 1.0),
        (0.0, 0.0),
        (1.0, 0.0),
        (1.0, 1.0),
    ];
    for (m, (x, y)) in model.iter().zip(want) {
        close(m.translation.x as f64, x, 16.0 * U, "chain x");
        close(m.translation.y as f64, y, 16.0 * U, "chain y");
    }
}

#[test]
// Not on wasm32: a panic aborts there (no unwinding), so `should_panic` cannot catch it.
#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
#[should_panic(expected = "must come before it")]
fn local_to_model_rejects_a_parent_after_its_child_in_debug() {
    let parents = [NO_PARENT, 2, 0];
    let soa = [SoaTransform::identity()];
    let mut model = [AosTransform::identity(); 3];
    local_to_model(&parents, &soa, &mut model);
}

#[test]
fn quantisation_round_trips_and_matches_the_reference() {
    for bits in (1..=16).chain([19, 23]) {
        assert!(quant::is_supported_bits(bits));
        let max = quant::unorm_max(bits);
        assert_eq!(quant::unpack_unorm(0, bits), 0.0);
        assert_eq!(quant::unpack_unorm(max, bits), 1.0);
        // Exhaustive up to 16 bits, every 7th code above.
        let step = if bits <= 16 { 1 } else { 7 };
        let mut code = 0u32;
        while code <= max {
            let v = quant::unpack_unorm(code, bits);
            assert_eq!(quant::pack_unorm(v, bits), code, "{bits}-bit code {code}");
            // One correctly rounded division: within half an ulp of the f64 quotient.
            close(
                v as f64,
                r::unpack_unorm(code, bits),
                U * (v as f64).max(1e-30),
                "unpack",
            );
            code += step;
        }
    }
    for bits in [0, 17, 18, 20, 24, 32] {
        assert!(!quant::is_supported_bits(bits));
    }
    // Pack: half up, clamped, NaN to 0, and equal to the f64 reference.
    let mut rng = Rng::new(24);
    for _ in 0..10_000 {
        let bits = [1, 4, 8, 12, 16, 19, 23][rng.below(7) as usize];
        let x = rng.range(-0.2, 1.2);
        assert_eq!(
            quant::pack_unorm(x, bits),
            r::pack_unorm(x as f64, bits),
            "pack {x}"
        );
        let (min, extent) = (rng.range(-5.0, 5.0), rng.range(0.01, 10.0));
        let v = rng.range(min, min + extent);
        let code = quant::pack_range(v, min, extent, bits);
        // Range unpack: the quantisation step (extent / max) bounds the round-trip error, plus
        // f32 rounding of the result (≈ 2U·(|min| + extent)).
        let back = quant::unpack_range(code, bits, min, extent) as f64;
        let step = extent as f64 / quant::unorm_max(bits) as f64;
        close(
            back,
            v as f64,
            0.5 * step + 4.0 * U * (min.abs() + extent) as f64,
            "range round trip",
        );
        close(
            back,
            r::unpack_range(code, bits, min as f64, extent as f64),
            4.0 * U * (min.abs() + extent) as f64,
            "unpack_range vs reference",
        );
    }
    assert_eq!(quant::pack_unorm(f32::NAN, 8), 0);
    assert_eq!(quant::pack_unorm(-1.0, 8), 0);
    assert_eq!(quant::pack_unorm(2.0, 8), 255);
    // 0.5 · 3 = 1.5 rounds half up to 2.
    assert_eq!(quant::pack_unorm(0.5, 2), 2);
    assert_eq!(quant::pack_range(3.0, 3.0, 0.0, 8), 0, "constant track");
    // SoA unpack of mixed codes.
    let four = quant::unpack_unorm4([0, 1, 254, 255], 8).to_array();
    assert_eq!(four[0], 0.0);
    assert_eq!(four[3], 1.0);
    let rng4 = quant::unpack_range4([0, 255, 0, 255], 8, F32x4::splat(-1.0), F32x4::splat(2.0));
    assert_eq!(rng4.to_array(), [-1.0, 1.0, -1.0, 1.0]);
}

#[test]
fn soa_quat_lane_accessors() {
    let q = [
        AosQuat::identity(),
        AosQuat::new(1.0, 0.0, 0.0, 0.0),
        AosQuat::new(0.0, 1.0, 0.0, 0.0),
        AosQuat::new(0.0, 0.0, 1.0, 0.0),
    ];
    let s = SoaQuat::from_aos(&q);
    for (i, want) in q.iter().enumerate() {
        let l = s.lane(i);
        assert_eq!((l.x, l.y, l.z, l.w), (want.x, want.y, want.z, want.w));
    }
}
