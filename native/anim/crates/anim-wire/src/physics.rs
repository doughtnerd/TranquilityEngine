//! Family `physics`: physical animation: joint drive targets and strengths per bone, and the
//! physical-pose blend input (ADR 0340, 0342, 0345). T44r.
//!
//! # Ragdoll descriptions (setup)
//!
//! `ragdoll_create(skeleton, bytes)` takes one [`RagdollInfo`] then one [`RagdollBone`] per
//! skeleton bone, back to back (`ragdoll_build` writes the default description in this layout,
//! from a skeleton file's joint ranges or its profile roles' defaults).
//!
//! # Rows and views (per fixed step)
//!
//! `physics_configure(max_rows)` sizes the views; `physics_attach(instance, ragdoll)` gives an
//! instance a row (its index, or `NONE`). Each row has `max_bones` bone slots:
//!
//! - **Input view** (`physics_in_ptr()`, `physics_in_row_bytes()` per row): a [`RowControl`] then
//!   one [`BodyIn`] per bone, headers written by the core at attach (with strength 1, pin 1, every
//!   multiplier 1). The ragdoll plugin writes the simulated bodies after the physics step, in the
//!   character's model space (+Y up), with [`BODY_SIMULATED`] set on bones it simulates.
//! - **Output view** (`physics_out_ptr()`, `physics_out_row_bytes()` per row): a [`RowOut`] then
//!   one [`DriveOut`] per bone.
//!
//! Each fixed step: `physics_read(world)` copies the input rows into the instances'
//! `PHYSICAL_POSE` nodes (state words, so snapshots are exact); the fixed `evaluate` runs; then
//! `physics_drive(world)` writes the drive targets (from the first `PHYSICS_BLEND` node's animated
//! input, else the instance's output pose history) and the get-up facing to the output rows.

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 8;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// "None" (an unset index or state).
pub const NONE: u32 = 0xFFFF_FFFF;

/// [`RagdollBone::flags`]: the bone has a rigid body.
pub const BONE_BODY: u32 = 1;

/// [`BodyIn::flags`]: the plugin simulated this bone's body this step (its pose is valid).
pub const BODY_SIMULATED: u32 = 1;

/// [`DriveOut::flags`]: the bone has a body.
pub const DRIVE_BODY: u32 = 1;
/// [`DriveOut::flags`]: a root body: its target is in model space and its pose is the pin target.
pub const DRIVE_ROOT: u32 = 2;
/// [`DriveOut::flags`]: the angular velocity came from two poses (else zero).
pub const DRIVE_VELOCITY: u32 = 4;

/// [`RowOut::flags`]: drives were written this step.
pub const ROW_DRIVES: u32 = 1;
/// [`RowOut::flags`]: the pelvis body was simulated, so `facing` and `getup` are valid.
pub const ROW_FACING: u32 = 2;

/// [`RowOut::facing`]: unknown (no simulated pelvis).
pub const FACING_NONE: u32 = 0;
/// [`RowOut::facing`]: on its back.
pub const FACING_UP: u32 = 1;
/// [`RowOut::facing`]: on its front.
pub const FACING_DOWN: u32 = 2;

/// Status: the instance has no row (`physics_detach`, `physics_capture`), or every row is taken.
pub const STATUS_NO_ROW: u32 = 0x0801;

wire_record! {
    /// Setup: a ragdoll description's header (`ragdoll_create`, `ragdoll_build`).
    pub struct RagdollInfo: family(ID, VERSION), kind(1) {
        /// Bones that follow (= the skeleton's).
        bone_count: u32,
        /// The pelvis bone (get-up facing), or `NONE` for the first root body.
        pelvis: u32,
        /// The pelvis's local axis out of the belly: 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z.
        front: u32,
    }
}

wire_record! {
    /// Setup: one bone of a ragdoll description.
    pub struct RagdollBone: family(ID, VERSION), kind(2) {
        /// [`BONE_BODY`].
        flags: u32,
        /// The joint frame (body frame relative to the bone frame), x, y, z, w.
        frame_x: f32,
        frame_y: f32,
        frame_z: f32,
        frame_w: f32,
        /// Swing limit about Y, degrees in [0, 180].
        swing_y: f32,
        /// Swing limit about Z, degrees in [0, 180].
        swing_z: f32,
        /// Twist minimum about X, degrees in [-180, 180].
        twist_min: f32,
        /// Twist maximum, degrees in [twist_min, 180].
        twist_max: f32,
        /// Drive stiffness (≥ 0).
        stiffness: f32,
        /// Drive damping (≥ 0).
        damping: f32,
        /// Drive maximum force (≥ 0).
        max_force: f32,
        /// Muscle strength multiplier (≥ 0).
        strength: f32,
        /// Pin weight in [0, 1].
        pin: f32,
    }
}

wire_record! {
    /// Input view: a row's controls (written by the plugin; defaults at attach).
    pub struct RowControl: family(ID, VERSION), kind(3) {
        /// Global muscle strength (scales every drive; default 1).
        strength: f32,
        /// Global pin weight in [0, 1] (default 1).
        pin: f32,
        /// The get-up state for lying on the back (reported back as `RowOut.getup`), or `NONE`.
        getup_from_back: u32,
        /// The get-up state for lying on the front, or `NONE`.
        getup_from_front: u32,
    }
}

wire_record! {
    /// Input view: one bone's simulated body (model space) and muscle multiplier.
    pub struct BodyIn: family(ID, VERSION), kind(4) {
        /// [`BODY_SIMULATED`].
        flags: u32,
        pos_x: f32,
        pos_y: f32,
        pos_z: f32,
        rot_x: f32,
        rot_y: f32,
        rot_z: f32,
        rot_w: f32,
        /// This bone's strength multiplier this step (default 1).
        multiplier: f32,
    }
}

wire_record! {
    /// Output view: a row's header.
    pub struct RowOut: family(ID, VERSION), kind(5) {
        /// The instance handle.
        instance: u32,
        /// [`ROW_DRIVES`], [`ROW_FACING`].
        flags: u32,
        /// [`FACING_NONE`], [`FACING_UP`], [`FACING_DOWN`].
        facing: u32,
        /// The get-up state the facing picks (`RowControl`'s), or `NONE`.
        getup: u32,
        /// Bone records that follow with meaning (the skeleton's bone count).
        bone_count: u32,
    }
}

wire_record! {
    /// Output view: one bone's drive target.
    pub struct DriveOut: family(ID, VERSION), kind(6) {
        /// [`DRIVE_BODY`], [`DRIVE_ROOT`], [`DRIVE_VELOCITY`].
        flags: u32,
        /// The parent body's bone, or `NONE`.
        parent_body: u32,
        /// Target rotation relative to the parent body frame (a root body's: model space).
        target_x: f32,
        target_y: f32,
        target_z: f32,
        target_w: f32,
        /// Target angular velocity, rad/s, in the parent body frame.
        vel_x: f32,
        vel_y: f32,
        vel_z: f32,
        /// Scaled drive stiffness, damping and maximum force.
        stiffness: f32,
        damping: f32,
        max_force: f32,
        /// Pin weight in [0, 1].
        pin: f32,
        /// The animated body pose (model space): spawn and pin target.
        pos_x: f32,
        pos_y: f32,
        pos_z: f32,
        rot_x: f32,
        rot_y: f32,
        rot_z: f32,
        rot_w: f32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "ragdoll_info",
            &RagdollInfo {
                bone_count: 20,
                pelvis: 1,
                front: 4,
            },
        ),
        Vector::of(
            "ragdoll_bone",
            &RagdollBone {
                flags: BONE_BODY,
                frame_x: 0.0,
                frame_y: 0.0,
                frame_z: 0.0,
                frame_w: 1.0,
                swing_y: 45.0,
                swing_z: 30.0,
                twist_min: -20.0,
                twist_max: 35.0,
                stiffness: 400.0,
                damping: 40.0,
                max_force: 1000.0,
                strength: 1.0,
                pin: 0.5,
            },
        ),
        Vector::of(
            "row_control",
            &RowControl {
                strength: 0.75,
                pin: 1.0,
                getup_from_back: 3,
                getup_from_front: NONE,
            },
        ),
        Vector::of(
            "body_in",
            &BodyIn {
                flags: BODY_SIMULATED,
                pos_x: 0.1,
                pos_y: 1.0,
                pos_z: -0.25,
                rot_x: 0.0,
                rot_y: 0.70710677,
                rot_z: 0.0,
                rot_w: 0.70710677,
                multiplier: 0.5,
            },
        ),
        Vector::of(
            "row_out",
            &RowOut {
                instance: 0x0001_0002,
                flags: ROW_DRIVES | ROW_FACING,
                facing: FACING_UP,
                getup: 3,
                bone_count: 20,
            },
        ),
        Vector::of(
            "drive_out",
            &DriveOut {
                flags: DRIVE_BODY | DRIVE_VELOCITY,
                parent_body: 1,
                target_x: 0.0,
                target_y: 0.0,
                target_z: 0.38268343,
                target_w: 0.9238795,
                vel_x: 0.0,
                vel_y: 0.0,
                vel_z: 1.5,
                stiffness: 300.0,
                damping: 30.0,
                max_force: 750.0,
                pin: 0.0,
                pos_x: 0.0,
                pos_y: 1.2,
                pos_z: 0.0,
                rot_x: 0.0,
                rot_y: 0.0,
                rot_z: 0.0,
                rot_w: 1.0,
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
    name: "physics",
    id: ID,
    version: VERSION,
    doc: "Wire family `physics`: physical animation (ADR 0340, 0342, 0345): ragdoll descriptions, the per-row input view\n(simulated bodies, strengths) and output view (drive targets, get-up facing)\n(native/anim/crates/anim-wire/src/physics.rs documents them).",
    records: &[
        RagdollInfo::DESC,
        RagdollBone::DESC,
        RowControl::DESC,
        BodyIn::DESC,
        RowOut::DESC,
        DriveOut::DESC,
    ],
    consts: consts![
        NONE: "None (an unset index or state).",
        BONE_BODY: "`RAGDOLL_BONE.flags`: the bone has a rigid body.",
        BODY_SIMULATED: "`BODY_IN.flags`: the plugin simulated this bone's body this step.",
        DRIVE_BODY: "`DRIVE_OUT.flags`: the bone has a body.",
        DRIVE_ROOT: "`DRIVE_OUT.flags`: a root body (model-space target, pinned).",
        DRIVE_VELOCITY: "`DRIVE_OUT.flags`: the angular velocity came from two poses.",
        ROW_DRIVES: "`ROW_OUT.flags`: drives were written this step.",
        ROW_FACING: "`ROW_OUT.flags`: `facing` and `getup` are valid.",
        FACING_NONE: "`ROW_OUT.facing`: unknown.",
        FACING_UP: "`ROW_OUT.facing`: on its back.",
        FACING_DOWN: "`ROW_OUT.facing`: on its front.",
        STATUS_NO_ROW: "Status: the instance has no row, or every row is taken.",
    ],
    vectors,
};

const _: () = {
    assert!(RowControl::STRIDE == 20);
    assert!(BodyIn::STRIDE == 40);
    assert!(DriveOut::STRIDE == 84);
};
