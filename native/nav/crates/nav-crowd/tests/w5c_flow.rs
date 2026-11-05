//! Wave 5c: agents following flow fields: many agents share one field (one build), take their paths from it and walk to
//! the goal, switch on and off as the field comes and goes, and are handed across a seam exit to the next navmesh.
//! The fields themselves are `flow_fields.rs` / `nav-query`'s; the walking here is a test-side mover along each
//! agent's served path (see `w5c_common.rs`).
#[path = "w5c_common.rs"]
mod w5c_common;

use nav_crowd::chase;
use nav_crowd::components::{NavFlowGoal, NavPathState};
use nav_crowd::flow_agents;
use nav_crowd::ids::{TargetId, TargetRef};
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, NavAvoidance, NavMeshAgent};
use nav_crowd::world::TargetInput;
use nav_format::file::BakeFile;
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use std::sync::{Arc, OnceLock};
use w5c_common::bake_common::*;
use w5c_common::*;

const GOAL: TargetId = TargetId(1);

fn v3(x: f32, y: f32, z: f32) -> Float3 {
    Float3::new(x, y, z)
}

fn walker_types() -> AgentTypes {
    let walk = NavMeshAgent { radius: 0.5, height: 2.0, step_height: 0.5, pivot_offset: 0.0, max_snap_distance: 2.0, speed: 4.0, ..NavMeshAgent::default() };
    AgentTypes::new(vec![AgentTypeSettings::walker("Walker", WALKER, walk).with_avoidance(NavAvoidance::default())])
}

fn set_goal(sim: &mut Sim, at: Float3) {
    let t = sim.targets.entry(GOAL);
    t.position = at;
    t.flow_goal = Some(NavFlowGoal { move_threshold: 0.0 });
}

fn chase_goal(sim: &mut Sim, r: usize) {
    chase::start(&mut sim.agents.data[r], TargetRef::Target(GOAL), 0.0);
}

/// Walks an agent along its served path (the walkers' follow and move, crudely): towards the next waypoint at its
/// speed, on to the next when there, arrived at the last.
fn walk_path(sim: &mut Sim, r: usize) {
    let speed = sim.agents.data[r].walk.as_ref().unwrap().speed();
    let pos = sim.agents.position[r];
    let w = sim.agents.data[r].walker.as_deref_mut().unwrap();
    if w.path.state != NavPathState::Following || w.path.count == 0 || w.path.next_index as usize >= w.elements.len() {
        return;
    }
    let target = w.elements[w.path.next_index as usize].position;
    let to = target - pos;
    if to.length() < 0.3 {
        let n = w.path.next_index as usize;
        if n + 1 < w.path.count as usize {
            w.path.set_segment(&w.elements, n + 1);
        } else {
            w.path.state = NavPathState::Arrived;
        }
        return;
    }
    let step = to.normalize() * (speed * DT).min(to.length());
    sim.agents.position[r] = pos + step;
    sim.agents.surface[r].surface_position = pos + step;
}

fn step(sim: &mut Sim, rows: &[usize]) {
    sim.begin();
    sim.flow_update();
    for &r in rows {
        walk_path(sim, r);
    }
}

fn flat_sim(agents: usize) -> (Sim, Vec<usize>) {
    let mut sim = Sim::new(vec![floor_chunk(30.0, &[])], walker_types());
    let mut rows = Vec::new();
    for i in 0..agents {
        let (cx, cz) = ((i % 6) as f32, (i / 6) as f32);
        let r = sim.add_agent(WALKER, v3(-25.0 + cx * 1.5, 0.0, -20.0 + cz * 1.5), |_| {});
        chase_goal(&mut sim, r);
        rows.push(r);
    }
    set_goal(&mut sim, v3(20.0, 0.0, 10.0));
    (sim, rows)
}

#[test]
fn many_agents_with_one_goal_share_one_field_and_walk_it_to_the_goal() {
    let (mut sim, rows) = flat_sim(30);
    let goal = v3(20.0, 0.0, 10.0);
    let mut arrived_at = None;
    for t in 0..4000 {
        step(&mut sim, &rows);
        if rows.iter().all(|&r| (sim.agents.position[r] - goal).length() < 3.0) {
            arrived_at = Some(t);
            break;
        }
    }
    assert!(arrived_at.is_some(), "not all arrived: {:?}", rows.iter().map(|&r| sim.agents.position[r]).collect::<Vec<_>>());
    assert_eq!(sim.flow.set_count(), 1, "one set for the goal and agent type");
    assert_eq!(sim.flow.stats.builds, 1, "one build served all {} agents", rows.len());
    for &r in &rows {
        let d = &sim.agents.data[r];
        assert!(flow_agents::following(d), "agent {r} is on the field");
        let w = d.walker.as_deref().unwrap();
        let end = w.elements.last().unwrap().position;
        assert!((end - goal).length() < 2.0, "agent {r}'s path ends at the goal: {end:?}");
    }
}

#[test]
fn agents_switch_on_when_the_field_is_ready_and_off_when_it_goes() {
    let (mut sim, rows) = flat_sim(8);
    // Before the field exists they are off (and added to the chasers).
    sim.begin();
    sim.flow_update();
    for &r in &rows {
        let fa = sim.agents.data[r].flow_agent.expect("NavFlowAgent added to a chaser once a flow goal exists");
        assert!(!fa.enabled, "off while there's no field");
    }
    // The field builds (a slice a tick; this floor is small) and they turn on within a few ticks of their turns.
    for _ in 0..40 {
        step(&mut sim, &[]);
    }
    for &r in &rows {
        assert!(flow_agents::following(&sim.agents.data[r]), "agent {r} on");
        assert_eq!(sim.agents.data[r].walker.as_deref().unwrap().path.state, NavPathState::Following, "served a path from the field");
        assert!(!sim.agents.data[r].path_request_enabled, "the request was served");
    }
    let stats = sim.flow_agents.stats;
    assert!(stats.following > 0);

    // The goal stops being a flow goal: the fields go, the agents turn off and ask for a path the ordinary way.
    sim.targets.get_mut(GOAL).unwrap().flow_goal = None;
    for _ in 0..12 {
        step(&mut sim, &[]);
    }
    assert_eq!(sim.flow.set_count(), 0);
    for &r in &rows {
        let d = &sim.agents.data[r];
        assert!(!flow_agents::following(d), "agent {r} off again");
        // It asked for an ordinary path to the goal: still searching (request on), or searched already (the harness
        // runs the path requests too), its path now ending at the goal.
        let path = d.walker.as_deref().unwrap().path;
        assert!((d.path_request.goal - v3(20.0, 0.0, 10.0)).length() < 1e-4, "and asking for an ordinary path to the goal");
        assert!(d.path_request_enabled || (path.goal - v3(20.0, 0.0, 10.0)).length() < 1.0, "{:?}", path.goal);
    }
}

#[test]
fn a_moved_goal_rebuilds_the_field_and_the_agents_follow_it_there() {
    let (mut sim, rows) = flat_sim(6);
    for _ in 0..60 {
        step(&mut sim, &rows);
    }
    let first = sim.flow.set(target_key(), WALKER).unwrap().version;
    let new_goal = v3(-20.0, 0.0, 25.0);
    sim.targets.apply_input(&[TargetInput { id: GOAL, position: new_goal }]);
    let mut arrived = false;
    for _ in 0..4000 {
        step(&mut sim, &rows);
        // The chase repath (walkers) would also move the request goal; here the field's rebuild asks them.
        if rows.iter().all(|&r| (sim.agents.position[r] - new_goal).length() < 3.0) {
            arrived = true;
            break;
        }
    }
    assert!(sim.flow.set(target_key(), WALKER).unwrap().version > first, "the field was rebuilt for the new goal");
    assert!(arrived, "agents followed the rebuilt field: {:?}", rows.iter().map(|&r| sim.agents.position[r]).collect::<Vec<_>>());
}

fn target_key() -> u64 {
    nav_crowd::components::target_key(TargetRef::Target(GOAL))
}

// ------------------------------------------------------------------------------------------------- seams

const OMIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const OMAX_A: Float3 = Float3::new(0.0, 6.0, 16.0);
const OMIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const OMAX_B: Float3 = Float3::new(40.0, 6.0, 16.0);
const CHUNK_A: Hash128 = Hash128::new(1, 10, 0, 0);
const CHUNK_B: Hash128 = Hash128::new(2, 10, 0, 0);

/// The overlay pair of `NavOverlayTests` (as in `crowd.rs`): A: x in [-40, 0], B: x in [0, 40]; A's floor stops 3 m
/// short of the face, B's runs 6 m into A's box.
fn bakes() -> &'static (Arc<BakeFile>, Arc<BakeFile>) {
    static BAKES: OnceLock<(Arc<BakeFile>, Arc<BakeFile>)> = OnceLock::new();
    BAKES.get_or_init(|| {
        let mut a = TestBake::new(Some(flat_profile()));
        a.add_floor((-40.0, -16.0), (-3.0, 16.0), 0.0, &[]);
        a.set_chunk_bounds(OMIN_A, OMAX_A, 1, 2);
        a.bake();
        let mut b = TestBake::new(Some(flat_profile()));
        b.add_floor((-6.0, -16.0), (40.0, 16.0), 0.0, &[]);
        b.set_chunk_bounds(OMIN_B, OMAX_B, 1, 2);
        b.bake();
        (Arc::new(a.out.file.clone()), Arc::new(b.out.file.clone()))
    })
}

#[test]
fn an_agent_is_handed_across_a_seam_exit_and_reaches_a_goal_in_the_next_chunk() {
    let chunks = vec![LoadedChunk::new(CHUNK_A, bakes().0.clone()), LoadedChunk::new(CHUNK_B, bakes().1.clone())];
    let mut sim = Sim::new(chunks, walker_types());
    let r = sim.add_agent(WALKER, v3(-30.0, 0.0, 2.0), |_| {});
    chase_goal(&mut sim, r);
    let goal = v3(30.0, 0.0, -4.0);
    set_goal(&mut sim, goal);
    let (mut crossed, mut saw_exit, mut arrived) = (false, false, false);
    for _ in 0..5000 {
        step(&mut sim, &[r]);
        let fa = sim.agents.data[r].flow_agent.unwrap();
        saw_exit |= fa.enabled && fa.exit >= 0;
        crossed |= sim.agents.chunk[r].chunk == CHUNK_B || sim.chunks.snapshot().entries.get(sim.agents.chunk[r].entry.max(0) as usize).is_some_and(|e| e.overlay);
        if (sim.agents.position[r] - goal).length() < 3.0 {
            arrived = true;
            break;
        }
    }
    assert!(saw_exit, "its first path from the field ends at the seam (exit set)");
    assert!(crossed, "it was handed onto the navmesh across the seam");
    assert!(arrived, "and walked on to the goal: {:?}", sim.agents.position[r]);
    assert!(flow_agents::following(&sim.agents.data[r]));
}

#[test]
fn flow_following_is_deterministic() {
    let run = || {
        let (mut sim, rows) = flat_sim(12);
        for _ in 0..400 {
            step(&mut sim, &rows);
        }
        rows.iter().map(|&r| sim.agents.position[r].to_array().map(f32::to_bits)).collect::<Vec<_>>()
    };
    assert_eq!(run(), run());
}
