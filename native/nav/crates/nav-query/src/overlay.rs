//! The runtime planning of overlays (Foxfire's `Systems/NavOverlaySystem.cs` and `Components/NavOverlayComponents.cs`),
//! everything except the rebuild itself (`nav_bake::overlay::build_overlay`).
//!
//! A chunk with Chunk Bounds and border data that has a loaded neighbour across a side face gets an overlay for each
//! agent type: its edge tiles facing the neighbours, rebuilt with the neighbours' border geometry (the transition
//! geometry past the shared face), as a navmesh of its own. [`plan_overlays`] works out which (chunk, agent type)
//! pairs call for one, with each one's neighbours (in chunk order, so the key doesn't depend on load order), open
//! sides and key (what it is built from: the chunk, its navmesh and border, and each neighbour's border and face).
//! [`OverlayManager`] is the system's state: the overlays that stand, the keys wanted and the builds in flight. It
//! schedules a build only for a key that has neither, drops an overlay as soon as its chunk unloads, is rebaked or
//! has no loaded neighbour left (others stay until their replacement is built, so a chunk is never without one in
//! between), and hands [`NavChunks::gather`] the standing overlays with their switched-off masks.
//!
//! Foxfire compares blob pointers; a snapshot here has none that last, so [`crate::seams::nav_identity`] and
//! [`crate::seams::border_identity`] (content hashes) stand in. They cost a pass over the data: call the planner
//! when the loaded set changes ([`overlay_signature`] is the cheap-enough change test), not every frame, or cache
//! them by `Arc`.
use crate::chunks::{NavChunks, OverlayInput};
use crate::seams::{border_identity, nav_identity, shared_face};
use nav_format::blob::{NavChunkBorderData, NavChunkFace, NavMeshData};
use nav_math::hash::hash_value;
use nav_math::{Float3, Hash128, Int2};
use std::sync::Arc;

const KEY_SEED: u64 = 0x0FE7;
const SIG_SEED: u64 = 0x0E7;

/// `NavOverlayTile`: a base tile the overlay replaces, the grid column (x, z) of its interior corner
/// (`NavTileRange::origin`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavOverlayTile {
    pub origin: Int2,
}

/// `NavOverlayLink`: a join between an overlay and the rest of its chunk's navmesh, on the inner line: `base_poly`
/// (a kept polygon of the base) to `overlay_poly` (of the overlay's navmesh). `a0`-`a1` is the stretch on the base
/// polygon's edge, `b0`-`b1` on the overlay polygon's (`b0` pairs with `a0`). The same shape as
/// `nav_bake::overlay::OverlayLink`, which the build makes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavOverlayLink {
    pub base_poly: i32,
    pub overlay_poly: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
}

/// A neighbour across one of a chunk's faces, for one agent type (`Neighbour`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverlayNeighbourRef {
    /// Index of the neighbour's entry in the [`NavChunks`] planned from.
    pub entry: usize,
    /// The chunk's face the neighbour lies across.
    pub face: NavChunkFace,
    /// The neighbour's profile index for the agent type.
    pub profile: usize,
}

/// One overlay the loaded chunks call for.
#[derive(Clone, Debug, PartialEq)]
pub struct OverlayPlan {
    /// The chunk's base entry in the [`NavChunks`] planned from.
    pub entry: usize,
    pub chunk: Hash128,
    pub agent_type: Hash128,
    /// What the overlay is built from: the chunk, its navmesh and border, and each neighbour with its face.
    pub key: u64,
    /// The chunk's profile index for the agent type.
    pub profile: usize,
    /// Faces with a loaded neighbour, bits by `NavChunkFace`.
    pub open_sides: i32,
    /// The neighbours, in chunk id order.
    pub neighbours: Vec<OverlayNeighbourRef>,
}

/// The border profile an agent type was built with (`ProfileOf`), or None if the border has none for it.
pub fn profile_of(border: &NavChunkBorderData, agent_type: Hash128) -> Option<usize> {
    border.agents.iter().find(|a| a.agent_type == agent_type).map(|a| a.profile as usize)
}

/// The signature of what planning depends on: entries' ids, agent types, bounds, navmeshes and borders
/// (`NavOverlaySystem.Signature`). Independent of the order of the entries; changes only when the loaded set
/// does.
pub fn overlay_signature(chunks: &NavChunks) -> u64 {
    let mut h = chunks.len() as u64;
    for e in &chunks.entries {
        let mut x = hash_value([e.chunk, e.agent_type], SIG_SEED);
        x = hash_value([e.bounds_min, e.bounds_max], x);
        x = hash_value(e.bounded as i32 | (e.overlay as i32) << 1, x);
        x = hash_value(e.nav.as_deref().map(nav_identity).unwrap_or(0), x);
        x = hash_value(e.border.as_deref().map(border_identity).unwrap_or(0), x);
        h = h.wrapping_add(x);
    }
    h
}

/// The overlays `chunks` calls for: every non-overlay, bounded entry with a navmesh and a border whose agent type
/// has a profile, that has at least one neighbour (another chunk of the same agent type, bounded, with navmesh,
/// border and profile) sharing a side face. Sorted by (chunk, agent type).
pub fn plan_overlays(chunks: &NavChunks) -> Vec<OverlayPlan> {
    let mut order: Vec<usize> = (0..chunks.entries.len()).filter(|&i| !chunks.entries[i].overlay).collect();
    order.sort_by_key(|&i| (chunks.entries[i].chunk, chunks.entries[i].agent_type));
    let mut plans = Vec::new();
    for &a in &order {
        let entry = &chunks.entries[a];
        let (Some(nav), Some(border)) = (&entry.nav, &entry.border) else { continue };
        if !entry.bounded {
            continue;
        }
        let Some(profile) = profile_of(border, entry.agent_type) else { continue };

        let mut neighbours: Vec<OverlayNeighbourRef> = Vec::new();
        for &b in &order {
            let other = &chunks.entries[b];
            if b == a || other.chunk == entry.chunk || other.agent_type != entry.agent_type {
                continue;
            }
            let (true, Some(_), Some(other_border)) = (other.bounded, &other.nav, &other.border) else { continue };
            let Some((face, _, _)) = shared_face(entry.bounds_min, entry.bounds_max, other.bounds_min, other.bounds_max) else { continue };
            let Some(other_profile) = profile_of(other_border, entry.agent_type) else { continue };
            neighbours.push(OverlayNeighbourRef { entry: b, face, profile: other_profile });
        }
        if neighbours.is_empty() {
            continue;
        }
        // Entries may come in any order: key the neighbours in chunk order, so the key doesn't depend on it.
        neighbours.sort_by_key(|n| (chunks.entries[n.entry].chunk, n.face.0));

        let mut key = hash_value([entry.chunk, entry.agent_type], KEY_SEED);
        key = hash_value([nav_identity(nav), border_identity(border)], key);
        let mut open_sides = 0;
        for n in &neighbours {
            let other_border = chunks.entries[n.entry].border.as_deref().expect("planned with a border");
            key = hash_value([border_identity(other_border), n.face.0 as u64], key);
            open_sides |= 1 << n.face.0;
        }
        plans.push(OverlayPlan { entry: a, chunk: entry.chunk, agent_type: entry.agent_type, key, profile, open_sides, neighbours });
    }
    plans
}

/// `NavSwitchedOff.Create`: the mask of `base`'s polygons in the tiles whose interior corners are `origins`
/// (the overlay's [`NavOverlayTile`]s).
pub fn switched_off_mask(base: &NavMeshData, origins: &[Int2]) -> Vec<bool> {
    let mut polys = vec![false; base.polys.len()];
    for range in &base.tile_ranges {
        if !origins.contains(&range.origin) {
            continue;
        }
        for p in range.poly_start..range.poly_start + range.poly_count {
            polys[p as usize] = true;
        }
    }
    polys
}

/// A standing overlay (`NavOverlay` with its buffers).
#[derive(Clone, Debug)]
pub struct OverlayRecord {
    pub chunk: Hash128,
    pub agent_type: Hash128,
    /// What it was built from ([`OverlayPlan::key`]).
    pub key: u64,
    /// The identity of the chunk's navmesh it overlays: a rebaked chunk's overlay goes.
    pub base_id: u64,
    pub nav: Arc<NavMeshData>,
    /// Faces with a loaded neighbour, bits by `NavChunkFace`.
    pub open_sides: i32,
    /// Time it was made: the chunk's paths made before then may cross replaced tiles.
    pub created: f64,
    /// The base tiles it replaces.
    pub tiles: Vec<NavOverlayTile>,
    /// Its joins to the rest of the base.
    pub links: Vec<NavOverlayLink>,
    /// The base's polygons it replaces.
    pub switched_off: Vec<bool>,
}

/// A finished build, as [`OverlayManager::collect`] takes it.
#[derive(Clone, Debug, Default)]
pub struct OverlayBuilt {
    pub nav: NavMeshData,
    /// The replaced tiles' interior corners (`nav_bake::overlay::OverlayOutput::tile_origins`).
    pub tile_origins: Vec<Int2>,
    pub links: Vec<NavOverlayLink>,
    pub open_sides: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pending {
    chunk: Hash128,
    agent_type: Hash128,
    key: u64,
}

/// What [`OverlayManager::plan`] decided.
#[derive(Clone, Debug, Default)]
pub struct OverlayPlanning {
    /// The overlays to start building: wanted, and neither standing nor in flight with the same key.
    pub schedule: Vec<OverlayPlan>,
    /// How many standing overlays went (unloaded, rebaked, or no loaded neighbour left).
    pub removed: usize,
}

/// `NavOverlaySystem`'s state: standing overlays, the keys the loaded chunks call for, builds in flight.
#[derive(Clone, Debug, Default)]
pub struct OverlayManager {
    pub overlays: Vec<OverlayRecord>,
    wanted: Vec<u64>,
    pending: Vec<Pending>,
    signature: Option<u64>,
}

impl OverlayManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// The signature of the snapshot last planned for.
    pub fn signature(&self) -> Option<u64> {
        self.signature
    }

    /// Builds in flight (scheduled, not yet collected).
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn overlay(&self, chunk: Hash128, agent_type: Hash128) -> Option<&OverlayRecord> {
        self.overlays.iter().find(|o| o.chunk == chunk && o.agent_type == agent_type)
    }

    /// Plans for `chunks` if its signature changed (else nothing happens): which overlays to schedule, and which
    /// standing ones go now. Scheduled plans count as in flight until [`collect`](Self::collect) or
    /// [`cancel`](Self::cancel). Plan before collecting: a chunk that unloaded this frame is no longer wanted, so
    /// a build for it is dropped instead of collected against its released navmesh.
    pub fn plan(&mut self, chunks: &NavChunks) -> OverlayPlanning {
        let signature = overlay_signature(chunks);
        if self.signature == Some(signature) {
            return OverlayPlanning::default();
        }
        self.signature = Some(signature);
        let plans = plan_overlays(chunks);
        self.wanted = plans.iter().map(|p| p.key).collect();
        let mut schedule = Vec::new();
        for plan in &plans {
            let have = self.overlays.iter().any(|o| o.key == plan.key) || self.pending.iter().any(|p| p.key == plan.key);
            if !have {
                self.pending.push(Pending { chunk: plan.chunk, agent_type: plan.agent_type, key: plan.key });
                schedule.push(plan.clone());
            }
        }

        // Overlays whose chunk no longer wants one (unloaded, rebaked, or no loaded neighbour) go now. Others stay
        // until their replacement is built, so the chunk is never without one in between.
        let before = self.overlays.len();
        self.overlays.retain(|o| {
            let wanted = plans.iter().any(|p| p.chunk == o.chunk && p.agent_type == o.agent_type);
            let current = chunks.find(o.chunk, o.agent_type, false).and_then(|e| chunks.entries[e].nav.as_deref().map(nav_identity));
            wanted && current == Some(o.base_id)
        });
        OverlayPlanning { schedule, removed: before - self.overlays.len() }
    }

    /// A build finished for the plan with `key`. It becomes the overlay of its chunk and agent type (replacing the
    /// previous one) if its key is still wanted; returns whether it did, else the build is dropped (superseded
    /// while it built). `base` is the chunk's navmesh the overlay replaces tiles of (for the switched-off mask);
    /// `now` is the world time.
    pub fn collect(&mut self, plan: &OverlayPlan, built: OverlayBuilt, base: &NavMeshData, now: f64) -> bool {
        self.pending.retain(|p| p.key != plan.key);
        if !self.wanted.contains(&plan.key) {
            return false;
        }
        self.overlays.retain(|o| !(o.chunk == plan.chunk && o.agent_type == plan.agent_type));
        let switched_off = switched_off_mask(base, &built.tile_origins);
        self.overlays.push(OverlayRecord {
            chunk: plan.chunk,
            agent_type: plan.agent_type,
            key: plan.key,
            base_id: nav_identity(base),
            tiles: built.tile_origins.iter().map(|&origin| NavOverlayTile { origin }).collect(),
            nav: Arc::new(built.nav),
            open_sides: built.open_sides,
            created: now,
            links: built.links,
            switched_off,
        });
        self.overlays.sort_by_key(|o| (o.chunk, o.agent_type));
        true
    }

    /// A scheduled build won't finish (the caller dropped it).
    pub fn cancel(&mut self, key: u64) {
        self.pending.retain(|p| p.key != key);
    }

    /// The standing overlays as [`NavChunks::gather`] takes them.
    pub fn inputs(&self) -> Vec<OverlayInput> {
        self.overlays
            .iter()
            .map(|o| OverlayInput { chunk: o.chunk, agent_type: o.agent_type, nav: o.nav.clone(), switched_off: o.switched_off.clone(), created: o.created })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_format::blob::{NavBorderAgent, NavTileRange};

    #[test]
    fn switched_off_marks_the_polygons_of_the_replaced_tiles() {
        let nav = NavMeshData {
            polys: vec![Default::default(); 6],
            tile_ranges: vec![
                NavTileRange { origin: Int2::new(0, 0), poly_start: 0, poly_count: 2 },
                NavTileRange { origin: Int2::new(64, 0), poly_start: 2, poly_count: 3 },
                NavTileRange { origin: Int2::new(128, 0), poly_start: 5, poly_count: 1 },
            ],
            ..NavMeshData::default()
        };
        let mask = switched_off_mask(&nav, &[Int2::new(64, 0), Int2::new(128, 0)]);
        assert_eq!(mask, vec![false, false, true, true, true, true]);
        assert_eq!(switched_off_mask(&nav, &[]), vec![false; 6]);
    }

    #[test]
    fn profile_lookup_by_agent_type() {
        let b = NavChunkBorderData {
            agents: vec![NavBorderAgent { agent_type: Hash128::new(7, 0, 0, 0), profile: 2 }],
            ..NavChunkBorderData::default()
        };
        assert_eq!(profile_of(&b, Hash128::new(7, 0, 0, 0)), Some(2));
        assert_eq!(profile_of(&b, Hash128::new(8, 0, 0, 0)), None);
    }
}
