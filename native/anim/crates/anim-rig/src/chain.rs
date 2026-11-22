//! Chain IK: CCD and FABRIK, with per-joint limits.

use crate::geom::{from_to, normalize_or, DEGENERATE_SQ};
use crate::limit::JointLimit;
use crate::pose::{chain_parent_rotation, gather, rotate_from, write_chain, ChainJoint, RigPose};
use anim_math::AosVec3;

/// One chain solve: a model-space target for the chain's last bone.
#[derive(Clone, Copy, Debug)]
pub struct ChainGoal {
    /// The tip's model-space target position.
    pub target: AosVec3,
    /// The most iterations to run (each a full pass over the chain).
    pub iterations: u32,
    /// Stop once the tip is within this distance of the target (model units).
    pub tolerance: f32,
    /// The entry weight in `[0, 1]`: local rotations blend from the input pose by it.
    pub weight: f32,
}

impl ChainGoal {
    /// 16 iterations, 1 mm tolerance, weight 1.
    pub fn new(target: AosVec3) -> Self {
        Self {
            target,
            iterations: 16,
            tolerance: 1e-3,
            weight: 1.0,
        }
    }
}

/// What a chain solve did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChainResult {
    /// Iterations run (0 when the tip already met the tolerance).
    pub iterations: u32,
    /// The final distance from the tip to the target, at full weight.
    pub error: f32,
}

fn check(chain: &[u16], limits: &[JointLimit], scratch: &[ChainJoint]) {
    assert!(chain.len() >= 2, "a chain needs at least two bones");
    assert!(scratch.len() >= chain.len(), "chain scratch too short");
    assert!(
        limits.is_empty() || limits.len() == chain.len(),
        "limits: none or one per chain bone"
    );
}

/// Limits joint `j`'s local rotation and carries the correction to the joints below it.
fn limit_joint(c: &mut [ChainJoint], count: usize, j: usize, limit: &JointLimit) {
    if limit.is_free() {
        return;
    }
    let pr = chain_parent_rotation(c, j);
    let local = (pr.conjugate() * c[j].rotation).normalize_or_identity();
    let Some(limited) = limit.limit(local) else {
        return;
    };
    let target = (pr * limited).normalize_or_identity();
    let delta = (target * c[j].rotation.conjugate()).normalize_or_identity();
    rotate_from(c, count, j, delta);
}

/// Cyclic coordinate descent.
///
/// `chain` lists bones from the chain's root to its tip; each must be a descendant of the one
/// before (bones in between keep their local rotations). `limits` is empty or holds one
/// [`JointLimit`] per chain bone (the tip's is unused).
///
/// # Algorithm
///
/// Each iteration visits joints from the one nearest the tip back to the root. At joint `j`
/// (position `pⱼ`), with tip `e` and target `t`, the joint turns by the shortest arc
/// `from_to(ê, t̂)` between `e − pⱼ` and `t − pⱼ`, which carries every joint below it (their
/// positions turn about `pⱼ`). Its local rotation (against its parent's current rotation) is then
/// limited and the correction carried down the same way. Iterations stop once
/// `|e − t| ≤ tolerance` or after `iterations`.
///
/// CCD minimises the error monotonically without limits (each step can only bring `e` closer to
/// `t`), favours the joints nearest the tip, and needs no lengths. All work happens in `scratch`
/// (model space); the locals are written once at the end, blended by `goal.weight`. Never
/// allocates.
pub fn ccd(
    pose: &mut RigPose,
    chain: &[u16],
    limits: &[JointLimit],
    goal: &ChainGoal,
    scratch: &mut [ChainJoint],
) -> ChainResult {
    check(chain, limits, scratch);
    let n = chain.len();
    let at = |j: usize| chain[j] as usize;
    gather(pose, n, at, scratch);
    let c = &mut scratch[..n];
    let t = goal.target;
    let tol = goal.tolerance.max(0.0);
    let mut error = (c[n - 1].position - t).length();
    let mut iterations = 0;
    while iterations < goal.iterations && error > tol {
        iterations += 1;
        for j in (0..n - 1).rev() {
            let p = c[j].position;
            let to_e = c[n - 1].position - p;
            let to_t = t - p;
            if to_e.length_squared() > DEGENERATE_SQ && to_t.length_squared() > DEGENERATE_SQ {
                let delta = from_to(normalize_or(to_e, to_t), normalize_or(to_t, to_e));
                rotate_from(c, n, j, delta);
            }
            if let Some(l) = limits.get(j) {
                limit_joint(c, n, j, l);
            }
        }
        error = (c[n - 1].position - t).length();
    }
    if iterations > 0 {
        write_chain(pose, c, n - 1, at, goal.weight);
    }
    ChainResult { iterations, error }
}

/// FABRIK (Aristidou & Lasenby 2011), with joint limits projected in the forward pass.
///
/// `chain` and `limits` as for [`ccd`].
///
/// # Algorithm
///
/// With chain positions `p₀ … pₙ₋₁` and segment lengths `lⱼ = |pⱼ₊₁ − pⱼ|` (fixed from the input
/// pose):
///
/// - **Backward pass** (tip to root): `pₙ₋₁ ← t`, then
///   `pⱼ ← pⱼ₊₁ + normalize(pⱼ − pⱼ₊₁)·lⱼ`.
/// - **Forward pass** (root to tip): `p₀` returns to its original position. For each joint `j`,
///   the joint's rotation turns by the shortest arc from its current bone direction
///   (`Rⱼ·offsetⱼ`) to `normalize(pⱼ₊₁ − pⱼ)` (the joints below turn with it, so their locals are
///   kept), its local rotation is limited (the projection step), and `pⱼ₊₁ ← pⱼ + Rⱼ·offsetⱼ`.
///
/// Tracking rotations in the forward pass (instead of positions only) gives each joint the
/// minimal twist and makes limit projection exact. An unreachable target ends with the chain
/// straight toward it after one iteration. Stops at `tolerance` or after `iterations`; writes
/// the locals blended by `goal.weight`. Never allocates.
pub fn fabrik(
    pose: &mut RigPose,
    chain: &[u16],
    limits: &[JointLimit],
    goal: &ChainGoal,
    scratch: &mut [ChainJoint],
) -> ChainResult {
    check(chain, limits, scratch);
    let n = chain.len();
    let at = |j: usize| chain[j] as usize;
    gather(pose, n, at, scratch);
    let c = &mut scratch[..n];
    let t = goal.target;
    let tol = goal.tolerance.max(0.0);
    let base = c[0].position;
    let mut error = (c[n - 1].position - t).length();
    let mut iterations = 0;
    while iterations < goal.iterations && error > tol {
        iterations += 1;
        // Backward.
        c[n - 1].position = t;
        for j in (0..n - 1).rev() {
            let bone_dir = c[j].rotation.rotate(c[j].offset);
            let d = c[j].position - c[j + 1].position;
            let dir = normalize_or(d, normalize_or(-bone_dir, AosVec3::new(1.0, 0.0, 0.0)));
            c[j].position = c[j + 1].position + dir.scale(c[j].length);
        }
        // Forward.
        c[0].position = base;
        for j in 0..n - 1 {
            forward_joint(c, n, j);
            if let Some(l) = limits.get(j) {
                limit_joint_keep_targets(c, n, j, l);
            }
            c[j + 1].position = c[j].position + c[j].rotation.rotate(c[j].offset);
        }
        error = (c[n - 1].position - t).length();
    }
    if iterations > 0 {
        write_chain(pose, c, n - 1, at, goal.weight);
    }
    ChainResult { iterations, error }
}

/// Turns joint `j` toward `pⱼ₊₁` and carries the rotation (not the positions, which are the
/// backward pass's targets) to the joints below.
pub(crate) fn forward_joint(c: &mut [ChainJoint], count: usize, j: usize) {
    let bone_dir = c[j].rotation.rotate(c[j].offset);
    let want = c[j + 1].position - c[j].position;
    if bone_dir.length_squared() <= DEGENERATE_SQ || want.length_squared() <= DEGENERATE_SQ {
        return;
    }
    let delta = from_to(normalize_or(bone_dir, want), normalize_or(want, bone_dir));
    for k in j..count {
        c[k].rotation = (delta * c[k].rotation).normalize_or_identity();
    }
}

/// [`limit_joint`] for the forward pass: corrects rotations only.
fn limit_joint_keep_targets(c: &mut [ChainJoint], count: usize, j: usize, limit: &JointLimit) {
    if limit.is_free() {
        return;
    }
    let pr = chain_parent_rotation(c, j);
    let local = (pr.conjugate() * c[j].rotation).normalize_or_identity();
    let Some(limited) = limit.limit(local) else {
        return;
    };
    let target = (pr * limited).normalize_or_identity();
    let delta = (target * c[j].rotation.conjugate()).normalize_or_identity();
    for k in j..count {
        c[k].rotation = (delta * c[k].rotation).normalize_or_identity();
    }
}
