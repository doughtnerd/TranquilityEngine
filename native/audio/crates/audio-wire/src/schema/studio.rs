//! The Audio Studio wire (ADRs 0342, 0345, 0346): time parameters (ABI 4.2), sample loop programs
//! (LOOPS, ABI 4.3), instance submixes (SUBMIX, ABI 4.5) and the records later Studio milestones add. `batch.rs` lists the opcodes
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
/// ADR 0346); both clear, a local slot of the voice's group.
pub const CONSTANTS: &[Const] = &[
    c!("PARAM_GLOBAL", 0x8000, "binding param bit 15: a global slot (low 15 bits)"),
    c!("PARAM_TIME", 0x4000, "binding param bit 14 (bit 15 clear): a time parameter, TIME_* in bits 0-1 (ADR 0346; voices only)"),
    c!("PARAM_TIME_MASK", 0x3, "binding param bits 0-1 of a time parameter: which"),
    c!("TIME_VOICE", 0, "voiceTime: seconds since the voice started (its start frame; paused time counts)"),
    c!("TIME_CLIP", 1, "clipTime: the voice's playhead in the clip, in seconds of the clip"),
    c!("TIME_SEQUENCE", 2, "sequenceTime: the voice's group's sequence clock (TIME re-anchors it)"),
    c!("VOICE_LOOPS_MAX", 4, "loops a voice's LOOPS program keeps (ADR 0342); extra ones are ignored"),
    c!("LOOP_DIRECTION_MASK", 0x3, "LOOPS item flags bits 0-1: 0 forward, 1 ping-pong, 2 backward"),
    c!("LOOP_ACTIVE_SHIFT", 2, "LOOPS item flags bits 2-3: 0 always, 1 held (until the key-off), 2 parameter"),
    c!("LOOP_EXIT_SHIFT", 4, "LOOPS item flags bits 4-5: 0 finish, 1 jump (through crossfadeFrames), 2 crossfade (exitFadeFrames)"),
    c!("LOOP_REENTER", 0x40, "LOOPS item flags bit 6: re-enter (clear: ignore)"),
    c!("LOOP_BELOW", 0x80, "LOOPS item flags bit 7: a parameter activation holds while the parameter is below threshold (clear: above)"),
    c!("SUBMIXES_MAX", 64, "instance submix slots the core lays out (ADR 0345); SUBMIX voiceId 0..63"),
    c!("SUBMIX_EFFECTS_MAX", 8, "effects a submix's chain keeps; extra ones are ignored"),
    c!("SUBMIX_FX_LOWPASS", 1, "SUBMIX effect type: the catalogue's lowpass; p cutoff Hz, resonance 0..1, drive %"),
    c!("SUBMIX_FX_HIGHPASS", 2, "SUBMIX effect type: the catalogue's highpass; p cutoff Hz, resonance 0..1, drive %"),
    c!("SUBMIX_FX_COMPRESSOR", 3, "SUBMIX effect type: the catalogue's compressor; p threshold dB, ratio, attack ms, release ms, makeup dB, knee dB"),
    c!("SUBMIX_FX_EQ", 4, "effect type: the catalogue's eq; p low, mid, high dB (shelf 250 Hz, peak 1 kHz Q 0.7, shelf 4 kHz; ABI 4.6)"),
    c!("SUBMIX_FX_BANDPASS", 5, "effect type: the catalogue's bandpass; p centre Hz, resonance 0..1 (Q 0.5..10), drive %"),
    c!("SUBMIX_FX_SATURATION", 6, "effect type: the catalogue's saturation; p amount %"),
    c!("SUBMIX_FX_DISTORTION", 7, "effect type: the catalogue's distortion; p drive 0..1, mix %"),
    c!("SUBMIX_FX_BITCRUSH", 8, "effect type: the catalogue's bitcrush; p bits, downsample, mix %"),
    c!("SUBMIX_FX_CHORUS", 9, "effect type: the catalogue's chorus; p rate Hz, depth %, mix %"),
    c!("SUBMIX_FX_DELAY", 10, "effect type: the catalogue's delay; p time ms, feedback %, mix %"),
    c!("SUBMIX_FX_REVERB", 11, "effect type: the catalogue's reverb (an FDN); p size 0..1, decay s, mix %"),
    c!("SUBMIX_FX_FORMANT", 12, "effect type: the catalogue's formantShift; p shift st"),
    c!("SUBMIX_FX_PITCH", 13, "effect type: the catalogue's pitchShift (granular); p semitones, cents"),
    c!("SUBMIX_FX_LIMITER", 14, "effect type: the catalogue's limiter (no look-ahead); p ceiling dB, release ms"),
    c!("SUBMIX_FX_SIDECHAIN", 15, "effect type: the catalogue's sidechainCompressor (buses only); p threshold dB, ratio, release ms, key bus slot"),
    c!("SUBMIX_FX_GAIN", 16, "effect type: the catalogue's gain; p gain dB"),
    c!("BUS_FX_CATALOGUE", 16, "a bus effect type at or above this is a catalogue effect: SUBMIX_FX_* plus 16, p the catalogue's parameters in its order (ABI 4.6)"),
    c!("FX_MEMORY_SECONDS", 20, "the effect memory region holds this many seconds of stereo audio at the context rate (delay lines, reverbs; ABI 4.6)"),
    c!("SUBMIX_FX_ON", 1, "SUBMIX effect flags bit 0: the effect runs (clear: bypassed, its state kept)"),
    c!("AUTO_TARGET_KIND_MASK", 0xFF, "binding target bits 0-7: the kind (0 volume .. 4 pan, AUTO_TARGET_FX, AUTO_TARGET_SEND)"),
    c!("AUTO_TARGET_FX", 5, "binding target kind: an effect parameter of the bus's (BUS_AUTOMATE) or submix's (SUBMIX_AUTOMATE) chain, replaced by the curve's value (ABI 4.8)"),
    c!("AUTO_TARGET_SEND", 6, "binding target kind: a bus's send, the curve's dB added to its level (BUS_AUTOMATE only; ABI 4.8)"),
    c!("AUTO_TARGET_SLOT_SHIFT", 8, "binding target bits 8-15: the effect's slot in the chain (FX), or the receiving bus slot of the send (SEND)"),
    c!("AUTO_TARGET_PARAM_SHIFT", 16, "binding target bits 16-23: the catalogue parameter's index (FX)"),
    c!("AUTO_TARGET_LOG", 0x0100_0000u32, "binding target bit 24: the curve's value is log2 of the parameter (frequencies interpolate in log scale); the core takes 2^value (FX)"),
    c!("BUS_AUTOMATE_MAX_BINDINGS", 16, "bindings a bus or a submix keeps (BUS_AUTOMATE, SUBMIX_AUTOMATE; ABI 4.8, 8 before)"),
    c!("BUS_FX_HELD_SHIFT", 16, "bus effect type bits 16-31: bit i set holds catalogue parameter i at its sent value (a snapshot override); automation leaves it (ABI 4.8; 16 bits from 5.0)"),
    c!("BUS_FX_TYPE_MASK", 0xFFFF, "bus effect type bits 0-15: the type"),
    c!("FX_PARAMS", 16, "parameters an effect record carries (BUS_CONFIG, BUS_SLOT, SUBMIX; ABI 5.0, ADR 0352; 7 and 8 before)"),
    c!("FX_PLUGIN_BASE", 0x100, "an effect kind at FX_PLUGIN_BASE + e is registered plugin effect e (0..FX_PLUGINS_MAX-1), run through the myco_ext import (ABI 5.0, ADR 0352); on a bus, BUS_FX_CATALOGUE + FX_PLUGIN_BASE + e"),
    c!("FX_PLUGINS_MAX", 256, "plugin effects the host may register (e is 0..255)"),
    c!("FX_PLUGIN_FUEL_PER_FRAME", 5000, "each chain level's (the buses', the instance submixes') shared fuel per frame and quantum, across every plugin instance (0358 section 3): a call whose budget doesn't fit what is left passes dry"),
    c!("FX_PLUGIN_FLAG_PARAMS", 1, "myco_ext.process flags bit 0: a parameter moved this block (or the block is the first)"),
    c!("FX_PLUGIN_FLAG_SILENT", 2, "myco_ext.process flags bit 1: the input block is silent"),
    c!("FX_PLUGIN_FLAG_RESET", 4, "myco_ext.process flags bit 2: the first block since the slot was configured or RESET: the glue resets the instance first"),
    c!("FX_STARVED_SUBMIX", 0x8000, "STATUS fxStarvedOwner bit 15: the owner is a submix slot (low bits), else a bus slot"),
    c!("FX_STARVED_NONE", 0xFFFF, "STATUS fxStarvedOwner: no effect has starved"),
    c!("SUBMIX_PARENT_NONE", 0, "SUBMIX parent: the slot feeds its bus (else parent - 1 is the slot it feeds; ABI 4.9)"),
    c!("SUBMIX_DEPTH_MAX", 8, "submix levels a chain of parents keeps (ABI 4.9); a slot deeper than this feeds its bus"),
    c!("FADE_SHAPE_EQUAL_POWER", 0, "LOOPS shapes nibble: equal power (sin in, cos out; the default, ABI 4.9)"),
    c!("FADE_SHAPE_LINEAR", 1, "LOOPS shapes nibble: linear"),
    c!("FADE_SHAPE_S_CURVE", 2, "LOOPS shapes nibble: s-curve u^2(3 - 2u)"),
    c!("FADE_SHAPE_INV_S_CURVE", 3, "LOOPS shapes nibble: inverse s-curve 2u - u^2(3 - 2u)"),
    c!("FADE_SHAPE_LOG1", 4, "LOOPS shapes nibble: log 1 - (1 - u)^1.41"),
    c!("FADE_SHAPE_LOG2", 5, "LOOPS shapes nibble: log 1 - (1 - u)^2"),
    c!("FADE_SHAPE_LOG3", 6, "LOOPS shapes nibble: log 1 - (1 - u)^3"),
    c!("FADE_SHAPE_EXP1", 7, "LOOPS shapes nibble: exp u^1.41"),
    c!("FADE_SHAPE_EXP2", 8, "LOOPS shapes nibble: exp u^2"),
    c!("FADE_SHAPE_EXP3", 9, "LOOPS shapes nibble: exp u^3"),
    c!("LOOP_SEAM_SHAPE_SHIFT", 0, "LOOPS item shapes bits 0-3: the seam crossfade's FADE_SHAPE_* (ABI 4.9)"),
    c!("LOOP_EXIT_SHAPE_SHIFT", 4, "LOOPS item shapes bits 4-7: the exit crossfade's FADE_SHAPE_* (ABI 4.9)"),
    c!("AMP_ENV_ON", 1, "AMP_ENVELOPE flags bit 0: the envelope applies (clear: the voice's envelope is removed; ABI 6.1)"),
    c!("AMP_ENV_KEY_OFF_NONE", 0xFFFF_FFFFu32, "AMP_ENVELOPE keyOffFrame: never keyed off (the sustain holds; ABI 6.1)"),
];

/// One effect of a SUBMIX chain: 72 B (ABI 5.0, ADR 0352: 16 parameters; 40 B before).
const SUBMIX_EFFECTS: Repeat = Repeat {
    name: "effects",
    count_field: "effectCount",
    item: &[
        Field::new("type", Ty::U32).doc("SUBMIX_FX_*, or FX_PLUGIN_BASE + e for registered plugin effect e (ABI 5.0); a type the core doesn't know passes the signal through"),
        Field::new("flags", Ty::U32).doc("SUBMIX_FX_ON"),
        Field::new("p", Ty::F32).array(16).doc("the catalogue's (or the plugin's declared) parameters in order; unused p = 0 (16 from ABI 5.0)"),
    ],
    then: None,
    max: 0,
};

/// 0x0C SUBMIX (ADR 0345, ABI 4.5; levels ABI 4.9): configures submix slot `voiceId`
/// (0..SUBMIXES_MAX-1): the voices of instance `group` on bus `bus` route into it (group 0: only
/// the voices a ROUTE names), it runs its chain and feeds slot `parent - 1` (a nested playlist's, a
/// track's or a clip's submix feeding its parent level's) or, with parent 0 or a free parent, bus
/// `bus`. An effect count of 0 frees the slot; a slot whose group goes to 0 keeps running its chain
/// (its tail rings) until freed. Applies on arrival, like AUTOMATE; main sends it before the PLAYs.
pub const SUBMIX: Opcode = Opcode {
    id: 0x0C,
    name: "SUBMIX",
    payload: Body::with_tail(
        &[
            Field::new("group", Ty::U16).doc("the instance group 1..=1024 whose voices on `bus` route here; 0 none (ROUTE only)"), // 12
            Field::new("bus", Ty::U16).doc("the output bus index"),                                           // 14
            Field::new("effectCount", Ty::U32).doc("0 frees the slot"),                                       // 16
            Field::new("parent", Ty::U16).doc("ABI 4.9: the slot this one feeds, plus 1; SUBMIX_PARENT_NONE (0) the bus"), // 20
            Field::new("reserved", Ty::U16),                                                                 // 22
        ],
        Tail::Repeat(&SUBMIX_EFFECTS),
    ),
    total_bytes: None,
    sent: true,
    doc: "configure a submix's group, bus, parent and insert chain (ADR 0345); no effects frees it",
};

/// 0x0D ROUTE, 16 B (ADR 0345 levels, ABI 4.9): voice `voiceId` mixes into submix slot `submix - 1`
/// (its playlist level's) instead of its group's; 0 goes back to the group's route. Applies on
/// arrival, like AUTOMATE, so main sends it right after the PLAY (and after a replayed PLAY). A free
/// slot routes the voice to the slot's bus, as a group route does.
pub const ROUTE: Opcode = Opcode {
    id: 0x0D,
    name: "ROUTE",
    payload: Body::fixed(&[
        Field::new("submix", Ty::U16).doc("the submix slot plus 1; 0 the group's route"), // 12
        Field::new("reserved", Ty::U16),                                                // 14
    ]),
    total_bytes: Some(16),
    sent: true,
    doc: "route a voice into a submix slot (ADR 0345 levels)",
};

/// SUBMIX_AUTOMATE bindings (AUTOMATE's items): AUTO_TARGET_FX targets only; params global, local to the submix's
/// group, or its group's `sequenceTime`; at most BUS_AUTOMATE_MAX_BINDINGS kept.
const SUBMIX_AUTOMATE_BINDINGS: Repeat = Repeat { name: "bindings", count_field: "bindingCount", item: super::batch::BINDING_ITEM, then: None, max: 0 };

/// 0x1F SUBMIX_AUTOMATE (ADR 0345 instance automation, ABI 4.8): replaces instance submix slot `voiceId`'s
/// bindings (count 0 clears them; a SUBMIX that frees the slot or gives it another group clears them too). Each
/// binding drives one parameter of the submix's chain (AUTO_TARGET_FX, the slot and parameter in the target's
/// upper bits), evaluated once a quantum before the chain runs, from a global parameter, a local one of the
/// submix's group, or the group's `sequenceTime`. Applies on arrival, like AUTOMATE; main sends it after the SUBMIX.
pub const SUBMIX_AUTOMATE: Opcode = Opcode {
    id: 0x1F,
    name: "SUBMIX_AUTOMATE",
    payload: Body::with_tail(&[Field::new("bindingCount", Ty::U32)], Tail::Repeat(&SUBMIX_AUTOMATE_BINDINGS)),
    total_bytes: None,
    sent: true,
    doc: "replace an instance submix's effect-parameter automation (ADR 0345, ABI 4.8); count 0 clears it",
};

/// One loop of a LOOPS program: 28 B.
const LOOPS_ITEMS: Repeat = Repeat {
    name: "loops",
    count_field: "loopCount",
    item: &[
        Field::new("startFrame", Ty::U32).doc("clip frames"),
        Field::new("endFrame", Ty::U32).doc("clip frames; equal to startFrame: a hold point"),
        Field::new("crossfadeFrames", Ty::U32).doc("the seam's crossfade (and a hold point's fades), clip frames; shaped by `shapes` bits 0-3"),
        Field::new("exitFadeFrames", Ty::U32).doc("exit crossfade's length, clip frames; shaped by `shapes` bits 4-7"),
        Field::new("count", Ty::U16).doc("0 endless; else passes in all, the first included"),
        Field::new("flags", Ty::U16).doc("LOOP_* direction, activation, exit, re-entry and comparison"),
        Field::new("param", Ty::U16).doc("activation parameter: a binding param (PARAM_GLOBAL | slot, or a local slot)"),
        Field::new("shapes", Ty::U16).doc("ABI 4.9: FADE_SHAPE_* of the seam (bits 0-3) and exit (bits 4-7) crossfades; 0 equal power"),
        Field::new("threshold", Ty::F32).doc("activation threshold"),
    ],
    then: None,
    max: 0,
};

/// 0x0B LOOPS (ADR 0342): replaces a clip voice's loop program, at most `VOICE_LOOPS_MAX` loops
/// (count 0 clears it); applies on arrival, like AUTOMATE, so main sends it right after the PLAY. A
/// SET_LOOP with `looping` clear is the program's key-off (held loops let go, stamped); one with
/// `looping` set replaces the program with its single region. Stream and ambisonic voices ignore it.
pub const LOOPS: Opcode = Opcode {
    id: 0x0B,
    name: "LOOPS",
    payload: Body::with_tail(&[Field::new("loopCount", Ty::U32)], Tail::Repeat(&LOOPS_ITEMS)),
    total_bytes: None,
    sent: true,
    doc: "replace a clip voice's loop program (ADR 0342); count 0 clears it",
};

/// 0x1D TIME, 24 B (ADR 0346): re-anchors a group's clock at the record's frame (stamped like a
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
    doc: "re-anchor a group's sequence clock (ADR 0346); stamped",
};

/// 0x22 AMP_ENVELOPE, 44 B (ADR 0362 item 2, ABI 6.1): voice `voiceId`'s Amp envelope (the catalogue's `envelope` on
/// a sequence clip), a gain per sample over the envelope's own frames (`audio_dsp::adsr`): from 0 to 1 over
/// `attackFrames`, 1 for `holdFrames`, down to `sustain` over `decayFrames`, then `sustain`; at `keyOffFrame` the
/// release falls from the level reached to 0 over `releaseFrames` (silent after it). Envelope frame `offsetFrames` is the
/// voice's first rendered frame (a voice that starts inside its clip starts inside the envelope), and the envelope
/// moves one frame per output frame the voice renders or, virtual, keeps time for (not while paused; independent of
/// pitch). Applies on arrival, like AUTOMATE, so main sends it right after the PLAY; a later one replaces it, and one
/// with `AMP_ENV_ON` clear removes it. A stale id is ignored.
pub const AMP_ENVELOPE: Opcode = Opcode {
    id: 0x22,
    name: "AMP_ENVELOPE",
    payload: Body::fixed(&[
        Field::new("flags", Ty::U32).doc("AMP_ENV_ON"),                                                       // 12
        Field::new("attackFrames", Ty::U32),                                                                 // 16
        Field::new("holdFrames", Ty::U32),                                                                   // 20
        Field::new("decayFrames", Ty::U32),                                                                  // 24
        Field::new("sustain", Ty::F32).doc("0..1"),                                                          // 28
        Field::new("releaseFrames", Ty::U32),                                                                // 32
        Field::new("keyOffFrame", Ty::U32).doc("the envelope frame the release starts at; AMP_ENV_KEY_OFF_NONE never"), // 36
        Field::new("offsetFrames", Ty::U32).doc("the envelope frame of the voice's first rendered frame"),    // 40
    ]),
    total_bytes: Some(44),
    sent: true,
    doc: "a voice's Amp envelope (ADR 0362, ABI 6.1); applies on arrival",
};
