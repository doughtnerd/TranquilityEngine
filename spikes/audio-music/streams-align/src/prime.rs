//! Prototype of the main-side PRIME planner (spike S1, question 2). No core change: priming is "open the streams
//! early, stamp the PLAYs for a grid frame far enough ahead that every ring holds >= START_FRAMES (4,096) when the
//! quantum containing the stamp starts". The core already supports it: a SCHEDULED stream voice does not bind to its
//! ring or consume from it before its stamp (`voices.rs:380-399` starts a voice only at its stamp;
//! `voices.rs:705-715` WAITING), so a ring primed early just fills (up to 32,768 frames) and idles.

use crate::Q;

/// What priming one segment costs, in frames at the context rate.
#[derive(Clone, Copy, Debug)]
pub struct PrimeCost {
    /// Per stem, in the one decoder worker (serial): fetch (cached or not) + wasm open + seek + decode of the first
    /// 4,096-frame chunk + the postMessage that carries it.
    pub per_stem: u64,
    /// The worker -> worklet delivery tail: the chunk lands between two render callbacks (M1 messaging spike:
    /// one-way p50 1 quantum, p99 4-5 quanta).
    pub tail: u64,
    /// Safety margin on the sum, percent.
    pub margin_pct: u64,
}

/// A fixed-tempo bar grid (the M4 tempo map generalises `next_bar_at_or_after`).
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub origin: u64,
    pub bar_frames: u64,
}

impl Grid {
    /// The first bar line at or after `t`.
    pub fn next_bar_at_or_after(&self, t: u64) -> u64 {
        if t <= self.origin {
            return self.origin;
        }
        self.origin + (t - self.origin).div_ceil(self.bar_frames) * self.bar_frames
    }
}

/// The lead (frames before the stamp) at which `n` stems must be opened: the planner's estimate of when the last ring
/// holds its first chunk, plus one quantum for the commit boundary, plus the margin, never under the PLAY's own
/// lookahead `l` (`lookahead.ts`).
pub fn prime_lead(n: u32, c: &PrimeCost, l: u64) -> u64 {
    let base = n as u64 * c.per_stem + c.tail + Q;
    (base + base * c.margin_pct / 100).max(l)
}

pub struct Plan {
    /// The frame the transition lands on (a bar line).
    pub stamp: u64,
    /// `stamp - now - prime_lead`: slack; 0 for the earliest bar that is feasible.
    pub lead_available: u64,
    /// Bars the transition waits beyond the first bar line after `now`.
    pub bars_deferred: u64,
}

/// The earliest bar line that a segment of `n` stems can be primed for when asked at `now`.
pub fn plan_bar_transition(now: u64, grid: &Grid, n: u32, c: &PrimeCost, l: u64) -> Plan {
    let lead = prime_lead(n, c, l);
    let first = grid.next_bar_at_or_after(now + 1);
    let stamp = grid.next_bar_at_or_after(now + lead);
    Plan { stamp, lead_available: stamp - now - lead, bars_deferred: (stamp - first) / grid.bar_frames }
}
