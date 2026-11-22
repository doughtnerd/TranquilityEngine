//! Property tests: `anim-math`'s SoA path against `anim-offline`'s f64 reference.
//!
//! Both sides get the same f32 inputs (the reference widens them exactly to f64), so every
//! difference is f32 arithmetic error in `anim-math` (or polynomial error, for trigonometry).
//! Tolerances are stated in units of `U` = 2^-24, the binary32 unit roundoff, with the reasoning
//! next to each. A sum of n products carries at most γn·Σ|terms| ≈ n·U·Σ|terms| of rounding error
//! (Higham, *Accuracy and Stability of Numerical Algorithms*, §3.1); the bounds add a margin of
//! about 2× on top.

mod common;

use anim_math::layout::{local_to_model, pack_pose, soa_len, NO_PARENT};
use anim_math::trig::{atan2, sin_cos};
use anim_math::{
    AosMat3x4, AosTransform, AosVec3, F32x4, SoaMat3x4, SoaQuat, SoaTransform, SoaVec3,
};
use anim_offline::math as r;
use common::*;

const CASES: usize = 2_000;

#[test]
fn vector_ops() {
    let mut rng = Rng::new(1);
    for _ in 0..CASES {
        let a = four(|| rng.vec3(-10.0, 10.0));
        let b = four(|| rng.vec3(-10.0, 10.0));
        let s = four(|| rng.range(-4.0, 4.0));
        let (sa, sb) = (SoaVec3::from_aos(&a), SoaVec3::from_aos(&b));
        let ss = F32x4::from_array(s);
        let add = (sa + sb).to_aos();
        let sub = (sa - sb).to_aos();
        let mul = (sa * sb).to_aos();
        let scl = sa.scale(ss).to_aos();
        let dot = lanes(sa.dot(sb));
        let crs = sa.cross(sb).to_aos();
        let len = lanes(sa.length());
        let nrm = sa.normalize_or(SoaVec3::zero()).to_aos();
        for i in 0..4 {
            let (ra, rb) = (v64(a[i]), v64(b[i]));
            // One rounding of a result below 20 (add/sub) or 100 (mul/scale): ≤ U·|result|.
            close_v(add[i], ra + rb, 20.0 * U, "add");
            close_v(sub[i], ra - rb, 20.0 * U, "sub");
            close_v(mul[i], ra * rb, 100.0 * U, "mul");
            close_v(scl[i], ra.scale(s[i] as f64), 40.0 * U, "scale");
            // dot: three products summed, γ3·Σ|aᵢbᵢ| ≤ 3U·|a||b|; ×2 margin.
            let mag = ra.length() * rb.length();
            close(dot[i], ra.dot(rb), 6.0 * U * mag, "dot");
            // cross: each component a difference of two products, γ2·(|..|+|..|) ≤ 2U·2|a||b|.
            close_v(crs[i], ra.cross(rb), 8.0 * U * mag, "cross");
            // length: dot (3U relative, all terms positive) then sqrt (halves it, plus U): ≤ 3U.
            close(len[i], ra.length(), 4.0 * U * ra.length(), "length");
            // normalize: length error plus one division and one multiply: ≤ 6U per component.
            close_v(nrm[i], ra.normalize_or(r::Vec3::ZERO), 8.0 * U, "normalize");
        }
    }
}

#[test]
fn quaternion_ops() {
    let mut rng = Rng::new(2);
    for _ in 0..CASES {
        let a = four(|| rng.quat());
        let b = four(|| rng.quat());
        let v = four(|| rng.vec3(-10.0, 10.0));
        let t = four(|| rng.unit());
        let (sa, sb) = (SoaQuat::from_aos(&a), SoaQuat::from_aos(&b));
        let tt = F32x4::from_array(t);
        let mul = (sa * sb).to_aos();
        let conj = sa.conjugate().to_aos();
        let rot = sa.rotate(SoaVec3::from_aos(&v)).to_aos();
        let nl = sa.nlerp(sb, tt).to_aos();
        let sl = sa.slerp(sb, tt).to_aos();
        let len = lanes(sa.length());
        for i in 0..4 {
            let (ra, rb) = (q64(a[i]), q64(b[i]));
            // Hamilton product of unit quaternions: each component sums four products with
            // Σ|terms| ≤ |a||b| ≈ 1, so γ4 ≈ 4U; ×2 margin.
            close_q(mul[i], ra * rb, 8.0 * U, "mul");
            close_q(conj[i], ra.conjugate(), 0.0, "conjugate (exact)");
            // rotate: two cross products and a sum, each step adding ≈ 2U·|v| (|u| ≤ 1); the
            // inputs aren't exactly unit (rounded to f32, |q|−1 ≤ 2U), which scales v by ≤ 4U.
            let mag = v64(v[i]).length();
            close_v(rot[i], ra.rotate(v64(v[i])), 24.0 * U * mag, "rotate");
            // nlerp: lerp (2U), length (3U), divide and multiply (2U), plus input non-unitness.
            close_q(nl[i], ra.nlerp(rb, t[i] as f64), 16.0 * U, "nlerp");
            // slerp: polynomial atan2 and sin (each ≤ 3e-7 ≈ 5U absolute, see `trig`), divided by
            // sin θ ≥ ~1e-3 for these random pairs, against f64 acos. 2e-6 absolute covers the
            // worst observed pair (θ near 0 amplifies the weight error; the linear branch takes
            // over below sin θ = 1e-6).
            close_q(sl[i], ra.slerp(rb, t[i] as f64), 2e-6, "slerp");
            close(len[i], ra.length(), 4.0 * U, "length");
        }
    }
}

#[test]
fn axis_angle() {
    let mut rng = Rng::new(3);
    for _ in 0..CASES {
        let axis = four(|| {
            let a = v64(rng.vec3(-1.0, 1.0)).normalize_or(r::Vec3::X);
            AosVec3::new(a.x as f32, a.y as f32, a.z as f32)
        });
        let angle = four(|| rng.range(-6.5, 6.5));
        let q = SoaQuat::from_axis_angle(SoaVec3::from_aos(&axis), F32x4::from_array(angle));
        let (back_axis, back_angle) = q.to_axis_angle();
        let qa = q.to_aos();
        let (ba, bn) = (back_axis.to_aos(), lanes(back_angle));
        for i in 0..4 {
            let want = r::Quat::from_axis_angle(v64(axis[i]), angle[i] as f64);
            // sin/cos polynomials ≤ 3e-7 absolute (≈ 5U), times a unit axis, plus one product.
            close_q(qa[i], want, 8.0 * U, "from_axis_angle");
            let (want_axis, want_angle) = r::Quat::to_axis_angle(q64(qa[i]));
            // atan2 polynomial ≤ 3e-7 absolute, doubled for the full angle, plus the length (3U).
            close(bn[i], want_angle, 1e-6, "to_axis_angle angle");
            // The axis is v/|v|; ill-conditioned as |v| = sin(angle/2) → 0, so it is compared
            // only for angles above 0.01, with a 6U / sin(angle/2) bound.
            let half_sin = (want_angle * 0.5).sin();
            if half_sin > 0.005 {
                close_v(
                    ba[i],
                    want_axis,
                    6.0 * U / half_sin + 8.0 * U,
                    "to_axis_angle axis",
                );
            }
        }
    }
}

#[test]
fn transform_ops() {
    let mut rng = Rng::new(4);
    for _ in 0..CASES {
        let a = four(|| rng.transform());
        let b = four(|| rng.transform());
        let u = four(|| rng.uniform_transform());
        let p = four(|| rng.vec3(-10.0, 10.0));
        let (sa, sb, su) = (
            SoaTransform::from_aos(&a),
            SoaTransform::from_aos(&b),
            SoaTransform::from_aos(&u),
        );
        let sp = SoaVec3::from_aos(&p);
        let comp = sa.compose(sb).to_aos();
        let inv = sa.inverse().to_aos();
        let pt = sa.transform_point(sp).to_aos();
        let vc = sa.transform_vector(sp).to_aos();
        let round = su
            .inverse()
            .transform_point(su.transform_point(sp))
            .to_aos();
        for i in 0..4 {
            let (ra, rb) = (t64(a[i]), t64(b[i]));
            // Translations reach |s|·|t| + |t| ≈ 50; rotate (24U·|v|), a scale and an add per
            // step: 64U relative to that magnitude. Rotations as quaternion mul (8U), scales one
            // product (U·16).
            close_t(
                comp[i],
                ra.compose(rb),
                64.0 * U * 60.0,
                32.0 * U,
                "compose",
            );
            // Inverse: 1/s (U relative, |1/s| ≤ 4), then a rotate of t/s (|t/s| ≤ 70).
            close_t(inv[i], ra.inverse(), 64.0 * U * 70.0, 8.0 * U, "inverse");
            close_v(
                pt[i],
                ra.transform_point(v64(p[i])),
                64.0 * U * 60.0,
                "transform_point",
            );
            close_v(
                vc[i],
                ra.transform_vector(v64(p[i])),
                64.0 * U * 60.0,
                "transform_vector",
            );
            // Uniform (and negative uniform) scale: the TRS inverse is exact, so the round trip
            // returns p up to two transforms' rounding, amplified by 1/|s| ≤ 4: 1e-4 absolute.
            close_v(
                round[i],
                v64(p[i]),
                1e-4,
                "inverse round trip (uniform scale)",
            );
        }
    }
}

#[test]
fn matrices() {
    let mut rng = Rng::new(5);
    for _ in 0..CASES {
        let a = four(|| rng.transform());
        let b = four(|| rng.transform());
        let p = four(|| rng.vec3(-10.0, 10.0));
        let ma = SoaMat3x4::from_transform(SoaTransform::from_aos(&a));
        let mb = SoaMat3x4::from_transform(SoaTransform::from_aos(&b));
        let am = ma.to_aos();
        let prod = (ma * mb).to_aos();
        let inv = ma.inverse_or(SoaMat3x4::identity()).to_aos();
        let pt = ma.transform_point(SoaVec3::from_aos(&p)).to_aos();
        for i in 0..4 {
            let want = r::Mat3x4::from_transform(t64(a[i]));
            // Rotation entries: ≤ 3 products and sums of unit-bounded terms (≈ 4U), times a scale
            // ≤ 4: 32U absolute. Translation copied exactly.
            for k in 0..12 {
                close(am[i].m[k] as f64, want.m[k], 32.0 * U, "from_transform");
            }
            let mb64 = m64(mb.to_aos()[i]);
            let want_prod = m64(am[i]) * mb64;
            // Three products of entries ≤ 4 (sums ≤ 48), translation sums to ≈ 200: 4U·200.
            for k in 0..12 {
                close(prod[i].m[k] as f64, want_prod.m[k], 4.0 * U * 200.0, "mul");
            }
            // The exact affine inverse of a non-uniformly scaled, rotated matrix. Condition
            // number ≤ 16 (scale ratio), entries ≤ 4, translations ≤ 70: 1e-5 relative to 70.
            let want_inv = m64(am[i]).inverse().unwrap();
            for k in 0..12 {
                close(inv[i].m[k] as f64, want_inv.m[k], 1e-5 * 70.0, "inverse");
            }
            close_v(
                pt[i],
                m64(am[i]).transform_point(v64(p[i])),
                4.0 * U * 60.0,
                "point",
            );
        }
    }
}

#[test]
fn local_to_model_matches_reference() {
    let mut rng = Rng::new(6);
    for n in 1..=23usize {
        let parents: Vec<u16> = (0..n)
            .map(|i| {
                if i == 0 || rng.below(5) == 0 {
                    NO_PARENT
                } else {
                    rng.below(i as u64) as u16
                }
            })
            .collect();
        // Short bones and mild scales, as a skeleton has: offsets ≤ 1, scale in [0.8, 1.25).
        let local: Vec<AosTransform> = (0..n)
            .map(|_| AosTransform::new(rng.vec3(-1.0, 1.0), rng.quat(), rng.vec3(0.8, 1.25)))
            .collect();
        let mut soa = vec![SoaTransform::identity(); soa_len(n)];
        pack_pose(&local, &mut soa);
        let mut model = vec![AosTransform::identity(); n];
        local_to_model(&parents, &soa, &mut model);
        let want = r::local_to_model(&parents, &local.iter().map(|t| t64(*t)).collect::<Vec<_>>());
        for i in 0..n {
            // Each level adds a compose's rounding (≈ 64U relative to the reach, which stays below
            // ~2·depth here) and carries the parent's: ≤ 23 levels × 64U × 50 ≈ 4.4e-3 worst case;
            // observed errors are far smaller, so a 1e-4 bound still has margin.
            close_t(model[i], want[i], 1e-4, 1e-5, "local_to_model");
        }
    }
}

#[test]
fn trig_against_libm() {
    let mut rng = Rng::new(7);
    let mut worst_sc = 0.0f64;
    let mut worst_at = 0.0f64;
    for _ in 0..CASES * 4 {
        let x = four(|| rng.range(-100.0, 100.0));
        let (s, c) = sin_cos(F32x4::from_array(x));
        let (s, c) = (lanes(s), lanes(c));
        let y = four(|| rng.range(-10.0, 10.0));
        let z = four(|| rng.range(-10.0, 10.0));
        let at = lanes(atan2(F32x4::from_array(y), F32x4::from_array(z)));
        for i in 0..4 {
            let xf = x[i] as f64;
            worst_sc = worst_sc
                .max((s[i] - xf.sin()).abs())
                .max((c[i] - xf.cos()).abs());
            worst_at = worst_at.max((at[i] - (y[i] as f64).atan2(z[i] as f64)).abs());
        }
    }
    // Cephes' sinf/cosf/atanf minimax polynomials are good to ≈ 1 ulp of the result plus range
    // reduction and final rounding; 3e-7 (≈ 5U) absolute is the documented bound in `trig`.
    assert!(worst_sc <= 3e-7, "sin_cos worst {worst_sc}");
    assert!(worst_at <= 3e-7, "atan2 worst {worst_at}");
    // Special values.
    let (s, c) = sin_cos(0.0f32);
    assert_eq!((s, c), (0.0, 1.0));
    assert_eq!(atan2(0.0f32, 0.0), 0.0);
    assert_eq!(atan2(0.0f32, -1.0), core::f32::consts::PI);
    assert_eq!(atan2(1.0f32, 0.0), core::f32::consts::FRAC_PI_2);
    assert_eq!(atan2(-1.0f32, 0.0), -core::f32::consts::FRAC_PI_2);
}

#[test]
fn matrix_output_layout() {
    // A 90° turn about Z with scale (2, 3, 4) and translation (5, 6, 7): x → 2y, y → −3x, z → 4z.
    let t = AosTransform::new(
        AosVec3::new(5.0, 6.0, 7.0),
        anim_math::AosQuat::new(
            0.0,
            0.0,
            core::f32::consts::FRAC_1_SQRT_2,
            core::f32::consts::FRAC_1_SQRT_2,
        ),
        AosVec3::new(2.0, 3.0, 4.0),
    );
    let rows = AosMat3x4::from_transform(t).to_rows();
    let want = [0.0, -3.0, 0.0, 5.0, 2.0, 0.0, 0.0, 6.0, 0.0, 0.0, 4.0, 7.0];
    for k in 0..12 {
        close(
            rows[k] as f64,
            want[k],
            8.0 * U * 4.0,
            "row-major 3x4 layout",
        );
    }
    // write_rows writes only the real lanes of a padded group.
    let soa = SoaMat3x4::from_transform(SoaTransform::from_aos(&[t, t, t, t]));
    let mut out = [-1.0f32; 48];
    soa.write_rows(&mut out, 3);
    assert_eq!(&out[..12], &rows);
    assert_eq!(&out[24..36], &rows);
    assert!(out[36..].iter().all(|&v| v == -1.0), "lane 3 untouched");
}
