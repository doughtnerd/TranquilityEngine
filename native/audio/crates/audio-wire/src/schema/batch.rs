//! A0.2-L2: the command batch and REPLAY (ADR 0157 section 4.2). Transcribe the batch header, the
//! record head and every opcode into the tables below. Fill the tables marked A0.2-L2 and the
//! ignored tests.

use crate::model::*;

/// Flag bits of the batch header (`flags`, offset 12).
const BATCH_FLAGS: &[Bits] = &[
    Bits::bit("overflowed", 0, "the writer dropped records this batch"),
    Bits::bit("firstChunk", 1, "first chunk of a REPLAY (begins with RESET)"),
    Bits::bit("lastChunk", 2, "last chunk of a REPLAY"),
];

/// Flag bits of a voice (`flags` of PLAY, bits 0-6 of `flags` of SET_PARAMS). Only `panner` is
/// read from SET_PARAMS `flags`.
const VOICE_FLAGS: &[Bits] = &[
    Bits::bit("loop", 0, "loop the clip"),
    Bits::bit("stream", 1, "a stream voice (STREAM_OPEN), not a clip"),
    Bits::bit("wantsPlayhead", 2, "report the playhead in STATUS"),
    Bits::bit("mixed", 3, "mixed (1) or virtual (0)"),
    Bits::bit("spatial", 4, "spatialised; the panner applies"),
    Bits::range("panner", 5, 2, "0 equal-power, 1 HRTF, 2-3 reserved (spatial voices only)"),
];

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

/// Every opcode of the section 4.2 table, including LISTENER (0x20, `sent_in_m1: false`) and RESET
/// (0x30), in id order, with `total_bytes` from the table's "Total B" column. Payloads exclude the
/// record head.
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
        sent_in_m1: true,
        doc: "start a voice; does not ramp",
    },
    Opcode {
        id: 0x02,
        name: "STOP",
        payload: Body::fixed(&[
            Field::new("fadeFrames", Ty::U32).doc("0 is now"),
            Field::new("reason", Ty::U32),
        ]),
        total_bytes: Some(20),
        sent_in_m1: true,
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
            Field::new("lpHz", Ty::F32),
            Field::new("score", Ty::F32),
            Field::new("bus", Ty::U32),
            Field::new("rampFrames", Ty::U32),
            Field::new("flags", Ty::U32).flags(VOICE_FLAGS).doc("only the panner bits are read"),
        ]),
        total_bytes: Some(56),
        sent_in_m1: true,
        doc: "set voice parameters; ramps over rampFrames",
    },
    Opcode {
        id: 0x04,
        name: "FADE",
        payload: Body::fixed(&[
            Field::new("target", Ty::F32),
            Field::new("frames", Ty::U32),
            Field::new("flags", Ty::U32).flags(FADE_FLAGS),
        ]),
        total_bytes: Some(24),
        sent_in_m1: true,
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
        sent_in_m1: true,
        doc: "move a voice between mixed and virtual",
    },
    Opcode {
        id: 0x06,
        name: "SET_PAUSED",
        payload: Body::fixed(&[Field::new("paused", Ty::U32)]),
        total_bytes: Some(16),
        sent_in_m1: true,
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
        sent_in_m1: true,
        doc: "seek a voice; drops chunks of older epochs",
    },
    Opcode {
        id: 0x10,
        name: "BUS_CONFIG",
        payload: Body::with_tail(
            &[Field::new("busCount", Ty::U32)],
            Tail::Repeat(&BUS_CONFIG_BUSES),
        ),
        total_bytes: None,
        sent_in_m1: true,
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
        sent_in_m1: true,
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
        sent_in_m1: true,
        doc: "master volume and mute; ramps over rampFrames",
    },
    Opcode {
        id: 0x20,
        name: "LISTENER",
        payload: Body::EMPTY,
        total_bytes: None,
        sent_in_m1: false,
        doc: "reserved for M3; not sent in M1 (the main thread sends listener-space directions)",
    },
    Opcode {
        id: 0x30,
        name: "RESET",
        payload: Body::fixed(&[Field::new("keepClips", Ty::U32).doc(
            "0 also resets the arena and slab classes; the first record of a rebuild's REPLAY",
        )]),
        total_bytes: Some(16),
        sent_in_m1: true,
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
        assert_eq!(ids, vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x10, 0x11, 0x12, 0x20, 0x30]);
        assert!(!op(0x20).sent_in_m1);
        assert!(OPCODES.iter().filter(|o| o.id != 0x20).all(|o| o.sent_in_m1));
    }

    #[test]
    fn fixed_totals_match_the_spec_column() {
        let expected: [(u16, u32); 9] = [
            (0x01, 56),
            (0x02, 20),
            (0x03, 56),
            (0x04, 24),
            (0x05, 36),
            (0x06, 16),
            (0x07, 20),
            (0x12, 24),
            (0x30, 16),
        ];
        for (id, total) in expected {
            let o = op(id);
            assert_eq!(o.total_bytes, Some(total), "{}", o.name);
            assert_eq!(size(RECORD_HEAD) + size(o.payload.fields), total, "{}", o.name);
            assert!(matches!(o.payload.tail, Tail::None), "{}", o.name);
        }
        for id in [0x10, 0x11] {
            let o = op(id);
            assert_eq!(o.total_bytes, None, "{}", o.name);
            assert!(matches!(o.payload.tail, Tail::Repeat(_)), "{}", o.name);
        }
        assert_eq!(op(0x20).total_bytes, None);
        assert!(op(0x20).payload.fields.is_empty());
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
