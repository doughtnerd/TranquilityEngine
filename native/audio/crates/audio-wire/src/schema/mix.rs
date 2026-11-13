//! The M5 mix wire (ADR 0171 amended by ADR 0172; design `docs/design/0171-audio-mix/api-and-models.md`
//! §4.1-§4.3): the constants of the whole M5 format, the five new command records and the three new
//! STATUS sections, generated once (task Wa1) so no later task touches the schema. Fields of later
//! milestones read 0 until their tasks fill them (M4's rule).
//!
//! `batch.rs` lists the opcodes, `status.rs` the header fields and sections, `schema.rs` merges the
//! constants below into its output; this file holds their tables. Byte offsets in the comments count
//! from the record's first byte, head included (12 B).
//!
//! `BUS_MIX` (0x11) stays generated until R0 retires it (its id stays reserved); its doc comment in
//! `batch.rs` says so.

use crate::model::*;

macro_rules! c {
    ($name:literal, $value:expr, $doc:literal) => {
        Const { name: $name, value: $value as u64, doc: $doc }
    };
}

/// Every M5 constant (API section 4.1). The architecture quotes these by name (contract S11).
pub const CONSTANTS: &[Const] = &[
    c!("MAX_LOUDNESS_BUSES", 8, "most buses with a loudness meter (LOUD_CONFIG meterCount); master is implicit"),
    c!("LOUD_METERS", 9, "meters in STATUS loudBuses: MAX_LOUDNESS_BUSES plus the final-output tap"),
    c!("LOUD_RING_SUBBLOCKS", 32, "sub-blocks of the core's loudness ring per meter (3.2 s of main stall lose nothing)"),
    c!("MAX_LOUD_ENERGIES", 288, "STATUS loudEnergies cap: LOUD_METERS x LOUD_RING_SUBBLOCKS"),
    c!("LOUD_OUTPUT_TAP", 0xFFFF, "loudBuses slot value: the final output"),
    c!("BUS_MASTER_OUT", 0xFFFF, "BUS_RAMP voiceId: the output gain (what MASTER sets today)"),
    c!("LANE_AUTHORED", 0, "gain lane 0: the project's authored bus volume (main-written)"),
    c!("LANE_RUNTIME", 1, "gain lane 1: the script's bus volume and mute (main-written)"),
    c!("LANE_SNAPSHOT", 2, "gain lane 2: the snapshot's gain and low-pass (main-written)"),
    c!("LANE_MONITOR", 3, "gain lane 3: the editor's solo and mute monitor (main-written)"),
    c!("LANE_DIP", 4, "gain lane 4: the structural-edit dip and a tombstone's silence (main-written)"),
    c!("LANE_DUCK", 5, "gain lane 5: sidechain and presence ducking (core-owned; a BUS_RAMP naming it is ignored and counted)"),
    c!("LANE_AUTOMATION", 6, "gain lane 6: BUS_AUTOMATE's gain multiplier (core-owned; a BUS_RAMP naming it is ignored and counted)"),
    c!("LANE_COUNT", 7, "lanes per bus"),
    c!("LANE_LAST_MAIN_WRITTEN", 4, "the highest lane a BUS_RAMP may name"),
    c!("MAX_DUCK_RULES", 32, "most BUS_DUCK rules, and the busDuck section's cap"),
    c!("MAX_LEVEL_RULES", 8, "most BUS_DUCK rules in level mode (flags bit 0)"),
    c!("BUS_MIN_RAMP_MS", 5, "the floor of a main-chosen ramp length: toggles and script jumps (R2)"),
    c!("DRAG_RAMP_MS", 10, "the ramp length of a continuous drag"),
    c!("FADER_COALESCE_MS", 4, "a fader drag coalesces its writes to one per this many ms"),
    c!("TOMBSTONE_TAIL_FRAMES", 128, "a tombstoned slot is recycled this many frames after its config frame, with no live voice (R9)"),
    c!("COMPRESSOR_SMOOTH_MS", 20, "a BUS_SLOT edit smooths only a compressor's parameters, over this long (R7)"),
    c!("BUS_RAMP_GAIN_MAX", 4, "BUS_RAMP gain target ceiling (clamped); a non-finite value leaves the target"),
    c!("BUS_RAMP_LP_MIN_HZ", 10, "BUS_RAMP lpHz lower bound; BUS_LP_OFF_HZ (24,000) is off"),
    c!("SHAPE_SEQUENCE_SHIFT", 3, "BUS_RAMP shape bits 3-15: sequenceId (0 = none, C27)"),
    c!("SHAPE_SEQUENCE_MASK", 0x1FFF, "BUS_RAMP shape sequenceId after the shift: 13 bits"),
    c!("BUS_SLOT_MAX_EFFECTS", 4, "effects a slot keeps; a BUS_SLOT naming more keeps the first four"),
    c!("DUCK_FLAG_LEVEL", 0x1, "BUS_DUCK rule flags bit 0: level mode (reads the trigger bus's buffer; adds a bus-order edge)"),
    c!("DUCK_FLAG_RMS", 0x2, "BUS_DUCK rule flags bit 1: the detector is RMS rather than peak"),
    c!("LOUD_FLAG_NEW_BLOCKS_MASK", 0x3F, "loudBuses flags bits 0-5: sub-blocks this meter added since the last take, 0..=32"),
    c!("LOUD_FLAG_PAUSED", 0x40, "loudBuses flags bit 6: paused by the load-shedding ladder"),
    c!("LOUD_FLAG_RESET", 0x80, "loudBuses flags bit 7: the meter was reset"),
    c!("LOUD_FLAG_LOST", 0x100, "loudBuses flags bit 8: sub-blocks were lost (firstSeq shows the gap)"),
    c!("LOUD_FLAG_GATED", 0x200, "loudBuses flags bit 9: the true-peak gate rejected a quantum"),
    c!("LOUD_FLAG_TP_GATE_ACTIVE", 0x400, "loudBuses flags bit 10: the true-peak gate is in force"),
];

/// BUS_RAMP `mask`: which targets the record sets.
const BUS_RAMP_MASK: &[Bits] = &[
    Bits::bit("gain", 0, "the gain target"),
    Bits::bit("lpHz", 1, "the lpHz target (lane 2 only: the snapshot low-pass)"),
];

/// BUS_RAMP `shape`: the law and start phase as FADE's (linear only in M5), plus the sequence tag.
const BUS_RAMP_SHAPE_BITS: &[Bits] = &[
    Bits::range("law", 0, 3, "0 linear (FadeLaw); only linear in M5"),
    Bits::range("sequenceId", 3, 13, "the structural sequence this record belongs to; 0 = none (C27)"),
    Bits::range("startPhase", 16, 16, "start phase of the curve as u0.16: value / 65,536"),
];

/// 0x18 BUS_RAMP, 32 B, the third stamped class in `due.rs` (change 27). `voiceId` is the bus slot
/// (`BUS_MASTER_OUT` the output gain); `frameOffset` the start frame or `ASAP`. Linear from the lane's
/// value at its start frame; `frames` 0 is a literal step (replay and RESET only, R2).
pub const BUS_RAMP: Opcode = Opcode {
    id: 0x18,
    name: "BUS_RAMP",
    payload: Body::fixed(&[
        Field::new("lane", Ty::U16).doc("0-4 main-written; 5 duck and 6 automation are core-owned: a record naming them is ignored and counted"), // 12
        Field::new("mask", Ty::U16).flags(BUS_RAMP_MASK),                                                                                           // 14
        Field::new("gain", Ty::F32).doc("gain target, >= 0 (clamped to 4); a non-finite value leaves the target"),                                  // 16
        Field::new("lpHz", Ty::F32).doc("low-pass target, 10..24,000 (24,000 = off); lane 2 only"),                                                  // 20
        Field::new("frames", Ty::U32).doc("ramp length from the start frame; 0 is a literal step, used by replay and RESET only (R2)"),             // 24
        Field::new("shape", Ty::U32).flags(BUS_RAMP_SHAPE_BITS).doc("law and start phase as FADE's, plus bits 3-15 sequenceId (0 = none, C27)"),    // 28
    ]),
    total_bytes: Some(32),
    sent: true,
    doc: "stamped ramp of one bus lane (voiceId = bus slot, BUS_MASTER_OUT for the output gain; ADR 0171 change 27)",
};

/// BUS_SLOT `flags`.
const BUS_SLOT_FLAGS: &[Bits] = &[
    Bits::bit("structural", 0, "applies at quantum granularity and obeys the late-batch gate"),
    Bits::bit("fresh", 1, "the slot starts zeroed with unity lanes: a re-add after recycling"),
];

/// 0x1C BUS_SLOT, variable (R7): one slot's configuration, so a parameter edit no longer resends the
/// tree. The effects are BUS_CONFIG's (`u32 type; f32 p[7]`); at most four are kept.
pub const BUS_SLOT: Opcode = Opcode {
    id: 0x1C,
    name: "BUS_SLOT",
    payload: Body::with_tail(
        &[
            Field::new("slot", Ty::U16),                                                                 // 12
            Field::new("flags", Ty::U16).flags(BUS_SLOT_FLAGS),                                          // 14
            Field::new("sequenceId", Ty::U16).doc("the structural sequence this record belongs to (13 bits, 0 = none, C27)"), // 16
            Field::new("reserved", Ty::U16).doc("reserved, 0"),                                          // 18
            Field::new("reserved2", Ty::U32).doc("reserved, 0"),                                         // 20
            Field::new("parent", Ty::U16).doc("parent slot; BUS_ROOT (0xFFFF) for a root"),              // 24
            Field::new("effectCount", Ty::U16).doc("at most 4 are kept"),                                // 26
        ],
        Tail::Repeat(&super::batch::EFFECTS),
    ),
    total_bytes: None,
    sent: true,
    doc: "one bus slot's configuration (R7); a tombstone is a silent root (R9); stamped when its sequenceId is set (C27)",
};

/// BUS_DUCK `flags`.
const BUS_DUCK_RULE_FLAGS: &[Bits] = &[
    Bits::bit("level", 0, "level mode: the trigger's buffer is read (adds a bus-order edge); clear is presence mode"),
    Bits::bit("rms", 1, "the detector is RMS rather than peak"),
];

/// One BUS_DUCK rule, 24 B.
const BUS_DUCK_RULES: Repeat = Repeat {
    name: "rules",
    count_field: "ruleCount",
    item: &[
        Field::new("target", Ty::U16).doc("the bus that is ducked"),
        Field::new("trigger", Ty::U16).doc("the bus (level) or slot (presence) that triggers it"),
        Field::new("flags", Ty::U32).flags(BUS_DUCK_RULE_FLAGS),
        Field::new("thresholdDb", Ty::F32),
        Field::new("amount", Ty::F32),
        Field::new("attack", Ty::F32),
        Field::new("release", Ty::F32),
    ],
    then: None,
    max: 32,
};

/// 0x19 BUS_DUCK, replace-all, asap only (R6): `u32 ruleCount` (at most `MAX_DUCK_RULES`, at most
/// `MAX_LEVEL_RULES` of them level), then 24 B items.
pub const BUS_DUCK: Opcode = Opcode {
    id: 0x19,
    name: "BUS_DUCK",
    payload: Body::with_tail(&[Field::new("ruleCount", Ty::U32).doc("at most 32, at most 8 level")], Tail::Repeat(&BUS_DUCK_RULES)),
    total_bytes: None,
    sent: true,
    doc: "replace all ducking rules; asap only; recomputes the bus order (R6)",
};

/// 0x1A BUS_PRESENCE, 16 B, stamped at the frame of the voice start or explicit stop.
pub const BUS_PRESENCE: Opcode = Opcode {
    id: 0x1A,
    name: "BUS_PRESENCE",
    payload: Body::fixed(&[Field::new("mask", Ty::U32).doc("bit b set while slot b has a voice (virtual and locked included)")]),
    total_bytes: Some(16),
    sent: true,
    doc: "which slots have a voice, stamped at the frame of the start or explicit stop; applies at the start of the quantum holding its frame",
};

/// One LOUD_CONFIG meter, 4 B.
const LOUD_CONFIG_METERS: Repeat = Repeat {
    name: "meters",
    count_field: "meterCount",
    item: &[Field::new("slot", Ty::U16), Field::new("reserved", Ty::U16).doc("reserved, 0")],
    then: None,
    max: 8,
};

/// 0x1B LOUD_CONFIG, replace-all, asap only: `f32 tpGateDbfs`, `u32 meterCount` (at most
/// `MAX_LOUDNESS_BUSES`; master is implicit), then 4 B items. Replacing keeps the state of meters
/// that stay.
pub const LOUD_CONFIG: Opcode = Opcode {
    id: 0x1B,
    name: "LOUD_CONFIG",
    payload: Body::with_tail(
        &[
            Field::new("tpGateDbfs", Ty::F32).doc("the selected ceiling minus 6 dB; a target change re-sends it and is not a reset"),
            Field::new("meterCount", Ty::U32).doc("at most 8; master is implicit"),
        ],
        Tail::Repeat(&LOUD_CONFIG_METERS),
    ),
    total_bytes: None,
    sent: true,
    doc: "replace the loudness meters' configuration; asap only",
};

/// `loudBuses` flags (bits 0-5 are the new-block count, `LOUD_FLAG_NEW_BLOCKS_MASK`).
const LOUD_BUSES_FLAGS: &[Bits] = &[
    Bits::range("newBlocks", 0, 6, "sub-blocks added since the last successful take, 0..=32"),
    Bits::bit("paused", 6, "paused by the load-shedding ladder"),
    Bits::bit("reset", 7, "the meter was reset"),
    Bits::bit("lost", 8, "sub-blocks were lost: firstSeq shows the gap"),
    Bits::bit("gated", 9, "the true-peak gate rejected a quantum"),
    Bits::bit("tpGateActive", 10, "the true-peak gate is in force"),
];

/// STATUS `loudBuses` item, 16 B: one per meter (`LOUD_OUTPUT_TAP` is the final output).
pub const LOUD_BUSES_ITEM: &[Field] = &[
    Field::new("slot", Ty::U16).doc("bus slot; LOUD_OUTPUT_TAP (0xFFFF) is the final output"),
    Field::new("flags", Ty::U16).flags(LOUD_BUSES_FLAGS),
    Field::new("firstSeq", Ty::U32).doc("sequence number of the first sub-block this STATUS carries for the meter"),
    Field::new("truePeak", Ty::F32).doc("linear max(true peak, sample peak) since the last successful take"),
    Field::new("gatedQuanta", Ty::U32).doc("quanta the true-peak gate rejected (cumulative)"),
];

/// STATUS `loudEnergies` item, 4 B: the K-weighted L+R mean square of a sub-block, bus-major in
/// `loudBuses` order, oldest first.
pub const LOUD_ENERGIES_ITEM: &[Field] = &[Field::new("energy", Ty::F32).doc("K-weighted L+R mean square of a sub-block")];

/// STATUS `busDuck` item, 8 B: only buses that are the target of a rule.
pub const BUS_DUCK_ITEM: &[Field] = &[
    Field::new("slot", Ty::U16),
    Field::new("pad", Ty::U16).doc("0"),
    Field::new("gain", Ty::F32).doc("the duck lane's current gain"),
];
