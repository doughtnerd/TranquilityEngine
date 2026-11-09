//! Command apply and the scheduler (api-and-models §4.1, §4.2; architecture §3.3, §4.3, §4.4).
//!
//! [`submit`] parses one inbox message with `audio-wire`'s generated readers (contract K1). It runs
//! in `onmessage`, never inside `process`:
//! - The envelope is checked: a bad magic or a short message is refused; another **major** version
//!   is refused, counted with the STATUS `versionMismatch` flag; an unknown kind of this major is
//!   skipped. BATCH (1) and REPLAY (12) carry records; other kinds aren't handled here.
//! - Every record head is validated before any record applies (lengths inside the message, at least
//!   the head), so a malformed batch changes nothing. Unknown opcodes, and the ones later tasks
//!   apply (SET_MIXED, SET_PAUSED, SEEK, BUS_*, MASTER, RESET), are skipped by their length.
//! - `slack = firstFrame - currentFrame` is noted for STATUS `minSlackFrames`.
//!
//! **asap vs stamped** (architecture §4.3). `frameOffset == 0xFFFFFFFF` is asap: PLAY starts at
//! offset 0 of the next quantum, and STOP, SET_PARAMS and FADE apply at once (between quanta, so
//! the effect starts with the next quantum and ramps from its start). Never counted late. Any other
//! offset is the absolute frame `firstFrame + frameOffset`:
//! - PLAY writes its slot at once with that start frame (so later records for the voice find it),
//!   and the voice starts at the sample offset in its quantum.
//! - STOP, SET_PARAMS and FADE wait in the pending queue (the `Pending` region, kept sorted by frame,
//!   stable) and apply at their sample offset in the quantum that contains their frame.
//! - A stamped frame already before the quantum being rendered applies at offset 0 and counts in
//!   `lateCommands` and `maxLatenessFrames` (§4.4). A full pending queue applies the record at once.
//!
//! The pending queue's head and length live in [`SchedulerArea`], in the core-state region after
//! the voices' area.

use crate::core::Core;
use crate::layout::PENDING_RECORD_BYTES;

/// One stamped record waiting for its frame: 48 bytes (`PENDING_RECORD_BYTES`), all-zero valid.
/// STOP, SET_PARAMS and FADE only (PLAY is written to its slot at once).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PendingRecord {
    /// Absolute context frame.
    pub frame: u64,
    pub voice_id: u32,
    /// The wire opcode (STOP, SET_PARAMS or FADE).
    pub op: u8,
    /// SET_PARAMS `mask` (bits 0–6).
    pub mask: u8,
    /// SET_PARAMS: the panner kind; FADE: bit0 stop at end.
    pub flags: u8,
    /// SET_PARAMS `bus` (bus indices fit a byte: at most 256 buses).
    pub bus: u8,
    /// SET_PARAMS: gain, pitch, dirX, dirY, dirZ, lpHz, score. FADE: `[0]` target.
    pub values: [f32; 7],
    /// SET_PARAMS `rampFrames`; STOP `fadeFrames`; FADE `frames`.
    pub frames: u32,
}

const _: () = assert!(core::mem::size_of::<PendingRecord>() == PENDING_RECORD_BYTES, "a pending record is the layout's size");

/// The scheduler's scalars in the core-state region. All-zero is valid (an empty queue).
#[repr(C)]
pub struct SchedulerArea {
    /// Index of the first live record in the `Pending` region.
    pub head: u32,
    /// Live records from `head`.
    pub len: u32,
}

/// Offset of [`SchedulerArea`] in the core-state region (after the voices' area).
pub const SCHEDULER_AREA_OFFSET: usize = crate::voices::VOICE_AREA_OFFSET + crate::voices::VOICE_AREA_BYTES;

/// `myco_audio_submit`: parses and applies one inbox message (see the module comment). Returns 0,
/// or a negative `audio-wire` error code (`ERR_BAD_MAGIC`, `ERR_VERSION_MISMATCH`,
/// `ERR_TRUNCATED`, `ERR_MALFORMED`) with nothing applied.
pub fn submit(core: &mut Core, msg: &[u8]) -> i32 {
    let _ = (core, msg);
    todo!("A1.2-core")
}

/// Removes and returns the earliest pending record whose frame is before `before` (the end of the
/// quantum being rendered), or `None`. Called by `voices::render`; never allocates.
pub fn pop_due(core: &mut Core, before: u64) -> Option<PendingRecord> {
    let _ = (core, before);
    todo!("A1.2-core")
}

/// Applies one record that came due (or arrived late, or found the queue full) to its voice.
pub fn apply(core: &mut Core, record: &PendingRecord) {
    let _ = (core, record);
    todo!("A1.2-core")
}

/// Pending records waiting.
pub fn pending_len(core: &Core) -> usize {
    let _ = core;
    todo!("A1.2-core")
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "A1.2-core"]
    fn a_bad_envelope_is_refused() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn a_malformed_record_refuses_the_whole_batch() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn unknown_opcodes_are_skipped() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn stamped_records_stay_sorted_by_frame_and_stable() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn asap_never_counts_late() {}
}
