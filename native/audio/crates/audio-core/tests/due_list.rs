//! 0166 M4-0, the due list (Z2a; api-and-models §3.1 "Due list", "Class G and class S", §9 "Unit
//! (cargo)"; architecture §4.4 "`render`", §3.6 "Held records"; ADR 0167 §1.1; rulings R2, R3, R10).
//!
//! `pop_due` still pops every stamped record due in a quantum; `due::route` sends a per-voice record
//! into the quantum's due list (setting its voice's `due::FLAG2_DUE`) or parks it (its voice held by
//! the gate, `groups::FLAG2_GATED`), and the quantum renders once: the record applies inside its own
//! voice, at its own sample. Records that aren't per voice, and a quantum with more than
//! `due::DUE_RECORDS` due records, still split the quantum and count `splitQuanta` once per quantum.
//! A due record at a voice's own start frame applies before its first sample. Past
//! `due::PARKED_RECORDS` parked records a record applies at its own frame, unrebased, and counts
//! `parkedOverflow`. `due::rebase` shifts a held group's parked and still pending records.
//!
//! Leaf **L-Z2aa** fills these cases (tree: §9's cargo list). Records go in as BATCH messages through
//! `scheduler::submit` and render through `Core::process` (see `in_voice_hooks.rs`, `paused.rs`), or,
//! for the list's own API, through `due::view`, `due::route` and `due::rebase` on a core. A voice is
//! gated for a test by setting `groups::FLAG2_GATED` in its slot's `flags2` byte in the `Voices`
//! region (`index * layout::VOICE_SLOT_BYTES + core::mem::offset_of!(VoiceSlot, flags2)`): no task
//! before C2b sets it.

#![allow(unused_imports)]

mod common;

use audio_core::due::{self, Class, Route, DUE_RECORDS, FLAG2_DUE, PARKED_RECORDS};
use audio_core::groups::FLAG2_GATED;
use audio_core::scheduler::{self, PendingRecord};
use audio_core::{status, voices};
use audio_wire::generated as wire;
use common::*;

use audio_core::layout::VOICE_SLOT_BYTES;
use audio_core::{Core, QUANTUM};

const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const V3: u32 = 0x0001_0003;
/// A 2,000-frame one-shot clip whose frame `k` is `k / 100_000`.
const RAMP: u32 = 2;
const RAMP_FRAMES: usize = 2_000;
/// A shape word with a law and a start phase (api-and-models §4.2), for the shape test.
const SHAPE: u32 = 0x0003_0002;
const TOL_OUT: f32 = 1e-6;
/// The 5 ms mix fade a pause or a seek of a mixed voice ramps over (paused.rs, seek.rs).
const MIX_FADE: usize = 240;

/// Voice id of slot `index` (generation 0).
fn vid(index: u32) -> u32 {
    0x0001_0000 | index
}

/// The ramp clip's sample at frame `p`.
fn c(p: usize) -> f32 {
    p as f32 / 100_000.0
}

/// A mixer over no look-ahead (its frames are core frames), with the ramp clip loaded.
fn quiet() -> Mixer {
    let mut m = Mixer::new(2);
    m.set_lookahead(0.0);
    let samples: Vec<f32> = (0..RAMP_FRAMES).map(|k| k as f32 / 100_000.0).collect();
    m.load_clip(RAMP, &samples);
    m
}

/// A mixer with the DC voices `ids` playing (looping, mixed, gain 1) from frame 0, rendered one
/// quantum: `m.frame` is then 128.
fn live(ids: &[u32]) -> Mixer {
    let mut m = quiet();
    let recs: Vec<Rec> = ids.iter().map(|&v| played(v, DC, MIXED | LOOP, 1.0)).collect();
    m.submit(&recs);
    m.render();
    m
}

/// A PLAY of `clip` on the root bus, asap, at `gain`.
fn played(voice: u32, clip: u32, flags: u16, gain: f32) -> Rec {
    let Rec::Play(mut p) = play(voice, clip, ROOT, flags) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

/// A PLAY as [`played`], stamped at `frame`.
fn played_at(voice: u32, clip: u32, flags: u16, gain: f32, frame: u32) -> Rec {
    let Rec::Play(mut p) = played(voice, clip, flags, gain) else { unreachable!() };
    p.frame_offset = frame;
    Rec::Play(p)
}

/// A BATCH of `recs` whose frame offsets are absolute frames (first frame 0), submitted directly.
fn submit_abs(m: &mut Mixer, recs: &[Rec]) {
    assert_eq!(scheduler::submit(&mut m.core, &batch(0.0, recs)), 0, "the batch was refused");
}

/// SET_PARAMS of gain `gain` over `ramp` frames, stamped at `frame`.
fn gain_at(voice: u32, gain: f32, ramp: u32, frame: u32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: frame, mask: wire::SET_PARAMS_MASK_GAIN, gain, ramp_frames: ramp, ..Default::default() })
}

/// SET_PARAMS of pitch `pitch` at `frame`, at once.
fn pitch_at(voice: u32, pitch: f32, frame: u32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: frame, mask: wire::SET_PARAMS_MASK_PITCH, pitch, ramp_frames: 0, ..Default::default() })
}

/// SET_PARAMS of gain 0.4 and pitch 1.5 (both bits), stamped at `frame`, with `shape` (0 for none).
fn gain_pitch_at(voice: u32, frame: u32, shape: u32) -> Rec {
    let mask = wire::SET_PARAMS_MASK_GAIN | wire::SET_PARAMS_MASK_PITCH;
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: frame, mask, gain: 0.4, pitch: 1.5, shape, ..Default::default() })
}

/// STOP with `fade` frames, stamped at `frame`, with `shape`.
fn stop_at(voice: u32, fade: u32, frame: u32, shape: u32) -> Rec {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: voice, frame_offset: frame, fade_frames: fade, reason: 0, shape }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// FADE to `target` over `frames`, stamped at `frame`, with `shape`.
fn fade_at(voice: u32, target: f32, frames: u32, frame: u32, shape: u32) -> Rec {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id: voice, frame_offset: frame, target, frames, flags: 0, shape }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// SET_PAUSED at `frame`.
fn paused_at(voice: u32, paused: bool, frame: u32) -> Rec {
    let mut b = vec![0u8; wire::SetPaused::FIXED_END];
    wire::SetPaused { voice_id: voice, frame_offset: frame, paused: paused as u32 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// SEEK to clip frame `clip_frame` at `frame` (clips: epoch 0).
fn seek_at(voice: u32, clip_frame: u32, frame: u32) -> Rec {
    let mut b = vec![0u8; wire::Seek::FIXED_END];
    wire::Seek { voice_id: voice, frame_offset: frame, clip_frame, epoch: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// SET_LOOP over `start..end` (clip frames) at `frame`, looping or not.
fn loop_at(voice: u32, start: u32, end: u32, looping: bool, frame: u32) -> Rec {
    let flags = if looping { wire::SET_LOOP_FLAGS_LOOPING } else { 0 };
    let mut b = vec![0u8; wire::SetLoop::FIXED_END];
    wire::SetLoop { voice_id: voice, frame_offset: frame, loop_start_frame: start, loop_end_frame: end, flags }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// A pending record of `op` and `mask` for `voice` at `frame`.
fn pending(op: u16, mask: u32, voice: u32, frame: u64) -> PendingRecord {
    PendingRecord { frame, voice_id: voice, op: op as u8, mask: mask as u8, ..Default::default() }
}

/// A gain-only SET_PARAMS as a pending record (what `submit` queues), at `frame`.
fn gain_pending(voice: u32, gain: f32, ramp: u32, frame: u64) -> PendingRecord {
    PendingRecord { values: [gain, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], frames: ramp, ..pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_GAIN, voice, frame) }
}

/// Sets or clears `FLAG2_GATED` in voice `voice`'s slot.
fn set_gated(core: &mut Core, voice: u32, on: bool) {
    let at = (voice & 0xFFFF) as usize * VOICE_SLOT_BYTES + std::mem::offset_of!(voices::VoiceSlot, flags2);
    let b = &mut core.regions_mut().voices[at];
    if on {
        *b |= FLAG2_GATED;
    } else {
        *b &= !FLAG2_GATED;
    }
}

/// Zeroes voice `voice`'s slot: the voice is gone.
fn free_slot(core: &mut Core, voice: u32) {
    let at = (voice & 0xFFFF) as usize * VOICE_SLOT_BYTES;
    core.regions_mut().voices[at..at + VOICE_SLOT_BYTES].fill(0);
}

/// The slot's `flags2` of voice `voice`.
fn flags2_of(core: &Core, voice: u32) -> u8 {
    voices::slots(core)[(voice & 0xFFFF) as usize].flags2
}

/// The frames of this quantum's due list, in list order.
fn frames_of(core: &mut Core) -> Vec<u64> {
    let list = due::view(core.regions_mut());
    list.records().iter().map(|r| r.frame).collect()
}

/// The (voice, frame) of the parked records, in arrival order.
fn parked_of(core: &mut Core) -> Vec<(u32, u64)> {
    let list = due::view(core.regions_mut());
    list.parked().iter().map(|r| (r.voice_id, r.frame)).collect()
}

/// One voice's case of the every-record test: two looping DC voices at gain 0.1, and voice 3, a ramp
/// clip at gain 0.5 from frame 0, which gets `rec` (stamped at frame 50). The quantum's output is
/// `0.2 + want(k)` (the two DC voices, then voice 3's own curve), and no quantum splits.
fn per_voice_case(what: &str, rec: Rec, want: impl Fn(usize) -> f32) {
    let mut m = quiet();
    m.submit(&[played(vid(1), DC, MIXED | LOOP, 0.1), played(vid(2), DC, MIXED | LOOP, 0.1), played(vid(3), RAMP, MIXED, 0.5), rec]);
    m.render();
    m.expect(L, TOL_OUT, what, |k| 0.2 + want(k));
    assert_eq!(status::counters(&m.core).music.split_quanta, 0, "{what}: no quantum split");
}

// --- Class routing (§3.1 "Class G and class S") ---

/// `due::classify`: FADE, STOP (fade 0 and with a fade) and SET_PARAMS with the gain bit alone are
/// class G; SET_PARAMS with any other bit (pitch, direction, `lpHz`, score, bus, flags; gain with
/// another bit), SET_PAUSED, SEEK and SET_LOOP are class S; any other opcode is `Class::Quantum`.
#[test]
fn classify_follows_the_class_table() {
    let g = [
        pending(wire::op::FADE, 0, V1, 0),
        pending(wire::op::STOP, 0, V1, 0),
        PendingRecord { frames: 10, ..pending(wire::op::STOP, 0, V1, 0) },
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_GAIN, V1, 0),
    ];
    for r in &g {
        assert_eq!(due::classify(r), Class::G, "{r:?}");
    }
    let s = [
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_PITCH, V1, 0),
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_DIR, V1, 0),
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_LP_HZ, V1, 0),
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_SCORE, V1, 0),
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_BUS, V1, 0),
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_FLAGS, V1, 0),
        pending(wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_GAIN | wire::SET_PARAMS_MASK_PITCH, V1, 0),
        pending(wire::op::SET_PAUSED, 0, V1, 0),
        pending(wire::op::SEEK, 0, V1, 0),
        pending(wire::op::SET_LOOP, 0, V1, 0),
    ];
    for r in &s {
        assert_eq!(due::classify(r), Class::S, "{r:?}");
    }
    // (BUS_MIX, retired by 0171/0172 M5, was here too; BUS_RAMP becomes class B with B1b.)
    assert_eq!(due::classify(&pending(wire::op::MASTER, 0, 0, 0)), Class::Quantum, "MASTER");
}

/// A stamped record for a live, ungated voice: `route` returns `Route::Voice`, the record is in the
/// list (`DueList::records`, `for_voice`) and its voice carries `FLAG2_DUE`; the next
/// `due::begin_quantum` empties the list and clears the bit.
#[test]
fn a_per_voice_record_goes_into_the_due_list_and_flags_its_voice() {
    let mut m = live(&[V1]);
    let frame = m.frame;
    let core = &mut m.core;
    due::begin_quantum(core, frame);
    assert_eq!(due::route(core, &gain_pending(V1, 0.5, 0, 200), frame), Route::Voice);
    assert_eq!(frames_of(core), vec![200]);
    assert_eq!(due::view(core.regions_mut()).for_voice(V1).count(), 1);
    assert_ne!(flags2_of(core, V1) & FLAG2_DUE, 0, "the voice is flagged");
    due::begin_quantum(core, frame + QUANTUM as u64);
    assert!(frames_of(core).is_empty(), "the list is emptied");
    assert_eq!(flags2_of(core, V1) & FLAG2_DUE, 0, "the flag is cleared");
}

/// A record for a stale id or an ended voice: `Route::Dropped`, nothing in the list, no flag, no
/// split.
#[test]
fn a_record_for_a_gone_voice_is_dropped_without_a_split() {
    let mut m = quiet();
    // V2 is a one-shot over the 64-frame DC clip: it has ended by the end of the first quantum.
    m.submit(&[played(V1, DC, MIXED | LOOP, 1.0), played(V2, DC, MIXED, 1.0)]);
    m.render();
    let core = &mut m.core;
    due::begin_quantum(core, 128);
    assert_eq!(due::route(core, &gain_pending(V2, 0.5, 0, 200), 128), Route::Dropped, "an ended voice");
    assert_eq!(due::route(core, &gain_pending(0x0002_0001, 0.5, 0, 200), 128), Route::Dropped, "a stale id");
    assert!(frames_of(core).is_empty(), "nothing listed");
    assert_eq!(flags2_of(core, V1) & FLAG2_DUE, 0, "no flag");
}

/// Every per-voice record (STOP with fade 0 and with a fade, FADE, SET_PARAMS gain and pitch,
/// SET_PAUSED, SEEK, SET_LOOP), stamped at a sample inside a quantum on one voice among several,
/// lands on that voice at that sample (its output against the expected curve, as
/// `golden_native.rs` and `paused.rs` check them), the other voices' output is bit-identical to a
/// twin core without the record, and `splitQuanta` stays 0.
#[test]
fn every_per_voice_record_reaches_its_voice_at_its_sample() {
    // Voice 3 plays the ramp clip at gain 0.5 and gets the record at frame 50.
    per_voice_case("STOP without a fade", stop_at(V3,0, 50, 0), |k| if k < 50 { 0.5 * c(k) } else { 0.0 });
    per_voice_case("STOP with a fade", stop_at(V3,32, 50, 0), |k| {
        if k < 50 {
            0.5 * c(k)
        } else if k < 82 {
            0.5 * c(k) * ramp_to(1.0, 0.0, 32, k - 50)
        } else {
            0.0
        }
    });
    per_voice_case("FADE", fade_at(V3,0.25, 32, 50, 0), |k| if k < 50 { 0.5 * c(k) } else { 0.5 * c(k) * ramp_to(1.0, 0.25, 32, k - 50) });
    per_voice_case("SET_PARAMS gain", gain_at(V3,0.25, 16, 50), |k| if k < 50 { 0.5 * c(k) } else { c(k) * ramp_to(0.5, 0.25, 16, k - 50) });
    // The position advances one frame a sample until frame 50, then two (pitch 2 from frame 50).
    per_voice_case("SET_PARAMS pitch", pitch_at(V3,2.0, 50), |k| 0.5 * c(if k < 50 { k } else { 50 + 2 * (k - 50) }));
    per_voice_case("SET_PAUSED", paused_at(V3,true, 50), |k| if k < 50 { 0.5 * c(k) } else { 0.5 * c(k) * ramp_to(1.0, 0.0, MIX_FADE, k - 50) });
    // A mixed voice's seek fades the old audio out over the mix fade; the jump comes after it.
    per_voice_case("SEEK", seek_at(V3,1_000, 50), |k| if k < 50 { 0.5 * c(k) } else { 0.5 * c(k) * ramp_to(1.0, 0.0, MIX_FADE, k - 50) });
    // Looping from frame 50 over clip frames 0..100: frame 100 wraps (not checked), then frame 101 is
    // clip frame 1.
    per_voice_case("SET_LOOP", loop_at(V3,0, 100, true, 50), |k| {
        if k < 100 {
            0.5 * c(k)
        } else if k == 100 {
            f32::NAN
        } else {
            0.5 * c(k - 100)
        }
    });
}

/// Several records for one voice in one quantum, at different samples and at the same sample,
/// apply in frame order, and in arrival order at one frame (e.g. two SET_PARAMS gains at one frame:
/// the second wins).
#[test]
fn one_voices_records_apply_in_frame_order_and_stably() {
    let mut m = quiet();
    // Arrival order: 0.2 at 40, 0.8 at 10, 0.5 at 40. Frame order: 0.8 (10), 0.2 (40), 0.5 (40).
    m.submit(&[played(V1, DC, MIXED | LOOP, 1.0), gain_at(V1, 0.2, 0, 40), gain_at(V1, 0.8, 0, 10), gain_at(V1, 0.5, 0, 40)]);
    m.render();
    m.expect(L, TOL_OUT, "frame order, then arrival order at one frame", |k| if k < 10 { 1.0 } else if k < 40 { 0.8 } else { 0.5 });
}

/// §3.1: "A due record at a voice's own start frame applies before its first sample": a stamped
/// PLAY at sample k with a FADE to 0 over 0 frames, or a SET_PARAMS gain, stamped at the same frame:
/// the voice's first sample already has it. A record stamped before the start (same quantum)
/// applies too, in order.
#[test]
fn a_record_at_a_voices_start_frame_applies_before_its_first_sample() {
    // A gain at the start frame.
    let mut m = quiet();
    m.submit(&[played_at(V1, DC, MIXED | LOOP, 1.0, 40), gain_at(V1, 0.5, 0, 40)]);
    m.render();
    m.expect(L, TOL_OUT, "a gain at the start frame", |k| if k < 40 { 0.0 } else { 0.5 });

    // A gain stamped before the start, in the same quantum.
    let mut m = quiet();
    m.submit(&[played_at(V1, DC, MIXED | LOOP, 1.0, 40), gain_at(V1, 0.5, 0, 30)]);
    m.render();
    m.expect(L, TOL_OUT, "a gain before the start", |k| if k < 40 { 0.0 } else { 0.5 });

    // A FADE to 0 over 0 frames at the start frame: the first sample is already 0.
    let mut m = quiet();
    m.submit(&[played_at(V1, DC, MIXED | LOOP, 1.0, 40), fade_at(V1, 0.0, 0, 40, 0)]);
    m.render();
    m.expect(L, TOL_OUT, "a zero fade at the start frame", |_| 0.0);
}

/// A record whose frame has passed applies at sample 0 of the next quantum, counts in
/// `lateCommands` and `maxLatenessFrames` as before, and doesn't split.
#[test]
fn a_late_record_applies_at_sample_0_and_counts_late() {
    let mut m = quiet();
    m.submit(&[played(V1, DC, MIXED | LOOP, 1.0)]);
    m.render_n(2);
    // Frame 200 is inside the quantum at 128, already rendered: due before the quantum at 256 starts.
    submit_abs(&mut m, &[gain_at(V1, 0.5, 0, 200)]);
    m.render();
    m.expect(L, TOL_OUT, "applied at sample 0 of the quantum at 256", |_| 0.5);
    let counters = status::counters(&m.core);
    assert_eq!((counters.late_commands, counters.max_lateness_frames), (1, 56));
    assert_eq!(counters.music.split_quanta, 0, "a late record doesn't split");
}

// --- Overflow (§3.1: "so does a quantum with more than 256 due records") ---

/// More than `DUE_RECORDS` records due in one quantum: the first `DUE_RECORDS` go into the list;
/// each one past it splits the quantum at its sample (`Route::Split`) and applies there. Every
/// record still lands on its sample, and `splitQuanta` counts the quantum once.
#[test]
fn past_due_records_a_quantum_splits_and_counts_split_quanta_once() {
    // 257 gain records over three DC voices, one per voice per frame: voice v (1 + i % 3) takes record
    // i at frame i / 3, with gain 0.05 + 0.0005 i. Record 256 (the 257th due) is past the list.
    let mut m = quiet();
    let mut recs = vec![played(vid(1), DC, MIXED | LOOP, 1.0), played(vid(2), DC, MIXED | LOOP, 1.0), played(vid(3), DC, MIXED | LOOP, 1.0)];
    for i in 0u32..257 {
        recs.push(gain_at(vid(1 + i % 3), 0.05 + 0.0005 * i as f32, 0, i / 3));
    }
    m.submit(&recs);
    m.render();
    // Voice v's last record at or before frame f is record 3k + v, with k = min(f, its last frame).
    let last = [85usize, 85, 84];
    m.expect(L, TOL_OUT, "every record lands on its sample", |f| {
        (0..3usize).map(|v| 0.05 + 0.0005 * (3 * f.min(last[v]) + v) as f32).sum::<f32>()
    });
    assert_eq!(status::counters(&m.core).music.split_quanta, 1, "one quantum split, counted once");
}

// --- Parked records (§3.1, architecture §3.6, R10) ---

/// A record for a gated voice: `Route::Parked`, in `DueList::parked`, not applied, not counted late
/// while held, the voice not flagged.
#[test]
fn a_held_voices_record_is_parked_not_applied() {
    let mut m = live(&[V1]);
    set_gated(&mut m.core, V1, true);
    submit_abs(&mut m, &[gain_at(V1, 0.5, 0, 200)]);
    m.render();
    let core = &mut m.core;
    assert_eq!(parked_of(core), vec![(V1, 200)], "parked");
    assert!(frames_of(core).is_empty(), "not in the due list");
    assert_eq!(flags2_of(core, V1) & FLAG2_DUE, 0, "the voice is not flagged");
    assert_eq!(status::counters(core).late_commands, 0, "not counted late");
    assert_eq!(status::counters(core).music.split_quanta, 0, "no split");
}

/// Past `PARKED_RECORDS` parked records, a held voice's record returns `Route::Overflow`: it goes
/// into the due list and applies at its own frame, unrebased, and `parkedOverflow` counts it
/// (`status::counters(..).music.parked_overflow`).
#[test]
fn past_parked_records_a_record_applies_unrebased_and_counts_parked_overflow() {
    let mut m = live(&[V1]);
    set_gated(&mut m.core, V1, true);
    let core = &mut m.core;
    due::begin_quantum(core, 128);
    for i in 0..PARKED_RECORDS as u64 {
        assert_eq!(due::route(core, &gain_pending(V1, 0.5, 0, 200 + i), 128), Route::Parked);
    }
    assert_eq!(due::route(core, &gain_pending(V1, 0.5, 0, 300), 128), Route::Overflow);
    assert_eq!(status::counters(core).music.parked_overflow, 1, "counted");
    assert_eq!(parked_of(core).len(), PARKED_RECORDS, "the parked records stay");
    assert_eq!(frames_of(core), vec![300], "in the due list at its own frame, unrebased");
}

/// `due::release_parked(core, before)`: once the voice's `FLAG2_GATED` is clear, its parked records
/// with a frame before `before` move into the due list in frame order and apply at their samples in
/// that quantum; later ones stay parked; a still gated voice's stay parked; a gone voice's are
/// dropped.
#[test]
fn released_parked_records_apply_in_the_quantum_their_frame_falls_in() {
    let mut m = live(&[V1, V2]);
    set_gated(&mut m.core, V1, true);
    set_gated(&mut m.core, V2, true);
    let core = &mut m.core;
    due::begin_quantum(core, 128);
    let parks: [(u32, u64); 4] = [(V1, 150), (V1, 100), (V1, 300), (V2, 120)];
    for (v, f) in parks {
        assert_eq!(due::route(core, &gain_pending(v, 0.5, 0, f), 128), Route::Parked);
    }
    set_gated(core, V1, false);
    assert_eq!(due::release_parked(core, 200), 2, "V1's records before 200 move");
    assert_eq!(frames_of(core), vec![100, 150], "in frame order");
    assert_eq!(parked_of(core), vec![(V1, 300), (V2, 120)], "the rest stay parked, in arrival order");

    // V2 is gone: its parked record drops; V1's 300 (before 1,000, and V1 is no longer gated) moves.
    free_slot(core, V2);
    assert_eq!(due::release_parked(core, 1_000), 1);
    assert!(parked_of(core).is_empty(), "the gone voice's record is dropped");
}

/// R10, `due::rebase(core, is_member, from_frame, slip)`: every parked record and every record still
/// in the pending queue of a member, with frame ≥ `from_frame`, moves by `slip` (the counts come
/// back in `Rebased`); records before `from_frame` and every non-member's record stay; the pending
/// queue stays sorted by frame and stable (pop it with `scheduler::pop_due`).
#[test]
fn rebase_shifts_members_parked_and_pending_records_and_keeps_the_queue_sorted() {
    let mut m = live(&[V1, V2]);
    set_gated(&mut m.core, V1, true);
    set_gated(&mut m.core, V2, true);
    let core = &mut m.core;
    due::begin_quantum(core, 128);
    for (v, f) in [(V1, 100u64), (V1, 300), (V2, 300)] {
        assert_eq!(due::route(core, &gain_pending(v, 0.5, 0, f), 128), Route::Parked);
    }
    // Still pending: V1 at 150 (before the rebase point), V1 at 500 twice (0.7 then 0.6), V2 at 500.
    scheduler::submit(core, &batch(0.0, &[gain_at(V1, 0.2, 0, 150), gain_at(V1, 0.7, 0, 500), gain_at(V1, 0.6, 0, 500), gain_at(V2, 0.9, 0, 500)]));
    let moved = due::rebase(core, |v| v == V1, 200, 50);
    assert_eq!(moved, due::Rebased { parked: 1, pending: 2 });
    assert_eq!(parked_of(core), vec![(V1, 100), (V1, 350), (V2, 300)], "V1's 300 moved, the rest stayed");
    let mut popped = Vec::new();
    while let Some(r) = scheduler::pop_due(core, u64::MAX) {
        popped.push((r.frame, r.voice_id, r.values[0]));
    }
    assert_eq!(popped, vec![(150, V1, 0.2), (500, V2, 0.9), (550, V1, 0.7), (550, V1, 0.6)]);
}

/// `DueList::drop_parked(voice)` removes that voice's parked records only (returns how many); a
/// voice that ends (or a PLAY replacing it) drops its own; RESET (`scheduler::reset`) empties the
/// due list and the parked records.
#[test]
fn drop_parked_and_reset_empty_the_lists() {
    let mut m = live(&[V1, V2]);
    set_gated(&mut m.core, V1, true);
    set_gated(&mut m.core, V2, true);
    let core = &mut m.core;
    due::begin_quantum(core, 128);
    for (v, f) in [(V1, 200u64), (V1, 210), (V2, 220)] {
        assert_eq!(due::route(core, &gain_pending(v, 0.5, 0, f), 128), Route::Parked);
    }
    assert_eq!(due::view(core.regions_mut()).drop_parked(V1), 2, "V1's two");
    assert_eq!(parked_of(core), vec![(V2, 220)], "V2's stays");
    scheduler::reset(core, false);
    assert!(parked_of(core).is_empty(), "RESET empties the parked records");
    assert!(frames_of(core).is_empty(), "and the due list");
}

// --- The shape word in a 48-byte record (api-and-models §4.2; Z2a's ruling) ---

/// `scheduler::shape_word` reads back a stamped FADE's, STOP's and gain-only SET_PARAMS' `shape`
/// word; a shaped SET_PARAMS with the gain bit and others is queued as two records at one frame
/// (gain alone with the shape, then the rest with none: `scheduler::pending_len` 2); an unshaped
/// one stays one record.
#[test]
fn the_shape_word_rides_in_the_record() {
    let mut core = new_core(2);
    scheduler::submit(&mut core, &batch(0.0, &[fade_at(V1, 0.0, 10, 100, SHAPE), stop_at(V1, 10, 110, SHAPE), gain_pitch_at(V1, 120, SHAPE)]));
    assert_eq!(scheduler::pending_len(&mut core), 4, "the shaped SET_PARAMS is two records");
    scheduler::submit(&mut core, &batch(0.0, &[gain_pitch_at(V1, 130, 0)]));
    assert_eq!(scheduler::pending_len(&mut core), 5, "the unshaped one is one record");
    let mut got = Vec::new();
    while let Some(r) = scheduler::pop_due(&mut core, u64::MAX) {
        got.push((r.op as u16, r.mask, scheduler::shape_word(&r)));
    }
    assert_eq!(
        got,
        vec![
            (wire::op::FADE, 0, SHAPE),
            (wire::op::STOP, 0, SHAPE),
            (wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_GAIN as u8, SHAPE),
            (wire::op::SET_PARAMS, wire::SET_PARAMS_MASK_PITCH as u8, 0),
            (wire::op::SET_PARAMS, (wire::SET_PARAMS_MASK_GAIN | wire::SET_PARAMS_MASK_PITCH) as u8, 0),
        ]
    );
}
