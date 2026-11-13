//! Loudness metering in the core (ADR 0171 §§ loudness, amended by 0172 §1.11, §3.4; architecture
//! §4.4, §4.8, R19, R20, R21; api-and-models §4.2 `LOUD_CONFIG`, §4.3 `loudBuses`,
//! `loudEnergies`).
//!
//! **Design.**
//! - **Meters:** master (the final output, `LOUD_OUTPUT_TAP`) plus up to `MAX_LOUDNESS_BUSES` (8)
//!   buses `LOUD_CONFIG` names: `LOUD_METERS` = 9. Core state 1,512 B per meter + a 128 B ring
//!   (9 × 1,640 B = 14.8 KB on every preset, ARCH §6).
//! - **Taps:** master after the reverb return, MASTER and the limiter (record change 11), with full
//!   true peak; other buses where the peak meter is: after effects, snapshot low-pass and all seven
//!   lanes (post-fader).
//! - **Per metered bus:** K-weighting in f64 (`audio_dsp::loudness`, Ld1), the L + R mean square
//!   per sub-block of round(0.1 × rate) frames into a 32-entry ring with a sequence number; 4×
//!   true peak (48 taps) every quantum on master, on other buses only while the sample peak reaches
//!   the ceiling − 6 dB (`tpGateDbfs`), skipped quanta counted.
//! - **The take:** each STATUS take carries, per metered bus, the sub-blocks since the last
//!   successful take and the peak since then (a 3.2 s main stall loses nothing).
//! - **The ladder** (R21, Ld7): its new first step pauses non-master metering (skipped when only
//!   master is metered), reported in `loudShed`; given back last.
//! - `wuLoudness` (cumulative work units) is this module's.
//!
//! **Who fills what.** K1 (W1): the hooks below, identity bodies, called from `bus.rs`,
//! `scheduler.rs` and `status.rs`. Ld2 (W6): taps, `LOUD_CONFIG`, the ring and take
//! semantics, flags, the true-peak gate, `wuLoudness`, the STATUS sections. Ld7 (W7): the ladder
//! step and `loudShed`.
//!
//! **The region (Ld2).** [`HEADER_BYTES`] of [`Header`] (`ready`, the last `tpGateDbfs`, the
//! work units not yet reported, Ld7's pause word, the taps' routes: slot → meter), then per meter
//! `i` its 1,512-B state and its 128-B ring. The state is Ld1's [`Meter`] (1,496 B) followed by
//! this module's 16-B [`Book`]: the bus slot, the active and reset bits, the sent cursor (the
//! sequence after the last sub-block a successful take carried) and the gate-skip count at that
//! take. Meter 0 is master, active from the first `LOUD_CONFIG` on (main sends one at configure
//! and in every replay); meters 1..=8 are the buses `LOUD_CONFIG` names, in the free index each
//! got when it was added (a meter that stays keeps its index, its state and its cursor). An
//! all-zero region is inert (no route), and nothing is metered until a `LOUD_CONFIG` arrives, so a
//! core never configured for loudness is bit for bit the K1 core.
//!
//! **Take semantics.** A meter's ring holds sub-block `e` at `e % 32`. [`status`] reports the
//! sub-blocks from the sent cursor to the meter's sequence, at most the 32 the ring still holds
//! (more: the oldest were overwritten, `LOUD_FLAG_LOST`, and `firstSeq` shows the gap); it changes
//! nothing, so a take whose buffer was too short sends the same sub-blocks next time. [`taken`]
//! advances each cursor past what the take carried, clears the take-relative peak and the reset
//! bit, and counts the lost sub-blocks in `loud_sub_blocks_lost`. Everything is on the audio clock:
//! a sub-block closes after round(0.1 × rate) rendered frames, whatever main's wall clock did.
//!
//! **Work units.** Each quantum a meter processes adds [`wu::METER`] (K-weighting, the sub-block
//! sum, the sample peak and the FIR history) and, when its true-peak FIR ran, [`wu::TRUE_PEAK`],
//! into the header's f64; [`status`] adds it to the cumulative `wuLoudness` and zeroes it (the
//! taps have no counters in hand, and the total only travels in STATUS).
//!
//! Nothing here allocates; [`tap`] runs inside `process`.

use audio_dsp::loudness::{ring_in_place, subblock_frames, Meter, Ring};
use audio_wire::generated as wire;

use crate::core::Core;
use crate::counters::{LoudBus, MixSections};
use crate::status;

/// [`tap`]'s `bus` for the final output (the wire's `LOUD_OUTPUT_TAP`).
pub const OUTPUT_TAP: u16 = wire::LOUD_OUTPUT_TAP as u16;
/// Meters: master plus `MAX_LOUDNESS_BUSES` (the wire's `LOUD_METERS`, 9).
pub const METERS: usize = wire::LOUD_METERS as usize;
/// One meter's DSP state (ARCH §5.3, spike S1: K-weighting biquads in f64, the sub-block
/// accumulator, the true-peak FIR history): 1,512 B. Ld1's state type must fit it.
pub const METER_STATE_BYTES: usize = 1_512;
/// One meter's ring: `LOUD_RING_SUBBLOCKS` (32) f32 sub-block energies = 128 B.
pub const RING_BYTES: usize = wire::LOUD_RING_SUBBLOCKS as usize * 4;
/// The region's header (Ld2: `tpGateDbfs`, the metered slots, the sent cursors, the pause): 64 B.
pub const HEADER_BYTES: usize = 64;
/// The `Loudness` region (ARCH §6): the header, then per meter its state and its ring
/// (meter `i` at `HEADER_BYTES + i × (METER_STATE_BYTES + RING_BYTES)`):
/// 64 + 9 × (1,512 + 128) = 14,824 B on every preset. Ld2 owns the bytes' layout inside it.
pub const REGION_BYTES: usize = HEADER_BYTES + METERS * (METER_STATE_BYTES + RING_BYTES);
/// Sub-blocks a ring holds (32 = 3.2 s).
const RING_LEN: u32 = wire::LOUD_RING_SUBBLOCKS;

const _: () = assert!(REGION_BYTES == 14_824, "ARCH §6: 9 × (1,512 + 128) B plus the header");
const _: () = assert!((METER_STATE_BYTES + RING_BYTES) % 8 == 0 && HEADER_BYTES % 8 == 0, "every meter starts 8-byte aligned (f64 state)");
const _: () = assert!(Meter::BYTES % 8 == 0 && Meter::BYTES + core::mem::size_of::<Book>() <= METER_STATE_BYTES, "Ld1's Meter and the book fit the state");
const _: () = assert!(core::mem::size_of::<Header>() == HEADER_BYTES);
const _: () = assert!(audio_dsp::loudness::RING_BYTES == RING_BYTES);

/// Work-unit coefficients (1 WU ≈ 1 ns on the lab machine, `cap.rs`'s convention), per meter per
/// quantum. Estimates from spike S1's container p50 (ARCH §7.1: a gated bus on ordinary content
/// 1.3 µs; master at full true peak 2.2 µs), to be refitted by Bn3's metered scenes.
pub mod wu {
    /// K-weighting, the sub-block sum, the sample peak and the FIR history (a quantum the gate skipped).
    pub const METER: u32 = 1_300;
    /// The 4× true-peak FIR, when it ran.
    pub const TRUE_PEAK: u32 = 900;
}

/// The region's header (64 B, 8-byte aligned). All-zero: not initialised.
#[repr(C)]
#[derive(Clone, Copy)]
struct Header {
    /// 1 once [`init`] ran.
    ready: u32,
    /// The last `LOUD_CONFIG`'s `tpGateDbfs` (0 until one arrives).
    tp_gate_dbfs: f32,
    /// Work units of the taps not yet added to `wuLoudness` ([`status`] moves them).
    wu: f64,
    /// Ld7: the ladder's loudness step, bits [`LADDER_PAUSED`], [`LADDER_PRESSURE`] and
    /// [`LADDER_SETTLED`] (0: running, no pressure).
    ladder: u16,
    /// 1 while master (meter 0) is active: the output tap's route.
    out_routed: u16,
    /// Per bus slot below [`ROUTED`], its meter's index + 1 (0: not metered), so a tap finds its meter
    /// at once; slots past it are looked up in the books ([`reroute`] keeps both in step).
    route: [u8; ROUTED],
    /// Ld7: the frames (their low 32 bits, compared with wrapping arithmetic) the current run of
    /// underruns at the cap's floor started, of its last underrun, and of the step being taken.
    pressure_since: u32,
    last_underrun: u32,
    paused_at: u32,
}

/// [`Header::ladder`]: the ladder's loudness step is in force (non-master meters paused, `loudShed` 1).
const LADDER_PAUSED: u16 = 1;
/// [`Header::ladder`]: underruns at the cap's floor are going on (since `pressure_since`).
const LADDER_PRESSURE: u16 = 2;
/// [`Header::ladder`]: the step has been in force for a whole [`crate::zones::LADDER_MS`], so the
/// audible steps may follow (set once, so a step held past the 32-bit frame wrap can't block them).
const LADDER_SETTLED: u16 = 4;

/// Bus slots [`Header::route`] covers (the core's 32 slots, tombstones included).
const ROUTED: usize = 32;

/// [`Book::flags`]: the meter is in use.
const ACTIVE: u16 = 1;
/// [`Book::flags`]: the next successful take carries `LOUD_FLAG_RESET` (a fresh sequence).
const RESET_PENDING: u16 = 2;

/// A meter's take bookkeeping, the last 16 B of its state (4-byte aligned).
#[repr(C)]
#[derive(Clone, Copy)]
struct Book {
    /// The bus slot, or [`OUTPUT_TAP`] for master.
    slot: u16,
    /// [`ACTIVE`], [`RESET_PENDING`].
    flags: u16,
    /// The sequence after the last sub-block a successful take carried.
    sent: u32,
    /// The meter's gate-skip count at the last successful take.
    skipped_seen: u32,
    reserved: u32,
}

/// Meter `i`'s state and ring bytes in the `Loudness` region (`None` past `METERS` or a short
/// region): `(state, ring)`, 1,512 and 128 B, each 8-byte aligned.
pub fn meter(region: &mut [u8], i: usize) -> Option<(&mut [u8], &mut [u8])> {
    if i >= METERS {
        return None;
    }
    let at = HEADER_BYTES + i * (METER_STATE_BYTES + RING_BYTES);
    region.get_mut(at..at + METER_STATE_BYTES + RING_BYTES).map(|m| m.split_at_mut(METER_STATE_BYTES))
}

/// The header in place (`None` for a short or misaligned region).
fn header(region: &mut [u8]) -> Option<&mut Header> {
    if region.len() < HEADER_BYTES || region.as_ptr() as usize % core::mem::align_of::<Header>() != 0 {
        return None;
    }
    // SAFETY: length and alignment checked; plain integers and floats, so any bit pattern is a
    // valid `Header`; the borrow of `region` is exclusive.
    Some(unsafe { &mut *(region.as_mut_ptr() as *mut Header) })
}

/// Meter `i` in place: Ld1's state, this module's book, the ring.
fn parts(region: &mut [u8], i: usize) -> Option<(&mut Meter, &mut Book, &mut Ring)> {
    let (state, ring) = meter(region, i)?;
    let (m, book) = state.split_at_mut(Meter::BYTES);
    let m = Meter::in_place(m)?;
    if book.len() < core::mem::size_of::<Book>() || book.as_ptr() as usize % core::mem::align_of::<Book>() != 0 {
        return None;
    }
    // SAFETY: length and alignment checked; plain integers, any bit pattern is valid; exclusive.
    let book = unsafe { &mut *(book.as_mut_ptr() as *mut Book) };
    Some((m, book, ring_in_place(ring)?))
}

/// The linear true-peak gate for `tpGateDbfs` (a non-finite value runs the FIR every quantum).
fn gate_linear(dbfs: f32) -> f32 {
    if dbfs.is_finite() {
        libm::powf(10.0, dbfs / 20.0)
    } else {
        0.0
    }
}

/// Sets meter `i` up fresh for `slot` (a reset take follows).
fn start_meter(region: &mut [u8], i: usize, slot: u16, rate: f32, gate: f32) {
    if let Some((state, ring)) = meter(region, i) {
        state.fill(0);
        ring.fill(0);
    }
    if let Some((m, book, _)) = parts(region, i) {
        m.init(rate as f64);
        m.set_true_peak_gate(gate);
        *book = Book { slot, flags: ACTIVE | RESET_PENDING, sent: 0, skipped_seen: 0, reserved: 0 };
    }
}

/// Rebuilds the header's routes from the books (after `LOUD_CONFIG` changed them).
fn reroute(region: &mut [u8]) {
    let mut route = [0u8; ROUTED];
    let mut out = 0;
    for i in 0..METERS {
        if let Some((_, book, _)) = parts(region, i) {
            if book.flags & ACTIVE == 0 {
                continue;
            }
            if book.slot == OUTPUT_TAP {
                out = 1;
            } else if (book.slot as usize) < ROUTED {
                route[book.slot as usize] = i as u8 + 1;
            }
        }
    }
    if let Some(h) = header(region) {
        h.out_routed = out;
        h.route = route;
    }
}

/// Readies the region after it is zeroed (`Core::new`, once) and puts `loudSubBlockFrames` into
/// the counters. No meter runs yet: master starts with the first `LOUD_CONFIG` ([`on_config`]),
/// which main sends when it configures the mixer and in every rebuild's replay, so a core nobody
/// configured for loudness renders and reports exactly as before M5 (the null case).
pub fn init(core: &mut Core) {
    let rate = core.params().sample_rate;
    if let Some(h) = header(&mut core.regions_mut().loudness[..]) {
        h.ready = 1;
    }
    status::counters_mut(core).mix.loud_sub_block_frames = subblock_frames(rate as f64);
}

/// A loudness tap: bus `bus`'s quantum `l`, `r` (post-fader: after its lanes, where the peak
/// meter reads it), or the final output after the limiter when `bus` is [`OUTPUT_TAP`]. Called by
/// `bus::mixdown` for every bus and once for the output. K-weights and accumulates the sub-block
/// of a metered bus (a bus not metered returns after one header read), runs the true peak (gated
/// off master), and adds to `wuLoudness`. While the ladder's loudness step is in force a bus tap
/// returns after the header read: no K-weighting, sub-block or true peak (master keeps metering).
/// `loudness` is the `Loudness` region. Reads the signal only.
#[inline]
pub fn tap(loudness: &mut [u8], bus: u16, l: &[f32], r: &[f32]) {
    let Some(h) = header(loudness) else { return };
    let i = if bus == OUTPUT_TAP {
        if h.out_routed == 0 {
            return;
        }
        0
    } else if h.ladder & LADDER_PAUSED != 0 {
        // Ld7 (ARCH §4.8): the ladder's loudness step stops every meter but master.
        return;
    } else if (bus as usize) < ROUTED {
        match h.route[bus as usize] {
            0 => return,
            k => k as usize - 1,
        }
    } else {
        match (1..METERS).find(|&i| parts(loudness, i).is_some_and(|(_, b, _)| b.flags & ACTIVE != 0 && b.slot == bus)) {
            Some(i) => i,
            None => return,
        }
    };
    let Some((m, _, ring)) = parts(loudness, i) else { return };
    let ran = m.true_peak_counts().0;
    m.process(l, r, ring);
    let mut units = wu::METER as f64;
    if m.true_peak_counts().0 != ran {
        units += wu::TRUE_PEAK as f64;
    }
    if let Some(h) = header(loudness) {
        h.wu += units;
    }
}

/// The `loudBuses` and `loudEnergies` STATUS sections (API §4.3) for a take: per active meter, a
/// `LoudBus` in `mix.loud_buses` and its sub-blocks since the last successful take, oldest first,
/// in `mix.loud_energies` (bus-major, the item's flags carrying the count), in meter order (master
/// first); and `wuLoudness`. Called by `status::take` before the block is written; doesn't advance
/// the sent cursor ([`taken`] does), so it can run again for the same take.
pub fn status(core: &mut Core, mix: &mut MixSections) {
    let region = &mut core.regions_mut().loudness[..];
    let Some(h) = header(region) else { return };
    if h.ready == 0 {
        return;
    }
    let wu = core::mem::take(&mut h.wu);
    let paused = h.ladder & LADDER_PAUSED != 0;
    for i in 0..METERS {
        let Some((m, book, ring)) = parts(region, i) else { break };
        if book.flags & ACTIVE == 0 {
            continue;
        }
        let seq = m.seq();
        let pending = seq.wrapping_sub(book.sent);
        let n = pending.min(RING_LEN);
        let first = seq.wrapping_sub(n);
        let (_, skipped) = m.true_peak_counts();
        let mut flags = n as u16 & wire::LOUD_FLAG_NEW_BLOCKS_MASK as u16;
        if book.flags & RESET_PENDING != 0 {
            flags |= wire::LOUD_FLAG_RESET as u16;
        }
        if pending > RING_LEN {
            flags |= wire::LOUD_FLAG_LOST as u16;
        }
        if skipped != book.skipped_seen {
            flags |= wire::LOUD_FLAG_GATED as u16;
        }
        if m.true_peak_gate() > 0.0 {
            flags |= wire::LOUD_FLAG_TP_GATE_ACTIVE as u16;
        }
        if paused && i != 0 {
            flags |= wire::LOUD_FLAG_PAUSED as u16;
        }
        let peak = m.peak();
        mix.loud_buses.push(LoudBus { slot: book.slot, flags, first_seq: first, true_peak: peak[0].max(peak[1]), gated_quanta: skipped });
        for e in 0..n {
            mix.loud_energies.push(ring[(first.wrapping_add(e) % RING_LEN) as usize]);
        }
    }
    status::counters_mut(core).mix.wu_loudness += wu;
}

/// After a successful take: the sub-blocks `mix` carried are sent, so each meter's sent cursor
/// advances past them, its take-relative peak and its reset bit clear, and sub-blocks the ring
/// overwrote before this take count in `loud_sub_blocks_lost` (a failed take sends them again).
pub fn taken(core: &mut Core, mix: &MixSections) {
    let region = &mut core.regions_mut().loudness[..];
    let mut lost = 0u32;
    for item in mix.loud_buses.as_slice() {
        for i in 0..METERS {
            let Some((m, book, _)) = parts(region, i) else { break };
            if book.flags & ACTIVE == 0 || book.slot != item.slot {
                continue;
            }
            if item.flags & wire::LOUD_FLAG_LOST as u16 != 0 {
                lost = lost.wrapping_add(item.first_seq.wrapping_sub(book.sent));
            }
            book.sent = item.first_seq.wrapping_add((item.flags & wire::LOUD_FLAG_NEW_BLOCKS_MASK as u16) as u32);
            book.skipped_seen = item.gated_quanta;
            book.flags &= !RESET_PENDING;
            m.take_peak();
            break;
        }
    }
    if lost != 0 {
        let x = &mut status::counters_mut(core).mix;
        x.loud_sub_blocks_lost = x.loud_sub_blocks_lost.wrapping_add(lost);
    }
}

/// `true` when a `LOUD_CONFIG` record (0x1B, API §4.2) at `msg[off..off + len]` holds its
/// `meterCount` items of 4 B (pass 1 of `scheduler::submit`: a malformed record refuses the batch;
/// more than 8 meters is dropped and counted at apply, not refused).
pub fn config_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::LoudConfig::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = crate::wire_read::u32_at(msg, off + 16) as usize;
    n.checked_mul(wire::LoudConfigMeters::FIXED_END).is_some_and(|bytes| wire::LoudConfig::FIXED_END + bytes <= len)
}

/// `LOUD_CONFIG` (0x1B, API §4.2, asap): `tpGateDbfs` and the metered bus slots (master
/// implicit), replace-all, applied before the next quantum renders. A meter whose slot stays keeps
/// its state, cursor and index (a gate change alone is not a reset); one no longer named stops
/// (inert); a new one starts fresh, its first take flagged `reset`. Items past the eighth, a slot
/// past the configured buses, `LOUD_OUTPUT_TAP` and duplicates are dropped and counted in
/// `loud_meters_dropped` (a level). The gate applies to every non-master meter; master's FIR runs
/// every quantum. Pass 1 checked the record's extent.
pub fn on_config(core: &mut Core, msg: &[u8], off: usize) {
    let gate_dbfs = f32::from_bits(crate::wire_read::u32_at(msg, off + 12));
    let n = crate::wire_read::u32_at(msg, off + 16) as usize;
    let buses = crate::bus::count(core);
    let rate = core.params().sample_rate;
    let mut want = [0u16; METERS - 1];
    let mut wanted = 0usize;
    let mut dropped = 0u32;
    for k in 0..n {
        let slot = crate::wire_read::u16_at(msg, off + wire::LoudConfig::FIXED_END + 4 * k);
        if wanted == want.len() || slot == OUTPUT_TAP || slot as usize >= buses || want[..wanted].contains(&slot) {
            dropped += 1;
            continue;
        }
        want[wanted] = slot;
        wanted += 1;
    }
    let want = &want[..wanted];
    let gate = gate_linear(gate_dbfs);
    let region = &mut core.regions_mut().loudness[..];
    if let Some(h) = header(region) {
        h.tp_gate_dbfs = gate_dbfs;
    }
    // Master: started by the first record, then kept (its gate stays 0: the FIR every quantum).
    if parts(region, 0).is_some_and(|(_, book, _)| book.flags & ACTIVE == 0) {
        start_meter(region, 0, OUTPUT_TAP, rate, 0.0);
    }
    // Meters that stay take the new gate; the others stop.
    let mut have = [u16::MAX; METERS];
    for i in 1..METERS {
        let stop = match parts(region, i) {
            Some((m, book, _)) if book.flags & ACTIVE != 0 => {
                if want.contains(&book.slot) {
                    m.set_true_peak_gate(gate);
                    have[i] = book.slot;
                    false
                } else {
                    true
                }
            }
            _ => false,
        };
        if stop {
            if let Some((state, ring)) = meter(region, i) {
                state.fill(0);
                ring.fill(0);
            }
        }
    }
    // New ones take a free index.
    for &slot in want {
        if have.contains(&slot) {
            continue;
        }
        if let Some(i) = (1..METERS).find(|&i| have[i] == u16::MAX) {
            start_meter(region, i, slot, rate, gate);
            have[i] = slot;
        }
    }
    reroute(region);
    status::counters_mut(core).mix.loud_meters_dropped = dropped.min(u16::MAX as u32) as u16;
}

/// RESET: reseeds the meters' filters and rings and restarts each sequence (the next take carries
/// `reset`); the configuration and the gate stay (main keeps its histograms, ARCH §4.4
/// "Rebuilds"), and so does the cumulative `wuLoudness`.
pub fn reset(core: &mut Core) {
    let region = &mut core.regions_mut().loudness[..];
    for i in 0..METERS {
        reseed(region, i);
    }
}

/// Reseeds meter `i` when it is active: filters, open sub-block, peaks and counters cleared, the
/// ring zeroed, the sequence and the sent cursor back to 0, the next take flagged `reset`.
fn reseed(region: &mut [u8], i: usize) {
    let active = match parts(region, i) {
        Some((m, book, _)) if book.flags & ACTIVE != 0 => {
            m.reset();
            book.sent = 0;
            book.skipped_seen = 0;
            book.flags |= RESET_PENDING;
            true
        }
        _ => false,
    };
    if active {
        if let Some((_, ring)) = meter(region, i) {
            ring.fill(0);
        }
    }
}

/// The frames of the ladder's trigger and spacing at `rate` (`zones::LADDER_MS`, 1 s, as the bed
/// and zone steps count it).
fn ladder_frames(rate: f32) -> u32 {
    crate::cap_controller::ms_to_frames(crate::zones::LADDER_MS, rate).min(u32::MAX as u64) as u32
}

/// Whether a meter other than master is active (the loudness step has something to pause).
fn has_bus_meters(region: &mut [u8]) -> bool {
    (1..METERS).any(|i| parts(region, i).is_some_and(|(_, book, _)| book.flags & ACTIVE != 0))
}

/// Ld7 (R21, ARCH §4.8): the ladder's loudness step, checked once a quantum after the buses mixed
/// (`zones::after_render` calls it first, before the zone steps). Its trigger is the ladder's own,
/// as `zones.rs` counts it: the adaptive cap at its floor and underruns going on for
/// [`crate::zones::LADDER_MS`] (a gap of more than that between underruns starts the run again).
/// The step pauses every non-master meter (see [`tap`]) and sets `loudShed`; it is **skipped** while
/// only master is metered, so the audible steps aren't delayed for nothing. It is the ladder's
/// first step: [`audible_steps_may_start`] holds the bed and zone steps back until it has been in
/// force for another `LADDER_MS`. `cap.rs`'s recovery clock gives it back last
/// ([`restore_step`]). Never allocates; at the cap's floor or above it, without underruns, it is a
/// header read.
pub fn ladder(core: &mut Core) {
    let (at_floor, underrun) = {
        let c = core.cap();
        (c.cap() <= c.config().floor, c.underrun_pending())
    };
    // The frame's low 32 bits: every comparison below is a wrapping difference of at most seconds.
    let frame = core.frame() as u32;
    let rate = core.params().sample_rate;
    let region = &mut core.regions_mut().loudness[..];
    let Some(h) = header(region) else { return };
    if h.ladder & (LADDER_PAUSED | LADDER_SETTLED) == LADDER_PAUSED && frame.wrapping_sub(h.paused_at) >= ladder_frames(rate) {
        h.ladder |= LADDER_SETTLED;
    }
    if !at_floor {
        h.ladder &= !LADDER_PRESSURE;
        return;
    }
    if !underrun {
        if h.ladder & LADDER_PRESSURE != 0 && frame.wrapping_sub(h.last_underrun) > ladder_frames(rate) {
            h.ladder &= !LADDER_PRESSURE;
        }
        return;
    }
    if h.ladder & LADDER_PRESSURE == 0 {
        h.ladder |= LADDER_PRESSURE;
        h.pressure_since = frame;
        h.last_underrun = frame;
        return;
    }
    h.last_underrun = frame;
    if h.ladder & LADDER_PAUSED != 0 || frame.wrapping_sub(h.pressure_since) < ladder_frames(rate) || !has_bus_meters(region) {
        return;
    }
    let Some(h) = header(region) else { return };
    h.pressure_since = frame;
    h.paused_at = frame;
    h.ladder = (h.ladder | LADDER_PAUSED) & !LADDER_SETTLED;
    status::counters_mut(core).mix.loud_shed = 1;
}

/// Ld7 (ARCH §4.8, O4): whether the ladder's audible steps (`bed.rs`'s bed-idle step, `zones.rs`'s
/// two) may go ahead at the current frame. The loudness step comes first: while a non-master meter
/// is active and the step isn't in force, no audible step is taken (it will be, on this quantum's
/// [`ladder`] check), and once it is in force the next step waits a whole `LADDER_MS`, as each
/// later step waits for the one before. With only master metered this is always true, so the
/// ladder runs exactly as before M5. Called only when an audible step is due (the cap at its floor,
/// a fresh underrun).
pub fn audible_steps_may_start(core: &mut Core) -> bool {
    let frame = core.frame() as u32;
    let rate = core.params().sample_rate;
    let region = &mut core.regions_mut().loudness[..];
    let Some(h) = header(region) else { return true };
    if h.ladder & LADDER_PAUSED != 0 {
        return h.ladder & LADDER_SETTLED != 0 || frame.wrapping_sub(h.paused_at) >= ladder_frames(rate);
    }
    !has_bus_meters(region)
}

/// Ld7: the ladder's loudness step in force, 0 or 1 (STATUS `loudShed`; `cap.rs`'s recovery clock
/// counts it with the bed and zone steps, which `m3Shed` keeps reporting alone).
pub fn shed_steps(core: &mut Core) -> u32 {
    header(&mut core.regions_mut().loudness[..]).map_or(0, |h| (h.ladder & LADDER_PAUSED) as u32)
}

/// Ld7 (ADR 0170, R21): gives the loudness step back, last (`cap.rs`'s recovery clock, after the
/// zone and bed steps). Each non-master meter is reseeded, so its first sub-block after the span
/// holds only signal from after it, and its next take is flagged `reset` (main restarts the feed
/// and marks the reading `incomplete`); master never stopped and is untouched. `loudShed` returns
/// to 0. Returns whether the step was in force.
pub fn restore_step(core: &mut Core) -> bool {
    let region = &mut core.regions_mut().loudness[..];
    let Some(h) = header(region) else { return false };
    if h.ladder & LADDER_PAUSED == 0 {
        return false;
    }
    h.ladder = 0;
    for i in 1..METERS {
        reseed(region, i);
    }
    status::counters_mut(core).mix.loud_shed = 0;
    true
}
