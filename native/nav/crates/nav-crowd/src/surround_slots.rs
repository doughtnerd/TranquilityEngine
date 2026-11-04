//! Surround slot layout (Foxfire's `Runtime/Lib/NavSurroundSlots.cs`): where a [`NavSurround`] target's slots are, as
//! offsets from its position. Pure functions: slots aren't stored, so they move with the target and cost no memory.
//!
//! Ground slots: ring r has radius `radius + r x spacing` and as many slots as fit `spacing` apart along it (at least
//! one), odd rings turned half a step so slots sit between the previous ring's. Air slots: shell r likewise, with points
//! spread evenly over the sphere (a Fibonacci spiral), as many as fit about `air_spacing` apart. Slot indices run ring
//! by ring, inner first.
use crate::components::{NavSurround, NavSurroundSlot, PathGoalTarget};
use crate::ids::TargetRef;
use crate::world::Targets;
use nav_math::math::{self, PI};
use nav_math::Float3;

/// pi x (3 - sqrt 5).
#[allow(clippy::excessive_precision)]
const GOLDEN_ANGLE: f32 = 2.39996323;
/// Sphere area per point at spacing 1, packed hexagonally.
const HEX_AREA: f32 = 0.8660254;

/// `Spacing`: the ground spacing, or for air slots the air spacing if set; at least 0.01.
pub fn spacing(surround: &NavSurround, air: bool) -> f32 {
    math::max(if air && surround.air_spacing > 0.0 { surround.air_spacing } else { surround.spacing }, 0.01)
}

/// `RingRadius`.
pub fn ring_radius(surround: &NavSurround, air: bool, ring: i32) -> f32 {
    math::max(surround.radius, 0.0) + ring as f32 * spacing(surround, air)
}

/// `Count`: how many slots ring (air: shell) `ring` holds.
pub fn count(surround: &NavSurround, air: bool, ring: i32) -> i32 {
    let spacing = spacing(surround, air);
    let r = ring_radius(surround, air, ring);
    let n = if air { 4.0 * PI * r * r / (HEX_AREA * spacing * spacing) } else { 2.0 * PI * r / spacing };
    1.max(n as i32)
}

/// `Ring`: the ring (air: shell) `slot` is on, with that ring's first slot index and slot count.
pub fn ring(surround: &NavSurround, air: bool, slot: i32) -> (i32, i32, i32) {
    let mut first = 0;
    let mut ring = 0;
    loop {
        let count = count(surround, air, ring);
        if slot < first + count {
            return (ring, first, count);
        }
        first += count;
        ring += 1;
    }
}

/// `Offset`: the slot's offset from the target's position (ground slots level with it: paths snap them onto the
/// navmesh).
pub fn offset(surround: &NavSurround, air: bool, slot: i32) -> Float3 {
    let (ring, first, count) = ring(surround, air, slot);
    let r = ring_radius(surround, air, ring);
    (if air { on_shell(slot - first, count) } else { on_ring(slot - first, count, ring) }) * r
}

/// `OnRing`: point k of n on a unit ring (level), odd rings turned half a step.
pub fn on_ring(k: i32, n: i32, ring: i32) -> Float3 {
    let angle = (k as f32 + 0.5 * (ring & 1) as f32) * (2.0 * PI / n as f32);
    let (s, c) = angle.sin_cos();
    Float3::new(c, 0.0, s)
}

/// `NearestOnRing`: the slot on a ring (k of `count`) nearest the level direction `angle` (radians from +x towards
/// +z).
pub fn nearest_on_ring(angle: f32, count: i32, ring: i32) -> i32 {
    let k = math::round(angle / (2.0 * PI / count as f32) - 0.5 * (ring & 1) as f32) as i32;
    ((k % count) + count) % count
}

/// `OnShell`: point k of n spread evenly over a unit sphere (a Fibonacci spiral from top to bottom).
pub fn on_shell(k: i32, n: i32) -> Float3 {
    let y = 1.0 - 2.0 * (k as f32 + 0.5) / n as f32;
    let r = math::max(0.0, 1.0 - y * y).sqrt();
    let (s, c) = (k as f32 * GOLDEN_ANGLE).sin_cos();
    Float3::new(c * r, y, s * r)
}

/// `ChaseGoal`: where an agent chasing `chase.target` should head, given the target's position: its surround slot if
/// it holds one on that target (`slot` enabled and naming it, the target a host target with a [`NavSurround`]), else
/// the target's position. Returns the goal and the repath distance: `chase.repath_distance`, but at most half a slot's
/// spacing while it holds one, so it re-aims as soon as it claims and doesn't end up in a neighbour's slot.
pub fn chase_goal(slot: Option<&NavSurroundSlot>, chase: &PathGoalTarget, target_position: Float3, targets: &Targets) -> (Float3, f32) {
    let repath_distance = chase.repath_distance;
    let Some(slot) = slot.filter(|s| s.enabled && s.target == chase.target) else { return (target_position, repath_distance) };
    let TargetRef::Target(id) = chase.target else { return (target_position, repath_distance) };
    let Some(surround) = targets.get(id).and_then(|t| t.surround) else { return (target_position, repath_distance) };
    (target_position + offset(&surround, slot.air, slot.index as i32), math::min(repath_distance, 0.5 * spacing(&surround, slot.air)))
}
