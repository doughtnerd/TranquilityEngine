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
//! - 0171/0172 M5 (K1): BUS_RAMP (`lanes::on_ramp`), BUS_DUCK (`duck::on_rules`), BUS_PRESENCE
//!   (`duck::on_presence`), LOUD_CONFIG (`loudness::on_config`) and BUS_SLOT (`bus_slots::on_slot`)
//!   are handed to their owner with their frame (`None` asap), each record checked by its owner's
//!   `*_is_well_formed` in pass 1. Until B1a, B1b, B2, B3, Dp1 and Ld2 fill them the owners ignore
//!   the records. B1b adds class B routing.
//! - **0171/0172 M5 (B2): stamped configuration.** An asap `BUS_SLOT` or `BUS_PRESENCE` applies at
//!   once. A stamped one waits in the **configuration queue** ([`ConfigArea`], beside the pending
//!   queue: its records are variable and longer than 48 B), and applies at the start of the first
//!   quantum holding its frame ([`apply_due_config`], from `due::begin_quantum`), in (frame, batch
//!   order); it never enters the due list, so it can't overflow it (ARCH §4.7). `BUS_DUCK` and
//!   `LOUD_CONFIG` are asap only: their frame is ignored (API §4.2).
//! - **The late-batch rule (C27, ARCH §3.3).** Before pass 2 applies anything, every stamped
//!   `BUS_RAMP` and `BUS_SLOT` with a non-zero `sequenceId` is grouped by sequence
//!   ([`sequence_shifts`]): F0 = the sequence's earliest frame, q = the first frame of the next
//!   quantum to render. A sequence with F0 < q is shifted whole by s = ⌈(q − F0) / 128⌉ × 128, and a
//!   sequence that would start before the in-flight one's (shifted) end is shifted to that end, by
//!   whole quanta too; pass 2 adds s to every record of the sequence before handing it on (so
//!   `lanes::on_ramp` sees the shifted frame). A shifted sequence counts `lateCommands` once and
//!   raises `maxLatenessFrames` to s once. A sequence found late only when its `BUS_SLOT` comes due
//!   (the shell's frame jumped) is shifted then by [`shift_sequence`], which B1b also calls when it
//!   pops a late dip-down ramp.
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
use crate::{automation, bed, bus, bus_slots, duck, fxpool, lanes, listener, loudness, status, voices, zones};

/// One stamped record waiting for its frame: 48 bytes (`PENDING_RECORD_BYTES`), all-zero valid.
/// STOP, SET_PARAMS, FADE, SET_PAUSED, SEEK and SET_LOOP only (PLAY is written to its slot at once).
///
/// **The `shape` word** (api-and-models §4.2; 0166 M4-0, Z2a) rides in a value the record doesn't
/// otherwise use, so the record stays 48 B ([`shape_word`] reads it back):
/// - FADE: `values[1]`'s bits;
/// - STOP: `values[0]`'s bits;
/// - SET_PARAMS with the gain bit alone: `values[1]`'s bits (the pitch slot, outside its mask).
///
/// A shaped SET_PARAMS whose mask holds the gain bit **and** others (60 B on the wire, with all seven
/// values) is queued as two records at the same frame, in this order: the gain alone with its shape
/// (class G), then the other bits with no shape (class S). An unshaped one stays one record. The
/// word only shapes a gain ramp, so on a SET_PARAMS without the gain bit it is dropped.
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
            // Envelope 1.2: an older record without the appended `shape` word reads it as 0.
            wire::op::STOP => Stop::MIN_END,
            wire::op::SET_PARAMS => SetParams::MIN_END,
            wire::op::FADE => Fade::MIN_END,
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
            // 0171/0172 M5 (K1): the mix records (API §4.2).
            wire::op::BUS_RAMP => wire::BusRamp::FIXED_END,
            wire::op::BUS_DUCK => wire::BusDuck::FIXED_END,
            wire::op::BUS_PRESENCE => wire::BusPresence::FIXED_END,
            wire::op::LOUD_CONFIG => wire::LoudConfig::FIXED_END,
            wire::op::BUS_SLOT => wire::BusSlot::FIXED_END,
            _ => RecordHead::FIXED_END,
        };
        if len < min || off + len > msg.len() {
            return wire::ERR_MALFORMED;
        }
        let entries_fit = match head.opcode {
            wire::op::BUS_CONFIG => bus::config_is_well_formed(msg, off, len),
            wire::op::BUS_MIX => lanes::mix_is_well_formed(msg, off, len),
            wire::op::AUTOMATE | wire::op::BUS_AUTOMATE => automation::bindings_is_well_formed(msg, off, len),
            wire::op::CURVES => automation::curves_is_well_formed(msg, off, len),
            wire::op::BED_CONFIG => bed::config_is_well_formed(msg, off, len),
            wire::op::ZONE_CONFIG => zones::config_is_well_formed(msg, off, len),
            // 0171/0172 M5 (K1): each owner checks its own record.
            wire::op::BUS_RAMP => lanes::ramp_is_well_formed(msg, off, len),
            wire::op::BUS_DUCK => duck::rules_is_well_formed(msg, off, len),
            wire::op::LOUD_CONFIG => loudness::config_is_well_formed(msg, off, len),
            wire::op::BUS_SLOT => bus_slots::slot_is_well_formed(msg, off, len),
            _ => true,
        };
        if !entries_fit {
            return wire::ERR_MALFORMED;
        }
        off += len;
    }

    // M5 (B2): the late-batch rule, decided for the whole batch before anything applies.
    let shifts = sequence_shifts(core, msg, first, header.count, header.first_frame);

    let slack = header.first_frame - status::counters(core).current_frame;
    status::counters_mut(core).note_slack(slack.clamp(i32::MIN as f64, i32::MAX as f64) as i32);
    // A3.3: the adaptive cap's late gate (on-time batches with negative slack) and record count.
    crate::cap::note_batch(core, header.first_frame, header.count);

    // Pass 2: apply in arrival order. The reads can't fail now; a failure would skip the record.
    let mut off = first;
    for _ in 0..header.count {
        let Ok((head, _)) = RecordHead::read(msg, off) else { break };
        let len = head.words as usize * 4;
        let mut at = if head.frame_offset == wire::ASAP { None } else { Some(absolute(header.first_frame, head.frame_offset)) };
        // M5 (B2): a record of a shifted sequence moves with it (C27).
        if let Some(frame) = at.as_mut() {
            let s = shifts.of(record_sequence(msg, off, head.opcode));
            *frame = frame.saturating_add(s);
        }
        match head.opcode {
            wire::op::PLAY => {
                if let Ok((p, _)) = Play::read(msg, off) {
                    voices::play(core, &p, at.unwrap_or(voices::ASAP));
                }
            }
            wire::op::STOP => {
                if let Ok((s, _)) = Stop::read(msg, off) {
                    let record = PendingRecord {
                        voice_id: s.voice_id,
                        op: wire::op::STOP as u8,
                        frames: s.fade_frames,
                        values: [f32::from_bits(s.shape), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                        ..Default::default()
                    };
                    schedule(core, record, at);
                }
            }
            wire::op::SET_PARAMS => {
                if let Ok((p, _)) = SetParams::read(msg, off) {
                    let (gain, rest) = set_params_records(&p);
                    if let Some(gain) = gain {
                        schedule(core, gain, at);
                    }
                    if let Some(rest) = rest {
                        schedule(core, rest, at);
                    }
                }
            }
            wire::op::FADE => {
                if let Ok((f, _)) = Fade::read(msg, off) {
                    let record = PendingRecord {
                        voice_id: f.voice_id,
                        op: wire::op::FADE as u8,
                        flags: (f.flags & wire::FADE_FLAGS_STOP_AT_END) as u8,
                        values: [f.target, f32::from_bits(f.shape), 0.0, 0.0, 0.0, 0.0, 0.0],
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
            wire::op::BUS_MIX => lanes::mix(core, msg, off),
            // 0171/0172 M5 (K1): each arm calls its owner (B1a/B1b lanes, B3 and Dp1 duck, Ld2
            // loudness, B2 slots). `at` is the record's absolute frame (shifted with its sequence),
            // `None` asap; BUS_DUCK and LOUD_CONFIG are asap only (API §4.2), so their frame is
            // ignored. B2: a stamped BUS_SLOT or BUS_PRESENCE waits in the configuration queue.
            wire::op::BUS_RAMP => lanes::on_ramp(core, msg, off, at),
            wire::op::BUS_DUCK => duck::on_rules(core, msg, off),
            wire::op::BUS_PRESENCE => match at {
                None => duck::on_presence(core, msg, off, None),
                Some(frame) => schedule_config(core, msg, off, len, frame),
            },
            wire::op::LOUD_CONFIG => loudness::on_config(core, msg, off),
            wire::op::BUS_SLOT => match at {
                None => bus_slots::on_slot(core, msg, off, None),
                Some(frame) => schedule_config(core, msg, off, len, frame),
            },
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
    // M5 (B2): stamped configuration still waiting goes with the pending records, and so does the
    // in-flight sequence (main replays the end state after a RESET, API §4.2).
    regions.core_state[CONFIG_AREA_OFFSET..CONFIG_AREA_OFFSET + CONFIG_AREA_BYTES].fill(0);
    // 0166 M4-0: the due list and the parked records go, and every curve-pool entry with the slots
    // that linked them (all-zero is a free pool).
    crate::due::reset(core);
    core.regions_mut().curves.fill(0);
    // 0166 M4a (C2b): every group entry goes with its members.
    crate::groups::reset(core);
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
    // M5 (K1): the duck lane's detectors and followers (Dp1, Sc1) and the loudness meters (Ld2);
    // no-ops until those tasks fill them. The lanes settle in `bus::reset`.
    duck::reset(core);
    loudness::reset(core);
}

/// `firstFrame + frameOffset` as an absolute frame (a negative or fractional `firstFrame` rounds,
/// and clamps at 0).
fn absolute(first_frame: f64, offset: u32) -> u64 {
    let f = libm::round(first_frame);
    let base = if f > 0.0 { f as u64 } else { 0 };
    base.saturating_add(offset as u64)
}

/// SET_PARAMS as pending records (see [`PendingRecord`] on the shape word): `(gain, rest)`, where
/// `gain` is the gain-only record carrying the shape (for a gain-only mask, or a shaped mask with the
/// gain bit and others) and `rest` the record of every other bit (the whole record for an unshaped
/// mixed mask, or one without the gain bit). At least one is `Some`.
fn set_params_records(p: &SetParams) -> (Option<PendingRecord>, Option<PendingRecord>) {
    let whole = PendingRecord {
        voice_id: p.voice_id,
        op: wire::op::SET_PARAMS as u8,
        mask: (p.mask & 0x7F) as u8,
        flags: ((p.flags & wire::SET_PARAMS_FLAGS_PANNER_MASK) >> wire::SET_PARAMS_FLAGS_PANNER_SHIFT) as u8,
        bus: p.bus.min(255) as u8,
        values: [p.gain, p.pitch, p.dir_x, p.dir_y, p.dir_z, p.lp_hz, p.score],
        frames: p.ramp_frames,
        frame: 0,
    };
    let gain_bit = wire::SET_PARAMS_MASK_GAIN as u8;
    if whole.mask & gain_bit == 0 || (p.shape == 0 && whole.mask != gain_bit) {
        return (None, Some(whole));
    }
    let gain = PendingRecord { mask: gain_bit, values: [p.gain, f32::from_bits(p.shape), 0.0, 0.0, 0.0, 0.0, 0.0], ..whole };
    let rest = whole.mask & !gain_bit;
    (Some(gain), (rest != 0).then_some(PendingRecord { mask: rest, ..whole }))
}

/// A pending record's `shape` word (api-and-models §4.2: bits 0–2 the law, bits 16–31 the start
/// phase), or 0 (linear from phase 0) for a record that carries none. See [`PendingRecord`].
/// B1b (W3): a queued `BUS_RAMP` gets its arm here (bits 3–15 its `sequenceId`, which
/// `due::sequence_of` reads for the late-batch rule).
pub fn shape_word(record: &PendingRecord) -> u32 {
    match record.op as u16 {
        wire::op::FADE => record.values[1].to_bits(),
        wire::op::STOP => record.values[0].to_bits(),
        wire::op::SET_PARAMS if record.mask == wire::SET_PARAMS_MASK_GAIN as u8 => record.values[1].to_bits(),
        _ => 0,
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

/// R10, for `due::rebase` (C2d through it): shifts by `slip` frames every record still in the
/// pending queue whose voice satisfies `is_member` and whose frame is ≥ `from_frame`, then sorts
/// the queue by frame again, stable (records of one frame keep their queue order). Returns how many
/// moved. Control rate: a group start or resume, never per quantum.
pub fn rebase_pending(core: &mut Core, is_member: &dyn Fn(u32) -> bool, from_frame: u64, slip: u64) -> u32 {
    let q = queue(core.regions_mut());
    let (head, len) = (q.area.head as usize, q.area.len as usize);
    let live = &mut q.records[head..head + len];
    let mut moved = 0u32;
    for r in live.iter_mut() {
        if r.frame >= from_frame && is_member(r.voice_id) {
            r.frame = r.frame.saturating_add(slip);
            moved += 1;
        }
    }
    if moved == 0 || slip == 0 {
        return moved;
    }
    // Stable insertion sort by frame (records arrived in order; the shift broke it only forwards).
    for i in 1..live.len() {
        let r = live[i];
        let mut j = i;
        while j > 0 && live[j - 1].frame > r.frame {
            live[j] = live[j - 1];
            j -= 1;
        }
        live[j] = r;
    }
    moved
}

/// Applies one record that came due (or arrived asap, or found the queue full) to its voice.
///
/// 0166 M4-0: a per-voice record touches only its own voice, so this is also the **per-voice apply**
/// the in-voice path uses between a voice's sub-ranges (`voices.rs`, hook H1): `voices::render`
/// calls it with the core between two pieces of one voice's render, never inside a piece.
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
                shape: shape_word(record),
            };
            voices::set_params(core, &p);
        }
        _ => {}
    }
    // 0166 M4-0 (Z2b): a record that ramps a voice's fade or gain outside the gain loop (asap,
    // between a voice's pieces, at a quantum split) takes its `shape` here: a law or a start phase,
    // or, for shape 0, only the release of a curve it replaces on that ramp.
    let ramps_gain = match record.op as u16 {
        wire::op::STOP | wire::op::FADE => true,
        wire::op::SET_PARAMS => record.mask & wire::SET_PARAMS_MASK_GAIN as u8 != 0,
        _ => false,
    };
    if ramps_gain {
        voices::shape_applied(core, record);
    }
}

/// Pending records waiting.
pub fn pending_len(core: &mut Core) -> usize {
    queue(core.regions_mut()).area.len as usize
}

// --- M5 (B2): stamped configuration and the late-batch rule (API §4.2, ARCH §3.3, §4.7) ---

/// Stamped configuration records the queue holds (`BUS_SLOT`, `BUS_PRESENCE`). A removal of a
/// whole tree tombstones at most `MAX_BUSES` (32) slots in one sequence; the rest is room for
/// presence changes inside the lookahead. A record that finds it full applies at once (as a full
/// pending queue does).
pub const CONFIG_PENDING: usize = 64;
/// Bytes of one queued record's copy: a `BUS_SLOT` with the 4 effects it keeps is 28 + 4 × 32 =
/// 156 B; `BUS_PRESENCE` is 16 B.
pub const CONFIG_RECORD_BYTES: usize = 160;

/// One stamped configuration record waiting for its quantum: its absolute frame (shifted with its
/// sequence), its sequence and a copy of the record, head included (a `BUS_SLOT` cut to the
/// effects it keeps, its `effectCount` and head words patched to match). All-zero is valid.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ConfigRecord {
    pub frame: u64,
    /// `sequenceId` (13 bits, 0 = none; C27).
    pub sequence: u16,
    /// Bytes of `bytes` in use.
    pub len: u16,
    /// Effects past `BUS_SLOT_MAX_EFFECTS` cut from the copy, added to the dropped count at apply.
    pub dropped: u16,
    pub _pad: u16,
    pub bytes: [u8; CONFIG_RECORD_BYTES],
}

/// The configuration queue and the in-flight sequence, in the core-state region after the due
/// area. All-zero is valid (an empty queue, no sequence in flight).
#[repr(C)]
pub struct ConfigArea {
    /// Live records, `records[..len]`, sorted by frame, stable (batch order within a frame).
    pub len: u32,
    /// The last sequence seen (0 = none): later sequences are kept from starting before its end.
    pub inflight_sequence: u32,
    /// That sequence's end, shifted: the latest `frame + frames` of its records.
    pub inflight_end: u64,
    pub records: [ConfigRecord; CONFIG_PENDING],
}

const fn align_up(n: usize, to: usize) -> usize {
    (n + to - 1) / to * to
}

/// Offset of [`ConfigArea`] in the core-state region (after the due area).
pub const CONFIG_AREA_OFFSET: usize = align_up(crate::due::DUE_AREA_OFFSET + crate::due::DUE_AREA_BYTES, crate::layout::REGION_ALIGN);
/// Bytes it takes, rounded to a region alignment.
pub const CONFIG_AREA_BYTES: usize = align_up(core::mem::size_of::<ConfigArea>(), crate::layout::REGION_ALIGN);

const _: () = assert!(CONFIG_AREA_OFFSET + CONFIG_AREA_BYTES <= crate::layout::CORE_STATE_BYTES, "the configuration area fits the core-state region");
const _: () = assert!(core::mem::align_of::<ConfigArea>() <= crate::layout::REGION_ALIGN);
const _: () = assert!(wire::BusSlot::FIXED_END + wire::BUS_SLOT_MAX_EFFECTS as usize * wire::BusSlotEffects::FIXED_END <= CONFIG_RECORD_BYTES);

fn config_mut(regions: &mut Regions) -> &mut ConfigArea {
    let bytes = &mut regions.core_state[CONFIG_AREA_OFFSET..CONFIG_AREA_OFFSET + core::mem::size_of::<ConfigArea>()];
    // SAFETY: the core-state region is 64-byte aligned and zeroed at init; all-zero bytes are a
    // valid ConfigArea; CONFIG_AREA_OFFSET is a multiple of REGION_ALIGN and the area fits
    // (asserted above). Only this module views these bytes.
    unsafe { &mut *(bytes.as_mut_ptr() as *mut ConfigArea) }
}

/// The configuration queue and the in-flight sequence (tests and a debugger read it).
pub fn config_area(core: &Core) -> &ConfigArea {
    let bytes = &core.regions().core_state[CONFIG_AREA_OFFSET..CONFIG_AREA_OFFSET + core::mem::size_of::<ConfigArea>()];
    // SAFETY: as in `config_mut`.
    unsafe { &*(bytes.as_ptr() as *const ConfigArea) }
}

/// Stamped configuration records waiting.
pub fn config_pending_len(core: &Core) -> usize {
    config_area(core).len as usize
}

/// Distinct sequences [`sequence_shifts`] tracks in one batch. Main sends one sequence per batch
/// (structural ops of one display frame coalesce, ARCH §3.3); a ninth in one batch isn't shifted.
pub const MAX_BATCH_SEQUENCES: usize = 8;

#[derive(Clone, Copy, Default)]
struct Sequence {
    id: u16,
    first: u64,
    end: u64,
    shift: u64,
}

/// The shift of each sequence in one batch ([`sequence_shifts`]).
#[derive(Default)]
pub struct Shifts {
    seqs: [Sequence; MAX_BATCH_SEQUENCES],
    len: usize,
}

impl Shifts {
    /// The frames sequence `id` moves by (0 for none or an untracked sequence).
    pub fn of(&self, id: u16) -> u64 {
        if id == 0 {
            return 0;
        }
        self.seqs[..self.len].iter().find(|s| s.id == id).map_or(0, |s| s.shift)
    }
}

/// The `sequenceId` of the record at `msg[off..]` (C27): a `BUS_SLOT`'s field, a `BUS_RAMP`'s
/// `shape` bits 3–15; 0 for every other record.
pub fn record_sequence(msg: &[u8], off: usize, opcode: u16) -> u16 {
    match opcode {
        wire::op::BUS_SLOT => crate::wire_read::u16_at(msg, off + 16) & wire::SHAPE_SEQUENCE_MASK as u16,
        wire::op::BUS_RAMP => wire::ramp_sequence_id(crate::wire_read::u32_at(msg, off + 28)) as u16,
        _ => 0,
    }
}

/// The first frame of the next quantum the core renders: q of the late-batch rule. Between quanta
/// that is the frame after the last one rendered (`currentFrame`, which the shell's
/// `status::after_quantum` sets; also `frame + 128` once a quantum has rendered, for drivers that
/// don't call it).
pub fn next_quantum_frame(core: &Core) -> u64 {
    let rendered = if bus::area(core).rendered != 0 { core.frame() + crate::QUANTUM as u64 } else { 0 };
    let current = status::counters(core).current_frame;
    rendered.max(if current > 0.0 { current as u64 } else { 0 })
}

/// `frames` rounded up to whole quanta.
fn whole_quanta(frames: u64) -> u64 {
    frames.div_ceil(crate::QUANTUM as u64) * crate::QUANTUM as u64
}

/// The late-batch rule for one batch (C27, ARCH §3.3), before pass 2 applies anything: groups the
/// stamped `BUS_RAMP` and `BUS_SLOT` records by `sequenceId`, F0 = a sequence's earliest frame and
/// its end the latest `frame + frames`. In order of first appearance, a sequence is shifted by
/// s = ⌈max(q − F0, inFlightEnd − F0, 0) / 128⌉ × 128 (q = [`next_quantum_frame`]; the in-flight
/// end is that of the last sequence before it, shifted, so two dips never overlap). A shifted
/// sequence counts `lateCommands` + 1 and raises `maxLatenessFrames` to s, once. The sequence
/// becomes the in-flight one. Asap records carry no frame and are never shifted.
pub fn sequence_shifts(core: &mut Core, msg: &[u8], first: usize, count: u32, first_frame: f64) -> Shifts {
    let mut shifts = Shifts::default();
    let mut off = first;
    for _ in 0..count {
        let Ok((head, _)) = RecordHead::read(msg, off) else { break };
        let len = head.words as usize * 4;
        let id = record_sequence(msg, off, head.opcode);
        if id != 0 && head.frame_offset != wire::ASAP {
            let frame = absolute(first_frame, head.frame_offset);
            let frames = if head.opcode == wire::op::BUS_RAMP { crate::wire_read::u32_at(msg, off + 24) as u64 } else { 0 };
            let end = frame.saturating_add(frames);
            match shifts.seqs[..shifts.len].iter_mut().find(|s| s.id == id) {
                Some(s) => {
                    s.first = s.first.min(frame);
                    s.end = s.end.max(end);
                }
                None if shifts.len < MAX_BATCH_SEQUENCES => {
                    shifts.seqs[shifts.len] = Sequence { id, first: frame, end, shift: 0 };
                    shifts.len += 1;
                }
                None => {}
            }
        }
        off += len;
    }
    if shifts.len == 0 {
        return shifts;
    }
    let q = next_quantum_frame(core);
    for i in 0..shifts.len {
        let s = &mut shifts.seqs[i];
        let area = config_mut(core.regions_mut());
        let mut need = q.saturating_sub(s.first);
        if area.inflight_sequence != 0 && area.inflight_sequence != s.id as u32 {
            need = need.max(area.inflight_end.saturating_sub(s.first));
        }
        s.shift = whole_quanta(need);
        area.inflight_sequence = s.id as u32;
        area.inflight_end = area.inflight_end.max(s.end.saturating_add(s.shift));
        if s.shift > 0 {
            status::counters_mut(core).note_late(s.shift.min(u32::MAX as u64) as u32);
        }
    }
    shifts
}

/// Queues the stamped configuration record at `msg[off..off + len]` (`BUS_SLOT` or
/// `BUS_PRESENCE`) for `frame`, after any of the same frame; with the queue full it applies now.
fn schedule_config(core: &mut Core, msg: &[u8], off: usize, len: usize, frame: u64) {
    let opcode = crate::wire_read::u16_at(msg, off);
    let mut record = ConfigRecord { frame, sequence: record_sequence(msg, off, opcode), len: 0, dropped: 0, _pad: 0, bytes: [0; CONFIG_RECORD_BYTES] };
    let copy = if opcode == wire::op::BUS_SLOT {
        let n = crate::wire_read::u16_at(msg, off + 26) as usize;
        let kept = n.min(wire::BUS_SLOT_MAX_EFFECTS as usize);
        record.dropped = (n - kept).min(u16::MAX as usize) as u16;
        let copy = wire::BusSlot::FIXED_END + kept * wire::BusSlotEffects::FIXED_END;
        record.bytes[..copy].copy_from_slice(&msg[off..off + copy]);
        record.bytes[26..28].copy_from_slice(&(kept as u16).to_le_bytes());
        copy
    } else {
        let copy = len.min(CONFIG_RECORD_BYTES) & !3;
        record.bytes[..copy].copy_from_slice(&msg[off..off + copy]);
        copy
    };
    record.len = copy as u16;
    let words = RecordHead::WORDS_AT;
    record.bytes[words..words + 2].copy_from_slice(&((copy / 4) as u16).to_le_bytes());
    let area = config_mut(core.regions_mut());
    let n = area.len as usize;
    if n >= CONFIG_PENDING {
        apply_config_record(core, &record);
        return;
    }
    let mut i = n;
    while i > 0 && area.records[i - 1].frame > frame {
        area.records[i] = area.records[i - 1];
        i -= 1;
    }
    area.records[i] = record;
    area.len += 1;
}

/// Applies one configuration record that came due (or found the queue full).
fn apply_config_record(core: &mut Core, record: &ConfigRecord) {
    let bytes = &record.bytes[..record.len as usize];
    match crate::wire_read::u16_at(bytes, RecordHead::OPCODE_AT) {
        wire::op::BUS_SLOT => {
            bus_slots::on_slot(core, bytes, 0, Some(record.frame));
            let area = bus::view(core.regions_mut()).area;
            area.dropped = area.dropped.wrapping_add(record.dropped as u32);
        }
        wire::op::BUS_PRESENCE => duck::on_presence(core, bytes, 0, Some(record.frame)),
        _ => {}
    }
}

/// The start of quantum `frame` (from `due::begin_quantum`, before any voice renders): applies
/// every queued configuration record whose frame falls before the quantum's end, in (frame, batch
/// order) (ARCH §4.7). A record already late applies at the quantum's start and counts
/// `lateCommands` like any late stamped record — except a sequence's: a sequence still late here
/// (the shell's frame jumped past it after it arrived) is shifted whole by [`shift_sequence`]
/// instead, so its `BUS_SLOT` keeps following its dip-down.
pub fn apply_due_config(core: &mut Core, frame: u64) {
    let end = frame + crate::QUANTUM as u64;
    loop {
        let area = config_mut(core.regions_mut());
        if area.len == 0 || area.records[0].frame >= end {
            return;
        }
        let record = area.records[0];
        if record.sequence != 0 && record.frame < frame {
            shift_sequence(core, record.sequence, whole_quanta(frame - record.frame));
            continue;
        }
        let n = area.len as usize;
        area.records.copy_within(1..n, 0);
        area.len -= 1;
        if record.frame < frame {
            status::counters_mut(core).note_late((frame - record.frame).min(u32::MAX as u64) as u32);
        }
        apply_config_record(core, &record);
    }
}

/// Shifts structural sequence `sequence` by `s` frames (a whole number of quanta) wherever its
/// records still wait: the configuration queue and the pending queue (records whose
/// `due::sequence_of` is `sequence`; B1b's stamped dip ramps once they ride there). Both stay
/// sorted, stable. Counts `lateCommands` + 1 and raises `maxLatenessFrames` to `s`, once, and moves
/// the in-flight end when `sequence` is the one in flight. Returns the records moved. A caller
/// that has already popped one of the sequence's records (B1b's late dip-down) re-queues it at its
/// frame + `s` itself. Control rate only: never per quantum unless a sequence is late.
pub fn shift_sequence(core: &mut Core, sequence: u16, s: u64) -> u32 {
    if sequence == 0 || s == 0 {
        return 0;
    }
    let mut moved = 0u32;
    let area = config_mut(core.regions_mut());
    let n = area.len as usize;
    for r in area.records[..n].iter_mut().filter(|r| r.sequence == sequence) {
        r.frame = r.frame.saturating_add(s);
        moved += 1;
    }
    for i in 1..n {
        let r = area.records[i];
        let mut j = i;
        while j > 0 && area.records[j - 1].frame > r.frame {
            area.records[j] = area.records[j - 1];
            j -= 1;
        }
        area.records[j] = r;
    }
    if area.inflight_sequence == sequence as u32 {
        area.inflight_end = area.inflight_end.saturating_add(s);
    }
    let q = queue(core.regions_mut());
    let (head, len) = (q.area.head as usize, q.area.len as usize);
    let live = &mut q.records[head..head + len];
    let mut pending_moved = 0u32;
    for r in live.iter_mut().filter(|r| crate::due::sequence_of(r) == sequence) {
        r.frame = r.frame.saturating_add(s);
        pending_moved += 1;
    }
    if pending_moved > 0 {
        for i in 1..live.len() {
            let r = live[i];
            let mut j = i;
            while j > 0 && live[j - 1].frame > r.frame {
                live[j] = live[j - 1];
                j -= 1;
            }
            live[j] = r;
        }
    }
    status::counters_mut(core).note_late(s.min(u32::MAX as u64) as u32);
    moved + pending_moved
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

    /// `record` cut to `len` bytes, its head's word count to match (an older minor's record).
    fn cut(mut record: Vec<u8>, len: usize) -> Vec<u8> {
        record.truncate(len);
        record[2..4].copy_from_slice(&((len / 4) as u16).to_le_bytes());
        record
    }

    /// Envelope 1.2: STOP, FADE and SET_PARAMS of the sizes before the appended `shape` word are
    /// accepted and read it as 0; one shorter than that is still malformed.
    #[test]
    fn older_records_without_the_shape_word_read_it_as_0() {
        let id = 0x0001_0001;
        let mut full_stop = vec![0u8; Stop::FIXED_END];
        Stop { voice_id: id, frame_offset: 7, fade_frames: 33, reason: 0, shape: 0x0001_0003 }.write(&mut full_stop, 0).unwrap();
        let mut full_fade = vec![0u8; Fade::FIXED_END];
        Fade { voice_id: id, frame_offset: 7, target: 0.5, frames: 44, flags: 0, shape: 0x0001_0002 }.write(&mut full_fade, 0).unwrap();
        let mut full_set = vec![0u8; SetParams::FIXED_END];
        SetParams { voice_id: id, frame_offset: 7, mask: wire::SET_PARAMS_MASK_GAIN, gain: 0.25, ramp_frames: 55, shape: 0x0001_0001, ..Default::default() }.write(&mut full_set, 0).unwrap();
        let cases = [(full_stop, Stop::MIN_END, wire::op::STOP, 33), (full_fade, Fade::MIN_END, wire::op::FADE, 44), (full_set, SetParams::MIN_END, wire::op::SET_PARAMS, 55)];
        for (full, min, op, frames) in cases {
            assert!(min < full.len(), "op {op}: the shape word is appended");
            let mut core = voices::tests::core();
            assert_eq!(submit(&mut core, &batch(1_000.0, &[cut(full.clone(), min)])), wire::ERR_OK, "op {op}: the older size is accepted");
            let r = pop_due(&mut core, u64::MAX).expect("queued");
            assert_eq!((r.op as u16, r.frame, r.frames, shape_word(&r)), (op, 1_007, frames, 0), "op {op}: read with shape 0");
            let mut core = voices::tests::core();
            submit(&mut core, &batch(1_000.0, &[full]));
            assert_ne!(shape_word(&pop_due(&mut core, u64::MAX).unwrap()), 0, "op {op}: the full size keeps its shape");
            let mut core = voices::tests::core();
            let mut short = vec![0u8; min - 4];
            RecordHead { opcode: op, words: ((min - 4) / 4) as u16, voice_id: id, frame_offset: 7 }.write(&mut short, 0).unwrap();
            assert_eq!(submit(&mut core, &batch(1_000.0, &[short])), wire::ERR_MALFORMED, "op {op}: shorter still refused");
        }
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
