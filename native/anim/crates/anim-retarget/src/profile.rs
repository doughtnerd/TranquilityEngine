//! Skeleton profiles (ADR 0351's `*.skelprofile.json`): named roles, chains of roles, per-role
//! joint-range defaults, per-role mirror flips and left/right role pairs, plus the built-in
//! **Humanoid** profile ([`Profile::humanoid`]) and the per-skeleton [`BoneMap`].
//!
//! A profile is load-time data (it allocates); nothing here runs per frame.

use anim_format::skeleton::{JointRange, NO_ROLE};
use anim_pose::mirror::Flip;

/// "No bone" in a [`BoneMap`] (the skeleton's `NO_PARENT` value, as bone indices are `u16`).
pub const NO_BONE: u16 = 0xFFFF;

/// The most roles a profile holds (role indices are `u16`; [`NO_ROLE`] means none).
pub const MAX_ROLES: usize = 1024;
/// The most chains a profile holds.
pub const MAX_CHAINS: usize = 1024;
/// The longest role, chain or profile name, in UTF-8 bytes.
pub const MAX_NAME: usize = 255;

/// What a chain is, which decides how tools present it and which chains measure leg length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ChainKind {
    Spine = 0,
    Arm = 1,
    Leg = 2,
    Finger = 3,
    Head = 4,
    Twist = 5,
    Custom = 6,
}

impl ChainKind {
    /// The kind for a stored byte, or `None`.
    pub fn from_u8(v: u8) -> Option<ChainKind> {
        Some(match v {
            0 => ChainKind::Spine,
            1 => ChainKind::Arm,
            2 => ChainKind::Leg,
            3 => ChainKind::Finger,
            4 => ChainKind::Head,
            5 => ChainKind::Twist,
            6 => ChainKind::Custom,
            _ => return None,
        })
    }
}

/// One role.
#[derive(Clone, Debug, PartialEq)]
pub struct Role {
    /// Unique within the profile.
    pub name: String,
    /// The left/right counterpart role, or the role itself for a centre role.
    pub mirror: u16,
    /// The bone's mirror correction ([`Flip`]), or `None` to derive it from the rest pose
    /// (`anim_pose::mirror::flips_from_rest`), which is what the Humanoid profile does: the
    /// convention belongs to the rig, not the profile.
    pub flip: Option<Flip>,
    /// The default joint range for a bone in this role (degrees, `anim-format`'s layout), or
    /// `None` for free.
    pub range: Option<JointRange>,
    /// Whether a bone map must fill this role for the profile to be complete.
    pub required: bool,
}

/// An ordered run of roles, start to end (e.g. shoulder, upper arm, lower arm, hand).
#[derive(Clone, Debug, PartialEq)]
pub struct Chain {
    /// Unique within the profile; chains of two profiles are matched by name.
    pub name: String,
    pub kind: ChainKind,
    /// Role indices, start to end, distinct.
    pub roles: Vec<u16>,
    /// The chain's last three roles form a limb (root, mid, tip) that the retargeter pins with
    /// two-bone IK; the root's position is the goal's reference. Needs at least three roles.
    pub ik: bool,
}

/// A skeleton profile.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub name: String,
    pub roles: Vec<Role>,
    /// Retargeting runs chains in this order; a bone a chain already drives is skipped by the
    /// chains after it (so twist chains come last).
    pub chains: Vec<Chain>,
    /// The role of the skeleton's root bone (root motion), or [`NO_ROLE`].
    pub root: u16,
    /// The retarget root (the hips: its translation is scaled by the leg-length ratio), or
    /// [`NO_ROLE`].
    pub hips: u16,
}

/// Why a profile was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProfileError {
    /// The encoded bytes are malformed (what, byte offset).
    Malformed(&'static str, usize),
    /// The profile breaks a rule (what, and which role or chain).
    Invalid(&'static str, String),
}

impl core::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ProfileError::Malformed(what, at) => {
                write!(f, "malformed profile: {what} at byte {at}")
            }
            ProfileError::Invalid(what, which) => write!(f, "invalid profile: {what} ({which})"),
        }
    }
}

impl std::error::Error for ProfileError {}

fn invalid(what: &'static str, which: impl Into<String>) -> ProfileError {
    ProfileError::Invalid(what, which.into())
}

/// Whether a joint range is within `anim-format`'s rules (finite; swings in \[0, 180\]; twists in
/// \[-180, 180\], min ≤ max).
pub fn range_is_valid(r: &JointRange) -> bool {
    let fin = r.swing_y.is_finite()
        && r.swing_z.is_finite()
        && r.twist_min.is_finite()
        && r.twist_max.is_finite();
    fin && (0.0..=180.0).contains(&r.swing_y)
        && (0.0..=180.0).contains(&r.swing_z)
        && (-180.0..=180.0).contains(&r.twist_min)
        && (-180.0..=180.0).contains(&r.twist_max)
        && r.twist_min <= r.twist_max
}

impl Profile {
    /// The index of the role named `name`.
    pub fn role(&self, name: &str) -> Option<u16> {
        self.roles
            .iter()
            .position(|r| r.name == name)
            .map(|i| i as u16)
    }

    /// The index of the chain named `name`.
    pub fn chain(&self, name: &str) -> Option<usize> {
        self.chains.iter().position(|c| c.name == name)
    }

    /// Checks every rule: 1..=[`MAX_ROLES`] roles and at most [`MAX_CHAINS`] chains; names
    /// non-empty, at most [`MAX_NAME`] bytes and unique (roles among roles, chains among
    /// chains); the mirror map in range and an involution (`mirror[mirror[i]] == i`); valid
    /// ranges; chain roles in range, distinct, at least one; IK chains with at least three roles;
    /// `root` and `hips` in range or [`NO_ROLE`], and not the same role.
    pub fn validate(&self) -> Result<(), ProfileError> {
        let n = self.roles.len();
        if n == 0 || n > MAX_ROLES {
            return Err(invalid("role count", n.to_string()));
        }
        if self.chains.len() > MAX_CHAINS {
            return Err(invalid("chain count", self.chains.len().to_string()));
        }
        if self.name.len() > MAX_NAME {
            return Err(invalid("profile name too long", self.name.clone()));
        }
        for (i, r) in self.roles.iter().enumerate() {
            if r.name.is_empty() || r.name.len() > MAX_NAME {
                return Err(invalid("role name length", r.name.clone()));
            }
            if self.roles[..i].iter().any(|o| o.name == r.name) {
                return Err(invalid("duplicate role name", r.name.clone()));
            }
            let m = r.mirror as usize;
            if m >= n || self.roles[m].mirror as usize != i {
                return Err(invalid("mirror map is not an involution", r.name.clone()));
            }
            if let Some(range) = &r.range {
                if !range_is_valid(range) {
                    return Err(invalid("joint range", r.name.clone()));
                }
            }
        }
        for (i, c) in self.chains.iter().enumerate() {
            if c.name.is_empty() || c.name.len() > MAX_NAME {
                return Err(invalid("chain name length", c.name.clone()));
            }
            if self.chains[..i].iter().any(|o| o.name == c.name) {
                return Err(invalid("duplicate chain name", c.name.clone()));
            }
            if c.roles.is_empty() {
                return Err(invalid("empty chain", c.name.clone()));
            }
            for (k, &r) in c.roles.iter().enumerate() {
                if r as usize >= n {
                    return Err(invalid("chain role out of range", c.name.clone()));
                }
                if c.roles[..k].contains(&r) {
                    return Err(invalid("chain repeats a role", c.name.clone()));
                }
            }
            if c.ik && c.roles.len() < 3 {
                return Err(invalid("IK chain needs three roles", c.name.clone()));
            }
        }
        for (what, r) in [("root role", self.root), ("hips role", self.hips)] {
            if r != NO_ROLE && r as usize >= n {
                return Err(invalid(what, r.to_string()));
            }
        }
        if self.root != NO_ROLE && self.root == self.hips {
            return Err(invalid(
                "root and hips are the same role",
                self.root.to_string(),
            ));
        }
        Ok(())
    }

    /// The built-in Humanoid profile: Godot's `SkeletonProfileHumanoid` roles (56, in Godot's
    /// order: [`humanoid`] has the indices) plus eight twist roles, with chains for the spine,
    /// head, eyes, jaw, arms (IK), fingers, legs (IK), toes and twists.
    pub fn humanoid() -> Profile {
        let mut roles: Vec<Role> = Vec::with_capacity(humanoid::COUNT);
        for &(name, range, required) in HUMANOID_ROLES.iter() {
            roles.push(Role {
                name: name.to_string(),
                mirror: 0,
                flip: None,
                range: range.map(|[a, b, c, d]| JointRange {
                    swing_y: a,
                    swing_z: b,
                    twist_min: c,
                    twist_max: d,
                }),
                required,
            });
        }
        for i in 0..roles.len() {
            let name = roles[i].name.clone();
            let other = if let Some(rest) = name.strip_prefix("Left") {
                format!("Right{rest}")
            } else if let Some(rest) = name.strip_prefix("Right") {
                format!("Left{rest}")
            } else {
                name.clone()
            };
            roles[i].mirror = roles.iter().position(|r| r.name == other).unwrap_or(i) as u16;
        }
        let find = |n: &str| -> u16 { roles.iter().position(|r| r.name == n).unwrap() as u16 };
        let mut chains = Vec::new();
        let mut chain = |name: &str, kind: ChainKind, ik: bool, names: &[&str]| {
            chains.push(Chain {
                name: name.to_string(),
                kind,
                roles: names.iter().map(|n| find(n)).collect(),
                ik,
            });
        };
        chain(
            "Spine",
            ChainKind::Spine,
            false,
            &["Spine", "Chest", "UpperChest"],
        );
        chain("Head", ChainKind::Head, false, &["Neck", "Head"]);
        chain("LeftEye", ChainKind::Head, false, &["LeftEye"]);
        chain("RightEye", ChainKind::Head, false, &["RightEye"]);
        chain("Jaw", ChainKind::Head, false, &["Jaw"]);
        for side in ["Left", "Right"] {
            let s = |r: &str| format!("{side}{r}");
            let arm = [s("Shoulder"), s("UpperArm"), s("LowerArm"), s("Hand")];
            let arm: Vec<&str> = arm.iter().map(String::as_str).collect();
            chain(&s("Arm"), ChainKind::Arm, true, &arm);
            for (finger, parts) in [
                ("Thumb", ["Metacarpal", "Proximal", "Distal"]),
                ("Index", ["Proximal", "Intermediate", "Distal"]),
                ("Middle", ["Proximal", "Intermediate", "Distal"]),
                ("Ring", ["Proximal", "Intermediate", "Distal"]),
                ("Little", ["Proximal", "Intermediate", "Distal"]),
            ] {
                let names: Vec<String> = parts.iter().map(|p| s(&format!("{finger}{p}"))).collect();
                let names: Vec<&str> = names.iter().map(String::as_str).collect();
                chain(&s(finger), ChainKind::Finger, false, &names);
            }
        }
        for side in ["Left", "Right"] {
            let s = |r: &str| format!("{side}{r}");
            let leg = [s("UpperLeg"), s("LowerLeg"), s("Foot")];
            let leg: Vec<&str> = leg.iter().map(String::as_str).collect();
            chain(&s("Leg"), ChainKind::Leg, true, &leg);
            chain(&s("Toes"), ChainKind::Leg, false, &[&s("Toes")]);
        }
        for side in ["Left", "Right"] {
            for part in [
                "UpperArmTwist",
                "LowerArmTwist",
                "UpperLegTwist",
                "LowerLegTwist",
            ] {
                let n = format!("{side}{part}");
                chain(&n, ChainKind::Twist, false, &[&n]);
            }
        }
        Profile {
            name: "Humanoid".to_string(),
            roles,
            chains,
            root: humanoid::ROOT,
            hips: humanoid::HIPS,
        }
    }

    /// The role pairs' partner bones and each bone's flip for a skeleton mapped by `map`: the
    /// table `anim_pose::mirror::mirror_flipped` takes.
    ///
    /// `partner[b]` is the bone of the mirror role of `b`'s role; for a bone without a role (or
    /// whose mirror role is unmapped) it is `fallback[b]` (the skeleton's `MIRROR` section) when
    /// given and in range, else `b`. `flip[b]` is the role's explicit [`Flip`] when the profile
    /// sets one, else derived from the rest pose (`rest_model`: model-space rest transforms).
    pub fn mirror_table(
        &self,
        map: &BoneMap,
        rest_model: &[anim_math::AosTransform],
        fallback: Option<&[u32]>,
        axis: anim_pose::Axis,
    ) -> (Vec<u16>, Vec<Flip>) {
        let n = rest_model.len();
        let mut partner: Vec<u16> = (0..n)
            .map(|b| match fallback.and_then(|f| f.get(b)) {
                Some(&p) if (p as usize) < n => p as u16,
                _ => b as u16,
            })
            .collect();
        let mut role_of = vec![NO_ROLE; n];
        for (r, &b) in map.bones.iter().enumerate() {
            if (b as usize) < n {
                role_of[b as usize] = r as u16;
            }
        }
        for b in 0..n {
            let r = role_of[b];
            if r == NO_ROLE || r as usize >= self.roles.len() {
                continue;
            }
            let m = self.roles[r as usize].mirror as usize;
            if let Some(&pb) = map.bones.get(m) {
                if (pb as usize) < n {
                    partner[b] = pb;
                }
            }
        }
        let mut flips = vec![Flip::None; n];
        anim_pose::mirror::flips_from_rest(rest_model, &partner, axis, &mut flips);
        for b in 0..n {
            let r = role_of[b];
            if r != NO_ROLE && (r as usize) < self.roles.len() {
                if let Some(f) = self.roles[r as usize].flip {
                    flips[b] = f;
                }
            }
        }
        (partner, flips)
    }
}

/// The bone each role maps to in one skeleton, with the guess's confidence.
#[derive(Clone, Debug, PartialEq)]
pub struct BoneMap {
    /// Per role: the bone index, or [`NO_BONE`].
    pub bones: Vec<u16>,
    /// Per role, in \[0, 1\]: 1 for a hand-set or name-and-topology match, lower for a guess the
    /// names only partly support, 0 for an unmapped role.
    pub confidence: Vec<f32>,
}

impl BoneMap {
    /// An empty map for `role_count` roles.
    pub fn new(role_count: usize) -> BoneMap {
        BoneMap {
            bones: vec![NO_BONE; role_count],
            confidence: vec![0.0; role_count],
        }
    }

    /// The map a skeleton's `ROLES` section stores (one role per bone, [`NO_ROLE`] for none).
    /// A role out of range is ignored; a role on two bones keeps the first.
    pub fn from_roles(roles: &[u16], role_count: usize) -> BoneMap {
        let mut m = BoneMap::new(role_count);
        for (b, &r) in roles.iter().enumerate() {
            let r = r as usize;
            if r < role_count && m.bones[r] == NO_BONE {
                m.bones[r] = b as u16;
                m.confidence[r] = 1.0;
            }
        }
        m
    }

    /// The `ROLES` section for a skeleton of `bone_count` bones (the inverse of
    /// [`from_roles`](Self::from_roles)); a bone index out of range is ignored.
    pub fn to_roles(&self, bone_count: usize) -> Vec<u16> {
        let mut roles = vec![NO_ROLE; bone_count];
        for (r, &b) in self.bones.iter().enumerate() {
            if (b as usize) < bone_count && roles[b as usize] == NO_ROLE {
                roles[b as usize] = r as u16;
            }
        }
        roles
    }

    /// The bone of `role`, if mapped.
    pub fn bone(&self, role: u16) -> Option<u16> {
        self.bones
            .get(role as usize)
            .copied()
            .filter(|&b| b != NO_BONE)
    }

    /// Sets `role` to `bone` with confidence 1 (a hand edit). Out-of-range roles are ignored.
    pub fn set(&mut self, role: u16, bone: u16) {
        if let Some(b) = self.bones.get_mut(role as usize) {
            *b = bone;
            self.confidence[role as usize] = if bone == NO_BONE { 0.0 } else { 1.0 };
        }
    }

    /// The required roles of `profile` this map leaves unmapped.
    pub fn missing_required(&self, profile: &Profile) -> Vec<u16> {
        (0..profile.roles.len() as u16)
            .filter(|&r| profile.roles[r as usize].required && self.bone(r).is_none())
            .collect()
    }
}

/// The Humanoid profile's role indices ([`Profile::humanoid`]).
pub mod humanoid {
    pub const ROOT: u16 = 0;
    pub const HIPS: u16 = 1;
    pub const SPINE: u16 = 2;
    pub const CHEST: u16 = 3;
    pub const UPPER_CHEST: u16 = 4;
    pub const NECK: u16 = 5;
    pub const HEAD: u16 = 6;
    pub const LEFT_EYE: u16 = 7;
    pub const RIGHT_EYE: u16 = 8;
    pub const JAW: u16 = 9;
    pub const LEFT_SHOULDER: u16 = 10;
    pub const LEFT_UPPER_ARM: u16 = 11;
    pub const LEFT_LOWER_ARM: u16 = 12;
    pub const LEFT_HAND: u16 = 13;
    /// The first of the left hand's 15 finger roles (thumb metacarpal, proximal, distal; then
    /// index, middle, ring and little proximal, intermediate, distal).
    pub const LEFT_FINGERS: u16 = 14;
    pub const RIGHT_SHOULDER: u16 = 29;
    pub const RIGHT_UPPER_ARM: u16 = 30;
    pub const RIGHT_LOWER_ARM: u16 = 31;
    pub const RIGHT_HAND: u16 = 32;
    /// The first of the right hand's 15 finger roles.
    pub const RIGHT_FINGERS: u16 = 33;
    pub const LEFT_UPPER_LEG: u16 = 48;
    pub const LEFT_LOWER_LEG: u16 = 49;
    pub const LEFT_FOOT: u16 = 50;
    pub const LEFT_TOES: u16 = 51;
    pub const RIGHT_UPPER_LEG: u16 = 52;
    pub const RIGHT_LOWER_LEG: u16 = 53;
    pub const RIGHT_FOOT: u16 = 54;
    pub const RIGHT_TOES: u16 = 55;
    pub const LEFT_UPPER_ARM_TWIST: u16 = 56;
    pub const LEFT_LOWER_ARM_TWIST: u16 = 57;
    pub const RIGHT_UPPER_ARM_TWIST: u16 = 58;
    pub const RIGHT_LOWER_ARM_TWIST: u16 = 59;
    pub const LEFT_UPPER_LEG_TWIST: u16 = 60;
    pub const LEFT_LOWER_LEG_TWIST: u16 = 61;
    pub const RIGHT_UPPER_LEG_TWIST: u16 = 62;
    pub const RIGHT_LOWER_LEG_TWIST: u16 = 63;
    /// Roles in the profile.
    pub const COUNT: usize = 64;
}

type RoleRow = (&'static str, Option<[f32; 4]>, bool);

// Joint-range defaults (degrees: swing about Y, swing about Z, twist min, twist max), in the
// spirit of Unity's muscle defaults; the importer writes them to `JOINT_RANGES` when a skeleton
// has none, and the rig editor edits them per bone.
const SPINE_R: Option<[f32; 4]> = Some([40.0, 40.0, -40.0, 40.0]);
const SHOULDER_R: Option<[f32; 4]> = Some([15.0, 15.0, -10.0, 10.0]);
const UPPER_ARM_R: Option<[f32; 4]> = Some([100.0, 90.0, -90.0, 90.0]);
const LOWER_ARM_R: Option<[f32; 4]> = Some([5.0, 80.0, -90.0, 90.0]);
const HAND_R: Option<[f32; 4]> = Some([40.0, 80.0, -40.0, 40.0]);
const THUMB_R: Option<[f32; 4]> = Some([40.0, 40.0, -20.0, 20.0]);
const FINGER_BASE_R: Option<[f32; 4]> = Some([20.0, 90.0, -10.0, 10.0]);
const FINGER_R: Option<[f32; 4]> = Some([5.0, 90.0, 0.0, 0.0]);
const UPPER_LEG_R: Option<[f32; 4]> = Some([90.0, 90.0, -60.0, 60.0]);
const LOWER_LEG_R: Option<[f32; 4]> = Some([5.0, 80.0, -10.0, 10.0]);
const FOOT_R: Option<[f32; 4]> = Some([30.0, 50.0, -30.0, 30.0]);
const TOES_R: Option<[f32; 4]> = Some([5.0, 50.0, 0.0, 0.0]);
const TWIST_R: Option<[f32; 4]> = Some([0.0, 0.0, -90.0, 90.0]);

macro_rules! hand {
    ($side:literal) => {
        [
            (concat!($side, "Shoulder"), SHOULDER_R, false),
            (concat!($side, "UpperArm"), UPPER_ARM_R, true),
            (concat!($side, "LowerArm"), LOWER_ARM_R, true),
            (concat!($side, "Hand"), HAND_R, true),
            (concat!($side, "ThumbMetacarpal"), THUMB_R, false),
            (concat!($side, "ThumbProximal"), FINGER_R, false),
            (concat!($side, "ThumbDistal"), FINGER_R, false),
            (concat!($side, "IndexProximal"), FINGER_BASE_R, false),
            (concat!($side, "IndexIntermediate"), FINGER_R, false),
            (concat!($side, "IndexDistal"), FINGER_R, false),
            (concat!($side, "MiddleProximal"), FINGER_BASE_R, false),
            (concat!($side, "MiddleIntermediate"), FINGER_R, false),
            (concat!($side, "MiddleDistal"), FINGER_R, false),
            (concat!($side, "RingProximal"), FINGER_BASE_R, false),
            (concat!($side, "RingIntermediate"), FINGER_R, false),
            (concat!($side, "RingDistal"), FINGER_R, false),
            (concat!($side, "LittleProximal"), FINGER_BASE_R, false),
            (concat!($side, "LittleIntermediate"), FINGER_R, false),
            (concat!($side, "LittleDistal"), FINGER_R, false),
        ]
    };
}

macro_rules! leg {
    ($side:literal) => {
        [
            (concat!($side, "UpperLeg"), UPPER_LEG_R, true),
            (concat!($side, "LowerLeg"), LOWER_LEG_R, true),
            (concat!($side, "Foot"), FOOT_R, true),
            (concat!($side, "Toes"), TOES_R, false),
        ]
    };
}

const fn concat_rows<const N: usize>(parts: [&[RoleRow]; 9]) -> [RoleRow; N] {
    let mut out: [RoleRow; N] = [("", None, false); N];
    let mut k = 0;
    let mut p = 0;
    while p < parts.len() {
        let mut i = 0;
        while i < parts[p].len() {
            out[k] = parts[p][i];
            k += 1;
            i += 1;
        }
        p += 1;
    }
    assert!(k == N, "row count");
    out
}

const CENTRE: [RoleRow; 10] = [
    ("Root", None, false),
    ("Hips", None, true),
    ("Spine", SPINE_R, true),
    ("Chest", SPINE_R, true),
    ("UpperChest", SPINE_R, false),
    ("Neck", SPINE_R, true),
    ("Head", SPINE_R, true),
    ("LeftEye", Some([20.0, 15.0, 0.0, 0.0]), false),
    ("RightEye", Some([20.0, 15.0, 0.0, 0.0]), false),
    ("Jaw", Some([10.0, 10.0, 0.0, 0.0]), false),
];
const LEFT_HAND_ROWS: [RoleRow; 19] = hand!("Left");
const RIGHT_HAND_ROWS: [RoleRow; 19] = hand!("Right");
const LEFT_LEG_ROWS: [RoleRow; 4] = leg!("Left");
const RIGHT_LEG_ROWS: [RoleRow; 4] = leg!("Right");
const LEFT_TWISTS: [RoleRow; 2] = [
    ("LeftUpperArmTwist", TWIST_R, false),
    ("LeftLowerArmTwist", TWIST_R, false),
];
const RIGHT_TWISTS: [RoleRow; 2] = [
    ("RightUpperArmTwist", TWIST_R, false),
    ("RightLowerArmTwist", TWIST_R, false),
];
const LEG_TWISTS: [RoleRow; 4] = [
    ("LeftUpperLegTwist", TWIST_R, false),
    ("LeftLowerLegTwist", TWIST_R, false),
    ("RightUpperLegTwist", TWIST_R, false),
    ("RightLowerLegTwist", TWIST_R, false),
];

const HUMANOID_ROLES: [RoleRow; humanoid::COUNT] = concat_rows([
    &CENTRE,
    &LEFT_HAND_ROWS,
    &RIGHT_HAND_ROWS,
    &LEFT_LEG_ROWS,
    &RIGHT_LEG_ROWS,
    &LEFT_TWISTS,
    &RIGHT_TWISTS,
    &LEG_TWISTS,
    &[],
]);
