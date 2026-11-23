//! [`RigPose`]: the local pose and its model-space cache that every solver works on, and the
//! chain scratch ([`ChainJoint`]) the chain solvers share.

use anim_math::layout::{soa_len, NO_PARENT};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_pose::{bone, set_bone};

/// A local pose (SoA, `anim-pose`'s layout) with its model-space cache, borrowed for a run of
/// solvers.
///
/// Solvers read model-space transforms through [`model`](Self::model) and write **local**
/// rotations and translations. The cache is kept valid lazily: a write marks bone `i` and
/// everything after it (in parents-first order, every descendant of `i` comes after `i`) as
/// stale, and a read of bone `j` recomputes the stale entries on `j`'s ancestor chain
/// (`model[k] = model[parent] ∘ local[k]`, the same arithmetic whichever bones are computed and
/// in whatever order, so the values never depend on the order of reads). So a solver never pays
/// for bones it doesn't read, and dropping the `RigPose` recomputes the rest, leaving the
/// caller's `model` slice valid ([`discard`](Self::discard) skips that when the caller doesn't
/// need it).
///
/// Never allocates.
pub struct RigPose<'a> {
    parents: &'a [u16],
    local: &'a mut [SoaTransform],
    model: &'a mut [AosTransform],
    /// `model[..valid]` is current.
    valid: usize,
    /// Bones at or past `valid` (below [`FRESH_BONES`]) recomputed since the last write at or
    /// before them, one bit each.
    fresh: [u64; FRESH_WORDS],
}

/// Words of [`RigPose`]'s fresh-bone bits.
const FRESH_WORDS: usize = 4;
/// Bones the ancestor-chain path covers; reads past it recompute the stale prefix.
const FRESH_BONES: usize = 64 * FRESH_WORDS;
/// The deepest ancestor chain the ancestor-chain path walks; deeper reads recompute the prefix.
const MAX_CHAIN_DEPTH: usize = 64;

impl<'a> RigPose<'a> {
    /// Wraps a pose whose `model` cache already holds `local` in model space (e.g. straight
    /// from `anim_pose::model::model_space`). `parents.len()` is the bone count; `local` holds
    /// `soa_len(n)` groups and `model` `n` transforms (panics otherwise).
    pub fn new(
        parents: &'a [u16],
        local: &'a mut [SoaTransform],
        model: &'a mut [AosTransform],
    ) -> Self {
        let n = parents.len();
        assert_eq!(local.len(), soa_len(n), "SoA pose length");
        assert_eq!(model.len(), n, "model pose length");
        Self {
            parents,
            local,
            model,
            valid: n,
            fresh: [0; FRESH_WORDS],
        }
    }

    /// Like [`new`](Self::new), but treats `model` as stale (it is computed on demand).
    pub fn stale(
        parents: &'a [u16],
        local: &'a mut [SoaTransform],
        model: &'a mut [AosTransform],
    ) -> Self {
        let mut p = Self::new(parents, local, model);
        p.valid = 0;
        p
    }

    /// The bone count.
    #[inline]
    pub fn bone_count(&self) -> usize {
        self.parents.len()
    }

    /// The parent of bone `i`, or `None` for a root.
    #[inline]
    pub fn parent(&self, i: usize) -> Option<usize> {
        let p = self.parents[i];
        (p != NO_PARENT).then_some(p as usize)
    }

    /// Bone `i`'s local transform.
    #[inline]
    pub fn local(&self, i: usize) -> AosTransform {
        bone(self.local, i)
    }

    /// Bone `i`'s model-space transform (recomputing stale cache entries up to `i`).
    #[inline]
    pub fn model(&mut self, i: usize) -> AosTransform {
        self.ensure(i);
        self.model[i]
    }

    /// The model-space transform of bone `i`'s parent; identity for a root.
    #[inline]
    pub fn parent_model(&mut self, i: usize) -> AosTransform {
        match self.parent(i) {
            Some(p) => self.model(p),
            None => AosTransform::identity(),
        }
    }

    /// Replaces bone `i`'s local transform.
    #[inline]
    pub fn set_local(&mut self, i: usize, t: AosTransform) {
        set_bone(self.local, i, t);
        self.valid = self.valid.min(i);
        self.clear_fresh_from(i);
    }

    /// Sets bone `i`'s local rotation to `nlerp(current, solved, weight)`: unchanged at
    /// `weight ≤ 0`, exactly `solved` at `weight ≥ 1`.
    #[inline]
    pub fn blend_local_rotation(&mut self, i: usize, solved: AosQuat, weight: f32) {
        if !(weight > 0.0) {
            return;
        }
        let mut t = self.local(i);
        t.rotation = blend_rotation(t.rotation, solved, weight);
        self.set_local(i, t);
    }

    /// Sets bone `i`'s local translation to `lerp(current, solved, weight)`.
    #[inline]
    pub fn blend_local_translation(&mut self, i: usize, solved: AosVec3, weight: f32) {
        if !(weight > 0.0) {
            return;
        }
        let mut t = self.local(i);
        t.translation = blend_vec(t.translation, solved, weight);
        self.set_local(i, t);
    }

    /// Moves bone `i` toward the model-space position `p` by `weight`, by changing its local
    /// translation: `local.t = s⁻¹ ⊙ (r⁻¹ · (p − parent.t))` with the parent's model `r`, `s`
    /// (the exact inverse of `TransformT::transform_point`; zero parent scale components give 0).
    pub fn blend_model_translation(&mut self, i: usize, p: AosVec3, weight: f32) {
        if !(weight > 0.0) {
            return;
        }
        let pm = self.parent_model(i);
        let solved = parent_space_point(pm, p);
        self.blend_local_translation(i, solved, weight);
    }

    /// Rotates bone `i` toward the model-space rotation `r` by `weight`, by changing its local
    /// rotation: `local.r = parent.r⁻¹ · r`.
    pub fn blend_model_rotation(&mut self, i: usize, r: AosQuat, weight: f32) {
        if !(weight > 0.0) {
            return;
        }
        let pr = self.parent_model(i).rotation;
        let solved = (pr.conjugate() * r).normalize_or_identity();
        self.blend_local_rotation(i, solved, weight);
    }

    /// Recomputes every stale cache entry.
    pub fn refresh(&mut self) {
        let n = self.bone_count();
        if n > 0 {
            self.ensure_prefix(n - 1);
        }
    }

    /// Ends the run without recomputing the stale cache entries (as dropping does): for a caller
    /// that reads only the local pose afterwards. The `model` slice is left partly stale.
    pub fn discard(mut self) {
        self.valid = self.bone_count();
    }

    #[inline]
    fn is_fresh(&self, k: usize) -> bool {
        k < FRESH_BONES && self.fresh[k / 64] & (1u64 << (k % 64)) != 0
    }

    #[inline]
    fn set_fresh(&mut self, k: usize) {
        if k < FRESH_BONES {
            self.fresh[k / 64] |= 1u64 << (k % 64);
        }
    }

    /// Forgets the fresh bits of bones `i` and after.
    #[inline]
    fn clear_fresh_from(&mut self, i: usize) {
        for (w, word) in self.fresh.iter_mut().enumerate() {
            let lo = w * 64;
            if i <= lo {
                *word = 0;
            } else if i < lo + 64 {
                *word &= (1u64 << (i - lo)) - 1;
            }
        }
    }

    #[inline]
    fn current(&self, k: usize) -> bool {
        k < self.valid || self.is_fresh(k)
    }

    /// Makes bone `i`'s model transform current: its stale ancestors, then it.
    fn ensure(&mut self, i: usize) {
        if self.current(i) {
            return;
        }
        // The stale chain from `i` up (each parent comes before its child).
        let mut chain = [0u16; MAX_CHAIN_DEPTH];
        let mut len = 0;
        let mut k = i;
        loop {
            if len == MAX_CHAIN_DEPTH || k >= FRESH_BONES {
                return self.ensure_prefix(i);
            }
            chain[len] = k as u16;
            len += 1;
            let p = self.parents[k];
            if p == NO_PARENT || self.current(p as usize) {
                break;
            }
            debug_assert!((p as usize) < k, "bone {k}: parent {p} must come before it");
            k = p as usize;
        }
        for &k in chain[..len].iter().rev() {
            self.compute(k as usize);
            self.set_fresh(k as usize);
        }
    }

    /// Makes `model[..=i]` current.
    fn ensure_prefix(&mut self, i: usize) {
        while self.valid <= i {
            let k = self.valid;
            if !self.is_fresh(k) {
                self.compute(k);
            }
            self.valid += 1;
        }
    }

    /// `model[k] = model[parent] ∘ local[k]` (the parent current).
    #[inline]
    fn compute(&mut self, k: usize) {
        let lt = bone(self.local, k);
        let p = self.parents[k];
        self.model[k] = if p == NO_PARENT {
            lt
        } else {
            debug_assert!((p as usize) < k, "bone {k}: parent {p} must come before it");
            self.model[p as usize].compose(lt)
        };
    }
}

impl Drop for RigPose<'_> {
    /// Leaves the borrowed model cache valid.
    fn drop(&mut self) {
        self.refresh();
    }
}

/// `p` (model space) in the space of a parent with model transform `pm`.
#[inline]
pub(crate) fn parent_space_point(pm: AosTransform, p: AosVec3) -> AosVec3 {
    let v = pm.rotation.conjugate().rotate(p - pm.translation);
    let rcp = |s: f32| {
        if s.abs() > anim_math::SCALE_EPSILON {
            1.0 / s
        } else {
            0.0
        }
    };
    AosVec3::new(
        v.x * rcp(pm.scale.x),
        v.y * rcp(pm.scale.y),
        v.z * rcp(pm.scale.z),
    )
}

/// `nlerp(a, b, w)` on the shortest path; exactly `a` at `w ≤ 0` and `b` at `w ≥ 1`.
#[inline]
pub fn blend_rotation(a: AosQuat, b: AosQuat, w: f32) -> AosQuat {
    if !(w > 0.0) {
        a
    } else if w >= 1.0 {
        b
    } else {
        a.nlerp(b, w)
    }
}

/// `lerp(a, b, w)`; exactly `a` at `w ≤ 0` and `b` at `w ≥ 1`.
#[inline]
pub fn blend_vec(a: AosVec3, b: AosVec3, w: f32) -> AosVec3 {
    if !(w > 0.0) {
        a
    } else if w >= 1.0 {
        b
    } else {
        a.lerp(b, w)
    }
}

/// One joint of a chain in a solver's scratch: its model-space position and rotation while the
/// solver works, plus what the solver needs to turn them back into local rotations.
///
/// Callers allocate a slice of these once (`vec![ChainJoint::default(); n]`) and pass it to
/// every solve; its contents between calls don't matter.
#[derive(Clone, Copy, Debug)]
pub struct ChainJoint {
    /// Model-space position.
    pub(crate) position: AosVec3,
    /// Model-space rotation (the solved one once a solver finishes).
    pub(crate) rotation: AosQuat,
    /// For joint 0, the absolute model rotation of the bone's parent; for joint `j > 0`,
    /// `rotation[j−1]⁻¹ · model(parent(bone j)).r` (the rotation of the unchanged bones between
    /// the two chain joints). See [`chain_parent_rotation`].
    pub(crate) parent: AosQuat,
    /// The vector to the next chain joint in this joint's frame (model scale); zero for the last.
    pub(crate) offset: AosVec3,
    /// The distance to the next chain joint; 0 for the last.
    pub(crate) length: f32,
    /// The local rotation before the solve.
    pub(crate) local: AosQuat,
}

impl Default for ChainJoint {
    fn default() -> Self {
        Self {
            position: AosVec3::zero(),
            rotation: AosQuat::identity(),
            parent: AosQuat::identity(),
            offset: AosVec3::zero(),
            length: 0.0,
            local: AosQuat::identity(),
        }
    }
}

/// Fills `out[j]` for `j < count` from the bones `bone_at(j)`, where every `bone_at(j + 1)` is a
/// descendant of `bone_at(j)`.
pub(crate) fn gather(
    pose: &mut RigPose,
    count: usize,
    bone_at: impl Fn(usize) -> usize,
    out: &mut [ChainJoint],
) {
    assert!(out.len() >= count, "chain scratch too short");
    for j in 0..count {
        let b = bone_at(j);
        let m = pose.model(b);
        let pr = pose.parent_model(b).rotation;
        out[j].position = m.translation;
        out[j].rotation = m.rotation;
        out[j].local = pose.local(b).rotation;
        out[j].parent = if j == 0 {
            pr
        } else {
            (out[j - 1].rotation.conjugate() * pr).normalize_or_identity()
        };
    }
    for j in 0..count {
        if j + 1 < count {
            let d = out[j + 1].position - out[j].position;
            out[j].offset = out[j].rotation.conjugate().rotate(d);
            out[j].length = d.length();
        } else {
            out[j].offset = AosVec3::zero();
            out[j].length = 0.0;
        }
    }
}

/// The model rotation of joint `j`'s parent bone given the chain's current rotations.
#[inline]
pub(crate) fn chain_parent_rotation(c: &[ChainJoint], j: usize) -> AosQuat {
    if j == 0 {
        c[0].parent
    } else {
        (c[j - 1].rotation * c[j].parent).normalize_or_identity()
    }
}

/// Rotates joint `j` (about its position) and every later joint by the model-space `delta`.
pub(crate) fn rotate_from(c: &mut [ChainJoint], count: usize, j: usize, delta: AosQuat) {
    let pivot = c[j].position;
    for k in j..count {
        c[k].rotation = (delta * c[k].rotation).normalize_or_identity();
        if k > j {
            c[k].position = pivot + delta.rotate(c[k].position - pivot);
        }
    }
}

/// Writes joints `0..upto` back as local rotations blended by `weight` (each solved local is
/// `parent_rotation⁻¹ · rotation` from the chain's own solved rotations).
pub(crate) fn write_chain(
    pose: &mut RigPose,
    c: &[ChainJoint],
    upto: usize,
    bone_at: impl Fn(usize) -> usize,
    weight: f32,
) {
    for j in 0..upto {
        let pr = chain_parent_rotation(c, j);
        let solved = (pr.conjugate() * c[j].rotation).normalize_or_identity();
        pose.blend_local_rotation(bone_at(j), solved, weight);
    }
}
