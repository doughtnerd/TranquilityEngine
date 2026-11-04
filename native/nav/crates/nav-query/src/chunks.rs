//! The loaded chunks (Foxfire's `NavChunks`, `NavChunkEntry`): one entry per (chunk, agent type) with
//! that chunk's navmesh, flight volume and landing links for the agent type (any may be missing), its
//! gate states (a range of [`NavChunks::closed_gates`], indexed by `NavPoly` gate id), and when they
//! last changed.
//!
//! A chunk with an overlay has a second entry for it (`overlay` set): its navmesh is the overlay's,
//! with no gates, volume or links. The chunk's own entry then has the overlay's tiles switched off (a
//! range of [`NavChunks::switched_off`], by polygon), and agents standing on those tiles use the
//! overlay's entry.
//!
//! In Myco a chunk is a scene's bake (`myco.nav@1`, ADR 0065). Foxfire takes entries in ECS query order;
//! here [`NavChunks::gather`] sorts them by (chunk id, agent type, overlay), so the snapshot, and every
//! seam, route graph and route built from it, doesn't depend on the order scenes were loaded.
use nav_format::blob::{NavChunkBorderData, NavLandingLinksData, NavMeshData, NavVolumeData};
use nav_format::file::BakeFile;
use nav_math::{Float3, Hash128};
use std::sync::Arc;

/// One scene's bake, as loaded: the file, and the chunk id the runtime gave it (`nav_bake::output::chunk_id`
/// of the scene path and chunk node id).
#[derive(Clone, Debug)]
pub struct LoadedChunk {
    pub id: Hash128,
    pub file: Arc<BakeFile>,
    /// Chunk Bounds: the chunk's box (it joins neighbours at shared faces). Otherwise its contents' bounds.
    pub bounds_min: Float3,
    pub bounds_max: Float3,
    pub bounded: bool,
    /// The file's sections, shared: each copied once when the chunk loads, so every gather (and every agent
    /// type's entry) shares them instead of copying the navmeshes again.
    pub sections: Arc<ChunkSections>,
}

/// A loaded chunk's sections behind `Arc`s, by group (see [`LoadedChunk::sections`]).
#[derive(Clone, Debug, Default)]
pub struct ChunkSections {
    pub navmeshes: Vec<(u32, Arc<NavMeshData>)>,
    pub volumes: Vec<(u32, Arc<NavVolumeData>)>,
    /// (walking group, flying group, links).
    pub landing_links: Vec<(u32, u32, Arc<NavLandingLinksData>)>,
    pub border: Option<Arc<NavChunkBorderData>>,
}

impl ChunkSections {
    pub fn of(file: &BakeFile) -> Self {
        Self {
            navmeshes: file.navmeshes.iter().map(|n| (n.group, Arc::new(n.data.clone()))).collect(),
            volumes: file.volumes.iter().map(|v| (v.group, Arc::new(v.data.clone()))).collect(),
            landing_links: file.landing_links.iter().map(|l| (l.ground_group, l.air_group, Arc::new(l.data.clone()))).collect(),
            border: file.chunk_border.clone().map(Arc::new),
        }
    }
}

impl LoadedChunk {
    /// A loaded chunk with bounds given by the caller (tests, or a host that knows them).
    pub fn with_bounds(id: Hash128, file: Arc<BakeFile>, bounds_min: Float3, bounds_max: Float3, bounded: bool) -> Self {
        let sections = Arc::new(ChunkSections::of(&file));
        Self { id, file, bounds_min, bounds_max, bounded, sections }
    }

    /// A loaded chunk with its bounds worked out from the file: the chunk info's flag and box when the file has
    /// one (every bake writes it, so a fly-only bounded chunk, which bakes no border, is still bounded). Without
    /// it (older files): the chunk border's box for a bounded chunk, else the union of its navmeshes' vertices
    /// and volumes' boxes.
    pub fn new(id: Hash128, file: Arc<BakeFile>) -> Self {
        if let Some(info) = file.chunk_info {
            return Self::with_bounds(id, file, info.box_min, info.box_max, info.bounded != 0);
        }
        if let Some((min, max)) = file.chunk_border.as_ref().map(|b| (b.box_min, b.box_max)) {
            return Self::with_bounds(id, file, min, max, true);
        }
        let mut min = Float3::splat(f32::INFINITY);
        let mut max = Float3::splat(f32::NEG_INFINITY);
        for n in &file.navmeshes {
            for v in &n.data.verts {
                min = min.min(*v);
                max = max.max(*v);
            }
        }
        for v in &file.volumes {
            let d = &v.data;
            let size = Float3::new(d.dims.x as f32, d.dims.y as f32, d.dims.z as f32) * d.cell_size;
            min = min.min(d.origin);
            max = max.max(d.origin + size);
        }
        if min.x > max.x {
            min = Float3::default();
            max = Float3::default();
        }
        Self::with_bounds(id, file, min, max, false)
    }
}

/// What one chunk has for one agent type (`NavChunkEntry`).
#[derive(Clone, Debug, Default)]
pub struct ChunkEntry {
    pub chunk: Hash128,
    pub agent_type: Hash128,
    /// The bake's input signature (`BakeFile::signature`). Overlay entries keep the base file's signature; their
    /// identity differs by `overlay`.
    pub signature: Hash128,
    pub nav: Option<Arc<NavMeshData>>,
    pub volume: Option<Arc<NavVolumeData>>,
    pub links: Option<Arc<NavLandingLinksData>>,
    /// Chunk Bounds: what overlays rebuild the chunk's edge from.
    pub border: Option<Arc<NavChunkBorderData>>,
    pub bounds_min: Float3,
    pub bounds_max: Float3,
    /// Chunk Bounds: the bounds are the chunk's box, and it joins neighbours at shared faces.
    pub bounded: bool,
    pub gate_start: usize,
    pub gate_count: usize,
    pub last_gate_change: f64,
    pub overlay: bool,
    pub switched_off_start: usize,
    pub switched_off_count: usize,
}

impl ChunkEntry {
    /// The bounds as text, for logs.
    pub fn bounds_text(&self) -> String {
        let (a, b) = (self.bounds_min, self.bounds_max);
        format!("[{:.2}, {:.2}, {:.2} .. {:.2}, {:.2}, {:.2}]", a.x, a.y, a.z, b.x, b.y, b.z)
    }
}

/// An overlay to include: a navmesh rebuilt across a chunk's edge for one agent type, replacing some of
/// the base chunk's polygons (built by the overlay module).
#[derive(Clone, Debug)]
pub struct OverlayInput {
    pub chunk: Hash128,
    pub agent_type: Hash128,
    pub nav: Arc<NavMeshData>,
    /// By base polygon: true if the overlay replaces it.
    pub switched_off: Vec<bool>,
    /// When the overlay came (it counts as a gate change for paths through the base chunk).
    pub created: f64,
}

/// A runtime change to a chunk's gates: its closed flags (by gate id; entry 0 unused) and when they changed.
#[derive(Clone, Debug, Default)]
pub struct GateState {
    pub closed: Vec<bool>,
    pub last_change: f64,
}

/// This frame's loaded chunks (`NavChunks`): one entry per (chunk, agent type) with a navmesh or a
/// flight volume, the agent types among them, and every chunk's gate states and switched-off masks
/// back to back.
#[derive(Clone, Debug, Default)]
pub struct NavChunks {
    pub entries: Vec<ChunkEntry>,
    pub agent_types: Vec<Hash128>,
    pub closed_gates: Vec<bool>,
    /// By polygon, back to back: chunks' polygons their overlays replace.
    pub switched_off: Vec<bool>,
}

impl NavChunks {
    /// Builds the snapshot from the loaded chunks, their current gate states (by chunk id; the bake's
    /// starting state where missing) and the overlays.
    pub fn gather(loaded: &[LoadedChunk], gates: &dyn Fn(Hash128) -> Option<GateState>, overlays: &[OverlayInput]) -> Self {
        let mut chunks: Vec<&LoadedChunk> = loaded.iter().collect();
        chunks.sort_by_key(|c| c.id);
        let mut out = NavChunks::default();
        for c in chunks {
            let file = &c.file;
            let Some(table) = &file.agent_table else { continue };
            // The chunk's gate states, shared by its agent types' entries.
            let state = gates(c.id);
            let baked: Vec<bool> = file.gate_table.as_ref().map(|t| t.closed.iter().map(|&b| b != 0).collect()).unwrap_or_default();
            let closed = state.as_ref().map(|s| s.closed.clone()).unwrap_or(baked);
            let gate_start = out.closed_gates.len();
            let gate_count = closed.len();
            out.closed_gates.extend(closed);
            let last_gate_change = state.map(|s| s.last_change).unwrap_or(0.0);
            let sections = &c.sections;
            let border = sections.border.clone();

            let mut agents = table.entries.clone();
            agents.sort_by_key(|a| a.id);
            for a in agents {
                let nav = (a.walk_group >= 0).then(|| sections.navmeshes.iter().find(|n| n.0 as i32 == a.walk_group).map(|n| &n.1)).flatten();
                let volume = (a.fly_group >= 0).then(|| sections.volumes.iter().find(|v| v.0 as i32 == a.fly_group).map(|v| &v.1)).flatten();
                if nav.is_none() && volume.is_none() {
                    continue;
                }
                let links = (a.walk_group >= 0 && a.fly_group >= 0)
                    .then(|| sections.landing_links.iter().find(|l| l.0 as i32 == a.walk_group && l.1 as i32 == a.fly_group).map(|l| &l.2))
                    .flatten();
                let overlay = overlays.iter().find(|o| o.chunk == c.id && o.agent_type == a.id);
                let mut entry = ChunkEntry {
                    chunk: c.id,
                    agent_type: a.id,
                    signature: file.signature,
                    nav: nav.cloned(),
                    volume: volume.cloned(),
                    links: links.cloned(),
                    border: border.clone(),
                    bounds_min: c.bounds_min,
                    bounds_max: c.bounds_max,
                    bounded: c.bounded,
                    gate_start,
                    gate_count,
                    last_gate_change,
                    ..ChunkEntry::default()
                };
                if let Some(o) = overlay {
                    entry.switched_off_start = out.switched_off.len();
                    entry.switched_off_count = o.switched_off.len();
                    out.switched_off.extend_from_slice(&o.switched_off);
                    entry.last_gate_change = entry.last_gate_change.max(o.created);
                }
                if !out.agent_types.contains(&a.id) {
                    out.agent_types.push(a.id);
                }
                out.entries.push(entry.clone());
                if let Some(o) = overlay {
                    out.entries.push(ChunkEntry {
                        nav: Some(o.nav.clone()),
                        volume: None,
                        links: None,
                        gate_start: 0,
                        gate_count: 0,
                        overlay: true,
                        switched_off_start: 0,
                        switched_off_count: 0,
                        last_gate_change: o.created,
                        ..entry
                    });
                }
            }
        }
        out.agent_types.sort();
        out
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The entry of `chunk` for `agent_type` (its overlay's with `overlay`), or None (`NavChunks.Find`).
    pub fn find(&self, chunk: Hash128, agent_type: Hash128, overlay: bool) -> Option<usize> {
        self.entries.iter().position(|e| e.chunk == chunk && e.agent_type == agent_type && e.overlay == overlay)
    }

    /// An entry's switched-off polygons (empty if none), `NavChunks.SwitchedOffOf`.
    pub fn switched_off_of(&self, entry: usize) -> &[bool] {
        let e = &self.entries[entry];
        &self.switched_off[e.switched_off_start..e.switched_off_start + e.switched_off_count]
    }

    /// An entry's gate states, by gate id, `NavChunks.GatesOf`.
    pub fn gates_of(&self, entry: usize) -> &[bool] {
        let e = &self.entries[entry];
        &self.closed_gates[e.gate_start..e.gate_start + e.gate_count]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_format::blob::{NavAgentEntry, NavAgentTableData, NavChunkInfo, NavGateTableData};
    use nav_format::file::NavMeshSection;

    fn file(agents: &[(u32, i32)], gates_closed: &[u8]) -> Arc<BakeFile> {
        let nav = NavMeshData { verts: vec![Float3::new(0.0, 0.0, 0.0), Float3::new(4.0, 1.0, 4.0)], ..NavMeshData::default() };
        Arc::new(BakeFile {
            navmeshes: vec![NavMeshSection { group: 0, data: nav }],
            agent_table: Some(NavAgentTableData {
                entries: agents.iter().map(|&(id, walk)| NavAgentEntry { id: Hash128::new(id, 0, 0, 0), walk_group: walk, fly_group: -1, pad: [0; 2] }).collect(),
            }),
            gate_table: Some(NavGateTableData { ids: vec![Hash128::default(); gates_closed.len()], closed: gates_closed.to_vec() }),
            ..BakeFile::default()
        })
    }

    #[test]
    fn entries_per_chunk_and_agent_type_independent_of_load_order() {
        let a = LoadedChunk::new(Hash128::new(2, 0, 0, 0), file(&[(7, 0), (3, 0), (9, -1)], &[0, 1]));
        let b = LoadedChunk::new(Hash128::new(1, 0, 0, 0), file(&[(3, 0)], &[0]));
        let no_gates = |_: Hash128| None;
        let one = NavChunks::gather(&[a.clone(), b.clone()], &no_gates, &[]);
        let two = NavChunks::gather(&[b, a], &no_gates, &[]);
        let key = |c: &NavChunks| c.entries.iter().map(|e| (e.chunk, e.agent_type, e.gate_start)).collect::<Vec<_>>();
        assert_eq!(key(&one), key(&two));
        assert_eq!(one.len(), 3, "agent 9 can't walk and the chunk has no volume");
        assert_eq!(one.agent_types, vec![Hash128::new(3, 0, 0, 0), Hash128::new(7, 0, 0, 0)]);
        let e = one.find(Hash128::new(2, 0, 0, 0), Hash128::new(7, 0, 0, 0), false).unwrap();
        assert_eq!(one.gates_of(e), &[false, true]);
        assert_eq!(one.entries[e].bounds_max, Float3::new(4.0, 1.0, 4.0));
    }

    #[test]
    fn fly_only_bounded_chunk_is_bounded_through_chunk_info() {
        let mut f = (*file(&[(3, 0)], &[])).clone();
        f.signature = Hash128::new(9, 8, 7, 6);
        f.chunk_info = Some(NavChunkInfo { box_min: Float3::new(-8.0, 0.0, -8.0), box_max: Float3::new(8.0, 4.0, 8.0), bounded: 1, pad: 0 });
        assert!(f.chunk_border.is_none());
        let c = LoadedChunk::new(Hash128::new(1, 0, 0, 0), Arc::new(f));
        assert!(c.bounded);
        assert_eq!((c.bounds_min, c.bounds_max), (Float3::new(-8.0, 0.0, -8.0), Float3::new(8.0, 4.0, 8.0)));
        let s = NavChunks::gather(&[c], &|_| None, &[]);
        assert!(s.entries[0].bounded);
        assert_eq!(s.entries[0].signature, Hash128::new(9, 8, 7, 6));
        // Without chunk info and border the chunk is unbounded, as before.
        assert!(!LoadedChunk::new(Hash128::new(2, 0, 0, 0), file(&[(3, 0)], &[])).bounded);
    }

    #[test]
    fn runtime_gate_states_and_overlays_take_effect() {
        let id = Hash128::new(5, 0, 0, 0);
        let c = LoadedChunk::new(id, file(&[(3, 0)], &[0, 0]));
        let gates = move |chunk: Hash128| (chunk == id).then(|| GateState { closed: vec![false, true], last_change: 4.0 });
        let overlay = OverlayInput { chunk: id, agent_type: Hash128::new(3, 0, 0, 0), nav: Arc::new(NavMeshData::default()), switched_off: vec![true, false], created: 6.0 };
        let s = NavChunks::gather(&[c], &gates, &[overlay]);
        assert_eq!(s.len(), 2);
        let base = s.find(id, Hash128::new(3, 0, 0, 0), false).unwrap();
        let over = s.find(id, Hash128::new(3, 0, 0, 0), true).unwrap();
        assert_eq!(s.gates_of(base), &[false, true]);
        assert_eq!(s.switched_off_of(base), &[true, false]);
        assert_eq!(s.entries[base].last_gate_change, 6.0);
        assert!(s.gates_of(over).is_empty() && s.switched_off_of(over).is_empty());
    }
}
