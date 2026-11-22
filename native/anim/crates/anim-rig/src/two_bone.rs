//! Analytic two-bone IK (arms and legs).

use crate::geom::{
    any_orthogonal, exp_neg, fmax, fmin, from_to, normalize_or, unit_clamp, DEGENERATE_SQ,
};
use crate::pose::RigPose;
use anim_math::{AosQuat, AosVec3};

/// The three bones of a limb: `root` (upper arm, thigh), `mid` (forearm, shin) and `tip` (hand,
/// foot). `mid` must be a descendant of `root` and `tip` of `mid`; usually they are parent and
/// child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TwoBone {
    pub root: u16,
    pub mid: u16,
    pub tip: u16,
}

/// Where the limb bends.
#[derive(Clone, Copy, Debug)]
pub enum Pole {
    /// Keep the animated bend plane (the plane through root, mid and target).
    Animated,
    /// Bend toward this model-space point (a knee or elbow target).
    Position(AosVec3),
    /// Bend toward this model-space direction from the root (a hint direction).
    Direction(AosVec3),
}

/// What the tip's rotation does.
#[derive(Clone, Copy, Debug)]
pub enum TipRotation {
    /// The tip keeps its local rotation, so it turns with the mid bone.
    Inherit,
    /// The tip keeps its model-space rotation from before the solve (feet stay flat, hands keep
    /// holding).
    Maintain,
    /// The tip takes this model-space rotation.
    Target(AosQuat),
}

/// One two-bone solve.
#[derive(Clone, Copy, Debug)]
pub struct TwoBoneGoal {
    /// The tip's model-space target position.
    pub target: AosVec3,
    pub pole: Pole,
    pub tip_rotation: TipRotation,
    /// Soft-IK band as a fraction of the full reach `L = a + b`, in `[0, 1)`; 0 is hard IK.
    /// See [`two_bone`].
    pub soft: f32,
    /// The largest stretch factor (≥ 1; 1 never stretches). See [`two_bone`].
    pub max_stretch: f32,
    /// The entry weight in `[0, 1]`: every local rotation (and stretched translation) is blended
    /// from the input pose by it.
    pub weight: f32,
}

impl TwoBoneGoal {
    /// Hard IK toward `target`, animated bend plane, inherited tip rotation, no stretch, weight 1.
    pub fn new(target: AosVec3) -> Self {
        Self {
            target,
            pole: Pole::Animated,
            tip_rotation: TipRotation::Inherit,
            soft: 0.0,
            max_stretch: 1.0,
            weight: 1.0,
        }
    }
}

/// What a two-bone solve did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TwoBoneResult {
    /// The distance from the root the tip was placed at (after soft IK and stretch).
    pub reach: f32,
    /// The stretch factor applied (1 when none).
    pub stretch: f32,
}

/// Analytic two-bone IK.
///
/// # Maths
///
/// Model-space positions `A` (root), `B` (mid), `C` (tip) and target `T`; lengths
/// `a = |B − A|`, `b = |C − B|`, `L = a + b`; `d = |T − A|` and `û = (T − A)/d`.
///
/// 1. **Soft IK** (Andy Dixon's curve): with band `s = soft·L` and `dₛ = L − s`, a target past
///    `dₛ` is placed at `dₛ + s·(1 − e^(−(d − dₛ)/s))` instead of `d`. The curve meets the
///    line `d` with slope 1 at `dₛ` and approaches `L` without reaching it, so the limb never
///    snaps straight. ([`exp_neg`] makes `e^-x` deterministic.)
/// 2. **Stretch**: with `max_stretch > 1`, the limb scales by `k = clamp(d / d_soft, 1, max)`
///    (`d_soft` is `min(d, L)` without soft IK; `mid`'s and `tip`'s local translations scale by `k`, which is exact when they are the
///    children of `root` and `mid`), so the tip still reaches `T` when
///    soft IK alone would leave it short. The placed reach is `r = d_soft·k`, never more than `d`.
/// 3. The reach is clamped to `[|a − b|, L]` (fully folded to fully straight, scaled by `k`).
/// 4. **Bend direction** `n̂`: the part of the pole vector perpendicular to `û`
///    (`Pole::Position(P)`: `P − A`; `Pole::Direction(v)`: `v`; `Pole::Animated`: `B − A`). If
///    that is degenerate (a straight limb with no pole, or a pole on the line), the animated
///    `B − A`, then [`any_orthogonal`]`(û)`.
/// 5. **Mid position** by the law of cosines without trigonometry:
///    `x = (r² + a² − b²) / 2r` along `û` and `h = √max(0, a² − x²)` along `n̂`:
///    `B' = A + û·x + n̂·h`.
/// 6. **Rotations**: the root turns by the shortest arc `q₁ = from_to(B − A, B' − A)`; that
///    carries the tip to `C₁ = B' + q₁·(C − B)`; the mid then turns by
///    `q₂ = from_to(C₁ − B', T' − B')` with `T' = A + û·r`. Model rotations become
///    `q₁·R_root`, `q₂·q₁·R_mid`, and the tip's per [`TipRotation`].
/// 7. Locals are `parent⁻¹ · model` against the *solved* parents, then blended from the input
///    by `weight` (nlerp).
///
/// If the target sits on the root (`d ≈ 0`), `û` falls back to the current root-to-tip
/// direction. Never allocates.
pub fn two_bone(pose: &mut RigPose, limb: TwoBone, goal: &TwoBoneGoal) -> TwoBoneResult {
    let (ri, mi, ti) = (limb.root as usize, limb.mid as usize, limb.tip as usize);
    let root = pose.model(ri);
    let mid = pose.model(mi);
    let tip = pose.model(ti);
    let root_parent = pose.parent_model(ri).rotation;
    let mid_parent = pose.parent_model(mi).rotation;
    let tip_parent = pose.parent_model(ti).rotation;

    let pa = root.translation;
    let pb = mid.translation;
    let pc = tip.translation;
    let a = (pb - pa).length();
    let b = (pc - pb).length();
    let full = a + b;
    if !(a > 1e-6 && b > 1e-6) {
        return TwoBoneResult {
            reach: (pc - pa).length(),
            stretch: 1.0,
        };
    }

    let to_t = goal.target - pa;
    let d = to_t.length();
    let fallback_dir = normalize_or(pc - pa, normalize_or(pb - pa, AosVec3::new(1.0, 0.0, 0.0)));
    let u = normalize_or(to_t, fallback_dir);

    // 1. Soft IK.
    let soft = fmin(unit_clamp(goal.soft), 0.999);
    let band = soft * full;
    let start = full - band;
    let d_soft = if band > 1e-6 && d > start {
        start + band * (1.0 - exp_neg((d - start) / band))
    } else {
        fmin(d, full)
    };
    // 2. Stretch.
    let max_stretch = fmax(goal.max_stretch, 1.0);
    let k = if max_stretch > 1.0 && d_soft > 1e-6 {
        fmin(fmax(d / d_soft, 1.0), max_stretch)
    } else {
        1.0
    };
    let (a2, b2) = (a * k, b * k);
    // 3. Reach clamp.
    let r = fmin(fmax(d_soft * k, (a2 - b2).abs()), a2 + b2);

    // 4. Bend direction.
    let pole_vec = match goal.pole {
        Pole::Animated => pb - pa,
        Pole::Position(p) => p - pa,
        Pole::Direction(v) => v,
    };
    let perp = |v: AosVec3| v - u.scale(v.dot(u));
    let mut n = perp(pole_vec);
    if n.length_squared() <= DEGENERATE_SQ {
        n = perp(pb - pa);
    }
    let n = normalize_or(n, any_orthogonal(u));

    // 5. Mid position.
    let x = if r > 1e-9 {
        (r * r + a2 * a2 - b2 * b2) / (2.0 * r)
    } else {
        0.0
    };
    let h = fmax(a2 * a2 - x * x, 0.0).sqrt();
    let pb_new = pa + u.scale(x) + n.scale(h);
    let pt_new = pa + u.scale(r);

    // 6. Rotations.
    let q1 = from_to(normalize_or(pb - pa, u), normalize_or(pb_new - pa, u));
    let c1 = pb_new + q1.rotate((pc - pb).scale(k));
    let q2 = from_to(
        normalize_or(c1 - pb_new, u),
        normalize_or(pt_new - pb_new, u),
    );
    let root_r = (q1 * root.rotation).normalize_or_identity();
    let q21 = (q2 * q1).normalize_or_identity();
    let mid_r = (q21 * mid.rotation).normalize_or_identity();

    // 7. Locals against the solved parents. The bones between root and mid (if any) turn by q1,
    // those between mid and tip by q2·q1.
    let root_local = (root_parent.conjugate() * root_r).normalize_or_identity();
    let mid_parent_new = (q1 * mid_parent).normalize_or_identity();
    let mid_local = (mid_parent_new.conjugate() * mid_r).normalize_or_identity();
    let tip_parent_new = (q21 * tip_parent).normalize_or_identity();
    let tip_local = match goal.tip_rotation {
        TipRotation::Inherit => None,
        TipRotation::Maintain => Some(tip.rotation),
        TipRotation::Target(q) => Some(q),
    }
    .map(|m| (tip_parent_new.conjugate() * m).normalize_or_identity());

    let w = goal.weight;
    pose.blend_local_rotation(ri, root_local, w);
    pose.blend_local_rotation(mi, mid_local, w);
    if let Some(tl) = tip_local {
        pose.blend_local_rotation(ti, tl, w);
    }
    if k > 1.0 {
        let mt = pose.local(mi).translation;
        let tt = pose.local(ti).translation;
        let stretch_w = unit_clamp(w);
        let ks = 1.0 + (k - 1.0) * stretch_w;
        pose.blend_local_translation(mi, mt.scale(ks), 1.0);
        pose.blend_local_translation(ti, tt.scale(ks), 1.0);
    }
    TwoBoneResult {
        reach: r,
        stretch: k,
    }
}
