//! Property tests: `anim-pose`'s SoA path against `anim-offline::pose`'s f64 reference.
//!
//! Both sides get the same f32 inputs (the reference widens them exactly), so every difference is
//! f32 arithmetic error in `anim-pose`. Tolerances are in units of `U` = 2^-24, the binary32 unit
//! roundoff, with the reasoning next to each. Random poses have translations in [-10, 10], scales
//! in [0.5, 2], unit rotations of either sign, and bone counts from 1 to 11 (so the padding of
//! the last SoA group is exercised).

mod common;

use anim_math::layout::soa_len;
use anim_math::{AosMat3x4, AosTransform, F32x4, SoaTransform};
use anim_offline::math as r;
use anim_offline::pose as o;
use anim_pose::additive::{apply_additive, apply_additive_masked, make_additive};
use anim_pose::blend::{blend, blend_masked, lerp, pack_mask};
use anim_pose::inertialize::Inertializer;
use anim_pose::mirror::{mirror, mirror_transform};
use anim_pose::model::{inverse_bind_matrices, skinning_matrices};
use anim_pose::root::{bake_out_root, root_delta, RootMotionAxes, RootRotation};
use anim_pose::{Axis, NO_PARENT};
use common::*;

const CASES: usize = 1_500;

fn bone_count(rng: &mut Rng) -> usize {
    1 + rng.below(11) as usize
}

fn axis_o(a: Axis) -> o::Axis {
    match a {
        Axis::X => o::Axis::X,
        Axis::Y => o::Axis::Y,
        Axis::Z => o::Axis::Z,
    }
}

#[test]
fn lerp_matches_reference() {
    let mut rng = Rng::new(10);
    // lerp: a + (b - a) * t. Translation: three roundings of values up to 20, 20 and 10:
    // <= U * 50, doubled for margin. Scale (|s| <= 2): far below that. Rotation: components of
    // unit quaternions, 5U for the lerp and ~6U for the normalise, doubled, plus up to 1.41x
    // amplification of the sum's length shortfall: 32U.
    let tol = Tol {
        t: 100.0 * U,
        r: 32.0 * U,
        s: 100.0 * U,
    };
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let (a, b) = (rng.pose(n), rng.pose(n));
        let t = rng.unit();
        let mut out = soa_identity(n);
        lerp(&soa(&a), &soa(&b), t, &mut out);
        let want = o::lerp(&pose64(&a), &pose64(&b), t as f64);
        close_pose(&unsoa(&out, n), &want, tol, "lerp");
    }
}

#[test]
fn blend_matches_reference() {
    let mut rng = Rng::new(11);
    // N <= 5 poses: each term is a weight division (U), a product (U) and a sum step (U) on values
    // up to 10: <= 3U * 10 * N = 150U, doubled. Rotation: the weights' rounding scales the whole
    // quaternion sum, which the normalise removes; what is left is ~(3 + N)U per component, x2.
    let tol = Tol {
        t: 300.0 * U,
        r: 40.0 * U,
        s: 100.0 * U,
    };
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let k = 2 + rng.below(4) as usize;
        let poses: Vec<Vec<AosTransform>> = (0..k).map(|_| rng.pose(n)).collect();
        // Unnormalised weights, some zero or negative.
        let weights: Vec<f32> = (0..k)
            .map(|_| match rng.below(6) {
                0 => 0.0,
                1 => -rng.unit(),
                _ => rng.range(0.05, 3.0),
            })
            .collect();
        let rest = rng.pose(n);
        let soas: Vec<Vec<SoaTransform>> = poses.iter().map(|p| soa(p)).collect();
        let refs: Vec<&[SoaTransform]> = soas.iter().map(|p| p.as_slice()).collect();
        let mut out = soa_identity(n);
        blend(&refs, &weights, &soa(&rest), &mut out);
        let p64: Vec<Vec<r::Transform>> = poses.iter().map(|p| pose64(p)).collect();
        let r64: Vec<&[r::Transform]> = p64.iter().map(|p| p.as_slice()).collect();
        let w64: Vec<f64> = weights.iter().map(|&w| w as f64).collect();
        let want = o::blend(&r64, &w64, &pose64(&rest));
        close_pose(&unsoa(&out, n), &want, tol, "blend");
        assert_padding_identity(&out, n, "blend");
    }
}

#[test]
fn masked_blend_matches_reference() {
    let mut rng = Rng::new(12);
    // As lerp, with the mask * weight product (one more rounding on t, relative U: it moves the
    // result by <= U * |b - a| = 20U for translation).
    let tol = Tol {
        t: 128.0 * U,
        r: 40.0 * U,
        s: 128.0 * U,
    };
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let (base, layer) = (rng.pose(n), rng.pose(n));
        let mask: Vec<f32> = (0..n)
            .map(|_| match rng.below(4) {
                0 => 0.0,
                1 => 1.0,
                _ => rng.unit(),
            })
            .collect();
        let weight = rng.range(0.0, 1.2);
        let mut packed = vec![F32x4::splat(0.0); soa_len(n)];
        pack_mask(&mask, &mut packed);
        let mut out = soa_identity(n);
        blend_masked(&soa(&base), &soa(&layer), &packed, weight, &mut out);
        let m64: Vec<f64> = mask.iter().map(|&m| m as f64).collect();
        let want = o::blend_masked(
            &pose64(&base),
            &pose64(&layer),
            &m64,
            weight.min(1.0) as f64,
        );
        close_pose(&unsoa(&out, n), &want, tol, "masked blend");
        // Bones the mask excludes are the base, bit for bit.
        let got = unsoa(&out, n);
        for i in 0..n {
            if mask[i] == 0.0 || weight == 0.0 {
                assert_eq!(bits_t(got[i]), bits_t(base[i]), "masked-out bone {i}");
            }
        }
    }
}

#[test]
fn additive_matches_reference() {
    let mut rng = Rng::new(13);
    // make_additive: translation difference of values <= 10 (one rounding of <= 20: 20U),
    // rotation product (8U), scale ratio p * (1/r) with |ratio| <= 4 (2 roundings: 8U); x2.
    let make_tol = Tol {
        t: 64.0 * U,
        r: 16.0 * U,
        s: 32.0 * U,
    };
    // apply: translation b + d * w with |b| <= 10, |d| <= 20: three roundings on <= 30 -> 90U,
    // doubled; rotation: nlerp normalise (12U) then a product (8U), x2; scale b * (1 + (ds-1) w)
    // with |ds| <= 4, |b| <= 2: ~6 roundings on <= 8 -> 48U, x2.
    let apply_tol = Tol {
        t: 180.0 * U,
        r: 48.0 * U,
        s: 100.0 * U,
    };
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let (pose, reference, base) = (rng.pose(n), rng.pose(n), rng.pose(n));
        let mut delta = soa_identity(n);
        make_additive(&soa(&pose), &soa(&reference), &mut delta);
        let want_delta = o::make_additive(&pose64(&pose), &pose64(&reference));
        close_pose(&unsoa(&delta, n), &want_delta, make_tol, "make_additive");

        let w = rng.range(0.0, 1.0);
        let mut out = soa_identity(n);
        apply_additive(&soa(&base), &delta, w, &mut out);
        // The reference applies the fast path's own (rounded) delta, to test apply alone.
        let d_aos = unsoa(&delta, n);
        let want = o::apply_additive(&pose64(&base), &pose64(&d_aos), w as f64);
        close_pose(&unsoa(&out, n), &want, apply_tol, "apply_additive");

        let mask: Vec<f32> = (0..n).map(|_| rng.unit()).collect();
        let mut packed = vec![F32x4::splat(0.0); soa_len(n)];
        pack_mask(&mask, &mut packed);
        let mut outm = soa_identity(n);
        apply_additive_masked(&soa(&base), &delta, &packed, w, &mut outm);
        // The kernel multiplies mask * w in f32, so feed the reference that rounded product.
        let mw: Vec<f64> = mask.iter().map(|&m| (m * w) as f64).collect();
        let want = o::apply_additive_masked(&pose64(&base), &pose64(&d_aos), &mw, 1.0);
        close_pose(&unsoa(&outm, n), &want, apply_tol, "apply_additive_masked");
    }
}

#[test]
fn additive_applied_to_its_reference_restores_the_pose() {
    let mut rng = Rng::new(14);
    // delta = (p - r) then r + delta: two roundings of values <= 20; rotation r * (r^-1 p):
    // two products (16U) plus the nlerp normalise (12U), x2. Scale r * (1 + (p/r - 1)): <= 8 -> 6 roundings.
    let tol = Tol {
        t: 128.0 * U,
        r: 64.0 * U,
        s: 128.0 * U,
    };
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let (pose, reference) = (rng.pose(n), rng.pose(n));
        let mut delta = soa_identity(n);
        make_additive(&soa(&pose), &soa(&reference), &mut delta);
        let mut out = soa_identity(n);
        apply_additive(&soa(&reference), &delta, 1.0, &mut out);
        close_pose(&unsoa(&out, n), &pose64(&pose), tol, "roundtrip");
    }
}

#[test]
fn mirror_matches_reference() {
    let mut rng = Rng::new(15);
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let pose = rng.pose(n);
        // A random involution: pair up some bones, the rest map to themselves.
        let mut partner: Vec<u16> = (0..n as u16).collect();
        for i in 0..n {
            let j = rng.below(n as u64) as usize;
            if partner[i] as usize == i && partner[j] as usize == j && i != j {
                partner[i] = j as u16;
                partner[j] = i as u16;
            }
        }
        for axis in [Axis::X, Axis::Y, Axis::Z] {
            let mut out = soa_identity(n);
            mirror(&soa(&pose), &partner, axis, &mut out);
            let want = o::mirror(&pose64(&pose), &partner, axis_o(axis));
            // The fast path flips signs (exact, so translation and scale match to the bit). The
            // reference rebuilds the rotation from axis-angle in f64, so it comes out exactly unit
            // while the f32 input is unit only to ~2U per component (rounded from f64): 4U.
            close_pose(
                &unsoa(&out, n),
                &want,
                Tol {
                    t: 0.0,
                    r: 4.0 * U,
                    s: 0.0,
                },
                "mirror",
            );
            assert_padding_identity(&out, n, "mirror");
        }
    }
}

/// Reflection of a model-space transform across the plane with normal `axis` (reference).
fn reflect_model(t: r::Transform, axis: Axis) -> r::Transform {
    o::mirror_transform(t, axis_o(axis))
}

#[test]
fn mirroring_the_local_pose_mirrors_the_model_pose() {
    // The defining property: for a skeleton whose two sides are mirror images and a partner map
    // that is a tree automorphism, model(mirror(local))[i] is the reflection of model(local)[partner[i]].
    //
    //   0 root (centre)   1 spine (0)   2 armL (1)   3 armR (1)
    //   4 handL (2)       5 handR (3)   6 head (1)
    let parents = [NO_PARENT, 0, 1, 1, 2, 3, 1];
    let partner: [u16; 7] = [0, 1, 3, 2, 5, 4, 6];
    let mut rng = Rng::new(16);
    for _ in 0..CASES {
        // Uniform scale 1 so the model space composes exactly as reflections do (no shear).
        let pose: Vec<AosTransform> = (0..7)
            .map(|_| {
                AosTransform::new(
                    rng.vec3(-2.0, 2.0),
                    rng.quat(),
                    anim_math::AosVec3::new(1.0, 1.0, 1.0),
                )
            })
            .collect();
        for axis in [Axis::X, Axis::Y, Axis::Z] {
            let mut mirrored = soa_identity(7);
            mirror(&soa(&pose), &partner, axis, &mut mirrored);
            let mut model_m = vec![AosTransform::identity(); 7];
            anim_pose::model::model_space(&parents, &mirrored, &mut model_m);
            let mut model = vec![AosTransform::identity(); 7];
            anim_pose::model::model_space(&parents, &soa(&pose), &mut model);
            // Depth <= 4: translation error ~ 12U * depth^2 * |t|, x4 margin; rotation 16U * depth.
            for i in 0..7 {
                let want = reflect_model(t64(model[partner[i] as usize]), axis);
                close_t(
                    model_m[i],
                    want,
                    Tol {
                        t: 1500.0 * U,
                        r: 256.0 * U,
                        s: 64.0 * U,
                    },
                    "mirrored model pose",
                );
            }
        }
    }
}

#[test]
fn mirror_transform_is_an_involution() {
    let mut rng = Rng::new(17);
    for _ in 0..CASES {
        let t = rng.transform();
        for axis in [Axis::X, Axis::Y, Axis::Z] {
            let twice = mirror_transform(mirror_transform(t, axis), axis);
            assert_eq!(bits_t(twice), bits_t(t));
        }
    }
}

/// A random skeleton of `n` bones with parents before children and depth at most `max_depth`.
fn random_parents(rng: &mut Rng, n: usize, max_depth: usize) -> Vec<u16> {
    let mut parents = vec![NO_PARENT; n];
    let mut depth = vec![0usize; n];
    for i in 1..n {
        loop {
            let p = rng.below(i as u64) as usize;
            if depth[p] < max_depth {
                parents[i] = p as u16;
                depth[i] = depth[p] + 1;
                break;
            }
        }
    }
    parents
}

#[test]
fn model_space_and_skinning_match_reference() {
    let mut rng = Rng::new(18);
    let max_depth = 6usize;
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let parents = random_parents(&mut rng, n, max_depth);
        // Local translations <= 1 and uniform scale in [0.8, 1.25] keep the chain's magnitude
        // below depth * 1.25^depth ~ 25 and exercise scale composition.
        let local: Vec<AosTransform> = (0..n)
            .map(|_| {
                let s = rng.range(0.8, 1.25);
                AosTransform::new(
                    rng.vec3(-1.0, 1.0),
                    rng.quat(),
                    anim_math::AosVec3::new(s, s, s),
                )
            })
            .collect();
        let bind: Vec<AosTransform> = (0..n)
            .map(|_| {
                AosTransform::new(
                    rng.vec3(-1.0, 1.0),
                    rng.quat(),
                    anim_math::AosVec3::new(1.0, 1.0, 1.0),
                )
            })
            .collect();
        let mut bind_model = vec![AosTransform::identity(); n];
        anim_pose::model::model_space(&parents, &soa(&bind), &mut bind_model);

        let mut inv_bind = vec![AosMat3x4::identity(); n];
        inverse_bind_matrices(&bind_model, &mut inv_bind);

        let mut model = vec![AosTransform::identity(); n];
        let mut skin = vec![0.0f32; 12 * n];
        skinning_matrices(&parents, &soa(&local), &inv_bind, &mut model, &mut skin);

        let want_model = o::model_space(&parents, &pose64(&local));
        // Each compose level adds a rotate (<= 24U * |v|, |v| <= ~25 here) and a scale/add: the
        // errors accumulate down the chain, so the bound is per bone and grows with depth:
        // translation 16U * 25 * (d + 1)^2, rotation 16U * (d + 1) (a product per level).
        for i in 0..n {
            let mut d = 0;
            let mut p = parents[i];
            while p != NO_PARENT {
                d += 1;
                p = parents[p as usize];
            }
            let k = (d + 1) as f64;
            close_t(
                model[i],
                want_model[i],
                Tol {
                    t: 16.0 * U * 25.0 * k * k,
                    r: 16.0 * U * k,
                    s: 16.0 * U * 4.0 * k,
                },
                "model space",
            );
        }

        // Skinning: the reference multiplies the fast path's own (f32) model transforms and
        // inverse-bind matrices in f64, so only the 3x4 conversion and the product are tested.
        // Rotation-block entries of the model matrix reach 1.25^6 ~ 3.8 (scale), its translation
        // ~25, the inverse bind's translation ~6. An entry is a sum of <= 4 products, so
        // error <= 4U * sum|terms| ~ 4U * (3 * 3.8 * 6 + 25) ~ 400U, plus the matrix
        // conversion's own ~8U * 3.8 * 3 ~ 100U: bound 1024U (2x margin).
        let ib64: Vec<r::Mat3x4> = inv_bind.iter().map(|&m| m64(m)).collect();
        let model_f32_as_64 = pose64(&model);
        let want_skin: Vec<r::Mat3x4> = model_f32_as_64
            .iter()
            .zip(&ib64)
            .map(|(&m, &ib)| r::Mat3x4::from_transform(m) * ib)
            .collect();
        for i in 0..n {
            for k in 0..12 {
                close(
                    skin[12 * i + k] as f64,
                    want_skin[i].m[k],
                    1024.0 * U,
                    "skinning matrix entry",
                );
            }
        }
    }
}

#[test]
fn the_bind_pose_skins_to_identity() {
    let mut rng = Rng::new(19);
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let parents = random_parents(&mut rng, n, 5);
        let bind: Vec<AosTransform> = (0..n)
            .map(|_| {
                AosTransform::new(
                    rng.vec3(-1.0, 1.0),
                    rng.quat(),
                    anim_math::AosVec3::new(1.0, 1.0, 1.0),
                )
            })
            .collect();
        let mut bind_model = vec![AosTransform::identity(); n];
        anim_pose::model::model_space(&parents, &soa(&bind), &mut bind_model);
        let mut inv_bind = vec![AosMat3x4::identity(); n];
        inverse_bind_matrices(&bind_model, &mut inv_bind);
        let mut model = vec![AosTransform::identity(); n];
        let mut skin = vec![0.0f32; 12 * n];
        skinning_matrices(&parents, &soa(&bind), &inv_bind, &mut model, &mut skin);
        // Identity to the accumulated error of a 5-deep chain and an affine inverse: 1e-4.
        for i in 0..n {
            let want = AosMat3x4::identity().m;
            for k in 0..12 {
                assert!(
                    (skin[12 * i + k] - want[k]).abs() <= 1e-4,
                    "bone {i} entry {k}: {}",
                    skin[12 * i + k]
                );
            }
        }
    }
}

fn random_axes(rng: &mut Rng) -> RootMotionAxes {
    RootMotionAxes {
        translate: [rng.below(2) == 0, rng.below(2) == 0, rng.below(2) == 0],
        rotation: match rng.below(3) {
            0 => RootRotation::None,
            1 => RootRotation::Yaw,
            _ => RootRotation::Full,
        },
    }
}

fn axes_o(a: RootMotionAxes) -> o::RootMotionAxes {
    o::RootMotionAxes {
        translate: a.translate,
        rotation: match a.rotation {
            RootRotation::None => o::RootRotation::None,
            RootRotation::Yaw => o::RootRotation::Yaw,
            RootRotation::Full => o::RootRotation::Full,
        },
    }
}

/// The twist about `up` of `q` is ill-conditioned when `q` is nearly a 180-degree swing; random
/// cases keep (up component, w) away from that.
fn well_conditioned(q: anim_math::AosQuat, up: Axis) -> bool {
    let c = match up {
        Axis::X => q.x,
        Axis::Y => q.y,
        Axis::Z => q.z,
    };
    c * c + q.w * q.w > 0.1
}

#[test]
fn root_delta_and_bake_out_match_reference() {
    let mut rng = Rng::new(20);
    let mut checked = 0;
    for _ in 0..CASES * 2 {
        let (from, to, reference) = (rng.transform(), rng.transform(), rng.transform());
        let up = [Axis::X, Axis::Y, Axis::Z][rng.below(3) as usize];
        let axes = random_axes(&mut rng);
        let dq = to.rotation * from.rotation.conjugate();
        let bq = to.rotation * reference.rotation.conjugate();
        if axes.rotation == RootRotation::Yaw
            && !(well_conditioned(dq, up) && well_conditioned(bq, up))
        {
            continue;
        }
        checked += 1;
        // Delta: translation is one subtraction of values <= 10 (<= 20U). Rotation: one product
        // (8U) for Full; Yaw adds the projection's normalise, whose input has length >= sqrt(0.1)
        // so it amplifies by <= 3.2: (8 + 6) * 3.2 = 45U, x1.5 margin.
        let got = root_delta(from, to, axes, up);
        let want = o::root_delta(t64(from), t64(to), axes_o(axes), axis_o(up));
        close_v(got.translation, want.translation, 20.0 * U, "root delta t");
        close_rot(got.rotation, want.rotation, 64.0 * U, "root delta r");

        // Bake out: translation is copied (exact); Yaw is conj(yaw) * r, another product and
        // normalise: 64U + 16U.
        let got = bake_out_root(to, reference, axes, up);
        let want = o::bake_out_root(t64(to), t64(reference), axes_o(axes), axis_o(up));
        close_v(got.translation, want.translation, 0.0, "bake t");
        close_rot(got.rotation, want.rotation, 96.0 * U, "bake r");
        close_v(got.scale, want.scale, 0.0, "bake s");
    }
    assert!(checked > CASES, "too many cases skipped: {checked}");
}

#[test]
fn inertialization_matches_reference() {
    let mut rng = Rng::new(21);
    // The output is `new + dir * x(t)`, x a quintic built from the offset (|x0| <= ~35 for
    // translation) and the velocity (a difference of nearby poses over dt = 1/30). The f32 path
    // loses ~U * |x0| in the offset and ~U * |x0| / dt in the velocity, which enters x(t) scaled
    // by T h1(s) <= 0.075 (T <= 0.5): about U * 35 * (1 + 0.075 * 30) ~ 115U, and a few more
    // roundings. Measured worst over the cases: ~250U, so 512U. Rotation: atan2's 3e-7 on the
    // offset angle and on each velocity angle, the latter scaled by 30 * 0.075: ~2e-6 measured
    // worst 1e-6, bound 2e-5.
    let tol = Tol {
        t: 512.0 * U,
        r: 2e-5,
        s: 0.0,
    };
    let dt = 1.0f32 / 30.0;
    for _ in 0..CASES {
        let n = bone_count(&mut rng);
        let prev = rng.pose(n);
        let prev_prev = rng.nearby(&prev);
        let new = rng.pose(n);
        let new_prev = rng.nearby(&new);
        let blend_time = rng.range(0.05, 0.5);
        let with_velocity = rng.below(2) == 0;
        let mut inertia = Inertializer::new(n);
        if with_velocity {
            inertia.begin_with_target_velocity(
                &soa(&prev),
                &soa(&prev_prev),
                &soa(&new),
                &soa(&new_prev),
                dt,
                blend_time,
            );
        } else {
            inertia.begin(&soa(&prev), &soa(&prev_prev), &soa(&new), dt, blend_time);
        }
        let offsets = o::inertialize_begin(
            &pose64(&prev),
            &pose64(&prev_prev),
            &pose64(&new),
            with_velocity.then(|| pose64(&new_prev)).as_deref(),
            dt as f64,
            blend_time as f64,
        )
        .unwrap();
        // Sample the curve at t = 0, then four more steps across (and past) the blend time.
        let mut elapsed = 0.0f32;
        let step = blend_time / 4.0;
        for k in 0..6 {
            let mut pose = soa(&new);
            let advance = if k == 0 { 0.0 } else { step };
            elapsed += advance;
            inertia.apply(advance, &mut pose);
            let want = o::inertialize_apply(&offsets, elapsed as f64, &pose64(&new));
            let got = unsoa(&pose, n);
            close_pose(&got, &want, tol, &format!("inertialize step {k}"));
            assert_padding_identity(&pose, n, "inertialize");
        }
    }
}
