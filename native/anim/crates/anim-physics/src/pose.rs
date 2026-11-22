//! Body frames and bone frames, and the simulated bodies back as the skeleton's local pose.
//!
//! A body's pose is `(p, R_bone · J)` for a bone at model position `p` with model rotation
//! `R_bone` and joint frame `J` (crate docs). [`bodies_to_local`] is the physical-pose graph
//! input's conversion: bones with a simulated body take its pose (rotation and position; scale
//! stays the fallback pose's), the others keep the fallback pose's local transform below their
//! (possibly simulated) parent, as PuppetMaster leaves unmapped bones animated.

use anim_math::layout::{LANES, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};

/// A rigid body's pose in model space (no scale).
#[derive(Clone, Copy, Debug)]
pub struct BodyPose {
    pub position: AosVec3,
    pub rotation: AosQuat,
}

impl Default for BodyPose {
    fn default() -> Self {
        BodyPose {
            position: AosVec3::zero(),
            rotation: AosQuat::identity(),
        }
    }
}

/// The body pose of a bone with model transform `model` and joint frame `joint_frame`.
#[inline]
pub fn body_from_bone(model: &AosTransform, joint_frame: AosQuat) -> BodyPose {
    BodyPose {
        position: model.translation,
        rotation: (model.rotation * joint_frame).normalize_or_identity(),
    }
}

/// The bone's model position and rotation from its body's pose (the inverse of
/// [`body_from_bone`] up to rounding).
#[inline]
pub fn bone_from_body(body: &BodyPose, joint_frame: AosQuat) -> BodyPose {
    BodyPose {
        position: body.position,
        rotation: (body.rotation * joint_frame.conjugate()).normalize_or_identity(),
    }
}

/// Replaces bones of the local pose `local` (SoA, the skeleton's groups) by simulated ones:
/// `bone(b)` gives bone `b`'s model-space position and rotation when it is simulated (from
/// [`bone_from_body`]), `None` to keep `local`'s transform below its parent. Bones are visited
/// parents first; `model` is scratch of at least one transform per bone. Never allocates.
pub fn bodies_to_local(
    parents: &[u16],
    mut bone: impl FnMut(usize) -> Option<BodyPose>,
    local: &mut [SoaTransform],
    model: &mut [AosTransform],
) {
    let n = parents.len().min(model.len()).min(local.len() * LANES);
    for b in 0..n {
        let g = &mut local[b / LANES];
        let mut lanes = g.to_aos();
        let fallback = lanes[b % LANES];
        let p = parents[b];
        let parent = if p == NO_PARENT || p as usize >= b {
            None
        } else {
            Some(model[p as usize])
        };
        let l = match bone(b) {
            Some(s) => {
                let (t, r) = match parent {
                    Some(pm) => (
                        pm.inverse().transform_point(s.position),
                        (pm.rotation.conjugate() * s.rotation).normalize_or_identity(),
                    ),
                    None => (s.position, s.rotation),
                };
                AosTransform::new(t, r, fallback.scale)
            }
            None => fallback,
        };
        lanes[b % LANES] = l;
        *g = SoaTransform::from_aos(&lanes);
        model[b] = match parent {
            Some(pm) => pm.compose(l),
            None => l,
        };
    }
}
