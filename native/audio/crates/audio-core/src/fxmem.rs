//! The effect memory (ADR 0331, ABI 4.6): the `FxMem` region, where the catalogue's effects that
//! need more than a few bytes (delay lines, the reverb's network, the pitch shifter's grains, the
//! compressor's look-ahead) keep their state, for bus chains and instance submixes alike.
//!
//! - **Size.** [`FX_MEMORY_SECONDS`] seconds of stereo audio at the context rate (7.7 MB at
//!   48 kHz), in blocks of [`BLOCK_FLOATS`] floats, on every preset. A tripwire like the others,
//!   not a design limit: raise it with a note when a mix needs more.
//! - **Allocation.** An effect asks for `audio_dsp::fx::mem_floats` floats when it is configured
//!   (its kind is new, or it needs more than it holds: a delay made longer); it gets the first run
//!   of free blocks that fits, zeroed. Its slot records where (`Effect::mem_off`, `mem_len`).
//!   When nothing fits the effect has no memory and passes its signal through; `starved` counts
//!   it (tests and a debugger: the wire has no STATUS field for it yet).
//! - **Freeing is a sweep** ([`rebuild`]): after every message that configures effects (BUS_CONFIG,
//!   BUS_SLOT, SUBMIX, RESET) the block map is rebuilt from the effects that are still configured,
//!   so a slot overwritten, tombstoned or freed by any path gives its memory back without each path
//!   having to. Between a configure and its sweep a discarded effect's blocks stay marked (less room
//!   for that one message, never an overlap).
//!
//! Runs in `onmessage`; the render only reads the slices. Nothing allocates.

use audio_dsp::fx::Effect;
use audio_wire::generated as wire;

use crate::core::Regions;
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;

/// Seconds of stereo audio the region holds (the wire's `FX_MEMORY_SECONDS`).
pub const FX_MEMORY_SECONDS: u32 = wire::FX_MEMORY_SECONDS;
/// Floats per block (16 KB).
pub const BLOCK_FLOATS: usize = 4_096;
/// The most blocks the map tracks (192 kHz × 20 s × 2 channels = 1,875 blocks).
pub const MAX_BLOCKS: usize = 2_048;

/// The region's header: counters, then one byte per block (0 free, 1 taken).
#[repr(C)]
pub struct Header {
    pub blocks: u32,
    /// Blocks taken.
    pub used: u32,
    /// Allocations refused (nothing fitted), cumulative.
    pub starved: u32,
    /// Allocations made, cumulative.
    pub allocs: u32,
    pub map: [u8; MAX_BLOCKS],
}

const HEADER_BYTES: usize = (core::mem::size_of::<Header>() + REGION_ALIGN - 1) / REGION_ALIGN * REGION_ALIGN;

/// Blocks at `sample_rate`.
pub fn blocks(sample_rate: f32) -> usize {
    let rate = if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate as f64 } else { 48_000.0 };
    let floats = FX_MEMORY_SECONDS as f64 * rate * 2.0;
    ((floats / BLOCK_FLOATS as f64).ceil() as usize).min(MAX_BLOCKS)
}

/// The `FxMem` region's size for `p`.
pub fn region_bytes(p: &InitParams) -> usize {
    HEADER_BYTES + blocks(p.sample_rate) * BLOCK_FLOATS * 4
}

/// The header and the blocks of the region (`None` when it is too short to hold a header).
pub(crate) fn split(region: &mut [u8]) -> Option<(&mut Header, &mut [f32])> {
    if region.len() < HEADER_BYTES {
        return None;
    }
    let (h, data) = region.split_at_mut(HEADER_BYTES);
    let floats = data.len() / 4;
    // SAFETY: the region is 64-byte aligned (Layout) and zeroed at init; all-zero is a valid
    // Header; the data after the 64-aligned header is f32-aligned and `floats * 4` bytes long. Only
    // this module and the views it hands out read these bytes.
    unsafe { Some((&mut *(h.as_mut_ptr() as *mut Header), core::slice::from_raw_parts_mut(data.as_mut_ptr() as *mut f32, floats))) }
}

/// Sets the block count at init (from the region's length).
pub fn init(region: &mut [u8]) {
    let Some((h, data)) = split(region) else { return };
    h.blocks = (data.len() / BLOCK_FLOATS).min(MAX_BLOCKS) as u32;
}

/// A first-fit run of blocks for `floats`, zeroed: its float offset. `None` when nothing fits.
fn alloc(h: &mut Header, data: &mut [f32], floats: usize) -> Option<u32> {
    let need = floats.div_ceil(BLOCK_FLOATS);
    let n = (h.blocks as usize).min(MAX_BLOCKS);
    if need == 0 || need > n {
        h.starved = h.starved.wrapping_add((need > 0) as u32);
        return None;
    }
    let mut run = 0usize;
    for b in 0..n {
        if h.map[b] == 0 {
            run += 1;
            if run == need {
                let start = b + 1 - need;
                h.map[start..=b].fill(1);
                h.used += need as u32;
                h.allocs = h.allocs.wrapping_add(1);
                data[start * BLOCK_FLOATS..(b + 1) * BLOCK_FLOATS].fill(0.0);
                return Some((start * BLOCK_FLOATS) as u32);
            }
        } else {
            run = 0;
        }
    }
    h.starved = h.starved.wrapping_add(1);
    None
}

/// `e`'s memory slice in the region's data (empty when it holds none or it is out of range).
pub fn slice<'a>(data: &'a mut [f32], e: &Effect) -> &'a mut [f32] {
    let (off, len) = (e.mem_off as usize, e.mem_len as usize);
    if len == 0 || off + len > data.len() {
        return &mut [];
    }
    &mut data[off..off + len]
}

/// Configures effect `e` (its kind, on flag and catalogue parameters) and gives it the memory it
/// needs: a new kind takes fresh zeroed memory; the same kind keeps its memory unless it needs
/// more. A slot not `in_use` before starts from an empty effect.
pub fn configure(region: &mut [u8], e: &mut Effect, in_use: bool, kind: u32, on: bool, p: &[f32; audio_dsp::fx::PARAMS], sample_rate: f32) {
    if !in_use {
        *e = Effect::default();
    }
    let fresh = e.configure(kind, on, p, sample_rate);
    let need = audio_dsp::fx::mem_floats(kind, p, sample_rate);
    let Some((h, data)) = split(region) else {
        e.mem_len = 0;
        return;
    };
    if need == 0 {
        e.mem_len = 0;
        e.mem_off = 0;
        return;
    }
    if !fresh && (e.mem_len as usize) >= need && e.mem_off as usize + e.mem_len as usize <= data.len() {
        return;
    }
    // The old run stays marked until the sweep (`rebuild`); a grown delay restarts from silence.
    e.mem_len = 0;
    match alloc(h, data, need) {
        Some(off) => {
            e.mem_off = off;
            e.mem_len = need as u32;
        }
        None => e.mem_off = 0,
    }
}

/// The sweep: the block map rebuilt from every configured effect of the bus chains and the
/// submixes (see the module comment).
pub fn rebuild(regions: &mut Regions) {
    let fxmem: *mut [u8] = &mut regions.fxmem[..];
    // SAFETY: the FxMem region is distinct from the buses and submixes regions viewed below.
    let Some((h, data)) = split(unsafe { &mut *fxmem }) else { return };
    let n = (h.blocks as usize).min(MAX_BLOCKS);
    h.map[..n].fill(0);
    h.used = 0;
    let floats = data.len();
    let mut mark = |e: &Effect| {
        let (off, len) = (e.mem_off as usize, e.mem_len as usize);
        if len == 0 || off + len > floats {
            return;
        }
        let (a, b) = (off / BLOCK_FLOATS, (off + len).div_ceil(BLOCK_FLOATS).min(n));
        for m in h.map[a..b].iter_mut() {
            if *m == 0 {
                *m = 1;
                h.used += 1;
            }
        }
    };
    crate::bus::for_each_effect(regions, &mut mark);
    crate::submix::for_each_effect(regions, &mut mark);
}

/// Blocks in use and allocations refused (tests and a debugger).
pub fn usage(regions: &mut Regions) -> (u32, u32) {
    split(&mut regions.fxmem[..]).map_or((0, 0), |(h, _)| (h.used, h.starved))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_scale_with_the_rate() {
        assert_eq!(blocks(48_000.0), 469);
        assert_eq!(blocks(192_000.0), 1_875);
        assert!(blocks(192_000.0) <= MAX_BLOCKS);
    }

    #[test]
    fn first_fit_runs_and_starvation() {
        // A header plus 4 blocks.
        let mut bytes = vec![0u8; HEADER_BYTES + 4 * BLOCK_FLOATS * 4 + 64];
        let base = bytes.as_ptr() as usize;
        let skip = (REGION_ALIGN - base % REGION_ALIGN) % REGION_ALIGN;
        let region = &mut bytes[skip..skip + HEADER_BYTES + 4 * BLOCK_FLOATS * 4];
        init(region);
        let (h, data) = split(region).unwrap();
        assert_eq!(h.blocks, 4);
        data.fill(1.0);
        assert_eq!(alloc(h, data, 10), Some(0));
        assert_eq!(alloc(h, data, BLOCK_FLOATS + 1), Some(BLOCK_FLOATS as u32));
        assert_eq!(data[BLOCK_FLOATS], 0.0, "zeroed");
        assert_eq!(data[3 * BLOCK_FLOATS], 1.0, "untouched beyond the run");
        assert_eq!(alloc(h, data, 2 * BLOCK_FLOATS), None, "one block left");
        assert_eq!(h.starved, 1);
        assert_eq!(alloc(h, data, 1), Some(3 * BLOCK_FLOATS as u32));
        assert_eq!(h.used, 4);
    }
}
