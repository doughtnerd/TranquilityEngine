//! The ragdoll description: per bone a body or not, its joint frame and limits, and its motor; the
//! default builder from a skeleton's joint ranges; and the validated [`Ragdoll`].

use anim_format::skeleton::JointRange;
use anim_math::layout::NO_PARENT;
use anim_math::{AosQuat, AosVec3};

/// "No bone" (the pelvis of a description without one).
pub const NO_BONE: u16 = 0xFFFF;

/// Default motor stiffness (N·m per radian) of the builder: a firm human joint for a body of a
/// few kilograms. The ragdoll builder (ADR 0343) scales it by the bodies' masses.
pub const DEFAULT_STIFFNESS: f32 = 400.0;
/// Default motor damping (N·m·s per radian).
pub const DEFAULT_DAMPING: f32 = 40.0;
/// Default maximum motor torque (N·m).
pub const DEFAULT_MAX_FORCE: f32 = 1000.0;
/// The builder's joint range for a body bone when the skeleton gives none (degrees: swing Y, swing
/// Z, twist min, twist max).
pub const DEFAULT_RANGE: JointRange = JointRange {
    swing_y: 45.0,
    swing_z: 45.0,
    twist_min: -30.0,
    twist_max: 30.0,
};

/// One bone's ragdoll settings.
#[derive(Clone, Copy, Debug)]
pub struct BoneDesc {
    /// The bone has a rigid body (and, unless it is a root body, a ball joint to its parent body).
    pub body: bool,
    /// The body frame relative to the bone frame (a unit quaternion; module docs of the crate).
    pub joint_frame: AosQuat,
    /// The ball joint's limits relative to the rest pose, degrees (`anim-format`'s
    /// `JOINT_RANGES` layout: swing about Y, swing about Z, twist min and max about X).
    pub range: JointRange,
    /// The rotation drive (ADR 0345's `drive`): stiffness, damping, maximum force.
    pub stiffness: f32,
    pub damping: f32,
    pub max_force: f32,
    /// This bone's muscle strength multiplier (scales the three drive values).
    pub strength: f32,
    /// How strongly the body is pinned to its animated position, in \[0, 1\] (PuppetMaster's pin
    /// weight); root bodies default to 1, the others to 0.
    pub pin: f32,
}

impl Default for BoneDesc {
    fn default() -> Self {
        BoneDesc {
            body: false,
            joint_frame: AosQuat::identity(),
            range: DEFAULT_RANGE,
            stiffness: DEFAULT_STIFFNESS,
            damping: DEFAULT_DAMPING,
            max_force: DEFAULT_MAX_FORCE,
            strength: 1.0,
            pin: 0.0,
        }
    }
}

/// The pelvis's local axis that points out of the belly (for get-up, [`crate::getup`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum FrontAxis {
    PosX = 0,
    NegX = 1,
    PosY = 2,
    NegY = 3,
    #[default]
    PosZ = 4,
    NegZ = 5,
}

impl FrontAxis {
    /// The axis for a stored value `0..=5`, or `None`.
    pub fn from_u32(v: u32) -> Option<FrontAxis> {
        Some(match v {
            0 => FrontAxis::PosX,
            1 => FrontAxis::NegX,
            2 => FrontAxis::PosY,
            3 => FrontAxis::NegY,
            4 => FrontAxis::PosZ,
            5 => FrontAxis::NegZ,
            _ => return None,
        })
    }

    /// The unit vector.
    pub fn vector(self) -> AosVec3 {
        match self {
            FrontAxis::PosX => AosVec3::new(1.0, 0.0, 0.0),
            FrontAxis::NegX => AosVec3::new(-1.0, 0.0, 0.0),
            FrontAxis::PosY => AosVec3::new(0.0, 1.0, 0.0),
            FrontAxis::NegY => AosVec3::new(0.0, -1.0, 0.0),
            FrontAxis::PosZ => AosVec3::new(0.0, 0.0, 1.0),
            FrontAxis::NegZ => AosVec3::new(0.0, 0.0, -1.0),
        }
    }
}

/// A ragdoll description: one [`BoneDesc`] per skeleton bone, the pelvis and its front axis.
#[derive(Clone, Debug)]
pub struct RagdollDesc {
    pub bones: Vec<BoneDesc>,
    /// The pelvis bone (get-up facing), or [`NO_BONE`]: the first root body.
    pub pelvis: u16,
    pub front: FrontAxis,
}

/// Why a description was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DescError {
    /// It doesn't have one entry per bone, or the skeleton has no bones or more than `0xFFFF`.
    BoneCount,
    /// A bone's parent doesn't come before it.
    ParentOrder(usize),
    /// A bone's joint frame isn't a finite non-zero quaternion, a limit is outside
    /// `anim-format`'s ranges, or a drive value, strength or pin is negative or not finite.
    Value(usize),
    /// The pelvis is out of range or has no body.
    Pelvis,
    /// No bone has a body.
    NoBody,
}

impl core::fmt::Display for DescError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            DescError::BoneCount => write!(f, "ragdoll: one entry per bone needed"),
            DescError::ParentOrder(b) => write!(f, "ragdoll: bone {b}'s parent must come first"),
            DescError::Value(b) => write!(f, "ragdoll: bone {b} has a value out of range"),
            DescError::Pelvis => write!(f, "ragdoll: the pelvis has no body"),
            DescError::NoBody => write!(f, "ragdoll: no bone has a body"),
        }
    }
}

impl std::error::Error for DescError {}

fn range_ok(r: &JointRange) -> bool {
    let ok = |v: f32, lo: f32, hi: f32| v.is_finite() && v >= lo && v <= hi;
    ok(r.swing_y, 0.0, 180.0)
        && ok(r.swing_z, 0.0, 180.0)
        && ok(r.twist_min, -180.0, 180.0)
        && ok(r.twist_max, r.twist_min, 180.0)
}

impl RagdollDesc {
    /// The default description for a skeleton (`parents` first, `0xFFFF` for a root): a body on
    /// every bone with a joint range in `ranges` (its own, or its profile role's default; the
    /// caller resolves them), with that range; a skeleton without any range gets a body on every
    /// bone with [`DEFAULT_RANGE`]. Joint frames identity, the default drive, strength 1; root
    /// bodies pinned (pin 1). The pelvis is `pelvis` when it has a body, else the first root body;
    /// its front axis +Z (the model's forward, decision D60). The editor's ragdoll builder (ADR
    /// 0343) refines it.
    pub fn from_skeleton(parents: &[u16], ranges: &[Option<JointRange>], pelvis: u16) -> Self {
        let n = parents.len();
        let any = ranges.iter().any(Option::is_some);
        let mut bones: Vec<BoneDesc> = (0..n)
            .map(|b| {
                let r = ranges.get(b).copied().flatten();
                BoneDesc {
                    body: r.is_some() || !any,
                    range: r.unwrap_or(DEFAULT_RANGE),
                    ..BoneDesc::default()
                }
            })
            .collect();
        let parent_body = parent_bodies(parents, &bones);
        for b in 0..n {
            if bones[b].body && parent_body[b] == NO_BONE {
                bones[b].pin = 1.0;
            }
        }
        let pelvis = if (pelvis as usize) < n && bones[pelvis as usize].body {
            pelvis
        } else {
            (0..n)
                .find(|&b| bones[b].body && parent_body[b] == NO_BONE)
                .map_or(NO_BONE, |b| b as u16)
        };
        RagdollDesc {
            bones,
            pelvis,
            front: FrontAxis::PosZ,
        }
    }
}

/// Each bone's nearest ancestor with a body ([`NO_BONE`] for none). Parents must come first.
fn parent_bodies(parents: &[u16], bones: &[BoneDesc]) -> Vec<u16> {
    let n = parents.len();
    // nearest[b]: b itself when it has a body, else its own nearest ancestor body.
    let mut nearest = vec![NO_BONE; n];
    let mut out = vec![NO_BONE; n];
    for b in 0..n {
        let p = parents[b];
        let up = if p == NO_PARENT || p as usize >= b {
            NO_BONE
        } else {
            nearest[p as usize]
        };
        out[b] = up;
        nearest[b] = if bones.get(b).is_some_and(|d| d.body) {
            b as u16
        } else {
            up
        };
    }
    out
}

/// A validated description bound to its skeleton's parents, with each bone's parent body.
#[derive(Clone, Debug)]
pub struct Ragdoll {
    pub(crate) desc: RagdollDesc,
    pub(crate) parents: Vec<u16>,
    pub(crate) parent_body: Vec<u16>,
    pub(crate) pelvis: u16,
}

impl Ragdoll {
    /// Validates `desc` against the skeleton's `parents` (allocates; load time).
    pub fn new(desc: RagdollDesc, parents: &[u16]) -> Result<Ragdoll, DescError> {
        let n = parents.len();
        if n == 0 || n >= NO_BONE as usize || desc.bones.len() != n {
            return Err(DescError::BoneCount);
        }
        for (i, &p) in parents.iter().enumerate() {
            if p != NO_PARENT && p as usize >= i {
                return Err(DescError::ParentOrder(i));
            }
        }
        let good = |v: f32| v.is_finite() && v >= 0.0;
        for (i, b) in desc.bones.iter().enumerate() {
            let q = b.joint_frame;
            let len = q.length_squared();
            if !(len.is_finite() && len > 1e-12)
                || !range_ok(&b.range)
                || !good(b.stiffness)
                || !good(b.damping)
                || !good(b.max_force)
                || !good(b.strength)
                || !(good(b.pin) && b.pin <= 1.0)
            {
                return Err(DescError::Value(i));
            }
        }
        let mut desc = desc;
        for b in &mut desc.bones {
            b.joint_frame = b.joint_frame.normalize_or_identity();
        }
        if !desc.bones.iter().any(|b| b.body) {
            return Err(DescError::NoBody);
        }
        let parent_body = parent_bodies(parents, &desc.bones);
        let pelvis = if desc.pelvis == NO_BONE {
            (0..n)
                .find(|&b| desc.bones[b].body && parent_body[b] == NO_BONE)
                .map_or(NO_BONE, |b| b as u16)
        } else if (desc.pelvis as usize) < n && desc.bones[desc.pelvis as usize].body {
            desc.pelvis
        } else {
            return Err(DescError::Pelvis);
        };
        Ok(Ragdoll {
            desc,
            parents: parents.to_vec(),
            parent_body,
            pelvis,
        })
    }

    /// The description (joint frames normalised).
    pub fn desc(&self) -> &RagdollDesc {
        &self.desc
    }

    /// The skeleton's bone count.
    pub fn bone_count(&self) -> usize {
        self.parents.len()
    }

    /// The skeleton's parents.
    pub fn parents(&self) -> &[u16] {
        &self.parents
    }

    /// Bone `b`'s parent body ([`NO_BONE`] for a root body or a bone without a body above it).
    pub fn parent_body(&self, b: usize) -> u16 {
        self.parent_body.get(b).copied().unwrap_or(NO_BONE)
    }

    /// The pelvis (resolved: never [`NO_BONE`] for a valid ragdoll).
    pub fn pelvis(&self) -> u16 {
        self.pelvis
    }
}
