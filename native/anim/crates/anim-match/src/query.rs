//! Building a query: the current pose and the predicted trajectory, as features, normalised and
//! weighted like the database's rows (runtime; never allocates).
//!
//! The pose comes in **character space** (`crate::character`): the model-space transforms of
//! the current and previous frames with the character's own movement removed (a pose whose root
//! motion is extracted, D35). The character's movement between them is a [`RootDelta`] in the
//! previous frame's character space (D35). A bone's velocity is then its world velocity in the
//! current character frame, as the bake measures it:
//!
//! `v = (p₁ − R⁻¹·(p₀ − d)) / dt` (`p₀`, `p₁` the bone's positions, `d`, `R` the delta).
//!
//! Each dim is written as `(value − mean) / std · √weight`, the same f32 operations the bake
//! normalises with and the load scales with, so a query equal to a frame's features costs
//! exactly 0 against it. Custom dims are left at the mean (0).

use crate::db::MatchDb;
use crate::trajectory::Trajectory;
use anim_format::posedb::FeatureKind;
use anim_math::{AosTransform, AosVec3, F32x4};
use anim_pose::root::RootDelta;

/// The pose a query is built from.
#[derive(Clone, Copy)]
pub struct PoseInput<'a> {
    /// This frame's character-space bone transforms (one per skeleton bone).
    pub current: &'a [AosTransform],
    /// The previous frame's.
    pub previous: &'a [AosTransform],
    /// The character's movement from the previous frame to this one.
    pub delta: RootDelta,
    /// Seconds between them (> 0; otherwise velocities are 0).
    pub dt: f32,
}

/// Why a query couldn't be built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryError {
    /// `out` isn't `db.lanes()` long.
    Length,
    /// A bone feature's bone isn't in the pose.
    Bone,
    /// The trajectory has no sample at a feature's time offset.
    Trajectory,
}

/// Where a query reads the character-space transforms of the bones its features name: this
/// frame's and the previous frame's (only the translations are read). [`PoseInput`]'s slices are
/// one source; the graph's matching node (T42) computes only the feature bones from its pose
/// history instead of whole model-space poses.
pub trait BoneSource {
    /// Bone `bone`'s (current, previous) character-space transforms, or `None` when the pose
    /// has no such bone.
    fn bone(&self, bone: u32) -> Option<(AosTransform, AosTransform)>;
}

impl BoneSource for PoseInput<'_> {
    fn bone(&self, bone: u32) -> Option<(AosTransform, AosTransform)> {
        let b = bone as usize;
        Some((*self.current.get(b)?, *self.previous.get(b)?))
    }
}

/// Writes the query for `pose` and `trajectory` into `out` (`db.lanes()` long; padding 0).
pub fn build_query(
    db: &MatchDb,
    pose: &PoseInput<'_>,
    trajectory: &Trajectory,
    out: &mut [F32x4],
) -> Result<(), QueryError> {
    build_query_from(db, pose, pose.delta, pose.dt, trajectory, out)
}

/// [`build_query`] with the bones read from `bones`; `delta` and `dt` as in [`PoseInput`]. The same
/// operations in the same order, so both give the same bits for the same transforms.
pub fn build_query_from(
    db: &MatchDb,
    bones: &impl BoneSource,
    delta: RootDelta,
    dt: f32,
    trajectory: &Trajectory,
    out: &mut [F32x4],
) -> Result<(), QueryError> {
    if out.len() != db.lanes {
        return Err(QueryError::Length);
    }
    let mut buf = [0.0f32; 4];
    let mut lane = 0usize;
    let mut fill = 0usize;
    let mut put = |v: f32, d: usize, out: &mut [F32x4]| {
        let n = (v - db.mean[d]) / db.std[d] * db.scale[d];
        buf[fill] = n;
        fill += 1;
        if fill == 4 {
            out[lane] = F32x4::from_array(buf);
            lane += 1;
            fill = 0;
        }
    };
    let inv_r = delta.rotation.conjugate();
    let inv_dt = if dt > 0.0 { 1.0 / dt } else { 0.0 };
    let mut d = 0usize;
    for f in &db.features {
        match f.kind {
            FeatureKind::BonePosition | FeatureKind::BoneVelocity => {
                let Some((p1, p0)) = bones.bone(f.bone) else {
                    return Err(QueryError::Bone);
                };
                let v: AosVec3 = if f.kind == FeatureKind::BonePosition {
                    p1.translation
                } else {
                    let back = inv_r.rotate(p0.translation - delta.translation);
                    (p1.translation - back).scale(inv_dt)
                };
                for x in [v.x, v.y, v.z] {
                    put(x, d, out);
                    d += 1;
                }
            }
            FeatureKind::TrajectoryPosition | FeatureKind::TrajectoryDirection => {
                let (p, dir) = trajectory
                    .sample(f.time_offset)
                    .ok_or(QueryError::Trajectory)?;
                let v = if f.kind == FeatureKind::TrajectoryPosition {
                    p
                } else {
                    dir
                };
                for x in v {
                    put(x, d, out);
                    d += 1;
                }
            }
            FeatureKind::Custom => {
                for _ in 0..f.dims {
                    put(db.mean[d], d, out);
                    d += 1;
                }
            }
        }
    }
    while fill != 0 {
        buf[fill] = 0.0;
        fill += 1;
        if fill == 4 {
            out[lane] = F32x4::from_array(buf);
            lane += 1;
            fill = 0;
        }
    }
    Ok(())
}
