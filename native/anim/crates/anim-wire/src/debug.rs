//! Family `debug`: the graph debugger's records (ADR 0342, 0343): active nodes with weights and
//! phases, state machines with each candidate transition's blocker, live request lifetimes.
//!
//! Written only for instances flagged with the `graph` family's `DEBUG` command, pulled per
//! instance: `debug_write(instance)` fills the debug buffer (`debug_ptr()`, [`DEBUG_BYTES`] bytes)
//! from the instance's state after its last `evaluate` and returns the bytes written (0 for an
//! instance not flagged, or a stale handle). The buffer holds a [`DebugHeader`], then its
//! records back to back in this order: [`DebugNode`]s, then per machine a [`DebugMachine`]
//! followed by its [`DebugTransition`]s (the current state's candidates in the order the machine
//! tries them), then [`DebugRequest`]s. Records that don't fit are counted in the header's
//! `dropped`, never half-written.

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 10;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// The debug buffer's size in bytes.
pub const DEBUG_BYTES: u32 = 32 * 1024;

/// [`DebugTransition::blocker`]: it would fire now (the first ready candidate).
pub const BLOCK_READY: u32 = 0;
/// [`DebugTransition::blocker`]: its condition is false; `detail` is the failing comparison's
/// condition node and `value` its operand's current value.
pub const BLOCK_CONDITION: u32 = 1;
/// [`DebugTransition::blocker`]: ready, but shadowed by the higher-priority transition `detail`.
pub const BLOCK_SHADOWED: u32 = 2;
/// [`DebugTransition::blocker`]: a transition is in progress and doesn't let it interrupt.
pub const BLOCK_INTERRUPT: u32 = 3;
/// [`DebugTransition::blocker`]: its `when` (exit time, marker, normalised time) isn't reached.
pub const BLOCK_WHEN: u32 = 4;
/// [`DebugTransition::blocker`]: the machine is travelling along another path.
pub const BLOCK_TRAVEL: u32 = 5;

wire_record! {
    /// The head of a debug report.
    pub struct DebugHeader: family(ID, VERSION), kind(1) {
        /// The instance handle.
        instance: u32,
        /// `DebugNode` records.
        nodes: u32,
        /// `DebugMachine` records.
        machines: u32,
        /// `DebugTransition` records.
        transitions: u32,
        /// `DebugRequest` records.
        requests: u32,
        /// Bytes of records after this header.
        record_bytes: u32,
        /// Records that didn't fit.
        dropped: u32,
    }
}

wire_record! {
    /// An active node: reached by the output's weighted walk.
    pub struct DebugNode: family(ID, VERSION), kind(2) {
        /// The node index.
        node: u32,
        /// Its effective weight (summed over the paths that reach it).
        weight: f32,
        /// The clip that times it (0: none).
        clip: u32,
        /// That clip's playhead, seconds.
        time: f32,
        /// The playhead over the clip's duration.
        normalized: f32,
    }
}

wire_record! {
    /// A state machine.
    pub struct DebugMachine: family(ID, VERSION), kind(3) {
        /// The machine index.
        machine: u32,
        /// The current state (local index).
        current: u32,
        /// The state a bridge leads to (`0xFFFFFFFF`: none).
        target: u32,
        /// The transition in progress (`0xFFFFFFFF`: none).
        active: u32,
        /// The newest entry's fade: elapsed seconds.
        elapsed: f32,
        /// Its duration.
        duration: f32,
        /// Seconds in the current state.
        state_time: f32,
        /// The current state's normalised time (loops count whole).
        normalized: f32,
        /// The travel target (`0xFFFFFFFF`: none).
        travel: u32,
        /// The last transition fired (`0xFFFFFFFF`: none).
        last_fired: u32,
        /// Entries in the blend stack.
        entries: u32,
    }
}

wire_record! {
    /// A candidate transition of a machine's current state and what blocks it.
    pub struct DebugTransition: family(ID, VERSION), kind(4) {
        /// The machine index.
        machine: u32,
        /// The transition index.
        transition: u32,
        /// Its target state.
        target: u32,
        /// `BLOCK_*`.
        blocker: u32,
        /// `BLOCK_CONDITION`: the failing condition node; `BLOCK_SHADOWED`: the transition that wins.
        detail: u32,
        /// `BLOCK_CONDITION`: the failing comparison's operand value now.
        value: f32,
    }
}

wire_record! {
    /// A request name the conditions read.
    pub struct DebugRequest: family(ID, VERSION), kind(5) {
        /// The name's string id.
        name: u32,
        /// Seconds left (0: not live).
        life: f32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "header",
            &DebugHeader {
                instance: 0x0001_0002,
                nodes: 5,
                machines: 1,
                transitions: 3,
                requests: 1,
                record_bytes: 300,
                dropped: 0,
            },
        ),
        Vector::of(
            "node",
            &DebugNode {
                node: 4,
                weight: 0.75,
                clip: 0x0001_0003,
                time: 0.5,
                normalized: 0.25,
            },
        ),
        Vector::of(
            "machine",
            &DebugMachine {
                machine: 0,
                current: 2,
                target: u32::MAX,
                active: 5,
                elapsed: 0.1,
                duration: 0.2,
                state_time: 0.1,
                normalized: 0.05,
                travel: u32::MAX,
                last_fired: 5,
                entries: 2,
            },
        ),
        Vector::of(
            "transition_condition",
            &DebugTransition {
                machine: 0,
                transition: 6,
                target: 1,
                blocker: BLOCK_CONDITION,
                detail: 3,
                value: 1.5,
            },
        ),
        Vector::of(
            "request",
            &DebugRequest {
                name: 7,
                life: 0.125,
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
    name: "debug",
    id: ID,
    version: VERSION,
    doc: "Wire family `debug`: the graph debugger's records (ADR 0342, 0343): active nodes with weights and phases, state\nmachines with each candidate transition's blocker, live request lifetimes (native/anim/crates/anim-wire/src/debug.rs).",
    records: &[
        DebugHeader::DESC,
        DebugNode::DESC,
        DebugMachine::DESC,
        DebugTransition::DESC,
        DebugRequest::DESC,
    ],
    consts: consts![
        DEBUG_BYTES: "The debug buffer's size in bytes.",
        BLOCK_READY: "`DEBUG_TRANSITION.blocker`: it would fire now.",
        BLOCK_CONDITION: "`DEBUG_TRANSITION.blocker`: condition false (`detail` the failing node, `value` its operand now).",
        BLOCK_SHADOWED: "`DEBUG_TRANSITION.blocker`: ready, but transition `detail` wins by priority.",
        BLOCK_INTERRUPT: "`DEBUG_TRANSITION.blocker`: the transition in progress doesn't let it interrupt.",
        BLOCK_WHEN: "`DEBUG_TRANSITION.blocker`: exit time, marker or normalised time not reached.",
        BLOCK_TRAVEL: "`DEBUG_TRANSITION.blocker`: travelling along another path.",
    ],
    vectors,
};
