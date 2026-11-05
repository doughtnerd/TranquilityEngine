//! Surround slots: `NavSurroundSystem` and `NavSurroundJobs` (the slot layout is [`crate::surround_slots`]).
//!
//! A host target with [`NavSurround`] is surrounded instead of stacked on: agents chasing it claim a slot once they're
//! within `claim_distance` and head for the slot instead of the target's position ([`surround_slots::chase_goal`],
//! read by the repath steps). Walkers get rings on the ground, flyers shells in the air. Group members claim for the
//! target their group's body chases (when the group's `surround` is on); group bodies don't claim.
//!
//! [`update`] runs before routes and both repaths, in Foxfire's job order:
//!
//! 1. `NavSurroundReleaseJob`: agents holding a slot that stopped chasing altogether (and aren't group members) turn
//!    their slot off, which frees it (a holder whose slot is off, or names another slot, counts as free; holders aren't
//!    cleared).
//! 2. `NavSurroundRequestJob` (chasers that aren't members or bodies) and `NavGroupSurroundRequestJob` (members): one
//!    holding a slot keeps it while it still chases that target, the target is still surroundable and the agent is
//!    within [`RELEASE_DISTANCE`] x `claim_distance` of it (`NavSurroundHold`); one without asks once it's within
//!    `claim_distance`. Staggered as Foxfire's chunk jobs: rows are taken in blocks of [`STAGGER_ROWS`] (an archetype
//!    chunk's worth) and each block is visited one tick in [`REQUEST_EVERY`].
//! 3. `NavSurroundClaimJob`: requests sorted by target then agent, at most [`CLAIMS_PER_FRAME`] claims a tick, each
//!    agent taking the free usable slot cheapest to reach from the direction it comes from (inner rings first, then
//!    the arc round), skipping ground slots off every loaded navmesh of its type and air slots outside free flight
//!    space. `Target::holders` grows to 2 x `max_slots` on the first claim.
//!
//! Surround slots attach to host targets only (`world.rs`): an agent chasing another agent never claims.
use crate::agents::{AgentKind, AgentStore};
use crate::components::{NavSurround, NavSurroundSlot};
use crate::ids::{AgentId, TargetId, TargetRef};
use crate::surround_slots;
use crate::tick::Frame;
use crate::world::Targets;
use nav_math::math;
use nav_math::Float3;
use nav_query::filter::NavMeshQueryFilter;

/// `NavSurroundSystem.ClaimsPerFrame`.
pub const CLAIMS_PER_FRAME: usize = 256;
/// `NavSurroundRequestJob.RequestEvery`: ticks between visits to each block of chasers (a power of two).
pub const REQUEST_EVERY: i32 = 4;
/// `NavSurroundHold.ReleaseDistance`: slots are let go this far out, as a multiple of `claim_distance`.
pub const RELEASE_DISTANCE: f32 = 1.25;
/// Rows per stagger block (stands in for Foxfire's archetype chunk index in the request jobs).
pub const STAGGER_ROWS: usize = 128;

/// `NavSurroundRequest`: an agent asking for a slot this tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurroundRequest {
    pub agent: AgentId,
    pub target: TargetId,
    pub target_position: Float3,
    /// From the target to the agent: it takes the free slot nearest this.
    pub direction: Float3,
    /// Walkers: how far a ground slot may be from the navmesh.
    pub snap_distance: f32,
    /// The agent's snapshot entry: whose agent type checks the slot.
    pub entry: i32,
    pub air: bool,
}

/// Why slots were passed over in the last claim pass (Foxfire's `NavPerfCounter.SurroundSlot*`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SurroundCounters {
    pub requests: usize,
    pub taken: usize,
    pub no_chunk: usize,
    pub off_mesh: usize,
    pub too_far: usize,
    pub air_blocked: usize,
}

/// The surround step's state between ticks.
#[derive(Clone, Debug, Default)]
pub struct SurroundSystems {
    /// Claims granted last tick.
    pub claims: usize,
    /// `_frame`: staggers requests.
    pub frame: i32,
    /// Last tick's counters.
    pub counters: SurroundCounters,
    requests: Vec<SurroundRequest>,
}

/// `NavSurroundSystem.OnUpdate`.
pub fn update(sys: &mut SurroundSystems, agents: &mut AgentStore, targets: &mut Targets, frame: &Frame) {
    if !targets.iter().any(|(_, t)| t.surround.is_some()) {
        return; // RequireForUpdate<NavSurround>
    }
    release(agents);
    sys.requests.clear();
    let chaser_frame = sys.frame;
    sys.frame = sys.frame.wrapping_add(1);
    request_chasers(&mut sys.requests, agents, targets, chaser_frame);
    request_members(&mut sys.requests, agents, targets, sys.frame);
    let mut requests = std::mem::take(&mut sys.requests);
    let (claims, counters) = claim(&mut requests, agents, targets, frame, CLAIMS_PER_FRAME);
    sys.requests = requests;
    sys.claims = claims;
    sys.counters = counters;
}

fn member_on(agents: &AgentStore, r: usize) -> bool {
    agents.data[r].group_member.is_some_and(|m| m.enabled)
}

fn slot_on(agents: &AgentStore, r: usize) -> bool {
    agents.data[r].surround_slot.is_some_and(|s| s.enabled)
}

/// `NavSurroundReleaseJob`: holding a slot, no longer chasing, not a member.
fn release(agents: &mut AgentStore) {
    for r in agents.active_rows().collect::<Vec<_>>() {
        if slot_on(agents, r) && agents.data[r].goal_target.is_none() && !member_on(agents, r) {
            if let Some(s) = agents.data[r].surround_slot.as_mut() {
                s.enabled = false;
            }
        }
    }
}

/// `NavSurroundHold.Keeps`.
pub fn keeps(slot: &NavSurroundSlot, target: Option<TargetRef>, position: Float3, targets: &Targets) -> bool {
    if Some(slot.target) != target {
        return false;
    }
    let TargetRef::Target(id) = slot.target else { return false };
    let Some(t) = targets.get(id) else { return false };
    let Some(surround) = t.surround else { return false };
    let reach = RELEASE_DISTANCE * surround.claim_distance;
    position.distance_sq(t.position) <= reach * reach
}

/// The block's turn this tick (`((unfilteredChunkIndex + Frame) & (RequestEvery - 1)) == 0`).
fn turn(row: usize, frame: i32) -> bool {
    (((row / STAGGER_ROWS) as i32).wrapping_add(frame) & (REQUEST_EVERY - 1)) == 0
}

/// The surround target (and its settings and position) an agent at `position` may ask for a slot at: within its
/// claim distance.
fn claimable(target: TargetRef, position: Float3, targets: &Targets) -> Option<(TargetId, NavSurround, Float3)> {
    let TargetRef::Target(id) = target else { return None };
    let t = targets.get(id)?;
    let surround = t.surround?;
    let to_agent = position - t.position;
    (to_agent.length_sq() <= surround.claim_distance * surround.claim_distance).then_some((id, surround, t.position))
}

fn snap_distance(agents: &AgentStore, r: usize) -> f32 {
    agents.data[r].walk.as_ref().map_or(0.0, |w| w.settings.max_snap_distance)
}

/// `NavSurroundRequestJob`: chasers that aren't group members or group bodies.
fn request_chasers(requests: &mut Vec<SurroundRequest>, agents: &mut AgentStore, targets: &Targets, frame: i32) {
    for r in agents.active_rows().collect::<Vec<_>>() {
        let d = &agents.data[r];
        let (Some(chase), Some(slot)) = (d.goal_target, d.surround_slot) else { continue };
        if member_on(agents, r) || d.group.is_some() || !turn(r, frame) {
            continue;
        }
        let position = agents.position[r];
        if slot.enabled {
            if !keeps(&slot, Some(chase.target), position, targets) {
                agents.data[r].surround_slot.as_mut().unwrap().enabled = false;
            }
            continue;
        }
        let entry = agents.chunk[r].entry;
        if entry < 0 {
            continue; // its chunk isn't loaded: paused
        }
        let Some((target, _, target_position)) = claimable(chase.target, position, targets) else { continue };
        let walker = d.kind.walks();
        let air = !walker || (d.kind == AgentKind::WalkFly && d.route.as_deref().is_some_and(|x| x.flying));
        if air && !d.kind.flies() {
            continue;
        }
        requests.push(SurroundRequest {
            agent: agents.id_of(r).unwrap(),
            target,
            target_position,
            direction: position - target_position,
            snap_distance: snap_distance(agents, r),
            entry,
            air,
        });
    }
}

/// `NavGroupSurroundRequestJob`: group members (on), for the target their group's body chases.
fn request_members(requests: &mut Vec<SurroundRequest>, agents: &mut AgentStore, targets: &Targets, frame: i32) {
    for r in agents.active_rows().collect::<Vec<_>>() {
        let Some(member) = agents.data[r].group_member.filter(|m| m.enabled) else { continue };
        if !turn(r, frame) {
            continue;
        }
        let target = agents
            .row(member.group)
            .and_then(|g| {
                let body = &agents.data[g];
                body.group.as_deref().filter(|x| x.group.surround).and(body.goal_target)
            })
            .map(|c| c.target);
        let position = agents.position[r];
        let d = &agents.data[r];
        if let Some(slot) = d.surround_slot.filter(|s| s.enabled) {
            if !keeps(&slot, target, position, targets) {
                agents.data[r].surround_slot.as_mut().unwrap().enabled = false;
            }
            continue;
        }
        let entry = agents.chunk[r].entry;
        let Some(target) = target else { continue };
        if member.slot < 0 || entry < 0 {
            continue; // not in yet, paused
        }
        let Some((target, _, target_position)) = claimable(target, position, targets) else { continue };
        // Walk-and-fly members: the kind of slot they can stand in now; taking off or landing (both on), wait.
        let route = d.route.as_deref();
        let flying = d.kind == AgentKind::WalkFly && route.is_some_and(|x| x.flying);
        if flying && route.is_some_and(|x| x.walking) {
            continue;
        }
        let air = !d.kind.walks() || flying;
        if air && !d.kind.flies() {
            continue;
        }
        requests.push(SurroundRequest {
            agent: agents.id_of(r).unwrap(),
            target,
            target_position,
            direction: position - target_position,
            snap_distance: snap_distance(agents, r),
            entry,
            air,
        });
    }
}

/// `NavSurroundClaimJob.Execute`: hands out the requested slots in a fixed order, at most `budget`. Returns the claims
/// and the counters.
pub fn claim(requests: &mut [SurroundRequest], agents: &mut AgentStore, targets: &mut Targets, frame: &Frame, budget: usize) -> (usize, SurroundCounters) {
    requests.sort_by(|a, b| a.target.cmp(&b.target).then(a.agent.index().cmp(&b.agent.index())));
    let mut counters = SurroundCounters { requests: requests.len(), ..SurroundCounters::default() };

    // Once a request finds no slot on a target, the rest asking for the same kind there this tick would find the same.
    let mut claims = 0;
    let mut full_target: Option<TargetId> = None;
    let (mut full_ground, mut full_air) = (false, false);
    for request in requests.iter() {
        if claims >= budget {
            break;
        }
        if Some(request.target) != full_target {
            full_target = Some(request.target);
            full_ground = false;
            full_air = false;
        }
        if if request.air { full_air } else { full_ground } {
            continue;
        }
        let Some(t) = targets.get_mut(request.target) else { continue };
        let Some(surround) = t.surround else { continue };
        let max = surround.max_slots.clamp(1, i16::MAX as i32);
        if t.holders.len() < 2 * max as usize {
            t.holders.resize(2 * max as usize, None);
        }

        let slot = pick(request, &surround, max, &t.holders, agents, frame, &mut counters);
        if slot < 0 {
            if request.air {
                full_air = true;
            } else {
                full_ground = true;
            }
            continue;
        }

        t.holders[(if request.air { max } else { 0 } + slot) as usize] = Some(request.agent);
        if let Some(r) = agents.row(request.agent) {
            agents.data[r].surround_slot = Some(NavSurroundSlot { target: TargetRef::Target(request.target), index: slot as i16, air: request.air, enabled: true });
        }
        claims += 1;
    }
    (claims, counters)
}

/// `Pick`: the free, usable slot cheapest to reach from where the agent comes in: ring r costs r x spacing, plus the
/// arc from its approach direction round to the slot. -1 if none is free.
fn pick(request: &SurroundRequest, surround: &NavSurround, max: i32, holders: &[Option<AgentId>], agents: &AgentStore, frame: &Frame, counters: &mut SurroundCounters) -> i32 {
    let air = request.air;
    let spacing = surround_slots::spacing(surround, air);
    let angle = request.direction.z.atan2(request.direction.x);
    let toward = request.direction.normalize_safe(Float3::new(0.0, 1.0, 0.0));
    let mut best = -1;
    let mut best_cost = f32::MAX;
    let mut first = 0;
    let mut ring = 0;
    while first < max && (ring as f32) * spacing < best_cost {
        let count = surround_slots::count(surround, air, ring);
        let radius = surround_slots::ring_radius(surround, air, ring);
        let (slot, off) = if air {
            nearest_on_shell(request, surround, toward, first, count, max, holders, agents, frame, counters)
        } else {
            nearest_on_ring(request, surround, angle, ring, first, count, max, holders, agents, frame, counters)
        };
        let cost = ring as f32 * spacing + off * radius;
        if slot >= 0 && cost < best_cost {
            best = slot;
            best_cost = cost;
        }
        first += count;
        ring += 1;
    }
    best
}

/// `NearestOnRing` (claim job): the free, usable slot on a ring nearest the approach angle, and how far round
/// (radians); (-1, 0) if none.
#[allow(clippy::too_many_arguments)]
fn nearest_on_ring(
    request: &SurroundRequest,
    surround: &NavSurround,
    angle: f32,
    ring: i32,
    first: i32,
    count: i32,
    max: i32,
    holders: &[Option<AgentId>],
    agents: &AgentStore,
    frame: &Frame,
    counters: &mut SurroundCounters,
) -> (i32, f32) {
    // Nearest first: the slot the angle rounds to, then alternately the next one on the side the angle leans towards
    // and the one on the other side.
    let step = 2.0 * math::PI / count as f32;
    let position = angle / step - 0.5 * (ring & 1) as f32;
    let nearest = math::round(position) as i32;
    let side = if position >= nearest as f32 { 1 } else { -1 };
    for d in 0..count {
        let k = nearest + if d & 1 == 1 { side * ((d + 1) / 2) } else { -side * (d / 2) };
        let slot = first + ((k % count) + count) % count;
        if slot >= max || !free(request, slot, max, holders, agents, counters) || !usable(request, surround, slot, frame, counters) {
            continue;
        }
        return (slot, math::abs(k as f32 - position) * step);
    }
    (-1, 0.0)
}

/// `NearestOnShell`: the free, usable slot on a shell nearest the approach direction, and the angle between; (-1, 0)
/// if none.
#[allow(clippy::too_many_arguments)]
fn nearest_on_shell(
    request: &SurroundRequest,
    surround: &NavSurround,
    toward: Float3,
    first: i32,
    count: i32,
    max: i32,
    holders: &[Option<AgentId>],
    agents: &AgentStore,
    frame: &Frame,
    counters: &mut SurroundCounters,
) -> (i32, f32) {
    let mut best = -1;
    let mut best_dot = f32::MIN;
    let mut k = 0;
    while k < count && first + k < max {
        let dot = surround_slots::on_shell(k, count).dot(toward);
        if dot > best_dot && free(request, first + k, max, holders, agents, counters) && usable(request, surround, first + k, frame, counters) {
            best = first + k;
            best_dot = dot;
        }
        k += 1;
    }
    (best, if best >= 0 { math::clamp(best_dot, -1.0, 1.0).acos() } else { 0.0 })
}

/// `Free`: no agent holds the slot: nobody took it, or its holder is gone or no longer holds it.
fn free(request: &SurroundRequest, slot: i32, max: i32, holders: &[Option<AgentId>], agents: &AgentStore, counters: &mut SurroundCounters) -> bool {
    let Some(holder) = holders[(if request.air { max } else { 0 } + slot) as usize] else { return true };
    let Some(r) = agents.row(holder) else { return true };
    let Some(held) = agents.data[r].surround_slot.filter(|s| s.enabled) else { return true };
    let free = held.target != TargetRef::Target(request.target) || held.air != request.air || held.index as i32 != slot;
    if !free {
        counters.taken += 1;
    }
    free
}

/// `Usable`: the slot is somewhere the agent can be: on a navmesh (ground) or in free flight space (air) of its agent
/// type, in whichever loaded chunk the slot is in.
fn usable(request: &SurroundRequest, surround: &NavSurround, slot: i32, frame: &Frame, counters: &mut SurroundCounters) -> bool {
    let snapshot = frame.world.snapshot();
    if request.entry < 0 || request.entry as usize >= snapshot.entries.len() {
        return false;
    }
    let at = request.target_position + surround_slots::offset(surround, request.air, slot);
    let agent_type = snapshot.entries[request.entry as usize].agent_type;
    let spacing = surround_slots::spacing(surround, request.air);
    let reach = math::max(request.snap_distance, 0.5 * spacing);
    let mut filter = NavMeshQueryFilter::zeroed();
    filter.allowed_bins = u64::MAX;
    let (mut in_chunk, mut near_mesh) = (false, false);
    let r3 = Float3::splat(reach);
    for entry in &snapshot.entries {
        let (lo, hi) = (entry.bounds_min - r3, entry.bounds_max + r3);
        if entry.agent_type != agent_type || at.x < lo.x || at.y < lo.y || at.z < lo.z || at.x > hi.x || at.y > hi.y || at.z > hi.z {
            continue;
        }
        in_chunk = true;
        if request.air {
            if entry.volume.as_deref().is_some_and(|v| nav_query::volume::leaf_at(v, at) >= 0) {
                return true;
            }
            continue;
        }
        let Some(nav) = entry.nav.as_deref() else { continue };
        let Some((_, nearest)) = nav_query::pathfinding::find_nearest_poly(nav, at, reach, &filter) else { continue };
        near_mesh = true;
        if (nearest - at).xz().length_sq() <= 0.25 * spacing * spacing {
            return true; // the navmesh is there, not just nearby
        }
    }

    if !in_chunk {
        counters.no_chunk += 1;
    } else if request.air {
        counters.air_blocked += 1;
    } else if !near_mesh {
        counters.off_mesh += 1;
    } else {
        counters.too_far += 1;
    }
    false
}
