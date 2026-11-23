//! Feature `matching`: pose databases and motion-matching state (wire family `match`; `match` is a
//! Rust keyword). Filled by T42 (node half).
//!
//! - `posedb_load(bytes)`: a `myco.posedb@1` file becomes an arena asset ([`PoseDbAsset`]: the
//!   search-ready `anim_match::MatchDb`, built once here, and a clip handle per database clip).
//!   Refused (`STATUS_BAD_ASSET`) when it doesn't parse or its KD-tree is malformed,
//!   `STATUS_TOO_LARGE` past `anim_graph::matching::MAX_QUERY_LANES` lanes of features.
//! - `posedb_bind(db, clip_index, clip)`: binds the database's clip `clip_index` (its `CLIPS`
//!   entry, whose asset reference `posedb_clip` returns) to a clip handle (0 unbinds). The node
//!   reads the table every update, so binding may come before or after instances exist.
//! - A graph names the database by a string id bound with `graph_bind`; the
//!   `anim-graph::matching` node does the rest.
//! - `match_debug_write(instance)`: the live debugger's records (wire family `match`).
//!
//! **The bake is not in the runtime module.** `anim_match::bake` allocates freely and pulls in the
//! offline statistics and KD-tree build, which only the editor needs. Phase B builds it for the
//! editor's bake worker as a separate wasm (a small `cdylib` over `anim-match` with its own
//! wasm-bindgen glue, like `anim-meter`'s loader build), so the shipped runtime doesn't carry it.

use anim_format::posedb::PoseDbView;
use anim_graph::dispatch::Family;
use anim_graph::matching::{self, MatchRef, MAX_QUERY_LANES};
use anim_match::MatchDb;
use anim_wire::core::{
    Init, STATUS_BAD_ASSET, STATUS_MISMATCH, STATUS_NOT_INITIALIZED, STATUS_OK, STATUS_TOO_LARGE,
    STATUS_WRONG_KIND,
};
use anim_match::Trajectory;
use anim_wire::r#match::{
    MatchHeader, MatchNode, MatchSample, MATCH_DEBUG_BYTES, SAMPLE_MATCHED, SAMPLE_PREDICTED,
};
use anim_wire::WireRecord;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::assets::{Arena, Asset};
use crate::init::{with, Core};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the match debug buffer (databases live in the arena).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    MATCH_DEBUG_BYTES as u64
}

/// A loaded pose database.
pub struct PoseDbAsset {
    pub db: MatchDb,
    /// A clip handle per database clip (0: unbound).
    pub clips: Vec<u32>,
    /// Each database clip's asset reference (`CLIPS`).
    pub names: Vec<String>,
}

/// The match debug buffer.
pub struct MatchBuffers {
    pub debug: Vec<u8>,
}

impl Default for MatchBuffers {
    fn default() -> Self {
        MatchBuffers {
            debug: vec![0; MATCH_DEBUG_BYTES as usize],
        }
    }
}

/// The database of `handle` as the graph sees it.
pub(crate) fn match_ref(arena: &Arena, handle: u32) -> Option<MatchRef<'_>> {
    match arena.get(handle) {
        Ok(Asset::PoseDb(p)) => Some(MatchRef {
            db: &p.db,
            clips: &p.clips,
        }),
        _ => None,
    }
}

fn load(arena: &mut Arena, bytes: &[u8]) -> Result<u32, u32> {
    let view = PoseDbView::parse(bytes).map_err(|_| STATUS_BAD_ASSET)?;
    let db = MatchDb::new(&view).map_err(|_| STATUS_BAD_ASSET)?;
    if db.lanes() > MAX_QUERY_LANES {
        return Err(STATUS_TOO_LARGE);
    }
    let strings = view.strings();
    let names: Vec<String> = view
        .clips()
        .iter()
        .map(|id| strings.get(id).unwrap_or("").to_string())
        .collect();
    arena.insert(Asset::PoseDb(PoseDbAsset {
        db,
        clips: vec![0; names.len()],
        names,
    }))
}

fn bind(arena: &mut Arena, db: u32, index: u32, clip: u32) -> u32 {
    if clip != 0 {
        if let Err(e) = arena.clip_asset(clip) {
            return e;
        }
    }
    match arena.get_mut(db) {
        Ok(Asset::PoseDb(p)) => match p.clips.get_mut(index as usize) {
            Some(c) => {
                *c = clip;
                STATUS_OK
            }
            None => STATUS_MISMATCH,
        },
        Ok(_) => STATUS_WRONG_KIND,
        Err(e) => e,
    }
}

struct Writer<'b> {
    out: &'b mut [u8],
    at: usize,
}

impl Writer<'_> {
    fn put<R: WireRecord>(&mut self, r: &R) -> bool {
        let stride = R::DESC.stride as usize;
        match self.out.get_mut(self.at..self.at + stride) {
            Some(o) => {
                let _ = r.encode_into(o);
                self.at += stride;
                true
            }
            None => false,
        }
    }
}

impl Core {
    /// Loads a `myco.posedb@1` file; 0 on failure (see `last_status`).
    pub fn posedb_load(&mut self, bytes: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = load(&mut self.arena, bytes);
        self.handle(r)
    }

    /// Binds database clip `index` to a clip handle (0 unbinds); returns a status.
    pub fn posedb_bind(&mut self, db: u32, index: u32, clip: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        bind(&mut self.arena, db, index, clip)
    }

    /// Database clip `index`'s asset reference ("" for none or a stale handle).
    pub fn posedb_clip(&self, db: u32, index: u32) -> String {
        match self.arena.get(db) {
            Ok(Asset::PoseDb(p)) => p.names.get(index as usize).cloned().unwrap_or_default(),
            _ => String::new(),
        }
    }

    /// Writes instance `handle`'s match report into the match buffer; returns its bytes (0 for a
    /// stale handle). Never allocates.
    pub fn match_debug_write(&mut self, handle: u32) -> u32 {
        if !self.started {
            return 0;
        }
        let Ok(inst) = self.table.get_mut(handle) else {
            return 0;
        };
        let groups = inst.groups;
        let program = match self.arena.graph(inst.graph) {
            Ok(g) if inst.graph != 0 => Some(&g.program),
            _ => None,
        };
        let (head, body) = self
            .matching
            .debug
            .split_at_mut(MatchHeader::STRIDE as usize);
        let mut w = Writer { out: body, at: 0 };
        let mut header = MatchHeader {
            instance: handle,
            nodes: 0,
            dropped: 0,
        };
        if let Some(program) = program {
            for n in 0..program.node_count() as u32 {
                if program.node_kind(n) != Some((Family::Matching, matching::kind::POSE_DATABASE)) {
                    continue;
                }
                let Some(v) = matching::view(program.node_state(&mut inst.state, groups, n)) else {
                    continue;
                };
                let rec = MatchNode {
                    node: n,
                    database: v.database,
                    clip: v.clip,
                    time: v.time,
                    frame: v.frame,
                    cost: v.cost,
                    updates: v.updates,
                    last_search: v.last_search,
                    flags: v.flags,
                };
                if w.put(&rec) {
                    header.nodes += 1;
                } else {
                    header.dropped += 1;
                }
                // T70: the predicted trajectory, then the playing frame's.
                let Some(m) = match_ref(&self.arena, v.database) else {
                    continue;
                };
                let mut t = Trajectory::default();
                let mut put = |kind: u32, t: &Trajectory, header: &mut MatchHeader| {
                    for i in 0..t.count {
                        let s = MatchSample {
                            node: n,
                            kind,
                            time: t.offsets[i],
                            x: t.positions[i][0],
                            z: t.positions[i][1],
                            dx: t.directions[i][0],
                            dz: t.directions[i][1],
                        };
                        if !w.put(&s) {
                            header.dropped += 1;
                        }
                    }
                };
                if matching::predicted_trajectory(program, &mut inst.state, groups, n, m.db, &mut t)
                {
                    put(SAMPLE_PREDICTED, &t, &mut header);
                }
                if v.frame != anim_format::NONE && m.db.frame_trajectory(v.frame as usize, &mut t) {
                    put(SAMPLE_MATCHED, &t, &mut header);
                }
            }
        }
        let _ = header.encode_into(head);
        (MatchHeader::STRIDE as usize + w.at) as u32
    }

    /// The match debug buffer.
    pub fn match_debug(&self) -> &[u8] {
        &self.matching.debug
    }
}

/// Loads a `myco.posedb@1` file (copied in); returns its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn posedb_load(bytes: &[u8]) -> u32 {
    with(|c| c.posedb_load(bytes))
}

/// Binds a database's clip `index` to a clip handle (0 unbinds); returns a status.
#[wasm_bindgen]
pub fn posedb_bind(db: u32, index: u32, clip: u32) -> u32 {
    with(|c| c.posedb_bind(db, index, clip))
}

/// A database clip's asset reference ("" for none).
#[wasm_bindgen]
pub fn posedb_clip(db: u32, index: u32) -> String {
    with(|c| c.posedb_clip(db, index))
}

/// The match debug buffer's byte offset in memory (`match` family, `MATCH_DEBUG_BYTES` long).
#[wasm_bindgen]
pub fn match_debug_ptr() -> u32 {
    with(|c| Core::addr(&c.matching.debug))
}

/// Writes an instance's match report into the match buffer; returns its byte length.
#[wasm_bindgen]
pub fn match_debug_write(handle: u32) -> u32 {
    with(|c| c.match_debug_write(handle))
}
