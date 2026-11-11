//! Reverb zones (ADR 0162, api-and-models §3.1, §4.2 ZONE_CONFIG, §4.3, §5.2; architecture §2.2,
//! §3.3, §4.4, §7.3; contracts C5, C7, C8, OD2, OD3): the fixed `Zones` region of convolver slots,
//! the ZONE_CONFIG table and slot state machine, the return buses ([`add_returns`], called from
//! `bus.rs`'s pre-effects input hook), the shared-return scale ([`shared_return`]), the STATUS zone
//! slots and the load-shedding ladder's zone steps. Task C4 fills the slot inputs (`sends::tap`,
//! through [`slot_input`]); task C3b prepares format 5 PCM in the core.
//!
//! **Slots (OD2).** The core has `max_zone_slots` slots: `maxActive + standby` (3 on high and
//! default, the standby slot letting a released zone ring out while the incoming one takes the
//! spare; 1 on low, where main evicts with a 150 ms fade first). Each slot is one stereo convolver
//! (`audio_dsp::convolver::instance`) over a kernel held in the arena (format 3, read in place),
//! with its state in this region, so a slot costs its region bytes whether used or not and nothing
//! is ever allocated for it.
//!
//! **The table (C5).** ZONE_CONFIG is idempotent and applies on arrival; [`configure`] diffs it
//! against the slots. Per slot (the wire always carries up to 4; a slot past `max_zone_slots` with
//! a kernel is the zone event `refusedSlot`):
//!
//! | Record | Slot | Result |
//! |---|---|---|
//! | new `kernelId`, state 1 | off | starts: waiting for kernel, or (resident) planned by `stagger::plan_one` and fading in over 100 ms |
//! | new `kernelId` | not off | refused: zone event `refusedKernel`, once per id (main reads the slot states first) |
//! | same id, state 1 | ringing out / evicting | active again (fades back in when it was fading out) |
//! | same id, state 2 release | fading in / active | ringing out: sends ignored, the tail rings out, then off |
//! | same id, state 3 evict | fading in / active / ringing out | evicting: sends ignored, the wet fades out over 150 ms, then off |
//! | state 2 or 3 | waiting for kernel | off |
//! | `kernelId` 0 (or the slot missing) | fading in / active | evicting (no cut); a waiting slot goes off |
//!
//! `wet` (0..2) ramps over `rampFrames` and `sharedReturnGain` (0..1) likewise; neither re-plans.
//! A slot "waiting for kernel" starts when its kernel's last range is committed
//! ([`kernel_resident`], from `clips::commit`), so REPLAY needs no ordering. Starting (the stagger
//! plan and clearing the slot's state) runs in `onmessage`, never in `process`. A kernel that
//! doesn't parse, is at another rate, or is longer than the slot holds is the zone event `badBlob`
//! (once) and the slot keeps waiting. A kernel freed under a running slot sends it back to waiting.
//!
//! **Render** ([`render`], from `bus::mixdown` before the buses mix): each running slot convolves
//! its input (the quantum's sends, zeroed when the slot ignores sends) and keeps the wet signal,
//! times `wet × fade`, for [`add_returns`], which adds it into the slot's return bus (the zone's
//! `output`, R17; bus 0 when that bus isn't configured) before the bus's effects, so the bus's
//! fader, ducking and meter apply. A slot whose input has been silent for its IR plus
//! [`IDLE_MARGIN_QUANTA`] stops convolving (its whole state is exact zeros by then) and costs
//! nothing; a ringing-out or evicting slot is off at that point. Each slot's schedule clock is the
//! core's quantum count (`Instance::set_clock` on start and on waking), so the stagger planner's
//! phases line up across slots; the output never depends on the phase.
//!
//! **The shared reverb's return** is scaled by `sharedReturnGain` (1 minus the listener's zone
//! weight), ramped per frame. Settled at 1 (always, before any ZONE_CONFIG) `bus::mixdown` runs
//! M1's path unchanged, so every M1/M2 golden stays bit-identical.
//!
//! **The load-shedding ladder (OD3, architecture §7.3).** Only when the adaptive cap sits at its
//! floor (16, or `max_mixed` below that) and underruns continue for [`LADDER_MS`]: step 1 cuts
//! the releasing slots' tails with a 100 ms fade (and every release after it, for the session);
//! step 2, after another second of underruns, allows one active slot fewer for the session (the
//! active slot with the lowest wet is evicted; a start past the limit is `refusedSlot`). Each step
//! counts in [`shed_steps`] (main's `m3Shed`). It never touches beds or HRTF.
//!
//! **Sizes (C8).** The region holds `max_zone_slots` slots of [`slot_state_bytes`]`(zone_max_frames)`
//! (a header with the slot's stereo input and wet buffers, then the instance state), then the aux
//! accumulator ([`aux_accumulator`], C4's, `max_buses × 1 KB`, also without slots), the sends
//! area ([`sends_area`], C4's: the quantum's bus-chain gains, `max_buses × 512 B` plus a 64-byte
//! header) and a 64-byte tail. The kernels
//! are arena clips outside `clipMemoryMB`, within [`kernel_budget_bytes`] (the
//! `myco_audio_zone_kernel_budget_bytes` export, which the shell adds to the Memory's maximum).
//! The TypeScript mirror (`worklet/coreDriver.ts`) follows both functions. The table's scalars,
//! the shared-return ramp and the ladder live in [`ZoneArea`], in the core-state region after the
//! bus area.

use audio_dsp::convolver::instance::{self, Instance, Phase, SHARED_PHASE};
use audio_dsp::convolver::kernel::Kernel;
use audio_dsp::convolver::stagger::{plan_one, Load, MAX_PLANNED};
use audio_dsp::convolver::{self, ir, Scratch};
use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;
use wire::{zone_event, zone_slot_state, zone_state};

use crate::clips::{is_zone_kernel_id, ClipStore};
use crate::core::{Core, Regions};
use crate::counters::{ZoneEvent, ZoneStatus, ZONES_CAP};
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;
use crate::wire_read::u32_at;
use crate::{status, QUANTUM};

/// The wet fade-in once a slot's kernel is resident (C5: 100 ms).
pub const FADE_IN_MS: u32 = 100;
/// The eviction fade (ZONE_CONFIG state 3, OD2: 150 ms).
pub const EVICT_MS: u32 = 150;
/// The ladder's tail cut (OD3: 100 ms).
pub const CUT_MS: u32 = 100;
/// Underruns at the cap's floor for this long take a ladder step (OD3: 1 s).
pub const LADDER_MS: u32 = 1_000;
/// Ladder steps: cut releasing tails, then one active slot fewer.
pub const LADDER_STEPS: u32 = 2;
/// Quanta of silent input past the IR's length after which a slot's state is exact zeros (the tail
/// FFT's overlap, the delay line's newest block and the accumulation buffer's look-ahead: three
/// 16-quantum cycles, plus 2), so it stops convolving.
pub const IDLE_MARGIN_QUANTA: u32 = 3 * convolver::CYCLE + 2;
/// Modelled work units of one running slot per quantum (`zones-2x2s` ≈ 47 µs p50 for two slots,
/// container est.; STATUS `workZones`).
pub const SLOT_WU: u32 = 23_000;
/// [`ZoneArea::active_limit`] when the ladder hasn't lowered it.
pub const NO_LIMIT: u32 = u32::MAX;

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

/// The arena block a request of `bytes` takes (`arena::size_class`: four classes per doubling
/// from 4 KB), as a `const fn`, so the budget export and its TypeScript mirror agree.
pub const fn arena_block_bytes(bytes: usize) -> usize {
    let mut doubling = 0;
    while doubling < 20 {
        let mut step = 0;
        while step < 4 {
            let class = (1024usize << doubling) * (4 + step);
            if class >= bytes {
                return class;
            }
            step += 1;
        }
        doubling += 1;
    }
    usize::MAX
}

/// The zone kernel budget (C8): `max_zone_slots` kernels of `zone_max_frames`, each the arena
/// block it takes (the kernel budget is one kernel per core slot, OD2). 0 without slots.
pub const fn kernel_budget_bytes(max_zone_slots: u32, zone_max_frames: u32) -> usize {
    if max_zone_slots == 0 {
        return 0;
    }
    max_zone_slots as usize * arena_block_bytes(kernel_blob_bytes(zone_max_frames as usize))
}

const fn align_up(n: usize, to: usize) -> usize {
    n.div_ceil(to) * to
}

/// One slot's header, at the start of its bytes. `#[repr(C)]`; all-zero is an off slot.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SlotHeader {
    /// The slot's kernel (a zone kernel clip id), 0 when off.
    pub kernel_id: u32,
    /// ZONE_CONFIG `irFrames` (the idle check uses the kernel's own length once it runs).
    pub ir_frames: u32,
    /// ZONE_CONFIG `returnBus`, and the bus the wet goes to this quantum (bus 0 when it isn't
    /// configured).
    pub return_bus: u16,
    pub route: u16,
    /// The wire's `ZoneState` (0 off .. 5 evicting).
    pub state: u8,
    /// 1 once the instance was started for `kernel_id` (in `onmessage`).
    pub started: u8,
    /// 1 while the instance's clock follows the core's quantum count (0 after idling).
    pub clocked: u8,
    /// 1 once `badBlob` was reported for `kernel_id`.
    pub bad_reported: u8,
    /// The last id refused in this slot (`refusedKernel`/`refusedSlot` once per id).
    pub refused_id: u32,
    /// The running kernel's tail partitions and stagger phase `[f0, i0, f1, i1]`.
    pub tail_parts: u32,
    pub phase: [u8; 4],
    /// 1 when `output` holds this quantum's wet signal.
    pub live: u32,
    /// Quanta since a send last fed the slot (saturating).
    pub quanta_since_input: u32,
    /// The wet output's peak, last quantum.
    pub wet_peak: f32,
    /// ZONE_CONFIG `wet`, ramped per frame.
    pub wet: Ramp,
    /// The fade: in over 100 ms, out over 150 ms (evict) or 100 ms (the ladder's cut).
    pub fade: Ramp,
    /// The quantum's sends, planar stereo `[L; 128][R; 128]` (C4's `sends::tap` adds into it).
    pub input: [f32; 2 * QUANTUM],
    /// The quantum's wet signal, planar stereo, after `wet × fade`.
    pub output: [f32; 2 * QUANTUM],
}

/// Bytes before a slot's instance state: the header, rounded so the state starts 32 bytes past a
/// 64-byte boundary (`instance.rs`: its parts are then 64-byte aligned).
pub const SLOT_HEADER_BYTES: usize = align_up(core::mem::size_of::<SlotHeader>(), REGION_ALIGN) + 32;

/// One zone slot's bytes for an IR of `frames` (C8): the header (input and wet buffers, the state
/// machine), then C1's instance state (`instance::state_bytes`: head input spectra, the tail's
/// frequency-domain delay lines, accumulators, the input ring and the accumulation buffer), rounded
/// to the region alignment. The FFT scratch is the shared reverb's (`convolver::shared_scratch`).
pub const fn slot_state_bytes(frames: usize) -> usize {
    align_up(SLOT_HEADER_BYTES + instance::state_bytes(tail_parts(frames)), REGION_ALIGN)
}

/// Bytes of the region's tail: slot count, stride, aux buses, the aux accumulator's offset and size.
pub const REGION_TAIL_BYTES: usize = REGION_ALIGN;

/// The aux accumulator's bytes (coordinator ruling for C4): one planar stereo quantum per bus,
/// `max_buses × 1 KB` (32 KB at the default 32 buses), there with or without zone slots, since aux
/// sends work without zones.
pub const fn aux_bytes(p: &InitParams) -> usize {
    p.max_buses as usize * 2 * QUANTUM * 4
}

/// The sends area's bytes (C4): a 64-byte [`SendsHeader`], then per bus the quantum's chain gain
/// to the root (`max_buses × 512 B`), which `sends::begin_quantum` fills for the taps, since
/// `sends::tap` sees only this region. There with or without zone slots.
pub const fn sends_bytes(p: &InitParams) -> usize {
    REGION_ALIGN + p.max_buses as usize * QUANTUM * 4
}

/// The `Zones` region's size (C8, with the aux accumulator and the sends area): `max_zone_slots ×
/// slot_state_bytes(zone_max_frames)`, then [`aux_bytes`], then [`sends_bytes`], then the 64-byte
/// tail. Slots come first, so each is 64-byte aligned.
pub const fn region_bytes(p: &InitParams) -> usize {
    let slots = if p.max_zone_slots == 0 { 0 } else { p.max_zone_slots as usize * slot_state_bytes(p.zone_max_frames as usize) };
    slots + aux_bytes(p) + sends_bytes(p) + REGION_TAIL_BYTES
}

/// The sends area's header (C4), at the area's start. All-zero: no chain gains, no aux pending.
#[repr(C)]
pub struct SendsHeader {
    /// Buses whose chain gains this quantum holds (0: none; `sends::begin_quantum` fills them only
    /// while some mixed voice has a send or an aux bus).
    pub buses: u32,
    /// Bit `b`: bus `b`'s aux accumulator holds this quantum's sends (`sends::add_aux` clears it).
    pub aux_dirty: [u32; 8],
}

const _: () = assert!(core::mem::size_of::<SendsHeader>() <= REGION_ALIGN && InitParams::MAX_BUSES as usize <= 8 * 32);

/// The sends' view of the region (C4): the aux accumulator and, right after it, the sends area.
pub struct SendsArea<'a> {
    pub head: &'a mut SendsHeader,
    /// Per bus a quantum of chain gains (`max_buses × 128` f32).
    pub gains: &'a mut [f32],
    /// [`aux_accumulator`]: per bus a planar stereo quantum (`max_buses × 256` f32).
    pub aux: &'a mut [f32],
}

/// The aux accumulator and the sends area (one view, as `sends.rs` takes it), found from the
/// region's end and its bus count (tail word 2): `[aux][header][gains][tail]`; `None` for a region
/// [`init`] didn't lay out.
#[inline(never)]
pub fn sends_area(zones: &mut [u8]) -> Option<SendsArea<'_>> {
    let end = zones.len().checked_sub(REGION_TAIL_BYTES)?;
    let buses = tail_word(zones, 2);
    if buses > InitParams::MAX_BUSES as usize {
        return None;
    }
    let aux = buses * 2 * QUANTUM * 4;
    let at = end.checked_sub(aux + REGION_ALIGN + buses * QUANTUM * 4)?;
    let (acc, rest) = zones[at..end].split_at_mut(aux);
    let (head, gains) = rest.split_at_mut(REGION_ALIGN);
    // SAFETY: inside the region (checked); 64-byte aligned, since the region and every part's size
    // are; every bit pattern is valid for the header's integers and the floats. Only `sends.rs`
    // views these bytes (and the tests, through `aux_accumulator`).
    unsafe {
        Some(SendsArea {
            head: &mut *(head.as_mut_ptr() as *mut SendsHeader),
            gains: core::slice::from_raw_parts_mut(gains.as_mut_ptr() as *mut f32, gains.len() / 4),
            aux: core::slice::from_raw_parts_mut(acc.as_mut_ptr() as *mut f32, acc.len() / 4),
        })
    }
}

/// The aux accumulator: per bus a planar stereo quantum `[L; 128][R; 128]`, as `f32`s
/// (`aux_buses × 256` of them; empty for a region [`init`] didn't lay out). C4's `sends::tap_aux`
/// adds into bus `b`'s quantum and `sends::add_aux` moves it into the bus's input and clears it.
pub fn aux_accumulator(zones: &mut [u8]) -> &mut [f32] {
    if zones.len() < REGION_TAIL_BYTES {
        return &mut [];
    }
    let (at, len) = (tail_word(zones, 3), tail_word(zones, 4));
    if at % 4 != 0 || at.checked_add(len).is_none_or(|e| e > zones.len() - REGION_TAIL_BYTES) {
        return &mut [];
    }
    let bytes = &mut zones[at..at + len];
    // SAFETY: inside the region (checked), 4-byte aligned (the region is 64-byte aligned, the
    // offset a multiple of 4); every bit pattern is a valid f32.
    unsafe { core::slice::from_raw_parts_mut(bytes.as_mut_ptr() as *mut f32, len / 4) }
}

/// The table's scalars, the shared-return ramp and the ladder: in the core-state region at
/// [`ZONE_AREA_OFFSET`]. All-zero is valid; [`init`] fills it.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ZoneArea {
    /// ZONE_CONFIG `sharedReturnGain`, ramped per frame (1 until the first ZONE_CONFIG).
    pub shared_return: Ramp,
    /// [`FADE_IN_MS`], [`EVICT_MS`], [`CUT_MS`] and [`LADDER_MS`] in frames.
    pub fade_in_frames: u32,
    pub evict_frames: u32,
    pub cut_frames: u32,
    pub ladder_frames: u32,
    /// The ladder: 1 while underruns at the floor go on, since when, and the last one.
    pub pressure: u32,
    pub pressure_since: u64,
    pub last_underrun: u64,
    /// Steps taken (0..=2, main's `m3Shed`), whether releases are cut (step 1), and the most
    /// active slots allowed (step 2; [`NO_LIMIT`] before).
    pub shed_steps: u32,
    pub cut_tails: u32,
    pub active_limit: u32,
    /// Kernels and slots refused, cumulative (main's `kernelRefused` counts from the events).
    pub refused: u32,
}

/// Offset of [`ZoneArea`] in the core-state region (after the bus area).
pub const ZONE_AREA_OFFSET: usize = align_up(crate::bus::BUS_AREA_OFFSET + core::mem::size_of::<crate::bus::BusArea>(), REGION_ALIGN);

const _: () = assert!(ZONE_AREA_OFFSET + core::mem::size_of::<ZoneArea>() <= crate::layout::CORE_STATE_BYTES, "the zone area fits the core-state region");
const _: () = assert!(core::mem::align_of::<SlotHeader>() <= REGION_ALIGN && core::mem::align_of::<ZoneArea>() <= REGION_ALIGN);

fn area_mut(core_state: &mut [u8]) -> &mut ZoneArea {
    let bytes = &mut core_state[ZONE_AREA_OFFSET..ZONE_AREA_OFFSET + core::mem::size_of::<ZoneArea>()];
    // SAFETY: the core-state region is 64-byte aligned and zeroed at init; ZONE_AREA_OFFSET is a
    // multiple of REGION_ALIGN and the area fits (asserted); all-zero bytes are a valid ZoneArea
    // (integers, floats, ramps). Only this module views these bytes.
    unsafe { &mut *(bytes.as_mut_ptr() as *mut ZoneArea) }
}

/// The zone area (tests and a debugger).
pub fn area(core: &Core) -> &ZoneArea {
    let bytes = &core.regions().core_state[ZONE_AREA_OFFSET..ZONE_AREA_OFFSET + core::mem::size_of::<ZoneArea>()];
    // SAFETY: as in `area_mut`.
    unsafe { &*(bytes.as_ptr() as *const ZoneArea) }
}

/// Word `i` of the region's tail (see [`region_bytes`]).
#[inline(never)]
fn tail_word(zones: &[u8], i: usize) -> usize {
    let at = zones.len() - REGION_TAIL_BYTES + 4 * i;
    u32::from_ne_bytes([zones[at], zones[at + 1], zones[at + 2], zones[at + 3]]) as usize
}

/// The region's slot count and stride, read from its tail (0 slots for an empty region or one
/// [`init`] didn't lay out).
#[inline(never)]
fn geometry(zones: &[u8]) -> (usize, usize) {
    if zones.len() < REGION_TAIL_BYTES {
        return (0, 0);
    }
    let (count, stride) = (tail_word(zones, 0), tail_word(zones, 1));
    if count == 0 || stride < SLOT_HEADER_BYTES || count.checked_mul(stride).is_none_or(|n| n > zones.len()) {
        return (0, 0);
    }
    (count, stride)
}

/// Slot `k`'s header and instance state bytes (`k < count`, `stride` from [`geometry`]).
#[inline(never)]
fn slot(zones: &mut [u8], k: usize, stride: usize) -> (&mut SlotHeader, &mut [u8]) {
    let bytes = &mut zones[k * stride..(k + 1) * stride];
    let (head, state) = bytes.split_at_mut(SLOT_HEADER_BYTES);
    // SAFETY: the region is 64-byte aligned (Layout) and the stride a multiple of REGION_ALIGN, so
    // the header is aligned; it fits SLOT_HEADER_BYTES; all-zero bytes are a valid SlotHeader.
    (unsafe { &mut *(head.as_mut_ptr() as *mut SlotHeader) }, state)
}

#[inline(never)]
fn header(zones: &[u8], k: usize, stride: usize) -> &SlotHeader {
    // SAFETY: as in `slot`.
    unsafe { &*(zones[k * stride..].as_ptr() as *const SlotHeader) }
}

/// Lays the slots out and sets the area's defaults (`sharedReturnGain` 1, no ladder step). Called
/// once by `bus::init` (from `Core::new`).
pub fn init(core: &mut Core) {
    let p = *core.params();
    let rate = p.sample_rate;
    let regions = core.regions_mut();
    let count = p.max_zone_slots as usize;
    let stride = slot_state_bytes(p.zone_max_frames as usize);
    let len = regions.zones.len();
    if len >= REGION_TAIL_BYTES {
        // The region's tail: where a view of the region alone (`sends::tap`) finds its parts.
        let aux = aux_bytes(&p);
        let words = [count as u32, stride as u32, p.max_buses, (count * stride) as u32, aux as u32];
        for (dst, w) in regions.zones[len - REGION_TAIL_BYTES..].chunks_exact_mut(4).zip(words) {
            dst.copy_from_slice(&w.to_ne_bytes());
        }
    }
    let a = area_mut(regions.core_state);
    a.shared_return = Ramp::at(1.0);
    let frames = |ms: u32| crate::cap_controller::ms_to_frames(ms, rate).min(u32::MAX as u64) as u32;
    a.fade_in_frames = frames(FADE_IN_MS);
    a.evict_frames = frames(EVICT_MS);
    a.cut_frames = frames(CUT_MS);
    a.ladder_frames = frames(LADDER_MS);
    a.active_limit = NO_LIMIT;
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

/// Zone events gathered while the regions are borrowed, pushed to STATUS after.
#[derive(Default)]
struct Events {
    list: [ZoneEvent; 2 * MAX_PLANNED],
    len: usize,
}

impl Events {
    #[inline(never)]
    fn push(&mut self, slot: usize, code: u32) {
        if self.len < self.list.len() {
            self.list[self.len] = ZoneEvent { slot: slot as u8, code: code as u8 };
            self.len += 1;
        }
    }

    #[inline(never)]
    fn flush(self, core: &mut Core) {
        let c = status::counters_mut(core);
        for e in &self.list[..self.len] {
            let _ = c.spatial.zone_events.push(*e);
        }
    }
}

fn is_running(state: u8) -> bool {
    matches!(state as u32, zone_state::FADING_IN | zone_state::ACTIVE | zone_state::RINGING_OUT | zone_state::EVICTING)
}

/// Sends accepted: waiting, fading in or active (ZONE_CONFIG state 1).
fn accepts_sends(state: u8) -> bool {
    matches!(state as u32, zone_state::WAITING_KERNEL | zone_state::FADING_IN | zone_state::ACTIVE)
}

#[inline(never)]
fn set_off(h: &mut SlotHeader) {
    h.kernel_id = 0;
    h.state = zone_state::OFF as u8;
    h.started = 0;
    h.clocked = 0;
    h.bad_reported = 0;
    h.live = 0;
    h.wet = Ramp::at(0.0);
    h.fade = Ramp::at(0.0);
    h.wet_peak = 0.0;
    h.quanta_since_input = 0;
}

#[inline(never)]
fn fade_out(h: &mut SlotHeader, frames: u32) {
    h.state = zone_state::EVICTING as u8;
    h.fade.set_target(0.0, frames);
}

fn clamp_wet(wet: f32, old: f32) -> f32 {
    if wet.is_finite() {
        wet.clamp(0.0, 2.0)
    } else {
        old
    }
}

/// ZONE_CONFIG (C5, idempotent, applies on arrival) from the well-formed record at `msg[off..]`:
/// diffs it against the slots (the module comment's table), then starts the slots whose kernel is
/// resident. In `onmessage`; never allocates.
#[inline(never)]
pub fn configure(core: &mut Core, msg: &[u8], off: usize) {
    let n = (u32_at(msg, off + 12) as usize).min(wire::MAX_ZONE_SLOTS as usize);
    let shared = f32::from_bits(u32_at(msg, off + 16));
    let ramp = u32_at(msg, off + 20);
    let mut recs: [wire::ZoneConfigSlots; wire::MAX_ZONE_SLOTS as usize] = Default::default();
    for (k, r) in recs.iter_mut().enumerate().take(n) {
        if let Ok((s, _)) = wire::ZoneConfigSlots::read(msg, off + wire::ZoneConfig::FIXED_END + k * wire::ZoneConfigSlots::FIXED_END) {
            *r = s;
        }
    }
    let mut events = Events::default();
    {
        let regions = core.regions_mut();
        let a = area_mut(regions.core_state);
        if shared.is_finite() {
            let g = shared.clamp(0.0, 1.0);
            if g != a.shared_return.target {
                a.shared_return.set_target(g, ramp);
            }
        }
        let a = *a;
        let (count, stride) = geometry(regions.zones);
        let zones = &mut regions.zones[..];
        let mut active = (0..count).filter(|&k| accepts_sends(header(zones, k, stride).state)).count() as u32;
        let mut refused = 0u32;
        for (k, rec) in recs.iter().enumerate() {
            let id = if is_zone_kernel_id(rec.kernel_id) { rec.kernel_id } else { 0 };
            if k >= count {
                if id != 0 && rec.state as u32 == zone_slot_state::ACTIVE {
                    events.push(k, zone_event::REFUSED_SLOT);
                    refused += 1;
                }
                continue;
            }
            let (h, _) = slot(zones, k, stride);
            if id == 0 {
                match h.state as u32 {
                    zone_state::WAITING_KERNEL => {
                        set_off(h);
                        active = active.saturating_sub(1);
                    }
                    zone_state::FADING_IN | zone_state::ACTIVE => {
                        fade_out(h, a.evict_frames);
                        active = active.saturating_sub(1);
                    }
                    _ => {}
                }
                h.refused_id = 0;
                continue;
            }
            if id != h.kernel_id {
                if h.state as u32 != zone_state::OFF {
                    if h.refused_id != id {
                        events.push(k, zone_event::REFUSED_KERNEL);
                        h.refused_id = id;
                        refused += 1;
                    }
                    continue;
                }
                if rec.state as u32 != zone_slot_state::ACTIVE {
                    continue;
                }
                if active >= a.active_limit {
                    if h.refused_id != id {
                        events.push(k, zone_event::REFUSED_SLOT);
                        h.refused_id = id;
                        refused += 1;
                    }
                    continue;
                }
                set_off(h);
                h.kernel_id = id;
                h.ir_frames = rec.ir_frames;
                h.return_bus = rec.return_bus;
                h.wet = Ramp::at(clamp_wet(rec.wet, 0.0));
                h.state = zone_state::WAITING_KERNEL as u8;
                h.refused_id = 0;
                h.input = [0.0; 2 * QUANTUM];
                active += 1;
                continue;
            }
            // The slot's own kernel: return bus, wet and state.
            h.return_bus = rec.return_bus;
            h.ir_frames = rec.ir_frames;
            let wet = clamp_wet(rec.wet, h.wet.target);
            if wet != h.wet.target {
                h.wet.set_target(wet, ramp);
            }
            match (rec.state as u32, h.state as u32) {
                (zone_slot_state::ACTIVE, zone_state::RINGING_OUT) => {
                    h.state = if h.fade.value >= 1.0 { zone_state::ACTIVE } else { zone_state::FADING_IN } as u8;
                    active += 1;
                }
                (zone_slot_state::ACTIVE, zone_state::EVICTING) => {
                    h.state = zone_state::FADING_IN as u8;
                    h.fade.set_target(1.0, a.fade_in_frames);
                    active += 1;
                }
                (zone_slot_state::RELEASE | zone_slot_state::EVICT, zone_state::WAITING_KERNEL) => {
                    set_off(h);
                    active = active.saturating_sub(1);
                }
                (zone_slot_state::RELEASE, zone_state::FADING_IN | zone_state::ACTIVE) => {
                    if a.cut_tails != 0 {
                        fade_out(h, a.cut_frames);
                    } else {
                        h.state = zone_state::RINGING_OUT as u8;
                    }
                    active = active.saturating_sub(1);
                }
                (zone_slot_state::EVICT, zone_state::FADING_IN | zone_state::ACTIVE) => {
                    fade_out(h, a.evict_frames);
                    active = active.saturating_sub(1);
                }
                (zone_slot_state::EVICT, zone_state::RINGING_OUT) => fade_out(h, a.evict_frames),
                _ => {}
            }
        }
        area_mut(regions.core_state).refused += refused;
    }
    start_waiting(core, None, &mut events);
    events.flush(core);
}

/// Starts every slot waiting for kernel `only` (or for any kernel) whose kernel is resident: parses
/// it, plans its stagger phase around the shared reverb and the running slots (`stagger::plan_one`, exhaustive for one instance), and starts its
/// instance (clearing its state), fading in. In `onmessage`.
#[inline(never)]
fn start_waiting(core: &mut Core, only: Option<u32>, events: &mut Events) {
    let p = *core.params();
    let max_tail = tail_parts(p.zone_max_frames as usize);
    let shared = Load { phase: SHARED_PHASE, tail_parts: convolver::tail_partitions(ir::frames(p.sample_rate)) };
    let fade_in = area(core).fade_in_frames;
    let (regions, clips, _) = core.render_parts();
    let (count, stride) = geometry(regions.zones);
    let zones = &mut regions.zones[..];
    for k in 0..count {
        let h = header(zones, k, stride);
        if h.state as u32 != zone_state::WAITING_KERNEL || only.is_some_and(|id| id != h.kernel_id) {
            continue;
        }
        let Some(bytes) = clips.zone_kernel(h.kernel_id) else { continue };
        let kernel = Kernel::parse(bytes).filter(|k| (k.sample_rate() - p.sample_rate).abs() <= 0.5 && k.tail_parts() <= max_tail);
        let Some(kernel) = kernel else {
            let (h, _) = slot(zones, k, stride);
            if h.bad_reported == 0 {
                h.bad_reported = 1;
                events.push(k, zone_event::BAD_BLOB);
            }
            continue;
        };
        let mut fixed = [shared; 1 + MAX_PLANNED];
        let mut n = 1;
        for j in 0..count {
            let o = header(zones, j, stride);
            if j != k && o.started != 0 && is_running(o.state) && n < fixed.len() {
                fixed[n] = Load { phase: [(o.phase[0], o.phase[1]), (o.phase[2], o.phase[3])], tail_parts: o.tail_parts as usize };
                n += 1;
            }
        }
        let phase: [Phase; 1] = [plan_one(&fixed[..n], kernel.tail_parts()).unwrap_or(SHARED_PHASE)];
        let (h, state) = slot(zones, k, stride);
        if Instance::start(kernel, state, phase[0]).is_none() {
            continue;
        }
        h.started = 1;
        h.clocked = 0;
        h.tail_parts = kernel.tail_parts() as u32;
        h.ir_frames = kernel.frames() as u32;
        h.phase = [phase[0][0].0, phase[0][0].1, phase[0][1].0, phase[0][1].1];
        h.state = zone_state::FADING_IN as u8;
        h.fade = Ramp::at(0.0);
        h.fade.set_target(1.0, fade_in);
        h.quanta_since_input = 0;
    }
}

/// A zone kernel became resident (`clips::commit`, `clips::write`): the slots waiting for it start.
pub fn kernel_resident(core: &mut Core, id: u32) {
    let mut events = Events::default();
    start_waiting(core, Some(id), &mut events);
    events.flush(core);
}

/// Quanta after which slot input silence leaves the state at exact zeros.
fn idle_quanta(ir_frames: u32) -> u32 {
    (ir_frames as usize).div_ceil(QUANTUM).min(u32::MAX as usize) as u32 + IDLE_MARGIN_QUANTA
}

/// What [`render`] did this quantum.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderNote {
    /// Slots that convolved.
    pub running: u32,
}

/// Renders every running slot for the quantum at context frame `frame` (see the module comment);
/// `bus_count` is the configured buses (a return bus past them goes to bus 0). Called by
/// `bus::mixdown` before the buses mix. Never allocates.
pub(crate) fn render(regions: &mut Regions, clips: &ClipStore, frame: u64, bus_count: usize) -> RenderNote {
    let Regions { zones, reverb, .. } = regions;
    let (count, stride) = geometry(zones);
    let mut note = RenderNote::default();
    if count == 0 {
        return note;
    }
    let clock = (frame / QUANTUM as u64) as u32;
    let mut scratch: Option<Scratch<'_>> = None;
    let mut scratch_tried = false;
    for k in 0..count {
        let (h, state) = slot(zones, k, stride);
        h.live = 0;
        h.wet_peak = 0.0;
        h.route = if (h.return_bus as usize) < bus_count { h.return_bus } else { 0 };
        if !is_running(h.state) || h.started == 0 {
            h.input = [0.0; 2 * QUANTUM];
            continue;
        }
        if !accepts_sends(h.state) {
            h.input = [0.0; 2 * QUANTUM];
        }
        if h.input.iter().any(|x| *x != 0.0) {
            h.quanta_since_input = 0;
        } else {
            h.quanta_since_input = h.quanta_since_input.saturating_add(1);
        }
        if h.quanta_since_input > idle_quanta(h.ir_frames) {
            // Silent long enough that every history is zero: skip the convolution.
            h.clocked = 0;
            h.wet.advance(QUANTUM as u32);
            h.fade.advance(QUANTUM as u32);
            match h.state as u32 {
                zone_state::RINGING_OUT | zone_state::EVICTING => set_off(h),
                zone_state::FADING_IN if h.fade.is_settled() => h.state = zone_state::ACTIVE as u8,
                _ => {}
            }
            continue;
        }
        let kernel = clips.zone_kernel(h.kernel_id).and_then(Kernel::parse);
        if !scratch_tried {
            scratch_tried = true;
            scratch = convolver::shared_scratch(reverb);
        }
        let (Some(kernel), Some(scratch)) = (kernel, scratch.as_mut()) else {
            // The kernel went (freed under the slot) or the core has no scratch: silent until it
            // is back (an accepting slot waits for it; a fading one is done).
            if accepts_sends(h.state) {
                h.state = zone_state::WAITING_KERNEL as u8;
                h.started = 0;
            } else {
                set_off(h);
            }
            h.input = [0.0; 2 * QUANTUM];
            continue;
        };
        let Some(mut inst) = Instance::attach(kernel, state) else {
            h.state = zone_state::WAITING_KERNEL as u8;
            h.started = 0;
            h.input = [0.0; 2 * QUANTUM];
            continue;
        };
        if h.clocked == 0 {
            inst.set_clock(clock);
            h.clocked = 1;
        }
        h.output = [0.0; 2 * QUANTUM];
        {
            let (in_l, in_r) = h.input.split_at(QUANTUM);
            let (out_l, out_r) = h.output.split_at_mut(QUANTUM);
            inst.process(scratch, in_l, in_r, out_l, out_r);
        }
        let mut peak = 0.0f32;
        let (out_l, out_r) = h.output.split_at_mut(QUANTUM);
        for i in 0..QUANTUM {
            let g = h.wet.next() * h.fade.next();
            out_l[i] *= g;
            out_r[i] *= g;
            peak = peak.max(out_l[i].abs()).max(out_r[i].abs());
        }
        h.wet_peak = peak;
        h.input = [0.0; 2 * QUANTUM];
        h.live = 1;
        note.running += 1;
        match h.state as u32 {
            zone_state::FADING_IN if h.fade.is_settled() => h.state = zone_state::ACTIVE as u8,
            // The fade has reached 0: this quantum's wet was the last.
            zone_state::EVICTING if h.fade.is_settled() => {
                h.state = zone_state::OFF as u8;
                h.kernel_id = 0;
                h.started = 0;
                h.clocked = 0;
                h.bad_reported = 0;
            }
            _ => {}
        }
    }
    note
}

/// The pre-effects input hook (`bus::mixdown`): adds the wet output of every zone slot whose
/// return bus is `bus` into its input `l`, `r`. Never allocates.
#[inline]
pub fn add_returns(zones: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let (count, stride) = geometry(zones);
    for k in 0..count {
        let h = header(zones, k, stride);
        if h.live == 0 || h.route as usize != bus {
            continue;
        }
        let (wl, wr) = h.output.split_at(QUANTUM);
        for (d, s) in l.iter_mut().zip(wl) {
            *d += *s;
        }
        for (d, s) in r.iter_mut().zip(wr) {
            *d += *s;
        }
    }
}

/// The shared reverb's return gain for this quantum, per frame, or `None` when it is settled at 1
/// (then `bus::mixdown` adds the shared reverb unscaled, M1's path). Advances the ramp: call once
/// per quantum.
pub fn shared_return(core_state: &mut [u8]) -> Option<[f32; QUANTUM]> {
    let a = area_mut(core_state);
    if a.shared_return.is_settled() && a.shared_return.value == 1.0 {
        return None;
    }
    let mut g = [0.0f32; QUANTUM];
    a.shared_return.fill(&mut g);
    Some(g)
}

/// After the buses mixed (`bus::mixdown`, before the adaptive cap's step): the ladder's check and
/// the STATUS zone fields. Nothing happens without zone slots.
#[inline(never)]
pub(crate) fn after_render(core: &mut Core, note: RenderNote) {
    let (count, stride) = geometry(&core.regions().zones[..]);
    if count == 0 {
        return;
    }
    let cap = core.cap();
    let at_floor = cap.cap() <= cap.config().floor;
    let underrun = cap.underrun_pending();
    let frame = core.frame();
    ladder(core, frame, at_floor, underrun);
    let used_kb = (core.clips().zone_bytes() / 1024) as u32;
    let n = count.min(ZONES_CAP);
    let (mut active, mut ringing) = (0u16, 0u16);
    for k in 0..n {
        let h = *header(&core.regions().zones[..], k, stride);
        match h.state as u32 {
            zone_state::WAITING_KERNEL | zone_state::FADING_IN | zone_state::ACTIVE => active += 1,
            zone_state::RINGING_OUT | zone_state::EVICTING => ringing += 1,
            _ => {}
        }
        status::counters_mut(core).spatial.zones[k] =
            ZoneStatus { kernel_id: h.kernel_id, state: h.state, _pad: 0, quanta_since_input: h.quanta_since_input.min(u16::MAX as u32) as u16, wet_peak: h.wet_peak };
    }
    let c = &mut status::counters_mut(core).spatial;
    c.zone_slots = n as u16;
    c.zones_active = active;
    c.zones_ringing = ringing;
    c.zone_used_kb = used_kb;
    c.work_zones = note.running * SLOT_WU;
}

/// The load-shedding ladder (OD3): see the module comment. `at_floor` and `underrun` are the
/// adaptive cap's (`cap_controller`'s floor; the shell's probe since the last step).
#[inline(never)]
fn ladder(core: &mut Core, frame: u64, at_floor: bool, underrun: bool) {
    let regions = core.regions_mut();
    let a = area_mut(regions.core_state);
    if !at_floor {
        a.pressure = 0;
        return;
    }
    if !underrun {
        if a.pressure != 0 && frame.saturating_sub(a.last_underrun) > a.ladder_frames as u64 {
            a.pressure = 0;
        }
        return;
    }
    if a.pressure == 0 {
        a.pressure = 1;
        a.pressure_since = frame;
        a.last_underrun = frame;
        return;
    }
    a.last_underrun = frame;
    if frame.saturating_sub(a.pressure_since) < a.ladder_frames as u64 || a.shed_steps >= LADDER_STEPS {
        return;
    }
    a.pressure_since = frame;
    a.shed_steps += 1;
    let a = *a;
    let (count, stride) = geometry(regions.zones);
    let zones = &mut regions.zones[..];
    if a.shed_steps == 1 {
        area_mut(regions.core_state).cut_tails = 1;
        for k in 0..count {
            let (h, _) = slot(zones, k, stride);
            if h.state as u32 == zone_state::RINGING_OUT {
                fade_out(h, a.cut_frames);
            }
        }
        return;
    }
    // Step 2: one active slot fewer, for the session.
    let (mut active, mut weakest) = (0u32, None::<usize>);
    for k in 0..count {
        let h = header(zones, k, stride);
        if accepts_sends(h.state) {
            active += 1;
            if weakest.is_none_or(|b| header(zones, b, stride).wet.target >= h.wet.target) {
                weakest = Some(k);
            }
        }
    }
    area_mut(regions.core_state).active_limit = if active > 0 { active - 1 } else { count.saturating_sub(1) as u32 };
    if let Some(k) = weakest {
        let (h, _) = slot(zones, k, stride);
        if h.state as u32 == zone_state::WAITING_KERNEL {
            set_off(h);
        } else {
            fade_out(h, a.evict_frames);
        }
    }
}

/// Ladder steps taken this session (0..=2): main's `m3Shed` for zones (`Audio.debug()`).
pub fn shed_steps(core: &Core) -> u32 {
    area(core).shed_steps
}

/// Slot `k`'s input buffers, planar `[L; 128]`, `[R; 128]`, when the slot accepts sends (waiting
/// for kernel, fading in or active); `None` otherwise or past the slots. For C4's `sends::tap`,
/// which has only the region: it adds `send[k] × mono sum × chain gain` into both.
pub fn slot_input(zones: &mut [u8], k: usize) -> Option<(&mut [f32], &mut [f32])> {
    let (count, stride) = geometry(zones);
    if k >= count {
        return None;
    }
    let (h, _) = slot(zones, k, stride);
    if !accepts_sends(h.state) {
        return None;
    }
    let (l, r) = h.input.split_at_mut(QUANTUM);
    Some((l, r))
}

/// Adds `l`, `r` (each at most a quantum) into slot `k`'s input, when it accepts sends (tests and
/// benches, before C4's sends; `onmessage` or between quanta).
pub fn add_input(core: &mut Core, k: usize, l: &[f32], r: &[f32]) {
    if let Some((il, ir)) = slot_input(&mut core.regions_mut().zones[..], k) {
        for (d, s) in il.iter_mut().zip(l) {
            *d += *s;
        }
        for (d, s) in ir.iter_mut().zip(r) {
            *d += *s;
        }
    }
}

/// Zone slots in the core (`max_zone_slots`, 0 when the region is empty).
pub fn slot_count(core: &Core) -> usize {
    geometry(&core.regions().zones[..]).0
}

/// Slot `k`'s header, or `None` past the slots (tests and a debugger).
pub fn slot_header(core: &Core, k: usize) -> Option<&SlotHeader> {
    let zones = &core.regions().zones[..];
    let (count, stride) = geometry(zones);
    (k < count).then(|| header(zones, k, stride))
}

/// Slot `k`'s state, the wire's `ZoneState` (0 off when `k` is past the slots).
pub fn slot_state(core: &Core, k: usize) -> u8 {
    slot_header(core, k).map_or(zone_state::OFF as u8, |h| h.state)
}

/// The shared reverb's return gain as last rendered (its ramp's value).
pub fn shared_return_gain(core: &Core) -> f32 {
    area(core).shared_return.value
}

/// RESET (§4.2: "RESET clears … zone slots"): every slot off, the shared return back to 1. The
/// ladder's steps stay (they are for the session); kernels go with the clips unless `keepClips`.
pub fn reset(core: &mut Core) {
    let regions = core.regions_mut();
    let (count, stride) = geometry(regions.zones);
    for k in 0..count {
        let (h, _) = slot(regions.zones, k, stride);
        set_off(h);
        h.refused_id = 0;
        h.input = [0.0; 2 * QUANTUM];
        h.output = [0.0; 2 * QUANTUM];
    }
    let a = area_mut(regions.core_state);
    a.shared_return = Ramp::at(1.0);
    a.pressure = 0;
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
        assert_eq!(kernel_budget_bytes(3, 96_000), 3 * arena_block_bytes(kernel_blob_bytes(96_000)));
        assert_eq!(arena_block_bytes(kernel_blob_bytes(96_000)), 1536 * 1024, "the 1.5 MiB class");
    }

    #[test]
    fn the_block_rounding_matches_the_arena() {
        use crate::arena::size_class::{class_bytes, class_of};
        for bytes in [1usize, 4096, 4097, 65_000, 1_507_360, 3_014_688, 6_000_000] {
            assert_eq!(arena_block_bytes(bytes), class_bytes(class_of(bytes).unwrap()), "{bytes}");
        }
    }

    #[test]
    fn a_slot_with_its_kernel_is_near_the_memory_table() {
        // api-and-models §10 C3: 3.1 / 6.1 MB per slot at 2 / 4 s (state plus kernel). The spike's
        // figures are MiB (3.21 / 6.29 MB decimal); the kernel is its arena block (1.5 / 3 MiB).
        for (frames, mib) in [(96_000usize, 3.1f64), (192_000, 6.1)] {
            let (state, kernel) = (slot_state_bytes(frames), arena_block_bytes(kernel_blob_bytes(frames)));
            let total = (state + kernel) as f64 / (1u64 << 20) as f64;
            eprintln!("{frames} frames: state {state} B + kernel block {kernel} B = {total:.2} MiB");
            assert!((total - mib).abs() < 0.15, "{total} MiB at {frames} frames");
        }
        assert_eq!(slot_state_bytes(96_000) % REGION_ALIGN, 0);
        assert_eq!(SLOT_HEADER_BYTES % REGION_ALIGN, 32);
    }

    #[test]
    fn the_zone_area_follows_the_bus_area() {
        assert!(ZONE_AREA_OFFSET >= crate::bus::BUS_AREA_OFFSET + core::mem::size_of::<crate::bus::BusArea>());
        assert_eq!(ZONE_AREA_OFFSET % REGION_ALIGN, 0);
    }
}
