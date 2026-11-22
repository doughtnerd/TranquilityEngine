//! The foot grounder: feet onto uneven ground from ray hits, with a pelvis offset.
//!
//! # Frame flow (ADR 0340)
//!
//! The core never casts rays. Each frame:
//!
//! 1. [`ray_requests`] writes one ray per foot from the animated pose; the host stores them and
//!    casts them (through the physics plugin's public ray API) before the next frame.
//! 2. Next frame, the host passes those hits back as [`RayHit`]s, and [`solve`] turns them into
//!    foot targets and a pelvis offset, smoothed over time in a fixed-size [`GrounderState`].
//! 3. [`apply`] moves the pelvis and runs two-bone IK on each leg (or a full-body solve takes the
//!    targets instead).
//!
//! A hit is one frame old, as in Final IK's grounder. Requests and hits are in **model space**
//! (the character's space): the host converts requests to world space with the frame's
//! character transform, and converts hits back with the transform of the frame they are used in,
//! so a moving character still reads the ground where it is now. The animation's ground plane is
//! the model-space plane through the origin perpendicular to `up`.

use crate::geom::{clamp_angle, fmax, fmin, from_to, half_life_alpha, normalize_or, DEGENERATE_SQ};
use crate::pose::{blend_rotation, RigPose};
use crate::two_bone::{two_bone, Pole, TipRotation, TwoBone, TwoBoneGoal};
use anim_math::{AosQuat, AosVec3};

/// The most feet a grounder handles (bipeds use two, quadrupeds four).
pub const MAX_FEET: usize = 4;

/// One ray for the host to cast, in model space.
#[derive(Clone, Copy, Debug)]
pub struct RayRequest {
    pub origin: AosVec3,
    /// Unit direction (`−up`).
    pub direction: AosVec3,
    /// The ray's length.
    pub length: f32,
}

/// A ray result from the host, in model space.
#[derive(Clone, Copy, Debug)]
pub struct RayHit {
    pub point: AosVec3,
    /// The unit surface normal.
    pub normal: AosVec3,
    /// Whether the ray hit anything (when false, `point` and `normal` are ignored).
    pub valid: bool,
}

impl RayHit {
    /// No hit.
    pub const MISS: RayHit = RayHit {
        point: AosVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
        normal: AosVec3 {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        },
        valid: false,
    };
}

/// Grounder settings.
#[derive(Clone, Copy, Debug)]
pub struct GrounderSettings {
    /// Model-space up (unit).
    pub up: AosVec3,
    /// How far above the foot a ray starts; also the largest step up it can see.
    pub ray_height: f32,
    /// How far below the foot a ray reaches.
    pub ray_depth: f32,
    /// The largest raise or drop of a foot from its animated height.
    pub max_step: f32,
    /// The largest foot tilt from the ground normal, radians.
    pub max_foot_angle: f32,
    /// How much of the ground tilt the feet take, in `[0, 1]`.
    pub foot_rotation_weight: f32,
    /// Half-life of foot height and tilt smoothing, seconds (0 snaps).
    pub foot_half_life: f32,
    /// Half-life of pelvis smoothing, seconds (0 snaps).
    pub pelvis_half_life: f32,
    /// The largest pelvis drop (positive distance).
    pub max_pelvis_down: f32,
    /// The largest pelvis raise (positive distance; 0 never raises).
    pub max_pelvis_up: f32,
    /// The entry weight in `[0, 1]` ([`apply`]).
    pub weight: f32,
}

impl Default for GrounderSettings {
    fn default() -> Self {
        Self {
            up: AosVec3::new(0.0, 1.0, 0.0),
            ray_height: 0.5,
            ray_depth: 0.5,
            max_step: 0.5,
            max_foot_angle: 45f32.to_radians(),
            foot_rotation_weight: 1.0,
            foot_half_life: 0.05,
            pelvis_half_life: 0.1,
            max_pelvis_down: 0.5,
            max_pelvis_up: 0.0,
            weight: 1.0,
        }
    }
}

/// One foot's smoothed state.
#[derive(Clone, Copy, Debug)]
struct FootState {
    offset: f32,
    tilt: AosQuat,
}

/// The grounder's state across frames (fixed size, no allocation).
#[derive(Clone, Copy, Debug)]
pub struct GrounderState {
    feet: [FootState; MAX_FEET],
    pelvis: f32,
    initialized: bool,
}

impl GrounderState {
    pub const fn new() -> Self {
        Self {
            feet: [FootState {
                offset: 0.0,
                tilt: AosQuat {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                    w: 1.0,
                },
            }; MAX_FEET],
            pelvis: 0.0,
            initialized: false,
        }
    }

    /// Forgets the smoothing history (after a teleport or a cut): the next solve snaps.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// The `u32` words [`write_words`](Self::write_words) fills: per foot its offset and tilt
    /// (5 words), then the pelvis offset and the initialised flag.
    pub const WORDS: usize = 5 * MAX_FEET + 2;

    /// Writes the state as [`WORDS`](Self::WORDS) words (f32 bits; the flag as 0 or 1), so it can
    /// live in a word blob that snapshots by copying. Panics when `out` is shorter.
    pub fn write_words(&self, out: &mut [u32]) {
        let mut p = crate::words::Put::new(out);
        for f in &self.feet {
            p.f(f.offset);
            p.q(f.tilt);
        }
        p.f(self.pelvis);
        p.b(self.initialized);
    }

    /// The state [`write_words`](Self::write_words) wrote, bit for bit. Panics when `words` is
    /// shorter than [`WORDS`](Self::WORDS).
    pub fn read_words(words: &[u32]) -> Self {
        let mut g = crate::words::Get::new(words);
        let mut s = Self::new();
        for f in &mut s.feet {
            f.offset = g.f();
            f.tilt = g.q();
        }
        s.pelvis = g.f();
        s.initialized = g.b();
        s
    }
}

impl Default for GrounderState {
    fn default() -> Self {
        Self::new()
    }
}

/// One foot's target from [`solve`].
#[derive(Clone, Copy, Debug)]
pub struct FootTarget {
    /// Model-space target position for the foot bone.
    pub position: AosVec3,
    /// Model-space target rotation for the foot bone (its animated rotation, tilted).
    pub rotation: AosQuat,
    /// The smoothed height change from the animated pose, along `up`.
    pub offset: f32,
}

/// The output of [`solve`].
#[derive(Clone, Copy, Debug)]
pub struct GroundTargets {
    pub feet: [FootTarget; MAX_FEET],
    /// The number of feet filled.
    pub count: usize,
    /// The smoothed pelvis offset along `up` (negative: down).
    pub pelvis_offset: f32,
}

fn check(legs: &[TwoBone]) {
    assert!(
        !legs.is_empty() && legs.len() <= MAX_FEET,
        "1 to {MAX_FEET} legs"
    );
}

/// This frame's ray per foot, written to `out[..legs.len()]`: from the animated foot position
/// raised by `ray_height` along `up`, pointing down `−up`, `ray_height + ray_depth` long. Call it
/// on the animated pose (before [`apply`]); the host casts them for the next frame's [`solve`].
pub fn ray_requests(
    pose: &mut RigPose,
    legs: &[TwoBone],
    settings: &GrounderSettings,
    out: &mut [RayRequest],
) {
    check(legs);
    assert!(out.len() >= legs.len(), "one ray request per leg");
    let up = settings.up;
    for (leg, r) in legs.iter().zip(out.iter_mut()) {
        let foot = pose.model(leg.tip as usize).translation;
        *r = RayRequest {
            origin: foot + up.scale(settings.ray_height),
            direction: -up,
            length: settings.ray_height + settings.ray_depth,
        };
    }
}

/// Foot targets and the pelvis offset from last frame's hits, smoothed into `state`.
///
/// # Maths
///
/// Per foot, from its animated model position `f` and rotation `R`:
///
/// - **Height**: a valid hit at `h` gives the raw offset `clamp(h·up, −max_step, max_step)`
///   (the ground's height above the animation's ground plane, so a lifted foot stays lifted by
///   the same amount); a miss gives 0 (the animated height).
/// - **Tilt**: `clamp_angle(from_to(up, n), max_foot_angle)` scaled by `foot_rotation_weight`
///   (identity on a miss).
/// - **Smoothing**: offset and tilt move toward the raw values by
///   `α = 1 − e^(−ln 2·dt / foot_half_life)` (critically damped first order: half the gap closes
///   per half-life, independent of frame rate); the first solve after a reset snaps.
/// - **Pelvis**: the raw offset is the lowest foot's raw offset, clamped to
///   `[−max_pelvis_down, max_pelvis_up]`, smoothed with `pelvis_half_life`. Lowering the pelvis
///   to the lowest foot lets that leg reach down; the higher leg bends.
///
/// The target is `f + up·offset` with rotation `tilt·R`. `hits` holds one entry per leg (in the
/// order of the requests).
pub fn solve(
    pose: &mut RigPose,
    legs: &[TwoBone],
    hits: &[RayHit],
    settings: &GrounderSettings,
    state: &mut GrounderState,
    dt: f32,
) -> GroundTargets {
    check(legs);
    assert!(hits.len() >= legs.len(), "one ray hit per leg");
    let up = normalize_or(settings.up, AosVec3::new(0.0, 1.0, 0.0));
    let snap = !state.initialized;
    let fa = if snap {
        1.0
    } else {
        half_life_alpha(settings.foot_half_life, dt)
    };
    let pa = if snap {
        1.0
    } else {
        half_life_alpha(settings.pelvis_half_life, dt)
    };
    let max_step = fmax(settings.max_step, 0.0);
    let mut out = GroundTargets {
        feet: [FootTarget {
            position: AosVec3::zero(),
            rotation: AosQuat::identity(),
            offset: 0.0,
        }; MAX_FEET],
        count: legs.len(),
        pelvis_offset: 0.0,
    };
    let mut lowest = f32::INFINITY;
    for (i, leg) in legs.iter().enumerate() {
        let m = pose.model(leg.tip as usize);
        let hit = &hits[i];
        let (raw, tilt) = if hit.valid {
            let h = fmin(fmax(hit.point.dot(up), -max_step), max_step);
            let n = normalize_or(hit.normal, up);
            let tilt = if n.length_squared() > DEGENERATE_SQ {
                clamp_angle(from_to(up, n), settings.max_foot_angle)
            } else {
                AosQuat::identity()
            };
            let tilt = blend_rotation(AosQuat::identity(), tilt, settings.foot_rotation_weight);
            (h, tilt)
        } else {
            (0.0, AosQuat::identity())
        };
        lowest = fmin(lowest, raw);
        let fs = &mut state.feet[i];
        fs.offset += (raw - fs.offset) * fa;
        fs.tilt = blend_rotation(fs.tilt, tilt, fa);
        out.feet[i] = FootTarget {
            position: m.translation + up.scale(fs.offset),
            rotation: (fs.tilt * m.rotation).normalize_or_identity(),
            offset: fs.offset,
        };
    }
    let pelvis_raw = fmin(
        fmax(lowest, -fmax(settings.max_pelvis_down, 0.0)),
        fmax(settings.max_pelvis_up, 0.0),
    );
    state.pelvis += (pelvis_raw - state.pelvis) * pa;
    state.initialized = true;
    out.pelvis_offset = state.pelvis;
    out
}

/// Applies grounding targets: moves `pelvis` by `up·pelvis_offset` (model space), then runs
/// [`two_bone`] on each leg toward its target, with the animated bend plane and the target foot
/// rotation; everything blended by `settings.weight`.
pub fn apply(
    pose: &mut RigPose,
    pelvis: u16,
    legs: &[TwoBone],
    targets: &GroundTargets,
    settings: &GrounderSettings,
) {
    check(legs);
    let w = settings.weight;
    if !(w > 0.0) {
        return;
    }
    let up = normalize_or(settings.up, AosVec3::new(0.0, 1.0, 0.0));
    let p = pose.model(pelvis as usize).translation;
    pose.blend_model_translation(pelvis as usize, p + up.scale(targets.pelvis_offset), w);
    for (i, leg) in legs.iter().enumerate().take(targets.count) {
        let t = &targets.feet[i];
        let goal = TwoBoneGoal {
            target: t.position,
            pole: Pole::Animated,
            tip_rotation: TipRotation::Target(t.rotation),
            soft: 0.0,
            max_stretch: 1.0,
            weight: w,
        };
        two_bone(pose, *leg, &goal);
    }
}
