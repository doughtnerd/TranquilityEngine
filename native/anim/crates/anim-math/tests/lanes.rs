//! Bit-for-bit agreement between the SoA path ([`F32x4`] lanes) and the scalar AoS path (`f32`).
//!
//! Natively, `F32x4` is the portable fallback, so this checks that the fallback runs exactly the
//! scalar operations. Built for `wasm32` with `simd128`, `F32x4` is `v128` and the AoS path is
//! scalar wasm `f32`, so the same test checks the SIMD path against scalar code.

mod common;

use anim_math::layout::{pack_pose, soa_len, unpack_pose};
use anim_math::trig::{atan2, sin_cos};
use anim_math::{
    quant, AosMat3x4, AosQuat, AosTransform, AosVec3, F32x4, Lane, SoaMat3x4, SoaQuat,
    SoaTransform, SoaVec3,
};
use common::*;

fn bits_v(v: AosVec3) -> [u32; 3] {
    [v.x.to_bits(), v.y.to_bits(), v.z.to_bits()]
}
fn bits_q(q: AosQuat) -> [u32; 4] {
    [q.x.to_bits(), q.y.to_bits(), q.z.to_bits(), q.w.to_bits()]
}
fn bits_t(t: AosTransform) -> [u32; 10] {
    let (a, b, c) = (bits_v(t.translation), bits_q(t.rotation), bits_v(t.scale));
    [a[0], a[1], a[2], b[0], b[1], b[2], b[3], c[0], c[1], c[2]]
}
fn bits_m(m: AosMat3x4) -> [u32; 12] {
    m.m.map(f32::to_bits)
}

/// Special values every primitive must treat the same way on both paths.
const SPECIAL: [f32; 14] = [
    0.0,
    -0.0,
    1.0,
    -1.0,
    0.5,
    -0.5,
    2.5,
    -2.5,
    1e-40, // denormal
    -1e-40,
    f32::MAX,
    f32::INFINITY,
    f32::NEG_INFINITY,
    f32::NAN,
];

#[test]
fn primitives_match_scalar_on_special_values() {
    for &a in &SPECIAL {
        for &b in &SPECIAL {
            let (va, vb) = (F32x4::splat(a), F32x4::splat(b));
            let same = |got: F32x4, want: f32, what: &str| {
                let g = got.to_array()[0];
                // NaN payloads may differ (crate docs); everything else is bit-exact.
                assert!(
                    (g.is_nan() && want.is_nan()) || g.to_bits() == want.to_bits(),
                    "{what}({a}, {b}): {g} vs {want}"
                );
            };
            same(va + vb, a + b, "add");
            same(va - vb, a - b, "sub");
            same(va * vb, a * b, "mul");
            same(va / vb, a / b, "div");
            same(-va, -a, "neg");
            same(Lane::sqrt(va), Lane::sqrt(a), "sqrt");
            same(Lane::abs(va), Lane::abs(a), "abs");
            same(Lane::min(va, vb), Lane::min(a, b), "min");
            same(Lane::max(va, vb), Lane::max(a, b), "max");
            same(Lane::floor(va), Lane::floor(a), "floor");
            same(Lane::round_even(va), Lane::round_even(a), "round_even");
            assert_eq!(Lane::lt(va, vb).all(), Lane::lt(a, b), "lt");
            assert_eq!(Lane::le(va, vb).all(), Lane::le(a, b), "le");
            assert_eq!(Lane::gt(va, vb).all(), Lane::gt(a, b), "gt");
            assert_eq!(Lane::ge(va, vb).all(), Lane::ge(a, b), "ge");
            assert_eq!(Lane::eq(va, vb).all(), Lane::eq(a, b), "eq");
            let m = Lane::lt(va, vb);
            same(F32x4::select(m, va, vb), f32::select(a < b, a, b), "select");
        }
    }
    // pmin/pmax semantics on signed zeros: min(+0, −0) keeps the first operand.
    assert_eq!(Lane::min(0.0f32, -0.0).to_bits(), 0.0f32.to_bits());
    assert_eq!(Lane::max(-0.0f32, 0.0).to_bits(), (-0.0f32).to_bits());
    // round_even ties.
    assert_eq!(
        Lane::round_even(F32x4::new(0.5, 1.5, 2.5, -2.5)).to_array(),
        [0.0, 2.0, 2.0, -2.0]
    );
    // Lanes stay independent.
    let x = F32x4::new(1.0, -2.0, 4.0, f32::INFINITY);
    assert_eq!(Lane::sqrt(x * x).to_array()[..3], [1.0, 2.0, 4.0]);
}

#[test]
fn soa_equals_aos_bit_for_bit() {
    let mut rng = Rng::new(11);
    for _ in 0..1_000 {
        let a = four(|| rng.vec3(-10.0, 10.0));
        let b = four(|| rng.vec3(-10.0, 10.0));
        let qa = four(|| rng.quat());
        let qb = four(|| rng.quat());
        let ta = four(|| rng.transform());
        let tb = four(|| rng.transform());
        let t = four(|| rng.unit());
        let x = four(|| rng.range(-20.0, 20.0));
        let (sa, sb) = (SoaVec3::from_aos(&a), SoaVec3::from_aos(&b));
        let (sqa, sqb) = (SoaQuat::from_aos(&qa), SoaQuat::from_aos(&qb));
        let (sta, stb) = (SoaTransform::from_aos(&ta), SoaTransform::from_aos(&tb));
        let st = F32x4::from_array(t);
        let sx = F32x4::from_array(x);

        let cross = sa.cross(sb).to_aos();
        let dot = sa.dot(sb).to_array();
        let nrm = sa.normalize_or(SoaVec3::zero()).to_aos();
        let lerp = sa.lerp(sb, st).to_aos();
        let qmul = (sqa * sqb).to_aos();
        let nl = sqa.nlerp(sqb, st).to_aos();
        let sl = sqa.slerp(sqb, st).to_aos();
        let rot = sqa.rotate(sa).to_aos();
        let fa = SoaQuat::from_axis_angle(sa.normalize_or(SoaVec3::zero()), sx).to_aos();
        let (ax, an) = sqa.to_axis_angle();
        let (ax, an) = (ax.to_aos(), an.to_array());
        let comp = sta.compose(stb).to_aos();
        let inv = sta.inverse().to_aos();
        let pt = sta.transform_point(sb).to_aos();
        let mat = SoaMat3x4::from_transform(sta);
        let mm = (mat * SoaMat3x4::from_transform(stb)).to_aos();
        let mi = mat.inverse_or(SoaMat3x4::identity()).to_aos();
        let ms = mat.to_aos();
        let (s, c) = sin_cos(sx);
        let (s, c) = (s.to_array(), c.to_array());
        let at = atan2(sx, F32x4::from_array(t)).to_array();

        for i in 0..4 {
            assert_eq!(bits_v(cross[i]), bits_v(a[i].cross(b[i])), "cross");
            assert_eq!(dot[i].to_bits(), a[i].dot(b[i]).to_bits(), "dot");
            assert_eq!(
                bits_v(nrm[i]),
                bits_v(a[i].normalize_or(AosVec3::zero())),
                "normalize"
            );
            assert_eq!(bits_v(lerp[i]), bits_v(a[i].lerp(b[i], t[i])), "lerp");
            assert_eq!(bits_q(qmul[i]), bits_q(qa[i] * qb[i]), "quat mul");
            assert_eq!(bits_q(nl[i]), bits_q(qa[i].nlerp(qb[i], t[i])), "nlerp");
            assert_eq!(bits_q(sl[i]), bits_q(qa[i].slerp(qb[i], t[i])), "slerp");
            assert_eq!(bits_v(rot[i]), bits_v(qa[i].rotate(a[i])), "rotate");
            let fa_want = AosQuat::from_axis_angle(a[i].normalize_or(AosVec3::zero()), x[i]);
            assert_eq!(bits_q(fa[i]), bits_q(fa_want), "from_axis_angle");
            let (wax, wan) = qa[i].to_axis_angle();
            assert_eq!(bits_v(ax[i]), bits_v(wax), "to_axis_angle axis");
            assert_eq!(an[i].to_bits(), wan.to_bits(), "to_axis_angle angle");
            assert_eq!(bits_t(comp[i]), bits_t(ta[i].compose(tb[i])), "compose");
            assert_eq!(bits_t(inv[i]), bits_t(ta[i].inverse()), "inverse");
            assert_eq!(
                bits_v(pt[i]),
                bits_v(ta[i].transform_point(b[i])),
                "transform_point"
            );
            let am = AosMat3x4::from_transform(ta[i]);
            assert_eq!(bits_m(ms[i]), bits_m(am), "from_transform");
            assert_eq!(
                bits_m(mm[i]),
                bits_m(am * AosMat3x4::from_transform(tb[i])),
                "mat mul"
            );
            assert_eq!(
                bits_m(mi[i]),
                bits_m(am.inverse_or(AosMat3x4::identity())),
                "mat inverse"
            );
            let (ws, wc) = sin_cos(x[i]);
            assert_eq!(
                (s[i].to_bits(), c[i].to_bits()),
                (ws.to_bits(), wc.to_bits()),
                "sin_cos"
            );
            assert_eq!(at[i].to_bits(), atan2(x[i], t[i]).to_bits(), "atan2");
        }

        for bits in [1u32, 7, 12, 16, 19, 23] {
            let max = quant::unorm_max(bits) as u64 + 1;
            let codes: [u32; 4] = core::array::from_fn(|_| rng.below(max) as u32);
            let un = quant::unpack_unorm4(codes, bits).to_array();
            let rg = quant::unpack_range4(codes, bits, F32x4::from_array(x), st).to_array();
            for i in 0..4 {
                assert_eq!(
                    un[i].to_bits(),
                    quant::unpack_unorm(codes[i], bits).to_bits()
                );
                let want = quant::unpack_range(codes[i], bits, x[i], t[i]);
                assert_eq!(rg[i].to_bits(), want.to_bits(), "unpack_range");
            }
        }
    }
}

#[test]
fn transposes_and_padding() {
    let mut rng = Rng::new(12);
    for n in 0..=13usize {
        let pose: Vec<AosTransform> = (0..n).map(|_| rng.transform()).collect();
        let mut soa = vec![SoaTransform::identity(); soa_len(n)];
        assert_eq!(soa.len(), n.div_ceil(4));
        pack_pose(&pose, &mut soa);
        // Lanes past the last bone are identity.
        for i in n..soa.len() * 4 {
            let t = soa[i / 4].lane(i % 4);
            assert_eq!(
                bits_t(t),
                bits_t(AosTransform::identity()),
                "padding lane {i}"
            );
        }
        let mut back = vec![AosTransform::identity(); n];
        unpack_pose(&soa, &mut back);
        for i in 0..n {
            assert_eq!(bits_t(back[i]), bits_t(pose[i]), "round trip bone {i}");
        }
    }
    // glam interchange is lossless.
    let t = rng.transform();
    let (gt, gr, gs) = t.to_glam();
    assert_eq!(bits_t(AosTransform::from_glam(gt, gr, gs)), bits_t(t));
}

#[test]
fn row_multiply_and_lane_access_match_the_scalar_forms() {
    let mut rng = Rng::new(13);
    for _ in 0..1_000 {
        let a = AosMat3x4::from_transform(rng.transform());
        let mut b = AosMat3x4::from_transform(rng.transform());
        // Signed zeros and specials in both operands: the translation column adds a3 alone.
        b.m[rng.below(12) as usize] = SPECIAL[rng.below(SPECIAL.len() as u64) as usize];
        let mut a2 = a;
        a2.m[rng.below(12) as usize] = -0.0;
        for (x, y) in [(a, b), (a2, b), (a2, a2)] {
            let got = bits_m(x.mul_rows(y));
            let want = bits_m(x * y);
            for (g, w) in got.iter().zip(want) {
                let nan = f32::from_bits(*g).is_nan() && f32::from_bits(w).is_nan();
                assert!(nan || *g == w, "mul_rows: {got:?} vs {want:?}");
            }
        }

        let ts = four(|| rng.transform());
        let mut soa = SoaTransform::from_aos(&ts);
        let t = rng.transform();
        let l = rng.below(4) as usize;
        for (i, want) in ts.iter().enumerate() {
            assert_eq!(bits_t(soa.lane(i)), bits_t(*want), "lane {i}");
        }
        soa.set_lane(l, t);
        let mut want = ts;
        want[l] = t;
        for (i, w) in want.iter().enumerate() {
            assert_eq!(bits_t(soa.lane(i)), bits_t(*w), "set_lane {l}, lane {i}");
        }
        let v = F32x4::from_array([1.0, 2.0, 3.0, 4.0]).with_lane(l, -0.0);
        assert_eq!(v.get_lane(l).to_bits(), (-0.0f32).to_bits());
        for i in (0..4).filter(|&i| i != l) {
            assert_eq!(v.get_lane(i), (i + 1) as f32);
        }
    }
}
