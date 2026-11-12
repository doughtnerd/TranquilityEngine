//! M4 wire, gate family (task W1; leaf L-W1a fills the ignored cases): PLAY `gate`, STREAM_OPEN
//! `music`, the `musicRings` and `groupStarts` STATUS sections and the fuzz rows of API section 4.5.
//!
//! Every case is live (leaf L-W1a filled the cases; each case's brief is in its doc comment). The first
//! test pins the packers the rest build on.

use audio_wire::cases::cases;
use audio_wire::gen::codec::{encode, to_hex};
use audio_wire::generated::*;
use audio_wire::model::Value;
use audio_wire::schema::schema;
use audio_wire::vector::{Subject, VectorCase};

fn u(x: u64) -> Value {
    Value::U(x)
}

fn f(x: f64) -> Value {
    Value::F(x)
}

/// Encodes one record through the interpretive codec, the schema's own view of the wire.
fn codec(name: &'static str, subject: Subject, values: Vec<(&'static str, Value)>) -> Vec<u8> {
    let case = VectorCase { name, subject, values, hex: "" };
    encode(&schema(), &case).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn gate_packers_agree_with_the_constants() {
    assert_eq!(PLAY_GATE_ID_MASK, 0x3ff);
    assert_eq!(PLAY_GATE_SIZE_SHIFT, 10);
    assert_eq!(pack_gate(1023, 64), 0xffff);
    assert_eq!((gate_group_id(0xffff), gate_group_size(0xffff)), (1023, 64));
    assert_eq!(pack_gate(0, 7), 0, "id 0 is ungated whatever the size");
    assert_eq!((gate_group_id(0), gate_group_size(0)), (0, 0));
}

/// PLAY `gate` round trips through `Play::write` / `Play::read` and the interpretive codec for every
/// (id, size) corner: (1, 1), (1, 64), (1023, 1), (1023, 64), (512, 32), and 0 (ungated). `group`,
/// `flags` and the other fields are untouched; PLAY stays 56 B; the `gate` bytes sit at offset 22.
#[test]
fn play_gate_round_trips_at_offset_22() {
    // (id, size, the id and size the gate reads back as)
    let corners: [(u32, u32, u32, u32); 6] = [
        (1, 1, 1, 1),
        (1, 64, 1, 64),
        (1023, 1, 1023, 1),
        (1023, 64, 1023, 64),
        (512, 32, 512, 32),
        (0, 7, 0, 0),
    ];
    let mut buf = vec![0u8; 64];
    let mut largest = Vec::new();
    for (id, size, want_id, want_size) in corners {
        let gate = pack_gate(id, size);
        let play = Play {
            voice_id: 0x0102_0304,
            frame_offset: 2400,
            clip: 9,
            bus: 3,
            flags: PLAY_FLAGS_FADE_ZERO | 0x09,
            group: 0x0bcd,
            gate,
            gain: 0.5,
            pitch: 1.25,
            dir_x: 0.25,
            dir_y: -0.5,
            dir_z: 1.0,
            lp_hz: 8000.0,
            score: 0.75,
            start_offset_frames: 48,
        };
        assert_eq!(play.write(&mut buf, 0).unwrap(), 56, "PLAY stays 56 B");
        assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 14, "PLAY words");
        if (id, size) == (1023, 64) {
            largest = buf[..56].to_vec();
        }
        assert_eq!(&buf[22..24], &gate.to_le_bytes(), "gate at offset 22 for ({id}, {size})");
        assert_eq!(&buf[20..22], &0x0bcdu16.to_le_bytes(), "group untouched for ({id}, {size})");
        assert_eq!(&buf[18..20], &0x0109u16.to_le_bytes(), "flags untouched for ({id}, {size})");

        let (back, used) = Play::read(&buf, 0).unwrap();
        assert_eq!((back.clone(), used), (play.clone(), 56), "round trip for ({id}, {size})");
        assert_eq!(
            (gate_group_id(back.gate), gate_group_size(back.gate)),
            (want_id, want_size),
            "gate reads back for ({id}, {size})"
        );
    }

    // The interpretive codec places `gate` at the same offset, for the largest corner.
    let via_codec = codec(
        "PLAY_gate_corner_rt",
        Subject::Opcode("PLAY"),
        vec![
            ("voiceId", u(0x0102_0304)),
            ("frameOffset", u(2400)),
            ("clip", u(9)),
            ("bus", u(3)),
            ("flags", u(0x109)),
            ("group", u(0x0bcd)),
            ("gate", u(pack_gate(1023, 64) as u64)),
            ("gain", f(0.5)),
            ("pitch", f(1.25)),
            ("dirX", f(0.25)),
            ("dirY", f(-0.5)),
            ("dirZ", f(1.0)),
            ("lpHz", f(8000.0)),
            ("score", f(0.75)),
            ("startOffsetFrames", u(48)),
        ],
    );
    assert_eq!(via_codec.len(), 56);
    assert_eq!(via_codec, largest, "codec and writer agree for gate 1023 of 64");
}

/// STREAM_OPEN `flags` bit 1: `STREAM_OPEN_FLAG_MUSIC` (0x2) round trips next to `loop` (0x1); the body
/// stays 40 B; `STREAM_EVENT_MUSIC_FULL` is 4 and the `StreamEvent` enum has `MusicFull`.
#[test]
fn stream_open_music_flag_round_trips() {
    assert_eq!(STREAM_OPEN_FLAG_MUSIC, 0x2);
    assert_eq!(STREAM_OPEN_FLAGS_LOOP, 0x1);
    assert_eq!(STREAM_EVENT_MUSIC_FULL, 4);
    assert_eq!(stream_event::MUSIC_FULL, 4);
    let stream_event_enum = schema().enums.iter().find(|e| e.name == "StreamEvent").expect("StreamEvent enum");
    assert!(
        stream_event_enum.variants.iter().any(|(name, value, _)| *name == "MusicFull" && *value == 4),
        "StreamEvent has MusicFull = 4"
    );

    let mut buf = vec![0u8; 64];
    for flags in [STREAM_OPEN_FLAG_MUSIC, STREAM_OPEN_FLAG_MUSIC | STREAM_OPEN_FLAGS_LOOP] {
        let open = StreamOpen {
            stream_id: 7,
            channels: 2,
            sample_rate: 48_000.0,
            total_frames: 0xffff_ffff,
            loop_start: 0,
            loop_end: 0,
            flags,
            epoch: 1,
            start_frame: 0,
            convention: 0,
        };
        assert_eq!(open.write(&mut buf, 0).unwrap(), 56, "STREAM_OPEN: 16 B envelope + 40 B body");
        // The flags word is body offset 24, so record offset 40.
        assert_eq!(u32::from_le_bytes(buf[40..44].try_into().unwrap()), flags, "flags {flags:#x}");
        assert_eq!(StreamOpen::read(&buf, 0).unwrap(), (open.clone(), 56), "round trip {flags:#x}");
    }

    let via_codec = codec(
        "STREAM_OPEN_music_rt",
        Subject::Kind("STREAM_OPEN"),
        vec![
            ("seq", u(14)),
            ("streamId", u(7)),
            ("channels", u(2)),
            ("sampleRate", f(48_000.0)),
            ("totalFrames", u(0xffff_ffff)),
            ("loopStart", u(0)),
            ("loopEnd", u(0)),
            ("flags", u(2)),
            ("epoch", u(1)),
            ("startFrame", u(0)),
            ("convention", u(0)),
        ],
    );
    assert_eq!(via_codec.len(), 56);
    assert_eq!(&via_codec[40..44], &[2, 0, 0, 0], "codec: music flag at record offset 40");
}

/// STATUS `musicRings` (8 B items: streamId, epochFlags with epoch in bits 0-29, primed bit 30, bound
/// bit 31) and `groupStarts` (16 B items: groupId u16, flags u16, slipFrames, startFrameLo, startFrameHi):
/// the counts at 144 and 146 are derived from the section lengths, the sections follow `zoneEvents` in
/// that order, and a hand-computed byte layout matches the writer.
#[test]
fn status_music_sections_round_trip_with_derived_counts() {
    let status = StatusBlock {
        zone_events: vec![StatusZoneEventsItem { slot: 1, code: 2, reserved: 0 }],
        music_rings: vec![
            StatusMusicRingsItem { stream_id: 3, epoch_flags: MUSIC_RING_PRIMED | MUSIC_RING_BOUND | 4 },
            StatusMusicRingsItem { stream_id: 5, epoch_flags: MUSIC_RING_PRIMED | 9 },
        ],
        group_starts: vec![StatusGroupStartsItem {
            group_id: 1023,
            flags: (GROUP_START_LATE | GROUP_START_ABANDONED) as u16,
            slip_frames: 1024,
            start_frame_lo: 0x8000_0000,
            start_frame_hi: 1,
        }],
        ..Default::default()
    };
    let mut buf = vec![0u8; 256];
    let n = status.write(&mut buf, 0, 40).unwrap();

    // zoneEvents (4 B) at 176, then musicRings (2 x 8 B) at 180, then groupStarts (16 B) at 196.
    assert_eq!(n, 212, "176 header + 4 + 16 + 16");
    assert_eq!(&buf[12..16], &[196, 0, 0, 0], "bodyBytes = 212 - 16");
    assert_eq!(&buf[144..146], &[2, 0], "144 musicRingCount derived: 2");
    assert_eq!(&buf[146..148], &[1, 0], "146 groupStartCount derived: 1");
    assert_eq!(&buf[176..180], &[1, 2, 0, 0], "zoneEvents first: slot 1, code 2, reserved 0");
    assert_eq!(&buf[180..184], &3u32.to_le_bytes(), "musicRings[0].streamId");
    assert_eq!(&buf[184..188], &(0xC000_0004u32).to_le_bytes(), "musicRings[0].epochFlags: primed | bound | epoch 4");
    assert_eq!(&buf[188..192], &5u32.to_le_bytes(), "musicRings[1].streamId");
    assert_eq!(&buf[192..196], &(0x4000_0009u32).to_le_bytes(), "musicRings[1].epochFlags: primed | epoch 9");
    assert_eq!(&buf[196..198], &1023u16.to_le_bytes(), "groupStarts[0].groupId");
    assert_eq!(&buf[198..200], &5u16.to_le_bytes(), "groupStarts[0].flags: late | abandoned");
    assert_eq!(&buf[200..204], &1024u32.to_le_bytes(), "groupStarts[0].slipFrames");
    assert_eq!(&buf[204..208], &0x8000_0000u32.to_le_bytes(), "groupStarts[0].startFrameLo");
    assert_eq!(&buf[208..212], &1u32.to_le_bytes(), "groupStarts[0].startFrameHi");

    assert_eq!(StatusBlock::read(&buf[..n], 0).unwrap(), (status.clone(), n));

    // The counts follow the lengths: a block with no music sections writes 0 at 144 and 146.
    let mut empty = status.clone();
    empty.music_rings.clear();
    empty.group_starts.clear();
    assert_eq!(empty.write(&mut buf, 0, 40).unwrap(), 180);
    assert_eq!(&buf[144..148], &[0, 0, 0, 0]);
}

/// Fuzz rows of API section 4.5: a PLAY of gate size 64 and id 1023; a STATUS with 8 `groupStarts`
/// (and with 9: refused as over its cap); a STATUS with 16 `musicRings` (and 17 refused); every
/// truncation of a STATUS with both sections is an error and never a panic; `musicRingCount` above 16
/// and `groupStartCount` above 8 in the header are refused on read.
#[test]
fn fuzz_rows_of_the_gate_family() {
    // PLAY: gate size 64 and id 1023 pack to 0xffff and read back whole.
    let play = Play {
        voice_id: 2,
        frame_offset: ASAP,
        clip: 9,
        bus: 1,
        flags: PLAY_FLAGS_FADE_ZERO | 0x08,
        group: 3,
        gate: pack_gate(1023, 64),
        gain: 1.0,
        pitch: 1.0,
        lp_hz: 24_000.0,
        score: 0.5,
        ..Default::default()
    };
    let mut buf = vec![0u8; 64];
    assert_eq!(play.write(&mut buf, 0).unwrap(), 56);
    assert_eq!(&buf[22..24], &[0xff, 0xff], "gate 1023 of 64");
    assert_eq!(Play::read(&buf, 0).unwrap(), (play.clone(), 56));

    // STATUS with 8 groupStarts round trips; 9 is refused on write.
    let group = |i: usize| StatusGroupStartsItem {
        group_id: (i + 1) as u16,
        flags: (i % 8) as u16,
        slip_frames: i as u32 * 100,
        start_frame_lo: i as u32,
        start_frame_hi: 0,
    };
    let eight = StatusBlock { group_starts: (0..MAX_GROUP_STARTS_PER_BLOCK as usize).map(group).collect(), ..Default::default() };
    let mut sbuf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = eight.write(&mut sbuf, 0, 1).unwrap();
    assert_eq!(n, 176 + 8 * 16);
    assert_eq!(StatusBlock::read(&sbuf[..n], 0).unwrap(), (eight.clone(), n));
    let nine = StatusBlock { group_starts: (0..9).map(group).collect(), ..Default::default() };
    assert_eq!(nine.write(&mut sbuf, 0, 1), Err(ERR_OVERSIZE), "9 groupStarts is over the cap");

    // STATUS with 16 musicRings round trips; 17 is refused on write.
    let ring = |i: usize| StatusMusicRingsItem { stream_id: i as u32 + 1, epoch_flags: MUSIC_RING_PRIMED | (i as u32 + 1) };
    let sixteen = StatusBlock { music_rings: (0..MAX_MUSIC_RINGS as usize).map(ring).collect(), ..Default::default() };
    let n = sixteen.write(&mut sbuf, 0, 1).unwrap();
    assert_eq!(n, 176 + 16 * 8);
    assert_eq!(StatusBlock::read(&sbuf[..n], 0).unwrap(), (sixteen.clone(), n));
    let seventeen = StatusBlock { music_rings: (0..17).map(ring).collect(), ..Default::default() };
    assert_eq!(seventeen.write(&mut sbuf, 0, 1), Err(ERR_OVERSIZE), "17 musicRings is over the cap");

    // Every truncation of a STATUS with both sections (and a zone event) is an error, never a panic.
    let both = StatusBlock {
        zone_events: vec![StatusZoneEventsItem { slot: 0, code: 1, reserved: 0 }],
        music_rings: vec![ring(0), ring(1)],
        group_starts: vec![group(0), group(1)],
        ..Default::default()
    };
    let n = both.write(&mut sbuf, 0, 1).unwrap();
    assert_eq!(n, 176 + 4 + 16 + 32);
    assert_eq!(StatusBlock::read(&sbuf[..n], 0).unwrap(), (both.clone(), n));
    for len in 0..n {
        assert!(StatusBlock::read(&sbuf[..len], 0).is_err(), "cut to {len} B must be an error");
    }

    // Header counts above the caps are refused on read, even with room in the buffer for them.
    let mut header = vec![0u8; 512];
    StatusBlock::default().write(&mut header, 0, 1).unwrap();
    header[144..146].copy_from_slice(&17u16.to_le_bytes());
    assert_eq!(StatusBlock::read(&header, 0).unwrap_err(), ERR_OVERSIZE, "musicRingCount 17");
    header[144..146].copy_from_slice(&0u16.to_le_bytes());
    header[146..148].copy_from_slice(&9u16.to_le_bytes());
    assert_eq!(StatusBlock::read(&header, 0).unwrap_err(), ERR_OVERSIZE, "groupStartCount 9");
}

/// STATUS worst case: every section at its cap writes exactly `STATUS_WORST_CASE_BYTES` (16,192 B),
/// under `STATUS_BUFFER_BYTES` (16,384 B) with 192 B spare, and reads back equal. (`tests/m4_per_voice.rs`
/// and `tests/spatial_vectors.rs` already assert the total; this case pins the 128 + 128 B of the two
/// new sections by name.)
#[test]
fn status_worst_case_has_192_bytes_spare() {
    assert_eq!(STATUS_BUFFER_BYTES, 16_384);
    assert_eq!(STATUS_WORST_CASE_BYTES, 16_192);
    assert_eq!(STATUS_BUFFER_BYTES - STATUS_WORST_CASE_BYTES, 192);
    assert_eq!(StatusMusicRingsItem::FIXED_END, 8);
    assert_eq!(StatusGroupStartsItem::FIXED_END, 16);
    assert_eq!(MAX_MUSIC_RINGS as usize * StatusMusicRingsItem::FIXED_END, 128, "musicRings at its cap: 128 B");
    assert_eq!(MAX_GROUP_STARTS_PER_BLOCK as usize * StatusGroupStartsItem::FIXED_END, 128, "groupStarts at its cap: 128 B");

    let mut full = StatusBlock {
        ended: vec![0; MAX_ENDED_PER_BLOCK as usize],
        demoted: vec![0; MAX_DEMOTED_PER_BLOCK as usize],
        starved: vec![0; MAX_STARVED_PER_BLOCK as usize],
        playheads: vec![Default::default(); MAX_PLAYHEADS_PER_BLOCK as usize],
        clip_events: vec![Default::default(); MAX_CLIP_EVENTS_PER_BLOCK as usize],
        stream_events: vec![Default::default(); MAX_STREAM_EVENTS_PER_BLOCK as usize],
        peaks: vec![Default::default(); 32],
        beds: vec![Default::default(); MAX_BEDS as usize],
        zones: vec![Default::default(); MAX_ZONE_SLOTS as usize],
        zone_events: vec![Default::default(); MAX_ZONE_EVENTS_PER_BLOCK as usize],
        ..Default::default()
    };
    // The new sections at their caps, with distinct values so a shifted field would show.
    full.music_rings = (0..MAX_MUSIC_RINGS as usize)
        .map(|i| StatusMusicRingsItem { stream_id: i as u32 + 1, epoch_flags: MUSIC_RING_PRIMED | MUSIC_RING_BOUND | (i as u32 + 1) })
        .collect();
    full.group_starts = (0..MAX_GROUP_STARTS_PER_BLOCK as usize)
        .map(|i| StatusGroupStartsItem {
            group_id: i as u16 + 1,
            flags: GROUP_START_HELD as u16,
            slip_frames: i as u32,
            start_frame_lo: 0x1000 * i as u32,
            start_frame_hi: i as u32,
        })
        .collect();

    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = full.write(&mut buf, 0, 1).unwrap();
    assert_eq!(n, STATUS_WORST_CASE_BYTES as usize);
    assert!(n <= STATUS_BUFFER_BYTES as usize);
    assert_eq!(StatusBlock::read(&buf, 0).unwrap(), (full.clone(), n));

    // Without the two new sections the same block is 256 B shorter: 15,936 B, the M3 + header worst case.
    let mut without = full.clone();
    without.music_rings.clear();
    without.group_starts.clear();
    assert_eq!(without.write(&mut buf, 0, 1).unwrap(), n - 256);
    assert_eq!(n - 256, 15_936);
}

/// `vectors/wire.json`: add to `vectors/cases.rs` hand-derived cases for a gated PLAY (id 1023, size 64,
/// `fadeZero`), a STREAM_OPEN with `music`, and a STATUS with two `musicRings` and eight `groupStarts`.
/// Regenerate with `gen_wire`; do not hand-edit the JSON.
#[test]
fn golden_vectors_cover_the_gate_family() {
    // (name, encoded size in bytes): PLAY 56, STREAM_OPEN 16 + 40, STATUS 176 + 16 + 128.
    let expect: [(&str, usize); 3] = [
        ("PLAY_gate_1023_of_64_fade_zero", 56),
        ("STREAM_OPEN_music", 56),
        ("STATUS_two_music_rings_eight_group_starts", 320),
    ];
    let all = cases();
    let s = schema();
    for (name, size) in expect {
        let case = all.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no vector named {name}"));
        assert_eq!(case.hex.len(), 2 * size, "{name}: hex length");
        let bytes = encode(&s, case).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(to_hex(&bytes), case.hex, "{name}");
    }

    // The gate, the music flag and the derived counts sit where the spec puts them.
    let play = all.iter().find(|c| c.name == "PLAY_gate_1023_of_64_fade_zero").unwrap();
    let bytes = encode(&s, play).unwrap();
    assert_eq!(&bytes[22..24], &[0xff, 0xff], "gate");
    assert_eq!(&bytes[18..20], &[0x08, 0x01], "flags: fadeZero");
    let stream = all.iter().find(|c| c.name == "STREAM_OPEN_music").unwrap();
    let bytes = encode(&s, stream).unwrap();
    assert_eq!(&bytes[40..44], &[2, 0, 0, 0], "flags: music");
    let status = all.iter().find(|c| c.name == "STATUS_two_music_rings_eight_group_starts").unwrap();
    let bytes = encode(&s, status).unwrap();
    assert_eq!(&bytes[144..148], &[2, 0, 8, 0], "musicRingCount 2, groupStartCount 8");
    assert_eq!(&bytes[176..180], &3u32.to_le_bytes(), "the first musicRings item follows the header");
}
