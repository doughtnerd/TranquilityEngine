//! Full-body IK: FABRIK over a tree of chains, with effectors for chain ends and the root, a body
//! pull and a centre-of-mass target.

use crate::geom::{fraction, from_to, from_to_pair, normalize_or, unit_clamp, DEGENERATE_SQ};
use crate::pose::{
    blend_rotation, chain_parent_rotation, gather, parent_space_point, ChainJoint, RigPose,
};
use anim_math::{AosQuat, AosVec3};

/// The most chains a body may have (a humanoid uses six: spine, neck, two arms, two legs).
pub const MAX_CHAINS: usize = 8;

/// The weight a chain end without a position effector still has when sub-base positions are
/// averaged, so a body with no effectors stays put instead of dividing by zero.
const MIN_WEIGHT: f32 = 1e-3;

/// One chain of the body tree.
///
/// `bones[0]` is the chain's **sub-base**, shared with other chains: the body's root bone when
/// `parent` is `None`, otherwise the last bone of `chains[parent]`. Each bone must be a
/// descendant of the one before. A humanoid: spine `[hips, spine, chest]` (root), legs
/// `[hips, thigh, shin, foot]` (root), neck `[chest, neck, head]`, arms
/// `[chest, clavicle, upper arm, forearm, hand]` (parent: the spine).
#[derive(Clone, Copy, Debug)]
pub struct BodyChain<'a> {
    pub bones: &'a [u16],
    /// The chain this one branches from (an earlier index), or `None` for the root.
    pub parent: Option<u8>,
}

/// A position and rotation goal with weights (0 = ignore).
#[derive(Clone, Copy, Debug)]
pub struct Effector {
    /// Model-space target position.
    pub position: AosVec3,
    /// In `[0, 1]`.
    pub position_weight: f32,
    /// Model-space target rotation.
    pub rotation: AosQuat,
    /// In `[0, 1]`.
    pub rotation_weight: f32,
}

impl Effector {
    /// No goal.
    pub const NONE: Effector = Effector {
        position: AosVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
        position_weight: 0.0,
        rotation: AosQuat {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            w: 1.0,
        },
        rotation_weight: 0.0,
    };

    /// A full-weight position goal.
    pub fn at(position: AosVec3) -> Self {
        Self {
            position,
            position_weight: 1.0,
            ..Self::NONE
        }
    }
}

/// A centre-of-mass goal.
#[derive(Clone, Copy, Debug)]
pub struct CentreOfMass<'a> {
    /// Model-space target for the centre of mass.
    pub target: AosVec3,
    /// How far toward the target the centre of mass moves, in `[0, 1]`.
    pub weight: f32,
    /// Mass per skeleton bone (indexed by bone); empty gives every chain bone mass 1.
    pub masses: &'a [f32],
    /// When non-zero (unit), the pull acts only in the plane perpendicular to this up axis
    /// (balance over the feet without lifting the body).
    pub up: AosVec3,
}

/// A full-body solve.
#[derive(Clone, Copy, Debug)]
pub struct FullBodyGoal<'a> {
    /// The root (hips) effector. Its rotation and position move the whole body rigidly first;
    /// its position weight also pins the root against the body pull.
    pub root: Effector,
    /// One effector per chain, at the chain's last bone (hands, feet, head; a branch end such as
    /// the chest may have one too).
    pub effectors: &'a [Effector],
    pub centre_of_mass: Option<CentreOfMass<'a>>,
    /// How far the root follows the chain ends (0: the root stays; 1: it moves to where the
    /// chains pull it). Final IK's body pull.
    pub body_pull: f32,
    pub iterations: u32,
    /// Stop once every weighted position effector is within this distance.
    pub tolerance: f32,
    /// The entry weight in `[0, 1]`.
    pub weight: f32,
}

/// What a full-body solve did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FullBodyResult {
    pub iterations: u32,
    /// The largest distance from a weighted position effector to its chain end, at full weight.
    pub error: f32,
}

/// The scratch entries [`full_body`] needs: the sum of the chain lengths.
pub fn scratch_len(chains: &[BodyChain]) -> usize {
    chains.iter().map(|c| c.bones.len()).sum()
}

/// The rotation that best carries the old child directions onto the new ones: the first child
/// exactly, then a twist about it for the second (2 children) or for the vector from the second
/// to the third (3 or more, e.g. thigh to thigh, shoulder to shoulder).
fn branch_rotation(old: &[AosVec3], new: &[AosVec3]) -> AosQuat {
    let n = old.len();
    if n == 0 {
        return AosQuat::identity();
    }
    let u1 = normalize_or(old[0], AosVec3::new(0.0, 1.0, 0.0));
    let v1 = normalize_or(new[0], u1);
    match n {
        1 => from_to(u1, v1),
        2 => from_to_pair(u1, old[1], v1, new[1]),
        _ => from_to_pair(u1, old[2] - old[1], v1, new[2] - new[1]),
    }
}

/// Full-body IK.
///
/// # Algorithm
///
/// FABRIK for multiple end effectors (Aristidou & Lasenby 2011, §5), on a tree of chains
/// ([`BodyChain`]) whose sub-bases are the root or a parent chain's last bone:
///
/// 0. **Rigid body move.** The whole body turns about the root by
///    `fraction(root.rotation · R_root⁻¹, root.rotation_weight)` and moves by
///    `(root.position − root)·root.position_weight`.
/// 1. **Backward pass**, chains from last to first (children before parents). A leaf chain's end
///    is placed at `lerp(start + shift, effector, position_weight)`, where `start` is its
///    position after step 0 and `shift` how far the root has moved since, so a free hand follows
///    the body. A branch chain's end goes to the weighted centroid of its children's sub-base
///    estimates (weights: the summed effector weights below each child, at least 1e-3 per end),
///    then toward its own effector if it has one. Each chain is walked back to its sub-base
///    (`pⱼ ← pⱼ₊₁ + normalize(pⱼ − pⱼ₊₁)·lⱼ`), giving an estimate of the sub-base.
/// 2. **Root.** The root's anchor is its position after step 0 plus the accumulated
///    centre-of-mass shift: each iteration adds `goal − COM`, where `COM` is the mass-weighted
///    mean of the chain bones and `goal = COM₀ + weight·(target − COM₀)` (projected off `up`
///    when given). Then the root moves from the anchor toward the weighted centroid of the root
///    chains' sub-base estimates by `body_pull·(1 − root.position_weight)`.
/// 3. **Forward pass**, chains first to last: the sub-base takes the root's (or the parent
///    chain's final end) position, and `pⱼ₊₁ ← pⱼ + normalize(pⱼ₊₁ − pⱼ)·lⱼ`.
/// 4. Repeat 1–3 until every weighted effector is within `tolerance`, or `iterations`.
/// 5. **Rotations**, top-down. An inner bone keeps the twist it inherits (`parent' · local`) and
///    turns by the shortest arc onto its new bone direction. A branch bone (the root, the chest)
///    turns to fit its children ([`from_to_pair`]: the first child exactly, then the second, or
///    the second-to-third vector, about it). A leaf end keeps its inherited rotation, blended
///    toward its effector rotation by `rotation_weight`. The root's translation is written too.
///
/// Locals are blended from the input by `goal.weight`. Effectors that pull apart can't all be
/// reached; the result is FABRIK's weighted compromise. Never allocates.
pub fn full_body(
    pose: &mut RigPose,
    root: u16,
    chains: &[BodyChain],
    goal: &FullBodyGoal,
    scratch: &mut [ChainJoint],
) -> FullBodyResult {
    let nc = chains.len();
    assert!(nc > 0 && nc <= MAX_CHAINS, "1 to {MAX_CHAINS} chains");
    assert_eq!(goal.effectors.len(), nc, "one effector per chain");
    assert!(
        scratch.len() >= scratch_len(chains),
        "full-body scratch too short"
    );
    let mut off = [0usize; MAX_CHAINS];
    let mut has_children = [false; MAX_CHAINS];
    let mut total = 0;
    for (ci, ch) in chains.iter().enumerate() {
        assert!(ch.bones.len() >= 2, "chain {ci}: at least two bones");
        match ch.parent {
            None => assert_eq!(
                ch.bones[0], root,
                "chain {ci}: a root chain starts at the root"
            ),
            Some(p) => {
                let p = p as usize;
                assert!(p < ci, "chain {ci}: its parent must come first");
                assert_eq!(
                    ch.bones[0],
                    *chains[p].bones.last().unwrap(),
                    "chain {ci}: starts at its parent chain's last bone"
                );
                has_children[p] = true;
            }
        }
        off[ci] = total;
        total += ch.bones.len();
    }

    // Gather.
    for (ci, ch) in chains.iter().enumerate() {
        let bones = ch.bones;
        gather(
            pose,
            bones.len(),
            |j| bones[j] as usize,
            &mut scratch[off[ci]..off[ci] + bones.len()],
        );
    }
    let s = &mut scratch[..total];
    let root_model = pose.model(root as usize);
    let root_parent = pose.parent_model(root as usize);
    let r0 = root_model.translation;

    // 0. Rigid body move.
    let rw = goal.root.rotation_weight;
    let dr = fraction(
        (goal.root.rotation * root_model.rotation.conjugate()).normalize_or_identity(),
        rw,
    );
    let shift0 = (goal.root.position - r0).scale(unit_clamp(goal.root.position_weight));
    for j in s.iter_mut() {
        j.position = r0 + shift0 + dr.rotate(j.position - r0);
        j.rotation = (dr * j.rotation).normalize_or_identity();
    }
    let root_start = r0 + shift0;

    // Weights and starts.
    let mut weight = [0.0f32; MAX_CHAINS];
    let mut end_start = [AosVec3::zero(); MAX_CHAINS];
    for ci in (0..nc).rev() {
        let last = off[ci] + chains[ci].bones.len() - 1;
        end_start[ci] = s[last].position;
        if !has_children[ci] {
            weight[ci] = goal.effectors[ci].position_weight.max(0.0) + MIN_WEIGHT;
        }
        if let Some(p) = chains[ci].parent {
            let w = weight[ci];
            weight[p as usize] += w;
        }
    }

    // Centre of mass.
    let com_of = |s: &[ChainJoint], masses: &[f32]| -> AosVec3 {
        let mass = |b: u16| masses.get(b as usize).copied().unwrap_or(1.0).max(0.0);
        let mut sum = s[0].position.scale(mass(root));
        let mut m = mass(root);
        for (ci, ch) in chains.iter().enumerate() {
            for (j, &b) in ch.bones.iter().enumerate().skip(1) {
                let w = mass(b);
                sum = sum + s[off[ci] + j].position.scale(w);
                m += w;
            }
        }
        if m > 0.0 {
            sum.scale(1.0 / m)
        } else {
            s[0].position
        }
    };
    let com_goal = goal.centre_of_mass.map(|c| {
        let com0 = com_of(s, c.masses);
        let mut d = (c.target - com0).scale(unit_clamp(c.weight));
        if c.up.length_squared() > DEGENERATE_SQ {
            d = d - c.up.scale(d.dot(c.up));
        }
        com0 + d
    });

    let error_of = |s: &[ChainJoint]| -> f32 {
        let mut e = 0.0f32;
        for (ci, ch) in chains.iter().enumerate() {
            let eff = &goal.effectors[ci];
            if eff.position_weight > 0.0 {
                let last = off[ci] + ch.bones.len() - 1;
                e = e.max((s[last].position - eff.position).length());
            }
        }
        e
    };

    let pull = unit_clamp(goal.body_pull) * (1.0 - unit_clamp(goal.root.position_weight));
    let mut anchor = root_start;
    let mut root_pos = root_start;
    let mut base_est = [AosVec3::zero(); MAX_CHAINS];
    let mut iterations = 0;
    let tol = goal.tolerance.max(0.0);
    while iterations < goal.iterations
        && (error_of(s) > tol || (com_goal.is_some() && iterations == 0))
    {
        iterations += 1;
        if let (Some(cg), Some(c)) = (com_goal, goal.centre_of_mass) {
            let mut d = cg - com_of(s, c.masses);
            if c.up.length_squared() > DEGENERATE_SQ {
                d = d - c.up.scale(d.dot(c.up));
            }
            anchor = anchor + d;
        }
        let shift = root_pos - root_start;

        // 1. Backward.
        for ci in (0..nc).rev() {
            let len = chains[ci].bones.len();
            let o = off[ci];
            let eff = &goal.effectors[ci];
            let mut end = if has_children[ci] {
                let (mut sum, mut wsum) = (AosVec3::zero(), 0.0f32);
                for (k, ch) in chains.iter().enumerate().skip(ci + 1) {
                    if ch.parent == Some(ci as u8) {
                        sum = sum + base_est[k].scale(weight[k]);
                        wsum += weight[k];
                    }
                }
                sum.scale(1.0 / wsum)
            } else {
                end_start[ci] + shift
            };
            end = end.lerp(eff.position, unit_clamp(eff.position_weight));
            s[o + len - 1].position = end;
            for j in (0..len - 1).rev() {
                let bone_dir = s[o + j].rotation.rotate(s[o + j].offset);
                let d = s[o + j].position - s[o + j + 1].position;
                let dir = normalize_or(d, normalize_or(-bone_dir, AosVec3::new(0.0, -1.0, 0.0)));
                s[o + j].position = s[o + j + 1].position + dir.scale(s[o + j].length);
            }
            base_est[ci] = s[o].position;
        }

        // 2. Root.
        let (mut sum, mut wsum) = (AosVec3::zero(), 0.0f32);
        for ci in 0..nc {
            if chains[ci].parent.is_none() {
                sum = sum + base_est[ci].scale(weight[ci]);
                wsum += weight[ci];
            }
        }
        let root_bwd = sum.scale(1.0 / wsum);
        root_pos = anchor + (root_bwd - anchor).scale(pull);

        // 3. Forward.
        for ci in 0..nc {
            let len = chains[ci].bones.len();
            let o = off[ci];
            let start = match chains[ci].parent {
                None => root_pos,
                Some(p) => {
                    let p = p as usize;
                    s[off[p] + chains[p].bones.len() - 1].position
                }
            };
            s[o].position = start;
            for j in 0..len - 1 {
                let bone_dir = s[o + j].rotation.rotate(s[o + j].offset);
                let d = s[o + j + 1].position - s[o + j].position;
                let dir = normalize_or(d, normalize_or(bone_dir, AosVec3::new(0.0, 1.0, 0.0)));
                s[o + j + 1].position = s[o + j].position + dir.scale(s[o + j].length);
            }
        }
    }
    let error = error_of(s);

    // 5. Rotations, top-down.
    let mut old = [AosVec3::zero(); MAX_CHAINS];
    let mut new = [AosVec3::zero(); MAX_CHAINS];
    let r_root = {
        let r_inh = s[0].rotation;
        let mut k = 0;
        for ci in 0..nc {
            if chains[ci].parent.is_none() {
                let o = off[ci];
                old[k] = r_inh.rotate(s[o].offset);
                new[k] = s[o + 1].position - root_pos;
                k += 1;
            }
        }
        (branch_rotation(&old[..k], &new[..k]) * r_inh).normalize_or_identity()
    };
    for ci in 0..nc {
        if chains[ci].parent.is_none() {
            s[off[ci]].rotation = r_root;
        }
    }
    let w = goal.weight;
    let root_local = (root_parent.rotation.conjugate() * r_root).normalize_or_identity();
    pose.blend_local_rotation(root as usize, root_local, w);
    pose.blend_local_translation(root as usize, parent_space_point(root_parent, root_pos), w);

    for ci in 0..nc {
        let ch = &chains[ci];
        let len = ch.bones.len();
        let o = off[ci];
        for j in 1..len {
            let pr = chain_parent_rotation(&s[o..o + len], j);
            let r_inh = (pr * s[o + j].local).normalize_or_identity();
            let mut r = if j + 1 < len {
                let from = normalize_or(r_inh.rotate(s[o + j].offset), AosVec3::new(0.0, 1.0, 0.0));
                let to = normalize_or(s[o + j + 1].position - s[o + j].position, from);
                (from_to(from, to) * r_inh).normalize_or_identity()
            } else if has_children[ci] {
                let mut k = 0;
                for (kc, child) in chains.iter().enumerate().skip(ci + 1) {
                    if child.parent == Some(ci as u8) {
                        let co = off[kc];
                        old[k] = r_inh.rotate(s[co].offset);
                        new[k] = s[co + 1].position - s[o + j].position;
                        k += 1;
                    }
                }
                (branch_rotation(&old[..k], &new[..k]) * r_inh).normalize_or_identity()
            } else {
                r_inh
            };
            if j + 1 == len {
                let eff = &goal.effectors[ci];
                r = blend_rotation(r, eff.rotation, eff.rotation_weight);
                if has_children[ci] {
                    for (kc, child) in chains.iter().enumerate().skip(ci + 1) {
                        if child.parent == Some(ci as u8) {
                            s[off[kc]].rotation = r;
                        }
                    }
                }
            }
            s[o + j].rotation = r;
            let local = (pr.conjugate() * r).normalize_or_identity();
            pose.blend_local_rotation(ch.bones[j] as usize, local, w);
        }
    }
    FullBodyResult { iterations, error }
}
