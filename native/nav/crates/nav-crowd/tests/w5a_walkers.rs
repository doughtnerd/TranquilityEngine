//! Walkers on real bakes (W5a: `walkers.rs`, `motion.rs`): an agent walks its path and arrives, at its speed and turn
//! speed, easing per its Motion; repaths for a chase target that moved, for being pushed off its path, for a gate closed
//! across it; skips a waypoint it's stuck on; searches wait for a free search of the pool; congestion spreads agents
//! over lanes; walkers climb walls across folds (their up follows) and jump gaps; `move_along_surface` keeps them on the
//! mesh. Plus Foxfire's `NavCongestionTests` (3), run on hand-made walkers.
//!
//! Every scene is one chunk (cross-chunk routes are `routes.rs`'s). Agents here don't avoid, so the moves are the plain
//! mover's and the numbers exact.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_crowd::agents::{AgentDesc, AgentStore};
use nav_crowd::chunks::ChunkWorld;
use nav_crowd::components::{NavCorridor, NavFlowAgent, NavGroupMember, NavMeshAgentSurface, NavPathState};
use nav_crowd::filters::quat_rotate;
use nav_crowd::ids::{AgentId, TargetId, TargetRef};
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, CrowdSettings, NavAvoidance, NavEase, NavMeshAgent, NavMotion, NavigationRuntimeSettings};
use nav_crowd::tick::Frame;
use nav_crowd::walkers::{self, CongestionTable, WalkerSystems};
use nav_crowd::warnings::Warnings;
use nav_crowd::world::{TargetInput, WorldInput};
use nav_crowd::Crowd;
use nav_format::file::BakeFile;
use nav_math::{Float3, Float4, Hash128};
use nav_query::chunks::LoadedChunk;
use nav_query::straight_path::NavMeshWaypointFlags as F;
use std::sync::Arc;

const DT: f32 = 1.0 / 60.0;
const WALKER: Hash128 = Hash128::new(1, 0, 0, 0);
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
        max_jump_up_height: 1.0,
        max_jump_distance: 4.0,
        max_fall_distance: 2.0,
        jump_arc_height: 1.0,
        jump_apex_speed: 3.0,
        jump_rise_gravity: 10.0,
        jump_fall_gravity: 10.0,
        ..NavMeshAgent::default()
    }
}

fn crowd_with(walk: NavMeshAgent, runtime: NavigationRuntimeSettings, file: Arc<BakeFile>) -> Crowd {
    let types = AgentTypes::new(vec![AgentTypeSettings::walker("Walker", WALKER, walk)]);
    let mut c = Crowd::new(CrowdSettings { agent_types: types, runtime, label: "w5a".into() });
    c.load_chunk(LoadedChunk::new(CHUNK, file));
    c
}

fn no_congestion() -> NavigationRuntimeSettings {
    NavigationRuntimeSettings { congestion_window: 0.0, ..NavigationRuntimeSettings::default() }
}

struct Run {
    c: Crowd,
    t: f64,
    targets: Vec<TargetInput>,
}

impl Run {
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
    fn add(&mut self, p: Float3) -> AgentId {
        self.c.add_agent(AgentDesc::new(WALKER, p))
    }
    fn state(&self, id: AgentId) -> nav_crowd::boundary::AgentState {
        self.c.agent_state(id).expect("live")
    }
    fn walker(&self, id: AgentId) -> &nav_crowd::agents::WalkerData {
        self.c.agents().data[id.row()].walker.as_deref().unwrap()
    }
    fn surface(&self, id: AgentId) -> NavMeshAgentSurface {
        self.c.agents().surface[id.row()]
    }
}

fn floor_bake(p: nav_bake::settings::BakeProfile) -> TestBake {
    let mut b = TestBake::new(Some(p));
    b.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    b
}

fn flat_floor() -> Arc<BakeFile> {
    let mut b = floor_bake(flat_profile());
    b.bake();
    Arc::new(b.out.file.clone())
}

fn angle_between(a: Float3, b: Float3) -> f32 {
    (a.dot(b) / (a.length() * b.length())).clamp(-1.0, 1.0).acos()
}

// ------------------------------------------------------------------------------------------------- walking

#[test]
fn walker_walks_its_path_and_arrives_at_its_speed_and_turn_speed() {
    let mut r = Run::new(crowd_with(walk_settings(), no_congestion(), flat_floor()));
    let a = r.add(v3(-10.0, 0.0, 0.0));
    r.tick(); // goes live
    let goal = v3(10.0, 0.0, 3.0);
    r.c.set_destination(a, goal);
    let mut last = r.state(a).position;
    let mut first_turn = None;
    let mut max_step = 0.0f32;
    for i in 0..400 {
        r.tick();
        let s = r.state(a);
        max_step = max_step.max(s.position.distance(last));
        last = s.position;
        if i == 0 {
            assert_eq!(s.path_state, NavPathState::Following, "a path the same tick it was asked for");
            let forward = quat_rotate(s.rotation, v3(0.0, 0.0, 1.0));
            first_turn = Some(angle_between(forward, v3(0.0, 0.0, 1.0)));
        }
        if s.path_state == NavPathState::Arrived {
            break;
        }
    }
    let s = r.state(a);
    assert_eq!(s.path_state, NavPathState::Arrived);
    let end = r.walker(a).elements.last().unwrap().position; // the goal snapped onto the floor's surface
    assert!((end.x - goal.x).abs() < 1e-3 && (end.z - goal.z).abs() < 1e-3);
    assert!(s.position.distance(end) <= 0.5 + 1e-3, "within its arrival distance: {:?}", s.position);
    assert!(max_step <= 4.0 * DT * 1.001, "never faster than its speed: {max_step}");
    assert!(max_step >= 4.0 * DT * 0.99, "at full speed (Constant): {max_step}");
    // Turning from +z towards +x at 5/s: one tick turns 1 - exp(-5/60) of the way.
    let turned = first_turn.unwrap();
    let travel = angle_between(v3(20.0, 0.0, 3.0), v3(0.0, 0.0, 1.0));
    let expected = travel * (1.0 - (-5.0f32 * DT).exp());
    assert!((turned - expected).abs() < 0.02, "turned {turned} rad, expected about {expected}");
    // Facing its travel by the end.
    let forward = quat_rotate(s.rotation, v3(0.0, 0.0, 1.0));
    assert!(angle_between(forward, v3(20.0, 0.0, 3.0)) < 0.1);
    assert!(s.velocity.length() < 1e-6, "arrived agents stand still");
}

#[test]
fn easing_in_and_out_follows_the_agents_motion() {
    let speed_profile = |ease: NavEase| -> Vec<f32> {
        let walk = NavMeshAgent { motion: NavMotion { ease, ease_in_time: 1.0, ease_out_time: 1.0 }, ..walk_settings() };
        let mut r = Run::new(crowd_with(walk, no_congestion(), flat_floor()));
        let a = r.add(v3(-12.0, 0.0, 0.0));
        r.tick();
        r.c.set_destination(a, v3(12.0, 0.0, 0.0));
        let mut speeds = Vec::new();
        for _ in 0..600 {
            r.tick();
            let s = r.state(a);
            speeds.push(s.velocity.length());
            if s.path_state == NavPathState::Arrived {
                break;
            }
        }
        assert_eq!(r.state(a).path_state, NavPathState::Arrived, "{ease:?} arrives");
        speeds
    };
    let constant = speed_profile(NavEase::Constant);
    assert!((constant[0] - 4.0).abs() < 1e-3, "Constant: full speed from the first tick");

    let eased = speed_profile(NavEase::InOutQuad);
    assert!(eased[0] < 0.2, "InOutQuad sets off from rest: {}", eased[0]);
    // InQuad's speed rises linearly over the ease in time: half speed at half a second.
    assert!((eased[29] - 2.0).abs() < 0.15, "half speed after half a second: {}", eased[29]);
    let top = eased.iter().cloned().fold(0.0, f32::max);
    assert!((top - 4.0).abs() < 1e-3, "full speed in the middle");
    for w in eased[..58].windows(2) {
        assert!(w[1] >= w[0] - 1e-4, "speeds up steadily");
    }
    let n = eased.len();
    assert!(eased[n - 2] < 1.0, "slows to a stop at the goal: {}", eased[n - 2]);
    assert!(n > constant.len() + 30, "easing takes longer: {} vs {}", n, constant.len());
}

// ------------------------------------------------------------------------------------------------- repathing

#[test]
fn chase_repaths_when_the_target_moves_past_its_repath_distance() {
    let mut r = Run::new(crowd_with(walk_settings(), no_congestion(), flat_floor()));
    let a = r.add(v3(-15.0, 0.0, 0.0));
    let target = TargetId(1);
    r.targets = vec![TargetInput { id: target, position: v3(15.0, 0.0, 0.0) }];
    r.tick();
    r.c.chase(a, TargetRef::Target(target), 3.0);
    r.tick();
    assert_eq!(r.state(a).path_state, NavPathState::Following, "chasing at once");
    assert!(r.walker(a).path.goal.distance(v3(15.0, 0.0, 0.0)) < 1e-4);
    let first = r.walker(a).path.computed_time;

    // Within the repath distance: the path stands.
    r.targets[0].position = v3(15.0, 0.0, 2.0);
    r.ticks(10);
    assert_eq!(r.walker(a).path.computed_time, first, "moved 2 of 3: no repath");

    // Past it: repathed within a full check's few ticks, to where the target is now.
    r.targets[0].position = v3(15.0, 0.0, 8.0);
    r.ticks(walkers::CHECK_FRAMES as usize + 1);
    assert!(r.walker(a).path.computed_time > first);
    assert!(r.walker(a).path.goal.distance(v3(15.0, 0.0, 8.0)) < 1e-4, "{:?}", r.walker(a).path.goal);

    // A target that's gone leaves the agent on its last path.
    r.c.remove_target(target);
    r.targets.clear();
    let before = r.walker(a).path.computed_time;
    r.ticks(10);
    assert_eq!(r.walker(a).path.computed_time, before);
    assert_eq!(r.state(a).path_state, NavPathState::Following);
}

#[test]
fn pushed_off_its_path_it_repaths_from_where_it_is() {
    let mut r = Run::new(crowd_with(walk_settings(), no_congestion(), flat_floor()));
    let mut desc = AgentDesc::new(WALKER, v3(-10.0, 0.0, 0.0));
    desc.update_position = false; // the host moves it: it can push it
    let a = r.c.add_agent(desc);
    r.tick();
    r.c.set_destination(a, v3(10.0, 0.0, 0.0));
    r.tick();
    let first = r.walker(a).path.computed_time;
    let rot = Float4::new(0.0, 0.0, 0.0, 1.0);
    // Pushed 1 m aside (under the off-path distance of 1.5): no repath.
    r.c.write_agent_transform(a, v3(-8.0, 0.0, 1.0), rot, v3(0.0, 1.0, 0.0));
    r.ticks(walkers::CHECK_FRAMES as usize + 1);
    assert_eq!(r.walker(a).path.computed_time, first);
    assert!((r.surface(a).surface_position.z - 1.0).abs() < 0.1, "the host's move is the contact (and this tick's step)");
    // 4 m aside: a new path from there.
    r.c.write_agent_transform(a, v3(-6.0, 0.0, 4.0), rot, v3(0.0, 1.0, 0.0));
    r.ticks(walkers::CHECK_FRAMES as usize + 1);
    let w = r.walker(a);
    assert!(w.path.computed_time > first, "repathed");
    assert!(w.elements[0].position.xz().distance(v3(-6.0, 0.0, 4.0).xz()) < 0.1, "from where it was pushed: {:?}", w.elements[0].position);
    assert!(r.state(a).desired_velocity.length() > 3.9, "a host-moved walker still gets its desired velocity");
}

/// A floor split by a wall along x = 0 with a gated gap at z in [-1, 1] and an open one at z in [7, 9].
fn gated_wall() -> Arc<BakeFile> {
    let mut b = floor_bake(flat_profile());
    b.add_obstacle(v3(0.0, 1.0, -5.5), v3(0.5, 2.0, 9.0), Rot::IDENTITY);
    b.add_obstacle(v3(0.0, 1.0, 4.0), v3(0.5, 2.0, 6.0), Rot::IDENTITY);
    b.add_obstacle(v3(0.0, 1.0, 14.5), v3(0.5, 2.0, 11.0), Rot::IDENTITY);
    b.add_gate(v3(0.0, 0.0, 0.0), v3(1.5, 2.0, 2.0), true);
    b.bake();
    Arc::new(b.out.file.clone())
}

#[test]
fn a_gate_closed_across_its_path_repaths_it_the_other_way() {
    let mut r = Run::new(crowd_with(walk_settings(), no_congestion(), gated_wall()));
    let a = r.add(v3(-8.0, 0.0, 0.0));
    r.tick();
    r.c.set_destination(a, v3(8.0, 0.0, 0.0));
    r.tick();
    let w = r.walker(a);
    assert_eq!(w.path.state, NavPathState::Following);
    assert!(w.elements.iter().all(|e| e.position.z.abs() < 2.0), "straight through the open gate: {:?}", w.elements);
    let first = w.path.computed_time;
    r.ticks(30);

    r.c.set_gate(Hash128::new(1, 1, 0, 0), false);
    r.tick();
    let w = r.walker(a);
    assert!(w.path.computed_time > first, "a gate change repaths at once (urgent)");
    assert!(w.elements.iter().any(|e| e.position.z > 6.0), "round by the open gap: {:?}", w.elements);
    for _ in 0..800 {
        r.tick();
        if r.state(a).path_state == NavPathState::Arrived {
            break;
        }
    }
    assert_eq!(r.state(a).path_state, NavPathState::Arrived);
}

#[test]
fn stuck_on_a_waypoint_it_skips_to_the_next() {
    // A wall across the middle: the path turns its end, so it has corners.
    let mut b = floor_bake(flat_profile());
    b.add_obstacle(v3(0.0, 1.0, -4.0), v3(0.5, 2.0, 24.0), Rot::IDENTITY); // z -16..8
    b.bake();
    // No off-path repath: past the skipped corner it's off its new segment.
    let walk = NavMeshAgent { off_path_distance: 0.0, ..walk_settings() };
    let mut r = Run::new(crowd_with(walk, no_congestion(), Arc::new(b.out.file.clone())));
    let mut desc = AgentDesc::new(WALKER, v3(-8.0, 0.0, 0.0));
    desc.update_position = false; // the host holds it still
    let a = r.c.add_agent(desc);
    r.tick();
    r.c.set_destination(a, v3(8.0, 0.0, 0.0));
    r.tick();
    let w = r.walker(a);
    assert!(w.path.count >= 3, "a corner to turn: {:?}", w.elements);
    assert_eq!(w.path.next_index, 1);
    r.ticks(50); // under a second
    assert_eq!(r.walker(a).path.next_index, 1, "not yet");
    r.ticks(20);
    assert_eq!(r.walker(a).path.next_index, 2, "skipped after StuckSkipTime without progress");
}

// ------------------------------------------------------------------------------------------------- searches

#[test]
fn more_requests_than_searches_are_served_over_later_ticks() {
    let runtime = NavigationRuntimeSettings { max_paths_per_frame: 2, ..no_congestion() };
    let mut r = Run::new(crowd_with(walk_settings(), runtime, flat_floor()));
    let ids: Vec<AgentId> = (0..6).map(|i| r.add(v3(-10.0, 0.0, -6.0 + 2.0 * i as f32))).collect();
    r.tick();
    for &a in &ids {
        r.c.set_destination(a, v3(10.0, 0.0, 0.0));
    }
    let served = |r: &Run| ids.iter().filter(|&&a| r.state(a).path_state != NavPathState::None).count();
    r.tick();
    assert_eq!(served(&r), 2, "two searches: two paths this tick");
    r.tick();
    assert_eq!(served(&r), 4);
    r.tick();
    assert_eq!(served(&r), 6, "the rest on later ticks");
    for &a in &ids {
        assert_eq!(r.state(a).path_state, NavPathState::Following);
    }
}

// ------------------------------------------------------------------------------------------------- congestion

/// Two narrow lanes either side of a block (z in [1, 2.6] and [-2.6, -1]).
fn two_lanes() -> Arc<BakeFile> {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-14.0, -2.6), (14.0, 2.6), 0.0, &[]);
    b.add_obstacle(v3(0.0, 1.0, 0.0), v3(16.0, 2.0, 2.0), Rot::IDENTITY);
    b.bake();
    Arc::new(b.out.file.clone())
}

#[test]
fn congestion_reservations_spread_agents_over_lanes() {
    let south = |runtime: NavigationRuntimeSettings| -> usize {
        let mut r = Run::new(crowd_with(walk_settings(), runtime, two_lanes()));
        // Every agent starts on the north side: the north lane is its shortest way.
        let ids: Vec<AgentId> = (0..5).map(|i| r.add(v3(-12.0 + 0.6 * i as f32, 0.0, 1.8))).collect();
        r.tick();
        for &a in &ids {
            r.c.set_destination(a, v3(12.0, 0.0, 1.8));
        }
        r.tick();
        ids.iter()
            .filter(|&&a| {
                let w = r.walker(a);
                assert_eq!(w.path.state, NavPathState::Following);
                w.elements.iter().any(|e| e.position.z < 0.0)
            })
            .count()
    };
    assert_eq!(south(no_congestion()), 0, "without congestion every agent takes the north lane");
    let on = south(NavigationRuntimeSettings { congestion_window: 4.0, congestion_slot: 0.5, ..NavigationRuntimeSettings::default() });
    assert!(on >= 1, "with reservations later agents take the free lane: {on}");
    assert!(on < 5, "the first still takes the short one");
}

// ------------------------------------------------------------------------------------------------- surfaces

#[test]
fn climbing_a_wall_its_up_follows_the_surface_across_the_folds() {
    let mut b = floor_bake(profile(false, true, true, 1));
    b.add_box(v3(6.0, 2.5, 0.0), v3(3.0, 5.0, 10.0), Rot::IDENTITY); // x 4.5..7.5, top y 5
    b.bake();
    let walk = NavMeshAgent { can_climb_walls: true, can_walk_ceilings: true, ..walk_settings() };
    let mut r = Run::new(crowd_with(walk, no_congestion(), Arc::new(b.out.file.clone())));
    let a = r.add(v3(0.0, 0.0, 0.0));
    r.tick();
    let goal = v3(6.0, 5.0, 0.0);
    r.c.set_destination(a, goal);
    let (mut on_wall, mut folds) = (false, false);
    for _ in 0..800 {
        r.tick();
        let s = r.surface(a);
        if s.up.x < -0.9 {
            on_wall = true;
            assert!(s.surface_position.x < 4.7 && s.surface_position.y > 0.2, "on the west face: {:?}", s.surface_position);
        }
        folds |= r.walker(a).path.is_fold_segment();
        if r.state(a).path_state == NavPathState::Arrived {
            break;
        }
    }
    assert!(folds, "crossed folds");
    assert!(on_wall, "its up turned to the wall's normal on the face");
    let s = r.state(a);
    assert_eq!(s.path_state, NavPathState::Arrived);
    assert!(s.position.distance(goal) < 0.6, "on top: {:?}", s.position);
    assert!(r.surface(a).up.y > 0.99, "upright again on top");
}

#[test]
fn jumping_a_gap_follows_the_arc_from_take_off_to_landing() {
    let mut b = TestBake::new(Some(profile(true, false, false, 1)));
    b.add_floor((-8.0, -3.0), (-1.0, 3.0), 0.0, &[]);
    b.add_floor((1.0, -3.0), (8.0, 3.0), 0.0, &[]);
    b.bake();
    let walk = NavMeshAgent { can_jump: true, ..walk_settings() };
    let mut r = Run::new(crowd_with(walk, no_congestion(), Arc::new(b.out.file.clone())));
    let a = r.add(v3(-6.0, 0.0, 0.0));
    r.tick();
    r.c.set_destination(a, v3(6.0, 0.0, 0.0));
    r.tick();
    assert!(r.walker(a).elements.iter().any(|e| e.flags.contains(F::JUMP_START)), "the path jumps");
    let (mut jumping, mut peak) = (0, 0.0f32);
    for _ in 0..600 {
        r.tick();
        if r.walker(a).path.is_jump_segment() {
            jumping += 1;
            let p = r.state(a).position;
            if p.x > -0.5 && p.x < 0.5 {
                peak = peak.max(p.y);
            }
        }
        if r.state(a).path_state == NavPathState::Arrived {
            break;
        }
    }
    let s = r.state(a);
    assert_eq!(s.path_state, NavPathState::Arrived);
    assert!(jumping > 2, "the jump took several ticks: {jumping}");
    assert!(peak > 0.8, "in the air mid-gap on the arc: {peak}");
    assert!(s.position.distance(v3(6.0, 0.0, 0.0)) < 0.6);
}

#[test]
fn move_along_surface_keeps_moves_on_the_mesh() {
    let mut b = floor_bake(flat_profile());
    b.add_obstacle(v3(0.0, 1.0, 0.0), v3(2.0, 2.0, 6.0), Rot::IDENTITY); // x -1..1, z -3..3
    b.bake();
    let nav = b.nav();
    let start = v3(-4.0, 0.0, 0.0);
    let poly = nearest_poly(nav, start, 1.0).unwrap() as i32;
    let no_gates: [bool; 0] = [];

    // Into the block: stopped at its eroded edge (x -1.5), sliding along it.
    let (to, end_poly) = walkers::move_along_surface(nav, poly, start, v3(0.0, 0.0, 0.5), &no_gates);
    assert!(to.x <= -1.4 && to.x >= -1.7, "held at the edge: {to:?}");
    assert!(to.z > 0.0, "slid along it: {to:?}");
    assert!(distance_to_poly(nav, end_poly as usize, to) < 1e-3, "on the polygon it returns");

    // A move on open floor ends where it was asked.
    let (to, end_poly) = walkers::move_along_surface(nav, poly, start, v3(-5.0, 0.0, -1.0), &no_gates);
    assert!(to.xz().distance(v3(-5.0, 0.0, -1.0).xz()) < 1e-3 && to.y.abs() < 0.3, "on the floor's surface: {to:?}");
    assert_eq!(walkers::locate_poly(nav, to, v3(0.0, 1.0, 0.0), end_poly, -1, -1, 1.0), end_poly);

    // Off the edge of the floor: held on it.
    let edge = v3(-18.0, 0.0, 0.0);
    let poly = nearest_poly(nav, edge, 1.0).unwrap() as i32;
    let (to, _) = walkers::move_along_surface(nav, poly, edge, v3(-25.0, 0.0, 0.0), &no_gates);
    assert!(to.x > -20.0 && to.x < -19.0, "{to:?}");
    // Located: lost polygons are found again near; agents off the mesh with no hint aren't searched for.
    assert!(walkers::locate_poly(nav, v3(-5.0, 0.0, -1.0), v3(0.0, 1.0, 0.0), poly, -1, -1, 1.0) >= 0);
    assert_eq!(walkers::locate_poly(nav, v3(0.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), -1, -1, -1, 1.0), -1, "inside the block");
}

// ------------------------------------------------------------------------------------------------- NavCongestionTests

const BUCKETS: usize = 8;

struct CongestionScene {
    world: ChunkWorld,
    agents: AgentStore,
    types: AgentTypes,
    runtime: NavigationRuntimeSettings,
    sys: WalkerSystems,
    polys: [i32; 4],
}

impl CongestionScene {
    fn new() -> Self {
        let mut world = ChunkWorld::new();
        world.load(LoadedChunk::new(CHUNK, flat_floor()));
        world.update(0.0, &mut Warnings::new("w5a"));
        let nav = world.snapshot().entries[0].nav.clone().unwrap();
        assert!(nav.polys.len() >= 4, "setup: the floor has at least four polygons");
        let types = AgentTypes::new(vec![AgentTypeSettings::walker("Walker", WALKER, NavMeshAgent::default()).with_avoidance(NavAvoidance::default())]);
        let mut sys = WalkerSystems::default();
        sys.congestion = CongestionTable { loads: vec![0; nav.polys.len() * BUCKETS], offsets: vec![0], slots: BUCKETS, bucket_seconds: 0.5, ..Default::default() };
        Self { world, agents: AgentStore::new(), types, runtime: NavigationRuntimeSettings::default(), sys, polys: [0, 1, 2, 3] }
    }

    fn add_walker(&mut self, flow: Option<bool>, member: bool, tracked: Option<(i32, bool)>) -> usize {
        let nav = self.world.snapshot().entries[0].nav.clone().unwrap();
        let start = nav.polys[self.polys[0] as usize].center;
        let id = self.agents.reserve();
        self.agents.activate(id, &AgentDesc::new(WALKER, start), &self.types).unwrap();
        let r = id.row();
        self.agents.surface[r] = NavMeshAgentSurface { surface_position: start, up: v3(0.0, 1.0, 0.0), initialized: true };
        self.agents.chunk[r].entry = 0;
        let key = self.world.nav_key(0);
        let d = &mut self.agents.data[r];
        let w = d.walker.as_deref_mut().unwrap();
        w.path.state = NavPathState::Following;
        w.path.nav = key;
        w.path.computed_time = -100.0;
        w.path.goal = nav.polys[self.polys[3] as usize].center;
        w.corridor = self.polys.iter().enumerate().map(|(i, &p)| NavCorridor { poly: p, distance: 0.3 * i as f32, lanes: 1.0 }).collect();
        if let Some(on) = flow {
            d.flow_agent = Some(NavFlowAgent { enabled: on, exit: -1, ..NavFlowAgent::default() });
        }
        if member {
            d.group_member = Some(NavGroupMember { group: id, slot: 0, enabled: true });
        }
        if let Some((poly, steers)) = tracked {
            w.avoidance_state.poly = poly;
            self.agents.steering[r] = steers;
        } else {
            d.avoidance = None;
        }
        r
    }

    /// Every slot of the corridor's polygons at `load` (this walker plus load - 1 others).
    fn fill(&mut self, load: i32) {
        self.sys.congestion.loads.iter_mut().for_each(|l| *l = 0);
        for p in self.polys {
            for b in 0..BUCKETS {
                self.sys.congestion.loads[p as usize * BUCKETS + b] = load;
            }
        }
    }

    fn frame(&self) -> Frame<'_> {
        Frame { dt: DT, time: 0.0, tick: 1, world: &self.world, update: Default::default(), types: &self.types, runtime: &self.runtime, world_area_costs: &[] }
    }

    fn run_repath(&mut self) {
        for r in self.agents.live_rows().collect::<Vec<_>>() {
            self.agents.data[r].path_request_enabled = false;
        }
        let frame = Frame { dt: DT, time: 0.0, tick: 1, world: &self.world, update: Default::default(), types: &self.types, runtime: &self.runtime, world_area_costs: &[] };
        walkers::congestion_repath(&mut self.sys, &mut self.agents, &frame);
    }

    fn run_reserve(&mut self) {
        self.sys.congestion.loads.iter_mut().for_each(|l| *l = 0);
        let frame = Frame { dt: DT, time: 0.0, tick: 1, world: &self.world, update: Default::default(), types: &self.types, runtime: &self.runtime, world_area_costs: &[] };
        walkers::reserve_corridors(&mut self.sys, &mut self.agents, &frame);
    }

    fn requested(&self, r: usize) -> bool {
        self.agents.data[r].path_request_enabled
    }
}

#[test]
fn congested_corridor_repaths_the_walker_not_flow_followers_or_group_members() {
    let mut s = CongestionScene::new();
    let _ = s.frame();
    let off_field = s.add_walker(Some(false), false, None);
    let on_field = s.add_walker(Some(true), false, None);
    let member = s.add_walker(Some(false), true, None);
    let plain = s.add_walker(None, false, None);
    s.fill(5);
    s.run_repath();
    assert!(s.requested(off_field), "off its field: repaths");
    assert!(s.requested(plain), "no flow component: repaths");
    assert!(!s.requested(on_field), "on a flow field: skipped");
    assert!(!s.requested(member), "a group member: skipped");
    let d = &s.agents.data[off_field];
    assert_eq!(d.walker.as_deref().unwrap().path.goal, d.path_request.goal, "to the same goal");
}

#[test]
fn only_flow_followers_are_skipped_and_a_free_corridor_repaths_nobody() {
    let mut s = CongestionScene::new();
    let followers: Vec<usize> = (0..5).map(|_| s.add_walker(Some(true), false, None)).collect();
    s.fill(5);
    s.run_repath();
    for f in followers {
        assert!(!s.requested(f), "followers don't repath for congestion");
    }
    let walker = s.add_walker(Some(false), false, None);
    s.fill(1); // only its own reservation
    s.run_repath();
    assert!(!s.requested(walker), "room ahead: no repath");
}

#[test]
fn reserve_moves_the_cursor_to_the_tracked_polygon_while_steering_and_reserves_from_there() {
    let mut s = CongestionScene::new();
    let p2 = s.polys[2];
    let steering = s.add_walker(Some(false), false, Some((p2, true)));
    let idle = s.add_walker(Some(false), false, Some((p2, false)));
    s.run_reserve();
    assert_eq!(s.agents.data[steering].walker.as_deref().unwrap().cursor.index, 2, "to the polygon avoidance tracks");
    assert_eq!(s.agents.data[idle].walker.as_deref().unwrap().cursor.index, 0, "by where it stands");
    let t = &s.sys.congestion;
    assert_eq!(t.load(0, s.polys[0], 0), 1, "only the idle walker is still on the first polygon");
    assert_eq!(t.load(0, s.polys[2], 0), 2, "the steering walker reserves its polygon from now; the idle one passes it later in the slot");
}
