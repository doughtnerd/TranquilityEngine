//! Groups on a real bake (see `w5d_common.rs` for the test world): members take formation slots behind a moving body
//! and keep pace (slowest member, MinPace, catch-up), a column bends round a corner, flocking, turning in place,
//! swapping slots, joining and leaving (JoinDistance, AcceptJoiners, MaxMembers), merging (Merge, MergePriority),
//! flyer groups, walk-and-fly members taking off and landing, and determinism.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;
#[path = "w5d_common.rs"]
mod w5d_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::commands::Command;
use nav_crowd::components::{NavFormationPreset, NavGroup, NavGroupMode, NavMotionMode};
use nav_crowd::formations;
use nav_crowd::groups::{self, HEADROOM};
use nav_crowd::ids::AgentId;
use nav_crowd::settings::{AgentTypeSettings, NavAvoidance, NavFlightAgent, NavMeshAgent};
use nav_format::file::BakeFile;
use nav_math::{Float3, Hash128};
use std::sync::{Arc, OnceLock};
use w5d_common::*;

/// The test walker's id (`flat_profile`, and `hybrid(.., 1, ..)`).
const TYPE: Hash128 = Hash128::new(1, 0, 0, 0);

fn floor_bake() -> Arc<BakeFile> {
    static BAKE: OnceLock<Arc<BakeFile>> = OnceLock::new();
    BAKE.get_or_init(|| {
        let mut b = TestBake::new(Some(flat_profile()));
        b.add_floor((-40.0, -40.0), (40.0, 40.0), 0.0, &[]);
        b.bake();
        Arc::new(b.out.file.clone())
    })
    .clone()
}

/// A floor with a volume above it (walk-and-fly and flyer groups).
fn hybrid_bake() -> Arc<BakeFile> {
    static BAKE: OnceLock<Arc<BakeFile>> = OnceLock::new();
    BAKE.get_or_init(|| {
        let mut b = TestBake::new(None);
        let (walker, flyer) = hybrid(1.0, 0.5, 10.0, 30.0, 1, false);
        b.add_hybrid(walker, flyer);
        b.add_floor((-15.0, -15.0), (15.0, 15.0), 0.0, &[]);
        b.bake();
        Arc::new(b.out.file.clone())
    })
    .clone()
}

fn walk_settings(speed: f32) -> NavMeshAgent {
    NavMeshAgent { radius: 0.5, height: 2.0, step_height: 0.5, pivot_offset: 0.0, max_snap_distance: 2.0, speed, arrival_distance: 0.5, ..NavMeshAgent::default() }
}

fn walker_type(join_groups: bool) -> AgentTypeSettings {
    let mut t = AgentTypeSettings::walker("Walker", TYPE, walk_settings(4.0)).with_avoidance(NavAvoidance::default());
    t.join_groups = join_groups;
    t
}

fn flight_settings() -> NavFlightAgent {
    NavFlightAgent { radius: 1.0, speed: 4.0, max_snap_distance: 2.0, takeoff_speed: 6.0, ..NavFlightAgent::default() }
}

fn walk_fly_type() -> AgentTypeSettings {
    let mut t = AgentTypeSettings::walker("WalkFly", TYPE, walk_settings(4.0));
    t.flight = Some(Arc::new(flight_settings()));
    t.with_avoidance(NavAvoidance::default())
}

fn flyer_type() -> AgentTypeSettings {
    AgentTypeSettings::flyer("Flyer", TYPE, flight_settings()).with_avoidance(NavAvoidance::default())
}

fn v(x: f32, z: f32) -> Float3 {
    v3(x, 0.0, z)
}

fn sim() -> Sim {
    Sim::new(floor_bake(), vec![walker_type(false)])
}

fn body(s: &mut Sim, at: Float3, group: NavGroup) -> AgentId {
    let mut d = AgentDesc::new(TYPE, at);
    d.group = Some(group);
    s.add(d)
}

fn member(s: &mut Sim, at: Float3, group: AgentId) -> AgentId {
    let id = s.add(AgentDesc::new(TYPE, at));
    assert!(s.command(Command::JoinGroup { agent: id, group }));
    id
}

/// Each member's distance from its slot (bent along the trail), and the largest.
fn worst_gap(s: &Sim, g: AgentId) -> f32 {
    let gr = s.group(g);
    let r = s.row(g);
    let gd = s.agents.data[r].group.as_deref().unwrap();
    let pivot = s.agents.surface[r].surface_position;
    let mut worst = 0.0f32;
    for (i, &m) in gd.members.iter().enumerate() {
        let slot = formations::target_on_trail(&gr, gd.formation.as_deref(), pivot, i as i32, gr.count, s.at(m), v3(0.0, 1.0, 0.0), &gd.trail, true);
        worst = worst.max((slot - s.at(m)).xz().length());
    }
    worst
}

// ------------------------------------------------------------------------------------------------- formation and pace

#[test]
fn members_take_formation_slots_behind_a_moving_body_and_keep_pace_with_the_slowest() {
    let mut s = sim();
    let g = body(&mut s, v(0.0, 0.0), NavGroup { spacing: 2.0, ..NavGroup::default() });
    let scattered = [v(-4.0, -6.0), v(3.0, -3.0), v(-1.0, -8.0), v(5.0, -7.0), v(0.0, -4.0), v(-6.0, -2.0)];
    let members: Vec<AgentId> = scattered.iter().map(|&p| member(&mut s, p, g)).collect();
    assert!(s.command(Command::SetSpeed { agent: members[2], speed: 3.0, turn_speed: 0.0 }), "one slower member");
    s.step();
    let mut slots: Vec<i32> = members.iter().map(|&m| s.slot_of(m)).collect();
    slots.sort();
    assert_eq!(slots, vec![0, 1, 2, 3, 4, 5], "taken in (and traded at once to the nearest slots)");
    assert_eq!(s.group(g).count, 6);

    s.run_seconds(3.0); // members fall in round the standing body
    assert!(worst_gap(&s, g) < 0.6, "fallen in: {}", worst_gap(&s, g));

    s.send(g, v(0.0, 30.0));
    s.run_seconds(4.0);
    let bodyr = s.row(g);
    let speed = s.agents.data[bodyr].walk.as_ref().unwrap().speed_override;
    assert!((speed - HEADROOM * 3.0).abs() < 1e-3, "the body walks at 85% of its slowest member's speed: {speed}");
    assert!(s.group(g).velocity.length() > 2.0, "on the move");
    assert!((s.group(g).forward - v3(0.0, 0.0, 1.0)).length() < 1e-3, "facing its way");
    assert!(worst_gap(&s, g) < 1.0, "members keep their slots on the move: {}", worst_gap(&s, g));
    // Slots are behind and beside the pivot (a Box hangs from its front centre).
    let pivot = s.at(g);
    for &m in &members {
        assert!(s.at(m).z <= pivot.z + 0.5, "behind or beside the pivot");
    }
}

#[test]
fn a_member_held_back_slows_the_group_down_to_min_pace_and_catch_up_is_capped_by_speed() {
    let mut s = sim();
    let g = body(&mut s, v(0.0, 0.0), NavGroup { spacing: 2.0, min_pace: 0.25, ..NavGroup::default() });
    let a = member(&mut s, v(-1.0, -1.0), g);
    let b = member(&mut s, v(1.0, -1.0), g);
    s.run_seconds(2.0);
    s.send(g, v(0.0, 30.0));
    s.step();
    let br = s.row(b);
    // Held: it steers but doesn't move (its chunk is gone: paused for the mover).
    s.agents.chunk[br].entry = -1;
    s.agents.chunk_pending[br] = false;
    s.run_seconds(5.0);
    let gr = s.group(g);
    let speed = s.agents.data[s.row(g)].walk.as_ref().unwrap().speed_override;
    assert!(s.at(g).distance(s.at(b)) > 2.0 * gr.slack, "the group left it more than twice Slack behind");
    assert!((speed - HEADROOM * 4.0 * gr.min_pace).abs() < 1e-3, "down to MinPace, not a stop: {speed}");
    let desired = s.agents.desired[br];
    assert!((desired.length() - 4.0).abs() < 1e-3, "far behind: catching up at its full speed, no more ({})", desired.length());
    assert!(s.at(a).distance(s.at(g)) < 3.0, "the other keeps up");

    // Pace by itself: 1 up to Slack behind, MinPace at twice Slack, 0 with nobody.
    let group = NavGroup { slack: 4.0, min_pace: 0.0, ..NavGroup::default() };
    assert_eq!(groups::pace_speed(&group, 3, 4.0, 3.0), HEADROOM * 4.0);
    assert!((groups::pace_speed(&group, 3, 4.0, 6.0) - HEADROOM * 2.0).abs() < 1e-5);
    assert_eq!(groups::pace_speed(&group, 3, 4.0, 9.0), 1e-3, "stops (a sliver: 0 means the type's speed)");
    assert_eq!(groups::pace_speed(&group, 0, 4.0, 0.0), 0.0);
}

#[test]
fn a_column_bends_round_a_corner_along_the_way_the_body_came() {
    let mut s = sim();
    let g = body(&mut s, v(-12.0, 0.0), NavGroup { formation: NavFormationPreset::Column, spacing: 2.0, forward: v3(1.0, 0.0, 0.0), ..NavGroup::default() });
    let members: Vec<AgentId> = (0..5).map(|i| member(&mut s, v(-13.0 - 2.0 * i as f32, 0.0), g)).collect();
    s.run_seconds(1.0);
    s.send(g, v(0.0, 0.0));
    s.run_seconds(6.0);
    s.send(g, v(0.0, 6.0));
    s.run_seconds(6.0); // arrived, and everyone settled into their slots
    assert!(s.at(g).distance(v(0.0, 6.0)) < 0.6, "the body arrived");
    let rear = *members.iter().find(|&&m| s.slot_of(m) == 4).unwrap();
    let at = s.at(rear);
    assert!(at.distance(v(-2.0, 0.0)) < 1.0, "the rear (8 m back) stands round the corner on the east leg: {at:?}");
    assert!(at.distance(v(0.0, -2.0)) > 1.5, "not straight behind through the corner");
    assert!(worst_gap(&s, g) < 0.6);
}

#[test]
fn a_flock_keeps_within_its_leash_spaced_apart() {
    let mut s = sim();
    let g = body(&mut s, v(0.0, 0.0), NavGroup { mode: NavGroupMode::Flock, spacing: 2.0, ..NavGroup::default() });
    let members: Vec<AgentId> = [v(-8.0, 3.0), v(7.0, -6.0), v(0.3, 9.0), v(0.0, 0.2), v(0.2, 0.0), v(-5.0, -5.0)].iter().map(|&p| member(&mut s, p, g)).collect();
    s.run_seconds(10.0);
    let leash = formations::leash(&s.group(g), 6);
    for &m in &members {
        assert!(s.at(m).distance(s.at(g)) <= leash + 0.5, "within the flock's leash ({leash})");
    }
    for i in 0..members.len() {
        for j in i + 1..members.len() {
            assert!(s.at(members[i]).distance(s.at(members[j])) > 1.0, "separation keeps members {i} and {j} apart");
        }
    }
    assert_eq!(s.group(g).columns, 0, "a flock doesn't squeeze");
}

#[test]
fn a_column_turned_round_turns_in_place_and_its_rear_takes_the_front() {
    let mut s = sim();
    let g = body(&mut s, v(0.0, -10.0), NavGroup { formation: NavFormationPreset::Column, spacing: 2.0, ..NavGroup::default() });
    let members: Vec<AgentId> = (0..5).map(|i| member(&mut s, v(0.0, -11.0 - 2.0 * i as f32), g)).collect();
    s.run_seconds(1.0);
    s.send(g, v(0.0, 8.0));
    s.run_seconds(9.0); // arrived and settled, facing north
    let rear = *members.iter().find(|&&m| s.slot_of(m) == 4).unwrap();
    let before = s.at(g);
    assert!((s.group(g).forward - v3(0.0, 0.0, 1.0)).length() < 1e-3);

    s.send(g, v(0.0, -30.0)); // a new goal behind it
    s.run(3);
    let gr = s.group(g);
    assert!(gr.turned_at > 0.0, "it turned in place");
    assert!((gr.forward - v3(0.0, 0.0, -1.0)).length() < 1e-3, "facing south now");
    assert!(s.at(g).z < before.z - 6.0, "the pivot moved to the old rear ({:?} from {before:?})", s.at(g));
    assert_eq!(s.slot_of(rear), 0, "the old rear member is the front now");
}

#[test]
fn members_swap_slots_when_that_brings_them_nearer() {
    let mut s = sim();
    let g = body(&mut s, v(0.0, 0.0), NavGroup { formation: NavFormationPreset::Line, spacing: 2.0, ..NavGroup::default() });
    // Line: slot 0 on the pivot, slot 1 a spacing right (+x). Joined the wrong way round.
    let a = member(&mut s, v(2.0, 0.0), g);
    let b = member(&mut s, v(0.0, 0.0), g);
    s.run(10);
    assert_eq!((s.slot_of(a), s.slot_of(b)), (1, 0), "traded: nobody crosses the formation");

    let mut s2 = sim();
    let g2 = body(&mut s2, v(0.0, 0.0), NavGroup { formation: NavFormationPreset::Line, spacing: 2.0, swap_slots: false, ..NavGroup::default() });
    let a2 = member(&mut s2, v(2.0, 0.0), g2);
    let _ = member(&mut s2, v(0.0, 0.0), g2);
    s2.run(10);
    assert_eq!(s2.slot_of(a2), 0, "SwapSlots off: the slot it joined with");
}

// ------------------------------------------------------------------------------------------------- joining and leaving

#[test]
fn joining_takes_the_next_slot_leaving_closes_the_hole_and_a_gone_group_lets_go() {
    let mut s = sim();
    // Swaps off, so the slots are the join order and the compaction alone moves them.
    let g = body(&mut s, v(0.0, 0.0), NavGroup { spacing: 2.0, swap_slots: false, ..NavGroup::default() });
    let m: Vec<AgentId> = (0..4).map(|i| member(&mut s, v(i as f32, -2.0), g)).collect();
    s.run(2);
    assert_eq!(s.members(g), m, "slots in join order");
    assert!(s.command(Command::LeaveGroup { agent: m[1], goal: Some(v(20.0, 20.0)) }));
    s.step();
    let left = &s.agents.data[s.row(m[1])];
    assert!(!left.group_member.unwrap().enabled && !left.group_joiner, "on its own, not straight back in");
    assert_eq!(s.goals.get(&s.row(m[1])), Some(&v(20.0, 20.0)), "sent off to its goal (its request, served)");
    assert_eq!(s.group(g).count, 3);
    assert_eq!(s.members(g), vec![m[0], m[3], m[2]], "the hole is filled from the rear; the others keep their slots");
    assert_eq!([m[0], m[3], m[2]].map(|x| s.slot_of(x)), [0, 1, 2]);

    // A member whose group is removed is on its own again.
    s.agents.remove(g);
    s.step();
    assert_eq!(s.slot_of(m[0]), -2);
    assert!(!s.agents.steering[s.row(m[0])]);
}

#[test]
fn lone_joiners_join_a_nearby_accepting_group_going_to_the_same_place_up_to_max_members() {
    let goal = v(30.0, 30.0);
    let run = |group: NavGroup, joiner_at: Float3, joiner_goal: Float3| -> (bool, Sim, AgentId, AgentId) {
        let mut s = Sim::new(floor_bake(), vec![walker_type(true)]);
        let g = body(&mut s, v(0.0, 0.0), group);
        let _m = member(&mut s, v(0.0, -1.0), g);
        s.send(g, goal);
        let j = s.add(AgentDesc::new(TYPE, joiner_at));
        s.send(j, joiner_goal);
        s.frozen.push(s.row(g)); // the body waits for the test
        s.run_seconds(1.2);
        let joined = s.agents.data[s.row(j)].group_member.is_some_and(|x| x.enabled && x.group == g);
        (joined, s, g, j)
    };
    let group = NavGroup { spacing: 2.0, join_distance: 4.0, ..NavGroup::default() };
    let (joined, s, g, j) = run(group, v(3.0, 2.0), goal);
    assert!(joined, "within the footprint plus JoinDistance, the same goal: it joins");
    assert!(s.slot_of(j) >= 0, "and takes a slot");
    assert!(!s.agents.data[s.row(j)].path_request_enabled, "the group plans now");
    assert_eq!(s.members(g).len(), 2);

    assert!(!run(group, v(3.0, 2.0), v(-30.0, 30.0)).0, "another goal: no");
    assert!(!run(group, v(12.0, 0.0), goal).0, "too far: no");
    assert!(!run(NavGroup { accept_joiners: false, ..group }, v(3.0, 2.0), goal).0, "AcceptJoiners off: no");
    assert!(!run(NavGroup { max_members: 1, ..group }, v(3.0, 2.0), goal).0, "full (MaxMembers): no");
}

#[test]
fn touching_groups_going_to_the_same_place_merge_into_the_lower_merge_priority() {
    let goal = v(30.0, 0.0);
    let setup = |pa: NavGroup, pb: NavGroup| {
        let mut s = sim();
        let a = body(&mut s, v(0.0, 0.0), pa);
        let am: Vec<AgentId> = (0..2).map(|i| member(&mut s, v(i as f32, -1.0), a)).collect();
        let b = body(&mut s, v(0.0, 4.0), pb);
        let bm: Vec<AgentId> = (0..2).map(|i| member(&mut s, v(i as f32, 3.0), b)).collect();
        s.send(a, goal);
        s.send(b, goal);
        let (ra, rb) = (s.row(a), s.row(b));
        s.frozen.extend([ra, rb]);
        s.run_seconds(1.2);
        (s, a, b, am, bm)
    };
    let base = NavGroup { spacing: 2.0, ..NavGroup::default() };
    let (s, a, b, am, bm) = setup(base, NavGroup { merge_priority: 10, ..base });
    let ra = s.row(a);
    assert!(s.agents.data[ra].disabled, "the loser's body is turned off");
    assert_eq!(s.agents.data[ra].group.as_deref().unwrap().merged_into, Some(b), "and names the group it went into");
    assert_eq!(s.group(b).count, 4, "the winner took its members");
    let mut slots: Vec<i32> = am.iter().chain(&bm).map(|&m| s.slot_of(m)).collect();
    slots.sort();
    assert_eq!(slots, vec![0, 1, 2, 3]);

    let (s, a, b, ..) = setup(base, NavGroup { merge: false, ..base });
    assert!(!s.agents.data[s.row(a)].disabled && !s.agents.data[s.row(b)].disabled, "Merge off on one: both stay");

    // Equal priority: the larger wins (then the older).
    let (s, a, ..) = setup(base, base);
    assert!(!s.agents.data[s.row(a)].disabled, "equal size and priority: the older (lower row) wins");
}

// ------------------------------------------------------------------------------------------------- flyers, walk-fly

#[test]
fn flyer_members_fly_to_their_slots_round_a_flying_body() {
    let mut s = Sim::new(hybrid_bake(), vec![flyer_type()]);
    let g = body(&mut s, v3(0.0, 4.0, -6.0), NavGroup { formation: NavFormationPreset::Wedge, spacing: 2.0, ..NavGroup::default() });
    let members: Vec<AgentId> = [v3(-3.0, 3.0, -9.0), v3(2.0, 5.0, -10.0), v3(0.0, 4.0, -12.0)].iter().map(|&p| member(&mut s, p, g)).collect();
    s.run_seconds(1.0);
    s.send(g, v3(0.0, 4.0, 6.0));
    s.run_seconds(8.0);
    assert!(s.at(g).distance(v3(0.0, 4.0, 6.0)) < 0.5, "the body arrived");
    let gr = s.group(g);
    for &m in &members {
        let slot = formations::slot(&gr, None, s.at(g), s.slot_of(m), gr.count);
        assert!(s.at(m).distance(slot) < 0.6, "in its wedge slot in 3D: {:?} vs {slot:?}", s.at(m));
    }
}

#[test]
fn walk_fly_members_take_off_and_land_with_their_body() {
    let mut s = Sim::new(hybrid_bake(), vec![walk_fly_type()]);
    let g = body(&mut s, v(0.0, 0.0), NavGroup { spacing: 2.0, ..NavGroup::default() });
    let members: Vec<AgentId> = [v(-1.0, -2.0), v(1.0, -2.0)].iter().map(|&p| member(&mut s, p, g)).collect();
    s.frozen.push(s.row(g));
    s.run_seconds(1.0);

    // The body takes off.
    let gr = s.row(g);
    {
        let route = s.agents.data[gr].route.as_deref_mut().unwrap();
        route.route.mode = NavMotionMode::TakingOff;
        route.route.transition_to = v3(0.0, 5.0, 0.0);
    }
    s.step();
    s.agents.position[gr] = v3(0.0, 5.0, 0.0); // up (the routes step would fly it)
    for &m in &members {
        let rd = s.agents.data[s.row(m)].route.as_deref().unwrap();
        assert_eq!(rd.route.mode, NavMotionMode::TakingOff, "members lift with it");
        assert!(rd.walking && rd.flying, "both mode flags on meanwhile");
        assert!(rd.route.transition_to.y > 4.0, "to the body's air point height");
    }
    s.run_seconds(2.0);
    for &m in &members {
        let r = s.row(m);
        let rd = s.agents.data[r].route.as_deref().unwrap();
        assert_eq!(rd.route.mode, NavMotionMode::Flying);
        assert!(rd.flying && !rd.walking);
        assert!(s.agents.position[r].y > 4.0, "up in the air");
    }

    // The body lands.
    s.agents.data[gr].route.as_deref_mut().unwrap().route.mode = NavMotionMode::Walking;
    s.agents.surface[gr].surface_position = v(0.0, 0.0);
    s.agents.position[gr] = v(0.0, 0.0);
    s.step();
    for &m in &members {
        assert_eq!(s.agents.data[s.row(m)].route.as_deref().unwrap().route.mode, NavMotionMode::Landing, "members land with it");
    }
    s.run_seconds(2.0);
    for &m in &members {
        let r = s.row(m);
        let rd = s.agents.data[r].route.as_deref().unwrap();
        assert_eq!(rd.route.mode, NavMotionMode::Walking);
        assert!(rd.walking && !rd.flying);
        assert!(s.agents.surface[r].initialized && s.agents.surface[r].surface_position.y.abs() < 0.3, "on the ground");
    }
}

// ------------------------------------------------------------------------------------------------- determinism

#[test]
fn groups_are_deterministic() {
    let scenario = || {
        let mut s = sim();
        let g = body(&mut s, v(0.0, 0.0), NavGroup { spacing: 2.0, ..NavGroup::default() });
        let h = body(&mut s, v(0.0, 5.0), NavGroup { formation: NavFormationPreset::Wedge, spacing: 2.0, ..NavGroup::default() });
        for i in 0..5 {
            member(&mut s, v(-3.0 + 1.3 * i as f32, -4.0 + 0.7 * i as f32), g);
            member(&mut s, v(3.0 - 1.1 * i as f32, 2.0 + 0.4 * i as f32), h);
        }
        s.send(g, v(20.0, 20.0));
        s.send(h, v(20.0, 20.0));
        s.run_seconds(6.0);
        s.agents.live_rows().map(|r| (s.agents.position[r], s.agents.data[r].group_member.map(|m| (m.group, m.slot, m.enabled)))).collect::<Vec<_>>()
    };
    let (a, b) = (scenario(), scenario());
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(&b) {
        assert_eq!((x.0.x.to_bits(), x.0.y.to_bits(), x.0.z.to_bits()), (y.0.x.to_bits(), y.0.y.to_bits(), y.0.z.to_bits()));
        assert_eq!(x.1, y.1);
    }
}

// ------------------------------------------------------------------------------------------------- through the real tick

fn tick_sim() -> TickSim {
    TickSim::new(floor_bake(), vec![walker_type(false)])
}

fn tick_body(s: &mut TickSim, at: Float3, group: NavGroup) -> AgentId {
    let mut d = AgentDesc::new(TYPE, at);
    d.group = Some(group);
    s.add(d)
}

fn tick_member(s: &mut TickSim, at: Float3, group: AgentId) -> AgentId {
    let id = s.add(AgentDesc::new(TYPE, at));
    s.command(Command::JoinGroup { agent: id, group });
    id
}

fn tick_worst_gap(s: &TickSim, g: AgentId) -> f32 {
    let gr = s.group(g);
    let r = s.row(g);
    let gd = s.agents().data[r].group.as_deref().unwrap();
    let pivot = s.agents().surface[r].surface_position;
    let mut worst = 0.0f32;
    for (i, &m) in gd.members.iter().enumerate() {
        let slot = formations::target_on_trail(&gr, gd.formation.as_deref(), pivot, i as i32, gr.count, s.at(m), v3(0.0, 1.0, 0.0), &gd.trail, true);
        worst = worst.max((slot - s.at(m)).xz().length());
    }
    worst
}

#[test]
fn through_the_tick_members_take_formation_slots_behind_a_moving_body_and_keep_pace_with_the_slowest() {
    let mut s = tick_sim();
    let g = tick_body(&mut s, v(0.0, 0.0), NavGroup { spacing: 2.0, ..NavGroup::default() });
    let scattered = [v(-4.0, -6.0), v(3.0, -3.0), v(-1.0, -8.0), v(5.0, -7.0), v(0.0, -4.0), v(-6.0, -2.0)];
    let members: Vec<AgentId> = scattered.iter().map(|&p| tick_member(&mut s, p, g)).collect();
    s.command(Command::SetSpeed { agent: members[2], speed: 3.0, turn_speed: 0.0 });
    s.step();
    let mut slots: Vec<i32> = members.iter().map(|&m| s.slot_of(m)).collect();
    slots.sort();
    assert_eq!(slots, vec![0, 1, 2, 3, 4, 5]);
    assert_eq!(s.group(g).count, 6);

    s.run_seconds(4.0);
    assert!(tick_worst_gap(&s, g) < 0.8, "fallen in: {}", tick_worst_gap(&s, g));

    s.send(g, v(0.0, 30.0));
    s.run_seconds(4.0);
    let speed = s.agents().data[s.row(g)].walk.as_ref().unwrap().speed_override;
    assert!((speed - HEADROOM * 3.0).abs() < 1e-3, "the body walks at 85% of its slowest member's speed: {speed}");
    assert!(s.group(g).velocity.length() > 2.0, "on the move");
    assert!((s.group(g).forward - v3(0.0, 0.0, 1.0)).length() < 0.05, "facing its way: {:?}", s.group(g).forward);
    assert!(tick_worst_gap(&s, g) < 1.5, "members keep their slots on the move: {}", tick_worst_gap(&s, g));
    let pivot = s.at(g);
    for &m in &members {
        assert!(s.at(m).z <= pivot.z + 0.75, "behind or beside the pivot");
    }
    s.run_seconds(12.0);
    assert!(s.at(g).distance(v(0.0, 30.0)) < 0.75, "the body arrived: {:?}", s.at(g));
    assert!(tick_worst_gap(&s, g) < 0.8, "and its members stand in their slots: {}", tick_worst_gap(&s, g));
}

#[test]
fn through_the_tick_a_column_bends_round_a_corner_along_the_way_the_body_came() {
    let mut s = tick_sim();
    let g = tick_body(&mut s, v(-12.0, 0.0), NavGroup { formation: NavFormationPreset::Column, spacing: 2.0, forward: v3(1.0, 0.0, 0.0), ..NavGroup::default() });
    let members: Vec<AgentId> = (0..5).map(|i| tick_member(&mut s, v(-13.0 - 2.0 * i as f32, 0.0), g)).collect();
    s.run_seconds(1.0);
    s.send(g, v(0.0, 0.0));
    s.run_seconds(7.0);
    s.send(g, v(0.0, 6.0));
    s.run_seconds(8.0);
    assert!(s.at(g).distance(v(0.0, 6.0)) < 0.75, "the body arrived: {:?}", s.at(g));
    let rear = *members.iter().find(|&&m| s.slot_of(m) == 4).unwrap();
    let at = s.at(rear);
    assert!(at.distance(v(-2.0, 0.0)) < 1.5, "the rear stands round the corner on the east leg: {at:?}");
    assert!(at.distance(v(0.0, -2.0)) > 1.5, "not straight behind through the corner");
    assert!(tick_worst_gap(&s, g) < 1.0, "{}", tick_worst_gap(&s, g));
}

#[test]
fn through_the_tick_joining_takes_the_next_slot_leaving_closes_the_hole_and_a_gone_group_lets_go() {
    let mut s = tick_sim();
    let g = tick_body(&mut s, v(0.0, 0.0), NavGroup { spacing: 2.0, swap_slots: false, ..NavGroup::default() });
    let m: Vec<AgentId> = (0..4).map(|i| tick_member(&mut s, v(i as f32, -2.0), g)).collect();
    s.run(2);
    assert_eq!(s.members(g), m, "slots in join order");
    s.command(Command::LeaveGroup { agent: m[1], goal: Some(v(20.0, 20.0)) });
    s.step();
    let left = &s.agents().data[s.row(m[1])];
    assert!(!left.group_member.unwrap().enabled && !left.group_joiner);
    assert_eq!(s.group(g).count, 3);
    assert_eq!(s.members(g), vec![m[0], m[3], m[2]], "the hole is filled from the rear");
    s.run_seconds(12.0);
    let st = s.c.agent_state(m[1]).unwrap();
    assert_eq!(st.path_state, nav_crowd::NavPathState::Arrived, "the leaver walked to its goal on its own");
    assert!(s.at(m[1]).distance(v(20.0, 20.0)) < 1.0);

    // Leaving with no goal: the request is off and it stands.
    s.command(Command::LeaveGroup { agent: m[3], goal: None });
    s.step();
    assert!(!s.agents().data[s.row(m[3])].path_request_enabled);

    // A member whose group is removed is on its own again.
    s.c.remove_agent(g);
    s.run(2);
    assert_eq!(s.slot_of(m[0]), -2);
    assert!(!s.agents().steering[s.row(m[0])]);
}

#[test]
fn through_the_tick_touching_groups_going_to_the_same_place_merge_into_the_lower_merge_priority() {
    let goal = v(30.0, 0.0);
    let mut s = tick_sim();
    let base = NavGroup { spacing: 2.0, ..NavGroup::default() };
    let a = tick_body(&mut s, v(0.0, 0.0), base);
    let am: Vec<AgentId> = (0..2).map(|i| tick_member(&mut s, v(i as f32, -1.0), a)).collect();
    let b = tick_body(&mut s, v(0.0, 4.0), NavGroup { merge_priority: 10, ..base });
    let bm: Vec<AgentId> = (0..2).map(|i| tick_member(&mut s, v(i as f32, 3.0), b)).collect();
    s.send(a, goal);
    s.send(b, goal);
    s.run_seconds(1.2);
    let ra = s.row(a);
    assert!(s.agents().data[ra].disabled, "the loser's body is turned off");
    assert_eq!(s.agents().data[ra].group.as_deref().unwrap().merged_into, Some(b));
    assert_eq!(s.group(b).count, 4, "the winner took its members");
    let mut slots: Vec<i32> = am.iter().chain(&bm).map(|&m| s.slot_of(m)).collect();
    slots.sort();
    assert_eq!(slots, vec![0, 1, 2, 3]);
    s.run_seconds(15.0);
    assert!(s.at(b).distance(goal) < 0.75, "the merged group goes on to the goal: {:?}", s.at(b));
}
