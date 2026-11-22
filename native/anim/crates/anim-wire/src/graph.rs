//! Family `graph`: graph inputs and state: blackboard parameter rows, parameter and request
//! commands, `travel` and `jump`, slot plays, linked-graph selections, layer weights, the seed,
//! pose captures, the debug flag, and graph state-change records (ADR 0342).
//!
//! # Commands
//!
//! Graph commands go into the core's command buffer beside the `core` family's and are applied by
//! the same `write_inputs` call, in buffer order. They address instances of graph assets (an
//! implicit-graph instance refuses them with `STATUS_MISMATCH`, as asset-graph instances refuse
//! `PLAY`). Indices are the graph file's: parameters (`PARAMS` order), machines (`MACHINES`),
//! states (local to their machine), slots (`SLOTS`), linked-graph slots (`LINKED`), string ids
//! (request names), nodes. A refused command produces the `core` family's `STATE_CHANGE` with
//! `CHANGE_REFUSED`, `layer` the index it named and `status` saying why ([`STATUS_UNREACHABLE`],
//! [`STATUS_NO_SUCH`], or a `core` status).
//!
//! # The blackboard view
//!
//! At `blackboard_ptr()`, [`BLACKBOARD_STRIDE`] bytes per instance index (ADR 0342's
//! `animatorParams(entity)`): two `u32` dirty masks (parameters 0–31, 32–63), then
//! [`BLACKBOARD_PARAMS`] parameters of four words each, typed by the graph's parameter table
//! (floats and vectors as f32 bits, ints as i32, bools 0/1). The host writes values and sets
//! their dirty bits; `write_inputs` copies dirty parameters into the instance's state (before the
//! commands) and clears the masks. A float that isn't finite is skipped (the old value stays).
//! Parameters past the first 64 are set with [`SetParam`].
//!
//! # Graph state changes
//!
//! `evaluate` writes [`GraphChange`] records at `graph_changes_ptr()` (`graph_change_count()` of
//! them; `write_inputs` clears them, and slot interruptions and stops a command causes are written
//! there by `write_inputs`): states entered and exited, slot plays finished, interrupted or
//! stopped (with the play id), requests consumed (with the transition) or expired.

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 3;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// Status: the target state can't be reached from the current one (`TRAVEL`).
pub const STATUS_UNREACHABLE: u32 = 0x0301;
/// Status: the graph has no such parameter, machine, state, slot, linked-graph slot, request
/// name or node, or the parameter's type differs.
pub const STATUS_NO_SUCH: u32 = 0x0302;

/// Blackboard: parameters per row.
pub const BLACKBOARD_PARAMS: u32 = 64;
/// Blackboard: the dirty masks' offset (two `u32`).
pub const BLACKBOARD_DIRTY: u32 = 0;
/// Blackboard: the values' offset (four words per parameter).
pub const BLACKBOARD_VALUES: u32 = 8;
/// Blackboard: bytes per instance row.
pub const BLACKBOARD_STRIDE: u32 = BLACKBOARD_VALUES + 16 * BLACKBOARD_PARAMS;

/// [`GraphChange::kind`]: machine `index` entered state `value`.
pub const GRAPH_STATE_ENTERED: u32 = 1;
/// [`GraphChange::kind`]: machine `index` left state `value` (it stopped contributing).
pub const GRAPH_STATE_EXITED: u32 = 2;
/// [`GraphChange::kind`]: slot `index`'s play `value` reached its end.
pub const GRAPH_SLOT_FINISHED: u32 = 3;
/// [`GraphChange::kind`]: slot `index`'s play `value` ended early; `reason` says why.
pub const GRAPH_SLOT_INTERRUPTED: u32 = 4;
/// [`GraphChange::kind`]: request `index` (its name string id) was consumed by transition `value`.
pub const GRAPH_REQUEST_CONSUMED: u32 = 5;
/// [`GraphChange::kind`]: request `index` expired unread.
pub const GRAPH_REQUEST_EXPIRED: u32 = 6;

/// [`GraphChange::reason`]: none (other kinds) / the play finished.
pub const REASON_FINISHED: u32 = 0;
/// [`GraphChange::reason`]: another play replaced it (in its slot or its slot group).
pub const REASON_INTERRUPTED: u32 = 1;
/// [`GraphChange::reason`]: `SLOT_STOP` stopped it.
pub const REASON_STOPPED: u32 = 2;

/// [`SlotPlay::flags`] and [`SlotNextSection::flags`]: loop the section.
pub const SECTION_LOOP: u32 = 1;

/// [`Debug::flags`]: the instance answers `debug_write`.
pub const DEBUG_ON: u32 = 1;

wire_record! {
    /// Command: sets graph parameter `param` (typed: the four words as the graph's parameter
    /// table stores them).
    pub struct SetParam: family(ID, VERSION), kind(1) {
        /// The instance handle.
        instance: u32,
        /// The parameter index.
        param: u32,
        /// The parameter's type (`myco.animgraph@1`'s: 0 float, 1 int, 2 bool, 3 vec2, 4 vec3, 5 quat, 6 node); refused when it differs.
        param_type: u32,
        /// Word 0 (f32 bits, i32, 0/1 or a node id).
        w0: u32,
        w1: u32,
        w2: u32,
        w3: u32,
    }
}

wire_record! {
    /// Command: a request (ADR 0342's `request`, replacing triggers): live for `lifetime`
    /// seconds, consumed by the first transition that reads it and fires.
    pub struct Request: family(ID, VERSION), kind(2) {
        /// The instance handle.
        instance: u32,
        /// The request's name (a string id of the graph).
        name: u32,
        /// Seconds (0 or less: 0.25, the default `within`).
        lifetime: f32,
    }
}

wire_record! {
    /// Command: travel to a state along the shortest path through the machine (Godot's `travel`).
    pub struct Travel: family(ID, VERSION), kind(3) {
        /// The instance handle.
        instance: u32,
        /// The machine index.
        machine: u32,
        /// The target state (local index).
        state: u32,
    }
}

wire_record! {
    /// Command: cut to a state at the next update, no path (`jump`).
    pub struct Jump: family(ID, VERSION), kind(4) {
        /// The instance handle.
        instance: u32,
        /// The machine index.
        machine: u32,
        /// The target state (local index).
        state: u32,
    }
}

wire_record! {
    /// Command: plays a clip in a slot (a one-shot over the graph, Unreal's montage), from
    /// section `[start, end)`.
    pub struct SlotPlay: family(ID, VERSION), kind(5) {
        /// The instance handle.
        instance: u32,
        /// The slot index.
        slot: u32,
        /// The clip handle.
        clip: u32,
        /// The host's id for the play, echoed in its state changes (0: none).
        play_id: u32,
        /// Seconds.
        blend_in: f32,
        /// Seconds; the play blends out so it reaches 0 at its section's end.
        blend_out: f32,
        /// Playback speed.
        speed: f32,
        /// Section start, clip seconds.
        start: f32,
        /// Section end, clip seconds (0, or not after `start`: the clip's end).
        end: f32,
        /// `SECTION_LOOP`.
        flags: u32,
    }
}

wire_record! {
    /// Command: the section a slot's play continues with when its current section ends.
    pub struct SlotNextSection: family(ID, VERSION), kind(6) {
        /// The instance handle.
        instance: u32,
        /// The slot index.
        slot: u32,
        /// The play it applies to (refused for another).
        play_id: u32,
        /// Clip seconds.
        start: f32,
        /// Clip seconds (0: the clip's end).
        end: f32,
        /// `SECTION_LOOP`.
        flags: u32,
    }
}

wire_record! {
    /// Command: blends a slot's play out.
    pub struct SlotStop: family(ID, VERSION), kind(7) {
        /// The instance handle.
        instance: u32,
        /// The slot index.
        slot: u32,
        /// The play to stop (0: whatever plays).
        play_id: u32,
        /// Seconds.
        fade: f32,
    }
}

wire_record! {
    /// Command: runs a graph in a linked-graph slot from the next update (0 unlinks).
    pub struct Link: family(ID, VERSION), kind(8) {
        /// The instance handle.
        instance: u32,
        /// The linked-graph slot index.
        linked: u32,
        /// A graph handle, or 0.
        graph: u32,
    }
}

wire_record! {
    /// Command: a layer's weight (writes the input view's weight for layers below `MAX_LAYERS`).
    pub struct LayerWeight: family(ID, VERSION), kind(9) {
        /// The instance handle.
        instance: u32,
        /// The layer index.
        layer: u32,
        /// In [0, 1].
        weight: f32,
    }
}

wire_record! {
    /// Command: reseeds the instance's random generator (from the World's seeded generator).
    pub struct SetSeed: family(ID, VERSION), kind(10) {
        /// The instance handle.
        instance: u32,
        /// The seed (0 reads as the default).
        seed: u32,
    }
}

wire_record! {
    /// Command: captures the instance's last output pose into a pose-snapshot node.
    pub struct CapturePose: family(ID, VERSION), kind(11) {
        /// The instance handle.
        instance: u32,
        /// The pose-snapshot node's index.
        node: u32,
    }
}

wire_record! {
    /// Command: flags an instance for the graph debugger (`debug_write` answers only for flagged
    /// instances).
    pub struct Debug: family(ID, VERSION), kind(12) {
        /// The instance handle.
        instance: u32,
        /// `DEBUG_ON`, or 0.
        flags: u32,
    }
}

wire_record! {
    /// Output: a graph state change.
    pub struct GraphChange: family(ID, VERSION), kind(13) {
        /// The instance handle.
        instance: u32,
        /// `GRAPH_*`.
        kind: u32,
        /// The machine, slot, or request name string id.
        index: u32,
        /// The state, play id, or transition (`0xFFFFFFFF` for none).
        value: u32,
        /// `REASON_*` for slot plays, else 0.
        reason: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "set_param_float",
            &SetParam {
                instance: 0x0001_0002,
                param: 3,
                param_type: 0,
                w0: 2.5f32.to_bits(),
                w1: 0,
                w2: 0,
                w3: 0,
            },
        ),
        Vector::of(
            "request_jump",
            &Request {
                instance: 0x0002_0001,
                name: 7,
                lifetime: 0.2,
            },
        ),
        Vector::of(
            "travel",
            &Travel {
                instance: 0x0001_0000,
                machine: 1,
                state: 4,
            },
        ),
        Vector::of(
            "jump",
            &Jump {
                instance: 0x0001_0000,
                machine: 0,
                state: 2,
            },
        ),
        Vector::of(
            "slot_play_section",
            &SlotPlay {
                instance: 0x0003_0001,
                slot: 0,
                clip: 0x0001_0009,
                play_id: 42,
                blend_in: 0.1,
                blend_out: 0.15,
                speed: 1.25,
                start: 0.5,
                end: 1.0,
                flags: SECTION_LOOP,
            },
        ),
        Vector::of(
            "slot_next_section",
            &SlotNextSection {
                instance: 0x0003_0001,
                slot: 0,
                play_id: 42,
                start: 1.0,
                end: 0.0,
                flags: 0,
            },
        ),
        Vector::of(
            "slot_stop",
            &SlotStop {
                instance: 0x0003_0001,
                slot: 1,
                play_id: 0,
                fade: 0.2,
            },
        ),
        Vector::of(
            "link",
            &Link {
                instance: 0x0001_0004,
                linked: 0,
                graph: 0x0002_0005,
            },
        ),
        Vector::of(
            "layer_weight",
            &LayerWeight {
                instance: 0x0001_0004,
                layer: 2,
                weight: 0.5,
            },
        ),
        Vector::of(
            "set_seed",
            &SetSeed {
                instance: 0x0001_0004,
                seed: 0xDEAD_BEEF,
            },
        ),
        Vector::of(
            "capture_pose",
            &CapturePose {
                instance: 0x0001_0004,
                node: 12,
            },
        ),
        Vector::of(
            "debug_on",
            &Debug {
                instance: 0x0001_0004,
                flags: DEBUG_ON,
            },
        ),
        Vector::of(
            "graph_change_slot_stopped",
            &GraphChange {
                instance: 0x0001_0004,
                kind: GRAPH_SLOT_INTERRUPTED,
                index: 1,
                value: 42,
                reason: REASON_STOPPED,
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
    name: "graph",
    id: ID,
    version: VERSION,
    doc: "Wire family `graph`: graph inputs and state (ADR 0342): the blackboard view, parameter and request commands,\ntravel and jump, slot plays with sections, linked graphs, layer weights, the seed, pose captures, the debug flag,\nand graph state-change records (native/anim/crates/anim-wire/src/graph.rs documents them).",
    records: &[
        SetParam::DESC,
        Request::DESC,
        Travel::DESC,
        Jump::DESC,
        SlotPlay::DESC,
        SlotNextSection::DESC,
        SlotStop::DESC,
        Link::DESC,
        LayerWeight::DESC,
        SetSeed::DESC,
        CapturePose::DESC,
        Debug::DESC,
        GraphChange::DESC,
    ],
    consts: consts![
        STATUS_UNREACHABLE: "Status: the target state can't be reached from the current one (`TRAVEL`).",
        STATUS_NO_SUCH: "Status: no such parameter, machine, state, slot, linked-graph slot, request or node, or another parameter type.",
        BLACKBOARD_PARAMS: "Blackboard: parameters per row.",
        BLACKBOARD_DIRTY: "Blackboard: the dirty masks' offset (two `u32`: parameters 0-31, 32-63).",
        BLACKBOARD_VALUES: "Blackboard: the values' offset (four words per parameter).",
        BLACKBOARD_STRIDE: "Blackboard: bytes per instance row.",
        GRAPH_STATE_ENTERED: "`GRAPH_CHANGE.kind`: machine `index` entered state `value`.",
        GRAPH_STATE_EXITED: "`GRAPH_CHANGE.kind`: machine `index` left state `value`.",
        GRAPH_SLOT_FINISHED: "`GRAPH_CHANGE.kind`: slot `index`'s play `value` reached its end.",
        GRAPH_SLOT_INTERRUPTED: "`GRAPH_CHANGE.kind`: slot `index`'s play `value` ended early (`reason`).",
        GRAPH_REQUEST_CONSUMED: "`GRAPH_CHANGE.kind`: request `index` consumed by transition `value`.",
        GRAPH_REQUEST_EXPIRED: "`GRAPH_CHANGE.kind`: request `index` expired unread.",
        REASON_FINISHED: "`GRAPH_CHANGE.reason`: finished (or not a slot change).",
        REASON_INTERRUPTED: "`GRAPH_CHANGE.reason`: replaced by another play.",
        REASON_STOPPED: "`GRAPH_CHANGE.reason`: stopped by `SLOT_STOP`.",
        SECTION_LOOP: "`SLOT_PLAY.flags`, `SLOT_NEXT_SECTION.flags`: loop the section.",
        DEBUG_ON: "`DEBUG.flags`: the instance answers `debug_write`.",
    ],
    vectors,
};

const _: () = {
    assert!(GraphChange::STRIDE == 24);
    assert!(BLACKBOARD_PARAMS == 64);
};
