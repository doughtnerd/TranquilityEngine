//! A0.2-L4: byte vectors, one or more per record of ADR 0157 section 4, with the expected bytes derived
//! by hand from the spec tables (see `crate::vector` for the value conventions per subject).
//!
//! Coverage required: the envelope; every kind; every opcode (LISTENER excepted: it is never sent);
//! PLAY with the `panner` bits at 0, 1 and 2; SET_PARAMS with a panner change; asap and stamped
//! `frameOffset`; a BATCH and a REPLAY (first chunk with RESET, last chunk flag); BUS_CONFIG with two
//! buses and mixed effects; the HRIR header; a STATUS message with every header field set to a
//! distinct value, every flag bit, and every section non-empty.
//!
//! Envelopes carry version 1.1 (`0101`, ADR 0162) except `ENVELOPE_v1_0`, which states 1.0. ADR 0162's
//! records have their own vectors in `spatial_cases.rs` (leaf L-A1a), chained after these.
//!
//! Hex is written by hand: little-endian, f32 as `f32::to_bits`, f64 as `f64::to_bits`. Envelope
//! `seq` values: 5 ENVELOPE, 9..=17 kinds, 20..=22 batch kinds, 30 STATUS. Each record is commented
//! with its field offsets where the hex is not obvious.

use crate::model::Value;
use crate::vector::{Subject, VectorCase};

fn vu(x: u64) -> Value {
    Value::U(x)
}

fn vf(x: f64) -> Value {
    Value::F(x)
}

fn vi(x: i64) -> Value {
    Value::I(x)
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

/// The 16-byte envelope prefix shared by the kind cases: magic, version 1.0, kind, seq, bodyBytes.
pub fn cases() -> Vec<VectorCase> {
    vec![
        // Envelope: magic 0x4D594131 ("1AYM" in LE bytes), version 0x0100 (1.0), kind 1, seq 5, bodyBytes 32.
        case(
            "ENVELOPE_v1_0",
            Subject::Envelope,
            vec![
                ("magic", vu(0x4D59_4131)),
                ("version", vu(0x0100)),
                ("kind", vu(1)),
                ("seq", vu(5)),
                ("bodyBytes", vu(32)),
            ],
            concat!("3141594d", "0001", "0100", "05000000", "20000000"),
        ),
        // Kind 2 CLIP_BEGIN: clipId 7, frames 1000, channels 2, sampleRate 48000.0 (0x473B8000), format 0.
        case(
            "CLIP_BEGIN_f32_stereo",
            Subject::Kind("CLIP_BEGIN"),
            vec![
                ("seq", vu(9)),
                ("clipId", vu(7)),
                ("frames", vu(1000)),
                ("channels", vu(2)),
                ("sampleRate", vf(48000.0)),
                ("format", vu(0)),
            ],
            concat!(
                "3141594d", "0201", "0200", "09000000", "14000000", // envelope, bodyBytes 20
                "07000000", // clipId
                "e8030000", // frames 1000
                "02000000", // channels
                "00803b47", // sampleRate 48000.0
                "00000000", // format 0 (f32)
            ),
        ),
        // Kind 3 CLIP_CHUNK, f32 clip: clipId 7, frameOffset 0, frames 2, reserved 0, 2 frames x 2 ch f32.
        // Samples: 0.5, -0.5, 1.0, -0.25.
        case(
            "CLIP_CHUNK_f32",
            Subject::Kind("CLIP_CHUNK"),
            vec![
                ("seq", vu(10)),
                ("clipId", vu(7)),
                ("frameOffset", vu(0)),
                ("frames", vu(2)),
                ("reserved", vu(0)),
                (
                    "payload",
                    va(vec![
                        vu(0x00), vu(0x00), vu(0x00), vu(0x3F),
                        vu(0x00), vu(0x00), vu(0x00), vu(0xBF),
                        vu(0x00), vu(0x00), vu(0x80), vu(0x3F),
                        vu(0x00), vu(0x00), vu(0x80), vu(0xBE),
                    ]),
                ),
            ],
            concat!(
                "3141594d", "0201", "0300", "0a000000", "20000000", // envelope, bodyBytes 32
                "07000000", // clipId
                "00000000", // frameOffset
                "02000000", // frames
                "00000000", // reserved
                "0000003f", // 0.5
                "000000bf", // -0.5
                "0000803f", // 1.0
                "000080be", // -0.25
            ),
        ),
        // Kind 4 CLIP_UNLOAD: clipId 7.
        case(
            "CLIP_UNLOAD",
            Subject::Kind("CLIP_UNLOAD"),
            vec![("seq", vu(11)), ("clipId", vu(7))],
            concat!("3141594d", "0201", "0400", "0b000000", "04000000", "07000000"),
        ),
        // Kind 5 STREAM_OPEN: streamId 3, channels 2, sampleRate 44100.0 (0x472C4400), totalFrames unknown,
        // loop 0..0 (whole stream), flags loop, epoch 4, startFrame 0, convention 0 (AmbiX).
        case(
            "STREAM_OPEN_loop",
            Subject::Kind("STREAM_OPEN"),
            vec![
                ("seq", vu(12)),
                ("streamId", vu(3)),
                ("channels", vu(2)),
                ("sampleRate", vf(44100.0)),
                ("totalFrames", vu(0xFFFF_FFFF)),
                ("loopStart", vu(0)),
                ("loopEnd", vu(0)),
                ("flags", vu(1)),
                ("epoch", vu(4)),
                ("startFrame", vu(0)),
                ("convention", vu(0)),
            ],
            concat!(
                "3141594d", "0201", "0500", "0c000000", "28000000", // envelope, bodyBytes 40
                "03000000", // streamId
                "02000000", // channels
                "00442c47", // sampleRate 44100.0
                "ffffffff", // totalFrames unknown
                "00000000", // loopStart
                "00000000", // loopEnd
                "01000000", // flags: bit0 loop
                "04000000", // epoch
                "00000000", // startFrame
                "00000000", // convention AmbiX
            ),
        ),
        // Kind 6 STREAM_CHUNK: streamId 3, chunkSeq 1, frames 2, flags last|wrapped (3), epoch 4, 16 bytes.
        case(
            "STREAM_CHUNK_last_wrapped",
            Subject::Kind("STREAM_CHUNK"),
            vec![
                ("seq", vu(13)),
                ("streamId", vu(3)),
                ("chunkSeq", vu(1)),
                ("frames", vu(2)),
                ("flags", vu(3)),
                ("epoch", vu(4)),
                (
                    "payload",
                    va(vec![
                        vu(0x00), vu(0x00), vu(0x00), vu(0x3F),
                        vu(0x00), vu(0x00), vu(0x00), vu(0xBF),
                        vu(0x00), vu(0x00), vu(0x80), vu(0x3F),
                        vu(0x00), vu(0x00), vu(0x80), vu(0xBE),
                    ]),
                ),
            ],
            concat!(
                "3141594d", "0201", "0600", "0d000000", "24000000", // envelope, bodyBytes 36
                "03000000", // streamId
                "01000000", // chunkSeq
                "02000000", // frames
                "03000000", // flags: bit0 last, bit1 wrapped
                "04000000", // epoch
                "0000003f", // 0.5
                "000000bf", // -0.5
                "0000803f", // 1.0
                "000080be", // -0.25
            ),
        ),
        // Kind 7 STREAM_CLOSE: streamId 3.
        case(
            "STREAM_CLOSE",
            Subject::Kind("STREAM_CLOSE"),
            vec![("seq", vu(14)), ("streamId", vu(3))],
            concat!("3141594d", "0201", "0700", "0e000000", "04000000", "03000000"),
        ),
        // Kind 8 TIME_PING: pingSeq 42.
        case(
            "TIME_PING",
            Subject::Kind("TIME_PING"),
            vec![("seq", vu(15)), ("pingSeq", vu(42))],
            concat!("3141594d", "0201", "0800", "0f000000", "04000000", "2a000000"),
        ),
        // Kind 10 RECYCLE: no body.
        case(
            "RECYCLE",
            Subject::Kind("RECYCLE"),
            vec![("seq", vu(16))],
            concat!("3141594d", "0201", "0a00", "10000000", "00000000"),
        ),
        // Kind 11 STREAM_CREDIT: streamId 3, epoch 4, consumedFrames 512, returnedBuffers 2.
        case(
            "STREAM_CREDIT",
            Subject::Kind("STREAM_CREDIT"),
            vec![
                ("seq", vu(17)),
                ("streamId", vu(3)),
                ("epoch", vu(4)),
                ("consumedFrames", vu(512)),
                ("returnedBuffers", vu(2)),
            ],
            concat!(
                "3141594d", "0201", "0b00", "11000000", "10000000", // envelope, bodyBytes 16
                "03000000", // streamId
                "04000000", // epoch
                "00020000", // consumedFrames 512
                "02000000", // returnedBuffers
            ),
        ),
        // HRIR header (format 2 first chunk, 16 bytes): elevations 2, azimuths 3, irLength 4, rate 48000.0.
        case(
            "HRIR_HEADER",
            Subject::HrirHeader,
            vec![
                ("elevations", vu(2)),
                ("azimuths", vu(3)),
                ("irLength", vu(4)),
                ("rate", vf(48000.0)),
            ],
            concat!("02000000", "03000000", "04000000", "00803b47"),
        ),
        // Opcode records (head included). Head: opcode u16, words u16, voiceId u32, frameOffset u32.

        // PLAY, 56 B = 14 words. Panner 0 (equal-power, bits 5-6 = 00), not looped; flags mixed|spatial = 0x18.
        // Asap frameOffset.
        case(
            "PLAY_clip_equal_power_asap",
            Subject::Opcode("PLAY"),
            vec![
                ("voiceId", vu(1)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("clip", vu(3)),
                ("bus", vu(0)),
                ("flags", vu(0x18)),
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
                "0100", "0e00", "01000000", "ffffffff", // head: PLAY, 14 words, voice 1, asap
                "03000000", // clip 3
                "0000", // bus 0
                "1800", // flags: mixed (bit3) | spatial (bit4), panner 0 (bits 5-6 clear)
                "0000", // group 0
                "0000", // reserved
                "0000803f", // gain 1.0
                "0000803f", // pitch 1.0
                "00000000", // dirX
                "00000000", // dirY
                "00000000", // dirZ
                "0080bb46", // lpHz 24000.0
                "0000403f", // score 0.75
                "00000000", // startOffsetFrames
            ),
        ),
        // PLAY, panner 1 (HRTF): flags loop (bit0) | mixed | spatial | panner 1 (bit5) = 0x39. Stamped frameOffset 1000.
        case(
            "PLAY_loop_hrtf_spatial",
            Subject::Opcode("PLAY"),
            vec![
                ("voiceId", vu(7)),
                ("frameOffset", vu(1000)),
                ("clip", vu(3)),
                ("bus", vu(1)),
                ("flags", vu(0x39)),
                ("group", vu(2)),
                ("reserved", vu(0)),
                ("gain", vf(0.5)),
                ("pitch", vf(1.0)),
                ("dirX", vf(0.0)),
                ("dirY", vf(0.0)),
                ("dirZ", vf(-1.0)),
                ("lpHz", vf(24000.0)),
                ("score", vf(0.75)),
                ("startOffsetFrames", vu(0)),
            ],
            concat!(
                "0100", "0e00", "07000000", "e8030000", // head: PLAY, 14 words, voice 7, frame 1000
                "03000000", // clip 3
                "0100", // bus 1
                "3900", // flags: 0x01 loop, 0x08 mixed, 0x10 spatial, 0x20 panner 1 (HRTF)
                "0200", // group 2
                "0000", // reserved
                "0000003f", // gain 0.5
                "0000803f", // pitch 1.0
                "00000000", // dirX
                "00000000", // dirY
                "000080bf", // dirZ -1.0
                "0080bb46", // lpHz 24000.0
                "0000403f", // score 0.75
                "00000000", // startOffsetFrames
            ),
        ),
        // PLAY, panner 2 (reserved): flags stream (bit1) | wantsPlayhead (bit2) | mixed | spatial | panner 2
        // (bit6, value 2 << 5 = 0x40) = 0x5E. Asap; startOffsetFrames 256.
        case(
            "PLAY_stream_panner2_reserved",
            Subject::Opcode("PLAY"),
            vec![
                ("voiceId", vu(9)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("clip", vu(4)),
                ("bus", vu(2)),
                ("flags", vu(0x5E)),
                ("group", vu(0)),
                ("reserved", vu(0)),
                ("gain", vf(0.5)),
                ("pitch", vf(1.0)),
                ("dirX", vf(1.0)),
                ("dirY", vf(0.0)),
                ("dirZ", vf(0.0)),
                ("lpHz", vf(24000.0)),
                ("score", vf(0.75)),
                ("startOffsetFrames", vu(256)),
            ],
            concat!(
                "0100", "0e00", "09000000", "ffffffff", // head: PLAY, 14 words, voice 9, asap
                "04000000", // clip 4
                "0200", // bus 2
                "5e00", // flags: 0x02 stream, 0x04 wantsPlayhead, 0x08 mixed, 0x10 spatial, 0x40 panner 2
                "0000", // group 0
                "0000", // reserved
                "0000003f", // gain 0.5
                "0000803f", // pitch 1.0
                "0000803f", // dirX 1.0
                "00000000", // dirY
                "00000000", // dirZ
                "0080bb46", // lpHz 24000.0
                "0000403f", // score 0.75
                "00010000", // startOffsetFrames 256
            ),
        ),
        // STOP, 24 B = 6 words: fadeFrames 480, reason 1, shape 0 (the word is appended since envelope 1.2; ADR 0166). Asap.
        case(
            "STOP_fade_asap",
            Subject::Opcode("STOP"),
            vec![
                ("voiceId", vu(7)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("fadeFrames", vu(480)),
                ("reason", vu(1)),
            ],
            concat!("0200", "0600", "07000000", "ffffffff", "e0010000", "01000000", "00000000"),
        ),
        // SET_PARAMS, 60 B = 15 words (shape word 0 appended, envelope 1.2), panner change: mask gain (bit0) | dir (bit2) | flags (bit6) = 0x45;
        // flags 0x20 = panner 1 (HRTF). dirX -1.0 with rampFrames 480. Stamped frameOffset 2048.
        case(
            "SET_PARAMS_panner_change",
            Subject::Opcode("SET_PARAMS"),
            vec![
                ("voiceId", vu(7)),
                ("frameOffset", vu(2048)),
                ("mask", vu(0x45)),
                ("gain", vf(0.25)),
                ("pitch", vf(0.0)),
                ("dirX", vf(-1.0)),
                ("dirY", vf(0.0)),
                ("dirZ", vf(0.0)),
                ("lpHz", vf(0.0)),
                ("score", vf(0.0)),
                ("bus", vu(0)),
                ("rampFrames", vu(480)),
                ("flags", vu(0x20)),
            ],
            concat!(
                "0300", "0f00", "07000000", "00080000", // head: SET_PARAMS, 15 words, voice 7, frame 2048
                "45000000", // mask: gain | dir | flags
                "0000803e", // gain 0.25
                "00000000", // pitch
                "000080bf", // dirX -1.0
                "00000000", // dirY
                "00000000", // dirZ
                "00000000", // lpHz
                "00000000", // score
                "00000000", // bus
                "e0010000", // rampFrames 480
                "20000000", // flags: panner 1
                "00000000", // shape: linear, phase 0
            ),
        ),
        // FADE, 28 B = 7 words: target 0.0, frames 960, flags stopAtEnd, shape 0 (appended, envelope 1.2). Asap.
        case(
            "FADE_stop_at_end",
            Subject::Opcode("FADE"),
            vec![
                ("voiceId", vu(7)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("target", vf(0.0)),
                ("frames", vu(960)),
                ("flags", vu(1)),
            ],
            concat!("0400", "0700", "07000000", "ffffffff", "00000000", "c0030000", "01000000", "00000000"),
        ),
        // SET_MIXED, 36 B = 9 words: mixed 1, gain 1.0, dir (0, 0, -1), lpHz 24000. Asap.
        case(
            "SET_MIXED",
            Subject::Opcode("SET_MIXED"),
            vec![
                ("voiceId", vu(7)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("mixed", vu(1)),
                ("gain", vf(1.0)),
                ("dirX", vf(0.0)),
                ("dirY", vf(0.0)),
                ("dirZ", vf(-1.0)),
                ("lpHz", vf(24000.0)),
            ],
            concat!(
                "0500", "0900", "07000000", "ffffffff", // head: SET_MIXED, 9 words, voice 7, asap
                "01000000", // mixed
                "0000803f", // gain 1.0
                "00000000", // dirX
                "00000000", // dirY
                "000080bf", // dirZ -1.0
                "0080bb46", // lpHz 24000.0
            ),
        ),
        // SET_PAUSED, 16 B = 4 words: paused 1. Asap.
        case(
            "SET_PAUSED",
            Subject::Opcode("SET_PAUSED"),
            vec![("voiceId", vu(0)), ("frameOffset", vu(0xFFFF_FFFF)), ("paused", vu(1))],
            concat!("0600", "0400", "00000000", "ffffffff", "01000000"),
        ),
        // SEEK, 20 B = 5 words: clipFrame 4800, epoch 3. Asap.
        case(
            "SEEK_stream",
            Subject::Opcode("SEEK"),
            vec![
                ("voiceId", vu(5)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("clipFrame", vu(4800)),
                ("epoch", vu(3)),
            ],
            concat!("0700", "0500", "05000000", "ffffffff", "c0120000", "03000000"),
        ),
        // SET_LOOP (ADR 0158), 24 B = 6 words: voice 0x00020003, stamped at offset 64; loop 4800..9600,
        // looping.
        case(
            "SET_LOOP_region",
            Subject::Opcode("SET_LOOP"),
            vec![
                ("voiceId", vu(0x0002_0003)),
                ("frameOffset", vu(64)),
                ("loopStartFrame", vu(4800)),
                ("loopEndFrame", vu(9600)),
                ("flags", vu(1)),
            ],
            concat!("0800", "0600", "03000200", "40000000", "c0120000", "80250000", "01000000"),
        ),
        // AUTOMATE (ADR 0158), variable length: 32 B = 8 words. Voice 0x00010005, asap; two bindings:
        // global slot 3 (0x8003) through curve 7 to volume, local slot 1 through curve 8 to lowpass.
        case(
            "AUTOMATE_two_bindings",
            Subject::Opcode("AUTOMATE"),
            vec![
                ("voiceId", vu(0x0001_0005)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                (
                    "bindings",
                    va(vec![
                        vr(vec![("param", vu(0x8003)), ("curve", vu(7)), ("target", vu(0))]),
                        vr(vec![("param", vu(1)), ("curve", vu(8)), ("target", vu(2))]),
                    ]),
                ),
            ],
            concat!(
                "0900", "0800", "05000100", "ffffffff", // head: AUTOMATE, 8 words, voice, asap
                "02000000", // bindingCount 2
                "0380", "0700", "00000000", // param 0x8003, curve 7, target 0 (volume)
                "0100", "0800", "02000000", // param 1, curve 8, target 2 (lowpass)
            ),
        ),
        // CURVES (ADR 0158), variable length: 64 B = 16 words. Curves 10 and 11: curve 10 has keys
        // (0, 0, linear) and (1, 1, smooth); curve 11 one key (0.5, 0.25, step).
        case(
            "CURVES_two_curves",
            Subject::Opcode("CURVES"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("firstCurve", vu(10)),
                (
                    "curves",
                    va(vec![
                        vr(vec![
                            ("reserved", vu(0)),
                            (
                                "keys",
                                va(vec![
                                    vr(vec![("x", vf(0.0)), ("y", vf(0.0)), ("interp", vu(0))]),
                                    vr(vec![("x", vf(1.0)), ("y", vf(1.0)), ("interp", vu(2))]),
                                ]),
                            ),
                        ]),
                        vr(vec![("reserved", vu(0)), ("keys", va(vec![vr(vec![("x", vf(0.5)), ("y", vf(0.25)), ("interp", vu(1))])]))]),
                    ]),
                ),
            ],
            concat!(
                "1300", "1000", "00000000", "ffffffff", // head: CURVES, 16 words, 0, asap
                "0a000000", "02000000", // firstCurve 10, curveCount 2
                "0200", "0000", // curve 10: keyCount 2, reserved
                "00000000", "00000000", "00000000", // key (0.0, 0.0, linear)
                "0000803f", "0000803f", "02000000", // key (1.0, 1.0, smooth)
                "0100", "0000", // curve 11: keyCount 1, reserved
                "0000003f", "0000803e", "01000000", // key (0.5, 0.25, step)
            ),
        ),
        // PARAM (ADR 0158), 24 B = 6 words: group 3, slot 1, value 0.5, seek 2.0 per second. Asap.
        case(
            "PARAM_local_seek",
            Subject::Opcode("PARAM"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("group", vu(3)),
                ("slot", vu(1)),
                ("value", vf(0.5)),
                ("seekPerSecond", vf(2.0)),
            ],
            concat!("1400", "0600", "00000000", "ffffffff", "0300", "0100", "0000003f", "00000040"),
        ),
        // BUS_AUTOMATE (ADR 0158), variable length: 24 B = 6 words. Bus 2; one binding: global slot 0
        // (0x8000) through curve 4 to lowpass.
        case(
            "BUS_AUTOMATE_one_binding",
            Subject::Opcode("BUS_AUTOMATE"),
            vec![
                ("voiceId", vu(2)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("bindings", va(vec![vr(vec![("param", vu(0x8000)), ("curve", vu(4)), ("target", vu(2))])])),
            ],
            concat!("1500", "0600", "02000000", "ffffffff", "01000000", "0080", "0400", "02000000"),
        ),
        // BUS_CONFIG, variable length: 120 B = 30 words. Two buses. Bus 0 (root, parent 0xFFFF) has a
        // lowpass (2000 Hz, q 1.0) and a reverb send (0.5); bus 1 (parent 0) has a compressor
        // (threshold -12, knee 6, ratio 4, attack 1, release 2 with the unused p = 0).
        case(
            "BUS_CONFIG_two_buses_effects",
            Subject::Opcode("BUS_CONFIG"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                (
                    "buses",
                    va(vec![
                        vr(vec![
                            ("parent", vu(0xFFFF)),
                            (
                                "effects",
                                va(vec![
                                    vr(vec![
                                        ("type", vu(0)),
                                        ("p", va(vec![vf(2000.0), vf(1.0), vf(0.0), vf(0.0), vf(0.0), vf(0.0), vf(0.0)])),
                                    ]),
                                    vr(vec![
                                        ("type", vu(3)),
                                        ("p", va(vec![vf(0.5), vf(0.0), vf(0.0), vf(0.0), vf(0.0), vf(0.0), vf(0.0)])),
                                    ]),
                                ]),
                            ),
                        ]),
                        vr(vec![
                            ("parent", vu(0)),
                            (
                                "effects",
                                va(vec![vr(vec![
                                    ("type", vu(2)),
                                    ("p", va(vec![vf(-12.0), vf(6.0), vf(4.0), vf(1.0), vf(2.0), vf(0.0), vf(0.0)])),
                                ])]),
                            ),
                        ]),
                    ]),
                ),
            ],
            concat!(
                "1000", "1e00", "00000000", "ffffffff", // head: BUS_CONFIG, 30 words, bus 0, frame asap
                "02000000", // busCount 2
                // bus 0: parent 0xFFFF, effectCount 2
                "ffff", "0200",
                // effect 0: lowpass; p = 2000.0, 1.0, 0 x5
                "00000000", "0000fa44", "0000803f", "00000000", "00000000", "00000000", "00000000", "00000000",
                // effect 1: reverb send; p = 0.5, 0 x6
                "03000000", "0000003f", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000",
                // bus 1: parent 0, effectCount 1
                "0000", "0100",
                // effect 0: compressor; p = -12.0, 6.0, 4.0, 1.0, 2.0, 0, 0
                "02000000", "000040c1", "0000c040", "00008040", "0000803f", "00000040", "00000000", "00000000",
            ),
        ),
        // BUS_MIX, variable length: 36 B = 9 words. Ramp 480; bus 0 gain 1.0 lpHz off (24000),
        // bus 1 gain 0.5 lpHz 1200.0.
        case(
            "BUS_MIX_two_buses",
            Subject::Opcode("BUS_MIX"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("rampFrames", vu(480)),
                (
                    "buses",
                    va(vec![
                        vr(vec![("gain", vf(1.0)), ("lpHz", vf(24000.0))]),
                        vr(vec![("gain", vf(0.5)), ("lpHz", vf(1200.0))]),
                    ]),
                ),
            ],
            concat!(
                "1100", "0900", "00000000", "ffffffff", // head: BUS_MIX, 9 words, bus 0, asap
                "02000000", // busCount 2
                "e0010000", // rampFrames 480
                "0000803f", "0080bb46", // bus 0: gain 1.0, lpHz 24000.0
                "0000003f", "00009644", // bus 1: gain 0.5, lpHz 1200.0
            ),
        ),
        // MASTER, 24 B = 6 words: volume 0.8, muted 0, ramp 960. Asap.
        case(
            "MASTER",
            Subject::Opcode("MASTER"),
            vec![
                ("voiceId", vu(0)),
                ("frameOffset", vu(0xFFFF_FFFF)),
                ("volume", vf(0.8)),
                ("muted", vu(0)),
                ("rampFrames", vu(960)),
            ],
            concat!("1200", "0600", "00000000", "ffffffff", "cdcc4c3f", "00000000", "c0030000"),
        ),
        // RESET, 16 B = 4 words: keepClips 1. Asap.
        case(
            "RESET",
            Subject::Opcode("RESET"),
            vec![("voiceId", vu(0)), ("frameOffset", vu(0xFFFF_FFFF)), ("keepClips", vu(1))],
            concat!("3000", "0400", "00000000", "ffffffff", "01000000"),
        ),
        // BATCH, 96 B body (16 header + 56 PLAY + 24 STOP). Flags 0. firstFrame 1000.0 (f64 0x408F400000000000).
        // Record 1: PLAY asap (the same payload as PLAY_loop_hrtf_spatial). Record 2: STOP stamped at 1000.
        case(
            "BATCH_play_stop",
            Subject::Batch("BATCH"),
            vec![
                ("seq", vu(20)),
                ("firstFrame", vf(1000.0)),
                ("flags", vu(0)),
                (
                    "records",
                    va(vec![
                        vr(vec![
                            ("op", vs("PLAY")),
                            ("voiceId", vu(7)),
                            ("frameOffset", vu(0xFFFF_FFFF)),
                            ("clip", vu(3)),
                            ("bus", vu(1)),
                            ("flags", vu(0x39)),
                            ("group", vu(2)),
                            ("reserved", vu(0)),
                            ("gain", vf(0.5)),
                            ("pitch", vf(1.0)),
                            ("dirX", vf(0.0)),
                            ("dirY", vf(0.0)),
                            ("dirZ", vf(-1.0)),
                            ("lpHz", vf(24000.0)),
                            ("score", vf(0.75)),
                            ("startOffsetFrames", vu(0)),
                        ]),
                        vr(vec![
                            ("op", vs("STOP")),
                            ("voiceId", vu(7)),
                            ("frameOffset", vu(1000)),
                            ("fadeFrames", vu(480)),
                            ("reason", vu(1)),
                        ]),
                    ]),
                ),
            ],
            concat!(
                "3141594d", "0201", "0100", "14000000", "60000000", // envelope: BATCH, seq 20, bodyBytes 96
                "0000000000408f40", // firstFrame 1000.0
                "02000000", // count 2
                "00000000", // flags 0
                // record 1: PLAY asap
                "0100", "0e00", "07000000", "ffffffff",
                "03000000", "0100", "3900", "0200", "0000",
                "0000003f", "0000803f", "00000000", "00000000", "000080bf", "0080bb46", "0000403f", "00000000",
                // record 2: STOP at frame 1000
                "0200", "0600", "07000000", "e8030000",
                "e0010000", "01000000", "00000000",
            ),
        ),
        // REPLAY, first chunk: flags firstChunk (bit1); begins with RESET (keepClips 0), then MASTER.
        // Body 56 B = 16 header + 16 RESET + 24 MASTER. firstFrame 0.0.
        case(
            "REPLAY_first_chunk_reset",
            Subject::Batch("REPLAY"),
            vec![
                ("seq", vu(21)),
                ("firstFrame", vf(0.0)),
                ("flags", vu(2)),
                (
                    "records",
                    va(vec![
                        vr(vec![
                            ("op", vs("RESET")),
                            ("voiceId", vu(0)),
                            ("frameOffset", vu(0xFFFF_FFFF)),
                            ("keepClips", vu(0)),
                        ]),
                        vr(vec![
                            ("op", vs("MASTER")),
                            ("voiceId", vu(0)),
                            ("frameOffset", vu(0xFFFF_FFFF)),
                            ("volume", vf(0.8)),
                            ("muted", vu(0)),
                            ("rampFrames", vu(960)),
                        ]),
                    ]),
                ),
            ],
            concat!(
                "3141594d", "0201", "0c00", "15000000", "38000000", // envelope: REPLAY, seq 21, bodyBytes 56
                "0000000000000000", // firstFrame 0.0
                "02000000", // count 2
                "02000000", // flags: bit1 first chunk
                // record 1: RESET
                "3000", "0400", "00000000", "ffffffff", "00000000",
                // record 2: MASTER
                "1200", "0600", "00000000", "ffffffff", "cdcc4c3f", "00000000", "c0030000",
            ),
        ),
        // REPLAY, last chunk: flags lastChunk (bit2); one SET_PAUSED. Body 32 B. firstFrame 1000.0.
        case(
            "REPLAY_last_chunk",
            Subject::Batch("REPLAY"),
            vec![
                ("seq", vu(22)),
                ("firstFrame", vf(1000.0)),
                ("flags", vu(4)),
                (
                    "records",
                    va(vec![vr(vec![
                        ("op", vs("SET_PAUSED")),
                        ("voiceId", vu(0)),
                        ("frameOffset", vu(0xFFFF_FFFF)),
                        ("paused", vu(0)),
                    ])]),
                ),
            ],
            concat!(
                "3141594d", "0201", "0c00", "16000000", "20000000", // envelope: REPLAY, seq 22, bodyBytes 32
                "0000000000408f40", // firstFrame 1000.0
                "01000000", // count 1
                "04000000", // flags: bit2 last chunk
                "0600", "0400", "00000000", "ffffffff", "00000000", // SET_PAUSED 0
            ),
        ),
        // STATUS, 184 B total: header 112 B (envelope counted) and sections 72 B. Every header field
        // non-zero; flags 0x3F sets all six bits; every section non-empty. Section counts are derived:
        // ended 2, demoted 1, starved 3, playheads 2, clipEvents 1, streamEvents 1, peaks 2 (busCount 2).
        case(
            "STATUS_all_fields",
            Subject::Status,
            vec![
                ("seq", vu(30)),
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
                ("flags", vu(0x3F)),
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
                // ADR 0162 header fields, zero here (their own golden STATUS is in spatial_cases.rs).
                ("bedVoices", vu(0)),
                ("fxVoices", vu(0)),
                ("ambisonicVoices", vu(0)),
                ("zonesActive", vu(0)),
                ("zonesRinging", vu(0)),
                ("bedsRefused", vu(0)),
                ("m3Shed", vu(0)),
                ("zoneUsedKB", vu(0)),
                ("workBed", vu(0)),
                ("workZones", vu(0)),
                // ADR 0166 M4 header fields, distinct and non-zero except the section counts and `reserved`
                // (the musicRings and groupStarts sections follow with W1).
                ("musicRingCount", vu(0)),
                ("groupStartCount", vu(0)),
                ("musicRingsOpen", vu(5)),
                ("streamStartsLate", vu(6)),
                ("groupsLate", vu(7)),
                ("groupsHeld", vu(8)),
                ("groupsAbandoned", vu(9)),
                ("curvePoolFull", vu(10)),
                ("maxSlipFrames", vu(1111)),
                ("splitQuanta", vu(222)),
                ("voiceSplits", vu(333)),
                ("ended", va(vec![vu(11), vu(12)])),
                ("demoted", va(vec![vu(13)])),
                ("starved", va(vec![vu(14), vu(15), vu(16)])),
                (
                    "playheads",
                    va(vec![
                        vr(vec![("id", vu(3)), ("clipFrame", vu(1000))]),
                        vr(vec![("id", vu(4)), ("clipFrame", vu(2000))]),
                    ]),
                ),
                ("clipEvents", va(vec![vr(vec![("clipId", vu(7)), ("code", vu(1))])])),
                ("streamEvents", va(vec![vr(vec![("id", vu(3)), ("code", vu(2))])])),
                (
                    "peaks",
                    va(vec![
                        vr(vec![("l", vf(0.25)), ("r", vf(0.5))]),
                        vr(vec![("l", vf(1.0)), ("r", vf(0.75))]),
                    ]),
                ),
                ("beds", va(vec![])),
                ("zones", va(vec![])),
                ("zoneEvents", va(vec![])),
            ],
            concat!(
                "3141594d", "0201", "0900", "1e000000", "e8000000", // envelope: STATUS, seq 30, bodyBytes 232
                "0000000000408f40", // 16 currentFrame f64 1000.0
                "000000000000f83f", // 24 dateMs f64 1.5
                "07000000", // 32 pingSeq
                "00100000", // 36 pingFrameLo 4096
                "03000000", // 40 underruns
                "02000000", // 44 lateCommands
                "d2040000", // 48 workUnits 1234
                "2e160000", // 52 workUnitsMax 5678
                "0c00", // 56 mixedVoices 12
                "1400", // 58 liveVoices 20
                "3f000000", // 60 flags: bits 0-5
                "0200", // 64 endedCount 2
                "0100", // 66 demotedCount 1
                "0300", // 68 starvedCount 3
                "0200", // 70 playheadCount 2
                "0200", // 72 busCount 2
                "0100", // 74 clipEventCount 1
                "0100", // 76 streamEventCount 1
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
                "0000000000000000", "0000000000000000", // 112..127 bed/zone counts, all 0
                "0000000000000000", "0000000000000000", // 128..143 zoneSlots, m3Shed, zoneUsedKB, workBed, workZones
                "00000000", // 144 musicRingCount 0, 146 groupStartCount 0 (derived)
                "0500", "0600", "0700", "0800", "0900", "0a00", // 148 musicRingsOpen 5, streamStartsLate 6, groupsLate 7, groupsHeld 8, groupsAbandoned 9, curvePoolFull 10
                "57040000", // 160 maxSlipFrames 1111
                "de000000", // 164 splitQuanta 222
                "4d010000", // 168 voiceSplits 333
                "00000000", // 172 reserved
                // sections, in order
                "0b000000", "0c000000", // ended: 11, 12
                "0d000000", // demoted: 13
                "0e000000", "0f000000", "10000000", // starved: 14, 15, 16
                "03000000", "e8030000", "04000000", "d0070000", // playheads: (3, 1000), (4, 2000)
                "07000000", "01000000", // clipEvents: (7, 1)
                "03000000", "02000000", // streamEvents: (3, 2)
                "0000803e", "0000003f", "0000803f", "0000403f", // peaks: (0.25, 0.5), (1.0, 0.75)
            ),
        ),
    ]
    .into_iter()
    .chain(crate::spatial_cases::spatial_cases())
    .collect()
}
