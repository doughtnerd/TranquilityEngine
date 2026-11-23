//! The sound generators' wire (ADR 0346 §3, ABI 5.1): a generator voice is a PLAY of a reserved clip id
//! (`GEN_CLIP_ID_FIRST` + kind; never uploaded, no clip memory), its parameters come in GEN (0x21), and AUTOMATE binds a
//! curve to one of them (target kind `AUTO_TARGET_GEN`). `batch.rs` lists the opcode in id order; `schema.rs` merges the
//! constants below into its output. Byte offsets in the comments count from the record's first byte, head included.

use crate::model::*;

macro_rules! c {
    ($name:literal, $value:expr, $doc:literal) => {
        Const { name: $name, value: $value as u64, doc: $doc }
    };
}

/// The generator constants. The parameter order of each kind is the generator catalogue's
/// (`src/engine/audio/generators/catalogue.ts`), which is the order GEN's mask and values and a target's index use.
pub const CONSTANTS: &[Const] = &[
    c!("GEN_CLIP_ID_FIRST", 0xFFFF_0300u32, "reserved clip ids of generator voices: GEN_CLIP_ID_FIRST + kind (ADR 0346; never uploaded)"),
    c!("GEN_CLIP_ID_LAST", 0xFFFF_03FFu32, "the reserved generator range's last id"),
    c!("GEN_KIND_OSCILLATOR", 1, "generator kind: oscillator (10 parameters)"),
    c!("GEN_KIND_SYNTH", 2, "generator kind: two-oscillator synth (25 parameters)"),
    c!("GEN_KIND_BLIP", 3, "generator kind: sfxr blip in sfxr's units (24 parameters)"),
    c!("GEN_KIND_SILENCE", 4, "generator kind: silence (2 parameters), always virtual"),
    c!("GEN_PARAMS_MAX", 32, "parameters a generator kind has at most (GEN mask bits 0-31)"),
    c!("AUTO_TARGET_GEN", 5, "voice binding target kind (AUTOMATE): a generator parameter, its index in bits 8-15, AUTO_TARGET_LOG for a log2 curve; the curve's value replaces it, glided over the quantum (ABI 5.1; buses read kind 5 as AUTO_TARGET_FX)"),
    c!("AUTO_TARGET_GEN_PARAM_SHIFT", 8, "binding target bits 8-15 of an AUTO_TARGET_GEN binding: the parameter's index"),
];

/// GEN's values: one `f32` per set bit of the mask, in bit order (ABI 5.1).
const GEN_VALUES: &[PaddedArray] = &[PaddedArray {
    name: "values",
    count_field: "valueCount",
    ty: Ty::F32,
    max: 32,
    doc: "the masked parameters' values in bit order, each in its own units (Hz, ms, dB, %, sfxr's units, a choice's index); clamped by the core",
}];

/// 0x21 GEN, 28 + 4n B (ADR 0346 §3, ABI 5.1): generator voice `voiceId`'s parameters. Bit i of `mask` set: parameter i
/// takes the next value (`valueCount` is popcount(mask); a short list leaves the rest of the mask unset). Applies on
/// arrival, like AUTOMATE and LOOPS (its values don't fit a stamped record), so main sends it right after the PLAY, in
/// the same batch, with every parameter; then with a partial mask when a value changes. A voice that hasn't started
/// takes the values at once; a started one glides its smooth parameters over `rampFrames` (frequencies in log2) and
/// steps the rest. A GEN for a voice that isn't a generator, or a stale id, is ignored; a generator PLAY with no GEN
/// plays its kind's defaults.
pub const GEN: Opcode = Opcode {
    id: 0x21,
    name: "GEN",
    payload: Body::with_tail(
        &[
            Field::new("mask", Ty::U32).doc("bit i: parameter i is in `values`"),                               // 12
            Field::new("seed", Ty::U32).doc("the noise generator's seed (xorshift32, also the synth LFO's sample-and-hold); 0 keeps the voice's seed"), // 16
            Field::new("rampFrames", Ty::U32).doc("glide of the changed smooth parameters; 0 steps"),               // 20
            Field::new("valueCount", Ty::U32).doc("popcount(mask), at most GEN_PARAMS_MAX"),                        // 24
        ],
        Tail::Arrays(GEN_VALUES),
    ),
    total_bytes: None,
    sent: true,
    doc: "a generator voice's parameters and noise seed (ADR 0346, ABI 5.1); applies on arrival",
};
