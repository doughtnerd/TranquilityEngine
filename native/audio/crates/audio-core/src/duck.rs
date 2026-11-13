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
//! `scheduler.rs`. B3 (W3): the rule table ([`on_rules`]: `DuckArea::rules`, `rule_count`,
//! `level_count`, followers carried by key, `detectors[k]` for the k-th level rule), the core's
//! check ([`validate`]: [`FLAG_INERT`]), the late mark ([`FLAG_LATE`]) and the order re-run
//! (`bus_order::rerun`, which reads the level edges). Dp1 and Sc1 find a target's rules with
//! [`DuckArea::rules_for`]. Dp1 (W4): presence ([`on_presence`], [`gain`], [`status`]'s
//! `busDuck` section). Sc1 (W6): level mode ([`detect`], `audio_dsp::sidechain`).
//!
//! Nothing here allocates; [`detect`] and [`gain`] run inside `process`.

use audio_wire::generated as wire;

use crate::bus::BusSlot;
use audio_dsp::sidechain as sc;
use crate::core::Core;
use crate::counters::{BusDuckGain, MixSections};
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
    /// The wire's `DUCK_FLAG_*` bits; plus the core-only [`FLAG_INERT`] and [`FLAG_LATE`] (B3).
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
    /// Late detections (a level rule of a dropped cycle edge read its trigger's previous quantum)
    /// since the last take; [`status`] adds them to `sidechainLate` (Sc1). `process` has no
    /// counters, only this region.
    pub late_pending: u32,
    /// The detectors' per-rate coefficients ([`set_sample_rate`]; Sc1).
    pub coeffs: sc::DetectorCoeffs,
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
///
/// **Sc1.** Each live level rule whose trigger is `bus` runs its own detector (`detectors[k]` for
/// the `k`-th level rule) over the quantum and stores the quantum's level (the envelope at the
/// quantum's end, dB; ARCH §4.6 and S4 both read the end) for [`gain`]. A rule of a dropped cycle
/// edge ([`FLAG_LATE`]) has its target mixed before its trigger, so [`gain`] reads the level this
/// call stored a quantum earlier. With no level rule this is a loop over nothing.
#[inline]
pub fn detect(duck: &mut DuckArea, bus: usize, l: &[f32], r: &[f32]) {
    let levels = (duck.level_count as usize).min(MAX_LEVEL);
    if levels == 0 {
        return;
    }
    let (Ok(l), Ok(r)) = (<&[f32; QUANTUM]>::try_from(l), <&[f32; QUANTUM]>::try_from(r)) else { return };
    let n = (duck.rule_count as usize).min(MAX_RULES);
    let coeffs = duck.coeffs;
    for det in &mut duck.detectors[..levels] {
        let i = det.rule as usize;
        if i >= n {
            continue;
        }
        let rule = duck.rules[i];
        if !rule.is_level() || rule.is_inert() || rule.trigger as usize != bus {
            continue;
        }
        let mut st = sc::DetectorState { env: det.env };
        det.level_db = if rule.is_rms() { sc::detect_rms(&mut st, &coeffs, l, r) } else { sc::detect_peak(&mut st, &coeffs, l, r) };
        det.env = st.env;
        det.late = rule.is_late() as u32;
    }
}

/// The level a detector reads before it has seen a quantum (silence): `detect_*`'s floor, dB.
pub const LEVEL_FLOOR_DB: f32 = -240.0;

/// Sets the detectors' per-rate coefficients (`Core::new` through [`init`], and every `BUS_DUCK`).
pub fn set_sample_rate(duck: &mut DuckArea, sample_rate: f32) {
    duck.coeffs = sc::DetectorCoeffs::new(sample_rate);
}

/// A level rule's goal for this quantum (the gain computer, `sidechain::gain_goal`), from the
/// quantum's level; a non-finite threshold or a NaN result reads as no duck.
#[inline]
fn level_goal(level_db: f32, r: &Rule) -> f32 {
    if !r.threshold_db.is_finite() {
        return 1.0;
    }
    let g = sc::gain_goal(level_db, r.threshold_db, clamp_amount(r.amount));
    if g.is_nan() {
        1.0
    } else {
        g.clamp(0.0, 1.0)
    }
}

/// Moves follower `f` one quantum toward `goal` and folds its per-sample line into `curve` by min
/// (both modes; the law of [`gain`]'s comment). A follower settled at 1 with goal 1 adds nothing.
#[inline]
fn advance(f: &mut Follower, goal: f32, curve: &mut [f32; QUANTUM], any: &mut bool) {
    f.goal = goal;
    let start = f.gain;
    if start == 1.0 && goal == 1.0 {
        return;
    }
    let coef = if goal < start { f.attack_coef } else { f.release_coef };
    let mut end = goal + (start - goal) * coef;
    if (end - goal).abs() < SETTLE {
        end = goal;
    }
    f.gain = end;
    if !*any {
        curve.fill(1.0);
        *any = true;
    }
    let step = (end - start) / QUANTUM as f32;
    for (k, c) in curve.iter_mut().enumerate() {
        let g = if k + 1 == QUANTUM { end } else { start + step * (k + 1) as f32 };
        if g < *c {
            *c = g;
        }
    }
}

/// The `duck` lane of bus `bus` for this quantum: writes the per-frame gain into `curve` and
/// returns `true`, or returns `false` when the lane is at identity (no rule targets the bus, or
/// its duck gain is a settled 1), and the gain stage then **skips** the lane (R3; `lanes::apply`'s
/// `duck` is `None`). Presence rules (Dp1), the min
/// over the bus's rules, attack and release per quantum interpolated per sample; Sc1 adds level
/// rules to the min.
/// `duck` is the duck state ([`area`] of the `Duck` region).
///
/// **Dp1 (presence mode, R4).** Each live presence rule of the bus moves its follower one quantum:
/// the goal is `amount` while the trigger's bit is set in the presence mask, else 1; the end-of-
/// quantum gain is `goal + (gain − goal) × coef` (the attack coefficient falling, the release one
/// rising, [`coefficient`]), and the curve is the straight line from the last quantum's gain to
/// it, per sample. The rules combine by min, per sample. A rule settled at 1 contributes nothing,
/// so a bus whose rules have all released reads identity again.
///
/// **Sc1 (level mode).** Each live level rule of the bus takes its goal from the gain computer
/// on its detector's level (`sidechain::gain_goal`: depth = clamp((level − threshold) / 6 dB, 0,
/// 1), goal = 1 − depth × (1 − amount)) and moves its follower by the same law; it joins the same
/// per-sample min. Under its threshold the goal is exactly 1, so a level rule that never fires
/// leaves the lane at identity (bit-identical to no rule). A late rule ([`FLAG_LATE`]) reads the
/// level [`detect`] stored in the previous quantum and counts one late detection (`sidechainLate`,
/// added at the next take by [`status`]).
pub fn gain(duck: &mut DuckArea, bus: usize, curve: &mut [f32; QUANTUM]) -> bool {
    let n = (duck.rule_count as usize).min(MAX_RULES);
    let presence = duck.presence;
    let mut any = false;
    // `detectors[k]` serves the k-th level rule in rule order (`on_rules`).
    let mut level_k = 0usize;
    for i in 0..n {
        let r = duck.rules[i];
        let k = level_k;
        if r.is_level() {
            level_k += 1;
        }
        if r.is_inert() || r.target as usize != bus {
            continue;
        }
        let goal = if r.is_level() {
            if k >= MAX_LEVEL {
                continue;
            }
            if r.is_late() {
                duck.late_pending = duck.late_pending.saturating_add(1);
            }
            level_goal(duck.detectors[k].level_db, &r)
        } else {
            let on = (r.trigger as u32) < 32 && presence & (1 << r.trigger) != 0;
            if on {
                clamp_amount(r.amount)
            } else {
                1.0
            }
        };
        advance(&mut duck.followers[i], goal, curve, &mut any);
    }
    any
}

/// A follower closer than this to its goal lands on it (≈ −100 dB of the step), so a released
/// duck reaches exactly 1 and the lane returns to identity.
pub const SETTLE: f32 = 1e-5;

/// `amount` as a gain in [0, 1] (a NaN reads as no duck).
#[inline]
fn clamp_amount(a: f32) -> f32 {
    if a.is_nan() {
        1.0
    } else {
        a.clamp(0.0, 1.0)
    }
}

/// The per-quantum one-pole coefficient of a 63 % time constant `seconds` at `sample_rate`:
/// `exp(−QUANTUM / (seconds × sample_rate))`; 0 (a jump) for a zero, negative or non-finite time.
pub fn coefficient(seconds: f32, sample_rate: f32) -> f32 {
    let frames = seconds as f64 * sample_rate as f64;
    if !(frames > 0.0) || !frames.is_finite() {
        return 0.0;
    }
    libm::exp(-(QUANTUM as f64) / frames) as f32
}

/// Sets every kept rule's follower coefficients from its attack and release (after `BUS_DUCK`).
fn set_coefficients(d: &mut DuckArea, sample_rate: f32) {
    let n = (d.rule_count as usize).min(MAX_RULES);
    for i in 0..n {
        let r = d.rules[i];
        d.followers[i].attack_coef = coefficient(r.attack, sample_rate);
        d.followers[i].release_coef = coefficient(r.release, sample_rate);
    }
}

/// The `busDuck` STATUS section (API §4.3) for a take: pushes `{slot, gain}` into
/// `mix.bus_duck` for every bus that is the target of a rule (at most `MAX_DUCK_RULES`), its duck
/// gain at the end of the last quantum. Called by `status::take` before the block is written; a
/// level, so a failed take loses nothing.
///
/// Dp1: one entry per distinct target of a live rule, in rule order, its gain the min of its
/// rules' followers, both modes (Sc1: level rules' followers move).
///
/// Sc1: first adds the late detections counted since the last take (`DuckArea::late_pending`)
/// to `sidechainLate` (saturating), so the counter in this take's block includes them.
pub fn status(core: &mut Core, mix: &mut MixSections) {
    let late = area(&mut core.regions_mut().duck[..]).map_or(0, |d| core::mem::take(&mut d.late_pending));
    if late != 0 {
        let c = &mut crate::status::counters_mut(core).mix;
        c.sidechain_late = c.sidechain_late.saturating_add(late.min(u16::MAX as u32) as u16);
    }
    let Some(d) = area(&mut core.regions_mut().duck[..]) else { return };
    let rules = d.rules();
    for (i, r) in rules.iter().enumerate() {
        if r.is_inert() || rules[..i].iter().any(|o| !o.is_inert() && o.target == r.target) {
            continue;
        }
        let g = d.rules_for(r.target as usize).map(|(j, _)| d.followers[j].gain).fold(1.0f32, f32::min);
        if !mix.bus_duck.push(BusDuckGain { slot: r.target, gain: g }) {
            break;
        }
    }
}

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
    let sample_rate = core.params().sample_rate;
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
            // A new detector starts at silence (a level of 0 dB would duck a late rule's first quantum).
            let det = det.unwrap_or(Detector { level_db: LEVEL_FLOOR_DB, ..Detector::default() });
            d.detectors[levels] = Detector { rule: kept as u16, ..det };
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
    // Dp1: the followers' per-quantum coefficients from the rules' times (kept followers too, so
    // an edit of the times takes effect from the next quantum).
    set_coefficients(d, sample_rate);
    set_sample_rate(d, sample_rate);
    crate::bus_order::rerun(core);
    crate::status::counters_mut(core).mix.duck_rules_dropped = dropped.min(u16::MAX as usize) as u16;
}

/// `BUS_PRESENCE` (0x1A, 16 B, API §4.2): `u32 mask`, one bit per trigger slot with a voice,
/// applying at the start of the quantum holding its frame (`at`: `None` asap, `Some(frame)`
/// stamped). B2's configuration queue holds a stamped record until the quantum holding its frame
/// starts and then calls this, so the mask is in force for that whole quantum (quantum
/// granularity, before any bus mixes). Dp1: replaces the mask in force.
pub fn on_presence(core: &mut Core, msg: &[u8], off: usize, _at: Option<u64>) {
    if off + wire::BusPresence::FIXED_END > msg.len() {
        return;
    }
    let mask = crate::wire_read::u32_at(msg, off + 12);
    if let Some(d) = area(&mut core.regions_mut().duck[..]) {
        d.presence = mask;
    }
}

/// Sets the duck state up after the region is zeroed (`Core::new`, once). K1: a no-op (no rules;
/// all-zero is valid). Sc1: the detectors' per-rate coefficients.
pub fn init(core: &mut Core) {
    let sample_rate = core.params().sample_rate;
    if let Some(d) = area(&mut core.regions_mut().duck[..]) {
        set_sample_rate(d, sample_rate);
    }
}

/// RESET: clears detector and follower state (the rules stay: they are main's intent, re-sent by
/// the replay). Dp1: every voice is gone, so the presence mask clears and each follower settles
/// at 1 (its coefficients kept); each detector's envelope clears (its rule index kept) and its
/// level reads silence ([`LEVEL_FLOOR_DB`]).
pub fn reset(core: &mut Core) {
    let Some(d) = area(&mut core.regions_mut().duck[..]) else { return };
    d.presence = 0;
    let n = (d.rule_count as usize).min(MAX_RULES);
    for f in &mut d.followers[..n] {
        f.gain = 1.0;
        f.goal = 1.0;
    }
    for x in &mut d.detectors {
        *x = Detector { rule: x.rule, level_db: LEVEL_FLOOR_DB, ..Detector::default() };
    }
}
