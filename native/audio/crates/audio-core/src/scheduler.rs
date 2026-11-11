//! Command apply and the scheduler (api-and-models §4.1, §4.2; architecture §3.3, §4.3, §4.4).
//!
//! [`submit`] parses one inbox message with `audio-wire`'s generated readers (contract K1). It runs
//! in `onmessage`, never inside `process`:
//! - The envelope is checked: a bad magic or a short message is refused; another **major** version
//!   is refused, counted with the STATUS `versionMismatch` flag; an unknown kind of this major is
//!   skipped. BATCH (1) and REPLAY (12) carry records; STREAM_OPEN (5) and STREAM_CLOSE (7) open
//!   and close a stream's ring (B3, `stream.rs`); other kinds aren't handled here.
//! - Every record head is validated before any record applies (lengths inside the message, at least
//!   the head; BUS_CONFIG and BUS_MIX also their per-bus entries), so a malformed batch changes
//!   nothing. Unknown opcodes are skipped by their length.
//! - SET_MIXED (A3.1, `voices::set_mixed`) applies at once, in arrival order, whatever its
//!   `frameOffset` (main's selection sends it asap; its 5 ms fade starts with the next quantum).
//! - SET_PAUSED (A3.7, `voices::set_paused`) is scheduled like STOP: asap applies at once, a stamped
//!   one at its frame (main sends it asap, ahead of the frame's SET_MIXED, so a resume and the
//!   promote that follows it land together).
//! - BUS_CONFIG, BUS_MIX and MASTER (A2.1, `bus.rs`) apply at once, in arrival order, whatever
//!   their `frameOffset`; their ramps start with the next quantum.
//! - ADR 0158 E2: CURVES, PARAM, AUTOMATE and BUS_AUTOMATE (`automation.rs`) apply at once, in
//!   arrival order, whatever their `frameOffset` (AUTOMATE finds its voice because PLAY writes the
//!   slot at once); SET_LOOP is scheduled like STOP (a release lands on its exact frame).
//! - RESET (A1.3b) applies at once, in arrival order, whatever its `frameOffset`: every voice and
//!   pending record is cleared, and with `keepClips = 0` every clip too and the arena reclaimed
//!   ([`reset`]). It's the first record of a rebuild's REPLAY, and A1.4 sends `RESET 0` when the
//!   last World is released.
//! - ADR 0162 (K2): SET_VOICE_FX is handed to `fxpool::set_voice_fx` with its frame (stamped like
//!   SET_PARAMS; D1 schedules it), BED_CONFIG to `bed::configure`, ZONE_CONFIG to
//!   `zones::configure` and LISTENER to `listener::set`, each at once. BED_CONFIG with more than
//!   `MAX_BEDS` slots or arrays past its length, and ZONE_CONFIG with more than `MAX_ZONE_SLOTS`
//!   slots or slots past its length, refuse the batch like any malformed record. The handlers parse
//!   and drop until their tasks fill them (A4, C3, D1, B3). RESET also calls their `reset`.
//! - `slack = firstFrame - currentFrame` is noted for STATUS `minSlackFrames`.
//!
//! **asap vs stamped** (architecture §4.3). `frameOffset == 0xFFFFFFFF` is asap: PLAY starts at
//! offset 0 of the next quantum, and STOP, SET_PARAMS and FADE apply at once (between quanta, so
//! the effect starts with the next quantum and ramps from its start). Never counted late. Any other
//! offset is the absolute frame `firstFrame + frameOffset`:
//! - PLAY writes its slot at once with that start frame (so later records for the voice find it),
//!   and the voice starts at the sample offset in its quantum.
//! - STOP, SET_PARAMS, FADE and SET_PAUSED wait in the pending queue (the `Pending` region, kept sorted by frame,
//!   stable) and apply at their sample offset in the quantum that contains their frame.
//! - A stamped frame already before the quantum being rendered applies at offset 0 and counts in
//!   `lateCommands` and `maxLatenessFrames` (§4.4). A full pending queue applies the record at once.
//!
//! The pending queue's head and length live in [`SchedulerArea`], in the core-state region after
//! the voices' area. `pop_due` (inside `process`) only moves the head; the queue is compacted when a
//! record is inserted (in `submit`).

use audio_wire::generated::{self as wire, BatchHeader, Envelope, Fade, Master, Play, RecordHead, Reset, SetParams, Stop};

use crate::core::{Core, Regions};
use crate::counters::flag;
use crate::layout::{PENDING_CAPACITY, PENDING_RECORD_BYTES};
use crate::{automation, bed, bus, fxpool, listener, status, voices, zones};

/// One stamped record waiting for its frame: 48 bytes (`PENDING_RECORD_BYTES`), all-zero valid.
/// STOP, SET_PARAMS, FADE and SET_PAUSED only (PLAY is written to its slot at once).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PendingRecord {
    /// Absolute context frame.
    pub frame: u64,
    pub voice_id: u32,
    /// The wire opcode (STOP, SET_PARAMS, FADE, SET_PAUSED, SEEK or SET_LOOP).
    pub op: u8,
    /// SET_PARAMS `mask` (bits 0–6).
    pub mask: u8,
    /// SET_PARAMS: the panner kind; FADE: bit0 stop at end; SET_PAUSED: bit0 paused; SET_LOOP: bit0 looping.
    pub flags: u8,
    /// SET_PARAMS `bus` (bus indices fit a byte: at most 256 buses).
    pub bus: u8,
    /// SET_PARAMS: gain, pitch, dirX, dirY, dirZ, lpHz, score. FADE: `[0]` target.
    pub values: [f32; 7],
    /// SET_PARAMS `rampFrames`; STOP `fadeFrames`; FADE `frames`; SEEK `clipFrame`; SET_LOOP
    /// `loopStartFrame` (its `loopEndFrame` rides in `values[0]`'s bits).
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
    match env.kind {
        wire::kind::BATCH | wire::kind::REPLAY => {}
        // B3: the stream control messages the shell passes through the inbox (STREAM_CHUNK goes
        // through `stream_chunk_ptr` and `stream_commit`).
        wire::kind::STREAM_OPEN => return stream_open(core, msg),
        wire::kind::STREAM_CLOSE => {
            return match wire::StreamClose::read(msg, 0) {
                Ok((c, _)) => {
                    if core.streams_mut().close(c.stream_id) {
                        wire::ERR_OK
                    } else {
                        wire::ERR_UNKNOWN_STREAM
                    }
                }
                Err(e) => e,
            };
        }
        _ => return wire::ERR_OK,
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
            wire::op::RESET => Reset::FIXED_END,
            wire::op::BUS_CONFIG => wire::BusConfig::FIXED_END,
            wire::op::BUS_MIX => wire::BusMix::FIXED_END,
            wire::op::MASTER => Master::FIXED_END,
            wire::op::SET_MIXED => wire::SetMixed::FIXED_END,
            wire::op::SET_PAUSED => wire::SetPaused::FIXED_END,
            wire::op::SEEK => wire::Seek::FIXED_END,
            wire::op::SET_LOOP => wire::SetLoop::FIXED_END,
            wire::op::AUTOMATE => wire::Automate::FIXED_END,
            wire::op::CURVES => wire::Curves::FIXED_END,
            wire::op::PARAM => wire::Param::FIXED_END,
            wire::op::BUS_AUTOMATE => wire::BusAutomate::FIXED_END,
            wire::op::SET_VOICE_FX => wire::SetVoiceFx::FIXED_END,
            wire::op::BED_CONFIG => wire::BedConfig::FIXED_END,
            wire::op::ZONE_CONFIG => wire::ZoneConfig::FIXED_END,
            wire::op::LISTENER => wire::Listener::FIXED_END,
            _ => RecordHead::FIXED_END,
        };
        if len < min || off + len > msg.len() {
            return wire::ERR_MALFORMED;
        }
        let entries_fit = match head.opcode {
            wire::op::BUS_CONFIG => bus::config_is_well_formed(msg, off, len),
            wire::op::BUS_MIX => bus::mix_is_well_formed(msg, off, len),
            wire::op::AUTOMATE | wire::op::BUS_AUTOMATE => automation::bindings_is_well_formed(msg, off, len),
            wire::op::CURVES => automation::curves_is_well_formed(msg, off, len),
            wire::op::BED_CONFIG => bed::config_is_well_formed(msg, off, len),
            wire::op::ZONE_CONFIG => zones::config_is_well_formed(msg, off, len),
            _ => true,
        };
        if !entries_fit {
            return wire::ERR_MALFORMED;
        }
        off += len;
    }

    let slack = header.first_frame - status::counters(core).current_frame;
    status::counters_mut(core).note_slack(slack.clamp(i32::MIN as f64, i32::MAX as f64) as i32);
    // A3.3: the adaptive cap's late gate (on-time batches with negative slack) and record count.
    crate::cap::note_batch(core, header.first_frame, header.count);

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
            wire::op::RESET => {
                if let Ok((r, _)) = Reset::read(msg, off) {
                    reset(core, r.keep_clips != 0);
                }
            }
            wire::op::SET_MIXED => {
                if let Ok((m, _)) = wire::SetMixed::read(msg, off) {
                    voices::set_mixed(core, &m);
                }
            }
            wire::op::SET_PAUSED => {
                if let Ok((p, _)) = wire::SetPaused::read(msg, off) {
                    let record = PendingRecord { voice_id: p.voice_id, op: wire::op::SET_PAUSED as u8, flags: (p.paused != 0) as u8, ..Default::default() };
                    schedule(core, record, at);
                }
            }
            wire::op::SEEK => {
                if let Ok((k, _)) = wire::Seek::read(msg, off) {
                    let record = PendingRecord { voice_id: k.voice_id, op: wire::op::SEEK as u8, frames: k.clip_frame, values: [f32::from_bits(k.epoch), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], ..Default::default() };
                    schedule(core, record, at);
                }
            }
            wire::op::SET_LOOP => {
                if let Ok((l, _)) = wire::SetLoop::read(msg, off) {
                    let record = PendingRecord {
                        voice_id: l.voice_id,
                        op: wire::op::SET_LOOP as u8,
                        flags: (l.flags & wire::SET_LOOP_FLAGS_LOOPING) as u8,
                        frames: l.loop_start_frame,
                        values: [f32::from_bits(l.loop_end_frame), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                        ..Default::default()
                    };
                    schedule(core, record, at);
                }
            }
            wire::op::AUTOMATE => automation::automate(core, msg, off),
            wire::op::BUS_AUTOMATE => automation::bus_automate(core, msg, off),
            wire::op::CURVES => automation::curves(core, msg, off),
            wire::op::PARAM => {
                if let Ok((p, _)) = wire::Param::read(msg, off) {
                    automation::param(core, &p);
                }
            }
            wire::op::SET_VOICE_FX => {
                if let Ok((fx, _)) = wire::SetVoiceFx::read(msg, off) {
                    fxpool::set_voice_fx(core, &fx, at);
                }
            }
            wire::op::BED_CONFIG => bed::configure(core, msg, off),
            wire::op::ZONE_CONFIG => zones::configure(core, msg, off),
            wire::op::LISTENER => {
                if let Ok((l, _)) = wire::Listener::read(msg, off) {
                    listener::set(core, &l);
                }
            }
            wire::op::BUS_CONFIG => bus::configure(core, msg, off),
            wire::op::BUS_MIX => bus::mix(core, msg, off),
            wire::op::MASTER => {
                if let Ok((m, _)) = Master::read(msg, off) {
                    bus::master(core, &m);
                }
            }
            _ => {}
        }
        off += len;
    }
    wire::ERR_OK
}

/// STREAM_OPEN (B3, `stream.rs`): takes or restarts the stream's ring. No ring free, or a shape the
/// ring can't hold: stream event 3 (error) for the stream and `ERR_BAD_ARG`; its voice waits until
/// main stops it.
fn stream_open(core: &mut Core, msg: &[u8]) -> i32 {
    let o = match wire::StreamOpen::read(msg, 0) {
        Ok((o, _)) => o,
        Err(e) => return e,
    };
    if core.streams_mut().open(&o) {
        return wire::ERR_OK;
    }
    let event = crate::counters::Event { id: o.stream_id, code: core.streams().refusal_code(&o) };
    status::counters_mut(core).stream_events.push(event);
    wire::ERR_BAD_ARG
}

/// RESET (api-and-models §4.2): frees every voice slot and drops every pending record, clears the
/// buses' DSP state (`bus::reset`: the tree and gains stay); unless `keep_clips`, drops every clip
/// and reclaims the arena (`clips::reset`). Ended voices aren't reported: main clears its own table
/// with the RESET. `onmessage` only.
pub fn reset(core: &mut Core, keep_clips: bool) {
    let regions = core.regions_mut();
    // All-zero bytes are free voice slots, an empty voices' area and an empty queue (the voices'
    // and scheduler's invariants: their regions are zeroed at init).
    regions.voices.fill(0);
    let area_end = SCHEDULER_AREA_OFFSET + core::mem::size_of::<SchedulerArea>();
    regions.core_state[voices::VOICE_AREA_OFFSET..area_end].fill(0);
    let c = status::counters_mut(core);
    c.live_voices = 0;
    c.mixed_voices = 0;
    bus::reset(core);
    // ADR 0158 E2: curves, parameters, bindings and loop regions.
    automation::reset(core);
    if !keep_clips {
        crate::clips::reset(core);
    }
    // B3: every voice is gone, so every ring is freed (main closes its streams with them).
    core.streams_mut().clear();
    // ADR 0162 §4.2: beds, zone slots, the pool and the listener (no-ops until A4, C3, D1, B3).
    bed::reset(core);
    zones::reset(core);
    fxpool::reset(core);
    listener::reset(core);
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
        wire::op::SET_PAUSED => voices::set_paused(core, record.voice_id, record.flags & 1 != 0),
        wire::op::SEEK => voices::seek(core, record.voice_id, record.frames, record.values[0].to_bits()),
        wire::op::SET_LOOP => voices::set_loop(core, record.voice_id, record.frames, record.values[0].to_bits(), record.flags & 1 != 0),
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
                shape: 0,
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
        Stop { voice_id: id, frame_offset, fade_frames: 0, reason: 0, shape: 0 }.write(&mut b, 0).unwrap();
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

    /// A core with clip 1 resident (4,096 frames of silence: long enough to stay live for 32 quanta).
    fn core_with_clip() -> Core {
        let mut core = voices::tests::core();
        core.clips_mut().reserve(1, 4_096, 1, 48_000.0, crate::clips::ClipFormat::I16).unwrap();
        core
    }

    #[test]
    fn slack_is_first_frame_minus_current_frame_and_may_be_negative() {
        // A3.2: STATUS `minSlackFrames` (architecture §3.3: "slack is firstFrame minus currentFrame").
        let mut core = voices::tests::core();
        status::counters_mut(&mut core).current_frame = 1_024.0;
        submit(&mut core, &batch(1_920.0, &[stop(0x0001_0009, wire::ASAP)]));
        assert_eq!(status::counters(&core).min_slack_frames(), 896);
        submit(&mut core, &batch(2_048.0, &[]));
        assert_eq!(status::counters(&core).min_slack_frames(), 896, "the block keeps its minimum");
        submit(&mut core, &batch(1_000.0, &[]));
        assert_eq!(status::counters(&core).min_slack_frames(), -24, "a batch that arrived after its firstFrame");
        // A refused batch notes nothing.
        let mut bad = batch(0.0, &[play(0x0001_0001, wire::ASAP)]);
        bad[24..28].copy_from_slice(&2u32.to_le_bytes());
        assert_eq!(submit(&mut core, &bad), wire::ERR_TRUNCATED);
        assert_eq!(status::counters(&core).min_slack_frames(), -24);
    }

    #[test]
    fn a_far_future_stamped_play_waits_then_starts_on_its_frame() {
        let mut core = core_with_clip();
        // Frame 100 * 128 + 37 = 12,837: a hundred quanta ahead.
        submit(&mut core, &batch(12_800.0, &[play(0x0001_0001, 37)]));
        for q in 0..100u64 {
            core.process(q * 128);
            assert_eq!(voices::slots(&core)[1].state, state::SCHEDULED, "quantum {q}: still waiting");
        }
        core.process(100 * 128);
        assert_eq!(voices::slots(&core)[1].state, state::PLAYING);
        assert_eq!(status::counters(&core).late_commands, 0);
    }

    #[test]
    fn a_stamped_stop_whose_frame_has_passed_applies_at_offset_0_and_counts_late() {
        let mut core = core_with_clip();
        submit(&mut core, &batch(0.0, &[play(0x0001_0001, wire::ASAP)]));
        core.process(0);
        core.process(128);
        // Frame 200 is inside the quantum at 128, already rendered: due before the quantum at 256 starts.
        submit(&mut core, &batch(200.0, &[stop(0x0001_0001, 0)]));
        assert_eq!(pending_len(&mut core), 1);
        core.process(256);
        assert_eq!(pending_len(&mut core), 0);
        assert!(status::counters(&core).ended.as_slice().contains(&0x0001_0001), "the STOP ended the voice");
        let c = status::counters(&core);
        assert_eq!(c.late_commands, 1);
        assert_eq!(c.max_lateness_frames, 56);
    }

    #[test]
    fn a_record_due_inside_the_quantum_is_not_late() {
        let mut core = core_with_clip();
        submit(&mut core, &batch(0.0, &[play(0x0001_0001, wire::ASAP)]));
        core.process(0);
        // Frame 255 is the last frame of the quantum at 128: on time, at offset 127.
        submit(&mut core, &batch(255.0, &[stop(0x0001_0001, 0)]));
        core.process(128);
        assert!(status::counters(&core).ended.as_slice().contains(&0x0001_0001), "the STOP ended the voice");
        assert_eq!(status::counters(&core).late_commands, 0);
    }

    fn reset_rec(keep_clips: u32) -> Vec<u8> {
        let mut b = vec![0u8; Reset::FIXED_END];
        Reset { voice_id: 0, frame_offset: wire::ASAP, keep_clips }.write(&mut b, 0).unwrap();
        b
    }

    #[test]
    fn reset_clears_every_voice_and_with_keep_clips_0_every_clip() {
        use crate::clips::ClipFormat;
        let mut core = voices::tests::core();
        core.clips_mut().reserve(1, 4_096, 2, 48_000.0, ClipFormat::I16).unwrap();
        core.clips_mut().reserve(2, 4_096, 2, 48_000.0, ClipFormat::I16).unwrap();
        let msg = batch(0.0, &[play(0x0001_0001, wire::ASAP), play(0x0001_0002, wire::ASAP), stop(0x0001_0001, 50_000)]);
        assert_eq!(submit(&mut core, &msg), wire::ERR_OK);
        core.process(0);
        assert_eq!(voices::live_count(&mut core), 2);
        assert_eq!(pending_len(&mut core), 1);

        // keepClips = 1: voices and pending records go, clips stay.
        assert_eq!(submit(&mut core, &batch(128.0, &[reset_rec(1)])), wire::ERR_OK);
        assert_eq!(voices::live_count(&mut core), 0);
        assert_eq!(pending_len(&mut core), 0);
        assert!(voices::slots(&core).iter().all(|s| s.state == state::FREE));
        assert_eq!(core.clips().len(), 2);

        // A REPLAY-like batch: RESET 0 first, then a PLAY that must survive it.
        let msg = batch(256.0, &[reset_rec(0), play(0x0002_0003, wire::ASAP)]);
        assert_eq!(submit(&mut core, &msg), wire::ERR_OK);
        assert_eq!(core.clips().len(), 0);
        assert_eq!(core.clips().arena().used_bytes(), 0, "the arena is reclaimed");
        assert_eq!(status::counters(&core).arena_used_kb, 0);
        assert_eq!(voices::live_count(&mut core), 1, "records after the RESET apply");
    }
}
