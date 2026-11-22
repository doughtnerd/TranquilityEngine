//! Inertialization (leaf L12a): Bollo's pose transition, "Inertialization: High-Performance
//! Animation Transitions in Gears of War" (GDC 2018).
//!
//! At a switch the new animation takes over *immediately*. For each bone, the difference between
//! the old pose and the new pose is captured as an **offset** (a vector for translation, an
//! axis-angle for rotation) with the **velocity** of that difference, and then added on top of the
//! new animation, decaying to zero over the blend time. Unlike a crossfade it evaluates only the
//! new animation (one source, no second pose to blend), and the motion stays continuous in
//! position and in velocity.
//!
//! # The decay curve
//!
//! Per bone and channel the offset is a scalar `x(t)` along a fixed direction (a unit vector for
//! translation, a rotation axis for rotation, so `offset(t) = dir * x(t)`), a quintic
//!
//! ```text
//! x(t) = A t^5 + B t^4 + C t^3 + D t^2 + E t + F,   0 <= t <= T
//! ```
//!
//! with `x(0) = x0`, `x'(0) = v0`, `x''(0) = a0`, and `x(T) = x'(T) = x''(T) = 0`. Solving the
//! six conditions (Bollo's coefficients):
//!
//! ```text
//! F = x0,   E = v0,   D = a0 / 2
//! A = -(a0 T^2 +  6 v0 T + 12 x0) / (2 T^5)
//! B =  (3 a0 T^2 + 16 v0 T + 30 x0) / (2 T^4)
//! C = -(3 a0 T^2 + 12 v0 T + 20 x0) / (2 T^3)
//! ```
//!
//! [`Quintic`] stores the same polynomial in `s = t / T` (so the coefficients stay near the
//! magnitude of `x0`, `v0 T` and `a0 T^2` and f32 keeps its precision): with `u = v0 T`,
//! `w = a0 T^2`,
//!
//! ```text
//! x(s) = x0 + u s + (w/2) s^2 + (-10 x0 - 6 u - 1.5 w) s^3 + (15 x0 + 8 u + 1.5 w) s^4
//!        + (-6 x0 - 3 u - 0.5 w) s^5
//! ```
//!
//! which is `A..F` rewritten (`A T^5` is the `s^5` coefficient, and so on). The poses here use
//! `a0 = 0`: the offset's initial acceleration isn't known from three pose samples, and zero
//! keeps the curve smooth.
//!
//! # No overshoot
//!
//! When the offset's initial velocity points toward zero (`v0` and `x0` of opposite signs) and is
//! large, the quintic would pass through zero and come back. Bollo limits the blend time so it
//! can't. With `a0 = 0` and `k = |v0| T / |x0|`, the quintic stays on the side of `x0` exactly
//! while `k <= 2.50087`, so [`clamp_blend_time`] uses `T' = min(T, 2.5 |x0| / |v0|)` for that
//! channel (a bisection over `k`; 2.5 keeps a margin). A bone whose offset is gone early simply
//! settles early.
//!
//! # What is captured
//!
//! [`Inertializer::begin`] takes the last two output poses (`prev`, `prev_prev`, one `dt` apart),
//! and the new animation's pose at the switch. Velocity of the old motion is
//! `(prev - prev_prev) / dt`; the new animation's velocity is taken as zero, or measured with
//! [`Inertializer::begin_with_target_velocity`], which also takes the new animation one `dt`
//! earlier. The offset velocity is their difference, so the output's velocity is continuous.
//! Rotation velocities are the axis-angle of the frame-to-frame rotation divided by `dt`, along
//! the offset's axis. Scale isn't inertialized (it isn't visible motion in practice); the new
//! animation's scale is used as is.
//!
//! [`Inertializer::apply`] advances the clock by `dt` *first* and then adds the offset at the new
//! time, so the frame after `begin` already moves on (no frame is shown twice). Time comes from
//! the caller's `dt`, not a clock.

use anim_math::layout::{soa_len, LANES};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};

/// A transition shorter than this (seconds) is a cut: the offset isn't applied at all.
pub const MIN_BLEND_TIME: f32 = 1e-4;

/// `k_max` of the module docs, with margin: `|v0| T / |x0|` above this overshoots.
pub const NO_OVERSHOOT_K: f32 = 2.5;

/// Offsets (or velocities times a time step) below this are zero.
const EPS: f32 = 1e-9;

/// The scalar decay curve `x(t)` of the module docs, in `s = t / T` form.
#[derive(Clone, Copy, Debug, Default)]
pub struct Quintic {
    /// Coefficients of `s^0..s^5`.
    c: [f32; 6],
    duration: f32,
}

impl Quintic {
    /// The curve with `x(0) = x0`, `x'(0) = v0`, `x''(0) = a0` and `x = x' = x'' = 0` at
    /// `duration`. A `duration` below [`MIN_BLEND_TIME`] gives the zero curve.
    pub fn new(x0: f32, v0: f32, a0: f32, duration: f32) -> Self {
        if !(duration >= MIN_BLEND_TIME) {
            return Self::default();
        }
        let t = duration;
        let (u, w) = (v0 * t, a0 * t * t);
        Self {
            c: [
                x0,
                u,
                0.5 * w,
                -10.0 * x0 - 6.0 * u - 1.5 * w,
                15.0 * x0 + 8.0 * u + 1.5 * w,
                -6.0 * x0 - 3.0 * u - 0.5 * w,
            ],
            duration: t,
        }
    }

    /// The time at which the curve reaches zero for good (0 for the zero curve).
    pub fn duration(&self) -> f32 {
        self.duration
    }

    /// `x(t)`: `x0` at or before 0, exactly 0 at or after the duration.
    pub fn eval(&self, t: f32) -> f32 {
        if !(t < self.duration) {
            return 0.0;
        }
        let s = if t > 0.0 { t / self.duration } else { 0.0 };
        let c = &self.c;
        c[0] + s * (c[1] + s * (c[2] + s * (c[3] + s * (c[4] + s * c[5]))))
    }

    /// `x'(t)`.
    pub fn velocity(&self, t: f32) -> f32 {
        if !(t < self.duration) {
            return 0.0;
        }
        let s = if t > 0.0 { t / self.duration } else { 0.0 };
        let c = &self.c;
        (c[1] + s * (2.0 * c[2] + s * (3.0 * c[3] + s * (4.0 * c[4] + s * 5.0 * c[5]))))
            / self.duration
    }
}

/// The blend time that keeps the quintic (with `a0 = 0`) from overshooting zero:
/// `min(blend_time, 2.5 |x0| / |v0|)` when `v0` heads toward zero (opposite sign of `x0`),
/// else `blend_time` unchanged.
pub fn clamp_blend_time(x0: f32, v0: f32, blend_time: f32) -> f32 {
    if x0 * v0 < 0.0 {
        let limit = NO_OVERSHOOT_K * x0.abs() / v0.abs();
        if limit < blend_time {
            return limit;
        }
    }
    blend_time
}

/// One bone's captured offsets: a translation offset `pos_dir * pos(t)` and a rotation offset of
/// angle `rot(t)` about `rot_axis`.
#[derive(Clone, Copy, Debug)]
pub struct BoneInertia {
    pub pos_dir: AosVec3,
    pub pos: Quintic,
    pub rot_axis: AosVec3,
    pub rot: Quintic,
}

impl Default for BoneInertia {
    fn default() -> Self {
        Self {
            pos_dir: AosVec3::new(1.0, 0.0, 0.0),
            pos: Quintic::default(),
            rot_axis: AosVec3::new(1.0, 0.0, 0.0),
            rot: Quintic::default(),
        }
    }
}

/// A running inertialization for a skeleton of a fixed bone count. [`new`](Self::new) allocates
/// the per-bone state once; [`begin`](Self::begin) and [`apply`](Self::apply) never allocate.
#[derive(Clone, Debug)]
pub struct Inertializer {
    bones: Vec<BoneInertia>,
    elapsed: f32,
    blend_time: f32,
    active: bool,
}

impl Inertializer {
    pub fn new(bone_count: usize) -> Self {
        Self {
            bones: vec![BoneInertia::default(); bone_count],
            elapsed: 0.0,
            blend_time: 0.0,
            active: false,
        }
    }

    pub fn bone_count(&self) -> usize {
        self.bones.len()
    }

    /// Whether offsets are still decaying.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Seconds since [`begin`](Self::begin).
    pub fn elapsed(&self) -> f32 {
        self.elapsed
    }

    /// The captured offsets, for inspection.
    pub fn bones(&self) -> &[BoneInertia] {
        &self.bones
    }

    /// Stops the transition: [`apply`](Self::apply) leaves poses alone until the next `begin`.
    pub fn cancel(&mut self) {
        self.active = false;
    }

    /// Captures the offsets at a switch, with the new animation's velocity taken as zero. See the
    /// module docs. `prev` and `prev_prev` are the last two output poses, `dt` seconds apart
    /// (`dt <= 0` gives zero velocities); `new_pose` is the new animation's pose now. A
    /// `blend_time` below [`MIN_BLEND_TIME`] is a cut (nothing is applied). Restarting while
    /// active simply captures again (that's how interrupted transitions chain).
    ///
    /// Panics unless all three poses have `soa_len(bone_count)` groups.
    pub fn begin(
        &mut self,
        prev: &[SoaTransform],
        prev_prev: &[SoaTransform],
        new_pose: &[SoaTransform],
        dt: f32,
        blend_time: f32,
    ) {
        self.capture(prev, prev_prev, new_pose, None, dt, blend_time);
    }

    /// [`begin`](Self::begin) with the new animation's velocity measured from `new_prev`, the
    /// new animation's pose `dt` seconds before `new_pose`.
    pub fn begin_with_target_velocity(
        &mut self,
        prev: &[SoaTransform],
        prev_prev: &[SoaTransform],
        new_pose: &[SoaTransform],
        new_prev: &[SoaTransform],
        dt: f32,
        blend_time: f32,
    ) {
        self.capture(prev, prev_prev, new_pose, Some(new_prev), dt, blend_time);
    }

    fn capture(
        &mut self,
        prev: &[SoaTransform],
        prev_prev: &[SoaTransform],
        new_pose: &[SoaTransform],
        new_prev: Option<&[SoaTransform]>,
        dt: f32,
        blend_time: f32,
    ) {
        let n = self.bones.len();
        let groups = soa_len(n);
        assert_eq!(prev.len(), groups, "SoA pose length");
        assert_eq!(prev_prev.len(), groups, "SoA pose length");
        assert_eq!(new_pose.len(), groups, "SoA pose length");
        if let Some(p) = new_prev {
            assert_eq!(p.len(), groups, "SoA pose length");
        }
        self.elapsed = 0.0;
        self.blend_time = blend_time;
        self.active = blend_time >= MIN_BLEND_TIME;
        if !self.active {
            return;
        }
        let inv_dt = if dt > 0.0 { 1.0 / dt } else { 0.0 };
        for g in 0..groups {
            let (a, b, c) = (
                prev[g].to_aos(),
                prev_prev[g].to_aos(),
                new_pose[g].to_aos(),
            );
            let d = new_prev.map(|p| p[g].to_aos());
            for l in 0..LANES {
                let i = g * LANES + l;
                if i >= n {
                    break;
                }
                self.bones[i] = capture_bone(a[l], b[l], c[l], d.map(|d| d[l]), inv_dt, blend_time);
            }
        }
    }

    /// Adds the decaying offsets to `pose` (the new animation's pose this frame), after advancing
    /// the clock by `dt` (negative counts as 0). Returns whether the transition is still
    /// running; once the clock passes the blend time the pose is left untouched (the offsets are
    /// exactly zero there) and this returns false.
    ///
    /// Panics unless `pose` has `soa_len(bone_count)` groups. Never allocates.
    pub fn apply(&mut self, dt: f32, pose: &mut [SoaTransform]) -> bool {
        let n = self.bones.len();
        assert_eq!(pose.len(), soa_len(n), "SoA pose length");
        if !self.active {
            return false;
        }
        if dt > 0.0 {
            self.elapsed += dt;
        }
        let t = self.elapsed;
        if !(t < self.blend_time) {
            self.active = false;
            return false;
        }
        for (g, group) in pose.iter_mut().enumerate() {
            let mut lanes = group.to_aos();
            for (l, lane) in lanes.iter_mut().enumerate() {
                let i = g * LANES + l;
                if i >= n {
                    break;
                }
                let b = &self.bones[i];
                let x = b.pos.eval(t);
                if x != 0.0 {
                    lane.translation = lane.translation + b.pos_dir.scale(x);
                }
                let angle = b.rot.eval(t);
                if angle != 0.0 {
                    let off = AosQuat::from_axis_angle(b.rot_axis, angle);
                    lane.rotation = (off * lane.rotation).normalize_or_identity();
                }
            }
            *group = SoaTransform::from_aos(&lanes);
        }
        true
    }
}

fn capture_bone(
    prev: AosTransform,
    prev_prev: AosTransform,
    new: AosTransform,
    new_prev: Option<AosTransform>,
    inv_dt: f32,
    blend_time: f32,
) -> BoneInertia {
    // Translation: offset and relative velocity.
    let x0 = prev.translation - new.translation;
    let v_old = (prev.translation - prev_prev.translation).scale(inv_dt);
    let v_new = new_prev.map_or(AosVec3::zero(), |p| {
        (new.translation - p.translation).scale(inv_dt)
    });
    let (pos_dir, px, pv) = decompose(x0, v_old - v_new);

    // Rotation: the offset quaternion `prev * new⁻¹` as an axis-angle vector.
    let q0 = rotation_vector(prev.rotation * new.rotation.conjugate());
    let w_old = rotation_vector(prev.rotation * prev_prev.rotation.conjugate()).scale(inv_dt);
    let w_new = new_prev.map_or(AosVec3::zero(), |p| {
        rotation_vector(new.rotation * p.rotation.conjugate()).scale(inv_dt)
    });
    let (rot_axis, rx, rv) = decompose(q0, w_old - w_new);

    BoneInertia {
        pos_dir,
        pos: Quintic::new(px, pv, 0.0, clamp_blend_time(px, pv, blend_time)),
        rot_axis,
        rot: Quintic::new(rx, rv, 0.0, clamp_blend_time(rx, rv, blend_time)),
    }
}

/// `x0` and `v0` vectors to a direction and the scalar offset and velocity along it. A zero
/// offset takes the velocity's direction (offset 0, velocity its length); both zero gives +X.
fn decompose(x0: AosVec3, v0: AosVec3) -> (AosVec3, f32, f32) {
    let len = x0.length();
    if len > EPS {
        let dir = x0.scale(1.0 / len);
        return (dir, len, v0.dot(dir));
    }
    let vlen = v0.length();
    if vlen > EPS {
        return (v0.scale(1.0 / vlen), 0.0, vlen);
    }
    (AosVec3::new(1.0, 0.0, 0.0), 0.0, 0.0)
}

/// The rotation as `axis * angle` (angle in [0, π], shortest path).
fn rotation_vector(q: AosQuat) -> AosVec3 {
    let (axis, angle) = q.to_axis_angle();
    axis.scale(angle)
}
