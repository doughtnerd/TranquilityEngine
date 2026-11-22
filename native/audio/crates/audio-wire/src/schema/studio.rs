//! The Audio Studio wire (ADRs 0328, 0332): time parameters (ABI 4.2), sample loop programs (LOOPS,
//! ABI 4.3) and the records later Studio milestones add to the voice. `batch.rs` lists the opcodes
//! in id order; `schema.rs` merges the constants below into its output. Byte offsets in the comments
//! count from the record's first
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
    c!("VOICE_LOOPS_MAX", 4, "loops a voice's LOOPS program keeps (ADR 0328); extra ones are ignored"),
    c!("LOOP_DIRECTION_MASK", 0x3, "LOOPS item flags bits 0-1: 0 forward, 1 ping-pong, 2 backward"),
    c!("LOOP_ACTIVE_SHIFT", 2, "LOOPS item flags bits 2-3: 0 always, 1 held (until the key-off), 2 parameter"),
    c!("LOOP_EXIT_SHIFT", 4, "LOOPS item flags bits 4-5: 0 finish, 1 jump (through crossfadeFrames), 2 crossfade (exitFadeFrames)"),
    c!("LOOP_REENTER", 0x40, "LOOPS item flags bit 6: re-enter (clear: ignore)"),
    c!("LOOP_BELOW", 0x80, "LOOPS item flags bit 7: a parameter activation holds while the parameter is below threshold (clear: above)"),
];

/// One loop of a LOOPS program: 28 B.
const LOOPS_ITEMS: Repeat = Repeat {
    name: "loops",
    count_field: "loopCount",
    item: &[
        Field::new("startFrame", Ty::U32).doc("clip frames"),
        Field::new("endFrame", Ty::U32).doc("clip frames; equal to startFrame: a hold point"),
        Field::new("crossfadeFrames", Ty::U32).doc("the seam's equal-power crossfade (and a hold point's fades), clip frames"),
        Field::new("exitFadeFrames", Ty::U32).doc("exit crossfade's length, clip frames"),
        Field::new("count", Ty::U16).doc("0 endless; else passes in all, the first included"),
        Field::new("flags", Ty::U16).doc("LOOP_* direction, activation, exit, re-entry and comparison"),
        Field::new("param", Ty::U16).doc("activation parameter: a binding param (PARAM_GLOBAL | slot, or a local slot)"),
        Field::new("reserved", Ty::U16),
        Field::new("threshold", Ty::F32).doc("activation threshold"),
    ],
    then: None,
    max: 0,
};

/// 0x0B LOOPS (ADR 0328): replaces a clip voice's loop program, at most `VOICE_LOOPS_MAX` loops
/// (count 0 clears it); applies on arrival, like AUTOMATE, so main sends it right after the PLAY. A
/// SET_LOOP with `looping` clear is the program's key-off (held loops let go, stamped); one with
/// `looping` set replaces the program with its single region. Stream and ambisonic voices ignore it.
pub const LOOPS: Opcode = Opcode {
    id: 0x0B,
    name: "LOOPS",
    payload: Body::with_tail(&[Field::new("loopCount", Ty::U32)], Tail::Repeat(&LOOPS_ITEMS)),
    total_bytes: None,
    sent: true,
    doc: "replace a clip voice's loop program (ADR 0328); count 0 clears it",
};

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
