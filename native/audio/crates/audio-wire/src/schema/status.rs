//! The STATUS body (ADR 0157 section 4.3; ADR 0162 §4.3 and C7 for M3; ADR 0166 M4, API section 4.4): the 176-byte header
//! (absolute offsets, envelope counted: `.at(off)` on every field) and the sections. M3's section
//! items are in `spatial.rs`.

use crate::model::*;

/// Header fields at the spec's offsets (16..=175), `flags` with its seven named bits.
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
        Bits::bit("bedDecoderReady", 6, "the MagLS filters (format 4) are committed and transformed (ADR 0162)"),
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
    // ADR 0162 §4.3 (C7): 112..=143.
    Field::new("bedVoices", Ty::U16).at(112).doc("voices encoded into a bed"),
    Field::new("bedsActive", Ty::U16).at(114).doc("bed slots decoding; the beds section's count"),
    Field::new("fxVoices", Ty::U16).at(116).doc("mixed-voice pool entries with an active filter"),
    Field::new("ambisonicVoices", Ty::U16).at(118),
    Field::new("zonesActive", Ty::U16).at(120),
    Field::new("zonesRinging", Ty::U16).at(122),
    Field::new("zoneEventCount", Ty::U16).at(124),
    Field::new("bedsRefused", Ty::U16).at(126).doc("buses whose bed host failed validation (cumulative, saturating)"),
    Field::new("zoneSlots", Ty::U16).at(128).doc("zone slots reported; the zones section's count (max_zone_slots, at most 4)"),
    Field::new("m3Shed", Ty::U16).at(130).doc("the load-shedding ladder's steps taken: bed steps plus zone steps (ADR 0162 OD3, D5)"),
    Field::new("zoneUsedKB", Ty::U32).at(132).doc("zone kernels resident, KB"),
    Field::new("workBed", Ty::U32).at(136).doc("work units, last quantum: bed encode, decode, ambisonic voices"),
    Field::new("workZones", Ty::U32).at(140).doc("work units, last quantum: zone convolvers, sends, aux"),
    // ADR 0166 M4 (API section 4.4): 144..=175. The layout lands once (task Z1); the fields read 0 until their tasks fill them.
    Field::new("musicRingCount", Ty::U16).at(144).doc("the musicRings section's count (at most 16)"),
    Field::new("groupStartCount", Ty::U16).at(146).doc("the groupStarts section's count (at most 8)"),
    Field::new("musicRingsOpen", Ty::U16).at(148).doc("music rings open"),
    Field::new("streamStartsLate", Ty::U16).at(150).doc("voices that started after their stamp because a ring was not ready (cumulative, saturating)"),
    Field::new("groupsLate", Ty::U16).at(152).doc("groups that started late (cumulative, saturating)"),
    Field::new("groupsHeld", Ty::U16).at(154).doc("groups held by a starving member (cumulative)"),
    Field::new("groupsAbandoned", Ty::U16).at(156).doc("group give-ups (cumulative)"),
    Field::new("curvePoolFull", Ty::U16).at(158).doc("curve pool refusals (cumulative)"),
    Field::new("maxSlipFrames", Ty::U32).at(160).doc("largest group slip since init"),
    Field::new("splitQuanta", Ty::U32).at(164).doc("whole-quantum splits (cumulative; R3)"),
    Field::new("voiceSplits", Ty::U32).at(168).doc("voice-local splits (cumulative; R3)"),
    Field::new("reserved", Ty::U32).at(172).doc("reserved, 0"),
    // ADR 0171 M5 (API section 4.3): 176..=255. The layout lands once (task Wa1); the fields read 0 until their tasks fill them.
    Field::new("busyMsTotal", Ty::F64).at(176).doc("sum of Date.now() deltas around process(), ms, since the driver started (shell)"),
    Field::new("quantaTotal", Ty::F64).at(184).doc("quanta processed since the driver started (shell)"),
    Field::new("wuVoices", Ty::F64).at(192).doc("cumulative work units: voices"),
    Field::new("wuBuses", Ty::F64).at(200).doc("cumulative work units: buses, effects, sidechain, ramps"),
    Field::new("wuSpatial", Ty::F64).at(208).doc("cumulative work units: spatial"),
    Field::new("wuMusic", Ty::F64).at(216).doc("cumulative work units: music"),
    Field::new("wuLoudness", Ty::F64).at(224).doc("cumulative work units: loudness"),
    Field::new("loudBusCount", Ty::U16).at(232).doc("the loudBuses section's count (at most 9)"),
    Field::new("loudEnergyCount", Ty::U16).at(234).doc("the loudEnergies section's count (at most 288)"),
    Field::new("duckCount", Ty::U16).at(236).doc("the busDuck section's count (at most 32)"),
    Field::new("clockStepMs", Ty::U16).at(238).doc("the smallest non-zero Date.now delta seen; 0 = none yet (shell)"),
    Field::new("loudSubBlockFrames", Ty::U32).at(240).doc("round(sampleRate / 10)"),
    Field::new("clockSteps", Ty::U16).at(244).doc("wall-clock steps clamped, saturating (shell)"),
    Field::new("loudShed", Ty::U16).at(246).doc("the load-shedding ladder's loudness step in force, 0 or 1"),
    Field::new("busRecordsEarly", Ty::U16).at(248).doc("BUS_RAMP records applied at the quantum's start because the due list was full (cumulative, saturating)"),
    Field::new("sidechainLate", Ty::U16).at(250).doc("late sidechain detections (cumulative, saturating)"),
    Field::new("reserved2", Ty::U32).at(252).doc("reserved, 0"),
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
        doc: "ClipEvent codes: 1 resident, 2 refusedCeiling, 3 refusedGrow, 4 hrtfReady, 5 refusedFormat",
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
    Section {
        name: "beds",
        item: super::spatial::BEDS_ITEM,
        count_field: "bedsActive",
        max: 4,
        doc: "per active bed slot: host bus, voices and work (ADR 0162)",
    },
    Section {
        name: "zones",
        item: super::spatial::ZONES_ITEM,
        count_field: "zoneSlots",
        max: 4,
        doc: "per zone slot: kernel, state, quanta since input, wet peak (ADR 0162)",
    },
    Section {
        name: "zoneEvents",
        item: super::spatial::ZONE_EVENTS_ITEM,
        count_field: "zoneEventCount",
        max: 16,
        doc: "ZoneEvent codes: 1 refused kernel, 2 refused slot, 3 bad blob (ADR 0162)",
    },
    Section {
        name: "musicRings",
        item: super::music::MUSIC_RINGS_ITEM,
        count_field: "musicRingCount",
        max: 16,
        doc: "every open music ring: stream id, epoch and primed and bound bits (ADR 0166 M4)",
    },
    Section {
        name: "groupStarts",
        item: super::music::GROUP_STARTS_ITEM,
        count_field: "groupStartCount",
        max: 8,
        doc: "one item per group start: slip, flags, start frame; the rest carry over like starved (ADR 0166 M4)",
    },
    Section {
        name: "loudBuses",
        item: super::mix::LOUD_BUSES_ITEM,
        count_field: "loudBusCount",
        max: 9,
        doc: "one item per loudness meter (the final-output tap included): new-block count and flags, first sequence, true peak, gated quanta (ADR 0171 M5)",
    },
    Section {
        name: "loudEnergies",
        item: super::mix::LOUD_ENERGIES_ITEM,
        count_field: "loudEnergyCount",
        max: 288,
        doc: "K-weighted sub-block energies since the last successful take, bus-major in loudBuses order, oldest first (ADR 0171 M5)",
    },
    Section {
        name: "busDuck",
        item: super::mix::BUS_DUCK_ITEM,
        count_field: "duckCount",
        max: 32,
        doc: "the duck lane's gain of every bus that is the target of a rule (ADR 0171 M5)",
    },
];

pub const STATUS: StatusSpec = StatusSpec { header_bytes: 256,fields: HEADER_FIELDS, sections: SECTIONS };

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Ty;
    fn constant(name: &str) -> u64 {
        crate::schema::schema().constants.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no constant {name}")).value
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
            ("bedVoices", 112, Ty::U16),
            ("bedsActive", 114, Ty::U16),
            ("fxVoices", 116, Ty::U16),
            ("ambisonicVoices", 118, Ty::U16),
            ("zonesActive", 120, Ty::U16),
            ("zonesRinging", 122, Ty::U16),
            ("zoneEventCount", 124, Ty::U16),
            ("bedsRefused", 126, Ty::U16),
            ("zoneSlots", 128, Ty::U16),
            ("m3Shed", 130, Ty::U16),
            ("zoneUsedKB", 132, Ty::U32),
            ("workBed", 136, Ty::U32),
            ("workZones", 140, Ty::U32),
            ("musicRingCount", 144, Ty::U16),
            ("groupStartCount", 146, Ty::U16),
            ("musicRingsOpen", 148, Ty::U16),
            ("streamStartsLate", 150, Ty::U16),
            ("groupsLate", 152, Ty::U16),
            ("groupsHeld", 154, Ty::U16),
            ("groupsAbandoned", 156, Ty::U16),
            ("curvePoolFull", 158, Ty::U16),
            ("maxSlipFrames", 160, Ty::U32),
            ("splitQuanta", 164, Ty::U32),
            ("voiceSplits", 168, Ty::U32),
            ("reserved", 172, Ty::U32),
            ("busyMsTotal", 176, Ty::F64),
            ("quantaTotal", 184, Ty::F64),
            ("wuVoices", 192, Ty::F64),
            ("wuBuses", 200, Ty::F64),
            ("wuSpatial", 208, Ty::F64),
            ("wuMusic", 216, Ty::F64),
            ("wuLoudness", 224, Ty::F64),
            ("loudBusCount", 232, Ty::U16),
            ("loudEnergyCount", 234, Ty::U16),
            ("duckCount", 236, Ty::U16),
            ("clockStepMs", 238, Ty::U16),
            ("loudSubBlockFrames", 240, Ty::U32),
            ("clockSteps", 244, Ty::U16),
            ("loudShed", 246, Ty::U16),
            ("busRecordsEarly", 248, Ty::U16),
            ("sidechainLate", 250, Ty::U16),
            ("reserved2", 252, Ty::U32),
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
        assert_eq!(STATUS.header_bytes, 256);
    }

    #[test]
    fn flags_bits_0_to_6() {
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
                ("bedDecoderReady", 6, 1),
            ]
        );
    }

    #[test]
    fn sections_and_caps() {
        let names: Vec<&str> = SECTIONS.iter().map(|s| s.name).collect();
        assert_eq!(names, ["ended", "demoted", "starved", "playheads", "clipEvents", "streamEvents", "peaks", "beds", "zones", "zoneEvents", "musicRings", "groupStarts", "loudBuses", "loudEnergies", "busDuck"]);

        let counts: Vec<&str> = SECTIONS.iter().map(|s| s.count_field).collect();
        assert_eq!(
            counts,
            ["endedCount", "demotedCount", "starvedCount", "playheadCount", "clipEventCount", "streamEventCount", "busCount", "bedsActive", "zoneSlots", "zoneEventCount", "musicRingCount", "groupStartCount", "loudBusCount", "loudEnergyCount", "duckCount"]
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
        assert_eq!(caps[7], constant("MAX_BEDS") as u32);
        assert_eq!(caps[8], constant("MAX_ZONE_SLOTS") as u32);
        assert_eq!(caps[9], constant("MAX_ZONE_EVENTS_PER_BLOCK") as u32);
        assert_eq!(caps[10], constant("MAX_MUSIC_RINGS") as u32);
        assert_eq!(caps[11], constant("MAX_GROUP_STARTS_PER_BLOCK") as u32);
        assert_eq!(caps[12], constant("LOUD_METERS") as u32);
        assert_eq!(caps[13], constant("MAX_LOUD_ENERGIES") as u32);
        assert_eq!(caps[13], constant("LOUD_METERS") as u32 * constant("LOUD_RING_SUBBLOCKS") as u32);
        assert_eq!(caps[14], constant("MAX_DUCK_RULES") as u32);

        let item_fields = |s: &Section| -> Vec<(&str, Ty)> { s.item.iter().map(|f| (f.name, f.ty)).collect() };
        assert_eq!(item_fields(&SECTIONS[0]), vec![("id", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[3]), vec![("id", Ty::U32), ("clipFrame", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[4]), vec![("clipId", Ty::U32), ("code", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[5]), vec![("id", Ty::U32), ("code", Ty::U32)]);
        assert_eq!(item_fields(&SECTIONS[6]), vec![("l", Ty::F32), ("r", Ty::F32)]);
    }

    #[test]
    fn worst_case_is_17824_bytes() {
        let worst: u32 = STATUS.header_bytes
            + SECTIONS
                .iter()
                .map(|s| s.max * s.item.iter().map(|f| f.bytes()).sum::<u32>())
                .sum::<u32>();
        // ADR 0162 §4.3: 15,728 - 112 + 144 + 32 + 48 + 64 = 15,904; API §4.4: - 144 + 176 (header)
        // + 16 x 8 (musicRings) + 8 x 16 (groupStarts) = 16,192, 192 B under the buffer.
        // M5 (API §4.3): 16,192 - 176 + 256 (header) + 9 x 16 + 288 x 4 + 32 x 8 = 17,824, 2,656 B under the buffer.
        assert_eq!(worst, 17824);
        assert!(worst <= constant("STATUS_BUFFER_BYTES") as u32);
        assert_eq!(worst as u64, constant("STATUS_WORST_CASE_BYTES"));
    }
}
