//! The command batch and REPLAY (ADR 0157 section 4.2; ADR 0162 §4.1–§4.2 for M3): the batch
//! header, the record head and every opcode. The M3 records' tables are in `spatial.rs`.

use crate::model::*;

/// Flag bits of the batch header (`flags`, offset 12).
const BATCH_FLAGS: &[Bits] = &[
    Bits::bit("overflowed", 0, "the writer dropped records this batch"),
    Bits::bit("firstChunk", 1, "first chunk of a REPLAY (begins with RESET)"),
    Bits::bit("lastChunk", 2, "last chunk of a REPLAY"),
];

/// Flag bits of a voice (`flags` of PLAY, bits 0-7 of `flags` of SET_PARAMS). Only `panner` is
/// read from SET_PARAMS `flags`; `ambisonic` and `fadeZero` only from PLAY. Bits 9-15 are reserved.
const VOICE_FLAGS: &[Bits] = &[
    Bits::bit("loop", 0, "loop the clip"),
    Bits::bit("stream", 1, "a stream voice (STREAM_OPEN), not a clip"),
    Bits::bit("wantsPlayhead", 2, "report the playhead in STATUS"),
    Bits::bit("mixed", 3, "mixed (1) or virtual (0)"),
    Bits::bit("spatial", 4, "spatialised; the panner applies"),
    Bits::range("panner", 5, 2, "0 equal-power, 1 HRTF, 2 bed (ADR 0162 C1: the bus's bed slot, equal-power without one), 3 reserved; spatial voices only"),
    Bits::bit("ambisonic", 7, "a B-format clip or stream voice of 4, 9 or 16 channels (ADR 0162 C1); spatial, panner and dir are ignored; read from PLAY only"),
    Bits::bit("fadeZero", 8, "the voice starts with its fade ramp at 0, so an incoming stem is silent without touching gain; a stamped FADE to 1 opens it (ADR 0166 M4, API section 4.1); read from PLAY only"),
];

/// The `shape` word appended to FADE, SET_PARAMS and STOP (ADR 0166 M4, API section 4.2): bits 0-2
/// `law`, bits 16-31 `startPhase`. An older, shorter record reads it as 0 (linear, phase 0).
const SHAPE_BITS: &[Bits] = &[
    Bits::range("law", 0, 3, "0 linear, 1 sCurve, 2 equalPowerIn, 3 equalPowerOut (FadeLaw); 4-7 reserved"),
    Bits::range("startPhase", 16, 16, "start phase of the curve as u0.16: value / 65,536"),
];

const SHAPE: Field = Field::new("shape", Ty::U32)
    .appended()
    .flags(SHAPE_BITS)
    .doc("law and start phase of the ramp (envelope 1.2); a record without the word reads 0");

/// SET_PARAMS `mask`: which parameters the record sets.
const SET_PARAMS_MASK: &[Bits] = &[
    Bits::bit("gain", 0, "gain"),
    Bits::bit("pitch", 1, "pitch"),
    Bits::bit("dir", 2, "dirX, dirY, dirZ"),
    Bits::bit("lpHz", 3, "lpHz"),
    Bits::bit("score", 4, "score"),
    Bits::bit("bus", 5, "bus"),
    Bits::bit("flags", 6, "flags (the panner bits)"),
];

/// FADE `flags`.
const FADE_FLAGS: &[Bits] = &[Bits::bit("stopAtEnd", 0, "stop the voice at the end of the fade")];

/// One effect of a BUS_CONFIG bus: `u32 type; f32 p[7]`.
const EFFECTS: Repeat = Repeat {
    name: "effects",
    count_field: "effectCount",
    item: &[
        Field::new("type", Ty::U32).doc("0 lowpass, 1 highpass, 2 compressor, 3 reverb send"),
        Field::new("p", Ty::F32).array(7).doc("parameters; q in dB; unused p = 0"),
    ],
    then: None,
    max: 0,
};

/// BUS_CONFIG buses: `u16 parent (0xFFFF root); u16 effectCount`, then the effects.
const BUS_CONFIG_BUSES: Repeat = Repeat {
    name: "buses",
    count_field: "busCount",
    item: &[
        Field::new("parent", Ty::U16).doc("parent bus index; 0xFFFF is the root"),
        Field::new("effectCount", Ty::U16),
    ],
    then: Some(&EFFECTS),
    max: 0,
};

/// BUS_MIX buses: `f32 gain; f32 lpHz` (24000 is off).
const BUS_MIX_BUSES: Repeat = Repeat {
    name: "buses",
    count_field: "busCount",
    item: &[
        Field::new("gain", Ty::F32),
        Field::new("lpHz", Ty::F32).doc("low-pass cutoff; 24000 off"),
    ],
    then: None,
    max: 0,
};

/// SET_LOOP `flags` (ADR 0158 §4).
const SET_LOOP_FLAGS: &[Bits] = &[Bits::bit("looping", 0, "loop the region; clear is a release (play on to the clip's end)")];

/// One automation binding of AUTOMATE and BUS_AUTOMATE (ADR 0158 §3): `u16 param; u16 curve; u32 target`.
const BINDING_ITEM: &[Field] = &[
    Field::new("param", Ty::U16).doc("bit15 set: global slot (low 15 bits); clear: local slot of the voice's group"),
    Field::new("curve", Ty::U16).doc("curve id (CURVES)"),
    Field::new("target", Ty::U32).doc("0 volume (gain multiplier), 1 pitch (ratio multiplier), 2 lowpass (Hz)"),
];

/// AUTOMATE bindings: at most 8 per voice are kept.
const AUTOMATE_BINDINGS: Repeat = Repeat { name: "bindings", count_field: "bindingCount", item: BINDING_ITEM, then: None, max: 0 };

/// BUS_AUTOMATE bindings: global parameters only; target 0 volume or 2 lowpass; at most 8 per bus.
const BUS_AUTOMATE_BINDINGS: Repeat = Repeat { name: "bindings", count_field: "bindingCount", item: BINDING_ITEM, then: None, max: 0 };

/// One CURVES key: `f32 x; f32 y; u32 interp`.
const CURVE_KEYS: Repeat = Repeat {
    name: "keys",
    count_field: "keyCount",
    item: &[
        Field::new("x", Ty::F32),
        Field::new("y", Ty::F32),
        Field::new("interp", Ty::U32).doc("shape to the next key: 0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut"),
    ],
    then: None,
    max: 0,
};

/// CURVES curves: `u16 keyCount; u16 reserved`, then the keys (sorted by x; at most 32 kept).
const CURVES_CURVES: Repeat = Repeat {
    name: "curves",
    count_field: "curveCount",
    item: &[Field::new("keyCount", Ty::U16), Field::new("reserved", Ty::U16)],
    then: Some(&CURVE_KEYS),
    max: 0,
};

/// Body header, 16 bytes: `f64 firstFrame` (0), `u32 count` (8), `u32 flags` (12; bit0 overflowed,
/// bit1 first chunk, bit2 last chunk of a REPLAY).
pub const BATCH_HEADER: &[Field] = &[
    Field::new("firstFrame", Ty::F64)
        .doc("earliest absolute frame among the records, or the host's estimate if none"),
    Field::new("count", Ty::U32).doc("number of records"),
    Field::new("flags", Ty::U32).flags(BATCH_FLAGS),
];

/// Record head, 12 bytes: `u16 opcode; u16 words; u32 voiceId; u32 frameOffset`. `words` is the
/// total record length in u32 words; `frameOffset` 0xFFFFFFFF means asap.
pub const RECORD_HEAD: &[Field] = &[
    Field::new("opcode", Ty::U16),
    Field::new("words", Ty::U16).doc("total record length in u32 words"),
    Field::new("voiceId", Ty::U32).doc("voice, bus index, or 0"),
    Field::new("frameOffset", Ty::U32).doc("frame after firstFrame; 0xFFFFFFFF is asap"),
];

/// Every opcode of the section 4.2 tables (ADR 0157, and ADR 0162's SET_VOICE_FX, BED_CONFIG,
/// ZONE_CONFIG and LISTENER from `spatial.rs`), in id order, with `total_bytes` from the tables'
/// "Total B". Payloads exclude the record head.
pub const OPCODES: &[Opcode] = &[
    Opcode {
        id: 0x01,
        name: "PLAY",
        payload: Body::fixed(&[
            Field::new("clip", Ty::U32).doc("clip id"),
            Field::new("bus", Ty::U16).doc("bus index"),
            Field::new("flags", Ty::U16).flags(VOICE_FLAGS),
            Field::new("group", Ty::U16),
            Field::new("reserved", Ty::U16),
            Field::new("gain", Ty::F32),
            Field::new("pitch", Ty::F32),
            Field::new("dirX", Ty::F32),
            Field::new("dirY", Ty::F32),
            Field::new("dirZ", Ty::F32),
            Field::new("lpHz", Ty::F32),
            Field::new("score", Ty::F32),
            Field::new("startOffsetFrames", Ty::U32),
        ]),
        total_bytes: Some(56),
        sent: true,
        doc: "start a voice; does not ramp",
    },
    Opcode {
        id: 0x02,
        name: "STOP",
        payload: Body::fixed(&[
            Field::new("fadeFrames", Ty::U32).doc("0 is now"),
            Field::new("reason", Ty::U32),
            SHAPE,
        ]),
        total_bytes: Some(24),
        sent: true,
        doc: "stop a voice",
    },
    Opcode {
        id: 0x03,
        name: "SET_PARAMS",
        payload: Body::fixed(&[
            Field::new("mask", Ty::U32).flags(SET_PARAMS_MASK),
            Field::new("gain", Ty::F32),
            Field::new("pitch", Ty::F32),
            Field::new("dirX", Ty::F32),
            Field::new("dirY", Ty::F32),
            Field::new("dirZ", Ty::F32),
            Field::new("lpHz", Ty::F32).doc("low-pass cutoff, applied to every voice below LP_TOP (ADR 0162 §4.1), ramped in log-Hz"),
            Field::new("score", Ty::F32),
            Field::new("bus", Ty::U32),
            Field::new("rampFrames", Ty::U32),
            Field::new("flags", Ty::U32).flags(VOICE_FLAGS).doc("only the panner bits are read"),
            SHAPE,
        ]),
        total_bytes: Some(60),
        sent: true,
        doc: "set voice parameters; ramps over rampFrames",
    },
    Opcode {
        id: 0x04,
        name: "FADE",
        payload: Body::fixed(&[
            Field::new("target", Ty::F32),
            Field::new("frames", Ty::U32),
            Field::new("flags", Ty::U32).flags(FADE_FLAGS),
            SHAPE,
        ]),
        total_bytes: Some(28),
        sent: true,
        doc: "fade a voice's gain to target",
    },
    Opcode {
        id: 0x05,
        name: "SET_MIXED",
        payload: Body::fixed(&[
            Field::new("mixed", Ty::U32).doc("0 virtual, 1 mixed"),
            Field::new("gain", Ty::F32),
            Field::new("dirX", Ty::F32),
            Field::new("dirY", Ty::F32),
            Field::new("dirZ", Ty::F32),
            Field::new("lpHz", Ty::F32),
        ]),
        total_bytes: Some(36),
        sent: true,
        doc: "move a voice between mixed and virtual",
    },
    Opcode {
        id: 0x06,
        name: "SET_PAUSED",
        payload: Body::fixed(&[Field::new("paused", Ty::U32)]),
        total_bytes: Some(16),
        sent: true,
        doc: "pause or resume the mix",
    },
    Opcode {
        id: 0x07,
        name: "SEEK",
        payload: Body::fixed(&[
            Field::new("clipFrame", Ty::U32),
            Field::new("epoch", Ty::U32).doc("streams: the seek epoch; clips: 0"),
        ]),
        total_bytes: Some(20),
        sent: true,
        doc: "seek a voice; drops chunks of older epochs",
    },
    Opcode {
        id: 0x08,
        name: "SET_LOOP",
        payload: Body::fixed(&[
            Field::new("loopStartFrame", Ty::U32).doc("clip frames"),
            Field::new("loopEndFrame", Ty::U32).doc("clip frames; 0 is the clip's end"),
            Field::new("flags", Ty::U32).flags(SET_LOOP_FLAGS),
        ]),
        total_bytes: Some(24),
        sent: true,
        doc: "a clip voice's loop region, or its release (ADR 0158 §4); overrides PLAY's loop flag",
    },
    Opcode {
        id: 0x09,
        name: "AUTOMATE",
        payload: Body::with_tail(&[Field::new("bindingCount", Ty::U32)], Tail::Repeat(&AUTOMATE_BINDINGS)),
        total_bytes: None,
        sent: true,
        doc: "replace a voice's automation bindings (ADR 0158 §3); count 0 clears them",
    },
    super::spatial::SET_VOICE_FX,
    Opcode {
        id: 0x10,
        name: "BUS_CONFIG",
        payload: Body::with_tail(
            &[Field::new("busCount", Ty::U32)],
            Tail::Repeat(&BUS_CONFIG_BUSES),
        ),
        total_bytes: None,
        sent: true,
        doc: "configure buses and their effects",
    },
    Opcode {
        id: 0x11,
        name: "BUS_MIX",
        payload: Body::with_tail(
            &[Field::new("busCount", Ty::U32), Field::new("rampFrames", Ty::U32)],
            Tail::Repeat(&BUS_MIX_BUSES),
        ),
        total_bytes: None,
        sent: true,
        doc: "set bus gain and filter; ramps over rampFrames",
    },
    Opcode {
        id: 0x12,
        name: "MASTER",
        payload: Body::fixed(&[
            Field::new("volume", Ty::F32),
            Field::new("muted", Ty::U32),
            Field::new("rampFrames", Ty::U32),
        ]),
        total_bytes: Some(24),
        sent: true,
        doc: "master volume and mute; ramps over rampFrames",
    },
    Opcode {
        id: 0x13,
        name: "CURVES",
        payload: Body::with_tail(
            &[Field::new("firstCurve", Ty::U32), Field::new("curveCount", Ty::U32)],
            Tail::Repeat(&CURVES_CURVES),
        ),
        total_bytes: None,
        sent: true,
        doc: "define or overwrite curves firstCurve.. (ADR 0158 §3); 1024 curves of at most 32 keys",
    },
    Opcode {
        id: 0x14,
        name: "PARAM",
        payload: Body::fixed(&[
            Field::new("group", Ty::U16).doc("0 global (slots 0..63), else the instance group 1..=1024 (slots 0..15)"),
            Field::new("slot", Ty::U16),
            Field::new("value", Ty::F32).doc("the target"),
            Field::new("seekPerSecond", Ty::F32).doc("0 jumps; else units per second toward the target"),
        ]),
        total_bytes: Some(24),
        sent: true,
        doc: "set a parameter's target and seek speed (ADR 0158 §3)",
    },
    Opcode {
        id: 0x15,
        name: "BUS_AUTOMATE",
        payload: Body::with_tail(&[Field::new("bindingCount", Ty::U32)], Tail::Repeat(&BUS_AUTOMATE_BINDINGS)),
        total_bytes: None,
        sent: true,
        doc: "replace a bus's automation bindings (voiceId = bus index; ADR 0158 §3)",
    },
    super::spatial::BED_CONFIG,
    super::spatial::ZONE_CONFIG,
    super::spatial::LISTENER,
    Opcode {
        id: 0x30,
        name: "RESET",
        payload: Body::fixed(&[Field::new("keepClips", Ty::U32).doc(
            "0 also resets the arena and slab classes; the first record of a rebuild's REPLAY",
        )]),
        total_bytes: Some(16),
        sent: true,
        doc: "reset the core",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn size(fields: &[Field]) -> u32 {
        fields.iter().map(|f| f.bytes()).sum()
    }

    fn offsets(fields: &[Field]) -> Vec<u32> {
        let mut at = 0;
        fields
            .iter()
            .map(|f| {
                let o = at;
                at += f.bytes();
                o
            })
            .collect()
    }

    fn op(id: u16) -> &'static Opcode {
        OPCODES.iter().find(|o| o.id == id).unwrap()
    }

    fn field<'a>(fields: &'a [Field], name: &str) -> &'a Field {
        fields.iter().find(|f| f.name == name).unwrap()
    }

    #[test]
    fn header_and_head_sizes() {
        assert_eq!(size(BATCH_HEADER), 16);
        assert_eq!(offsets(BATCH_HEADER), vec![0, 8, 12]);
        assert_eq!(BATCH_HEADER[2].bits.len(), 3);

        assert_eq!(size(RECORD_HEAD), 12);
        assert_eq!(offsets(RECORD_HEAD), vec![0, 2, 4, 8]);
    }

    #[test]
    fn opcode_ids_are_unique_and_sorted() {
        let ids: Vec<u16> = OPCODES.iter().map(|o| o.id).collect();
        assert!(ids.windows(2).all(|w| w[0] < w[1]), "ids not strictly increasing: {ids:?}");
        assert_eq!(ids, vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x20, 0x30]);
        assert!(OPCODES.iter().all(|o| o.sent));
    }

    #[test]
    fn fixed_totals_match_the_spec_column() {
        let expected: [(u16, u32); 13] = [
            (0x01, 56),
            (0x02, 24),
            (0x03, 60),
            (0x04, 28),
            (0x05, 36),
            (0x06, 16),
            (0x07, 20),
            (0x08, 24),
            (0x0A, 52),
            (0x12, 24),
            (0x14, 24),
            (0x20, 36),
            (0x30, 16),
        ];
        for (id, total) in expected {
            let o = op(id);
            assert_eq!(o.total_bytes, Some(total), "{}", o.name);
            assert_eq!(size(RECORD_HEAD) + size(o.payload.fields), total, "{}", o.name);
            assert!(matches!(o.payload.tail, Tail::None), "{}", o.name);
        }
        for id in [0x09, 0x10, 0x11, 0x13, 0x15, 0x17] {
            let o = op(id);
            assert_eq!(o.total_bytes, None, "{}", o.name);
            assert!(matches!(o.payload.tail, Tail::Repeat(_)), "{}", o.name);
        }
        assert_eq!(op(0x16).total_bytes, None);
        assert!(matches!(op(0x16).payload.tail, Tail::Arrays(_)));
    }

    #[test]
    fn play_and_set_params_carry_the_panner_bits() {
        let voice = [
            ("loop", 0u8, 1u8),
            ("stream", 1, 1),
            ("wantsPlayhead", 2, 1),
            ("mixed", 3, 1),
            ("spatial", 4, 1),
            ("panner", 5, 2),
            ("ambisonic", 7, 1),
        ];
        for id in [0x01, 0x03] {
            let flags = field(op(id).payload.fields, "flags");
            for (name, lo, width) in voice {
                let bits = flags.bits.iter().find(|b| b.name == name).unwrap_or_else(|| {
                    panic!("op {id:#x} flags lacks {name}")
                });
                assert_eq!((bits.lo, bits.width), (lo, width), "op {id:#x} {name}");
            }
        }

        let mask = field(op(0x03).payload.fields, "mask");
        let names: Vec<(&str, u8)> = mask.bits.iter().map(|b| (b.name, b.lo)).collect();
        assert_eq!(
            names,
            vec![("gain", 0), ("pitch", 1), ("dir", 2), ("lpHz", 3), ("score", 4), ("bus", 5), ("flags", 6)]
        );
    }
}
