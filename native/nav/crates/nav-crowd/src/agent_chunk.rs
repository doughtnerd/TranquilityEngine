//! Which chunk entry each agent uses (Foxfire's `NavAgentChunkSystem`), and the warning for agent types nothing is
//! baked for (`NavAgentTypeCheckSystem`).
//!
//! [`assign_chunks`] visits only agents with `chunk_pending` set: new agents, agents whose chunk isn't loaded (retried
//! every tick), and every agent once whenever the snapshot's entries change ([`ChunkWorld::entry_signature`]). An
//! agent with a chunk keeps it (and pauses, entry -1, while it's unloaded) unless a loaded bounded chunk's box holds it
//! (its own was rebaked under another id); an agent without one takes the chunk of its type whose bounds hold it, else
//! the nearest, but a chunk with Chunk Bounds only if its box holds the agent in x and z. A walker (that doesn't also
//! fly) whose chunk has an overlay takes the overlay's entry if the polygon under it is one the overlay replaced.
use crate::agents::AgentStore;
use crate::chunks::ChunkWorld;
use crate::settings::AgentTypes;
use crate::warnings::Warnings;
use nav_math::{Float3, Hash128};
use nav_query::chunks::NavChunks;
use nav_query::filter::NavMeshQueryFilter;
use nav_query::pathfinding::find_nearest_poly;
use std::collections::BTreeSet;

/// `NavAgentTypeCheckSystem.CheckFrames`: ticks between checks.
pub const TYPE_CHECK_TICKS: u64 = 120;

/// The agent-chunk step's state between ticks.
#[derive(Clone, Debug, Default)]
pub struct AgentChunkState {
    signature: Option<u64>,
    /// Agent types already warned about (walking, flying): warned again only after they load and go missing again.
    warned_walk: BTreeSet<Hash128>,
    warned_fly: BTreeSet<Hash128>,
    /// Counters: resolves done and agents left waiting, last tick.
    pub resolved: usize,
    pub waiting: usize,
}

/// `NavAgentChunkSystem.OnUpdate`: marks everyone pending when the entries changed, then resolves pending agents.
pub fn assign_chunks(state: &mut AgentChunkState, agents: &mut AgentStore, world: &ChunkWorld) {
    let signature = world.entry_signature();
    if state.signature != Some(signature) {
        state.signature = Some(signature);
        for r in agents.live_rows().collect::<Vec<_>>() {
            agents.chunk_pending[r] = true;
        }
    }
    state.resolved = 0;
    state.waiting = 0;
    let chunks = world.snapshot();
    for r in agents.live_rows().collect::<Vec<_>>() {
        if !agents.chunk_pending[r] || agents.data[r].disabled {
            continue;
        }
        let entry = locate(agents, r, chunks);
        agents.chunk_pending[r] = entry < 0;
        if entry < 0 {
            state.waiting += 1;
        } else {
            state.resolved += 1;
        }
    }
}

/// `LocateAgentChunkJob.Execute` for one agent: sets its chunk and entry, returns the entry.
fn locate(agents: &mut AgentStore, r: usize, chunks: &NavChunks) -> i32 {
    let agent_type = agents.data[r].agent_type;
    let p = agents.position[r];
    let current = agents.chunk[r];
    if current.chunk.is_valid() {
        let mut entry = chunks.find(current.chunk, agent_type, false).map_or(-1, |e| e as i32);
        let mut chunk = current.chunk;
        if entry < 0 {
            // Its chunk isn't loaded, but a loaded chunk's box holds it: that's its chunk now (boxes don't overlap).
            if let Some(holder) = holding(chunks, agent_type, p) {
                chunk = chunks.entries[holder].chunk;
                entry = holder as i32;
            }
        }
        if entry >= 0 {
            entry = on_overlay(agents, r, entry as usize, chunks) as i32;
        }
        agents.chunk[r].chunk = chunk;
        agents.chunk[r].entry = entry;
        return entry;
    }

    // No chunk yet: the one whose bounds hold the agent (distance 0), else the nearest; bounded chunks only if their box
    // holds it in x and z.
    let mut best: i32 = -1;
    let mut best_distance = f32::MAX;
    for (i, e) in chunks.entries.iter().enumerate() {
        if e.agent_type != agent_type || e.overlay {
            continue;
        }
        let mut outside = (e.bounds_min - p).max(p - e.bounds_max).max(Float3::splat(0.0));
        if e.bounded {
            if outside.x > 0.0 || outside.z > 0.0 {
                continue;
            }
            outside.y = 0.0;
        }
        let d = outside.length_sq();
        if d >= best_distance {
            continue;
        }
        best_distance = d;
        best = i as i32;
    }
    if best >= 0 {
        agents.chunk[r].chunk = chunks.entries[best as usize].chunk;
        agents.chunk[r].entry = on_overlay(agents, r, best as usize, chunks) as i32;
    } else {
        agents.chunk[r].entry = -1;
    }
    agents.chunk[r].entry
}

/// `Holding`: the entry of a loaded bounded chunk of this type whose box holds `p` (x and z).
fn holding(chunks: &NavChunks, agent_type: Hash128, p: Float3) -> Option<usize> {
    chunks.entries.iter().position(|e| {
        e.agent_type == agent_type
            && !e.overlay
            && e.bounded
            && p.x >= e.bounds_min.x
            && p.z >= e.bounds_min.z
            && p.x <= e.bounds_max.x
            && p.z <= e.bounds_max.z
    })
}

/// `OnOverlay`: the chunk's overlay entry if this walker stands on a polygon the overlay replaced, else `own`. Agents
/// that walk and fly stay on the chunk's own entry (their landing links are its polygons).
fn on_overlay(agents: &AgentStore, r: usize, own: usize, chunks: &NavChunks) -> usize {
    let entry = &chunks.entries[own];
    let Some(nav) = entry.nav.as_deref() else { return own };
    if entry.switched_off_count == 0 {
        return own;
    }
    let data = &agents.data[r];
    let Some(walk) = &data.walk else { return own };
    if data.route.is_some() {
        return own;
    }
    let Some(overlay) = chunks.find(entry.chunk, entry.agent_type, true) else { return own };
    let s = agents.surface[r];
    let at = if s.initialized { s.surface_position } else { agents.position[r] };
    let filter = NavMeshQueryFilter::default_for(walk.settings.radius); // not switched off: which polygon is it on?
    match find_nearest_poly(nav, at, walk.settings.max_snap_distance.max(0.5), &filter) {
        Some((poly, _)) if chunks.switched_off_of(own).get(poly as usize).copied().unwrap_or(false) => overlay,
        _ => own,
    }
}

/// `NavAgentTypeCheckSystem.OnUpdate` (every [`TYPE_CHECK_TICKS`] ticks): warns once per agent type whose walkers have
/// no navmesh, or whose flyers no flight volume, in any loaded chunk.
pub fn check_agent_types(state: &mut AgentChunkState, tick: u64, agents: &AgentStore, world: &ChunkWorld, types: &AgentTypes, warnings: &mut Warnings) {
    if !tick.is_multiple_of(TYPE_CHECK_TICKS) {
        return;
    }
    let chunks = world.snapshot();
    for t in types.iter() {
        let walkers = agents.live_rows().filter(|&r| agents.data[r].agent_type == t.id && agents.data[r].walk.is_some()).count();
        let flyers = agents.live_rows().filter(|&r| agents.data[r].agent_type == t.id && agents.data[r].flight.is_some()).count();
        let has_nav = chunks.entries.iter().any(|e| e.agent_type == t.id && e.nav.is_some());
        let has_volume = chunks.entries.iter().any(|e| e.agent_type == t.id && e.volume.is_some());
        check(&mut state.warned_walk, t.id, &t.name, walkers, has_nav, "walk", "navmesh", warnings);
        check(&mut state.warned_fly, t.id, &t.name, flyers, has_volume, "fly", "flight volume", warnings);
    }
}

#[allow(clippy::too_many_arguments)]
fn check(warned: &mut BTreeSet<Hash128>, id: Hash128, name: &str, agents: usize, baked: bool, verb: &str, what: &str, warnings: &mut Warnings) {
    if agents == 0 || baked {
        warned.remove(&id); // loaded (or no such agents): warn again if it goes missing
        return;
    }
    if !warned.insert(id) {
        return;
    }
    warnings.warn_text(format!(
        "Navigation [{}]: {agents} agents that {verb} with agent type '{name}' ({id}) can't move: no {what} for that type is loaded in any chunk. \
         List the type under the agent types its chunks bake (and not under a chunk's skipped agent types), and rebake those scenes.",
        warnings.label()
    ));
}
