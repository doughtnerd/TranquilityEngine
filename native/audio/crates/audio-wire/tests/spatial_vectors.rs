//! L-A1a: ADR 0162's wire records (spatial audio, M3): golden vectors, round trips through the
//! generated Rust, refusals and a seeded fuzz. The vectors themselves are in `vectors/spatial_cases.rs`;
//! `tests/vectors.rs` already checks every case against the interpretive codec.

use audio_wire::cases::cases;
use audio_wire::generated::*;
use audio_wire::model::Value;
use audio_wire::vector::{Subject, VectorCase};

/// The ADR 0162 opcodes that have their own vectors in `spatial_cases.rs`.
const M3_OPCODES: &[&str] = &["SET_VOICE_FX", "BED_CONFIG", "ZONE_CONFIG", "LISTENER"];

/// Vector name and opcode of each single-record vector (the truncation and fuzz tests use these).
const RECORDS: &[(&str, &str)] = &[
    ("SET_VOICE_FX_all_bits_stamped", "SET_VOICE_FX"),
    ("SET_VOICE_FX_hp_asap", "SET_VOICE_FX"),
    ("BED_CONFIG_5_buses_3_slots", "BED_CONFIG"),
    ("BED_CONFIG_4_buses_0_slots", "BED_CONFIG"),
    ("BED_CONFIG_empty", "BED_CONFIG"),
    ("ZONE_CONFIG_0_slots", "ZONE_CONFIG"),
    ("ZONE_CONFIG_3_slots", "ZONE_CONFIG"),
    ("ZONE_CONFIG_4_slots", "ZONE_CONFIG"),
    ("LISTENER_ramped", "LISTENER"),
    ("LISTENER_snap", "LISTENER"),
];

/// Every named vector the L-A1a coverage list asks for.
const COVERAGE: &[&str] = &[
    "SET_VOICE_FX_all_bits_stamped",
    "SET_VOICE_FX_hp_asap",
    "BED_CONFIG_5_buses_3_slots",
    "BED_CONFIG_4_buses_0_slots",
    "BED_CONFIG_empty",
    "ZONE_CONFIG_0_slots",
    "ZONE_CONFIG_3_slots",
    "ZONE_CONFIG_4_slots",
    "LISTENER_ramped",
    "LISTENER_snap",
    "PLAY_ambisonic_flag",
    "PLAY_bed_panner2",
    "SET_PARAMS_bed_panner2",
    "STREAM_OPEN_16ch_fuma",
    "CLIP_BEGIN_zone_kernel_f3",
    "CLIP_BEGIN_magls_f4",
    "CLIP_BEGIN_zone_ir_f5",
    "ZONE_KERNEL_HEADER",
    "MAGLS_HEADER",
    "STATUS_adr0162_sections",
    "BATCH_m3_opcodes",
];

/// Records and blob headers read by the fuzz: vector name, then the reader's kind.
const TEMPLATES: &[(&str, &str)] = &[
    ("SET_VOICE_FX_all_bits_stamped", "SET_VOICE_FX"),
    ("SET_VOICE_FX_hp_asap", "SET_VOICE_FX"),
    ("BED_CONFIG_5_buses_3_slots", "BED_CONFIG"),
    ("BED_CONFIG_4_buses_0_slots", "BED_CONFIG"),
    ("BED_CONFIG_empty", "BED_CONFIG"),
    ("ZONE_CONFIG_0_slots", "ZONE_CONFIG"),
    ("ZONE_CONFIG_3_slots", "ZONE_CONFIG"),
    ("ZONE_CONFIG_4_slots", "ZONE_CONFIG"),
    ("LISTENER_ramped", "LISTENER"),
    ("LISTENER_snap", "LISTENER"),
    ("PLAY_ambisonic_flag", "PLAY"),
    ("PLAY_bed_panner2", "PLAY"),
    ("SET_PARAMS_bed_panner2", "SET_PARAMS"),
    ("ZONE_KERNEL_HEADER", "ZONE_KERNEL_HEADER"),
    ("MAGLS_HEADER", "MAGLS_HEADER"),
    ("STATUS_adr0162_sections", "STATUS"),
];

fn named(name: &str) -> VectorCase {
    cases().into_iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no vector named {name}"))
}

fn from_hex(h: &str) -> Vec<u8> {
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
}

fn bytes(c: &VectorCase) -> Vec<u8> {
    from_hex(c.hex)
}

fn word_count(buf: &[u8]) -> u16 {
    u16::from_le_bytes([buf[2], buf[3]])
}

fn with_words(buf: &[u8], words: u16) -> Vec<u8> {
    let mut out = buf.to_vec();
    out[2..4].copy_from_slice(&words.to_le_bytes());
    out
}

fn num(c: &VectorCase, field: &str) -> u64 {
    match c.values.iter().find(|(n, _)| *n == field) {
        Some((_, Value::U(x))) => *x,
        other => panic!("{}: {field} is {other:?}", c.name),
    }
}

/// The `op` of each record of a BATCH vector.
fn batch_ops(c: &VectorCase) -> Vec<String> {
    let Some((_, Value::Arr(records))) = c.values.iter().find(|(n, _)| *n == "records") else {
        panic!("{}: no records", c.name)
    };
    records
        .iter()
        .map(|r| match r {
            Value::Rec(fields) => match fields.iter().find(|(n, _)| n.as_str() == "op") {
                Some((_, Value::Str(s))) => s.clone(),
                other => panic!("{}: op is {other:?}", c.name),
            },
            other => panic!("{}: record is {other:?}", c.name),
        })
        .collect()
}

/// The length a reader consumes for the record `op` (or `Err` with its code).
fn read_len(op: &str, buf: &[u8]) -> Result<usize, i32> {
    match op {
        "SET_VOICE_FX" => SetVoiceFx::read(buf, 0).map(|(_, n)| n),
        "BED_CONFIG" => BedConfig::read(buf, 0).map(|(_, n)| n),
        "ZONE_CONFIG" => ZoneConfig::read(buf, 0).map(|(_, n)| n),
        "LISTENER" => Listener::read(buf, 0).map(|(_, n)| n),
        "PLAY" => Play::read(buf, 0).map(|(_, n)| n),
        "SET_PARAMS" => SetParams::read(buf, 0).map(|(_, n)| n),
        other => panic!("no reader for {other}"),
    }
}

/// Reads `buf` as the record `op` and writes it back with the generated writer.
fn rewrite_record(op: &str, buf: &[u8]) -> Result<Vec<u8>, i32> {
    let mut out = vec![0u8; buf.len() + 64];
    let n = match op {
        "SET_VOICE_FX" => SetVoiceFx::read(buf, 0)?.0.write(&mut out, 0)?,
        "BED_CONFIG" => BedConfig::read(buf, 0)?.0.write(&mut out, 0)?,
        "ZONE_CONFIG" => ZoneConfig::read(buf, 0)?.0.write(&mut out, 0)?,
        "LISTENER" => Listener::read(buf, 0)?.0.write(&mut out, 0)?,
        "PLAY" => Play::read(buf, 0)?.0.write(&mut out, 0)?,
        "SET_PARAMS" => SetParams::read(buf, 0)?.0.write(&mut out, 0)?,
        other => panic!("no writer for {other}"),
    };
    out.truncate(n);
    Ok(out)
}

/// Reads a STATUS message and writes it back; the envelope's `seq` is kept.
fn rewrite_status(buf: &[u8]) -> Vec<u8> {
    let (env, _) = Envelope::read(buf, 0).unwrap();
    let (block, n) = StatusBlock::read(buf, 0).unwrap();
    let mut out = vec![0u8; buf.len()];
    let m = block.write(&mut out, 0, env.seq).unwrap();
    assert_eq!(m, n, "STATUS length");
    out.truncate(m);
    out
}

/// Every ADR 0162 opcode (SET_VOICE_FX, BED_CONFIG, ZONE_CONFIG, LISTENER), both blob headers
/// (`ZoneKernelHeader`, `MaglsHeader`) and a STATUS with non-empty `beds`/`zones`/`zoneEvents` have at
/// least one vector, plus every case the coverage list of `spatial_cases.rs` names.
#[test]
fn every_m3_record_has_a_vector() {
    let all = cases();
    for name in COVERAGE {
        assert!(all.iter().any(|c| c.name == *name), "coverage vector {name} is missing");
    }
    for op in M3_OPCODES {
        assert!(all.iter().any(|c| matches!(c.subject, Subject::Opcode(n) if n == *op)), "no vector for {op}");
    }
    assert!(all.iter().any(|c| matches!(c.subject, Subject::BlobHeader("ZoneKernelHeader"))));
    assert!(all.iter().any(|c| matches!(c.subject, Subject::BlobHeader("MaglsHeader"))));

    // The M3 STATUS: beds, zones and zoneEvents non-empty, flags bit 6, and the ADR 0162 header fields
    // distinct and non-zero.
    let status = named("STATUS_adr0162_sections");
    let (st, _) = StatusBlock::read(&bytes(&status), 0).unwrap();
    assert!(!st.beds.is_empty() && !st.zones.is_empty() && !st.zone_events.is_empty());
    assert_ne!(st.flags & 0x40, 0, "bedDecoderReady");
    let fields = [
        st.bed_voices as u32,
        st.beds.len() as u32,
        st.fx_voices as u32,
        st.ambisonic_voices as u32,
        st.zones_active as u32,
        st.zones_ringing as u32,
        st.zone_events.len() as u32,
        st.beds_refused as u32,
        st.zones.len() as u32,
        st.m3_shed as u32,
        st.zone_used_kb,
        st.work_bed,
        st.work_zones,
    ];
    assert!(fields.iter().all(|&x| x != 0), "a zero ADR 0162 STATUS field: {fields:?}");
    let mut distinct = fields.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(distinct.len(), fields.len(), "ADR 0162 STATUS fields are not distinct");

    // The BATCH carries one record of each new opcode.
    let ops = batch_ops(&named("BATCH_m3_opcodes"));
    assert_eq!(ops, ["SET_VOICE_FX", "BED_CONFIG", "ZONE_CONFIG", "LISTENER"]);

    // The CLIP_BEGIN formats, the STREAM_OPEN convention and the PLAY and SET_PARAMS panner and
    // ambisonic bits named by the coverage list.
    assert_eq!(num(&named("CLIP_BEGIN_zone_kernel_f3"), "format"), 3);
    assert_eq!(num(&named("CLIP_BEGIN_magls_f4"), "format"), 4);
    assert_eq!(num(&named("CLIP_BEGIN_zone_ir_f5"), "format"), 5);
    assert_eq!(num(&named("CLIP_BEGIN_zone_kernel_f3"), "clipId"), 0xFFFF_0200);
    assert_eq!(num(&named("CLIP_BEGIN_magls_f4"), "clipId"), 0xFFFF_0100);
    assert_eq!(num(&named("CLIP_BEGIN_zone_ir_f5"), "clipId"), 0xFFFF_02FF);
    let wide = named("STREAM_OPEN_16ch_fuma");
    assert_eq!((num(&wide, "channels"), num(&wide, "convention")), (16, 1));
    assert_ne!(num(&named("PLAY_ambisonic_flag"), "flags") & 0x80, 0);
    assert_eq!((num(&named("PLAY_bed_panner2"), "flags") >> 5) & 3, 2);
    assert_eq!((num(&named("SET_PARAMS_bed_panner2"), "flags") >> 5) & 3, 2);
    assert_eq!(num(&named("LISTENER_snap"), "flags") & 1, 1);
    assert_eq!(num(&named("LISTENER_ramped"), "flags") & 1, 0);
    assert!(num(&named("LISTENER_ramped"), "rampFrames") > 0);
}

/// Each `Subject::Opcode` vector of an ADR 0162 opcode, decoded from its hex with the generated
/// `read`, then written again with `write`, gives the same bytes and the same length; likewise the
/// blob headers and the M3 STATUS vector through `StatusBlock`.
#[test]
fn m3_vectors_round_trip_through_the_generated_rust() {
    for c in cases() {
        let buf = bytes(&c);
        match &c.subject {
            Subject::Opcode(op) if M3_OPCODES.contains(op) => {
                let out = rewrite_record(op, &buf).unwrap_or_else(|e| panic!("{}: read failed with {e}", c.name));
                assert_eq!(out, buf, "{}: rewritten bytes differ", c.name);
            }
            Subject::BlobHeader("ZoneKernelHeader") => {
                let (h, n) = ZoneKernelHeader::read(&buf, 0).unwrap();
                let mut out = vec![0u8; buf.len()];
                assert_eq!(h.write(&mut out, 0).unwrap(), n, "{}", c.name);
                assert_eq!(out, buf, "{}", c.name);
            }
            Subject::BlobHeader("MaglsHeader") => {
                let (h, n) = MaglsHeader::read(&buf, 0).unwrap();
                let mut out = vec![0u8; buf.len()];
                assert_eq!(h.write(&mut out, 0).unwrap(), n, "{}", c.name);
                assert_eq!(out, buf, "{}", c.name);
            }
            Subject::Status if c.name == "STATUS_adr0162_sections" => {
                assert_eq!(rewrite_status(&buf), buf, "{}", c.name);
            }
            _ => {}
        }
    }
}

/// BED_CONFIG's two arrays pad to whole words with zero bytes (5 buses -> 8 B, 3 slots -> 8 B), the
/// record's `words` counts the padding, and a reader given non-zero padding still reads the arrays.
#[test]
fn bed_config_pads_each_array_to_four_bytes() {
    let five = bytes(&named("BED_CONFIG_5_buses_3_slots"));
    assert_eq!(five.len(), 36, "20 + pad4(5) + pad4(3 x 2)");
    assert_eq!(word_count(&five), 9, "words counts the padding");
    assert_eq!(&five[25..28], &[0, 0, 0], "bedSlot padding is zero");
    assert_eq!(&five[34..36], &[0, 0], "hostBus padding is zero");

    let mut dirty = five.clone();
    dirty[25..28].fill(0xAA);
    dirty[34..36].fill(0xAA);
    let (read, n) = BedConfig::read(&dirty, 0).unwrap();
    assert_eq!(n, 36);
    assert_eq!(read.bed_slot, vec![0, 1, 0xFF, 2, 3]);
    assert_eq!(read.host_bus, vec![5, 0xFFFF, 6]);
    assert_eq!(rewrite_record("BED_CONFIG", &dirty).unwrap(), five, "the writer zeroes the padding");

    let four = bytes(&named("BED_CONFIG_4_buses_0_slots"));
    assert_eq!(four.len(), 24, "20 + pad4(4) + no hostBus");
    assert_eq!(word_count(&four), 6);
    let (read, n) = BedConfig::read(&four, 0).unwrap();
    assert_eq!(n, 24);
    assert!(read.host_bus.is_empty());

    let mut out = vec![0u8; 64];
    let three_buses = BedConfig { voice_id: 0, frame_offset: ASAP, bed_slot: vec![1, 2, 3], host_bus: vec![] };
    assert_eq!(three_buses.write(&mut out, 0).unwrap(), 24, "3 buses pad to 4 B");
    assert_eq!(out[23], 0);
    let one_host = BedConfig { voice_id: 0, frame_offset: ASAP, bed_slot: vec![], host_bus: vec![7] };
    assert_eq!(one_host.write(&mut out, 0).unwrap(), 24, "1 slot pads 2 B to 4 B");
    assert_eq!(&out[22..24], &[0, 0]);
}

/// Caps: BED_CONFIG `slotCount` 5 and ZONE_CONFIG `slotCount` 5 are refused on read (`ERR_MALFORMED`)
/// and on write (`ERR_OVERSIZE`); 4 is accepted.
#[test]
fn slot_counts_above_four_are_refused() {
    let mut out = vec![0u8; 512];
    let bed = |hosts: usize| BedConfig { voice_id: 0, frame_offset: ASAP, bed_slot: vec![], host_bus: vec![0; hosts] };
    assert_eq!(bed(5).write(&mut out, 0), Err(ERR_OVERSIZE));
    assert!(bed(4).write(&mut out, 0).is_ok());

    let zone = |slots: usize| ZoneConfig {
        voice_id: 0,
        frame_offset: ASAP,
        shared_return_gain: 1.0,
        ramp_frames: 0,
        slots: vec![ZoneConfigSlots::default(); slots],
    };
    assert_eq!(zone(5).write(&mut out, 0), Err(ERR_OVERSIZE));
    assert!(zone(4).write(&mut out, 0).is_ok());

    let mut bed_bytes = bytes(&named("BED_CONFIG_5_buses_3_slots"));
    bed_bytes[16..20].copy_from_slice(&5u32.to_le_bytes());
    assert_eq!(BedConfig::read(&bed_bytes, 0).err(), Some(ERR_MALFORMED));

    let mut zone_bytes = bytes(&named("ZONE_CONFIG_3_slots"));
    zone_bytes[12..16].copy_from_slice(&5u32.to_le_bytes());
    assert_eq!(ZoneConfig::read(&zone_bytes, 0).err(), Some(ERR_MALFORMED));

    let four = bytes(&named("ZONE_CONFIG_4_slots"));
    assert_eq!(ZoneConfig::read(&four, 0).unwrap().0.slots.len(), 4);
}

/// Truncation: every ADR 0162 record cut at each length below its size (and with `words` claiming
/// more than the buffer) is refused with `ERR_TRUNCATED`, never a panic; a record read with another
/// opcode's reader is `ERR_MALFORMED`.
#[test]
fn truncated_m3_records_are_refused() {
    for &(name, op) in RECORDS {
        let full = bytes(&named(name));
        for cut in 0..full.len() {
            assert_eq!(read_len(op, &full[..cut]), Err(ERR_TRUNCATED), "{name} cut at {cut}");
        }
        let claims_more = with_words(&full, word_count(&full) + 1);
        assert_eq!(read_len(op, &claims_more), Err(ERR_TRUNCATED), "{name}: words past the buffer");
        for &(_, other) in RECORDS.iter().filter(|(_, o)| *o != op) {
            assert_eq!(read_len(other, &full), Err(ERR_MALFORMED), "{name} read as {other}");
        }
    }
    let kernel = bytes(&named("ZONE_KERNEL_HEADER"));
    for cut in 0..kernel.len() {
        assert_eq!(ZoneKernelHeader::read(&kernel[..cut], 0).err(), Some(ERR_TRUNCATED), "header cut at {cut}");
    }
    let magls = bytes(&named("MAGLS_HEADER"));
    for cut in 0..magls.len() {
        assert_eq!(MaglsHeader::read(&magls[..cut], 0).err(), Some(ERR_TRUNCATED), "header cut at {cut}");
    }
}

/// A LISTENER with NaN or zero quaternion components and a SET_VOICE_FX with NaN sends parse (the
/// wire carries them; the core ignores them, K2) and round-trip bit for bit.
#[test]
fn non_finite_values_survive_the_wire() {
    let payload_nan = f32::from_bits(0x7FC0_1234);
    let listener = Listener {
        voice_id: 0,
        frame_offset: ASAP,
        qx: payload_nan,
        qy: f32::INFINITY,
        qz: -0.0,
        qw: 0.0,
        ramp_frames: 0,
        flags: LISTENER_FLAGS_SNAP,
    };
    let mut out = vec![0u8; 64];
    let n = listener.write(&mut out, 0).unwrap();
    assert_eq!(n, 36);
    assert_eq!(&out[12..16], &0x7FC0_1234u32.to_le_bytes(), "NaN payload on the wire");
    let (back, m) = Listener::read(&out[..n], 0).unwrap();
    assert_eq!(m, n);
    assert_eq!(back.qx.to_bits(), payload_nan.to_bits());
    assert_eq!(back.qy.to_bits(), f32::INFINITY.to_bits());
    assert_eq!(back.qz.to_bits(), (-0.0f32).to_bits());
    assert_eq!(back.qw.to_bits(), 0.0f32.to_bits());
    assert_eq!(rewrite_record("LISTENER", &out[..n]).unwrap(), out[..n]);

    let sends = [f32::from_bits(0x7FC0_0042), f32::INFINITY, 0.0, -0.0];
    let fx = SetVoiceFx {
        voice_id: 4,
        frame_offset: 128,
        mask: 0x0F,
        ramp_frames: 0,
        hp_hz: f32::NAN,
        send: sends,
        yaw: f32::NEG_INFINITY,
        aux_level: f32::from_bits(0x7FC0_BEEF),
        aux_bus: AUX_BUS_NONE as u16,
        reserved: 0,
    };
    let mut out = vec![0u8; 64];
    let n = fx.write(&mut out, 0).unwrap();
    assert_eq!(n, 52);
    let (back, m) = SetVoiceFx::read(&out[..n], 0).unwrap();
    assert_eq!(m, n);
    assert_eq!(back.hp_hz.to_bits(), fx.hp_hz.to_bits());
    for i in 0..4 {
        assert_eq!(back.send[i].to_bits(), sends[i].to_bits(), "send {i}");
    }
    assert_eq!(back.yaw.to_bits(), f32::NEG_INFINITY.to_bits());
    assert_eq!(back.aux_level.to_bits(), 0x7FC0_BEEFu32);
    assert_eq!(rewrite_record("SET_VOICE_FX", &out[..n]).unwrap(), out[..n]);
}

/// A small linear congruential generator (the constants of `wire.roundtrip.test.ts`), so the fuzz is
/// the same sequence on both sides.
struct Lcg(u32);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0
    }

    /// A value in `0..n`.
    fn below(&mut self, n: u32) -> u32 {
        ((self.next() as u64 * n as u64) >> 32) as u32
    }
}

fn put_u32(buf: &mut [u8], at: usize, v: u32) {
    buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

/// Reads `buf` with the reader of `kind`; the consumed length, or the error code.
fn read_any(kind: &str, buf: &[u8], base: usize) -> Result<usize, i32> {
    match kind {
        "SET_VOICE_FX" => SetVoiceFx::read(buf, base).map(|(_, n)| n),
        "BED_CONFIG" => BedConfig::read(buf, base).map(|(_, n)| n),
        "ZONE_CONFIG" => ZoneConfig::read(buf, base).map(|(_, n)| n),
        "LISTENER" => Listener::read(buf, base).map(|(_, n)| n),
        "PLAY" => Play::read(buf, base).map(|(_, n)| n),
        "SET_PARAMS" => SetParams::read(buf, base).map(|(_, n)| n),
        "ZONE_KERNEL_HEADER" => ZoneKernelHeader::read(buf, base).map(|(_, n)| n),
        "MAGLS_HEADER" => MaglsHeader::read(buf, base).map(|(_, n)| n),
        "STATUS" => StatusBlock::read(buf, base).map(|(_, n)| n),
        other => panic!("no reader for {other}"),
    }
}

/// Seeded fuzz (fixed seed, a small LCG as `wire.roundtrip.test.ts`): 1,000 random byte buffers built
/// from valid ADR 0162 records with random truncation, random `words`, BED_CONFIG with a bad host and
/// huge counts, ZONE_CONFIG with `slotCount` above 4, LISTENER with NaN. Every generated reader
/// returns `Ok` or an `ERR_*` code; none panics or reads out of bounds.
#[test]
fn fuzz_m3_records_never_panic() {
    let templates: Vec<(&str, Vec<u8>)> = TEMPLATES.iter().map(|&(name, kind)| (kind, bytes(&named(name)))).collect();
    let mut rng = Lcg(0x5eed_1234);
    let (mut ok, mut refused) = (0u32, 0u32);
    let mut status_refused = 0u32;

    for _ in 0..1_000 {
        let (kind, template) = &templates[rng.below(templates.len() as u32) as usize];
        let mut buf = template.clone();

        // Random byte overwrites anywhere in the message.
        for _ in 0..rng.below(4) {
            let i = rng.below(buf.len() as u32) as usize;
            buf[i] = rng.next() as u8;
        }
        // Random `words`, which may claim more than the buffer holds.
        if rng.below(3) == 0 {
            buf = with_words(&buf, rng.below(65_536) as u16);
        }
        match *kind {
            "BED_CONFIG" => {
                // A bad host: a random hostBus word.
                if rng.below(2) == 0 && buf.len() >= 22 {
                    let at = 20 + rng.below((buf.len() - 21) as u32) as usize;
                    buf[at..at + 2].copy_from_slice(&(rng.next() as u16).to_le_bytes());
                }
                // Huge counts: busCount and slotCount.
                if rng.below(4) == 0 {
                    let huge = match rng.below(3) {
                        0 => 0xFFFF_FFFF,
                        1 => rng.next(),
                        _ => 5,
                    };
                    put_u32(&mut buf, 12 + 4 * rng.below(2) as usize, huge);
                }
            }
            "ZONE_CONFIG" => {
                // slotCount above 4 most of the time.
                if rng.below(2) == 0 {
                    put_u32(&mut buf, 12, rng.below(12));
                }
            }
            "LISTENER" => {
                // NaN components.
                if rng.below(2) == 0 {
                    put_u32(&mut buf, 12 + 4 * rng.below(4) as usize, 0x7FC0_0000 | (rng.next() & 0x3F_FFFF));
                }
            }
            "SET_VOICE_FX" => {
                if rng.below(2) == 0 {
                    put_u32(&mut buf, 20 + 4 * rng.below(6) as usize, 0x7FC0_0000 | (rng.next() & 0x3F_FFFF));
                }
            }
            "STATUS" => {
                // A bodyBytes shorter than the header, or past the buffer, or a section count past
                // its cap (beds at 114, zoneEventCount at 124, zoneSlots at 128).
                match rng.below(3) {
                    0 => put_u32(&mut buf, 12, rng.below(200)),
                    1 => put_u32(&mut buf, 12, rng.next()),
                    _ => {
                        let at = [114usize, 124, 128][rng.below(3) as usize];
                        buf[at..at + 2].copy_from_slice(&(rng.below(40) as u16).to_le_bytes());
                    }
                }
            }
            _ => {}
        }
        // Truncation.
        if rng.below(3) == 0 {
            let cut = rng.below(buf.len() as u32 + 1) as usize;
            buf.truncate(cut);
        }
        // A base offset into a larger buffer.
        let base = rng.below(3) as usize;
        let mut framed = vec![0u8; base];
        framed.extend_from_slice(&buf);

        match read_any(kind, &framed, base) {
            Ok(n) => {
                assert!(n <= framed.len() - base, "{kind}: consumed {n} of {} B", framed.len() - base);
                ok += 1;
            }
            Err(code) => {
                assert!((ERR_MALFORMED..=ERR_NOT_IMPLEMENTED).contains(&code), "{kind}: unexpected code {code}");
                if *kind == "STATUS" {
                    status_refused += 1;
                }
                refused += 1;
            }
        }
    }
    assert!(ok > 0 && refused > 0, "the fuzz exercised neither outcome: ok {ok}, refused {refused}");
    assert!(status_refused > 0, "the fuzz refused no STATUS");
}

/// STATUS worst case (api-and-models §4.3): every section at its cap (ended, demoted, starved 1,024;
/// playheads 256; clip and stream events 64; peaks 32; beds 4; zones 4; zoneEvents 16) writes exactly
/// `STATUS_WORST_CASE_BYTES` (17,824 B with the M5 sections, at most `STATUS_BUFFER_BYTES`) and reads back equal.
#[test]
fn status_worst_case_is_17824_bytes() {
    let st = StatusBlock {
        current_frame: 1000.0,
        date_ms: 1.5,
        ping_seq: 7,
        flags: 0x7F,
        mixed_cap: 64,
        bed_voices: 9,
        fx_voices: 8,
        ambisonic_voices: 6,
        zones_active: 3,
        zones_ringing: 1,
        beds_refused: 7,
        m3_shed: 11,
        zone_used_kb: 4096,
        work_bed: 1500,
        work_zones: 2500,
        ended: (0..1024u32).collect(),
        demoted: (0..1024u32).collect(),
        starved: (0..1024u32).collect(),
        playheads: (0..256u32).map(|i| StatusPlayheadsItem { id: i, clip_frame: i * 3 }).collect(),
        clip_events: (0..64u32).map(|i| StatusClipEventsItem { clip_id: i, code: 1 + i % 5 }).collect(),
        stream_events: (0..64u32).map(|i| StatusStreamEventsItem { id: i, code: 1 + i % 3 }).collect(),
        peaks: (0..32u32).map(|i| StatusPeaksItem { l: i as f32 * 0.5, r: 1.0 }).collect(),
        beds: (0..4u32).map(|i| StatusBedsItem { bus: i as u16, voices: 2, work: 100 + i }).collect(),
        zones: (0..4u32)
            .map(|i| StatusZonesItem { kernel_id: 0xFFFF_0200 + i, state: 3, pad: 0, quanta_since_input: 1, wet_peak: 0.5 })
            .collect(),
        zone_events: (0..16u32).map(|i| StatusZoneEventsItem { slot: (i % 4) as u8, code: 1 + (i % 3) as u8, reserved: 0 }).collect(),
        music_rings: (0..16u32).map(|i| StatusMusicRingsItem { stream_id: 100 + i, epoch_flags: i | MUSIC_RING_PRIMED | if i % 2 == 0 { MUSIC_RING_BOUND } else { 0 } }).collect(),
        group_starts: (0..8u32).map(|i| StatusGroupStartsItem { group_id: 1 + i as u16, flags: (i % 8) as u16, slip_frames: i * 128, start_frame_lo: 1000 + i, start_frame_hi: i }).collect(),
        loud_buses: (0..LOUD_METERS).map(|i| StatusLoudBusesItem { slot: if i == 8 { LOUD_OUTPUT_TAP as u16 } else { i as u16 }, flags: (i % 33) as u16, first_seq: 1000 + i, true_peak: i as f32 * 0.125, gated_quanta: i * 7 }).collect(),
        loud_energies: (0..MAX_LOUD_ENERGIES).map(|i| i as f32 * 0.001).collect(),
        bus_duck: (0..MAX_DUCK_RULES).map(|i| StatusBusDuckItem { slot: i as u16, pad: 0, gain: 1.0 - i as f32 * 0.01 }).collect(),
        ..StatusBlock::default()
    };
    let mut buf = vec![0u8; STATUS_BUFFER_BYTES as usize];
    let n = st.write(&mut buf, 0, 30).unwrap();
    assert_eq!(n, STATUS_WORST_CASE_BYTES as usize);
    assert!(n <= STATUS_BUFFER_BYTES as usize);
    let (back, m) = StatusBlock::read(&buf, 0).unwrap();
    assert_eq!(m, n);
    assert_eq!(back, st);
}
