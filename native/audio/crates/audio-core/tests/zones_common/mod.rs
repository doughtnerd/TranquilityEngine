//! Shared helpers for the zone tests (`zones_state.rs`, `zones_golden.rs`; ADR 0162 C3): a core
//! with zone slots, a prepared kernel uploaded as a format 3 clip, ZONE_CONFIG records, and slot
//! input fed directly (`zones::add_input`, standing in for C4's sends).
#![allow(dead_code)]

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{clips, zones, Core, QUANTUM};
use audio_dsp::convolver::kernel::{kernel_bytes, prepare_ir, IrSpec};
use audio_dsp::convolver::{Scratch, SCRATCH_BYTES};
use audio_wire::generated as wire;

#[allow(unused_imports)]
pub use wire::{zone_event, zone_slot_state, zone_state};

pub const RATE: f32 = 48_000.0;
/// The first zone kernel id (format 3 and 5 clips).
pub const K1: u32 = wire::ZONE_KERNEL_ID_FIRST;
pub const K2: u32 = wire::ZONE_KERNEL_ID_FIRST + 1;
pub const K3: u32 = wire::ZONE_KERNEL_ID_FIRST + 2;
pub const K4: u32 = wire::ZONE_KERNEL_ID_FIRST + 3;
/// A short IR (0.25 s: 32 head and 2 tail partitions), so the tests run quickly.
pub const IR_FRAMES: u32 = 12_000;

/// Init parameters with `slots` zone slots of `max_frames` (the high and default presets have
/// `maxActive + standby` = 3 slots, low 1), 16 mixed voices (the cap starts at its floor).
pub fn zone_params(slots: u32, max_frames: u32) -> InitParams {
    InitParams {
        sample_rate: RATE,
        max_logical: 64,
        max_mixed: 16,
        max_buses: 8,
        arena_initial_bytes: 0,
        max_zone_slots: slots,
        zone_max_frames: if slots > 0 { max_frames } else { 0 },
        ..InitParams::default()
    }
}

/// A core over a leaked, zeroed, page-aligned block for `p`.
pub fn core_with(p: InitParams) -> Core {
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// A core with `slots` zone slots of [`IR_FRAMES`].
pub fn zone_core(slots: u32) -> Core {
    core_with(zone_params(slots, IR_FRAMES))
}

fn bytes_of(v: &mut [u64]) -> &mut [u8] {
    // SAFETY: a u64 buffer viewed as its bytes.
    unsafe { core::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, v.len() * 8) }
}

/// A prepared kernel (format 3 blob) of a decaying noise IR of `frames` at `rate`, seeded.
pub fn kernel_blob_at(frames: u32, seed: u32, rate: f32) -> Vec<u8> {
    let mut sb = vec![0u64; SCRATCH_BYTES / 8];
    let mut scratch = Scratch::from_bytes(bytes_of(&mut sb)).unwrap();
    scratch.fill_twiddles();
    let n = kernel_bytes(frames as usize);
    let mut kb = vec![0u64; n.div_ceil(8)];
    let mut s = seed | 1;
    let mut i = 0u32;
    let mut next = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let t = (i % frames) as f32 / frames as f32;
        i += 1;
        ((s as f32 / u32::MAX as f32) * 2.0 - 1.0) * (1.0 - t) * (1.0 - t)
    };
    prepare_ir(bytes_of(&mut kb), &mut scratch, IrSpec { frames: frames as usize, sample_rate: rate, scale: 0.004, flags: 0 }, &mut next).unwrap();
    let mut out = bytes_of(&mut kb).to_vec();
    out.truncate(n);
    out
}

/// [`kernel_blob_at`] at [`RATE`].
pub fn kernel_blob(frames: u32, seed: u32) -> Vec<u8> {
    kernel_blob_at(frames, seed, RATE)
}

/// Reserves zone kernel `id` (format 3) for `blob`; returns the reserve's result.
pub fn reserve_kernel(core: &mut Core, id: u32, blob: &[u8]) -> i32 {
    clips::reserve(core, id, (blob.len() / 4) as u32, 1, RATE, wire::clip_format::ZONE_KERNEL)
}

/// Uploads zone kernel `id` whole (reserve, then write: it is resident at once, and the slots
/// waiting for it start).
pub fn load_kernel(core: &mut Core, id: u32, blob: &[u8]) {
    assert_eq!(reserve_kernel(core, id, blob), wire::ERR_OK, "reserve kernel {id:#x}");
    assert_eq!(clips::write(core, id, 0, blob), wire::ERR_OK, "write kernel {id:#x}");
}

/// One ZONE_CONFIG slot: `(kernelId, returnBus, state, wet, irFrames)`.
pub type Slot = (u32, u16, u8, f32, u32);

/// An active slot of kernel `id` returning to bus 0 at `wet`.
pub fn active(id: u32, wet: f32) -> Slot {
    (id, 0, zone_slot_state::ACTIVE as u8, wet, IR_FRAMES)
}

/// A ZONE_CONFIG record, written (head included).
pub fn zone_config(shared: f32, ramp: u32, slots: &[Slot]) -> Vec<u8> {
    let rec = wire::ZoneConfig {
        voice_id: 0,
        frame_offset: wire::ASAP,
        shared_return_gain: shared,
        ramp_frames: ramp,
        slots: slots.iter().map(|&(kernel_id, return_bus, state, wet, ir_frames)| wire::ZoneConfigSlots { kernel_id, return_bus, state, reserved: 0, wet, ir_frames }).collect(),
    };
    let mut buf = vec![0u8; 24 + 16 * slots.len()];
    rec.write(&mut buf, 0).unwrap();
    buf
}

/// A whole BATCH of written records at `first_frame`.
pub fn batch(first_frame: f64, recs: &[Vec<u8>]) -> Vec<u8> {
    let mut buf = vec![0u8; 32];
    for r in recs {
        buf.extend_from_slice(r);
    }
    let len = buf.len();
    wire::Envelope::new(wire::kind::BATCH, 1, (len - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
    buf
}

/// A RESET record (`keepClips`).
pub fn reset_rec(keep_clips: bool) -> Vec<u8> {
    let mut buf = vec![0u8; 16];
    wire::Reset { voice_id: 0, frame_offset: wire::ASAP, keep_clips: keep_clips as u32 }.write(&mut buf, 0).unwrap();
    buf
}

/// A core and its clock: submits records and renders quanta.
pub struct Zones {
    pub core: Core,
    pub frame: u64,
}

impl Zones {
    pub fn new(slots: u32) -> Zones {
        Zones { core: zone_core(slots), frame: 0 }
    }

    pub fn over(core: Core) -> Zones {
        Zones { core, frame: 0 }
    }

    /// Submits one BATCH of `recs`; asserts it was accepted.
    pub fn submit(&mut self, recs: &[Vec<u8>]) {
        let msg = batch(self.frame as f64, recs);
        assert_eq!(audio_core::scheduler::submit(&mut self.core, &msg), 0, "the batch was refused");
    }

    /// Submits a ZONE_CONFIG.
    pub fn config(&mut self, shared: f32, ramp: u32, slots: &[Slot]) {
        self.submit(&[zone_config(shared, ramp, slots)]);
    }

    /// Feeds slot `k` a quantum of `x` in both channels (before the next render).
    pub fn feed(&mut self, k: usize, x: &[f32; QUANTUM]) {
        zones::add_input(&mut self.core, k, x, x);
    }

    /// Renders one quantum; returns its planar stereo output.
    pub fn render(&mut self) -> (Vec<f32>, Vec<f32>) {
        let out = self.core.process(self.frame);
        let pair = (out[..QUANTUM].to_vec(), out[QUANTUM..2 * QUANTUM].to_vec());
        self.frame += QUANTUM as u64;
        pair
    }

    /// Renders `n` quanta, feeding slot `k` with `input(q)` before each (when `Some`).
    pub fn run(&mut self, n: usize, mut input: impl FnMut(usize) -> Option<(usize, [f32; QUANTUM])>) -> (Vec<f32>, Vec<f32>) {
        let (mut l, mut r) = (Vec::new(), Vec::new());
        for q in 0..n {
            if let Some((k, x)) = input(q) {
                self.feed(k, &x);
            }
            let (a, b) = self.render();
            l.extend(a);
            r.extend(b);
        }
        (l, r)
    }

    /// Slot `k`'s state (the wire's `ZoneState`).
    pub fn state(&self, k: usize) -> u32 {
        zones::slot_state(&self.core, k) as u32
    }

    /// The zone events in the current STATUS counters, `(slot, code)`.
    pub fn events(&self) -> Vec<(u8, u8)> {
        audio_core::status::counters(&self.core).spatial.zone_events.as_slice().iter().map(|e| (e.slot, e.code)).collect()
    }
}

/// A quantum of seeded noise (deterministic).
pub fn noise(seed: u32) -> [f32; QUANTUM] {
    let mut s = seed.wrapping_mul(2_654_435_761) | 1;
    core::array::from_fn(|_| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        (s as f32 / u32::MAX as f32) - 0.5
    })
}

/// The largest absolute sample.
pub fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0, |m, v| m.max(v.abs()))
}

/// Quanta of `ms` milliseconds at [`RATE`], rounded up.
pub fn quanta(ms: u32) -> usize {
    ((ms as usize * RATE as usize) / 1000).div_ceil(QUANTUM)
}
