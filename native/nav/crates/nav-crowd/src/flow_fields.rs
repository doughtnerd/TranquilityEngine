//! Flow field maintenance (Foxfire's `NavFlowFieldSystem`, `UpdateAfter(NavRouteGraphSystem)`): one call a tick that
//! keeps a field per (flow goal, walking agent type) over every loaded navmesh and overlay of the type, rebuilt in
//! budgeted slices when its goal moves or what's loaded changes, evicted least recently wanted first over the memory
//! cap. The work is `nav_query::flow::FlowFields`; this hands it the goals (host targets with a `NavFlowGoal`), the
//! snapshot and the route graphs' seams.
//!
//! Agents following the fields (`NavFlowAgentSystem`, `NavFlowFollowing`) are `flow_agents.rs`: it marks the sets it
//! wants each tick (`FlowFields::note_wanted`), which keeps them built.
use crate::chunks::ChunkWorld;
use crate::components::target_key;
use crate::ids::TargetRef;
use crate::settings::NavigationRuntimeSettings;
use crate::world::Targets;
use nav_query::flow::{FlowFields, FlowGoal};

/// `NavFlowFieldSystem.OnUpdate`.
pub fn update_flow_fields(flow: &mut FlowFields, time: f64, targets: &Targets, world: &mut ChunkWorld, runtime: &NavigationRuntimeSettings) {
    let goals: Vec<FlowGoal> = targets
        .iter()
        .filter_map(|(id, t)| {
            t.flow_goal.map(|g| FlowGoal { id: target_key(TargetRef::Target(id)), position: t.position, move_threshold: g.move_threshold })
        })
        .collect();
    if goals.is_empty() && flow.set_count() == 0 {
        return;
    }
    world.refresh_flow_seams();
    flow.update(time, &goals, world.snapshot(), world.flow_seams(), runtime.flow_field_memory_bytes());
}
