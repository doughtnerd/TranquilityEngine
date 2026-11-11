//! L-A1a: ADR 0162's byte vectors (spatial audio, M3), with the expected bytes derived **by hand** from
//! the tables of api-and-models §4.2–§4.5 and contracts C1–C7 (never by running the writers). Same
//! conventions as `cases.rs` (see `crate::vector`): envelopes carry version 1.1 (`0101`); f32 as
//! `f32::to_bits`, little-endian; each record commented with its field offsets.
//!
//! `cases::cases()` chains these after the M1/M2 vectors, so `tests/vectors.rs` checks each against
//! the interpretive codec and `gen_wire` writes them to `vectors/wire.json` for the TypeScript round
//! trip (rerun `gen_wire` after editing this file).
//!
//! Coverage required (L-A1a), envelope `seq` values 40..=49 where a message is a whole kind:
//! - SET_VOICE_FX: every mask bit at once with all four sends, stamped; and hp only, asap, auxBus 0xFFFF.
//! - BED_CONFIG: 5 buses and 3 slots (both arrays padded: 5 -> 8 B, 3 x 2 -> 8 B), one bus 0xFF and
//!   one slot 0xFFFF; 4 buses and 0 slots (no padding, empty hostBus); 0 buses and 0 slots (20 B).
//! - ZONE_CONFIG: 0 slots (24 B); 3 slots (72 B) with states 1, 2, 3 and one kernelId 0 (off); 4 slots.
//! - LISTENER: a ramped rotation, and a snap (flags bit0).
//! - PLAY with bit 7 `ambisonic` set; PLAY and SET_PARAMS with panner 2 (bed).
//! - STREAM_OPEN with 16 channels and convention 1 (FuMa).
//! - CLIP_BEGIN with format 3 (id 0xFFFF0200), 4 (id 0xFFFF0100) and 5 (id 0xFFFF02FF).
//! - `BlobHeader("ZoneKernelHeader")` and `BlobHeader("MaglsHeader")`, every field distinct.
//! - a STATUS whose ADR 0162 header fields are all distinct and non-zero, `flags` with bit 6, and the
//!   `beds`, `zones` and `zoneEvents` sections non-empty (the M1/M2 sections may be empty).
//! - a BATCH carrying one record of each new opcode.

use crate::model::Value;
use crate::vector::{Subject, VectorCase};

fn vu(x: u64) -> Value {
    Value::U(x)
}

fn vi(x: i64) -> Value {
    Value::I(x)
}

fn vf(x: f64) -> Value {
    Value::F(x)
}

fn va(items: Vec<Value>) -> Value {
    Value::Arr(items)
}

fn vr(fields: Vec<(&str, Value)>) -> Value {
    Value::Rec(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn vs(s: &str) -> Value {
    Value::Str(s.to_string())
}

fn case(name: &'static str, subject: Subject, values: Vec<(&'static str, Value)>, hex: &'static str) -> VectorCase {
    VectorCase { name, subject, values, hex }
}

/// ADR 0162's vectors. The names are checked by `tests/spatial_vectors.rs`.
pub fn spatial_cases() -> Vec<VectorCase> {
    vec![
        // SET_VOICE_FX, 52 B = 13 words, stamped at 512. Mask 0xF (every bit), ramp 480 frames, hpHz 120.0,
        // sends 0.5, 0.25, 0.0, 1.0, yaw pi/2, aux 0.5 into bus 2.
        case(
            "SET_VOICE_FX_all_bits_stamped",
            Subject::Opcode("SET_VOICE_FX"),
            vec![
                ("voiceId", vu(7)),
                ("frameOffset", vu(512)),
                ("mask", vu(0x0F)),
                ("rampFrames", vu(480)),
                ("hpHz", vf(120.0)),
                ("send", va(vec![vf(0.5), vf(0.25), vf(0.0), vf(1.0)])),
                ("yaw", vf(std::f64::consts::FRAC_PI_2)),
                ("auxLevel", vf(0.5)),
                ("auxBus", vu(2)),
                ("reserved", vu(0)),
            ],
            concat!(
                "0a00", "0d00", "07000000", "00020000", // head: SET_VOICE_FX, 13 words, voice 7, frame 512
                "0f000000", // 12 mask: hpHz | sends | yaw | aux
                "e0010000", // 16 rampFrames 480
                "0000f042", // 20 hpHz 120.0
                "0000003f", "0000803e", "00000000", "0000803f", // 24 send[0..3]: 0.5, 0.25, 0.0, 1.0
                "db0fc93f", // 40 yaw pi/2
                "0000003f", // 44 auxLevel 0.5
                "0200", // 48 auxBus 2
                "0000", // 50 reserved
            ),
        ),
        // SET_VOICE_FX, 52 B = 13 words, asap. Mask 0x1 (hpHz only), hpHz 80.0, aux bus none (0xFFFF).
        case(
            "SET_VOICE_FX_hp_asap",
            Subject::Opcode("SET_VOICE_FX"),
            vec![
                ("voiceId", vu(3)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("mask", vu(0x01)),
                ("rampFrames", vu(0)),
                ("hpHz", vf(80.0)),
                ("send", va(vec![vf(0.0), vf(0.0), vf(0.0), vf(0.0)])),
                ("yaw", vf(0.0)),
                ("auxLevel", vf(0.0)),
                ("auxBus", vu(0xFFFF)),
                ("reserved", vu(0)),
            ],
            concat!(
                "0a00", "0d00", "03000000", "ffffffff", // head: SET_VOICE_FX, 13 words, voice 3, asap
                "01000000", // 12 mask: hpHz
                "00000000", // 16 rampFrames 0
                "0000a042", // 20 hpHz 80.0
                "00000000", "00000000", "00000000", "00000000", // 24 send[0..3] off
                "00000000", // 40 yaw
                "00000000", // 44 auxLevel
                "ffff", // 48 auxBus none
                "0000", // 50 reserved
            ),
        ),
        // BED_CONFIG, 36 B = 9 words, asap. 5 buses, 3 slots: bedSlot 0, 1, 0xFF (none), 2, 3, padded to 8 B;
        // hostBus 5, 0xFFFF (unused), 6, padded to 8 B.
        case(
            "BED_CONFIG_5_buses_3_slots",
            Subject::Opcode("BED_CONFIG"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("bedSlot", va(vec![vu(0), vu(1), vu(0xFF), vu(2), vu(3)])),
                ("hostBus", va(vec![vu(5), vu(0xFFFF), vu(6)])),
            ],
            concat!(
                "1600", "0900", "00000000", "ffffffff", // head: BED_CONFIG, 9 words, voice 0, asap
                "05000000", // 12 busCount 5
                "03000000", // 16 slotCount 3
                "0001ff0203000000", // 20 bedSlot[5] = 00 01 ff 02 03, pad 00 00 00 (8 B)
                "0500ffff06000000", // 28 hostBus[3] = 0005 ffff 0006, pad 00 00 (8 B)
            ),
        ),
        // BED_CONFIG, 24 B = 6 words, asap. 4 buses and 0 slots: no padding for the empty hostBus.
        case(
            "BED_CONFIG_4_buses_0_slots",
            Subject::Opcode("BED_CONFIG"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("bedSlot", va(vec![vu(0xFF), vu(0xFF), vu(0xFF), vu(0xFF)])),
                ("hostBus", va(vec![])),
            ],
            concat!(
                "1600", "0600", "00000000", "ffffffff", // head: BED_CONFIG, 6 words, voice 0, asap
                "04000000", // 12 busCount 4
                "00000000", // 16 slotCount 0
                "ffffffff", // 20 bedSlot[4], all none, no padding
            ),
        ),
        // BED_CONFIG, 20 B = 5 words, asap. No buses, no slots.
        case(
            "BED_CONFIG_empty",
            Subject::Opcode("BED_CONFIG"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("bedSlot", va(vec![])),
                ("hostBus", va(vec![])),
            ],
            concat!(
                "1600", "0500", "00000000", "ffffffff", // head: BED_CONFIG, 5 words, voice 0, asap
                "00000000", // 12 busCount 0
                "00000000", // 16 slotCount 0
            ),
        ),
        // ZONE_CONFIG, 24 B = 6 words, asap. No slots; shared return 1.0, ramp 960.
        case(
            "ZONE_CONFIG_0_slots",
            Subject::Opcode("ZONE_CONFIG"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("sharedReturnGain", vf(1.0)),
                ("rampFrames", vu(960)),
                ("slots", va(vec![])),
            ],
            concat!(
                "1700", "0600", "00000000", "ffffffff", // head: ZONE_CONFIG, 6 words, voice 0, asap
                "00000000", // 12 slotCount 0
                "0000803f", // 16 sharedReturnGain 1.0
                "c0030000", // 20 rampFrames 960
            ),
        ),
        // ZONE_CONFIG, 72 B = 18 words, asap. Three slots: active kernel 0xFFFF0200 (wet 1.0); off (kernel 0,
        // release, wet 0.5); kernel 0xFFFF0201 evicting (wet 0.25).
        case(
            "ZONE_CONFIG_3_slots",
            Subject::Opcode("ZONE_CONFIG"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("sharedReturnGain", vf(0.5)),
                ("rampFrames", vu(480)),
                (
                    "slots",
                    va(vec![
                        vr(vec![
                            ("kernelId", vu(0xFFFF_0200)),
                            ("returnBus", vu(4)),
                            ("state", vu(1)),
                            ("reserved", vu(0)),
                            ("wet", vf(1.0)),
                            ("irFrames", vu(4800)),
                        ]),
                        vr(vec![
                            ("kernelId", vu(0)),
                            ("returnBus", vu(5)),
                            ("state", vu(2)),
                            ("reserved", vu(0)),
                            ("wet", vf(0.5)),
                            ("irFrames", vu(0)),
                        ]),
                        vr(vec![
                            ("kernelId", vu(0xFFFF_0201)),
                            ("returnBus", vu(6)),
                            ("state", vu(3)),
                            ("reserved", vu(0)),
                            ("wet", vf(0.25)),
                            ("irFrames", vu(9600)),
                        ]),
                    ]),
                ),
            ],
            concat!(
                "1700", "1200", "00000000", "ffffffff", // head: ZONE_CONFIG, 18 words, voice 0, asap
                "03000000", // 12 slotCount 3
                "0000003f", // 16 sharedReturnGain 0.5
                "e0010000", // 20 rampFrames 480
                // slot 0 (24): kernel 0xFFFF0200, bus 4, state 1, wet 1.0, 4800 frames
                "0002ffff", "0400", "01", "00", "0000803f", "c0120000",
                // slot 1 (40): kernel 0 (off), bus 5, state 2, wet 0.5, 0 frames
                "00000000", "0500", "02", "00", "0000003f", "00000000",
                // slot 2 (56): kernel 0xFFFF0201, bus 6, state 3, wet 0.25, 9600 frames
                "0102ffff", "0600", "03", "00", "0000803e", "80250000",
            ),
        ),
        // ZONE_CONFIG, 88 B = 22 words, asap. Four slots: active, release, evict, and an evicting off slot.
        case(
            "ZONE_CONFIG_4_slots",
            Subject::Opcode("ZONE_CONFIG"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("sharedReturnGain", vf(0.25)),
                ("rampFrames", vu(0)),
                (
                    "slots",
                    va(vec![
                        vr(vec![
                            ("kernelId", vu(0xFFFF_0200)),
                            ("returnBus", vu(0)),
                            ("state", vu(1)),
                            ("reserved", vu(0)),
                            ("wet", vf(2.0)),
                            ("irFrames", vu(4800)),
                        ]),
                        vr(vec![
                            ("kernelId", vu(0xFFFF_02FF)),
                            ("returnBus", vu(1)),
                            ("state", vu(2)),
                            ("reserved", vu(0)),
                            ("wet", vf(1.0)),
                            ("irFrames", vu(1024)),
                        ]),
                        vr(vec![
                            ("kernelId", vu(0xFFFF_0201)),
                            ("returnBus", vu(2)),
                            ("state", vu(3)),
                            ("reserved", vu(0)),
                            ("wet", vf(0.5)),
                            ("irFrames", vu(9600)),
                        ]),
                        vr(vec![
                            ("kernelId", vu(0)),
                            ("returnBus", vu(3)),
                            ("state", vu(3)),
                            ("reserved", vu(0)),
                            ("wet", vf(0.0)),
                            ("irFrames", vu(0)),
                        ]),
                    ]),
                ),
            ],
            concat!(
                "1700", "1600", "00000000", "ffffffff", // head: ZONE_CONFIG, 22 words, voice 0, asap
                "04000000", // 12 slotCount 4
                "0000803e", // 16 sharedReturnGain 0.25
                "00000000", // 20 rampFrames 0
                "0002ffff", "0000", "01", "00", "00000040", "c0120000", // slot 0: 0xFFFF0200, bus 0, active, wet 2.0
                "ff02ffff", "0100", "02", "00", "0000803f", "00040000", // slot 1: 0xFFFF02FF, bus 1, release, wet 1.0
                "0102ffff", "0200", "03", "00", "0000003f", "80250000", // slot 2: 0xFFFF0201, bus 2, evict, wet 0.5
                "00000000", "0300", "03", "00", "00000000", "00000000", // slot 3: off, bus 3, evict, wet 0
            ),
        ),
        // LISTENER, 36 B = 9 words, asap: a ramped rotation, q = (0, s, 0, s) with s = 1/sqrt 2 (a 90-degree
        // turn about Y), over 480 frames, no snap.
        case(
            "LISTENER_ramped",
            Subject::Opcode("LISTENER"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("qx", vf(0.0)),
                ("qy", vf(std::f64::consts::FRAC_1_SQRT_2)),
                ("qz", vf(0.0)),
                ("qw", vf(std::f64::consts::FRAC_1_SQRT_2)),
                ("rampFrames", vu(480)),
                ("flags", vu(0)),
            ],
            concat!(
                "2000", "0900", "00000000", "ffffffff", // head: LISTENER, 9 words, voice 0, asap
                "00000000", // 12 qx 0.0
                "f304353f", // 16 qy 1/sqrt 2
                "00000000", // 20 qz 0.0
                "f304353f", // 24 qw 1/sqrt 2
                "e0010000", // 28 rampFrames 480
                "00000000", // 32 flags: no snap
            ),
        ),
        // LISTENER, 36 B = 9 words, asap: a camera cut (flags bit0 snap) to the identity rotation, no ramp.
        case(
            "LISTENER_snap",
            Subject::Opcode("LISTENER"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("qx", vf(0.0)),
                ("qy", vf(0.0)),
                ("qz", vf(0.0)),
                ("qw", vf(1.0)),
                ("rampFrames", vu(0)),
                ("flags", vu(1)),
            ],
            concat!(
                "2000", "0900", "00000000", "ffffffff", // head: LISTENER, 9 words, voice 0, asap
                "00000000", // 12 qx 0.0
                "00000000", // 16 qy 0.0
                "00000000", // 20 qz 0.0
                "0000803f", // 24 qw 1.0
                "00000000", // 28 rampFrames 0
                "01000000", // 32 flags: snap
            ),
        ),
        // PLAY, 56 B = 14 words, asap. Ambisonic (bit 7) with mixed | spatial: flags 0x98, panner 0.
        case(
            "PLAY_ambisonic_flag",
            Subject::Opcode("PLAY"),
            vec![
                ("voiceId", vu(4)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("clip", vu(3)),
                ("bus", vu(0)),
                ("flags", vu(0x98)),
                ("group", vu(0)),
                ("reserved", vu(0)),
                ("gain", vf(1.0)),
                ("pitch", vf(1.0)),
                ("dirX", vf(0.0)),
                ("dirY", vf(0.0)),
                ("dirZ", vf(0.0)),
                ("lpHz", vf(24000.0)),
                ("score", vf(0.75)),
                ("startOffsetFrames", vu(0)),
            ],
            concat!(
                "0100", "0e00", "04000000", "ffffffff", // head: PLAY, 14 words, voice 4, asap
                "03000000", // 12 clip 3
                "0000", // 16 bus 0
                "9800", // 18 flags: 0x80 ambisonic | 0x10 spatial | 0x08 mixed, panner 0
                "0000", // 20 group 0
                "0000", // 22 reserved
                "0000803f", // 24 gain 1.0
                "0000803f", // 28 pitch 1.0
                "00000000", "00000000", "00000000", // 32 dirX, dirY, dirZ (ignored for ambisonic)
                "0080bb46", // 44 lpHz 24000.0
                "0000403f", // 48 score 0.75
                "00000000", // 52 startOffsetFrames 0
            ),
        ),
        // PLAY, 56 B = 14 words, asap. Panner 2 (bed): flags 0x58 = 0x40 panner 2 | 0x10 spatial | 0x08 mixed,
        // on bus 2.
        case(
            "PLAY_bed_panner2",
            Subject::Opcode("PLAY"),
            vec![
                ("voiceId", vu(5)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("clip", vu(3)),
                ("bus", vu(2)),
                ("flags", vu(0x58)),
                ("group", vu(0)),
                ("reserved", vu(0)),
                ("gain", vf(1.0)),
                ("pitch", vf(1.0)),
                ("dirX", vf(0.0)),
                ("dirY", vf(0.0)),
                ("dirZ", vf(0.0)),
                ("lpHz", vf(24000.0)),
                ("score", vf(0.75)),
                ("startOffsetFrames", vu(0)),
            ],
            concat!(
                "0100", "0e00", "05000000", "ffffffff", // head: PLAY, 14 words, voice 5, asap
                "03000000", // 12 clip 3
                "0200", // 16 bus 2
                "5800", // 18 flags: panner 2 (bed) | spatial | mixed
                "0000", // 20 group 0
                "0000", // 22 reserved
                "0000803f", // 24 gain 1.0
                "0000803f", // 28 pitch 1.0
                "00000000", "00000000", "00000000", // 32 dirX, dirY, dirZ
                "0080bb46", // 44 lpHz 24000.0
                "0000403f", // 48 score 0.75
                "00000000", // 52 startOffsetFrames 0
            ),
        ),
        // SET_PARAMS, 56 B = 14 words, stamped at 256. Mask 0x41 (gain | flags), gain 0.5, panner 2 (bed).
        case(
            "SET_PARAMS_bed_panner2",
            Subject::Opcode("SET_PARAMS"),
            vec![
                ("voiceId", vu(5)),
                ("frameOffset", vu(256)),
                ("mask", vu(0x41)),
                ("gain", vf(0.5)),
                ("pitch", vf(0.0)),
                ("dirX", vf(0.0)),
                ("dirY", vf(0.0)),
                ("dirZ", vf(0.0)),
                ("lpHz", vf(0.0)),
                ("score", vf(0.0)),
                ("bus", vu(0)),
                ("rampFrames", vu(0)),
                ("flags", vu(0x40)),
            ],
            concat!(
                "0300", "0e00", "05000000", "00010000", // head: SET_PARAMS, 14 words, voice 5, frame 256
                "41000000", // 12 mask: gain | flags
                "0000003f", // 16 gain 0.5
                "00000000", // 20 pitch
                "00000000", "00000000", "00000000", // 24 dirX, dirY, dirZ
                "00000000", // 36 lpHz
                "00000000", // 40 score
                "00000000", // 44 bus
                "00000000", // 48 rampFrames
                "40000000", // 52 flags: panner 2 (bed)
            ),
        ),
        // STREAM_OPEN, 40 B body (56 B with the envelope), seq 43: 16 channels (a wide ring), 48 kHz,
        // 96000 frames, whole-stream loop, epoch 2, FuMa convention.
        case(
            "STREAM_OPEN_16ch_fuma",
            Subject::Kind("STREAM_OPEN"),
            vec![
                ("seq", vu(43)),
                ("streamId", vu(9)),
                ("channels", vu(16)),
                ("sampleRate", vf(48000.0)),
                ("totalFrames", vu(96000)),
                ("loopStart", vu(0)),
                ("loopEnd", vu(0)),
                ("flags", vu(0)),
                ("epoch", vu(2)),
                ("startFrame", vu(0)),
                ("convention", vu(1)),
            ],
            concat!(
                "3141594d", "0101", "0500", "2b000000", "28000000", // envelope: STREAM_OPEN, seq 43, bodyBytes 40
                "09000000", // streamId 9
                "10000000", // channels 16
                "00803b47", // sampleRate 48000.0
                "00770100", // totalFrames 96000
                "00000000", // loopStart
                "00000000", // loopEnd
                "00000000", // flags
                "02000000", // epoch 2
                "00000000", // startFrame
                "01000000", // convention FuMa
            ),
        ),
        // CLIP_BEGIN, 20 B body, seq 40: format 3, a prepared zone kernel (clip id 0xFFFF0200), 4800 frames
        // of IR, 2 channels, 48 kHz.
        case(
            "CLIP_BEGIN_zone_kernel_f3",
            Subject::Kind("CLIP_BEGIN"),
            vec![
                ("seq", vu(40)),
                ("clipId", vu(0xFFFF_0200)),
                ("frames", vu(4800)),
                ("channels", vu(2)),
                ("sampleRate", vf(48000.0)),
                ("format", vu(3)),
            ],
            concat!(
                "3141594d", "0101", "0200", "28000000", "14000000", // envelope: CLIP_BEGIN, seq 40, bodyBytes 20
                "0002ffff", // clipId 0xFFFF0200
                "c0120000", // frames 4800
                "02000000", // channels 2
                "00803b47", // sampleRate 48000.0
                "03000000", // format 3 (prepared zone kernel)
            ),
        ),
        // CLIP_BEGIN, 20 B body, seq 41: format 4, the MagLS filters (clip id 0xFFFF0100), 256 taps, 2 ears.
        case(
            "CLIP_BEGIN_magls_f4",
            Subject::Kind("CLIP_BEGIN"),
            vec![
                ("seq", vu(41)),
                ("clipId", vu(0xFFFF_0100)),
                ("frames", vu(256)),
                ("channels", vu(2)),
                ("sampleRate", vf(48000.0)),
                ("format", vu(4)),
            ],
            concat!(
                "3141594d", "0101", "0200", "29000000", "14000000", // envelope: CLIP_BEGIN, seq 41, bodyBytes 20
                "0001ffff", // clipId 0xFFFF0100
                "00010000", // frames 256
                "02000000", // channels 2
                "00803b47", // sampleRate 48000.0
                "04000000", // format 4 (MagLS filters)
            ),
        ),
        // CLIP_BEGIN, 20 B body, seq 42: format 5, zone IR PCM (clip id 0xFFFF02FF), 4800 frames, 2 channels.
        case(
            "CLIP_BEGIN_zone_ir_f5",
            Subject::Kind("CLIP_BEGIN"),
            vec![
                ("seq", vu(42)),
                ("clipId", vu(0xFFFF_02FF)),
                ("frames", vu(4800)),
                ("channels", vu(2)),
                ("sampleRate", vf(48000.0)),
                ("format", vu(5)),
            ],
            concat!(
                "3141594d", "0101", "0200", "2a000000", "14000000", // envelope: CLIP_BEGIN, seq 42, bodyBytes 20
                "ff02ffff", // clipId 0xFFFF02FF
                "c0120000", // frames 4800
                "02000000", // channels 2
                "00803b47", // sampleRate 48000.0
                "05000000", // format 5 (zone IR PCM)
            ),
        ),
        // ZoneKernelHeader, 32 B: the first CLIP_CHUNK of a format 3 clip. 4800 frames, 48 kHz, 12 head and
        // 5 tail partitions, flags 1 (source mono), reserved 0.
        case(
            "ZONE_KERNEL_HEADER",
            Subject::BlobHeader("ZoneKernelHeader"),
            vec![
                ("magic", vu(0x5249_594D)),
                ("version", vu(1)),
                ("irFrames", vu(4800)),
                ("sampleRate", vf(48000.0)),
                ("headParts", vu(12)),
                ("tailParts", vu(5)),
                ("flags", vu(1)),
                ("reserved", vu(0)),
            ],
            concat!(
                "4d594952", // magic 'MYIR'
                "01000000", // version 1
                "c0120000", // irFrames 4800
                "00803b47", // sampleRate 48000.0
                "0c000000", // headParts 12
                "05000000", // tailParts 5
                "01000000", // flags: sourceMono
                "00000000", // reserved
            ),
        ),
        // MaglsHeader, 32 B: the first CLIP_CHUNK of a format 4 clip. Order 3, 256 taps, 48 kHz.
        case(
            "MAGLS_HEADER",
            Subject::BlobHeader("MaglsHeader"),
            vec![
                ("magic", vu(0x4442_594D)),
                ("version", vu(1)),
                ("order", vu(3)),
                ("taps", vu(256)),
                ("sampleRate", vf(48000.0)),
                ("reserved", va(vec![vu(0), vu(0), vu(0)])),
            ],
            concat!(
                "4d594244", // magic 'MYBD'
                "01000000", // version 1
                "03000000", // order 3
                "00010000", // taps 256
                "00803b47", // sampleRate 48000.0
                "00000000", "00000000", "00000000", // reserved[3]
            ),
        ),
        // STATUS, 228 B total (envelope 16, header 16..144, sections 84), seq 45. The ADR 0162 header fields
        // are distinct and non-zero (`reserved` is zero by definition); flags 0x7F (bit 6 set); beds 2,
        // zones 4, zoneEvents 5. The M1 sections are empty. Counts are derived: bedsActive 2, zoneSlots 4,
        // zoneEventCount 5.
        case(
            "STATUS_adr0162_sections",
            Subject::Status,
            vec![
                ("seq", vu(45)),
                ("currentFrame", vf(1000.0)),
                ("dateMs", vf(1.5)),
                ("pingSeq", vu(7)),
                ("pingFrameLo", vu(4096)),
                ("underruns", vu(3)),
                ("lateCommands", vu(2)),
                ("workUnits", vu(1234)),
                ("workUnitsMax", vu(5678)),
                ("mixedVoices", vu(12)),
                ("liveVoices", vu(20)),
                ("flags", vu(0x7F)),
                ("mixedCap", vu(64)),
                ("loadPermille", vu(250)),
                ("traps", vu(9)),
                ("minSlackFrames", vi(-3)),
                ("underrunFrames", vu(512)),
                ("arenaUsedKB", vu(300)),
                ("arenaLargestFreeKB", vu(8192)),
                ("abiVersion", vu(1)),
                ("maxLatenessFrames", vu(77)),
                ("hrtfVoices", vu(4)),
                ("hrtfLoadFailure", vu(2)),
                ("bedVoices", vu(9)),
                ("fxVoices", vu(8)),
                ("ambisonicVoices", vu(6)),
                ("zonesActive", vu(3)),
                ("zonesRinging", vu(1)),
                ("bedsRefused", vu(7)),
                ("m3Shed", vu(11)),
                ("zoneUsedKB", vu(4096)),
                ("workBed", vu(1500)),
                ("workZones", vu(2500)),
                ("ended", va(vec![])),
                ("demoted", va(vec![])),
                ("starved", va(vec![])),
                ("playheads", va(vec![])),
                ("clipEvents", va(vec![])),
                ("streamEvents", va(vec![])),
                ("peaks", va(vec![])),
                (
                    "beds",
                    va(vec![
                        vr(vec![("bus", vu(1)), ("voices", vu(4)), ("work", vu(900))]),
                        vr(vec![("bus", vu(3)), ("voices", vu(2)), ("work", vu(300))]),
                    ]),
                ),
                (
                    "zones",
                    va(vec![
                        vr(vec![("kernelId", vu(0xFFFF_0200)), ("state", vu(3)), ("pad", vu(0)), ("quantaSinceInput", vu(2)), ("wetPeak", vf(0.5))]),
                        vr(vec![("kernelId", vu(0xFFFF_0201)), ("state", vu(4)), ("pad", vu(0)), ("quantaSinceInput", vu(17)), ("wetPeak", vf(0.25))]),
                        vr(vec![("kernelId", vu(0)), ("state", vu(0)), ("pad", vu(0)), ("quantaSinceInput", vu(0)), ("wetPeak", vf(0.0))]),
                        vr(vec![("kernelId", vu(0xFFFF_02FF)), ("state", vu(2)), ("pad", vu(0)), ("quantaSinceInput", vu(1)), ("wetPeak", vf(1.0))]),
                    ]),
                ),
                (
                    "zoneEvents",
                    va(vec![
                        vr(vec![("slot", vu(0)), ("code", vu(1))]),
                        vr(vec![("slot", vu(1)), ("code", vu(2))]),
                        vr(vec![("slot", vu(2)), ("code", vu(3))]),
                        vr(vec![("slot", vu(3)), ("code", vu(1))]),
                        vr(vec![("slot", vu(0)), ("code", vu(3))]),
                    ]),
                ),
            ],
            concat!(
                "3141594d", "0101", "0900", "2d000000", "d4000000", // envelope: STATUS, seq 45, bodyBytes 212
                "0000000000408f40", // 16 currentFrame 1000.0
                "000000000000f83f", // 24 dateMs 1.5
                "07000000", // 32 pingSeq 7
                "00100000", // 36 pingFrameLo 4096
                "03000000", // 40 underruns 3
                "02000000", // 44 lateCommands 2
                "d2040000", // 48 workUnits 1234
                "2e160000", // 52 workUnitsMax 5678
                "0c00", // 56 mixedVoices 12
                "1400", // 58 liveVoices 20
                "7f000000", // 60 flags: bits 0-6
                "0000", // 64 endedCount 0 (derived)
                "0000", // 66 demotedCount 0
                "0000", // 68 starvedCount 0
                "0000", // 70 playheadCount 0
                "0000", // 72 busCount 0
                "0000", // 74 clipEventCount 0
                "0000", // 76 streamEventCount 0
                "4000", // 78 mixedCap 64
                "fa00", // 80 loadPermille 250
                "0900", // 82 traps 9
                "fdffffff", // 84 minSlackFrames -3
                "00020000", // 88 underrunFrames 512
                "2c010000", // 92 arenaUsedKB 300
                "00200000", // 96 arenaLargestFreeKB 8192
                "01000000", // 100 abiVersion 1
                "4d000000", // 104 maxLatenessFrames 77
                "0400", // 108 hrtfVoices 4
                "0200", // 110 hrtfLoadFailure 2
                "0900", // 112 bedVoices 9
                "0200", // 114 bedsActive 2 (derived)
                "0800", // 116 fxVoices 8
                "0600", // 118 ambisonicVoices 6
                "0300", // 120 zonesActive 3
                "0100", // 122 zonesRinging 1
                "0500", // 124 zoneEventCount 5 (derived)
                "0700", // 126 bedsRefused 7
                "0400", // 128 zoneSlots 4 (derived)
                "0b00", // 130 m3Shed 11
                "00100000", // 132 zoneUsedKB 4096
                "dc050000", // 136 workBed 1500
                "c4090000", // 140 workZones 2500
                // sections: beds (2 x 8 B: u16 bus, u16 voices, u32 work), zones (4 x 12 B), zoneEvents (5 x 4 B)
                "0100", "0400", "84030000", // beds: bus 1, 4 voices, work 900
                "0300", "0200", "2c010000", // beds: bus 3, 2 voices, work 300
                "0002ffff", "03", "00", "0200", "0000003f", // zone 0: kernel 0xFFFF0200, state 3, pad, quanta 2, wet 0.5
                "0102ffff", "04", "00", "1100", "0000803e", // zone 1: kernel 0xFFFF0201, state 4, quanta 17, wet 0.25
                "00000000", "00", "00", "0000", "00000000", // zone 2: off
                "ff02ffff", "02", "00", "0100", "0000803f", // zone 3: kernel 0xFFFF02FF, state 2, quanta 1, wet 1.0
                "00010000", // zone event: slot 0, code 1 (refused kernel)
                "01020000", // zone event: slot 1, code 2 (refused slot)
                "02030000", // zone event: slot 2, code 3 (bad blob)
                "03010000", // zone event: slot 3, code 1
                "00030000", // zone event: slot 0, code 3
            ),
        ),
        // BATCH, 228 B total (212 B body: 16 header + 52 SET_VOICE_FX + 36 BED_CONFIG + 72 ZONE_CONFIG +
        // 36 LISTENER), seq 44, firstFrame 1000.0, flags 0. One record of each new opcode, copied from the
        // single-record vectors above.
        case(
            "BATCH_m3_opcodes",
            Subject::Batch("BATCH"),
            vec![
                ("seq", vu(44)),
                ("firstFrame", vf(1000.0)),
                ("flags", vu(0)),
                (
                    "records",
                    va(vec![
                        vr(vec![
                            ("op", vs("SET_VOICE_FX")),
                            ("voiceId", vu(7)),
                            ("frameOffset", vu(512)),
                            ("mask", vu(0x0F)),
                            ("rampFrames", vu(480)),
                            ("hpHz", vf(120.0)),
                            ("send", va(vec![vf(0.5), vf(0.25), vf(0.0), vf(1.0)])),
                            ("yaw", vf(std::f64::consts::FRAC_PI_2)),
                            ("auxLevel", vf(0.5)),
                            ("auxBus", vu(2)),
                            ("reserved", vu(0)),
                        ]),
                        vr(vec![
                            ("op", vs("BED_CONFIG")),
                            ("voiceId", vu(0)),
                            ("frameOffset", vu(0xFFFF_FFFF)),
                            ("bedSlot", va(vec![vu(0), vu(1), vu(0xFF), vu(2), vu(3)])),
                            ("hostBus", va(vec![vu(5), vu(0xFFFF), vu(6)])),
                        ]),
                        vr(vec![
                            ("op", vs("ZONE_CONFIG")),
                            ("voiceId", vu(0)),
                            ("frameOffset", vu(0xFFFF_FFFF)),
                            ("sharedReturnGain", vf(0.5)),
                            ("rampFrames", vu(480)),
                            (
                                "slots",
                                va(vec![
                                    vr(vec![
                                        ("kernelId", vu(0xFFFF_0200)),
                                        ("returnBus", vu(4)),
                                        ("state", vu(1)),
                                        ("reserved", vu(0)),
                                        ("wet", vf(1.0)),
                                        ("irFrames", vu(4800)),
                                    ]),
                                    vr(vec![
                                        ("kernelId", vu(0)),
                                        ("returnBus", vu(5)),
                                        ("state", vu(2)),
                                        ("reserved", vu(0)),
                                        ("wet", vf(0.5)),
                                        ("irFrames", vu(0)),
                                    ]),
                                    vr(vec![
                                        ("kernelId", vu(0xFFFF_0201)),
                                        ("returnBus", vu(6)),
                                        ("state", vu(3)),
                                        ("reserved", vu(0)),
                                        ("wet", vf(0.25)),
                                        ("irFrames", vu(9600)),
                                    ]),
                                ]),
                            ),
                        ]),
                        vr(vec![
                            ("op", vs("LISTENER")),
                            ("voiceId", vu(0)),
                            ("frameOffset", vu(0xFFFF_FFFF)),
                            ("qx", vf(0.0)),
                            ("qy", vf(std::f64::consts::FRAC_1_SQRT_2)),
                            ("qz", vf(0.0)),
                            ("qw", vf(std::f64::consts::FRAC_1_SQRT_2)),
                            ("rampFrames", vu(480)),
                            ("flags", vu(0)),
                        ]),
                    ]),
                ),
            ],
            concat!(
                "3141594d", "0101", "0100", "2c000000", "d4000000", // envelope: BATCH, seq 44, bodyBytes 212
                "0000000000408f40", // firstFrame 1000.0
                "04000000", // count 4
                "00000000", // flags 0
                // record 1: SET_VOICE_FX, stamped at 512
                "0a00", "0d00", "07000000", "00020000",
                "0f000000", "e0010000", "0000f042",
                "0000003f", "0000803e", "00000000", "0000803f",
                "db0fc93f", "0000003f", "0200", "0000",
                // record 2: BED_CONFIG, asap
                "1600", "0900", "00000000", "ffffffff",
                "05000000", "03000000", "0001ff0203000000", "0500ffff06000000",
                // record 3: ZONE_CONFIG, asap
                "1700", "1200", "00000000", "ffffffff",
                "03000000", "0000003f", "e0010000",
                "0002ffff", "0400", "01", "00", "0000803f", "c0120000",
                "00000000", "0500", "02", "00", "0000003f", "00000000",
                "0102ffff", "0600", "03", "00", "0000803e", "80250000",
                // record 4: LISTENER, asap
                "2000", "0900", "00000000", "ffffffff",
                "00000000", "f304353f", "00000000", "f304353f", "e0010000", "00000000",
            ),
        ),
    ]
}
