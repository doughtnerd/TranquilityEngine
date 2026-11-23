//! Family `timeline`: timeline instances: create and control commands, state changes, and the
//! layout of their outputs (ADR 0371, 0372).
//!
//! # What a timeline is
//!
//! A **timeline asset** is a `myco.anim@1` clip used as a timeline: its property tracks sit on many
//! nodes (each track names its own node path, component and field, so a track is a binding), and
//! its keyed tracks (`event`, `marker`, `audio`, `activation`, `control`, `discrete`) work as in
//! any clip. Its `subclip` tracks play other clips (or timelines) at `start .. end` with `offset`,
//! `speed` and blend in and out regions; a subclip key's `clip` is a string id of the **owning
//! clip's** string table, which the host binds to a loaded clip handle with
//! `timeline_bind(instance, owner_clip, string_id, asset)`. Entries that overlap on one track are
//! crossfaded by their blend weights. A timeline **instance** plays one asset (or a sequence, below)
//! with its own playhead, speed, wrap mode and time mode.
//!
//! A **sequence** is a program built in Rust from tween specs: `timeline_create_sequence(SEQ_CREATE
//! followed by SEQ_MEMBER × members)`. `sequence(a, b)` is members at offsets 0 and `a`'s length,
//! `parallel(a, b)` members all at offset 0 (the host computes the offsets; a nested group adds
//! its own offset to its members'). Each member is a tween (as in the `tween` family) starting at
//! its `offset`.
//!
//! # Commands
//!
//! - `timeline_create(TIMELINE_CREATE)` and `timeline_create_sequence(bytes)` return a handle
//!   (`generation << 16 | index`; 0: refused, `last_status()` says why: `STATUS_FULL`,
//!   `STATUS_BAD_RECORD`, `STATUS_WRONG_KIND` or `STATUS_STALE_HANDLE` for the clip). Capacity comes
//!   from `timelines_configure(max_timelines, record_bytes)`.
//! - `timeline_bind(instance, owner_clip, string_id, asset)` binds one subclip string id.
//!   Nested timelines resolve through the same call (the owner is the nested clip's handle), to
//!   [`MAX_DEPTH`] levels.
//! - `timeline_control(TIMELINE_CONTROL)`: [`OP_PLAY`], [`OP_PAUSE`], [`OP_STOP`] (end open states,
//!   rewind to 0, stay stopped), [`OP_SEEK`] (to `value` seconds; fires no events), [`OP_SET_SPEED`],
//!   [`OP_KILL`] (the host cancelled it) and [`OP_DESTROYED`] (its director is gone). A stale handle
//!   answers `STATUS_STALE_HANDLE`.
//! - `timeline_info(instance, out)` writes its [`TimelineInfo`]; `timeline_blocks(instance, out)`
//!   its [`TimelineBlock`] records.
//!
//! # Wrap modes
//!
//! [`WRAP_ONCE`]: plays to the end, writes `CHANGE_FINISHED`, the instance is retired (the handle
//! goes stale; the last values stay in the fields). [`WRAP_HOLD`]: the same, but the instance stays
//! at the end, alive, until it is killed or played again ([`OP_PLAY`] at the end restarts from 0).
//! [`WRAP_LOOP`]: wraps at the end (and at 0 when playing backwards) and writes `CHANGE_LOOPED`.
//! [`WRAP_PINGPONG`]: reverses at either end and writes `CHANGE_LOOPED` at each turn. A negative
//! speed plays backwards; once and hold finish at 0 then. Keys at the end fire once per pass, and a
//! looping timeline fires keys at 0 again on each wrap (the track windows' loop rule).
//!
//! # Per frame
//!
//! `evaluate(world, pass, …)` advances every playing instance of `world` whose time mode belongs to
//! the pass (as tweens: `TIME_SCALED` and `TIME_UNSCALED` in the normal pass, `TIME_FIXED` in the
//! fixed pass), and evaluates, once, any instance that was created, seeked or stopped since.
//! `write_inputs` clears the outputs, so both passes append. Read:
//!
//! - **evaluated instances:** `timeline_active_count()` handles at `timeline_active_ptr()` (`u32`).
//!   Only these have new values this frame.
//! - **values:** an instance's blocks of words at `timeline_values_ptr() + 4·value_offset` (from its
//!   `TIMELINE_INFO`); a block of a clip timeline is a *column block* laid out as the `tracks`
//!   family says (its `COLUMN` records from `clip_columns(clip)`), f32 or u32 words. A sequence
//!   member's block is its tween's `width` floats (4 for a quaternion). `timeline_weights_ptr() +
//!   4·weight_offset` has one `f32` per block, in `[0, 1]`: how much of the block applies
//!   (0: nothing, leave the field; a subclip track's block is the crossfade's total weight).
//! - **records:** `timeline_records_len()` bytes of `tracks` family records (`EVENT`,
//!   `NOTIFY_STATE`, `ACTIVATION_EDGE`, `CONTROL`, `AUDIO`, `MARKER`, `SUBCLIP_STATE`) at
//!   `timeline_records_ptr()`, packed back to back across instances (each names its `instance`
//!   handle and the `clip` it came from, which is a nested clip for events from a subclip), and
//!   `timeline_records_dropped()`, how many did not fit.
//! - **changes:** `timeline_changes_count()` [`TimelineChange`] records at
//!   `timeline_changes_ptr()`.
//!
//! # Blocks
//!
//! A clip timeline has block 0 (`BLOCK_ROOT`: the asset's own property tracks, `column_words` of
//! the asset) and one block per `subclip` track that has a bound, compatible entry
//! (`BLOCK_SUBCLIP`, `track` its track index, words those of the first entry's clip). Entries
//! whose clip lays out its columns differently from the first are skipped (value-wise; their
//! records still fire). Within a block entries mix by weight: f32 columns by weighted average,
//! quaternion columns by sign-aligned weighted nlerp, `u32` columns take the heaviest entry's
//! word. Only entries directly under the root contribute values; nested timelines' deeper entries
//! contribute records. A sequence has one `BLOCK_MEMBER` per member (`track` its index, `column`
//! and `host_id` the member's). A block table is stable for the instance's life.
//!
//! # Records and seeks
//!
//! A seek (and the first evaluation of a created or stopped instance) fires no key: levels
//! (`discrete`, `activation`, subclip entries, sequence members' values) follow the new position,
//! open notify states the position leaves still end (`end` always follows `begin`), and a sequence
//! reports no member completion. Crossing the end of a once, hold or pingpong timeline reports each
//! key once. A paused instance is not evaluated.
//!
//! A sequence reports `CHANGE_MEMBER_DONE` (`member` = the member's `host_id`) as each member
//! completes during playback, ordered by completion time, then `CHANGE_FINISHED` when all are done
//! (wrap mode applies to the whole sequence; an infinite member never completes).

use crate::record::{Const, FamilyDesc, WireRecord};
use crate::vector::Vector;
use crate::wire_record;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 7;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// Timeline instances the table holds unless `timelines_configure` says otherwise.
pub const DEFAULT_MAX_TIMELINES: u32 = 256;
/// Bytes of `tracks` records one frame's evaluation can append (by default).
pub const DEFAULT_RECORD_BYTES: u32 = 64 * 1024;
/// Nesting levels of subclips below the root (root, nested, nested in nested).
pub const MAX_DEPTH: u32 = 3;
/// Words of an absent value (`TimelineBlock::column` of a clip block, member ids of a clip).
pub const NONE: u32 = u32::MAX;

/// [`TimelineCreate::wrap`]: play once and retire.
pub const WRAP_ONCE: u32 = 0;
/// [`TimelineCreate::wrap`]: play once and stay at the end.
pub const WRAP_HOLD: u32 = 1;
/// [`TimelineCreate::wrap`]: wrap around.
pub const WRAP_LOOP: u32 = 2;
/// [`TimelineCreate::wrap`]: reverse at each end.
pub const WRAP_PINGPONG: u32 = 3;

/// [`TimelineCreate::flags`]: start playing at once.
pub const FLAG_PLAY: u32 = 1;

/// [`TimelineControl::op`]: play (from the playhead; from 0 when finished).
pub const OP_PLAY: u32 = 1;
/// [`TimelineControl::op`]: pause.
pub const OP_PAUSE: u32 = 2;
/// [`TimelineControl::op`]: end open states, rewind to 0 and stop.
pub const OP_STOP: u32 = 3;
/// [`TimelineControl::op`]: move the playhead to `value` seconds (no events).
pub const OP_SEEK: u32 = 4;
/// [`TimelineControl::op`]: set the speed to `value` (negative plays backwards).
pub const OP_SET_SPEED: u32 = 5;
/// [`TimelineControl::op`]: the host cancelled it (`CHANGE_KILLED`).
pub const OP_KILL: u32 = 6;
/// [`TimelineControl::op`]: its director or targets are gone (`CHANGE_DESTROYED`).
pub const OP_DESTROYED: u32 = 7;

/// [`TimelineChange::kind`]: played to its end.
pub const CHANGE_FINISHED: u32 = 1;
/// [`TimelineChange::kind`]: wrapped (loop) or turned (pingpong).
pub const CHANGE_LOOPED: u32 = 2;
/// [`TimelineChange::kind`]: killed by the host.
pub const CHANGE_KILLED: u32 = 3;
/// [`TimelineChange::kind`]: destroyed with its target.
pub const CHANGE_DESTROYED: u32 = 4;
/// [`TimelineChange::kind`]: a sequence member completed (`member`).
pub const CHANGE_MEMBER_DONE: u32 = 5;

/// [`TimelineBlock::kind`]: the asset's own property tracks.
pub const BLOCK_ROOT: u32 = 0;
/// [`TimelineBlock::kind`]: the mixed entries of a `subclip` track.
pub const BLOCK_SUBCLIP: u32 = 1;
/// [`TimelineBlock::kind`]: a sequence member's value.
pub const BLOCK_MEMBER: u32 = 2;

wire_record! {
    /// Command: create an instance of a clip used as a timeline.
    pub struct TimelineCreate: family(ID, VERSION), kind(1) {
        /// The World it runs in.
        world: u32,
        /// The host's id, echoed in its state changes.
        host_id: u32,
        /// The timeline clip's handle.
        clip: u32,
        /// `TIME_SCALED`, `TIME_UNSCALED`, `TIME_FIXED` (`tween` family).
        time_mode: u32,
        /// `WRAP_*`.
        wrap: u32,
        /// `FLAG_PLAY`.
        flags: u32,
        /// Playback speed (negative plays backwards).
        speed: f32,
        /// The start time, seconds.
        start: f32,
    }
}

wire_record! {
    /// Command head: create a sequence; `members` `SEQ_MEMBER` records follow it.
    pub struct SeqCreate: family(ID, VERSION), kind(2) {
        /// The World it runs in.
        world: u32,
        /// The host's id, echoed in its state changes.
        host_id: u32,
        /// `TIME_SCALED`, `TIME_UNSCALED`, `TIME_FIXED`.
        time_mode: u32,
        /// `WRAP_*`.
        wrap: u32,
        /// `FLAG_PLAY`.
        flags: u32,
        /// Playback speed.
        speed: f32,
        /// Members that follow (at most 4,096).
        members: u32,
    }
}

wire_record! {
    /// One tween of a sequence, starting `offset` seconds into it.
    pub struct SeqMember: family(ID, VERSION), kind(3) {
        /// The host's id for this tween, echoed in `CHANGE_MEMBER_DONE`.
        host_id: u32,
        /// The host's id for the target column, in the block table.
        column: u32,
        /// `KIND_VALUE`, `KIND_QUAT_NLERP`, `KIND_QUAT_SLERP` (`tween` family).
        value_kind: u32,
        /// Floats of a `KIND_VALUE` tween, 1 to 4.
        width: u32,
        /// An easing id.
        ease: u32,
        /// `FLAG_RELATIVE`, `FLAG_YOYO` (`tween` family).
        flags: u32,
        /// Cycles (0 counts as 1), or `LOOPS_INFINITE`.
        loops: u32,
        /// Seconds into the sequence at which the tween's delay starts.
        offset: f32,
        /// Seconds per cycle.
        duration: f32,
        /// Seconds before its first cycle.
        delay: f32,
        from0: f32,
        from1: f32,
        from2: f32,
        from3: f32,
        to0: f32,
        to1: f32,
        to2: f32,
        to3: f32,
    }
}

wire_record! {
    /// Command: control an instance.
    pub struct TimelineControl: family(ID, VERSION), kind(4) {
        /// The instance handle.
        handle: u32,
        /// `OP_*`.
        op: u32,
        /// `OP_SEEK`'s time, `OP_SET_SPEED`'s speed; else 0.
        value: f32,
    }
}

wire_record! {
    /// Output: an instance's state changed (resolves its promise; feeds director events).
    pub struct TimelineChange: family(ID, VERSION), kind(5) {
        /// The instance handle.
        instance: u32,
        /// The host's id from the create command.
        host_id: u32,
        /// `CHANGE_*`.
        kind: u32,
        /// `CHANGE_MEMBER_DONE`: the member's `host_id`; else `NONE`.
        member: u32,
        /// The playhead when it happened.
        time: f32,
    }
}

wire_record! {
    /// Reply of `timeline_info`: where an instance's outputs sit.
    pub struct TimelineInfo: family(ID, VERSION), kind(6) {
        /// The instance handle.
        instance: u32,
        /// The first value word (in `timeline_values_ptr`'s words).
        value_offset: u32,
        /// Value words over every block.
        value_words: u32,
        /// The first weight (in `timeline_weights_ptr`'s floats).
        weight_offset: u32,
        /// Blocks (= weights).
        blocks: u32,
        /// The timeline's duration in seconds (infinity: a sequence with an endless member).
        duration: f32,
    }
}

wire_record! {
    /// One block of an instance's value words (`timeline_blocks`).
    pub struct TimelineBlock: family(ID, VERSION), kind(7) {
        /// The block's index (its weight is `weights[weight_offset + index]`).
        index: u32,
        /// `BLOCK_ROOT`, `BLOCK_SUBCLIP` or `BLOCK_MEMBER`.
        kind: u32,
        /// The first word, relative to the instance's `value_offset`.
        offset: u32,
        /// Words.
        words: u32,
        /// A subclip block's track index, a member block's member index; else 0.
        track: u32,
        /// A member block's `column`; else `NONE`.
        column: u32,
        /// A member block's `host_id`; else `NONE`.
        host_id: u32,
    }
}

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    vec![
        Vector::of(
            "timeline_create",
            &TimelineCreate {
                world: 2,
                host_id: 40,
                clip: 0x0002_0005,
                time_mode: 1,
                wrap: WRAP_PINGPONG,
                flags: FLAG_PLAY,
                speed: -0.5,
                start: 1.25,
            },
        ),
        Vector::of(
            "seq_create",
            &SeqCreate {
                world: 0,
                host_id: 7,
                time_mode: 0,
                wrap: WRAP_LOOP,
                flags: 0,
                speed: 1.0,
                members: 3,
            },
        ),
        Vector::of(
            "seq_member",
            &SeqMember {
                host_id: 11,
                column: 5,
                value_kind: 0,
                width: 2,
                ease: 6,
                flags: 3,
                loops: 0xFFFF_FFFF,
                offset: 0.5,
                duration: 0.25,
                delay: 0.125,
                from0: 1.0,
                from1: -1.0,
                from2: 0.0,
                from3: 0.0,
                to0: 2.0,
                to1: 3.0,
                to2: 0.0,
                to3: 0.0,
            },
        ),
        Vector::of(
            "timeline_control_seek",
            &TimelineControl {
                handle: 0x0001_0003,
                op: OP_SEEK,
                value: 2.5,
            },
        ),
        Vector::of(
            "timeline_change_member_done",
            &TimelineChange {
                instance: 0x0001_0003,
                host_id: 40,
                kind: CHANGE_MEMBER_DONE,
                member: 11,
                time: 0.875,
            },
        ),
        Vector::of(
            "timeline_info",
            &TimelineInfo {
                instance: 0x0002_0001,
                value_offset: 128,
                value_words: 20,
                weight_offset: 6,
                blocks: 3,
                duration: 2.5,
            },
        ),
        Vector::of(
            "timeline_block_member",
            &TimelineBlock {
                index: 2,
                kind: BLOCK_MEMBER,
                offset: 12,
                words: 4,
                track: 2,
                column: 77,
                host_id: 11,
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
    name: "timeline",
    id: ID,
    version: VERSION,
    doc: "Wire family `timeline`: timeline instances: create and control commands, state changes and the layout of their outputs (ADR 0371, 0372).\nnative/anim/crates/anim-wire/src/timeline.rs documents what a timeline is, its wrap modes, its views and its blocks.",
    records: &[
        TimelineCreate::DESC,
        SeqCreate::DESC,
        SeqMember::DESC,
        TimelineControl::DESC,
        TimelineChange::DESC,
        TimelineInfo::DESC,
        TimelineBlock::DESC,
    ],
    consts: consts![
        DEFAULT_MAX_TIMELINES: "Timeline instances the table holds unless `timelines_configure` says otherwise.",
        DEFAULT_RECORD_BYTES: "Bytes of `tracks` records one frame's timeline evaluation can append (by default).",
        MAX_DEPTH: "Nesting levels of subclips: root, nested, nested in nested.",
        NONE: "An absent id (`TIMELINE_BLOCK.column`, `TIMELINE_CHANGE.member`).",
        WRAP_ONCE: "Wrap mode: play once and retire.",
        WRAP_HOLD: "Wrap mode: play once and stay at the end.",
        WRAP_LOOP: "Wrap mode: wrap around.",
        WRAP_PINGPONG: "Wrap mode: reverse at each end.",
        FLAG_PLAY: "`TIMELINE_CREATE.flags`: start playing at once.",
        OP_PLAY: "`TIMELINE_CONTROL.op`: play.",
        OP_PAUSE: "`TIMELINE_CONTROL.op`: pause.",
        OP_STOP: "`TIMELINE_CONTROL.op`: rewind to 0 and stop.",
        OP_SEEK: "`TIMELINE_CONTROL.op`: move the playhead (no events).",
        OP_SET_SPEED: "`TIMELINE_CONTROL.op`: set the speed.",
        OP_KILL: "`TIMELINE_CONTROL.op`: the host cancelled it.",
        OP_DESTROYED: "`TIMELINE_CONTROL.op`: its director is gone.",
        CHANGE_FINISHED: "`TIMELINE_CHANGE.kind`: played to its end.",
        CHANGE_LOOPED: "`TIMELINE_CHANGE.kind`: wrapped or turned.",
        CHANGE_KILLED: "`TIMELINE_CHANGE.kind`: killed by the host.",
        CHANGE_DESTROYED: "`TIMELINE_CHANGE.kind`: destroyed with its target.",
        CHANGE_MEMBER_DONE: "`TIMELINE_CHANGE.kind`: a sequence member completed.",
        BLOCK_ROOT: "`TIMELINE_BLOCK.kind`: the asset's own property tracks.",
        BLOCK_SUBCLIP: "`TIMELINE_BLOCK.kind`: the mixed entries of a subclip track.",
        BLOCK_MEMBER: "`TIMELINE_BLOCK.kind`: a sequence member's value.",
    ],
    vectors,
};
