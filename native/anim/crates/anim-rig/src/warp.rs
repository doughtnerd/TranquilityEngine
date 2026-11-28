//! Warping: distance matching (playback time from root travel), stride warping, orientation
//! warping and motion warping (landing the root on a target over a window).

use crate::geom::{fmax, fmin, normalize_or, swing_twist, unit_clamp, DEGENERATE_SQ};
use crate::grounder::MAX_FEET;
use crate::pose::{gather, write_chain, ChainJoint, RigPose};
use crate::two_bone::{two_bone, Pole, TipRotation, TwoBone, TwoBoneGoal};
use anim_format::frames::FrameClock;
use anim_math::trig::atan2;
use anim_math::{AosQuat, AosTransform, AosVec3};

// ---------------------------------------------------------------------------------------------
// Distance warping

/// A clip's cumulative root travel per frame: `distance[i]` is the distance the root has covered
/// by frame `i`'s time (non-decreasing, usually starting at 0), the frames placed by `clock` (the
/// clip's, so a last frame at the clip's duration is honoured; [`FrameClock::uniform`] for a
/// uniform grid). [`cumulative_distance`] builds one from root positions.
#[derive(Clone, Copy, Debug)]
pub struct DistanceCurve<'a> {
    pub distance: &'a [f32],
    pub clock: FrameClock,
}

/// Fills `out[i]` with the root's travel up to sample `i`: the sum of `|pₖ − pₖ₋₁|` with each
/// difference projected off `up` when `up` is non-zero (ground-plane travel).
pub fn cumulative_distance(positions: &[AosVec3], up: AosVec3, out: &mut [f32]) {
    assert_eq!(positions.len(), out.len(), "one distance per sample");
    let mut sum = 0.0f32;
    for i in 0..positions.len() {
        if i > 0 {
            let mut d = positions[i] - positions[i - 1];
            if up.length_squared() > DEGENERATE_SQ {
                d = d - up.scale(d.dot(up));
            }
            sum += d.length();
        }
        out[i] = sum;
    }
}

impl DistanceCurve<'_> {
    /// The time of the last sample.
    pub fn duration(&self) -> f32 {
        self.clock
            .time(self.distance.len().saturating_sub(1) as f32)
    }

    /// The travel at time `t` (linear between samples, clamped to the ends).
    pub fn distance_at(&self, t: f32) -> f32 {
        let n = self.distance.len();
        assert!(n > 0, "empty distance curve");
        if n == 1 || !(t > 0.0) {
            return self.distance[0];
        }
        let p = self.clock.pos(t);
        let (a, b) = ((p.f0 as usize).min(n - 1), (p.f1 as usize).min(n - 1));
        self.distance[a] + (self.distance[b] - self.distance[a]) * p.alpha
    }

    /// The earliest time the travel reaches `d` (the inverse of [`distance_at`](Self::distance_at)):
    /// a binary search for the first sample at or past `d`, then linear inside the segment.
    /// Below the first sample gives 0; past the last, the duration.
    pub fn time_at(&self, d: f32) -> f32 {
        let s = self.distance;
        let n = s.len();
        assert!(n > 0, "empty distance curve");
        if !(d > s[0]) {
            return 0.0;
        }
        if d >= s[n - 1] {
            // The earliest sample that already reached the end value.
            let mut k = n - 1;
            while k > 0 && s[k - 1] >= s[n - 1] {
                k -= 1;
            }
            return self.clock.time(k as f32);
        }
        // First index with s[i] >= d (i ≥ 1).
        let (mut lo, mut hi) = (0usize, n - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if s[mid] >= d {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        let seg = s[hi] - s[lo];
        let f = if seg > 0.0 { (d - s[lo]) / seg } else { 0.0 };
        self.clock.time(lo as f32 + f)
    }

    /// The playback rate that makes the clip's root travel `travel` over the next `dt` from time
    /// `t`: `(time_at(distance_at(t) + travel) − t) / dt`, clamped to `[min_rate, max_rate]`.
    /// Distance warping for starts, pivots and locomotion cycles whose speed differs from the
    /// character's.
    pub fn playback_rate(&self, t: f32, dt: f32, travel: f32, min_rate: f32, max_rate: f32) -> f32 {
        if !(dt > 0.0) {
            return 1.0;
        }
        let goal = self.time_at(self.distance_at(t) + fmax(travel, 0.0));
        fmin(fmax((goal - t) / dt, min_rate), max_rate)
    }

    /// Distance matching toward a marker (a stop): the time at which the clip's remaining travel
    /// to `marker_time` equals `remaining`, i.e. `time_at(distance_at(marker_time) − remaining)`.
    pub fn time_before(&self, marker_time: f32, remaining: f32) -> f32 {
        let end = self.distance_at(marker_time);
        fmin(self.time_at(end - fmax(remaining, 0.0)), marker_time)
    }
}

// ---------------------------------------------------------------------------------------------
// Stride warping

/// Stride warping: scale how far the feet reach along the movement direction.
#[derive(Clone, Copy, Debug)]
pub struct StrideWarp {
    pub pelvis: u16,
    /// Model-space movement direction (unit, along the ground).
    pub direction: AosVec3,
    /// Stride scale (actual speed over the clip's speed): 1 changes nothing.
    pub scale: f32,
    /// Model-space up (unit).
    pub up: AosVec3,
    /// How much of the needed pelvis drop to apply, in `[0, 1]`.
    pub pelvis_weight: f32,
    /// The largest pelvis drop.
    pub max_pelvis_drop: f32,
    /// The longest leg extension as a fraction of the leg's length (e.g. 0.995).
    pub max_reach: f32,
    /// The entry weight in `[0, 1]`.
    pub weight: f32,
}

/// Stride warping (Unreal's Stride Warping).
///
/// # Maths
///
/// With the pelvis `p`, its ground point `g = p − up·(p·up)` and the movement direction `m̂`,
/// each foot `f` moves to `f' = f + m̂·(scale − 1)·((f − g)·m̂)`: the stride scales about the
/// point under the pelvis, along the movement only. A leg whose root `h` can then no longer
/// reach (`|f' − h| > R`, `R = max_reach·(a + b)`) needs the pelvis lowered by the smallest
/// `d ≥ 0` with `|f' − h + up·d| = R`: `d = −v·up − √((v·up)² − |v|² + R²)` for `v = f' − h`
/// (or `−v·up` if no drop reaches). The pelvis drops by `pelvis_weight·max d`, clamped to
/// `max_pelvis_drop`, then each leg runs [`two_bone`] to `f'` keeping the foot's model rotation.
/// Blended by `weight`. Never allocates.
pub fn stride_warp(pose: &mut RigPose, legs: &[TwoBone], s: &StrideWarp) {
    assert!(
        !legs.is_empty() && legs.len() <= MAX_FEET,
        "1 to {MAX_FEET} legs"
    );
    if !(s.weight > 0.0) {
        return;
    }
    let up = normalize_or(s.up, AosVec3::new(0.0, 1.0, 0.0));
    let m = s.direction - up.scale(s.direction.dot(up));
    let m = normalize_or(m, AosVec3::zero());
    let p = pose.model(s.pelvis as usize).translation;
    let g = p - up.scale(p.dot(up));
    let mut feet = [AosVec3::zero(); MAX_FEET];
    let mut drop = 0.0f32;
    for (i, leg) in legs.iter().enumerate() {
        let h = pose.model(leg.root as usize).translation;
        let k = pose.model(leg.mid as usize).translation;
        let f = pose.model(leg.tip as usize).translation;
        let fp = f + m.scale((s.scale - 1.0) * (f - g).dot(m));
        feet[i] = fp;
        let r = fmax(s.max_reach, 0.0) * ((k - h).length() + (f - k).length());
        let v = fp - h;
        if v.length_squared() > r * r {
            let vu = v.dot(up);
            let disc = vu * vu - v.length_squared() + r * r;
            let d = if disc >= 0.0 { -vu - disc.sqrt() } else { -vu };
            drop = fmax(drop, fmax(d, 0.0));
        }
    }
    let drop = fmin(
        drop * unit_clamp(s.pelvis_weight),
        fmax(s.max_pelvis_drop, 0.0),
    );
    if drop > 0.0 {
        pose.blend_model_translation(s.pelvis as usize, p - up.scale(drop), s.weight);
    }
    for (i, leg) in legs.iter().enumerate() {
        let goal = TwoBoneGoal {
            target: feet[i],
            pole: Pole::Animated,
            tip_rotation: TipRotation::Maintain,
            soft: 0.0,
            max_stretch: 1.0,
            weight: s.weight,
        };
        two_bone(pose, *leg, &goal);
    }
}

// ---------------------------------------------------------------------------------------------
// Orientation warping

/// The signed angle about `up` from `facing` to `movement` (both projected onto the ground
/// plane), in `[−π, π]`; 0 when either is degenerate. The angle [`orientation_warp`] turns by.
pub fn heading_angle(facing: AosVec3, movement: AosVec3, up: AosVec3) -> f32 {
    let a = facing - up.scale(facing.dot(up));
    let b = movement - up.scale(movement.dot(up));
    if a.length_squared() <= DEGENERATE_SQ || b.length_squared() <= DEGENERATE_SQ {
        return 0.0;
    }
    atan2(a.cross(b).dot(up), a.dot(b))
}

/// Orientation warping: turn the lower body toward the movement direction and counter-rotate
/// the spine so the upper body keeps facing.
#[derive(Clone, Copy, Debug)]
pub struct OrientationWarp<'a> {
    pub pelvis: u16,
    /// Spine bones from the pelvis up; each a descendant of the one before (and of the pelvis).
    pub spine: &'a [u16],
    /// The share of the counter-rotation per spine bone; empty spreads it evenly. Normalised to
    /// sum 1.
    pub spine_weights: &'a [f32],
    /// The turn about `up`, radians ([`heading_angle`]).
    pub angle: f32,
    /// The largest turn, radians.
    pub max_angle: f32,
    /// Model-space up (unit).
    pub up: AosVec3,
    /// The entry weight in `[0, 1]`.
    pub weight: f32,
}

/// Orientation warping (Unreal's Orientation Warping).
///
/// # Maths
///
/// With `a = clamp(angle, ±max_angle)` and `Q(x)` the rotation of `x` about `up`, the pelvis's
/// model rotation becomes `Q(a)·R_pelvis` (the legs, and so the feet, turn with it), and spine
/// bone `k` with cumulative weight `cₖ = w₀ + … + wₖ` becomes `Q(a·(1 − cₖ))·Rₖ` in model space.
/// The last spine bone (`c = 1`) ends with its animated model rotation: the chest, neck, head
/// and arms keep facing where the animation faced. Locals are solved against the solved
/// parents and blended by `weight`. `scratch` needs `spine.len() + 1` entries. Never allocates.
pub fn orientation_warp(pose: &mut RigPose, w: &OrientationWarp, scratch: &mut [ChainJoint]) {
    let n = w.spine.len() + 1;
    assert!(scratch.len() >= n, "orientation-warp scratch too short");
    assert!(
        w.spine_weights.is_empty() || w.spine_weights.len() == w.spine.len(),
        "spine weights: none or one per spine bone"
    );
    let up = normalize_or(w.up, AosVec3::new(0.0, 1.0, 0.0));
    let max = fmax(w.max_angle, 0.0);
    let a = fmin(fmax(w.angle, -max), max);
    let at = |j: usize| {
        if j == 0 {
            w.pelvis as usize
        } else {
            w.spine[j - 1] as usize
        }
    };
    gather(pose, n, at, scratch);
    let c = &mut scratch[..n];
    let q = |x: f32| AosQuat::from_axis_angle(up, x);
    c[0].rotation = (q(a) * c[0].rotation).normalize_or_identity();
    let total: f32 = if w.spine_weights.is_empty() {
        w.spine.len() as f32
    } else {
        w.spine_weights.iter().map(|&x| fmax(x, 0.0)).sum()
    };
    let mut cum = 0.0f32;
    for k in 1..n {
        let wk = if w.spine_weights.is_empty() {
            1.0
        } else {
            fmax(w.spine_weights[k - 1], 0.0)
        };
        cum += if total > 0.0 { wk / total } else { 0.0 };
        let rest = if k == n - 1 { 0.0 } else { 1.0 - cum };
        c[k].rotation = (q(a * rest) * c[k].rotation).normalize_or_identity();
    }
    write_chain(pose, c, n, at, w.weight);
}

// ---------------------------------------------------------------------------------------------
// Motion warping

/// A clip's root transform per frame (`samples[i]` at frame `i`'s time, placed by `clock`), in
/// the clip's space. Scale is ignored.
#[derive(Clone, Copy, Debug)]
pub struct RootCurve<'a> {
    pub samples: &'a [AosTransform],
    pub clock: FrameClock,
}

impl RootCurve<'_> {
    /// The root at `t`: translations lerped, rotations nlerped between samples, clamped to the
    /// ends.
    pub fn sample(&self, t: f32) -> AosTransform {
        let n = self.samples.len();
        assert!(n > 0, "empty root curve");
        if n == 1 || !(t > 0.0) {
            return self.samples[0];
        }
        let p = self.clock.pos(t);
        let f = p.alpha;
        let (a, b) = (
            self.samples[(p.f0 as usize).min(n - 1)],
            self.samples[(p.f1 as usize).min(n - 1)],
        );
        AosTransform::new(
            a.translation.lerp(b.translation, f),
            a.rotation.nlerp(b.rotation, f),
            AosVec3::one(),
        )
    }
}

/// A motion warp: over the window `[t0, t1]` of a clip, bend the root's path so that it lands on
/// `target` at `t1` (`warp("Vault", target, window)` from code, ADR 0372).
#[derive(Clone, Copy, Debug)]
pub struct MotionWarp {
    pub t0: f32,
    pub t1: f32,
    /// Where the character's root was at `t0` (the space the result is in, usually world).
    pub start: AosTransform,
    /// Where the root must be at `t1`, in the same space. Only its position and its yaw about
    /// `up` are matched.
    pub target: AosTransform,
    /// Up (unit), for the yaw correction.
    pub up: AosVec3,
}

/// `3u² − 2u³` for `u` clamped to `[0, 1]`.
fn smoothstep(u: f32) -> f32 {
    let u = unit_clamp(u);
    u * u * (3.0 - 2.0 * u)
}

/// The root's path relative to its pose at `t0`, carried onto `start`.
fn unwarped(curve: &RootCurve, w: &MotionWarp, t: f32) -> AosTransform {
    let r0 = curve.sample(w.t0);
    let r = curve.sample(t);
    let inv0 = r0.rotation.conjugate();
    let rel_t = inv0.rotate(r.translation - r0.translation);
    let rel_r = (inv0 * r.rotation).normalize_or_identity();
    AosTransform::new(
        w.start.translation + w.start.rotation.rotate(rel_t),
        (w.start.rotation * rel_r).normalize_or_identity(),
        AosVec3::one(),
    )
}

/// The warped root at clip time `t`.
///
/// # Maths
///
/// The unwarped root is the clip's motion since `t0` carried onto `start` (`S`):
/// `U(t) = S ∘ (root(t0)⁻¹ ∘ root(t))` (rotation and translation). The yaw it misses by at the
/// end is `Δψ`, the twist about `up` of `target.r · U(t1).r⁻¹` (swing-twist, [`swing_twist`]);
/// `Q(x)` is the rotation of `x` about `up`. With `α(t) = smoothstep((t − t0)/(t1 − t0))` (zero
/// slope at `t0`, so the warp starts smoothly):
///
/// - rotation `R(t) = Q(α·Δψ)·U(t).r`;
/// - position `P(t) = S.t + Q(α·Δψ)·(U(t).t − S.t) + α·Δp`, with
///   `Δp = target.t − S.t − Q(Δψ)·(U(t1).t − S.t)`: the path turns about the start with the
///   facing (so the root never slides sideways), and the remaining miss is spread over the
///   window.
///
/// So before `t0` the root is exactly the clip's (`α = 0`); at `t1` it is exactly at
/// `target.t`, with `target`'s yaw (exactly `target.r` when the two differ by yaw only); after
/// `t1` the clip's motion continues from there, turned by `Δψ`. A window with `t1 ≤ t0` jumps at
/// `t0`.
pub fn motion_warp(curve: &RootCurve, w: &MotionWarp, t: f32) -> AosTransform {
    let u = unwarped(curve, w, t);
    let alpha = if w.t1 > w.t0 {
        smoothstep((t - w.t0) / (w.t1 - w.t0))
    } else if t >= w.t0 {
        1.0
    } else {
        0.0
    };
    if !(alpha > 0.0) {
        return u;
    }
    let end = unwarped(curve, w, w.t1);
    let up = normalize_or(w.up, AosVec3::new(0.0, 1.0, 0.0));
    let diff = (w.target.rotation * end.rotation.conjugate()).normalize_or_identity();
    let (_, twist) = swing_twist(diff, up);
    let twist = if twist.w < 0.0 { -twist } else { twist };
    let yaw = 2.0 * atan2(twist.xyz().dot(up), twist.w);
    let s0 = w.start.translation;
    let q_full = AosQuat::from_axis_angle(up, yaw);
    let dp = w.target.translation - s0 - q_full.rotate(end.translation - s0);
    let q = AosQuat::from_axis_angle(up, yaw * alpha);
    AosTransform::new(
        s0 + q.rotate(u.translation - s0) + dp.scale(alpha),
        (q * u.rotation).normalize_or_identity(),
        AosVec3::one(),
    )
}

/// The warped root motion from `t_prev` to `t`, in the root's frame at `t_prev`
/// (`translation = R_prev⁻¹·(P − P_prev)`, `rotation = R_prev⁻¹·R`): what the host applies to
/// the character each frame while the warp runs. Outside the window it equals the clip's own
/// root motion.
pub fn motion_warp_delta(curve: &RootCurve, w: &MotionWarp, t_prev: f32, t: f32) -> AosTransform {
    let a = motion_warp(curve, w, t_prev);
    let b = motion_warp(curve, w, t);
    let inv = a.rotation.conjugate();
    AosTransform::new(
        inv.rotate(b.translation - a.translation),
        (inv * b.rotation).normalize_or_identity(),
        AosVec3::one(),
    )
}
