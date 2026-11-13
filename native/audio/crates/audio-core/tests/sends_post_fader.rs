//! Rv1 (0171/0172 M5, ADR 0172 owner decision 1; architecture §4.5 "Post-fader sends", §3.3 and
//! §4.7 "Last reverb send removed"; R11): the bus reverb send is post-fader, and the shared
//! convolver runs out after the last send is removed, then resets.
//!
//! - **Post-fader** (`sends::feed`): a bus's reverb contribution (the 1 KB scratch `fx.process`
//!   writes) is multiplied by the bus's gain for the quantum (`lanes::apply`'s `Gain`: all seven
//!   lanes) before it joins the convolver input. A muted, dipped, monitor-muted, faded or ducked
//!   bus stops feeding (or feeds scaled); a settled gain of 1 (`Gain::Unity`) skips the multiply,
//!   bit-identical with the pre-fader send.
//! - **The run-out** (`sends::convolver_should_run`, `sends::run_out_quanta`): with no send left
//!   the convolver keeps running on silent input until that input has been silent for more than
//!   the IR's length in quanta plus `zones::IDLE_MARGIN_QUANTA`, then resets (histories cleared,
//!   clock restarted) and stops; a later send replays nothing stale.
//!
//! Leaf L-Rv1a fills the cases below (each `#[ignore]` until filled). The golden
//! (`golden/m5/bus-mute-send.json`) and the click check are the lead's, in
//! `sends_post_fader_golden.rs`.

mod common;

#[allow(unused_imports)]
use audio_core::lanes::Gain;
#[allow(unused_imports)]
use audio_core::{sends, zones, QUANTUM};
#[allow(unused_imports)]
use audio_wire::generated as wire;
#[allow(unused_imports)]
use common::*;

/// A zeroed send area (all-zero is valid: an empty scratch, no tail to ring out).
#[allow(dead_code)]
fn send_area() -> Box<sends::SendArea> {
    // SAFETY: all-zero is a valid SendArea.
    Box::new(unsafe { core::mem::zeroed() })
}

// --- `feed`, unit level ------------------------------------------------------------------------

/// L-Rv1a: `Gain::Unity` adds the scratch into the convolver input bit for bit as `rev + x`
/// (no multiply; NaN payloads and -0.0 kept), and clears the scratch.
#[test]
#[ignore = "L-Rv1a"]
fn a_settled_unity_gain_is_bit_identical_with_the_pre_fader_send() {}

/// L-Rv1a: `Gain::Scalar(g)` adds `x·g` (exactly the f32 product), `Gain::Scalar(0.0)` adds
/// nothing (the input is unchanged bit for bit), and both clear the scratch.
#[test]
#[ignore = "L-Rv1a"]
fn a_scalar_gain_scales_the_send_and_zero_adds_nothing() {}

/// L-Rv1a: `Gain::Curve` adds `x[i]·curve[i]` frame by frame (left and right alike), and clears
/// the scratch.
#[test]
#[ignore = "L-Rv1a"]
fn a_curve_gain_scales_the_send_frame_by_frame() {}

// --- Post-fader through the core ---------------------------------------------------------------
// A bus with a reverb send (`fx::kind::REVERB_SEND`) and a voice on it: with the bus's gain at 0
// its dry path is silent, so the output is the reverb's wet signal alone.

/// L-Rv1a: a bus muted on its `runtime` lane (settled at 0 before the voice starts) never feeds
/// the reverb: the output is exactly 0 for many quanta (more than the IR's head). **Fails before
/// Rv1** (the pre-fader send fed the reverb whatever the gain): say so in the report.
#[test]
#[ignore = "L-Rv1a"]
fn a_muted_bus_stops_feeding_the_reverb() {}

/// L-Rv1a: the same with the `dip` lane at 0 (the structural dip), and with the `monitor` lane at
/// 0 (a monitor mute), and with the `authored` lane at 0: no wet output.
#[test]
#[ignore = "L-Rv1a"]
fn a_dipped_or_monitor_muted_bus_stops_feeding_the_reverb() {}

/// L-Rv1a: a bus faded to 0.5 (`runtime` lane, settled) feeds the reverb at half: its wet output
/// (the dry path removed, e.g. a second core whose bus has no send, subtracted) is 0.5 × the wet
/// output of the same scene at gain 1, to f32 rounding (the convolver is linear).
#[test]
#[ignore = "L-Rv1a"]
fn a_faded_bus_feeds_the_reverb_scaled_by_its_gain() {}

// --- The run-out -------------------------------------------------------------------------------

/// L-Rv1a: `run_out_quanta` of the core's `Reverb` region is ceil(IR frames / 128) +
/// `zones::IDLE_MARGIN_QUANTA` (the IR is `audio_dsp::convolver::ir::frames(rate)` frames), and 0
/// for a region with no prepared response.
#[test]
#[ignore = "L-Rv1a"]
fn the_run_out_lasts_the_ir_length_plus_the_idle_margin() {}

/// L-Rv1a: `convolver_should_run` on a zeroed area and a real reverb region: false while no send
/// ever existed; true while `has_reverb` or `sent`; after both go false, true for exactly
/// `run_out_quanta` more calls, then false (and `head.live` 0) from the next one on.
#[test]
#[ignore = "L-Rv1a"]
fn the_convolver_runs_out_then_stops() {}

/// L-Rv1a: through the core, a bus with a send and a voice; BUS_CONFIG then removes the send (the
/// voice keeps playing dry): the wet tail goes on after the removal (the output differs from the
/// dry-only level for quanta after it, decaying), then is exactly the dry level once the run-out
/// ends. **Fails before Rv1** (the convolver stopped at once, cutting the tail).
#[test]
#[ignore = "L-Rv1a"]
fn removing_the_last_send_rings_the_tail_out() {}

/// L-Rv1a: after the run-out ended, a later send (the send re-added by BUS_CONFIG) gives exactly
/// the output of a fresh core given the same send and voice from that point: nothing stale is
/// replayed. **Fails before Rv1** (the frozen tail replayed).
#[test]
#[ignore = "L-Rv1a"]
fn a_later_send_replays_nothing_stale() {}

/// L-Rv1a: a send re-added during the run-out (before the reset) continues the tail rather than
/// restarting it: with the voice stopped before the removal, the output equals that of a core
/// whose send was never removed (its bus silent, so the convolver input is zero either way), bit
/// for bit (no reset mid-tail).
#[test]
#[ignore = "L-Rv1a"]
fn a_send_during_the_run_out_keeps_the_tail() {}
