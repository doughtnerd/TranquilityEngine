//! The adaptive mixed-voice cap's controller (ADR 0157 A3.3; architecture §6.3's table), pure: no
//! core, no I/O, no clock of its own. `cap.rs` feeds it the signals once per quantum and acts on the
//! cap it returns (the core's demote, STATUS `mixedCap`).
//!
//! | Element | Rule (architecture §6.3) |
//! |---|---|
//! | Signals | an underrun; a qualifying late command; the modelled work units' p99 over a window, against a fixed budget |
//! | Decrease | any underrun, a qualifying late command, or (model-driven only) p99 > 70% of the budget: cap ← max(16, ⌊0.85·cap⌋), then hold 1 s |
//! | Increase | nothing qualifying (and, model-driven only, p99 < 55%) for 5 s: cap ← min(configured, cap + max(2, configured/32)), once per second |
//!
//! **The work-unit model is informational by default** ([`MODEL_DRIVES_CAP`], owner decision 2026-11-10):
//! the cap moves only on real trouble, underruns and qualifying late commands (whose gate includes negative
//! slack). The owner's 30-minute soak on a fast machine showed why: with the model driving, a machine with zero
//! underruns sat at 184 of 256 voices because the model's p99 stayed in the hold band. With the model driving
//! (`CapConfig::model_drives`), a window between 55% and 70% holds the cap (hysteresis): no decrease, and the
//! 5 s of calm start again.
//! During a hold, signals don't lower the cap further (selection gets time to follow), but they do
//! restart the calm. The floor is 16, or the configured cap when that is lower (the cap never rises
//! above the configured value nor falls below the floor). Time is in frames of the core's clock;
//! [`CapConfig::at_rate`] converts the table's milliseconds.
//!
//! All-zero bytes aren't a meaningful controller; build one with [`CapController::new`]. Nothing
//! here allocates.

/// The cap never falls below this (or the configured cap, when that is lower).
pub const CAP_FLOOR: u32 = 16;
/// A decrease multiplies the cap by `DECREASE_NUM / DECREASE_DEN` (0.85), rounded down.
pub const DECREASE_NUM: u32 = 85;
pub const DECREASE_DEN: u32 = 100;
/// A window whose work-unit p99 is above this share of the budget (‰) lowers the cap.
pub const DECREASE_ABOVE_PERMILLE: u32 = 700;
/// Windows below this share of the budget (‰) count as calm; at or above it, the calm restarts.
pub const CALM_BELOW_PERMILLE: u32 = 550;
/// Whether the work-unit model's p99 lowers the cap and holds its recovery (§6.3's original table). False: the
/// model is reported (STATUS `workUnits`, `Audio.debug()`) but only underruns and qualifying late commands move
/// the cap, since the model's coefficients are a fixed estimate from one lab machine (owner-review 30, 35).
pub const MODEL_DRIVES_CAP: bool = false;
/// The window the work units' p99 is taken over, in ms.
pub const WINDOW_MS: u32 = 250;
/// After a decrease, no further decrease (and no increase) for this long, in ms.
pub const HOLD_MS: u32 = 1_000;
/// Calm needed before the first increase, in ms.
pub const CALM_MS: u32 = 5_000;
/// At most one increase per this long, in ms.
pub const STEP_MS: u32 = 1_000;
/// An increase adds `max(MIN_INCREASE, configured / INCREASE_DIVISOR)`.
pub const INCREASE_DIVISOR: u32 = 32;
pub const MIN_INCREASE: u32 = 2;

/// The controller's fixed parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapConfig {
    /// The configured mixed cap (`voices.mixed`, the core's `max_mixed`): the ceiling.
    pub configured: u32,
    /// `min(CAP_FLOOR, configured)`.
    pub floor: u32,
    /// [`HOLD_MS`], [`CALM_MS`] and [`STEP_MS`] in frames.
    pub hold_frames: u64,
    pub calm_frames: u64,
    pub step_frames: u64,
    /// The work-unit budget per quantum (`cap::BUDGET_WU`, or a test's).
    pub budget: u32,
    /// Whether the model's p99 moves the cap ([`MODEL_DRIVES_CAP`] by default; tests set it).
    pub model_drives: bool,
}

impl CapConfig {
    /// The table's constants at `sample_rate`, for a configured cap and a work-unit budget.
    pub fn at_rate(configured: u32, sample_rate: f32, budget: u32) -> CapConfig {
        CapConfig {
            configured,
            floor: CAP_FLOOR.min(configured),
            hold_frames: ms_to_frames(HOLD_MS, sample_rate),
            calm_frames: ms_to_frames(CALM_MS, sample_rate),
            step_frames: ms_to_frames(STEP_MS, sample_rate),
            budget,
            model_drives: MODEL_DRIVES_CAP,
        }
    }

    /// The same, with the work-unit model driving the cap (§6.3's original table).
    pub fn with_model(self) -> CapConfig {
        CapConfig { model_drives: true, ..self }
    }

    /// The step an increase adds: `max(MIN_INCREASE, configured / INCREASE_DIVISOR)`.
    pub fn increase_step(&self) -> u32 {
        MIN_INCREASE.max(self.configured / INCREASE_DIVISOR)
    }
}

/// `ms` milliseconds in frames at `sample_rate`, rounded (at least 1 frame).
pub fn ms_to_frames(ms: u32, sample_rate: f32) -> u64 {
    let frames = libm::round(ms as f64 * sample_rate as f64 / 1_000.0);
    if frames < 1.0 {
        1
    } else {
        frames as u64
    }
}

/// What the core saw since the last step.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Signals {
    /// The underrun probe counted at least one underrun.
    pub underrun: bool,
    /// A late command qualified (architecture §6.3: counted with a negative `minSlackFrames` while
    /// batches arrive on time; `cap.rs` applies that gate).
    pub late: bool,
    /// The work units' p99 over the window that just ended, or `None` mid-window.
    pub wu_p99: Option<u32>,
}

/// What a step did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    None,
    Decreased,
    Increased,
}

/// The controller's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapController {
    cap: u32,
    /// No decrease or increase before this frame.
    hold_until: u64,
    /// The frame the current calm started (the last qualifying signal or busy window).
    calm_since: u64,
    /// The frame of the last decrease or increase.
    last_change: u64,
}

/// `units > budget × permille / 1000`, exactly.
fn above(units: u32, budget: u32, permille: u32) -> bool {
    units as u64 * 1_000 > budget as u64 * permille as u64
}

impl CapController {
    /// A controller at the configured cap, calm from `now`.
    pub fn new(cfg: &CapConfig, now: u64) -> CapController {
        CapController { cap: cfg.configured, hold_until: now, calm_since: now, last_change: now }
    }

    /// The current cap: `floor ≤ cap ≤ configured`.
    pub fn cap(&self) -> u32 {
        self.cap
    }

    /// Whether the cap is below the configured value (STATUS flag bit3, "adaptive cap active").
    pub fn active(&self, cfg: &CapConfig) -> bool {
        self.cap < cfg.configured
    }

    /// One step at frame `now` (non-decreasing between calls) with what was seen since the last.
    pub fn step(&mut self, cfg: &CapConfig, now: u64, s: Signals) -> Change {
        let wu_p99 = if cfg.model_drives { s.wu_p99 } else { None };
        let over = wu_p99.is_some_and(|p| above(p, cfg.budget, DECREASE_ABOVE_PERMILLE));
        if s.underrun || s.late || over {
            self.calm_since = now;
            if now < self.hold_until {
                return Change::None;
            }
            self.hold_until = now + cfg.hold_frames;
            self.last_change = now;
            let next = (self.cap as u64 * DECREASE_NUM as u64 / DECREASE_DEN as u64) as u32;
            let next = next.max(cfg.floor).min(self.cap);
            if next < self.cap {
                self.cap = next;
                return Change::Decreased;
            }
            return Change::None;
        }
        if wu_p99.is_some_and(|p| p as u64 * 1_000 >= cfg.budget as u64 * CALM_BELOW_PERMILLE as u64) {
            // A busy window (55% to 70%): hold where we are and start the calm again.
            self.calm_since = now;
            return Change::None;
        }
        if self.cap < cfg.configured && now >= self.hold_until && now - self.calm_since >= cfg.calm_frames && now - self.last_change >= cfg.step_frames {
            self.cap = (self.cap + cfg.increase_step()).min(cfg.configured);
            self.last_change = now;
            return Change::Increased;
        }
        Change::None
    }
}

/// The load-shedding ladder gives a step back after this long without an underrun, in ms (ADR 0170).
pub const LADDER_HOLD_MS: u32 = 20_000;
/// A re-trip doubles the hold up to this, in ms (ADR 0170: 20, 40, 80, 160 s).
pub const LADDER_HOLD_MAX_MS: u32 = 160_000;

/// What a [`LadderRecovery`] step asks of the ladder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LadderMove {
    None,
    /// Give back the step taken last (the caller does; the clock already counts it gone).
    Restore,
}

/// The load-shedding ladder's way back (ADR 0170, amending ADR 0162 OD3), pure like
/// [`CapController`]: `cap.rs` feeds it once a quantum with the underrun signal and the steps in
/// force (`bed.rs`'s plus `zones.rs`'s), and gives back the step taken last when it says so.
///
/// | Element | Rule |
/// |---|---|
/// | Clean | no underrun and no ladder move (a step taken or given back) for the hold |
/// | Restore | steps in force and clean for the hold: one step back, then a fresh hold before the next |
/// | Re-trip | a step taken after a step was given back, before the ladder sat idle and clean for a whole hold: the hold doubles, up to [`LADDER_HOLD_MAX_MS`] |
/// | Back-off ends | idle and clean for [`LADDER_HOLD_MAX_MS`]: the hold returns to [`LADDER_HOLD_MS`] |
///
/// Nothing here allocates; `cap.rs` skips it while the ladder is idle and no underrun comes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LadderRecovery {
    /// The steps in force as last seen.
    steps: u32,
    /// The last underrun or ladder move.
    clean_since: u64,
    /// The current hold, and its base and ceiling, in frames.
    hold: u64,
    base: u64,
    max: u64,
    /// A step was given back since the ladder last sat idle and clean for a whole hold.
    restored: bool,
    /// Cumulative: steps given back, and re-trips (tests and a debugger).
    pub restores: u32,
    pub retrips: u32,
}

impl LadderRecovery {
    /// Idle, clean from frame 0, with ADR 0170's holds at `sample_rate`.
    pub fn new(sample_rate: f32) -> LadderRecovery {
        LadderRecovery::with_hold(ms_to_frames(LADDER_HOLD_MS, sample_rate), ms_to_frames(LADDER_HOLD_MAX_MS, sample_rate))
    }

    /// Idle, with a hold of `base` frames doubling up to `max` (tests).
    pub fn with_hold(base: u64, max: u64) -> LadderRecovery {
        LadderRecovery { steps: 0, clean_since: 0, hold: base, base, max: max.max(base), restored: false, restores: 0, retrips: 0 }
    }

    /// The hold before the next step comes back, in frames.
    pub fn hold(&self) -> u64 {
        self.hold
    }

    /// Whether the clock still has work: a step in force, or an episode whose back-off hasn't
    /// ended (the caller then steps it every quantum, not only on an underrun).
    pub fn busy(&self) -> bool {
        self.steps > 0 || self.restored || self.hold != self.base
    }

    /// One quantum at frame `now` (non-decreasing): `underrun` since the last step, `steps` the
    /// ladder's steps in force now.
    pub fn step(&mut self, now: u64, underrun: bool, steps: u32) -> LadderMove {
        if steps > self.steps {
            if self.restored {
                self.retrips = self.retrips.saturating_add(1);
                self.hold = (self.hold * 2).min(self.max);
            }
            self.clean_since = now;
        }
        self.steps = steps;
        if underrun {
            self.clean_since = now;
            return LadderMove::None;
        }
        let clean = now.saturating_sub(self.clean_since);
        if steps == 0 {
            if self.restored && clean >= self.hold {
                self.restored = false;
            }
            if clean >= self.max {
                self.hold = self.base;
            }
            return LadderMove::None;
        }
        if clean < self.hold {
            return LadderMove::None;
        }
        self.steps -= 1;
        self.clean_since = now;
        self.restored = true;
        self.restores = self.restores.saturating_add(1);
        LadderMove::Restore
    }
}

#[cfg(test)]
mod ladder_tests {
    use super::*;

    const H: u64 = 1_000;

    /// Steps the clock over frames `from..to` with `steps` in force (each give-back lowers it), and
    /// returns the frames it gave a step back at.
    fn run(r: &mut LadderRecovery, from: u64, to: u64, steps: &mut u32) -> Vec<u64> {
        let mut at = Vec::new();
        for now in from..to {
            if r.step(now, false, *steps) == LadderMove::Restore {
                *steps -= 1;
                at.push(now);
            }
        }
        at
    }

    #[test]
    fn steps_come_back_one_per_hold_after_the_last_underrun() {
        let mut r = LadderRecovery::with_hold(H, 8 * H);
        let mut steps = 3;
        assert_eq!(r.step(0, true, steps), LadderMove::None);
        assert_eq!(r.step(500, true, steps), LadderMove::None, "the last underrun");
        assert_eq!(run(&mut r, 501, 5_000, &mut steps), vec![1_500, 2_500, 3_500]);
        assert_eq!((steps, r.restores, r.retrips, r.hold()), (0, 3, 0, H));
    }

    #[test]
    fn an_underrun_during_the_hold_starts_it_again() {
        let mut r = LadderRecovery::with_hold(H, 8 * H);
        let mut steps = 1;
        r.step(0, true, steps);
        assert!(run(&mut r, 1, 900, &mut steps).is_empty());
        r.step(900, true, steps);
        assert!(run(&mut r, 901, 1_900, &mut steps).is_empty(), "a full hold from the underrun at 900");
        assert_eq!(run(&mut r, 1_900, 1_901, &mut steps), vec![1_900]);
    }

    #[test]
    fn a_re_trip_doubles_the_hold_up_to_its_ceiling_and_a_long_idle_ends_the_back_off() {
        let mut r = LadderRecovery::with_hold(H, 4 * H);
        let mut steps = 2;
        r.step(0, true, steps);
        assert_eq!(run(&mut r, 1, 1_001, &mut steps), vec![1_000]);
        // Underruns again: the ladder takes the step back (a re-trip).
        r.step(1_200, true, steps);
        steps = 2;
        r.step(1_300, true, steps);
        assert_eq!((r.retrips, r.hold()), (1, 2 * H));
        assert_eq!(run(&mut r, 1_301, 5_400, &mut steps), vec![3_300, 5_300], "2 holds of 2,000");
        // Idle but within a hold of the last give-back: a step taken now is still a re-trip.
        r.step(6_000, true, 0);
        r.step(6_100, true, 1);
        assert_eq!((r.retrips, r.hold()), (2, 4 * H));
        steps = 1;
        r.step(6_200, true, steps);
        steps = 2;
        r.step(6_300, true, steps);
        assert_eq!((r.retrips, r.hold()), (3, 4 * H), "the ceiling");
        assert_eq!(run(&mut r, 6_301, 14_400, &mut steps), vec![10_300, 14_300]);
        // Idle and clean for the ceiling: the hold is back to its base, and a step taken then is a
        // new episode, not a re-trip.
        assert!(run(&mut r, 14_400, 18_300, &mut steps).is_empty());
        assert_eq!(r.hold(), 4 * H);
        assert!(r.busy());
        run(&mut r, 18_300, 18_301, &mut steps);
        assert_eq!(r.hold(), H);
        assert!(!r.busy());
        r.step(18_400, true, 1);
        assert_eq!((r.retrips, r.hold()), (3, H));
    }

    #[test]
    fn at_48_khz_the_hold_is_20_s_and_the_ceiling_160_s() {
        let r = LadderRecovery::new(48_000.0);
        assert_eq!((r.hold(), r.max), (960_000, 7_680_000));
        assert!(!r.busy());
    }
}
