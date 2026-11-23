//! The feature schema a database is baked with, and the default one.
//!
//! Every feature is measured in character space ([`crate::character`]):
//!
//! | kind | dims | value |
//! |---|---|---|
//! | `BonePosition` | 3 | the bone's position |
//! | `BoneVelocity` | 3 | the bone's velocity in the world (or clip) frame, rotated into character space |
//! | `TrajectoryPosition` | 2 | `(x, z)` of the character frame `time_offset` seconds away |
//! | `TrajectoryDirection` | 2 | `(x, z)` of that frame's forward |
//!
//! `Custom` features can be stored in a database but the bake can't compute them (it refuses
//! them); a query leaves their dims at the mean.

use anim_format::posedb::FeatureKind;

/// One feature to bake.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FeatureSpec {
    /// What it measures.
    pub kind: FeatureKind,
    /// The bone (bone kinds; ignored otherwise).
    pub bone: u32,
    /// Its weight in the distance (finite, ≥ 0). The cost is `Σ weight · (q − r)²` over the
    /// feature's normalised dims.
    pub weight: f32,
    /// Seconds from the frame (trajectory kinds: past < 0; ignored otherwise).
    pub time_offset: f32,
}

impl FeatureSpec {
    /// A bone position feature.
    pub fn bone_position(bone: u32, weight: f32) -> Self {
        Self {
            kind: FeatureKind::BonePosition,
            bone,
            weight,
            time_offset: 0.0,
        }
    }
    /// A bone velocity feature.
    pub fn bone_velocity(bone: u32, weight: f32) -> Self {
        Self {
            kind: FeatureKind::BoneVelocity,
            bone,
            weight,
            time_offset: 0.0,
        }
    }
    /// A trajectory position sample.
    pub fn trajectory_position(time_offset: f32, weight: f32) -> Self {
        Self {
            kind: FeatureKind::TrajectoryPosition,
            bone: anim_format::NONE,
            weight,
            time_offset,
        }
    }
    /// A trajectory facing sample.
    pub fn trajectory_direction(time_offset: f32, weight: f32) -> Self {
        Self {
            kind: FeatureKind::TrajectoryDirection,
            bone: anim_format::NONE,
            weight,
            time_offset,
        }
    }
    /// The feature's dims.
    pub fn dims(&self) -> u16 {
        self.kind.dims().unwrap_or(0)
    }
}

/// The default schema's future trajectory offsets, seconds.
pub const DEFAULT_FUTURE: [f32; 3] = [0.33, 0.66, 1.0];
/// The default schema's optional past trajectory offset, seconds.
pub const DEFAULT_PAST: f32 = -0.33;

/// The default schema (Clavet 2016, Holden 2020), all weights 1: the left and right foot
/// positions and velocities, the hip velocity, then trajectory positions and facings at
/// [`DEFAULT_FUTURE`], plus [`DEFAULT_PAST`] first when `past`. 27 dims (31 with `past`).
pub fn default_schema(left_foot: u32, right_foot: u32, hips: u32, past: bool) -> Vec<FeatureSpec> {
    let mut s = vec![
        FeatureSpec::bone_position(left_foot, 1.0),
        FeatureSpec::bone_position(right_foot, 1.0),
        FeatureSpec::bone_velocity(left_foot, 1.0),
        FeatureSpec::bone_velocity(right_foot, 1.0),
        FeatureSpec::bone_velocity(hips, 1.0),
    ];
    let offsets = past
        .then_some(DEFAULT_PAST)
        .into_iter()
        .chain(DEFAULT_FUTURE);
    for t in offsets.clone() {
        s.push(FeatureSpec::trajectory_position(t, 1.0));
    }
    for t in offsets {
        s.push(FeatureSpec::trajectory_direction(t, 1.0));
    }
    s
}
