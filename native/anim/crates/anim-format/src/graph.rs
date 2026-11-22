//! `myco.animgraph@1`: a compiled animation graph (ADR 0342), in the
//! [container] layout.
//!
//! Magic `"MYCOAGPH"`, version [`FORMAT_VERSION`], no header flags (0).
//!
//! The graph is a pose dataflow DAG of nodes; each node is a [family] plus a `u16` kind
//! that `anim-graph`'s dispatch table routes, an input list and a parameter block (u32 words
//! whose meaning the node catalogue defines; opaque here). State machines, slots, linked graphs,
//! layers and chooser tables are side tables that name their nodes.
//!
//! # Sections
//!
//! | kind | name | count | record | required |
//! |---|---|---|---|---|
//! | 1 | `STRINGS` | strings | [string table](crate::strings) | yes |
//! | 2 | `INFO` | 1 | 16 B | yes |
//! | 3 | `PARAMS` | parameters | 24 B | no |
//! | 4 | `NODES` | nodes (≥ 1) | 24 B | yes |
//! | 5 | `NODE_INPUTS` | u32 values | 4 B | no |
//! | 6 | `PARAM_BLOCKS` | u32 words | 4 B | no |
//! | 7 | `MACHINES` | state machines | 32 B | no |
//! | 8 | `STATES` | states | 24 B | no |
//! | 9 | `TRANSITIONS` | transitions | 40 B | no |
//! | 10 | `INTERRUPTS` | u32 values | 4 B | no |
//! | 11 | `CONDITION_PROGRAMS` | programs | 8 B | no |
//! | 12 | `CONDITION_NODES` | condition nodes | 16 B | no |
//! | 13 | `SLOTS` | slots | 16 B | no |
//! | 14 | `LINKED` | linked-graph slots | 16 B | no |
//! | 15 | `LAYERS` | layers | 24 B | no |
//! | 16 | `CHOOSERS` | chooser tables | 16 B | no |
//! | 17 | `CHOOSER_ROWS` | rows | 8 B | no |
//!
//! Every section is 4-byte aligned. An absent optional section is an empty table.
//!
//! ## `INFO` (16 bytes)
//!
//! `u32` name string id (or `NONE`), `u32` output node index, `u32` skeleton string id (or
//! `NONE`), `u32` reserved (0).
//!
//! ## `PARAMS` (24 bytes each)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | name string id |
//! | 4 | u8 | type ([`ParamType`]: float, int, bool, vec2, vec3, quat, node) |
//! | 5 | u8 | flags: [`PARAM_REPLICATE`] (1), [`PARAM_PREDICTED`] (2), [`PARAM_COMPUTED`] (4) |
//! | 6 | u16 | reserved (0) |
//! | 8 | u32 x 4 | default: float/vec/quat as f32 bits (finite); int as i32; bool 0/1; node as a node-path string id or `NONE`; unused words 0 |
//!
//! ## `NODES` (24 bytes each)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u8 | family ([`family`] ids, equal to `anim-graph`'s `Family` discriminants) |
//! | 1 | u8 | reserved (0) |
//! | 2 | u16 | kind (per family) |
//! | 4 | u32 | first input in `NODE_INPUTS` |
//! | 8 | u32 | input count |
//! | 12 | u32 | first word of the parameter block in `PARAM_BLOCKS` |
//! | 16 | u32 | parameter block length in words |
//! | 20 | u32 | debug name string id, or `NONE` |
//!
//! `NODE_INPUTS` holds node indices. Inputs, state roots, bridge nodes and chooser results form a
//! DAG (a cycle is refused).
//!
//! ## `MACHINES` (32 bytes each)
//!
//! `u32` node (a [`family::LOGIC`] node), `u32` name string id or `NONE`, `u32` first state,
//! `u32` state count, `u32` entry state (local index), `u32` first any-state transition, `u32`
//! any-state transition count, `u32` reserved (0).
//!
//! ## `STATES` (24 bytes each)
//!
//! `u32` name string id or `NONE`, `u32` root node of the state's sub-graph, `u32` first
//! transition, `u32` transition count (the range is in priority order, highest first), `u32`
//! flags ([`STATE_EXIT`]), `u32` reserved (0).
//!
//! ## `TRANSITIONS` (40 bytes each)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | target state (local index within the owning machine) |
//! | 4 | u32 | condition program index, or `NONE` (always true) |
//! | 8 | u8 | when ([`WhenKind`]: now, exit, marker, normalized time) |
//! | 9 | u8 | how ([`HowKind`]: crossfade, cut, inertialize, bridge) |
//! | 10 | u8 | interrupt mode ([`InterruptMode`]: never, any, list) |
//! | 11 | u8 | reserved (0) |
//! | 12 | u32 | when value: marker → marker name string id; normalized time → f32 bits (finite, ≥ 0); else 0 |
//! | 16 | f32 | duration, seconds (crossfade, inertialize, bridge; finite, ≥ 0; cut: 0) |
//! | 20 | u32 | fade shape id (crossfade and bridge, from the shared fade-shape set; else 0) |
//! | 24 | u32 | bridge node (bridge), else `NONE` |
//! | 28 | u32 | first interrupter in `INTERRUPTS` (list mode), else 0 |
//! | 32 | u32 | interrupter count (list mode), else 0 |
//! | 36 | u32 | reserved (0) |
//!
//! `INTERRUPTS` holds transition indices allowed to interrupt.
//!
//! ## Conditions
//!
//! `CONDITION_PROGRAMS` (8 bytes each): `u32` first node, `u32` node count (≥ 1). The nodes of
//! a program are one tree in prefix order, at most [`MAX_CONDITION_DEPTH`] deep.
//!
//! `CONDITION_NODES` (16 bytes each):
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u8 | code: 0 all, 1 any (groups), 2 compare |
//! | 1 | u8 | compare op ([`CmpOp`]), groups 0 |
//! | 2 | u8 | operand source ([`OperandSource`]), groups 0 |
//! | 3 | u8 | reserved (0) |
//! | 4 | u32 | groups: child count (≥ 1); param: parameter index; curve, request: name string id; else 0 |
//! | 8 | u32 | constant: f32 bits for float operands (params, state time, normalized time, sync phase, curves); i32 for int params; 0/1 for bool params and requests (op eq or ne only); groups 0 |
//! | 12 | u32 | reserved (0) |
//!
//! Vector, quaternion and node parameters aren't comparable.
//!
//! ## Slots, linked graphs, layers, choosers
//!
//! - `SLOTS` (16 bytes): `u32` name string id, `u32` slot node, `u32` slot group string id or `NONE`, `u32` reserved.
//! - `LINKED` (16 bytes): `u32` name string id, `u32` linked-graph node, `u32` default graph asset string id or `NONE`, `u32` reserved.
//! - `LAYERS` (24 bytes): `u32` name string id, `u32` layer root node, `u32` mask asset string id or `NONE` (full body), `u32` mode ([`LayerMode`]), `f32` default weight in \[0, 1\], `u32` weight parameter (a float parameter) or `NONE`.
//! - `CHOOSERS` (16 bytes): `u32` chooser node, `u32` first row, `u32` row count, `u32` fallback node or `NONE`.
//! - `CHOOSER_ROWS` (8 bytes): `u32` condition program, `u32` result node. Rows are tried in order.

use crate::bytes::*;
use crate::container::{self, Container, FormatSpec, Layout, SectionEntry, SectionSpec};
use crate::error::{FormatError, Result};
use crate::macros::u8_enum;
use crate::strings::{self, StringTable};

/// Magic bytes.
pub const MAGIC: [u8; 8] = *b"MYCOAGPH";
/// The format's name.
pub const FORMAT: &str = "myco.animgraph@1";
/// The format version this build reads and writes.
pub const FORMAT_VERSION: u32 = 1;

/// Parameter flag: replicated (0340).
pub const PARAM_REPLICATE: u8 = 1;
/// Parameter flag: predicted.
pub const PARAM_PREDICTED: u8 = 2;
/// Parameter flag: computed (filled by a registered function in Gather).
pub const PARAM_COMPUTED: u8 = 4;
const PARAM_FLAGS: u8 = PARAM_REPLICATE | PARAM_PREDICTED | PARAM_COMPUTED;

/// State flag: an exit state of its machine.
pub const STATE_EXIT: u32 = 1;

/// How deep a condition tree may nest (the root counts as 1).
pub const MAX_CONDITION_DEPTH: u32 = 16;

/// Node family ids. Copied from `anim-graph`'s `Family` enum (`dispatch.rs`), whose discriminants
/// are the stored ids: append-only, never renumbered.
pub mod family {
    /// Clip players, blend spaces, pose snapshot, reference and bind pose.
    pub const SOURCES: u8 = 0;
    /// State machines, transitions, requests, choosers and the random selector.
    pub const LOGIC: u8 = 1;
    /// Blends, additive, masked layers, mirror.
    pub const MIXING: u8 = 2;
    /// Slots and linked graphs.
    pub const SLOTS: u8 = 3;
    /// Sync groups, markers, notify weights.
    pub const SYNC: u8 = 4;
    /// The rig stack.
    pub const RIG: u8 = 5;
    /// Runtime retargeting.
    pub const RETARGET: u8 = 6;
    /// Motion matching.
    pub const MATCHING: u8 = 7;
    /// Physical animation.
    pub const PHYSICS: u8 = 8;
    /// Third-party nodes.
    pub const PLUGIN: u8 = 9;
    /// The number of families.
    pub const COUNT: u8 = 10;
}

/// Section kinds.
pub mod section {
    /// String table.
    pub const STRINGS: u32 = 1;
    /// Graph info.
    pub const INFO: u32 = 2;
    /// Parameter table.
    pub const PARAMS: u32 = 3;
    /// Node table.
    pub const NODES: u32 = 4;
    /// Node input lists.
    pub const NODE_INPUTS: u32 = 5;
    /// Node parameter blocks.
    pub const PARAM_BLOCKS: u32 = 6;
    /// State machines.
    pub const MACHINES: u32 = 7;
    /// States.
    pub const STATES: u32 = 8;
    /// Transitions.
    pub const TRANSITIONS: u32 = 9;
    /// Interrupt lists.
    pub const INTERRUPTS: u32 = 10;
    /// Condition programs.
    pub const CONDITION_PROGRAMS: u32 = 11;
    /// Condition nodes.
    pub const CONDITION_NODES: u32 = 12;
    /// Slots.
    pub const SLOTS: u32 = 13;
    /// Linked-graph slots.
    pub const LINKED: u32 = 14;
    /// Layers.
    pub const LAYERS: u32 = 15;
    /// Chooser tables.
    pub const CHOOSERS: u32 = 16;
    /// Chooser rows.
    pub const CHOOSER_ROWS: u32 = 17;
}

const INFO_LEN: usize = 16;
const PARAM_LEN: usize = 24;
const NODE_LEN: usize = 24;
const MACHINE_LEN: usize = 32;
const STATE_LEN: usize = 24;
const TRANSITION_LEN: usize = 40;
const PROGRAM_LEN: usize = 8;
const COND_LEN: usize = 16;
const SLOT_LEN: usize = 16;
const LINKED_LEN: usize = 16;
const LAYER_LEN: usize = 24;
const CHOOSER_LEN: usize = 16;
const ROW_LEN: usize = 8;

const fn sec(kind: u32, name: &'static str, stride: usize, required: bool) -> SectionSpec {
    SectionSpec {
        kind,
        name,
        align: 4,
        layout: Layout::Records(stride),
        required,
    }
}

static SPEC: FormatSpec = FormatSpec {
    magic: MAGIC,
    version: FORMAT_VERSION,
    known_flags: 0,
    sections: &[
        SectionSpec {
            kind: section::STRINGS,
            name: "STRINGS",
            align: 4,
            layout: Layout::Custom,
            required: true,
        },
        sec(section::INFO, "INFO", INFO_LEN, true),
        sec(section::PARAMS, "PARAMS", PARAM_LEN, false),
        sec(section::NODES, "NODES", NODE_LEN, true),
        sec(section::NODE_INPUTS, "NODE_INPUTS", 4, false),
        sec(section::PARAM_BLOCKS, "PARAM_BLOCKS", 4, false),
        sec(section::MACHINES, "MACHINES", MACHINE_LEN, false),
        sec(section::STATES, "STATES", STATE_LEN, false),
        sec(section::TRANSITIONS, "TRANSITIONS", TRANSITION_LEN, false),
        sec(section::INTERRUPTS, "INTERRUPTS", 4, false),
        sec(
            section::CONDITION_PROGRAMS,
            "CONDITION_PROGRAMS",
            PROGRAM_LEN,
            false,
        ),
        sec(section::CONDITION_NODES, "CONDITION_NODES", COND_LEN, false),
        sec(section::SLOTS, "SLOTS", SLOT_LEN, false),
        sec(section::LINKED, "LINKED", LINKED_LEN, false),
        sec(section::LAYERS, "LAYERS", LAYER_LEN, false),
        sec(section::CHOOSERS, "CHOOSERS", CHOOSER_LEN, false),
        sec(section::CHOOSER_ROWS, "CHOOSER_ROWS", ROW_LEN, false),
    ],
};

u8_enum! {
    /// A parameter's type.
    pub enum ParamType {
        /// f32.
        Float = 0,
        /// i32.
        Int = 1,
        /// 0 or 1.
        Bool = 2,
        /// Two f32.
        Vec2 = 3,
        /// Three f32.
        Vec3 = 4,
        /// Four f32 (x, y, z, w).
        Quat = 5,
        /// A node reference (node-path string id).
        Node = 6,
    }
}

u8_enum! {
    /// When a transition may fire.
    pub enum WhenKind {
        /// Immediately.
        Now = 0,
        /// At the playing clip's next `exit` marker, else its end.
        Exit = 1,
        /// At the next sync marker of a name.
        Marker = 2,
        /// At a normalized time.
        NormalizedTime = 3,
    }
}

u8_enum! {
    /// How a transition blends.
    pub enum HowKind {
        /// Crossfade with a fade shape.
        Crossfade = 0,
        /// Cut.
        Cut = 1,
        /// Inertialize.
        Inertialize = 2,
        /// Through a bridge node.
        Bridge = 3,
    }
}

u8_enum! {
    /// Which transitions may interrupt a transition in progress.
    pub enum InterruptMode {
        /// None.
        Never = 0,
        /// Any.
        Any = 1,
        /// Those in its `INTERRUPTS` list.
        List = 2,
    }
}

u8_enum! {
    /// A comparison.
    pub enum CmpOp {
        /// ==
        Eq = 0,
        /// !=
        Ne = 1,
        /// <
        Lt = 2,
        /// <=
        Le = 3,
        /// >
        Gt = 4,
        /// >=
        Ge = 5,
    }
}

u8_enum! {
    /// What a comparison reads.
    pub enum OperandSource {
        /// A parameter.
        Param = 0,
        /// The state's time, seconds.
        StateTime = 1,
        /// The state's normalized time.
        NormalizedTime = 2,
        /// The sync phase.
        SyncPhase = 3,
        /// A named curve.
        Curve = 4,
        /// Whether a named request is live (consumed by the transition that reads it).
        Request = 5,
    }
}

u8_enum! {
    /// How a layer combines.
    pub enum LayerMode {
        /// Replaces the layers below (by mask and weight).
        Override = 0,
        /// Adds onto the layers below.
        Additive = 1,
    }
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

/// A parameter's default (its variant is its type).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamValue {
    /// float
    Float(f32),
    /// int
    Int(i32),
    /// bool
    Bool(bool),
    /// vec2
    Vec2([f32; 2]),
    /// vec3
    Vec3([f32; 3]),
    /// quat (x, y, z, w)
    Quat([f32; 4]),
    /// node: a node-path string id or `NONE`
    Node(u32),
}

impl ParamValue {
    /// The type.
    pub fn ty(&self) -> ParamType {
        match self {
            ParamValue::Float(_) => ParamType::Float,
            ParamValue::Int(_) => ParamType::Int,
            ParamValue::Bool(_) => ParamType::Bool,
            ParamValue::Vec2(_) => ParamType::Vec2,
            ParamValue::Vec3(_) => ParamType::Vec3,
            ParamValue::Quat(_) => ParamType::Quat,
            ParamValue::Node(_) => ParamType::Node,
        }
    }
    fn words(&self) -> [u32; 4] {
        let f = |v: &[f32]| {
            let mut w = [0u32; 4];
            for (o, x) in w.iter_mut().zip(v) {
                *o = x.to_bits();
            }
            w
        };
        match *self {
            ParamValue::Float(v) => f(&[v]),
            ParamValue::Int(v) => [v as u32, 0, 0, 0],
            ParamValue::Bool(v) => [v as u32, 0, 0, 0],
            ParamValue::Vec2(v) => f(&v),
            ParamValue::Vec3(v) => f(&v),
            ParamValue::Quat(v) => f(&v),
            ParamValue::Node(v) => [v, 0, 0, 0],
        }
    }
    fn from_words(ty: ParamType, w: [u32; 4]) -> ParamValue {
        let e = f32::from_bits;
        match ty {
            ParamType::Float => ParamValue::Float(e(w[0])),
            ParamType::Int => ParamValue::Int(w[0] as i32),
            ParamType::Bool => ParamValue::Bool(w[0] != 0),
            ParamType::Vec2 => ParamValue::Vec2([e(w[0]), e(w[1])]),
            ParamType::Vec3 => ParamValue::Vec3([e(w[0]), e(w[1]), e(w[2])]),
            ParamType::Quat => ParamValue::Quat([e(w[0]), e(w[1]), e(w[2]), e(w[3])]),
            ParamType::Node => ParamValue::Node(w[0]),
        }
    }
}

/// A parameter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Param {
    /// Name string id.
    pub name: u32,
    /// [`PARAM_REPLICATE`], [`PARAM_PREDICTED`], [`PARAM_COMPUTED`].
    pub flags: u8,
    /// The default (and the type).
    pub default: ParamValue,
}

/// A node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Node {
    /// Family id ([`family`]).
    pub family: u8,
    /// Kind within the family.
    pub kind: u16,
    /// First input in the input list.
    pub inputs_first: u32,
    /// Input count.
    pub inputs_count: u32,
    /// First parameter-block word.
    pub params_first: u32,
    /// Parameter-block words.
    pub params_count: u32,
    /// Debug name string id, or `NONE`.
    pub name: u32,
}

/// A state machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Machine {
    /// The state machine node.
    pub node: u32,
    /// Name string id, or `NONE`.
    pub name: u32,
    /// First state.
    pub states_first: u32,
    /// State count.
    pub states_count: u32,
    /// Entry state (local).
    pub entry: u32,
    /// First any-state transition.
    pub any_first: u32,
    /// Any-state transition count.
    pub any_count: u32,
}

/// A state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    /// Name string id, or `NONE`.
    pub name: u32,
    /// Sub-graph root node.
    pub node: u32,
    /// First transition (priority order).
    pub transitions_first: u32,
    /// Transition count.
    pub transitions_count: u32,
    /// [`STATE_EXIT`].
    pub flags: u32,
}

/// When a transition may fire.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum When {
    /// Immediately.
    Now,
    /// At the next exit marker, else the clip end.
    Exit,
    /// At the next sync marker with this name (string id).
    Marker(u32),
    /// At this normalized time.
    NormalizedTime(f32),
}

/// How a transition blends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum How {
    /// Crossfade over `duration` seconds with fade shape `shape`.
    Crossfade { duration: f32, shape: u32 },
    /// Cut.
    Cut,
    /// Inertialize over `duration` seconds.
    Inertialize { duration: f32 },
    /// Through bridge `node`, faded in over `duration` with `shape`.
    Bridge {
        node: u32,
        duration: f32,
        shape: u32,
    },
}

/// Which transitions may interrupt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interrupt {
    /// None.
    Never,
    /// Any.
    Any,
    /// Those at `INTERRUPTS[first..first + count]`.
    List { first: u32, count: u32 },
}

/// A transition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    /// Target state (local to the machine).
    pub target: u32,
    /// Condition program, or `NONE`.
    pub condition: u32,
    /// When.
    pub when: When,
    /// How.
    pub how: How,
    /// Interruption.
    pub interrupt: Interrupt,
}

/// What a comparison reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operand {
    /// A parameter index.
    Param(u32),
    /// The state's time.
    StateTime,
    /// The state's normalized time.
    NormalizedTime,
    /// The sync phase.
    SyncPhase,
    /// A curve (name string id).
    Curve(u32),
    /// A request (name string id).
    Request(u32),
}

/// One node of a condition tree (prefix order).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CondNode {
    /// All of the next `n` subtrees.
    All(u32),
    /// Any of the next `n` subtrees.
    Any(u32),
    /// `operand op value` (value bits per the operand's type).
    Compare {
        operand: Operand,
        op: CmpOp,
        value: u32,
    },
}

/// A condition program: one tree of condition nodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CondProgram {
    /// First condition node.
    pub first: u32,
    /// Node count.
    pub count: u32,
}

/// A slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot {
    /// Name string id.
    pub name: u32,
    /// Slot node.
    pub node: u32,
    /// Slot group string id, or `NONE`.
    pub group: u32,
}

/// A linked-graph slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkedGraph {
    /// Name string id.
    pub name: u32,
    /// Linked-graph node.
    pub node: u32,
    /// Default graph asset string id, or `NONE`.
    pub default_graph: u32,
}

/// A layer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layer {
    /// Name string id.
    pub name: u32,
    /// Layer root node.
    pub node: u32,
    /// Mask asset string id, or `NONE`.
    pub mask: u32,
    /// Override or additive.
    pub mode: LayerMode,
    /// Default weight.
    pub weight: f32,
    /// Weight parameter, or `NONE`.
    pub weight_param: u32,
}

/// A chooser table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chooser {
    /// Chooser node.
    pub node: u32,
    /// First row.
    pub rows_first: u32,
    /// Row count.
    pub rows_count: u32,
    /// Fallback node, or `NONE`.
    pub fallback: u32,
}

/// A chooser row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChooserRow {
    /// Condition program.
    pub condition: u32,
    /// Result node.
    pub node: u32,
}

/// The owned model of a `myco.animgraph@1` file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnimGraph {
    /// Name string id, or `NONE`.
    pub name: u32,
    /// Output node.
    pub output: u32,
    /// Skeleton string id, or `NONE`.
    pub skeleton: u32,
    /// The string table.
    pub strings: Vec<String>,
    /// Parameters.
    pub params: Vec<Param>,
    /// Nodes.
    pub nodes: Vec<Node>,
    /// Node input lists.
    pub inputs: Vec<u32>,
    /// Parameter blocks.
    pub param_blocks: Vec<u32>,
    /// State machines.
    pub machines: Vec<Machine>,
    /// States.
    pub states: Vec<State>,
    /// Transitions.
    pub transitions: Vec<Transition>,
    /// Interrupt lists.
    pub interrupts: Vec<u32>,
    /// Condition programs.
    pub programs: Vec<CondProgram>,
    /// Condition nodes.
    pub conditions: Vec<CondNode>,
    /// Slots.
    pub slots: Vec<Slot>,
    /// Linked-graph slots.
    pub linked: Vec<LinkedGraph>,
    /// Layers.
    pub layers: Vec<Layer>,
    /// Chooser tables.
    pub choosers: Vec<Chooser>,
    /// Chooser rows.
    pub chooser_rows: Vec<ChooserRow>,
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

fn put_transition(o: &mut Out, t: &Transition) {
    let (when, when_value) = match t.when {
        When::Now => (WhenKind::Now, 0),
        When::Exit => (WhenKind::Exit, 0),
        When::Marker(id) => (WhenKind::Marker, id),
        When::NormalizedTime(v) => (WhenKind::NormalizedTime, v.to_bits()),
    };
    let (how, duration, shape, bridge) = match t.how {
        How::Crossfade { duration, shape } => (HowKind::Crossfade, duration, shape, NONE),
        How::Cut => (HowKind::Cut, 0.0, 0, NONE),
        How::Inertialize { duration } => (HowKind::Inertialize, duration, 0, NONE),
        How::Bridge {
            node,
            duration,
            shape,
        } => (HowKind::Bridge, duration, shape, node),
    };
    let (mode, first, count) = match t.interrupt {
        Interrupt::Never => (InterruptMode::Never, 0, 0),
        Interrupt::Any => (InterruptMode::Any, 0, 0),
        Interrupt::List { first, count } => (InterruptMode::List, first, count),
    };
    o.u32(t.target);
    o.u32(t.condition);
    o.u8(when.id());
    o.u8(how.id());
    o.u8(mode.id());
    o.u8(0);
    o.u32(when_value);
    o.f32(duration);
    o.u32(shape);
    o.u32(bridge);
    o.u32(first);
    o.u32(count);
    o.u32(0);
}

fn bad(what: &'static str, value: u32) -> FormatError {
    FormatError::InvalidValue { what, value }
}

/// Decodes a transition record, refusing bad enums and any field its variant doesn't use being
/// other than 0 / `NONE` (the record must be the canonical encoding of what it decodes to).
fn read_transition(bytes: &[u8]) -> Result<Transition> {
    let mut r = Rd::new(bytes);
    let target = r.u32();
    let condition = r.u32();
    let (when, how, mode) = (r.u8(), r.u8(), r.u8());
    r.u8();
    let when_value = r.u32();
    let duration = r.f32();
    let shape = r.u32();
    let bridge = r.u32();
    let first = r.u32();
    let count = r.u32();
    let when = match WhenKind::from_u8(when).ok_or(bad("transition when", when as u32))? {
        WhenKind::Now => When::Now,
        WhenKind::Exit => When::Exit,
        WhenKind::Marker => When::Marker(when_value),
        WhenKind::NormalizedTime => When::NormalizedTime(f32::from_bits(when_value)),
    };
    let how = match HowKind::from_u8(how).ok_or(bad("transition how", how as u32))? {
        HowKind::Crossfade => How::Crossfade { duration, shape },
        HowKind::Cut => How::Cut,
        HowKind::Inertialize => How::Inertialize { duration },
        HowKind::Bridge => How::Bridge {
            node: bridge,
            duration,
            shape,
        },
    };
    let interrupt = match InterruptMode::from_u8(mode).ok_or(bad("interrupt mode", mode as u32))? {
        InterruptMode::Never => Interrupt::Never,
        InterruptMode::Any => Interrupt::Any,
        InterruptMode::List => Interrupt::List { first, count },
    };
    let t = Transition {
        target,
        condition,
        when,
        how,
        interrupt,
    };
    let mut o = Out::default();
    put_transition(&mut o, &t);
    if o.buf != bytes {
        return Err(FormatError::NonZeroReserved {
            what: "transition unused fields",
        });
    }
    Ok(t)
}

fn put_cond(o: &mut Out, n: &CondNode) {
    let (code, op, src, operand, value) = match *n {
        CondNode::All(c) => (0u8, 0u8, 0u8, c, 0u32),
        CondNode::Any(c) => (1, 0, 0, c, 0),
        CondNode::Compare { operand, op, value } => {
            let (src, idx) = match operand {
                Operand::Param(i) => (OperandSource::Param, i),
                Operand::StateTime => (OperandSource::StateTime, 0),
                Operand::NormalizedTime => (OperandSource::NormalizedTime, 0),
                Operand::SyncPhase => (OperandSource::SyncPhase, 0),
                Operand::Curve(i) => (OperandSource::Curve, i),
                Operand::Request(i) => (OperandSource::Request, i),
            };
            (2, op.id(), src.id(), idx, value)
        }
    };
    o.u8(code);
    o.u8(op);
    o.u8(src);
    o.u8(0);
    o.u32(operand);
    o.u32(value);
    o.u32(0);
}

fn read_cond(bytes: &[u8]) -> Result<CondNode> {
    let mut r = Rd::new(bytes);
    let (code, op, src) = (r.u8(), r.u8(), r.u8());
    r.u8();
    let operand = r.u32();
    let value = r.u32();
    let n = match code {
        0 => CondNode::All(operand),
        1 => CondNode::Any(operand),
        2 => {
            let op = CmpOp::from_u8(op).ok_or(bad("compare op", op as u32))?;
            let source = OperandSource::from_u8(src).ok_or(bad("operand source", src as u32))?;
            let operand = match source {
                OperandSource::Param => Operand::Param(operand),
                OperandSource::StateTime => Operand::StateTime,
                OperandSource::NormalizedTime => Operand::NormalizedTime,
                OperandSource::SyncPhase => Operand::SyncPhase,
                OperandSource::Curve => Operand::Curve(operand),
                OperandSource::Request => Operand::Request(operand),
            };
            CondNode::Compare { operand, op, value }
        }
        c => return Err(bad("condition code", c as u32)),
    };
    let mut o = Out::default();
    put_cond(&mut o, &n);
    if o.buf != bytes {
        return Err(FormatError::NonZeroReserved {
            what: "condition node unused fields",
        });
    }
    Ok(n)
}

fn read_param(bytes: &[u8]) -> Result<Param> {
    let mut r = Rd::new(bytes);
    let name = r.u32();
    let ty = r.u8();
    let flags = r.u8();
    let reserved = r.u16();
    let words = r.u32s::<4>();
    check_zero("param reserved", reserved as u32)?;
    let ty = ParamType::from_u8(ty).ok_or(bad("param type", ty as u32))?;
    if flags & !PARAM_FLAGS != 0 {
        return Err(bad("param flags", flags as u32));
    }
    let default = ParamValue::from_words(ty, words);
    if default.words() != words {
        return Err(FormatError::InvalidValue {
            what: "param default",
            value: words[0],
        });
    }
    Ok(Param {
        name,
        flags,
        default,
    })
}

fn read_node(mut r: Rd<'_>) -> (Node, u8) {
    let family = r.u8();
    let reserved = r.u8();
    let n = Node {
        family,
        kind: r.u16(),
        inputs_first: r.u32(),
        inputs_count: r.u32(),
        params_first: r.u32(),
        params_count: r.u32(),
        name: r.u32(),
    };
    (n, reserved)
}

fn read_machine(mut r: Rd<'_>) -> (Machine, u32) {
    let m = Machine {
        node: r.u32(),
        name: r.u32(),
        states_first: r.u32(),
        states_count: r.u32(),
        entry: r.u32(),
        any_first: r.u32(),
        any_count: r.u32(),
    };
    (m, r.u32())
}

fn read_state(mut r: Rd<'_>) -> (State, u32) {
    let s = State {
        name: r.u32(),
        node: r.u32(),
        transitions_first: r.u32(),
        transitions_count: r.u32(),
        flags: r.u32(),
    };
    (s, r.u32())
}

fn read_layer(mut r: Rd<'_>) -> Result<Layer> {
    let name = r.u32();
    let node = r.u32();
    let mask = r.u32();
    let mode = r.u32();
    let weight = r.f32();
    let weight_param = r.u32();
    let mode = u8::try_from(mode)
        .ok()
        .and_then(LayerMode::from_u8)
        .ok_or(bad("layer mode", mode))?;
    Ok(Layer {
        name,
        node,
        mask,
        mode,
        weight,
        weight_param,
    })
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

impl AnimGraph {
    /// Writes the file (parsed back before it is returned).
    pub fn write(&self) -> Result<Vec<u8>> {
        let mut w = container::Writer::new(&SPEC, 0);
        w.section(
            section::STRINGS,
            self.strings.len(),
            strings::write(&self.strings)?,
        )?;
        let mut o = Out::default();
        o.u32s(&[self.name, self.output, self.skeleton, 0]);
        w.section(section::INFO, 1, o.finish())?;

        let mut o = Out::default();
        for p in &self.params {
            o.u32(p.name);
            o.u8(p.default.ty().id());
            o.u8(p.flags);
            o.u16(0);
            o.u32s(&p.default.words());
        }
        w.section(section::PARAMS, self.params.len(), o.finish())?;

        let mut o = Out::default();
        for n in &self.nodes {
            o.u8(n.family);
            o.u8(0);
            o.u16(n.kind);
            o.u32s(&[
                n.inputs_first,
                n.inputs_count,
                n.params_first,
                n.params_count,
                n.name,
            ]);
        }
        w.section(section::NODES, self.nodes.len(), o.finish())?;
        w.section(
            section::NODE_INPUTS,
            self.inputs.len(),
            u32_bytes(&self.inputs),
        )?;
        w.section(
            section::PARAM_BLOCKS,
            self.param_blocks.len(),
            u32_bytes(&self.param_blocks),
        )?;

        let mut o = Out::default();
        for m in &self.machines {
            o.u32s(&[
                m.node,
                m.name,
                m.states_first,
                m.states_count,
                m.entry,
                m.any_first,
                m.any_count,
                0,
            ]);
        }
        w.section(section::MACHINES, self.machines.len(), o.finish())?;
        let mut o = Out::default();
        for s in &self.states {
            o.u32s(&[
                s.name,
                s.node,
                s.transitions_first,
                s.transitions_count,
                s.flags,
                0,
            ]);
        }
        w.section(section::STATES, self.states.len(), o.finish())?;
        let mut o = Out::default();
        self.transitions
            .iter()
            .for_each(|t| put_transition(&mut o, t));
        w.section(section::TRANSITIONS, self.transitions.len(), o.finish())?;
        w.section(
            section::INTERRUPTS,
            self.interrupts.len(),
            u32_bytes(&self.interrupts),
        )?;

        let mut o = Out::default();
        self.programs
            .iter()
            .for_each(|p| o.u32s(&[p.first, p.count]));
        w.section(section::CONDITION_PROGRAMS, self.programs.len(), o.finish())?;
        let mut o = Out::default();
        self.conditions.iter().for_each(|c| put_cond(&mut o, c));
        w.section(section::CONDITION_NODES, self.conditions.len(), o.finish())?;

        let mut o = Out::default();
        self.slots
            .iter()
            .for_each(|s| o.u32s(&[s.name, s.node, s.group, 0]));
        w.section(section::SLOTS, self.slots.len(), o.finish())?;
        let mut o = Out::default();
        self.linked
            .iter()
            .for_each(|l| o.u32s(&[l.name, l.node, l.default_graph, 0]));
        w.section(section::LINKED, self.linked.len(), o.finish())?;
        let mut o = Out::default();
        for l in &self.layers {
            o.u32s(&[l.name, l.node, l.mask, l.mode.id() as u32]);
            o.f32(l.weight);
            o.u32(l.weight_param);
        }
        w.section(section::LAYERS, self.layers.len(), o.finish())?;
        let mut o = Out::default();
        self.choosers
            .iter()
            .for_each(|c| o.u32s(&[c.node, c.rows_first, c.rows_count, c.fallback]));
        w.section(section::CHOOSERS, self.choosers.len(), o.finish())?;
        let mut o = Out::default();
        self.chooser_rows
            .iter()
            .for_each(|r| o.u32s(&[r.condition, r.node]));
        w.section(section::CHOOSER_ROWS, self.chooser_rows.len(), o.finish())?;

        let bytes = w.finish()?;
        AnimGraphView::parse(&bytes)?;
        Ok(bytes)
    }
}

fn u32_bytes(v: &[u32]) -> Vec<u8> {
    let mut o = Out::default();
    o.u32s(v);
    o.finish()
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/// A validated, zero-copy view of a `myco.animgraph@1` buffer.
#[derive(Clone, Copy)]
pub struct AnimGraphView<'a> {
    c: Container<'a>,
    strings: StringTable<'a>,
    info: [u32; 4],
}

impl<'a> AnimGraphView<'a> {
    /// Parses and validates `bytes`.
    pub fn parse(bytes: &'a [u8]) -> Result<Self> {
        let c = container::parse(&SPEC, bytes)?;
        let strings =
            StringTable::parse(c.count(section::STRINGS) as u32, c.data(section::STRINGS))?;
        if c.count(section::INFO) != 1 {
            return Err(FormatError::BadCount {
                what: "INFO records",
                count: c.count(section::INFO) as u64,
                expected: 1,
            });
        }
        let info = Rd::new(c.data(section::INFO)).u32s::<4>();
        let v = AnimGraphView { c, strings, info };
        v.validate()?;
        Ok(v)
    }

    fn validate(&self) -> Result<()> {
        let s = &self.strings;
        let n_nodes = self.node_count();
        if n_nodes == 0 {
            return Err(FormatError::BadCount {
                what: "nodes",
                count: 0,
                expected: 1,
            });
        }
        s.check("graph name", self.info[0])?;
        check_index("output node", self.info[1], n_nodes)?;
        s.check("skeleton", self.info[2])?;
        check_zero("INFO reserved", self.info[3])?;

        let params: Vec<Param> = self
            .chunks(section::PARAMS, PARAM_LEN)
            .map(read_param)
            .collect::<Result<_>>()?;
        for p in &params {
            check_index("param name", p.name, s.len())?;
            match p.default {
                ParamValue::Float(v) => check_finite("param default", v)?,
                ParamValue::Vec2(v) => check_all_finite("param default", &v)?,
                ParamValue::Vec3(v) => check_all_finite("param default", &v)?,
                ParamValue::Quat(v) => check_all_finite("param default", &v)?,
                ParamValue::Node(id) => s.check("param node path", id)?,
                ParamValue::Int(_) | ParamValue::Bool(_) => {}
            }
        }

        let n_inputs = self.c.count(section::NODE_INPUTS);
        let n_words = self.c.count(section::PARAM_BLOCKS);
        for i in 0..n_nodes {
            let (n, reserved) = read_node(self.rec(section::NODES, NODE_LEN, i));
            check_zero("node reserved", reserved as u32)?;
            if n.family >= family::COUNT {
                return Err(bad("node family", n.family as u32));
            }
            check_range("node inputs", n.inputs_first, n.inputs_count, n_inputs)?;
            check_range(
                "node parameter block",
                n.params_first,
                n.params_count,
                n_words,
            )?;
            s.check("node name", n.name)?;
        }
        for i in U32s::new(self.c.data(section::NODE_INPUTS)).iter() {
            check_index("node input", i, n_nodes)?;
        }

        let n_states = self.c.count(section::STATES);
        let n_trans = self.c.count(section::TRANSITIONS);
        let n_programs = self.c.count(section::CONDITION_PROGRAMS);
        let n_interrupts = self.c.count(section::INTERRUPTS);
        for i in 0..n_states {
            let (st, reserved) = read_state(self.rec(section::STATES, STATE_LEN, i));
            check_zero("state reserved", reserved)?;
            s.check("state name", st.name)?;
            check_index("state node", st.node, n_nodes)?;
            check_range(
                "state transitions",
                st.transitions_first,
                st.transitions_count,
                n_trans,
            )?;
            if st.flags & !STATE_EXIT != 0 {
                return Err(bad("state flags", st.flags));
            }
        }
        let mut transitions = Vec::with_capacity(n_trans);
        for b in self.chunks(section::TRANSITIONS, TRANSITION_LEN) {
            let t = read_transition(b)?;
            check_opt_index("transition condition", t.condition, n_programs)?;
            match t.when {
                When::Marker(id) => check_index("transition marker", id, s.len())?,
                When::NormalizedTime(v) if !(v.is_finite() && v >= 0.0) => {
                    return Err(FormatError::BadFloat {
                        what: "transition normalized time",
                    })
                }
                _ => {}
            }
            match t.how {
                How::Crossfade { duration, .. } | How::Inertialize { duration } => {
                    check_duration(duration)?
                }
                How::Bridge { node, duration, .. } => {
                    check_index("bridge node", node, n_nodes)?;
                    check_duration(duration)?;
                }
                How::Cut => {}
            }
            if let Interrupt::List { first, count } = t.interrupt {
                check_range("interrupt list", first, count, n_interrupts)?;
            }
            transitions.push(t);
        }
        for i in U32s::new(self.c.data(section::INTERRUPTS)).iter() {
            check_index("interrupting transition", i, n_trans)?;
        }
        for i in 0..self.c.count(section::MACHINES) {
            let (m, reserved) = read_machine(self.rec(section::MACHINES, MACHINE_LEN, i));
            check_zero("machine reserved", reserved)?;
            check_index("machine node", m.node, n_nodes)?;
            if read_node(self.rec(section::NODES, NODE_LEN, m.node as usize))
                .0
                .family
                != family::LOGIC
            {
                return Err(FormatError::Inconsistent {
                    what: "state machine on a non-logic node",
                });
            }
            s.check("machine name", m.name)?;
            check_range("machine states", m.states_first, m.states_count, n_states)?;
            check_index("entry state", m.entry, m.states_count as usize)?;
            check_range("any-state transitions", m.any_first, m.any_count, n_trans)?;
            for (first, count) in self.machine_transition_ranges(&m) {
                for t in &transitions[first as usize..(first + count) as usize] {
                    check_index("transition target", t.target, m.states_count as usize)?;
                }
            }
        }

        // Conditions: every node well-formed, every program exactly one tree.
        let conds: Vec<CondNode> = self
            .chunks(section::CONDITION_NODES, COND_LEN)
            .map(read_cond)
            .collect::<Result<_>>()?;
        for c in &conds {
            self.check_cond(c, &params)?;
        }
        for i in 0..n_programs {
            let mut r = self.rec(section::CONDITION_PROGRAMS, PROGRAM_LEN, i);
            check_tree(
                &conds,
                CondProgram {
                    first: r.u32(),
                    count: r.u32(),
                },
            )?;
        }

        for i in 0..self.c.count(section::SLOTS) {
            let [name, node, group, reserved] = self.rec(section::SLOTS, SLOT_LEN, i).u32s::<4>();
            check_index("slot name", name, s.len())?;
            check_index("slot node", node, n_nodes)?;
            s.check("slot group", group)?;
            check_zero("slot reserved", reserved)?;
        }
        for i in 0..self.c.count(section::LINKED) {
            let [name, node, graph, reserved] =
                self.rec(section::LINKED, LINKED_LEN, i).u32s::<4>();
            check_index("linked graph name", name, s.len())?;
            check_index("linked graph node", node, n_nodes)?;
            s.check("linked default graph", graph)?;
            check_zero("linked reserved", reserved)?;
        }
        for i in 0..self.c.count(section::LAYERS) {
            let l = read_layer(self.rec(section::LAYERS, LAYER_LEN, i))?;
            check_index("layer name", l.name, s.len())?;
            check_index("layer node", l.node, n_nodes)?;
            s.check("layer mask", l.mask)?;
            if !(0.0..=1.0).contains(&l.weight) {
                return Err(FormatError::BadFloat {
                    what: "layer weight",
                });
            }
            check_opt_index("layer weight param", l.weight_param, params.len())?;
            if l.weight_param != NONE
                && params[l.weight_param as usize].default.ty() != ParamType::Float
            {
                return Err(FormatError::Inconsistent {
                    what: "layer weight param is not a float",
                });
            }
        }
        let n_rows = self.c.count(section::CHOOSER_ROWS);
        for i in 0..n_rows {
            let [cond, node] = self.rec(section::CHOOSER_ROWS, ROW_LEN, i).u32s::<2>();
            check_index("chooser row condition", cond, n_programs)?;
            check_index("chooser row node", node, n_nodes)?;
        }
        for i in 0..self.c.count(section::CHOOSERS) {
            let [node, first, count, fallback] =
                self.rec(section::CHOOSERS, CHOOSER_LEN, i).u32s::<4>();
            check_index("chooser node", node, n_nodes)?;
            check_range("chooser rows", first, count, n_rows)?;
            check_opt_index("chooser fallback", fallback, n_nodes)?;
        }
        self.check_acyclic(&transitions)
    }

    /// The machine's any-state range, then each state's transition range (validated ranges).
    fn machine_transition_ranges(&self, m: &Machine) -> Vec<(u32, u32)> {
        let mut ranges = vec![(m.any_first, m.any_count)];
        for si in m.states_first..m.states_first + m.states_count {
            let st = read_state(self.rec(section::STATES, STATE_LEN, si as usize)).0;
            ranges.push((st.transitions_first, st.transitions_count));
        }
        ranges
    }

    fn check_cond(&self, c: &CondNode, params: &[Param]) -> Result<()> {
        let s = &self.strings;
        let CondNode::Compare { operand, op, value } = *c else {
            return Ok(());
        };
        let eq_only = |what| {
            if matches!(op, CmpOp::Eq | CmpOp::Ne) && value <= 1 {
                Ok(())
            } else {
                Err(FormatError::Inconsistent { what })
            }
        };
        match operand {
            Operand::Param(i) => {
                check_index("condition param", i, params.len())?;
                match params[i as usize].default.ty() {
                    ParamType::Float => check_finite("condition constant", f32::from_bits(value))?,
                    ParamType::Int => {}
                    ParamType::Bool => eq_only("bool comparison must be eq/ne against 0 or 1")?,
                    _ => {
                        return Err(FormatError::Inconsistent {
                            what: "parameter type not comparable",
                        })
                    }
                }
            }
            Operand::StateTime | Operand::NormalizedTime | Operand::SyncPhase => {
                check_finite("condition constant", f32::from_bits(value))?
            }
            Operand::Curve(id) => {
                check_index("condition curve", id, s.len())?;
                check_finite("condition constant", f32::from_bits(value))?;
            }
            Operand::Request(id) => {
                check_index("condition request", id, s.len())?;
                eq_only("request comparison must be eq/ne against 0 or 1")?;
            }
        }
        Ok(())
    }

    /// Refuses a cycle through node inputs, state roots, bridges and chooser results.
    fn check_acyclic(&self, transitions: &[Transition]) -> Result<()> {
        let n = self.node_count();
        let mut edges: Vec<Vec<u32>> = vec![Vec::new(); n];
        let inputs = U32s::new(self.c.data(section::NODE_INPUTS));
        for (i, e) in edges.iter_mut().enumerate() {
            let node = read_node(self.rec(section::NODES, NODE_LEN, i)).0;
            if let Some(list) = inputs.slice(node.inputs_first as usize, node.inputs_count as usize)
            {
                e.extend(list.iter());
            }
        }
        for i in 0..self.c.count(section::MACHINES) {
            let m = read_machine(self.rec(section::MACHINES, MACHINE_LEN, i)).0;
            for si in m.states_first..m.states_first + m.states_count {
                let st = read_state(self.rec(section::STATES, STATE_LEN, si as usize)).0;
                edges[m.node as usize].push(st.node);
            }
            for (first, count) in self.machine_transition_ranges(&m) {
                for t in &transitions[first as usize..(first + count) as usize] {
                    if let How::Bridge { node, .. } = t.how {
                        edges[m.node as usize].push(node);
                    }
                }
            }
        }
        for i in 0..self.c.count(section::CHOOSERS) {
            let [node, first, count, fallback] =
                self.rec(section::CHOOSERS, CHOOSER_LEN, i).u32s::<4>();
            for r in first..first + count {
                let row = self
                    .rec(section::CHOOSER_ROWS, ROW_LEN, r as usize)
                    .u32s::<2>();
                edges[node as usize].push(row[1]);
            }
            if fallback != NONE {
                edges[node as usize].push(fallback);
            }
        }
        // Iterative three-colour depth-first search: 0 unseen, 1 on the stack, 2 done.
        let mut colour = vec![0u8; n];
        for root in 0..n {
            if colour[root] != 0 {
                continue;
            }
            let mut stack = vec![(root, 0usize)];
            colour[root] = 1;
            while let Some(top) = stack.last_mut() {
                let (v, next) = *top;
                if let Some(&w) = edges[v].get(next) {
                    top.1 += 1;
                    match colour[w as usize] {
                        0 => {
                            colour[w as usize] = 1;
                            stack.push((w as usize, 0));
                        }
                        1 => {
                            return Err(FormatError::Cycle {
                                what: "graph nodes",
                            })
                        }
                        _ => {}
                    }
                } else {
                    colour[v] = 2;
                    stack.pop();
                }
            }
        }
        Ok(())
    }

    fn chunks(&self, kind: u32, stride: usize) -> core::slice::ChunksExact<'a, u8> {
        self.c.data(kind).chunks_exact(stride)
    }

    fn rec(&self, kind: u32, stride: usize, i: usize) -> Rd<'a> {
        container::record(self.c.data(kind), stride, i).unwrap_or(Rd::new(&[]))
    }

    fn fixed<const N: usize>(&self, kind: u32, stride: usize, i: usize) -> Option<[u32; N]> {
        Some(container::record(self.c.data(kind), stride, i)?.u32s::<N>())
    }

    fn bytes_of(&self, kind: u32, stride: usize, i: usize) -> Option<&'a [u8]> {
        let a = i.checked_mul(stride)?;
        self.c.data(kind).get(a..a.checked_add(stride)?)
    }

    // -- accessors ------------------------------------------------------------------------------

    /// Name string id.
    pub fn name(&self) -> u32 {
        self.info[0]
    }
    /// Output node.
    pub fn output(&self) -> u32 {
        self.info[1]
    }
    /// Skeleton string id.
    pub fn skeleton(&self) -> u32 {
        self.info[2]
    }
    /// The string table.
    pub fn strings(&self) -> StringTable<'a> {
        self.strings
    }
    /// A section's table entry, if present.
    pub fn section(&self, kind: u32) -> Option<SectionEntry> {
        self.c.entry(kind)
    }
    /// The number of parameters.
    pub fn param_count(&self) -> usize {
        self.c.count(section::PARAMS)
    }
    /// Parameter `i`.
    pub fn param(&self, i: usize) -> Option<Param> {
        read_param(self.bytes_of(section::PARAMS, PARAM_LEN, i)?).ok()
    }
    /// The number of nodes.
    pub fn node_count(&self) -> usize {
        self.c.count(section::NODES)
    }
    /// Node `i`.
    pub fn node(&self, i: usize) -> Option<Node> {
        container::record(self.c.data(section::NODES), NODE_LEN, i).map(|r| read_node(r).0)
    }
    /// Node `i`'s inputs.
    pub fn node_inputs(&self, i: usize) -> Option<U32s<'a>> {
        let n = self.node(i)?;
        U32s::new(self.c.data(section::NODE_INPUTS))
            .slice(n.inputs_first as usize, n.inputs_count as usize)
    }
    /// Node `i`'s parameter block.
    pub fn node_params(&self, i: usize) -> Option<U32s<'a>> {
        let n = self.node(i)?;
        self.param_blocks()
            .slice(n.params_first as usize, n.params_count as usize)
    }
    /// Every parameter-block word.
    pub fn param_blocks(&self) -> U32s<'a> {
        U32s::new(self.c.data(section::PARAM_BLOCKS))
    }
    /// The number of state machines.
    pub fn machine_count(&self) -> usize {
        self.c.count(section::MACHINES)
    }
    /// State machine `i`.
    pub fn machine(&self, i: usize) -> Option<Machine> {
        container::record(self.c.data(section::MACHINES), MACHINE_LEN, i).map(|r| read_machine(r).0)
    }
    /// The number of states.
    pub fn state_count(&self) -> usize {
        self.c.count(section::STATES)
    }
    /// State `i`.
    pub fn state(&self, i: usize) -> Option<State> {
        container::record(self.c.data(section::STATES), STATE_LEN, i).map(|r| read_state(r).0)
    }
    /// The number of transitions.
    pub fn transition_count(&self) -> usize {
        self.c.count(section::TRANSITIONS)
    }
    /// Transition `i`.
    pub fn transition(&self, i: usize) -> Option<Transition> {
        read_transition(self.bytes_of(section::TRANSITIONS, TRANSITION_LEN, i)?).ok()
    }
    /// The interrupt lists.
    pub fn interrupts(&self) -> U32s<'a> {
        U32s::new(self.c.data(section::INTERRUPTS))
    }
    /// The number of condition programs.
    pub fn program_count(&self) -> usize {
        self.c.count(section::CONDITION_PROGRAMS)
    }
    /// Condition program `i`.
    pub fn program(&self, i: usize) -> Option<CondProgram> {
        let [first, count] = self.fixed(section::CONDITION_PROGRAMS, PROGRAM_LEN, i)?;
        Some(CondProgram { first, count })
    }
    /// The number of condition nodes.
    pub fn condition_count(&self) -> usize {
        self.c.count(section::CONDITION_NODES)
    }
    /// Condition node `i`.
    pub fn condition(&self, i: usize) -> Option<CondNode> {
        read_cond(self.bytes_of(section::CONDITION_NODES, COND_LEN, i)?).ok()
    }
    /// The number of slots.
    pub fn slot_count(&self) -> usize {
        self.c.count(section::SLOTS)
    }
    /// Slot `i`.
    pub fn slot(&self, i: usize) -> Option<Slot> {
        let [name, node, group, _] = self.fixed(section::SLOTS, SLOT_LEN, i)?;
        Some(Slot { name, node, group })
    }
    /// The number of linked-graph slots.
    pub fn linked_count(&self) -> usize {
        self.c.count(section::LINKED)
    }
    /// Linked-graph slot `i`.
    pub fn linked(&self, i: usize) -> Option<LinkedGraph> {
        let [name, node, default_graph, _] = self.fixed(section::LINKED, LINKED_LEN, i)?;
        Some(LinkedGraph {
            name,
            node,
            default_graph,
        })
    }
    /// The number of layers.
    pub fn layer_count(&self) -> usize {
        self.c.count(section::LAYERS)
    }
    /// Layer `i`.
    pub fn layer(&self, i: usize) -> Option<Layer> {
        read_layer(container::record(
            self.c.data(section::LAYERS),
            LAYER_LEN,
            i,
        )?)
        .ok()
    }
    /// The number of chooser tables.
    pub fn chooser_count(&self) -> usize {
        self.c.count(section::CHOOSERS)
    }
    /// Chooser table `i`.
    pub fn chooser(&self, i: usize) -> Option<Chooser> {
        let [node, rows_first, rows_count, fallback] =
            self.fixed(section::CHOOSERS, CHOOSER_LEN, i)?;
        Some(Chooser {
            node,
            rows_first,
            rows_count,
            fallback,
        })
    }
    /// The number of chooser rows.
    pub fn chooser_row_count(&self) -> usize {
        self.c.count(section::CHOOSER_ROWS)
    }
    /// Chooser row `i`.
    pub fn chooser_row(&self, i: usize) -> Option<ChooserRow> {
        let [condition, node] = self.fixed(section::CHOOSER_ROWS, ROW_LEN, i)?;
        Some(ChooserRow { condition, node })
    }

    /// The owned model.
    pub fn to_graph(&self) -> AnimGraph {
        fn all<T>(n: usize, f: impl Fn(usize) -> Option<T>) -> Vec<T> {
            (0..n).filter_map(f).collect()
        }
        AnimGraph {
            name: self.name(),
            output: self.output(),
            skeleton: self.skeleton(),
            strings: self.strings.to_vec(),
            params: all(self.param_count(), |i| self.param(i)),
            nodes: all(self.node_count(), |i| self.node(i)),
            inputs: U32s::new(self.c.data(section::NODE_INPUTS)).to_vec(),
            param_blocks: self.param_blocks().to_vec(),
            machines: all(self.machine_count(), |i| self.machine(i)),
            states: all(self.state_count(), |i| self.state(i)),
            transitions: all(self.transition_count(), |i| self.transition(i)),
            interrupts: self.interrupts().to_vec(),
            programs: all(self.program_count(), |i| self.program(i)),
            conditions: all(self.condition_count(), |i| self.condition(i)),
            slots: all(self.slot_count(), |i| self.slot(i)),
            linked: all(self.linked_count(), |i| self.linked(i)),
            layers: all(self.layer_count(), |i| self.layer(i)),
            choosers: all(self.chooser_count(), |i| self.chooser(i)),
            chooser_rows: all(self.chooser_row_count(), |i| self.chooser_row(i)),
        }
    }
}

fn check_duration(d: f32) -> Result<()> {
    if d.is_finite() && d >= 0.0 {
        Ok(())
    } else {
        Err(FormatError::BadFloat {
            what: "transition duration",
        })
    }
}

/// Checks `p` covers exactly one prefix-order tree of `conds`, within the depth limit.
fn check_tree(conds: &[CondNode], p: CondProgram) -> Result<()> {
    check_range("condition program", p.first, p.count, conds.len())?;
    if p.count == 0 {
        return Err(FormatError::BadCount {
            what: "condition program nodes",
            count: 0,
            expected: 1,
        });
    }
    let mut pending: Vec<u32> = vec![1];
    for c in &conds[p.first as usize..(p.first + p.count) as usize] {
        let Some(top) = pending.last_mut() else {
            return Err(FormatError::Inconsistent {
                what: "condition program has nodes past its tree",
            });
        };
        *top -= 1;
        if let CondNode::All(k) | CondNode::Any(k) = *c {
            if k == 0 {
                return Err(FormatError::Inconsistent {
                    what: "empty condition group",
                });
            }
            pending.push(k);
            if pending.len() as u32 > MAX_CONDITION_DEPTH {
                return Err(FormatError::TooDeep {
                    what: "condition tree",
                    limit: MAX_CONDITION_DEPTH,
                });
            }
        }
        while pending.last() == Some(&0) {
            pending.pop();
        }
    }
    if !pending.is_empty() {
        return Err(FormatError::Inconsistent {
            what: "condition program ends inside its tree",
        });
    }
    Ok(())
}
