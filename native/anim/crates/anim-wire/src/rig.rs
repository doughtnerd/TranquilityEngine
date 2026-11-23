//! Family `rig`: rig stack inputs and outputs (ADR 0350, 0352): the rig input view (the
//! character's transform, the rig LOD level, IK target slots, last frame's ray hits), the ray
//! output view (grounder ray requests), and the motion-warp and reset commands.
//!
//! # The rig input view
//!
//! At `rig_inputs_ptr()`, [`RIG_INPUT_STRIDE`] bytes per instance index, written by the host
//! before `evaluate` (`animation.Gather`):
//!
//! | Offset | Content |
//! |---|---|
//! | [`RIG_CHARACTER_POSITION`] | the character's model-to-world transform: position (3 f32) |
//! | [`RIG_CHARACTER_ROTATION`] | rotation (4 f32, x y z w) |
//! | [`RIG_CHARACTER_SCALE`] | scale (3 f32) |
//! | [`RIG_LOD`] | `u32` rig LOD level (0 full detail; rig nodes declare the level they are skipped at, ADR 0350's "rig and spring bones switch off past a distance") |
//! | [`RIG_TARGETS`] | [`RIG_MAX_TARGETS`] IK target slots of [`TARGET_STRIDE`] bytes |
//! | [`RIG_HITS`] | [`RIG_MAX_RAYS`] ray hits of [`HIT_STRIDE`] bytes |
//!
//! A **target slot** (`anim.ik(name)` maps a name to its slot index, which the graph compiler
//! assigns): position (3 f32) at [`TARGET_POSITION`], rotation (4 f32) at [`TARGET_ROTATION`],
//! position weight at [`TARGET_POSITION_WEIGHT`] (0: the slot is off), rotation weight at
//! [`TARGET_ROTATION_WEIGHT`], `u32` flags at [`TARGET_FLAGS`] ([`TARGET_WORLD`]: world space,
//! converted with the character's transform; otherwise model space). IK targets that are nodes
//! are written at their world transform from the previous propagation (ADR 0350).
//!
//! A **hit** answers the ray request of the same index from the previous frame (ADR 0350: a hit
//! is one frame old), in model space (decision D41): point (3 f32) at [`HIT_POINT`], unit normal
//! (3 f32) at [`HIT_NORMAL`], `u32` flags at [`HIT_FLAGS`] ([`HIT_VALID`] when the ray hit).
//!
//! `create_instance` fills a row with the identity transform, LOD 0, no targets and no hits.
//!
//! # The ray output view
//!
//! At `rig_rays_ptr()`, [`RAY_ROW_STRIDE`] bytes per instance index: [`RIG_MAX_RAYS`] requests
//! of [`RAY_STRIDE`] bytes, written by grounders when the instance's pose is evaluated (rows are
//! cleared first, so a request without [`RAY_VALID`] was not asked for): origin (3 f32) at
//! [`RAY_ORIGIN`], unit direction (3 f32) at [`RAY_DIRECTION`], length (f32) at [`RAY_LENGTH`],
//! `u32` flags at [`RAY_FLAGS`]. Model space: the host casts them in world space with the frame's
//! character transform (the physics plugin's public ray API) and writes the hits back, in model
//! space, for the next frame.
//!
//! # Commands
//!
//! Rig commands go into the core's command buffer beside the `core` and `graph` families' and
//! are applied by `write_inputs`, in order. They address nodes of a graph asset's instance by
//! node index (a refusal is the `core` family's `STATE_CHANGE` with `CHANGE_REFUSED`, `layer` the
//! node and `status` why: `STATUS_MISMATCH` for an implicit-graph instance or a node of another
//! kind, `graph`'s `STATUS_NO_SUCH` for a node index out of range).

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 4;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// Input view: IK target slots per instance.
pub const RIG_MAX_TARGETS: u32 = 16;
/// Input view: ray hits (and output view: ray requests) per instance.
pub const RIG_MAX_RAYS: u32 = 8;
/// Input view: the character's position (3 f32).
pub const RIG_CHARACTER_POSITION: u32 = 0;
/// Input view: the character's rotation (4 f32).
pub const RIG_CHARACTER_ROTATION: u32 = 12;
/// Input view: the character's scale (3 f32).
pub const RIG_CHARACTER_SCALE: u32 = 28;
/// Input view: the rig LOD level (`u32`).
pub const RIG_LOD: u32 = 40;
/// Input view: the target slots' offset.
pub const RIG_TARGETS: u32 = 64;
/// Bytes per target slot.
pub const TARGET_STRIDE: u32 = 48;
/// Target: position (3 f32).
pub const TARGET_POSITION: u32 = 0;
/// Target: rotation (4 f32).
pub const TARGET_ROTATION: u32 = 12;
/// Target: position weight (f32; 0 turns the slot off).
pub const TARGET_POSITION_WEIGHT: u32 = 28;
/// Target: rotation weight (f32).
pub const TARGET_ROTATION_WEIGHT: u32 = 32;
/// Target: flags (`u32`).
pub const TARGET_FLAGS: u32 = 36;
/// Target flag: world space.
pub const TARGET_WORLD: u32 = 1;
/// Input view: the hits' offset.
pub const RIG_HITS: u32 = RIG_TARGETS + RIG_MAX_TARGETS * TARGET_STRIDE;
/// Bytes per hit.
pub const HIT_STRIDE: u32 = 32;
/// Hit: point (3 f32, model space).
pub const HIT_POINT: u32 = 0;
/// Hit: unit normal (3 f32, model space).
pub const HIT_NORMAL: u32 = 12;
/// Hit: flags (`u32`).
pub const HIT_FLAGS: u32 = 24;
/// Hit flag: the ray hit something.
pub const HIT_VALID: u32 = 1;
/// Input view: bytes per instance row.
pub const RIG_INPUT_STRIDE: u32 = RIG_HITS + RIG_MAX_RAYS * HIT_STRIDE;
/// Output view: bytes per ray request.
pub const RAY_STRIDE: u32 = 32;
/// Request: origin (3 f32, model space).
pub const RAY_ORIGIN: u32 = 0;
/// Request: unit direction (3 f32, model space).
pub const RAY_DIRECTION: u32 = 12;
/// Request: length (f32).
pub const RAY_LENGTH: u32 = 24;
/// Request: flags (`u32`).
pub const RAY_FLAGS: u32 = 28;
/// Request flag: asked for this frame.
pub const RAY_VALID: u32 = 1;
/// Output view: bytes per instance row.
pub const RAY_ROW_STRIDE: u32 = RIG_MAX_RAYS * RAY_STRIDE;
/// [`WarpTarget::flags`]: clear the target (root motion passes through again).
pub const WARP_CLEAR: u32 = 1;
/// [`RigReset::node`]: every rig node of the instance.
pub const NODE_ALL: u32 = 0xFFFF_FFFF;

wire_record! {
    /// Command: a motion-warp node's target (`anim.warp(name, target)`, ADR 0352), world space
    /// (the character transform's space). The node lands the root there at its window's end; a
    /// target set mid-window re-plans from the current frame.
    pub struct WarpTarget: family(ID, VERSION), kind(1) {
        /// The instance handle.
        instance: u32,
        /// The motion-warp node's index.
        node: u32,
        px: f32,
        py: f32,
        pz: f32,
        /// Rotation (only the yaw about the node's up axis is matched, decision D42).
        rx: f32,
        ry: f32,
        rz: f32,
        rw: f32,
        /// `WARP_CLEAR`, or 0.
        flags: u32,
    }
}

wire_record! {
    /// Command: rig nodes forget their history at their next solve (spring chains restart on the
    /// animated pose, damp and grounder smoothing snap): after a teleport or a cut.
    pub struct RigReset: family(ID, VERSION), kind(2) {
        /// The instance handle.
        instance: u32,
        /// A rig node's index, or `NODE_ALL`.
        node: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "warp_target",
            &WarpTarget {
                instance: 0x0001_0002,
                node: 5,
                px: 1.5,
                py: 0.0,
                pz: -2.25,
                rx: 0.0,
                ry: 0.382_683_43,
                rz: 0.0,
                rw: 0.923_879_5,
                flags: 0,
            },
        ),
        Vector::of(
            "warp_clear",
            &WarpTarget {
                instance: 0x0003_0001,
                node: 2,
                px: 0.0,
                py: 0.0,
                pz: 0.0,
                rx: 0.0,
                ry: 0.0,
                rz: 0.0,
                rw: 1.0,
                flags: WARP_CLEAR,
            },
        ),
        Vector::of(
            "reset_all",
            &RigReset {
                instance: 0x0002_0004,
                node: NODE_ALL,
            },
        ),
        Vector::of(
            "reset_node",
            &RigReset {
                instance: 0x0002_0004,
                node: 7,
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
    name: "rig",
    id: ID,
    version: VERSION,
    doc: "Wire family `rig`: rig stack inputs and outputs (ADR 0350, 0352): the rig input view (character transform, rig LOD,\nIK target slots, last frame's ray hits), the ray output view (grounder ray requests) and the motion-warp and reset\ncommands (native/anim/crates/anim-wire/src/rig.rs documents them).",
    records: &[WarpTarget::DESC, RigReset::DESC],
    consts: consts![
        RIG_MAX_TARGETS: "Input view: IK target slots per instance.",
        RIG_MAX_RAYS: "Input view: ray hits per instance (and output view: ray requests).",
        RIG_CHARACTER_POSITION: "Input view: the character's model-to-world position (3 f32).",
        RIG_CHARACTER_ROTATION: "Input view: the character's rotation (4 f32, x y z w).",
        RIG_CHARACTER_SCALE: "Input view: the character's scale (3 f32).",
        RIG_LOD: "Input view: the rig LOD level (u32; 0 full detail).",
        RIG_TARGETS: "Input view: the target slots' offset.",
        TARGET_STRIDE: "Bytes per target slot.",
        TARGET_POSITION: "Target: position (3 f32).",
        TARGET_ROTATION: "Target: rotation (4 f32).",
        TARGET_POSITION_WEIGHT: "Target: position weight (f32; 0 turns the slot off).",
        TARGET_ROTATION_WEIGHT: "Target: rotation weight (f32).",
        TARGET_FLAGS: "Target: flags (u32).",
        TARGET_WORLD: "Target flag: world space (else model space).",
        RIG_HITS: "Input view: the ray hits' offset.",
        HIT_STRIDE: "Bytes per hit.",
        HIT_POINT: "Hit: point (3 f32, model space).",
        HIT_NORMAL: "Hit: unit normal (3 f32, model space).",
        HIT_FLAGS: "Hit: flags (u32).",
        HIT_VALID: "Hit flag: the ray hit something.",
        RIG_INPUT_STRIDE: "Input view: bytes per instance row.",
        RAY_STRIDE: "Output view: bytes per ray request.",
        RAY_ORIGIN: "Request: origin (3 f32, model space).",
        RAY_DIRECTION: "Request: unit direction (3 f32, model space).",
        RAY_LENGTH: "Request: length (f32).",
        RAY_FLAGS: "Request: flags (u32).",
        RAY_VALID: "Request flag: asked for this frame.",
        RAY_ROW_STRIDE: "Output view: bytes per instance row.",
        WARP_CLEAR: "`WARP_TARGET.flags`: clear the target.",
        NODE_ALL: "`RIG_RESET.node`: every rig node of the instance.",
    ],
    vectors,
};

const _: () = {
    assert!(WarpTarget::STRIDE == 44);
    assert!(RigReset::STRIDE == 12);
    assert!(RIG_INPUT_STRIDE == 1088);
    assert!(RIG_INPUT_STRIDE.is_multiple_of(16));
};
