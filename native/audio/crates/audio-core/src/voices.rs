//! Voice slots and the render loop (api-and-models §3, §4.2; architecture §2.2).
//!
//! The `Voices` region is viewed as `[VoiceSlot; max_logical]`. A voice id is
//! `gen << 16 | index` (api-and-models §3): the slot is `index`, and the slot keeps the whole id,
//! so a command whose generation differs from the slot's is dropped (a stale id).
//!
//! **Lifecycle in the core.** PLAY writes the slot at once (`Scheduled`, with the absolute frame it
//! starts at, or [`ASAP`]) and links it into the live list. A PLAY whose id has the slot's index but
//! another generation **replaces** the voice there (main's steal, A1.1): the old voice is reported
//! ended once and its generation's commands are dropped from then on. During `process` a scheduled
//! voice starts at its sample offset (asap: offset 0 of the first quantum after arrival; a stamped
//! frame already past: offset 0, counted late, from its start, architecture §4.4). A playing voice
//! reads its clip through the 4-point resampler (`resample::lagrange`, A3.6), multiplies by its gain and fade ramps and pans
//! through its [`PannerState`]. A virtual voice (PLAY flag `mixed` clear) keeps time without
//! rendering. A voice ends when a non-looping clip runs out, when STOP lands (fade 0), or when a
//! fade with "stop at end" finishes. Ended voices are reported in STATUS `ended` (K12) and their slot
//! is freed; when the block's `ended` list is full the rest wait in `Ended` for the next quantum
//! (carried, §4.3).
//!
//! Live voices form an intrusive doubly linked list through the slots (indices + 1, 0 = none), so a
//! quantum touches only live slots. The list head and per-quantum scratch live in [`VoiceArea`], in
//! the core-state region right after the status area (`status::STATUS_AREA_BYTES`).
//!
//! Each voice mixes into its bus's input buffer (`bus.rs`, A2.1; an unconfigured bus index goes to
//! bus 0, the root). Not applied yet: `lpHz` (kept for the per-voice filter), SET_PAUSED.
//!
//! **Mixed and virtual** (A3.1; architecture §2.2, §4.7 "promote and demote 5 ms"). Main's selection
//! decides which voices are mixed and sends SET_MIXED for changes ([`set_mixed`]); the adaptive cap
//! (A3.3) demotes through [`demote`] / [`demote_lowest`], which report the ids in STATUS `demoted`.
//! Both ride one per-voice `mix` ramp on top of the gain and fade:
//! - **Demote** (mixed to virtual): `mix` ramps to 0 over [`MIX_FADE_SECONDS`] while the voice still
//!   renders (flag `DEMOTING`); when it settles the voice stops rendering (`MIXED` clear) and keeps
//!   time like any virtual voice.
//! - **Promote** (virtual to mixed): the voice renders again from where its playhead is, its gain,
//!   direction and `lpHz` set at once from the record (it is silent there), `mix` ramping from 0 to 1
//!   over the same 5 ms. A voice still fading out turns round from where its `mix` is, its gain and
//!   direction ramping over the 5 ms instead.
//! - A voice that hasn't started yet (`Scheduled`) changes at once with no fade: it starts mixed at
//!   its gain (a clean onset), or virtual.
//!
//! `process` never allocates: every buffer is a region or a fixed-size stack array.

use audio_dsp::ramp::Ramp;
use audio_dsp::resample;
use audio_wire::generated as wire;

use crate::clips::ClipStore;
use crate::core::{Core, Regions};
use crate::counters::{Playhead, ENDED_CAP, PLAYHEADS_CAP};
use crate::layout::VOICE_SLOT_BYTES;
use crate::panner::PannerState;
use crate::{status, QUANTUM};

/// `start_frame` of a voice that starts at the first quantum after its PLAY arrived.
pub const ASAP: u64 = u64::MAX;

/// Slot states. 0 is free, so a zeroed region is all free slots.
pub mod state {
    pub const FREE: u8 = 0;
    /// PLAY applied; waiting for `start_frame`.
    pub const SCHEDULED: u8 = 1;
    pub const PLAYING: u8 = 2;
    /// Finished; waiting to be reported in STATUS `ended`, then freed.
    pub const ENDED: u8 = 3;
}

/// Slot flag bits.
pub mod flag {
    pub const LOOP: u8 = 1 << 0;
    /// Rendered (mixed); clear means virtual.
    pub const MIXED: u8 = 1 << 1;
    pub const WANTS_PLAYHEAD: u8 = 1 << 2;
    /// Set by FADE with "stop at end" and by STOP with a fade: the voice ends when `fade` settles.
    pub const STOP_ON_FADE_END: u8 = 1 << 3;
    pub const PAUSED: u8 = 1 << 4;
    /// Mixed and fading out to virtual: `MIXED` clears when the `mix` ramp settles at 0.
    pub const DEMOTING: u8 = 1 << 5;
}

/// The promote and demote fade (architecture §4.7: "promote and demote 5 ms").
pub const MIX_FADE_SECONDS: f32 = 0.005;

/// One logical voice. `#[repr(C)]`, all-zero is a free slot, at most `VOICE_SLOT_BYTES`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct VoiceSlot {
    /// The voice id (`gen << 16 | index`); 0 when free.
    pub id: u32,
    /// The clip id.
    pub clip: u32,
    /// [`state`].
    pub state: u8,
    /// [`flag`] bits.
    pub flags: u8,
    /// Bus index: the voice mixes into this bus (`bus.rs`; past the configured buses, bus 0).
    pub bus: u16,
    /// Live list links: slot index + 1, 0 = none.
    pub next: u32,
    pub prev: u32,
    /// Clip rate / context rate, set at PLAY. (Here, before the 8-byte fields, so the slot packs
    /// into `VOICE_SLOT_BYTES` with the `mix` ramp.)
    pub rate_ratio: f32,
    /// Absolute context frame to start at, or [`ASAP`].
    pub start_frame: u64,
    /// Read position in clip frames.
    pub position: f64,
    /// PLAY / SET_PARAMS `lpHz`, kept for the per-voice filter (not applied yet).
    pub lp_hz: f32,
    /// PLAY / SET_PARAMS `score` (the adaptive cap's ranking, A3.3).
    pub score: f32,
    pub gain: Ramp,
    pub pitch: Ramp,
    /// FADE and STOP-with-fade; starts at 1.
    pub fade: Ramp,
    /// Mixed or virtual (A3.1): 1 while mixed, 0 while virtual, ramping between them over
    /// [`MIX_FADE_SECONDS`] on a promote or demote of a started voice.
    pub mix: Ramp,
    pub panner: PannerState,
}

const _: () = assert!(core::mem::size_of::<VoiceSlot>() <= VOICE_SLOT_BYTES, "a voice slot fits its layout size");
const _: () = assert!(core::mem::align_of::<VoiceSlot>() <= crate::layout::REGION_ALIGN);

/// Most ended voices moved to STATUS per quantum (the block's list holds `counters::ENDED_CAP`).
pub const ENDED_SCRATCH: usize = 1_024;

/// The voices' scalars in the core-state region, after the status area. All-zero is valid.
#[repr(C)]
pub struct VoiceArea {
    /// Live list head: slot index + 1, 0 = empty.
    pub live_head: u32,
    /// Slots not free.
    pub live_count: u32,
    /// Live voices rendered in the last quantum.
    pub mixed_count: u32,
    /// Stamped records applied late since the last report, and the most late (frames).
    pub late_count: u32,
    pub late_max: u32,
    /// Round-robin cursor over `wantsPlayhead` voices (a count into the live list).
    pub playhead_cursor: u32,
    /// Ended ids moved out of their slots this quantum, reported right after the render.
    pub ended_len: u32,
    pub ended: [u32; ENDED_SCRATCH],
    /// Playheads gathered this quantum (round-robin), reported right after the render.
    pub playheads_len: u32,
    pub playheads: [Playhead; PLAYHEADS_CAP],
}

/// Offset of [`VoiceArea`] in the core-state region.
pub const VOICE_AREA_OFFSET: usize = crate::status::STATUS_AREA_BYTES;
/// Bytes it takes, rounded to a region alignment. The scheduler's area follows.
pub const VOICE_AREA_BYTES: usize = (core::mem::size_of::<VoiceArea>() + crate::layout::REGION_ALIGN - 1) / crate::layout::REGION_ALIGN * crate::layout::REGION_ALIGN;

const _: () = assert!(
    VOICE_AREA_OFFSET + VOICE_AREA_BYTES + core::mem::size_of::<crate::scheduler::SchedulerArea>() <= crate::layout::CORE_STATE_BYTES,
    "the voices' and scheduler's areas fit the core-state region"
);

/// The slots and the voices' area, borrowed together from the regions.
struct View<'a> {
    slots: &'a mut [VoiceSlot],
    area: &'a mut VoiceArea,
}

fn view(regions: &mut Regions) -> View<'_> {
    let count = regions.voices.len() / VOICE_SLOT_BYTES;
    let state = &mut regions.core_state[VOICE_AREA_OFFSET..VOICE_AREA_OFFSET + VOICE_AREA_BYTES];
    // SAFETY: both regions are 64-byte aligned (Layout) and zeroed at init; all-zero bytes are a
    // valid VoiceSlot and VoiceArea (integers, floats and arrays of them). `count` slots of
    // size_of::<VoiceSlot>() <= VOICE_SLOT_BYTES fit the region; VOICE_AREA_OFFSET is a multiple of
    // REGION_ALIGN and the area fits (asserted above). The two slices are distinct regions. Only
    // this module views these bytes.
    unsafe {
        View {
            slots: core::slice::from_raw_parts_mut(regions.voices.as_mut_ptr() as *mut VoiceSlot, count),
            area: &mut *(state.as_mut_ptr() as *mut VoiceArea),
        }
    }
}

/// The slots, viewed over the `Voices` region (`max_logical` of them).
pub fn slots(core: &Core) -> &[VoiceSlot] {
    let bytes: &[u8] = &core.regions().voices[..];
    // SAFETY: as in `view`.
    unsafe { core::slice::from_raw_parts(bytes.as_ptr() as *const VoiceSlot, bytes.len() / VOICE_SLOT_BYTES) }
}

/// Live voices (slots not free).
pub fn live_count(core: &mut Core) -> u32 {
    view(core.regions_mut()).area.live_count
}

fn link(v: &mut View<'_>, index: usize) {
    let head = v.area.live_head;
    v.slots[index].prev = 0;
    v.slots[index].next = head;
    if head != 0 {
        v.slots[head as usize - 1].prev = index as u32 + 1;
    }
    v.area.live_head = index as u32 + 1;
    v.area.live_count += 1;
}

fn unlink_and_free(v: &mut View<'_>, index: usize) {
    let (prev, next) = (v.slots[index].prev, v.slots[index].next);
    if prev != 0 {
        v.slots[prev as usize - 1].next = next;
    } else {
        v.area.live_head = next;
    }
    if next != 0 {
        v.slots[next as usize - 1].prev = prev;
    }
    v.slots[index] = VoiceSlot::default();
    v.area.live_count -= 1;
}

/// The slot index of a voice that is exactly `voice_id` and not ended, or `None` (stale).
fn find(v: &View<'_>, voice_id: u32) -> Option<usize> {
    let index = (voice_id & 0xFFFF) as usize;
    let s = v.slots.get(index)?;
    (voice_id != 0 && s.id == voice_id && (s.state == state::SCHEDULED || s.state == state::PLAYING)).then_some(index)
}

/// Renders one quantum at context frame `frame` into the output region (called by
/// `Core::process`): applies the scheduler's records due in this quantum at their sample offsets,
/// renders every live voice, then reports ended voices, late records, the live and mixed counts
/// and playheads through the counters (K12). Never allocates.
pub fn render(core: &mut Core, frame: u64) {
    let end = frame + QUANTUM as u64;
    core.regions_mut().output[..2 * QUANTUM].fill(0.0);
    let mut cursor = 0usize;
    while let Some(record) = crate::scheduler::pop_due(core, end) {
        let offset = if record.frame < frame {
            note_late(core, frame - record.frame);
            0
        } else {
            (record.frame - frame) as usize
        };
        if offset > cursor {
            render_range(core, frame, cursor, offset);
            cursor = offset;
        }
        crate::scheduler::apply(core, &record);
    }
    if cursor < QUANTUM {
        render_range(core, frame, cursor, QUANTUM);
    }
    report(core);
}

fn note_late(core: &mut Core, lateness: u64) {
    let area = view(core.regions_mut()).area;
    area.late_count += 1;
    area.late_max = area.late_max.max(lateness.min(u32::MAX as u64) as u32);
}

/// Renders every live voice over frames `from..to` of the quantum at `frame`, each into its bus's
/// input buffer (A2.1; `bus::mixdown` mixes the buses into the output after the last range).
fn render_range(core: &mut Core, frame: u64, from: usize, to: usize) {
    let (regions, clips) = core.parts_mut();
    // The buses' buffers are the `Buses` region, distinct from the voices and core-state regions
    // `v` views (Layout); `Inputs` holds a raw view of them and reads the bus count first.
    let mut inputs = crate::bus::Inputs::of(regions);
    let v = view(regions);
    let mut cursor = v.area.live_head;
    while cursor != 0 {
        let index = cursor as usize - 1;
        cursor = v.slots[index].next;
        let slot = &mut v.slots[index];
        let start = match slot.state {
            state::SCHEDULED => {
                let start = if slot.start_frame == ASAP {
                    from
                } else if slot.start_frame < frame + from as u64 {
                    if slot.start_frame < frame {
                        let lateness = (frame - slot.start_frame).min(u32::MAX as u64) as u32;
                        v.area.late_count += 1;
                        v.area.late_max = v.area.late_max.max(lateness);
                    }
                    from
                } else if slot.start_frame < frame + to as u64 {
                    (slot.start_frame - frame) as usize
                } else {
                    continue;
                };
                slot.state = state::PLAYING;
                start
            }
            state::PLAYING => from,
            _ => continue,
        };
        let Some((out_l, out_r)) = inputs.get(slot.bus) else { continue };
        render_voice(slot, clips, start, to, out_l, out_r);
    }
}

/// Renders one playing voice over frames `from..to` (mixed) or keeps its time (virtual), and ends
/// it when its clip runs out or its stopping fade settles.
fn render_voice(slot: &mut VoiceSlot, clips: &ClipStore, from: usize, to: usize, out_l: &mut [f32], out_r: &mut [f32]) {
    if slot.flags & flag::PAUSED != 0 {
        return;
    }
    let Some(clip) = clips.frames(slot.clip) else {
        slot.state = state::ENDED;
        return;
    };
    let stopping = slot.flags & flag::STOP_ON_FADE_END != 0;
    if stopping && slot.fade.is_settled() {
        slot.state = state::ENDED;
        return;
    }
    let mut n = to - from;
    if stopping {
        // Render only up to the end of the stopping fade.
        n = n.min(slot.fade.remaining as usize);
    }
    let looping = slot.flags & flag::LOOP != 0;
    let mut steps = [0.0f32; QUANTUM];
    for step in steps[..n].iter_mut() {
        *step = slot.pitch.next() * slot.rate_ratio;
    }
    if slot.flags & flag::MIXED != 0 {
        let mut l = [0.0f32; QUANTUM];
        let mut r = [0.0f32; QUANTUM];
        resample::lagrange(&clip.source, &mut slot.position, &steps[..n], looping, &mut l[..n], &mut r[..n]);
        if slot.mix.is_settled() && slot.mix.value == 1.0 {
            for i in 0..n {
                let g = slot.gain.next() * slot.fade.next();
                l[i] *= g;
                r[i] *= g;
            }
        } else {
            // A promote or demote under way (A3.1): the mix ramp on top of the gain and fade.
            for i in 0..n {
                let g = slot.gain.next() * slot.fade.next() * slot.mix.next();
                l[i] *= g;
                r[i] *= g;
            }
        }
        slot.panner.mix(&l[..n], &r[..n], &mut out_l[from..from + n], &mut out_r[from..from + n]);
        if slot.flags & flag::DEMOTING != 0 && slot.mix.is_settled() {
            // The demote fade is done: virtual from the next frame, keeping time.
            slot.flags &= !(flag::MIXED | flag::DEMOTING);
        }
    } else {
        resample::advance(&mut slot.position, &steps[..n], clip.source.frames, looping);
        slot.gain.advance(n as u32);
        slot.fade.advance(n as u32);
        slot.mix.advance(n as u32);
        slot.panner.advance(n as u32);
    }
    let ran_out = !looping && slot.position >= clip.source.frames as f64;
    if ran_out || (stopping && slot.fade.is_settled()) {
        slot.state = state::ENDED;
    }
}

/// After the render: frees ended voices into STATUS `ended` (as many as the block has room for),
/// gathers playheads round-robin, and sets the live and mixed counts and the late records.
fn report(core: &mut Core) {
    let room = (ENDED_CAP - status::counters(core).ended.len()).min(ENDED_SCRATCH);
    let (live, mixed, ended, playheads, late_count, late_max) = {
        let mut v = view(core.regions_mut());
        v.area.ended_len = 0;
        let mut mixed = 0u32;
        let mut wants = 0u32;
        let mut cursor = v.area.live_head;
        while cursor != 0 {
            let index = cursor as usize - 1;
            cursor = v.slots[index].next;
            let s = v.slots[index];
            match s.state {
                state::ENDED => {
                    if (v.area.ended_len as usize) < room {
                        let at = v.area.ended_len as usize;
                        v.area.ended[at] = s.id;
                        v.area.ended_len += 1;
                        unlink_and_free(&mut v, index);
                    }
                }
                state::PLAYING => {
                    if s.flags & flag::MIXED != 0 {
                        mixed += 1;
                    }
                    if s.flags & flag::WANTS_PLAYHEAD != 0 {
                        wants += 1;
                    }
                }
                _ => {}
            }
        }
        gather_playheads(&mut v, wants);
        let late = (v.area.late_count, v.area.late_max);
        v.area.late_count = 0;
        v.area.late_max = 0;
        v.area.mixed_count = mixed;
        (v.area.live_count, mixed, v.area.ended_len as usize, v.area.playheads_len as usize, late.0, late.1)
    };
    for i in 0..ended {
        let id = view(core.regions_mut()).area.ended[i];
        status::counters_mut(core).ended.push(id);
    }
    status::counters_mut(core).playheads.clear();
    for i in 0..playheads {
        let p = view(core.regions_mut()).area.playheads[i];
        status::counters_mut(core).playheads.push(p);
    }
    let c = status::counters_mut(core);
    for _ in 0..late_count {
        c.note_late(late_max);
    }
    c.live_voices = live.min(u16::MAX as u32) as u16;
    c.mixed_voices = mixed.min(u16::MAX as u32) as u16;
}

/// Up to `PLAYHEADS_CAP` playing `wantsPlayhead` voices, starting after the cursor's count and
/// wrapping, so every such voice is reported in turn when more than fit.
fn gather_playheads(v: &mut View<'_>, wants: u32) {
    v.area.playheads_len = 0;
    if wants == 0 {
        v.area.playhead_cursor = 0;
        return;
    }
    let skip = if wants as usize <= PLAYHEADS_CAP { 0 } else { v.area.playhead_cursor % wants };
    let take = (wants as usize).min(PLAYHEADS_CAP);
    let mut taken = 0usize;
    // Two passes over the live list: from the `skip`th such voice to the end, then from the start.
    for pass in 0..2 {
        let mut cursor = v.area.live_head;
        let mut k = 0u32;
        while cursor != 0 && taken < take {
            let index = cursor as usize - 1;
            cursor = v.slots[index].next;
            let s = &v.slots[index];
            if s.state != state::PLAYING || s.flags & flag::WANTS_PLAYHEAD == 0 {
                continue;
            }
            let in_pass = if pass == 0 { k >= skip } else { k < skip };
            k += 1;
            if in_pass {
                v.area.playheads[taken] = Playhead { id: s.id, clip_frame: s.position as u32 };
                taken += 1;
            }
        }
    }
    v.area.playheads_len = taken as u32;
    v.area.playhead_cursor = (skip + taken as u32) % wants;
}

/// PLAY (api-and-models §4.2): writes the slot for `play.voice_id` and links it live, to start at
/// `start_frame` (absolute, or [`ASAP`]). A slot still holding an older voice is taken over and
/// that voice is reported ended (A1.1's steal: same index, new generation; the old generation's
/// commands are dropped from then on). An index past `max_logical` or a zero generation is dropped.
pub fn play(core: &mut Core, play: &wire::Play, start_frame: u64) {
    let index = (play.voice_id & 0xFFFF) as usize;
    if play.voice_id >> 16 == 0 {
        return;
    }
    let sample_rate = core.params().sample_rate;
    let (channels, clip_rate) = core.clips().frames(play.clip).map_or((1, sample_rate), |c| (c.source.channels, c.sample_rate));
    let replaced = {
        let mut v = view(core.regions_mut());
        if index >= v.slots.len() {
            return;
        }
        let old = v.slots[index];
        if old.state == state::FREE {
            link(&mut v, index);
        }
        let s = &mut v.slots[index];
        let mut flags = 0u8;
        if play.flags & wire::PLAY_FLAGS_LOOP != 0 {
            flags |= flag::LOOP;
        }
        if play.flags & wire::PLAY_FLAGS_MIXED != 0 {
            flags |= flag::MIXED;
        }
        if play.flags & wire::PLAY_FLAGS_WANTS_PLAYHEAD != 0 {
            flags |= flag::WANTS_PLAYHEAD;
        }
        s.id = play.voice_id;
        s.clip = play.clip;
        s.state = state::SCHEDULED;
        s.flags = flags;
        s.bus = play.bus;
        s.start_frame = start_frame;
        s.position = play.start_offset_frames as f64;
        s.rate_ratio = clip_rate / sample_rate;
        s.lp_hz = play.lp_hz;
        s.score = play.score;
        s.gain = Ramp::at(play.gain);
        s.pitch = Ramp::at(play.pitch);
        s.fade = Ramp::at(1.0);
        s.mix = Ramp::at(if flags & flag::MIXED != 0 { 1.0 } else { 0.0 });
        let spatial = play.flags & wire::PLAY_FLAGS_SPATIAL != 0;
        let kind = ((play.flags & wire::PLAY_FLAGS_PANNER_MASK) >> wire::PLAY_FLAGS_PANNER_SHIFT) as u8;
        s.panner.start(spatial, kind, [play.dir_x, play.dir_y, play.dir_z], channels);
        (old.state != state::FREE && old.id != play.voice_id).then_some(old.id)
    };
    if let Some(old) = replaced {
        status::counters_mut(core).ended.push(old);
    }
}

/// STOP: `fade_frames == 0` ends the voice now; otherwise its fade ramps to 0 over `fade_frames`
/// and it ends when the fade settles. A voice that hasn't started yet ends now. A stale id is
/// dropped.
pub fn stop(core: &mut Core, voice_id: u32, fade_frames: u32) {
    let v = view(core.regions_mut());
    let Some(index) = find(&v, voice_id) else { return };
    let s = &mut v.slots[index];
    if fade_frames == 0 || s.state == state::SCHEDULED {
        s.state = state::ENDED;
    } else {
        s.fade.set_target(0.0, fade_frames);
        s.flags |= flag::STOP_ON_FADE_END;
    }
}

/// SET_PARAMS: applies the masked fields; gain, pitch and direction ramp over `ramp_frames`.
pub fn set_params(core: &mut Core, p: &wire::SetParams) {
    let v = view(core.regions_mut());
    let Some(index) = find(&v, p.voice_id) else { return };
    let s = &mut v.slots[index];
    if p.mask & wire::SET_PARAMS_MASK_GAIN != 0 {
        s.gain.set_target(p.gain, p.ramp_frames);
    }
    if p.mask & wire::SET_PARAMS_MASK_PITCH != 0 {
        s.pitch.set_target(p.pitch, p.ramp_frames);
    }
    if p.mask & wire::SET_PARAMS_MASK_DIR != 0 {
        s.panner.set_direction([p.dir_x, p.dir_y, p.dir_z], p.ramp_frames);
    }
    if p.mask & wire::SET_PARAMS_MASK_LP_HZ != 0 {
        s.lp_hz = p.lp_hz;
    }
    if p.mask & wire::SET_PARAMS_MASK_SCORE != 0 {
        s.score = p.score;
    }
    if p.mask & wire::SET_PARAMS_MASK_BUS != 0 {
        s.bus = p.bus.min(u16::MAX as u32) as u16;
    }
    if p.mask & wire::SET_PARAMS_MASK_FLAGS != 0 {
        s.panner.set_kind(((p.flags & wire::SET_PARAMS_FLAGS_PANNER_MASK) >> wire::SET_PARAMS_FLAGS_PANNER_SHIFT) as u8);
    }
}

/// FADE: the fade ramps to `target` over `frames`; with `stop_at_end`, the voice ends when it
/// settles (at once for `frames == 0` or a voice not started yet). A stop under way stays a stop.
pub fn fade(core: &mut Core, voice_id: u32, target: f32, frames: u32, stop_at_end: bool) {
    let v = view(core.regions_mut());
    let Some(index) = find(&v, voice_id) else { return };
    let s = &mut v.slots[index];
    if stop_at_end && (frames == 0 || s.state == state::SCHEDULED) {
        s.state = state::ENDED;
        return;
    }
    s.fade.set_target(target, frames);
    if stop_at_end {
        s.flags |= flag::STOP_ON_FADE_END;
    }
}

/// The promote and demote fade in frames at the core's rate (5 ms, at least 1 frame).
pub fn mix_fade_frames(core: &Core) -> u32 {
    let frames = libm::roundf(MIX_FADE_SECONDS * core.params().sample_rate);
    if frames < 1.0 {
        1
    } else {
        frames as u32
    }
}

/// SET_MIXED (api-and-models §4.2, A3.1): main's selection promotes (`mixed`) or demotes a voice;
/// see the module notes for the fades. `gain`, `dir` and `lp_hz` are the voice's current
/// parameters, applied on a promote (main sends no SET_PARAMS to virtual voices). A stale id is
/// dropped; a voice already in the asked state only takes the parameters (a promote) or nothing.
/// Never reported in `demoted`: main asked for it.
pub fn set_mixed(core: &mut Core, m: &wire::SetMixed) {
    let frames = mix_fade_frames(core);
    let v = view(core.regions_mut());
    let Some(index) = find(&v, m.voice_id) else { return };
    let s = &mut v.slots[index];
    if m.mixed != 0 {
        promote_slot(s, m.gain, [m.dir_x, m.dir_y, m.dir_z], m.lp_hz, frames);
    } else {
        demote_slot(s, frames);
    }
}

fn promote_slot(s: &mut VoiceSlot, gain: f32, dir: [f32; 3], lp_hz: f32, frames: u32) {
    s.lp_hz = lp_hz;
    if s.state == state::SCHEDULED {
        // Not started: start mixed at its gain, no fade (a clean onset).
        s.flags = (s.flags | flag::MIXED) & !flag::DEMOTING;
        s.mix = Ramp::at(1.0);
        s.gain = Ramp::at(gain);
        s.panner.set_direction(dir, 0);
        return;
    }
    if s.flags & flag::MIXED == 0 {
        // Virtual: silent here, so the parameters jump and the mix fades in from 0. The panner's
        // state restarts at the new direction (promotion resets filter state, architecture §2.2).
        s.flags |= flag::MIXED;
        s.mix = Ramp::at(0.0);
        s.mix.set_target(1.0, frames);
        s.gain = Ramp::at(gain);
        s.panner.set_direction(dir, 0);
    } else {
        // Mixed, perhaps fading out: turn round from where it is, ramping the parameters.
        s.flags &= !flag::DEMOTING;
        if !(s.mix.is_settled() && s.mix.value == 1.0) {
            s.mix.set_target(1.0, frames);
        }
        s.gain.set_target(gain, frames);
        s.panner.set_direction(dir, frames);
    }
}

/// Starts slot `s`'s demote; returns whether it was mixed (and not already fading out).
fn demote_slot(s: &mut VoiceSlot, frames: u32) -> bool {
    if s.flags & flag::MIXED == 0 || s.flags & flag::DEMOTING != 0 {
        return false;
    }
    if s.state == state::SCHEDULED {
        s.flags &= !flag::MIXED;
        s.mix = Ramp::at(0.0);
    } else {
        s.flags |= flag::DEMOTING;
        s.mix.set_target(0.0, frames);
    }
    true
}

/// The core's own demote (architecture §6.3; for A3.3's adaptive cap): `voice_id` fades to virtual
/// over 5 ms and is reported in STATUS `demoted` so main's table follows. Returns false for a stale
/// id, a voice already virtual or fading out, or a full `demoted` list (nothing changes then; the
/// caller retries next quantum).
pub fn demote(core: &mut Core, voice_id: u32) -> bool {
    if status::counters(core).demoted.is_full() {
        return false;
    }
    let frames = mix_fade_frames(core);
    let changed = {
        let v = view(core.regions_mut());
        let Some(index) = find(&v, voice_id) else { return false };
        demote_slot(&mut v.slots[index], frames)
    };
    if changed {
        status::counters_mut(core).demoted.push(voice_id);
    }
    changed
}

/// Mixed voices that aren't fading out (what counts against a mixed cap).
pub fn mixed_live(core: &mut Core) -> u32 {
    let v = view(core.regions_mut());
    let mut n = 0;
    let mut cursor = v.area.live_head;
    while cursor != 0 {
        let s = &v.slots[cursor as usize - 1];
        cursor = s.next;
        if (s.state == state::SCHEDULED || s.state == state::PLAYING) && s.flags & flag::MIXED != 0 && s.flags & flag::DEMOTING == 0 {
            n += 1;
        }
    }
    n
}

/// Demotes the lowest-`score` mixed voices until at most `keep` remain mixed (architecture §6.3:
/// "the core demotes the lowest-`score` mixed voices"), each through [`demote`]. Returns how many
/// it demoted. O(demoted × live); the adaptive cap (A3.3) calls it rarely and with small excesses.
pub fn demote_lowest(core: &mut Core, keep: u32) -> u32 {
    let mut excess = mixed_live(core).saturating_sub(keep);
    let mut demoted = 0;
    while excess > 0 {
        let victim = {
            let v = view(core.regions_mut());
            let mut best: Option<(f32, u32)> = None;
            let mut cursor = v.area.live_head;
            while cursor != 0 {
                let s = &v.slots[cursor as usize - 1];
                cursor = s.next;
                if (s.state == state::SCHEDULED || s.state == state::PLAYING) && s.flags & flag::MIXED != 0 && s.flags & flag::DEMOTING == 0 && best.is_none_or(|(score, _)| s.score < score) {
                    best = Some((s.score, s.id));
                }
            }
            best
        };
        let Some((_, id)) = victim else { break };
        if !demote(core, id) {
            break;
        }
        demoted += 1;
        excess -= 1;
    }
    demoted
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::layout::{Layout, PAGE_BYTES};
    use crate::InitParams;

    /// A small core over a zeroed, page-aligned, leaked block.
    pub(crate) fn core() -> Core {
        let p = InitParams { sample_rate: 48_000.0, max_logical: 16, max_mixed: 8, max_buses: 4, arena_initial_bytes: 0 };
        let layout = Layout::new(&p);
        let l = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
        // SAFETY: non-zero size, zeroed, page-aligned, leaked on purpose.
        unsafe { Core::new(p, layout, std::alloc::alloc_zeroed(l)) }
    }

    fn play_rec(id: u32, clip: u32) -> wire::Play {
        wire::Play { voice_id: id, clip, flags: wire::PLAY_FLAGS_MIXED | wire::PLAY_FLAGS_LOOP, gain: 1.0, pitch: 1.0, dir_z: -1.0, ..Default::default() }
    }

    fn live_ids(core: &mut Core) -> Vec<u32> {
        let v = view(core.regions_mut());
        let mut out = vec![];
        let mut c = v.area.live_head;
        while c != 0 {
            out.push(v.slots[c as usize - 1].id);
            c = v.slots[c as usize - 1].next;
        }
        out
    }

    #[test]
    fn a_zeroed_region_is_all_free_slots() {
        let core = core();
        assert_eq!(slots(&core).len(), 16);
        assert!(slots(&core).iter().all(|s| s.state == state::FREE && s.id == 0));
    }

    #[test]
    fn stale_ids_are_dropped() {
        let mut core = core();
        play(&mut core, &play_rec(0x0001_0002, 1), ASAP);
        stop(&mut core, 0x0002_0002, 0);
        fade(&mut core, 0x0003_0002, 0.0, 0, true);
        assert_eq!(slots(&core)[2].state, state::SCHEDULED, "commands for another generation are dropped");
        play(&mut core, &play_rec(0x0000_0003, 1), ASAP);
        play(&mut core, &play_rec(0x0001_00FF, 1), ASAP);
        assert_eq!(live_ids(&mut core), vec![0x0001_0002], "gen 0 and out-of-range indices are dropped");
    }

    /// A1.1's stealing contract: main reuses the victim's index with a bumped generation, and the
    /// new PLAY replaces the old voice; the old generation's commands are dropped from then on.
    #[test]
    fn a_play_with_a_new_generation_replaces_the_voice_in_its_slot() {
        let mut core = core();
        play(&mut core, &play_rec(0x0001_0003, 1), ASAP);
        play(&mut core, &play_rec(0x0002_0003, 2), ASAP);
        assert_eq!(live_ids(&mut core), vec![0x0002_0003], "one voice in the slot");
        assert_eq!(slots(&core)[3].clip, 2);
        assert_eq!(status::counters(&core).ended.as_slice(), &[0x0001_0003], "the old voice is reported ended once");
        stop(&mut core, 0x0001_0003, 0);
        assert_eq!(slots(&core)[3].state, state::SCHEDULED, "the old generation's STOP is dropped");
        stop(&mut core, 0x0002_0003, 0);
        assert_eq!(slots(&core)[3].state, state::ENDED);
    }

    #[test]
    fn the_live_list_links_and_unlinks() {
        let mut core = core();
        for i in 1..=4 {
            play(&mut core, &play_rec(0x0001_0000 | i, 1), ASAP);
        }
        assert_eq!(live_ids(&mut core), vec![0x0001_0004, 0x0001_0003, 0x0001_0002, 0x0001_0001]);
        let mut v = view(core.regions_mut());
        unlink_and_free(&mut v, 3);
        unlink_and_free(&mut v, 1);
        assert_eq!(v.area.live_count, 2);
        assert_eq!(live_ids(&mut core), vec![0x0001_0004, 0x0001_0002]);
        let mut v = view(core.regions_mut());
        unlink_and_free(&mut v, 4);
        unlink_and_free(&mut v, 2);
        assert_eq!((v.area.live_head, v.area.live_count), (0, 0));
    }

    #[test]
    fn a_full_ended_list_carries_voices_to_the_next_quantum() {
        let mut core = core();
        play(&mut core, &play_rec(0x0001_0001, 1), ASAP);
        play(&mut core, &play_rec(0x0001_0002, 1), ASAP);
        stop(&mut core, 0x0001_0001, 0);
        stop(&mut core, 0x0001_0002, 0);
        for i in 0..ENDED_CAP - 1 {
            status::counters_mut(&mut core).ended.push(0xF000_0000 + i as u32);
        }
        report(&mut core);
        assert!(status::counters(&core).ended.is_full());
        assert_eq!(live_count(&mut core), 1, "one voice waits in Ended");
        status::counters_mut(&mut core).end_block();
        report(&mut core);
        assert_eq!(status::counters(&core).ended.len(), 1);
        assert_eq!(live_count(&mut core), 0);
        assert_eq!(status::counters(&core).live_voices, 0);
    }
}
