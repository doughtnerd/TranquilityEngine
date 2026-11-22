//! Trajectory prediction (runtime; fixed size, never allocates).
//!
//! The future comes from Holden's critically damped springs ([`crate::spring`]): the ground
//! velocity, starting at the character controller's velocity and the predictor's carried
//! acceleration, is pulled toward the desired velocity with `velocity_half_life`; the facing yaw,
//! starting at the character's yaw and the carried yaw rate, is pulled toward the desired yaw
//! (the shortest way round) with `facing_half_life`. Each future sample is the closed-form state
//! `offset` seconds ahead, so a prediction doesn't depend on the frame rate.
//!
//! The past comes from a history of the character's actual frames: a ring of [`HISTORY`]
//! samples taken at least [`HISTORY_INTERVAL`] apart, interpolated linearly (yaw the short way).
//! Older than the history reaches, it clamps to the oldest sample.
//!
//! Samples are expressed in the character's current frame ([`crate::character`]): positions
//! `(x, z)` and unit facings `(x, z)`, exactly what the bake measured.

use crate::character::CharacterFrame;
use crate::spring::{spring_damper, velocity_spring, wrap_angle};
use crate::MAX_TRAJECTORY;
use anim_math::trig::sin_cos;

/// Past samples kept.
pub const HISTORY: usize = 128;
/// Seconds between kept past samples (the history spans `HISTORY · HISTORY_INTERVAL`, about 2 s).
pub const HISTORY_INTERVAL: f32 = 1.0 / 60.0;
/// The history clock is rebased by this many seconds when it passes it.
const CLOCK_REBASE: f32 = 256.0;

/// Spring half-lives, seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrajectorySettings {
    /// Default 0.3.
    pub velocity_half_life: f32,
    /// Default 0.2.
    pub facing_half_life: f32,
}

impl Default for TrajectorySettings {
    fn default() -> Self {
        Self {
            velocity_half_life: 0.3,
            facing_half_life: 0.2,
        }
    }
}

/// The character's state this frame and what the player wants.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TrajectoryInput {
    /// World ground position `(x, z)`.
    pub position: [f32; 2],
    /// World yaw (radians about +Y; 0 faces +Z).
    pub yaw: f32,
    /// The controller's ground velocity `(x, z)`, world.
    pub velocity: [f32; 2],
    /// The desired ground velocity `(x, z)`, world.
    pub desired_velocity: [f32; 2],
    /// The desired yaw.
    pub desired_yaw: f32,
}

/// Predicted (and remembered) trajectory samples in character space, one per offset.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trajectory {
    /// Samples held.
    pub count: usize,
    /// Each sample's time offset, seconds.
    pub offsets: [f32; MAX_TRAJECTORY],
    /// `(x, z)` positions.
    pub positions: [[f32; 2]; MAX_TRAJECTORY],
    /// Unit `(x, z)` facings.
    pub directions: [[f32; 2]; MAX_TRAJECTORY],
}

impl Default for Trajectory {
    fn default() -> Self {
        Self {
            count: 0,
            offsets: [0.0; MAX_TRAJECTORY],
            positions: [[0.0; 2]; MAX_TRAJECTORY],
            directions: [[0.0, 1.0]; MAX_TRAJECTORY],
        }
    }
}

impl Trajectory {
    /// The sample at `offset` (matched by its exact bits), or `None`.
    pub fn sample(&self, offset: f32) -> Option<([f32; 2], [f32; 2])> {
        (0..self.count)
            .find(|&i| self.offsets[i].to_bits() == offset.to_bits())
            .map(|i| (self.positions[i], self.directions[i]))
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Past {
    time: f32,
    position: [f32; 2],
    yaw: f32,
}

/// The predictor's state: the springs' carried acceleration and yaw rate, and the history.
#[derive(Clone, Copy, Debug)]
pub struct TrajectoryPredictor {
    acceleration: [f32; 2],
    yaw_rate: f32,
    last_velocity: [f32; 2],
    last_yaw: f32,
    started: bool,
    clock: f32,
    history: [Past; HISTORY],
    head: usize,
    len: usize,
}

impl Default for TrajectoryPredictor {
    fn default() -> Self {
        Self::new()
    }
}

impl TrajectoryPredictor {
    /// A predictor with no history and the springs at rest.
    pub fn new() -> Self {
        Self {
            acceleration: [0.0; 2],
            yaw_rate: 0.0,
            last_velocity: [0.0; 2],
            last_yaw: 0.0,
            started: false,
            clock: 0.0,
            history: [Past::default(); HISTORY],
            head: 0,
            len: 0,
        }
    }

    /// Forgets the history and the springs' state.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// Advances by `dt` seconds to this frame's `input` (call once per frame, before
    /// [`predict`](Self::predict)): carries the springs' acceleration and yaw rate from the last
    /// frame's velocity and yaw toward this frame's goals, and records the frame in the history.
    pub fn update(&mut self, dt: f32, input: &TrajectoryInput, settings: &TrajectorySettings) {
        let dt = if dt.is_finite() { dt.max(0.0) } else { 0.0 };
        if self.started {
            for k in 0..2 {
                let (_, _, a) = velocity_spring(
                    0.0,
                    self.last_velocity[k],
                    self.acceleration[k],
                    input.desired_velocity[k],
                    settings.velocity_half_life,
                    dt,
                );
                self.acceleration[k] = a;
            }
            let goal = self.last_yaw + wrap_angle(input.desired_yaw - self.last_yaw);
            let (_, w) = spring_damper(
                self.last_yaw,
                self.yaw_rate,
                goal,
                settings.facing_half_life,
                dt,
            );
            self.yaw_rate = w;
            self.clock += dt;
            // Keep the clock small so f32 time keeps its resolution over long sessions.
            if self.clock > CLOCK_REBASE {
                self.clock -= CLOCK_REBASE;
                for p in &mut self.history {
                    p.time -= CLOCK_REBASE;
                }
            }
        }
        self.started = true;
        self.last_velocity = input.velocity;
        self.last_yaw = input.yaw;
        let newest = (self.head + HISTORY - 1) % HISTORY;
        if self.len == 0 || self.clock - self.history[newest].time >= HISTORY_INTERVAL {
            self.history[self.head] = Past {
                time: self.clock,
                position: input.position,
                yaw: input.yaw,
            };
            self.head = (self.head + 1) % HISTORY;
            self.len = (self.len + 1).min(HISTORY);
        }
    }

    /// Writes the samples at `offsets` (at most [`MAX_TRAJECTORY`]; usually
    /// `MatchDb::trajectory_offsets`) into `out`, in the frame of `input` (this frame's input, as
    /// given to [`update`](Self::update)).
    pub fn predict(
        &self,
        input: &TrajectoryInput,
        settings: &TrajectorySettings,
        offsets: &[f32],
        out: &mut Trajectory,
    ) {
        let (s, c) = sin_cos(input.yaw);
        let frame = CharacterFrame {
            position: input.position,
            forward: [s, c],
        };
        let goal = input.yaw + wrap_angle(input.desired_yaw - input.yaw);
        out.count = offsets.len().min(MAX_TRAJECTORY);
        for (i, &t) in offsets.iter().take(MAX_TRAJECTORY).enumerate() {
            // `d`: the world displacement from the character's position.
            let (d, yaw) = if t > 0.0 {
                let mut p = [0.0f32; 2];
                for (k, pk) in p.iter_mut().enumerate() {
                    let (x, _, _) = velocity_spring(
                        0.0,
                        input.velocity[k],
                        self.acceleration[k],
                        input.desired_velocity[k],
                        settings.velocity_half_life,
                        t,
                    );
                    *pk = x;
                }
                let (yaw, _) =
                    spring_damper(input.yaw, self.yaw_rate, goal, settings.facing_half_life, t);
                (p, yaw)
            } else if t < 0.0 {
                let (p, yaw) = self.past(input, t);
                ([p[0] - input.position[0], p[1] - input.position[1]], yaw)
            } else {
                ([0.0; 2], input.yaw)
            };
            out.offsets[i] = t;
            out.positions[i] = frame.vector_to_local(d);
            let (rs, rc) = sin_cos(wrap_angle(yaw - input.yaw));
            out.directions[i] = [rs, rc];
        }
    }

    /// The remembered position and yaw `t` (< 0) seconds ago.
    fn past(&self, input: &TrajectoryInput, t: f32) -> ([f32; 2], f32) {
        let target = self.clock + t;
        // Walk from the newest sample back; the live input stands at `clock`.
        let mut later = Past {
            time: self.clock,
            position: input.position,
            yaw: input.yaw,
        };
        for k in 0..self.len {
            let p = self.history[(self.head + HISTORY - 1 - k) % HISTORY];
            if p.time <= target {
                let span = later.time - p.time;
                let a = if span > 0.0 {
                    (target - p.time) / span
                } else {
                    0.0
                };
                let pos = [
                    p.position[0] + (later.position[0] - p.position[0]) * a,
                    p.position[1] + (later.position[1] - p.position[1]) * a,
                ];
                let yaw = p.yaw + wrap_angle(later.yaw - p.yaw) * a;
                return (pos, yaw);
            }
            later = p;
        }
        (later.position, later.yaw)
    }
}
