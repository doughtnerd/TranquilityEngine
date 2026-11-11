//! The M4 interactive-music wire (ADR 0166, amended by ADR 0167; API section 4, architecture 5.3):
//! the constants and enums of the whole M4 format, generated once (tasks Z1 then W1), so no later task
//! touches the schema.
//!
//! * the per-voice family (Z1): the `shape` word on FADE, SET_PARAMS and STOP (`batch.rs`), PLAY
//!   `fadeZero` (`batch.rs`), the 176-byte STATUS header (`status.rs`) and the constants below;
//! * the gate family (W1): PLAY `gate`, STREAM_OPEN `music`, the `musicRings` and `groupStarts` STATUS
//!   sections (items below), and init `max_music_rings` (ABI 3.0).
//!
//! The constants are merged into `schema::CONSTANTS`' output by `schema::schema()`; the packers and
//! readers of the shape word and the gate are emitted by the generators from these values.

use crate::model::*;

macro_rules! c {
    ($name:literal, $value:expr, $doc:literal) => {
        Const { name: $name, value: $value as u64, doc: $doc }
    };
}

/// Every M4 constant (API section 4.5). The architect quotes these by name.
pub const CONSTANTS: &[Const] = &[
    c!("HEADER_BYTES", 176, "the STATUS header with the M4 fields, envelope included (STATUS_HEADER_BYTES); sections start here"),
    c!("MAX_MUSIC_RINGS", 16, "most music rings (init max_music_rings 0..=16, the musicRings section's cap)"),
    c!("MAX_GROUPS", 16, "group table entries in the core (ADR 0167 R9)"),
    c!("MAX_GROUP_MEMBERS", 32, "members of a group the core's table holds; a larger gate size is refused and counted"),
    c!("CURVE_ENTRIES", 255, "curve pool entries (ADR 0167 R4)"),
    c!("DUE_RECORDS", 256, "stamped records due in one quantum (the due list)"),
    c!("PARKED_RECORDS", 128, "parked records of held voices; overflow applies unrebased"),
    c!("PLAY_GATE_ID_MASK", 0x3FF, "PLAY gate bits 0-9: groupId 1..=1023, 0 = ungated"),
    c!("PLAY_GATE_SIZE_SHIFT", 10, "PLAY gate bits 10-15: groupSize - 1"),
    c!("PLAY_GATE_SIZE_MASK", 0x3F, "PLAY gate size field after the shift: groupSize - 1, 0..=63"),
    c!("PLAY_GATE_MAX_SIZE", 64, "most members a gate can state on the wire (the core's table holds MAX_GROUP_MEMBERS)"),
    c!("STREAM_OPEN_FLAG_MUSIC", 0x2, "STREAM_OPEN flags bit 1: the ring comes from the music pool; none free is refused (stream event 4)"),
    c!("STREAM_EVENT_MUSIC_FULL", 4, "STATUS streamEvents code 4: a music STREAM_OPEN found no free music ring (ADR 0167 R7)"),
    c!("SHAPE_LAW_MASK", 0x7, "shape word bits 0-2: the curve law (FadeLaw)"),
    c!("SHAPE_PHASE_SHIFT", 16, "shape word bits 16-31: startPhase as u0.16"),
    c!("SHAPE_PHASE_MASK", 0xFFFF_0000u32, "shape word startPhase bits"),
    c!("SHAPE_PHASE_SCALE", 65536, "startPhase = value / 65,536"),
    c!("FADE_CURVE_TABLE_POINTS", 1024, "points of the equal-power curve table (control-rate laws, ADR 0167 R6)"),
    c!("MUSIC_RING_EPOCH_MASK", 0x3FFF_FFFFu32, "musicRings epochFlags bits 0-29: the ring's current epoch"),
    c!("MUSIC_RING_PRIMED", 0x4000_0000u32, "musicRings epochFlags bit 30: primed (at least START_FRAMES in the current epoch, or input ended)"),
    c!("MUSIC_RING_BOUND", 0x8000_0000u32, "musicRings epochFlags bit 31: bound to a voice"),
    c!("GROUP_START_LATE", 0x1, "groupStarts flags bit 0: the group started late"),
    c!("GROUP_START_HELD", 0x2, "groupStarts flags bit 1: held and resumed"),
    c!("GROUP_START_ABANDONED", 0x4, "groupStarts flags bit 2: abandoned (give-up)"),
    c!("MAX_GROUP_STARTS_PER_BLOCK", 8, "STATUS groupStarts cap; the rest carry over like starved"),
];

/// Enumerations of the M4 format.
pub const ENUMS: &[Enum] = &[Enum {
    name: "FadeLaw",
    doc: "shape word bits 0-2: the law of a gain ramp (FADE, SET_PARAMS, STOP)",
    variants: &[
        ("Linear", 0, "linear: today's behaviour"),
        ("SCurve", 1, "S-curve"),
        ("EqualPowerIn", 2, "equal power, rising"),
        ("EqualPowerOut", 3, "equal power, falling"),
    ],
}];

/// STATUS `musicRings` item (API section 4.4, 8 B): every open music ring, a level reported each STATUS
/// so a lost report repairs itself. `epochFlags`: bits 0-29 the ring's current epoch
/// (`MUSIC_RING_EPOCH_MASK`), bit 30 primed (`MUSIC_RING_PRIMED`), bit 31 bound (`MUSIC_RING_BOUND`).
pub const MUSIC_RINGS_ITEM: &[Field] = &[
    Field::new("streamId", Ty::U32),
    Field::new("epochFlags", Ty::U32).doc("bits 0-29 epoch, bit 30 primed, bit 31 bound"),
];

/// STATUS `groupStarts` item (API section 4.4, 16 B): one per group. `flags`: bit 0 late, bit 1 held
/// and resumed, bit 2 abandoned (`GROUP_START_*`).
pub const GROUP_STARTS_ITEM: &[Field] = &[
    Field::new("groupId", Ty::U16),
    Field::new("flags", Ty::U16).doc("bit 0 late, bit 1 held and resumed, bit 2 abandoned"),
    Field::new("slipFrames", Ty::U32),
    Field::new("startFrameLo", Ty::U32).doc("low 32 bits of the start frame"),
    Field::new("startFrameHi", Ty::U32).doc("high 32 bits of the start frame"),
];
