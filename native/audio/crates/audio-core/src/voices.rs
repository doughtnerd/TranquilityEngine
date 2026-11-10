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
//! through its [`PannerState`] (equal-power, or HRTF for the voices main flags, H3: their HRTF half
//! is panned per quantum by `panner::flush` after every voice rendered). A virtual voice (PLAY flag `mixed` clear) keeps time without
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
//! bus 0, the root). Not applied yet: `lpHz` (kept for the per-voice filter).
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
//! **Paused** (A3.7; api-and-models §4.2 SET_PAUSED; architecture §2.2: "Paused: the playhead
//! holds", "Paused --> Virtual: resume, then selection"). [`set_paused`]:
//! - A paused voice neither renders nor advances: its position, ramps and panner hold exactly.
//! - A mixed voice fades out first, over the same 5 ms `mix` ramp as a demote (flag `PAUSING`), so
//!   there is no click; it renders and advances during those 5 ms, then holds at the frame the fade
//!   ended on, out of the mix (`MIXED` clear). A virtual voice holds at once. A voice already
//!   fading out to virtual finishes that fade, then holds.
//! - Resume makes a held voice virtual from that same frame; main's selection, in the same batch,
//!   promotes it (a 5 ms fade-in from the held frame) or leaves it virtual (keeping time from there).
//!   A resume during the 5 ms fade-out turns the fade round (main hasn't demoted it), unless a
//!   SET_MIXED 0 arrived meanwhile, which the fade then completes.
//! - A voice not started yet doesn't start while paused; resumed after its start frame has passed,
//!   it starts at once (not counted late).
//! - STOP, or FADE with "stop at end", ends a held voice at the next quantum (it is silent). The
//!   cap's own demote and its counts leave paused voices out (they are already leaving the mix);
//!   main never promotes a paused voice (selection forces it virtual), and a promote while paused is
//!   dropped. RESET and a new PLAY in the slot clear the pause.
//!
//! `process` never allocates: every buffer is a region or a fixed-size stack array.

use audio_dsp::ramp::Ramp;
use audio_dsp::resample;
use audio_wire::generated as wire;

use crate::automation::{self, VoiceAuto};
use crate::clips::ClipStore;
use crate::core::{Core, Regions};
use crate::counters::{Playhead, ENDED_CAP, PLAYHEADS_CAP};
use crate::layout::VOICE_SLOT_BYTES;
use crate::panner::{Hrtf, PannerState};
use crate::stream::StreamStore;
use crate::{status, QUANTUM};

/// `start_frame` of a voice that starts at the first quantum after its PLAY arrived.
pub const ASAP: u64 = u64::MAX;

/// B3b: marks a started clip voice's `start_frame` as holding a pending SEEK (bit 62 set, bit 63
/// clear, so it is neither [`ASAP`] nor a frame); the low 32 bits are the target frame.
const SEEK_PENDING: u64 = 1 << 62;

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
    /// Paused while mixed and fading out (A3.7): `MIXED` clears when the `mix` ramp settles at 0,
    /// and the voice holds from then on. A resume before that turns the fade round.
    pub const PAUSING: u8 = 1 << 6;
    /// A stream voice (PLAY flag `stream`, B3): `clip` is the stream id and the PCM comes from its
    /// ring (`stream.rs`) through [`super::render_stream_voice`].
    pub const STREAM: u8 = 1 << 7;
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

/// The slots viewed over a `Voices` region's bytes (the automation pass reads them beside its own
/// region, `automation::begin_quantum`).
pub(crate) fn slots_of(bytes: &[u8]) -> &[VoiceSlot] {
    // SAFETY: as in `view`.
    unsafe { core::slice::from_raw_parts(bytes.as_ptr() as *const VoiceSlot, bytes.len() / VOICE_SLOT_BYTES) }
}

/// `true` for the states of a voice that is still live (scheduled or playing).
#[inline]
pub(crate) fn is_live_state(s: u8) -> bool {
    s == state::SCHEDULED || s == state::PLAYING
}

/// The slot index of the live voice `voice_id`, or `None` (stale).
pub(crate) fn live_index(core: &mut Core, voice_id: u32) -> Option<usize> {
    find(&view(core.regions_mut()), voice_id)
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
    // ADR 0158 E2: parameters move and bindings are evaluated before any voice renders.
    automation::begin_quantum(core);
    core.regions_mut().output[..2 * QUANTUM].fill(0.0);
    let mut cursor = 0usize;
    let (mut source_frames, mut moving) = (0.0f32, 0u32);
    while let Some(record) = crate::scheduler::pop_due(core, end) {
        let offset = if record.frame < frame {
            note_late(core, frame - record.frame);
            0
        } else {
            (record.frame - frame) as usize
        };
        if offset > cursor {
            let (f, m) = render_range(core, frame, cursor, offset);
            source_frames += f;
            moving = moving.max(m);
            cursor = offset;
        }
        crate::scheduler::apply(core, &record);
    }
    if cursor < QUANTUM {
        let (f, m) = render_range(core, frame, cursor, QUANTUM);
        source_frames += f;
        moving = moving.max(m);
    }
    // A3.5: the source frames the mixed voices read and the moving ones, for the work-unit model.
    core.cap_mut().note_voices(source_frames, moving);
    crate::panner::flush(core, frame);
    report(core);
}

fn note_late(core: &mut Core, lateness: u64) {
    let area = view(core.regions_mut()).area;
    area.late_count += 1;
    area.late_max = area.late_max.max(lateness.min(u32::MAX as u64) as u32);
}

/// Renders every live voice over frames `from..to` of the quantum at `frame`, each into its bus's
/// input buffer (A2.1; `bus::mixdown` mixes the buses into the output after the last range).
/// Returns about how many source frames the mixed voices read (A3.5: each one's pitch × rate
/// ratio at the range's start × its frames; the work-unit model's pitch term) and how many mixed
/// voices were moving (their pan matrix ramping, which takes the per-frame path). Reading them
/// changes nothing rendered.
fn render_range(core: &mut Core, frame: u64, from: usize, to: usize) -> (f32, u32) {
    let sample_rate = core.params().sample_rate;
    let fade_frames = mix_fade_frames(core);
    let (regions, clips, streams) = core.render_parts();
    // The buses' buffers are the `Buses` region, distinct from the voices and core-state regions
    // `v` views (Layout); `Inputs` holds a raw view of them and reads the bus count first.
    let mut inputs = crate::bus::Inputs::of(regions);
    // H3: the HRTF bank, once the HRIR table is resident (kind-1 voices pan equal-power until then).
    let mut hrtf = crate::panner::view(clips);
    // ADR 0158 E2: the voices' automation and loop entries, or `None` when no voice has any (then
    // every voice takes exactly the M1 path below). Another region than the ones `v` views.
    let autos: Option<*mut [VoiceAuto]> = automation::voice_entries(&mut regions.automation[..]).map(|a| a as *mut _);
    let v = view(regions);
    let (mut source_frames, mut moving) = (0.0f32, 0u32);
    let mut cursor = v.area.live_head;
    while cursor != 0 {
        let index = cursor as usize - 1;
        cursor = v.slots[index].next;
        let slot = &mut v.slots[index];
        let start = match slot.state {
            state::SCHEDULED => {
                if slot.flags & flag::PAUSED != 0 {
                    // Paused before it started: it waits for the resume, not counted late (A3.7).
                    continue;
                }
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
        if slot.flags & flag::MIXED != 0 {
            source_frames += slot.pitch.value * slot.rate_ratio * (to - start) as f32;
            moving += !slot.panner.matrix.iter().all(|r| r.is_settled()) as u32;
        }
        // SAFETY: `autos` views the automation region, distinct from the voices, core-state and
        // buses regions borrowed here, and one entry is borrowed at a time.
        let auto = autos.and_then(|a| unsafe { (&mut *a).get_mut(index) }).filter(|a| a.active_for(slot.id));
        // `AUTO = false` compiles the automation away: a voice without bindings or a loop region takes
        // exactly the M1 code (0158 E2: it costs nothing and renders bit for bit as before).
        match (slot.flags & flag::STREAM != 0, auto.is_some()) {
            (true, true) => render_stream_voice::<true>(slot, auto, streams, hrtf.as_mut(), frame, sample_rate, fade_frames, start, to, out_l, out_r),
            (true, false) => render_stream_voice::<false>(slot, None, streams, hrtf.as_mut(), frame, sample_rate, fade_frames, start, to, out_l, out_r),
            (false, true) => render_voice::<true>(slot, auto, clips, hrtf.as_mut(), frame, sample_rate, fade_frames, start, to, out_l, out_r),
            (false, false) => render_voice::<false>(slot, None, clips, hrtf.as_mut(), frame, sample_rate, fade_frames, start, to, out_l, out_r),
        }
    }
    (source_frames, moving)
}

/// Renders one playing voice over frames `from..to` of the quantum at `frame` (mixed) or keeps its
/// time (virtual), and ends it when its clip runs out or its stopping fade settles.
#[allow(clippy::too_many_arguments)]
fn render_voice<const AUTO: bool>(slot: &mut VoiceSlot, auto: Option<&mut VoiceAuto>, clips: &ClipStore, hrtf: Option<&mut Hrtf<'_>>, frame: u64, sample_rate: f32, fade_frames: u32, from: usize, to: usize, out_l: &mut [f32], out_r: &mut [f32]) {
    let mut auto = if AUTO { auto } else { None };
    if slot.flags & (flag::PAUSED | flag::MIXED) == flag::PAUSED {
        // Paused and out of the mix (A3.7): holds its position, ramps and panner exactly. A stop
        // (or a stopping fade) asked for while held ends it now: it is silent.
        if slot.flags & flag::STOP_ON_FADE_END != 0 {
            slot.state = state::ENDED;
        }
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
    if slot.flags & flag::PAUSED != 0 {
        // Paused and still mixed: the fade-out's tail. Render (and advance) only to its end, so the
        // voice holds at exactly the frame the fade ended on (A3.7).
        n = n.min(slot.mix.remaining as usize);
    }
    let looping = slot.flags & flag::LOOP != 0;
    if slot.start_frame >> 62 == 1 {
        // A SEEK is pending (B3b): a virtual voice (silent) or one whose fade-out has settled moves
        // now, and fades back in unless a demote or pause has taken the mix ramp; otherwise render
        // only up to the end of the fade-out.
        if slot.flags & flag::MIXED == 0 || slot.mix.is_settled() {
            let fade_in = slot.flags & flag::MIXED != 0 && slot.mix.value == 0.0 && slot.flags & (flag::DEMOTING | flag::PAUSING | flag::PAUSED) == 0;
            clip_seek_jump(slot, clip.source.frames, looping);
            if fade_in {
                slot.mix.set_target(1.0, fade_frames);
            }
        } else {
            n = n.min(slot.mix.remaining as usize);
        }
    }
    // ADR 0158 §4: a SET_LOOP region (the slot's whole-clip loop flag is clear while it loops).
    let region = auto.as_deref().and_then(|a| loop_region(a, clip.source.frames));
    let pitched = auto.as_deref().is_some_and(|a| a.count != 0 && a.targets & automation::has::PITCH != 0);
    // Virtual at a settled pitch (A3.5): every step is the same, so the position moves in O(1)
    // (`advance_constant`, bit-exact to the per-frame loop). Most logical voices take this path.
    // A virtual voice with a pitch binding keeps time at its pitchMul's mean over the range (control
    // rate: nobody hears it, and the O(1) path keeps 0158 §6's budget with many bound voices).
    let constant = slot.flags & flag::MIXED == 0 && slot.pitch.remaining == 0 && region.is_none();
    let mut steps = [0.0f32; QUANTUM];
    if !constant {
        for step in steps[..n].iter_mut() {
            *step = slot.pitch.next() * slot.rate_ratio;
        }
        if pitched {
            if let Some(a) = auto.as_deref() {
                auto_pitch(a, &mut steps[..n], from);
            }
        }
    }
    if slot.flags & flag::MIXED != 0 {
        let mut l = [0.0f32; QUANTUM];
        let mut r = [0.0f32; QUANTUM];
        if let Some((start, end)) = region {
            resample::lagrange_region(&clip.source, &mut slot.position, &steps[..n], start, end, &mut l[..n], &mut r[..n]);
        } else {
            resample::lagrange(&clip.source, &mut slot.position, &steps[..n], looping, &mut l[..n], &mut r[..n]);
        }
        if slot.mix.is_settled() && slot.mix.value == 1.0 {
            for i in 0..n {
                let g = slot.gain.next() * slot.fade.next();
                l[i] *= g;
                r[i] *= g;
            }
        } else {
            // A promote or demote (A3.1) or a seek fade (B3b) under way: the mix ramp on top of the gain and fade.
            for i in 0..n {
                let g = slot.gain.next() * slot.fade.next() * slot.mix.next();
                l[i] *= g;
                r[i] *= g;
            }
        }
        if let Some(a) = auto.as_deref_mut() {
            auto_gain_and_filter(a, slot.lp_hz, sample_rate, &mut l[..n], &mut r[..n], from);
        }
        let (id, bus) = (slot.id, slot.bus);
        slot.panner.mix_range(hrtf, id, bus, frame, from, &l[..n], &r[..n], &mut out_l[from..from + n], &mut out_r[from..from + n]);
        if slot.flags & (flag::DEMOTING | flag::PAUSING | flag::PAUSED) != 0 && slot.mix.is_settled() {
            // The demote (or pause) fade is done: virtual from the next frame, keeping time (or,
            // paused, holding from here).
            slot.flags &= !(flag::MIXED | flag::DEMOTING | flag::PAUSING);
        }
    } else {
        if constant {
            let mut step = slot.pitch.value * slot.rate_ratio;
            if pitched && n > 0 {
                if let Some(a) = auto.as_deref() {
                    step *= 0.5 * (a.pitch_at(from) + a.pitch_at(from + n - 1));
                }
            }
            resample::advance_constant(&mut slot.position, step, n, clip.source.frames, looping);
        } else if let Some((start, end)) = region {
            resample::advance_region(&mut slot.position, &steps[..n], start, end, clip.source.frames);
        } else {
            resample::advance(&mut slot.position, &steps[..n], clip.source.frames, looping);
        }
        slot.gain.advance(n as u32);
        slot.fade.advance(n as u32);
        slot.mix.advance(n as u32);
        slot.panner.advance(n as u32);
    }
    let ran_out = (region.is_some() || !looping) && slot.position >= clip.source.frames as f64;
    if ran_out || (stopping && slot.fade.is_settled()) {
        slot.state = state::ENDED;
    }
}

/// B3: renders one playing **stream** voice over frames `from..to` from its ring (`stream.rs`), or
/// holds it while its data is missing. A branch of its own beside [`render_voice`] (clips): the
/// ring replaces the clip, and the rest of the voice (gain, fade and mix ramps, panner, pause,
/// stop) behaves as a clip voice's. See `stream.rs` for the phases:
/// - no ring yet (PLAY before STREAM_OPEN) or `WAITING`: silent and held; it starts, with no fade,
///   once a chunk is in (or the input ended), its position set to the stream's start frame;
/// - each quantum a mixed voice checks the ring holds this quantum plus a 5 ms fade ahead; if not,
///   it fades out over what is left (`STARVING`), then holds silent (`STARVED`, reported once);
///   a virtual voice keeps time only over the frames there are, and starves without a fade;
/// - `STARVED` resumes with a 5 ms fade-in once a chunk is buffered (or the input ended);
/// - once the input ended, it plays out what is buffered (the last frame held for the resampler's
///   neighbours) and ends (stream event eos, or error if the stream was closed early).
///
/// The read is the 4-point Lagrange of `resample::lagrange` on the ring's frames (whole positions
/// read the ring bit for bit). The voice's position is in stream frames (its playhead); its ring
/// frame is `position - start_frame`. Afterwards the ring's `consumed` follows the position, less
/// the one frame behind it the resampler still reads.
#[allow(clippy::too_many_arguments)]
fn render_stream_voice<const AUTO: bool>(slot: &mut VoiceSlot, auto: Option<&mut VoiceAuto>, streams: &mut StreamStore, mut hrtf: Option<&mut Hrtf<'_>>, frame: u64, sample_rate: f32, fade_frames: u32, from: usize, to: usize, out_l: &mut [f32], out_r: &mut [f32]) {
    use crate::stream::{frame_at, pending, phase, START_FRAMES};
    let mut auto = if AUTO { auto } else { None };
    if slot.flags & (flag::PAUSED | flag::MIXED) == flag::PAUSED {
        // Paused and out of the mix: held, as a clip voice (A3.7); a stop ends it now.
        if slot.flags & flag::STOP_ON_FADE_END != 0 {
            slot.state = state::ENDED;
        }
        return;
    }
    let stopping = slot.flags & flag::STOP_ON_FADE_END != 0;
    if stopping && slot.fade.is_settled() {
        slot.state = state::ENDED;
        return;
    }
    let index = streams.index_of(slot.clip).filter(|&i| {
        let v = streams.ring(i).voice;
        v == 0 || v == slot.id
    });
    let Some(index) = index else {
        // No STREAM_OPEN yet (or none could be taken): waiting, silent. A stop ends it now.
        if stopping {
            slot.state = state::ENDED;
        }
        return;
    };
    let (ring, samples) = streams.split(index);
    if ring.voice == 0 {
        // Binds: the stream's rate and channels are known now.
        ring.voice = slot.id;
        slot.rate_ratio = ring.rate / sample_rate;
        if slot.panner.channels as u32 != ring.channels {
            let p = slot.panner;
            slot.panner.start(p.spatial != 0, p.kind, p.dir, ring.channels);
        }
    }
    if ring.seeking != 0 && render_seek_tail::<AUTO>(slot, auto.as_deref_mut(), ring, samples, hrtf.as_deref_mut(), frame, sample_rate, fade_frames, from, to, out_l, out_r) {
        return;
    }
    let ch = ring.channels as usize;
    let start = ring.start_frame as f64;
    let mixed = slot.flags & flag::MIXED != 0;
    let input_done = ring.input_done();
    let buffered = ring.written.saturating_sub((slot.position - start).max(0.0) as u64);
    let hold = |slot: &mut VoiceSlot| {
        // Silent and held: a stop ends it, and a demote or pause fade has nothing left to fade.
        if stopping {
            slot.state = state::ENDED;
        }
        if slot.flags & (flag::DEMOTING | flag::PAUSING) != 0 {
            slot.mix = Ramp::at(0.0);
            slot.flags &= !(flag::MIXED | flag::DEMOTING | flag::PAUSING);
        }
    };
    match ring.phase {
        phase::WAITING => {
            if !input_done && ring.written < START_FRAMES {
                // (After a seek the playhead is already at the target.)
                slot.position = start;
                hold(slot);
                return;
            }
            ring.phase = phase::PLAYING;
            ring.gain = Ramp::at(1.0);
            slot.position = start;
            if ring.fade_in != 0 && mixed {
                // B3b: the first frames after a seek fade in.
                ring.gain = Ramp::at(0.0);
                ring.gain.set_target(1.0, fade_frames);
            }
        }
        phase::STARVED => {
            if !input_done && buffered < START_FRAMES {
                hold(slot);
                return;
            }
            ring.phase = phase::PLAYING;
            ring.gain = Ramp::at(if mixed { 0.0 } else { 1.0 });
            ring.gain.set_target(1.0, if mixed { fade_frames } else { 0 });
        }
        phase::STARVING if input_done || buffered >= START_FRAMES => {
            // Data came back during the fade-out: turn round.
            ring.phase = phase::PLAYING;
            ring.gain.set_target(1.0, fade_frames);
        }
        _ => {}
    }
    let mut n = to - from;
    if stopping {
        n = n.min(slot.fade.remaining as usize);
    }
    if slot.flags & flag::PAUSED != 0 {
        n = n.min(slot.mix.remaining as usize);
    }
    let mut steps = [0.0f32; QUANTUM];
    let mut max_step = 0.0f32;
    for step in steps[..n].iter_mut() {
        *step = slot.pitch.next() * slot.rate_ratio;
        max_step = max_step.max(*step);
    }
    if let Some(a) = auto.as_deref() {
        max_step = max_step.max(auto_pitch(a, &mut steps[..n], from));
    }
    let written = ring.written;
    if mixed && ring.phase == phase::PLAYING && !input_done {
        // Enough ahead for this quantum and a fade? If not, fade out over what is left.
        let have = written as f64 - 3.0 - (slot.position - start);
        if have < (n as f64 + fade_frames as f64) * max_step as f64 {
            let can = if max_step > 0.0 { libm::floor(have / max_step as f64).max(0.0) } else { f64::MAX };
            let frames = (fade_frames as f64).min(can) as u32;
            ring.phase = phase::STARVING;
            ring.gain.set_target(0.0, frames);
        }
    }
    let mut l = [0.0f32; QUANTUM];
    let mut r = [0.0f32; QUANTUM];
    let mut done = 0usize;
    let mut starved = false;
    for i in 0..n {
        let p = slot.position - start;
        if input_done && p >= written as f64 {
            break;
        }
        let idx = p.max(0.0) as u64;
        if (!input_done && idx + 3 > written) || (ring.phase == phase::STARVING && ring.gain.is_settled()) {
            starved = true;
            break;
        }
        let g = ring.gain.next();
        if mixed {
            let last = written - 1;
            let t = (p - idx as f64) as f32;
            let w = resample::weights(t);
            let a = frame_at(samples, ch, idx.saturating_sub(1).min(last));
            let b = frame_at(samples, ch, idx.min(last));
            let c = frame_at(samples, ch, (idx + 1).min(last));
            let d = frame_at(samples, ch, (idx + 2).min(last));
            l[i] = (w[0] * a.0 + w[1] * b.0 + w[2] * c.0 + w[3] * d.0) * g;
            r[i] = (w[0] * a.1 + w[1] * b.1 + w[2] * c.1 + w[3] * d.1) * g;
        }
        slot.position += steps[i] as f64;
        done += 1;
    }
    if mixed {
        for i in 0..done {
            let g = slot.gain.next() * slot.fade.next() * slot.mix.next();
            l[i] *= g;
            r[i] *= g;
        }
        if let Some(a) = auto.as_deref_mut() {
            auto_gain_and_filter(a, slot.lp_hz, sample_rate, &mut l[..done], &mut r[..done], from);
        }
        let (id, bus) = (slot.id, slot.bus);
        slot.panner.mix_range(hrtf, id, bus, frame, from, &l[..done], &r[..done], &mut out_l[from..from + done], &mut out_r[from..from + done]);
        if slot.flags & (flag::DEMOTING | flag::PAUSING | flag::PAUSED) != 0 && slot.mix.is_settled() {
            slot.flags &= !(flag::MIXED | flag::DEMOTING | flag::PAUSING);
        }
    } else {
        slot.gain.advance(done as u32);
        slot.fade.advance(done as u32);
        slot.mix.advance(done as u32);
        slot.panner.advance(done as u32);
    }
    let p = slot.position - start;
    let behind = (p.max(0.0) as u64).saturating_sub(1).min(written);
    ring.consumed = ring.consumed.max(behind);
    if starved && ring.phase != phase::STARVED {
        ring.phase = phase::STARVED;
        ring.pending |= pending::STARVED;
        ring.gain = Ramp::at(0.0);
        hold(slot);
    }
    if input_done && p >= written as f64 {
        slot.state = state::ENDED;
        ring.pending |= pending::ENDED;
    } else if stopping && slot.fade.is_settled() {
        slot.state = state::ENDED;
    }
}

/// B3b: the seek fade of a stream voice (`stream.rs`, "The seek fade"): while `ring.seeking`, a
/// mixed voice renders the old epoch's audio from the ring's tail copy, fading out over 5 ms (less
/// if the copy is short), then moves to the new epoch (`position` = the target frame, the ring
/// waiting for its first chunk). A virtual voice, or one silent when the seek came, moves at once.
/// Returns true when it rendered (the quantum is done), false when the voice moved with nothing
/// left to fade (the caller goes on with the new epoch).
#[allow(clippy::too_many_arguments)]
fn render_seek_tail<const AUTO: bool>(slot: &mut VoiceSlot, auto: Option<&mut VoiceAuto>, ring: &mut crate::stream::Ring, samples: &[f32], hrtf: Option<&mut Hrtf<'_>>, frame: u64, sample_rate: f32, fade_frames: u32, from: usize, to: usize, out_l: &mut [f32], out_r: &mut [f32]) -> bool {
    use crate::stream::{frame_at, TAIL_OFFSET};
    let mut auto = if AUTO { auto } else { None };
    let finish = |slot: &mut VoiceSlot, ring: &mut crate::stream::Ring| {
        ring.seeking = 0;
        ring.tail_len = 0;
        slot.position = ring.start_frame as f64;
    };
    let mixed = slot.flags & flag::MIXED != 0;
    if !mixed || (ring.seeking == 1 && slot.mix.value == 0.0) {
        finish(slot, ring);
        return false;
    }
    let stopping = slot.flags & flag::STOP_ON_FADE_END != 0;
    let ch = ring.tail_channels.max(1) as usize;
    let tail = &samples[TAIL_OFFSET..];
    let len = ring.tail_len as u64;
    let t0 = ring.tail_frame0 as f64;
    let mut n = to - from;
    if stopping {
        n = n.min(slot.fade.remaining as usize);
    }
    if slot.flags & flag::PAUSED != 0 {
        n = n.min(slot.mix.remaining as usize);
    }
    let mut steps = [0.0f32; QUANTUM];
    let mut max_step = 0.0f32;
    for step in steps[..n].iter_mut() {
        *step = slot.pitch.next() * slot.rate_ratio;
        max_step = max_step.max(*step);
    }
    if let Some(a) = auto.as_deref() {
        max_step = max_step.max(auto_pitch(a, &mut steps[..n], from));
    }
    if ring.seeking == 1 {
        let have = len as f64 - 3.0 - (slot.position - t0);
        let can = if max_step > 0.0 { libm::floor(have / max_step as f64).max(0.0) } else { f64::MAX };
        ring.gain.set_target(0.0, (fade_frames as f64).min(can) as u32);
        ring.seeking = 2;
    }
    let mut l = [0.0f32; QUANTUM];
    let mut r = [0.0f32; QUANTUM];
    let mut done = 0usize;
    let mut faded = false;
    for i in 0..n {
        let p = slot.position - t0;
        let idx = p.max(0.0) as u64;
        if idx + 3 > len || ring.gain.is_settled() {
            faded = true;
            break;
        }
        let g = ring.gain.next();
        let last = len - 1;
        let w = resample::weights((p - idx as f64) as f32);
        let a = frame_at(tail, ch, idx.saturating_sub(1).min(last));
        let b = frame_at(tail, ch, idx.min(last));
        let c = frame_at(tail, ch, (idx + 1).min(last));
        let d = frame_at(tail, ch, (idx + 2).min(last));
        l[i] = (w[0] * a.0 + w[1] * b.0 + w[2] * c.0 + w[3] * d.0) * g;
        r[i] = (w[0] * a.1 + w[1] * b.1 + w[2] * c.1 + w[3] * d.1) * g;
        slot.position += steps[i] as f64;
        done += 1;
    }
    for i in 0..done {
        let g = slot.gain.next() * slot.fade.next() * slot.mix.next();
        l[i] *= g;
        r[i] *= g;
    }
    if let Some(a) = auto.as_deref_mut() {
        auto_gain_and_filter(a, slot.lp_hz, sample_rate, &mut l[..done], &mut r[..done], from);
    }
    let (id, bus) = (slot.id, slot.bus);
    slot.panner.mix_range(hrtf, id, bus, frame, from, &l[..done], &r[..done], &mut out_l[from..from + done], &mut out_r[from..from + done]);
    if slot.flags & (flag::DEMOTING | flag::PAUSING | flag::PAUSED) != 0 && slot.mix.is_settled() {
        slot.flags &= !(flag::MIXED | flag::DEMOTING | flag::PAUSING);
    }
    if faded {
        finish(slot, ring);
    } else if stopping && slot.fade.is_settled() {
        slot.state = state::ENDED;
    }
    true
}

/// ADR 0158 §4: the voice's SET_LOOP region resolved against its clip's `frames` (`end` 0 or past
/// the clip is the clip's end; an empty region loops the whole clip), or `None` when it has none.
fn loop_region(a: &VoiceAuto, frames: u32) -> Option<(u32, u32)> {
    if a.loop_on == 0 || frames == 0 {
        return None;
    }
    let end = if a.loop_end == 0 { frames } else { a.loop_end.min(frames) };
    Some(if a.loop_start < end { (a.loop_start, end) } else { (0, frames) })
}

/// ADR 0158 §3: multiplies `steps` (frames `from..` of the quantum) by the voice's `pitchMul`,
/// ramped across the quantum (per frame); returns the largest step. Nothing (0) without a pitch
/// binding.
fn auto_pitch(a: &VoiceAuto, steps: &mut [f32], from: usize) -> f32 {
    let mut max = 0.0f32;
    if a.count != 0 && a.targets & automation::has::PITCH != 0 {
        for (k, step) in steps.iter_mut().enumerate() {
            *step *= a.pitch_at(from + k);
            max = max.max(*step);
        }
    }
    max
}

/// ADR 0158 §3: multiplies a mixed voice's block (frames `from..` of the quantum) by its
/// `gainMul`, ramped across the quantum, and filters it at `min(lpHz, lpAuto)` when it has a
/// lowpass binding (the coefficients change at most once per quantum).
fn auto_gain_and_filter(a: &mut VoiceAuto, lp_hz: f32, sample_rate: f32, l: &mut [f32], r: &mut [f32], from: usize) {
    if a.count == 0 {
        return;
    }
    if a.targets & automation::has::GAIN != 0 {
        if a.g0 == a.g1 {
            let g = a.g1;
            for i in 0..l.len() {
                l[i] *= g;
                r[i] *= g;
            }
        } else {
            for i in 0..l.len() {
                let g = a.gain_at(from + i);
                l[i] *= g;
                r[i] *= g;
            }
        }
    }
    if a.targets & automation::has::LOWPASS != 0 {
        let base = if crate::fx::lowpass_on(lp_hz) { lp_hz } else { automation::LP_OFF_HZ };
        a.filter.set_lowpass(sample_rate, base.min(a.lp), crate::fx::SNAPSHOT_Q_DB);
        a.filter.process(l, r);
    }
}

/// A clip voice's pending SEEK (its target in `start_frame`'s low bits) lands: moves it there
/// (wrapped for a loop, clamped to the end otherwise) and ends the pending state.
fn clip_seek_jump(slot: &mut VoiceSlot, frames: u32, looping: bool) {
    let target = (slot.start_frame & 0xFFFF_FFFF) as f64;
    let total = frames as f64;
    slot.position = if looping && total > 0.0 { libm::fmod(target, total) } else { target.min(total) };
    slot.start_frame = 0;
}

/// After the render: frees ended voices into STATUS `ended` (as many as the block has room for),
/// gathers playheads round-robin, and sets the live and mixed counts and the late records.
fn report(core: &mut Core) {
    // B3: first, while the rings of voices that ended this quantum still hold their reports.
    report_streams(core);
    let room = (ENDED_CAP - status::counters(core).ended.len()).min(ENDED_SCRATCH);
    let (live, mixed, ended, playheads, late_count, late_max) = {
        let (regions, _, streams) = core.render_parts();
        let mut v = view(regions);
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
                        if s.flags & flag::STREAM != 0 {
                            // B3: its ring is freed (closed) or orphaned until STREAM_CLOSE.
                            streams.release(s.clip, s.id);
                        }
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

/// B3: moves the rings' pending reports into STATUS: a starved voice into `starved` and stream
/// event 1, a drained stream as event 2 (eos) or 3 (closed before its last chunk). What a full
/// block can't take waits for the next (a ring freed meanwhile drops its report).
fn report_streams(core: &mut Core) {
    use crate::counters::Event;
    use crate::stream::pending;
    for i in 0..core.streams().capacity() {
        let r = *core.streams().ring(i);
        if r.pending == 0 {
            continue;
        }
        let mut left = r.pending;
        let c = status::counters_mut(core);
        if left & pending::STARVED != 0 && !c.starved.is_full() && !c.stream_events.is_full() {
            c.starved.push(r.voice);
            c.stream_events.push(Event { id: r.id, code: wire::stream_event::STARVED });
            left &= !pending::STARVED;
        }
        if left & pending::ENDED != 0 && !c.stream_events.is_full() {
            let code = if left & pending::ERROR != 0 { wire::stream_event::ERROR } else { wire::stream_event::EOS };
            c.stream_events.push(Event { id: r.id, code });
            left &= !(pending::ENDED | pending::ERROR);
        }
        if r.open != 0 {
            core.streams_mut().ring_mut(i).pending = left;
        }
    }
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
    let (channels, clip_rate) = if play.flags & wire::PLAY_FLAGS_STREAM != 0 {
        // B3: a stream's shape comes with STREAM_OPEN, which may arrive after the PLAY; the render
        // branch sets the rate and the panner's channels when the voice binds to its ring.
        core.streams().get(play.clip).map_or((2, sample_rate), |r| (r.channels, r.rate))
    } else {
        core.clips().frames(play.clip).map_or((1, sample_rate), |c| (c.source.channels, c.sample_rate))
    };
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
        if play.flags & wire::PLAY_FLAGS_STREAM != 0 {
            flags |= flag::STREAM;
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
        (old.state != state::FREE && old.id != play.voice_id).then_some((old.id, old.flags & flag::STREAM != 0, old.clip))
    };
    // ADR 0158 E2: the slot's automation entry now belongs to this voice and its group.
    automation::on_play(core, index, play.voice_id, play.group);
    if let Some((old, stream, clip)) = replaced {
        status::counters_mut(core).ended.push(old);
        if stream {
            core.streams_mut().release(clip, old);
        }
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

/// SET_LOOP (ADR 0158 §4): a clip voice's loop region (`looping`; `end` 0 is the clip's end) or
/// its release (`looping` clear: it finishes its current pass and plays on to the clip's end, then
/// ends like a non-looping voice). Either way PLAY's whole-clip loop flag no longer applies. A
/// stale id is dropped. Stream voices are ignored in E2: their region loops go through the decoder
/// worker's gapless-loop path (E4).
pub fn set_loop(core: &mut Core, voice_id: u32, start: u32, end: u32, looping: bool) {
    let index = {
        let v = view(core.regions_mut());
        let Some(index) = find(&v, voice_id) else { return };
        let s = &mut v.slots[index];
        if s.flags & flag::STREAM != 0 {
            return;
        }
        s.flags &= !flag::LOOP;
        index
    };
    automation::set_loop(core, index, voice_id, start, end, looping);
}

/// SEEK (api-and-models §4.2, B3b): moves voice `voice_id` to `frame` (a clip frame, or a stream
/// frame for a stream voice, whose `epoch` is the seek epoch; a stale id is dropped).
/// - A stream voice: its ring restarts at the epoch (`StreamStore::seek`); the voice fades out
///   the old audio over 5 ms and fades in at the target when the new epoch's data is there.
/// - A clip voice: a mixed voice fades out over 5 ms (the `mix` ramp), jumps and fades back in; a
///   virtual one jumps at its next render, one not started yet starts there. `frame` wraps for a
///   loop and clamps to the end otherwise. A second SEEK before the jump replaces the target.
pub fn seek(core: &mut Core, voice_id: u32, frame: u32, epoch: u32) {
    let fade = mix_fade_frames(core);
    let v = view(core.regions_mut());
    let Some(index) = find(&v, voice_id) else { return };
    let s = &mut v.slots[index];
    if s.flags & flag::STREAM != 0 {
        let stream = s.clip;
        core.streams_mut().seek(stream, epoch, frame);
        return;
    }
    if s.state == state::SCHEDULED {
        s.position = frame as f64; // not started: it starts there
        return;
    }
    // A started voice's `start_frame` is dead: it carries the pending seek (bit 62, then the frame).
    let pending = s.start_frame >> 62 == 1;
    s.start_frame = SEEK_PENDING | frame as u64;
    if !pending && s.flags & flag::MIXED != 0 && s.flags & (flag::DEMOTING | flag::PAUSING | flag::PAUSED) == 0 {
        s.mix.set_target(0.0, fade);
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
    if s.flags & flag::PAUSED != 0 {
        // Main never promotes a paused voice (selection forces it virtual); dropped (A3.7).
        return;
    }
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
    if s.flags & flag::PAUSING != 0 {
        // Already fading out for a pause (A3.7): the same fade ends it; a resume no longer turns it round.
        s.flags |= flag::DEMOTING;
        return true;
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
        if v.slots[index].flags & flag::PAUSED != 0 {
            return false; // already leaving the mix (A3.7)
        }
        demote_slot(&mut v.slots[index], frames)
    };
    if changed {
        status::counters_mut(core).demoted.push(voice_id);
    }
    changed
}

/// Mixed voices that aren't fading out or paused (what counts against a mixed cap).
pub fn mixed_live(core: &mut Core) -> u32 {
    let v = view(core.regions_mut());
    let mut n = 0;
    let mut cursor = v.area.live_head;
    while cursor != 0 {
        let s = &v.slots[cursor as usize - 1];
        cursor = s.next;
        if (s.state == state::SCHEDULED || s.state == state::PLAYING) && s.flags & flag::MIXED != 0 && s.flags & (flag::DEMOTING | flag::PAUSED) == 0 {
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
                if (s.state == state::SCHEDULED || s.state == state::PLAYING) && s.flags & flag::MIXED != 0 && s.flags & (flag::DEMOTING | flag::PAUSED) == 0 && best.is_none_or(|(score, _)| s.score < score) {
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

/// SET_PAUSED (api-and-models §4.2, A3.7): pauses or resumes `voice_id`; see the module notes. A
/// stale id is dropped; a voice already in the asked state is left alone.
pub fn set_paused(core: &mut Core, voice_id: u32, paused: bool) {
    let frames = mix_fade_frames(core);
    // The next quantum's first frame (the frame after the last one rendered).
    let now = core.frame() + QUANTUM as u64;
    let v = view(core.regions_mut());
    let Some(index) = find(&v, voice_id) else { return };
    let s = &mut v.slots[index];
    if paused {
        pause_slot(s, frames);
    } else {
        resume_slot(s, frames, now);
    }
}

fn pause_slot(s: &mut VoiceSlot, frames: u32) {
    if s.flags & flag::PAUSED != 0 {
        return;
    }
    s.flags |= flag::PAUSED;
    if s.state == state::PLAYING && s.flags & flag::MIXED != 0 && s.flags & flag::DEMOTING == 0 {
        // Mixed: fade out over 5 ms, then hold (a voice already demoting finishes its own fade).
        s.flags |= flag::PAUSING;
        s.mix.set_target(0.0, frames);
    }
}

/// `now` is the context frame of the next quantum.
fn resume_slot(s: &mut VoiceSlot, frames: u32, now: u64) {
    if s.flags & flag::PAUSED == 0 {
        return;
    }
    s.flags &= !flag::PAUSED;
    if s.flags & flag::PAUSING != 0 {
        // Resumed during the fade-out: turn round, unless main demoted it meanwhile.
        s.flags &= !flag::PAUSING;
        if s.flags & flag::DEMOTING == 0 {
            s.mix.set_target(1.0, frames);
        }
    }
    if s.state == state::SCHEDULED && s.start_frame != ASAP && s.start_frame < now {
        // Its start passed while it was paused: start now, not counted late.
        s.start_frame = ASAP;
    }
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
