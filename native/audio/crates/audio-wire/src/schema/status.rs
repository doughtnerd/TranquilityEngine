//! A0.2-L3: the STATUS body (ADR 0157 section 4.3). Transcribe the 112-byte header (absolute offsets,
//! envelope counted: use `.at(off)` on every field) and the sections. Fill the tables marked
//! A0.2-L3 and the ignored tests.

use crate::model::*;

/// Header fields at the spec's offsets (16..=111), `flags` with its six named bits. A0.2-L3: fill.
pub const HEADER_FIELDS: &[Field] = &[
    Field::new("currentFrame", Ty::F64).at(16),
    Field::new("dateMs", Ty::F64).at(24),
    Field::new("pingSeq", Ty::U32).at(32),
    Field::new("pingFrameLo", Ty::U32).at(36),
    Field::new("underruns", Ty::U32).at(40),
    Field::new("lateCommands", Ty::U32).at(44),
    Field::new("workUnits", Ty::U32).at(48),
    Field::new("workUnitsMax", Ty::U32).at(52),
    Field::new("mixedVoices", Ty::U16).at(56),
    Field::new("liveVoices", Ty::U16).at(58),
    Field::new("flags", Ty::U32).at(60).flags(&[
        Bits::bit("versionMismatch", 0, "the envelope major version differs (VERSION_MISMATCH)"),
        Bits::bit("arenaFull", 1, "no slab of the class and the arena cannot grow"),
        Bits::bit("inboxOverflow", 2, "the inbox could not take a message"),
        Bits::bit("adaptiveCapActive", 3, "the adaptive voice cap is limiting voices"),
        Bits::bit("ready", 4, "the core is initialised and rendering"),
        Bits::bit("trapCaught", 5, "a trap was caught in the render path"),
    ]),
    Field::new("endedCount", Ty::U16).at(64),
    Field::new("demotedCount", Ty::U16).at(66),
    Field::new("starvedCount", Ty::U16).at(68),
    Field::new("playheadCount", Ty::U16).at(70),
    Field::new("busCount", Ty::U16).at(72),
    Field::new("clipEventCount", Ty::U16).at(74),
    Field::new("streamEventCount", Ty::U16).at(76),
    Field::new("mixedCap", Ty::U16).at(78),
    Field::new("loadPermille", Ty::U16).at(80),
    Field::new("traps", Ty::U16).at(82),
    Field::new("minSlackFrames", Ty::I32).at(84),
    Field::new("underrunFrames", Ty::U32).at(88),
    Field::new("arenaUsedKB", Ty::U32).at(92),
    Field::new("arenaLargestFreeKB", Ty::U32).at(96),
    Field::new("abiVersion", Ty::U32).at(100),
    Field::new("maxLatenessFrames", Ty::U32).at(104),
    Field::new("hrtfVoices", Ty::U16).at(108),
    Field::new("hrtfLoadFailure", Ty::U16).at(110),
];

/// Sections in order: ended, demoted, starved, playheads, clipEvents, streamEvents, peaks. A0.2-L3: fill.
pub const SECTIONS: &[Section] = &[
    Section {
        name: "ended",
        item: &[Field::new("id", Ty::U32)],
        count_field: "endedCount",
        max: 1024,
        doc: "voices that ended in this block",
    },
    Section {
        name: "demoted",
        item: &[Field::new("id", Ty::U32)],
        count_field: "demotedCount",
        max: 1024,
        doc: "voices virtualised by the adaptive cap",
    },
    Section {
        name: "starved",
        item: &[Field::new("id", Ty::U32)],
        count_field: "starvedCount",
        max: 1024,
        doc: "voices that starved this block; the rest carry over",
    },
    Section {
        name: "playheads",
        item: &[Field::new("id", Ty::U32), Field::new("clipFrame", Ty::U32)],
        count_field: "playheadCount",
        max: 256,
        doc: "playheads of looping, streamed and long clips, round-robin",
    },
    Section {
        name: "clipEvents",
        item: &[Field::new("clipId", Ty::U32), Field::new("code", Ty::U32)],
        count_field: "clipEventCount",
        max: 64,
        doc: "ClipEvent codes: 1 resident, 2 refusedCeiling, 3 refusedGrow, 4 hrtfReady",
    },
    Section {
        name: "streamEvents",
        item: &[Field::new("id", Ty::U32), Field::new("code", Ty::U32)],
        count_field: "streamEventCount",
        max: 64,
        doc: "StreamEvent codes: 1 starved, 2 eos, 3 error",
    },
    Section {
        name: "peaks",
        item: &[Field::new("l", Ty::F32), Field::new("r", Ty::F32)],
        count_field: "busCount",
        // Not stated in the table. The worst case (15,728 bytes) budgets 256 bytes for peaks,
        // which is 32 buses of 8 bytes.
        max: 32,
        doc: "peak level per bus, left and right",
    },
];

pub const STATUS: StatusSpec = StatusSpec { header_bytes: 112, fields: HEADER_FIELDS, sections: SECTIONS };

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Ty;
    use crate::schema::CONSTANTS;

    fn constant(name: &str) -> u64 {
        CONSTANTS.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no constant {name}")).value
    }

    #[test]
    fn header_fields_sit_at_the_spec_offsets_without_overlap() {
        let expected: &[(&str, u32, Ty)] = &[
            ("currentFrame", 16, Ty::F64),
            ("dateMs", 24, Ty::F64),
            ("pingSeq", 32, Ty::U32),
            ("pingFrameLo", 36, Ty::U32),
            ("underruns", 40, Ty::U32),
            ("lateCommands", 44, Ty::U32),
            ("workUnits", 48, Ty::U32),
            ("workUnitsMax", 52, Ty::U32),
            ("mixedVoices", 56, Ty::U16),
            ("liveVoices", 58, Ty::U16),
            ("flags", 60, Ty::U32),
            ("endedCount", 64, Ty::U16),
            ("demotedCount", 66, Ty::U16),
            ("starvedCount", 68, Ty::U16),
            ("playheadCount", 70, Ty::U16),
            ("busCount", 72, Ty::U16),
            ("clipEventCount", 74, Ty::U16),
            ("streamEventCount", 76, Ty::U16),
            ("mixedCap", 78, Ty::U16),
            ("loadPermille", 80, Ty::U16),
            ("traps", 82, Ty::U16),
            ("minSlackFrames", 84, Ty::I32),
            ("underrunFrames", 88, Ty::U32),
            ("arenaUsedKB", 92, Ty::U32),
            ("arenaLargestFreeKB", 96, Ty::U32),
            ("abiVersion", 100, Ty::U32),
            ("maxLatenessFrames", 104, Ty::U32),
            ("hrtfVoices", 108, Ty::U16),
            ("hrtfLoadFailure", 110, Ty::U16),
        ];
        assert_eq!(HEADER_FIELDS.len(), expected.len());
        let mut end = 16;
        for (field, (name, offset, ty)) in HEADER_FIELDS.iter().zip(expected) {
            assert_eq!(field.name, *name);
            assert_eq!(field.offset, Some(*offset), "{name}");
            assert_eq!(field.ty, *ty, "{name}");
            assert_eq!(field.count, 1, "{name}");
            // Contiguous and non-overlapping: each field starts where the previous one ended.
            assert_eq!(*offset, end, "{name} overlaps or leaves a gap");
            end = offset + field.bytes();
        }
        assert_eq!(end, constant("STATUS_HEADER_BYTES") as u32);
        assert_eq!(STATUS.header_bytes, 112);
    }

    #[test]
    fn flags_bits_0_to_5() {
        let flags = HEADER_FIELDS.iter().find(|f| f.name == "flags").unwrap();
        let names: Vec<(&str, u8, u8)> = flags.bits.iter().map(|b| (b.name, b.lo, b.width)).collect();
        assert_eq!(
            names,
            vec![
                ("versionMismatch", 0, 1),
                ("arenaFull", 1, 1),
                ("inboxOverflow", 2, 1),
                ("adaptiveCapActive", 3, 1),
                ("ready", 4, 1),
                ("trapCaught", 5, 1),
            ]
        );
    }

    #[test]
    fn sections_and_caps() {
        let names: Vec<&str> = SECTIONS.iter().map(|s| s.name).collect();
        assert_eq!(names, ["ended", "demoted", "starved", "playheads", "clipEvents", "streamEvents", "peaks"]);

        let counts: Vec<&str> = SECTIONS.iter().map(|s| s.count_field).collect();
        assert_eq!(
            counts,
            ["endedCount", "demotedCount", "starvedCount", "playheadCount", "clipEventCount", "streamEventCount", "busCount"]
        );
        for s in SECTIONS {
            assert!(HEADER_FIELDS.iter().any(|f| f.name == s.count_field), "{}", s.name);
        }

        let caps: Vec<u32> = SECTIONS.iter().map(|s| s.max).collect();
        assert_eq!(caps[0..3], [1024, 1024, 1024]);
        assert_eq!(caps[3], constant("MAX_PLAYHEADS_PER_BLOCK") as u32);
        assert_eq!(caps[4], constant("MAX_CLIP_EVENTS_PER_BLOCK") as u32);
        assert_eq!(caps[5], constant("MAX_STREAM_EVENTS_PER_BLOCK") as u32);
        assert_eq!(caps[0], constant("MAX_ENDED_PER_BLOCK") as u32);
        assert_eq!(caps[1], constant("MAX_DEMOTED_PER_BLOCK") as u32);
        assert_eq!(caps[2], constant("MAX_STARVED_PER_BLOCK") as u32);

        let item_fields = |s: &Section| -> Vec<(&str, Ty)> { s.item.iter().map(|f| (f.name, f.ty)).collect() };
        assert_eq!(item_fields(&SECTIONS[0]), vec![("id", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[3]), vec![("id", Ty::U32), ("clipFrame", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[4]), vec![("clipId", Ty::U32), ("code", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[5]), vec![("id", Ty::U32), ("code", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[6]), vec![("l", Ty::F32), ("r", Ty::F32)]);
    }

    #[test]
    fn worst_case_is_15728_bytes() {
        let worst: u32 = STATUS.header_bytes
            + SECTIONS
                .iter()
                .map(|s| s.max * s.item.iter().map(|f| f.bytes()).sum::<u32>())
                .sum::<u32>();
        assert_eq!(worst, 15728);
        assert_eq!(worst as u64, constant("STATUS_WORST_CASE_BYTES"));
    }
}
