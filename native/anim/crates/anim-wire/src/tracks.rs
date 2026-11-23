//! Family `tracks`: what a playing clip's tracks produce each frame (ADR 0351, 0352): a column
//! block of value words per clip binding, described once by [`Column`] records, and per-frame
//! records for crossed keys and states.
//!
//! # Per-frame output layout
//!
//! For each evaluated instance the core fills an output region:
//!
//! - **Columns:** per bound clip, a block of 32-bit words (`column_words` long), one column per
//!   property track, in track order. A [`Column`] record, written once when the clip is bound,
//!   says where each column sits (`offset` words into the block, `width` words) and how to read
//!   it (`COLUMN_F32`: f32 values of `float`..`vec4`, `color`, `quat`, `morph`, `curve` tracks;
//!   `COLUMN_U32`: a `discrete` payload id or an `activation` level 0/1). TypeScript reads the
//!   block through a `Float32Array` and a `Uint32Array` over the same words. A column flagged
//!   `COLUMN_DEFAULT` is never written (the field keeps its default; `animation.Apply` skips it).
//! - **Records:** an [`OutputHeader`], then `record_count` records packed back to back
//!   (`record_bytes` bytes; each record's opcode says which one it is and its stride how far to
//!   step): [`Event`], [`NotifyState`], [`ActivationEdge`], [`Control`], [`Audio`], [`Marker`],
//!   [`SubclipState`]. Records that didn't fit are counted in `dropped`, never half-written.
//!
//! Every record names its `instance` (the Animator instance handle) and `clip` (the clip asset
//! handle), the `track` (index in the clip's track table) and `key` (index in its `KEYS`
//! section), and times in clip seconds. Order within a frame, per clip: crossed keys in travel
//! order, then notify states, then activation edges, then subclip states.

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 2;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// [`NotifyState::phase`]: the state began.
pub const PHASE_BEGIN: u32 = 0;
/// [`NotifyState::phase`]: the state continues (once per frame).
pub const PHASE_TICK: u32 = 1;
/// [`NotifyState::phase`]: the state ended.
pub const PHASE_END: u32 = 2;

/// [`Column::column_type`]: f32 words.
pub const COLUMN_F32: u32 = 0;
/// [`Column::column_type`]: u32 words.
pub const COLUMN_U32: u32 = 1;
/// [`Column::flags`]: a dropped default channel; never written.
pub const COLUMN_DEFAULT: u32 = 1;

/// [`SubclipState::flags`]: the entry became active this frame.
pub const SUBCLIP_ENTERED: u32 = 1;
/// [`SubclipState::flags`]: the entry stopped being active this frame.
pub const SUBCLIP_EXITED: u32 = 2;

wire_record! {
    /// The head of an instance's track output region.
    pub struct OutputHeader: family(ID, VERSION), kind(1) {
        /// Words of the column blocks that follow, over every bound clip of the instance.
        column_words: u32,
        /// Bytes of the records after this header.
        record_bytes: u32,
        /// Records after this header.
        record_count: u32,
        /// Records that didn't fit this frame.
        dropped: u32,
    }
}

wire_record! {
    /// Where one property track's column sits in its clip's column block (written when the clip
    /// is bound).
    pub struct Column: family(ID, VERSION), kind(2) {
        /// The track index.
        track: u32,
        /// The track kind id (`myco.anim@1`'s track kinds).
        track_kind: u32,
        /// `COLUMN_F32` or `COLUMN_U32`.
        column_type: u32,
        /// `COLUMN_DEFAULT` or 0.
        flags: u32,
        /// The first word in the clip's column block.
        offset: u32,
        /// Words (the stride to the next column is its own width).
        width: u32,
    }
}

wire_record! {
    /// A notify crossed (an `event` key with `end == time`), past its weight threshold.
    pub struct Event: family(ID, VERSION), kind(3) {
        /// The Animator instance handle.
        instance: u32,
        /// The clip asset handle.
        clip: u32,
        track: u32,
        key: u32,
        /// Method name string id.
        method: u32,
        /// Args JSON string id, or `NONE`.
        args: u32,
        /// The key's time.
        time: f32,
        /// The clip's weight.
        weight: f32,
    }
}

wire_record! {
    /// A notify state's begin, tick or end.
    pub struct NotifyState: family(ID, VERSION), kind(4) {
        instance: u32,
        clip: u32,
        track: u32,
        key: u32,
        method: u32,
        args: u32,
        /// `PHASE_BEGIN`, `PHASE_TICK` or `PHASE_END`.
        phase: u32,
        /// Where it happened (entry or exit point, else the frame's clip time).
        time: f32,
        /// The state's start time.
        start: f32,
        /// The state's duration.
        duration: f32,
        weight: f32,
    }
}

wire_record! {
    /// An `activation` track's level changed.
    pub struct ActivationEdge: family(ID, VERSION), kind(5) {
        instance: u32,
        clip: u32,
        track: u32,
        /// 1 on, 0 off.
        active: u32,
        /// The frame's clip time.
        time: f32,
    }
}

wire_record! {
    /// A control key crossed.
    pub struct Control: family(ID, VERSION), kind(6) {
        instance: u32,
        clip: u32,
        track: u32,
        key: u32,
        /// The control kind id (`myco.anim@1`'s control kinds).
        control: u32,
        /// Target string id, or `NONE`.
        target: u32,
        /// Payload JSON string id, or `NONE`.
        payload: u32,
        time: f32,
        /// The key's `end - time`.
        duration: f32,
        weight: f32,
    }
}

wire_record! {
    /// An audio key crossed.
    pub struct Audio: family(ID, VERSION), kind(7) {
        instance: u32,
        clip: u32,
        track: u32,
        key: u32,
        /// Audio asset string id.
        asset: u32,
        /// Params JSON string id, or `NONE`.
        params: u32,
        time: f32,
        /// The key's `end - time`.
        duration: f32,
        weight: f32,
    }
}

wire_record! {
    /// A marker crossed.
    pub struct Marker: family(ID, VERSION), kind(8) {
        instance: u32,
        clip: u32,
        track: u32,
        key: u32,
        /// The marker kind id (`myco.anim@1`'s marker kinds: sync, exit, hit, cue).
        marker: u32,
        /// Name string id, or `NONE`.
        name: u32,
        time: f32,
    }
}

wire_record! {
    /// A subclip entry active this frame.
    pub struct SubclipState: family(ID, VERSION), kind(9) {
        instance: u32,
        clip: u32,
        track: u32,
        key: u32,
        /// The nested clip's asset string id.
        asset: u32,
        /// `SUBCLIP_ENTERED`, `SUBCLIP_EXITED`.
        flags: u32,
        /// The nested clip's time at the frame's end (or where the entry was left).
        local_time: f32,
        /// The nested clip's travel this frame.
        local_delta: f32,
        /// Blend weight (blend-in and blend-out ramps, the smaller).
        weight: f32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "output_header",
            &OutputHeader {
                column_words: 12,
                record_bytes: 96,
                record_count: 3,
                dropped: 1,
            },
        ),
        Vector::of(
            "column_f32",
            &Column {
                track: 4,
                track_kind: 3,
                column_type: COLUMN_F32,
                flags: 0,
                offset: 7,
                width: 3,
            },
        ),
        Vector::of(
            "column_default",
            &Column {
                track: u32::MAX - 1,
                track_kind: 7,
                column_type: COLUMN_U32,
                flags: COLUMN_DEFAULT,
                offset: 0x0102_0304,
                width: 1,
            },
        ),
        Vector::of(
            "event",
            &Event {
                instance: 0x0001_0005,
                clip: 9,
                track: 2,
                key: 17,
                method: 3,
                args: u32::MAX,
                time: 0.5,
                weight: 0.75,
            },
        ),
        Vector::of(
            "notify_state_begin",
            &NotifyState {
                instance: 1,
                clip: 2,
                track: 3,
                key: 4,
                method: 5,
                args: 6,
                phase: PHASE_BEGIN,
                time: 0.6,
                start: 0.6,
                duration: 0.3,
                weight: 1.0,
            },
        ),
        Vector::of(
            "notify_state_end",
            &NotifyState {
                instance: 1,
                clip: 2,
                track: 3,
                key: 4,
                method: 5,
                args: u32::MAX,
                phase: PHASE_END,
                time: -0.0,
                start: 1.5,
                duration: 0.5,
                weight: 0.25,
            },
        ),
        Vector::of(
            "activation_edge",
            &ActivationEdge {
                instance: 7,
                clip: 8,
                track: 9,
                active: 1,
                time: 1.25,
            },
        ),
        Vector::of(
            "control",
            &Control {
                instance: 1,
                clip: 2,
                track: 6,
                key: 11,
                control: 2,
                target: 0,
                payload: u32::MAX,
                time: 1.1,
                duration: 0.0,
                weight: 0.5,
            },
        ),
        Vector::of(
            "audio",
            &Audio {
                instance: 1,
                clip: 2,
                track: 5,
                key: 10,
                asset: 9,
                params: 12,
                time: 0.3,
                duration: 0.5,
                weight: 0.125,
            },
        ),
        Vector::of(
            "marker",
            &Marker {
                instance: 1,
                clip: 2,
                track: 4,
                key: 7,
                marker: 3,
                name: 8,
                time: 1.8,
            },
        ),
        Vector::of(
            "subclip_state",
            &SubclipState {
                instance: 1,
                clip: 2,
                track: 9,
                key: 17,
                asset: 10,
                flags: SUBCLIP_ENTERED | SUBCLIP_EXITED,
                local_time: 2.25,
                local_delta: -0.2,
                weight: 0.0,
            },
        ),
    ]
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "tracks",
    id: ID,
    version: VERSION,
    doc: "Wire family `tracks`: track outputs (ADR 0351, 0352): per bound clip a column block of value words described by COLUMN records; per frame an OUTPUT_HEADER, then EVENT, NOTIFY_STATE, ACTIVATION_EDGE, CONTROL, AUDIO, MARKER and SUBCLIP_STATE records packed back to back.",
    records: &[
        OutputHeader::DESC,
        Column::DESC,
        Event::DESC,
        NotifyState::DESC,
        ActivationEdge::DESC,
        Control::DESC,
        Audio::DESC,
        Marker::DESC,
        SubclipState::DESC,
    ],
    consts: &[
        Const { name: "PHASE_BEGIN", value: PHASE_BEGIN, doc: "`NOTIFY_STATE.phase`: the state began." },
        Const { name: "PHASE_TICK", value: PHASE_TICK, doc: "`NOTIFY_STATE.phase`: the state continues (once per frame)." },
        Const { name: "PHASE_END", value: PHASE_END, doc: "`NOTIFY_STATE.phase`: the state ended." },
        Const { name: "COLUMN_F32", value: COLUMN_F32, doc: "`COLUMN.columnType`: f32 words." },
        Const { name: "COLUMN_U32", value: COLUMN_U32, doc: "`COLUMN.columnType`: u32 words (discrete payload ids, activation 0/1)." },
        Const { name: "COLUMN_DEFAULT", value: COLUMN_DEFAULT, doc: "`COLUMN.flags`: a dropped default channel; never written." },
        Const { name: "SUBCLIP_ENTERED", value: SUBCLIP_ENTERED, doc: "`SUBCLIP_STATE.flags`: the entry became active this frame." },
        Const { name: "SUBCLIP_EXITED", value: SUBCLIP_EXITED, doc: "`SUBCLIP_STATE.flags`: the entry stopped being active this frame." },
    ],
    vectors,
};
