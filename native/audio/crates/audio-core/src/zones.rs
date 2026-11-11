//! Reverb zones (ADR 0162, api-and-models §5.2, architecture §4.4, contract C5 ZONE_CONFIG): the
//! fixed `Zones` region of convolver slots, the ZONE_CONFIG table and slot state machine (off,
//! waiting for kernel, fading in, active, ringing out, evicting), the return buses (`add_returns`,
//! called from `bus.rs`'s pre-effects input hook), the shared-return scale and the STATUS zone
//! slots.
//!
//! Skeleton declared by K2 (task A1): the region and kernel-budget sizes, ZONE_CONFIG's
//! well-formedness check and a handler that parses the record and drops it, the `add_returns` hook
//! and `reset` (no-ops). Task C3 fills it, C4 adds the inputs and C3b the in-core IR preparation.
//!
//! **Sizes (C8).** The `Zones` region holds `max_zone_slots` convolver states (input histories,
//! frequency-domain delay lines, accumulators, rings and FFT scratch) for an IR of
//! `zone_max_frames`. The prepared kernels (format 3, or format 5 prepared in the core) are clips in
//! the arena, outside `clipMemoryMB`, and [`kernel_budget_bytes`] (the
//! `myco_audio_zone_kernel_budget_bytes` export) is what the shell adds to the Memory's maximum for
//! them. [`slot_state_bytes`] is K2's estimate from the shared convolver's layout; C3 replaces its
//! body with C1's `convolver::instance` state size (the TypeScript mirror in
//! `runtime/core/initParams.ts` follows the same function).

use audio_wire::generated as wire;

use crate::core::Core;
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;
use crate::QUANTUM;

/// Head partitions of a zone kernel (`convolver.rs`: 128-frame partitions, at most 32).
pub const fn head_parts(frames: usize) -> usize {
    let max = wire::ZONE_KERNEL_MAX_HEAD_PARTS as usize;
    let n = frames.div_ceil(QUANTUM);
    if n < max {
        n
    } else {
        max
    }
}

/// Tail partitions of a zone kernel (2,048-frame partitions after the head's 4,096 frames).
pub const fn tail_parts(frames: usize) -> usize {
    let head_frames = wire::ZONE_KERNEL_MAX_HEAD_PARTS as usize * QUANTUM;
    frames.saturating_sub(head_frames).div_ceil(wire::ZONE_TAIL_BINS as usize)
}

/// Bytes of a prepared zone kernel (format 3, api-and-models §4.5): the 32-byte header, then two
/// channels of packed head spectra (128 bins) and tail spectra (2,048 bins), complex f32.
pub const fn kernel_blob_bytes(frames: usize) -> usize {
    let head = 2 * head_parts(frames) * wire::ZONE_HEAD_BINS as usize * 8;
    let tail = 2 * tail_parts(frames) * wire::ZONE_TAIL_BINS as usize * 8;
    wire::ZONE_KERNEL_HEADER_BYTES as usize + head + tail
}

/// The zone kernel budget (C8): `max_zone_slots` kernels of `zone_max_frames`, each rounded up to
/// the arena's 64-byte granule. 0 without slots.
pub const fn kernel_budget_bytes(max_zone_slots: u32, zone_max_frames: u32) -> usize {
    if max_zone_slots == 0 {
        return 0;
    }
    max_zone_slots as usize * align_up(kernel_blob_bytes(zone_max_frames as usize), REGION_ALIGN)
}

const fn align_up(n: usize, to: usize) -> usize {
    n.div_ceil(to) * to
}

/// One zone slot's convolver state for an IR of `frames` (K2's estimate, see the module comment):
/// per channel the head input spectra (32 × 128 bins), the previous quantum, the tail's
/// frequency-domain delay line (`tail_parts × 2,048` bins), the accumulator, a 2 × 4,096-frame input
/// ring and a 4,096-frame output ring; per slot the FFT scratch (time, two spectra, twiddles).
pub const fn slot_state_bytes(frames: usize) -> usize {
    const SIZE: usize = 2 * wire::ZONE_TAIL_BINS as usize; // the tail FFT's size, 4,096
    const BINS: usize = wire::ZONE_TAIL_BINS as usize;
    let parts = wire::ZONE_KERNEL_MAX_HEAD_PARTS as usize;
    let per_channel = parts * wire::ZONE_HEAD_BINS as usize * 8 + QUANTUM * 4 + tail_parts(frames) * BINS * 8 + BINS * 8 + 2 * SIZE * 4 + SIZE * 4;
    let scratch = SIZE * 4 + 2 * BINS * 8 + SIZE * 8;
    align_up(2 * per_channel + scratch, REGION_ALIGN)
}

/// The `Zones` region's size: `max_zone_slots × slot_state_bytes(zone_max_frames)` (C8).
pub const fn region_bytes(p: &InitParams) -> usize {
    if p.max_zone_slots == 0 {
        0
    } else {
        p.max_zone_slots as usize * slot_state_bytes(p.zone_max_frames as usize)
    }
}

fn u32_at(msg: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([msg[off], msg[off + 1], msg[off + 2], msg[off + 3]])
}

/// `true` when the ZONE_CONFIG record at `msg[off..off + len]` holds its `slotCount` 16-byte slots
/// and `slotCount <= MAX_ZONE_SLOTS` (C5). The scheduler refuses the whole batch otherwise.
pub fn config_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::ZoneConfig::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 12) as usize;
    n <= wire::MAX_ZONE_SLOTS as usize && wire::ZoneConfig::FIXED_END + n * wire::ZoneConfigSlots::FIXED_END <= len
}

/// ZONE_CONFIG (C5, idempotent, applies on arrival) from the well-formed record at `msg[off..]`.
/// K2: parsed and dropped; C3 diffs it against the slot table.
pub fn configure(core: &mut Core, msg: &[u8], off: usize) {
    let _ = (core, u32_at(msg, off + 12));
}

/// The pre-effects input hook (`bus::mixdown`): adds the wet output of every zone slot whose return
/// bus is `bus` into its input `l`, `r`. K2: a no-op (no zone runs before C3).
#[inline]
pub fn add_returns(zones: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let _ = (zones, bus, l, r);
}

/// RESET (§4.2: "RESET clears … zone slots"). K2: a no-op.
pub fn reset(core: &mut Core) {
    let _ = core;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_sizes_follow_section_4_5() {
        // 2 s at 48 kHz: 32 head and 45 tail partitions, ≈ 1.5 MB.
        assert_eq!((head_parts(96_000), tail_parts(96_000)), (32, 45));
        assert_eq!(kernel_blob_bytes(96_000), 32 + 32 * 2048 + 45 * 32_768);
        let mb = kernel_blob_bytes(96_000) as f64 / 1e6;
        assert!((1.4..1.6).contains(&mb), "{mb} MB at 2 s");
        let mb4 = kernel_blob_bytes(192_000) as f64 / 1e6;
        assert!((2.9..3.2).contains(&mb4), "{mb4} MB at 4 s");
        assert_eq!(kernel_budget_bytes(0, 96_000), 0);
        assert_eq!(kernel_budget_bytes(3, 96_000), 3 * align_up(kernel_blob_bytes(96_000), 64));
    }

    #[test]
    fn a_slot_with_its_kernel_is_near_the_memory_table() {
        // api-and-models §10 C3: 3.1 / 6.1 MB per slot at 2 / 4 s (state plus kernel, est.).
        for (frames, mb) in [(96_000usize, 3.1f64), (192_000, 6.1)] {
            let total = (slot_state_bytes(frames) + kernel_blob_bytes(frames)) as f64 / 1e6;
            assert!((total - mb).abs() < 0.5, "{total} MB at {frames} frames");
        }
    }
}
