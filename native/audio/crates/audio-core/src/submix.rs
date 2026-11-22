//! Instance submixes (ADR 0331 "Instance", ABI 4.5): the voices of one playing playlist, track or
//! sequence mix into a submix of their own, which runs the instance's insert chain and then feeds
//! the instance's output bus.
//!
//! - **The pool** is [`SUBMIXES`] slots in the `Submixes` region, laid out on every preset (one
//!   slot ≈ 6.4 KB (ABI 5.0): its quantum buffer and [`SUBMIX_EFFECTS`] effect slots; their delay lines,
//!   networks and compressors live in the effect memory, `fxmem.rs`, ABI 4.6). Main owns
//!   the allocation (`settings.voices.submixes` slots at most, clamped to the core's); the core
//!   keeps no instance lifecycle.
//! - **SUBMIX** (0x0C, applies on arrival like AUTOMATE) configures slot `voiceId`: the instance
//!   `group` (1..=1024; 0 none) whose voices route into it, the output `bus`, the `parent` slot it
//!   feeds (ABI 4.9) and the chain. An effect count of 0 frees the slot. A slot taken over by
//!   another group drops the old group's route; a group routed to another slot moves (the slot it
//!   left keeps running, ungrouped, until main frees it). A slot whose group goes to 0 keeps its
//!   chain's state: that is how main lets an ended instance's tails ring (it frees the slot later).
//! - **Levels** (ABI 4.9, ADR 0331): a nested playlist's, a sequence track's or a clip's chain is a
//!   slot of its own, usually with group 0, whose `parent` is the slot of the level above it (on
//!   the same bus). Its voices name it with **ROUTE** (0x0D, `automation::route`), which overrides
//!   the group route. A slot's output goes into its parent's buffer (the parent's chain then runs
//!   on it) when the parent is in use, else into its bus. Chains of parents are kept to
//!   [`DEPTH_MAX`] levels; a longer chain (or a loop) feeds the bus. [`render`] runs the deepest
//!   slots first, so a parent always has its children's output before its own chain runs.
//! - **Routing.** A mixed voice with a ROUTE mixes into that slot. Otherwise a voice whose PLAY
//!   `group` has a submix, and whose bus is the submix's bus, mixes into the submix's buffer
//!   instead of its bus's input (a voice of the instance on another bus, a nested playlist's
//!   output override, isn't the instance's mix): its dry
//!   output, and its HRTF half (`panner::flush` reads the route code the voice was panned with,
//!   [`route_code`]). A voice routed so is panned without the bed: a submix has no bed (the bed
//!   half of a kind-2 voice goes equal-power or HRTF into the submix), and an ambisonic voice still
//!   encodes into its bus's bed directly (follow-up: beds per submix). Zone and aux sends tap the
//!   voice before its panner as before.
//! - **Render** ([`render`], after every voice and the HRTF flush, before `bus::mixdown`): each
//!   slot in use runs its chain on its buffer, in order, and adds the result into its bus's input
//!   (an unconfigured bus is bus 0, as for voices), so the bus's effects, gain and meter apply on
//!   top. A slot that received nothing for [`QUIET_QUANTA`] quanta and whose chain put out silence
//!   (under −140 dB) that long (its filters', compressor's, delay's and reverb's tails have died
//!   away) is skipped until a voice feeds it again.
//! - **The chain** is the catalogue's shared effect DSP (`audio_dsp::fx`, ABI 4.6; the same code
//!   as the bus chains' catalogue effects): each slot is an `audio_dsp::fx::Effect` of a kind
//!   ([`kind`], the wire's `SUBMIX_FX_*`), the catalogue's parameters in its order
//!   (`effects/catalogue.ts`), large state in the effect memory (`fxmem::configure` gives it, the
//!   sweep takes it back). Every kind but the sidechain compressor runs (an instance has no key bus:
//!   it passes through); any number of compressors. A kind the core doesn't know (a newer catalogue)
//!   passes the signal through. An effect with its `on` flag clear passes the signal through and
//!   keeps its state. An effect that keeps its kind in its slot keeps its state across a SUBMIX and
//!   glides to the new parameters (an edit doesn't click).
//! - **Plugin effects** (ABI 5.0, ADR 0338): a kind `PLUGIN_BASE + e` runs registered plugin effect
//!   `e` in its own module through the `myco_ext` import (`ext.rs`), at every level; a fault passes
//!   the block dry, and every submix's plugin calls share one quantum's fuel (0344 §3).
//!
//! - **Automation** (SUBMIX_AUTOMATE, ABI 4.8; ADR 0331 instance automation): up to
//!   [`automation::BUS_BINDINGS`] fx bindings per slot, each a parameter of its chain driven by a
//!   curve of a global parameter, a local one of the slot's group, or the group's `sequenceTime`,
//!   evaluated once a quantum before the chain runs (`automation::submix_bindings`; the effect
//!   reaches the value across the quantum). A SUBMIX that frees the slot or gives it to another
//!   group clears them; one that keeps the group keeps them.
//!
//! RESET frees every slot (main replays the ones in use). Nothing here allocates.

use audio_dsp::fx::{Ctx, Effect};
use audio_wire::generated as wire;

use crate::automation::{self, Binding};
use crate::core::{Core, Regions};
use crate::layout::REGION_ALIGN;
use crate::wire_read::{u16_at, u32_at};
use crate::QUANTUM;

/// Slots the core lays out (the wire's `SUBMIXES_MAX`).
pub const SUBMIXES: usize = wire::SUBMIXES_MAX as usize;
/// Effects a submix's chain keeps (the wire's `SUBMIX_EFFECTS_MAX`).
pub const SUBMIX_EFFECTS: usize = wire::SUBMIX_EFFECTS_MAX as usize;
/// Parameters per effect on the wire (16 from ABI 5.0, ADR 0338).
pub const PARAMS: usize = audio_dsp::fx::PARAMS;
/// Instance groups 1..=GROUPS (as PLAY's `group`).
pub const GROUPS: usize = crate::automation::GROUPS;
/// Levels a chain of parents keeps (the wire's `SUBMIX_DEPTH_MAX`).
pub const DEPTH_MAX: usize = wire::SUBMIX_DEPTH_MAX as usize;
/// Quanta without input after which a slot's chain stops running (≈ 85 ms at 48 kHz).
pub const QUIET_QUANTA: u32 = 32;
/// The level under which a chain's output counts as silent (−140 dB): its tail has died away.
pub const TAIL_FLOOR: f32 = 1e-7;
/// A voice's route code (`panner` bus argument) for submix slot `s`: this bit plus `s`.
pub const ROUTE_SUBMIX: u16 = 0x8000;
/// A filter's Q in dB at resonance 0 and 1 (the bus chain's `Q_RANGE`, `legacyEffects.ts`).
pub const Q_RANGE_DB: (f32, f32) = audio_dsp::fx::Q_RANGE_DB;

/// Effect kinds (the wire's `SUBMIX_FX_*`, `audio_dsp::fx::kind`). 0 is an empty slot.
pub mod kind {
    pub use audio_dsp::fx::kind::*;
}

const _: () = {
    use audio_dsp::fx::kind as k;
    assert!(k::LOWPASS == wire::SUBMIX_FX_LOWPASS && k::HIGHPASS == wire::SUBMIX_FX_HIGHPASS && k::COMPRESSOR == wire::SUBMIX_FX_COMPRESSOR);
    assert!(k::EQ == wire::SUBMIX_FX_EQ && k::BANDPASS == wire::SUBMIX_FX_BANDPASS && k::SATURATION == wire::SUBMIX_FX_SATURATION);
    assert!(k::DISTORTION == wire::SUBMIX_FX_DISTORTION && k::BITCRUSH == wire::SUBMIX_FX_BITCRUSH && k::CHORUS == wire::SUBMIX_FX_CHORUS);
    assert!(k::DELAY == wire::SUBMIX_FX_DELAY && k::REVERB == wire::SUBMIX_FX_REVERB && k::FORMANT == wire::SUBMIX_FX_FORMANT);
    assert!(k::PITCH == wire::SUBMIX_FX_PITCH && k::LIMITER == wire::SUBMIX_FX_LIMITER && k::SIDECHAIN == wire::SUBMIX_FX_SIDECHAIN);
    assert!(k::GAIN == wire::SUBMIX_FX_GAIN && PARAMS == audio_dsp::fx::PARAMS);
};

/// One effect slot (the catalogue's shared effect, `audio_dsp::fx`). All-zero is an empty slot.
pub type SubmixEffect = Effect;

/// One submix slot. All-zero is a free slot.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Submix {
    /// This quantum's input, planar stereo `[L; 128][R; 128]`; routed voices add into it.
    pub buf: [f32; 2 * QUANTUM],
    /// The instance group (1..=1024) routed here; 0 none (ROUTE only, or a ringing tail).
    pub group: u16,
    /// The output bus index.
    pub bus: u16,
    /// Effects in use.
    pub count: u32,
    /// Non-zero when a voice (or a child slot) added into `buf` this quantum.
    pub fed: u32,
    /// Quanta since a voice last fed it (saturating at [`QUIET_QUANTA`]).
    pub quiet: u32,
    /// The slot this one feeds, plus 1, as SUBMIX gave it (ABI 4.9); 0 its bus.
    pub parent: u16,
    /// The slot its output goes into, plus 1 (its parent when that is in use and the chain of
    /// parents ends within [`DEPTH_MAX`]); 0 its bus. Worked out after every SUBMIX.
    pub out: u16,
    /// Non-zero while the slot is in use (configured with effects).
    pub used: u8,
    /// Its level: parents above it (0 feeds a bus); [`render`] runs the deepest first.
    pub depth: u8,
    pub _pad: u16,
    /// ABI 4.10: fx bindings in use (SUBMIX_AUTOMATE).
    pub auto_n: u32,
    pub _pad2: u32,
    pub effects: [SubmixEffect; SUBMIX_EFFECTS],
    /// ABI 4.8: the fx bindings (SUBMIX_AUTOMATE).
    pub auto: [Binding; automation::BUS_BINDINGS],
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

/// SUBMIX: configures slot `voiceId` (see the module comment). Out-of-range slots are ignored.
pub fn configure(core: &mut Core, msg: &[u8], off: usize) {
    let sample_rate = core.params().sample_rate;
    let index = u32_at(msg, off + 4) as usize;
    let regions = core.regions_mut();
    apply(regions, msg, off, index, sample_rate);
    crate::fxmem::rebuild(regions);
}

fn apply(regions: &mut Regions, msg: &[u8], off: usize, index: usize, sample_rate: f32) {
    let fxmem = &mut regions.fxmem[..];
    let Some(v) = view(&mut regions.submixes[..]) else { return };
    if index >= SUBMIXES {
        return;
    }
    v.header.configured = v.header.configured.wrapping_add(1);
    let group = u16_at(msg, off + 12) as usize;
    let bus = u16_at(msg, off + 14);
    let n = u32_at(msg, off + 16) as usize;
    let parent = u16_at(msg, off + 20);
    let was = v.slots[index].group as usize;
    let used = v.slots[index].used != 0;
    if was != 0 && v.header.route.get(was) == Some(&(index as u8 + 1)) {
        v.header.route[was] = 0;
    }
    if n == 0 {
        if used {
            v.header.active -= 1;
        }
        // SAFETY: all-zero is a free slot (its memory goes back at the sweep).
        v.slots[index] = unsafe { core::mem::zeroed() };
        rebuild_levels(v.slots);
        return;
    }
    let group = if group > GROUPS { 0 } else { group };
    // A group routed to another slot moves here (that slot keeps running, ungrouped, until freed).
    if group != 0 {
        if let Some(&old) = v.header.route.get(group) {
            if old != 0 && old as usize - 1 != index {
                v.slots[old as usize - 1].group = 0;
                v.slots[old as usize - 1].auto_n = 0;
            }
        }
    }
    let s = &mut v.slots[index];
    if !used {
        v.header.active += 1;
        s.quiet = 0;
    }
    let mut had = s.count as usize;
    if group != was {
        // Its automation reads the group it was given: another group (or none) drops it.
        s.auto_n = 0;
    }
    if !used || (group != 0 && group != was) {
        // A new slot or another instance: the chain starts from silence. (A group going to 0 keeps
        // its state: the instance ended and its tail rings.)
        s.buf = [0.0; 2 * QUANTUM];
        had = 0;
    }
    crate::fxmem::set_owner(fxmem, wire::FX_STARVED_SUBMIX as u16 | index as u16);
    if group != 0 {
        v.header.route[group] = index as u8 + 1;
        v.header.route_bus[group] = bus;
    }
    s.used = 1;
    s.group = group as u16;
    s.bus = bus;
    s.parent = if parent as usize > SUBMIXES || parent as usize == index + 1 { 0 } else { parent };
    let kept = n.min(SUBMIX_EFFECTS);
    for i in 0..kept {
        let at = off + wire::Submix::FIXED_END + i * wire::SubmixEffects::FIXED_END;
        let k = u32_at(msg, at);
        let flags = u32_at(msg, at + 4);
        let mut p = [0.0f32; PARAMS];
        for (j, x) in p.iter_mut().enumerate() {
            *x = f32::from_bits(u32_at(msg, at + 8 + 4 * j));
        }
        // A sidechain compressor needs a key bus: an instance has none, so it passes through.
        let k = if k == kind::SIDECHAIN { kind::NONE } else { k };
        crate::fxmem::configure(fxmem, &mut s.effects[i], i < had, k, flags & wire::SUBMIX_FX_ON != 0, &p, sample_rate);
    }
    for e in s.effects[kept..].iter_mut() {
        *e = Effect::default();
    }
    s.count = kept as u32;
    rebuild_levels(v.slots);
}

/// Works out every slot's output (`out`) and level (`depth`) from the parents (after a SUBMIX): a
/// slot feeds its parent when the parent is in use and the chain of parents ends at a bus within
/// [`DEPTH_MAX`] levels; otherwise (a free parent, a longer chain, a loop) it feeds its bus.
fn rebuild_levels(slots: &mut [Submix]) {
    for i in 0..slots.len() {
        if slots[i].used == 0 {
            continue;
        }
        let (mut depth, mut at, mut ends) = (0usize, slots[i].parent, false);
        while depth <= DEPTH_MAX {
            if at == 0 || slots[at as usize - 1].used == 0 {
                ends = true;
                break;
            }
            depth += 1;
            at = slots[at as usize - 1].parent;
        }
        // A free parent ends the chain at the slot above it: that slot feeds its bus.
        let feeds = slots[i].parent != 0 && slots[slots[i].parent as usize - 1].used != 0;
        if ends && feeds {
            slots[i].out = slots[i].parent;
            slots[i].depth = depth as u8;
        } else {
            slots[i].out = 0;
            slots[i].depth = 0;
        }
    }
    // A slot whose parent was cut off (it feeds its bus) is level 0, so its children's levels
    // count from it: work them out again from the outputs.
    for i in 0..slots.len() {
        if slots[i].used == 0 {
            continue;
        }
        let (mut depth, mut at) = (0u8, slots[i].out);
        while at != 0 && (depth as usize) < DEPTH_MAX {
            depth += 1;
            at = slots[at as usize - 1].out;
        }
        slots[i].depth = depth;
    }
}

/// SUBMIX_AUTOMATE (ABI 4.8): replaces slot `voiceId`'s fx bindings (count 0 clears them). A free
/// or out-of-range slot ignores it.
pub fn automate(core: &mut Core, msg: &[u8], off: usize) {
    let index = u32_at(msg, off + 4) as usize;
    let Some(v) = view(&mut core.regions_mut().submixes[..]) else { return };
    let Some(s) = v.slots.get_mut(index).filter(|s| s.group != 0) else { return };
    s.auto_n = automation::read_submix_bindings(msg, off, &mut s.auto) as u32;
}

/// RESET: every slot goes free and every route with it.
pub fn reset(core: &mut Core) {
    let regions = core.regions_mut();
    regions.submixes.fill(0);
    crate::fxmem::rebuild(regions);
}

/// Calls `f` with every configured effect of the slots in use (the effect memory's sweep).
pub(crate) fn for_each_effect(regions: &mut Regions, f: &mut impl FnMut(&Effect)) {
    let Some(v) = view(&mut regions.submixes[..]) else { return };
    for s in v.slots.iter().filter(|s| s.used != 0) {
        for e in &s.effects[..(s.count as usize).min(SUBMIX_EFFECTS)] {
            f(e);
        }
    }
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
        s < SUBMIXES && unsafe { (*self.base.add(s)).used } != 0
    }

    /// Slot `s`'s input (marking it fed), or `None` for a free or out-of-range slot.
    pub(crate) fn get(&mut self, s: usize) -> Option<(&mut [f32], &mut [f32])> {
        if s >= SUBMIXES {
            return None;
        }
        // SAFETY: `s < SUBMIXES` slots of the region viewed in `of`; `&mut self` keeps one borrowed.
        let slot = unsafe { &mut *self.base.add(s) };
        if slot.used == 0 {
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
/// chain, deepest level first, and adds into its parent's buffer or its bus's input (see the
/// module comment).
pub fn render(core: &mut Core) {
    let frame = core.frame();
    let regions = core.regions_mut();
    let mut inputs = crate::bus::Inputs::of(regions);
    let Some((_, fxdata)) = crate::fxmem::split(&mut regions.fxmem[..]) else { return };
    let Some(v) = view(&mut regions.submixes[..]) else { return };
    if v.header.active == 0 {
        return;
    }
    let eval = automation::submix_eval(&mut regions.automation[..], frame);
    let deepest = v.slots.iter().filter(|s| s.used != 0).map(|s| s.depth).max().unwrap_or(0);
    let mut out = [0.0f32; 2 * QUANTUM];
    // ABI 5.0 (ADR 0338, 0344 §3): the submixes' plugin effects, at every level, share one quantum's fuel.
    let mut fuel = crate::ext::Fuel::quantum(QUANTUM);
    for depth in (0..=deepest).rev() {
        for i in 0..SUBMIXES {
            let s = &mut v.slots[i];
            if s.used == 0 || s.depth != depth {
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
            // ABI 4.10: the slot's automated parameters reach its chain before it runs.
            if s.auto_n != 0 && s.group != 0 {
                if let Some(e) = &eval {
                    let count = (s.count as usize).min(SUBMIX_EFFECTS);
                    let effects = &mut s.effects;
                    automation::submix_bindings(e, &s.auto[..(s.auto_n as usize).min(automation::BUS_BINDINGS)], s.group, |slot, p, value| {
                        if slot < count {
                            effects[slot].automate(p, value);
                        }
                    });
                }
            }
            {
                let (l, r) = s.buf.split_at_mut(QUANTUM);
                run_chain(&mut s.effects[..(s.count as usize).min(SUBMIX_EFFECTS)], fxdata, l, r, &mut fuel);
            }
            // A tail still sounding (a delay, a reverb) keeps the slot running.
            if s.buf.iter().any(|x| x.abs() > TAIL_FLOOR) {
                s.quiet = 0;
            }
            out.copy_from_slice(&s.buf);
            s.buf = [0.0; 2 * QUANTUM];
            let (bus, to) = (s.bus, s.out as usize);
            let (l, r) = out.split_at(QUANTUM);
            if to != 0 && v.slots[to - 1].used != 0 {
                // Into the level above (rendered later: it is shallower).
                let p = &mut v.slots[to - 1];
                p.fed = 1;
                for (d, x) in p.buf.iter_mut().zip(out.iter()) {
                    *d += *x;
                }
            } else if let Some((dl, dr)) = inputs.get(bus) {
                for j in 0..QUANTUM {
                    dl[j] += l[j];
                    dr[j] += r[j];
                }
            }
        }
    }
}

/// Runs `effects` in order on one block, each on its effect memory (the kind dispatch is
/// `audio_dsp::fx::Effect::process`: see the module comment); a plugin effect through the import,
/// drawing on the level's `fuel` (ABI 5.0, `ext.rs`).
fn run_chain(effects: &mut [SubmixEffect], fxdata: &mut [f32], l: &mut [f32], r: &mut [f32], fuel: &mut crate::ext::Fuel) {
    let ctx = Ctx::default();
    for e in effects.iter_mut() {
        if e.on == 0 || e.kind == kind::NONE {
            continue;
        }
        if kind::plugin(e.kind).is_some() {
            crate::ext::process(e, l, r, fuel);
            continue;
        }
        let mem = crate::fxmem::slice(fxdata, e);
        e.process(mem, l, r, &ctx);
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
        // ABI 5.0 (ADR 0338): 16 parameters an effect made it ≈ 409 KB (≈ 360 KB before).
        assert!(REGION_BYTES < 440 << 10, "{REGION_BYTES}");
        assert_eq!(route_code(None, 3, 5), 5);
        // SAFETY: all-zero is a valid Header.
        let mut h: Header = unsafe { core::mem::zeroed() };
        h.route[3] = 7;
        h.route_bus[3] = 5;
        assert_eq!(route_code(Some(&h), 3, 5), ROUTE_SUBMIX | 6);
        assert_eq!(route_code(Some(&h), 3, 2), 2, "another bus of the instance");
        assert_eq!(route_code(Some(&h), 4, 5), 5);
    }
}
