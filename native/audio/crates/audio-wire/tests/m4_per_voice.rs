//! M4 wire, per-voice family (task Z1; leaf L-Z1a filled the ignored cases): the `shape` word on FADE,
//! SET_PARAMS and STOP, PLAY `fadeZero`, the 176-byte STATUS header (API section 4.1, 4.2, 4.4).
//!
//! Every case is live. The byte expectations are hand-derived from the section 4 tables; the codec
//! and the generated writers are only checked against them.

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

/// A FADE, STOP or SET_PARAMS of the old (pre-1.2) size reads `shape` as 0, and the writer always
/// writes the new size.
#[test]
fn older_records_without_the_shape_word_read_it_as_zero() {
    let mut buf = vec![0u8; 128];
    let fade = Fade { voice_id: 7, frame_offset: 96, target: 1.0, frames: 480, flags: 0, shape: pack_shape(fade_law::EQUAL_POWER_IN, 0x4000) };
    assert_eq!(fade.write(&mut buf, 0).unwrap(), 28);
    assert_eq!(Fade::read(&buf, 0).unwrap().0, fade);
    // The same record cut to 24 B with `words` = 6 (an older writer): shape reads 0.
    buf[2..4].copy_from_slice(&6u16.to_le_bytes());
    let (old, used) = Fade::read(&buf[..24], 0).unwrap();
    assert_eq!((old.shape, used), (0, 24));
    assert_eq!((old.target, old.frames), (1.0, 480));
    // `words` = 7 over a buffer that ends inside the shape word is TRUNCATED, not a short read.
    buf[2..4].copy_from_slice(&7u16.to_le_bytes());
    assert_eq!(Fade::read(&buf[..26], 0).unwrap_err(), ERR_TRUNCATED);
    // A record shorter than the old size is TRUNCATED.
    buf[2..4].copy_from_slice(&5u16.to_le_bytes());
    assert_eq!(Fade::read(&buf[..20], 0).unwrap_err(), ERR_TRUNCATED);

    let stop = Stop { voice_id: 3, frame_offset: ASAP, fade_frames: 240, reason: 1, shape: pack_shape(fade_law::EQUAL_POWER_OUT, 0) };
    assert_eq!(stop.write(&mut buf, 0).unwrap(), 24);
    buf[2..4].copy_from_slice(&5u16.to_le_bytes());
    assert_eq!(Stop::read(&buf[..20], 0).unwrap().0.shape, 0);

    let set = SetParams { voice_id: 3, frame_offset: 0, mask: SET_PARAMS_MASK_GAIN, gain: 0.5, ramp_frames: 128, shape: pack_shape(fade_law::S_CURVE, 1), ..Default::default() };
    assert_eq!(set.write(&mut buf, 0).unwrap(), 60);
    buf[2..4].copy_from_slice(&14u16.to_le_bytes());
    assert_eq!(SetParams::read(&buf[..56], 0).unwrap().0.shape, 0);
}

/// The shape word's packers and readers: law in bits 0-2, `startPhase` in bits 16-31, the other bits
/// ignored by the readers; `FadeLaw` values 0..3; the constants of API section 4.5 have their values.
#[test]
fn shape_word_packs_law_and_start_phase() {
    assert_eq!(SHAPE_LAW_MASK, 0x7);
    assert_eq!(SHAPE_PHASE_SHIFT, 16);
    assert_eq!(SHAPE_PHASE_MASK, 0xffff_0000);
    assert_eq!(SHAPE_PHASE_SCALE, 65_536);
    assert_eq!(
        (fade_law::LINEAR, fade_law::S_CURVE, fade_law::EQUAL_POWER_IN, fade_law::EQUAL_POWER_OUT),
        (0, 1, 2, 3)
    );
    for law in 0..=3u32 {
        for phase in [0u32, 1, 0x7fff, 0xffff] {
            let shape = pack_shape(law, phase);
            assert_eq!(shape, law | (phase << 16), "law {law}, phase {phase:#x}");
            assert_eq!(shape_law(shape), law, "law {law}, phase {phase:#x}");
            assert_eq!(shape_start_phase(shape), phase, "law {law}, phase {phase:#x}");
        }
    }
    // Hand-derived: equal power in at a quarter phase is 0x4000_0002; equal power out at 0xffff is 0xffff_0003.
    assert_eq!(pack_shape(fade_law::EQUAL_POWER_IN, 0x4000), 0x4000_0002);
    assert_eq!(pack_shape(fade_law::EQUAL_POWER_OUT, 0xffff), 0xffff_0003);
    assert_eq!(shape_start_phase(0x4000_0002) as f64 / SHAPE_PHASE_SCALE as f64, 0.25);
    // The packer masks a law to bits 0-2 and a phase to 16 bits.
    assert_eq!(pack_shape(0xb, 0), 3);
    assert_eq!(pack_shape(fade_law::EQUAL_POWER_IN, 0x1_4000), 0x4000_0002);
    // The readers take bits 0-2 and 16-31 only; the bits between are ignored.
    assert_eq!(shape_law(0x0000_fff8), 0);
    assert_eq!(shape_start_phase(0x0000_ffff), 0);
}

/// FADE (28 B), SET_PARAMS (60 B) and STOP (24 B) round trip a non-zero shape word through the
/// generated writer and reader and through the interpretive codec (`Subject::Opcode`).
#[test]
fn longer_records_round_trip_the_shape_word() {
    let mut buf = vec![0u8; 64];
    for law in 0..=3u32 {
        for phase in [0u32, 0xffff] {
            let shape = pack_shape(law, phase);
            let sh = shape as u64;

            let fade = Fade { voice_id: 7, frame_offset: 480, target: 1.0, frames: 480, flags: 0, shape };
            assert_eq!(fade.write(&mut buf, 0).unwrap(), 28);
            assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 7, "FADE words");
            assert_eq!(Fade::read(&buf, 0).unwrap(), (fade.clone(), 28), "FADE law {law}, phase {phase:#x}");
            let via_codec = codec(
                "FADE_rt",
                Subject::Opcode("FADE"),
                vec![("voiceId", u(7)), ("frameOffset", u(480)), ("target", f(1.0)), ("frames", u(480)), ("flags", u(0)), ("shape", u(sh))],
            );
            assert_eq!(via_codec, &buf[..28], "FADE codec, law {law}, phase {phase:#x}");

            let set = SetParams { voice_id: 7, frame_offset: 4096, mask: SET_PARAMS_MASK_GAIN, gain: 0.5, ramp_frames: 128, flags: 0, shape, ..Default::default() };
            assert_eq!(set.write(&mut buf, 0).unwrap(), 60);
            assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 15, "SET_PARAMS words");
            assert_eq!(SetParams::read(&buf, 0).unwrap(), (set.clone(), 60), "SET_PARAMS law {law}, phase {phase:#x}");
            let via_codec = codec(
                "SET_PARAMS_rt",
                Subject::Opcode("SET_PARAMS"),
                vec![
                    ("voiceId", u(7)),
                    ("frameOffset", u(4096)),
                    ("mask", u(1)),
                    ("gain", f(0.5)),
                    ("pitch", f(0.0)),
                    ("dirX", f(0.0)),
                    ("dirY", f(0.0)),
                    ("dirZ", f(0.0)),
                    ("lpHz", f(0.0)),
                    ("score", f(0.0)),
                    ("bus", u(0)),
                    ("rampFrames", u(128)),
                    ("flags", u(0)),
                    ("shape", u(sh)),
                ],
            );
            assert_eq!(via_codec, &buf[..60], "SET_PARAMS codec, law {law}, phase {phase:#x}");

            let stop = Stop { voice_id: 3, frame_offset: 1000, fade_frames: 240, reason: 1, shape };
            assert_eq!(stop.write(&mut buf, 0).unwrap(), 24);
            assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 6, "STOP words");
            assert_eq!(Stop::read(&buf, 0).unwrap(), (stop.clone(), 24), "STOP law {law}, phase {phase:#x}");
            let via_codec = codec(
                "STOP_rt",
                Subject::Opcode("STOP"),
                vec![("voiceId", u(3)), ("frameOffset", u(1000)), ("fadeFrames", u(240)), ("reason", u(1)), ("shape", u(sh))],
            );
            assert_eq!(via_codec, &buf[..24], "STOP codec, law {law}, phase {phase:#x}");
        }
    }
}

/// Every cut of `full` reads as the spec says. With `words` unchanged, a cut shorter than the record is
/// TRUNCATED. With `words` set to the cut, a cut below `min_end` is TRUNCATED, a cut that stops inside
/// the shape word reads shape 0 (an older record), and the whole record reads `shape`. A `words` that
/// runs past the buffer is TRUNCATED. Any panic or read past the slice fails the test.
fn sweep(name: &str, full: &[u8], min_end: usize, shape: u32, read: &dyn Fn(&[u8]) -> Result<(u32, usize), i32>) {
    let size = full.len();
    assert_eq!(read(full), Ok((shape, size)), "{name}: whole record");
    for len in 0..=size {
        let cut = &full[..len];
        if len < size {
            assert_eq!(read(cut), Err(ERR_TRUNCATED), "{name}: cut to {len} B, words unchanged");
        }

        let mut past = cut.to_vec();
        if len >= 4 {
            past[2..4].copy_from_slice(&u16::MAX.to_le_bytes());
        }
        assert_eq!(read(&past), Err(ERR_TRUNCATED), "{name}: cut to {len} B, words past the buffer");

        let mut cut_words = cut.to_vec();
        if len >= 4 {
            cut_words[2..4].copy_from_slice(&((len / 4) as u16).to_le_bytes());
        }
        let limit = len / 4 * 4;
        let want = if len < 12 || limit < min_end {
            Err(ERR_TRUNCATED)
        } else if limit == size {
            Ok((shape, size))
        } else {
            Ok((0, limit))
        };
        assert_eq!(read(&cut_words), want, "{name}: cut to {len} B, words = {}", len / 4);
    }
}

/// Fuzz: every truncation of each longer record (every length from 0 to its size, with `words`
/// unchanged and with `words` set to the cut) is `Err(TRUNCATED)` or an older record reading shape 0;
/// never a panic and never a read past the buffer.
#[test]
fn truncated_shape_word_never_panics() {
    let shape = pack_shape(fade_law::S_CURVE, 0x8000);
    let mut buf = vec![0u8; 64];

    let fade = Fade { voice_id: 7, frame_offset: 96, target: 0.0, frames: 960, flags: 1, shape };
    let n = fade.write(&mut buf, 0).unwrap();
    sweep("FADE", &buf[..n], Fade::MIN_END, shape, &|b| Fade::read(b, 0).map(|(r, used)| (r.shape, used)));

    let set = SetParams { voice_id: 7, frame_offset: 2048, mask: SET_PARAMS_MASK_GAIN, gain: 0.25, ramp_frames: 480, flags: 0x20, shape, ..Default::default() };
    let n = set.write(&mut buf, 0).unwrap();
    sweep("SET_PARAMS", &buf[..n], SetParams::MIN_END, shape, &|b| SetParams::read(b, 0).map(|(r, used)| (r.shape, used)));

    let stop = Stop { voice_id: 3, frame_offset: ASAP, fade_frames: 480, reason: 1, shape };
    let n = stop.write(&mut buf, 0).unwrap();
    sweep("STOP", &buf[..n], Stop::MIN_END, shape, &|b| Stop::read(b, 0).map(|(r, used)| (r.shape, used)));
}

/// PLAY `flags` bit 8 `fadeZero` (`PLAY_FLAGS_FADE_ZERO`, 0x100): round trips with the other bits
/// untouched (panner, ambisonic, loop) and is not read from SET_PARAMS `flags` as a panner bit.
#[test]
fn play_fade_zero_flag_round_trips() {
    assert_eq!(PLAY_FLAGS_FADE_ZERO, 0x100);
    assert_eq!(SET_PARAMS_FLAGS_FADE_ZERO, PLAY_FLAGS_FADE_ZERO as u32);

    // fadeZero | loop | mixed | spatial | panner 1 (HRTF, bits 5-6 = 01)
    let flags: u16 = 0x0100 | 0x0001 | 0x0008 | 0x0010 | 0x0020;
    assert_eq!(flags, 0x0139);
    let play = Play { voice_id: 1, frame_offset: 1000, clip: 3, bus: 1, flags, gain: 0.5, pitch: 1.0, dir_z: -1.0, lp_hz: 24000.0, score: 0.75, ..Default::default() };
    let mut buf = vec![0u8; 64];
    assert_eq!(play.write(&mut buf, 0).unwrap(), 56, "PLAY stays 56 B");
    assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 14, "PLAY words");
    assert_eq!(&buf[18..20], &[0x39, 0x01], "flags 0x0139, little endian");
    assert_eq!(Play::read(&buf, 0).unwrap(), (play.clone(), 56));
    assert_eq!(Play::read(&buf, 0).unwrap().0.flags & PLAY_FLAGS_FADE_ZERO, PLAY_FLAGS_FADE_ZERO);
    let written = buf[..56].to_vec();

    // Clearing only bit 8 leaves every other bit as it was.
    let mut no_fade = play.clone();
    no_fade.flags &= !PLAY_FLAGS_FADE_ZERO;
    assert_eq!(no_fade.write(&mut buf, 0).unwrap(), 56);
    assert_eq!(&buf[18..20], &[0x39, 0x00], "bit 8 cleared, the rest kept");
    assert_eq!(Play::read(&buf, 0).unwrap().0.flags, 0x0039);

    let via_codec = codec(
        "PLAY_fade_zero_rt",
        Subject::Opcode("PLAY"),
        vec![
            ("voiceId", u(1)),
            ("frameOffset", u(1000)),
            ("clip", u(3)),
            ("bus", u(1)),
            ("flags", u(0x0139)),
            ("group", u(0)),
            ("gate", u(0)),
            ("gain", f(0.5)),
            ("pitch", f(1.0)),
            ("dirX", f(0.0)),
            ("dirY", f(0.0)),
            ("dirZ", f(-1.0)),
            ("lpHz", f(24000.0)),
            ("score", f(0.75)),
            ("startOffsetFrames", u(0)),
        ],
    );
    assert_eq!(via_codec, written, "PLAY codec");

    // SET_PARAMS: bit 8 is not a panner bit, so a fadeZero flag there reads no panner.
    let set = SetParams { voice_id: 1, mask: SET_PARAMS_MASK_FLAGS, flags: SET_PARAMS_FLAGS_FADE_ZERO, ..Default::default() };
    assert_eq!(set.write(&mut buf, 0).unwrap(), 60);
    let (back, _) = SetParams::read(&buf, 0).unwrap();
    assert_eq!(back.flags, SET_PARAMS_FLAGS_FADE_ZERO);
    assert_eq!((back.flags & SET_PARAMS_FLAGS_PANNER_MASK) >> SET_PARAMS_FLAGS_PANNER_SHIFT, 0);
}

/// STATUS: `HEADER_BYTES` and `STATUS_HEADER_BYTES` are 256 (ADR 0171 grew the header from the M4 176); every M4 header field still sits at its offset
/// of API section 4.4's table (144 musicRingCount ... 172 reserved) and round trips a distinct value;
/// sections start at 256.
#[test]
fn status_header_is_256_bytes_with_every_m4_field_at_its_offset() {
    assert_eq!(HEADER_BYTES, 256);
    assert_eq!(STATUS_HEADER_BYTES, 256);

    let status = StatusBlock {
        music_rings_open: 5,
        stream_starts_late: 6,
        groups_late: 7,
        groups_held: 8,
        groups_abandoned: 9,
        curve_pool_full: 10,
        max_slip_frames: 0x0102_0304,
        split_quanta: 0x1122_3344,
        voice_splits: 0x5566_7788,
        reserved: 0x99aa_bbcc,
        ended: vec![0xcafe],
        ..Default::default()
    };
    let mut buf = vec![0u8; 512];
    let n = status.write(&mut buf, 0, 42).unwrap();
    assert_eq!(n, 256 + 4, "one ended entry after the 256-byte header");
    assert_eq!(&buf[8..12], &[42, 0, 0, 0], "seq");
    assert_eq!(&buf[12..16], &[244, 0, 0, 0], "bodyBytes = 260 - 16");
    assert_eq!(&buf[64..66], &[1, 0], "endedCount, still at 64");

    assert_eq!(&buf[144..146], &[0, 0], "144 musicRingCount (derived from the empty section)");
    assert_eq!(&buf[146..148], &[0, 0], "146 groupStartCount (derived)");
    assert_eq!(&buf[148..150], &[5, 0], "148 musicRingsOpen");
    assert_eq!(&buf[150..152], &[6, 0], "150 streamStartsLate");
    assert_eq!(&buf[152..154], &[7, 0], "152 groupsLate");
    assert_eq!(&buf[154..156], &[8, 0], "154 groupsHeld");
    assert_eq!(&buf[156..158], &[9, 0], "156 groupsAbandoned");
    assert_eq!(&buf[158..160], &[10, 0], "158 curvePoolFull");
    assert_eq!(&buf[160..164], &[0x04, 0x03, 0x02, 0x01], "160 maxSlipFrames 0x01020304");
    assert_eq!(&buf[164..168], &[0x44, 0x33, 0x22, 0x11], "164 splitQuanta 0x11223344");
    assert_eq!(&buf[168..172], &[0x88, 0x77, 0x66, 0x55], "168 voiceSplits 0x55667788");
    assert_eq!(&buf[172..176], &[0xcc, 0xbb, 0xaa, 0x99], "172 reserved");
    assert_eq!(&buf[256..260], &[0xfe, 0xca, 0, 0], "the first section starts at 256");

    let (back, used) = StatusBlock::read(&buf[..n], 0).unwrap();
    assert_eq!(used, n);
    assert_eq!(back, status);
}

/// STATUS worst case, 17,824 B = `STATUS_WORST_CASE_BYTES` (M4: 16,192 B with the 176-byte header; M5: header 256 B and the three loudness and duck sections, ADR 0171; W1 added the
/// `musicRings` (16 x 8 B) and `groupStarts` (8 x 16 B) sections to the 15,936 B of merge 1); of 16,384; this case is
/// updated by L-W1a then. Here: a STATUS with every section at its cap writes exactly the constant and
/// fits `STATUS_BUFFER_BYTES`.
#[test]
fn status_worst_case_matches_the_constant() {
    assert_eq!(STATUS_WORST_CASE_BYTES, 17_824);
    let full = StatusBlock {
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
        music_rings: vec![Default::default(); MAX_MUSIC_RINGS as usize],
        group_starts: vec![Default::default(); MAX_GROUP_STARTS_PER_BLOCK as usize],
        loud_buses: vec![Default::default(); LOUD_METERS as usize],
        loud_energies: vec![Default::default(); MAX_LOUD_ENERGIES as usize],
        bus_duck: vec![Default::default(); MAX_DUCK_RULES as usize],
        ..Default::default()
    };
    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = full.write(&mut buf, 0, 1).unwrap();
    assert_eq!(n, STATUS_WORST_CASE_BYTES as usize);
    assert!(n <= STATUS_BUFFER_BYTES as usize);
    let (back, used) = StatusBlock::read(&buf, 0).unwrap();
    assert_eq!(used, n);
    assert_eq!(back, full);
}

/// `vectors/wire.json` golden records: add to `vectors/cases.rs` a hand-derived case for FADE with a
/// non-zero shape (equal power in, phase 0x4000), STOP with equal power out, SET_PARAMS with an
/// S-curve, a PLAY with `fadeZero`, and a STATUS with every M4 header field non-zero; run `gen_wire`
/// and keep `vectors.rs` green. The hex is derived by hand from the section 4 tables, not from the
/// writers.
#[test]
fn golden_vectors_cover_every_longer_record() {
    // (name, encoded size in bytes): the record sizes of API section 4.
    let expect: [(&str, usize); 5] = [
        ("FADE_equal_power_in_phase_quarter", 28),
        ("STOP_equal_power_out", 24),
        ("SET_PARAMS_s_curve", 60),
        ("PLAY_fade_zero", 56),
        ("STATUS_m4_header_only", 256),
    ];
    let all = cases();
    let s = schema();
    for (name, size) in expect {
        let case = all.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no vector named {name}"));
        assert_eq!(case.hex.len(), 2 * size, "{name}: hex length");
        let bytes = encode(&s, case).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(to_hex(&bytes), case.hex, "{name}");
    }
}
