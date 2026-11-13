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
//! `scheduler.rs` and (stage B) `status.rs`. Ld2 (W6): taps, `LOUD_CONFIG`, the ring and take
//! semantics, flags, the true-peak gate, `wuLoudness`, the STATUS sections. Ld7 (W7): the ladder
//! step and `loudShed`.
//!
//! Nothing here allocates; [`tap`] runs inside `process`.

use crate::core::Core;

/// [`tap`]'s `bus` for the final output (the wire's `LOUD_OUTPUT_TAP`, Wa1's merge 1).
pub const OUTPUT_TAP: u16 = 0xFFFF;

/// A loudness tap: bus `bus`'s quantum `l`, `r` (post-fader: after its lanes, where the peak
/// meter reads it), or the final output after the limiter when `bus` is [`OUTPUT_TAP`]. Called by
/// `bus::mixdown` for every bus and once for the output. K1: a no-op. Ld2: K-weights and
/// accumulates the sub-block of a metered bus (a bus not metered returns at once), runs the true
/// peak (gated off master), and adds to `wuLoudness`; Ld7 skips paused meters.
#[inline]
pub fn tap(_bus: u16, _l: &[f32], _r: &[f32]) {}

/// `true` when a `LOUD_CONFIG` record (0x1B, API §4.2) at `msg[off..off + len]` holds its
/// `meterCount` items of 4 B. K1: `true` (the scheduler checks the fixed length); Ld2 fills it.
pub fn config_is_well_formed(_msg: &[u8], _off: usize, _len: usize) -> bool {
    true
}

/// `LOUD_CONFIG` (0x1B, API §4.2, asap): `tpGateDbfs` and the metered bus slots (master
/// implicit); replacing keeps the state of meters that stay. K1: a stub that ignores the record
/// and counts nothing. Ld2 fills it.
pub fn on_config(_core: &mut Core, _msg: &[u8], _off: usize) {}

/// RESET: reseeds the meters' filters and rings (the configuration stays; main keeps its
/// histograms, ARCH §4.4 "Rebuilds"). K1: a no-op; Ld2 fills it.
pub fn reset(_core: &mut Core) {}
