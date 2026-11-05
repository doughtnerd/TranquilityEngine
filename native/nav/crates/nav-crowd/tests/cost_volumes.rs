//! Runtime cost volumes (ADR 0070) in the crowd: a volume dropped on a walker's corridor re-plans it around, an
//! excluding one makes the polygons impassable, volumes for other agent types or off the corridor re-plan nobody, the
//! snapshot's tables follow chunk loads, and flyers price leaves by them.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::components::NavPathState;
use nav_crowd::ids::AgentId;
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, CrowdSettings, NavMeshAgent, NavigationRuntimeSettings};
use nav_crowd::world::WorldInput;
use nav_crowd::Crowd;
use nav_format::file::BakeFile;
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use nav_query::costs::{CostVolume, EXCLUDED};
use std::sync::Arc;

const DT: f32 = 1.0 / 60.0;
const WALKER: Hash128 = Hash128::new(1, 0, 0, 0);
const OTHER: Hash128 = Hash128::new(2, 0, 0, 0);
const CHUNK: Hash128 = Hash128::new(7, 10, 0, 0);

fn walk_settings() -> NavMeshAgent {
    NavMeshAgent {
        radius: 0.5,
        height: 2.0,
        step_height: 0.5,
        pivot_offset: 0.0,
        speed: 4.0,
        turn_speed: 5.0,
        max_snap_distance: 2.0,
        waypoint_reached_distance: 0.5,
        arrival_distance: 0.5,
        repath_interval: 0.0,
        off_path_distance: 1.5,
        stuck_skip_time: 1.0,
        ..NavMeshAgent::default()
    }
}

/// A floor split by a wall along x = 0 with gaps at z in [-1, 1] (near) and [7, 9] (far).
fn two_gaps() -> Arc<BakeFile> {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_agent(profile(false, false, false, 2));
    b.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    b.add_obstacle(v3(0.0, 1.0, -5.5), v3(0.5, 2.0, 9.0), Rot::IDENTITY);
    b.add_obstacle(v3(0.0, 1.0, 4.0), v3(0.5, 2.0, 6.0), Rot::IDENTITY);
    b.add_obstacle(v3(0.0, 1.0, 14.5), v3(0.5, 2.0, 11.0), Rot::IDENTITY);
    b.bake();
    Arc::new(b.out.file.clone())
}

struct Run {
    c: Crowd,
    t: f64,
}

impl Run {
    fn new(load: bool) -> Self {
        let types = AgentTypes::new(vec![AgentTypeSettings::walker("Walker", WALKER, walk_settings()), AgentTypeSettings::walker("Other", OTHER, walk_settings())]);
        let runtime = NavigationRuntimeSettings { congestion_window: 0.0, ..NavigationRuntimeSettings::default() };
        let mut c = Crowd::new(CrowdSettings { agent_types: types, runtime, label: "costs".into() });
        if load {
            c.load_chunk(LoadedChunk::new(CHUNK, two_gaps()));
        }
        Self { c, t: 0.0 }
    }
    fn tick(&mut self) {
        self.t += DT as f64;
        self.c.tick(DT, self.t, &WorldInput { targets: &[] });
    }
    fn ticks(&mut self, n: usize) {
        for _ in 0..n {
            self.tick();
        }
    }
    fn walker(&self, id: AgentId) -> &nav_crowd::agents::WalkerData {
        self.c.agents().data[id.row()].walker.as_deref().unwrap()
    }
    fn through_near_gap(&self, id: AgentId) -> bool {
        self.walker(id).elements.iter().all(|e| e.position.z.abs() < 2.0)
    }
    fn through_far_gap(&self, id: AgentId) -> bool {
        self.walker(id).elements.iter().any(|e| e.position.z > 6.0)
    }
}

fn near_gap_volume(cost: f32) -> CostVolume {
    CostVolume::aabb(v3(0.0, 0.0, 0.0), v3(3.0, 4.0, 3.0), cost)
}

/// A walker heading through the near gap, its path computed, a few ticks along.
fn walking(r: &mut Run, ty: Hash128) -> (AgentId, f64) {
    let a = r.c.add_agent(AgentDesc::new(ty, v3(-8.0, 0.0, 0.0)));
    r.tick();
    r.c.set_destination(a, v3(8.0, 0.0, 0.0));
    r.tick();
    assert_eq!(r.walker(a).path.state, NavPathState::Following);
    assert!(r.through_near_gap(a), "straight through the near gap: {:?}", r.walker(a).elements);
    let first = r.walker(a).path.computed_time;
    r.ticks(20);
    (a, first)
}

#[test]
fn a_costly_volume_on_the_corridor_re_plans_the_walker_around_it() {
    let mut r = Run::new(true);
    let (a, first) = walking(&mut r, WALKER);
    r.c.set_cost_volumes(vec![near_gap_volume(50.0)]);
    r.tick();
    assert!(r.c.last_chunk_update().costs_changed);
    let w = r.walker(a);
    assert!(w.path.computed_time > first, "re-planned at once");
    assert!(r.through_far_gap(a), "round by the far gap: {:?}", w.elements);
    for _ in 0..800 {
        r.tick();
        if r.c.agent_state(a).unwrap().path_state == NavPathState::Arrived {
            break;
        }
    }
    assert_eq!(r.c.agent_state(a).unwrap().path_state, NavPathState::Arrived);
}

#[test]
fn a_cheap_volume_keeps_the_short_way_and_an_excluding_one_blocks_it() {
    let mut r = Run::new(true);
    let (a, _) = walking(&mut r, WALKER);
    r.c.set_cost_volumes(vec![near_gap_volume(1.5)]);
    r.tick();
    assert!(r.through_near_gap(a), "a small multiplier isn't worth the detour");

    let mut ex = near_gap_volume(1.0);
    ex.excluded = true;
    r.c.set_cost_volumes(vec![ex]);
    r.tick();
    assert!(r.through_far_gap(a), "excluded polygons are never entered: {:?}", r.walker(a).elements);
    let snap = r.c.chunks().snapshot();
    let e = snap.find(CHUNK, WALKER, false).unwrap();
    assert!(snap.poly_costs_of(e).contains(&EXCLUDED));
}

#[test]
fn volumes_for_other_agent_types_or_off_the_corridor_re_plan_nobody() {
    let mut r = Run::new(true);
    let (a, first) = walking(&mut r, WALKER);

    let mut other = near_gap_volume(50.0);
    other.agents = vec![OTHER];
    r.c.set_cost_volumes(vec![other.clone()]);
    r.tick();
    assert!(r.c.last_chunk_update().costs_changed, "the other type's entry changed");
    assert_eq!(r.walker(a).path.computed_time, first, "not this type's volume");

    // (Per polygon: a box over the far gap would also hold the centre of a big floor polygon the corridor crosses.)
    let far = CostVolume::aabb(v3(14.0, 0.0, -14.0), v3(6.0, 4.0, 6.0), 50.0);
    r.c.set_cost_volumes(vec![other, far]);
    r.tick();
    assert!(r.c.last_chunk_update().costs_changed);
    assert_eq!(r.walker(a).path.computed_time, first, "off its corridor");

    // The other type's walker does go round.
    let mut r = Run::new(true);
    let (b, _) = walking(&mut r, OTHER);
    let mut v = near_gap_volume(50.0);
    v.agents = vec![OTHER];
    r.c.set_cost_volumes(vec![v]);
    r.tick();
    assert!(r.through_far_gap(b));
}

#[test]
fn setting_the_same_volumes_again_changes_nothing() {
    let mut r = Run::new(true);
    r.tick();
    r.c.set_cost_volumes(vec![near_gap_volume(3.0)]);
    r.tick();
    assert!(r.c.last_chunk_update().costs_changed);
    r.c.set_cost_volumes(vec![near_gap_volume(3.0)]);
    r.tick();
    assert!(!r.c.last_chunk_update().costs_changed);
    r.c.set_cost_volumes(Vec::new());
    r.tick();
    assert!(r.c.last_chunk_update().costs_changed, "removing a volume is a change");
    let snap = r.c.chunks().snapshot();
    assert!(snap.poly_costs.is_empty());
}

#[test]
fn a_chunk_loaded_after_the_volumes_gets_their_tables() {
    let mut r = Run::new(false);
    r.c.set_cost_volumes(vec![near_gap_volume(3.0)]);
    r.tick();
    r.c.load_chunk(LoadedChunk::new(CHUNK, two_gaps()));
    r.tick();
    let snap = r.c.chunks().snapshot();
    let e = snap.find(CHUNK, WALKER, false).unwrap();
    let table = snap.poly_costs_of(e);
    assert!(!table.is_empty() && table.contains(&3.0));
    let nav = snap.entries[e].nav.as_deref().unwrap();
    for (p, poly) in nav.polys.iter().enumerate() {
        let inside = poly.center.x.abs() <= 1.5 && poly.center.z.abs() <= 1.5 && poly.center.y.abs() <= 2.0;
        assert_eq!(table[p] == 3.0, inside, "polygon {p} at {:?}", poly.center);
    }
    assert!(snap.find(CHUNK, OTHER, false).is_some_and(|o| snap.poly_costs_of(o).contains(&3.0)), "every type when none is listed");
    let _ = Float3::default();
}
