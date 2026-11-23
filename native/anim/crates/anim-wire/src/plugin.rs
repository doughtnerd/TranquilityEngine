//! Family `plugin`: third-party nodes (ADR 0370, "Third-party graph and rig nodes"): the host call
//! and fault reports.
//!
//! # Modules
//!
//! The host (Phase B: the engine's loader) meters and instantiates a plugin's node module, reads
//! its descriptor (`anim-plugin-sdk::descriptor`) and registers it with `plugin_register(bytes)`,
//! which returns a module handle (an asset handle: `release` frees it, `graph_bind` binds it to a
//! graph's module string id) or 0 with `last_status`.
//!
//! # The host call
//!
//! A `PLUGIN_NODE` evaluation calls the JavaScript function `mycoAnimPluginHost.call(record)` (a
//! global namespace the host sets before evaluating) with the byte offset of a [`PluginCall`]
//! record in the core's memory. Its pointers are byte offsets in the core's memory, in the ABI's
//! layout (`anim-plugin-sdk::abi`: AoS poses of 10 floats per bone, one instance). The host copies
//! `input`, `params` and `state` into the module's memory, sets the call's fuel, calls
//! `myco_node_evaluate`, and on status 0 copies `output` and `state` back; it returns the module's
//! status, or [`FAULT_TRAP`] when the module trapped (or ran out of fuel), after which it discards
//! that module instance. The function must not throw (a throw counts as [`FAULT_HOST_THREW`]). Off
//! wasm (native builds) there is no host: every call faults with [`FAULT_NO_HOST`].
//!
//! # Faults
//!
//! A fault passes the node's input 0 through and keeps its state. Each node instance's first fault
//! is written as a [`PluginFault`] at `plugin_faults_ptr()` (`plugin_fault_count()` of them, at
//! most [`PLUGIN_FAULT_CAPACITY`]; `write_inputs` clears them).

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 9;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// Fault reports the buffer holds (more in one frame are counted by `plugin_faults_dropped()`).
pub const PLUGIN_FAULT_CAPACITY: u32 = 256;
/// Fault status (host): the module trapped or ran out of fuel.
pub const FAULT_TRAP: u32 = 0x0900;
/// Fault status: no module of that handle, or no node of that kind in it.
pub const FAULT_NO_MODULE: u32 = 0x0901;
/// Fault status: the node's state size or input count differs from the module's descriptor.
pub const FAULT_MISMATCH: u32 = 0x0902;
/// Fault status: the call buffers are too small (a skeleton larger than the init's `max_bones`).
pub const FAULT_NO_ROOM: u32 = 0x0903;
/// Fault status: no host function (a native build, or `mycoAnimPluginHost` missing).
pub const FAULT_NO_HOST: u32 = 0x0904;
/// Fault status: the host function threw.
pub const FAULT_HOST_THREW: u32 = 0x0905;
/// Fault status: the module wrote a non-finite value into its output pose.
pub const FAULT_NOT_FINITE: u32 = 0x0906;

wire_record! {
    /// One host call: `count` instances of node `kind` of module `module` (the core sends one).
    pub struct PluginCall: family(ID, VERSION), kind(1) {
        /// The module handle.
        module: u32,
        /// The node kind.
        kind: u32,
        /// Instances in the call.
        count: u32,
        /// Bones per pose.
        bones: u32,
        /// Pose inputs per instance.
        inputs: u32,
        /// `u32` words per parameter block.
        param_words: u32,
        /// Per-instance state bytes (the descriptor's; states lie `state_stride` apart).
        state_bytes: u32,
        /// Byte offset of `bones` `u16` parent indices, or 0 when the node doesn't need them.
        parents: u32,
        /// Byte offset of `count × inputs` AoS poses.
        input: u32,
        /// Byte offset of `count` AoS poses the module writes.
        output: u32,
        /// Byte offset of `count` parameter blocks.
        params: u32,
        /// Byte offset of `count` states.
        state: u32,
        /// The graph's step, seconds.
        dt: f32,
    }
}

wire_record! {
    /// A node instance's first fault.
    pub struct PluginFault: family(ID, VERSION), kind(2) {
        /// The graph instance's handle.
        instance: u32,
        /// The node's index in its graph.
        node: u32,
        /// The module handle.
        module: u32,
        /// The node kind.
        kind: u32,
        /// The module's status (`anim-plugin-sdk::abi::Status`) or a `FAULT_*`.
        status: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "call",
            &PluginCall {
                module: 0x0001_0009,
                kind: 2,
                count: 1,
                bones: 3,
                inputs: 1,
                param_words: 1,
                state_bytes: 4,
                parents: 0,
                input: 1024,
                output: 1144,
                params: 2048,
                state: 2052,
                dt: 1.0 / 30.0,
            },
        ),
        Vector::of(
            "fault",
            &PluginFault {
                instance: 0x0001_0001,
                node: 2,
                module: 0x0001_0009,
                kind: 1,
                status: FAULT_TRAP,
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
    name: "plugin",
    id: ID,
    version: VERSION,
    doc: "Wire family `plugin`: third-party nodes (ADR 0370): the host call `mycoAnimPluginHost.call(record)` and fault\nreports (native/anim/crates/anim-wire/src/plugin.rs).",
    records: &[PluginCall::DESC, PluginFault::DESC],
    consts: consts![
        PLUGIN_FAULT_CAPACITY: "Fault reports the buffer holds.",
        FAULT_TRAP: "Fault status (host): the module trapped or ran out of fuel.",
        FAULT_NO_MODULE: "Fault status: no such module or node kind.",
        FAULT_MISMATCH: "Fault status: the node's state size or inputs differ from the descriptor.",
        FAULT_NO_ROOM: "Fault status: the call buffers are too small.",
        FAULT_NO_HOST: "Fault status: no host function.",
        FAULT_HOST_THREW: "Fault status: the host function threw.",
        FAULT_NOT_FINITE: "Fault status: a non-finite value in the output pose.",
    ],
    vectors,
};
