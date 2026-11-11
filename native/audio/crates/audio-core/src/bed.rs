//! Ambisonic beds (ADR 0162, api-and-models §5.1, architecture §3.1, contract C4 BED_CONFIG): bed
//! slots and their host buses, the encoded-voice pool, panner kind 2 with the equal-power
//! crossfade law, the decode before the host bus's effects (`decode_into`, called from `bus.rs`'s
//! pre-effects input hook), the bus-chain gain fold, RESET and the bed counters.
//!
//! Skeleton declared by K2 (task A1): the region's size, BED_CONFIG's well-formedness check and a
//! handler that parses the record and drops it, the `decode_into` hook and `reset` (no-ops). Task
//! A4 fills it and task B3 adds private decoders and `maxClips` stealing.
//!
//! The `Beds` region (C8) holds `max_beds` slots of [`BED_SLOT_BYTES`] plus `max_wide` private
//! decoders of the same size (B3), zero bytes when both are 0.

use audio_wire::generated as wire;

use crate::core::Core;
use crate::params::InitParams;

/// One bed slot's state, or one private decoder's (C8: 48 KB): the 16-channel encode buffer, the
/// decoder's partition history and its MagLS spectra share. A4 sizes its types to fit.
pub const BED_SLOT_BYTES: usize = 48 * 1024;

/// The `Beds` region's size: `(max_beds + max_wide) × 48 KB` (C8).
pub const fn region_bytes(p: &InitParams) -> usize {
    (p.max_beds as usize + p.max_wide as usize) * BED_SLOT_BYTES
}

fn u32_at(msg: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([msg[off], msg[off + 1], msg[off + 2], msg[off + 3]])
}

/// `true` when the BED_CONFIG record at `msg[off..off + len]` holds its `bedSlot[busCount]` and
/// `hostBus[slotCount]` arrays, each padded to 4 bytes, and `slotCount <= MAX_BEDS` (C2). The
/// scheduler refuses the whole batch otherwise.
pub fn config_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::BedConfig::FIXED_END || off + len > msg.len() {
        return false;
    }
    let buses = u32_at(msg, off + 12) as usize;
    let slots = u32_at(msg, off + 16) as usize;
    if slots > wire::MAX_BEDS as usize {
        return false;
    }
    let pad4 = |n: usize| n.checked_add(3).map(|n| n & !3);
    match (pad4(buses), pad4(2 * slots)) {
        (Some(a), Some(b)) => a.checked_add(b).is_some_and(|n| wire::BedConfig::FIXED_END + n <= len),
        _ => false,
    }
}

/// BED_CONFIG (C2, applies on arrival) from the well-formed record at `msg[off..]`. K2: parsed and
/// dropped; A4 validates the hosts, keeps the slots' decoder state and counts `bedsRefused`.
pub fn configure(core: &mut Core, msg: &[u8], off: usize) {
    let _ = (core, u32_at(msg, off + 12), u32_at(msg, off + 16));
}

/// The pre-effects input hook (`bus::mixdown`): decodes every bed slot hosted by `bus` into its
/// input buffer `l`, `r` before the bus's effects. K2: a no-op (no bed decodes before A4).
#[inline]
pub fn decode_into(beds: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let _ = (beds, bus, l, r);
}

/// RESET (§4.2: "RESET clears beds"). K2: a no-op.
pub fn reset(core: &mut Core) {
    let _ = core;
}
