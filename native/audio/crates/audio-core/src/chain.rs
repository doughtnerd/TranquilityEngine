//! The bus-chain gain to the root (ADR 0162, api-and-models §4.4 and §5.1 build-plan additions;
//! architecture §3.3, §4.3): the product of each bus's main-written gain lanes (0171/0172 M5 §4.5:
//! `runtime`, then `authored`, `snapshot`, `monitor`, `dip`, as `lanes::product` gives them; before
//! M5 the one BUS_MIX gain, which the `runtime` lane is) and its automation `gainMul`, along a
//! bus's path to the root. The bed's gain fold (A4) and the voice sends (C4) both use it, so a send
//! follows a ducked or muted bus exactly as the dry path does. MASTER is not part of it: it applies
//! to the whole output after the tree. (The `duck` lane joins it when `duck::gain` stops being
//! identity, Dp1.) A bus with one lane moving reads exactly what it read before M5.
//!
//! Call these **before** `bus::mixdown` in the quantum (they read the ramps where mixdown will start
//! them, and never advance them). Two forms:
//! - [`fill`]: the gain at every frame of the quantum, the same per-frame values `mixdown` applies
//!   (each bus's ramp stepped as `Ramp::next` steps it, times `gainMul` ramped as
//!   `automation::ramp_at`), so a signal scaled by it matches the tree's own path to float rounding;
//! - [`ends`]: the gain at the quantum's first and last frame, for a straight-line ramp between them
//!   (architecture §4.3's `fold0`/`fold1`). Cheaper, but a bus ramp that ends inside the quantum makes
//!   the line miss the knee; use `fill` where that matters.
//!
//! Both take `until`: the walk stops before that bus (the bed's host, excluded from its fold), or at
//! the root when `None`. A bus index past the configured buses is bus 0, as the voices route it.
//! Nothing allocates; the walk is at most `max_buses` steps (the tree is repaired to be acyclic).

use audio_dsp::ramp::Ramp;

use crate::automation::{self, BusAuto};
use crate::bus::{self, BusSlot, ROOT};
use crate::core::Core;
use crate::lanes::{self, BusLanes, Gain};
use crate::QUANTUM;

/// The ramp's value at the quantum's first and last frame, as `Ramp::next` would give them.
fn ramp_ends(r: &Ramp) -> (f32, f32) {
    if r.is_settled() {
        return (r.value, r.value);
    }
    let first = if r.remaining == 1 { r.target } else { r.value + r.step };
    let last = if r.remaining as usize <= QUANTUM { r.target } else { r.value + r.step * QUANTUM as f32 };
    (first, last)
}

/// The path from `bus` towards the root, stopping before `until`: calls `f(slot, lanes, auto)` per
/// bus (`lanes`: its lane entry, all-unity when the region has none for it).
fn walk(core: &mut Core, bus: u16, until: Option<u16>, mut f: impl FnMut(&BusSlot, &BusLanes, Option<&BusAuto>)) {
    // The automation region's view needs `&mut`; it is a region of its own, distinct from the buses.
    let autos: Option<*const [BusAuto]> = automation::bus_entries(&mut core.regions_mut().automation[..]).map(|a| a as *const _);
    // SAFETY: `autos` views the automation region, which nothing else borrows during the walk.
    let autos: Option<&[BusAuto]> = autos.map(|a| unsafe { &*a });
    let lanes = lanes::entries_ref(&core.regions().lanes[..]);
    // The last entry is the output's.
    let lanes = &lanes[..lanes.len().saturating_sub(1)];
    let unity = BusLanes::default();
    let slots = bus::slots(core);
    let count = bus::count(core).min(slots.len());
    if count == 0 {
        return;
    }
    let mut b = if (bus as usize) < count { bus } else { 0 };
    for _ in 0..count {
        if Some(b) == until {
            return;
        }
        let slot = &slots[b as usize];
        let auto = autos.and_then(|a| a.get(b as usize)).filter(|a| a.count != 0 && a.targets & automation::has::GAIN != 0);
        f(slot, lanes.get(b as usize).unwrap_or(&unity), auto);
        if slot.parent == ROOT || slot.parent as usize >= count {
            return;
        }
        b = slot.parent;
    }
}

/// A bus's own lane product at every frame of the coming quantum: what `lanes::apply` multiplies
/// by before the duck and automation lanes (a lone lane: the values `Ramp::next` gives).
fn lane_frames(slot: &BusSlot, lanes: &BusLanes, out: &mut [f32; QUANTUM]) {
    match lanes::product(lanes, &slot.gain, out) {
        Gain::Unity => out.fill(1.0),
        Gain::Scalar(g) => out.fill(g),
        Gain::Curve => {}
    }
}

/// A bus's own lane product at the quantum's first and last frame: the runtime lane's ends, times
/// each other moving lane's (a lane at identity is skipped).
fn lane_ends(slot: &BusSlot, lanes: &BusLanes) -> (f32, f32) {
    let (mut a, mut b) = ramp_ends(&slot.gain);
    for r in lanes.moving_lanes() {
        let (x, y) = ramp_ends(r);
        a *= x;
        b *= y;
    }
    (a, b)
}

/// The chain gain of `bus` at every frame of the coming quantum (see the module comment).
pub fn fill(core: &mut Core, bus: u16, until: Option<u16>, out: &mut [f32; QUANTUM]) {
    out.fill(1.0);
    let mut own = [0.0f32; QUANTUM];
    walk(core, bus, until, |slot, lanes, auto| {
        lane_frames(slot, lanes, &mut own);
        for (j, x) in out.iter_mut().enumerate() {
            let g = own[j] * auto.map_or(1.0, |a| a.gain_at(j));
            *x *= g;
        }
    });
}

/// The chain gain of `bus` at the coming quantum's first and last frame (see the module comment).
pub fn ends(core: &mut Core, bus: u16, until: Option<u16>) -> (f32, f32) {
    let (mut g0, mut g1) = (1.0f32, 1.0f32);
    walk(core, bus, until, |slot, lanes, auto| {
        let (a, b) = lane_ends(slot, lanes);
        let (m0, m1) = auto.map_or((1.0, 1.0), |x| (x.gain_at(0), x.gain_at(QUANTUM - 1)));
        g0 *= a * m0;
        g1 *= b * m1;
    });
    (g0, g1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{Layout, PAGE_BYTES};
    use crate::params::InitParams;
    use audio_wire::generated as wire;

    fn core() -> Core {
        let p = InitParams { max_logical: 16, max_mixed: 8, max_buses: 8, arena_initial_bytes: 0, ..InitParams::default() };
        let layout = Layout::new(&p);
        let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
        // SAFETY: non-zero, zeroed, page-aligned, leaked on purpose ('static).
        let base = unsafe { std::alloc::alloc_zeroed(block) };
        // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
        unsafe { Core::new(p, layout, base) }
    }

    fn batch(recs: &[Vec<u8>]) -> Vec<u8> {
        let mut buf = vec![0u8; 32];
        for r in recs {
            buf.extend_from_slice(r);
        }
        wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        wire::BatchHeader { first_frame: 0.0, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
        buf
    }

    fn rec(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Vec<u8> {
        let mut b = vec![0u8; 4096];
        let n = write(&mut b).unwrap();
        b.truncate(n);
        b
    }

    /// What BUS_MIX of `gains` (low-pass off) over `ramp` was: per bus, an asap `BUS_RAMP` on the
    /// runtime lane's gain and one on the snapshot lane's low-pass (B1a's mapping, R3).
    fn mix(ramp: u32, gains: &[f32]) -> Vec<Vec<u8>> {
        let one = |bus: usize, lane: u32, mask: u16, gain: f32| {
            rec(|b| wire::BusRamp { voice_id: bus as u32, frame_offset: wire::ASAP, lane: lane as u16, mask, gain, lp_hz: wire::BUS_LP_OFF_HZ as f32, frames: ramp, shape: 0 }.write(b, 0))
        };
        gains.iter().enumerate().flat_map(|(i, &g)| [one(i, wire::LANE_RUNTIME, wire::BUS_RAMP_MASK_GAIN, g), one(i, wire::LANE_SNAPSHOT, wire::BUS_RAMP_MASK_LP_HZ, 1.0)]).collect()
    }

    /// One lane of one bus: an asap `BUS_RAMP` of `gain` over `ramp`.
    fn lane(bus: u32, lane: u32, gain: f32, ramp: u32) -> Vec<u8> {
        rec(|b| wire::BusRamp { voice_id: bus, frame_offset: wire::ASAP, lane: lane as u16, mask: wire::BUS_RAMP_MASK_GAIN, gain, lp_hz: 0.0, frames: ramp, shape: 0 }.write(b, 0))
    }

    fn db(a: f32, b: f32) -> f32 {
        (20.0 * (a / b).log10()).abs()
    }

    /// A ducked chain (architecture §4.3, api-and-models §9): root ← A ← B, A ducked 12 dB over 5 ms
    /// (a ramp that ends inside a quantum), B at 0.5, the root ramping up 6 dB at the same time. A constant signal put
    /// into B's input, through `bus::mixdown`, comes out as the signal × `fill`'s chain gain within
    /// 0.05 dB at every frame (it is the same product, so in fact to float rounding).
    #[test]
    fn the_chain_gain_follows_a_ducked_chain_within_0_05_db() {
        let mut c = core();
        let buses = |parents: &[u16]| {
            wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses: parents.iter().map(|&parent| wire::BusConfigBuses { parent, effects: vec![] }).collect() }
        };
        assert_eq!(crate::scheduler::submit(&mut c, &batch(&[vec![rec(|b| buses(&[ROOT, 0, 1]).write(b, 0))], mix(0, &[0.5, 1.0, 0.5])].concat())), 0);
        assert!(bus::set_limiter_lookahead(&mut c, 0.0), "no look-ahead: output frame = core frame");
        // The duck: A from 1 to 0.25 (-12 dB) over 240 frames (5 ms) while the root goes from 0.5 to 1.
        assert_eq!(crate::scheduler::submit(&mut c, &batch(&mix(240, &[1.0, 0.25, 0.5]))), 0);
        let x = 0.2f32;
        let mut worst = 0.0f32;
        let mut chord_worst = 0.0f32;
        for q in 0..8 {
            let mut want = [0.0f32; QUANTUM];
            fill(&mut c, 2, None, &mut want);
            let (g0, g1) = ends(&mut c, 2, None);
            // `ends` steps the ramp in one multiply, `fill` frame by frame: equal to float rounding.
            assert!(db(g0, want[0]) < 1e-4 && db(g1, want[QUANTUM - 1]) < 1e-4, "quantum {q}: ends {g0}, {g1} are fill's ends");
            {
                let mut inputs = bus::Inputs::of(c.regions_mut());
                let (l, r) = inputs.get(2).unwrap();
                l.fill(x);
                r.fill(x);
            }
            // `voices::render` clears the output before the buses add into it; no voice runs here.
            c.regions_mut().output.fill(0.0);
            bus::mixdown(&mut c);
            let out = &c.regions().output[..QUANTUM];
            for j in 0..QUANTUM {
                worst = worst.max(db(out[j], x * want[j]));
                chord_worst = chord_worst.max(db(out[j], x * automation::ramp_at(g0, g1, j)));
            }
        }
        assert!(worst < 0.05, "fill: {worst} dB");
        assert!(worst < 1e-4, "fill is the tree's own product: {worst} dB");
        // The straight line misses the duck's knee (recorded, not asserted): see the module comment.
        eprintln!("chain gain: fill {worst:.2e} dB, straight line between ends {chord_worst:.3} dB");
    }

    #[test]
    fn until_stops_before_the_host_and_unknown_buses_are_the_root() {
        let mut c = core();
        let buses = wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses: [ROOT, 0, 1].iter().map(|&parent| wire::BusConfigBuses { parent, effects: vec![] }).collect() };
        assert_eq!(crate::scheduler::submit(&mut c, &batch(&[vec![rec(|b| buses.write(b, 0))], mix(0, &[0.5, 0.25, 0.125])].concat())), 0);
        assert_eq!(ends(&mut c, 2, None), (0.5 * 0.25 * 0.125, 0.5 * 0.25 * 0.125));
        assert_eq!(ends(&mut c, 2, Some(0)), (0.25 * 0.125, 0.25 * 0.125), "the host (root) excluded");
        assert_eq!(ends(&mut c, 2, Some(2)), (1.0, 1.0), "the bus hosts its own bed");
        assert_eq!(ends(&mut c, 7, None), (0.5, 0.5), "an unconfigured bus is the root");
    }

    /// Sends and the bed fold follow every main-written lane, not only the runtime lane: root ← A
    /// ← B with A's authored lane settled at 0.5, its monitor lane ramping to 0 and its dip lane
    /// ramping to 0.25 (ends inside a quantum), B's runtime lane ramping up. `fill` is
    /// `bus::mixdown`'s own product to float rounding, and `ends` is `fill`'s ends.
    #[test]
    fn the_chain_gain_follows_every_lane() {
        let mut c = core();
        let buses = wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses: [ROOT, 0, 1].iter().map(|&parent| wire::BusConfigBuses { parent, effects: vec![] }).collect() };
        assert_eq!(crate::scheduler::submit(&mut c, &batch(&[rec(|b| buses.write(b, 0))])), 0);
        assert!(bus::set_limiter_lookahead(&mut c, 0.0));
        let recs = [
            lane(1, wire::LANE_AUTHORED, 0.5, 0),
            lane(1, wire::LANE_MONITOR, 0.0, 700),
            lane(1, wire::LANE_DIP, 0.25, 200),
            lane(2, wire::LANE_RUNTIME, 0.5, 0),
        ];
        assert_eq!(crate::scheduler::submit(&mut c, &batch(&recs)), 0);
        assert_eq!(crate::scheduler::submit(&mut c, &batch(&[lane(2, wire::LANE_RUNTIME, 1.0, 300)])), 0);
        let (g0, _) = ends(&mut c, 2, Some(0));
        let want0 = (0.5 + 0.5 / 300.0) * 0.5 * (1.0 - 1.0 / 700.0) * (1.0 - 0.75 / 200.0);
        assert!((g0 - want0).abs() < 1e-6, "the first frame is every lane's product: {g0} vs {want0}");
        let x = 0.2f32;
        let mut worst = 0.0f32;
        for q in 0..8 {
            let mut want = [0.0f32; QUANTUM];
            fill(&mut c, 2, None, &mut want);
            let (g0, g1) = ends(&mut c, 2, None);
            assert!((g0 - want[0]).abs() < 1e-6 && (g1 - want[QUANTUM - 1]).abs() < 1e-6, "quantum {q}: ends {g0}, {g1} vs {}, {}", want[0], want[QUANTUM - 1]);
            {
                let mut inputs = bus::Inputs::of(c.regions_mut());
                let (l, r) = inputs.get(2).unwrap();
                l.fill(x);
                r.fill(x);
            }
            c.regions_mut().output.fill(0.0);
            bus::mixdown(&mut c);
            let out = &c.regions().output[..QUANTUM];
            for j in 0..QUANTUM {
                let want = x * want[j];
                worst = worst.max((out[j] - want).abs());
            }
        }
        assert!(worst < 1e-7, "fill is the tree's own product: {worst}");
        // By the 8th quantum the monitor lane has reached 0: the chain is silent.
        let mut want = [1.0f32; QUANTUM];
        fill(&mut c, 2, None, &mut want);
        assert!(want.iter().all(|g| *g == 0.0));
    }
}
