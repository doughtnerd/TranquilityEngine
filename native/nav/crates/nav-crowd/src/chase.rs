//! Chasing (Foxfire's `NavChase` and the `PathGoalTarget` component).
//!
//! **Implemented:** [`start`] and [`stop`] (`NavChase.Start` / `Stop`, applied by the `Chase` / `StopChase` commands)
//! and [`chase_goal`], the target's current position.
//!
//! **To port (next wave), in the steps that read chases, not here:**
//! * `NavMeshRepathSystem` / `NavMeshRepathJob` (`walkers.rs`) and `NavVolumeRepathSystem` (`flyers.rs`): a chasing
//!   agent's goal is [`chase_goal`] (or its surround slot's point, `NavSurroundSlots.ChaseGoal`, `surround.rs`), and it
//!   repaths once the target is `repath_distance` from the goal its current path used. Group bodies chase the same way.
//! * A chase whose target is gone (a removed agent, a host target removed): Foxfire's repath jobs find no transform and
//!   leave the agent on its last path; do the same (keep the `PathGoalTarget`, request nothing) so a target that comes
//!   back (a re-registered host target) is chased again.
//! * `NavSurroundSystem` (`surround.rs`) turns the agent's `NavSurroundSlot` off once its chase ends, freeing the slot.
use crate::agents::AgentData;
use crate::components::{NavSurroundSlot, PathGoalTarget, DEFAULT_CHASE_REPATH_DISTANCE};
use crate::ids::TargetRef;
use crate::world::Targets;
use crate::agents::AgentStore;
use nav_math::Float3;

/// `NavChase.Start`: chase `target`, repathing when it has moved `repath_distance` (<= 0: the default 50) from the
/// goal the current path used. Adds the surround slot component, off, if missing (so the agent can take a slot at a
/// target with `NavSurround`). Retargeting an agent that already chases only sets the value.
pub fn start(agent: &mut AgentData, target: TargetRef, repath_distance: f32) {
    let repath_distance = if repath_distance > 0.0 { repath_distance } else { DEFAULT_CHASE_REPATH_DISTANCE };
    agent.goal_target = Some(PathGoalTarget { target, repath_distance });
    if agent.surround_slot.is_none() {
        agent.surround_slot = Some(NavSurroundSlot { target, index: 0, air: false, enabled: false });
    }
}

/// `NavChase.Stop`: the agent finishes the path it has. It keeps its surround slot component; the surround step turns
/// it off.
pub fn stop(agent: &mut AgentData) {
    agent.goal_target = None;
}

/// `NavChase.IsChasing`.
pub fn is_chasing(agent: &AgentData) -> bool {
    agent.goal_target.is_some()
}

/// Where a chasing agent's target is now; None if it isn't chasing or the target is gone.
pub fn chase_goal(agents: &AgentStore, row: usize, targets: &Targets) -> Option<Float3> {
    let chase = agents.data[row].goal_target?;
    agents.target_position(chase.target, targets)
}
