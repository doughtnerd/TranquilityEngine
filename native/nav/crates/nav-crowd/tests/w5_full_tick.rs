//! The whole runtime through `Crowd::tick` only (W5 integration): no stand-in planner or mover, every step in
//! Foxfire's order. Walkers to destinations round obstacles, a chase that repaths, a gate closing on a path, a walk-fly
//! agent over a wall, a fly-only agent across two chunks, a group in formation round a corner, a surround round a host
//! target, 30 agents on one flow field, avoidance through a doorway, chunks unloaded and reloaded mid-run, and
//! determinism (two runs give the same boundary bytes). State is read the way the host reads it: `agent_state` and the
//! boundary buffers.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::boundary::{state_flags, AGENT_OUT_STRIDE, AGENT_STATE_STRIDE};
use nav_crowd::components::{NavFlowGoal, NavFormationPreset, NavGroup, NavSurround};
use nav_crowd::ids::{AgentId, TargetId, TargetRef};
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, CrowdSettings, NavAvoidance, NavFlightAgent, NavMeshAgent, NavigationRuntimeSettings};
use nav_crowd::surround_slots;
use nav_crowd::world::{TargetInput, WorldInput};
use nav_crowd::{AgentKind, Crowd, NavMotionMode, NavPathState};
use nav_format::file::BakeFile;
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

const DT: f32 = 1.0 / 60.0;
/// The walker's id (`flat_profile`), also the walk-fly type's in its own crowd (`hybrid(.., 1, ..)`).
const WALKER: Hash128 = Hash128::new(1, 0, 0, 0);
/// The fly-only type's id (`flyer_with`).
const FLYER: Hash128 = Hash128::new(100, 0, 0, 0);
const CHUNK: Hash128 = Hash128::new(7, 10, 0, 0);
const CHUNK_A: Hash128 = Hash128::new(1, 10, 0, 0);
const CHUNK_B: Hash128 = Hash128::new(2, 10, 0, 0);
const MIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const MAX_A: Float3 = Float3::new(0.0, 16.0, 16.0);
const MIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const MAX_B: Float3 = Float3::new(40.0, 16.0, 16.0);
const TARGET: TargetId = TargetId(1);

// ------------------------------------------------------------------------------------------------- fixtures

fn walk_settings() -> NavMeshAgent {
    NavMeshAgent {
        radius: 0.5,
        height: 2.0,
        step_height: 0.5,
        pivot_offset: 0.0,
        speed: 4.0,
        max_snap_distance: 2.0,
        waypoint_reached_distance: 0.5,
        arrival_distance: 0.5,
        repath_interval: 0.0,
        off_path_distance: 1.5,
        stuck_skip_time: 1.0,
        ..NavMeshAgent::default()
    }
}

fn walker_type() -> AgentTypeSettings {
    AgentTypeSettings::walker("Walker", WALKER, walk_settings()).with_avoidance(NavAvoidance::default())
}

fn fly_settings() -> NavFlightAgent {
    NavFlightAgent {
        radius: 1.0,
        speed: 8.0,
        turn_speed: 30.0,
        waypoint_reached_distance: 1.0,
        arrival_distance: 1.0,
        max_snap_distance: 2.0,
        takeoff_speed: 8.0,
        takeoff_height: 5.0,
        repath_interval: 0.0,
        off_path_distance: 0.0,
        ..NavFlightAgent::default()
    }
}

fn walk_fly_type() -> AgentTypeSettings {
    AgentTypeSettings {
        id: WALKER,
        name: "WalkFly".into(),
        walk: Some(Arc::new(NavMeshAgent { speed: 8.0, arrival_distance: 1.0, ..walk_settings() })),
        flight: Some(Arc::new(fly_settings())),
        avoidance: None,
        join_groups: false,
    }
}

fn flyer_type() -> AgentTypeSettings {
    AgentTypeSettings::flyer("Flyer", FLYER, fly_settings())
}

fn crowd(types: Vec<AgentTypeSettings>) -> Crowd {
    Crowd::new(CrowdSettings { agent_types: AgentTypes::new(types), label: "w5".into(), ..CrowdSettings::default() })
}

fn crowd_with(types: Vec<AgentTypeSettings>, runtime: NavigationRuntimeSettings) -> Crowd {
    Crowd::new(CrowdSettings { agent_types: AgentTypes::new(types), runtime, label: "w5".into() })
}

fn once(cell: &'static OnceLock<Arc<BakeFile>>, build: impl FnOnce(&mut TestBake)) -> Arc<BakeFile> {
    cell.get_or_init(|| {
        let mut b = TestBake::new(Some(flat_profile()));
        build(&mut b);
        b.bake();
        Arc::new(b.out.file.clone())
    })
    .clone()
}

/// 40 x 40 m with four boxes.
fn obstacle_floor() -> Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    once(&B, |b| {
        b.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
        for (x, z) in [(-6.0, -6.0), (6.0, -6.0), (-6.0, 6.0), (6.0, 6.0)] {
            b.add_obstacle(v3(x, 1.0, z), v3(4.0, 2.0, 4.0), Rot::IDENTITY);
        }
    })
}

/// A wall along x = 0 with a gated gap at z in [-1, 1] and an open one at z in [7, 9] (as `w5a_walkers`).
fn gated_wall() -> Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    once(&B, |b| {
        b.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
        b.add_obstacle(v3(0.0, 1.0, -5.5), v3(0.5, 2.0, 9.0), Rot::IDENTITY);
        b.add_obstacle(v3(0.0, 1.0, 4.0), v3(0.5, 2.0, 6.0), Rot::IDENTITY);
        b.add_obstacle(v3(0.0, 1.0, 14.5), v3(0.5, 2.0, 11.0), Rot::IDENTITY);
        b.add_gate(v3(0.0, 0.0, 0.0), v3(1.5, 2.0, 2.0), true);
    })
}

/// An L-shaped corridor 8 m wide: east from x = -24 to 4 along z = 0, then north to z = 24 along x = 0.
fn corner() -> Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    once(&B, |b| {
        b.add_floor((-24.0, -4.0), (4.0, 4.0), 0.0, &[]);
        b.add_floor((-4.0, 4.0), (4.0, 24.0), 0.0, &[]);
    })
}

/// 60 x 60 m open floor.
fn big_floor() -> Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    once(&B, |b| b.add_floor((-30.0, -30.0), (30.0, 30.0), 0.0, &[]))
}

/// A wall across x = 0 with a 3 m door at z = 0.
fn doorway() -> Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    once(&B, |b| {
        b.add_floor((-12.0, -12.0), (12.0, 12.0), 0.0, &[]);
        b.add_obstacle(v3(0.0, 1.0, -6.75), v3(0.5, 2.0, 10.5), Rot::IDENTITY);
        b.add_obstacle(v3(0.0, 1.0, 6.75), v3(0.5, 2.0, 10.5), Rot::IDENTITY);
    })
}

/// Walker chunks A (x in [-40, 0]) and B (x in [0, 40]), z in [-16, 16].
fn walk_chunk(a: bool) -> LoadedChunk {
    static A: OnceLock<Arc<BakeFile>> = OnceLock::new();
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    let (cell, min, max, id) = if a { (&A, MIN_A, MAX_A, CHUNK_A) } else { (&B, MIN_B, MAX_B, CHUNK_B) };
    let file = once(cell, |b| {
        b.add_floor((min.x, -16.0), (max.x, 16.0), 0.0, &[]);
        b.add_obstacle(v3(0.5 * (min.x + max.x), 1.0, 0.0), v3(3.0, 2.0, 3.0), Rot::IDENTITY);
        b.set_chunk_bounds(min, max, 1, 2);
    });
    LoadedChunk::new(id, file)
}

/// Flyer chunks A and B (a floor and the flight volume above it).
fn fly_chunk(a: bool) -> LoadedChunk {
    static A: OnceLock<Arc<BakeFile>> = OnceLock::new();
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    let (cell, min, max, id) = if a { (&A, MIN_A, MAX_A, CHUNK_A) } else { (&B, MIN_B, MAX_B, CHUNK_B) };
    let file = cell
        .get_or_init(|| {
            let mut b = TestBake::new(None);
            b.add_floor((-40.0, -16.0), (40.0, 16.0), 0.0, &[]);
            b.add_flyer(flyer_with(1.0, 0.5, 0.0));
            b.set_chunk_bounds(min, max, 1, 2);
            b.bake();
            assert_eq!(b.out.file.volumes.len(), 1, "setup: no flight volume");
            Arc::new(b.out.file.clone())
        })
        .clone();
    LoadedChunk::new(id, file)
}

/// A 20 x 80 m floor split by a 3 m wall from z = -40 to 36, baked for the walk-fly type (as `w5b_routes`).
fn wall_scene() -> Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    B.get_or_init(|| {
        let (walker, flyer) = hybrid(1.0, 0.5, 10.0, 30.0, 1, false);
        let mut b = TestBake::new(None);
        b.add_hybrid(walker, flyer);
        b.add_floor((-10.0, -40.0), (10.0, 40.0), 0.0, &[]);
        b.add_obstacle(v3(0.0, 1.5, -2.0), v3(1.0, 3.0, 76.0), Rot::IDENTITY);
        b.bake();
        assert_eq!((b.out.file.navmeshes.len(), b.out.file.volumes.len(), b.out.file.landing_links.len()), (1, 1, 1));
        Arc::new(b.out.file.clone())
    })
    .clone()
}

// ------------------------------------------------------------------------------------------------- the host side

/// The host: ticks the crowd at 60 Hz with its targets' positions, and reads what it wrote back.
struct Host {
    c: Crowd,
    t: f64,
    targets: Vec<TargetInput>,
}

impl Host {
    fn new(c: Crowd) -> Self {
        Self { c, t: 0.0, targets: Vec::new() }
    }

    fn tick(&mut self) {
        self.t += DT as f64;
        let targets = self.targets.clone();
        self.c.tick(DT, self.t, &WorldInput { targets: &targets });
    }

    fn ticks(&mut self, n: usize) {
        for _ in 0..n {
            self.tick();
        }
    }

    /// Ticks until `done` holds (checked after each tick), at most `max`; panics with every agent's state if never.
    fn run_until(&mut self, max: usize, what: &str, mut done: impl FnMut(&Host) -> bool) -> usize {
        for i in 0..max {
            self.tick();
            if done(self) {
                return i + 1;
            }
        }
        panic!("{what}: not within {max} ticks\n{}", self.dump());
    }

    fn dump(&self) -> String {
        self.c.agents().ids().iter().map(|&id| format!("{id}: {:?}", self.c.agent_state(id))).collect::<Vec<_>>().join("\n")
    }

    fn add(&mut self, ty: Hash128, at: Float3) -> AgentId {
        self.c.add_agent(AgentDesc::new(ty, at))
    }

    fn send(&mut self, ty: Hash128, at: Float3, goal: Float3) -> AgentId {
        let id = self.add(ty, at);
        self.c.set_destination(id, goal);
        id
    }

    fn set_target(&mut self, id: TargetId, at: Float3) {
        match self.targets.iter_mut().find(|t| t.id == id) {
            Some(t) => t.position = at,
            None => self.targets.push(TargetInput { id, position: at }),
        }
    }

    /// The agent's position as the host reads it: `agents_out`, checked against `agent_state`.
    fn pos(&self, id: AgentId) -> Float3 {
        let o = &self.c.boundary().agents_out[id.row() * AGENT_OUT_STRIDE..][..3];
        let p = Float3::new(o[0], o[1], o[2]);
        assert_eq!(p, self.c.agent_state(id).expect("live").position, "agents_out and agent_state agree");
        p
    }

    /// The path state as the host reads it: the first byte of the agent's `agent_state` row.
    fn path_state(&self, id: AgentId) -> NavPathState {
        let b = self.c.boundary().agent_state[id.row() * AGENT_STATE_STRIDE];
        let s = self.c.agent_state(id).expect("live").path_state;
        assert_eq!(b, s as u8, "agent_state bytes and agent_state agree");
        s
    }

    fn flags(&self, id: AgentId) -> u8 {
        self.c.boundary().agent_state[id.row() * AGENT_STATE_STRIDE + 2]
    }

    fn arrived(&self, id: AgentId) -> bool {
        self.path_state(id) == NavPathState::Arrived
    }

    /// The boundary output the host views (positions, rotations, velocities, remaining distances; state bytes).
    fn output_bytes(&self) -> Vec<u8> {
        let b = self.c.boundary();
        let mut out: Vec<u8> = b.agents_out.iter().flat_map(|f| f.to_bits().to_le_bytes()).collect();
        out.extend_from_slice(&b.agent_state);
        out
    }
}

fn xz(p: Float3) -> Float3 {
    Float3::new(p.x, 0.0, p.z)
}

// ------------------------------------------------------------------------------------------------- walkers

#[test]
fn walkers_walk_round_obstacles_to_their_destinations_and_arrive() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(LoadedChunk::new(CHUNK, obstacle_floor()));
    let mut h = Host::new(c);
    let trips = [
        (v3(-15.0, 0.0, -15.0), v3(15.0, 0.0, 15.0)),
        (v3(15.0, 0.0, 15.0), v3(-15.0, 0.0, -15.0)),
        (v3(-15.0, 0.0, 15.0), v3(15.0, 0.0, -15.0)),
        (v3(15.0, 0.0, -15.0), v3(-15.0, 0.0, 15.0)),
        (v3(-15.0, 0.0, 0.0), v3(15.0, 0.0, 0.0)),
        (v3(0.0, 0.0, -15.0), v3(0.0, 0.0, 15.0)),
    ];
    let ids: Vec<AgentId> = trips.iter().map(|&(a, b)| h.send(WALKER, a, b)).collect();
    h.tick();
    for &id in &ids {
        assert_eq!(h.path_state(id), NavPathState::Following, "planned on the first tick");
        assert!(!h.c.path_waypoints(id).is_empty());
    }
    h.run_until(1500, "every walker arrives", |h| ids.iter().all(|&id| h.arrived(id)));
    for (&id, &(_, goal)) in ids.iter().zip(&trips) {
        let p = h.pos(id);
        assert!(xz(p).distance(goal) < 1.5, "{id} ended at {p:?}, goal {goal:?}");
        assert_eq!(h.flags(id) & state_flags::REQUEST_PENDING, 0);
    }
    // Nobody walked through a box.
    for &id in &ids {
        let p = h.pos(id);
        for (x, z) in [(-6.0, -6.0), (6.0, -6.0), (-6.0, 6.0), (6.0, 6.0)] {
            assert!((p.x - x).abs() > 2.0 || (p.z - z).abs() > 2.0, "{id} in a box at {p:?}");
        }
    }
}

#[test]
fn a_chaser_repaths_as_its_target_moves_and_catches_up() {
    let mut c = crowd_with(vec![walker_type()], NavigationRuntimeSettings { congestion_window: 0.0, ..NavigationRuntimeSettings::default() });
    c.load_chunk(LoadedChunk::new(CHUNK, big_floor()));
    let mut h = Host::new(c);
    h.set_target(TARGET, v3(10.0, 0.0, 0.0));
    let a = h.add(WALKER, v3(-20.0, 0.0, 0.0));
    h.tick();
    h.c.chase(a, TargetRef::Target(TARGET), 2.0);
    h.tick();
    assert_eq!(h.path_state(a), NavPathState::Following);
    assert_ne!(h.flags(a) & state_flags::CHASING, 0, "the chasing flag is set");
    let goal_of = |h: &Host| h.c.agents().data[a.row()].walker.as_deref().unwrap().path.goal;
    assert!(goal_of(&h).distance(v3(10.0, 0.0, 0.0)) < 1e-3);

    // The target walks north at 1 m/s; the chaser's path follows it each time it moves past 2 m.
    let mut repaths = 0;
    let mut last = goal_of(&h);
    for i in 0..600 {
        h.set_target(TARGET, v3(10.0, 0.0, i as f32 / 60.0));
        h.tick();
        if goal_of(&h) != last {
            repaths += 1;
            last = goal_of(&h);
        }
    }
    assert!(repaths >= 3, "repathed as the target moved: {repaths}");
    assert!(xz(h.pos(a)).distance(v3(10.0, 0.0, 10.0)) < 3.0, "caught up: {:?}", h.pos(a));
}

#[test]
fn a_gate_closing_on_a_walkers_path_sends_it_round_by_the_open_gap() {
    // Without avoidance: a steering walker that reaches the radius-inset corner at the wall's end a little short of
    // it heads for the goal across the wall's eroded corner, and the navmesh clip slides it back along the edge
    // (KeepOnNavmesh / MoveAlongSurface as Foxfire's); see the report. The plain mover walks its segments exactly.
    let mut c = crowd(vec![AgentTypeSettings::walker("Walker", WALKER, walk_settings())]);
    c.load_chunk(LoadedChunk::new(CHUNK, gated_wall()));
    let mut h = Host::new(c);
    let goal = v3(8.0, 0.0, 0.0);
    let a = h.send(WALKER, v3(-8.0, 0.0, 0.0), goal);
    h.ticks(2);
    assert!(h.c.path_waypoints(a).iter().all(|w| w.position.z.abs() < 2.0), "through the gate");
    h.ticks(30);
    h.c.set_gate(Hash128::new(1, 1, 0, 0), false);
    h.ticks(2);
    assert!(h.c.path_waypoints(a).iter().any(|w| w.position.z > 6.0), "round by the open gap: {:?}", h.c.path_waypoints(a));
    let mut max_z = 0.0f32;
    h.run_until(1200, "arrival round the wall", |h| {
        max_z = max_z.max(h.pos(a).z);
        h.arrived(a)
    });
    assert!(max_z > 6.0, "went by the open gap, not the closed gate: {max_z}");
    assert!(xz(h.pos(a)).distance(goal) < 1.0);
}

// ------------------------------------------------------------------------------------------------- walking and flying

#[test]
fn a_walk_fly_agent_flies_over_a_wall_and_lands_at_its_goal() {
    let mut c = crowd(vec![walk_fly_type()]);
    c.load_chunk(LoadedChunk::new(CHUNK, wall_scene()));
    let mut h = Host::new(c);
    let goal = v3(5.0, 0.0, 0.0);
    let a = h.send(WALKER, v3(-5.0, 0.0, 0.0), goal);
    let mut modes = vec![NavMotionMode::Walking];
    let mut max_y = 0.0f32;
    h.run_until(3000, "landed at the goal", |h| {
        let s = h.c.agent_state(a).unwrap();
        max_y = max_y.max(s.position.y);
        if *modes.last().unwrap() != s.mode {
            modes.push(s.mode);
        }
        s.mode == NavMotionMode::Walking && modes.len() > 1 && h.arrived(a)
    });
    use NavMotionMode::*;
    assert_eq!(modes, vec![Walking, TakingOff, Flying, Landing, Walking]);
    assert!(max_y > 3.0, "cleared the 3 m wall: {max_y}");
    let p = h.pos(a);
    assert!(xz(p).distance(goal) < 2.0 && p.y < 0.6, "on the floor at the goal: {p:?}");
    // The mode byte is what agent_state says.
    assert_eq!(h.c.boundary().agent_state[a.row() * AGENT_STATE_STRIDE + 1], Walking as u8);
}

#[test]
fn a_fly_only_agent_flies_from_one_chunk_into_the_next_and_arrives() {
    let mut c = crowd(vec![flyer_type()]);
    c.load_chunk(fly_chunk(true));
    c.load_chunk(fly_chunk(false));
    let mut h = Host::new(c);
    let goal = v3(30.0, 5.0, -3.0);
    let a = h.send(FLYER, v3(-30.0, 5.0, 2.0), goal);
    h.run_until(600, "handed over to B", |h| h.c.agent_state(a).unwrap().chunk == CHUNK_B);
    h.run_until(1500, "arrival", |h| h.arrived(a));
    assert!(h.pos(a).distance(goal) < 2.0, "{:?}", h.pos(a));
    assert_eq!(h.c.agent_state(a).unwrap().kind, AgentKind::Flyer);
}

// ------------------------------------------------------------------------------------------------- groups and surround

#[test]
fn a_group_in_formation_follows_its_body_round_a_corner_and_arrives() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(LoadedChunk::new(CHUNK, corner()));
    let mut h = Host::new(c);
    let mut d = AgentDesc::new(WALKER, v3(-18.0, 0.0, 0.0));
    d.group = Some(NavGroup { formation: NavFormationPreset::Box, spacing: 2.0, forward: v3(1.0, 0.0, 0.3), ..NavGroup::default() });
    let g = h.c.add_agent(d);
    let members: Vec<AgentId> = (0..6)
        .map(|i| {
            let m = h.add(WALKER, v3(-20.0 - (i / 3) as f32 * 2.0, 0.0, -2.0 + (i % 3) as f32 * 2.0));
            h.c.join_group(m, g);
            m
        })
        .collect();
    h.tick();
    {
        let body = &h.c.agents().data[g.row()];
        let forward = body.group.as_deref().unwrap().group.forward;
        assert!(forward.y == 0.0 && (forward.length() - 1.0).abs() < 1e-5, "InitBody levels and normalises the forward: {forward:?}");
        assert_ne!(h.flags(g) & state_flags::GROUP_BODY, 0);
    }
    let mut slots: Vec<i32> = members.iter().map(|&m| h.c.agents().data[m.row()].group_member.unwrap().slot).collect();
    slots.sort();
    assert_eq!(slots, (0..6).collect::<Vec<_>>(), "every member took a slot");
    for &m in &members {
        assert_ne!(h.flags(m) & state_flags::GROUP_MEMBER, 0);
    }
    h.ticks(60);

    let goal = v3(0.0, 0.0, 18.0);
    h.c.set_destination(g, goal);
    let mut worst_spread = 0.0f32;
    let mut turned = false;
    h.run_until(2400, "the body arrives with its members round it", |h| {
        let pivot = h.pos(g);
        turned |= pivot.z > 6.0;
        for &m in &members {
            worst_spread = worst_spread.max(xz(h.pos(m)).distance(xz(pivot)));
        }
        h.arrived(g) && members.iter().all(|&m| xz(h.pos(m)).distance(goal) < 6.0 && h.c.agent_state(m).unwrap().velocity.length() < 0.5)
    });
    assert!(turned, "the body went round the corner");
    assert!(worst_spread < 14.0, "members kept up with their body: {worst_spread}");
    // Behind the pivot (south of it, facing north) and on the floor of the north leg.
    for &m in &members {
        let p = h.pos(m);
        assert!(p.z <= goal.z + 0.75 && p.x.abs() < 4.0, "{m} at {p:?}");
    }
    let forward = h.c.agents().data[g.row()].group.as_deref().unwrap().group.forward;
    assert!(forward.z > 0.9, "the group faces north at the end: {forward:?}");
}

#[test]
fn chasers_surround_a_host_target_each_in_its_own_slot() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(LoadedChunk::new(CHUNK, big_floor()));
    let mut h = Host::new(c);
    let at = v3(5.0, 0.0, 0.0);
    let surround = NavSurround { radius: 2.0, spacing: 1.5, claim_distance: 15.0, ..NavSurround::default() };
    h.set_target(TARGET, at);
    h.c.set_target_surround(TARGET, Some(surround));
    let chasers: Vec<AgentId> = (0..8)
        .map(|i| {
            let a = h.add(WALKER, v3(-8.0 - (i % 2) as f32 * 1.5, 0.0, -6.0 + i as f32 * 1.6));
            h.c.chase(a, TargetRef::Target(TARGET), 0.0);
            a
        })
        .collect();
    let slot = |h: &Host, a: AgentId| h.c.agents().data[a.row()].surround_slot.filter(|s| s.enabled).map(|s| s.index);
    h.run_until(600, "every chaser holds a slot", |h| chasers.iter().all(|&a| slot(h, a).is_some()));
    let held: HashSet<i16> = chasers.iter().map(|&a| slot(&h, a).unwrap()).collect();
    assert_eq!(held.len(), chasers.len(), "distinct slots");
    h.run_until(1200, "everyone at their slot", |h| {
        chasers.iter().all(|&a| xz(h.pos(a)).distance(at + surround_slots::offset(&surround, false, slot(h, a).unwrap() as i32)) < 0.8)
    });
    for &a in &chasers {
        let r = xz(h.pos(a)).distance(at);
        assert!(r > 1.2, "round the target, not on it: {r}");
    }
}

// ------------------------------------------------------------------------------------------------- flow fields

#[test]
fn thirty_flow_agents_share_one_field_to_their_goal() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(LoadedChunk::new(CHUNK, big_floor()));
    let mut h = Host::new(c);
    let goal = v3(20.0, 0.0, 15.0);
    h.set_target(TARGET, goal);
    h.c.set_flow_goal(TARGET, Some(NavFlowGoal { move_threshold: 0.0 }));
    let agents: Vec<AgentId> = (0..30)
        .map(|i| {
            let a = h.add(WALKER, v3(-25.0 + (i % 6) as f32 * 1.6, 0.0, -22.0 + (i / 6) as f32 * 1.6));
            h.c.chase(a, TargetRef::Target(TARGET), 0.0);
            a
        })
        .collect();
    let mut on_field: HashSet<AgentId> = HashSet::new();
    h.run_until(3000, "all near the goal", |h| {
        for &a in &agents {
            if h.c.agents().data[a.row()].flow_agent.is_some_and(|f| f.enabled) {
                on_field.insert(a);
            }
        }
        agents.iter().all(|&a| xz(h.pos(a)).distance(goal) < 5.0)
    });
    assert_eq!(h.c.flow_fields().set_count(), 1, "one field for the goal and type");
    assert_eq!(h.c.flow_fields().stats.builds, 1, "built once for all 30");
    assert!(on_field.len() >= 25, "agents followed the field: {} of 30", on_field.len());
    // Spread out round the goal, not stacked on it.
    for i in 0..agents.len() {
        for j in i + 1..agents.len() {
            let d = xz(h.pos(agents[i])).distance(xz(h.pos(agents[j])));
            assert!(d > 0.5, "{} and {} overlap: {d}", agents[i], agents[j]);
        }
    }
}

// ------------------------------------------------------------------------------------------------- avoidance

#[test]
fn walkers_crossing_through_a_doorway_avoid_each_other_and_all_get_through() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(LoadedChunk::new(CHUNK, doorway()));
    let mut h = Host::new(c);
    let mut ids = Vec::new();
    let mut goals = Vec::new();
    for i in 0..4 {
        let z = -3.0 + i as f32 * 2.0;
        ids.push(h.send(WALKER, v3(-8.0, 0.0, z), v3(8.0, 0.0, -z)));
        goals.push(v3(8.0, 0.0, -z));
        ids.push(h.send(WALKER, v3(8.0, 0.0, z + 1.0), v3(-8.0, 0.0, -z - 1.0)));
        goals.push(v3(-8.0, 0.0, -z - 1.0));
    }
    let mut closest = f32::MAX;
    let mut steered = false;
    h.run_until(3000, "everyone through the door", |h| {
        for i in 0..ids.len() {
            steered |= h.flags(ids[i]) & state_flags::STEERING != 0;
            for j in i + 1..ids.len() {
                closest = closest.min(xz(h.pos(ids[i])).distance(xz(h.pos(ids[j]))));
            }
        }
        ids.iter().zip(&goals).all(|(&a, &g)| xz(h.pos(a)).distance(g) < 1.5)
    });
    assert!(steered, "avoidance steered them");
    assert!(closest > 0.6, "they kept apart (radii 0.5): {closest}");
    for &a in &ids {
        let p = h.pos(a);
        assert!(p.x.abs() > 1.0, "{a} isn't left in the doorway: {p:?}");
    }
}

// ------------------------------------------------------------------------------------------------- streaming

#[test]
fn a_walker_waits_while_the_next_chunk_is_unloaded_and_goes_on_when_it_loads_again() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(walk_chunk(true));
    c.load_chunk(walk_chunk(false));
    let mut h = Host::new(c);
    let goal = v3(30.0, 0.0, 4.0);
    let a = h.send(WALKER, v3(-30.0, 0.0, -4.0), goal);
    let stay = h.send(WALKER, v3(-10.0, 0.0, 8.0), v3(-35.0, 0.0, 8.0));
    h.ticks(120);
    assert!(h.pos(a).x > -30.0 + 4.0, "on its way: {:?}", h.pos(a));
    assert!(h.pos(a).x < -2.0, "still in A");

    // B goes: the walker can't go on past A, and nothing in B is left for it.
    assert!(h.c.unload_chunk(CHUNK_B));
    h.ticks(600);
    assert_eq!(h.c.loaded_chunks(), vec![CHUNK_A]);
    let p = h.pos(a);
    assert!(p.x <= 0.5 && p.x > -5.0, "waited at the edge of loaded space: {p:?}");
    let cr = h.c.agents().data[a.row()].chunk_route.as_deref().unwrap();
    assert!(cr.route.active && cr.route.to_edge, "its route runs to the edge of loaded space");
    assert_eq!(h.path_state(a), NavPathState::Arrived, "arrived at the edge: it waits there (as Foxfire)");
    assert!(h.arrived(stay), "the one inside A got where it was going regardless");

    // B comes back: on to the goal.
    h.c.load_chunk(walk_chunk(false));
    h.run_until(1800, "arrival in B", |h| h.arrived(a) && h.c.agent_state(a).unwrap().chunk == CHUNK_B);
    assert!(xz(h.pos(a)).distance(goal) < 1.5, "{:?}", h.pos(a));

    // A walker standing in a chunk that unloads is paused (its flag says so) and resumes on reload.
    let b = h.send(WALKER, v3(20.0, 0.0, -8.0), v3(35.0, 0.0, -8.0));
    h.tick();
    assert!(h.c.unload_chunk(CHUNK_B));
    h.ticks(2);
    assert_ne!(h.flags(b) & state_flags::PAUSED, 0, "paused with its chunk gone");
    let held = h.pos(b);
    h.ticks(30);
    assert_eq!(h.pos(b), held, "a paused agent stands still");
    h.c.load_chunk(walk_chunk(false));
    h.run_until(900, "resumed and arrived", |h| h.arrived(b));
}

// ------------------------------------------------------------------------------------------------- everything at once

/// A mixed run on the two walker chunks: walkers, chasers, a group, surround and flow targets, obstacles, chunk B
/// unloaded and reloaded, a gate-free world; returns a hash of the boundary output after every tick.
fn mixed_run() -> (Vec<u64>, Vec<Float3>) {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(walk_chunk(true));
    c.load_chunk(walk_chunk(false));
    c.add_obstacle(nav_crowd::components::NavAvoidanceObstacle { radius: 0.8, height: 2.0, layers: 1 }, v3(-15.0, 0.0, -6.0));
    let mut h = Host::new(c);
    let flow_target = TargetId(2);
    h.set_target(TARGET, v3(-25.0, 0.0, 8.0));
    h.set_target(flow_target, v3(25.0, 0.0, -10.0));
    h.c.set_target_surround(TARGET, Some(NavSurround { radius: 2.0, spacing: 1.5, claim_distance: 15.0, ..NavSurround::default() }));
    h.c.set_flow_goal(flow_target, Some(NavFlowGoal::default()));
    let mut ids = Vec::new();
    for i in 0..12 {
        let at = v3(-35.0 + i as f32 * 2.5, 0.0, -12.0 + (i % 4) as f32 * 2.0);
        let id = h.add(WALKER, at);
        match i % 3 {
            0 => h.c.set_destination(id, v3(30.0 - i as f32, 0.0, 10.0)),
            1 => h.c.chase(id, TargetRef::Target(TARGET), 1.0),
            _ => h.c.chase(id, TargetRef::Target(flow_target), 0.0),
        }
        ids.push(id);
    }
    let mut d = AgentDesc::new(WALKER, v3(-30.0, 0.0, 0.0));
    d.group = Some(NavGroup { spacing: 2.0, ..NavGroup::default() });
    let g = h.c.add_agent(d);
    for i in 0..4 {
        let m = h.add(WALKER, v3(-32.0 - i as f32, 0.0, 1.0));
        h.c.join_group(m, g);
        ids.push(m);
    }
    h.c.set_destination(g, v3(20.0, 0.0, 0.0));
    ids.push(g);

    let mut hashes = Vec::new();
    for frame in 0..900 {
        match frame {
            300 => assert!(h.c.unload_chunk(CHUNK_B)),
            420 => h.c.load_chunk(walk_chunk(false)),
            _ => {}
        }
        h.set_target(TARGET, v3(-25.0, 0.0, 8.0 - frame as f32 * 0.005));
        h.tick();
        hashes.push(nav_math::hash::hash_bytes(&h.output_bytes(), 0));
    }
    (hashes, ids.iter().map(|&id| h.pos(id)).collect())
}

#[test]
fn identical_runs_give_identical_boundary_output() {
    let (a, pa) = mixed_run();
    let (b, pb) = mixed_run();
    assert_eq!(a.len(), b.len());
    for (i, (x, y)) in a.iter().zip(&b).enumerate() {
        assert_eq!(x, y, "boundary output differs at tick {}", i + 1);
    }
    assert_eq!(pa, pb);
    // And the run did something: agents moved off their starts.
    assert!(pa.iter().filter(|p| p.x > -10.0).count() >= 6, "{pa:?}");
}


#[test]
fn a_group_given_a_painted_mask_stands_in_its_shape() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(LoadedChunk::new(CHUNK, big_floor()));
    let mut h = Host::new(c);
    // A 5-wide "V": row 0 (front) the centre, row 1 two either side of it, row 2 the outer two.
    let (w, rows) = (5, [0b00100u64, 0b01010, 0b10001]);
    let mut bits = 0u64;
    for (r, row) in rows.iter().enumerate() {
        bits |= row << (r * w);
    }
    let mut d = AgentDesc::new(WALKER, v3(0.0, 0.0, 0.0));
    d.group = Some(NavGroup { spacing: 2.0, forward: v3(0.0, 0.0, 1.0), ..NavGroup::default() });
    let g = h.c.add_agent(d);
    h.c.set_group_mask(g, &[bits], w as i32, 3);
    let members: Vec<AgentId> = (0..5)
        .map(|i| {
            let m = h.add(WALKER, v3(-4.0 + 2.0 * i as f32, 0.0, -8.0));
            h.c.join_group(m, g);
            m
        })
        .collect();
    h.ticks(2);
    let gd = h.c.agents().data[g.row()].group.as_deref().unwrap();
    assert_eq!(gd.group.formation, NavFormationPreset::Mask);
    assert_eq!(gd.formation.as_ref().map(|m| m.slots.len()), Some(5), "five painted cells");
    h.ticks(600);
    let gd = h.c.agents().data[g.row()].group.as_deref().unwrap();
    let mut want: Vec<(i32, i32)> = (0..5)
        .map(|i| {
            let o = nav_crowd::formations::slot(&gd.group, gd.formation.as_deref(), Float3::default(), i, 5);
            ((o.x * 2.0).round() as i32, (o.z * 2.0).round() as i32)
        })
        .collect();
    let mut got: Vec<(i32, i32)> = members.iter().map(|&m| ((h.pos(m).x * 2.0).round() as i32, (h.pos(m).z * 2.0).round() as i32)).collect();
    want.sort();
    got.sort();
    for (a, b) in want.iter().zip(&got) {
        assert!((a.0 - b.0).abs() <= 1 && (a.1 - b.1).abs() <= 1, "members stand in the painted V: want {want:?}, got {got:?}");
    }
    // A V: the front cell ahead of the others, the outer two furthest back.
    assert_eq!(got.iter().filter(|p| p.1 == got.iter().map(|q| q.1).max().unwrap()).count(), 1, "one at the front: {got:?}");
}
