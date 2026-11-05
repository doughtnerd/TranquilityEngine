//! Motion easing: Foxfire's `NavEasing` (`Components/NavMotionComponents.cs`) and the per-agent update of
//! `NavMotionState` (`Systems/Jobs/NavMotionJobs.cs`: `NavMotionStep`, used by `NavMeshChunkMotion` for walkers and
//! `NavVolumeMotionJob` for flyers).
//!
//! * [`eases_in`], [`eases_out`], [`start_scale`], [`stop_distance`], [`stop_scale`]: `NavEasing`'s maths, exactly
//!   (Sine uses its own formulas; Quad/Cubic/Quart are powers 2/3/4; `StopSlack` = 0.01). Plain `f32` sin/pow: runtime
//!   steering needn't be deterministic across targets (ADR 0065).
//! * `NavMotionStep`: [`MotionPhase`] / [`phase_of`] (a journey's phase: Moving, Ended, Waiting), [`start`] (the ease
//!   in), [`apply_stop`] (the ease out) and [`journey_goal`] (a route's goal while one is followed). Walkers run them in
//!   `walkers::follow` ([`walker_motion`], `NavMeshChunkMotion.Update`); flyers in their steering (`NavVolumeMotionJob`).
//! * [`update_motion`]: the step in one call for callers that already know the phase and the distance left.
//!
//! A journey runs from rest to rest: easing in when the agent sets off after its journey ended (Ended restarts
//! `elapsed`), not after merely waiting (a repath, a route's next leg, a paused chunk: Waiting changes nothing); easing
//! out from the distance left to the journey's goal. Agents whose ease is `Constant` keep scale 1 and are skipped
//! (`ChunkIsConstant`: their state isn't written).
use crate::components::{NavChunkRoute, NavMotionState, NavPath, NavPathState, NavRoute, NavRouteState, PathElement};
use crate::settings::{NavEase, NavMeshAgent, NavMotion};
use nav_math::Float3;
use nav_query::pathfinding::NavPathStatus;
use std::f32::consts::PI;

/// `NavEasing.StopSlack`: a centimetre added to what's left, so speed never reaches zero short of the arrival distance.
const STOP_SLACK: f32 = 0.01;

/// `NavEasing.EasesIn`.
pub fn eases_in(ease: NavEase) -> bool {
    ease != NavEase::Constant && (ease as i32 - NavEase::InSine as i32) % 3 != 1
}

/// `NavEasing.EasesOut`.
pub fn eases_out(ease: NavEase) -> bool {
    ease != NavEase::Constant && (ease as i32 - NavEase::InSine as i32) % 3 != 0
}

/// `NavEasing.Power`: 1 for Sine (its own formulas), else the power of the tween's position curve: 2 Quad, 3 Cubic,
/// 4 Quart.
fn power(ease: NavEase) -> i32 {
    if ease == NavEase::Constant {
        1
    } else {
        1 + (ease as i32 - NavEase::InSine as i32) / 3
    }
}

/// `NavEasing.StartScale`: share of full speed `elapsed` seconds after setting off from rest.
pub fn start_scale(motion: &NavMotion, elapsed: f32) -> f32 {
    if !eases_in(motion.ease) || motion.ease_in_time <= 0.0 {
        return 1.0;
    }
    let u = (elapsed / motion.ease_in_time).clamp(0.0, 1.0);
    let k = power(motion.ease);
    if k == 1 {
        (0.5 * PI * u).sin()
    } else {
        u.powf((k - 1) as f32)
    }
}

/// `NavEasing.StopDistance`: how far before the stop the ease out starts slowing, at full speed `speed`.
pub fn stop_distance(motion: &NavMotion, speed: f32) -> f32 {
    if !eases_out(motion.ease) || motion.ease_out_time <= 0.0 {
        return 0.0;
    }
    let k = power(motion.ease);
    speed * motion.ease_out_time * if k == 1 { 2.0 / PI } else { 1.0 / k as f32 }
}

/// `NavEasing.StopScale`: share of full speed with `remaining` metres to the stop (past the arrival distance), at full
/// speed `speed`: the inverse of the ease out's distance-to-go over time.
pub fn stop_scale(motion: &NavMotion, speed: f32, remaining: f32) -> f32 {
    if !eases_out(motion.ease) || motion.ease_out_time <= 0.0 || speed <= 0.0 {
        return 1.0;
    }
    let x = (remaining.max(0.0) + STOP_SLACK) / (speed * motion.ease_out_time); // in units of full speed x Ease Out Time
    let k = power(motion.ease);
    if k == 1 {
        let s = 1.0 - 0.5 * PI * x;
        return if s <= 0.0 { 1.0 } else { (1.0 - s * s).sqrt() };
    }
    if x >= 1.0 / k as f32 {
        1.0
    } else {
        (k as f32 * x).powf((k as f32 - 1.0) / k as f32)
    }
}

/// `NavMotionStep.Phase`: where an agent is in its journey, for the ease in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionPhase {
    /// Following its path: `elapsed` counts up.
    Moving,
    /// At rest at the journey's end (arrived, failed, or the end of a partial path): it eases in next time.
    Ended,
    /// Between paths (a repath, a route's next leg, a take-off or landing) or paused: nothing changes.
    Waiting,
}

/// `NavMotionStep.PhaseOf`: Moving if the path is being followed, Ended if it stopped at the journey's goal (within
/// `end_slack`), else Waiting.
pub fn phase_of(state: NavPathState, next_index: i32, count: i32, loaded: bool, path_goal: Float3, journey_goal: Float3, end_slack: f32) -> MotionPhase {
    if !loaded {
        return MotionPhase::Waiting;
    }
    let following = state == NavPathState::Following || state == NavPathState::Partial;
    if following && next_index < count {
        return MotionPhase::Moving;
    }
    let stopped = state == NavPathState::Arrived || state == NavPathState::Failed || state == NavPathState::Partial;
    if stopped && path_goal.distance_sq(journey_goal) <= end_slack * end_slack {
        MotionPhase::Ended
    } else {
        MotionPhase::Waiting
    }
}

/// `NavMotionStep.Start`: Ended restarts `elapsed`, Waiting leaves it, Moving counts it up to Ease In Time. False when
/// there's nothing more to work out (not moving, or no ease out); otherwise `scale` holds the ease in and the caller
/// applies the ease out with [`apply_stop`].
pub fn start(state: &mut NavMotionState, motion: &NavMotion, phase: MotionPhase, dt: f32) -> bool {
    if phase == MotionPhase::Waiting {
        return false;
    }
    if phase == MotionPhase::Ended || motion.ease == NavEase::Constant {
        state.elapsed = 0.0;
        state.scale = 1.0;
        return false;
    }
    state.elapsed = (state.elapsed + dt).min(motion.ease_in_time);
    state.scale = start_scale(motion, state.elapsed);
    eases_out(motion.ease)
}

/// `NavMotionStep.ApplyStop`: slows `scale` for the ease out, with `remaining` metres left past the arrival distance.
pub fn apply_stop(state: &mut NavMotionState, motion: &NavMotion, speed: f32, remaining: f32) {
    state.scale = state.scale.min(stop_scale(motion, speed, remaining));
}

/// `NavMotionStep.JourneyGoal`: a walk-and-fly route's goal while it's followed, a cross-chunk route's goal while it
/// can reach it, else the path's own goal.
pub fn journey_goal(path_goal: Float3, chunk_route: Option<&NavChunkRoute>, route: Option<&NavRoute>) -> Float3 {
    if let Some(r) = route {
        if r.state == NavRouteState::Following {
            return r.goal;
        }
    }
    if let Some(c) = chunk_route {
        if c.active && c.status == NavPathStatus::Success && !c.to_edge {
            return c.goal;
        }
    }
    path_goal
}

/// The step in one call: `moving` = [`MotionPhase::Moving`], else [`MotionPhase::Ended`] (callers that are only
/// waiting don't call it: nothing changes). `remaining`: metres to the stop past the arrival distance (`f32::MAX` when
/// far from it).
pub fn update_motion(state: &mut NavMotionState, motion: &NavMotion, speed: f32, remaining: f32, moving: bool, dt: f32) {
    if motion.ease == NavEase::Constant {
        return;
    }
    let phase = if moving { MotionPhase::Moving } else { MotionPhase::Ended };
    if start(state, motion, phase, dt) && remaining < f32::MAX {
        apply_stop(state, motion, speed, remaining);
    }
}

/// `NavMeshChunkMotion.Update`: a walker's `NavMotionState` this tick, its path already advanced. `position`: its
/// contact point; `loaded`: it has a chunk entry. Constant eases are left untouched.
#[allow(clippy::too_many_arguments)]
pub fn walker_motion(
    state: &mut NavMotionState,
    agent: &NavMeshAgent,
    speed: f32,
    path: &NavPath,
    points: &[PathElement],
    chunk_route: Option<&NavChunkRoute>,
    route: Option<&NavRoute>,
    position: Float3,
    loaded: bool,
    dt: f32,
) {
    if agent.motion.ease == NavEase::Constant {
        return;
    }
    let goal = journey_goal(path.goal, chunk_route, route);
    let phase = phase_of(path.state, path.next_index, path.count, loaded, path.goal, goal, agent.arrival_distance + 0.5);
    if !start(state, &agent.motion, phase, dt) {
        return;
    }
    let stop = stop_distance(&agent.motion, speed);

    // Only near the goal is the path walked (the straight line is never longer; the path's end can be up to a snap
    // distance off its goal).
    let near = stop + agent.arrival_distance + agent.max_snap_distance;
    if position.distance_sq(goal) >= near * near {
        return;
    }
    let count = (path.count.max(0) as usize).min(points.len());
    let mut remaining = position.distance(path.next);
    // The last segment, if it's not the one it's on.
    let mut last = if path.next_index >= count as i32 - 1 { f32::MAX } else { 0.0 };
    let mut p = (path.next_index + 1).max(1) as usize;
    while p < count && remaining < near {
        last = points[p - 1].position.distance(points[p].position);
        remaining += last;
        p += 1;
    }

    // A route leg ends short of the journey's goal: the rest is about the straight line from there.
    let leg_end = path.goal.distance_sq(goal) > 1e-4 && count > 0;
    if leg_end {
        remaining += points[count - 1].position.distance(goal);
    }
    // It stops within its arrival distance of the end, but not before the waypoint ahead of the last segment: fold
    // exits and landings must actually be reached.
    let reach = if leg_end { agent.arrival_distance } else { agent.arrival_distance.min(last) };
    apply_stop(state, &agent.motion, speed, remaining - reach);
}

#[cfg(test)]
mod tests {
    //! Foxfire's `NavEasingTests` (all five).
    use super::*;

    const EASES: [NavEase; 12] = [
        NavEase::InSine,
        NavEase::OutSine,
        NavEase::InOutSine,
        NavEase::InQuad,
        NavEase::OutQuad,
        NavEase::InOutQuad,
        NavEase::InCubic,
        NavEase::OutCubic,
        NavEase::InOutCubic,
        NavEase::InQuart,
        NavEase::OutQuart,
        NavEase::InOutQuart,
    ];

    fn motion(ease: NavEase) -> NavMotion {
        NavMotion { ease, ease_in_time: 2.0, ease_out_time: 1.5 }
    }

    fn name(ease: NavEase) -> String {
        format!("{ease:?}")
    }

    #[test]
    fn in_out_and_in_out_ease_the_right_ends() {
        assert!(!eases_in(NavEase::Constant));
        assert!(!eases_out(NavEase::Constant));
        for ease in EASES {
            let n = name(ease);
            assert_eq!(!n.starts_with("Out"), eases_in(ease), "{n}");
            assert_eq!(!n.starts_with("In") || n.starts_with("InOut"), eases_out(ease), "{n}");
        }
    }

    #[test]
    fn constant_is_full_speed_throughout() {
        let m = motion(NavEase::Constant);
        assert_eq!(start_scale(&m, 0.0), 1.0);
        assert_eq!(stop_scale(&m, 5.0, 0.0), 1.0);
        assert_eq!(stop_distance(&m, 5.0), 0.0);
    }

    #[test]
    fn ease_in_rises_from_zero_to_full_speed_over_ease_in_time() {
        for ease in EASES {
            let m = motion(ease);
            if !eases_in(ease) {
                assert_eq!(start_scale(&m, 0.0), 1.0, "{ease:?} doesn't ease in");
                continue;
            }
            assert!(start_scale(&m, 0.0).abs() < 1e-6, "{ease:?} starts from rest");
            let mut last = 0.0;
            let mut t = 0.1f32;
            while t <= 2.0 {
                let scale = start_scale(&m, t);
                assert!(scale > last, "{ease:?} speeds up at {t:.1} s");
                last = scale;
                t += 0.1;
            }
            assert!((start_scale(&m, 2.0) - 1.0).abs() < 1e-5, "{ease:?} at full speed after Ease In Time");
            assert_eq!(start_scale(&m, 5.0), 1.0, "{ease:?} stays there");
        }
    }

    #[test]
    fn ease_out_slows_from_full_speed_to_a_stop_at_the_goal_in_about_ease_out_time() {
        let speed = 6.0f32;
        let dt = 1.0f32 / 240.0;
        for ease in EASES {
            if !eases_out(ease) {
                continue;
            }
            let m = motion(ease);
            let zone = stop_distance(&m, speed);
            assert!(zone > 0.0, "{ease:?} slows down somewhere");
            assert_eq!(stop_scale(&m, speed, zone + 0.1), 1.0, "{ease:?}: full speed before the zone");
            assert!((stop_scale(&m, speed, zone - 0.06) - 1.0).abs() <= 0.05, "{ease:?}: no jump in speed entering it");

            // Drive a point at the goal from the start of the zone.
            let mut remaining = zone;
            let mut time = 0.0f32;
            let mut last = 1.0f32;
            while remaining > 1e-3 && time < 10.0 {
                let scale = stop_scale(&m, speed, remaining);
                assert!(scale <= last + 1e-5, "{ease:?} never speeds up on the way in");
                last = scale;
                remaining -= (speed * scale * dt).min(remaining);
                time += dt;
            }
            assert!(remaining < 1e-3, "{ease:?} reaches the goal");
            assert!(
                time >= 0.7 * m.ease_out_time && time <= 1.02 * m.ease_out_time,
                "{ease:?} takes about Ease Out Time to stop: {time}"
            );
            assert!(last < 0.25, "{ease:?} is nearly stopped when it gets there");
        }
    }

    #[test]
    fn phase_only_a_journeys_end_restarts_the_ease_in_not_waiting_for_a_path_or_a_legs_end() {
        let goal = Float3::new(10.0, 0.0, 0.0);
        let leg_end = Float3::new(4.0, 0.0, 0.0);
        assert_eq!(phase_of(NavPathState::Following, 1, 3, true, goal, goal, 1.0), MotionPhase::Moving);
        assert_eq!(phase_of(NavPathState::Partial, 1, 3, true, goal, goal, 1.0), MotionPhase::Moving);
        assert_eq!(phase_of(NavPathState::None, 0, 0, true, goal, goal, 1.0), MotionPhase::Waiting, "waiting for a path");
        assert_eq!(phase_of(NavPathState::Following, 1, 3, false, goal, goal, 1.0), MotionPhase::Waiting, "paused");
        assert_eq!(phase_of(NavPathState::Arrived, 3, 3, true, leg_end, goal, 1.0), MotionPhase::Waiting, "a route leg's end");
        assert_eq!(phase_of(NavPathState::Arrived, 3, 3, true, goal, goal, 1.0), MotionPhase::Ended, "arrived");
        assert_eq!(phase_of(NavPathState::Failed, 0, 0, true, goal, goal, 1.0), MotionPhase::Ended, "failed");
        assert_eq!(phase_of(NavPathState::Partial, 3, 3, true, goal, goal, 1.0), MotionPhase::Ended, "the end of a partial path");

        let m = motion(NavEase::InOutQuad);
        let mut state = NavMotionState::default();
        for frame in 0..30 {
            start(&mut state, &m, if frame % 3 == 0 { MotionPhase::Waiting } else { MotionPhase::Moving }, 0.05);
        }
        assert!((state.elapsed - 1.0).abs() < 1e-4, "waiting every third frame: still eases in (20 moving frames)");
        start(&mut state, &m, MotionPhase::Ended, 0.05);
        assert_eq!(state.elapsed, 0.0, "ended: eases in again next time");
    }
}
