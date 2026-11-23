//! Family `core`: the init parameters, the memory-needed reply (ADR 0370, after audio 0341/0328),
//! the per-frame commands and state-change records, and the layouts of the per-frame views.
//!
//! # Setup
//!
//! `init(INIT)` answers `MEMORY_NEEDED` and (re)starts the core with those limits: every handle
//! from before is gone. Assets load from bytes the host passes (`load_skeleton`, `load_clip`,
//! `load_graph`, `load_mask`) and come back as **handles**; instances are created for a skeleton
//! and an optional graph. A handle is `generation << 16 | index` ([`HANDLE_INDEX_MASK`],
//! [`HANDLE_GENERATION_SHIFT`]) and never 0; a released or destroyed one is stale, and calls with
//! it do nothing (status [`STATUS_STALE_HANDLE`]). Calls that return a handle return 0 on failure,
//! and `last_status()` says why.
//!
//! # The frame
//!
//! Per frame the host makes a fixed number of calls, never one per character (ADR 0370):
//!
//! 1. It writes each instance's row of the **input view** ([`INPUT_STRIDE`] bytes per instance
//!    index, at `inputs_ptr()`): time scale, LOD step, flags, layer weights. `create_instance`
//!    fills the row with defaults.
//! 2. It writes commands ([`Play`], [`Stop`], [`SetLayer`]) back to back into the **command
//!    buffer** (`commands_ptr()`, [`COMMAND_BYTES`] bytes) and calls
//!    `write_inputs(byteLength)`, which applies them and returns how many it applied. It also
//!    clears the state-change buffer, so call it every frame (with 0 when there are no commands).
//! 3. `evaluate(world, pass, dtScaled, dtUnscaled)` runs every instance of `world` whose
//!    [`FLAG_FIXED`] matches `pass` ([`PASS_NORMAL`], [`PASS_FIXED`]) and returns the number of
//!    [`StateChange`] records waiting at `changes_ptr()`.
//! 4. It reads the **output views**: bone matrices (`matrices_ptr()`: per instance index
//!    `maxBones · 12` floats, [`MATRIX_FLOATS`] per bone, 3×4 row-major `model × inverse bind`,
//!    decision D10) and root-motion deltas (`roots_ptr()`: [`ROOT_STRIDE`] bytes per instance
//!    index: translation x, y, z then rotation x, y, z, w, in the character's frame at the start of
//!    the step), and each instance's **track region** (`tracks_ptr()`: [`TRACK_STRIDE`] bytes
//!    per instance index): at [`TRACK_HEADER`] the `tracks` family's `OUTPUT_HEADER`, at
//!    [`TRACK_COLUMN_CLIP`] the `u32` handle of the clip whose column block fills
//!    [`TRACK_COLUMNS`] (the instance's highest-weight playing clip; 0 for none;
//!    [`TRACK_COLUMN_WORDS`] words at most, its `COLUMN` records from `clip_columns`), and at
//!    [`TRACK_RECORDS`] the frame's `tracks` records ([`TRACK_RECORD_BYTES`] bytes at most;
//!    events, notify states, markers… of every contributing clip at its effective weight).
//!
//! Views are byte offsets into the module's memory; re-create typed arrays after any load or
//! create call, which may grow it (`evaluate` and `write_inputs` never do).

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 1;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// Status: done.
pub const STATUS_OK: u32 = 0;
/// Status: the record was short, or of another opcode or version.
pub const STATUS_BAD_RECORD: u32 = 1;
/// Status: too large (memory past 4 GiB, more than 65,535 instances or bones, a skeleton with more
/// bones than `max_bones`).
pub const STATUS_TOO_LARGE: u32 = 2;
/// Status: `init` hasn't run.
pub const STATUS_NOT_INITIALIZED: u32 = 3;
/// Status: the bytes aren't a valid file of the format (the anim-format reader refused them).
pub const STATUS_BAD_ASSET: u32 = 4;
/// Status: the asset or instance table is full.
pub const STATUS_FULL: u32 = 5;
/// Status: the handle was released, destroyed, or never existed.
pub const STATUS_STALE_HANDLE: u32 = 6;
/// Status: the handle is of another kind (a clip where a skeleton was expected).
pub const STATUS_WRONG_KIND: u32 = 7;
/// Status: the assets don't fit together (a clip or mask for another bone count, a snapshot of
/// another graph or skeleton, an asset-graph instance given a code-first command).
pub const STATUS_MISMATCH: u32 = 8;
/// Status: loaded, but some nodes are of kinds this build doesn't know; they pass their first input
/// through.
pub const STATUS_UNKNOWN_NODES: u32 = 9;

/// Handles: the index bits (the instance's row in every view).
pub const HANDLE_INDEX_MASK: u32 = 0xFFFF;
/// Handles: the generation is above this shift.
pub const HANDLE_GENERATION_SHIFT: u32 = 16;

/// The command buffer's size in bytes.
pub const COMMAND_BYTES: u32 = 64 * 1024;

/// The layers of the implicit graph (code-first `play`) and the layer weights per input row.
pub const MAX_LAYERS: u32 = 4;

/// Input view: bytes per instance row.
pub const INPUT_STRIDE: u32 = 32;
/// Input view: `f32` time scale (1 by default; not finite counts as 0).
pub const INPUT_TIME_SCALE: u32 = 0;
/// Input view: `u32` update-rate LOD: evaluate the pose every N frames (1, 2, 4…; 0 counts as 1)
/// and interpolate between the last two poses otherwise.
pub const INPUT_LOD_STEP: u32 = 4;
/// Input view: `u32` flags (`FLAG_*`, the culling mode in `CULL_MASK`).
pub const INPUT_FLAGS: u32 = 8;
/// Input view: `f32` × `MAX_LAYERS` layer weights (graph layers by index; layer 0 of the
/// implicit graph is the base and ignores its weight).
pub const INPUT_LAYER_WEIGHTS: u32 = 16;

/// Flag: the Animator is visible this frame (for the culling modes).
pub const FLAG_VISIBLE: u32 = 1;
/// Flag: `updateMode: "unscaled"`: advance by `dtUnscaled`.
pub const FLAG_UNSCALED: u32 = 2;
/// Flag: `updateMode: "fixed"`: evaluated by the fixed pass only.
pub const FLAG_FIXED: u32 = 4;
/// Flag: bake the root bone's ground-plane motion and yaw out of the pose (it is reported as the
/// root delta), for `rootMotion` other than `"none"`.
pub const FLAG_BAKE_ROOT: u32 = 8;
/// Flag: the culling mode's bits.
pub const CULL_MASK: u32 = 0x30;
/// Culling mode: always evaluate.
pub const CULL_ALWAYS: u32 = 0x00;
/// Culling mode: when not visible, playheads advance and the pose and root motion freeze.
pub const CULL_WHEN_VISIBLE: u32 = 0x10;
/// Culling mode: when not visible, playheads advance and root motion is reported; the pose freezes.
pub const CULL_ROOT_MOTION_ONLY: u32 = 0x20;

/// Root view: bytes per instance row.
pub const ROOT_STRIDE: u32 = 32;
/// Track region: bytes per instance row.
pub const TRACK_STRIDE: u32 = TRACK_RECORDS + TRACK_RECORD_BYTES;
/// Track region: the `tracks` family's `OUTPUT_HEADER` (16 bytes).
pub const TRACK_HEADER: u32 = 0;
/// Track region: `u32` handle of the clip whose columns fill the column block (0: none).
pub const TRACK_COLUMN_CLIP: u32 = 16;
/// Track region: the column block.
pub const TRACK_COLUMNS: u32 = 32;
/// Track region: column words at most (a clip with more property-track words writes no columns).
pub const TRACK_COLUMN_WORDS: u32 = 256;
/// Track region: the records.
pub const TRACK_RECORDS: u32 = TRACK_COLUMNS + 4 * TRACK_COLUMN_WORDS;
/// Track region: record bytes at most per frame (about 60 of the largest record; records past it
/// are counted in the header's `dropped`).
pub const TRACK_RECORD_BYTES: u32 = 4096;

/// Matrix view: floats per bone (3×4 row-major).
pub const MATRIX_FLOATS: u32 = 12;

/// `evaluate` pass: instances without `FLAG_FIXED`.
pub const PASS_NORMAL: u32 = 0;
/// `evaluate` pass: instances with `FLAG_FIXED` (before the physics step).
pub const PASS_FIXED: u32 = 1;

/// [`Play::flags`]: switch by inertialization (a cut whose pop decays over `fade`) instead of a
/// crossfade.
pub const PLAY_INERTIALIZE: u32 = 1;
/// [`Play::flags`]: loop, whatever the clip says.
pub const PLAY_LOOP: u32 = 2;
/// [`Play::flags`]: play once, whatever the clip says.
pub const PLAY_ONCE: u32 = 4;

/// [`StateChange::kind`]: the play reached its end.
pub const CHANGE_FINISHED: u32 = 1;
/// [`StateChange::kind`]: the play was replaced or stopped first.
pub const CHANGE_INTERRUPTED: u32 = 2;
/// [`StateChange::kind`]: the command was refused (`status` says why); the play never started.
pub const CHANGE_REFUSED: u32 = 3;

wire_record! {
    /// The init parameters: the one record the boundary's `init` call reads.
    pub struct Init: family(ID, VERSION), kind(1) {
        /// The most Animator instances alive at once, over every World (at most 65,535).
        max_instances: u32,
        /// The most bones in one skeleton (at most 65,535).
        max_bones: u32,
        /// The asset arena's first size in bytes; it grows only in load calls.
        arena_initial_bytes: u32,
    }
}

wire_record! {
    /// The core's reply to `init`: how much memory it needs for those parameters.
    pub struct MemoryNeeded: family(ID, VERSION), kind(2) {
        /// `STATUS_OK`, `STATUS_BAD_RECORD` or `STATUS_TOO_LARGE`.
        status: u32,
        /// The bytes needed (0 unless the status is `STATUS_OK`).
        bytes: u32,
        /// The same in 64 KiB wasm pages, rounded up.
        pages: u32,
    }
}

wire_record! {
    /// Command: play `clip` on a layer of an instance without a graph asset (the implicit graph,
    /// ADR 0372's code-first `play`/`crossfade`). With `fade` > 0 it crossfades from what the
    /// layer shows (or, mid-fade or with `PLAY_INERTIALIZE`, inertializes); 0 cuts.
    pub struct Play: family(ID, VERSION), kind(3) {
        /// The instance handle.
        instance: u32,
        /// The clip handle.
        clip: u32,
        /// The host's id for this play, echoed in its state changes (0: no events).
        play_id: u32,
        /// The layer, below `MAX_LAYERS`.
        layer: u32,
        /// Seconds.
        fade: f32,
        /// Playback speed (negative plays backwards).
        speed: f32,
        /// Start time, seconds.
        start: f32,
        /// `PLAY_INERTIALIZE`, `PLAY_LOOP`, `PLAY_ONCE`.
        flags: u32,
    }
}

wire_record! {
    /// Command: fade a layer of an implicit-graph instance out to nothing over `fade` seconds (the
    /// base layer to the rest pose).
    pub struct Stop: family(ID, VERSION), kind(4) {
        /// The instance handle.
        instance: u32,
        /// The layer, below `MAX_LAYERS`.
        layer: u32,
        /// Seconds.
        fade: f32,
        /// `PLAY_INERTIALIZE`.
        flags: u32,
    }
}

wire_record! {
    /// Command: a layer's mask and mode on an implicit-graph instance (layers 1 and up).
    pub struct SetLayer: family(ID, VERSION), kind(5) {
        /// The instance handle.
        instance: u32,
        /// The layer, 1 to `MAX_LAYERS - 1`.
        layer: u32,
        /// A mask handle, or 0 for the full body.
        mask: u32,
        /// 0 override, 1 additive.
        mode: u32,
    }
}

wire_record! {
    /// Output: a play's state changed (resolves or rejects play promises; feeds
    /// `AnimatorStateChanges`).
    pub struct StateChange: family(ID, VERSION), kind(6) {
        /// The instance handle.
        instance: u32,
        /// The layer.
        layer: u32,
        /// `CHANGE_FINISHED`, `CHANGE_INTERRUPTED` or `CHANGE_REFUSED`.
        kind: u32,
        /// The play's id from its `Play` command.
        play_id: u32,
        /// For `CHANGE_REFUSED`: the status saying why; else 0.
        status: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "init_typical",
            &Init {
                max_instances: 256,
                max_bones: 128,
                arena_initial_bytes: 4 << 20,
            },
        ),
        Vector::of(
            "init_limits",
            &Init {
                max_instances: u32::MAX,
                max_bones: 0,
                arena_initial_bytes: 0x0102_0304,
            },
        ),
        Vector::of(
            "memory_needed_ok",
            &MemoryNeeded {
                status: STATUS_OK,
                bytes: 9_000_000,
                pages: 138,
            },
        ),
        Vector::of(
            "memory_needed_too_large",
            &MemoryNeeded {
                status: STATUS_TOO_LARGE,
                bytes: 0,
                pages: 0,
            },
        ),
        Vector::of(
            "play_crossfade",
            &Play {
                instance: 0x0001_0002,
                clip: 0x0003_0004,
                play_id: 77,
                layer: 1,
                fade: 0.25,
                speed: -1.5,
                start: 0.5,
                flags: PLAY_LOOP,
            },
        ),
        Vector::of(
            "stop_inertialize",
            &Stop {
                instance: 0x0002_0001,
                layer: 0,
                fade: 0.2,
                flags: PLAY_INERTIALIZE,
            },
        ),
        Vector::of(
            "set_layer_additive",
            &SetLayer {
                instance: 0x0001_0000,
                layer: 3,
                mask: 0x0005_0006,
                mode: 1,
            },
        ),
        Vector::of(
            "state_change_refused",
            &StateChange {
                instance: 0x0001_0009,
                layer: 2,
                kind: CHANGE_REFUSED,
                play_id: 0xFFFF_FFFF,
                status: STATUS_MISMATCH,
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
    name: "core",
    id: ID,
    version: VERSION,
    doc: "Wire family `core`: the init parameters and the memory-needed reply (ADR 0370), the per-frame commands and\nstate changes, and the layouts of the input and output views (native/anim/crates/anim-wire/src/core.rs documents\nthe frame).",
    records: &[
        Init::DESC,
        MemoryNeeded::DESC,
        Play::DESC,
        Stop::DESC,
        SetLayer::DESC,
        StateChange::DESC,
    ],
    consts: consts![
        STATUS_OK: "Status: done.",
        STATUS_BAD_RECORD: "Status: the record was short, or of another opcode or version.",
        STATUS_TOO_LARGE: "Status: too large (memory past 4 GiB, more than 65,535 instances or bones, a skeleton with more bones than `maxBones`).",
        STATUS_NOT_INITIALIZED: "Status: `init` hasn't run.",
        STATUS_BAD_ASSET: "Status: the bytes aren't a valid file of the format.",
        STATUS_FULL: "Status: the asset or instance table is full.",
        STATUS_STALE_HANDLE: "Status: the handle was released, destroyed, or never existed.",
        STATUS_WRONG_KIND: "Status: the handle is of another kind.",
        STATUS_MISMATCH: "Status: the assets don't fit together (bone counts, a snapshot of another graph or skeleton, a code-first command to an asset-graph instance).",
        STATUS_UNKNOWN_NODES: "Status: loaded, but some nodes are of kinds this build doesn't know (they pass their first input through).",
        HANDLE_INDEX_MASK: "Handles: the index bits (the instance's row in every view).",
        HANDLE_GENERATION_SHIFT: "Handles: the generation is above this shift.",
        COMMAND_BYTES: "The command buffer's size in bytes.",
        MAX_LAYERS: "The layers of the implicit graph and the layer weights per input row.",
        INPUT_STRIDE: "Input view: bytes per instance row.",
        INPUT_TIME_SCALE: "Input view: `f32` time scale (1 by default).",
        INPUT_LOD_STEP: "Input view: `u32` update-rate LOD: evaluate the pose every N frames, interpolating otherwise.",
        INPUT_FLAGS: "Input view: `u32` flags (`FLAG_*`, culling mode in `CULL_MASK`).",
        INPUT_LAYER_WEIGHTS: "Input view: `f32` x `MAX_LAYERS` layer weights.",
        FLAG_VISIBLE: "Flag: visible this frame.",
        FLAG_UNSCALED: "Flag: `updateMode: \"unscaled\"`.",
        FLAG_FIXED: "Flag: `updateMode: \"fixed\"` (evaluated by the fixed pass).",
        FLAG_BAKE_ROOT: "Flag: bake root motion out of the pose (reported as the root delta).",
        CULL_MASK: "Flag: the culling mode's bits.",
        CULL_ALWAYS: "Culling mode: always evaluate.",
        CULL_WHEN_VISIBLE: "Culling mode: when not visible, playheads advance; pose and root motion freeze.",
        CULL_ROOT_MOTION_ONLY: "Culling mode: when not visible, playheads advance and root motion is reported; the pose freezes.",
        ROOT_STRIDE: "Root view: bytes per instance row (translation xyz, rotation xyzw, 4 spare).",
        TRACK_STRIDE: "Track region: bytes per instance row.",
        TRACK_HEADER: "Track region: the `tracks` family's `OUTPUT_HEADER`.",
        TRACK_COLUMN_CLIP: "Track region: `u32` handle of the clip whose columns fill the column block (0: none).",
        TRACK_COLUMNS: "Track region: the column block.",
        TRACK_COLUMN_WORDS: "Track region: column words at most.",
        TRACK_RECORDS: "Track region: the records.",
        TRACK_RECORD_BYTES: "Track region: record bytes at most per frame.",
        MATRIX_FLOATS: "Matrix view: floats per bone (3x4 row-major); an instance's row is `maxBones` bones.",
        PASS_NORMAL: "`evaluate` pass: instances without `FLAG_FIXED`.",
        PASS_FIXED: "`evaluate` pass: instances with `FLAG_FIXED`.",
        PLAY_INERTIALIZE: "`PLAY.flags`: switch by inertialization instead of a crossfade.",
        PLAY_LOOP: "`PLAY.flags`: loop, whatever the clip says.",
        PLAY_ONCE: "`PLAY.flags`: play once, whatever the clip says.",
        CHANGE_FINISHED: "`STATE_CHANGE.kind`: the play reached its end.",
        CHANGE_INTERRUPTED: "`STATE_CHANGE.kind`: the play was replaced or stopped first.",
        CHANGE_REFUSED: "`STATE_CHANGE.kind`: the command was refused (`status` says why).",
    ],
    vectors,
};

const _: () = {
    // The input row's fields fit its stride.
    assert!(INPUT_LAYER_WEIGHTS + 4 * MAX_LAYERS <= INPUT_STRIDE);
    assert!(Init::STRIDE == 16);
};
