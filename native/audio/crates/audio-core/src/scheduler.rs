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
//! the voices' area. `pop_due` (inside `process`) only moves the head; the queue is compacted when a
//! record is inserted (in `submit`).

use audio_wire::generated::{self as wire, BatchHeader, Envelope, Fade, Play, RecordHead, SetParams, Stop};

use crate::core::{Core, Regions};
use crate::counters::flag;
use crate::layout::{PENDING_CAPACITY, PENDING_RECORD_BYTES};
use crate::{status, voices};

/// One stamped record waiting for its frame: 48 bytes (`PENDING_RECORD_BYTES`), all-zero valid.
/// STOP, SET_PARAMS and FADE only (PLAY is written to its slot at once).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
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

struct Queue<'a> {
    records: &'a mut [PendingRecord],
    area: &'a mut SchedulerArea,
}

fn queue(regions: &mut Regions) -> Queue<'_> {
    let count = (regions.pending.len() / PENDING_RECORD_BYTES).min(PENDING_CAPACITY);
    let area = &mut regions.core_state[SCHEDULER_AREA_OFFSET..SCHEDULER_AREA_OFFSET + core::mem::size_of::<SchedulerArea>()];
    // SAFETY: both regions are 64-byte aligned and zeroed at init; all-zero bytes are a valid
    // PendingRecord and SchedulerArea. SCHEDULER_AREA_OFFSET is a multiple of REGION_ALIGN and the
    // area fits the core-state region (asserted in `voices`). Only this module views these bytes.
    unsafe {
        Queue {
            records: core::slice::from_raw_parts_mut(regions.pending.as_mut_ptr() as *mut PendingRecord, count),
            area: &mut *(area.as_mut_ptr() as *mut SchedulerArea),
        }
    }
}

/// `myco_audio_submit`: parses and applies one inbox message (see the module comment). Returns 0,
/// or a negative `audio-wire` error code (`ERR_BAD_MAGIC`, `ERR_VERSION_MISMATCH`,
/// `ERR_TRUNCATED`, `ERR_MALFORMED`) with nothing applied.
pub fn submit(core: &mut Core, msg: &[u8]) -> i32 {
    let env = match Envelope::read(msg, 0) {
        Ok((env, _)) => env,
        Err(e) => return e,
    };
    if env.magic != wire::MAGIC {
        return wire::ERR_BAD_MAGIC;
    }
    if (env.version >> 8) as u32 != wire::VERSION_MAJOR {
        status::counters_mut(core).set_flag(flag::VERSION_MISMATCH, true);
        return wire::ERR_VERSION_MISMATCH;
    }
    let end = match (wire::ENVELOPE_BYTES as usize).checked_add(env.body_bytes as usize) {
        Some(end) if end <= msg.len() => end,
        _ => return wire::ERR_TRUNCATED,
    };
    let msg = &msg[..end];
    if env.kind != wire::kind::BATCH && env.kind != wire::kind::REPLAY {
        return wire::ERR_OK;
    }
    let header = match BatchHeader::read(msg, 0) {
        Ok((h, _)) => h,
        Err(e) => return e,
    };
    let first = (wire::ENVELOPE_BYTES + wire::BATCH_HEADER_BYTES) as usize;

    // Pass 1: every record fits and is at least as long as its opcode's fixed part.
    let mut off = first;
    for _ in 0..header.count {
        let head = match RecordHead::read(msg, off) {
            Ok((head, _)) => head,
            Err(e) => return e,
        };
        let len = head.words as usize * 4;
        let min = match head.opcode {
            wire::op::PLAY => Play::FIXED_END,
            wire::op::STOP => Stop::FIXED_END,
            wire::op::SET_PARAMS => SetParams::FIXED_END,
            wire::op::FADE => Fade::FIXED_END,
            _ => RecordHead::FIXED_END,
        };
        if len < min || off + len > msg.len() {
            return wire::ERR_MALFORMED;
        }
        off += len;
    }

    let slack = header.first_frame - status::counters(core).current_frame;
    status::counters_mut(core).note_slack(slack.clamp(i32::MIN as f64, i32::MAX as f64) as i32);

    // Pass 2: apply in arrival order. The reads can't fail now; a failure would skip the record.
    let mut off = first;
    for _ in 0..header.count {
        let Ok((head, _)) = RecordHead::read(msg, off) else { break };
        let len = head.words as usize * 4;
        let at = if head.frame_offset == wire::ASAP { None } else { Some(absolute(header.first_frame, head.frame_offset)) };
        match head.opcode {
            wire::op::PLAY => {
                if let Ok((p, _)) = Play::read(msg, off) {
                    voices::play(core, &p, at.unwrap_or(voices::ASAP));
                }
            }
            wire::op::STOP => {
                if let Ok((s, _)) = Stop::read(msg, off) {
                    let record = PendingRecord { voice_id: s.voice_id, op: wire::op::STOP as u8, frames: s.fade_frames, ..Default::default() };
                    schedule(core, record, at);
                }
            }
            wire::op::SET_PARAMS => {
                if let Ok((p, _)) = SetParams::read(msg, off) {
                    schedule(core, set_params_record(&p), at);
                }
            }
            wire::op::FADE => {
                if let Ok((f, _)) = Fade::read(msg, off) {
                    let record = PendingRecord {
                        voice_id: f.voice_id,
                        op: wire::op::FADE as u8,
                        flags: (f.flags & wire::FADE_FLAGS_STOP_AT_END) as u8,
                        values: [f.target, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                        frames: f.frames,
                        ..Default::default()
                    };
                    schedule(core, record, at);
                }
            }
            _ => {}
        }
        off += len;
    }
    wire::ERR_OK
}

/// `firstFrame + frameOffset` as an absolute frame (a negative or fractional `firstFrame` rounds,
/// and clamps at 0).
fn absolute(first_frame: f64, offset: u32) -> u64 {
    let f = libm::round(first_frame);
    let base = if f > 0.0 { f as u64 } else { 0 };
    base.saturating_add(offset as u64)
}

fn set_params_record(p: &SetParams) -> PendingRecord {
    PendingRecord {
        voice_id: p.voice_id,
        op: wire::op::SET_PARAMS as u8,
        mask: (p.mask & 0x7F) as u8,
        flags: ((p.flags & wire::SET_PARAMS_FLAGS_PANNER_MASK) >> wire::SET_PARAMS_FLAGS_PANNER_SHIFT) as u8,
        bus: p.bus.min(255) as u8,
        values: [p.gain, p.pitch, p.dir_x, p.dir_y, p.dir_z, p.lp_hz, p.score],
        frames: p.ramp_frames,
        frame: 0,
    }
}

/// Applies an asap record now, or queues a stamped one (at once if the queue is full).
fn schedule(core: &mut Core, mut record: PendingRecord, at: Option<u64>) {
    match at {
        None => apply(core, &record),
        Some(frame) => {
            record.frame = frame;
            if !push(core, record) {
                apply(core, &record);
            }
        }
    }
}

/// Inserts a record by frame, after any of the same frame (stable). `false` when full.
fn push(core: &mut Core, record: PendingRecord) -> bool {
    let q = queue(core.regions_mut());
    let (head, len) = (q.area.head as usize, q.area.len as usize);
    if len >= q.records.len() {
        return false;
    }
    if head > 0 {
        q.records.copy_within(head..head + len, 0);
        q.area.head = 0;
    }
    let mut i = len;
    while i > 0 && q.records[i - 1].frame > record.frame {
        q.records[i] = q.records[i - 1];
        i -= 1;
    }
    q.records[i] = record;
    q.area.len += 1;
    true
}

/// Removes and returns the earliest pending record whose frame is before `before` (the end of the
/// quantum being rendered), or `None`. Called by `voices::render`; never allocates.
pub fn pop_due(core: &mut Core, before: u64) -> Option<PendingRecord> {
    let q = queue(core.regions_mut());
    if q.area.len == 0 {
        return None;
    }
    let record = q.records[q.area.head as usize];
    if record.frame >= before {
        return None;
    }
    q.area.head += 1;
    q.area.len -= 1;
    if q.area.len == 0 {
        q.area.head = 0;
    }
    Some(record)
}

/// Applies one record that came due (or arrived asap, or found the queue full) to its voice.
pub fn apply(core: &mut Core, record: &PendingRecord) {
    match record.op as u16 {
        wire::op::STOP => voices::stop(core, record.voice_id, record.frames),
        wire::op::FADE => voices::fade(core, record.voice_id, record.values[0], record.frames, record.flags & 1 != 0),
        wire::op::SET_PARAMS => {
            let v = record.values;
            let p = SetParams {
                voice_id: record.voice_id,
                frame_offset: 0,
                mask: record.mask as u32,
                gain: v[0],
                pitch: v[1],
                dir_x: v[2],
                dir_y: v[3],
                dir_z: v[4],
                lp_hz: v[5],
                score: v[6],
                bus: record.bus as u32,
                ramp_frames: record.frames,
                flags: (record.flags as u32) << wire::SET_PARAMS_FLAGS_PANNER_SHIFT,
            };
            voices::set_params(core, &p);
        }
        _ => {}
    }
}

/// Pending records waiting.
pub fn pending_len(core: &mut Core) -> usize {
    queue(core.regions_mut()).area.len as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voices::{self, state};

    /// A BATCH of the given records (each already written, with its head).
    fn batch(first_frame: f64, records: &[Vec<u8>]) -> Vec<u8> {
        let body: usize = records.iter().map(|r| r.len()).sum();
        let mut buf = vec![0u8; 32 + body];
        let mut off = 32;
        for r in records {
            buf[off..off + r.len()].copy_from_slice(r);
            off += r.len();
        }
        Envelope::new(wire::kind::BATCH, 0, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        BatchHeader { first_frame, count: records.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
        buf
    }

    fn play(id: u32, frame_offset: u32) -> Vec<u8> {
        let mut b = vec![0u8; Play::FIXED_END];
        Play { voice_id: id, frame_offset, clip: 1, flags: wire::PLAY_FLAGS_MIXED, gain: 1.0, pitch: 1.0, dir_z: -1.0, ..Default::default() }.write(&mut b, 0).unwrap();
        b
    }

    fn stop(id: u32, frame_offset: u32) -> Vec<u8> {
        let mut b = vec![0u8; Stop::FIXED_END];
        Stop { voice_id: id, frame_offset, fade_frames: 0, reason: 0 }.write(&mut b, 0).unwrap();
        b
    }

    #[test]
    fn a_bad_envelope_is_refused() {
        let mut core = voices::tests::core();
        let good = batch(0.0, &[play(0x0001_0001, wire::ASAP)]);
        assert_eq!(submit(&mut core, &good[..10]), wire::ERR_TRUNCATED);
        let mut bad = good.clone();
        bad[0] ^= 1;
        assert_eq!(submit(&mut core, &bad), wire::ERR_BAD_MAGIC);
        let mut major = good.clone();
        major[5] = 2;
        assert_eq!(submit(&mut core, &major), wire::ERR_VERSION_MISMATCH);
        assert_ne!(status::counters(&core).flags & flag::VERSION_MISMATCH, 0);
        let mut short = good.clone();
        short[12..16].copy_from_slice(&1_000u32.to_le_bytes());
        assert_eq!(submit(&mut core, &short), wire::ERR_TRUNCATED);
        let mut other = good.clone();
        other[6] = wire::kind::TIME_PING as u8;
        assert_eq!(submit(&mut core, &other), wire::ERR_OK, "another kind is skipped");
        assert_eq!(voices::live_count(&mut core), 0, "nothing applied");
    }

    #[test]
    fn a_malformed_record_refuses_the_whole_batch() {
        let mut core = voices::tests::core();
        let mut short_play = play(0x0001_0002, wire::ASAP);
        short_play[2] = 4; // 16 bytes: shorter than PLAY's fixed part
        short_play.truncate(16);
        let msg = batch(0.0, &[play(0x0001_0001, wire::ASAP), short_play]);
        assert_eq!(submit(&mut core, &msg), wire::ERR_MALFORMED);
        assert_eq!(voices::live_count(&mut core), 0, "the good record before it didn't apply");
        let mut msg = batch(0.0, &[play(0x0001_0001, wire::ASAP)]);
        msg[24..28].copy_from_slice(&2u32.to_le_bytes()); // count says 2
        assert_eq!(submit(&mut core, &msg), wire::ERR_TRUNCATED);
    }

    #[test]
    fn unknown_opcodes_are_skipped() {
        let mut core = voices::tests::core();
        let mut unknown = vec![0u8; 20];
        RecordHead { opcode: 0x7F, words: 5, voice_id: 0, frame_offset: wire::ASAP }.write(&mut unknown, 0).unwrap();
        let msg = batch(0.0, &[unknown, play(0x0001_0001, wire::ASAP)]);
        assert_eq!(submit(&mut core, &msg), wire::ERR_OK);
        assert_eq!(voices::live_count(&mut core), 1);
    }

    #[test]
    fn stamped_records_stay_sorted_by_frame_and_stable() {
        let mut core = voices::tests::core();
        let msg = batch(1_000.0, &[stop(0x0001_0001, 50), stop(0x0001_0002, 10), stop(0x0001_0003, 50), stop(0x0001_0004, 0)]);
        assert_eq!(submit(&mut core, &msg), wire::ERR_OK);
        assert_eq!(pending_len(&mut core), 4);
        let got: Vec<(u64, u32)> = core::iter::from_fn(|| pop_due(&mut core, u64::MAX)).map(|r| (r.frame, r.voice_id)).collect();
        assert_eq!(got, vec![(1_000, 0x0001_0004), (1_010, 0x0001_0002), (1_050, 0x0001_0001), (1_050, 0x0001_0003)]);
        // Nothing before 1_000 is due; the queue compacts on the next insert.
        let msg = batch(2_000.0, &[stop(0x0001_0005, 0), stop(0x0001_0006, 0)]);
        submit(&mut core, &msg);
        assert!(pop_due(&mut core, 2_000).is_none());
        assert_eq!(pop_due(&mut core, 2_001).map(|r| r.voice_id), Some(0x0001_0005));
        let msg = batch(1_500.0, &[stop(0x0001_0007, 0)]);
        submit(&mut core, &msg);
        let got: Vec<u32> = core::iter::from_fn(|| pop_due(&mut core, u64::MAX)).map(|r| r.voice_id).collect();
        assert_eq!(got, vec![0x0001_0007, 0x0001_0006]);
    }

    #[test]
    fn asap_never_counts_late() {
        let mut core = voices::tests::core();
        let msg = batch(0.0, &[play(0x0001_0001, wire::ASAP), stop(0x0001_0001, wire::ASAP)]);
        assert_eq!(submit(&mut core, &msg), wire::ERR_OK);
        assert_eq!(pending_len(&mut core), 0, "asap records apply at once");
        assert_eq!(voices::slots(&core)[1].state, state::ENDED, "the asap STOP found the PLAY");
        assert_eq!(status::counters(&core).late_commands, 0);
    }

    #[test]
    fn a_stamped_play_writes_its_slot_at_once() {
        let mut core = voices::tests::core();
        let msg = batch(10_000.0, &[play(0x0001_0001, 5)]);
        submit(&mut core, &msg);
        let s = voices::slots(&core)[1];
        assert_eq!((s.state, s.start_frame), (state::SCHEDULED, 10_005));
        assert_eq!(absolute(-3.0, 4), 4);
        assert_eq!(absolute(99.6, 0), 100);
    }
}
