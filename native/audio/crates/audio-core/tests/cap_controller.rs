//! The adaptive cap's controller against architecture §6.3's table, row by row (ADR 0157 A3.3, leaf
//! L2). At a "rate" of 1,000 frames per second one frame is one millisecond, so the times below read
//! as the table's.

use audio_core::cap_controller::*;

const BUDGET: u32 = 1_000_000;

fn cfg(configured: u32) -> CapConfig {
    CapConfig::at_rate(configured, 1_000.0, BUDGET)
}

fn quiet() -> Signals {
    Signals::default()
}

fn underrun() -> Signals {
    Signals { underrun: true, ..Signals::default() }
}

fn late() -> Signals {
    Signals { late: true, ..Signals::default() }
}

/// A window that ended with p99 at `permille` of the budget.
fn window(permille: u32) -> Signals {
    Signals { wu_p99: Some(BUDGET / 1_000 * permille), ..Signals::default() }
}

/// Steps every millisecond from `from` to `to` (exclusive) with `s`; returns the changes.
fn run(c: &mut CapController, k: &CapConfig, from: u64, to: u64, s: Signals) -> Vec<(u64, Change, u32)> {
    let mut out = Vec::new();
    for now in from..to {
        let ch = c.step(k, now, s);
        if ch != Change::None {
            out.push((now, ch, c.cap()));
        }
    }
    out
}

#[test]
fn the_table_constants() {
    assert_eq!(CAP_FLOOR, 16);
    assert_eq!((DECREASE_NUM, DECREASE_DEN), (85, 100));
    assert_eq!((DECREASE_ABOVE_PERMILLE, CALM_BELOW_PERMILLE), (700, 550));
    assert_eq!((WINDOW_MS, HOLD_MS, CALM_MS, STEP_MS), (250, 1_000, 5_000, 1_000));
    let k = CapConfig::at_rate(128, 48_000.0, BUDGET);
    assert_eq!((k.hold_frames, k.calm_frames, k.step_frames), (48_000, 240_000, 48_000));
    assert_eq!(k.floor, 16);
    assert_eq!(cfg(8).floor, 8, "a configured cap under 16 is its own floor");
    assert_eq!(cfg(128).increase_step(), 4, "configured/32");
    assert_eq!(cfg(32).increase_step(), 2, "at least 2");
    assert_eq!(cfg(256).increase_step(), 8);
}

#[test]
fn starts_at_the_configured_cap_and_stays_there_when_quiet() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    assert_eq!(c.cap(), 128);
    assert!(!c.active(&k));
    assert!(run(&mut c, &k, 0, 20_000, quiet()).is_empty());
    assert!(run(&mut c, &k, 20_000, 21_000, window(100)).is_empty(), "never above the configured cap");
    assert_eq!(c.cap(), 128);
}

#[test]
fn an_underrun_cuts_the_cap_to_85_percent_at_once() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    assert_eq!(c.step(&k, 100, underrun()), Change::Decreased);
    assert_eq!(c.cap(), 108, "floor(0.85 * 128)");
    assert!(c.active(&k));
}

#[test]
fn a_qualifying_late_command_cuts_the_cap() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    assert_eq!(c.step(&k, 10, late()), Change::Decreased);
    assert_eq!(c.cap(), 108);
}

#[test]
fn a_window_over_70_percent_cuts_the_cap_and_70_exactly_does_not() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    assert_eq!(c.step(&k, 250, window(700)), Change::None, "70% is not over 70%");
    assert_eq!(c.step(&k, 500, window(701)), Change::Decreased);
    assert_eq!(c.cap(), 108);
}

#[test]
fn the_hold_blocks_a_second_cut_for_one_second() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    assert_eq!(c.step(&k, 0, underrun()), Change::Decreased);
    assert_eq!(c.step(&k, 999, underrun()), Change::None, "inside the hold");
    assert_eq!(c.cap(), 108);
    assert_eq!(c.step(&k, 1_000, underrun()), Change::Decreased, "the hold is over");
    assert_eq!(c.cap(), 91, "floor(0.85 * 108)");
}

#[test]
fn sustained_trouble_walks_the_cap_down_once_a_second_to_the_floor() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    let cuts = run(&mut c, &k, 0, 20_000, underrun());
    let caps: Vec<u32> = cuts.iter().map(|&(_, _, cap)| cap).collect();
    assert_eq!(caps, vec![108, 91, 77, 65, 55, 46, 39, 33, 28, 23, 19, 16]);
    let times: Vec<u64> = cuts.iter().map(|&(t, _, _)| t).collect();
    assert_eq!(times, (0..12).map(|s| s * 1_000).collect::<Vec<_>>());
    assert_eq!(c.cap(), CAP_FLOOR, "never below 16");
}

#[test]
fn a_configured_cap_under_the_floor_never_drops() {
    let k = cfg(8);
    let mut c = CapController::new(&k, 0);
    assert!(run(&mut c, &k, 0, 5_000, underrun()).is_empty());
    assert_eq!(c.cap(), 8);
    assert!(!c.active(&k));
}

#[test]
fn recovery_waits_5_s_of_calm_then_adds_a_step_once_a_second() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    assert_eq!(c.step(&k, 0, underrun()), Change::Decreased);
    assert_eq!(c.cap(), 108);
    let ups = run(&mut c, &k, 1, 12_001, quiet());
    let got: Vec<(u64, u32)> = ups.iter().map(|&(t, ch, cap)| {
        assert_eq!(ch, Change::Increased);
        (t, cap)
    }).collect();
    assert_eq!(got, vec![(5_000, 112), (6_000, 116), (7_000, 120), (8_000, 124), (9_000, 128)]);
    assert!(!c.active(&k));
    assert!(run(&mut c, &k, 12_001, 20_000, quiet()).is_empty(), "never above the configured cap");
}

#[test]
fn the_last_step_lands_on_the_configured_cap_not_past_it() {
    let k = cfg(100); // step max(2, 100/32 = 3) = 3
    let mut c = CapController::new(&k, 0);
    c.step(&k, 0, underrun()); // 85
    let caps: Vec<u32> = run(&mut c, &k, 1, 20_000, quiet()).iter().map(|&(_, _, cap)| cap).collect();
    assert_eq!(caps, vec![88, 91, 94, 97, 100]);
}

#[test]
fn a_signal_during_recovery_restarts_the_calm() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    c.step(&k, 0, underrun()); // 108, hold to 1,000
    assert!(run(&mut c, &k, 1, 3_000, quiet()).is_empty());
    // An underrun inside the calm but after the hold: a cut, and the calm restarts.
    assert_eq!(c.step(&k, 3_000, underrun()), Change::Decreased);
    assert_eq!(c.cap(), 91);
    let ups = run(&mut c, &k, 3_001, 9_001, quiet());
    assert_eq!(ups.first().map(|&(t, _, cap)| (t, cap)), Some((8_000, 95)));
}

#[test]
fn a_signal_inside_the_hold_does_not_cut_but_restarts_the_calm() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    c.step(&k, 0, underrun());
    assert_eq!(c.step(&k, 900, late()), Change::None);
    assert_eq!(c.cap(), 108);
    let ups = run(&mut c, &k, 901, 7_000, quiet());
    assert_eq!(ups.first().map(|&(t, _, _)| t), Some(5_900), "5 s after the late command, not after the cut");
}

#[test]
fn a_busy_window_between_55_and_70_percent_holds_the_cap_and_restarts_the_calm() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    c.step(&k, 0, underrun()); // 108
    // Windows every 250 ms at 60%: neither down nor up.
    for t in (250..10_000).step_by(250) {
        assert_eq!(c.step(&k, t, window(600)), Change::None, "at {t}");
    }
    assert_eq!(c.cap(), 108);
    // 55% exactly is busy too ("< 55%" is calm).
    assert_eq!(c.step(&k, 10_000, window(550)), Change::None);
    // Then calm windows at 54%: up 5 s after the last busy one.
    let mut first_up = None;
    for t in 10_001..16_000 {
        let s = if t % 250 == 0 { window(549) } else { quiet() };
        if c.step(&k, t, s) == Change::Increased && first_up.is_none() {
            first_up = Some(t);
        }
    }
    assert_eq!(first_up, Some(15_000));
}

#[test]
fn a_cut_at_the_floor_still_holds_and_reports_no_change() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    run(&mut c, &k, 0, 12_000, underrun());
    assert_eq!(c.cap(), 16);
    assert_eq!(c.step(&k, 12_000, underrun()), Change::None);
    assert_eq!(c.cap(), 16);
}

#[test]
fn full_recovery_from_the_floor_takes_about_half_a_minute_at_128() {
    let k = cfg(128);
    let mut c = CapController::new(&k, 0);
    run(&mut c, &k, 0, 12_000, underrun());
    assert_eq!(c.cap(), 16);
    let ups = run(&mut c, &k, 12_000, 60_000, quiet());
    let (last, _, cap) = *ups.last().unwrap();
    assert_eq!(cap, 128);
    assert_eq!(ups.len(), 28, "(128 - 16) / 4");
    assert_eq!(last, 11_999 + 5_000 + 27 * 1_000, "the first 5 s after the last underrun (11,999 ms), then one a second");
}

#[test]
fn ms_to_frames_rounds_and_is_at_least_one() {
    assert_eq!(ms_to_frames(250, 48_000.0), 12_000);
    assert_eq!(ms_to_frames(1_000, 44_100.0), 44_100);
    assert_eq!(ms_to_frames(1, 100.0), 1);
}
