//! Mirroring a local pose across a plane through the model origin, through a left/right bone map.
//!
//! `partner[i]` is the bone whose motion bone `i` takes over, mirrored: the other side's bone for
//! a left or right bone, `i` itself for a centre bone (the profile's left/right map, ADR 0342).
//! The map has one entry per bone; an entry out of range counts as the bone itself.
//!
//! The reflection of a local transform across the plane with normal axis `a`: the translation's
//! `a` component changes sign, and a rotation `(x, y, z, w)` keeps its angle and reflects its axis
//! as a pseudo-vector, so the two components other than `a` (and not `w`) change sign; scale is
//! unchanged. For `a = X`: `t -> (-tx, ty, tz)`, `q -> (qx, -qy, -qz, qw)`.
//!
//! **Assumption** of [`mirror`]: the two sides of the skeleton are *mirror images in local space*:
//! their local frames are reflections of each other (rigs built by mirroring, as in most DCC
//! tools), and the centre bones' local axes are aligned with the model axes (decision D18).
//!
//! # Flip table
//!
//! A rig whose sides use another convention (the right side's frames turned a half turn about one
//! local axis, as Maya's "behavior" mirroring and many exporters leave them; or a centre bone whose
//! axes aren't the model's) needs a per-bone correction, the *flip table* ([`FlipTable`], from the
//! skeleton profile; [`flips_from_rest`] derives it from the rest pose). With `M` the reflection and
//! `C_i` bone `i`'s flip (identity or a half turn about its local X, Y or Z), the rest pose
//! satisfies `R_i = M·R_p·M·C_i` in model space (`p` the partner), and the mirrored local is
//!
//! `t_i' = C_par(i)⁻¹ · (M t_p)`, `q_i' = C_par(i)⁻¹ · (M q_p M) · C_i`
//!
//! (`par(i)` is bone `i`'s parent; a root has no parent flip). A half turn's quaternion is a unit
//! axis with `w = 0`, so the correction only swaps and negates components: it stays exact, and
//! mirroring twice with a consistent table returns the input (up to each quaternion's sign).
//! An all-[`Flip::None`] table gives
//! exactly [`mirror`].

use crate::Axis;
use anim_math::layout::{soa_len, LANES, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, Lane, QuatT, SoaTransform, TransformT, Vec3T};

/// A bone's mirror correction: none, or a half turn about one of its local axes (see the module
/// docs). Stored as one byte per bone (`0..=3`) wherever it crosses a boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Flip {
    #[default]
    None = 0,
    X = 1,
    Y = 2,
    Z = 3,
}

impl Flip {
    /// The flip for a stored byte (`0..=3`), or `None` for any other value.
    pub fn from_u8(v: u8) -> Option<Flip> {
        match v {
            0 => Some(Flip::None),
            1 => Some(Flip::X),
            2 => Some(Flip::Y),
            3 => Some(Flip::Z),
            _ => None,
        }
    }

    /// The correction as a unit quaternion (identity, or `(1,0,0,0)`, `(0,1,0,0)`, `(0,0,1,0)`).
    #[inline]
    pub fn quat(self) -> AosQuat {
        match self {
            Flip::None => AosQuat::identity(),
            Flip::X => AosQuat::new(1.0, 0.0, 0.0, 0.0),
            Flip::Y => AosQuat::new(0.0, 1.0, 0.0, 0.0),
            Flip::Z => AosQuat::new(0.0, 0.0, 1.0, 0.0),
        }
    }

    /// `C⁻¹ · v`: a half turn is its own inverse, so this negates the two other components.
    #[inline]
    fn turn_vec(self, v: AosVec3) -> AosVec3 {
        match self {
            Flip::None => v,
            Flip::X => AosVec3::new(v.x, -v.y, -v.z),
            Flip::Y => AosVec3::new(-v.x, v.y, -v.z),
            Flip::Z => AosVec3::new(-v.x, -v.y, v.z),
        }
    }
}

/// A per-bone flip table and the skeleton's parents (each bone's correction also undoes its
/// parent's). Both have one entry per bone.
#[derive(Clone, Copy, Debug)]
pub struct FlipTable<'a> {
    pub parents: &'a [u16],
    pub flips: &'a [Flip],
}

/// The reflection of one local transform across the plane with normal `axis`. Exact (only sign
/// changes), so applying it twice returns the input.
#[inline(always)]
pub fn mirror_transform<L: Lane>(t: TransformT<L>, axis: Axis) -> TransformT<L> {
    let (p, q) = (t.translation, t.rotation);
    let (translation, rotation) = match axis {
        Axis::X => (Vec3T::new(-p.x, p.y, p.z), QuatT::new(q.x, -q.y, -q.z, q.w)),
        Axis::Y => (Vec3T::new(p.x, -p.y, p.z), QuatT::new(-q.x, q.y, -q.z, q.w)),
        Axis::Z => (Vec3T::new(p.x, p.y, -p.z), QuatT::new(-q.x, -q.y, q.z, q.w)),
    };
    TransformT::new(translation, rotation, t.scale)
}

/// `out[i]` = the mirror of `pose[partner[i]]`, for the SoA pose of `partner.len()` bones.
/// Spare lanes of the last group are identity. Pose and `out` are distinct slices.
///
/// Panics unless `pose.len() == out.len() == soa_len(partner.len())`. Never allocates. It gathers
/// across lanes (a partner can sit in any group), so it is a scalar pass over the bones; the
/// graph mirrors only when a mirror node asks for it.
#[inline]
pub fn mirror(pose: &[SoaTransform], partner: &[u16], axis: Axis, out: &mut [SoaTransform]) {
    mirror_flipped(pose, partner, axis, None, out);
}

/// [`mirror`] with an optional per-bone [`FlipTable`] (see the module docs). `None`, or a table of
/// all [`Flip::None`], gives exactly [`mirror`]'s result.
///
/// Panics unless `pose.len() == out.len() == soa_len(partner.len())` and, with a table, its
/// `parents` and `flips` have `partner.len()` entries. Never allocates.
#[inline]
pub fn mirror_flipped(
    pose: &[SoaTransform],
    partner: &[u16],
    axis: Axis,
    flips: Option<FlipTable<'_>>,
    out: &mut [SoaTransform],
) {
    let n = partner.len();
    assert_eq!(pose.len(), soa_len(n), "SoA pose length");
    assert_eq!(out.len(), soa_len(n), "SoA pose length");
    if let Some(f) = flips {
        assert_eq!(f.parents.len(), n, "flip table parents");
        assert_eq!(f.flips.len(), n, "flip table flips");
    }
    for (g, o) in out.iter_mut().enumerate() {
        let lanes: [AosTransform; LANES] = core::array::from_fn(|l| {
            let i = g * LANES + l;
            if i >= n {
                return AosTransform::identity();
            }
            let p = partner[i] as usize;
            let src = if p < n { p } else { i };
            let m = mirror_transform(pose[src / LANES].lane(src % LANES), axis);
            match flips {
                None => m,
                Some(f) => correct(m, i, f),
            }
        });
        *o = SoaTransform::from_aos(&lanes);
    }
}

/// Applies bone `i`'s flip correction to its mirrored local `m`.
#[inline]
fn correct(m: AosTransform, i: usize, f: FlipTable<'_>) -> AosTransform {
    let own = f.flips[i];
    let pi = f.parents[i];
    let parent = if pi == NO_PARENT || pi as usize >= f.flips.len() {
        Flip::None
    } else {
        f.flips[pi as usize]
    };
    if own == Flip::None && parent == Flip::None {
        return m;
    }
    // C⁻¹ = -C as a quaternion; the sign doesn't change the rotation, and a product with a
    // half turn's quaternion only swaps and negates components (exact).
    let mut q = m.rotation;
    if parent != Flip::None {
        q = parent.quat().conjugate() * q;
    }
    if own != Flip::None {
        q = q * own.quat();
    }
    if q.w < 0.0 {
        q = -q;
    }
    TransformT::new(parent.turn_vec(m.translation), q, m.scale)
}

/// Derives each bone's [`Flip`] from the rest pose's model-space rotations: the correction
/// `C_i = (M·R_p·M)⁻¹·R_i` snapped to the nearest of the four choices (largest `|q·c|`). A bone
/// whose sides aren't mirror images under any choice gets the nearest one anyway. `rest_model`,
/// `partner` and `out` have one entry per bone (a partner out of range counts as the bone itself).
/// Setup work (not the hot path); never allocates.
pub fn flips_from_rest(rest_model: &[AosTransform], partner: &[u16], axis: Axis, out: &mut [Flip]) {
    let n = rest_model.len();
    assert_eq!(partner.len(), n, "partner map length");
    assert_eq!(out.len(), n, "flip table length");
    for i in 0..n {
        let p = partner[i] as usize;
        let src = if p < n { p } else { i };
        let mirrored = mirror_transform(rest_model[src], axis).rotation;
        let c = mirrored.conjugate() * rest_model[i].rotation;
        // |q·c| for c = identity, X, Y, Z half turns is |w|, |x|, |y|, |z|.
        let cand = [
            (c.w.abs(), Flip::None),
            (c.x.abs(), Flip::X),
            (c.y.abs(), Flip::Y),
            (c.z.abs(), Flip::Z),
        ];
        let mut best = cand[0];
        for k in &cand[1..] {
            if k.0 > best.0 {
                best = *k;
            }
        }
        out[i] = best.1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anim_math::layout::{local_to_model, pack_pose, unpack_pose};

    fn v(x: f32, y: f32, z: f32) -> AosVec3 {
        AosVec3::new(x, y, z)
    }

    fn t(p: AosVec3, q: AosQuat) -> AosTransform {
        AosTransform::new(p, q.normalize_or_identity(), AosVec3::one())
    }

    fn soa(p: &[AosTransform]) -> Vec<SoaTransform> {
        let mut s = vec![SoaTransform::identity(); soa_len(p.len())];
        pack_pose(p, &mut s);
        s
    }

    fn aos(s: &[SoaTransform], n: usize) -> Vec<AosTransform> {
        let mut a = vec![AosTransform::identity(); n];
        unpack_pose(s, &mut a);
        a
    }

    fn model(parents: &[u16], p: &[AosTransform]) -> Vec<AosTransform> {
        let mut m = vec![AosTransform::identity(); p.len()];
        local_to_model(parents, &soa(p), &mut m);
        m
    }

    /// A centre root, a left arm (bones 1, 2) and a right arm (3, 4) whose frames are the left's
    /// mirror turned a half turn about local Z (the "behavior" convention), so the flip is Z on
    /// both sides (the table is symmetric).
    fn rig() -> (Vec<u16>, Vec<AosTransform>, Vec<u16>) {
        let parents = vec![NO_PARENT, 0, 1, 0, 3];
        let ql = AosQuat::new(0.1, 0.3, -0.2, 0.9).normalize_or_identity();
        let lm = t(v(0.2, 1.4, 0.0), ql);
        // Right rest model rotation = M·ql·M·C (C = Z half turn).
        let mr = (mirror_transform(lm, Axis::X).rotation * Flip::Z.quat()).normalize_or_identity();
        let rm = AosTransform::new(v(-0.2, 1.4, 0.0), mr, AosVec3::one());
        let root = t(v(0.0, 0.0, 0.0), AosQuat::identity());
        // Child bones 0.3 m along each arm's model direction (+X on the left, -X on the right).
        let l2 = t(lm.rotation.conjugate().rotate(v(0.3, 0.0, 0.0)), AosQuat::identity());
        let r2 = t(rm.rotation.conjugate().rotate(v(-0.3, 0.0, 0.0)), AosQuat::identity());
        (parents, vec![root, lm, l2, rm, r2], vec![0, 3, 4, 1, 2])
    }

    #[test]
    fn none_table_matches_mirror_bit_for_bit() {
        let (parents, locals, partner) = rig();
        let flips = vec![Flip::None; 5];
        let mut a = vec![SoaTransform::identity(); soa_len(5)];
        let mut b = a.clone();
        mirror(&soa(&locals), &partner, Axis::X, &mut a);
        let table = FlipTable {
            parents: &parents,
            flips: &flips,
        };
        mirror_flipped(&soa(&locals), &partner, Axis::X, Some(table), &mut b);
        for (x, y) in aos(&a, 5).iter().zip(aos(&b, 5).iter()) {
            let (qx, qy) = (x.rotation, y.rotation);
            assert_eq!(
                [qx.x, qx.y, qx.z, qx.w].map(f32::to_bits),
                [qy.x, qy.y, qy.z, qy.w].map(f32::to_bits)
            );
            let (px, py) = (x.translation, y.translation);
            assert_eq!(
                [px.x, px.y, px.z].map(f32::to_bits),
                [py.x, py.y, py.z].map(f32::to_bits)
            );
        }
    }

    #[test]
    fn flip_table_mirrors_model_space_and_keeps_rest() {
        let (parents, mut locals, partner) = rig();
        let rest_model = model(&parents, &locals);
        let mut flips = vec![Flip::None; 5];
        flips_from_rest(&rest_model, &partner, Axis::X, &mut flips);
        assert_eq!(flips, vec![Flip::None, Flip::Z, Flip::Z, Flip::Z, Flip::Z]);
        let table = FlipTable {
            parents: &parents,
            flips: &flips,
        };
        // The rest pose mirrors onto itself.
        let mut out = vec![SoaTransform::identity(); soa_len(5)];
        mirror_flipped(&soa(&locals), &partner, Axis::X, Some(table), &mut out);
        let m = model(&parents, &aos(&out, 5));
        for i in 0..5 {
            let d = m[i].translation - rest_model[i].translation;
            assert!(d.length() < 1e-5, "rest bone {i} moved by {}", d.length());
            let dq = m[i].rotation.dot(rest_model[i].rotation).abs();
            assert!(dq > 1.0 - 1e-5, "rest bone {i} turned");
        }
        // Bend the left arm; the mirrored pose puts every right bone at the reflection.
        locals[1].rotation =
            (locals[1].rotation * AosQuat::new(0.0, 0.0, 0.38, 0.92)).normalize_or_identity();
        locals[2].rotation = AosQuat::new(0.2, 0.1, 0.0, 0.97).normalize_or_identity();
        let posed = model(&parents, &locals);
        mirror_flipped(&soa(&locals), &partner, Axis::X, Some(table), &mut out);
        let mirrored = model(&parents, &aos(&out, 5));
        let r = |p: AosVec3| v(-p.x, p.y, p.z);
        for (i, &p) in partner.iter().enumerate() {
            let d = mirrored[i].translation - r(posed[p as usize].translation);
            assert!(d.length() < 1e-5, "bone {i}: {}", d.length());
            let want = mirror_transform(posed[p as usize], Axis::X).rotation * flips[i].quat();
            assert!(mirrored[i].rotation.dot(want).abs() > 1.0 - 1e-6, "bone {i}");
        }
        // Mirroring twice returns the input rotations.
        let mut back = vec![SoaTransform::identity(); soa_len(5)];
        mirror_flipped(&out, &partner, Axis::X, Some(table), &mut back);
        for (i, b) in aos(&back, 5).iter().enumerate() {
            assert!(b.rotation.dot(locals[i].rotation).abs() > 1.0 - 1e-6, "bone {i}");
        }
        // Without the table the right arm's frame comes out a half turn off (its frames aren't
        // mirror images of the left's).
        mirror(&soa(&locals), &partner, Axis::X, &mut out);
        let plain = model(&parents, &aos(&out, 5));
        assert!(plain[3].rotation.dot(mirrored[3].rotation).abs() < 1e-3);
    }
}
