//! Instance submixes (ADR 0331 "Instance", ABI 4.5): the voices of one playing playlist, track or
//! sequence mix into a submix of their own, which runs the instance's insert chain and then feeds
//! the instance's output bus.
//!
//! - **The pool** is [`SUBMIXES`] slots in the `Submixes` region, laid out on every preset (one
//!   slot ≈ 5 KB: its quantum buffer, [`SUBMIX_EFFECTS`] effect slots and one compressor). Main owns
//!   the allocation (`settings.voices.submixes` slots at most, clamped to the core's); the core
//!   keeps no instance lifecycle.
//! - **SUBMIX** (0x0C, applies on arrival like AUTOMATE) configures slot `voiceId`: the instance
//!   `group` (1..=1024) whose voices route into it, the output `bus`, and the chain. An effect count
//!   of 0 frees the slot. A slot taken over by another group drops the old group's route; a group
//!   routed to another slot moves.
//! - **Routing.** A mixed voice whose PLAY `group` has a submix, and whose bus is the submix's
//!   bus, mixes into the submix's buffer instead of its bus's input (a voice of the instance on
//!   another bus, a nested playlist's output override, isn't the instance's mix): its dry
//!   output, and its HRTF half (`panner::flush` reads the route code the voice was panned with,
//!   [`route_code`]). A voice routed so is panned without the bed: a submix has no bed (the bed
//!   half of a kind-2 voice goes equal-power or HRTF into the submix), and an ambisonic voice still
//!   encodes into its bus's bed directly (follow-up: beds per submix). Zone and aux sends tap the
//!   voice before its panner as before.
//! - **Render** ([`render`], after every voice and the HRTF flush, before `bus::mixdown`): each
//!   slot in use runs its chain on its buffer, in order, and adds the result into its bus's input
//!   (an unconfigured bus is bus 0, as for voices), so the bus's effects, gain and meter apply on
//!   top. A slot that received nothing for [`QUIET_QUANTA`] quanta (its filters' and compressor's
//!   tails have died away) is skipped until a voice feeds it again.
//! - **The chain** dispatches on each effect's kind ([`kind`], the wire's `SUBMIX_FX_*`, the
//!   catalogue's types): the catalogue's parameters arrive in its order (`effects/catalogue.ts`) and
//!   are converted here. A kind the core doesn't know (a newer catalogue) passes the signal through,
//!   so the next effects slot in by kind without a wire change. Today: `lowpass` and `highpass`
//!   (cutoff Hz, resonance 0..1 as Q 0.5..20 dB like the bus chain, drive not yet), `compressor`
//!   (threshold dB, ratio, attack ms, release ms, makeup dB, knee dB; one per submix, the first; a
//!   second is passed through). An effect with its `on` flag clear passes the signal through and
//!   keeps its state. An effect that keeps its kind in its slot keeps its filter or envelope state
//!   across a SUBMIX (an edit doesn't click).
//!
//! RESET frees every slot (main replays the ones in use). Nothing here allocates.

use audio_dsp::biquad::Biquad;
use audio_dsp::compressor::{db_to_linear, Compressor};
use audio_wire::generated as wire;

use crate::core::{Core, Regions};
use crate::layout::REGION_ALIGN;
use crate::wire_read::{u16_at, u32_at};
use crate::QUANTUM;

/// Slots the core lays out (the wire's `SUBMIXES_MAX`).
pub const SUBMIXES: usize = wire::SUBMIXES_MAX as usize;
/// Effects a submix's chain keeps (the wire's `SUBMIX_EFFECTS_MAX`).
pub const SUBMIX_EFFECTS: usize = wire::SUBMIX_EFFECTS_MAX as usize;
/// Parameters per effect on the wire.
pub const PARAMS: usize = 8;
/// Instance groups 1..=GROUPS (as PLAY's `group`).
pub const GROUPS: usize = crate::automation::GROUPS;
/// Quanta without input after which a slot's chain stops running (≈ 85 ms at 48 kHz).
pub const QUIET_QUANTA: u32 = 32;
/// A voice's route code (`panner` bus argument) for submix slot `s`: this bit plus `s`.
pub const ROUTE_SUBMIX: u16 = 0x8000;
/// A filter's Q in dB at resonance 0 and 1 (the bus chain's `Q_RANGE`, `legacyEffects.ts`).
pub const Q_RANGE_DB: (f32, f32) = (0.5, 20.0);

/// Effect kinds (the wire's `SUBMIX_FX_*`). 0 is an empty slot.
pub mod kind {
    use super::wire;
    pub const NONE: u32 = 0;
    pub const LOWPASS: u32 = wire::SUBMIX_FX_LOWPASS as u32;
    pub const HIGHPASS: u32 = wire::SUBMIX_FX_HIGHPASS as u32;
    pub const COMPRESSOR: u32 = wire::SUBMIX_FX_COMPRESSOR as u32;
}

/// One effect slot. All-zero is an empty slot.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SubmixEffect {
    /// [`kind`].
    pub kind: u32,
    /// Non-zero: runs; 0: passes the signal through (bypassed, state kept).
    pub on: u32,
    /// The catalogue's parameters in its order, non-finite read as 0.
    pub p: [f32; PARAMS],
    /// A filter's state (zeroed and unused for the other kinds).
    pub biquad: Biquad,
}

/// One submix slot. All-zero is a free slot.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Submix {
    /// This quantum's input, planar stereo `[L; 128][R; 128]`; routed voices add into it.
    pub buf: [f32; 2 * QUANTUM],
    /// The instance group (1..=1024) routed here; 0 when free.
    pub group: u16,
    /// The output bus index.
    pub bus: u16,
    /// Effects in use.
    pub count: u32,
    /// The slot that runs [`Submix::compressor`], or `u32::MAX`.
    pub compressor_slot: u32,
    /// Non-zero when a voice added into `buf` this quantum.
    pub fed: u32,
    /// Quanta since a voice last fed it (saturating at [`QUIET_QUANTA`]).
    pub quiet: u32,
    pub _pad: u32,
    pub effects: [SubmixEffect; SUBMIX_EFFECTS],
    /// The chain's one compressor.
    pub compressor: Compressor,
}

/// The region's scalars, then the group routes. All-zero is valid: nothing routed.
#[repr(C)]
pub struct Header {
    /// Slots in use.
    pub active: u32,
    /// Configurations received (tests and a debugger).
    pub configured: u32,
    /// `route[group]`: the slot routed for an instance group, plus 1; 0 none.
    pub route: [u8; GROUPS + 1],
    pub _pad: [u8; 7],
    /// `route_bus[group]`: that slot's bus (only the instance's voices on it route).
    pub route_bus: [u16; GROUPS + 1],
}

const _: () = assert!(SUBMIXES < 255, "a route is a u8 slot + 1");
const _: () = assert!(core::mem::align_of::<Submix>() <= REGION_ALIGN);

const fn align(n: usize) -> usize {
    (n + REGION_ALIGN - 1) / REGION_ALIGN * REGION_ALIGN
}

const HEADER_BYTES: usize = align(core::mem::size_of::<Header>());
/// The `Submixes` region's size, on every preset.
pub const REGION_BYTES: usize = align(HEADER_BYTES + SUBMIXES * SLOT_BYTES);
/// A slot's stride (the slots are an array after the header).
const SLOT_BYTES: usize = core::mem::size_of::<Submix>();

/// The header and the slots of the `Submixes` region (`None` when it is too short: never after
/// `Core::new`).
pub(crate) struct View<'a> {
    pub header: &'a mut Header,
    pub slots: &'a mut [Submix],
}

pub(crate) fn view(region: &mut [u8]) -> Option<View<'_>> {
    if region.len() < REGION_BYTES {
        return None;
    }
    let base = region.as_mut_ptr();
    // SAFETY: the region is 64-byte aligned (Layout), REGION_BYTES long (checked) and zeroed at
    // init; all-zero is a valid Header and Submix (integers, floats and all-zero-valid DSP state).
    // The header and the slots don't overlap (HEADER_BYTES apart). Only this module views it.
    unsafe {
        Some(View {
            header: &mut *(base as *mut Header),
            slots: core::slice::from_raw_parts_mut(base.add(HEADER_BYTES) as *mut Submix, SUBMIXES),
        })
    }
}

/// `true` when the (well-formed-length) SUBMIX record at `msg[off..off + len]` holds its effects.
pub fn config_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::Submix::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 16) as usize;
    n.checked_mul(wire::SubmixEffects::FIXED_END).is_some_and(|bytes| wire::Submix::FIXED_END + bytes <= len)
}

/// A filter's Q in dB at resonance `r` (0..1, clamped).
fn q_db(r: f32) -> f32 {
    let r = if r.is_finite() { r.clamp(0.0, 1.0) } else { 0.0 };
    Q_RANGE_DB.0 + r * (Q_RANGE_DB.1 - Q_RANGE_DB.0)
}

/// SUBMIX: configures slot `voiceId` (see the module comment). Out-of-range slots are ignored.
pub fn configure(core: &mut Core, msg: &[u8], off: usize) {
    let sample_rate = core.params().sample_rate;
    let index = u32_at(msg, off + 4) as usize;
    let Some(v) = view(&mut core.regions_mut().submixes[..]) else { return };
    if index >= SUBMIXES {
        return;
    }
    v.header.configured = v.header.configured.wrapping_add(1);
    let group = u16_at(msg, off + 12) as usize;
    let bus = u16_at(msg, off + 14);
    let n = u32_at(msg, off + 16) as usize;
    let was = v.slots[index].group as usize;
    if was != 0 && v.header.route.get(was) == Some(&(index as u8 + 1)) {
        v.header.route[was] = 0;
    }
    if n == 0 || group == 0 || group > GROUPS {
        if was != 0 {
            v.header.active -= 1;
        }
        // SAFETY: all-zero is a free slot.
        v.slots[index] = unsafe { core::mem::zeroed() };
        return;
    }
    // A group routed to another slot moves here (that slot goes free).
    if let Some(&old) = v.header.route.get(group) {
        if old != 0 && old as usize - 1 != index {
            // SAFETY: all-zero is a free slot.
            v.slots[old as usize - 1] = unsafe { core::mem::zeroed() };
            v.header.active -= 1;
        }
    }
    let s = &mut v.slots[index];
    if was == 0 {
        v.header.active += 1;
        s.quiet = 0;
    }
    if group != was {
        // Another instance: the chain starts from silence.
        s.buf = [0.0; 2 * QUANTUM];
        for e in s.effects.iter_mut() {
            e.kind = kind::NONE;
        }
        s.compressor = Compressor::default();
    }
    v.header.route[group] = index as u8 + 1;
    v.header.route_bus[group] = bus;
    s.group = group as u16;
    s.bus = bus;
    let old_compressor = s.compressor_slot;
    let had = s.count as usize;
    let mut compressor = u32::MAX;
    let kept = n.min(SUBMIX_EFFECTS);
    for i in 0..kept {
        let at = off + wire::Submix::FIXED_END + i * wire::SubmixEffects::FIXED_END;
        let k = u32_at(msg, at);
        let flags = u32_at(msg, at + 4);
        let mut p = [0.0f32; PARAMS];
        for (j, x) in p.iter_mut().enumerate() {
            let y = f32::from_bits(u32_at(msg, at + 8 + 4 * j));
            *x = if y.is_finite() { y } else { 0.0 };
        }
        let e = &mut s.effects[i];
        if e.kind != k || i >= had {
            e.biquad = Biquad::default();
        }
        e.kind = k;
        e.on = flags & wire::SUBMIX_FX_ON;
        e.p = p;
        match k {
            kind::LOWPASS => e.biquad.set_lowpass(sample_rate, p[0], q_db(p[1])),
            kind::HIGHPASS => e.biquad.set_highpass(sample_rate, p[0], q_db(p[1])),
            kind::COMPRESSOR if compressor == u32::MAX => {
                // Catalogue order: threshold, ratio, attack ms, release ms, makeup, knee.
                if old_compressor != i as u32 {
                    s.compressor = Compressor::default();
                }
                s.compressor.configure(sample_rate, p[0], p[5], p[1], p[2] / 1000.0, p[3] / 1000.0);
                compressor = i as u32;
            }
            _ => {}
        }
    }
    for e in s.effects[kept..].iter_mut() {
        e.kind = kind::NONE;
    }
    s.count = kept as u32;
    s.compressor_slot = compressor;
}

/// RESET: every slot goes free and every route with it.
pub fn reset(core: &mut Core) {
    core.regions_mut().submixes.fill(0);
}

/// The route code a voice of instance `group` on bus `bus` pans with: its submix's
/// ([`ROUTE_SUBMIX`] `| slot`) when the group has one on that bus, else `bus` itself.
#[inline]
pub(crate) fn route_code(routes: Option<&Header>, group: u16, bus: u16) -> u16 {
    let Some(h) = routes else { return bus };
    match h.route.get(group as usize) {
        Some(&s) if s != 0 && h.route_bus[group as usize] == bus => ROUTE_SUBMIX | (s as u16 - 1),
        _ => bus,
    }
}

/// The group routes for the voices' render loop, or `None` when no submix is in use (then every
/// voice pans with its bus, as before).
/// A raw view: the render loop reads it beside the regions it borrows (the routes live in the
/// `Submixes` region, which only `configure`, between quanta, writes).
pub(crate) fn routes(regions: &mut Regions) -> Option<*const Header> {
    let v = view(&mut regions.submixes[..])?;
    if v.header.active == 0 {
        return None;
    }
    Some(v.header as *const Header)
}

/// The buffers of the submix slots, for `bus::Inputs`: a raw view so a voice's slot and a bus
/// buffer can be borrowed with it (other regions).
pub(crate) struct Buffers {
    base: *mut Submix,
}

impl Buffers {
    pub(crate) fn of(regions: &mut Regions) -> Option<Buffers> {
        let v = view(&mut regions.submixes[..])?;
        (v.header.active != 0).then(|| Buffers { base: v.slots.as_mut_ptr() })
    }

    /// `true` when slot `s` is in use.
    pub(crate) fn live(&self, s: usize) -> bool {
        // SAFETY: as `get`.
        s < SUBMIXES && unsafe { (*self.base.add(s)).group } != 0
    }

    /// Slot `s`'s input (marking it fed), or `None` for a free or out-of-range slot.
    pub(crate) fn get(&mut self, s: usize) -> Option<(&mut [f32], &mut [f32])> {
        if s >= SUBMIXES {
            return None;
        }
        // SAFETY: `s < SUBMIXES` slots of the region viewed in `of`; `&mut self` keeps one borrowed.
        let slot = unsafe { &mut *self.base.add(s) };
        if slot.group == 0 {
            return None;
        }
        slot.fed = 1;
        let (l, r) = slot.buf.split_at_mut(QUANTUM);
        Some((l, r))
    }

    /// Slot `s`'s output bus (0 for a free slot): where a free slot's voices go instead.
    pub(crate) fn bus_of(&self, s: usize) -> u16 {
        if s >= SUBMIXES {
            return 0;
        }
        // SAFETY: as `get`.
        unsafe { (*self.base.add(s)).bus }
    }
}

/// Once a quantum after every voice and the HRTF flush (`Core::process`): each slot in use runs its
/// chain and adds into its bus's input (see the module comment).
pub fn render(core: &mut Core) {
    let regions = core.regions_mut();
    let mut inputs = crate::bus::Inputs::of(regions);
    let Some(v) = view(&mut regions.submixes[..]) else { return };
    if v.header.active == 0 {
        return;
    }
    for s in v.slots.iter_mut() {
        if s.group == 0 {
            continue;
        }
        if s.fed != 0 {
            s.quiet = 0;
        } else if s.quiet >= QUIET_QUANTA {
            continue;
        } else {
            s.quiet += 1;
        }
        s.fed = 0;
        let (l, r) = s.buf.split_at_mut(QUANTUM);
        run_chain(&mut s.effects[..s.count as usize], &mut s.compressor, s.compressor_slot, l, r);
        if let Some((dl, dr)) = inputs.get(s.bus) {
            for i in 0..QUANTUM {
                dl[i] += l[i];
                dr[i] += r[i];
            }
        }
        s.buf = [0.0; 2 * QUANTUM];
    }
}

/// Runs `effects` in order on one block (the kind dispatch: see the module comment).
fn run_chain(effects: &mut [SubmixEffect], compressor: &mut Compressor, compressor_slot: u32, l: &mut [f32], r: &mut [f32]) {
    for (i, e) in effects.iter_mut().enumerate() {
        if e.on == 0 {
            continue;
        }
        match e.kind {
            kind::LOWPASS | kind::HIGHPASS => e.biquad.process(l, r),
            kind::COMPRESSOR if compressor_slot == i as u32 => {
                compressor.process(l, r);
                let makeup = e.p[4];
                if makeup != 0.0 {
                    let g = db_to_linear(makeup.clamp(0.0, 24.0));
                    for j in 0..l.len() {
                        l[j] *= g;
                        r[j] *= g;
                    }
                }
            }
            _ => {}
        }
    }
}

/// Slots in use (tests and a debugger).
pub fn active(core: &mut Core) -> u32 {
    view(&mut core.regions_mut().submixes[..]).map_or(0, |v| v.header.active)
}

/// The slot routed for `group`, if any (tests and a debugger).
pub fn slot_of(core: &mut Core, group: u16) -> Option<usize> {
    let v = view(&mut core.regions_mut().submixes[..])?;
    v.header.route.get(group as usize).and_then(|&s| (s != 0).then(|| s as usize - 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_region_holds_the_header_and_every_slot() {
        assert!(REGION_BYTES < 400 << 10, "{REGION_BYTES}");
        assert_eq!(route_code(None, 3, 5), 5);
        // SAFETY: all-zero is a valid Header.
        let mut h: Header = unsafe { core::mem::zeroed() };
        h.route[3] = 7;
        h.route_bus[3] = 5;
        assert_eq!(route_code(Some(&h), 3, 5), ROUTE_SUBMIX | 6);
        assert_eq!(route_code(Some(&h), 3, 2), 2, "another bus of the instance");
        assert_eq!(route_code(Some(&h), 4, 5), 5);
    }

    #[test]
    fn resonance_maps_onto_the_bus_chains_q_range() {
        assert_eq!(q_db(0.0), 0.5);
        assert_eq!(q_db(1.0), 20.0);
        assert_eq!(q_db(f32::NAN), 0.5);
        assert_eq!(q_db(3.0), 20.0);
    }
}
