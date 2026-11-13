//! Ld7 (0171/0172 M5b; architecture §4.8, R21, O4; ADR 0170): the shedding ladder's new first
//! step pauses non-master loudness metering, through the core as the worklet drives it (`submit`,
//! `note_underruns`, `process` per quantum, `status::take`). Every timing is on the audio clock:
//! the frames of the quanta rendered, never wall time.
//!
//! - **Order:** with buses metered, the loudness step comes a second into underruns at the cap's
//!   floor, and the bed-idle and zone steps a second after it; ADR 0170's recovery gives them back
//!   one hold apart, zone 2, zone 1, bed, the loudness step last (all four back 80 s after the
//!   last underrun).
//! - **Skip:** with only master metered (or no `LOUD_CONFIG` at all) the step isn't taken and the
//!   audible steps come exactly when they did before M5.
//! - **Reporting:** `loudShed` carries the step, `m3Shed` the bed and zone steps alone; a paused
//!   meter's `loudBuses` item carries `LOUD_FLAG_PAUSED` and no sub-block, master keeps metering;
//!   the give-back reseeds each bus meter (its next take flagged `reset`).
//! - **Never shed:** a level duck's detector keeps working at the deepest step (the output is bit
//!   for bit the output without the ladder).

mod common;

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bed, duck, loudness, status, zones, Core, QUANTUM};
use audio_wire::generated as wire;
use common::*;

/// One second and ADR 0170's 20 s hold, in frames at 48 kHz (whole quanta: 375 and 7,500).
const SECOND: u64 = 48_000;
const HOLD: u64 = 20 * SECOND;

/// 16 mixed voices (the adaptive cap sits at its floor from the start), one bed slot and one zone
/// slot, so the ladder has all three of its audible steps.
fn ladder_core() -> Core {
    let p = InitParams {
        sample_rate: RATE,
        max_logical: 64,
        max_mixed: 16,
        max_buses: 8,
        arena_initial_bytes: 0,
        max_beds: 1,
        max_zone_slots: 1,
        zone_max_frames: 12_000,
        ..InitParams::default()
    };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// `LOUD_CONFIG` metering `slots` beside master (`tpGateDbfs` -7).
fn loud_config(slots: &[u16]) -> Rec {
    let rec = wire::LoudConfig { voice_id: 0, frame_offset: wire::ASAP, tp_gate_dbfs: -7.0, meters: slots.iter().map(|&slot| wire::LoudConfigMeters { slot, reserved: 0 }).collect() };
    let mut b = vec![0u8; wire::LoudConfig::FIXED_END + slots.len() * wire::LoudConfigMeters::FIXED_END];
    rec.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// The metering configurations the ladder sees.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Meters {
    /// No `LOUD_CONFIG` (the K1 core).
    None,
    /// Master only.
    Master,
    /// Master and every bus but the root (1, 2, 3).
    Buses,
}

/// Master, Music (1), SFX (2), UI (3); a DC voice on Music and one on SFX; metered per `meters`.
fn scene(meters: Meters) -> Mixer {
    let mut m = Mixer::over(ladder_core());
    m.submit(&[config(&[ROOT, 0, 0, 0]), gains(0, &[1.0, 0.25, 0.25, 1.0]), dc(0x0001_0001, 1, 0.0), dc(0x0002_0002, 2, 0.0)]);
    match meters {
        Meters::None => {}
        Meters::Master => m.submit(&[loud_config(&[])]),
        Meters::Buses => m.submit(&[loud_config(&[1, 2, 3])]),
    }
    m
}

/// One quantum (output discarded).
fn step(m: &mut Mixer) {
    m.core.process(m.frame);
    m.frame += QUANTUM as u64;
}

fn take(m: &mut Mixer) -> wire::StatusBlock {
    let mut out = vec![0u8; status::BUFFER_BYTES];
    let n = status::take(&mut m.core, &mut out, 0x400);
    assert!(n > 0);
    wire::StatusBlock::read(&out[..n], 0).unwrap().0
}

fn item(s: &wire::StatusBlock, slot: u16) -> wire::StatusLoudBusesItem {
    s.loud_buses.iter().find(|b| b.slot == slot).cloned().unwrap_or_else(|| panic!("no meter for slot {slot}"))
}

fn blocks(it: &wire::StatusLoudBusesItem) -> u32 {
    it.flags as u32 & wire::LOUD_FLAG_NEW_BLOCKS_MASK
}

fn has(it: &wire::StatusLoudBusesItem, flag: u32) -> bool {
    it.flags as u32 & flag != 0
}

/// The ladder's steps in force: (loudness, bed, zone).
fn steps(m: &mut Mixer) -> (u32, u32, u32) {
    (loudness::shed_steps(&mut m.core), bed::m3_shed(&mut m.core), zones::shed_steps(&m.core))
}

/// Each change of the ladder's steps, at the frame of the quantum it happened in.
#[derive(Debug, Default)]
struct Moves {
    /// (frame, (loudness, bed, zone) after it)
    at: Vec<(u64, (u32, u32, u32))>,
}

/// Renders `n` quanta, an underrun counted before each when `underruns`, noting the ladder's moves.
/// Takes STATUS every 6 quanta (the worklet's cadence while batches flow) so no ring overflows.
fn run(m: &mut Mixer, n: u64, underruns: bool, total: &mut u32, moves: &mut Moves) {
    for q in 0..n {
        let frame = m.frame;
        if underruns {
            *total += 1;
            m.core.note_underruns(*total);
        }
        let before = steps(m);
        step(m);
        let after = steps(m);
        if after != before {
            moves.at.push((frame, after));
        }
        if q % 6 == 5 {
            take(m);
        }
    }
}

/// Underruns from frame `from` until the deepest step, then 2 s more, then clean for 90 s. Returns
/// the moves and the frame of the last underrun.
fn overload_and_recover(meters: Meters) -> (Mixer, Moves, u64) {
    let mut m = scene(meters);
    let (mut total, mut moves) = (0, Moves::default());
    // The probe has no underrun for a second (and STATUS flows), then underruns every quantum.
    run(&mut m, SECOND / QUANTUM as u64, false, &mut total, &mut moves);
    assert!(moves.at.is_empty());
    run(&mut m, 5 * SECOND / QUANTUM as u64, true, &mut total, &mut moves);
    let last = m.frame - QUANTUM as u64;
    run(&mut m, 90 * SECOND / QUANTUM as u64, false, &mut total, &mut moves);
    (m, moves, last)
}

#[test]
fn with_buses_metered_the_loudness_step_comes_first_and_is_given_back_last() {
    let (m, moves, last) = overload_and_recover(Meters::Buses);
    // Underruns start at frame 1 s; the run counts from that quantum.
    let start = SECOND;
    let want = vec![
        // A second of underruns at the floor: the loudness step.
        (start + SECOND, (1, 0, 0)),
        // A second later: the bed-idle step and zone step 1 (each ladder's first audible step).
        (start + 2 * SECOND, (1, 1, 1)),
        // Another second: zone step 2.
        (start + 3 * SECOND, (1, 1, 2)),
        // ADR 0170: one step back per 20 s clean, zone 2, zone 1, bed, the loudness step last.
        (last + HOLD, (1, 1, 1)),
        (last + 2 * HOLD, (1, 1, 0)),
        (last + 3 * HOLD, (1, 0, 0)),
        (last + 4 * HOLD, (0, 0, 0)),
    ];
    assert_eq!(moves.at, want);
    assert_eq!((m.core.cap().ladder().restores, m.core.cap().ladder().retrips), (4, 0));
    assert_eq!(status::counters(&m.core).mix.loud_shed, 0);
}

#[test]
fn with_only_master_metered_or_none_the_ladder_runs_as_before() {
    let mut seen = Vec::new();
    for meters in [Meters::None, Meters::Master] {
        let (m, moves, last) = overload_and_recover(meters);
        let start = SECOND;
        let want = vec![
            (start + SECOND, (0, 1, 1)),
            (start + 2 * SECOND, (0, 1, 2)),
            (last + HOLD, (0, 1, 1)),
            (last + 2 * HOLD, (0, 1, 0)),
            (last + 3 * HOLD, (0, 0, 0)),
        ];
        assert_eq!(moves.at, want, "{meters:?}: the audible steps aren't delayed");
        assert_eq!(m.core.cap().ladder().restores, 3, "{meters:?}");
        seen.push(moves.at);
    }
    assert_eq!(seen[0], seen[1]);
}

#[test]
fn loud_shed_reports_the_step_and_m3_shed_keeps_the_bed_and_zone_steps() {
    let mut m = scene(Meters::Buses);
    let (mut total, mut moves) = (0, Moves::default());
    run(&mut m, SECOND / QUANTUM as u64, false, &mut total, &mut moves);
    let s = take(&mut m);
    assert_eq!((s.loud_shed, s.m3_shed), (0, 0));
    for b in &s.loud_buses {
        assert!(!has(b, wire::LOUD_FLAG_PAUSED), "nothing paused yet");
    }
    // Underruns until the loudness step: loudShed 1, m3Shed still 0.
    while steps(&mut m).0 == 0 {
        run(&mut m, 1, true, &mut total, &mut moves);
    }
    let s = take(&mut m);
    assert_eq!((s.loud_shed, s.m3_shed), (1, 0), "the loudness step is not an m3Shed step");
    // Paused: the bus meters carry the flag and no sub-block, master meters on (4,800-frame
    // sub-blocks: 37.5 quanta each, so 120 quanta close at least 3).
    let wu0 = status::counters(&m.core).mix.wu_loudness;
    for _ in 0..120 {
        step(&mut m);
    }
    let s = take(&mut m);
    for slot in [1u16, 2, 3] {
        let it = item(&s, slot);
        assert!(has(&it, wire::LOUD_FLAG_PAUSED), "slot {slot} paused");
        assert_eq!(blocks(&it), 0, "slot {slot}: no sub-block while paused");
    }
    let master = item(&s, loudness::OUTPUT_TAP);
    assert!(!has(&master, wire::LOUD_FLAG_PAUSED) && blocks(&master) >= 3, "master keeps metering: {master:?}");
    // Only master's work units while paused: its meter and its FIR every quantum.
    let wu = status::counters(&m.core).mix.wu_loudness - wu0;
    assert_eq!(wu, 120.0 * (loudness::wu::METER + loudness::wu::TRUE_PEAK) as f64, "the bus taps cost nothing");
    // A second more of underruns: the bed and zone steps, in m3Shed alone.
    while steps(&mut m).1 == 0 {
        run(&mut m, 1, true, &mut total, &mut moves);
    }
    let s = take(&mut m);
    assert_eq!((s.loud_shed, s.m3_shed), (1, 2), "bed-idle and zone step 1");
    // Clean until the bed and zone steps are back: m3Shed 0 while loudShed stays.
    while steps(&mut m).1 + steps(&mut m).2 > 0 {
        run(&mut m, 1, false, &mut total, &mut moves);
    }
    let s = take(&mut m);
    assert_eq!((s.loud_shed, s.m3_shed), (1, 0));
    // The loudness step comes back last: the bus meters restart fresh (`reset`), unpaused.
    while steps(&mut m).0 == 1 {
        run(&mut m, 1, false, &mut total, &mut moves);
    }
    let s = take(&mut m);
    assert_eq!((s.loud_shed, s.m3_shed), (0, 0));
    for slot in [1u16, 2, 3] {
        let it = item(&s, slot);
        assert!(!has(&it, wire::LOUD_FLAG_PAUSED) && has(&it, wire::LOUD_FLAG_RESET), "slot {slot} given back: {it:?}");
        assert_eq!(it.first_seq, 0, "slot {slot}: a fresh sequence");
    }
    assert!(!has(&item(&s, loudness::OUTPUT_TAP), wire::LOUD_FLAG_RESET), "master never stopped");
    // And meters again: a sub-block 4,800 frames on.
    for _ in 0..38 {
        step(&mut m);
    }
    let s = take(&mut m);
    for slot in [1u16, 2, 3] {
        let it = item(&s, slot);
        assert_eq!((blocks(&it), has(&it, wire::LOUD_FLAG_RESET)), (1, false), "slot {slot}");
    }
}

#[test]
fn a_meter_added_while_paused_starts_paused() {
    let mut m = scene(Meters::Buses);
    let (mut total, mut moves) = (0, Moves::default());
    while steps(&mut m).0 == 0 {
        run(&mut m, 1, true, &mut total, &mut moves);
    }
    // UI (3) leaves and comes back while the step is in force.
    m.submit(&[loud_config(&[1, 2])]);
    m.submit(&[loud_config(&[1, 2, 3])]);
    for _ in 0..80 {
        step(&mut m);
    }
    let s = take(&mut m);
    let it = item(&s, 3);
    assert!(has(&it, wire::LOUD_FLAG_PAUSED) && blocks(&it) == 0, "{it:?}");
}

#[test]
fn the_ladder_does_not_pause_metering_on_two_short_runs() {
    // At the floor, underruns for half a second, a 2 s gap, half a second more: no run of a second.
    let mut m = scene(Meters::Buses);
    let (mut total, mut moves) = (0, Moves::default());
    run(&mut m, SECOND / QUANTUM as u64 / 2, true, &mut total, &mut moves);
    run(&mut m, 2 * SECOND / QUANTUM as u64, false, &mut total, &mut moves);
    // Another half second: the gap of 2 s started the run again, so still no step.
    run(&mut m, SECOND / QUANTUM as u64 / 2, true, &mut total, &mut moves);
    assert!(moves.at.is_empty(), "{:?}", moves.at);
    assert_eq!(status::counters(&m.core).mix.loud_shed, 0);
}

#[test]
fn a_level_duck_keeps_working_at_the_deepest_step() {
    // Music (1) ducked by SFX (2)'s pre-fader level (SFX's fader at 0, so the output is Music
    // alone), both metered; the limiter's look-ahead at 0 so heard frame = core frame.
    let render = |overload: bool| {
        let mut m = Mixer::over(ladder_core());
        m.set_lookahead(0.0);
        let rule = wire::BusDuckRules { target: 1, trigger: 2, flags: wire::DUCK_FLAG_LEVEL, threshold_db: -30.0, amount: 0.3, attack: 0.01, release: 0.1 };
        let mut duck_rec = vec![0u8; wire::BusDuck::FIXED_END + wire::BusDuckRules::FIXED_END];
        wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: vec![rule] }.write(&mut duck_rec, 0).unwrap();
        m.submit(&[config(&[ROOT, 0, 0, 0]), gains(0, &[1.0, 0.25, 0.0, 1.0]), dc(0x0001_0001, 1, 0.0), dc(0x0002_0002, 2, 0.0), Rec::Raw(duck_rec), loud_config(&[1, 2])]);
        let (mut total, mut out) = (0u32, Vec::new());
        for q in 0..8 * SECOND / QUANTUM as u64 {
            if overload && q < 5 * SECOND / QUANTUM as u64 {
                total += 1;
                m.core.note_underruns(total);
            }
            let (l, _) = m.render();
            out.extend(l);
            if q % 6 == 5 {
                take(&mut m);
            }
        }
        let deepest = steps(&mut m);
        let mut mix = audio_core::counters::MixSections::default();
        duck::status(&mut m.core, &mut mix);
        (out, deepest, mix.bus_duck.as_slice()[0].gain)
    };
    let (plain, idle, _) = render(false);
    let (shed, deepest, gain) = render(true);
    assert_eq!(idle, (0, 0, 0));
    assert_eq!(deepest, (1, 1, 2), "the deepest step: metering paused, beds idle, one zone fewer");
    assert!((gain - 0.3).abs() < 1e-4, "the duck holds Music at its amount: {gain}");
    let tail = &shed[7 * SECOND as usize..];
    assert!(tail.iter().all(|x| (x / 0.25 - 0.3).abs() < 1e-4), "ducked to 0.3 at the deepest step");
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert_eq!(bits(&plain), bits(&shed), "the ladder changed no bit of the ducked output");
}
