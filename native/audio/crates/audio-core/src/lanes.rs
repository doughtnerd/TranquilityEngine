//! A bus's gain lanes (ADR 0171 amended by 0172 §1.3; architecture §4.5, R1, R2, R3, R6).
//!
//! **Design.** A bus's gain is the per-sample product of seven lanes: `authored`, `runtime`,
//! `snapshot`, `monitor`, `dip` (written by main through `BUS_RAMP`), `duck` and `automation`
//! (owned by the core). A lane that isn't moving costs nothing; lanes at identity are **skipped,
//! not multiplied by 1.0** (R3), and an asap `BUS_RAMP` on a lone lane uses `Ramp::next`'s
//! arithmetic, so every bus golden keeps its digest.
//!
//! **Today (K1, M5-0 wave 1).** The module holds the gain stage exactly as `bus.rs` had it before
//! M5, moved verbatim so every digest is bit-identical:
//! - one ramp per bus (`BusSlot::gain`), set by BUS_MIX ([`mix`], moved here from `bus.rs`) with
//!   the snapshot low-pass cut-off (`BusSlot::lp`, the `snapshot` lane's low-pass);
//! - automation's `gainMul` (ADR 0158 §3) multiplied after it ([`apply`]);
//! - the `duck` lane's curve from `duck::gain`, multiplied only when `duck::gain` says it moves
//!   (never, until Dp1);
//! - the output gain (MASTER, [`apply_master`]) and RESET's settle ([`settle`], [`settle_master`]).
//!
//! **Who fills what.** B1a (W2): the seven-lane state (the `Lanes` region, K1 stage B), `BUS_RAMP`
//! ([`on_ramp`]) on a lone lane with `Ramp::next` arithmetic, the output gain through
//! `BUS_MASTER_OUT`, BUS_MIX removed (R0), RESET settling every lane on its target. B1b (W3):
//! class B, stamped ramps from the due list with start-sample segments (§4.5 steps 1–2), the
//! overflow rule (`busRecordsEarly`). `chain.rs` reads a bus's gain only through [`gain_ramp`].
//!
//! Nothing here allocates; [`apply`] runs once per bus per quantum inside `process`.

use audio_dsp::ramp::Ramp;
use audio_wire::generated::{self as wire, BusMixBuses};

use crate::automation::{self, BusAuto};
use crate::bus::{self, BusSlot, LP_OFF_HZ};
use crate::core::Core;
use crate::wire_read::u32_at;
use crate::QUANTUM;

/// Lanes per bus (R1): `authored`, `runtime`, `snapshot`, `monitor`, `dip`, `duck`, `automation`.
/// The wire's `LANE_*` ids index them.
pub const LANES: usize = wire::LANE_COUNT as usize;

/// One bus's lane state in the `Lanes` region (K1 stage B lays it out; B1a fills it). `#[repr(C)]`,
/// all-zero valid (lanes at 0: [`init`] sets them to unity). B1a may change the fields: the
/// region is sized from this type ([`BUS_LANES_BYTES`]), so `layout.rs` doesn't change.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BusLanes {
    /// One ramp per lane, indexed by the wire's `LANE_*` (lanes 5 and 6 are the core's: the duck
    /// and automation lanes keep their own state in `duck.rs` and `automation.rs`; their entries
    /// here are free for B1a).
    pub lanes: [Ramp; LANES],
    /// Bit `k` set while lane `k` isn't settled at 1 (B1a: the "every lane settled" test of §4.5
    /// step 1).
    pub moving: u32,
    pub _reserved: [u32; 3],
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

/// Bus `bus`'s lane entry (`None` past the region).
pub fn entry(region: &mut [u8], bus: usize) -> Option<&mut BusLanes> {
    entries(region).get_mut(bus)
}

/// The output gain's lane entry: the region's last.
pub fn master_entry(region: &mut [u8]) -> Option<&mut BusLanes> {
    entries(region).last_mut()
}

/// Sets every lane of every entry to unity (`Core::new`, once). K1: the state isn't read yet;
/// B1a reads it.
pub fn init(core: &mut Core) {
    for e in entries(&mut core.regions_mut().lanes[..]) {
        e.lanes = [Ramp::at(1.0); LANES];
        e.moving = 0;
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
    /// A per-frame gain, written into [`apply`]'s `curve` (§4.5 step 2). K1: the product, frame by
    /// frame, of the factors applied (ramp, then duck, then automation), each rounded as applied.
    Curve,
}

/// The bus's gain ramp, for readers outside the gain stage (`chain.rs`'s chain gain for voice
/// sends and the bed fold). K1: BUS_MIX's ramp. B1a: returns or composes the lane product the
/// chain reads (keeping `chain.rs`'s accessor), so sends and beds follow the lanes bit for bit.
#[inline]
pub fn gain_ramp(slot: &BusSlot) -> &Ramp {
    &slot.gain
}

/// The gain stage of one bus (`bus::mixdown`, after the pre-fader tap `duck::detect`, before the
/// meter and the loudness tap): multiplies `l`, `r` (one quantum each) by the bus's lanes.
/// - `lanes`: the bus's lane entry (K1: not read; B1a: the seven-lane state).
/// - `ramp`: the bus's gain ramp (`BusSlot::gain`, BUS_MIX's); it advances one quantum. (The slot's
///   buffer holds `l`, `r`, so the stage takes the ramp, not the slot.)
/// - `auto`: the bus's automation entry when it has bindings (ADR 0158; its `gainMul` applies only
///   with `has::GAIN`).
/// - `duck`: the `duck` lane's curve for the quantum when `duck::gain` returned `true`, else
///   `None` (skipped, not multiplied by 1.0, R3).
/// - `curve`: written only when the result is [`Gain::Curve`].
///
/// Returns what was applied. K1: today's code, verbatim (the ramp, then automation), with the duck
/// curve between them; B1a replaces the single ramp with the seven-lane product, keeping this
/// signature and the bit-identity of a lone lane.
pub fn apply(lanes: &mut BusLanes, ramp: &mut Ramp, auto: Option<&BusAuto>, duck: Option<&[f32; QUANTUM]>, l: &mut [f32], r: &mut [f32], curve: &mut [f32; QUANTUM]) -> Gain {
    let _ = lanes;
    let auto = auto.filter(|a| a.targets & automation::has::GAIN != 0);
    let mut gain = if ramp.is_settled() {
        let g = ramp.value;
        if g != 1.0 {
            for x in l.iter_mut().chain(r.iter_mut()) {
                *x *= g;
            }
            Gain::Scalar(g)
        } else {
            Gain::Unity
        }
    } else {
        for i in 0..QUANTUM {
            let g = ramp.next();
            l[i] *= g;
            r[i] *= g;
            curve[i] = g;
        }
        Gain::Curve
    };
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
        // ADR 0158 §3: bus automation's gain on top of BUS_MIX's, ramped across the quantum.
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

/// The output gain (MASTER; B1a: `BUS_MASTER_OUT`'s lane) on the summed output, after the shared
/// reverb's return and before the limiter. `lanes` is the output's entry ([`master_entry`]; K1:
/// not read). K1: today's code, verbatim.
pub fn apply_master(lanes: &mut BusLanes, master: &mut Ramp, out_l: &mut [f32], out_r: &mut [f32]) {
    let _ = lanes;
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
}

/// RESET (R12): settles the bus's ramps on their targets. K1: the gain and the snapshot low-pass;
/// B1a: every lane of `lanes`, on its target.
pub fn settle(lanes: &mut BusLanes, slot: &mut BusSlot) {
    let _ = lanes;
    slot.gain = Ramp::at(slot.gain.target);
    slot.lp = Ramp::at(slot.lp.target);
}

/// RESET: settles the output gain on its target (`lanes`: the output's entry; B1a settles it).
pub fn settle_master(lanes: &mut BusLanes, master: &mut Ramp) {
    let _ = lanes;
    *master = Ramp::at(master.target);
}

/// `true` when the BUS_MIX record at `msg[off..off + len]` holds its `busCount` entries.
/// (BUS_MIX is retired by R0 once every caller sends `BUS_RAMP`.)
pub fn mix_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::BusMix::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 12) as usize;
    n.checked_mul(BusMixBuses::FIXED_END).is_some_and(|bytes| wire::BusMix::FIXED_END + bytes <= len)
}

/// BUS_MIX: sets each configured bus's gain and cut-off targets from the (well-formed) record at
/// `msg[off..]`, ramped over its `rampFrames`. Entries past the configured buses are dropped and
/// counted; buses past the record's entries keep their targets. (Moved verbatim from `bus.rs`.)
pub fn mix(core: &mut Core, msg: &[u8], off: usize) {
    let n = u32_at(msg, off + 12) as usize;
    let ramp = u32_at(msg, off + 16);
    let v = bus::view(core.regions_mut());
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

/// `true` when a `BUS_RAMP` record (0x18, 32 B, API §4.2) at `msg[off..off + len]` is well formed
/// (pass 1 of `scheduler::submit`, after its length check: `len >= BusRamp::FIXED_END`). K1: `true`;
/// B1a adds any field checks (a bad field is ignored and counted at apply, not refused, API §4.2).
pub fn ramp_is_well_formed(_msg: &[u8], _off: usize, _len: usize) -> bool {
    true
}

/// `BUS_RAMP` (0x18, API §4.2, ARCH §4.5): one lane's target for one bus slot (or
/// `BUS_MASTER_OUT`), ramped linearly over `frames` from the lane's value at its start frame
/// (`at`: `None` asap, `Some(frame)` stamped). Lanes 5 (`duck`) and 6 (`automation`) are the
/// core's: a record naming them is ignored and counted. K1: a stub that ignores the record and
/// counts nothing; B1a fills the asap path (R3), B1b the stamped path through the due list (class
/// B, R6).
pub fn on_ramp(_core: &mut Core, _msg: &[u8], _off: usize, _at: Option<u64>) {}

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
        settle(&mut BusLanes::default(), &mut s);
        assert!(s.gain.is_settled() && s.lp.is_settled());
        assert_eq!((s.gain.value, s.lp.value), (0.25, 500.0));
        let mut m = Ramp::at(1.0);
        m.set_target(0.5, 99);
        settle_master(&mut BusLanes::default(), &mut m);
        assert_eq!((m.value, m.is_settled()), (0.5, true));
    }
}
