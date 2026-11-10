//! The bus tree (api-and-models §3 "Bus state serialisation", §4.2 BUS_CONFIG, BUS_MIX, MASTER;
//! architecture §1, §4.3).
//!
//! **Tree.** BUS_CONFIG sends the whole tree, one entry per bus index: its parent (`0xFFFF` for a
//! root) and its effects. The core keeps at most `max_buses` buses (the rest are dropped and
//! counted). Parents are validated, so a bad tree never loops or reads out of bounds: a parent
//! that is out of range, or the bus itself, or part of a cycle, is replaced by the first root (bus 0
//! becomes the root when no bus is one), as `settings.ts` repairs a tree on main. The order buses
//! are mixed in is computed then (deepest first), so parents need not come before their children.
//! Before any BUS_CONFIG the tree is one root bus at unity gain.
//!
//! **Gains and ramps.** BUS_MIX gives each bus its own gain (mute and solo are folded into it on
//! main: a muted bus has gain 0) and its snapshot low-pass cut-off (24,000 Hz is off), both ramped
//! linearly over `rampFrames` from the start of the next quantum: the gain per frame (click-free),
//! the cut-off per quantum. The core multiplies gains down the tree by mixing each bus into its
//! parent. MASTER sets the output's volume and mute, ramped the same way. A bus that BUS_CONFIG
//! keeps keeps its gain, cut-off, effect state and meter; a new bus starts at unity until BUS_MIX.
//! A non-finite gain or volume leaves the old target; a negative one is 0; a non-finite cut-off is
//! off.
//!
//! **Timing.** BUS_CONFIG, BUS_MIX and MASTER apply when they arrive, between quanta, whatever
//! their `frameOffset` (main sends them asap; no M1 caller stamps them).
//!
//! **Render** ([`mixdown`], once per quantum after the voices): voices have mixed into their bus's
//! stereo buffer (a voice whose bus index isn't configured goes to bus 0, the root, as main's remap
//! does). Then, deepest bus first: the effect chain (`fx.rs`, K5; reverb sends feed the shared
//! convolver's input), the snapshot low-pass, the gain ramp, the meter (`meters.rs`), and the sum
//! into the parent's buffer, or into the output for a root. Then the shared reverb's wet signal is
//! added to the output (`audio_dsp::convolver`, A2.2b), then the MASTER gain ramp, and last the
//! master peak limiter (`audio_dsp::limiter`, A2.8). Peaks of the first 32 buses go to STATUS (K12).
//!
//! **The limiter** comes after MASTER: it is the output's safety stage, so whatever MASTER is set
//! to, nothing leaves the core above its 0 dBFS ceiling, and turning MASTER down lowers what
//! reaches the limiter (less limiting) instead of limiting first and then turning the limited
//! signal down (quieter, yet still pumping). It adds no latency, and while nothing exceeds the
//! ceiling the output is bit-exact what it was without it (the module doc has the design).
//!
//! **RESET** clears the buses' DSP state (buffers, filter and compressor state, the reverb tail,
//! meters, the limiter's gain reduction) and settles every ramp on its target. The tree and the gains stay: they are main's
//! intent, and main re-sends them after a rebuild's RESET (architecture §7, replay order), but not
//! after the idle `RESET 0` it sends when the last World is released.
//!
//! **Voice limits** (`maxVoices`) are main's (the voice table steals before the global cap, and its
//! limits are reset on each BUS_CONFIG); BUS_CONFIG carries none.
//!
//! The bus slots live in the `Buses` region (`[BusSlot; max_buses]`), the tree's scalars and the
//! reverb input in [`BusArea`], in the core-state region after the scheduler's area. All-zero is
//! valid for both, and [`init`] sets the unity defaults. `mixdown` never allocates.

use audio_dsp::biquad::Biquad;
use audio_dsp::convolver;
use audio_dsp::limiter::Limiter;
use audio_dsp::ramp::Ramp;
use audio_wire::generated::{self as wire, BusConfigBusesEffects, BusMixBuses, Master, RecordHead};

use crate::core::{Core, Regions};
use crate::fx::{self, FxChain};
use crate::layout::REGION_ALIGN;
use crate::meters::{self, Meter};
use crate::params::InitParams;
use crate::{status, QUANTUM};

/// `parent` of a root bus (the wire's `BUS_ROOT`).
pub const ROOT: u16 = wire::BUS_ROOT as u16;
/// The cut-off that means "no snapshot low-pass" (the wire's `BUS_LP_OFF_HZ`).
pub const LP_OFF_HZ: f32 = wire::BUS_LP_OFF_HZ as f32;

/// One bus. `#[repr(C)]`; all-zero is valid (a silent bus at gain 0; [`init`] and BUS_CONFIG set
/// unity).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BusSlot {
    /// This quantum's input, planar stereo `[L; 128][R; 128]`; voices and child buses add into it.
    pub buf: [f32; 2 * QUANTUM],
    /// The bus's own gain (BUS_MIX), ramped per frame.
    pub gain: Ramp,
    /// The snapshot low-pass cut-off in Hz (BUS_MIX), ramped per quantum; [`LP_OFF_HZ`] is off.
    pub lp: Ramp,
    /// The parent bus index, or [`ROOT`].
    pub parent: u16,
    /// Steps to a root (0 for a root).
    pub depth: u16,
    pub meter: Meter,
    /// The snapshot low-pass (`audio_dsp::biquad`, A2.2a).
    pub snapshot: Biquad,
    /// The effect chain (`fx.rs`, K5).
    pub fx: FxChain,
}

/// The bus tree's scalars and the shared reverb's input. All-zero is valid; [`init`] fills it.
#[repr(C)]
pub struct BusArea {
    /// Configured buses (1 after `init`).
    pub count: u32,
    /// Non-zero while a configured bus has a reverb send (the convolver runs only then).
    pub has_reverb: u32,
    pub sample_rate: f32,
    /// The meters' per-quantum decay (`meters::decay_per_block`).
    pub meter_decay: f32,
    /// MASTER: the output gain (`volume`, or 0 when muted), ramped per frame.
    pub master: Ramp,
    /// MASTER as last received.
    pub master_volume: f32,
    pub master_muted: u32,
    /// Buses, effects and BUS_MIX entries dropped (past the limits, a bus's second compressor,
    /// unknown effect types), cumulative. The wire has no STATUS field for it; tests and a debugger read it.
    pub dropped: u32,
    /// The mix order: bus indices, deepest first (`count` of them).
    pub order: [u8; InitParams::MAX_BUSES as usize],
    /// The summed reverb sends of this quantum, planar stereo.
    pub reverb_in: [f32; 2 * QUANTUM],
    /// The master peak limiter on the output, after MASTER (A2.8).
    pub limiter: Limiter,
    /// Quanta in which the limiter changed the output, cumulative. The wire has no STATUS field for
    /// it (K1 is frozen); tests and a debugger read it.
    pub limited: u32,
}

/// Offset of [`BusArea`] in the core-state region (after the scheduler's area).
pub const BUS_AREA_OFFSET: usize = (crate::scheduler::SCHEDULER_AREA_OFFSET + core::mem::size_of::<crate::scheduler::SchedulerArea>() + REGION_ALIGN - 1) / REGION_ALIGN * REGION_ALIGN;

const _: () = assert!(BUS_AREA_OFFSET + core::mem::size_of::<BusArea>() <= crate::layout::CORE_STATE_BYTES, "the bus area fits the core-state region");
const _: () = assert!(core::mem::align_of::<BusSlot>() <= REGION_ALIGN);
const _: () = assert!(core::mem::size_of::<BusSlot>() <= crate::layout::BUS_BYTES);

struct View<'a> {
    slots: &'a mut [BusSlot],
    area: &'a mut BusArea,
}

fn view(regions: &mut Regions) -> View<'_> {
    let count = regions.buses.len() / crate::layout::BUS_BYTES;
    let state = &mut regions.core_state[BUS_AREA_OFFSET..BUS_AREA_OFFSET + core::mem::size_of::<BusArea>()];
    // SAFETY: both regions are 64-byte aligned (Layout) and zeroed at init; all-zero bytes are a
    // valid BusSlot and BusArea (integers, floats, arrays, and DSP state that `audio-dsp` keeps
    // all-zero valid). BUS_BYTES >= size_of::<BusSlot>() and is a multiple of REGION_ALIGN, so the
    // slots are aligned and fit; BUS_AREA_OFFSET is a multiple of REGION_ALIGN and the area fits
    // (asserted above). The slices are distinct regions. Only this module views these bytes.
    unsafe {
        View {
            slots: core::slice::from_raw_parts_mut(regions.buses.as_mut_ptr() as *mut BusSlot, count),
            area: &mut *(state.as_mut_ptr() as *mut BusArea),
        }
    }
}

/// The bus slots (`max_buses` of them; the first [`count`] are configured).
pub fn slots(core: &Core) -> &[BusSlot] {
    let bytes: &[u8] = &core.regions().buses[..];
    // SAFETY: as in `view`.
    unsafe { core::slice::from_raw_parts(bytes.as_ptr() as *const BusSlot, bytes.len() / crate::layout::BUS_BYTES) }
}

/// The bus area.
pub fn area(core: &Core) -> &BusArea {
    let bytes = &core.regions().core_state[BUS_AREA_OFFSET..BUS_AREA_OFFSET + core::mem::size_of::<BusArea>()];
    // SAFETY: as in `view`.
    unsafe { &*(bytes.as_ptr() as *const BusArea) }
}

/// Configured buses.
pub fn count(core: &Core) -> usize {
    area(core).count as usize
}

/// A unity bus: gain 1, low-pass off, `parent`, fresh DSP state.
fn fresh(parent: u16) -> BusSlot {
    // SAFETY: all-zero is a valid BusSlot (see `view`).
    let mut s: BusSlot = unsafe { core::mem::zeroed() };
    s.gain = Ramp::at(1.0);
    s.lp = Ramp::at(LP_OFF_HZ);
    s.parent = parent;
    s
}

/// Sets the defaults: one root bus at unity, MASTER at unity, the meters' decay, and the shared
/// reverb's state (`convolver::init`). Called once by `Core::new`. Doesn't allocate.
pub fn init(core: &mut Core) {
    let sample_rate = core.params().sample_rate;
    let regions = core.regions_mut();
    convolver::init(&mut regions.reverb[..], sample_rate);
    let v = view(regions);
    v.area.sample_rate = sample_rate;
    v.area.meter_decay = meters::decay_per_block(sample_rate, QUANTUM);
    v.area.master = Ramp::at(1.0);
    v.area.master_volume = 1.0;
    v.area.master_muted = 0;
    v.area.has_reverb = 0;
    v.area.limiter = Limiter::new(sample_rate);
    v.area.limited = 0;
    if let Some(first) = v.slots.first_mut() {
        *first = fresh(ROOT);
        v.area.order[0] = 0;
        v.area.count = 1;
    }
    // STATUS `busCount` stays 0 (no peaks sent) until main's first BUS_CONFIG names the buses.
}

// --- Record parsing (in `onmessage`, from `scheduler::submit`) ---

fn u16_at(msg: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([msg[off], msg[off + 1]])
}

fn u32_at(msg: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([msg[off], msg[off + 1], msg[off + 2], msg[off + 3]])
}

/// `true` when the BUS_CONFIG record at `msg[off..off + len]` is well formed: every bus entry and
/// every effect lies inside the record. (Pass 1 of `submit`; the generated reader would allocate.)
pub fn config_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    let end = off + len;
    if len < wire::BusConfig::FIXED_END || end > msg.len() {
        return false;
    }
    let buses = u32_at(msg, off + 12) as usize;
    let mut cur = off + wire::BusConfig::FIXED_END;
    for _ in 0..buses {
        if cur + 4 > end {
            return false;
        }
        let effects = u16_at(msg, cur + 2) as usize;
        cur += 4;
        match effects.checked_mul(BusConfigBusesEffects::FIXED_END).and_then(|n| cur.checked_add(n)) {
            Some(next) if next <= end => cur = next,
            _ => return false,
        }
    }
    true
}

/// `true` when the BUS_MIX record at `msg[off..off + len]` holds its `busCount` entries.
pub fn mix_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::BusMix::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 12) as usize;
    n.checked_mul(BusMixBuses::FIXED_END).is_some_and(|bytes| wire::BusMix::FIXED_END + bytes <= len)
}

/// BUS_CONFIG: applies the tree in the (well-formed) record at `msg[off..]`. See the module
/// comment for validation and what is kept.
pub fn configure(core: &mut Core, msg: &[u8], off: usize) {
    let sample_rate = core.params().sample_rate;
    let max = core.params().max_buses as usize;
    let Ok((head, _)) = RecordHead::read(msg, off) else { return };
    let end = off + head.words as usize * 4;
    let wanted = u32_at(msg, off + 12) as usize;
    let regions = core.regions_mut();
    let v = view(regions);
    let max = max.min(v.slots.len()).min(InitParams::MAX_BUSES as usize);
    let old_count = v.area.count as usize;
    let count = wanted.min(max);
    let mut dropped = (wanted - count) as u32;
    let mut cur = off + wire::BusConfig::FIXED_END;
    let mut has_reverb = false;
    for i in 0..count {
        if cur + 4 > end {
            break;
        }
        let parent = u16_at(msg, cur);
        let effects = u16_at(msg, cur + 2) as usize;
        cur += 4;
        if i >= old_count {
            v.slots[i] = fresh(parent);
        }
        let slot = &mut v.slots[i];
        slot.parent = parent;
        let start = cur;
        let list = (0..effects).filter_map(|e| BusConfigBusesEffects::read(&msg[..end], start + e * BusConfigBusesEffects::FIXED_END).ok()).map(|(fx, _)| (fx.type_, fx.p));
        dropped += slot.fx.configure(list, sample_rate);
        has_reverb |= slot.fx.has_reverb_send();
        cur += effects * BusConfigBusesEffects::FIXED_END;
    }
    // Buses no longer configured go silent and lose their state.
    let len = v.slots.len();
    let removed = count.min(len)..old_count.min(len).max(count.min(len));
    for slot in v.slots[removed].iter_mut() {
        *slot = fresh(ROOT);
        slot.gain = Ramp::at(0.0);
    }
    if count == 0 {
        // An empty tree keeps one root bus, so voices still have somewhere to go.
        v.slots[0] = fresh(ROOT);
    }
    let count = count.max(1);
    repair_tree(&mut v.slots[..count]);
    order(&v.slots[..count], &mut v.area.order[..count]);
    v.area.count = count as u32;
    v.area.has_reverb = has_reverb as u32;
    v.area.dropped = v.area.dropped.wrapping_add(dropped);
    let c = status::counters_mut(core);
    c.set_bus_count(count);
    for b in count..crate::counters::PEAKS_CAP {
        c.set_peak(b, 0.0, 0.0);
    }
}

/// Makes `slots` a forest whose roots have `parent == ROOT`: out-of-range and self parents, and
/// every bus whose walk up loops, are re-parented to the first root (bus 0 is made a root when
/// none is). Sets each bus's `depth`.
fn repair_tree(slots: &mut [BusSlot]) {
    let n = slots.len();
    for i in 0..n {
        let p = slots[i].parent;
        if p != ROOT && (p as usize >= n || p as usize == i) {
            slots[i].parent = ROOT; // fixed below to the first root
            slots[i].depth = 1; // marks "re-parent" for the pass below
        } else {
            slots[i].depth = 0;
        }
    }
    let root = match slots.iter().position(|s| s.parent == ROOT && s.depth == 0) {
        Some(r) => r,
        None => match slots.iter().position(|s| s.parent == ROOT) {
            Some(r) => r,
            None => {
                slots[0].parent = ROOT;
                0
            }
        },
    };
    slots[root].depth = 0;
    for s in slots.iter_mut() {
        if s.parent == ROOT && s.depth == 1 {
            s.parent = root as u16;
        }
    }
    // Cycles: a walk longer than n steps never reaches a root.
    for i in 0..n {
        let mut b = i;
        let mut steps = 0usize;
        while slots[b].parent != ROOT && steps <= n {
            b = slots[b].parent as usize;
            steps += 1;
        }
        if steps > n {
            slots[i].parent = root as u16;
        }
    }
    for i in 0..n {
        let mut b = i;
        let mut depth = 0u16;
        while slots[b].parent != ROOT {
            b = slots[b].parent as usize;
            depth += 1;
        }
        slots[i].depth = depth;
    }
}

/// Writes the mix order into `out`: bus indices by depth, deepest first, ties by index (stable
/// insertion sort; at most 256 buses, in `onmessage`).
fn order(slots: &[BusSlot], out: &mut [u8]) {
    for (i, o) in out.iter_mut().enumerate() {
        *o = i as u8;
    }
    for i in 1..out.len() {
        let mut j = i;
        while j > 0 && slots[out[j - 1] as usize].depth < slots[out[j] as usize].depth {
            out.swap(j - 1, j);
            j -= 1;
        }
    }
}

/// BUS_MIX: sets each configured bus's gain and cut-off targets from the (well-formed) record at
/// `msg[off..]`, ramped over its `rampFrames`. Entries past the configured buses are dropped and
/// counted; buses past the record's entries keep their targets.
pub fn mix(core: &mut Core, msg: &[u8], off: usize) {
    let n = u32_at(msg, off + 12) as usize;
    let ramp = u32_at(msg, off + 16);
    let v = view(core.regions_mut());
    let count = v.area.count as usize;
    for i in 0..n {
        let Ok((entry, _)) = BusMixBuses::read(msg, off + wire::BusMix::FIXED_END + i * BusMixBuses::FIXED_END) else { break };
        if i >= count {
            v.area.dropped = v.area.dropped.wrapping_add((n - i) as u32);
            break;
        }
        let slot = &mut v.slots[i];
        if entry.gain.is_finite() {
            slot.gain.set_target(entry.gain.max(0.0), ramp);
        }
        let lp = if entry.lp_hz.is_finite() { entry.lp_hz.clamp(0.0, LP_OFF_HZ) } else { LP_OFF_HZ };
        if lp != slot.lp.target {
            slot.lp.set_target(lp, ramp);
        }
    }
}

/// MASTER: the output's volume and mute, ramped over `rampFrames`.
pub fn master(core: &mut Core, m: &Master) {
    let v = view(core.regions_mut());
    if m.volume.is_finite() {
        v.area.master_volume = m.volume.max(0.0);
    }
    v.area.master_muted = (m.muted != 0) as u32;
    let target = if m.muted != 0 { 0.0 } else { v.area.master_volume };
    v.area.master.set_target(target, m.ramp_frames);
}

/// RESET: clears the DSP state of every bus and the reverb tail, and settles every ramp on its
/// target. The tree, gains and MASTER stay (see the module comment).
pub fn reset(core: &mut Core) {
    let regions = core.regions_mut();
    convolver::reset(&mut regions.reverb[..]);
    let v = view(regions);
    let count = (v.area.count as usize).min(v.slots.len());
    for slot in v.slots[..count].iter_mut() {
        slot.buf = [0.0; 2 * QUANTUM];
        slot.gain = Ramp::at(slot.gain.target);
        slot.lp = Ramp::at(slot.lp.target);
        slot.meter.reset();
        slot.snapshot = Biquad::default();
        slot.fx.reset();
    }
    v.area.master = Ramp::at(v.area.master.target);
    v.area.limiter.reset();
    v.area.reverb_in = [0.0; 2 * QUANTUM];
    let c = status::counters_mut(core);
    for b in 0..crate::counters::PEAKS_CAP {
        c.set_peak(b, 0.0, 0.0);
    }
}

// --- Render (inside `process`) ---

/// The buses' input buffers, for the voices' render loop: a raw view, so the voices' slots can be
/// borrowed at the same time (they are another region).
pub(crate) struct Inputs {
    base: *mut BusSlot,
    count: usize,
}

impl Inputs {
    /// The buffers of the configured buses in `regions`.
    pub(crate) fn of(regions: &mut Regions) -> Inputs {
        let v = view(regions);
        let count = (v.area.count as usize).clamp(1, v.slots.len().max(1)).min(v.slots.len());
        Inputs { base: v.slots.as_mut_ptr(), count }
    }

    /// Bus `bus`'s left and right input (a bus not configured routes to bus 0, the root), or
    /// `None` when the core has no bus slot at all.
    pub(crate) fn get(&mut self, bus: u16) -> Option<(&mut [f32], &mut [f32])> {
        if self.count == 0 {
            return None;
        }
        let index = if (bus as usize) < self.count { bus as usize } else { 0 };
        // SAFETY: `index < count <= slots.len()` of the `Buses` region viewed in `of`; the region
        // outlives the render loop and nothing else views it while `Inputs` is in use (the voices
        // view their own regions). `&mut self` keeps one buffer borrowed at a time.
        let slot = unsafe { &mut *self.base.add(index) };
        let (l, r) = slot.buf.split_at_mut(QUANTUM);
        Some((l, r))
    }
}

/// Mixes the bus tree into the output region (see the module comment). Called by `Core::process`
/// after the voices rendered into the buses' buffers. Never allocates.
pub fn mixdown(core: &mut Core) {
    let regions = core.regions_mut();
    let output: &mut [f32] = &mut regions.output[..];
    let output: *mut [f32] = output;
    let reverb: &mut [u8] = &mut regions.reverb[..];
    let reverb: *mut [u8] = reverb;
    let v = view(regions);
    // SAFETY: the output and reverb regions are distinct from the buses and core-state regions
    // `v` views (Layout), so these views don't alias it.
    let (out_l, out_r) = unsafe { &mut *output }[..2 * QUANTUM].split_at_mut(QUANTUM);
    let reverb = unsafe { &mut *reverb };
    let count = (v.area.count as usize).min(v.slots.len());
    let sample_rate = v.area.sample_rate;
    let decay = v.area.meter_decay;
    let (rev_l, rev_r) = v.area.reverb_in.split_at_mut(QUANTUM);
    let mut sent = false;
    let mut block = [0.0f32; 2 * QUANTUM];
    for k in 0..count {
        let b = v.area.order[k] as usize;
        let slot = &mut v.slots[b];
        {
            let (l, r) = slot.buf.split_at_mut(QUANTUM);
            sent |= slot.fx.process(l, r, rev_l, rev_r);
            fx::snapshot_lowpass(&mut slot.snapshot, sample_rate, slot.lp.value, l, r);
            slot.lp.advance(QUANTUM as u32);
            if slot.gain.is_settled() {
                let g = slot.gain.value;
                if g != 1.0 {
                    for x in l.iter_mut().chain(r.iter_mut()) {
                        *x *= g;
                    }
                }
            } else {
                for i in 0..QUANTUM {
                    let g = slot.gain.next();
                    l[i] *= g;
                    r[i] *= g;
                }
            }
            slot.meter.update(l, r, decay);
        }
        block.copy_from_slice(&slot.buf);
        slot.buf = [0.0; 2 * QUANTUM];
        let parent = slot.parent;
        let (dst_l, dst_r): (&mut [f32], &mut [f32]) = if parent == ROOT || parent as usize >= count {
            (&mut out_l[..], &mut out_r[..])
        } else {
            let (l, r) = v.slots[parent as usize].buf.split_at_mut(QUANTUM);
            (l, r)
        };
        for i in 0..QUANTUM {
            dst_l[i] += block[i];
            dst_r[i] += block[QUANTUM + i];
        }
    }
    if v.area.has_reverb != 0 || sent {
        convolver::process(reverb, rev_l, rev_r, out_l, out_r);
        rev_l.fill(0.0);
        rev_r.fill(0.0);
    }
    let master = &mut v.area.master;
    if master.is_settled() {
        let g = master.value;
        if g != 1.0 {
            for i in 0..QUANTUM {
                out_l[i] *= g;
                out_r[i] *= g;
            }
        }
    } else {
        for i in 0..QUANTUM {
            let g = master.next();
            out_l[i] *= g;
            out_r[i] *= g;
        }
    }
    if v.area.limiter.process(out_l, out_r) {
        v.area.limited = v.area.limited.wrapping_add(1);
    }
    let peaks = count.min(crate::counters::PEAKS_CAP);
    for b in 0..peaks {
        let m = view(core.regions_mut()).slots[b].meter;
        status::counters_mut(core).set_peak(b, m.l, m.r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(parents: &[u16]) -> Vec<BusSlot> {
        parents.iter().map(|&p| fresh(p)).collect()
    }

    fn parents(slots: &[BusSlot]) -> Vec<u16> {
        slots.iter().map(|s| s.parent).collect()
    }

    #[test]
    fn a_good_tree_is_kept_and_ordered_deepest_first() {
        // 0 root; 1, 2 under 0; 3 under 1; 4 under 3.
        let mut s = tree(&[ROOT, 0, 0, 1, 3]);
        repair_tree(&mut s);
        assert_eq!(parents(&s), vec![ROOT, 0, 0, 1, 3]);
        assert_eq!(s.iter().map(|b| b.depth).collect::<Vec<_>>(), vec![0, 1, 1, 2, 3]);
        let mut o = [0u8; 5];
        order(&s, &mut o);
        assert_eq!(o, [4, 3, 1, 2, 0]);
    }

    #[test]
    fn children_may_come_before_their_parents() {
        let mut s = tree(&[2, ROOT, 1]);
        repair_tree(&mut s);
        let mut o = [0u8; 3];
        order(&s, &mut o);
        assert_eq!(o, [0, 2, 1]);
    }

    #[test]
    fn bad_parents_and_cycles_go_to_the_first_root() {
        // 1 points at itself, 2 out of range, 3 and 4 form a cycle, 5 hangs off the cycle.
        let mut s = tree(&[ROOT, 1, 9, 4, 3, 4]);
        repair_tree(&mut s);
        let p = parents(&s);
        assert_eq!(&p[..3], &[ROOT, 0, 0]);
        // Every bus reaches the root in at most n steps.
        for i in 0..s.len() {
            let mut b = i;
            let mut steps = 0;
            while s[b].parent != ROOT {
                b = s[b].parent as usize;
                steps += 1;
                assert!(steps <= s.len(), "bus {i} loops: {p:?}");
            }
            assert_eq!(b, 0);
        }
    }

    #[test]
    fn a_tree_with_no_root_makes_bus_0_the_root() {
        let mut s = tree(&[1, 0]);
        repair_tree(&mut s);
        assert_eq!(parents(&s), vec![ROOT, 0]);
    }
}
