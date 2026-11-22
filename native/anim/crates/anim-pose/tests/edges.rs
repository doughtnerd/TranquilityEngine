//! Edge cases and hand-computed values: blends (zero weights, `q` against `-q`, one bone, bone
//! counts that aren't a multiple of 4), additive, mirror, root motion, sync markers (looping,
//! missing markers) and the inertialization quintic.

mod common;

use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_pose::additive::{apply_additive, make_additive};
use anim_pose::blend::{blend, blend_masked, lerp, pack_mask};
use anim_pose::inertialize::{clamp_blend_time, Inertializer, Quintic};
use anim_pose::mirror::mirror;
use anim_pose::root::{
    bake_out_root, bake_out_root_motion, extract_root_delta, root_delta, RootDelta, RootMotionAxes,
    RootRotation,
};
use anim_pose::sync::{SyncClip, SyncMarker, SyncPhase, NO_MARKER};
use anim_pose::{bone, set_bone, Axis};
use common::*;

fn v(x: f32, y: f32, z: f32) -> AosVec3 {
    AosVec3::new(x, y, z)
}

fn at(t: AosVec3) -> AosTransform {
    AosTransform::new(t, AosQuat::identity(), v(1.0, 1.0, 1.0))
}

fn about(axis: Axis, angle: f32) -> AosQuat {
    let a = match axis {
        Axis::X => v(1.0, 0.0, 0.0),
        Axis::Y => v(0.0, 1.0, 0.0),
        Axis::Z => v(0.0, 0.0, 1.0),
    };
    AosQuat::from_axis_angle(a, angle)
}

fn rot(q: AosQuat) -> AosTransform {
    AosTransform::new(v(0.0, 0.0, 0.0), q, v(1.0, 1.0, 1.0))
}

#[track_caller]
fn near(got: f32, want: f32, tol: f32, what: &str) {
    assert!((got - want).abs() <= tol, "{what}: got {got}, want {want}");
}

// ---- blend ---------------------------------------------------------------------------------

#[test]
fn no_weight_gives_the_rest_pose_bit_for_bit() {
    let mut rng = Rng::new(40);
    for n in 1..=9 {
        let (a, b, rest) = (rng.pose(n), rng.pose(n), rng.pose(n));
        let (sa, sb, sr) = (soa(&a), soa(&b), soa(&rest));
        for w in [
            [0.0f32, 0.0],
            [-1.0, -2.0],
            [f32::NAN, 0.0],
            [0.0, -0.0],
            [1e-20, 1e-20], // total below MIN_TOTAL_WEIGHT
        ] {
            let mut out = soa_identity(n);
            blend(&[&sa, &sb], &w, &sr, &mut out);
            assert_bits_eq(&unsoa(&out, n), &rest, &format!("weights {w:?}"));
        }
        let mut out = soa_identity(n);
        blend(&[], &[], &sr, &mut out);
        assert_bits_eq(&unsoa(&out, n), &rest, "no poses");
    }
}

#[test]
fn one_positive_weight_copies_that_pose_exactly() {
    let mut rng = Rng::new(41);
    let n = 6;
    let (a, b, c, rest) = (rng.pose(n), rng.pose(n), rng.pose(n), rng.pose(n));
    let (sa, sb, sc) = (soa(&a), soa(&b), soa(&c));
    let mut out = soa_identity(n);
    blend(
        &[&sa, &sb, &sc],
        &[0.0, 0.37, f32::NAN],
        &soa(&rest),
        &mut out,
    );
    assert_bits_eq(&unsoa(&out, n), &b, "single weight");
}

#[test]
fn negated_rotations_blend_as_the_same_rotation() {
    let mut rng = Rng::new(42);
    for n in [1usize, 3, 4, 5, 8] {
        let a = rng.pose(n);
        // The same rotations with every quaternion negated (q and -q are one rotation).
        let b: Vec<AosTransform> = a
            .iter()
            .map(|t| AosTransform::new(t.translation, -t.rotation, t.scale))
            .collect();
        let (sa, sb) = (soa(&a), soa(&b));
        let mut out = soa_identity(n);
        blend(&[&sa, &sb], &[0.5, 0.5], &sa, &mut out);
        for (got, want) in unsoa(&out, n).iter().zip(&a) {
            // Sign-aligned: the sum is 2q / 2, never the zero quaternion (which would give
            // identity). Either sign of the result is the same rotation.
            close_rot(got.rotation, q64(want.rotation), 4.0 * U, "q vs -q");
        }
        // The first pose carries the reference sign even with weight 0: [x, -q, q] -> q.
        let x = rng.pose(n);
        let sx = soa(&x);
        let mut out = soa_identity(n);
        blend(&[&sx, &sb, &sa], &[0.0, 1.0, 1.0], &sx, &mut out);
        for (got, want) in unsoa(&out, n).iter().zip(&a) {
            close_rot(
                got.rotation,
                q64(want.rotation),
                4.0 * U,
                "weight-0 reference",
            );
        }
    }
}

#[test]
fn one_bone_blend_hand_values() {
    let a = [at(v(0.0, 0.0, 0.0))];
    let mut b = [at(v(2.0, 0.0, 0.0))];
    b[0].scale = v(3.0, 3.0, 3.0);
    let (sa, sb) = (soa(&a), soa(&b));
    let mut out = soa_identity(1);
    blend(&[&sa, &sb], &[1.0, 3.0], &sa, &mut out);
    let t = bone(&out, 0);
    near(t.translation.x, 1.5, 1e-6, "translation");
    near(t.scale.x, 2.5, 1e-6, "scale");
    assert_padding_identity(&out, 1, "one bone");
    // 90 degrees about Y and identity, equal weights: nlerp gives 45 degrees.
    let r = [rot(about(Axis::Y, core::f32::consts::FRAC_PI_2))];
    let id = [AosTransform::identity()];
    let (sr, si) = (soa(&r), soa(&id));
    blend(&[&si, &sr], &[1.0, 1.0], &si, &mut out);
    let q = bone(&out, 0).rotation;
    near(q.y, (core::f32::consts::FRAC_PI_8).sin(), 1e-6, "nlerp y");
    near(q.w, (core::f32::consts::FRAC_PI_8).cos(), 1e-6, "nlerp w");
}

#[test]
fn lerp_clamps_and_hits_the_ends() {
    let mut rng = Rng::new(43);
    let n = 7;
    let (a, b) = (rng.pose(n), rng.pose(n));
    let (sa, sb) = (soa(&a), soa(&b));
    let mut out = soa_identity(n);
    for t in [0.0, -3.0, f32::NAN] {
        lerp(&sa, &sb, t, &mut out);
        for (got, want) in unsoa(&out, n).iter().zip(&a) {
            // a + (b - a) * 0 is a, exactly, for translation and scale.
            assert_eq!(bits_v(got.translation), bits_v(want.translation), "t = {t}");
            assert_eq!(bits_v(got.scale), bits_v(want.scale));
            close_rot(got.rotation, q64(want.rotation), 4.0 * U, "t = 0 rotation");
        }
    }
    for t in [1.0, 5.0] {
        lerp(&sa, &sb, t, &mut out);
        for (got, want) in unsoa(&out, n).iter().zip(&b) {
            close_v(got.translation, v64(want.translation), 64.0 * U, "t = 1");
            close_rot(got.rotation, q64(want.rotation), 16.0 * U, "t = 1 rotation");
        }
    }
}

#[test]
fn blend_keeps_padding_identity_for_every_bone_count() {
    let mut rng = Rng::new(44);
    for n in 1..=13 {
        let (a, b, c) = (rng.pose(n), rng.pose(n), rng.pose(n));
        let (sa, sb, sc) = (soa(&a), soa(&b), soa(&c));
        let mut out = soa_identity(n);
        blend(&[&sa, &sb, &sc], &[0.2, 0.3, 0.5], &sa, &mut out);
        assert_padding_identity(&out, n, "blend");
        lerp(&sa, &sb, 0.3, &mut out);
        assert_padding_identity(&out, n, "lerp");
        let mut d = soa_identity(n);
        make_additive(&sa, &sb, &mut d);
        assert_padding_identity(&d, n, "make_additive");
        apply_additive(&sc, &d, 0.7, &mut out);
        assert_padding_identity(&out, n, "apply_additive");
    }
}

#[test]
fn masked_blend_hand_values() {
    // Bones (overall weight 0.5): 0 half layered, 1 not at all, 2 a quarter, 3 mask 2 * 0.5
    // = 1 so fully layered, 4 mask 1 so half.
    let base: Vec<AosTransform> = (0..5).map(|_| at(v(0.0, 0.0, 0.0))).collect();
    let layer: Vec<AosTransform> = (0..5).map(|_| at(v(10.0, 0.0, 0.0))).collect();
    let mask = [1.0f32, 0.0, 0.5, 2.0, 1.0];
    let mut packed = vec![F32x4::splat(0.0); soa_len(5)];
    pack_mask(&mask, &mut packed);
    // Spare lanes of the packed mask are 0.
    assert_eq!(packed[1].to_array(), [1.0, 0.0, 0.0, 0.0]);
    let mut out = soa_identity(5);
    blend_masked(&soa(&base), &soa(&layer), &packed, 0.5, &mut out);
    let got = unsoa(&out, 5);
    let xs: Vec<f32> = got.iter().map(|t| t.translation.x).collect();
    assert_eq!(xs, vec![5.0, 0.0, 2.5, 10.0, 5.0]);
    // Overall weight 0: everything is the base, bit for bit.
    blend_masked(&soa(&base), &soa(&layer), &packed, 0.0, &mut out);
    assert_bits_eq(&unsoa(&out, 5), &base, "weight 0");
}

// ---- additive ------------------------------------------------------------------------------

#[test]
fn additive_hand_values() {
    let reference = [AosTransform::new(
        v(1.0, 0.0, 0.0),
        about(Axis::Y, 0.5),
        v(4.0, 4.0, 4.0),
    )];
    let pose = [AosTransform::new(
        v(1.0, 3.0, 0.0),
        about(Axis::Y, 0.5) * about(Axis::X, 1.0),
        v(2.0, 2.0, 2.0),
    )];
    let mut d = soa_identity(1);
    make_additive(&soa(&pose), &soa(&reference), &mut d);
    let delta = bone(&d, 0);
    near(delta.translation.y, 3.0, 0.0, "delta t");
    near(delta.scale.x, 0.5, 0.0, "delta s");
    // inv(ref) * pose = Rx(1): a rotation of 1 radian about X.
    near(delta.rotation.x, 0.5f32.sin(), 1e-6, "delta r");
    near(delta.rotation.w, 0.5f32.cos(), 1e-6, "delta r");

    let base = [AosTransform::new(
        v(0.0, 1.0, 0.0),
        about(Axis::Z, 0.3),
        v(3.0, 3.0, 3.0),
    )];
    let mut out = soa_identity(1);
    apply_additive(&soa(&base), &d, 1.0, &mut out);
    let t = bone(&out, 0);
    near(t.translation.y, 4.0, 1e-6, "applied t");
    near(t.scale.x, 1.5, 1e-6, "applied s");
    // Weight 0: the base, bit for bit.
    apply_additive(&soa(&base), &d, 0.0, &mut out);
    assert_bits_eq(&unsoa(&out, 1), &base, "weight 0");
}

#[test]
fn additive_rotation_takes_the_short_way_round() {
    // A delta of 270 degrees about Y is -90 degrees; at weight 0.5 it must apply as -45.
    let reference = [AosTransform::identity()];
    let pose = [rot(about(Axis::Y, 1.5 * core::f32::consts::PI))];
    let mut d = soa_identity(1);
    make_additive(&soa(&pose), &soa(&reference), &mut d);
    let mut out = soa_identity(1);
    apply_additive(&soa(&reference), &d, 0.5, &mut out);
    let q = bone(&out, 0).rotation;
    let (s, c) = (core::f32::consts::FRAC_PI_8).sin_cos();
    // Same rotation as -45 degrees about Y, either sign.
    let sign = if q.w < 0.0 { -1.0 } else { 1.0 };
    near(sign * q.y, -s, 1e-5, "y");
    near(sign * q.w, c, 1e-5, "w");
}

#[test]
fn additive_with_zero_reference_scale_does_not_blow_up() {
    let mut reference = [AosTransform::identity()];
    reference[0].scale = v(0.0, 1.0, -0.0);
    let mut pose = [AosTransform::identity()];
    pose[0].scale = v(2.0, 2.0, 2.0);
    let mut d = soa_identity(1);
    make_additive(&soa(&pose), &soa(&reference), &mut d);
    let delta = bone(&d, 0);
    assert_eq!(
        (delta.scale.x, delta.scale.y, delta.scale.z),
        (1.0, 2.0, 1.0)
    );
}

// ---- mirror --------------------------------------------------------------------------------

#[test]
fn mirror_hand_values_and_map_rules() {
    let a = AosTransform::new(
        v(1.0, 2.0, 3.0),
        AosQuat::new(0.1, 0.2, 0.3, 0.9),
        v(1.0, 2.0, 3.0),
    );
    let b = AosTransform::new(
        v(-4.0, 5.0, 6.0),
        AosQuat::new(0.5, -0.5, 0.5, 0.5),
        v(1.0, 1.0, 1.0),
    );
    let c = AosTransform::new(
        v(7.0, 8.0, 9.0),
        AosQuat::new(0.0, 0.0, 0.0, 1.0),
        v(1.0, 1.0, 1.0),
    );
    let pose = [a, b, c, AosTransform::identity(), AosTransform::identity()];
    // 0 <-> 1 swap, 2 centre, 3 points out of range (counts as itself), 4 centre.
    let partner: [u16; 5] = [1, 0, 2, 99, 4];
    let mut out = soa_identity(5);
    mirror(&soa(&pose), &partner, Axis::X, &mut out);
    let got = unsoa(&out, 5);
    // Bone 0 takes bone 1's mirror: (-x, y, z), (qx, -qy, -qz, qw).
    assert_eq!(bits_v(got[0].translation), bits_v(v(4.0, 5.0, 6.0)));
    assert_eq!(
        bits_q(got[0].rotation),
        bits_q(AosQuat::new(0.5, 0.5, -0.5, 0.5))
    );
    assert_eq!(bits_v(got[1].translation), bits_v(v(-1.0, 2.0, 3.0)));
    assert_eq!(
        bits_q(got[1].rotation),
        bits_q(AosQuat::new(0.1, -0.2, -0.3, 0.9))
    );
    assert_eq!(
        bits_v(got[1].scale),
        bits_v(v(1.0, 2.0, 3.0)),
        "scale is unchanged"
    );
    // Centre bone mirrors itself.
    assert_eq!(bits_v(got[2].translation), bits_v(v(-7.0, 8.0, 9.0)));
    assert_padding_identity(&out, 5, "mirror");
    // Y and Z planes flip their own axis.
    mirror(&soa(&pose), &partner, Axis::Y, &mut out);
    assert_eq!(bits_v(bone(&out, 2).translation), bits_v(v(7.0, -8.0, 9.0)));
    mirror(&soa(&pose), &partner, Axis::Z, &mut out);
    assert_eq!(bits_v(bone(&out, 2).translation), bits_v(v(7.0, 8.0, -9.0)));
    // A mirrored 90-degree turn about Z (which lies in the X plane) turns the other way about Z.
    let turn = [rot(about(Axis::Z, 1.0))];
    let mut one = soa_identity(1);
    mirror(&soa(&turn), &[0], Axis::X, &mut one);
    let q = bone(&one, 0).rotation;
    near(q.z, -(0.5f32.sin()), 1e-6, "mirrored turn about Z");
}

// ---- root motion ---------------------------------------------------------------------------

const YAW_TOL: f32 = 2e-6;

#[test]
fn root_delta_hand_values() {
    let from = at(v(0.0, 0.0, 0.0));
    let to = AosTransform::new(
        v(1.0, 0.5, 2.0),
        about(Axis::Y, core::f32::consts::FRAC_PI_2),
        v(1.0, 1.0, 1.0),
    );
    let planar = RootMotionAxes::planar_yaw(Axis::Y);
    assert_eq!(planar.translate, [true, false, true]);
    let d = root_delta(from, to, planar, Axis::Y);
    assert_eq!(bits_v(d.translation), bits_v(v(1.0, 0.0, 2.0)));
    near(
        d.yaw_angle(Axis::Y),
        core::f32::consts::FRAC_PI_2,
        YAW_TOL,
        "yaw",
    );
    // Nothing is root motion: zero and identity.
    let d = root_delta(from, to, RootMotionAxes::NONE, Axis::Y);
    assert_eq!(bits_v(d.translation), bits_v(v(0.0, 0.0, 0.0)));
    assert_eq!(bits_q(d.rotation), bits_q(AosQuat::identity()));
    // Everything: all three translation axes and the full rotation.
    let d = root_delta(from, to, RootMotionAxes::ALL, Axis::Y);
    assert_eq!(bits_v(d.translation), bits_v(v(1.0, 0.5, 2.0)));
    close_rot(d.rotation, q64(to.rotation), 4.0 * U, "full rotation");
    // The default axes are planar yaw for +Y up.
    assert_eq!(RootMotionAxes::default(), planar);
}

#[test]
fn yaw_ignores_tilt_and_full_keeps_it() {
    // Heading 60 degrees applied last (parent space), tilt 30 degrees about X first.
    let yaw = 60f32.to_radians();
    let q = about(Axis::Y, yaw) * about(Axis::X, 30f32.to_radians());
    let to = rot(q);
    let from = AosTransform::identity();
    let d = root_delta(from, to, RootMotionAxes::planar_yaw(Axis::Y), Axis::Y);
    near(
        d.yaw_angle(Axis::Y),
        yaw,
        YAW_TOL,
        "yaw of a tilted rotation",
    );
    // The Yaw delta is a pure rotation about Y.
    near(d.rotation.x, 0.0, 0.0, "no x");
    near(d.rotation.z, 0.0, 0.0, "no z");
    let full = root_delta(from, to, RootMotionAxes::ALL, Axis::Y);
    close_rot(full.rotation, q64(q), 4.0 * U, "full");
    // Other up axes: yaw about Z of a Z-then-X rotation.
    let q = about(Axis::Z, 0.4) * about(Axis::X, 0.2);
    let d = root_delta(from, rot(q), RootMotionAxes::planar_yaw(Axis::Z), Axis::Z);
    near(d.yaw_angle(Axis::Z), 0.4, YAW_TOL, "yaw about Z");
    assert_eq!(
        RootMotionAxes::planar_yaw(Axis::Z).translate,
        [true, true, false]
    );
}

#[test]
fn yaw_delta_takes_the_short_way_round() {
    // 350 degrees to 10 degrees is +20, not -340.
    let from = rot(about(Axis::Y, 350f32.to_radians()));
    let to = rot(about(Axis::Y, 10f32.to_radians()));
    let d = root_delta(from, to, RootMotionAxes::planar_yaw(Axis::Y), Axis::Y);
    near(
        d.yaw_angle(Axis::Y),
        20f32.to_radians(),
        1e-5,
        "wrapped yaw",
    );
}

#[test]
fn deltas_over_a_loop_seam_add_up() {
    let a = RootDelta {
        translation: v(1.0, 0.0, 2.0),
        rotation: about(Axis::Y, 0.5),
    };
    let b = RootDelta {
        translation: v(0.5, 0.0, 1.0),
        rotation: about(Axis::Y, 0.25),
    };
    let both = a.then(b);
    assert_eq!(bits_v(both.translation), bits_v(v(1.5, 0.0, 3.0)));
    near(both.yaw_angle(Axis::Y), 0.75, YAW_TOL, "yaw adds");
    let id = RootDelta::identity().then(a);
    assert_eq!(bits_v(id.translation), bits_v(a.translation));
}

#[test]
fn bake_out_removes_exactly_the_flagged_motion() {
    let reference = AosTransform::new(v(1.0, 0.0, 1.0), AosQuat::identity(), v(1.0, 1.0, 1.0));
    let tilt = about(Axis::X, 30f32.to_radians());
    let moved = AosTransform::new(
        v(5.0, 1.0, 7.0),
        about(Axis::Y, 60f32.to_radians()) * tilt,
        v(2.0, 2.0, 2.0),
    );
    let planar = RootMotionAxes::planar_yaw(Axis::Y);
    let baked = bake_out_root(moved, reference, planar, Axis::Y);
    // Planar translation back to the reference, height (not flagged) kept, scale kept.
    assert_eq!(bits_v(baked.translation), bits_v(v(1.0, 1.0, 1.0)));
    assert_eq!(bits_v(baked.scale), bits_v(moved.scale));
    // The yaw is gone, the tilt stays.
    let d = root_delta(reference, baked, RootMotionAxes::ALL, Axis::Y);
    near(d.yaw_angle(Axis::Y), 0.0, YAW_TOL, "no yaw left");
    close_rot(baked.rotation, q64(tilt), 8.0 * U, "tilt kept");
    // Rotation None keeps the rotation; Full replaces it; translation flags work per axis.
    let keep = RootMotionAxes {
        translate: [false, true, false],
        rotation: RootRotation::None,
    };
    let b = bake_out_root(moved, reference, keep, Axis::Y);
    assert_eq!(bits_v(b.translation), bits_v(v(5.0, 0.0, 7.0)));
    assert_eq!(bits_q(b.rotation), bits_q(moved.rotation));
    let b = bake_out_root(moved, reference, RootMotionAxes::ALL, Axis::Y);
    assert_eq!(bits_q(b.rotation), bits_q(reference.rotation));
    assert_eq!(bits_v(b.translation), bits_v(reference.translation));
    // Nothing flagged: unchanged.
    let b = bake_out_root(moved, reference, RootMotionAxes::NONE, Axis::Y);
    assert_eq!(bits_t(b), bits_t(moved));
}

#[test]
fn pose_level_root_functions_touch_only_the_root() {
    let mut rng = Rng::new(50);
    let n = 6;
    let (p0, p1) = (rng.pose(n), rng.pose(n));
    let (s0, s1) = (soa(&p0), soa(&p1));
    for root in [0usize, 5] {
        let axes = RootMotionAxes::planar_yaw(Axis::Y);
        let d = extract_root_delta(&s0, &s1, root, axes, Axis::Y);
        let want = root_delta(p0[root], p1[root], axes, Axis::Y);
        assert_eq!(bits_v(d.translation), bits_v(want.translation));
        assert_eq!(bits_q(d.rotation), bits_q(want.rotation));

        let mut baked = s1.clone();
        bake_out_root_motion(&mut baked, root, p0[root], axes, Axis::Y);
        let got = unsoa(&baked, n);
        for i in 0..n {
            if i == root {
                let want = bake_out_root(p1[i], p0[root], axes, Axis::Y);
                assert_eq!(bits_t(got[i]), bits_t(want));
            } else {
                assert_eq!(bits_t(got[i]), bits_t(p1[i]), "bone {i} untouched");
            }
        }
    }
    let mut pose = soa_identity(5);
    set_bone(&mut pose, 4, at(v(1.0, 2.0, 3.0)));
    assert_eq!(bone(&pose, 4).translation.y, 2.0);
    assert_eq!(bone(&pose, 3).translation.y, 0.0);
}

// ---- sync ----------------------------------------------------------------------------------

const L: u32 = 1;
const R: u32 = 2;

fn mk(markers: &[SyncMarker], duration: f32, looping: bool) -> SyncClip<'_> {
    SyncClip {
        markers,
        duration,
        looping,
    }
}

fn m(id: u32, time: f32) -> SyncMarker {
    SyncMarker { id, time }
}

#[track_caller]
fn assert_phase(p: SyncPhase, marker: u32, id: u32, fraction: f32) {
    assert_eq!((p.marker, p.id), (marker, id), "{p:?}");
    near(p.fraction, fraction, 1e-6, "fraction");
}

#[test]
fn looping_phase_wraps_and_matches_across_clips() {
    let a_markers = [m(L, 0.0), m(R, 0.5)];
    let a = mk(&a_markers, 1.0, true);
    assert_phase(a.phase_at(0.25), 0, L, 0.5);
    assert_phase(a.phase_at(0.75), 1, R, 0.5);
    assert_phase(a.phase_at(0.0), 0, L, 0.0);
    // Wraps forward and backward.
    assert_phase(a.phase_at(1.25), 0, L, 0.5);
    assert_phase(a.phase_at(-0.25), 1, R, 0.5);
    assert_phase(a.phase_at(3.75), 1, R, 0.5);
    near(a.phase_at(1.25).normalized, 0.25, 1e-6, "normalized");

    // A longer clip with the same L R sequence at other times.
    let b_markers = [m(L, 0.2), m(R, 1.4)];
    let b = mk(&b_markers, 2.0, true);
    near(b.time_at(a.phase_at(0.25)), 0.2 + 0.5 * 1.2, 1e-6, "L half");
    // The R segment of b wraps past the end: 1.4 + 0.5 * (0.2 + 2.0 - 1.4) = 1.8.
    near(b.time_at(a.phase_at(0.75)), 1.8, 1e-6, "R half");
    // Before b's first marker (looping): the last segment, wrapped.
    let p = b.phase_at(0.1);
    assert_phase(p, 1, R, 0.875);
    near(b.time_at(p), 0.1, 1e-5, "wrapped back");
    // And a phase 0.95 into b's R segment lands at 1.4 + 0.95 * 0.8 - 2.0 after the wrap.
    let q = SyncPhase {
        marker: 1,
        id: R,
        fraction: 0.95,
        normalized: 0.0,
    };
    near(
        b.time_at(q),
        1.4 + 0.95 * 0.8 - 2.0,
        1e-5,
        "wraps into the next cycle",
    );
}

#[test]
fn phase_round_trips_between_clips_with_the_same_marker_sequence() {
    let mut rng = Rng::new(60);
    for _ in 0..500 {
        let k = 2 + rng.below(4) as usize;
        let mk_markers = |rng: &mut Rng, d: f32| -> Vec<SyncMarker> {
            let mut times: Vec<f32> = (0..k).map(|_| rng.range(0.0, d)).collect();
            times.sort_by(f32::total_cmp);
            times
                .iter()
                .enumerate()
                .map(|(i, &t)| m(1 + i as u32 % 2, t))
                .collect()
        };
        let (da, db) = (rng.range(0.5, 3.0), rng.range(0.5, 3.0));
        let (ma, mb) = (mk_markers(&mut rng, da), mk_markers(&mut rng, db));
        let looping = rng.below(2) == 0;
        let (a, b) = (mk(&ma, da, looping), mk(&mb, db, looping));
        let t = rng.range(0.0, da);
        let pa = a.phase_at(t);
        if pa.marker == NO_MARKER {
            continue;
        }
        let tb = b.time_at(pa);
        let pb = b.phase_at(tb);
        assert_eq!(
            pb.marker, pa.marker,
            "same segment: {pa:?} -> {tb} -> {pb:?}"
        );
        // Zero-length segments (equal marker times) have no fraction to speak of.
        let seg = (ma.get(pa.marker as usize + 1).map_or(da, |x| x.time)
            - ma[pa.marker as usize].time)
            .abs();
        if seg > 1e-3 {
            near(pb.fraction, pa.fraction, 2e-3, "fraction");
        }
        // And the time maps back into the first clip's segment.
        let back = a.time_at(pb);
        assert!(back >= 0.0 && back <= da);
    }
}

#[test]
fn clips_without_the_marker_fall_back_to_normalised_time() {
    let a_markers = [m(L, 0.0), m(R, 0.5)];
    let a = mk(&a_markers, 1.0, true);
    let p = a.phase_at(0.25);
    // A follower with no markers at all, and one with only other markers.
    let none = mk(&[], 3.0, true);
    near(none.time_at(p), 0.75, 1e-6, "no markers");
    let other_markers = [m(9, 0.1)];
    let other = mk(&other_markers, 3.0, true);
    near(other.time_at(p), 0.75, 1e-6, "no such id");
    // A leader without markers: its phase has none, the follower uses normalised time.
    let lp = none.phase_at(1.5);
    assert_eq!(lp.marker, NO_MARKER);
    near(lp.fraction, 0.5, 1e-6, "normalised fraction");
    let follower_markers = [m(L, 0.1), m(R, 0.6)];
    let follower = mk(&follower_markers, 2.0, true);
    near(follower.time_at(lp), 1.0, 1e-6, "leader has no markers");
    // The nearest marker with the id is used when the index doesn't exist in the follower.
    let long = [m(L, 0.0), m(R, 0.2), m(L, 0.5), m(R, 0.7)];
    let lead = mk(&long, 1.0, true);
    let p = lead.phase_at(0.85); // segment 3 (R), fraction 0.5
    assert_phase(p, 3, R, 0.5);
    let short_markers = [m(L, 0.0), m(R, 0.4)];
    let short = mk(&short_markers, 1.0, true);
    near(short.time_at(p), 0.4 + 0.5 * 0.6, 1e-6, "nearest R");
}

#[test]
fn non_looping_clips_clamp_and_have_no_phase_before_the_first_marker() {
    let markers = [m(L, 0.2), m(R, 1.4)];
    let c = mk(&markers, 2.0, false);
    let before = c.phase_at(0.1);
    assert_eq!(before.marker, NO_MARKER);
    near(before.fraction, 0.05, 1e-6, "normalised");
    // After the last marker the segment runs to the end of the clip.
    assert_phase(c.phase_at(1.8), 1, R, 0.4 / 0.6);
    // Past the end clamps (no wrap); before the start clamps to 0.
    assert_phase(c.phase_at(7.0), 1, R, 1.0);
    near(c.wrap_time(7.0), 2.0, 0.0, "clamped");
    near(c.wrap_time(-1.0), 0.0, 0.0, "clamped");
    near(
        c.time_at(SyncPhase {
            marker: 1,
            id: R,
            fraction: 1.0,
            normalized: 1.0,
        }),
        2.0,
        1e-6,
        "end",
    );
}

#[test]
fn degenerate_clips_never_produce_nan() {
    let none = mk(&[], 0.0, true);
    let p = none.phase_at(1.0);
    assert_eq!((p.marker, p.fraction, p.normalized), (NO_MARKER, 0.0, 0.0));
    assert_eq!(none.time_at(p), 0.0);
    let markers = [m(L, 0.5)];
    // One marker, looping: one segment of one full cycle.
    let one = mk(&markers, 1.0, true);
    assert_phase(one.phase_at(0.5), 0, L, 0.0);
    let p = one.phase_at(0.1);
    // The marker one cycle earlier is at -0.5, so 0.1 is 0.6 of the way along.
    assert_phase(p, 0, L, 0.6);
    near(one.time_at(p), 0.1, 1e-5, "wraps");
    // Two markers at the same time: zero-length segment, fraction 0, no NaN.
    let twin = [m(L, 0.5), m(R, 0.5)];
    let tw = mk(&twin, 1.0, true);
    let p = tw.phase_at(0.5);
    assert!(p.fraction == 0.0 && tw.time_at(p) == 0.5);
    // NaN and infinite times fold to something in range.
    let c = mk(&markers, 1.0, true);
    for t in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -1e-10, 1e30] {
        let w = c.wrap_time(t);
        assert!((0.0..1.0).contains(&w), "wrap_time({t}) = {w}");
        let p = c.phase_at(t);
        assert!(p.fraction.is_finite() && (0.0..=1.0).contains(&p.fraction));
    }
}

// ---- inertialization -----------------------------------------------------------------------

#[test]
fn quintic_hand_values() {
    // x0 = 1, v0 = a0 = 0, T = 2: the smoothstep-5 curve 1 - 10s^3 + 15s^4 - 6s^5.
    let q = Quintic::new(1.0, 0.0, 0.0, 2.0);
    near(q.eval(0.0), 1.0, 0.0, "x(0)");
    near(q.eval(1.0), 0.5, 1e-7, "x(T/2)");
    near(q.eval(2.0), 0.0, 0.0, "x(T)");
    near(q.eval(5.0), 0.0, 0.0, "after T");
    near(q.eval(-1.0), 1.0, 0.0, "before 0");
    near(q.velocity(0.0), 0.0, 0.0, "x'(0)");
    // dx/ds at s = 0.5 is -30s^2 + 60s^3 - 30s^4 = -1.875, and ds/dt = 1/2.
    near(q.velocity(1.0), -0.9375, 1e-6, "x'(T/2)");
    near(q.velocity(2.0), 0.0, 0.0, "x'(T)");

    // x0 = 1, v0 = -2, a0 = 0, T = 1: A = 0, B = -1, C = 2, D = 0, E = -2, F = 1, so
    // x(t) = -t^4 + 2t^3 - 2t + 1.
    let q = Quintic::new(1.0, -2.0, 0.0, 1.0);
    near(q.eval(0.0), 1.0, 0.0, "x(0)");
    near(q.eval(0.5), 0.1875, 1e-7, "x(T/2)");
    near(q.eval(1.0), 0.0, 0.0, "x(T)");
    near(q.velocity(0.0), -2.0, 1e-6, "x'(0)");
    near(
        q.velocity(0.5),
        -4.0 * 0.125 + 6.0 * 0.25 - 2.0,
        1e-6,
        "x'(T/2)",
    );
    // The end conditions from just inside T: x, x' and x'' all vanish (x'' by a difference).
    let e = 1e-3;
    // (The true values are O(e^3), O(e^2), O(e): about 1e-9, 1e-5 and 1e-2; f32 rounding of
    // terms of size 1 adds ~1e-7 to each evaluation.)
    near(q.eval(1.0 - e), 0.0, 1e-6, "x just before T");
    near(q.velocity(1.0 - e), 0.0, 1e-4, "x' just before T");
    let acc = (q.velocity(1.0 - e) - q.velocity(1.0 - 2.0 * e)) / e;
    near(acc, 0.0, 2e-2, "x'' just before T");

    // a0 only: x(s) = (w/2) s^2 - 1.5 w s^3 + 1.5 w s^4 - 0.5 w s^5 with w = a0 T^2 = 2.
    let q = Quintic::new(0.0, 0.0, 2.0, 1.0);
    near(q.eval(0.5), 0.03125, 1e-7, "a0 curve at T/2");
    near(q.eval(0.0), 0.0, 0.0, "x(0)");
    // A curve shorter than the minimum is the zero curve.
    let z = Quintic::new(1.0, 1.0, 1.0, 1e-6);
    assert_eq!((z.eval(0.0), z.duration()), (0.0, 0.0));
}

#[test]
fn the_quoted_coefficients_are_the_curve() {
    // The module docs quote A..F; check them in f64, and that Quintic's s-form is the same
    // polynomial and satisfies the six conditions.
    let mut rng = Rng::new(70);
    for _ in 0..500 {
        let x0 = rng.range(-3.0, 3.0) as f64;
        let v0 = rng.range(-5.0, 5.0) as f64;
        let a0 = rng.range(-20.0, 20.0) as f64;
        let big_t = rng.range(0.1, 2.0) as f64;
        let (t2, t3, t4, t5) = (big_t * big_t, big_t.powi(3), big_t.powi(4), big_t.powi(5));
        let a = -(a0 * t2 + 6.0 * v0 * big_t + 12.0 * x0) / (2.0 * t5);
        let b = (3.0 * a0 * t2 + 16.0 * v0 * big_t + 30.0 * x0) / (2.0 * t4);
        let c = -(3.0 * a0 * t2 + 12.0 * v0 * big_t + 20.0 * x0) / (2.0 * t3);
        let (d, e, f) = (a0 / 2.0, v0, x0);
        let x = |t: f64| (((((a * t + b) * t + c) * t + d) * t + e) * t) + f;
        let dx = |t: f64| ((((5.0 * a * t + 4.0 * b) * t + 3.0 * c) * t + 2.0 * d) * t) + e;
        let ddx = |t: f64| (((20.0 * a * t + 12.0 * b) * t + 6.0 * c) * t) + 2.0 * d;
        let scale = 1.0 + x0.abs() + (v0 * big_t).abs() + (a0 * t2).abs();
        assert!(
            (x(0.0) - x0).abs() < 1e-12
                && (dx(0.0) - v0).abs() < 1e-9
                && (ddx(0.0) - a0).abs() < 1e-6
        );
        assert!(x(big_t).abs() < 1e-9 * scale, "x(T) = {}", x(big_t));
        assert!(
            dx(big_t).abs() < 1e-8 * scale / big_t,
            "x'(T) = {}",
            dx(big_t)
        );
        assert!(
            ddx(big_t).abs() < 1e-6 * scale / t2,
            "x''(T) = {}",
            ddx(big_t)
        );
        let q = Quintic::new(x0 as f32, v0 as f32, a0 as f32, big_t as f32);
        for k in 0..8 {
            let t = big_t * (k as f64 / 8.0);
            let got = q.eval(t as f32) as f64;
            // f32 polynomial in s with coefficients up to ~15 * scale: 16 * 15U * scale.
            assert!(
                (got - x(t)).abs() <= 256.0 * U * scale,
                "k = {k}: {got} vs {}",
                x(t)
            );
        }
    }
}

#[test]
fn blend_time_clamp_values() {
    // Toward zero and fast: T' = 2.5 |x0| / |v0|.
    near(clamp_blend_time(1.0, -10.0, 1.0), 0.25, 1e-7, "toward zero");
    near(
        clamp_blend_time(-1.0, 10.0, 1.0),
        0.25,
        1e-7,
        "negative offset",
    );
    // Slow enough (limit 2.5 above T), away from zero, no velocity, no offset: unchanged.
    assert_eq!(clamp_blend_time(1.0, -1.0, 1.0), 1.0);
    assert_eq!(clamp_blend_time(1.0, 10.0, 1.0), 1.0);
    assert_eq!(clamp_blend_time(1.0, 0.0, 1.0), 1.0);
    assert_eq!(clamp_blend_time(0.0, -3.0, 1.0), 1.0);
}

#[test]
fn the_clamp_prevents_overshoot_and_is_needed() {
    // Without the clamp, k = |v0| T / |x0| = 5 dips below zero (the control).
    let unclamped = Quintic::new(1.0, -5.0, 0.0, 1.0);
    assert!(unclamped.eval(0.5) < -0.2);
    let mut rng = Rng::new(71);
    for _ in 0..500 {
        let x0 = rng.range(0.1, 3.0) * if rng.below(2) == 0 { 1.0 } else { -1.0 };
        let k = rng.range(0.0, 20.0);
        let big_t = rng.range(0.05, 1.0);
        // Velocity toward zero with |v0| T = k |x0|.
        let v0 = -x0.signum() * k * x0.abs() / big_t;
        let t = clamp_blend_time(x0, v0, big_t);
        let q = Quintic::new(x0, v0, 0.0, t);
        for i in 0..=200 {
            let x = q.eval(t * i as f32 / 200.0) * x0.signum();
            assert!(
                x >= -1e-5 * x0.abs(),
                "overshoot: x0 {x0} k {k} T {big_t}: {x}"
            );
        }
    }
}

fn single(t: AosTransform) -> Vec<SoaTransform> {
    soa(&[t])
}

#[test]
fn inertializer_decays_a_translation_offset_through_the_hand_values() {
    let dt = 1.0 / 30.0;
    let prev = at(v(1.0, 0.0, 0.0));
    let new = AosTransform::identity();
    // At rest (prev_prev = prev): x0 = 1, v0 = 0, T = 0.4.
    let mut inertia = Inertializer::new(1);
    inertia.begin(&single(prev), &single(prev), &single(new), dt, 0.4);
    assert!(inertia.is_active());
    let mut pose = single(new);
    assert!(inertia.apply(0.0, &mut pose));
    near(
        bone(&pose, 0).translation.x,
        1.0,
        1e-6,
        "t = 0 is the old pose",
    );
    let mut pose = single(new);
    assert!(inertia.apply(0.2, &mut pose));
    near(bone(&pose, 0).translation.x, 0.5, 1e-6, "t = T/2");
    let mut pose = single(new);
    assert!(!inertia.apply(0.2, &mut pose), "finished at T");
    assert_eq!(
        bits_t(bone(&pose, 0)),
        bits_t(new),
        "t = T is the new pose, untouched"
    );
    assert!(!inertia.is_active());
    assert!(!inertia.apply(0.1, &mut pose));
}

#[test]
fn inertializer_carries_the_old_velocity() {
    // x0 = 1 along +X, old velocity -2 per second (toward the new pose): the x(t) of the
    // x0 = 1, v0 = -2, T = 1 hand curve: 0.1875 at T/2.
    let dt = 1.0f32 / 30.0;
    let prev = at(v(1.0, 0.0, 0.0));
    let prev_prev = at(v(1.0 + 2.0 * dt, 0.0, 0.0));
    let new = AosTransform::identity();
    let mut inertia = Inertializer::new(1);
    inertia.begin(&single(prev), &single(prev_prev), &single(new), dt, 1.0);
    let mut pose = single(new);
    inertia.apply(0.0, &mut pose);
    near(bone(&pose, 0).translation.x, 1.0, 1e-6, "x(0)");
    let mut pose = single(new);
    inertia.apply(0.5, &mut pose);
    near(bone(&pose, 0).translation.x, 0.1875, 2e-5, "x(T/2)");
    // The velocity of the output at the start is the old velocity, to the cubic term:
    // (x(dt) - x(0)) / dt = v0 + c3 (dt/T)^3 / dt with c3 = -10 x0 - 6 v0 T = 2.
    let mut inertia = Inertializer::new(1);
    inertia.begin(&single(prev), &single(prev_prev), &single(new), dt, 1.0);
    let mut pose = single(new);
    inertia.apply(dt, &mut pose);
    let speed = (bone(&pose, 0).translation.x - 1.0) / dt;
    near(speed, -2.0, 0.1, "continuous velocity");
}

#[test]
fn inertializer_decays_a_rotation_offset() {
    let dt = 1.0f32 / 30.0;
    let prev = rot(about(Axis::Y, 1.0));
    let new = AosTransform::identity();
    let mut inertia = Inertializer::new(1);
    inertia.begin(&single(prev), &single(prev), &single(new), dt, 0.4);
    let angle = |p: &[SoaTransform]| {
        let q = bone(p, 0).rotation;
        2.0 * q.y.atan2(q.w)
    };
    let mut pose = single(new);
    inertia.apply(0.0, &mut pose);
    near(angle(&pose), 1.0, 1e-5, "angle(0)");
    let mut pose = single(new);
    inertia.apply(0.2, &mut pose);
    near(angle(&pose), 0.5, 1e-5, "angle(T/2)");
    let mut pose = single(new);
    assert!(!inertia.apply(0.2, &mut pose));
    assert_eq!(bits_t(bone(&pose, 0)), bits_t(new));
}

#[test]
fn inertializer_offsets_apply_on_top_of_the_new_animation_and_skip_padding() {
    let dt = 1.0f32 / 30.0;
    let n = 5;
    let mut rng = Rng::new(72);
    let prev = rng.pose(n);
    let new = rng.pose(n);
    let mut inertia = Inertializer::new(n);
    inertia.begin(&soa(&prev), &soa(&prev), &soa(&new), dt, 0.3);
    // The new animation moves on; at t = 0 the output is still the old pose at the old pose's
    // translation (offset = old - new at the switch, added to the new pose, which is unchanged).
    let mut pose = soa(&new);
    inertia.apply(0.0, &mut pose);
    for (got, want) in unsoa(&pose, n).iter().zip(&prev) {
        close_v(
            got.translation,
            v64(want.translation),
            256.0 * U,
            "starts at the old pose",
        );
        close_rot(
            got.rotation,
            q64(want.rotation),
            2e-6,
            "starts at the old rotation",
        );
        assert!(got.scale.x.is_finite());
    }
    assert_padding_identity(&pose, n, "padding");
    // A moved new pose keeps its own motion: bone 0 shifted by 2 in x after the switch.
    let mut shifted = new.clone();
    shifted[0].translation.x += 2.0;
    let mut pose = soa(&shifted);
    inertia.apply(0.0, &mut pose);
    let t = bone(&pose, 0).translation.x;
    near(
        t,
        prev[0].translation.x + 2.0,
        1e-4,
        "offset rides on the moved pose",
    );
}

#[test]
fn inertializer_never_overshoots_a_fast_approach() {
    // The old pose is 0.05 from the new and closing at 13.5 per second: unclamped, the quintic
    // would swing past zero. The clamp shortens this bone's blend, so x stays on its side.
    let dt = 1.0f32 / 30.0;
    let prev = at(v(0.05, 0.0, 0.0));
    let prev_prev = at(v(0.05 + 13.5 * dt, 0.0, 0.0));
    let new = AosTransform::identity();
    let mut inertia = Inertializer::new(1);
    inertia.begin(&single(prev), &single(prev_prev), &single(new), dt, 1.0);
    let limit = 2.5 * 0.05 / 13.5;
    near(
        inertia.bones()[0].pos.duration(),
        limit,
        1e-4,
        "clamped blend time",
    );
    for _ in 0..200 {
        let mut pose = single(new);
        inertia.apply(0.001, &mut pose);
        assert!(bone(&pose, 0).translation.x >= -1e-6, "overshoot");
    }
}

#[test]
fn inertializer_cut_and_restart_and_no_offset() {
    let dt = 1.0f32 / 30.0;
    let mut rng = Rng::new(73);
    let (prev, new) = (rng.pose(5), rng.pose(5));
    let mut inertia = Inertializer::new(5);
    // A blend time under the minimum is a cut: nothing happens.
    inertia.begin(&soa(&prev), &soa(&prev), &soa(&new), dt, 0.0);
    assert!(!inertia.is_active());
    let mut pose = soa(&new);
    assert!(!inertia.apply(dt, &mut pose));
    assert_bits_eq(&unsoa(&pose, 5), &new, "cut leaves the pose alone");
    // dt <= 0 gives zero velocities and no NaN.
    inertia.begin(&soa(&prev), &soa(&prev), &soa(&new), 0.0, 0.3);
    let mut pose = soa(&new);
    inertia.apply(0.1, &mut pose);
    for t in unsoa(&pose, 5) {
        assert!(bits_t(t).iter().all(|&b| f32::from_bits(b).is_finite()));
    }
    // Restarting while active resets the clock; cancel stops it.
    inertia.begin(&soa(&prev), &soa(&prev), &soa(&new), dt, 0.3);
    inertia.apply(0.1, &mut pose);
    assert!(inertia.elapsed() > 0.0);
    inertia.begin(&soa(&prev), &soa(&prev), &soa(&new), dt, 0.3);
    assert_eq!(inertia.elapsed(), 0.0);
    inertia.cancel();
    let mut pose = soa(&new);
    assert!(!inertia.apply(dt, &mut pose));
    assert_bits_eq(&unsoa(&pose, 5), &new, "cancelled");
    // The same pose before and after: no offset (only the rounding of q * q⁻¹, ~1e-7), so the new
    // pose comes back.
    inertia.begin(&soa(&new), &soa(&new), &soa(&new), dt, 0.3);
    let mut pose = soa(&new);
    assert!(inertia.apply(0.1, &mut pose));
    let tol = Tol {
        t: 0.0,
        r: 1e-6,
        s: 0.0,
    };
    close_pose(&unsoa(&pose, 5), &pose64(&new), tol, "zero offset");
    assert_eq!(inertia.bone_count(), 5);
}
