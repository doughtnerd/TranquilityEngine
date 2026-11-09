//! A0.2-L1: the envelope and the kinds (ADR 0157 section 4.1). Transcribe the spec tables into the
//! `const` tables below, using the `crate::model` types. Fill the tables marked A0.2-L1 and the
//! ignored tests.
//!
//! Layout rules: fields without `.at()` follow each other in order; the generator checks natural
//! alignment and that sizes add up. Kind ids: STREAM_OPEN is 5 (the spec table lost its number; the
//! HRIR row is a layout note for CLIP_CHUNK of a `format = 2` clip, modelled by `HRIR_HEADER`).

use crate::model::*;

const STREAM_OPEN_FLAGS: &[Bits] = &[Bits::bit("loop", 0, "1 = loop between loop_start and loop_end")];

const STREAM_CHUNK_FLAGS: &[Bits] = &[
    Bits::bit("last", 0, "1 = last chunk of the stream"),
    Bits::bit("wrapped", 1, "1 = the stream looped before this chunk"),
];

const CLIP_ID: Field =
    Field::new("clip_id", Ty::U32).doc("Clip id; for format 2 (HRIR) 0xFFFF0000..=0xFFFF00FF are reserved.");
const CHANNELS: Field = Field::new("channels", Ty::U32).doc("Interleaved channel count.");
const SAMPLE_RATE: Field = Field::new("sample_rate", Ty::F32).doc("Sample rate in Hz.");
const STREAM_ID: Field = Field::new("stream_id", Ty::U32).doc("Stream id, named in stream messages.");
const EPOCH: Field =
    Field::new("epoch", Ty::U32).doc("Stream epoch; a restart bumps it, so older-epoch messages are stale.");

/// Envelope, 16 bytes: `u32 magic; u16 version; u16 kind; u32 seq; u32 bodyBytes`, at offsets 0, 4,
/// 6, 8, 12.
pub const ENVELOPE: &[Field] = &[
    Field::new("magic", Ty::U32).at(0).doc("Always 0x4D594131 (`MYA1`)."),
    Field::new("version", Ty::U16)
        .at(4)
        .doc("Protocol version: high byte major, low byte minor (1.0 is 0x0100)."),
    Field::new("kind", Ty::U16).at(6).doc("Message kind, one of `KINDS` (1..=12)."),
    Field::new("seq", Ty::U32).at(8).doc("Per-sender sequence number; wraps at 2^32."),
    Field::new("body_bytes", Ty::U32).at(12).doc("Bytes of body after the 16-byte envelope."),
];

/// Every kind 1..=12 with its body (fixed fields and tail), in id order.
pub const KINDS: &[Kind] = &[
    Kind {
        id: 1,
        name: "BATCH",
        dir: Dir::MainToWorklet,
        body: Body::with_tail(super::batch::BATCH_HEADER, Tail::Records),
        doc: "Command batch of opcode records (section 4.2).",
    },
    Kind {
        id: 2,
        name: "CLIP_BEGIN",
        dir: Dir::MainOrWorkerToWorklet,
        body: Body::fixed(&[
            CLIP_ID,
            Field::new("frames", Ty::U32).doc("Total sample frames in the clip."),
            CHANNELS,
            SAMPLE_RATE,
            Field::new("format", Ty::U32)
                .doc("0 f32, 1 i16, 2 HRIR (int16 impulse responses already at the context rate)."),
        ]),
        doc: "Starts a clip load (main in M1a, worker in M1b).",
    },
    Kind {
        id: 3,
        name: "CLIP_CHUNK",
        dir: Dir::MainOrWorkerToWorklet,
        body: Body::with_tail(
            &[
                CLIP_ID,
                Field::new("frame_offset", Ty::U32).doc("First frame of this chunk within the clip."),
                Field::new("frames", Ty::U32).doc("Sample frames in this chunk."),
                Field::new("reserved", Ty::U32).doc("Reserved; 0."),
            ],
            Tail::Bytes,
        ),
        doc: "Clip samples: `frames * channels` interleaved samples. A format 2 clip's first chunk \
              begins with `HRIR_HEADER`.",
    },
    Kind {
        id: 4,
        name: "CLIP_UNLOAD",
        dir: Dir::MainToWorklet,
        body: Body::fixed(&[CLIP_ID]),
        doc: "Unloads a clip.",
    },
    Kind {
        id: 5,
        name: "STREAM_OPEN",
        dir: Dir::WorkerToWorklet,
        body: Body::fixed(&[
            STREAM_ID,
            CHANNELS,
            SAMPLE_RATE,
            Field::new("total_frames", Ty::U32).doc("Total sample frames; 0xFFFFFFFF if unknown."),
            Field::new("loop_start", Ty::U32).doc("Loop start frame."),
            Field::new("loop_end", Ty::U32).doc("Loop end frame; 0 means the whole stream."),
            Field::new("flags", Ty::U32).flags(STREAM_OPEN_FLAGS).doc("Flag bits, see `flags`."),
            EPOCH,
            Field::new("start_frame", Ty::U32).doc("Frame the stream starts playing from."),
        ]),
        doc: "Opens a worker-fed stream.",
    },
    Kind {
        id: 6,
        name: "STREAM_CHUNK",
        dir: Dir::WorkerToWorklet,
        body: Body::with_tail(
            &[
                STREAM_ID,
                Field::new("chunk_seq", Ty::U32).doc("Chunk sequence number within the stream."),
                Field::new("frames", Ty::U32).doc("Sample frames in this chunk."),
                Field::new("flags", Ty::U32).flags(STREAM_CHUNK_FLAGS).doc("Flag bits, see `flags`."),
                EPOCH,
            ],
            Tail::Bytes,
        ),
        doc: "Stream samples: `frames * channels` interleaved f32.",
    },
    Kind {
        id: 7,
        name: "STREAM_CLOSE",
        dir: Dir::MainOrWorkerToWorklet,
        body: Body::fixed(&[STREAM_ID]),
        doc: "Closes a stream.",
    },
    Kind {
        id: 8,
        name: "TIME_PING",
        dir: Dir::MainToWorklet,
        body: Body::fixed(&[Field::new("ping_seq", Ty::U32).doc("Ping sequence number, chosen by main.")]),
        doc: "Time ping from main.",
    },
    Kind {
        id: 9,
        name: "STATUS",
        dir: Dir::WorkletToMain,
        body: Body::EMPTY,
        doc: "Status report; its layout comes from `status.rs`.",
    },
    Kind {
        id: 10,
        name: "RECYCLE",
        dir: Dir::MainToWorklet,
        body: Body::EMPTY,
        doc: "Recycle request from main; no body.",
    },
    Kind {
        id: 11,
        name: "STREAM_CREDIT",
        dir: Dir::WorkletToWorker,
        body: Body::fixed(&[
            STREAM_ID,
            EPOCH,
            Field::new("consumed_frames", Ty::U32).doc("Sample frames the worklet has consumed."),
            Field::new("returned_buffers", Ty::U32).doc("Chunk buffers returned to the worker."),
        ]),
        doc: "Flow-control credit from the worklet to the worker.",
    },
    Kind {
        id: 12,
        name: "REPLAY",
        dir: Dir::MainToWorklet,
        body: Body::with_tail(super::batch::BATCH_HEADER, Tail::Records),
        doc: "Replays a recorded batch of opcode records (section 4.2).",
    },
];

/// First-chunk header of a `format = 2` HRIR clip: `u32 elevations; u32 azimuths; u32 irLength;
/// f32 rate;`.
pub const HRIR_HEADER: &[Field] = &[
    Field::new("elevations", Ty::U32).doc("Elevation count of the HRIR grid."),
    Field::new("azimuths", Ty::U32).doc("Azimuth count per elevation."),
    Field::new("ir_length", Ty::U32).doc("Frames per impulse response."),
    Field::new("rate", Ty::F32).doc("Sample rate of the impulse responses in Hz."),
];

#[cfg(test)]
mod tests {
    fn fixed_bytes(fields: &[crate::model::Field]) -> u32 {
        fields.iter().map(|f| f.bytes()).sum()
    }

    #[test]
    fn envelope_is_16_bytes_at_the_spec_offsets() {
        let offsets: Vec<Option<u32>> = super::ENVELOPE.iter().map(|f| f.offset).collect();
        assert_eq!(offsets, vec![Some(0), Some(4), Some(6), Some(8), Some(12)]);
        assert_eq!(fixed_bytes(super::ENVELOPE), 16);
    }

    #[test]
    fn kinds_are_1_to_12_with_unique_names() {
        let ids: Vec<u16> = super::KINDS.iter().map(|k| k.id).collect();
        assert_eq!(ids, (1..=12).collect::<Vec<u16>>());
        let names: std::collections::HashSet<&str> = super::KINDS.iter().map(|k| k.name).collect();
        assert_eq!(names.len(), 12);
    }

    #[test]
    fn bodies_match_the_spec_layouts() {
        let kind = |id: u16| super::KINDS.iter().find(|k| k.id == id).expect("kind present");
        let fixed = |id: u16| fixed_bytes(kind(id).body.fields);

        assert_eq!(fixed(2), 20, "CLIP_BEGIN");
        assert!(matches!(kind(2).body.tail, crate::model::Tail::None));
        assert_eq!(fixed(3), 16, "CLIP_CHUNK header");
        assert!(matches!(kind(3).body.tail, crate::model::Tail::Bytes));
        assert_eq!(fixed(4), 4, "CLIP_UNLOAD");
        assert_eq!(fixed(5), 36, "STREAM_OPEN");
        assert_eq!(fixed(6), 20, "STREAM_CHUNK header");
        assert!(matches!(kind(6).body.tail, crate::model::Tail::Bytes));
        assert_eq!(fixed(7), 4, "STREAM_CLOSE");
        assert_eq!(fixed(8), 4, "TIME_PING");
        assert_eq!(fixed(11), 16, "STREAM_CREDIT");

        for id in [9u16, 10] {
            assert!(kind(id).body.fields.is_empty(), "kind {id} has no body");
            assert!(matches!(kind(id).body.tail, crate::model::Tail::None));
        }
        // BATCH and REPLAY share the batch header; its size is checked in batch.rs (A0.2-L2).
        for id in [1u16, 12] {
            assert!(matches!(kind(id).body.tail, crate::model::Tail::Records));
            let names = kind(id).body.fields.iter().map(|f| f.name);
            assert!(names.eq(super::super::batch::BATCH_HEADER.iter().map(|f| f.name)));
        }
    }

    #[test]
    fn hrir_header_is_16_bytes() {
        assert_eq!(super::HRIR_HEADER.len(), 4);
        assert_eq!(fixed_bytes(super::HRIR_HEADER), 16);
    }
}
