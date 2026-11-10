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
