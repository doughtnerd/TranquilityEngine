//! Root motion: the root bone's movement between two poses, and removing it from a pose.
//!
//! The root bone's local transform is expressed in its parent's space (the character's space).
//! Between two poses of the same clip:
//!
//! - the **translation delta** is `to.t - from.t`, in the root's parent space;
//! - the **rotation delta** is `to.r * from.r⁻¹`, also in the parent space (shortest path, `w >= 0`).
//!   With [`RootRotation::Yaw`] only its twist about the up axis is kept
//!   (`normalize(0, c, 0, w)`, `c` the up component, no trigonometry); with
//!   [`RootRotation::Full`] all of it; with [`RootRotation::None`] none.
//!
//! [`RootMotionAxes`] says which components are root motion: a component that isn't is left out
//! of the delta (zero or identity) and is **not** touched by [`bake_out_root`] (it stays as
//! animation). Removing ("baking out") sets each flagged component back to a reference root
//! (usually the clip's first frame, or the bind pose), so the character stays put in place while
//! the other bones keep animating.
//!
//! Deltas over a loop seam are the sum of two deltas ([`RootDelta::then`]): `from -> clip end`,
//! then `clip start -> to`.

use crate::Axis;
use anim_math::trig::atan2;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};

/// How much of the root's rotation counts as root motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RootRotation {
    /// None: the rotation stays animation.
    None,
    /// The twist about the up axis only (turning in place, facing).
    #[default]
    Yaw,
    /// The whole rotation.
    Full,
}

/// Which components of the root bone are root motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RootMotionAxes {
    /// Translation along x, y, z of the root's parent space.
    pub translate: [bool; 3],
    pub rotation: RootRotation,
}

impl RootMotionAxes {
    /// Nothing is root motion.
    pub const NONE: Self = Self {
        translate: [false; 3],
        rotation: RootRotation::None,
    };
    /// Everything is root motion.
    pub const ALL: Self = Self {
        translate: [true; 3],
        rotation: RootRotation::Full,
    };

    /// Ground-plane translation (the two axes other than `up`) and yaw about `up`: the usual
    /// locomotion root motion.
    pub fn planar_yaw(up: Axis) -> Self {
        let mut translate = [true; 3];
        translate[axis_index(up)] = false;
        Self {
            translate,
            rotation: RootRotation::Yaw,
        }
    }
}

impl Default for RootMotionAxes {
    /// [`RootMotionAxes::planar_yaw`] for +Y up.
    fn default() -> Self {
        Self::planar_yaw(Axis::Y)
    }
}

/// A root movement between two times, in the root's parent space.
#[derive(Clone, Copy, Debug)]
pub struct RootDelta {
    pub translation: AosVec3,
    /// A unit quaternion; identity when the rotation isn't root motion.
    pub rotation: AosQuat,
}

impl RootDelta {
    pub fn identity() -> Self {
        Self {
            translation: AosVec3::zero(),
            rotation: AosQuat::identity(),
        }
    }

    /// This delta followed by `next` (both in the same parent space): translations add, the
    /// rotation is `next.r * self.r`. For a movement split at a loop seam.
    pub fn then(self, next: Self) -> Self {
        Self {
            translation: self.translation + next.translation,
            rotation: (next.rotation * self.rotation).normalize_or_identity(),
        }
    }

    /// The rotation's twist angle about `up` in radians, in [-π, π] (3e-7 accurate; uses the
    /// crate's deterministic polynomial `atan2`).
    pub fn yaw_angle(&self, up: Axis) -> f32 {
        let q = positive_w(self.rotation);
        2.0 * atan2(component(q, up), q.w)
    }
}

/// The root bone's movement from `from` to `to` (both the root's local transform), for the
/// components `axes` flags. Never allocates.
#[inline]
pub fn root_delta(
    from: AosTransform,
    to: AosTransform,
    axes: RootMotionAxes,
    up: Axis,
) -> RootDelta {
    let d = to.translation - from.translation;
    let pick = |i: usize, v: f32| if axes.translate[i] { v } else { 0.0 };
    let rotation = match axes.rotation {
        RootRotation::None => AosQuat::identity(),
        RootRotation::Full => positive_w(to.rotation * from.rotation.conjugate()),
        RootRotation::Yaw => twist(to.rotation * from.rotation.conjugate(), up),
    };
    RootDelta {
        translation: AosVec3::new(pick(0, d.x), pick(1, d.y), pick(2, d.z)),
        rotation,
    }
}

/// [`root_delta`] between the root bone `root` of two SoA poses.
#[inline]
pub fn extract_root_delta(
    from: &[SoaTransform],
    to: &[SoaTransform],
    root: usize,
    axes: RootMotionAxes,
    up: Axis,
) -> RootDelta {
    root_delta(crate::bone(from, root), crate::bone(to, root), axes, up)
}

/// `t` with the flagged root-motion components set back to `reference`'s: flagged translation
/// axes take the reference's value; [`RootRotation::Full`] takes its rotation; [`RootRotation::Yaw`]
/// removes the yaw of `t` relative to `reference` (`t.r` with the twist about `up` of
/// `t.r * reference.r⁻¹` taken off from the left), keeping tilt and the reference's heading.
/// Scale is untouched.
#[inline]
pub fn bake_out_root(
    t: AosTransform,
    reference: AosTransform,
    axes: RootMotionAxes,
    up: Axis,
) -> AosTransform {
    let pick = |i: usize, own: f32, reference: f32| if axes.translate[i] { reference } else { own };
    let rotation = match axes.rotation {
        RootRotation::None => t.rotation,
        RootRotation::Full => reference.rotation,
        RootRotation::Yaw => {
            let yaw = twist(t.rotation * reference.rotation.conjugate(), up);
            (yaw.conjugate() * t.rotation).normalize_or_identity()
        }
    };
    AosTransform::new(
        AosVec3::new(
            pick(0, t.translation.x, reference.translation.x),
            pick(1, t.translation.y, reference.translation.y),
            pick(2, t.translation.z, reference.translation.z),
        ),
        rotation,
        t.scale,
    )
}

/// [`bake_out_root`] on bone `root` of an SoA pose, in place. The other bones are untouched.
#[inline]
pub fn bake_out_root_motion(
    pose: &mut [SoaTransform],
    root: usize,
    reference: AosTransform,
    axes: RootMotionAxes,
    up: Axis,
) {
    let t = crate::bone(pose, root);
    crate::set_bone(pose, root, bake_out_root(t, reference, axes, up));
}

fn axis_index(a: Axis) -> usize {
    match a {
        Axis::X => 0,
        Axis::Y => 1,
        Axis::Z => 2,
    }
}

fn component(q: AosQuat, a: Axis) -> f32 {
    match a {
        Axis::X => q.x,
        Axis::Y => q.y,
        Axis::Z => q.z,
    }
}

fn positive_w(q: AosQuat) -> AosQuat {
    if q.w < 0.0 {
        -q
    } else {
        q
    }
}

/// The rotation about `up` that `q` is made of when written `twist * swing`: `normalize(c, w)`.
fn twist(q: AosQuat, up: Axis) -> AosQuat {
    let q = positive_w(q);
    let z = 0.0;
    match up {
        Axis::X => AosQuat::new(q.x, z, z, q.w),
        Axis::Y => AosQuat::new(z, q.y, z, q.w),
        Axis::Z => AosQuat::new(z, z, q.z, q.w),
    }
    .normalize_or_identity()
}
