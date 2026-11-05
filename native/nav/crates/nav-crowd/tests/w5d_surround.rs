//! The surround step on a real bake (see `w5d_common.rs`): agents chasing a target with `NavSurround` claim distinct
//! slots round it once within `claim_distance`, release them when they stop chasing, slots follow a moving target,
//! ground slots off the navmesh are skipped, group members break formation into the surround, and determinism.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;
#[path = "w5d_common.rs"]
mod w5d_common;

use bake_common::*;
use nav_crowd::agents::AgentDesc;
use nav_crowd::commands::Command;
use nav_crowd::components::{NavGroup, NavSurround};
use nav_crowd::ids::{AgentId, TargetId, TargetRef};
use nav_crowd::settings::{AgentTypeSettings, NavAvoidance, NavMeshAgent};
use nav_crowd::surround_slots;
use nav_crowd::world::TargetInput;
use nav_format::file::BakeFile;
use nav_math::{Float3, Hash128};
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use w5d_common::*;

const TYPE: Hash128 = Hash128::new(1, 0, 0, 0);
const TARGET: TargetId = TargetId(5);

/// A 40 x 40 floor with a hole (no floor) on its east side: x in [8, 20].
fn bake() -> Arc<BakeFile> {
    static BAKE: OnceLock<Arc<BakeFile>> = OnceLock::new();
    BAKE.get_or_init(|| {
        let mut b = TestBake::new(Some(flat_profile()));
        b.add_floor((-20.0, -20.0), (8.0, 20.0), 0.0, &[]);
        b.bake();
        Arc::new(b.out.file.clone())
    })
    .clone()
}

fn walker() -> AgentTypeSettings {
    let walk = NavMeshAgent { radius: 0.5, height: 2.0, step_height: 0.5, pivot_offset: 0.0, max_snap_distance: 1.0, speed: 4.0, arrival_distance: 0.5, ..NavMeshAgent::default() };
    AgentTypeSettings::walker("Walker", TYPE, walk).with_avoidance(NavAvoidance::default())
}

fn sim(at: Float3, surround: NavSurround) -> Sim {
    let mut s = Sim::new(bake(), vec![walker()]);
    s.targets.apply_input(&[TargetInput { id: TARGET, position: at }]);
    assert!(s.command(Command::SetTargetSurround { target: TARGET, surround: Some(surround) }));
    s
}

fn chaser(s: &mut Sim, at: Float3) -> AgentId {
    let id = s.add(AgentDesc::new(TYPE, at));
    assert!(s.command(Command::Chase { agent: id, target: TargetRef::Target(TARGET), repath_distance: 0.0 }));
    id
}

fn slot(s: &Sim, id: AgentId) -> Option<(i16, bool)> {
    s.agents.data[s.row(id)].surround_slot.filter(|x| x.enabled).map(|x| (x.index, x.air))
}

fn surround() -> NavSurround {
    NavSurround { radius: 2.0, spacing: 1.5, claim_distance: 12.0, ..NavSurround::default() }
}

#[test]
fn chasers_claim_distinct_slots_round_the_target_once_within_claim_distance_and_go_to_them() {
    let target_at = v3(-6.0, 0.0, 0.0);
    let mut s = sim(target_at, surround());
    let near: Vec<AgentId> = (0..8).map(|i| chaser(&mut s, target_at + v3(-8.0, 0.0, -5.0 + 1.4 * i as f32))).collect();
    let far = chaser(&mut s, target_at + v3(0.0, 0.0, -19.0));
    s.run(8); // every agent has had its turn (requests are staggered over 4 ticks)
    let claimed: Vec<i16> = near.iter().map(|&a| slot(&s, a).expect("within claim distance: a slot").0).collect();
    assert_eq!(claimed.iter().collect::<HashSet<_>>().len(), claimed.len(), "distinct slots");
    assert!(slot(&s, far).is_none(), "19 m out, beyond claim distance: none yet");
    let holders = &s.targets.get(TARGET).unwrap().holders;
    assert_eq!(holders.len(), 2 * surround().max_slots as usize, "holders grown to 2 x MaxSlots on the first claim");

    // Agents coming from the west take slots on the west side, the inner ring first.
    for &a in &near {
        let o = surround_slots::offset(&surround(), false, slot(&s, a).unwrap().0 as i32);
        assert!(o.x < 0.5, "a slot on its own side: {o:?}");
    }
    s.run_seconds(6.0);
    for &a in &near {
        let goal = target_at + surround_slots::offset(&surround(), false, slot(&s, a).unwrap().0 as i32);
        assert!(s.at(a).distance(goal) < 0.6, "at its slot");
    }
    assert!(slot(&s, far).is_some(), "the far one claimed once it came near");
}

#[test]
fn a_slot_is_released_when_its_holder_stops_chasing_and_taken_by_the_next() {
    let target_at = v3(-6.0, 0.0, 0.0);
    // One slot only.
    let s1 = NavSurround { max_slots: 1, ..surround() };
    let mut s = sim(target_at, s1);
    let a = chaser(&mut s, target_at + v3(-4.0, 0.0, 0.0));
    let b = chaser(&mut s, target_at + v3(-5.0, 0.0, 1.0));
    s.run(8);
    assert!(slot(&s, a).is_some() ^ slot(&s, b).is_some(), "one slot, one holder");
    let (holder, other) = if slot(&s, a).is_some() { (a, b) } else { (b, a) };
    assert!(s.command(Command::StopChase(holder)));
    s.run(8);
    assert!(slot(&s, holder).is_none(), "released");
    assert_eq!(slot(&s, other), Some((0, false)), "and taken by the other");

    // Removing the target's surround drops the slots (while any target is surroundable the step runs: Foxfire's
    // RequireForUpdate<NavSurround>).
    assert!(s.command(Command::SetTargetSurround { target: TargetId(99), surround: Some(surround()) }));
    assert!(s.command(Command::SetTargetSurround { target: TARGET, surround: None }));
    s.run(8);
    assert!(slot(&s, other).is_none(), "the target isn't surroundable any more");
}

#[test]
fn slots_follow_a_moving_target_and_are_let_go_when_it_moves_off_far() {
    let mut at = v3(-10.0, 0.0, 0.0);
    let mut s = sim(at, surround());
    let a = chaser(&mut s, at + v3(-5.0, 0.0, 0.0));
    s.run_seconds(3.0);
    let (index, _) = slot(&s, a).expect("a slot");
    let offset = surround_slots::offset(&surround(), false, index as i32);
    assert!(s.at(a).distance(at + offset) < 0.6, "at its slot");

    // The target walks north at 1 m/s: the slot goes with it, the chaser too.
    for _ in 0..120 {
        at += v3(0.0, 0.0, 1.0 / 30.0);
        s.targets.apply_input(&[TargetInput { id: TARGET, position: at }]);
        s.step();
    }
    assert_eq!(slot(&s, a).map(|x| x.0), Some(index), "the same slot");
    assert!(s.at(a).distance(at + offset) < 0.6, "it moved with the target");

    // The target jumps far off (beyond 1.25 x claim distance): the slot is let go.
    s.frozen.push(s.row(a));
    s.targets.apply_input(&[TargetInput { id: TARGET, position: at + v3(0.0, 0.0, 16.0) }]);
    s.run(8);
    assert!(slot(&s, a).is_none(), "let go");
}

#[test]
fn ground_slots_off_the_navmesh_are_skipped() {
    // The target stands at the floor's east edge: slots east of it are over the hole.
    let at = v3(7.0, 0.0, 0.0);
    let mut s = sim(at, surround());
    let agents: Vec<AgentId> = (0..6).map(|i| chaser(&mut s, at + v3(3.0, 0.0, -3.0 + 1.2 * i as f32))).collect();
    let mut passed_over = 0;
    for _ in 0..8 {
        s.step();
        let c = s.surround.counters;
        passed_over += c.off_mesh + c.no_chunk + c.too_far;
    }
    for &a in &agents {
        let (index, _) = slot(&s, a).expect("a slot (on the navmesh side)");
        let p = at + surround_slots::offset(&surround(), false, index as i32);
        assert!(p.x <= 8.0 + 0.75, "slot {index} at {p:?} is over the floor");
    }
    assert!(passed_over > 0, "slots over the hole were passed over");
}

#[test]
fn group_members_break_formation_into_the_surround_of_their_groups_chase_target() {
    let target_at = v3(-6.0, 0.0, 0.0);
    let mut s = sim(target_at, surround());
    let mut d = AgentDesc::new(TYPE, target_at + v3(-15.0, 0.0, 0.0));
    d.group = Some(NavGroup { spacing: 2.0, ..NavGroup::default() });
    let g = s.add(d);
    let members: Vec<AgentId> = (0..4)
        .map(|i| {
            let m = s.add(AgentDesc::new(TYPE, target_at + v3(-16.0 - i as f32, 0.0, -1.0)));
            assert!(s.command(Command::JoinGroup { agent: m, group: g }));
            m
        })
        .collect();
    assert!(s.command(Command::Chase { agent: g, target: TargetRef::Target(TARGET), repath_distance: 0.0 }));
    s.run_seconds(8.0);
    assert!(slot(&s, g).is_none(), "the body doesn't claim");
    for &m in &members {
        let (index, _) = slot(&s, m).expect("each member claimed a slot");
        let goal = target_at + surround_slots::offset(&surround(), false, index as i32);
        assert!(s.at(m).distance(goal) < 0.8, "and stands in it, out of formation");
        assert!(s.slot_of(m) >= 0, "still a member");
    }

    // The group chases something else: members let go and take their places again.
    assert!(s.command(Command::StopChase(g)));
    s.run(8);
    for &m in &members {
        assert!(slot(&s, m).is_none(), "released");
    }

    // Surround off on the group: members arrive in formation.
    let mut s2 = sim(target_at, surround());
    let mut d = AgentDesc::new(TYPE, target_at + v3(-15.0, 0.0, 0.0));
    d.group = Some(NavGroup { spacing: 2.0, surround: false, ..NavGroup::default() });
    let g2 = s2.add(d);
    let m2 = s2.add(AgentDesc::new(TYPE, target_at + v3(-16.0, 0.0, -1.0)));
    assert!(s2.command(Command::JoinGroup { agent: m2, group: g2 }));
    assert!(s2.command(Command::Chase { agent: g2, target: TargetRef::Target(TARGET), repath_distance: 0.0 }));
    s2.run_seconds(6.0);
    assert!(slot(&s2, m2).is_none(), "Surround off: no claim");
}

#[test]
fn surround_claims_are_deterministic() {
    let scenario = || {
        let target_at = v3(-6.0, 0.0, 0.0);
        let mut s = sim(target_at, surround());
        let agents: Vec<AgentId> = (0..12).map(|i| chaser(&mut s, target_at + v3(-9.0 + (i % 4) as f32 * 0.9, 0.0, -4.0 + (i / 4) as f32 * 2.3))).collect();
        s.run_seconds(3.0);
        agents.iter().map(|&a| (slot(&s, a), s.at(a).x.to_bits(), s.at(a).z.to_bits())).collect::<Vec<_>>()
    };
    assert_eq!(scenario(), scenario());
}

// ------------------------------------------------------------------------------------------------- through the real tick

fn tick_sim(at: Float3, surround: NavSurround) -> TickSim {
    let mut s = TickSim::new(bake(), vec![walker()]);
    s.set_target(TARGET, at);
    s.command(Command::SetTargetSurround { target: TARGET, surround: Some(surround) });
    s
}

fn tick_chaser(s: &mut TickSim, at: Float3) -> AgentId {
    let id = s.add(AgentDesc::new(TYPE, at));
    s.command(Command::Chase { agent: id, target: TargetRef::Target(TARGET), repath_distance: 0.0 });
    id
}

fn tick_slot(s: &TickSim, id: AgentId) -> Option<(i16, bool)> {
    s.agents().data[s.row(id)].surround_slot.filter(|x| x.enabled).map(|x| (x.index, x.air))
}

#[test]
fn through_the_tick_chasers_claim_distinct_slots_round_the_target_once_within_claim_distance_and_go_to_them() {
    let target_at = v3(-6.0, 0.0, 0.0);
    let mut s = tick_sim(target_at, surround());
    let near: Vec<AgentId> = (0..8).map(|i| tick_chaser(&mut s, target_at + v3(-8.0, 0.0, -5.0 + 1.4 * i as f32))).collect();
    let far = tick_chaser(&mut s, target_at + v3(0.0, 0.0, -19.0));
    s.run(8);
    let claimed: Vec<i16> = near.iter().map(|&a| tick_slot(&s, a).expect("within claim distance: a slot").0).collect();
    assert_eq!(claimed.iter().collect::<HashSet<_>>().len(), claimed.len(), "distinct slots");
    assert!(tick_slot(&s, far).is_none(), "beyond claim distance: none yet");
    for &a in &near {
        let o = surround_slots::offset(&surround(), false, tick_slot(&s, a).unwrap().0 as i32);
        assert!(o.x < 0.5, "a slot on its own side: {o:?}");
    }
    s.run_seconds(8.0);
    for &a in &near {
        let goal = target_at + surround_slots::offset(&surround(), false, tick_slot(&s, a).unwrap().0 as i32);
        assert!(s.at(a).distance(goal) < 0.8, "at its slot: {:?} vs {goal:?}", s.at(a));
    }
    assert!(tick_slot(&s, far).is_some(), "the far one claimed once it came near");
}

#[test]
fn through_the_tick_a_slot_is_released_when_its_holder_stops_chasing_and_taken_by_the_next() {
    let target_at = v3(-6.0, 0.0, 0.0);
    let mut s = tick_sim(target_at, NavSurround { max_slots: 1, ..surround() });
    let a = tick_chaser(&mut s, target_at + v3(-4.0, 0.0, 0.0));
    let b = tick_chaser(&mut s, target_at + v3(-5.0, 0.0, 1.0));
    s.run(8);
    assert!(tick_slot(&s, a).is_some() ^ tick_slot(&s, b).is_some(), "one slot, one holder");
    let (holder, other) = if tick_slot(&s, a).is_some() { (a, b) } else { (b, a) };
    s.command(Command::StopChase(holder));
    s.run(8);
    assert!(tick_slot(&s, holder).is_none(), "released");
    assert_eq!(tick_slot(&s, other), Some((0, false)), "and taken by the other");
    s.run_seconds(5.0);
    let goal = target_at + surround_slots::offset(&NavSurround { max_slots: 1, ..surround() }, false, 0);
    assert!(s.at(other).distance(goal) < 0.8, "the new holder went to the slot: {:?}", s.at(other));
}

#[test]
fn through_the_tick_group_members_break_formation_into_the_surround_of_their_groups_chase_target() {
    let target_at = v3(-6.0, 0.0, 0.0);
    let mut s = tick_sim(target_at, surround());
    // On the floor (it starts at x = -20; the stand-in world above doesn't mind agents placed off it, the real one does).
    let mut d = AgentDesc::new(TYPE, target_at + v3(-10.0, 0.0, 0.0));
    d.group = Some(NavGroup { spacing: 2.0, ..NavGroup::default() });
    let g = s.add(d);
    let members: Vec<AgentId> = (0..4)
        .map(|i| {
            let m = s.add(AgentDesc::new(TYPE, target_at + v3(-11.5, 0.0, -3.0 + 2.0 * i as f32)));
            s.command(Command::JoinGroup { agent: m, group: g });
            m
        })
        .collect();
    s.command(Command::Chase { agent: g, target: TargetRef::Target(TARGET), repath_distance: 0.0 });
    s.run_seconds(10.0);
    assert!(tick_slot(&s, g).is_none(), "the body doesn't claim");
    for &m in &members {
        let (index, _) = tick_slot(&s, m).expect("each member claimed a slot");
        let goal = target_at + surround_slots::offset(&surround(), false, index as i32);
        assert!(s.at(m).distance(goal) < 1.0, "and stands in it, out of formation: {:?} vs {goal:?}", s.at(m));
        assert!(s.slot_of(m) >= 0, "still a member");
    }
    s.command(Command::StopChase(g));
    s.run(8);
    for &m in &members {
        assert!(tick_slot(&s, m).is_none(), "released");
    }
}
