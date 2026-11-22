//! The Audio Studio wire (ADRs 0328, 0332): time parameters (ABI 4.2) and the records later Studio
//! milestones add to the voice. `batch.rs` lists the opcodes in id order; `schema.rs` merges the
//! constants below into its output. Byte offsets in the comments count from the record's first
//! byte, head included (12 B).

use crate::model::*;

macro_rules! c {
    ($name:literal, $value:expr, $doc:literal) => {
        Const { name: $name, value: $value as u64, doc: $doc }
    };
}

/// The Studio constants. A binding's `param` (AUTOMATE, BUS_AUTOMATE) is one of: bit 15 set, a global
/// slot in the low bits; bit 15 clear and bit 14 set, a time parameter (`TIME_*` in the low two bits,
/// ADR 0332); both clear, a local slot of the voice's group.
pub const CONSTANTS: &[Const] = &[
    c!("PARAM_GLOBAL", 0x8000, "binding param bit 15: a global slot (low 15 bits)"),
    c!("PARAM_TIME", 0x4000, "binding param bit 14 (bit 15 clear): a time parameter, TIME_* in bits 0-1 (ADR 0332; voices only)"),
    c!("PARAM_TIME_MASK", 0x3, "binding param bits 0-1 of a time parameter: which"),
    c!("TIME_VOICE", 0, "voiceTime: seconds since the voice started (its start frame; paused time counts)"),
    c!("TIME_CLIP", 1, "clipTime: the voice's playhead in the clip, in seconds of the clip"),
    c!("TIME_SEQUENCE", 2, "sequenceTime: the voice's group's sequence clock (TIME re-anchors it)"),
];

/// 0x1D TIME, 24 B (ADR 0332): re-anchors a group's clock at the record's frame (stamped like a
/// voice record; asap anchors at the next quantum's first frame). From there the clock reads
/// `value + rate × (frame − anchor) / sampleRate`; rate 0 parks it (a hold point), 1 runs it in
/// real time. `voiceId` is unused (0).
pub const TIME: Opcode = Opcode {
    id: 0x1D,
    name: "TIME",
    payload: Body::fixed(&[
        Field::new("group", Ty::U16).doc("0 the global clock, else the instance group 1..=1024"), // 12
        Field::new("which", Ty::U16).doc("the clock: TIME_SEQUENCE (2); any other value is ignored (reserved)"), // 14
        Field::new("value", Ty::F32).doc("seconds at the anchor"),          // 16
        Field::new("rate", Ty::F32).doc("seconds per second from the anchor; 0 parks"), // 20
    ]),
    total_bytes: Some(24),
    sent: true,
    doc: "re-anchor a group's sequence clock (ADR 0332); stamped",
};
