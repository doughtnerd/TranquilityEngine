//! Flyers (W5b): a fly-only agent in one chunk on a real flight bake: the repath/search/steering/move chain, flight
//! steering's speeds and separation inputs, and the flight search pool's size and queue (Foxfire's
//! `NavVolumeAgentSystems`, `NavFlightSteeringJobs`, `NavFlightSearchJobs`).
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::flyers::{SEARCH_POOL_SIZE, SEARCH_SLICE};
use nav_crowd::ids::AgentId;
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, CrowdSettings, NavFlightAgent};
use nav_crowd::world::WorldInput;
use nav_crowd::{Crowd, NavPathState};
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use std::sync::{Arc, OnceLock};

const FLYER: Hash128 = Hash128::new(100, 0, 0, 0);
const CHUNK: Hash128 = Hash128::new(7, 10, 0, 0);
const DT: f32 = 1.0 / 60.0;

/// One 80 x 32 m chunk (y to 16): a floor, and a 1 m wall to the ceiling from z = -16 to 4, so flyers go round through
/// the 12 m opening at z in [4, 16].
fn wall_chunk() -> LoadedChunk {
    static BAKE: OnceLock<Arc<nav_format::file::BakeFile>> = OnceLock::new();
    let file = BAKE.get_or_init(|| {
        let mut b = TestBake::new(None);
        b.add_floor((-40.0, -16.0), (40.0, 16.0), 0.0, &[]);
        b.add_obstacle(v3(0.0, 10.0, -6.0), v3(1.0, 20.0, 20.0), Rot::IDENTITY);
        b.add_flyer(flyer_with(1.0, 0.5, 0.0));
        b.set_chunk_bounds(v3(-40.0, -1.0, -16.0), v3(40.0, 16.0, 16.0), 1, 2);
        b.bake();
        assert_eq!(b.out.file.volumes.len(), 1, "setup: no flight volume");
        Arc::new(b.out.file.clone())
    });
    LoadedChunk::new(CHUNK, file.clone())
}

fn flyer_settings(f: impl FnOnce(&mut NavFlightAgent)) -> NavFlightAgent {
    let mut s = NavFlightAgent {
        radius: 1.0,
        speed: 10.0,
        turn_speed: 30.0,
        waypoint_reached_distance: 1.0,
        arrival_distance: 1.0,
        max_snap_distance: 2.0,
        repath_interval: 0.0,
        off_path_distance: 0.0,
        ..NavFlightAgent::default()
    };
    f(&mut s);
    s
}

fn crowd(f: impl FnOnce(&mut NavFlightAgent)) -> Crowd {
    let types = AgentTypes::new(vec![AgentTypeSettings::flyer("Flyer", FLYER, flyer_settings(f))]);
    let mut c = Crowd::new(CrowdSettings { agent_types: types, label: "test".into(), ..CrowdSettings::default() });
    c.load_chunk(wall_chunk());
    c
}

fn tick(c: &mut Crowd, t: &mut f64) {
    c.tick(DT, *t, &WorldInput::default());
    *t += DT as f64;
}

fn path_of(c: &Crowd, id: AgentId) -> nav_crowd::components::FlyPath {
    c.agents().data[id.row()].flyer.as_ref().expect("flyer").path
}

fn spawn(c: &mut Crowd, p: Float3, goal: Float3) -> AgentId {
    let id = c.add_agent(AgentDesc::new(FLYER, p));
    c.set_destination(id, goal);
    id
}

#[test]
fn a_flyer_flies_round_a_wall_along_its_fly_path_and_arrives() {
    let mut c = crowd(|_| {});
    let (start, goal) = (v3(-10.0, 5.0, -10.0), v3(10.0, 5.0, -10.0));
    let a = spawn(&mut c, start, goal);
    let mut t = 0.0;
    let mut max_speed = 0.0f32;
    let mut arrived_at = None;
    for i in 0..1500 {
        tick(&mut c, &mut t);
        let s = c.agent_state(a).unwrap();
        max_speed = max_speed.max(s.velocity.length());
        let p = s.position;
        assert!(p.x.abs() > 0.4 || p.z > 3.9, "tick {i}: inside the wall at {p:?}");
        if s.path_state == NavPathState::Arrived {
            arrived_at = Some(i);
            break;
        }
    }
    let i = arrived_at.expect("never arrived");
    assert!(i > 60, "arrived implausibly fast ({i} ticks)");
    let wp = c.path_waypoints(a);
    assert!(wp.len() >= 3, "a path round the wall has a corner: {wp:?}");
    assert!(wp.iter().any(|w| w.position.z > 3.5), "the path never goes through the opening: {wp:?}");
    assert!(wp[0].position.distance(start) < 2.0);
    let p = c.agent_state(a).unwrap().position;
    assert!(p.distance(goal) <= 1.5, "stopped at {p:?}, goal {goal:?}");
    assert!(max_speed <= 10.0 + 1e-2, "flew faster than its speed: {max_speed}");
    assert!(max_speed > 8.0, "never reached cruising speed: {max_speed}");
    let fp = path_of(&c, a);
    assert_eq!(fp.goal, goal);
    assert_eq!(fp.count as usize, wp.len());
}

#[test]
fn flight_steering_writes_the_desired_velocity_slows_near_the_goal_and_keeps_steering_after_arrival() {
    let mut c = crowd(|_| {});
    let a = spawn(&mut c, v3(-30.0, 5.0, 10.0), v3(-10.0, 5.0, 10.0)); // clear of the wall: a straight flight
    let mut t = 0.0;
    let (mut cruising, mut slowed) = (false, false);
    let mut steering_seen = false;
    for _ in 0..600 {
        tick(&mut c, &mut t);
        let s = c.agent_state(a).unwrap();
        let speed = s.desired_velocity.length();
        assert!(speed <= 10.0 + 1e-3, "desired {speed} past the speed");
        steering_seen |= s.flags & nav_crowd::boundary::state_flags::STEERING != 0;
        if (speed - 10.0).abs() < 1e-2 {
            cruising = true;
        }
        if s.path_state == NavPathState::Following && speed > 0.5 && speed < 9.0 && s.position.distance(v3(-10.0, 5.0, 10.0)) < 3.0 {
            slowed = true; // the brake over the last two arrival distances
        }
        if s.path_state == NavPathState::Arrived {
            break;
        }
    }
    assert!(cruising, "never at full speed");
    assert!(slowed, "never slowed near the goal");
    assert!(steering_seen);
    let s = c.agent_state(a).unwrap();
    assert_eq!(s.path_state, NavPathState::Arrived);
    // After arrival: no desired velocity, steering still on so arrived flyers keep spreading out.
    for _ in 0..3 {
        tick(&mut c, &mut t);
    }
    let s = c.agent_state(a).unwrap();
    assert_eq!(s.desired_velocity, Float3::default());
    assert!(s.flags & nav_crowd::boundary::state_flags::STEERING != 0, "arrived flyers keep steering");
}

#[test]
fn a_type_without_separation_doesnt_steer_and_flies_its_path_untouched() {
    let mut c = crowd(|f| f.separation_strength = 0.0);
    let a = spawn(&mut c, v3(-30.0, 5.0, 10.0), v3(-10.0, 5.0, 10.0));
    let mut t = 0.0;
    for _ in 0..30 {
        tick(&mut c, &mut t);
        let s = c.agent_state(a).unwrap();
        assert_eq!(s.flags & nav_crowd::boundary::state_flags::STEERING, 0);
        assert_eq!(s.desired_velocity, Float3::default(), "no steering stage: nothing desired");
    }
    let s = c.agent_state(a).unwrap();
    assert!(s.position.x > -30.0 + 3.0, "the move job flew it along the path: {:?}", s.position);
    assert!(s.velocity.length() > 5.0);
    for _ in 0..400 {
        tick(&mut c, &mut t);
        if c.agent_state(a).unwrap().path_state == NavPathState::Arrived {
            break;
        }
    }
    assert_eq!(c.agent_state(a).unwrap().path_state, NavPathState::Arrived);
}

#[test]
fn flyers_in_each_others_personal_space_steer_apart() {
    let mut c = crowd(|_| {});
    let goal = v3(-10.0, 5.0, 10.0);
    let a = spawn(&mut c, v3(-30.0, 5.0, 10.0), goal);
    let b = spawn(&mut c, v3(-30.0, 5.0, 10.8), goal);
    let mut t = 0.0;
    for _ in 0..4 {
        tick(&mut c, &mut t);
    }
    for id in [a, b] {
        let s = c.agent_state(id).unwrap();
        assert!(s.flags & nav_crowd::boundary::state_flags::STEERING != 0, "both separate");
        assert!(s.desired_velocity.length() > 5.0, "desired is the path's: {:?}", s.desired_velocity);
    }
    // The separation pushes them apart across z (when the avoidance step is in).
    let (pa, pb) = (c.agent_state(a).unwrap().position, c.agent_state(b).unwrap().position);
    assert!(pb.z - pa.z > 0.8 + 1e-3, "no push apart: {pa:?} {pb:?}");
}

#[test]
fn flight_searches_run_on_a_pool_urgent_first_and_the_rest_wait_their_turn() {
    assert_eq!(SEARCH_POOL_SIZE, 64);
    let mut c = crowd(|_| {});
    let n = SEARCH_POOL_SIZE + 10;
    let goal = v3(-26.0, 5.0, 10.0);
    let ids: Vec<AgentId> = (0..n).map(|i| spawn(&mut c, v3(-30.0, 5.0, 8.0 + 0.01 * i as f32), goal)).collect();
    let mut t = 0.0;
    tick(&mut c, &mut t);
    let served: Vec<bool> = ids.iter().map(|&id| path_of(&c, id).state != NavPathState::None).collect();
    let waiting: Vec<bool> = ids.iter().map(|&id| c.agents().data[id.row()].path_request_enabled).collect();
    // Short searches finish in the tick they're assigned in: a pool's worth are served, the rest wait enabled.
    assert_eq!(served.iter().filter(|&&s| s).count(), SEARCH_POOL_SIZE);
    assert_eq!(waiting.iter().filter(|&&s| s).count(), 10);
    // Same age, same urgency (the destination command is urgent): by row.
    assert!(served[..SEARCH_POOL_SIZE].iter().all(|&s| s), "the first rows are served first");
    tick(&mut c, &mut t);
    for &id in &ids {
        assert_ne!(path_of(&c, id).state, NavPathState::None, "{id}: still waiting");
        assert!(!c.agents().data[id.row()].path_request_enabled);
    }
}

#[test]
fn a_long_flight_search_is_sliced_over_ticks() {
    let chunk = wall_chunk();
    let volume = chunk.sections.volumes[0].1.clone();
    let filter = nav_query::volume::NavVolumeQueryFilter::for_volume(&volume, &[]);
    let (start, goal) = (v3(-39.0, 1.0, -15.0), v3(39.0, 15.0, -15.0));
    let mut pts = Vec::new();
    let (status, nodes) = nav_query::volume::find_path_counted(&volume, &filter, start, goal, 2.0, 100_000, &mut pts);
    assert_eq!(status, nav_query::pathfinding::NavPathStatus::Success);

    let mut c = crowd(|_| {});
    let a = spawn(&mut c, start, goal);
    let mut t = 0.0;
    tick(&mut c, &mut t);
    let done_after_one = path_of(&c, a).state != NavPathState::None;
    if nodes > SEARCH_SLICE as usize + 1 {
        assert!(!done_after_one, "{nodes} nodes in one slice of {SEARCH_SLICE}");
        assert!(c.agents().data[a.row()].path_request_enabled, "the request stays until the path is written");
    }
    for _ in 0..200 {
        tick(&mut c, &mut t);
        if path_of(&c, a).state != NavPathState::None {
            break;
        }
    }
    assert_ne!(path_of(&c, a).state, NavPathState::None, "never finished");
    assert!(!c.agents().data[a.row()].path_request_enabled);
}

#[test]
fn a_goal_under_the_free_air_flies_as_close_as_it_gets_and_a_start_in_the_ground_fails_with_a_warning() {
    let mut c = crowd(|f| f.max_snap_distance = 0.2);
    let mut t = 0.0;
    // The goal is in the floor: the free air above it, and the path stays Partial (it can't be reached).
    let a = spawn(&mut c, v3(-30.0, 5.0, 10.0), v3(-26.0, -0.5, 10.0));
    for _ in 0..5 {
        tick(&mut c, &mut t);
    }
    assert_eq!(path_of(&c, a).state, NavPathState::Partial);
    let wp = c.path_waypoints(a);
    assert!(wp.last().unwrap().position.y > 0.5, "ends above the floor: {wp:?}");
    // The start is in the floor, farther than the snap distance from free air.
    let b = spawn(&mut c, v3(-30.0, -0.5, 10.0), v3(-26.0, 5.0, 10.0));
    for _ in 0..5 {
        tick(&mut c, &mut t);
    }
    assert_eq!(path_of(&c, b).state, NavPathState::Failed);
    let w = c.drain_warnings();
    assert!(w.iter().any(|m| m.contains("MaxSnapDistance") || m.to_lowercase().contains("flight")), "{w:?}");
}
