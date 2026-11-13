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
//! Nothing here allocates; [`tap`] runs inside `process`.

use audio_wire::generated as wire;

use crate::core::Core;
use crate::counters::MixSections;

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

const _: () = assert!(REGION_BYTES == 14_824, "ARCH §6: 9 × (1,512 + 128) B plus the header");
const _: () = assert!((METER_STATE_BYTES + RING_BYTES) % 8 == 0 && HEADER_BYTES % 8 == 0, "every meter starts 8-byte aligned (f64 state)");

/// Meter `i`'s state and ring bytes in the `Loudness` region (`None` past `METERS` or a short
/// region): `(state, ring)`, 1,512 and 128 B, each 8-byte aligned.
pub fn meter(region: &mut [u8], i: usize) -> Option<(&mut [u8], &mut [u8])> {
    if i >= METERS {
        return None;
    }
    let at = HEADER_BYTES + i * (METER_STATE_BYTES + RING_BYTES);
    region.get_mut(at..at + METER_STATE_BYTES + RING_BYTES).map(|m| m.split_at_mut(METER_STATE_BYTES))
}

/// Sets the meters up after the region is zeroed (`Core::new`, once). K1: a no-op. Ld2: K-weighting
/// coefficients from the rate, `loudSubBlockFrames` into the counters.
pub fn init(_core: &mut Core) {}

/// A loudness tap: bus `bus`'s quantum `l`, `r` (post-fader: after its lanes, where the peak
/// meter reads it), or the final output after the limiter when `bus` is [`OUTPUT_TAP`]. Called by
/// `bus::mixdown` for every bus and once for the output. K1: a no-op. Ld2: K-weights and
/// accumulates the sub-block of a metered bus (a bus not metered returns at once), runs the true
/// peak (gated off master), and adds to `wuLoudness`; Ld7 skips paused meters. `loudness` is the
/// `Loudness` region.
#[inline]
pub fn tap(_loudness: &mut [u8], _bus: u16, _l: &[f32], _r: &[f32]) {}

/// The `loudBuses` and `loudEnergies` STATUS sections (API §4.3) for a take: per meter that
/// reports, a `LoudBus` in `mix.loud_buses` and its sub-blocks since the last successful take,
/// oldest first, in `mix.loud_energies` (bus-major, the item's flags carrying the count). Called by
/// `status::take` before the block is written; must not advance the sent cursor ([`taken`] does).
/// K1: writes nothing (counts 0). Ld2 fills it.
pub fn status(_core: &mut Core, _mix: &mut MixSections) {}

/// After a successful take: the sub-blocks `mix` carried are sent, so each meter's sent cursor
/// advances and its take-relative peak resets (a failed take sends them again). K1: a no-op;
/// Ld2 fills it.
pub fn taken(_core: &mut Core, _mix: &MixSections) {}

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
/// implicit); replacing keeps the state of meters that stay. K1: a stub that ignores the record
/// and counts nothing. Ld2 fills it.
pub fn on_config(_core: &mut Core, _msg: &[u8], _off: usize) {}

/// RESET: reseeds the meters' filters and rings (the configuration stays; main keeps its
/// histograms, ARCH §4.4 "Rebuilds"). K1: a no-op; Ld2 fills it.
pub fn reset(_core: &mut Core) {}
