//! Family `match`: motion matching (ADR 0350, 0352): the live debugger's records of the graph's
//! pose-database nodes.
//!
//! Pose databases load with `posedb_load(bytes)` (a `myco.posedb@1` file; an asset handle, or 0
//! with `last_status`), bind their clip list with `posedb_bind(db, clip_index, clip)` (0 unbinds)
//! and `posedb_clip(db, clip_index)` (the clip's asset reference, a string), and are bound into a
//! graph with `graph_bind` like clips. A `POSE_DATABASE` node reads its trajectory inputs from graph
//! parameters (the blackboard; `anim-graph::matching` documents its parameter words), so this
//! family has no input view.
//!
//! `match_debug_write(instance)` fills the match buffer (`match_debug_ptr()`, [`MATCH_DEBUG_BYTES`]
//! bytes) from the instance's state after its last `evaluate` and returns the bytes written (0 for
//! a stale handle): a [`MatchHeader`], then one [`MatchNode`] per `POSE_DATABASE` node of the
//! instance's graph (top level), in node order. Records that don't fit are counted in the header's
//! `dropped`.

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 5;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// The match buffer's size in bytes.
pub const MATCH_DEBUG_BYTES: u32 = 4096;
/// [`MatchNode::flags`]: the last update switched (an inertialized jump to the matched frame).
pub const MATCH_SWITCHED: u32 = 1;
/// [`MatchNode::flags`]: the last update searched.
pub const MATCH_SEARCHED: u32 = 2;

wire_record! {
    /// The head of a match report.
    pub struct MatchHeader: family(ID, VERSION), kind(1) {
        /// The instance handle.
        instance: u32,
        /// `MatchNode` records.
        nodes: u32,
        /// Records that didn't fit.
        dropped: u32,
    }
}

wire_record! {
    /// A `POSE_DATABASE` node's state.
    pub struct MatchNode: family(ID, VERSION), kind(2) {
        /// The node index.
        node: u32,
        /// The database's asset handle (0: none bound).
        database: u32,
        /// The playing clip's asset handle (0: none).
        clip: u32,
        /// Its playhead, seconds.
        time: f32,
        /// The database frame playing (`0xFFFFFFFF`: none).
        frame: u32,
        /// Its cost against the last query.
        cost: f32,
        /// Updates the node has run.
        updates: u32,
        /// The update count at the last search (`0xFFFFFFFF`: never).
        last_search: u32,
        /// `MATCH_*` flags of the last update.
        flags: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "header",
            &MatchHeader {
                instance: 0x0001_0002,
                nodes: 1,
                dropped: 0,
            },
        ),
        Vector::of(
            "node",
            &MatchNode {
                node: 3,
                database: 0x0001_0005,
                clip: 0x0001_0007,
                time: 0.5,
                frame: 42,
                cost: 1.25,
                updates: 120,
                last_search: 114,
                flags: MATCH_SEARCHED | MATCH_SWITCHED,
            },
        ),
    ]
}

macro_rules! consts {
    ($($name:ident: $doc:literal),* $(,)?) => {
        &[$(Const { name: stringify!($name), value: $name, doc: $doc }),*]
    };
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "match",
    id: ID,
    version: VERSION,
    doc: "Wire family `match`: motion matching (ADR 0350, 0352): the live debugger's records of the graph's pose-database\nnodes (native/anim/crates/anim-wire/src/match.rs).",
    records: &[MatchHeader::DESC, MatchNode::DESC],
    consts: consts![
        MATCH_DEBUG_BYTES: "The match buffer's size in bytes.",
        MATCH_SWITCHED: "`MATCH_NODE.flags`: the last update switched.",
        MATCH_SEARCHED: "`MATCH_NODE.flags`: the last update searched.",
    ],
    vectors,
};
