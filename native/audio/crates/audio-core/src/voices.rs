//! Voice slots and the render loop (api-and-models §3, §4.2; architecture §2.2).
//!
//! The `Voices` region is viewed as `[VoiceSlot; max_logical]`. A voice id is
//! `gen << 16 | index` (api-and-models §3): the slot is `index`, and the slot keeps the whole id,
//! so a command whose generation differs from the slot's is dropped (a stale id).
//!
//! **Lifecycle in the core.** PLAY writes the slot at once (`Scheduled`, with the absolute frame it
//! starts at, or [`ASAP`]) and links it into the live list. During `process` a scheduled voice
//! starts at its sample offset (asap: offset 0 of the first quantum after arrival; a stamped frame
//! already past: offset 0, counted late, from its start, architecture §4.4). A playing voice reads
//! its clip through the linear resampler, multiplies by its gain and fade ramps and pans through its
//! [`PannerState`]. A virtual voice (PLAY flag `mixed` clear) keeps time without rendering. A voice
//! ends when a non-looping clip runs out, when STOP lands (fade 0), or when a fade with "stop at end"
//! finishes. Ended voices are reported in STATUS `ended` (K12) and their slot is freed; when the
//! block's `ended` list is full the rest wait in `Ended` for the next quantum (carried, §4.3).
//!
//! Live voices form an intrusive doubly linked list through the slots (indices + 1, 0 = none), so a
//! quantum touches only live slots. The list head and per-quantum scratch live in [`VoiceArea`], in
//! the core-state region right after the status area (`status::STATUS_AREA_BYTES`).
//!
//! `process` never allocates: every buffer is a region or a fixed-size stack array.

use audio_dsp::ramp::Ramp;

use crate::core::Core;
use crate::layout::VOICE_SLOT_BYTES;
use crate::panner::PannerState;

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
}

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
    /// Bus index (A2.1 routes it; until then every voice goes to the output).
    pub bus: u16,
    /// Live list links: slot index + 1, 0 = none.
    pub next: u32,
    pub prev: u32,
    /// Absolute context frame to start at, or [`ASAP`].
    pub start_frame: u64,
    /// Read position in clip frames.
    pub position: f64,
    /// Clip rate / context rate, set at start.
    pub rate_ratio: f32,
    /// PLAY / SET_PARAMS `lpHz`, kept for the per-voice filter (not applied yet).
    pub lp_hz: f32,
    /// PLAY / SET_PARAMS `score` (the adaptive cap's ranking, A3.3).
    pub score: f32,
    pub gain: Ramp,
    pub pitch: Ramp,
    /// FADE and STOP-with-fade; starts at 1.
    pub fade: Ramp,
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
    /// Round-robin cursor over `wantsPlayhead` voices (a slot index).
    pub playhead_cursor: u32,
    /// Ended ids moved out of their slots this quantum, reported right after the render.
    pub ended_len: u32,
    pub ended: [u32; ENDED_SCRATCH],
}

/// Offset of [`VoiceArea`] in the core-state region.
pub const VOICE_AREA_OFFSET: usize = crate::status::STATUS_AREA_BYTES;
/// Bytes it takes, rounded to a region alignment. The scheduler's area follows.
pub const VOICE_AREA_BYTES: usize = (core::mem::size_of::<VoiceArea>() + crate::layout::REGION_ALIGN - 1) / crate::layout::REGION_ALIGN * crate::layout::REGION_ALIGN;

/// Renders one quantum at context frame `frame` into the output region (called by
/// `Core::process`): applies the scheduler's records due in this quantum at their sample offsets,
/// renders every live voice, then reports ended voices, late records, the live and mixed counts
/// and playheads through the counters (K12). Never allocates.
pub fn render(core: &mut Core, frame: u64) {
    let _ = (core, frame);
    todo!("A1.2-core")
}

/// PLAY (api-and-models §4.2): writes the slot for `play.voice_id` and links it live, to start at
/// `start_frame` (absolute, or [`ASAP`]). A slot still holding an older voice is taken over and
/// that voice is reported ended. An index past `max_logical` or a zero id is dropped.
pub fn play(core: &mut Core, play: &audio_wire::generated::Play, start_frame: u64) {
    let _ = (core, play, start_frame);
    todo!("A1.2-core")
}

/// STOP: `fade_frames == 0` ends the voice now; otherwise its fade ramps to 0 over `fade_frames`
/// and it ends when the fade settles. A stale id is dropped.
pub fn stop(core: &mut Core, voice_id: u32, fade_frames: u32) {
    let _ = (core, voice_id, fade_frames);
    todo!("A1.2-core")
}

/// SET_PARAMS: applies the masked fields; gain, pitch and direction ramp over `ramp_frames`.
pub fn set_params(core: &mut Core, p: &audio_wire::generated::SetParams) {
    let _ = (core, p);
    todo!("A1.2-core")
}

/// FADE: the fade ramps to `target` over `frames`; with `stop_at_end`, the voice ends when it
/// settles.
pub fn fade(core: &mut Core, voice_id: u32, target: f32, frames: u32, stop_at_end: bool) {
    let _ = (core, voice_id, target, frames, stop_at_end);
    todo!("A1.2-core")
}

/// The slots, viewed over the `Voices` region (`max_logical` of them).
pub fn slots(core: &Core) -> &[VoiceSlot] {
    let _ = core;
    todo!("A1.2-core")
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "A1.2-core"]
    fn a_zeroed_region_is_all_free_slots() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn stale_ids_are_dropped() {}

    /// A1.1's stealing contract: main reuses the victim's index with a bumped generation, and the
    /// new PLAY replaces the old voice; the old generation's commands are dropped from then on.
    #[test]
    #[ignore = "A1.2-core"]
    fn a_play_with_a_new_generation_replaces_the_voice_in_its_slot() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn the_live_list_links_and_unlinks() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn a_full_ended_list_carries_voices_to_the_next_quantum() {}
}
