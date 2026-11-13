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
//! `bus_order::compute` reads). Dp1 (W4): presence ([`on_presence`], [`gain`], `status`'s (stage B)
//! `busDuck` section). Sc1 (W6): level mode ([`detect`], `audio_dsp::sidechain`).
//!
//! Nothing here allocates; [`detect`] and [`gain`] run inside `process`.

use crate::core::Core;
use crate::QUANTUM;

/// The pre-fader tap (ARCH §4.6, record change 25): bus `bus`'s quantum `l`, `r` after its
/// effects and snapshot low-pass, before every lane (so monitoring never changes a duck). Called
/// by `bus::mixdown` for every bus in mix order, so a level rule's trigger is detected before its
/// target mixes (B3's order). K1: a no-op. Sc1: feeds the bus's detectors (peak or RMS, per
/// sample) when it triggers a level rule.
#[inline]
pub fn detect(_bus: usize, _l: &[f32], _r: &[f32]) {}

/// The `duck` lane of bus `bus` for this quantum: writes the per-frame gain into `curve` and
/// returns `true`, or returns `false` when the lane is at identity (no rule targets the bus, or
/// its duck gain is a settled 1), and the gain stage then **skips** the lane (R3; `lanes::apply`'s
/// `duck` is `None`). K1: always `false` (and `curve` untouched). Dp1: presence rules, the min
/// over the bus's rules, attack and release per quantum interpolated per sample; Sc1 adds level
/// rules to the min.
#[inline]
pub fn gain(_bus: usize, _curve: &mut [f32; QUANTUM]) -> bool {
    false
}

/// `true` when a `BUS_DUCK` record (0x19, API §4.2) at `msg[off..off + len]` holds its `ruleCount`
/// items of 24 B. K1: `true` (the scheduler checks the fixed length); B3 fills it.
pub fn rules_is_well_formed(_msg: &[u8], _off: usize, _len: usize) -> bool {
    true
}

/// `BUS_DUCK` (0x19, API §4.2): replaces the rule table (asap). Recomputes the bus order
/// (`bus_order::compute`, level edges only). K1: a stub that ignores the record and counts
/// nothing. B3: stores and validates the rules (inert rules, the 32 / 8 limits) and re-runs the
/// order; Dp1 and Sc1 read them.
pub fn on_rules(_core: &mut Core, _msg: &[u8], _off: usize) {}

/// `BUS_PRESENCE` (0x1A, 16 B, API §4.2): `u32 mask`, one bit per trigger slot with a voice,
/// applying at the start of the quantum holding its frame (`at`: `None` asap, `Some(frame)`
/// stamped). K1: a stub that ignores the record and counts nothing. Dp1 fills it (B2's pending
/// queue holds stamped configuration records).
pub fn on_presence(_core: &mut Core, _msg: &[u8], _off: usize, _at: Option<u64>) {}

/// RESET: clears detector and follower state (the rules stay: they are main's intent, re-sent by
/// the replay). K1: a no-op; Dp1 and Sc1 fill it.
pub fn reset(_core: &mut Core) {}
