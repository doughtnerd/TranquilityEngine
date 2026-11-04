//! The crowd's foundation on real bakes: agent slots, the command queue, the chunk steps (snapshot, seams, overlays,
//! route graphs) rebuilding only on change and independent of load order, agents' chunk assignment across two bounded
//! chunks, gates, warnings, and the whole tick running with every kind of agent.
//!
//! Chunks are Foxfire's overlay pair from `NavOverlayTests` (A: x in [-40, 0], B: x in [0, 40], z in [-16, 16]; A's floor
//! stops 3 m short of the face, B's runs 6 m into A's box), so loading both builds an overlay on each side.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::boundary::{state_flags, AGENT_IN_STRIDE, AGENT_OUT_STRIDE};
use nav_crowd::commands::Command;
use nav_crowd::components::{NavAvoidanceObstacle, NavFlowGoal, NavGroup, NavSurround};
use nav_crowd::ids::{AgentId, TargetId, TargetRef};
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, CrowdSettings, NavAvoidance, NavFlightAgent, NavMeshAgent};
use nav_crowd::world::{TargetInput, WorldInput};
use nav_crowd::{Crowd, NavPathState};
use nav_format::file::BakeFile;
use nav_math::{Float3, Float4, Hash128};
use nav_query::chunks::LoadedChunk;
use std::sync::{Arc, OnceLock};

const OMIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const OMAX_A: Float3 = Float3::new(0.0, 6.0, 16.0);
const OMIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const OMAX_B: Float3 = Float3::new(40.0, 6.0, 16.0);
const CHUNK_A: Hash128 = Hash128::new(1, 10, 0, 0);
const CHUNK_B: Hash128 = Hash128::new(2, 10, 0, 0);
/// The test walker's id (`flat_profile`).
const WALKER: Hash128 = Hash128::new(1, 0, 0, 0);

/// The two bakes, made once for every test.
fn bakes() -> &'static (Arc<BakeFile>, Arc<BakeFile>) {
    static BAKES: OnceLock<(Arc<BakeFile>, Arc<BakeFile>)> = OnceLock::new();
    BAKES.get_or_init(|| {
        let mut a = TestBake::new(Some(flat_profile()));
        a.add_floor((-40.0, -16.0), (-3.0, 16.0), 0.0, &[]);
        a.set_chunk_bounds(OMIN_A, OMAX_A, 1, 2);
        a.bake();
        let mut b = TestBake::new(Some(flat_profile()));
        b.add_floor((-6.0, -16.0), (40.0, 16.0), 0.0, &[]);
        b.add_gate(v3(20.0, 0.0, 0.0), v3(4.0, 2.0, 32.0), true);
        b.set_chunk_bounds(OMIN_B, OMAX_B, 1, 2);
        b.bake();
        (Arc::new(a.out.file.clone()), Arc::new(b.out.file.clone()))
    })
}

fn chunk_a() -> LoadedChunk {
    LoadedChunk::new(CHUNK_A, bakes().0.clone())
}

fn chunk_b() -> LoadedChunk {
    LoadedChunk::new(CHUNK_B, bakes().1.clone())
}

fn walker_type() -> AgentTypeSettings {
    let walk = NavMeshAgent { radius: 0.5, height: 2.0, step_height: 0.5, pivot_offset: 0.0, max_snap_distance: 2.0, speed: 4.0, ..NavMeshAgent::default() };
    AgentTypeSettings::walker("Walker", WALKER, walk).with_avoidance(NavAvoidance::default())
}

fn crowd() -> Crowd {
    Crowd::new(CrowdSettings { agent_types: AgentTypes::new(vec![walker_type()]), label: "test".into(), ..CrowdSettings::default() })
}

fn tick(c: &mut Crowd, t: f64) {
    c.tick(1.0 / 60.0, t, &WorldInput::default());
}

fn walker_at(c: &mut Crowd, p: Float3) -> AgentId {
    c.add_agent(AgentDesc::new(WALKER, p))
}

fn move_to(c: &mut Crowd, id: AgentId, p: Float3) {
    assert!(c.write_agent_transform(id, p, Float4::new(0.0, 0.0, 0.0, 1.0), Float3::new(0.0, 1.0, 0.0)));
}

// ------------------------------------------------------------------------------------------------- slots and commands

#[test]
fn agent_slots_are_reused_with_a_new_generation() {
    let mut c = crowd();
    let a = walker_at(&mut c, v3(-20.0, 0.0, 0.0));
    let b = walker_at(&mut c, v3(-21.0, 0.0, 0.0));
    assert!(!c.is_live(a), "live from the next tick");
    tick(&mut c, 0.0);
    assert!(c.is_live(a) && c.is_live(b));
    assert_eq!((a.row(), b.row()), (0, 1));

    c.remove_agent(a);
    tick(&mut c, 0.1);
    assert!(!c.is_live(a));
    assert!(c.agent_state(a).is_none());
    let a2 = walker_at(&mut c, v3(-22.0, 0.0, 0.0));
    assert_eq!(a2.row(), a.row(), "the freed row comes back");
    assert_eq!(a2.generation(), a.generation() + 1);
    tick(&mut c, 0.2);
    assert!(c.is_live(a2) && !c.is_live(a));

    // A stale handle's commands are ignored and counted, and never reach the row's new agent.
    c.set_destination(a, v3(-10.0, 0.0, 0.0));
    c.stop(a);
    let stats = c.tick(1.0 / 60.0, 0.3, &WorldInput::default());
    assert_eq!((stats.commands.applied, stats.commands.ignored), (0, 2));
    assert!(!c.agents().data[a2.row()].path_request_enabled);
    assert_eq!(c.agents().len(), 2);
    assert_eq!(c.agents().ids(), vec![a2, b]);
}

#[test]
fn commands_apply_in_order_at_the_start_of_the_next_tick() {
    let mut c = crowd();
    let a = walker_at(&mut c, v3(-20.0, 0.0, 0.0));
    c.set_destination(a, v3(-10.0, 0.0, 5.0));
    assert_eq!(c.queued().len(), 2, "nothing runs until the tick");
    tick(&mut c, 0.0);
    let d = &c.agents().data[a.row()];
    assert!(d.path_request_enabled, "the add, then the destination: both applied in order");
    assert_eq!(d.path_request.goal, v3(-10.0, 0.0, 5.0));
    assert!(d.path_request.start_from_current_position && d.path_request.urgent);
    assert!(c.queued().is_empty());

    // Chase, then a destination in the same tick: the destination wins and the chase stops.
    let t = TargetRef::Target(TargetId(7));
    c.chase(a, t, 0.0);
    c.set_destination(a, v3(-12.0, 0.0, 0.0));
    tick(&mut c, 0.1);
    let d = &c.agents().data[a.row()];
    assert!(d.goal_target.is_none());
    assert!(d.surround_slot.is_some_and(|s| !s.enabled), "a chase adds the surround slot, off");
    // Destination, then chase: chasing, request still there; then stop clears both.
    c.set_destination(a, v3(-14.0, 0.0, 0.0));
    c.chase(a, t, 12.0);
    tick(&mut c, 0.2);
    let d = &c.agents().data[a.row()];
    assert_eq!(d.goal_target.map(|g| g.repath_distance), Some(12.0));
    assert!(c.agent_state(a).unwrap().flags & state_flags::CHASING != 0);
    c.stop(a);
    tick(&mut c, 0.3);
    let d = &c.agents().data[a.row()];
    assert!(d.goal_target.is_none() && !d.path_request_enabled);
    assert_eq!(c.agent_state(a).unwrap().path_state, NavPathState::None);

    // A warp wins over the transform the host wrote for this tick, and the agent's chunk is found again.
    move_to(&mut c, a, v3(-25.0, 0.0, 0.0));
    c.warp(a, v3(-30.0, 0.0, 3.0));
    tick(&mut c, 0.4);
    assert_eq!(c.agent_state(a).unwrap().position, v3(-30.0, 0.0, 3.0));
    let out = &c.boundary().agents_out[a.row() * AGENT_OUT_STRIDE..][..3];
    assert_eq!(out, &[-30.0, 0.0, 3.0]);
    let fed_back = &c.boundary().agents_in[a.row() * AGENT_IN_STRIDE..][..3];
    assert_eq!(fed_back, &[-30.0, 0.0, 3.0], "the input row takes what the crowd wrote");

    // Joining something that isn't a group is ignored; joining a group body works, leaving with a goal asks for a path.
    let other = walker_at(&mut c, v3(-20.0, 0.0, 4.0));
    let mut group_desc = AgentDesc::new(WALKER, v3(-20.0, 0.0, -4.0));
    group_desc.group = Some(NavGroup::default());
    let group = c.add_agent(group_desc);
    tick(&mut c, 0.5);
    c.join_group(a, other);
    let stats = c.tick(1.0 / 60.0, 0.6, &WorldInput::default());
    assert_eq!(stats.commands.ignored, 1);
    assert!(c.agents().data[group.row()].avoidance.is_none(), "group bodies don't avoid");
    c.join_group(a, group);
    tick(&mut c, 0.7);
    // Member steering takes the new member in the same tick (`NavGroupJoinJob`): its slot is assigned.
    assert!(c.agents().data[a.row()].group_member.is_some_and(|m| m.enabled && m.group == group && m.slot == 0));
    assert_eq!(c.agents().data[group.row()].group.as_deref().unwrap().members, vec![a]);
    c.leave_group(a, Some(v3(-35.0, 0.0, 0.0)));
    tick(&mut c, 0.8);
    let d = &c.agents().data[a.row()];
    assert!(d.group_member.is_some_and(|m| !m.enabled) && !d.group_joiner && d.path_request_enabled);
    assert_eq!(d.path_request.goal, v3(-35.0, 0.0, 0.0));
    // Leaving without a goal turns the request off (`NavGroups.Leave`): it stands where it is.
    c.join_group(a, group);
    tick(&mut c, 0.85);
    c.leave_group(a, None);
    tick(&mut c, 0.87);
    let d = &c.agents().data[a.row()];
    assert!(d.group_member.is_some_and(|m| !m.enabled) && !d.path_request_enabled);

    // Unknown agent types aren't added (and say why).
    let bad = c.add_agent(AgentDesc::new(Hash128::new(99, 0, 0, 0), v3(0.0, 0.0, 0.0)));
    tick(&mut c, 0.9);
    assert!(!c.is_live(bad));
    assert!(c.drain_warnings().iter().any(|w| w.contains("unknown agent type")));

    // Area costs: per agent (upserted by area) and world-wide.
    let area = Hash128::new(1, 2, 0, 0);
    c.set_area_cost(a, area, 3.0, false);
    c.set_area_cost(a, area, 5.0, true);
    c.set_world_area_cost(area, 2.0, false);
    c.push(Command::SetSpeed { agent: a, speed: 9.0, turn_speed: 0.0 });
    tick(&mut c, 1.0);
    let d = &c.agents().data[a.row()];
    assert_eq!(d.area_costs.len(), 1);
    assert!(d.area_costs[0].excluded && d.area_costs[0].cost == 5.0);
    assert_eq!(d.walk.as_ref().unwrap().speed(), 9.0);
}

// ------------------------------------------------------------------------------------------------- chunk steps

#[test]
fn loading_and_unloading_rebuilds_snapshot_seams_overlays_and_graphs_only_on_change() {
    let mut c = crowd();
    tick(&mut c, 0.0);
    assert_eq!(c.last_chunk_update().gathers, 0, "nothing loaded, nothing gathered");

    c.load_chunk(chunk_a());
    tick(&mut c, 0.1);
    let up = c.last_chunk_update();
    assert!(up.snapshot_changed && up.gathers >= 1);
    assert_eq!(up.overlays_built, 0, "no neighbour: no overlay");
    assert_eq!(c.chunks().snapshot().len(), 1);
    assert!(c.chunks().seams.seams.is_empty());
    assert!(up.graphs_rebuilt, "the first build");
    let graphs_v1 = c.chunks().graphs.version;

    c.load_chunk(chunk_b());
    tick(&mut c, 0.2);
    let up = c.last_chunk_update();
    assert_eq!(up.overlays_built, 2, "an overlay on each side of the shared face");
    assert!(up.seams_changed && up.graphs_rebuilt);
    let snap = c.chunks().snapshot();
    assert_eq!(snap.len(), 4, "two chunks, two overlays");
    assert_eq!(c.chunks().seams.seams.len(), 1);
    let seam = &c.chunks().seams.seams[0];
    assert!(seam.overlay_a && seam.overlay_b && !seam.poly_links.is_empty(), "the seam joins the overlays");
    let g = c.chunks().route_graphs(WALKER).expect("two navmeshes: route graphs");
    assert_eq!(g.graphs.len(), 4, "two navmeshes and two overlays");
    assert!(!g.links.is_empty());
    assert!(c.chunks().graphs.version > graphs_v1);
    let logs = c.drain_logs();
    assert!(logs.iter().any(|l| l.contains("route graphs rebuilt")), "{logs:?}");
    assert!(logs.iter().any(|l| l.contains("overlays: 2 built")), "{logs:?}");

    // Nothing changes: nothing is gathered, stitched, built or rebuilt.
    let (stats, version, snap_version) = (c.chunks().stats, c.chunks().graphs.version, c.chunks().snapshot_version);
    for i in 0..5 {
        tick(&mut c, 0.3 + i as f64 * 0.1);
        let up = c.last_chunk_update();
        assert_eq!((up.gathers, up.snapshot_changed, up.seams_changed, up.graphs_rebuilt, up.overlays_built), (0, false, false, false, 0));
    }
    assert_eq!(c.chunks().stats, stats);
    assert_eq!((c.chunks().graphs.version, c.chunks().snapshot_version), (version, snap_version));
    assert!(c.drain_logs().is_empty());

    // B unloads: both overlays go (A has no neighbour; B is gone), the seam goes, the graphs are rebuilt.
    assert!(c.unload_chunk(CHUNK_B));
    assert!(!c.unload_chunk(CHUNK_B));
    tick(&mut c, 1.0);
    let up = c.last_chunk_update();
    assert_eq!(up.overlays_removed, 2);
    assert!(up.seams_changed && up.graphs_rebuilt);
    assert_eq!(c.chunks().snapshot().len(), 1);
    assert!(c.chunks().seams.seams.is_empty() && c.chunks().overlays.overlays.is_empty());
    assert_eq!(c.loaded_chunks(), vec![CHUNK_A]);

    // A rebake (same id, new file) counts as a change.
    c.load_chunk(chunk_a());
    tick(&mut c, 1.1);
    assert!(c.last_chunk_update().snapshot_changed);
}

/// What the chunk steps built, in a form two crowds can compare: entries, seams, route graph signatures, overlay keys
/// and the entry signature.
type ChunkState = (Vec<(Hash128, Hash128, bool)>, Vec<(Hash128, Hash128, usize, usize)>, Vec<(Hash128, u64)>, Vec<u64>, u64);

fn chunk_state(c: &Crowd) -> ChunkState {
    let snap = c.chunks().snapshot();
    let entries = snap.entries.iter().map(|e| (e.chunk, e.agent_type, e.overlay)).collect();
    let seams = c.chunks().seams.seams.iter().map(|s| (s.chunk_a, s.chunk_b, s.poly_links.len(), s.leaf_links.len())).collect();
    let graphs = c.chunks().graphs.types().iter().map(|&t| (t, c.chunks().route_graphs(t).unwrap().signature)).collect();
    let overlays = c.chunks().overlays.overlays.iter().map(|o| o.key).collect();
    (entries, seams, graphs, overlays, c.chunks().entry_signature())
}

#[test]
fn chunk_steps_dont_depend_on_load_order() {
    let mut ab = crowd();
    ab.load_chunk(chunk_a());
    tick(&mut ab, 0.0);
    ab.load_chunk(chunk_b());
    tick(&mut ab, 0.1);

    let mut ba = crowd();
    ba.load_chunk(chunk_b());
    tick(&mut ba, 0.0);
    ba.load_chunk(chunk_a());
    tick(&mut ba, 0.1);

    let mut both = crowd();
    both.load_chunk(chunk_b());
    both.load_chunk(chunk_a());
    tick(&mut both, 0.1);

    let reference = chunk_state(&ab);
    assert_eq!(reference.0.len(), 4);
    assert_eq!(chunk_state(&ba), reference, "B then A");
    assert_eq!(chunk_state(&both), reference, "both in one tick");
}

#[test]
fn gates_patch_the_snapshot_and_refresh_the_graphs_without_a_rebuild() {
    let mut c = crowd();
    c.load_chunk(chunk_a());
    c.load_chunk(chunk_b());
    tick(&mut c, 0.0);
    let gate = Hash128::new(1, 1, 0, 0);
    let (gathers, version) = (c.chunks().stats.gathers, c.chunks().graphs.version);
    let b = c.chunks().snapshot().find(CHUNK_B, WALKER, false).unwrap();
    assert_eq!(c.chunks().snapshot().gates_of(b), &[false, false], "baked open (entry 0 unused)");

    c.set_gate(gate, false);
    tick(&mut c, 2.0);
    let up = c.last_chunk_update();
    assert!(up.gates_changed && !up.snapshot_changed && !up.graphs_rebuilt);
    assert_eq!((c.chunks().stats.gathers, c.chunks().graphs.version), (gathers, version), "no gather, no rebuild");
    let snap = c.chunks().snapshot();
    assert_eq!(snap.gates_of(b), &[false, true]);
    assert_eq!(snap.entries[b].last_gate_change, 2.0, "paths computed before now repath");
    let g = c.chunks().route_graphs(WALKER).unwrap();
    let graph = &g.graphs[g.graph_of(CHUNK_B, false) as usize];
    assert_eq!(&g.closed_gates[graph.gate_start..graph.gate_start + graph.gate_count], &[false, true]);

    // Setting it to what it is changes nothing.
    c.set_gate(gate, false);
    tick(&mut c, 3.0);
    assert!(!c.last_chunk_update().gates_changed);

    // A chunk that loads later takes the gate's current state.
    c.unload_chunk(CHUNK_B);
    tick(&mut c, 4.0);
    c.load_chunk(chunk_b());
    tick(&mut c, 5.0);
    let snap = c.chunks().snapshot();
    let b = snap.find(CHUNK_B, WALKER, false).unwrap();
    assert_eq!(snap.gates_of(b), &[false, true]);
}

// ------------------------------------------------------------------------------------------------- agent chunks

#[test]
fn agents_take_the_chunk_that_holds_them_and_keep_it_until_it_unloads() {
    let mut c = crowd();
    let early = walker_at(&mut c, v3(20.0, 0.0, 0.0)); // B isn't loaded yet
    tick(&mut c, 0.0);
    assert_eq!(c.agent_state(early).unwrap().entry, -1, "no chunk loaded: it waits");
    assert!(c.agent_state(early).unwrap().flags & state_flags::PAUSED != 0);

    c.load_chunk(chunk_a());
    tick(&mut c, 0.1);
    let s = c.agent_state(early).unwrap();
    assert_eq!(s.entry, -1, "A's box doesn't hold it: it waits for its own chunk");
    assert!(!s.chunk.is_valid());

    c.load_chunk(chunk_b());
    let in_a = walker_at(&mut c, v3(-30.0, 0.0, 0.0));
    let on_edge = walker_at(&mut c, v3(-5.0, 0.0, 0.0)); // on A's last tile (x in [-8, 0]), which its overlay replaces
    tick(&mut c, 0.2);
    let snap = c.chunks().snapshot();
    let entry = |id: AgentId, c: &Crowd| c.agent_state(id).unwrap().entry as usize;
    assert_eq!(snap.entries[entry(early, &c)].chunk, CHUNK_B, "B loaded: it has its chunk");
    assert_eq!(snap.entries[entry(in_a, &c)].chunk, CHUNK_A);
    assert!(!snap.entries[entry(in_a, &c)].overlay);
    let edge = &snap.entries[entry(on_edge, &c)];
    assert!(edge.chunk == CHUNK_A && edge.overlay, "standing on a replaced polygon: the overlay's entry");
    assert_eq!(c.last_tick().paused, 0);

    // Walking into B doesn't change its chunk: crossing is the routes' job (a leg moves the agent on).
    move_to(&mut c, in_a, v3(20.0, 0.0, 5.0));
    tick(&mut c, 0.3);
    assert_eq!(c.agent_state(in_a).unwrap().chunk, CHUNK_A);

    // A unloads: an agent standing in B's box takes B (its own chunk is gone, a loaded box holds it); the one still in
    // A's box pauses, keeping its chunk.
    c.unload_chunk(CHUNK_A);
    tick(&mut c, 0.4);
    let snap = c.chunks().snapshot();
    let moved = c.agent_state(in_a).unwrap();
    assert_eq!(moved.chunk, CHUNK_B);
    assert_eq!(snap.entries[moved.entry as usize].chunk, CHUNK_B);
    let stranded = c.agent_state(on_edge).unwrap();
    assert_eq!((stranded.chunk, stranded.entry), (CHUNK_A, -1));
    assert_eq!(c.last_tick().paused, 1);

    // A comes back: everyone re-resolves against the new entries; the stranded agent resumes on A (its overlay again).
    c.load_chunk(chunk_a());
    tick(&mut c, 0.5);
    let snap = c.chunks().snapshot();
    let back = c.agent_state(on_edge).unwrap();
    assert!(back.entry >= 0 && snap.entries[back.entry as usize].chunk == CHUNK_A);
    assert!(snap.entries[back.entry as usize].overlay);
    assert_eq!(c.agent_state(in_a).unwrap().chunk, CHUNK_B, "it keeps the chunk it took");

    // A warp finds the chunk afresh from where it lands.
    c.warp(in_a, v3(-20.0, 0.0, 0.0));
    tick(&mut c, 0.6);
    let snap = c.chunks().snapshot();
    let s = c.agent_state(in_a).unwrap();
    assert_eq!((s.chunk, snap.entries[s.entry as usize].overlay), (CHUNK_A, false));
}

#[test]
fn an_agent_type_with_nothing_baked_is_warned_about_once() {
    let ghost = Hash128::new(42, 0, 0, 0);
    let types = AgentTypes::new(vec![walker_type(), AgentTypeSettings::walker("Ghost", ghost, NavMeshAgent::default())]);
    let mut c = Crowd::new(CrowdSettings { agent_types: types, label: "w".into(), ..CrowdSettings::default() });
    c.load_chunk(chunk_a());
    c.add_agent(AgentDesc::new(ghost, v3(-10.0, 0.0, 0.0)));
    c.add_agent(AgentDesc::new(WALKER, v3(-10.0, 0.0, 0.0)));
    let mut warnings = Vec::new();
    for i in 0..360 {
        tick(&mut c, i as f64 / 60.0);
        warnings.extend(c.drain_warnings());
    }
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains("'Ghost'") && warnings[0].contains("no navmesh"), "{}", warnings[0]);
}

#[test]
fn path_warnings_are_rate_limited_per_second() {
    use nav_crowd::warnings::{NavWarning, NavWarningKind, PER_SECOND};
    let mut c = crowd();
    tick(&mut c, 0.0);
    for _ in 0..20 {
        c.warnings_mut().add(&NavWarning::new(NavWarningKind::RouteOffMesh));
    }
    assert_eq!(c.drain_warnings().len(), PER_SECOND);
    tick(&mut c, 0.5);
    assert!(c.drain_warnings().is_empty());
    tick(&mut c, 1.0);
    let held = c.drain_warnings();
    assert_eq!(held.len(), 1);
    assert!(held[0].contains("15 more path warnings"), "{}", held[0]);
}

// ------------------------------------------------------------------------------------------------- the whole tick

#[test]
fn the_tick_runs_with_every_kind_of_agent_while_chunks_stream() {
    let flyer_id = Hash128::new(100, 0, 0, 0);
    let walk_fly_id = Hash128::new(3, 0, 0, 0);
    let types = AgentTypes::new(vec![
        walker_type(),
        AgentTypeSettings::flyer("Flyer", flyer_id, NavFlightAgent { radius: 1.0, ..NavFlightAgent::default() }).with_avoidance(NavAvoidance::default()),
        AgentTypeSettings {
            id: walk_fly_id,
            name: "WalkFly".into(),
            walk: Some(Arc::new(NavMeshAgent::default())),
            flight: Some(Arc::new(NavFlightAgent::default())),
            avoidance: Some(Arc::new(NavAvoidance::default())),
            join_groups: true,
        },
    ]);
    let mut c = Crowd::new(CrowdSettings { agent_types: types, label: "stream".into(), ..CrowdSettings::default() });
    let target = TargetId(1);
    c.set_target_surround(target, Some(NavSurround::default()));
    c.set_flow_goal(target, Some(NavFlowGoal::default()));
    c.add_obstacle(NavAvoidanceObstacle { radius: 1.0, height: 2.0, layers: 1 }, v3(-15.0, 0.0, 0.0));

    let mut ids = Vec::new();
    for i in 0..30 {
        let x = -38.0 + i as f32 * 2.5;
        let kind = [WALKER, flyer_id, walk_fly_id][i % 3];
        let id = c.add_agent(AgentDesc::new(kind, v3(x, 0.0, (i % 5) as f32)));
        ids.push(id);
    }
    let mut group = AgentDesc::new(WALKER, v3(-10.0, 0.0, 10.0));
    group.group = Some(NavGroup::default());
    let group = c.add_agent(group);

    let mut t = 0.0;
    for frame in 0..300 {
        match frame {
            1 => c.load_chunk(chunk_a()),
            10 => {
                c.load_chunk(chunk_b());
                for (i, &id) in ids.iter().enumerate() {
                    match i % 4 {
                        0 => c.set_destination(id, v3(30.0, 0.0, 0.0)),
                        1 => c.chase(id, TargetRef::Target(target), 10.0),
                        2 => c.join_group(id, group),
                        _ => c.chase(id, TargetRef::Agent(ids[0]), 0.0),
                    }
                }
                c.set_destination(group, v3(25.0, 0.0, 0.0));
            }
            60 => c.set_gate(Hash128::new(1, 1, 0, 0), false),
            100 => {
                c.unload_chunk(CHUNK_A);
                c.remove_agent(ids[3]);
                c.remove_agent(ids[0]); // chased by others: their chase names a gone agent
            }
            150 => c.load_chunk(chunk_a()),
            200 => {
                c.remove_agent(group); // members name a gone group
                c.remove_target(target);
            }
            _ => {}
        }
        let targets = [TargetInput { id: target, position: v3(10.0 + (frame as f32 * 0.05).sin(), 0.0, 0.0) }];
        let stats = c.tick(1.0 / 60.0, t, &WorldInput { targets: &targets });
        assert_eq!(stats.tick, frame as u64 + 1);
        t += 1.0 / 60.0;
    }
    assert_eq!(c.agents().len(), 28, "30 agents and the group, three removed");
    assert_eq!(c.chunks().loaded_count(), 2);
    let mut with_paths = 0;
    for &id in &ids[4..] {
        let s = c.agent_state(id).expect("live");
        assert!(s.position.x.is_finite() && s.position.y.is_finite() && s.position.z.is_finite());
        let path = c.path_waypoints(id);
        let mut flat = Vec::new();
        c.path_waypoints_flat(id, &mut flat);
        assert_eq!(flat.len(), path.len() * nav_crowd::boundary::WAYPOINT_STRIDE);
        if !path.is_empty() {
            with_paths += 1;
        }
    }
    // These bakes have no flight volume, so flyers and walk-fly agents stay put; walkers sent somewhere were served
    // (the gate closed at frame 60 spans chunk B, so some of them end Failed).
    assert!(with_paths >= 3, "walkers sent somewhere have paths: {with_paths}");
    for (i, &id) in ids.iter().enumerate().skip(4) {
        let s = c.agent_state(id).unwrap();
        if i % 3 == 0 && i % 4 != 2 {
            assert_ne!(s.path_state, NavPathState::None, "walker {i} was sent somewhere and was planned for");
        }
    }
    let _ = c.drain_warnings();
    let _ = c.drain_logs();
}
