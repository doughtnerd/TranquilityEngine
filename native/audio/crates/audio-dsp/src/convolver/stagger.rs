// SPDX-License-Identifier: Apache-2.0 OR MIT
//! The stagger planner (ADR 0162 C1, api-and-models §5.2, architecture §4.4): picks each new
//! convolver instance's [`Phase`], so the tail work of several instances (the shared reverb and
//! the zone slots) is spread over the 16-quantum tail cycle by modelled load. It replaces
//! architecture §10's "never share a tail quantum" (0157): keeping transforms apart is only
//! possible up to 4 stereo instances and loads the multiply-adds into squeezed windows, so the
//! objective is the busiest quantum's modelled load instead (convolution spike, finding 4).
//!
//! Ported from the convolution spike's load balancer (`spikes/audio-spatial/convolution/src/conv.rs`,
//! `plan_stagger`, `add_channel`, `modelled_slot_load`), with two changes: instances already
//! running (the shared reverb, running zone slots) are **fixed** and only the new ones are
//! planned; and nothing allocates (it runs in the worklet's `onmessage`, when ZONE_CONFIG starts a
//! slot, on the audio thread).
//!
//! **Model.** Load per quantum slot `s = (k + 1) % 16`, in 4,096-point-transform equivalents: a
//! channel on `(f, i)` puts [`TRANSFORM_WEIGHT`] at slot `f` (forward) and at slot `i` (inverse),
//! and spreads `MAC_WEIGHT * tail_parts` evenly over the slots `f + 1 ..= i - 1` (its partition
//! multiply-adds). Weights from the spike's `examples/micro.rs` (native: 20.7 µs per transform,
//! 1.06 µs per partition multiply-add; the wasm ratio is unmeasured). An instance with no tail
//! partitions runs no tail work and adds nothing.
//!
//! **Search.** The smallest cap, in steps of [`CAP_STEP`] from `floor(20 * total / 16) / 20` up,
//! on any slot's load for which a depth-first search over the new instances' channels (instance
//! order, left then right) finds an assignment; each channel's pairs are tried in order of
//! (resulting peak, resulting sum of squared slot loads, `f`, `i`), and each attempt is bounded by
//! [`NODE_BUDGET`] nodes. The phase only moves **when** work runs, never the block grid, so an
//! instance's output is bit-identical on every valid phase (spike check "staggered ==
//! unstaggered").

use super::instance::{phase_is_valid, Phase};
use super::CYCLE;

/// The most instances one call plans: `MAX_ZONE_SLOTS` (api-and-models §4.6).
pub const MAX_PLANNED: usize = 4;
/// Modelled load of one 4,096-point transform (forward or inverse).
pub const TRANSFORM_WEIGHT: f64 = 1.0;
/// Modelled load of one tail partition's spectrum multiply-add.
pub const MAC_WEIGHT: f64 = 0.055;
/// The cap search's step, in transform equivalents.
pub const CAP_STEP: f64 = 0.05;
/// Search nodes per cap attempt.
pub const NODE_BUDGET: u32 = 20_000;

/// One instance's share of the tail cycle: its phase and its tail partition count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Load {
    pub phase: Phase,
    pub tail_parts: usize,
}

/// Modelled load per slot of `instances` (every phase valid; an invalid phase adds nothing).
pub fn modelled_load(instances: &[Load]) -> [f64; CYCLE as usize] {
    let _ = (instances, phase_is_valid, TRANSFORM_WEIGHT, MAC_WEIGHT);
    todo!("L-C1a")
}

/// The busiest slot's load.
pub fn peak(load: &[f64; CYCLE as usize]) -> f64 {
    let _ = load;
    todo!("L-C1a")
}

/// Plans phases for new instances with `tail_parts[n]` tail partitions each, around the `fixed`
/// instances (which keep their phases), and writes them to `out[..tail_parts.len()]`. Returns
/// `false`, writing nothing, when `tail_parts` is longer than [`MAX_PLANNED`] or than `out`, or a
/// fixed phase is invalid. Every written phase is valid (`f + 2 <= i <= 15` per channel).
/// Deterministic (native and wasm agree); allocates nothing.
pub fn plan_stagger(fixed: &[Load], tail_parts: &[usize], out: &mut [Phase]) -> bool {
    let _ = (fixed, tail_parts, out, CAP_STEP, NODE_BUDGET);
    todo!("L-C1a")
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "L-C1a"]
    fn never_above_the_sequential_peak() {}

    #[test]
    #[ignore = "L-C1a"]
    fn matches_the_spike_with_nothing_fixed() {}

    #[test]
    #[ignore = "L-C1a"]
    fn plans_around_the_shared_reverb_and_running_slots() {}

    #[test]
    #[ignore = "L-C1a"]
    fn refuses_too_many_or_a_short_out() {}
}
