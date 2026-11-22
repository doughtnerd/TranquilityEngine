//! Chain retargeting: the [`RetargetMap`] precomputed at load, and the per-frame
//! [`RetargetMap::retarget`], which never allocates.
//!
//! # Model
//!
//! Source and target each have a skeleton, a profile and a [`BoneMap`]. Chains pair up by name
//! (and roles, for the retarget root, by the profiles' `root` and `hips`).
//!
//! - **A chain's bones** on one skeleton are the path from its first mapped role's bone to its
//!   last's (every bone between, mapped or not), so chains of different bone counts work. Each
//!   target bone samples the source chain at its own normalised rest length along the chain:
//!   bones `a`, `b` and a fraction `t` (with equal bone counts, bone `k` takes source bone `k`).
//! - **Rotation transfer** is in model space, relative to each rest pose: the source's delta
//!   `Δ = G_src · R_src⁻¹` (current model rotation times the inverse of the rest one) is
//!   independent of how the source's bones are oriented locally, so differing bone axes cancel.
//!   The target's model rotation is `nlerp(Δa, Δb, t) · A · R_tgt`, where `A` (with
//!   [`MapSettings::align_chains`]) is the shortest arc from the target bone's rest direction
//!   along the chain to the source's at the same point, so differing rest poses (T-pose and
//!   A-pose) give matching model-space directions; without alignment `A` is identity.
//! - **The retarget root** (the profile's hips, and its root bone): its rotation transfers the same
//!   way, and its model translation is `tgt_rest + (src − src_rest) · ratio` per axis
//!   ([`RootAxis`]), with `ratio` the leg-length ratio (target over source, averaged over the IK
//!   leg chains; the hips height ratio when no leg chain maps; 1 failing that).
//! - **Other target bones** keep their rest local transform; every driven bone keeps its rest
//!   local translation and scale (the target's own proportions).
//! - **IK goals** (chains marked `ik`): the limb's tip goal is
//!   `tgt_root_fk + (src_tip − src_root) · (target limb length / source limb length)` in model
//!   space, from the limb root's retargeted position, so a planted source foot stays planted on
//!   the scaled target. With a weight above 0 ([`RetargetOptions::ik_weights`]) the pinning pass
//!   runs `anim-rig`'s two-bone IK toward it (animated bend plane, tip keeps its model rotation).
//!
//! Both skeletons must share a model-space convention (up and forward); the importer normalises it.

use crate::profile::{BoneMap, ChainKind, Profile};
use anim_format::skeleton::NO_ROLE;
use anim_math::layout::{local_to_model, pack_pose, soa_len, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_rig::geom::{from_to, normalize_or};
use anim_rig::two_bone::{two_bone, Pole, TipRotation, TwoBone, TwoBoneGoal};
use anim_rig::RigPose;

/// One skeleton: parents (first, `0xFFFF` for a root) and the rest pose's local transforms.
#[derive(Clone, Copy, Debug)]
pub struct Skeleton<'a> {
    pub parents: &'a [u16],
    pub rest: &'a [AosTransform],
}

/// One side of a retarget: a skeleton, its profile and its bone map (indexed by that profile's
/// roles).
#[derive(Clone, Copy, Debug)]
pub struct Side<'a> {
    pub skeleton: Skeleton<'a>,
    pub profile: &'a Profile,
    pub map: &'a BoneMap,
}

/// Load-time settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapSettings {
    /// Align each target bone's rest direction along its chain with the source's (see the module
    /// docs). Default `true`.
    pub align_chains: bool,
}

impl Default for MapSettings {
    fn default() -> Self {
        MapSettings { align_chains: true }
    }
}

/// How one axis of the retarget root's translation follows the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RootAxis {
    /// The source's motion from its rest position, times the leg-length ratio.
    #[default]
    Scaled,
    /// The source's motion, unscaled.
    Unscaled,
    /// The target's rest position (the axis doesn't move).
    Locked,
}

/// Per-frame options.
#[derive(Clone, Copy, Debug)]
pub struct RetargetOptions<'a> {
    /// The retarget root's translation per model axis (x, y, z).
    pub root_axes: [RootAxis; 3],
    /// The pinning pass's weight per goal ([`RetargetMap::goals`] order) in \[0, 1\]; missing
    /// entries are 0 (no pinning).
    pub ik_weights: &'a [f32],
}

impl Default for RetargetOptions<'_> {
    fn default() -> Self {
        RetargetOptions {
            root_axes: [RootAxis::Scaled; 3],
            ik_weights: &[],
        }
    }
}

/// Why a map couldn't be built.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MapError {
    /// A skeleton has no bones or more than `0xFFFF`.
    BoneCount,
    /// A skeleton's rest pose doesn't have one transform per bone.
    RestLength,
    /// A bone's parent doesn't come before it (the bone).
    ParentOrder(usize),
    /// A bone map doesn't have one entry per profile role.
    MapLength,
}

impl core::fmt::Display for MapError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MapError::BoneCount => write!(f, "skeleton bone count out of range"),
            MapError::RestLength => write!(f, "rest pose length differs from the bone count"),
            MapError::ParentOrder(b) => write!(f, "bone {b}: parent must come first"),
            MapError::MapLength => write!(f, "bone map length differs from the role count"),
        }
    }
}

impl std::error::Error for MapError {}

/// Why a frame wasn't retargeted (the output is untouched).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetargetError {
    /// The source pose isn't `soa_len(source bones)` groups.
    SourceLength,
    /// The output isn't `soa_len(target bones)` groups.
    OutLength,
    /// The scratch wasn't made by this map's [`RetargetMap::scratch`].
    Scratch,
}

/// A paired chain: its name, kind, and its bones on each skeleton (start to end).
#[derive(Clone, Debug, PartialEq)]
pub struct ChainInfo {
    pub name: String,
    pub kind: ChainKind,
    pub source: Vec<u16>,
    /// Target bones this chain drives (a bone an earlier chain drives is left out).
    pub target: Vec<u16>,
}

/// An IK goal of the pinning pass.
#[derive(Clone, Debug, PartialEq)]
pub struct GoalInfo {
    /// The chain it ends.
    pub chain: String,
    /// The target limb.
    pub limb: TwoBone,
    /// The source limb.
    pub source: TwoBone,
    /// Target limb length over source limb length.
    pub ratio: f32,
}

#[derive(Clone, Copy, Debug)]
enum Drive {
    Rest,
    Chain {
        a: u16,
        b: u16,
        t: f32,
        /// `A · R_tgt` (model space).
        offset: AosQuat,
    },
    Root {
        src: u16,
        offset: AosQuat,
        src_rest: AosVec3,
        tgt_rest: AosVec3,
    },
}

/// Scratch for [`RetargetMap::retarget`], sized for one map ([`RetargetMap::scratch`]).
#[derive(Clone, Debug)]
pub struct RetargetScratch {
    src_model: Vec<AosTransform>,
    delta: Vec<AosQuat>,
    tgt_local: Vec<AosTransform>,
    tgt_model: Vec<AosTransform>,
    goals: Vec<AosVec3>,
}

impl RetargetScratch {
    /// The last frame's target model-space pose (after pinning).
    pub fn target_model(&self) -> &[AosTransform] {
        &self.tgt_model
    }

    /// The last frame's IK goal positions (model space, [`RetargetMap::goals`] order), for
    /// debug drawing.
    pub fn goals(&self) -> &[AosVec3] {
        &self.goals
    }
}

/// The precomputed mapping from one skeleton to another (see the module docs).
#[derive(Clone, Debug)]
pub struct RetargetMap {
    src_parents: Vec<u16>,
    tgt_parents: Vec<u16>,
    src_rest_inv: Vec<AosQuat>,
    tgt_rest: Vec<AosTransform>,
    drives: Vec<Drive>,
    goals: Vec<GoalInfo>,
    chains: Vec<ChainInfo>,
    ratio: f32,
    root_bones: Vec<(u16, u16)>,
}

fn check(s: &Skeleton<'_>) -> Result<(), MapError> {
    let n = s.parents.len();
    if n == 0 || n >= NO_PARENT as usize {
        return Err(MapError::BoneCount);
    }
    if s.rest.len() != n {
        return Err(MapError::RestLength);
    }
    for (i, &p) in s.parents.iter().enumerate() {
        if p != NO_PARENT && p as usize >= i {
            return Err(MapError::ParentOrder(i));
        }
    }
    Ok(())
}

fn rest_model(s: &Skeleton<'_>) -> Vec<AosTransform> {
    let n = s.parents.len();
    let mut soa = vec![SoaTransform::identity(); soa_len(n)];
    pack_pose(s.rest, &mut soa);
    let mut m = vec![AosTransform::identity(); n];
    local_to_model(s.parents, &soa, &mut m);
    m
}

fn is_ancestor(parents: &[u16], a: u16, b: u16) -> bool {
    let mut c = parents[b as usize];
    while c != NO_PARENT {
        if c == a {
            return true;
        }
        c = parents[c as usize];
    }
    false
}

/// The bones of `roles` on one side: the path from the first mapped role's bone to the last's.
fn chain_path(s: &Side<'_>, roles: &[u16]) -> Option<Vec<u16>> {
    let n = s.skeleton.parents.len();
    let mapped: Vec<u16> = roles
        .iter()
        .filter_map(|&r| s.map.bone(r))
        .filter(|&b| (b as usize) < n)
        .collect();
    let (&start, &end) = (mapped.first()?, mapped.last()?);
    let mut path = vec![end];
    let mut c = end;
    while c != start {
        c = s.skeleton.parents[c as usize];
        if c == NO_PARENT {
            return None;
        }
        path.push(c);
    }
    path.reverse();
    Some(path)
}

/// Normalised rest length at each joint of a path (0 at the start, 1 at the end; by index when
/// the path has no length).
fn params(path: &[u16], model: &[AosTransform]) -> Vec<f32> {
    let m = path.len();
    let mut acc = vec![0.0f32; m];
    for k in 1..m {
        let d = model[path[k] as usize].translation - model[path[k - 1] as usize].translation;
        acc[k] = acc[k - 1] + d.length();
    }
    let total = acc[m - 1];
    if total > 1e-6 {
        acc.iter().map(|a| a / total).collect()
    } else if m > 1 {
        (0..m).map(|k| k as f32 / (m - 1) as f32).collect()
    } else {
        vec![0.0]
    }
}

/// The unit rest direction along a path at joint `k` (toward the next joint; the last joint
/// takes the previous segment's), or `None` for a one-bone path.
fn direction(path: &[u16], model: &[AosTransform], k: usize) -> Option<AosVec3> {
    if path.len() < 2 {
        return None;
    }
    let (i, j) = if k + 1 < path.len() { (k, k + 1) } else { (k - 1, k) };
    let d = model[path[j] as usize].translation - model[path[i] as usize].translation;
    (d.length_squared() > 1e-12).then(|| normalize_or(d, d))
}

/// The limb (last three mapped roles) of an IK chain, when parent-ordered.
fn limb(s: &Side<'_>, roles: &[u16]) -> Option<TwoBone> {
    let k = roles.len();
    if k < 3 {
        return None;
    }
    let n = s.skeleton.parents.len() as u16;
    let b = |r: u16| s.map.bone(r).filter(|&b| b < n);
    let (root, mid, tip) = (b(roles[k - 3])?, b(roles[k - 2])?, b(roles[k - 1])?);
    let p = s.skeleton.parents;
    (is_ancestor(p, root, mid) && is_ancestor(p, mid, tip)).then_some(TwoBone { root, mid, tip })
}

fn limb_length(l: TwoBone, model: &[AosTransform]) -> f32 {
    let p = |b: u16| model[b as usize].translation;
    (p(l.mid) - p(l.root)).length() + (p(l.tip) - p(l.mid)).length()
}

impl RetargetMap {
    /// Builds the map (allocates; the per-frame call doesn't). Chains that can't be resolved on
    /// both sides (unmapped, or a last bone that isn't below the first) are left out, as are IK
    /// goals whose limb isn't parent-ordered; [`chains`](Self::chains) and
    /// [`goals`](Self::goals) list what was kept.
    pub fn new(source: Side<'_>, target: Side<'_>, settings: &MapSettings) -> Result<Self, MapError> {
        check(&source.skeleton)?;
        check(&target.skeleton)?;
        if source.map.bones.len() != source.profile.roles.len()
            || target.map.bones.len() != target.profile.roles.len()
        {
            return Err(MapError::MapLength);
        }
        let sm = rest_model(&source.skeleton);
        let tm = rest_model(&target.skeleton);
        let (ns, nt) = (sm.len(), tm.len());
        let mut drives = vec![Drive::Rest; nt];
        let mut claimed = vec![false; nt];

        // Leg-length ratio over the IK leg chains.
        let mut legs = (0.0f32, 0.0f32, 0u32);
        for tc in &target.profile.chains {
            if !(tc.ik && tc.kind == ChainKind::Leg) {
                continue;
            }
            let Some(sc) = source.profile.chain(&tc.name).map(|i| &source.profile.chains[i]) else {
                continue;
            };
            if let (Some(sl), Some(tl)) = (limb(&source, &sc.roles), limb(&target, &tc.roles)) {
                legs.0 += limb_length(sl, &sm);
                legs.1 += limb_length(tl, &tm);
                legs.2 += 1;
            }
        }
        let role_bone = |s: &Side<'_>, r: u16, n: usize| {
            (r != NO_ROLE).then(|| s.map.bone(r)).flatten().filter(|&b| (b as usize) < n)
        };
        let src_hips = role_bone(&source, source.profile.hips, ns);
        let tgt_hips = role_bone(&target, target.profile.hips, nt);
        let ratio = if legs.2 > 0 && legs.0 > 1e-6 && legs.1 > 1e-6 {
            legs.1 / legs.0
        } else {
            match (src_hips, tgt_hips) {
                (Some(s), Some(t)) => {
                    let (hs, ht) = (sm[s as usize].translation.y, tm[t as usize].translation.y);
                    if hs > 1e-4 && ht > 1e-4 {
                        ht / hs
                    } else {
                        1.0
                    }
                }
                _ => 1.0,
            }
        };

        // The retarget root: the root bone, then the hips.
        let mut root_bones = Vec::new();
        let src_root = role_bone(&source, source.profile.root, ns);
        let tgt_root = role_bone(&target, target.profile.root, nt);
        for (s, t) in [(src_root, tgt_root), (src_hips, tgt_hips)] {
            if let (Some(s), Some(t)) = (s, t) {
                if claimed[t as usize] {
                    continue;
                }
                claimed[t as usize] = true;
                drives[t as usize] = Drive::Root {
                    src: s,
                    offset: tm[t as usize].rotation,
                    src_rest: sm[s as usize].translation,
                    tgt_rest: tm[t as usize].translation,
                };
                root_bones.push((s, t));
            }
        }

        // Chains.
        let mut chains = Vec::new();
        let mut goals = Vec::new();
        for tc in &target.profile.chains {
            let Some(sc) = source.profile.chain(&tc.name).map(|i| &source.profile.chains[i]) else {
                continue;
            };
            let (Some(sp), Some(tp)) = (chain_path(&source, &sc.roles), chain_path(&target, &tc.roles))
            else {
                continue;
            };
            let su = params(&sp, &sm);
            let tu = params(&tp, &tm);
            let mut driven = Vec::new();
            for (k, &tb) in tp.iter().enumerate() {
                if claimed[tb as usize] {
                    continue;
                }
                let (a, b, t) = if sp.len() == tp.len() {
                    (k, k, 0.0)
                } else if sp.len() == 1 {
                    (0, 0, 0.0)
                } else {
                    let u = tu[k];
                    let mut j = 0;
                    while j + 2 < sp.len() && su[j + 1] <= u {
                        j += 1;
                    }
                    let span = su[j + 1] - su[j];
                    let t = if span > 1e-9 { ((u - su[j]) / span).clamp(0.0, 1.0) } else { 0.0 };
                    (j, j + 1, t)
                };
                let align = if settings.align_chains {
                    let sd = match (direction(&sp, &sm, a), direction(&sp, &sm, b)) {
                        (Some(da), Some(db)) => Some(normalize_or(da.lerp(db, t), da)),
                        _ => None,
                    };
                    match (direction(&tp, &tm, k), sd) {
                        (Some(td), Some(sd)) => from_to(td, sd),
                        _ => AosQuat::identity(),
                    }
                } else {
                    AosQuat::identity()
                };
                claimed[tb as usize] = true;
                drives[tb as usize] = Drive::Chain {
                    a: sp[a],
                    b: sp[b],
                    t,
                    offset: (align * tm[tb as usize].rotation).normalize_or_identity(),
                };
                driven.push(tb);
            }
            if tc.ik && sc.ik {
                if let (Some(sl), Some(tl)) = (limb(&source, &sc.roles), limb(&target, &tc.roles)) {
                    let (ls, lt) = (limb_length(sl, &sm), limb_length(tl, &tm));
                    goals.push(GoalInfo {
                        chain: tc.name.clone(),
                        limb: tl,
                        source: sl,
                        ratio: if ls > 1e-6 { lt / ls } else { 1.0 },
                    });
                }
            }
            chains.push(ChainInfo {
                name: tc.name.clone(),
                kind: tc.kind,
                source: sp,
                target: driven,
            });
        }

        Ok(RetargetMap {
            src_parents: source.skeleton.parents.to_vec(),
            tgt_parents: target.skeleton.parents.to_vec(),
            src_rest_inv: sm.iter().map(|m| m.rotation.conjugate()).collect(),
            tgt_rest: target.skeleton.rest.to_vec(),
            drives,
            goals,
            chains,
            ratio,
            root_bones,
        })
    }

    /// The source skeleton's bone count.
    pub fn source_bone_count(&self) -> usize {
        self.src_parents.len()
    }

    /// The target skeleton's bone count.
    pub fn target_bone_count(&self) -> usize {
        self.tgt_parents.len()
    }

    /// The paired chains, in the target profile's order.
    pub fn chains(&self) -> &[ChainInfo] {
        &self.chains
    }

    /// The IK goals of the pinning pass.
    pub fn goals(&self) -> &[GoalInfo] {
        &self.goals
    }

    /// The leg-length ratio (target over source) that scales the root.
    pub fn leg_ratio(&self) -> f32 {
        self.ratio
    }

    /// The retarget-root bone pairs (source, target): the root bone's, then the hips'.
    pub fn root_bones(&self) -> &[(u16, u16)] {
        &self.root_bones
    }

    /// Scratch for [`retarget`](Self::retarget) (allocates; make it once).
    pub fn scratch(&self) -> RetargetScratch {
        RetargetScratch {
            src_model: vec![AosTransform::identity(); self.src_parents.len()],
            delta: vec![AosQuat::identity(); self.src_parents.len()],
            tgt_local: vec![AosTransform::identity(); self.tgt_parents.len()],
            tgt_model: vec![AosTransform::identity(); self.tgt_parents.len()],
            goals: vec![AosVec3::zero(); self.goals.len()],
        }
    }

    /// Retargets one source local pose (SoA, `soa_len(source bones)` groups) into the target's
    /// local pose `out` (`soa_len(target bones)` groups; spare lanes identity), then runs the
    /// pinning pass for goals with a weight above 0. Never allocates; deterministic (only
    /// `anim-math` operations, in a fixed order).
    pub fn retarget(
        &self,
        source: &[SoaTransform],
        opts: &RetargetOptions<'_>,
        scratch: &mut RetargetScratch,
        out: &mut [SoaTransform],
    ) -> Result<(), RetargetError> {
        let (ns, nt) = (self.src_parents.len(), self.tgt_parents.len());
        if source.len() != soa_len(ns) {
            return Err(RetargetError::SourceLength);
        }
        if out.len() != soa_len(nt) {
            return Err(RetargetError::OutLength);
        }
        if scratch.src_model.len() != ns
            || scratch.delta.len() != ns
            || scratch.tgt_local.len() != nt
            || scratch.tgt_model.len() != nt
            || scratch.goals.len() != self.goals.len()
        {
            return Err(RetargetError::Scratch);
        }
        local_to_model(&self.src_parents, source, &mut scratch.src_model);
        for i in 0..ns {
            scratch.delta[i] =
                (scratch.src_model[i].rotation * self.src_rest_inv[i]).normalize_or_identity();
        }
        for i in 0..nt {
            let p = self.tgt_parents[i];
            let parent = if p == NO_PARENT {
                AosTransform::identity()
            } else {
                scratch.tgt_model[p as usize]
            };
            let rest = self.tgt_rest[i];
            let local_rot = |rot: AosQuat| (parent.rotation.conjugate() * rot).normalize_or_identity();
            let local = match self.drives[i] {
                Drive::Rest => rest,
                Drive::Chain { a, b, t, offset } => {
                    let da = scratch.delta[a as usize];
                    let d = if a == b { da } else { da.nlerp(scratch.delta[b as usize], t) };
                    let rot = (d * offset).normalize_or_identity();
                    AosTransform::new(rest.translation, local_rot(rot), rest.scale)
                }
                Drive::Root {
                    src,
                    offset,
                    src_rest,
                    tgt_rest,
                } => {
                    let rot = (scratch.delta[src as usize] * offset).normalize_or_identity();
                    let moved = scratch.src_model[src as usize].translation - src_rest;
                    let axis = |m: f32, r: f32, a: RootAxis| match a {
                        RootAxis::Scaled => r + m * self.ratio,
                        RootAxis::Unscaled => r + m,
                        RootAxis::Locked => r,
                    };
                    let [ax, ay, az] = opts.root_axes;
                    let pos = AosVec3::new(
                        axis(moved.x, tgt_rest.x, ax),
                        axis(moved.y, tgt_rest.y, ay),
                        axis(moved.z, tgt_rest.z, az),
                    );
                    let lt = if p == NO_PARENT {
                        pos
                    } else {
                        parent.inverse().transform_point(pos)
                    };
                    AosTransform::new(lt, local_rot(rot), rest.scale)
                }
            };
            scratch.tgt_local[i] = local;
            scratch.tgt_model[i] = if p == NO_PARENT {
                local
            } else {
                parent.compose(local)
            };
        }
        pack_pose(&scratch.tgt_local, out);

        // IK goals from the FK result, then the pinning pass.
        let mut pin = false;
        for (k, g) in self.goals.iter().enumerate() {
            let src = |b: u16| scratch.src_model[b as usize].translation;
            let reach = (src(g.source.tip) - src(g.source.root)).scale(g.ratio);
            scratch.goals[k] = scratch.tgt_model[g.limb.root as usize].translation + reach;
            pin |= opts.ik_weights.get(k).is_some_and(|&w| w > 0.0);
        }
        if pin {
            let mut pose = RigPose::new(&self.tgt_parents, out, &mut scratch.tgt_model);
            for (k, g) in self.goals.iter().enumerate() {
                let w = opts.ik_weights.get(k).copied().unwrap_or(0.0);
                if !(w > 0.0) {
                    continue;
                }
                let goal = TwoBoneGoal {
                    target: scratch.goals[k],
                    pole: Pole::Animated,
                    tip_rotation: TipRotation::Maintain,
                    soft: 0.0,
                    max_stretch: 1.0,
                    weight: if w < 1.0 { w } else { 1.0 },
                };
                two_bone(&mut pose, g.limb, &goal);
            }
            pose.refresh();
        }
        Ok(())
    }
}
