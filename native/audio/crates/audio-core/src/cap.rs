//! The adaptive mixed-voice cap in the core (ADR 0157 A3.3; architecture §6.3, §8; api-and-models
//! §4.3 `mixedCap`, `demoted`, flag bit3).
//!
//! Once per quantum, after the render (`Core::process`), [`after_render`]:
//! 1. **Models the quantum's work units** (§8: 1 WU ≈ 1 ns on the reference machine) from what the
//!    render reported: mixed and virtual voices (`counters.mixed_voices`, `live_voices`), HRTF voices
//!    (`hrtf_voices`, H3), each configured bus with its effects and snapshot low-pass, the shared
//!    reverb while a bus sends to it, the limiter, and the records the last batches carried. The
//!    coefficients are the named constants in [`wu`]; `Core::work_units` returns the total, which
//!    STATUS carries as `workUnits` / `workUnitsMax`.
//! 2. **Takes the p99 over a 250 ms window** without storing the window: the `k` largest values,
//!    where `k = ⌊n/100⌋ + 1` for the window's `n` quanta (94 at 48 kHz, so the max; 4th largest at
//!    192 kHz).
//! 3. **Gathers the feedback signals**: underruns the shell's probe counted (it calls
//!    `myco_audio_note_underruns` with its running total; the probe lives in the shell because only
//!    it has the wall clock), and qualifying late commands: `lateCommands` went up while a batch
//!    with negative slack (`firstFrame` behind `currentFrame` on arrival, `minSlackFrames < 0`)
//!    arrived **on time**, its `firstFrame` within 2× the average gap of the previous one
//!    ([`note_batch`], called by `scheduler::submit`). A late batch after a gap is main's stall, not
//!    the core's load, and doesn't count.
//! 4. **Steps the controller** (`cap_controller.rs`) and reports `mixedCap` and flag bit3 ("adaptive
//!    cap active", the cap below `voices.mixed`) through the counters (K12).
//! 5. **Demotes**: while the cap is below the configured value and more voices are mixed than it
//!    allows, the core demotes the lowest-`score` mixed voices itself ([`demote_lowest`]: one pass
//!    over the slots, then A3.1's `voices::demote` for each, at most 64 a quantum), 5 ms fades,
//!    reported in STATUS `demoted`; main's selection then runs at
//!    `min(voices.mixed, mixedCap)` and never re-promotes against it. At the configured cap the
//!    core enforces nothing (main's selection owns the count, as before A3.3), so normal output is
//!    unchanged.
//!
//! The state is a plain field of `Core` (not a region: nothing here is shared with main). Nothing
//! here allocates; the per-quantum cost is a pass over the configured buses (at most 32) and a few
//! comparisons, plus [`demote_lowest`]'s pass over the slots only while voices must be demoted.

use crate::cap_controller::{CapConfig, CapController, Change, Signals, WINDOW_MS};
use crate::core::Core;
use crate::counters::flag;
use crate::{bus, fx, status, voices, QUANTUM};

/// Work-unit coefficients (architecture §6.1's table, in ns at 1 WU ≈ 1 ns). Estimates until A3.5's
/// lab run freezes them.
///
/// **Re-measuring** (A3.5, after A3.6's 4-point resampler): render a fixed scene in Node wasm and
/// natively (≥ 5 runs × 60 s after a 5 s warm-up, §6.5) at several mixed counts with everything else
/// fixed, fit the per-quantum wall time against the count, and put the slope in
/// [`wu::MIXED_VOICE`] (and the pitch slope, below); likewise virtual voices, a bus, each effect
/// kind and the reverb from scenes that vary only that term. Then [`NS_PER_WU`] stays 1 and the
/// budget stays 1.3 ms, so the model's totals read as reference-machine nanoseconds.
pub mod wu {
    /// A mixed voice at pitch ≤ 1 (§6.1: 1.15 µs with the linear resampler, from the README's 0.31 ms
    /// for 256). A3.6's 4-point resampler is estimated at 1.6–2.3 µs: A3.5 re-measures this.
    /// Cost also grows with pitch (each voice reads pitch × 128 source frames); the render doesn't
    /// report a pitch sum yet, so the model counts every mixed voice at pitch 1 (see the report).
    pub const MIXED_VOICE: u32 = 1_150;
    /// A virtual voice keeping time (§6.1: ≈ 0.008 µs).
    pub const VIRTUAL_VOICE: u32 = 8;
    /// An HRTF-panned voice on top of its mixed cost (§6.1: 6.6 µs static; 10.4 crossfading).
    pub const HRTF_VOICE: u32 = 6_600;
    /// A configured bus: its gain ramp, mix into the parent and meter (§6.1: ≈ 1–2 µs).
    pub const BUS: u32 = 1_500;
    /// A biquad on a bus: lowpass, highpass, or the snapshot low-pass while on (§6.1: ≈ 0.5 µs).
    pub const BIQUAD: u32 = 500;
    /// A bus compressor (§6.1: 3–6 µs, est.).
    pub const COMPRESSOR: u32 = 4_500;
    /// A reverb send tap (a multiply-add into the shared input).
    pub const REVERB_SEND: u32 = 150;
    /// The shared 1.8 s convolver while a bus sends to it (§6.1: ≈ 0.07 ms average).
    pub const REVERB: u32 = 70_000;
    /// The master limiter (§6.1: ≈ 5 µs, est.).
    pub const LIMITER: u32 = 5_000;
    /// One record applied (parse, schedule, apply; est.).
    pub const RECORD: u32 = 100;
}

/// k, the lab constant per build: nanoseconds of reference-machine time per work unit (§6.3's µs
/// per WU × 1,000). 1 by definition until A3.5 measures otherwise.
pub const NS_PER_WU: u32 = 1;
/// The fixed per-quantum budget (§6.1, the ADR's 1.3 ms) in work units: 1.3 ms ÷ k.
pub const BUDGET_WU: u32 = 1_300_000 / NS_PER_WU;

/// Most of a window's largest values kept for its p99 (`k = ⌊n/100⌋ + 1`, 4 at 192 kHz).
const TOP_MAX: usize = 8;

/// Batches whose gaps must be seen before "on time" means anything.
const GAPS_BEFORE_ON_TIME: u32 = 2;
/// The gap average's EMA weight (as main's Δ̄, architecture §4.3).
const GAP_EMA: f64 = 0.1;

/// The adaptive cap's state, a field of [`Core`]. Build with [`CapState::new`].
#[derive(Clone, Copy, Debug)]
pub struct CapState {
    cfg: CapConfig,
    ctl: CapController,
    /// The window's length in quanta and its quanta so far.
    window_quanta: u32,
    window_count: u32,
    /// The window's largest work units, largest first (`top_len` of them).
    top: [u32; TOP_MAX],
    top_len: u32,
    /// The last window's p99.
    last_p99: u32,
    /// The last quantum's work units.
    last_wu: u32,
    /// The shell's underrun total as last noted, and whether it rose since the last step.
    underruns_total: u32,
    underrun_pending: bool,
    /// `lateCommands` as of the last step.
    late_seen: u32,
    /// A late command qualifies while the frame is below this (an on-time batch with negative slack
    /// arms it for one window).
    late_armed_until: u64,
    /// The previous batch's `firstFrame`, the gap average, and how many gaps were seen.
    last_first_frame: f64,
    gap_avg: f64,
    gaps: u32,
    batches: u32,
    /// Records carried by batches since the last quantum (their apply cost goes in its WU).
    pending_records: u32,
    /// Cumulative: decreases, increases, and voices the cap demoted (tests and a debugger).
    pub decreases: u32,
    pub increases: u32,
    pub demoted: u32,
}

impl CapState {
    /// At the configured cap (`max_mixed`), calm, with the fixed [`BUDGET_WU`].
    pub fn new(configured: u32, sample_rate: f32) -> CapState {
        CapState::with_budget(configured, sample_rate, BUDGET_WU)
    }

    /// As [`CapState::new`] with another work-unit budget (tests: a low ceiling stands in for load).
    pub fn with_budget(configured: u32, sample_rate: f32, budget: u32) -> CapState {
        let cfg = CapConfig::at_rate(configured, sample_rate, budget);
        let window_frames = crate::cap_controller::ms_to_frames(WINDOW_MS, sample_rate);
        let window_quanta = window_frames.div_ceil(QUANTUM as u64).max(1) as u32;
        CapState {
            cfg,
            ctl: CapController::new(&cfg, 0),
            window_quanta,
            window_count: 0,
            top: [0; TOP_MAX],
            top_len: 0,
            last_p99: 0,
            last_wu: 0,
            underruns_total: 0,
            underrun_pending: false,
            late_seen: 0,
            late_armed_until: 0,
            last_first_frame: 0.0,
            gap_avg: 0.0,
            gaps: 0,
            batches: 0,
            pending_records: 0,
            decreases: 0,
            increases: 0,
            demoted: 0,
        }
    }

    /// The current cap.
    pub fn cap(&self) -> u32 {
        self.ctl.cap()
    }

    /// The configured cap and budget.
    pub fn config(&self) -> &CapConfig {
        &self.cfg
    }

    /// The last quantum's modelled work units.
    pub fn work_units(&self) -> u32 {
        self.last_wu
    }

    /// The last complete window's work-unit p99.
    pub fn last_p99(&self) -> u32 {
        self.last_p99
    }

    /// Sets the work-unit budget (tests and a lab harness; production keeps [`BUDGET_WU`]).
    pub fn set_budget(&mut self, budget: u32) {
        self.cfg.budget = budget;
    }

    /// `k` for a window of `n` quanta: the p99 is the `k`th largest.
    fn rank(n: u32) -> usize {
        ((n / 100) as usize + 1).min(TOP_MAX)
    }

    /// Adds one quantum's work units to the window; at its end returns the p99 and starts the next.
    fn push_window(&mut self, units: u32) -> Option<u32> {
        let k = CapState::rank(self.window_quanta);
        // Insert into the largest-first top-k.
        let len = self.top_len as usize;
        if len < k || units > self.top[len - 1] {
            let mut at = len.min(k - 1);
            if len < k {
                self.top_len += 1;
            }
            while at > 0 && self.top[at - 1] < units {
                self.top[at] = self.top[at - 1];
                at -= 1;
            }
            self.top[at] = units;
        }
        self.window_count += 1;
        if self.window_count < self.window_quanta {
            return None;
        }
        let p99 = self.top[(self.top_len as usize).min(k) - 1];
        self.window_count = 0;
        self.top_len = 0;
        self.last_p99 = p99;
        Some(p99)
    }
}

/// `myco_audio_note_underruns`: the shell's probe's running total (architecture §4.7). A change
/// since the last note is an underrun signal for the next quantum (a lower total, from a restarted
/// probe, is just taken as the new base).
pub fn note_underruns(core: &mut Core, total: u32) {
    let s = core.cap_mut();
    if total > s.underruns_total {
        s.underrun_pending = true;
    }
    s.underruns_total = total;
}

/// Called by `scheduler::submit` for every accepted BATCH or REPLAY: its `firstFrame`, slack and
/// record count. A batch with negative slack that arrived on time (its `firstFrame` within 2× the
/// average gap after the previous one) arms the late signal for one window.
pub fn note_batch(core: &mut Core, first_frame: f64, records: u32) {
    let current = status::counters(core).current_frame;
    let window = core.cap().window_quanta as u64 * QUANTUM as u64;
    let s = core.cap_mut();
    s.pending_records = s.pending_records.saturating_add(records);
    if s.batches > 0 {
        let gap = (first_frame - s.last_first_frame).max(0.0);
        let on_time = s.gaps >= GAPS_BEFORE_ON_TIME && gap <= 2.0 * s.gap_avg;
        if first_frame < current && on_time {
            s.late_armed_until = current as u64 + window;
        }
        s.gap_avg = if s.gaps == 0 { gap } else { s.gap_avg + GAP_EMA * (gap - s.gap_avg) };
        s.gaps = s.gaps.saturating_add(1);
    }
    s.last_first_frame = first_frame;
    s.batches = s.batches.saturating_add(1);
}

/// The quantum's modelled work units (see [`wu`]).
fn model(core: &Core, records: u32) -> u32 {
    let c = status::counters(core);
    let mixed = c.mixed_voices as u64;
    let live = c.live_voices as u64;
    let mut units = mixed * wu::MIXED_VOICE as u64 + live.saturating_sub(mixed) * wu::VIRTUAL_VOICE as u64 + c.hrtf_voices as u64 * wu::HRTF_VOICE as u64;
    let count = bus::count(core);
    for slot in bus::slots(core).iter().take(count) {
        units += wu::BUS as u64;
        if fx::lowpass_on(slot.lp.value) || fx::lowpass_on(slot.lp.target) {
            units += wu::BIQUAD as u64;
        }
        for kind in slot.fx.kinds() {
            units += match kind {
                fx::kind::LOWPASS | fx::kind::HIGHPASS => wu::BIQUAD,
                fx::kind::COMPRESSOR => wu::COMPRESSOR,
                fx::kind::REVERB_SEND => wu::REVERB_SEND,
                _ => 0,
            } as u64;
        }
    }
    if bus::area(core).has_reverb != 0 {
        units += wu::REVERB as u64;
    }
    units += wu::LIMITER as u64 + records as u64 * wu::RECORD as u64;
    units.min(u32::MAX as u64) as u32
}

/// After the render of the quantum at `frame` (called by `Core::process`): models its work units,
/// steps the controller, reports `mixedCap` and flag bit3, and demotes when the cap requires it.
/// Never allocates.
pub fn after_render(core: &mut Core, frame: u64) {
    let records = core.cap().pending_records;
    let units = model(core, records);
    let (late_total, mixed_now) = {
        let c = status::counters(core);
        (c.late_commands, c.mixed_voices as u32)
    };
    let s = core.cap_mut();
    s.pending_records = 0;
    s.last_wu = units;
    let wu_p99 = s.push_window(units);
    let late = late_total != s.late_seen && frame < s.late_armed_until;
    s.late_seen = late_total;
    let signals = Signals { underrun: s.underrun_pending, late, wu_p99 };
    s.underrun_pending = false;
    let cfg = s.cfg;
    let change = s.ctl.step(&cfg, frame, signals);
    match change {
        Change::Decreased => s.decreases += 1,
        Change::Increased => s.increases += 1,
        Change::None => {}
    }
    let cap = s.ctl.cap();
    let active = s.ctl.active(&cfg);
    let c = status::counters_mut(core);
    c.mixed_cap = cap.min(u16::MAX as u32) as u16;
    c.set_flag(flag::ADAPTIVE_CAP_ACTIVE, active);
    // `mixed_voices` counts the voices rendered mixed this quantum (fading-out ones too), a cheap
    // upper bound; `demote_lowest` counts exactly and demotes only past the cap.
    if active && (mixed_now > cap || change == Change::Decreased) {
        let n = demote_lowest(core, cap);
        core.cap_mut().demoted += n;
    }
}

/// Most voices demoted in one quantum; a larger excess finishes over the next quanta.
pub const DEMOTES_PER_QUANTUM: usize = 64;

/// Demotes the lowest-`score` mixed voices (started or not, not already fading out) until at most
/// `keep` remain, at most [`DEMOTES_PER_QUANTUM`] this quantum; returns how many. One pass over the
/// slots (`voices::slots`) keeps the lowest scores in a bounded max-heap on the stack, then each is
/// demoted with `voices::demote` (O(1) by id; its 5 ms fade, STATUS `demoted`). Same choice as
/// `voices::demote_lowest` (up to ties), whose O(demoted × live) walk measured about 1 ms natively
/// for 39 demotes among 4,096 live voices, too long for the quantum that must shed load.
pub fn demote_lowest(core: &mut Core, keep: u32) -> u32 {
    use voices::{flag as vf, state as vs};
    let mut heap = [(0f32, 0u32); DEMOTES_PER_QUANTUM];
    let mut len = 0usize;
    let mut mixed = 0u32;
    for s in voices::slots(core) {
        if (s.state != vs::SCHEDULED && s.state != vs::PLAYING) || s.flags & vf::MIXED == 0 || s.flags & vf::DEMOTING != 0 {
            continue;
        }
        mixed += 1;
        if len < DEMOTES_PER_QUANTUM {
            // Push and sift up (largest score at the root).
            let mut at = len;
            heap[at] = (s.score, s.id);
            len += 1;
            while at > 0 && heap[(at - 1) / 2].0 < heap[at].0 {
                heap.swap(at, (at - 1) / 2);
                at = (at - 1) / 2;
            }
        } else if s.score < heap[0].0 {
            // Replace the largest kept and sift down.
            heap[0] = (s.score, s.id);
            let mut at = 0;
            loop {
                let (l, r) = (2 * at + 1, 2 * at + 2);
                let mut big = at;
                if l < len && heap[l].0 > heap[big].0 {
                    big = l;
                }
                if r < len && heap[r].0 > heap[big].0 {
                    big = r;
                }
                if big == at {
                    break;
                }
                heap.swap(at, big);
                at = big;
            }
        }
    }
    let excess = (mixed.saturating_sub(keep) as usize).min(len);
    if excess == 0 {
        return 0;
    }
    // The `excess` lowest of the kept: sort the few kept ascending (insertion sort, at most 64).
    let kept = &mut heap[..len];
    for i in 1..kept.len() {
        let mut j = i;
        while j > 0 && kept[j - 1].0 > kept[j].0 {
            kept.swap(j - 1, j);
            j -= 1;
        }
    }
    let mut demoted = 0;
    for &(_, id) in kept[..excess].iter() {
        if !voices::demote(core, id) {
            break; // the block's `demoted` list is full: the rest next quantum
        }
        demoted += 1;
    }
    demoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_is_250_ms_of_quanta_and_its_p99_the_kth_largest() {
        let s = CapState::new(128, 48_000.0);
        assert_eq!(s.window_quanta, 94, "12,000 frames, rounded up to whole quanta");
        assert_eq!(CapState::rank(94), 1, "p99 of 94 values is the max");
        let mut s = CapState::new(128, 192_000.0);
        assert_eq!(s.window_quanta, 375);
        assert_eq!(CapState::rank(375), 4, "p99 of 375 values is the 4th largest");
        // 371 quanta at 10, and 300, 100, 400, 200 scattered: the 4th largest is 100.
        let mut p99 = None;
        for q in 0..375u32 {
            let units = match q {
                7 => 300,
                50 => 100,
                123 => 400,
                300 => 200,
                _ => 10,
            };
            p99 = s.push_window(units);
            if q < 374 {
                assert_eq!(p99, None);
            }
        }
        assert_eq!(p99, Some(100));
        assert_eq!(s.last_p99(), 100);
        // The next window starts empty.
        for _ in 0..374 {
            assert_eq!(s.push_window(5), None);
        }
        assert_eq!(s.push_window(5), Some(5));
    }
}
