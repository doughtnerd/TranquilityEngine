//! The node module ABI, version 1: names, signatures, buffer layouts and limits.
//!
//! This is the contract between a plugin's node module and the **host glue** (Phase B: the
//! engine's JavaScript loader). The animation core is itself a wasm module and can't instantiate
//! another one, so the host instantiates each plugin module on its own and the core reaches it
//! through an imported host function. Each call copies the inputs into the plugin's own memory,
//! calls [`EVALUATE`], and copies the outputs back. Everything below is in the plugin's linear
//! memory; offsets are byte offsets, all values little-endian (wasm's byte order).
//!
//! # Module shape
//!
//! A node module is a core wasm module (Wasm 2.0 plus `extended-const`: `simd128`, bulk memory,
//! multi-value, reference types, sign extension and saturating conversions are allowed). It has:
//!
//! - **no imports** of any kind (no functions, memory, tables or globals);
//! - **one memory**, defined in the module and exported as [`MEMORY`], 32-bit and not shared;
//!   its maximum is at most the loader's limit (`anim-meter`'s `Limits::max_memory_pages`, 16 MiB
//!   by default; a module that declares no maximum gets the limit as its maximum);
//! - **no start function** (it would run outside any budget);
//! - exactly these function exports, plus immutable global exports (linkers add `__heap_base` and
//!   `__data_end`, which are harmless):
//!
//! | export | signature (wasm) | Rust (SDK) |
//! |---|---|---|
//! | [`ABI_VERSION_FN`] | `() -> i32` | returns [`ABI_VERSION`] |
//! | [`DESCRIBE`] | `() -> i32` | pointer to the descriptor blob ([`crate::descriptor`]) |
//! | [`ALLOC`] | `(bytes: i32) -> i32` | a 16-byte-aligned block of at least `bytes`, or 0 |
//! | [`EVALUATE`] | `(kind, count, bones, parents, input, output, params, state: i32, dt: f32) -> i32` | a [`Status`] |
//!
//! Export names starting with [`RESERVED_PREFIX`] belong to the loader: `anim-meter` adds
//! `myco_fuel_set(i64)` and `myco_fuel_get() -> i64` and refuses modules that already have them.
//!
//! # Calls
//!
//! 1. **Load** (once): meter the module (`anim-meter`), instantiate it with no imports, set fuel,
//!    call [`ABI_VERSION_FN`] (must equal [`ABI_VERSION`]), call [`DESCRIBE`] and read the
//!    16-byte header at the returned pointer, which holds the blob's total length; copy and parse
//!    the blob ([`crate::descriptor::Descriptor::parse`]).
//! 2. **Buffers**: call [`ALLOC`] for each buffer of the largest batch the host plans (it may call
//!    again later to grow; blocks are never freed and never move). The SDK's allocator grows the
//!    memory, so blocks are page-aligned.
//! 3. **Evaluate** (per batch): copy the inputs, parameters and states in, set the batch's fuel,
//!    call [`EVALUATE`], copy the outputs and states back.
//!
//! # A batch
//!
//! One [`EVALUATE`] call runs `count` instances of one node `kind` on one skeleton of `bones`
//! bones, so crowds of characters cross the boundary once per node kind per frame.
//!
//! - **Poses** are local (parent-relative) transforms, **array of structures**: [`BONE_FLOATS`]
//!   `f32` per bone, in order translation `x y z`, rotation quaternion `x y z w` (unit), scale
//!   `x y z`; bone `b` of a pose starts at float `b * 10`. A pose is [`pose_bytes`]`(bones)` bytes.
//!   The core converts its SoA groups to this layout on the way out and back on the way in.
//! - **`input`**: `count × inputs` poses, instance-major: input `j` of instance `i` is pose number
//!   `i * inputs + j` (`inputs` is the node's declared input count; 0 inputs means `input` may
//!   be 0).
//! - **`output`**: `count` poses; instance `i`'s is pose number `i`. Its contents on entry are
//!   unspecified (the host doesn't copy anything in) and the module writes every bone. The SDK
//!   first copies the instance's first input into it (identity transforms for a 0-input node), so
//!   a Rust node that writes only some bones leaves the rest as they came in.
//! - **`params`**: `count` blocks of [`crate::descriptor::param_words`] `u32` words; each parameter
//!   takes its kind's words ([`crate::ParamKind::words`]) in declared order: `f32` bits for float
//!   kinds, two's-complement `i32` for int, 0 or 1 for bool, `x y z w` for a quaternion.
//! - **`state`**: `count` per-instance states of the node's declared `state_bytes`, at a stride of
//!   [`state_stride`]`(state_bytes)` (rounded up to 16). The core owns the state (it is part of the
//!   graph instance, so it survives a module reload and joins snapshots and rollbacks); it starts
//!   zeroed and is copied in and back out around every call. 0 state bytes means `state` may be 0.
//! - **`parents`**: the skeleton's parent indices, `bones` `u16`s, [`NO_PARENT`] for a root, every
//!   parent before its children (`myco.skel@1`'s order). Passed only to nodes whose descriptor
//!   sets [`crate::descriptor::NODE_NEEDS_SKELETON`]; 0 otherwise.
//! - **`dt`**: the graph's step in seconds (≥ 0), the same for every instance.
//!
//! Pointers to poses and parameters are 4-aligned, `parents` 2-aligned, `state` 16-aligned.
//!
//! # Faults and budget
//!
//! A trap (including the metered module running out of fuel, which traps through `unreachable`
//! with `myco_fuel_get() < 0`) or a non-zero [`Status`] fails the whole batch: the host passes each
//! instance's first input pose through unchanged (rest pose for 0 inputs), keeps the states as they
//! were before the call, and reports the fault once per node instance. A trapped instance's memory
//! may be half-written, so the host discards that module instance and instantiates a fresh one
//! before the next call.

/// The ABI version this SDK implements; [`ABI_VERSION_FN`] returns it.
pub const ABI_VERSION: u32 = 1;

/// The exported memory's name.
pub const MEMORY: &str = "memory";
/// `() -> i32`: the ABI version.
pub const ABI_VERSION_FN: &str = "myco_node_abi_version";
/// `() -> i32`: a pointer to the descriptor blob.
pub const DESCRIBE: &str = "myco_node_describe";
/// `(bytes: i32) -> i32`: allocates a 16-byte-aligned buffer, 0 on failure.
pub const ALLOC: &str = "myco_node_alloc";
/// `(kind, count, bones, parents, input, output, params, state: i32, dt: f32) -> i32`.
pub const EVALUATE: &str = "myco_node_evaluate";
/// Every required function export, in the order above.
pub const REQUIRED_EXPORTS: [&str; 4] = [ABI_VERSION_FN, DESCRIBE, ALLOC, EVALUATE];
/// Export names with this prefix are reserved for the loader (the fuel exports).
pub const RESERVED_PREFIX: &str = "myco_fuel";

/// `f32` per bone transform: translation (3), rotation (4), scale (3).
pub const BONE_FLOATS: usize = 10;
/// Bytes per bone transform.
pub const BONE_BYTES: usize = BONE_FLOATS * 4;
/// The parent index of a root bone.
pub const NO_PARENT: u16 = u16::MAX;
/// Bones per pose: parent indices are `u16` and [`NO_PARENT`] is taken.
pub const MAX_BONES: u32 = u16::MAX as u32;
/// Pose inputs per node.
pub const MAX_INPUTS: u8 = 8;
/// Per-instance state bytes per node.
pub const MAX_STATE_BYTES: u32 = 64 * 1024;
/// Alignment of a per-instance state, and of [`ALLOC`]'s blocks.
pub const STATE_ALIGN: usize = 16;

/// Bytes of one pose of `bones` bones.
pub const fn pose_bytes(bones: usize) -> usize {
    bones * BONE_BYTES
}

/// The distance between two instances' states: `state_bytes` rounded up to [`STATE_ALIGN`].
pub const fn state_stride(state_bytes: usize) -> usize {
    state_bytes.div_ceil(STATE_ALIGN) * STATE_ALIGN
}

/// What [`EVALUATE`] returns (as `i32`). Anything but [`Status::Ok`] is a fault.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Every output pose and state is written.
    Ok = 0,
    /// The module has no node of this kind.
    UnknownKind = 1,
    /// A pointer is null or misaligned where data is expected, or `bones` is out of range.
    BadArguments = 2,
}

impl Status {
    /// The status a returned `i32` stands for; `None` for a code this version doesn't define
    /// (still a fault).
    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            0 => Some(Status::Ok),
            1 => Some(Status::UnknownKind),
            2 => Some(Status::BadArguments),
            _ => None,
        }
    }
}
