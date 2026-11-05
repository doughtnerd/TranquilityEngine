//! The chunk-level steps: what's loaded, gates, overlays, seams, the snapshot every step reads, and the route graphs
//! (Foxfire's `NavChunks`/`NavChunksCacheSystem`, `NavGateSystem`, `NavOverlaySystem`, `NavSeamSystem` and
//! `NavRouteGraphSystem`).
//!
//! In Myco a chunk is a scene's bake; the host adds and removes them as scenes load and unload
//! ([`crate::Crowd::load_chunk`] / [`crate::Crowd::unload_chunk`], ADR 0065's *Streaming*). Each tick
//! [`ChunkWorld::update`] runs, in Foxfire's `OrderFirst` order:
//!
//! 1. **Gates** ([`crate::gates`]): new tables sync, changed gates apply.
//! 2. **Overlays** (`NavOverlaySystem`, `UpdateBefore(NavSeamSystem)`): when the loaded set changed, the snapshot is
//!    gathered, `OverlayManager::plan` decides which overlays to build and which go, each scheduled build runs
//!    (`nav_bake::overlay::build_overlay`) and is collected, and the snapshot is gathered again with the new overlays
//!    (until planning settles). **Foxfire builds overlays in the background over several frames; here they're built
//!    synchronously in the tick that needs them** (a bounded chunk's edge tiles: milliseconds). The manager's
//!    plan/collect split is kept, so a later wave can move builds to a worker (a pending build simply isn't collected
//!    until it's done).
//! 3. **Seams** (`NavSeamSystem`): `SeamSet::update`, which restitches only when the snapshot's seam signature changed.
//!
//! [`ChunkWorld::update_route_graphs`] (`NavRouteGraphSystem`, later in the tick) rebuilds the route graphs when the
//! snapshot or seams changed and the cache says they're stale, and otherwise copies changed gate states into them.
//!
//! **The snapshot** (`NavChunks`) is gathered only when what it holds changes: the loaded set, the overlays, or (by
//! patching it in place) the gate states. `NavChunks::gather` copies every navmesh out of the files, so gathering
//! every tick, as Foxfire's `Gather` does from its blob pointers, would be far too slow; its `NavChunksCache` is the
//! same idea. Every step reads [`ChunkWorld::snapshot`]; entry indices are only valid until it changes
//! ([`ChunkUpdate::snapshot_changed`]), which is when the agent-chunk step re-resolves every agent.
use crate::components::DataKey;
use crate::gates::GateTables;
use crate::warnings::Warnings;
use nav_bake::overlay::{build_overlay, OverlayInput as BuildInput, OverlayNeighbour};
use nav_math::hash::FingerprintHasher;
use nav_math::Hash128;
use nav_query::chunks::{LoadedChunk, NavChunks};
use nav_query::costs::CostVolume;
use nav_query::flow::{FlowSeam, FlowSeams};
use nav_query::overlay::{NavOverlayLink, OverlayBuilt, OverlayManager, OverlayPlan};
use nav_query::route_graph::{OverlayJoins, RouteGraphCache, RouteGraphs, SeamInput};
use nav_query::seams::{nav_identity, SeamSet};
use std::collections::BTreeMap;

/// What one tick's chunk steps did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChunkUpdate {
    /// The snapshot was gathered again: entry indices changed.
    pub snapshot_changed: bool,
    /// Gate states changed (the snapshot was patched; route graphs refreshed).
    pub gates_changed: bool,
    pub overlays_built: usize,
    pub overlays_removed: usize,
    pub overlay_failures: usize,
    pub seams_changed: bool,
    pub graphs_rebuilt: bool,
    /// Gathers this tick (0 when nothing changed).
    pub gathers: usize,
    /// Runtime cost volumes changed a polygon's or leaf's cost (ADR 0070): entries' `last_cost_change` is this tick's
    /// time and the snapshot's `cost_changed` says which polygons.
    pub costs_changed: bool,
}

/// Counters over the crowd's life (for tests and the debug panel).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChunkStats {
    pub gathers: u64,
    pub seam_rebuilds: u64,
    pub overlay_builds: u64,
    pub graph_rebuilds: u64,
}

/// The loaded chunks and everything built from them (see the module doc).
#[derive(Debug, Default)]
pub struct ChunkWorld {
    loaded: BTreeMap<Hash128, LoadedChunk>,
    pub gates: GateTables,
    pub overlays: OverlayManager,
    pub seams: SeamSet,
    pub graphs: RouteGraphCache,
    snapshot: NavChunks,
    /// By snapshot entry: its navmesh's and volume's [`DataKey`].
    nav_keys: Vec<DataKey>,
    volume_keys: Vec<DataKey>,
    /// What the agent-chunk step resolves against: the entries' (chunk, agent type) and overlays' identities.
    entry_signature: u64,
    seam_inputs: Vec<SeamInput>,
    overlay_joins: Vec<OverlayJoins>,
    flow_seams: Vec<FlowSeams>,
    flow_seams_version: i32,
    loaded_dirty: bool,
    /// Bumped by every load and unload.
    pub loaded_version: u32,
    /// Bumped by every gather.
    pub snapshot_version: u32,
    /// Runtime cost volumes (ADR 0070), as the host last set them, and whether the snapshot's tables are behind.
    cost_volumes: Vec<CostVolume>,
    costs_dirty: bool,
    /// Bumped whenever the snapshot's cost tables change.
    pub cost_version: u32,
    pub stats: ChunkStats,
}

impl ChunkWorld {
    pub fn new() -> Self {
        Self { flow_seams_version: -1, ..Self::default() }
    }

    /// Adds a chunk (a scene's bake); a chunk already loaded under its id is replaced (rebaked). Takes effect on the
    /// next tick.
    pub fn load(&mut self, chunk: LoadedChunk) {
        self.gates.load(chunk.id, &chunk.file);
        self.loaded.insert(chunk.id, chunk);
        self.loaded_dirty = true;
        self.loaded_version = self.loaded_version.wrapping_add(1);
    }

    /// Removes a chunk; false if it wasn't loaded. Takes effect on the next tick.
    pub fn unload(&mut self, id: Hash128) -> bool {
        if self.loaded.remove(&id).is_none() {
            return false;
        }
        self.gates.unload(id);
        self.loaded_dirty = true;
        self.loaded_version = self.loaded_version.wrapping_add(1);
        true
    }

    /// The loaded chunks, by id.
    pub fn loaded(&self) -> impl Iterator<Item = &LoadedChunk> {
        self.loaded.values()
    }

    pub fn loaded_count(&self) -> usize {
        self.loaded.len()
    }

    pub fn is_loaded(&self, id: Hash128) -> bool {
        self.loaded.contains_key(&id)
    }

    /// Replaces the runtime cost volumes (ADR 0070). The snapshot's tables follow on the next tick; one-shot queries
    /// read [`ChunkWorld::cost_volumes`] at once.
    pub fn set_cost_volumes(&mut self, volumes: Vec<CostVolume>) {
        if volumes != self.cost_volumes {
            self.cost_volumes = volumes;
            self.costs_dirty = true;
        }
    }

    /// The runtime cost volumes as last set.
    pub fn cost_volumes(&self) -> &[CostVolume] {
        &self.cost_volumes
    }

    /// This tick's snapshot (valid after [`ChunkWorld::update`]).
    pub fn snapshot(&self) -> &NavChunks {
        &self.snapshot
    }

    /// The [`DataKey`] of an entry's navmesh (0 if it has none or the index is out of range).
    pub fn nav_key(&self, entry: i32) -> DataKey {
        usize::try_from(entry).ok().and_then(|e| self.nav_keys.get(e)).copied().unwrap_or(0)
    }

    /// The [`DataKey`] of an entry's flight volume.
    pub fn volume_key(&self, entry: i32) -> DataKey {
        usize::try_from(entry).ok().and_then(|e| self.volume_keys.get(e)).copied().unwrap_or(0)
    }

    /// What agents' entry indices depend on (`NavAgentChunkSystem`'s signature).
    pub fn entry_signature(&self) -> u64 {
        self.entry_signature
    }

    /// The seams as the route graphs take them.
    pub fn seam_inputs(&self) -> &[SeamInput] {
        &self.seam_inputs
    }

    /// The standing overlays' joins, as the route graphs take them.
    pub fn overlay_joins(&self) -> &[OverlayJoins] {
        &self.overlay_joins
    }

    /// The agent type's route graphs, if it needs them (more than one navmesh or volume, or unloaded space around).
    pub fn route_graphs(&self, agent_type: Hash128) -> Option<&RouteGraphs> {
        self.graphs.get(agent_type)
    }

    /// The chunk steps of a tick (see the module doc): gates, then overlays and the snapshot, then seams.
    pub fn update(&mut self, time: f64, warnings: &mut Warnings) -> ChunkUpdate {
        let mut up = ChunkUpdate::default();
        let gates_changed = self.gates.apply(time);

        let mut before: Option<NavChunks> = None;
        if self.loaded_dirty {
            self.loaded_dirty = false;
            before = Some(std::mem::take(&mut self.snapshot));
            // Plan, build and collect until planning settles: a collected overlay changes the snapshot (its entry), and
            // planning again for that snapshot schedules nothing (its key stands) but keeps the manager's signature in
            // step. Two rounds normally; three covers a replacement dropping an old overlay.
            for _ in 0..3 {
                self.gather(&mut up);
                let planning = self.overlays.plan(&self.snapshot);
                up.overlays_removed += planning.removed;
                let mut collected = 0;
                for plan in &planning.schedule {
                    match build_planned(&self.snapshot, plan) {
                        Some(built) => {
                            let base = self.snapshot.entries[plan.entry].nav.clone().expect("planned with a navmesh");
                            if self.overlays.collect(plan, built, &base, time) {
                                collected += 1;
                            }
                        }
                        None => {
                            self.overlays.cancel(plan.key);
                            up.overlay_failures += 1;
                            warnings.warn_text(format!(
                                "Navigation [{}]: the overlay of chunk {} for agent type {} couldn't be built (its border data or tile ranges are missing); its edge stays as baked.",
                                warnings.label(),
                                plan.chunk,
                                plan.agent_type
                            ));
                        }
                    }
                }
                up.overlays_built += collected;
                if planning.removed == 0 && collected == 0 {
                    break;
                }
            }
            self.stats.overlay_builds += up.overlays_built as u64;
            self.overlay_joins = self.overlays.overlays.iter().map(OverlayJoins::from).collect();
            if up.overlays_built > 0 || up.overlays_removed > 0 {
                warnings.log(format!(
                    "Navigation [{}]: overlays: {} built, {} removed, {} standing.",
                    warnings.label(),
                    up.overlays_built,
                    up.overlays_removed,
                    self.overlays.overlays.len()
                ));
            }
        } else if gates_changed {
            self.patch_gates();
        }
        up.gates_changed = gates_changed;

        // Runtime cost volumes (ADR 0070): new tables when the volumes or the snapshot changed.
        if self.costs_dirty || up.snapshot_changed {
            self.costs_dirty = false;
            let change = self.snapshot.apply_cost_volumes(&self.cost_volumes, before.as_ref(), time);
            if change.any() {
                up.costs_changed = true;
                self.cost_version = self.cost_version.wrapping_add(1);
            }
        }

        if up.snapshot_changed {
            let s = self.seams.update(&self.snapshot);
            if s.changed {
                up.seams_changed = true;
                self.stats.seam_rebuilds += 1;
                self.seam_inputs = self.seams.seams.iter().map(SeamInput::from).collect();
                let mut text = format!(
                    "Navigation [{}]: seams: {} ({} new, {} kept, {} removed), {} navmesh links, {} flight links.",
                    warnings.label(),
                    self.seams.seams.len(),
                    s.built,
                    s.kept,
                    s.removed,
                    s.poly_links,
                    s.leaf_links
                );
                for line in &self.seams.report {
                    text.push_str("\n  ");
                    text.push_str(line);
                }
                warnings.log(text);
            }
        }
        up
    }

    /// `NavRouteGraphSystem`: rebuilds the graphs if what they're built from changed, else refreshes their gate states.
    pub fn update_route_graphs(&mut self, up: &mut ChunkUpdate, warnings: &mut Warnings) {
        let mut rebuilt = false;
        if (up.snapshot_changed || up.seams_changed) && self.graphs.stale(&self.snapshot, &self.seam_inputs, &self.overlay_joins) {
            self.graphs.rebuild(&self.snapshot, &self.seam_inputs, &self.overlay_joins);
            self.stats.graph_rebuilds += 1;
            rebuilt = true;
            warnings.log(self.graphs.describe(&format!("NavRoutes [{}]", warnings.label())));
        }
        if !rebuilt && (up.gates_changed || up.snapshot_changed || up.costs_changed) {
            let types: Vec<Hash128> = self.graphs.types().to_vec();
            for t in types {
                if let Some(g) = self.graphs.get_mut(t) {
                    g.refresh_gates(&self.snapshot);
                    if up.costs_changed || up.snapshot_changed {
                        g.refresh_costs(&self.snapshot);
                    }
                }
            }
        }
        up.graphs_rebuilt = rebuilt;
    }

    /// Every agent type's seams and overlay joins for the flow fields (`FlowSeams`), from the route graphs' links, as
    /// of the last [`ChunkWorld::refresh_flow_seams`].
    pub fn flow_seams(&self) -> &[FlowSeams] {
        &self.flow_seams
    }

    /// Remakes [`ChunkWorld::flow_seams`] if the graphs were rebuilt since.
    pub fn refresh_flow_seams(&mut self) {
        if self.flow_seams_version != self.graphs.version {
            self.flow_seams_version = self.graphs.version;
            self.flow_seams = self
                .graphs
                .types()
                .iter()
                .filter_map(|&t| self.graphs.get(t))
                .map(|g| FlowSeams {
                    agent_type: g.agent_type,
                    version: self.graphs.version,
                    links: g
                        .links
                        .iter()
                        .map(|l| {
                            let (from, to) = (&g.graphs[l.from_graph as usize], &g.graphs[l.to_graph as usize]);
                            FlowSeam {
                                from_chunk: from.chunk,
                                from_overlay: from.overlay,
                                from_poly: l.from_poly,
                                to_chunk: to.chunk,
                                to_overlay: to.overlay,
                                to_poly: l.to_poly,
                                a0: l.a0,
                                a1: l.a1,
                                b0: l.b0,
                                b1: l.b1,
                            }
                        })
                        .collect(),
                })
                .collect();
        }
    }

    /// Gathers the snapshot from the loaded chunks, their gate states and the standing overlays, and works out the
    /// entries' data keys and the entry signature.
    fn gather(&mut self, up: &mut ChunkUpdate) {
        let loaded: Vec<LoadedChunk> = self.loaded.values().cloned().collect();
        let gates = &self.gates;
        self.snapshot = NavChunks::gather(&loaded, &|c| gates.state(c), &self.overlays.inputs());
        self.snapshot_version = self.snapshot_version.wrapping_add(1);
        self.stats.gathers += 1;
        up.gathers += 1;
        up.snapshot_changed = true;

        self.nav_keys.clear();
        self.volume_keys.clear();
        let mut sig = FingerprintHasher::new();
        sig.value(self.snapshot.entries.len() as u64);
        for e in &self.snapshot.entries {
            let mut h = FingerprintHasher::new();
            h.value(e.chunk).value(e.agent_type).value(e.signature).value(e.overlay as u8);
            if e.overlay {
                // An overlay is identified by what it is, and when it came (a replacement is a new navmesh).
                h.value(e.nav.as_deref().map_or(0, nav_identity)).value(e.last_gate_change.to_bits());
            }
            let base = h.finish();
            self.nav_keys.push(if e.nav.is_some() { FingerprintHasher::with_seed(base).value(1u8).finish() | 1 } else { 0 });
            self.volume_keys.push(if e.volume.is_some() { FingerprintHasher::with_seed(base).value(2u8).finish() | 1 } else { 0 });
            sig.value(e.chunk).value(e.agent_type).value(e.overlay as u8);
            if e.overlay {
                sig.value(base);
            }
        }
        self.entry_signature = sig.finish();
    }

    /// Copies the gate tables' states into the snapshot without gathering again (gate-only changes).
    fn patch_gates(&mut self) {
        let snapshot = &mut self.snapshot;
        for i in 0..snapshot.entries.len() {
            let e = &snapshot.entries[i];
            if e.overlay || e.gate_count == 0 {
                continue;
            }
            let Some(table) = self.gates.table(e.chunk) else { continue };
            let (start, n) = (e.gate_start, e.gate_count.min(table.closed.len()));
            let last = table.last_change;
            snapshot.closed_gates[start..start + n].copy_from_slice(&table.closed[..n]);
            // An overlay that came later than the gate change still counts (gather takes the later of the two).
            let e = &mut snapshot.entries[i];
            e.last_gate_change = e.last_gate_change.max(last);
        }
    }
}

/// Builds the overlay a plan calls for, from the snapshot it was planned on (`NavOverlaySystem.Schedule` and the
/// build job, run at once). None if the chunk's border or navmesh can't make one.
fn build_planned(snapshot: &NavChunks, plan: &OverlayPlan) -> Option<OverlayBuilt> {
    let entry = &snapshot.entries[plan.entry];
    let border = entry.border.as_deref()?;
    let base = entry.nav.as_deref()?;
    let neighbours: Vec<OverlayNeighbour> = plan
        .neighbours
        .iter()
        .filter_map(|n| snapshot.entries[n.entry].border.as_deref().map(|b| OverlayNeighbour { border: b, face: n.face, profile: n.profile }))
        .collect();
    let out = build_overlay(&BuildInput { border, profile: plan.profile, base, neighbours: &neighbours })?;
    Some(OverlayBuilt {
        nav: out.nav,
        tile_origins: out.tile_origins,
        links: out
            .links
            .iter()
            .map(|l| NavOverlayLink { base_poly: l.base_poly, overlay_poly: l.overlay_poly, a0: l.a0, a1: l.a1, b0: l.b0, b1: l.b1 })
            .collect(),
        open_sides: out.open_sides,
    })
}
