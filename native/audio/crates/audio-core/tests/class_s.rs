//! 0166 M4-0, class S records: the voice-local split (Z2c; api-and-models §3.1 "Class G and class
//! S"; architecture §4.4 "`render`" step 3; ADR 0167 §1.1; rulings R2, R3; tree A1, hook H1).
//!
//! Class S is every per-voice record that isn't gain-like: SET_PARAMS with pitch, low-pass
//! (`lpHz`), direction, score, bus or flag bits; SET_VOICE_FX; SET_PAUSED; SEEK; SET_LOOP. A stamped
//! one inside a quantum goes into the due list (Z2a) and applies by splitting **that voice's**
//! render at its sample (`voice_split::boundaries`, Z2c; `voices::render_due_voice`, H1): the voice
//! renders `[from, k)`, the record applies, then `[k, to)`. The quantum renders once, so
//! `splitQuanta` stays 0 and each extra render of the voice counts once in `voiceSplits`.
//!
//! **SET_VOICE_FX (build log D7).** A stamped SET_VOICE_FX applies at once at submit today
//! (`fxpool::set_voice_fx` ignores its frame) and never enters the pending queue or the due list;
//! its case pins that behaviour (no split of either kind), it does not test a split.
//!
//! Every case uses the same frame: the record is stamped at sample [`K`] of the second quantum
//! (absolute frame `QUANTUM + K`), so the voices are already running when it lands. "The other
//! voices are untouched" means their `VoiceSlot`s after the quantum are byte-identical to those of
//! a twin mixer that got the same submits without the record.
//!
//! Leaf **L-Z2ca** fills these cases. Helpers to copy, not import (test files share only
//! `common/`): the record builders in `due_list.rs` (`pitch_at`, `paused_at`, `seek_at`, `loop_at`,
//! `played`, `submit_abs`, `per_voice_case`'s expectations), `stamped` and the spatial-with-sends
//! scene in `in_voice_hooks.rs`, the aux-bus send set-up in `sends.rs`.

#![allow(unused_imports, dead_code)]

mod common;

use audio_core::due::FLAG2_DUE;
use audio_core::scheduler;
use audio_core::{status, voices, QUANTUM};
use audio_wire::generated as wire;
use common::*;

/// The record's sample inside the quantum it lands in.
const K: usize = 50;

/// SET_PARAMS pitch: voice 3 of three (a ramp clip, mixed, gain 0.5; voices 1 and 2 DC loops at
/// gain 0.1) gets pitch 2 at once at sample `K`. Its output follows `0.5 · c(p)` with the position
/// advancing one frame a sample before `K` and two after (as `due_list.rs`' pitch case);
/// `splitQuanta` 0, `voiceSplits` 1; voices 1 and 2 untouched.
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_pitch_splits_only_its_voice() {
    unimplemented!("L-Z2ca")
}

/// SET_PARAMS low-pass: the acceptance's `lowpass` ramp. A mixed voice on a bright clip (the saw of
/// `in_voice_hooks.rs`) gets `lpHz` 500 over 960 frames (the 20 ms quantised ramp of api-and-models
/// §2 `segment`) at sample `K`. Its output is bit-identical to the twin's before `K` and differs
/// after; `splitQuanta` reads 0 across the quantum and the 8 that follow (the ramp's span) while
/// `voiceSplits` reads 1 (the ramp runs inside the voice; only its start splits).
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_lowpass_ramp_splits_only_its_voice() {
    unimplemented!("L-Z2ca")
}

/// SET_PARAMS direction on a spatial voice with sends (the acceptance's "stamped spatial play with
/// sends"): voice 3 starts with a **stamped** spatial PLAY at sample `K` of one quantum, with a
/// SET_VOICE_FX of sends (0.5, 0.25) at the same frame (`in_voice_hooks.rs`' scene), and a stamped
/// SET_PARAMS direction (from `[0.6, 0, -0.8]` to `[-0.6, 0, -0.8]`, ramp 0) at sample `K` of a
/// later quantum. Across all of it `splitQuanta` reads 0; the PLAY itself splits nothing (a record
/// at a voice's start frame applies before its first sample: `voiceSplits` 0 after that quantum),
/// the direction change counts `voiceSplits` 1; the output is bit-identical to the twin's before
/// the direction's sample and differs after it (the pan moves; the sends tap per piece).
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_direction_on_a_spatial_voice_with_sends_splits_only_its_voice() {
    unimplemented!("L-Z2ca")
}

/// SET_VOICE_FX (D7, see the module notes): a SET_VOICE_FX stamped at sample `K` of a later quantum
/// for a playing mixed voice leaves the pending queue empty after submit (`scheduler::pending_len`
/// 0), its voice carries no `FLAG2_DUE` during the render, and `splitQuanta` and `voiceSplits` both
/// read 0 after it. (Today it applies at submit; if a later task makes it honour its frame, this
/// case becomes a split case like the others.)
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_voice_fx_applies_at_once_and_splits_nothing() {
    unimplemented!("L-Z2ca")
}

/// SET_PAUSED: voice 3 (as the pitch case) paused at sample `K`: `0.5 · c(k)` before `K`, then
/// faded over the 5 ms mix fade (240 frames, `due_list.rs` `MIX_FADE`) from `K`; `splitQuanta` 0,
/// `voiceSplits` 1; voices 1 and 2 untouched.
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_pause_splits_only_its_voice() {
    unimplemented!("L-Z2ca")
}

/// SEEK: voice 3 seeks to clip frame 1,000 at sample `K`: the old audio fades over the mix fade
/// from `K` (the jump comes after it, as `due_list.rs`' SEEK case); `splitQuanta` 0,
/// `voiceSplits` 1; voices 1 and 2 untouched.
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_seek_splits_only_its_voice() {
    unimplemented!("L-Z2ca")
}

/// SET_LOOP: voice 3, a one-shot, gets a loop over clip frames `0..(QUANTUM + K + 20)` at sample
/// `K`: it plays on unchanged until its position reaches the loop end, then wraps to clip frame 0
/// (skip the wrap sample itself, as `due_list.rs` does); `splitQuanta` 0, `voiceSplits` 1;
/// voices 1 and 2 untouched.
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_set_loop_splits_only_its_voice() {
    unimplemented!("L-Z2ca")
}

/// SET_PARAMS bus (and score): two buses under the root; voice 3 on bus 1 moves to bus 2 at
/// sample `K` (score 5 in the same record). Bus 1's input carries voice 3 for `[0, K)` only and
/// bus 2's for `[K, QUANTUM)` (give the buses different gains so the output shows the move at `K`
/// exactly: `g1 · v(k)` before, `g2 · v(k)` after); the slot's `score` reads 5; `splitQuanta` 0,
/// `voiceSplits` 1.
#[test]
#[ignore = "L-Z2ca"]
fn a_stamped_bus_move_splits_only_its_voice() {
    unimplemented!("L-Z2ca")
}

/// `voiceSplits` counts the pieces past the first, per voice, cumulatively: in one quantum voice 1
/// gets class S records at samples 20, 60 and two at 90 (one sample: one boundary), voice 2 one at
/// 0 (before its first sample: no split) and one at 127, voice 3 none. `voiceSplits` reads 3 + 1 =
/// 4, `splitQuanta` 0; the next quantum with no records adds nothing; a further quantum with one
/// record adds 1 (cumulative). Each voice's `FLAG2_DUE` is clear after the quantum that follows.
#[test]
#[ignore = "L-Z2ca"]
fn voice_splits_counts_each_extra_piece() {
    unimplemented!("L-Z2ca")
}

/// A voice that starts inside the quantum (a stamped PLAY at sample 30) with a class S record at 30
/// (applies before its first sample: no split) and one at 80 (one split): `voiceSplits` 1. A record
/// for a voice that has ended inside the quantum before its sample applies to no effect and counts
/// nothing.
#[test]
#[ignore = "L-Z2ca"]
fn a_voice_starting_or_ending_inside_the_quantum_splits_only_past_its_first_sample() {
    unimplemented!("L-Z2ca")
}

/// Two class G records for one voice at different samples (a FADE at 30 and a SET_PARAMS gain at
/// 70) take the class S path for the second (§3.1): `voiceSplits` 1, `splitQuanta` 0, and the
/// output follows both at their samples. Depends on Z2b's `curves::prepare` taking the first record
/// into the gain loop (with Z2b's stub both split: 2); stays ignored until Z2b and Z2c are both on
/// the flip branch.
#[test]
#[ignore = "Z2b"]
fn two_class_g_offsets_take_one_voice_local_split() {
    unimplemented!("after Z2b")
}
