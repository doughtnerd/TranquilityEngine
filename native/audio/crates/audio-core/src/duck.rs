//! The `duck` gain lane: ducking rules in the core (ADR 0171 amended by 0172 §1.1, §1.7, §3.8;
//! architecture §4.6, R4, R5; api-and-models §4.2 `BUS_DUCK`, `BUS_PRESENCE`, §4.3 `busDuck`).
//!
//! **Design.**
//! - **Rules** (`BUS_DUCK`, replace-all, asap): at most `MAX_DUCK_RULES` (32), at most
//!   `MAX_LEVEL_RULES` (8) of them level rules. A rule naming a tombstone or an ancestor trigger is
//!   made inert by the core's own check. A level cycle that reaches the core drops its last edge in
//!   rule order; that rule reads the previous quantum and `sidechainLate` counts it.
//! - **Presence mode** (R4, M5-0): `BUS_PRESENCE` carries one bit per trigger slot, stamped at the
//!   voice start or explicit stop; the gain approaches `amount` or 1.
//! - **Level mode** (M5c): a detector on the trigger's pre-fader signal (peak: instant attack, 10 ms
//!   release; RMS: 10 ms one-pole), a gain computer per quantum, depth = clamp((level dB −
//!   threshold) / 6 dB, 0, 1), goal = 1 − depth × (1 − amount).
//! - **Smoothing:** the duck gain approaches the goal with the rule's attack (falling) and release
//!   (rising) as 63 % one-pole time constants, interpolated per sample.
//! - **Combine:** by min per target, both modes.
//! - Never shed by the ladder (R21).
//!
//! **Who fills what.** K1 (W1): the hooks below, identity bodies, called from `bus.rs` and
//! `scheduler.rs`. B3 (W3): the rule table ([`on_rules`], validation, the level edges
//! `bus_order::compute` reads). Dp1 (W4): presence ([`on_presence`], [`gain`], [`status`]'s
//! `busDuck` section). Sc1 (W6): level mode ([`detect`], `audio_dsp::sidechain`).
//!
//! Nothing here allocates; [`detect`] and [`gain`] run inside `process`.

use audio_wire::generated as wire;

use crate::bus::BusSlot;
use crate::core::Core;
use crate::counters::MixSections;
use crate::QUANTUM;

/// Most rules (`MAX_DUCK_RULES`) and level rules (`MAX_LEVEL_RULES`).
pub const MAX_RULES: usize = wire::MAX_DUCK_RULES as usize;
pub const MAX_LEVEL: usize = wire::MAX_LEVEL_RULES as usize;

/// One stored rule (`BUS_DUCK`'s 24 B item, as B3 validates it). All-zero is an unused entry.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rule {
    pub target: u16,
    pub trigger: u16,
    /// The wire's `DUCK_FLAG_*` bits; B3 may add core-only bits above them (inert, late).
    pub flags: u32,
    pub threshold_db: f32,
    pub amount: f32,
    pub attack: f32,
    pub release: f32,
}

/// Core-only `Rule::flags` bit (above the wire's): the core's check made the rule inert (a
/// tombstone or a bus past the configured count named, the trigger the target itself or one of
/// its ancestors). Re-evaluated at every order re-run ([`validate`]); an inert rule ducks nothing
/// and adds no edge.
pub const FLAG_INERT: u32 = 1 << 31;
/// Core-only `Rule::flags` bit: a level rule whose trigger → target edge the order dropped to break
/// a cycle (the closing edge in rule order): its detector reads the trigger's previous quantum
/// and `sidechainLate` counts each such quantum (Sc1). Set by `bus_order::rerun`.
pub const FLAG_LATE: u32 = 1 << 30;
/// The wire's flag bits the core keeps (`DUCK_FLAG_LEVEL`, `DUCK_FLAG_RMS`); others are cleared.
const WIRE_FLAGS: u32 = wire::DUCK_FLAG_LEVEL | wire::DUCK_FLAG_RMS;

impl Rule {
    /// A level rule (`DUCK_FLAG_LEVEL`); otherwise a presence rule.
    #[inline]
    pub fn is_level(&self) -> bool {
        self.flags & wire::DUCK_FLAG_LEVEL != 0
    }
    /// An RMS detector (`DUCK_FLAG_RMS`; level rules only), else peak.
    #[inline]
    pub fn is_rms(&self) -> bool {
        self.flags & wire::DUCK_FLAG_RMS != 0
    }
    /// Made inert by the core's check ([`FLAG_INERT`]).
    #[inline]
    pub fn is_inert(&self) -> bool {
        self.flags & FLAG_INERT != 0
    }
    /// Reads its trigger a quantum late ([`FLAG_LATE`]).
    #[inline]
    pub fn is_late(&self) -> bool {
        self.flags & FLAG_LATE != 0
    }
    /// Sets or clears [`FLAG_INERT`].
    #[inline]
    pub fn set_inert(&mut self, on: bool) {
        self.flags = if on { self.flags | FLAG_INERT } else { self.flags & !FLAG_INERT };
    }
    /// Sets or clears [`FLAG_LATE`].
    #[inline]
    pub fn set_late(&mut self, on: bool) {
        self.flags = if on { self.flags | FLAG_LATE } else { self.flags & !FLAG_LATE };
    }
    /// The same rule for a follower's purposes: target, trigger and mode.
    #[inline]
    fn same_key(&self, o: &Rule) -> bool {
        self.target == o.target && self.trigger == o.trigger && self.is_level() == o.is_level()
    }
}

/// One rule's gain follower (Dp1, Sc1). All-zero valid (B3/Dp1 start it at 1).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Follower {
    /// The rule's gain at the end of the last quantum.
    pub gain: f32,
    /// The goal the gain approaches.
    pub goal: f32,
    /// Per-quantum one-pole coefficients (attack falling, release rising) from the rule's times.
    pub attack_coef: f32,
    pub release_coef: f32,
}

/// One level rule's detector on its trigger's pre-fader signal (Sc1). All-zero valid.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Detector {
    /// The rule it serves (index into `rules`).
    pub rule: u16,
    pub _pad: u16,
    /// Peak envelope or RMS mean square, per sample.
    pub env: f32,
    /// The level of the last quantum, dB (the gain computer's input).
    pub level_db: f32,
    /// The quantum's level is from the previous quantum (a dropped cycle edge, `sidechainLate`).
    pub late: u32,
}

/// The `Duck` region (ARCH §6): the rule table, a follower per rule, a detector per level rule and
/// the presence mask. `#[repr(C)]`, all-zero valid (no rules). Sized from this type, so B3, Dp1 and
/// Sc1 may add fields without editing `layout.rs`. ≈ 1.4 KB.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DuckArea {
    /// Rules in use (`rules[..rule_count]`), from the last `BUS_DUCK` (B3).
    pub rule_count: u32,
    /// Level rules among them (B3).
    pub level_count: u32,
    /// `BUS_PRESENCE`'s mask in force (Dp1).
    pub presence: u32,
    pub _reserved: u32,
    pub rules: [Rule; MAX_RULES],
    pub followers: [Follower; MAX_RULES],
    pub detectors: [Detector; MAX_LEVEL],
}

/// The `Duck` region's size: [`DuckArea`], rounded to a cache line.
pub const REGION_BYTES: usize = (core::mem::size_of::<DuckArea>() + crate::layout::REGION_ALIGN - 1) / crate::layout::REGION_ALIGN * crate::layout::REGION_ALIGN;

const _: () = assert!(core::mem::align_of::<DuckArea>() <= crate::layout::REGION_ALIGN);

/// The duck state in the `Duck` region (`None` when the region is too short, never after `Core::new`).
pub fn area(region: &mut [u8]) -> Option<&mut DuckArea> {
    if region.len() < core::mem::size_of::<DuckArea>() {
        return None;
    }
    // SAFETY: the region is 64-byte aligned (Layout), at least size_of::<DuckArea>() long (checked)
    // and zeroed at init; all-zero is a valid DuckArea (integers and floats). Only this module views
    // these bytes.
    Some(unsafe { &mut *(region.as_mut_ptr() as *mut DuckArea) })
}

impl DuckArea {
    /// The rules in use (`rules[..rule_count]`), inert ones included (check `Rule::is_inert`).
    #[inline]
    pub fn rules(&self) -> &[Rule] {
        &self.rules[..(self.rule_count as usize).min(MAX_RULES)]
    }

    /// The live (not inert) rules that duck bus `target`, with their index into `rules` (and so
    /// into `followers`). Dp1 and Sc1 take the min of their gains.
    #[inline]
    pub fn rules_for(&self, target: usize) -> impl Iterator<Item = (usize, &Rule)> {
        self.rules().iter().enumerate().filter(move |(_, r)| !r.is_inert() && r.target as usize == target)
    }

    /// `true` when some live rule ducks bus `target`.
    #[inline]
    pub fn is_target(&self, target: usize) -> bool {
        self.rules_for(target).next().is_some()
    }
}

/// The core's check (API §4.2): marks each rule of `rules` inert ([`FLAG_INERT`]) or live against
/// the configured tree `slots`, and returns the inert count. A rule is inert when its target or
/// trigger is past the configured buses or a **tombstone**, or its trigger is the target itself
/// or one of the target's ancestors (for both modes; R5's wider cycle check is main's validation,
/// and a cycle among level rules that still reaches the core is `bus_order`'s dropped edge).
///
/// A tombstone is a silent root (R9, no wire sentinel), so the core reads every root but the
/// first (lowest-index) one, which is the master, as a tombstone. Nothing allocates.
pub fn validate(rules: &mut [Rule], slots: &[BusSlot]) -> usize {
    let n = slots.len();
    let first_root = slots.iter().position(|s| s.parent == crate::bus::ROOT);
    let tombstone = |b: usize| slots[b].parent == crate::bus::ROOT && Some(b) != first_root;
    let ancestor = |a: usize, b: usize| {
        // Is `a` an ancestor of `b`? The walk is bounded by n (the tree is repaired; be safe).
        let mut x = slots[b].parent;
        let mut steps = 0;
        while x != crate::bus::ROOT && (x as usize) < n && steps <= n {
            if x as usize == a {
                return true;
            }
            x = slots[x as usize].parent;
            steps += 1;
        }
        false
    };
    let mut inert = 0;
    for r in rules.iter_mut() {
        let (t, g) = (r.trigger as usize, r.target as usize);
        let bad = t >= n || g >= n || t == g || tombstone(t) || tombstone(g) || ancestor(t, g);
        r.set_inert(bad);
        inert += bad as usize;
    }
    inert
}

/// The pre-fader tap (ARCH §4.6, record change 25): bus `bus`'s quantum `l`, `r` after its
/// effects and snapshot low-pass, before every lane (so monitoring never changes a duck). Called
/// by `bus::mixdown` for every bus in mix order, so a level rule's trigger is detected before its
/// target mixes (B3's order). K1: a no-op. Sc1: feeds the bus's detectors (peak or RMS, per
/// sample) when it triggers a level rule.
/// `duck` is the duck state ([`area`] of the `Duck` region).
#[inline]
pub fn detect(_duck: &mut DuckArea, _bus: usize, _l: &[f32], _r: &[f32]) {}

/// The `duck` lane of bus `bus` for this quantum: writes the per-frame gain into `curve` and
/// returns `true`, or returns `false` when the lane is at identity (no rule targets the bus, or
/// its duck gain is a settled 1), and the gain stage then **skips** the lane (R3; `lanes::apply`'s
/// `duck` is `None`). K1: always `false` (and `curve` untouched). Dp1: presence rules, the min
/// over the bus's rules, attack and release per quantum interpolated per sample; Sc1 adds level
/// rules to the min.
/// `duck` is the duck state ([`area`] of the `Duck` region).
#[inline]
pub fn gain(_duck: &mut DuckArea, _bus: usize, _curve: &mut [f32; QUANTUM]) -> bool {
    false
}

/// The `busDuck` STATUS section (API §4.3) for a take: pushes `{slot, gain}` into
/// `mix.bus_duck` for every bus that is the target of a rule (at most `MAX_DUCK_RULES`), its duck
/// gain at the end of the last quantum. Called by `status::take` before the block is written; a
/// level, so a failed take loses nothing. K1: writes nothing (count 0). Dp1 fills it.
pub fn status(_core: &mut Core, _mix: &mut MixSections) {}

/// `true` when a `BUS_DUCK` record (0x19, API §4.2) at `msg[off..off + len]` holds its `ruleCount`
/// items of 24 B (pass 1 of `scheduler::submit`: a malformed record refuses the batch). K1: checks
/// the item count against the length (B3 may add checks; past 32 rules is dropped and counted at
/// apply, not refused).
pub fn rules_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::BusDuck::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = crate::wire_read::u32_at(msg, off + 12) as usize;
    n.checked_mul(wire::BusDuckRules::FIXED_END).is_some_and(|bytes| wire::BusDuck::FIXED_END + bytes <= len)
}

/// `BUS_DUCK` (0x19, API §4.2): replaces the rule table (asap) and re-runs the bus order
/// (`bus_order::rerun`: the core's check, then Kahn with the level edges).
/// - **Limits:** rules are kept in record order up to `MAX_DUCK_RULES` (32); a level rule past the
///   eighth (`MAX_LEVEL_RULES`) is dropped, and so is every rule past 32; the level
///   `duckRulesDropped` counts them. Flags keep the wire's `level` and `rms` bits only.
/// - **Followers and detectors:** a kept rule with the target, trigger and mode of a rule in the
///   previous table keeps that rule's follower (and detector, for a level rule), so an edit of
///   `amount` or the times doesn't jump the gain; a new rule starts at gain 1, goal 1 (Dp1 sets
///   its coefficients). `detectors[k]` serves the `k`-th level rule (`Detector::rule`).
/// - Inert rules (`FLAG_INERT`) and late ones (`FLAG_LATE`) are marked by the re-run.
///
/// The record is well formed (`rules_is_well_formed`). Nothing allocates.
pub fn on_rules(core: &mut Core, msg: &[u8], off: usize) {
    let wanted = crate::wire_read::u32_at(msg, off + 12) as usize;
    let Some(d) = area(&mut core.regions_mut().duck[..]) else { return };
    let old = *d;
    let old_rules = old.rules();
    let mut taken = [false; MAX_RULES];
    let (mut kept, mut levels, mut dropped) = (0usize, 0usize, 0usize);
    for i in 0..wanted {
        let at = off + wire::BusDuck::FIXED_END + i * wire::BusDuckRules::FIXED_END;
        let rule = Rule {
            target: crate::wire_read::u16_at(msg, at),
            trigger: crate::wire_read::u16_at(msg, at + 2),
            flags: crate::wire_read::u32_at(msg, at + 4) & WIRE_FLAGS,
            threshold_db: f32::from_bits(crate::wire_read::u32_at(msg, at + 8)),
            amount: f32::from_bits(crate::wire_read::u32_at(msg, at + 12)),
            attack: f32::from_bits(crate::wire_read::u32_at(msg, at + 16)),
            release: f32::from_bits(crate::wire_read::u32_at(msg, at + 20)),
        };
        if kept == MAX_RULES || (rule.is_level() && levels == MAX_LEVEL) {
            dropped += 1;
            continue;
        }
        let prev = old_rules.iter().enumerate().position(|(j, o)| !taken[j] && o.same_key(&rule));
        d.rules[kept] = rule;
        d.followers[kept] = match prev {
            Some(j) => {
                taken[j] = true;
                old.followers[j]
            }
            None => Follower { gain: 1.0, goal: 1.0, ..Follower::default() },
        };
        if rule.is_level() {
            let det = prev.and_then(|j| old.detectors.iter().find(|x| x.rule as usize == j && old_rules[j].is_level()).copied());
            d.detectors[levels] = Detector { rule: kept as u16, ..det.unwrap_or_default() };
            levels += 1;
        }
        kept += 1;
    }
    for r in &mut d.rules[kept..] {
        *r = Rule::default();
    }
    for f in &mut d.followers[kept..] {
        *f = Follower::default();
    }
    for x in &mut d.detectors[levels..] {
        *x = Detector::default();
    }
    d.rule_count = kept as u32;
    d.level_count = levels as u32;
    crate::bus_order::rerun(core);
    crate::status::counters_mut(core).mix.duck_rules_dropped = dropped.min(u16::MAX as usize) as u16;
}

/// `BUS_PRESENCE` (0x1A, 16 B, API §4.2): `u32 mask`, one bit per trigger slot with a voice,
/// applying at the start of the quantum holding its frame (`at`: `None` asap, `Some(frame)`
/// stamped). K1: a stub that ignores the record and counts nothing. Dp1 fills it (B2's pending
/// queue holds stamped configuration records).
pub fn on_presence(_core: &mut Core, _msg: &[u8], _off: usize, _at: Option<u64>) {}

/// Sets the duck state up after the region is zeroed (`Core::new`, once). K1: a no-op (no rules;
/// all-zero is valid). Dp1 or Sc1 fill it if they need more.
pub fn init(_core: &mut Core) {}

/// RESET: clears detector and follower state (the rules stay: they are main's intent, re-sent by
/// the replay). K1: a no-op; Dp1 and Sc1 fill it.
pub fn reset(_core: &mut Core) {}
