//! Routes (W5b): walk-and-fly agents taking off, landing and walking short flights; walkers and fly-only agents
//! crossing between chunks along routes, waiting at the edge of loaded space, with the agent-moving cases of Foxfire's
//! `NavChunkRouteTests` and `NavHybridChunkRouteTests`, on real bakes through the whole crowd tick.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::ids::AgentId;
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, CrowdSettings, NavFlightAgent, NavMeshAgent};
use nav_crowd::world::WorldInput;
use nav_crowd::{Crowd, NavMotionMode, NavPathState};
use nav_format::file::BakeFile;
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use nav_query::route_search::NavRouteLegKind as K;
use std::sync::{Arc, OnceLock};

const CHUNK_A: Hash128 = Hash128::new(1, 10, 0, 0);
const CHUNK_B: Hash128 = Hash128::new(2, 10, 0, 0);
/// The walker's and the hybrid agent's id (`flat_profile`, `hybrid(.., 1, ..)`).
const TYPE: Hash128 = Hash128::new(1, 0, 0, 0);
/// The fly-only agent's id.
const FLYER: Hash128 = Hash128::new(100, 0, 0, 0);
const DT: f32 = 1.0 / 60.0;

const MIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const MAX_A: Float3 = Float3::new(0.0, 16.0, 16.0);
const MIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const MAX_B: Float3 = Float3::new(40.0, 16.0, 16.0);

// ------------------------------------------------------------------------------------------------- fixtures

fn walk_settings() -> NavMeshAgent {
    NavMeshAgent { radius: 0.5, height: 2.0, step_height: 0.5, pivot_offset: 0.0, max_snap_distance: 2.0, speed: 8.0, arrival_distance: 1.0, waypoint_reached_distance: 0.5, ..NavMeshAgent::default() }
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

fn walker_type() -> AgentTypeSettings {
    AgentTypeSettings::walker("Walker", TYPE, walk_settings())
}

fn hybrid_type(f: impl FnOnce(&mut NavFlightAgent)) -> AgentTypeSettings {
    let mut fl = fly_settings();
    f(&mut fl);
    AgentTypeSettings {
        id: TYPE,
        name: "Hybrid".into(),
        walk: Some(Arc::new(walk_settings())),
        flight: Some(Arc::new(fl)),
        avoidance: None,
        join_groups: false,
    }
}

fn flyer_type() -> AgentTypeSettings {
    AgentTypeSettings::flyer("Flyer", FLYER, fly_settings())
}

fn crowd(types: Vec<AgentTypeSettings>) -> Crowd {
    Crowd::new(CrowdSettings { agent_types: AgentTypes::new(types), label: "test".into(), ..CrowdSettings::default() })
}

fn file_of(b: &TestBake) -> Arc<BakeFile> {
    Arc::new(b.out.file.clone())
}

fn walk_bake(min: Float3, max: Float3, floor_min: (f32, f32), floor_max: (f32, f32)) -> Arc<BakeFile> {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor(floor_min, floor_max, 0.0, &[]);
    b.set_chunk_bounds(min, max, 1, 2);
    b.bake();
    file_of(&b)
}

fn flyer_bake(min: Float3, max: Float3) -> Arc<BakeFile> {
    let mut b = TestBake::new(None);
    b.add_floor((-40.0, -16.0), (40.0, 16.0), 0.0, &[]);
    b.add_flyer(flyer_with(1.0, 0.5, 0.0));
    b.set_chunk_bounds(min, max, 1, 2);
    b.bake();
    assert_eq!(b.out.file.volumes.len(), 1, "setup: no flight volume");
    file_of(&b)
}

/// A hybrid (id 1) Chunk Bounds bake of a floor, with a 3 m wall across x in [-2, 2] if `wall`.
fn hybrid_chunk_bake(min: Float3, max: Float3, wall: bool) -> Arc<BakeFile> {
    let (walker, flyer) = hybrid(1.0, 0.5, 10.0, 30.0, 1, false);
    let mut b = TestBake::new(None);
    b.add_hybrid(walker, flyer);
    b.add_floor((-40.0, -16.0), (40.0, 16.0), 0.0, &[]);
    if wall {
        b.add_obstacle(v3(0.0, 1.5, 0.0), v3(4.0, 3.0, 40.0), Rot::IDENTITY);
    }
    b.set_chunk_bounds(min, max, 1, 2);
    b.bake();
    assert_eq!(b.out.file.volumes.len(), 1);
    assert_eq!(b.out.file.landing_links.len(), 1);
    file_of(&b)
}

/// One unbounded hybrid chunk of a floor and obstacles (`HybridRouteTests.Scene`).
fn hybrid_scene(build: impl Fn(&mut TestBake)) -> Arc<BakeFile> {
    let (walker, flyer) = hybrid(1.0, 0.5, 10.0, 30.0, 1, false);
    let mut b = TestBake::new(None);
    b.add_hybrid(walker, flyer);
    build(&mut b);
    b.bake();
    assert_eq!(b.out.file.navmeshes.len(), 1);
    assert_eq!(b.out.file.volumes.len(), 1);
    assert_eq!(b.out.file.landing_links.len(), 1);
    file_of(&b)
}

/// 20 x 80 m floor split by a 3 m wall from z = -40 to `wall_to`; the way round is the opening beyond it.
fn wall_scene(wall_to: f32) -> Arc<BakeFile> {
    hybrid_scene(|b| {
        b.add_floor((-10.0, -40.0), (10.0, 40.0), 0.0, &[]);
        let len = wall_to + 40.0;
        b.add_obstacle(v3(0.0, 1.5, -40.0 + 0.5 * len), v3(1.0, 3.0, len), Rot::IDENTITY);
    })
}

/// Two islands (x -12..-4 and 4..12, z -4..4) with nothing between them.
fn chasm_scene() -> Arc<BakeFile> {
    hybrid_scene(|b| {
        b.add_floor((-12.0, -4.0), (-4.0, 4.0), 0.0, &[]);
        b.add_floor((4.0, -4.0), (12.0, 4.0), 0.0, &[]);
    })
}

fn chunk(id: Hash128, file: &Arc<BakeFile>) -> LoadedChunk {
    LoadedChunk::new(id, file.clone())
}

fn walk_a() -> &'static Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    B.get_or_init(|| walk_bake(MIN_A, MAX_A, (-40.0, -16.0), (0.0, 16.0)))
}
fn walk_b() -> &'static Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    B.get_or_init(|| walk_bake(MIN_B, MAX_B, (0.0, -16.0), (40.0, 16.0)))
}
fn fly_a() -> &'static Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    B.get_or_init(|| flyer_bake(MIN_A, MAX_A))
}
fn fly_b() -> &'static Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    B.get_or_init(|| flyer_bake(MIN_B, MAX_B))
}
fn wall_a() -> &'static Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    B.get_or_init(|| hybrid_chunk_bake(MIN_A, MAX_A, true))
}
fn wall_b() -> &'static Arc<BakeFile> {
    static B: OnceLock<Arc<BakeFile>> = OnceLock::new();
    B.get_or_init(|| hybrid_chunk_bake(MIN_B, MAX_B, true))
}

// ------------------------------------------------------------------------------------------------- helpers

struct Sim {
    c: Crowd,
    t: f64,
}

impl Sim {
    fn new(c: Crowd) -> Self {
        Self { c, t: 0.0 }
    }
    fn tick(&mut self) {
        self.c.tick(DT, self.t, &WorldInput::default());
        self.t += DT as f64;
    }
    /// Ticks until `done` (checked after each), at most `max` ticks; the number of ticks run, panics if never.
    fn run_until(&mut self, max: usize, what: &str, mut done: impl FnMut(&Crowd) -> bool) -> usize {
        for i in 0..max {
            self.tick();
            if done(&self.c) {
                return i + 1;
            }
        }
        panic!("{what}: not within {max} ticks; {}", self.dump());
    }
    fn dump(&self) -> String {
        self.c.agents().ids().iter().map(|&id| format!("{id}: {:?}", self.c.agent_state(id))).collect::<Vec<_>>().join("\n")
    }
    fn add(&mut self, ty: Hash128, at: Float3, goal: Float3) -> AgentId {
        let id = self.c.add_agent(AgentDesc::new(ty, at));
        self.c.set_destination(id, goal);
        id
    }
}

fn route_of(c: &Crowd, id: AgentId) -> &nav_crowd::agents::RouteData {
    c.agents().data[id.row()].route.as_deref().expect("a walk-fly agent")
}

fn chunk_route_of(c: &Crowd, id: AgentId) -> &nav_crowd::agents::ChunkRouteData {
    c.agents().data[id.row()].chunk_route.as_deref().expect("a chunk route")
}

/// The chunks a route's legs run on, in order, each once.
fn chunks_of(cr: &nav_crowd::agents::ChunkRouteData) -> Vec<Hash128> {
    let mut v: Vec<Hash128> = Vec::new();
    for l in &cr.legs {
        if v.last() != Some(&l.chunk) {
            v.push(l.chunk);
        }
    }
    v
}

fn pos(c: &Crowd, id: AgentId) -> Float3 {
    c.agent_state(id).unwrap().position
}

// ------------------------------------------------------------------------------------------------- walk and fly (one chunk)

#[test]
fn a_walk_fly_agent_takes_off_over_a_wall_when_walking_round_it_is_much_longer_and_lands_at_the_goal() {
    let file = wall_scene(36.0); // the way round is 4 m of opening at the far end
    let mut c = crowd(vec![hybrid_type(|_| {})]);
    c.load_chunk(chunk(CHUNK_A, &file));
    let mut s = Sim::new(c);
    let (start, goal) = (v3(-5.0, 0.0, 0.0), v3(5.0, 0.0, 0.0));
    let a = s.add(TYPE, start, goal);
    let mut modes = vec![NavMotionMode::Walking];
    let mut max_y = 0.0f32;
    for _ in 0..3000 {
        s.tick();
        let st = s.c.agent_state(a).unwrap();
        max_y = max_y.max(st.position.y);
        if *modes.last().unwrap() != st.mode {
            modes.push(st.mode);
        }
        if st.mode == NavMotionMode::Walking && modes.len() > 1 && st.position.distance(goal) < 2.0 {
            break;
        }
    }
    use NavMotionMode::*;
    assert_eq!(modes, vec![Walking, TakingOff, Flying, Landing, Walking], "{}", s.dump());
    assert!(max_y > 3.0, "never cleared the 3 m wall: {max_y}");
    let legs = &route_of(&s.c, a).legs;
    assert_eq!(legs.iter().map(|l| l.kind).collect::<Vec<_>>(), vec![K::Walk, K::Fly, K::Walk]);
    let p = pos(&s.c, a);
    assert!(p.distance(goal) < 2.0, "ended at {p:?}");
    assert!(p.y < 0.6, "landed on the floor: {p:?}");
}

#[test]
fn a_walk_fly_agent_walks_a_flight_that_walking_matches_within_the_walk_instead_ratio() {
    // The wall stops at z = 10: round it is about 22 m against a rise, a flight and a descent of about 25. With cheap
    // flights the search picks the flight, and WalkInsteadRatio turns it back into a walk.
    let file = wall_scene(10.0);
    let cheap = |f: &mut NavFlightAgent| {
        f.takeoff_cost = 0.0;
        f.landing_cost = 0.0;
        f.flight_cost_multiplier = 0.01;
        f.takeoff_height = 20.0;
    };
    let (start, goal) = (v3(-5.0, 0.0, 0.0), v3(5.0, 0.0, 0.0));

    let mut c = crowd(vec![hybrid_type(|f| {
        cheap(f);
        f.walk_instead_ratio = 0.0; // never walk a flight instead
    })]);
    c.load_chunk(chunk(CHUNK_A, &file));
    let mut s = Sim::new(c);
    let a = s.add(TYPE, start, goal);
    s.run_until(900, "planned", |c| route_of(c, a).route.state != nav_crowd::components::NavRouteState::None);
    let kinds: Vec<K> = route_of(&s.c, a).legs.iter().map(|l| l.kind).collect();
    assert!(kinds.contains(&K::Fly), "setup: cheap flights should fly over: {kinds:?}");

    let mut c = crowd(vec![hybrid_type(|f| {
        cheap(f);
        f.walk_instead_ratio = 1.5;
    })]);
    c.load_chunk(chunk(CHUNK_A, &file));
    let mut s = Sim::new(c);
    let a = s.add(TYPE, start, goal);
    s.run_until(900, "planned", |c| route_of(c, a).route.state != nav_crowd::components::NavRouteState::None);
    let kinds: Vec<K> = route_of(&s.c, a).legs.iter().map(|l| l.kind).collect();
    assert_eq!(kinds, vec![K::Walk], "the flight was walked instead");
    let mut max_y = 0.0f32;
    s.run_until(1500, "arrival", |c| {
        max_y = max_y.max(pos(c, a).y);
        pos(c, a).distance(goal) < 2.0
    });
    assert!(max_y < 0.6, "it flew after all: {max_y}");
    assert_eq!(s.c.agent_state(a).unwrap().mode, NavMotionMode::Walking);
}

#[test]
fn a_flyer_out_of_flight_in_the_air_lands_at_the_nearest_landing_and_stays_out_of_reach() {
    let file = chasm_scene();
    let mut c = crowd(vec![hybrid_type(|f| {
        f.max_flight_distance = 5.0; // less than the 8 m gap
        f.land_when_out_of_reach = true;
    })]);
    c.load_chunk(chunk(CHUNK_A, &file));
    let mut s = Sim::new(c);
    // Spawned in the air over island A, goal on island B: out of reach, so it lands on the nearest ground.
    let a = s.add(TYPE, v3(-8.0, 6.0, 0.0), v3(8.0, 0.0, 0.0));
    let mut modes = vec![s.c.agent_state(a).map_or(NavMotionMode::Walking, |s| s.mode)];
    for _ in 0..1500 {
        s.tick();
        let st = s.c.agent_state(a).unwrap();
        if *modes.last().unwrap() != st.mode {
            modes.push(st.mode);
        }
        if modes.contains(&NavMotionMode::Landing) && st.mode == NavMotionMode::Walking && st.position.y < 0.6 {
            break;
        }
    }
    assert!(modes.contains(&NavMotionMode::Landing), "never landed: {modes:?}\n{}", s.dump());
    for _ in 0..120 {
        s.tick();
    }
    let st = s.c.agent_state(a).unwrap();
    assert_eq!(st.mode, NavMotionMode::Walking, "{}", s.dump());
    assert!(st.position.y < 0.6, "on the ground: {:?}", st.position);
    assert!(st.position.x < -3.0, "still on island A: {:?}", st.position);
}

// ------------------------------------------------------------------------------------------------- walkers across chunks

fn two_chunks_walkers() -> Sim {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(chunk(CHUNK_A, walk_a()));
    c.load_chunk(chunk(CHUNK_B, walk_b()));
    Sim::new(c)
}

#[test]
fn a_walker_crosses_from_a_into_b_along_a_chunk_route_and_arrives() {
    let mut s = two_chunks_walkers();
    let (start, goal) = (v3(-30.0, 0.0, 2.0), v3(30.0, 0.0, -3.0));
    let a = s.add(TYPE, start, goal);
    s.run_until(30, "route planned", |c| chunk_route_of(c, a).route.active);
    {
        let cr = chunk_route_of(&s.c, a);
        // One leg per navmesh: each chunk's own and its overlay across the seam.
        assert!(cr.legs.len() >= 2, "{:?}", cr.legs);
        assert_eq!(chunks_of(cr), vec![CHUNK_A, CHUNK_B]);
        assert_eq!(cr.route.leg, 0);
        assert!(cr.legs[0].end.x < 0.01 && cr.legs[0].end.x > -12.0, "the first leg ends toward the seam: {:?}", cr.legs[0].end);
        assert_eq!(s.c.agent_state(a).unwrap().chunk, CHUNK_A);
    }
    // Over the seam it moves to B's entry, on the second leg, whose request goes to the goal.
    s.run_until(600, "handed over", |c| c.agent_state(a).unwrap().chunk == CHUNK_B);
    assert!(chunk_route_of(&s.c, a).route.leg >= 1);
    assert!(pos(&s.c, a).x > -12.0, "handed over near the seam: {:?}", pos(&s.c, a));
    s.run_until(1500, "arrival", |c| c.agent_state(a).unwrap().path_state == NavPathState::Arrived);
    assert!(pos(&s.c, a).distance(goal) < 2.0, "{:?}", pos(&s.c, a));
    assert_eq!(chunk_route_of(&s.c, a).route.leg as usize, chunk_route_of(&s.c, a).legs.len() - 1);
}

#[test]
fn walkers_apart_cross_at_different_points_and_those_with_one_key_share_the_search() {
    let mut s = two_chunks_walkers();
    let goal = v3(30.0, 0.0, 0.0);
    let a = s.add(TYPE, v3(-30.0, 0.0, -12.0), goal);
    let b = s.add(TYPE, v3(-30.0, 0.0, 12.0), goal);
    s.run_until(30, "routes planned", |c| chunk_route_of(c, a).route.active && chunk_route_of(c, b).route.active);
    let (ea, eb) = (chunk_route_of(&s.c, a).legs[0].end, chunk_route_of(&s.c, b).legs[0].end);
    assert!(ea.z < eb.z - 4.0, "crossing points {ea:?} {eb:?}");
    for id in [a, b] {
        assert_eq!(chunks_of(chunk_route_of(&s.c, id)), vec![CHUNK_A, CHUNK_B]);
    }
    s.run_until(2000, "both arrive", |c| [a, b].iter().all(|&id| c.agent_state(id).unwrap().path_state == NavPathState::Arrived));
}

#[test]
fn a_request_on_the_agents_own_navmesh_is_an_ordinary_path() {
    let mut s = two_chunks_walkers();
    let a = s.add(TYPE, v3(-30.0, 0.0, 2.0), v3(-20.0, 0.0, -3.0));
    s.run_until(600, "arrival", |c| c.agent_state(a).unwrap().path_state == NavPathState::Arrived);
    let cr = chunk_route_of(&s.c, a);
    assert!(!cr.route.active);
    assert!(cr.legs.is_empty());
    assert_eq!(s.c.agent_state(a).unwrap().chunk, CHUNK_A);
}

#[test]
fn a_walker_waits_at_the_edge_of_loaded_space_and_goes_on_when_the_next_chunk_loads() {
    let mut c = crowd(vec![walker_type()]);
    c.load_chunk(chunk(CHUNK_A, walk_a()));
    let mut s = Sim::new(c);
    let goal = v3(30.0, 0.0, -3.0); // in B's space: not loaded
    let a = s.add(TYPE, v3(-30.0, 0.0, 2.0), goal);
    s.run_until(30, "route to the edge", |c| chunk_route_of(c, a).route.active);
    {
        let cr = chunk_route_of(&s.c, a);
        assert!(cr.route.to_edge, "the goal is in unloaded space");
        assert_eq!(cr.legs.len(), 1);
        assert!(cr.legs[0].end.x > -3.0, "the edge is the face of A: {:?}", cr.legs[0].end);
    }
    s.run_until(900, "waiting at the edge", |c| c.agent_state(a).unwrap().path_state == NavPathState::Arrived);
    let waited_at = pos(&s.c, a);
    assert!(waited_at.x > -4.0 && waited_at.x < 0.5, "waits at A's edge: {waited_at:?}");
    for _ in 0..60 {
        s.tick();
    }
    assert!(pos(&s.c, a).x < 0.5, "it waits");

    // B loads: the route is planned again and the walker goes on into it.
    s.c.load_chunk(chunk(CHUNK_B, walk_b()));
    s.run_until(2500, "goes on into B", |c| {
        let st = c.agent_state(a).unwrap();
        st.chunk == CHUNK_B && st.path_state == NavPathState::Arrived && st.position.distance(goal) < 2.0
    });
    assert!(!chunk_route_of(&s.c, a).route.to_edge);
}

// ------------------------------------------------------------------------------------------------- fly-only across chunks

fn two_chunks_flyers() -> Sim {
    let mut c = crowd(vec![flyer_type()]);
    c.load_chunk(chunk(CHUNK_A, fly_a()));
    c.load_chunk(chunk(CHUNK_B, fly_b()));
    Sim::new(c)
}

#[test]
fn a_fly_only_agent_flies_from_as_volume_into_bs_along_its_route() {
    let mut s = two_chunks_flyers();
    let (start, goal) = (v3(-30.0, 5.0, 2.0), v3(30.0, 5.0, -3.0));
    let a = s.add(FLYER, start, goal);
    s.run_until(30, "route planned", |c| chunk_route_of(c, a).route.active);
    {
        let cr = chunk_route_of(&s.c, a);
        assert_eq!(cr.legs.len(), 2);
        assert_eq!((cr.legs[0].chunk, cr.legs[1].chunk), (CHUNK_A, CHUNK_B));
        assert!(cr.legs[0].end.x.abs() < 1.0, "the first leg ends on the face: {:?}", cr.legs[0].end);
        let f = s.c.agents().data[a.row()].flyer.as_ref().unwrap();
        assert!(f.path.arrival_distance > 0.0, "a leg ending on a face arrives within the crossing reach");
    }
    s.run_until(600, "handed over", |c| c.agent_state(a).unwrap().chunk == CHUNK_B);
    assert_eq!(chunk_route_of(&s.c, a).route.leg, 1);
    assert!(pos(&s.c, a).x > -4.0 && pos(&s.c, a).x < 4.0, "crossed near the face: {:?}", pos(&s.c, a));
    s.run_until(1500, "arrival", |c| c.agent_state(a).unwrap().path_state == NavPathState::Arrived);
    assert!(pos(&s.c, a).distance(goal) < 2.0, "{:?}", pos(&s.c, a));
    let cr = chunk_route_of(&s.c, a);
    assert_eq!(cr.route.leg, 1);
}

#[test]
fn fly_only_agents_with_one_goal_cell_get_the_one_search_and_all_arrive() {
    let mut s = two_chunks_flyers();
    // Goals 3.5 m apart in one 16 m cell: one key, and room for each at its own.
    let ids: Vec<AgentId> = (0..4).map(|i| s.add(FLYER, v3(-30.0, 5.0, -10.0 + 4.0 * i as f32), v3(30.0, 5.0, 0.5 + 3.5 * i as f32))).collect();
    s.run_until(60, "routes planned", |c| ids.iter().all(|&id| chunk_route_of(c, id).route.active));
    let ends: Vec<f32> = ids.iter().map(|&id| chunk_route_of(&s.c, id).legs[0].end.z).collect();
    assert!(ends.first().unwrap() < ends.last().unwrap(), "each crosses where its own way is straightest: {ends:?}");
    s.run_until(3000, "arrival", |c| ids.iter().all(|&id| c.agent_state(id).unwrap().chunk == CHUNK_B && c.agent_state(id).unwrap().path_state == NavPathState::Arrived));
}

#[test]
fn a_fly_only_agent_out_of_its_chunks_volume_takes_the_chunk_its_in() {
    let mut s = two_chunks_flyers();
    // Spawned in B's box, but assigned to A (its chunk was chosen by the box that holds it: so push it over later).
    let a = s.add(FLYER, v3(-10.0, 5.0, 0.0), v3(-20.0, 5.0, 0.0));
    s.run_until(30, "path", |c| c.agent_state(a).unwrap().chunk == CHUNK_A && c.agents().data[a.row()].flyer.as_ref().unwrap().path.state != NavPathState::None);
    // Pushed over the face by a crowd, well past the margin.
    assert!(s.c.write_agent_transform(a, v3(12.0, 5.0, 0.0), nav_math::Float4::new(0.0, 0.0, 0.0, 1.0), v3(0.0, 1.0, 0.0)));
    s.run_until(30, "takes B", |c| c.agent_state(a).unwrap().chunk == CHUNK_B);
}

#[test]
fn a_fly_only_agent_waits_at_the_edge_of_loaded_space_and_goes_on_when_the_next_chunk_loads() {
    let mut c = crowd(vec![flyer_type()]);
    c.load_chunk(chunk(CHUNK_A, fly_a()));
    let mut s = Sim::new(c);
    let goal = v3(30.0, 5.0, -3.0);
    let a = s.add(FLYER, v3(-30.0, 5.0, 2.0), goal);
    s.run_until(60, "route to the edge", |c| chunk_route_of(c, a).route.active);
    assert!(chunk_route_of(&s.c, a).route.to_edge);
    s.run_until(900, "at the edge", |c| c.agent_state(a).unwrap().path_state == NavPathState::Arrived);
    assert!(pos(&s.c, a).x < 0.5 && pos(&s.c, a).x > -4.0, "waits at A's face: {:?}", pos(&s.c, a));
    s.c.load_chunk(chunk(CHUNK_B, fly_b()));
    s.run_until(2500, "goes on into B", |c| {
        let st = c.agent_state(a).unwrap();
        st.chunk == CHUNK_B && st.position.distance(goal) < 2.0
    });
}

// ------------------------------------------------------------------------------------------------- walk and fly across chunks

#[test]
fn a_walk_fly_agent_flies_from_a_into_bs_volume_over_a_wall_across_the_face() {
    let mut c = crowd(vec![hybrid_type(|_| {})]);
    c.load_chunk(chunk(CHUNK_A, wall_a()));
    c.load_chunk(chunk(CHUNK_B, wall_b()));
    let mut s = Sim::new(c);
    let (start, goal) = (v3(-30.0, 0.0, 2.0), v3(30.0, 0.0, -3.0));
    let a = s.add(TYPE, start, goal);
    s.run_until(60, "route planned", |c| route_of(c, a).route.state == nav_crowd::components::NavRouteState::Following);
    let kinds: Vec<K> = route_of(&s.c, a).legs.iter().map(|l| l.kind).collect();
    // The flight has a leg per volume it crosses: A's, then B's.
    assert_eq!(kinds, vec![K::Walk, K::Fly, K::Fly, K::Walk], "{:?}", route_of(&s.c, a).legs);
    assert_eq!(route_of(&s.c, a).legs[1].chunk, CHUNK_A, "the flight starts on A and crosses on");
    assert_eq!(route_of(&s.c, a).legs[2].chunk, CHUNK_B);
    let mut chunks_flying = Vec::new();
    let mut max_y = 0.0f32;
    for _ in 0..4000 {
        s.tick();
        let st = s.c.agent_state(a).unwrap();
        max_y = max_y.max(st.position.y);
        if st.mode == NavMotionMode::Flying && chunks_flying.last() != Some(&st.chunk) {
            chunks_flying.push(st.chunk);
        }
        if st.chunk == CHUNK_B && st.mode == NavMotionMode::Walking && st.position.distance(goal) < 2.0 {
            break;
        }
    }
    assert!(max_y > 3.0, "never cleared the wall: {max_y}");
    assert_eq!(chunks_flying.first(), Some(&CHUNK_A));
    let st = s.c.agent_state(a).unwrap();
    assert_eq!(st.chunk, CHUNK_B, "{}", s.dump());
    assert!(st.position.distance(goal) < 2.0, "{:?}", st.position);
    assert_eq!(st.mode, NavMotionMode::Walking);
}

#[test]
fn walk_fly_agents_near_each_other_heading_for_one_goal_all_get_routes_and_arrive() {
    let file = wall_scene(36.0);
    let mut c = crowd(vec![hybrid_type(|_| {})]);
    c.load_chunk(chunk(CHUNK_A, &file));
    let mut s = Sim::new(c);
    let goal = v3(5.0, 0.0, 0.0);
    let ids: Vec<AgentId> = (0..5).map(|i| s.add(TYPE, v3(-5.0, 0.0, -1.0 + 0.5 * i as f32), goal)).collect();
    s.run_until(60, "routes", |c| ids.iter().all(|&id| route_of(c, id).route.state != nav_crowd::components::NavRouteState::None));
    for &id in &ids {
        assert!(route_of(&s.c, id).legs.iter().any(|l| l.kind == K::Fly), "{id} walks round");
    }
    s.run_until(4000, "arrival", |c| ids.iter().all(|&id| pos(c, id).distance(goal) < 3.0 && c.agent_state(id).unwrap().mode == NavMotionMode::Walking));
}
