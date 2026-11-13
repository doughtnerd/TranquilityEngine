//! A bus's gain lanes (ADR 0171 amended by 0172 §1.3; architecture §4.5, R1, R2, R3, R6).
//!
//! **Design.** A bus's gain is the per-sample product of seven lanes: `authored`, `runtime`,
//! `snapshot`, `monitor`, `dip` (written by main through `BUS_RAMP`), `duck` and `automation`
//! (owned by the core). A lane that isn't moving costs nothing; lanes at identity are **skipped,
//! not multiplied by 1.0** (R3), and an asap `BUS_RAMP` on a lone lane uses `Ramp::next`'s
//! arithmetic, so every bus golden keeps its digest.
//!
//! **Where each lane lives (B1a, M5-0 wave 2).**
//! - `runtime` (lane 1) is the bus slot's own ramp, `BusSlot::gain` (what BUS_MIX drove before
//!   M5), so a bus driven only through the runtime lane runs exactly today's code: the same ramp,
//!   the same `Ramp::next` steps, the same skip at a settled 1. A removed bus's slot goes silent
//!   through it and a new one starts at 1, as `bus::configure` has always done.
//! - The `snapshot` lane's low-pass is `BusSlot::lp` (ramped per quantum by `bus::mixdown`).
//! - `authored`, `snapshot` (gain), `monitor` and `dip` (lanes 0, 2, 3, 4) are ramps in the bus's
//!   [`BusLanes`] entry. Bit `k` of [`BusLanes::moving`] is set while lane `k` isn't a settled 1;
//!   a clear bit means the lane **is** 1 whatever its stored ramp holds (so an all-zero entry is
//!   all-unity, and a lane whose bit is clear restarts from 1 when it is next written).
//! - `duck` (lane 5) is `duck::gain`'s curve, `automation` (lane 6) automation's `gainMul`
//!   (ADR 0158 §3): core-owned, so a `BUS_RAMP` naming them is ignored and counted.
//! - The output gain (`BUS_MASTER_OUT`) is the same shape: its `runtime` lane is MASTER's ramp
//!   (`BusArea::master`, so MASTER and a runtime-lane `BUS_RAMP` on the output drive one value,
//!   never multiplied twice), its lanes 0, 2, 3, 4 the last entry of the `Lanes` region
//!   ([`master_entry`]). The output has no low-pass.
//!
//! **Order of the product** (only a lone lane must be bit-identical, R3): the runtime lane, then
//! lanes 0, 2, 3, 4 in index order into one curve or scalar that multiplies the samples once;
//! then the duck curve; then automation, each multiplied into the samples as applied (as before
//! M5). Settled lanes fold into one scalar (§4.5 step 1); otherwise a 128-frame curve is built
//! from each lane's `Ramp::next` (§4.5 step 2).
//!
//! **Records.** [`on_ramp`] applies an asap `BUS_RAMP`: `Ramp::set_target` from the lane's current
//! value, so a retarget never jumps. A **stamped** one is class B (B1b, W3; ARCH §4.5, R6): the
//! scheduler queues it as a pending record, `due::route` takes it into the quantum's due list and
//! hands it to [`on_due`], which applies it at once when its frame is the quantum's first (or it is
//! late), and otherwise **stages** it on the bus's entry ([`BusLanes::staged`]): the gain stage
//! then builds the quantum's curve with the lane holding its motion up to the stamp's sample and
//! retargeting there (a start-sample compare), so the ramp starts from the lane's value at its
//! start frame. Stamps of one lane apply in frame order. A stamped record that finds the due list
//! (or its bus's [`STAMPS`] stage slots) full applies at the quantum's start and counts
//! `busRecordsEarly`, never splitting ([`apply_early`]). A stamped low-pass target (lane 2) applies
//! at the start of the quantum holding its frame: the snapshot low-pass ramps per quantum.
//! (BUS_MIX, which carried a bus's runtime gain and snapshot low-pass, was retired at R0; its
//! opcode 0x11 stays reserved.)
//!
//! Nothing here allocates; [`apply`] runs once per bus per quantum inside `process`.

use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;

use crate::automation::{self, BusAuto};
use crate::bus::{self, BusSlot, LP_OFF_HZ};
use crate::core::Core;
use crate::QUANTUM;

/// Lanes per bus (R1): `authored`, `runtime`, `snapshot`, `monitor`, `dip`, `duck`, `automation`.
/// The wire's `LANE_*` ids index them.
pub const LANES: usize = wire::LANE_COUNT as usize;

/// The runtime lane, which lives in the bus slot's (or MASTER's) own ramp.
const RUNTIME: usize = wire::LANE_RUNTIME as usize;

/// The lanes kept in a [`BusLanes`] entry, in the order they multiply: `authored`, `snapshot`,
/// `monitor`, `dip`.
const ENTRY_LANES: [usize; 4] = [wire::LANE_AUTHORED as usize, wire::LANE_SNAPSHOT as usize, wire::LANE_MONITOR as usize, wire::LANE_DIP as usize];

/// A `BUS_RAMP` gain target is clamped to `0..=4` (API §4.2: authored 2 × runtime 2 is legal).
pub const MAX_LANE_GAIN: f32 = 4.0;

/// A `BUS_RAMP` low-pass target is clamped to `10..=24,000` Hz (24,000 = off).
pub const MIN_LANE_LP_HZ: f32 = 10.0;

/// One bus's lane state in the `Lanes` region. `#[repr(C)]`, all-zero valid: every bit of
/// `moving` clear is every lane at 1.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BusLanes {
    /// One ramp per lane, indexed by the wire's `LANE_*`. Only lanes 0, 2, 3, 4 are used: the
    /// runtime lane is the slot's (or MASTER's) ramp, lanes 5 and 6 keep their state in `duck.rs`
    /// and `automation.rs`. A lane's ramp is read only while its `moving` bit is set.
    pub lanes: [Ramp; LANES],
    /// Bit `k` set while lane `k` isn't a settled 1 (the "every lane settled" test of §4.5 step 1
    /// reads it too). Never set for lanes 1, 5, 6.
    pub moving: u32,
    /// B1b: stamps staged for the quantum [`staged_quantum`](Self::staged_quantum) names (0 to
    /// [`STAMPS`]), kept in the unused ramps of lanes 1, 5 and 6 ([`stage`]); the gain stage
    /// consumes them and clears this.
    pub staged: u32,
    /// The quantum (its first frame / 128, truncated) the staged stamps belong to.
    pub staged_quantum: u32,
    pub _reserved: u32,
}

/// Stamps one bus can hold staged in a quantum: the three ramps of its entry the lanes don't use
/// (lanes 1, 5 and 6). A fourth applies at the quantum's start and counts `busRecordsEarly`.
pub const STAMPS: usize = 3;

/// Where staged stamp `i` lives: the ramp of a lane the entry doesn't use.
const STAMP_SLOTS: [usize; STAMPS] = [RUNTIME, wire::LANE_DUCK as usize, wire::LANE_AUTOMATION as usize];

/// One staged stamp: lane `lane` retargets to `gain` over `frames` at sample `at` (1..=127) of the
/// quantum. Stored bit for bit in a spare [`Ramp`] (`value` the gain, `remaining` the frames,
/// `step`'s bits `at | lane << 16`), so the entry keeps its 128 B.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stamp {
    pub lane: u16,
    pub at: u16,
    pub gain: f32,
    pub frames: u32,
}

impl Stamp {
    fn to_ramp(self) -> Ramp {
        Ramp { value: self.gain, target: 0.0, step: f32::from_bits(self.at as u32 | (self.lane as u32) << 16), remaining: self.frames }
    }

    fn of_ramp(r: &Ramp) -> Stamp {
        let packed = r.step.to_bits();
        Stamp { lane: (packed >> 16) as u16, at: packed as u16, gain: r.value, frames: r.remaining }
    }
}

impl BusLanes {
    /// Lane `k`'s ramp as it applies: its stored ramp while its bit is set, else a settled 1.
    #[inline]
    pub fn lane(&self, k: usize) -> Ramp {
        if self.moving & (1 << k) != 0 {
            self.lanes[k]
        } else {
            Ramp::at(1.0)
        }
    }

    /// The ramps of lanes 0, 2, 3, 4 that aren't at identity, in the order they multiply.
    pub fn moving_lanes(&self) -> impl Iterator<Item = &Ramp> {
        ENTRY_LANES.iter().filter(move |&&k| self.moving & (1 << k) != 0).map(move |&k| &self.lanes[k])
    }

    /// The stamps staged on this entry, in the order they were staged (frame order).
    pub fn stamps(&self) -> impl Iterator<Item = Stamp> + '_ {
        STAMP_SLOTS[..(self.staged as usize).min(STAMPS)].iter().map(move |&k| Stamp::of_ramp(&self.lanes[k]))
    }

    /// Clears the bit of every lane that has come to rest at 1.
    #[inline]
    fn rest(&mut self) {
        for k in ENTRY_LANES {
            if self.moving & (1 << k) != 0 && self.lanes[k].is_unity() {
                self.moving &= !(1 << k);
            }
        }
    }
}

/// Stages stamp `stamp` (lane 0–4, `at` in 1..=127) on `lanes` for quantum `quantum` (its first
/// frame / 128): after the stamps already staged, so one lane's apply in the order staged (the
/// pending queue pops in frame order). Stamps left from another quantum are dropped first (never
/// after `Core::process`, which consumes them in its own quantum). `false` (no change) when
/// [`STAMPS`] are staged.
pub fn stage(lanes: &mut BusLanes, stamp: Stamp, quantum: u32) -> bool {
    if lanes.staged_quantum != quantum {
        lanes.staged = 0;
        lanes.staged_quantum = quantum;
    }
    let n = lanes.staged as usize;
    if n >= STAMPS {
        return false;
    }
    lanes.lanes[STAMP_SLOTS[n]] = stamp.to_ramp();
    lanes.staged += 1;
    true
}

/// Bytes of one [`BusLanes`] entry, rounded to a cache line (128 B: 7 × 16 B ramps + 16 B).
pub const BUS_LANES_BYTES: usize = (core::mem::size_of::<BusLanes>() + crate::layout::REGION_ALIGN - 1) / crate::layout::REGION_ALIGN * crate::layout::REGION_ALIGN;

const _: () = assert!(core::mem::align_of::<BusLanes>() <= crate::layout::REGION_ALIGN);
const _: () = assert!(BUS_LANES_BYTES == core::mem::size_of::<BusLanes>(), "the slice stride is the entry size");

/// The `Lanes` region (ARCH §6): one [`BusLanes`] per core bus slot (`max_buses`), then one more
/// for the output gain (`BUS_MASTER_OUT`, [`master_entry`]): 33 × 128 B = 4,224 B at 32 buses.
pub fn region_bytes(p: &crate::params::InitParams) -> usize {
    (p.max_buses as usize + 1) * BUS_LANES_BYTES
}

/// The lane entries of the `Lanes` region: `max_buses` bus entries, then the output's.
pub fn entries(region: &mut [u8]) -> &mut [BusLanes] {
    let n = region.len() / BUS_LANES_BYTES;
    // SAFETY: the region is 64-byte aligned (Layout) and zeroed at init; all-zero is a valid
    // BusLanes (floats and integers). BUS_LANES_BYTES >= size_of::<BusLanes>() and is a multiple
    // of REGION_ALIGN (and equal to it, asserted), so each entry is aligned and inside the region.
    unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut BusLanes, n) }
}

/// The lane entries, read-only (as [`entries`]).
pub fn entries_ref(region: &[u8]) -> &[BusLanes] {
    let n = region.len() / BUS_LANES_BYTES;
    // SAFETY: as in `entries`.
    unsafe { core::slice::from_raw_parts(region.as_ptr() as *const BusLanes, n) }
}

/// Bus `bus`'s lane entry (`None` past the region).
pub fn entry(region: &mut [u8], bus: usize) -> Option<&mut BusLanes> {
    let n = entries(region).len();
    // The last entry is the output's, not a bus's.
    if bus + 1 >= n {
        return None;
    }
    entries(region).get_mut(bus)
}

/// The output gain's lane entry: the region's last.
pub fn master_entry(region: &mut [u8]) -> Option<&mut BusLanes> {
    entries(region).last_mut()
}

/// Sets every lane of `entry` to a settled 1 (a `fresh` slot, `bus_slots::on_slot`; `init`).
/// The slot's own runtime lane and low-pass are reset with the slot (`bus::fresh`).
pub fn reset_unity(entry: &mut BusLanes) {
    *entry = BusLanes { lanes: [Ramp::at(1.0); LANES], ..BusLanes::default() };
}

/// Sets every lane of every entry to unity (`Core::new`, once).
pub fn init(core: &mut Core) {
    for e in entries(&mut core.regions_mut().lanes[..]) {
        reset_unity(e);
    }
}

/// What [`apply`] multiplied the bus by this quantum: the post-fader send (`sends::feed`, Rv1)
/// scales the reverb scratch by the same gain, and skips the multiply on [`Gain::Unity`] (R11's
/// bit-identity).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gain {
    /// Every lane at identity: nothing was multiplied (the samples are untouched, bit for bit).
    Unity,
    /// One scalar for the whole quantum (§4.5 step 1: every lane settled).
    Scalar(f32),
    /// A per-frame gain, written into [`apply`]'s `curve` (§4.5 step 2): the product, frame by
    /// frame, of the factors applied (the main-written lanes' product, then duck, then
    /// automation), each rounded as applied.
    Curve,
}

/// The main-written lanes' product (runtime, then lanes 0, 2, 3, 4) for the coming quantum,
/// without advancing anything: `Unity`, a scalar, or a curve written into `out`. The same values
/// [`apply`] multiplies by (`chain.rs` reads a bus's own factor through it).
pub fn product(lanes: &BusLanes, runtime: &Ramp, out: &mut [f32; QUANTUM]) -> Gain {
    let (mut l, mut r) = (*lanes, *runtime);
    product_advance(&mut l, &mut r, out)
}

/// As [`product`], advancing the ramps one quantum.
fn product_advance(lanes: &mut BusLanes, runtime: &mut Ramp, out: &mut [f32; QUANTUM]) -> Gain {
    if lanes.staged != 0 {
        return product_stamped(lanes, runtime, out);
    }
    let runtime_on = !runtime.is_unity();
    let others = lanes.moving & ENTRY_LANES.iter().fold(0, |m, &k| m | 1 << k);
    if !runtime_on && others == 0 {
        return Gain::Unity;
    }
    let settled = runtime.is_settled() && ENTRY_LANES.iter().all(|&k| others & (1 << k) == 0 || lanes.lanes[k].is_settled());
    if settled {
        // §4.5 step 1: one scalar. A lone lane's is its value exactly.
        let mut g: Option<f32> = runtime_on.then_some(runtime.value);
        for k in ENTRY_LANES {
            if others & (1 << k) != 0 {
                let v = lanes.lanes[k].value;
                g = Some(g.map_or(v, |g| g * v));
            }
        }
        lanes.rest();
        return match g {
            Some(g) if g != 1.0 => Gain::Scalar(g),
            _ => Gain::Unity,
        };
    }
    // §4.5 step 2: the curve, the first lane written as `Ramp::next` gives it (R3), each further
    // lane multiplied in.
    let mut first = true;
    let mut lane_in = |ramp: &mut Ramp, out: &mut [f32; QUANTUM]| {
        if first {
            first = false;
            if ramp.is_settled() {
                out.fill(ramp.value);
            } else {
                for x in out.iter_mut() {
                    *x = ramp.next();
                }
            }
        } else if ramp.is_settled() {
            let v = ramp.value;
            for x in out.iter_mut() {
                *x *= v;
            }
        } else {
            for x in out.iter_mut() {
                *x *= ramp.next();
            }
        }
    };
    if runtime_on {
        lane_in(runtime, out);
    }
    for k in ENTRY_LANES {
        if others & (1 << k) != 0 {
            lane_in(&mut lanes.lanes[k], out);
        }
    }
    lanes.rest();
    Gain::Curve
}

/// Frames `from..to` of one lane into `out`: written (`write`, the curve's first lane) or
/// multiplied in; a settled lane as its value (the hold segments), a moving one through
/// `Ramp::next` (the ramp segment, the same arithmetic as an asap ramp's).
#[inline]
fn segment(ramp: &mut Ramp, out: &mut [f32; QUANTUM], from: usize, to: usize, write: bool) {
    let out = &mut out[from..to];
    match (write, ramp.is_settled()) {
        (true, true) => out.fill(ramp.value),
        (false, true) => {
            let v = ramp.value;
            for x in out.iter_mut() {
                *x *= v;
            }
        }
        (true, false) => {
            for x in out.iter_mut() {
                *x = ramp.next();
            }
        }
        (false, false) => {
            for x in out.iter_mut() {
                *x *= ramp.next();
            }
        }
    }
}

/// §4.5 step 2 with stamps staged this quantum (class B, R6): the curve in the order of the plain
/// path (the runtime lane, then lanes 0, 2, 3, 4), each lane in segments split at its stamps'
/// samples: up to a stamp the lane keeps its motion (hold, or the ramp it was on), at the stamp it
/// retargets from its value there (`Ramp::set_target`, so a retarget never jumps), and so on in
/// the order staged. A lane at identity with no stamp is skipped. Consumes the stamps.
fn product_stamped(lanes: &mut BusLanes, runtime: &mut Ramp, out: &mut [f32; QUANTUM]) -> Gain {
    let mut stamps = [Stamp::default(); STAMPS];
    let n = (lanes.staged as usize).min(STAMPS);
    for (i, s) in lanes.stamps().enumerate() {
        stamps[i] = s;
    }
    lanes.staged = 0;
    let stamps = &stamps[..n];
    let mut first = true;
    for k in core::iter::once(RUNTIME).chain(ENTRY_LANES) {
        let stamped = stamps.iter().any(|s| s.lane as usize == k);
        let bit = 1u32 << k;
        let on = if k == RUNTIME { !runtime.is_unity() } else { lanes.moving & bit != 0 };
        if !on && !stamped {
            continue;
        }
        let ramp = if k == RUNTIME {
            &mut *runtime
        } else {
            if !on {
                // A clear bit is a lane at 1, whatever its stored ramp holds.
                lanes.lanes[k] = Ramp::at(1.0);
            }
            &mut lanes.lanes[k]
        };
        let mut from = 0;
        for s in stamps.iter().filter(|s| s.lane as usize == k) {
            let at = (s.at as usize).clamp(from, QUANTUM);
            segment(ramp, out, from, at, first);
            ramp.set_target(s.gain, s.frames);
            from = at;
        }
        segment(ramp, out, from, QUANTUM, first);
        first = false;
        if k != RUNTIME {
            if lanes.lanes[k].is_unity() {
                lanes.moving &= !bit;
            } else {
                lanes.moving |= bit;
            }
        }
    }
    if first {
        // Only stamps on lanes this curve doesn't take (never staged: `on_due` checks the lane).
        return product_advance(lanes, runtime, out);
    }
    Gain::Curve
}

/// Multiplies `l`, `r` by what `product_advance` gave: nothing at unity, the scalar, or the curve.
#[inline]
fn multiply(gain: Gain, curve: &[f32; QUANTUM], l: &mut [f32], r: &mut [f32]) {
    match gain {
        Gain::Unity => {}
        Gain::Scalar(g) => {
            for x in l.iter_mut().chain(r.iter_mut()) {
                *x *= g;
            }
        }
        Gain::Curve => {
            for i in 0..QUANTUM {
                let g = curve[i];
                l[i] *= g;
                r[i] *= g;
            }
        }
    }
}

/// The gain stage of one bus (`bus::mixdown`, after the pre-fader tap `duck::detect`, before the
/// meter and the loudness tap): multiplies `l`, `r` (one quantum each) by the bus's lanes.
/// - `lanes`: the bus's lane entry (lanes 0, 2, 3, 4).
/// - `ramp`: the bus's runtime lane (`BusSlot::gain`); it advances one quantum.
/// - `auto`: the bus's automation entry when it has bindings (ADR 0158; its `gainMul` applies only
///   with `has::GAIN`): the `automation` lane.
/// - `duck`: the `duck` lane's curve for the quantum when `duck::gain` returned `true`, else
///   `None` (skipped, not multiplied by 1.0, R3).
/// - `curve`: written only when the result is [`Gain::Curve`].
///
/// Returns what was applied.
pub fn apply(lanes: &mut BusLanes, ramp: &mut Ramp, auto: Option<&BusAuto>, duck: Option<&[f32; QUANTUM]>, l: &mut [f32], r: &mut [f32], curve: &mut [f32; QUANTUM]) -> Gain {
    let auto = auto.filter(|a| a.targets & automation::has::GAIN != 0);
    let mut gain = product_advance(lanes, ramp, curve);
    multiply(gain, curve, l, r);
    if let Some(d) = duck {
        // The duck lane (Dp1, Sc1): only when it moves or sits below 1.
        gain = to_curve(gain, curve);
        for i in 0..QUANTUM {
            let g = d[i];
            l[i] *= g;
            r[i] *= g;
            curve[i] *= g;
        }
    }
    if let Some(a) = auto {
        // ADR 0158 §3: the automation lane, on top of the main-written lanes, ramped across the
        // quantum.
        gain = to_curve(gain, curve);
        for i in 0..QUANTUM {
            let g = a.gain_at(i);
            l[i] *= g;
            r[i] *= g;
            curve[i] *= g;
        }
    }
    gain
}

/// `gain` as a per-frame curve in `curve` (unchanged when it is one already).
fn to_curve(gain: Gain, curve: &mut [f32; QUANTUM]) -> Gain {
    match gain {
        Gain::Unity => curve.fill(1.0),
        Gain::Scalar(g) => curve.fill(g),
        Gain::Curve => {}
    }
    Gain::Curve
}

/// The output gain on the summed output, after the shared reverb's return and before the
/// limiter: MASTER's ramp (the output's runtime lane) times the output's lanes 0, 2, 3, 4
/// (`lanes`, [`master_entry`]), set by `BUS_RAMP` on `BUS_MASTER_OUT`.
pub fn apply_master(lanes: &mut BusLanes, master: &mut Ramp, out_l: &mut [f32], out_r: &mut [f32]) {
    let mut curve = [0.0f32; QUANTUM];
    let gain = product_advance(lanes, master, &mut curve);
    multiply(gain, &curve, &mut out_l[..QUANTUM], &mut out_r[..QUANTUM]);
}

/// Settles every lane of `lanes` on its target (RESET, R12).
fn settle_lanes(lanes: &mut BusLanes) {
    for k in ENTRY_LANES {
        if lanes.moving & (1 << k) != 0 {
            lanes.lanes[k] = Ramp::at(lanes.lanes[k].target);
        }
    }
    lanes.rest();
}

/// RESET (R12): settles every lane of the bus on its target: the runtime lane (`slot.gain`), the
/// snapshot low-pass (`slot.lp`) and lanes 0, 2, 3, 4 of `lanes`.
pub fn settle(lanes: &mut BusLanes, slot: &mut BusSlot) {
    slot.gain = Ramp::at(slot.gain.target);
    slot.lp = Ramp::at(slot.lp.target);
    settle_lanes(lanes);
}

/// RESET: settles the output gain on its target (MASTER's ramp and the output's lanes).
pub fn settle_master(lanes: &mut BusLanes, master: &mut Ramp) {
    *master = Ramp::at(master.target);
    settle_lanes(lanes);
}

/// Points lane `lane` (0-4) at `gain` over `frames` from its current value (`Ramp::set_target`,
/// R3), and the snapshot low-pass at `lp_hz` when given. `runtime` is the bus's (or MASTER's)
/// ramp, `lp` the slot's low-pass ramp (`None` for the output). Callers have validated the values.
fn set_lane(lanes: &mut BusLanes, runtime: &mut Ramp, lp: Option<&mut Ramp>, lane: usize, gain: Option<f32>, lp_hz: Option<f32>, frames: u32) {
    if let Some(g) = gain {
        if lane == RUNTIME {
            runtime.set_target(g, frames);
        } else {
            let bit = 1u32 << lane;
            if lanes.moving & bit == 0 {
                // A clear bit is a lane at 1, whatever its stored ramp holds.
                lanes.lanes[lane] = Ramp::at(1.0);
            }
            lanes.lanes[lane].set_target(g, frames);
            if lanes.lanes[lane].is_unity() {
                lanes.moving &= !bit;
            } else {
                lanes.moving |= bit;
            }
        }
    }
    if let (Some(hz), Some(lp)) = (lp_hz, lp) {
        // An unchanged target leaves a running low-pass ramp alone (as BUS_MIX did before M5).
        if hz != lp.target {
            lp.set_target(hz, frames);
        }
    }
}

/// `true` when a `BUS_RAMP` record (0x18, 32 B, API §4.2) at `msg[off..off + len]` is well formed
/// (pass 1 of `scheduler::submit`, after its length check: `len >= BusRamp::FIXED_END`). Every
/// field is checked at apply: a bad lane, slot or value is ignored (and counted), never refused
/// (API §4.2).
pub fn ramp_is_well_formed(_msg: &[u8], _off: usize, _len: usize) -> bool {
    true
}

/// `BUS_RAMP` (0x18, API §4.2, ARCH §4.5): one lane's target for one bus slot (or
/// `BUS_MASTER_OUT`), ramped linearly over `frames` from the lane's current value (`frames` 0 is a
/// step). `mask` bit 0 sets the gain (clamped to `0..=4`; a non-finite value leaves the target),
/// bit 1 the low-pass (lane 2 of a bus only: clamped to `10..=24,000`; a non-finite value leaves
/// the target; an unchanged one leaves a running low-pass ramp alone, as BUS_MIX did).
///
/// Ignored and counted (`MixCounters::lane_records_ignored`): lanes 5 (`duck`) and 6
/// (`automation`), which the core owns, an unknown lane, a slot past the configured buses.
///
/// `at`: `None` asap, applied now (between quanta: the ramp starts with the next quantum). A
/// stamped record is queued by the scheduler and reaches [`on_due`] instead; one that reaches here
/// with `Some(frame)` (the pending queue was full) applies at once and counts `busRecordsEarly`.
pub fn on_ramp(core: &mut Core, msg: &[u8], off: usize, at: Option<u64>) {
    let Ok((rec, _)) = wire::BusRamp::read(msg, off) else { return };
    if at.is_some() {
        crate::status::counters_mut(core).mix.note_bus_record_early();
    }
    apply_ramp(core, &rec, None);
}

/// A stamped `BUS_RAMP` as a pending record (the scheduler's queue and the due list): `voice_id`
/// the bus slot, `flags` the lane (255 for any lane past it: ignored at apply), `mask` the
/// record's mask, `values` = `[gain, lpHz, shape bits]`, `frames` its frames. The caller sets
/// `frame`. `scheduler::shape_word` reads the shape back (and `due::sequence_of` its
/// `sequenceId`).
pub fn pending(rec: &wire::BusRamp) -> crate::scheduler::PendingRecord {
    crate::scheduler::PendingRecord {
        frame: 0,
        voice_id: rec.voice_id,
        op: wire::op::BUS_RAMP as u8,
        mask: rec.mask.min(255) as u8,
        flags: rec.lane.min(255) as u8,
        bus: 0,
        values: [rec.gain, rec.lp_hz, f32::from_bits(rec.shape), 0.0, 0.0, 0.0, 0.0],
        frames: rec.frames,
    }
}

/// [`pending`]'s inverse (the frame offset is the caller's business).
fn ramp_of_pending(r: &crate::scheduler::PendingRecord) -> wire::BusRamp {
    wire::BusRamp { voice_id: r.voice_id, frame_offset: wire::ASAP, lane: r.flags as u16, mask: r.mask as u16, gain: r.values[0], lp_hz: r.values[1], frames: r.frames, shape: r.values[2].to_bits() }
}

/// Class B (`due::route`, R6): the stamped `BUS_RAMP` `record`, due in the quantum at `frame`.
/// At the quantum's first sample (or late) it applies now, which is that sample: the gain stage
/// runs after every voice. Otherwise its gain is staged on its bus at its sample ([`stage`]) and
/// its low-pass target applies now (the snapshot low-pass ramps per quantum). With the bus's
/// stage slots full it applies now and counts `busRecordsEarly`, never splitting.
pub fn on_due(core: &mut Core, record: &crate::scheduler::PendingRecord, frame: u64) {
    let rec = ramp_of_pending(record);
    let at = crate::due::offset(record, frame);
    if at == 0 {
        apply_ramp(core, &rec, None);
    } else if !apply_ramp(core, &rec, Some((at as u16, (frame / QUANTUM as u64) as u32))) {
        crate::status::counters_mut(core).mix.note_bus_record_early();
    }
}

/// R6's overflow rule: a stamped `BUS_RAMP` that found the due list full applies at the quantum's
/// start (now: the gain stage runs after every voice) and counts `busRecordsEarly`.
pub fn apply_early(core: &mut Core, record: &crate::scheduler::PendingRecord) {
    crate::status::counters_mut(core).mix.note_bus_record_early();
    apply_ramp(core, &ramp_of_pending(record), None);
}

/// Applies `rec` (see [`on_ramp`] for the fields and what is ignored): now, or with `stage_at =
/// Some((sample, quantum))` its gain staged at that sample of that quantum. `false` only when the
/// gain should have been staged and the bus had no room: then it applied now instead.
fn apply_ramp(core: &mut Core, rec: &wire::BusRamp, stage_at: Option<(u16, u32)>) -> bool {
    let lane = rec.lane as usize;
    if lane > wire::LANE_LAST_MAIN_WRITTEN as usize {
        crate::status::counters_mut(core).mix.note_lane_record_ignored();
        return true;
    }
    let gain = (rec.mask & wire::BUS_RAMP_MASK_GAIN != 0 && rec.gain.is_finite()).then(|| rec.gain.clamp(0.0, MAX_LANE_GAIN));
    let lp_hz = (rec.mask & wire::BUS_RAMP_MASK_LP_HZ != 0 && lane == wire::LANE_SNAPSHOT as usize && rec.lp_hz.is_finite()).then(|| rec.lp_hz.clamp(MIN_LANE_LP_HZ, LP_OFF_HZ));
    let regions = core.regions_mut();
    let lanes: *mut [u8] = &mut regions.lanes[..];
    let v = bus::view(regions);
    // SAFETY: the lanes region is distinct from every region `v` views (Layout).
    let lanes = entries(unsafe { &mut *lanes });
    let count = (v.area.count as usize).min(v.slots.len());
    let bus = rec.voice_id as usize;
    let (entry, runtime, lp) = if rec.voice_id == wire::BUS_MASTER_OUT {
        match lanes.last_mut() {
            Some(e) => (e, &mut v.area.master, None),
            None => {
                crate::status::counters_mut(core).mix.note_lane_record_ignored();
                return true;
            }
        }
    } else if bus < count && bus + 1 < lanes.len() {
        let slot = &mut v.slots[bus];
        (&mut lanes[bus], &mut slot.gain, Some(&mut slot.lp))
    } else {
        crate::status::counters_mut(core).mix.note_lane_record_ignored();
        return true;
    };
    let lp_hz = lp_hz.filter(|_| lp.is_some());
    let mut staged = true;
    let gain_now = match (gain, stage_at) {
        (Some(g), Some((at, quantum))) => {
            staged = stage(entry, Stamp { lane: lane as u16, at, gain: g, frames: rec.frames }, quantum);
            (!staged).then_some(g)
        }
        (g, _) => g,
    };
    set_lane(entry, runtime, lp, lane, gain_now, lp_hz, rec.frames);
    staged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(gain: Ramp) -> BusSlot {
        // SAFETY: all-zero is a valid BusSlot (bus.rs).
        let mut s: BusSlot = unsafe { core::mem::zeroed() };
        s.gain = gain;
        s
    }

    #[test]
    fn a_settled_unity_bus_is_untouched_and_reports_unity() {
        let mut s = slot(Ramp::at(1.0));
        let (mut l, mut r) = ([0.3f32; QUANTUM], [-0.7f32; QUANTUM]);
        let mut curve = [f32::NAN; QUANTUM];
        assert_eq!(apply(&mut BusLanes::default(), &mut s.gain, None, None, &mut l, &mut r, &mut curve), Gain::Unity);
        assert_eq!((l, r), ([0.3; QUANTUM], [-0.7; QUANTUM]));
        assert!(curve.iter().all(|c| c.is_nan()), "no curve is written at unity");
    }

    #[test]
    fn a_skipped_duck_lane_differs_from_multiplying_by_one_never_and_a_moving_one_applies() {
        let mut s = slot(Ramp::at(0.5));
        let (mut l, mut r) = ([0.3f32; QUANTUM], [0.2f32; QUANTUM]);
        let mut curve = [0.0; QUANTUM];
        assert_eq!(apply(&mut BusLanes::default(), &mut s.gain, None, None, &mut l, &mut r, &mut curve), Gain::Scalar(0.5));
        assert_eq!(l[0], 0.3 * 0.5);
        let duck = [0.25f32; QUANTUM];
        let (mut l, mut r) = ([0.3f32; QUANTUM], [0.2f32; QUANTUM]);
        assert_eq!(apply(&mut BusLanes::default(), &mut s.gain, None, Some(&duck), &mut l, &mut r, &mut curve), Gain::Curve);
        assert_eq!((l[7], r[7], curve[7]), (0.3 * 0.5 * 0.25, 0.2 * 0.5 * 0.25, 0.5 * 0.25));
    }

    #[test]
    fn a_ramp_writes_the_curve_it_applied() {
        let mut s = slot(Ramp::at(0.0));
        s.gain.set_target(1.0, 256);
        let mut copy = s.gain;
        let (mut l, mut r) = ([1.0f32; QUANTUM], [1.0f32; QUANTUM]);
        let mut curve = [0.0; QUANTUM];
        assert_eq!(apply(&mut BusLanes::default(), &mut s.gain, None, None, &mut l, &mut r, &mut curve), Gain::Curve);
        for i in 0..QUANTUM {
            let g = copy.next();
            assert_eq!((l[i], curve[i]), (g, g));
        }
    }

    #[test]
    fn settle_lands_every_ramp_on_its_target() {
        let mut s = slot(Ramp::at(1.0));
        s.gain.set_target(0.25, 1000);
        s.lp = Ramp::at(LP_OFF_HZ);
        s.lp.set_target(500.0, 1000);
        let mut lanes = BusLanes::default();
        set_lane(&mut lanes, &mut s.gain, None, 3, Some(0.0), None, 1000);
        set_lane(&mut lanes, &mut s.gain, None, 4, Some(1.0), None, 0);
        settle(&mut lanes, &mut s);
        assert!(s.gain.is_settled() && s.lp.is_settled());
        assert_eq!((s.gain.value, s.lp.value), (0.25, 500.0));
        assert_eq!(lanes.moving, 1 << 3);
        assert_eq!(lanes.lane(3), Ramp::at(0.0));
        let mut m = Ramp::at(1.0);
        m.set_target(0.5, 99);
        settle_master(&mut BusLanes::default(), &mut m);
        assert_eq!((m.value, m.is_settled()), (0.5, true));
    }

    #[test]
    fn a_lane_that_returns_to_one_clears_its_bit_and_is_skipped_again() {
        let mut lanes = BusLanes::default();
        let mut rt = Ramp::at(1.0);
        set_lane(&mut lanes, &mut rt, None, 0, Some(0.5), None, 64);
        set_lane(&mut lanes, &mut rt, None, 0, Some(1.0), None, 64);
        assert_eq!(lanes.moving, 1);
        let mut curve = [0.0; QUANTUM];
        let (mut l, mut r) = ([0.1f32; QUANTUM], [0.1f32; QUANTUM]);
        assert_eq!(apply(&mut lanes, &mut rt, None, None, &mut l, &mut r, &mut curve), Gain::Curve);
        assert_eq!(lanes.moving, 0, "settled at 1: the bit clears");
        assert_eq!(apply(&mut lanes, &mut rt, None, None, &mut l, &mut r, &mut curve), Gain::Unity);
    }
}
