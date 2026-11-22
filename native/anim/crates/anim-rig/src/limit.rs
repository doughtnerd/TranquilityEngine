//! Joint rotation limits: a swing-twist decomposition relative to the rest rotation, with an
//! elliptical swing cone and a twist range — the model of `myco.skel@1`'s `JOINT_RANGES`.

use crate::geom::swing_twist;
use anim_format::skeleton::JointRange;
use anim_math::trig::atan2;
use anim_math::{AosQuat, AosVec3};

/// A rotation limit on one bone's **local** rotation, measured relative to `rest`.
///
/// # Model
///
/// With `rel = rest⁻¹ · local` split as `rel = swing · twist` about the bone's local **+X** axis
/// (the twist axis, as `JOINT_RANGES` defines it; [`swing_twist`]):
///
/// - **Twist**: the signed angle `θt = 2·atan2(twist.x, twist.w)` (sign-fixed to `w ≥ 0`, so
///   `θt ∈ [−π, π]`) is clamped to `[twist_min, twist_max]`.
/// - **Swing**: the swing's rotation vector `θ·a` (axis `a ⟂ X`, angle `θ ∈ [0, π]`) has
///   components `θy` about Y and `θz` about Z. It must lie inside the ellipse
///   `(θy / swing_y)² + (θz / swing_z)² ≤ 1`; outside, the vector is scaled back onto it along
///   the same direction (radial projection, as PhysX's elliptical cone). A zero half-axis
///   forbids swing about that axis.
///
/// The limited rotation is `rest · swing' · twist'`. Angles are radians; any swing half-axis of π
/// or more and a twist range covering `[−π, π]` make the limit free.
#[derive(Clone, Copy, Debug)]
pub struct JointLimit {
    /// The rest local rotation the limits are measured from.
    pub rest: AosQuat,
    /// Swing half-axis about local Y, radians in `[0, π]`.
    pub swing_y: f32,
    /// Swing half-axis about local Z, radians in `[0, π]`.
    pub swing_z: f32,
    /// Twist minimum about local X, radians in `[−π, π]`.
    pub twist_min: f32,
    /// Twist maximum, radians in `[twist_min, π]`.
    pub twist_max: f32,
}

const PI: f32 = core::f32::consts::PI;

impl JointLimit {
    /// No limit.
    pub const FREE: JointLimit = JointLimit {
        rest: AosQuat {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            w: 1.0,
        },
        swing_y: PI,
        swing_z: PI,
        twist_min: -PI,
        twist_max: PI,
    };

    /// From a skeleton's joint range (degrees) and the bone's rest local rotation.
    pub fn from_range(rest: AosQuat, range: &JointRange) -> Self {
        let r = PI / 180.0;
        Self {
            rest,
            swing_y: range.swing_y * r,
            swing_z: range.swing_z * r,
            twist_min: range.twist_min * r,
            twist_max: range.twist_max * r,
        }
    }

    /// Whether the limit can never change a rotation.
    pub fn is_free(&self) -> bool {
        self.swing_y >= PI && self.swing_z >= PI && self.twist_min <= -PI && self.twist_max >= PI
    }

    /// `local`, limited (see the type's docs). Returns `local` itself when it is inside.
    pub fn apply(&self, local: AosQuat) -> AosQuat {
        self.limit(local).unwrap_or(local)
    }

    /// The limited rotation, or `None` when `local` is already inside the limit.
    pub fn limit(&self, local: AosQuat) -> Option<AosQuat> {
        if self.is_free() {
            return None;
        }
        let rel = (self.rest.conjugate() * local).normalize_or_identity();
        let (swing, twist) = swing_twist(rel, AosVec3::new(1.0, 0.0, 0.0));
        let mut changed = false;

        // Twist.
        let tw = if twist.w < 0.0 { -twist } else { twist };
        let twist_angle = 2.0 * atan2(tw.x, tw.w);
        let clamped_twist = twist_angle.max(self.twist_min).min(self.twist_max);
        let twist = if clamped_twist != twist_angle {
            changed = true;
            AosQuat::from_axis_angle(AosVec3::new(1.0, 0.0, 0.0), clamped_twist)
        } else {
            twist
        };

        // Swing.
        let sw = if swing.w < 0.0 { -swing } else { swing };
        let v = AosVec3::new(0.0, sw.y, sw.z);
        let len = v.length();
        let swing = if len > 1e-9 {
            let angle = 2.0 * atan2(len, sw.w);
            let mut ty = angle * (sw.y / len);
            let mut tz = angle * (sw.z / len);
            let mut out = false;
            if self.swing_y < 1e-6 && ty != 0.0 {
                ty = 0.0;
                out = true;
            }
            if self.swing_z < 1e-6 && tz != 0.0 {
                tz = 0.0;
                out = true;
            }
            let ey = if self.swing_y < 1e-6 {
                0.0
            } else {
                ty / self.swing_y
            };
            let ez = if self.swing_z < 1e-6 {
                0.0
            } else {
                tz / self.swing_z
            };
            let e = ey * ey + ez * ez;
            if e > 1.0 {
                let k = 1.0 / e.sqrt();
                ty *= k;
                tz *= k;
                out = true;
            }
            if out {
                changed = true;
                let a = (ty * ty + tz * tz).sqrt();
                if a > 0.0 {
                    let axis = AosVec3::new(0.0, ty / a, tz / a);
                    AosQuat::from_axis_angle(axis, a)
                } else {
                    AosQuat::identity()
                }
            } else {
                swing
            }
        } else {
            swing
        };

        if !changed {
            return None;
        }
        Some((self.rest * swing * twist).normalize_or_identity())
    }
}

impl Default for JointLimit {
    fn default() -> Self {
        Self::FREE
    }
}
