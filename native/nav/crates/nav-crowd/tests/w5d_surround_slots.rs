//! Foxfire's `NavSurroundSlotsTests` (17), ported: where the surround slots are round a target (pure functions), and
//! where a slot holder's chase goal is (`chase_goal`).
use nav_crowd::components::{NavSurround, NavSurroundSlot, PathGoalTarget};
use nav_crowd::ids::{TargetId, TargetRef};
use nav_crowd::surround_slots as slots;
use nav_crowd::world::Targets;
use nav_math::Float3;

fn settings(radius: f32, spacing: f32, air_spacing: f32) -> NavSurround {
    NavSurround { radius, spacing, air_spacing, claim_distance: 30.0, max_slots: 64 }
}

/// Settings whose every ring holds at least 4 slots.
fn ground_settings() -> [NavSurround; 4] {
    [NavSurround::default(), settings(2.0, 2.5, 0.0), settings(0.0, 2.0, 0.0), settings(5.0, 1.5, 0.0)]
}

// ------------------------------------------------------------------------------------ Ground rings

#[test]
fn ground_slots_are_level_with_the_target_at_their_rings_radius() {
    for s in ground_settings() {
        let mut first = 0;
        for ring in 0..8 {
            let count = slots::count(&s, false, ring);
            let radius = slots::ring_radius(&s, false, ring);
            for k in 0..count {
                let o = slots::offset(&s, false, first + k);
                assert_eq!(o.y, 0.0, "level: ground slots snap onto the navmesh");
                assert!((o.length() - radius).abs() <= 1e-3, "ring {ring} slot {k} ({s:?})");
            }
            first += count;
        }
    }
}

#[test]
fn ground_slots_neighbours_on_a_ring_are_about_a_spacing_apart() {
    for s in ground_settings() {
        let mut first = 0;
        for ring in 0..10 {
            let count = slots::count(&s, false, ring);
            if count >= 6 {
                for k in 0..count {
                    let a = slots::offset(&s, false, first + k);
                    let b = slots::offset(&s, false, first + (k + 1) % count);
                    assert!(a.distance(b) >= 0.9 * s.spacing, "ring {ring} slots {k} and {} ({s:?})", (k + 1) % count);
                }
            }
            first += count;
        }
    }
}

#[test]
fn ground_slots_any_two_of_the_first_hundred_are_at_least_most_of_a_spacing_apart() {
    for s in ground_settings() {
        let o: Vec<Float3> = (0..100).map(|i| slots::offset(&s, false, i)).collect();
        for i in 0..o.len() {
            for j in i + 1..o.len() {
                assert!(o[i].distance(o[j]) >= 0.85 * s.spacing, "slots {i} and {j} ({s:?})");
            }
        }
    }
}

#[test]
fn ground_slots_count_grows_with_the_ring() {
    for s in ground_settings() {
        for ring in 0..10 {
            assert!(slots::count(&s, false, ring + 1) > slots::count(&s, false, ring), "ring {ring} to {} ({s:?})", ring + 1);
        }
    }
}

#[test]
fn ring_first_and_count_are_consistent_with_the_slot_indices() {
    for s in ground_settings() {
        for air in [false, true] {
            let mut first = 0;
            for ring in 0..6 {
                let count = slots::count(&s, air, ring);
                assert_eq!(slots::ring(&s, air, first), (ring, first, count), "first slot of ring {ring}, air {air}");
                assert_eq!(slots::ring(&s, air, first + count - 1), (ring, first, count), "last slot of ring {ring}, air {air}");
                assert_eq!(slots::ring(&s, air, first + count), (ring + 1, first + count, slots::count(&s, air, ring + 1)), "first slot of ring {}, air {air}", ring + 1);
                first += count;
            }
        }
    }
}

#[test]
fn radius_zero_first_slot_is_on_the_target() {
    let s = settings(0.0, 2.0, 0.0);
    assert_eq!(slots::count(&s, false, 0), 1, "a ring of radius 0 holds one slot");
    assert!(slots::offset(&s, false, 0).length() <= 1e-6, "on the target");
    assert!((slots::offset(&s, false, 1).length() - 2.0).abs() <= 1e-4, "the next ring is a Spacing out");
    let (ring, first, _) = slots::ring(&s, false, 1);
    assert_eq!((ring, first), (1, 1));
    assert!(slots::offset(&s, true, 0).length() <= 1e-6, "air: the first shell is a point on the target too");
}

// ------------------------------------------------------------------------------------ NearestOnRing

/// A small deterministic generator for angles (Foxfire's test uses `Unity.Mathematics.Random(12345)`).
struct Lcg(u64);

impl Lcg {
    fn next_f32(&mut self, lo: f32, hi: f32) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let u = (self.0 >> 40) as f32 / (1u64 << 24) as f32;
        lo + (hi - lo) * u
    }
}

fn slot_angle(k: i32, n: i32, ring: i32) -> f32 {
    let d = slots::on_ring(k, n, ring);
    d.z.atan2(d.x)
}

/// The angle between two direction angles in radians, wrapped: 0 to pi.
fn angle_between(a: f32, b: f32) -> f32 {
    let two_pi = 2.0 * std::f32::consts::PI;
    let d = a - b;
    (d - two_pi * (d / two_pi).round()).abs()
}

#[test]
fn nearest_on_ring_is_the_slot_closest_in_direction_for_any_angle() {
    let s = NavSurround::default();
    let mut rng = Lcg(12345);
    for ring in 0..4 {
        let count = slots::count(&s, false, ring);
        for _ in 0..200 {
            let angle = rng.next_f32(-20.0, 20.0);
            let nearest = slots::nearest_on_ring(angle, count, ring);
            assert!((0..count).contains(&nearest));
            let best = (0..count).map(|k| angle_between(angle, slot_angle(k, count, ring))).fold(f32::MAX, f32::min);
            let got = angle_between(angle, slot_angle(nearest, count, ring));
            assert!(got <= best + 1e-3, "ring {ring}, angle {angle}: slot {nearest} is {got} rad off, the closest {best}");
        }
    }
}

// ------------------------------------------------------------------------------------ Air shells

#[test]
fn air_slots_lie_on_their_shell_spanning_top_and_bottom() {
    for s in [NavSurround::default(), settings(4.0, 2.0, 3.0)] {
        let mut first = 0;
        for shell in 0..4 {
            let count = slots::count(&s, true, shell);
            let radius = slots::ring_radius(&s, true, shell);
            let (mut top, mut bottom) = (f32::MIN, f32::MAX);
            for k in 0..count {
                let o = slots::offset(&s, true, first + k);
                assert!((o.length() - radius).abs() <= 1e-3, "shell {shell} slot {k}");
                top = top.max(o.y);
                bottom = bottom.min(o.y);
            }
            if count >= 12 {
                assert!(top > 0.8 * radius, "shell {shell} reaches the top");
                assert!(bottom < -0.8 * radius, "shell {shell} reaches the bottom");
            }
            first += count;
        }
    }
}

#[test]
fn air_slots_on_a_shell_are_not_close_together() {
    for s in [NavSurround::default(), settings(4.0, 2.0, 3.0)] {
        let spacing = slots::spacing(&s, true);
        let mut first = 0;
        for shell in 0..4 {
            let count = slots::count(&s, true, shell);
            let o: Vec<Float3> = (0..count).map(|k| slots::offset(&s, true, first + k)).collect();
            for i in 0..o.len() {
                for j in i + 1..o.len() {
                    assert!(o[i].distance(o[j]) >= 0.5 * spacing, "shell {shell} slots {i} and {j}");
                }
            }
            first += count;
        }
    }
}

#[test]
fn air_spacing_zero_falls_back_to_spacing() {
    assert_eq!(slots::spacing(&NavSurround::default(), true), 3.0, "AirSpacing 0: the ground spacing");
    assert_eq!(slots::spacing(&NavSurround::default(), false), 3.0);
    let s = settings(3.0, 3.0, 5.0);
    assert_eq!(slots::spacing(&s, true), 5.0, "AirSpacing set: used for air");
    assert_eq!(slots::spacing(&s, false), 3.0, "and not for the ground");
    assert!((slots::ring_radius(&s, true, 1) - 8.0).abs() <= 1e-5, "shells are an AirSpacing apart");
    assert!((slots::ring_radius(&s, false, 1) - 6.0).abs() <= 1e-5, "rings a Spacing apart");

    let a = NavSurround::default();
    let b = NavSurround { air_spacing: a.spacing, ..a };
    for shell in 0..3 {
        assert_eq!(slots::count(&b, true, shell), slots::count(&a, true, shell), "shell {shell}");
    }
    assert_eq!(slots::offset(&b, true, 5), slots::offset(&a, true, 5));
}

// ------------------------------------------------------------------------------------ ChaseGoal

const TARGET_POS: Float3 = Float3::new(10.0, 2.0, -5.0);
const TARGET: TargetId = TargetId(1);
const OTHER: TargetId = TargetId(2);

fn surround_targets(s: NavSurround) -> Targets {
    let mut t = Targets::default();
    t.entry(TARGET).surround = Some(s);
    t.entry(OTHER).surround = Some(s);
    t
}

fn holder(target: TargetId, air: bool, index: i16) -> NavSurroundSlot {
    NavSurroundSlot { target: TargetRef::Target(target), index, air, enabled: true }
}

fn chase(repath_distance: f32) -> PathGoalTarget {
    PathGoalTarget { target: TargetRef::Target(TARGET), repath_distance }
}

#[test]
fn chase_goal_holding_a_slot_is_the_target_plus_the_slots_offset_repathing_within_half_a_spacing() {
    let s = NavSurround::default();
    let targets = surround_targets(s);
    let (goal, repath) = slots::chase_goal(Some(&holder(TARGET, false, 3)), &chase(10.0), TARGET_POS, &targets);
    let expected = TARGET_POS + slots::offset(&s, false, 3);
    assert!(goal.distance(expected) <= 1e-4);
    assert_ne!(goal, TARGET_POS, "setup: slot 3 isn't on the target");
    assert!((repath - 0.5 * s.spacing).abs() <= 1e-5, "at most half a spacing while holding a slot");
}

#[test]
fn chase_goal_a_smaller_repath_distance_is_kept() {
    let targets = surround_targets(NavSurround::default());
    let (_, repath) = slots::chase_goal(Some(&holder(TARGET, false, 3)), &chase(0.5), TARGET_POS, &targets);
    assert!((repath - 0.5).abs() <= 1e-6, "the min of the two");
}

#[test]
fn chase_goal_holding_an_air_slot_uses_air_spacing_and_the_shell() {
    let s = settings(3.0, 3.0, 4.0);
    let targets = surround_targets(s);
    let (goal, repath) = slots::chase_goal(Some(&holder(TARGET, true, 5)), &chase(10.0), TARGET_POS, &targets);
    assert!(goal.distance(TARGET_POS + slots::offset(&s, true, 5)) < 1e-4);
    assert!((repath - 2.0).abs() <= 1e-5, "half the air spacing");
}

#[test]
fn chase_goal_slot_disabled_is_the_target_position_and_the_given_repath_distance() {
    let targets = surround_targets(NavSurround::default());
    let slot = NavSurroundSlot { enabled: false, ..holder(TARGET, false, 3) };
    assert_eq!(slots::chase_goal(Some(&slot), &chase(10.0), TARGET_POS, &targets), (TARGET_POS, 10.0));
}

#[test]
fn chase_goal_slot_on_another_target_is_the_target_position_and_the_given_repath_distance() {
    let targets = surround_targets(NavSurround::default());
    assert_eq!(slots::chase_goal(Some(&holder(OTHER, false, 3)), &chase(10.0), TARGET_POS, &targets), (TARGET_POS, 10.0));
}

#[test]
fn chase_goal_target_no_longer_surroundable_is_the_target_position() {
    let mut targets = surround_targets(NavSurround::default());
    targets.entry(TARGET).surround = None;
    assert_eq!(slots::chase_goal(Some(&holder(TARGET, false, 3)), &chase(10.0), TARGET_POS, &targets), (TARGET_POS, 10.0));
}

#[test]
fn chase_goal_agent_without_a_slot_component_is_the_target_position() {
    let targets = surround_targets(NavSurround::default());
    assert_eq!(slots::chase_goal(None, &chase(10.0), TARGET_POS, &targets), (TARGET_POS, 10.0));
}
