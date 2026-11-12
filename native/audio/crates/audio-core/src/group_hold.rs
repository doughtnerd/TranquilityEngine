//! The group hold on starve (0166 M4a; architecture §4.3 rows "Started" and "Held", §2.2; rulings
//! R11; ADR 0167 §2 "A stem that runs dry mid-piece holds its whole group", §3.6 owner decision 6;
//! tree A3, hook H2).
//!
//! When any gated member of a started group would starve, every member fades out **together**,
//! then holds silent with its position pinned; decoded members too. The group resumes when every
//! member has ≥ 4,096 frames buffered (or its input ended): all at offset 0 with a 5 ms fade-in,
//! their queued records rebased by the hold's length (`group_rebase::apply`), a resume reported with
//! the slip. Held more than 1 s, the group is abandoned (`groups::begin_quantum`). An ungated stream
//! voice starves alone, as today.
//!
//! **The joint fade (C2c).** A member's own starve check fires inside its render, after the members
//! before it in the voice walk have rendered the quantum, so the others can't join a fade it starts.
//! The hold therefore looks ahead, before the voice loop ([`begin_started`], from
//! `groups::begin_quantum`): a stream member whose ring holds less than the fade plus one quantum
//! (`have < (fade + 128) × step`, a horizon at or above the voice's own `128 + 5 ms`, so the voice's
//! check never fires first at a steady pitch) starts the hold's fade in every member at sample 0 of
//! this quantum. The fade is the 5 ms starve fade **rounded up to whole quanta**
//! ([`hold_fade_frames`]: 256 frames at 44.1 and 48 kHz), so every member renders whole quanta while
//! it runs and stops on one frame, the starving one included (the look-ahead guarantees it holds
//! the fade's frames). Streamed members fade by their ring's starvation gain (`stream::Ring::gain`):
//! a ring that is short is put in `STARVING` so its own check stays quiet and it doesn't turn round;
//! a ring with data stays `PLAYING`. The entry stays STARTED with [`FLAG_FADING`] while the fade runs
//! (`held_frames` counts it), so the members aren't gated and their records apply at their own
//! frames; then it turns HELD and the hold's start is the first silent frame. **Decoded members**
//! have no ring: they fade by their `mix` ramp (`voices::hold_fade`), as a promote or demote does.
//! A virtual stream member is looked ahead too: it consumes its ring, so running dry would lose its
//! place.
//!
//! **The fallback.** If a starve the look-ahead missed (a pitch jump within the quantum) reaches the
//! starve path, [`on_starve`] (hook H2, at quantum end) holds the group from the next quantum: the
//! members are cut, but stay on one frame.
//!
//! **The hooks (H2, C2b's skeleton).** The starve path in `voices.rs` calls [`on_starve`]; every
//! gated member asks [`must_hold`] before rendering; `groups::begin_quantum` calls [`begin_started`]
//! for a started entry and, for a held one, [`try_resume`] with [`member_ready`], then
//! [`resume_members`].
//!
//! Owner: **C2c** (W6).

use crate::core::Core;
use crate::groups::{self, flag, state, GroupEntry};
use crate::stream::{phase, START_FRAMES, STARVE_FADE_SECONDS};
use crate::voices::{self, VoiceSlot};
use crate::QUANTUM;
use audio_dsp::ramp::Ramp;

/// [`GroupEntry::flags`] bit 4 (`groups::flag` takes bits 0–3): the hold's joint fade-out is under
/// way; the entry is STARTED and `held_frames` counts the fade's frames so far.
pub const FLAG_FADING: u8 = 1 << 4;

/// The hold's fade-out at `sample_rate`: the 5 ms starve fade (`STARVE_FADE_SECONDS`) rounded up to
/// whole quanta, so every member stops on one frame (256 frames at 44.1 and 48 kHz, 512 at 96 kHz).
pub fn hold_fade_frames(sample_rate: f32) -> u32 {
    let frames = libm::ceilf(STARVE_FADE_SECONDS * sample_rate).max(1.0) as u32;
    frames.div_ceil(QUANTUM as u32) * QUANTUM as u32
}

/// What a starving voice does ([`on_starve`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StarveAction {
    /// Starve alone, as today (ungated, or its group isn't started).
    Alone,
    /// Its group is held (or its joint fade is running): it fades and holds with the others.
    Group,
}

/// A member of the entry at `index` (`entries[index]`) would starve in the quantum at `frame`. Called
/// from the starve path in `voices.rs` (H2) at quantum end, once per starving member ring, every
/// quantum, so it is idempotent:
/// - a STARTED entry whose joint fade runs ([`FLAG_FADING`]), or a HELD one: nothing to do, `Group`;
/// - a STARTED entry the look-ahead missed: HELD from the next quantum (`held_frames` 0), counting
///   `groupsHeld` in `groups_held` (saturating), `Group`;
/// - otherwise (not a member, stamped, free): `Alone`.
pub fn on_starve(entries: &mut [GroupEntry], index: u8, voice_id: u32, frame: u64, groups_held: &mut u16) -> StarveAction {
    let _ = frame;
    let Some(e) = entries.get_mut(index as usize) else {
        return StarveAction::Alone;
    };
    if !e.has_member(voice_id) {
        return StarveAction::Alone;
    }
    match e.state {
        state::STARTED if e.flags & FLAG_FADING != 0 => StarveAction::Group,
        state::STARTED => {
            e.state = state::HELD;
            e.held_frames = 0;
            e.flags &= !flag::RESUMED;
            *groups_held = groups_held.saturating_add(1);
            StarveAction::Group
        }
        state::HELD => StarveAction::Group,
        _ => StarveAction::Alone,
    }
}

/// `true` while the entry at `index` is held: a gated member holds silent, position pinned.
#[inline]
pub fn must_hold(entries: &[GroupEntry], index: u8) -> bool {
    entries.get(index as usize).is_some_and(|e| e.state == state::HELD)
}

/// A held `entry` in the quantum at `frame`, `all_ready` when every member has ≥ 4,096 frames
/// buffered or its input ended ([`member_ready`]): resumes it (state STARTED, `start_frame` =
/// `frame`, `slip` the hold's length, the resume event pending, the late bit cleared) and returns
/// the slip (`held_frames`) for `group_rebase::apply` and `maxSlipFrames`; `None` while it stays held
/// (`held_frames` grows by the quantum, saturating) or when it isn't held.
pub fn try_resume(entry: &mut GroupEntry, frame: u64, all_ready: bool) -> Option<u32> {
    if entry.state != state::HELD {
        return None;
    }
    if !all_ready {
        entry.held_frames = entry.held_frames.saturating_add(QUANTUM as u32);
        return None;
    }
    let slip = entry.held_frames;
    entry.state = state::STARTED;
    entry.start_frame = frame;
    entry.slip = slip;
    entry.held_frames = 0;
    entry.flags &= !(flag::LATE | flag::ABANDONED | FLAG_FADING);
    entry.flags |= flag::RESUMED | flag::EVENT_PENDING;
    Some(slip)
}

/// `groups::begin_quantum` for the STARTED entry at `index`, before the voice loop of the quantum
/// at `frame`:
/// - its joint fade running: one more quantum faded; once the whole fade has run, the entry turns
///   HELD (`held_frames` 0: the hold starts at this frame) and this returns `true` (the caller goes
///   on as for a held entry); else the members' rings are steered on (see the module notes);
/// - else, when a stream member would starve within the fade plus this quantum: the joint fade
///   starts in every member at this frame ([`FLAG_FADING`], `groupsHeld` + 1).
///
/// Costs one look per stream member while the group plays.
pub fn begin_started(core: &mut Core, index: usize, frame: u64) -> bool {
    let _ = frame;
    let Some(&e) = groups::entries_of(core.regions().groups).get(index) else {
        return false;
    };
    if e.state != state::STARTED {
        return false;
    }
    let fade = hold_fade_frames(core.params().sample_rate);
    if e.flags & FLAG_FADING != 0 {
        let done = e.held_frames.saturating_add(QUANTUM as u32);
        let slot = &mut groups::entries(core.regions_mut().groups)[index];
        if done >= fade {
            slot.state = state::HELD;
            slot.flags &= !FLAG_FADING;
            slot.held_frames = 0;
            return true;
        }
        slot.held_frames = done;
        steer(core, &e, fade - done, false);
        return false;
    }
    let horizon = (fade + QUANTUM as u32) as f64;
    if !e.present_members().iter().any(|&v| would_starve(core, v, horizon)) {
        return false;
    }
    let slot = &mut groups::entries(core.regions_mut().groups)[index];
    slot.flags = (slot.flags | FLAG_FADING) & !flag::RESUMED;
    slot.held_frames = 0;
    crate::status::counters_mut(core).music.note_group_held();
    steer(core, &e, fade, true);
    false
}

/// Every stream member of `e`'s ring, through the joint fade's remaining `frames`: a ring short of
/// data `STARVING` (its own check quiet, no turn-round), one with data (or whose input ended)
/// `PLAYING`; its gain aimed at 0 over `frames` (at the fade's start, or again when something
/// turned it round). Rings waiting, starved or seeking are left alone.
fn steer(core: &mut Core, e: &GroupEntry, frames: u32, start: bool) {
    for &v in e.present_members() {
        let Some((slot, ring)) = member_ring(core, v) else {
            if start {
                voices::hold_fade(core, v, 0.0, frames);
            }
            continue;
        };
        let (position, slot_id) = (slot.position, slot.id);
        let r = core.streams_mut().ring_mut(ring);
        if r.voice != slot_id || r.seeking != 0 || (r.phase != phase::PLAYING && r.phase != phase::STARVING) {
            continue;
        }
        r.phase = if r.input_done() || buffered(r, position) >= START_FRAMES { phase::PLAYING } else { phase::STARVING };
        if start || r.gain.target != 0.0 {
            r.gain.set_target(0.0, frames);
        }
    }
}

/// Frames ring `r` holds ahead of a voice at `position` (as the stream branch of `voices.rs` reads it).
#[inline]
fn buffered(r: &crate::stream::Ring, position: f64) -> u64 {
    r.written.saturating_sub((position - r.start_frame as f64).max(0.0) as u64)
}

/// Group member `voice_id`'s slot and its bound ring, for a live stream voice.
fn member_ring(core: &Core, voice_id: u32) -> Option<(VoiceSlot, usize)> {
    let s = *voices::slots(core).get((voice_id & 0xFFFF) as usize)?;
    if voice_id == 0 || s.id != voice_id || s.flags & voices::flag::STREAM == 0 || !(s.state == voices::state::SCHEDULED || s.state == voices::state::PLAYING) {
        return None;
    }
    let ring = core.streams().index_of(s.clip).filter(|&i| core.streams().ring(i).voice == voice_id)?;
    Some((s, ring))
}

/// `true` when playing stream member `voice_id` (mixed or virtual) holds less than `horizon` frames
/// at its pitch: the voice's own check (`have < (n + 5 ms) × step`, `voices.rs`) with the hold's
/// horizon. A ring whose input ended, waiting, starving, starved or seeking doesn't count.
fn would_starve(core: &Core, voice_id: u32, horizon: f64) -> bool {
    let Some((s, ring)) = member_ring(core, voice_id) else { return false };
    let r = core.streams().ring(ring);
    if s.state != voices::state::PLAYING || r.phase != phase::PLAYING || r.input_done() || r.seeking != 0 {
        return false;
    }
    let have = r.written as f64 - 3.0 - (s.position - r.start_frame as f64);
    let step = (s.pitch.value.max(s.pitch.target) * s.rate_ratio) as f64;
    have < horizon * step
}

/// Group member `voice_id` is ready to resume a hold (architecture §4.3 "Held"): it is live and
/// decoded, or its ring holds ≥ 4,096 frames ahead of its pinned position, or its input ended. A
/// stream member not started yet takes the start's test (`voices::member_state`).
pub fn member_ready(core: &Core, voice_id: u32) -> bool {
    let m = voices::member_state(core, voice_id);
    if !m.present {
        return false;
    }
    match member_ring(core, voice_id) {
        Some((s, ring)) if s.state == voices::state::PLAYING => {
            let r = core.streams().ring(ring);
            r.input_done() || buffered(r, s.position) >= START_FRAMES
        }
        Some(_) => m.ready,
        None => voices::slots(core)[(voice_id & 0xFFFF) as usize].flags & voices::flag::STREAM == 0 || m.ready,
    }
}

/// The entry at `index` just resumed (`try_resume`): every stream member's ring plays again from its
/// pinned position with the 5 ms fade-in (`voices::mix_fade_frames`, the starve resume's).
pub fn resume_members(core: &mut Core, index: usize) {
    let Some(&e) = groups::entries_of(core.regions().groups).get(index) else { return };
    let frames = voices::mix_fade_frames(core);
    for &v in e.present_members() {
        let Some((_, ring)) = member_ring(core, v) else {
            voices::hold_fade(core, v, 1.0, frames);
            continue;
        };
        let r = core.streams_mut().ring_mut(ring);
        if r.seeking != 0 || r.phase == phase::WAITING {
            continue;
        }
        r.phase = phase::PLAYING;
        r.gain = Ramp::at(0.0);
        r.gain.set_target(1.0, frames);
    }
}
