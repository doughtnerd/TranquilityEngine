//! The adaptive mixed-voice cap in the core (ADR 0157 A3.3; architecture §6.3): under load the cap
//! drops, the core demotes the lowest-`score` mixed voices itself and reports them in STATUS
//! `demoted`, `mixedCap` and flag bit3 follow, and the cap recovers once the load ends. Load is
//! injected the three ways the core sees it: the shell's underrun total, a qualifying late command,
//! and the work-unit model against a lowered budget. At normal load nothing changes.

mod common;

use audio_core::cap::{self, wu, BUDGET_WU};
use audio_core::counters::flag;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{status, Core, QUANTUM};
use audio_wire::generated as wire;
use common::*;

const CONFIGURED: u32 = 40;
/// Quanta per second at 48 kHz (375).
const SECOND: usize = 375;

fn core_with(max_mixed: u32) -> Core {
    core_sized(64, max_mixed)
}

fn core_sized(max_logical: u32, max_mixed: u32) -> Core {
    let p = InitParams { sample_rate: RATE, max_logical, max_mixed, max_buses: 2, arena_initial_bytes: 0 };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh zeroed block of `layout.total()` bytes, page-aligned.
    unsafe { Core::new(p, layout, base) }
}

fn id(k: u32) -> u32 {
    (1 << 16) | k
}

/// `n` looping mixed DC voices at gain 1/64 (summed under the limiter), voice `k` with score `k`.
fn voices(n: u32) -> Vec<Rec> {
    (1..=n)
        .map(|k| {
            let Rec::Play(mut p) = dc(id(k), ROOT, 0.0) else { unreachable!() };
            p.gain = 1.0 / 64.0;
            p.score = k as f32;
            Rec::Play(p)
        })
        .collect()
}

/// A mixer with `CONFIGURED` as its cap and `n` voices playing.
fn rig(n: u32) -> Mixer {
    let mut m = Mixer::over(core_with(CONFIGURED));
    m.submit(&voices(n));
    m.render();
    m
}

/// Renders `n` quanta the way the shell does (the status writer's `after_quantum` after each, so
/// `currentFrame` is real), and returns the demoted ids reported meanwhile.
fn run(m: &mut Mixer, n: usize) -> Vec<u32> {
    let mut demoted = Vec::new();
    for _ in 0..n {
        m.render();
        status::after_quantum(&mut m.core);
        let c = status::counters_mut(&mut m.core);
        demoted.extend_from_slice(c.demoted.as_slice());
        c.end_block();
    }
    demoted
}

fn cap_of(m: &Mixer) -> u32 {
    status::counters(&m.core).mixed_cap as u32
}

fn active(m: &Mixer) -> bool {
    status::counters(&m.core).flags & flag::ADAPTIVE_CAP_ACTIVE != 0
}

fn mixed(m: &Mixer) -> u32 {
    status::counters(&m.core).mixed_voices as u32
}

#[test]
fn at_normal_load_the_cap_is_the_configured_one_and_nothing_is_demoted() {
    let mut m = rig(CONFIGURED);
    assert!(run(&mut m, 10 * SECOND).is_empty());
    assert_eq!(cap_of(&m), CONFIGURED);
    assert!(!active(&m));
    assert_eq!(mixed(&m), CONFIGURED);
    assert_eq!(m.core.cap().decreases, 0);
}

#[test]
fn the_model_counts_voices_buses_effects_and_records() {
    let mut m = rig(10);
    run(&mut m, 1);
    let base = wu::BUS + wu::LIMITER;
    assert_eq!(m.core.work_units(), 10 * wu::MIXED_VOICE + base);
    assert_eq!(status::counters(&m.core).work_units, m.core.work_units(), "STATUS workUnits");
    // Four voices go virtual (SET_MIXED), which also carries 4 records into the next quantum.
    let recs: Vec<Rec> = (1..=4).map(|k| Rec::Set(wire::SetParams { voice_id: id(k), frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_SCORE, score: 0.5, ..Default::default() })).collect();
    m.submit(&recs);
    run(&mut m, 1);
    assert_eq!(m.core.work_units(), 10 * wu::MIXED_VOICE + base + 4 * wu::RECORD);
    run(&mut m, 1);
    assert_eq!(m.core.work_units(), 10 * wu::MIXED_VOICE + base, "records count once");
    // A second bus with a lowpass and a compressor.
    m.submit(&[config_fx(&[(ROOT, vec![]), (0, vec![(wire::effect_type::LOWPASS, 1_000.0, 0.0), (wire::effect_type::COMPRESSOR, -24.0, 30.0)])])]);
    run(&mut m, 1);
    let fx = 2 * wu::BUS + wu::BIQUAD + wu::COMPRESSOR + wu::LIMITER;
    assert_eq!(m.core.work_units(), 10 * wu::MIXED_VOICE + fx + wu::RECORD, "the BUS_CONFIG record too");
    run(&mut m, 1);
    assert_eq!(m.core.work_units(), 10 * wu::MIXED_VOICE + fx);
    assert_eq!(BUDGET_WU, 1_300_000, "1.3 ms at 1 WU per ns");
}

#[test]
fn an_underrun_drops_the_cap_demotes_the_lowest_scores_and_it_recovers() {
    let mut m = rig(CONFIGURED);
    run(&mut m, SECOND);
    m.core.note_underruns(1);
    let demoted = run(&mut m, 1);
    assert_eq!(cap_of(&m), 34, "floor(0.85 * 40)");
    assert!(active(&m));
    let mut want: Vec<u32> = (1..=6).map(id).collect();
    let mut got = demoted.clone();
    got.sort();
    want.sort();
    assert_eq!(got, want, "the six lowest scores, reported in STATUS demoted");
    run(&mut m, 3); // the 5 ms fades
    assert_eq!(mixed(&m), 34);
    // The same total again is no new underrun.
    m.core.note_underruns(1);
    assert!(run(&mut m, 2 * SECOND).is_empty());
    assert_eq!(cap_of(&m), 34);

    // Calm: 5 s after the underrun, +2 a second (max(2, 40/32)) back to 40. The core never promotes
    // (main's selection does), so the mixed count stays.
    let mut caps = Vec::new();
    for _ in 0..8 {
        run(&mut m, SECOND);
        caps.push(cap_of(&m));
    }
    assert_eq!(caps, vec![34, 34, 36, 38, 40, 40, 40, 40]);
    assert!(!active(&m));
    assert_eq!(m.core.cap().decreases, 1);
    assert_eq!(m.core.cap().increases, 3);
    assert_eq!(m.core.cap().demoted, 6);
}

#[test]
fn repeated_underruns_cut_once_a_second_and_main_cannot_promote_past_the_cap() {
    let mut m = rig(CONFIGURED);
    run(&mut m, 10);
    for k in 1..=3 {
        m.core.note_underruns(k);
        run(&mut m, SECOND);
    }
    assert_eq!(cap_of(&m), 23, "40 -> 34 -> 28 -> 23");
    assert_eq!(mixed(&m), 23);
    // Main promotes a demoted voice against the cap (its STATUS hadn't arrived): the core demotes
    // the lowest score again, here that same voice.
    let promote = wire::SetMixed { voice_id: id(1), mixed: 1, gain: 1.0 / 64.0, dir_z: -1.0, lp_hz: OFF, ..Default::default() };
    let mut buf = vec![0u8; 32 + wire::SetMixed::FIXED_END];
    promote.write(&mut buf, 32).unwrap();
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: m.frame as f64, count: 1, flags: 0 }.write(&mut buf, 0).unwrap();
    assert_eq!(audio_core::scheduler::submit(&mut m.core, &buf), 0);
    let demoted = run(&mut m, 4);
    assert_eq!(demoted, vec![id(1)]);
    assert_eq!(mixed(&m), 23);
}

#[test]
fn a_late_command_on_time_drops_the_cap_and_one_after_a_stall_does_not() {
    // Batches every 4 quanta with firstFrame 512 frames ahead, as main sends them.
    let mut m = rig(CONFIGURED);
    let lead = (4 * QUANTUM) as f64;
    let send = |m: &mut Mixer, first_frame: f64, recs: &[Rec]| {
        let msg = batch(first_frame, recs);
        assert_eq!(audio_core::scheduler::submit(&mut m.core, &msg), 0);
    };
    let current = |m: &Mixer| status::counters(&m.core).current_frame;
    for _ in 0..20 {
        let f = current(&m) + lead;
        send(&mut m, f, &[]);
        run(&mut m, 4);
    }
    assert_eq!(cap_of(&m), CONFIGURED);

    // A stall: no batch for 200 quanta, then one that arrived after its firstFrame with a stamped
    // record already past: late, but main's fault (the gap), so no cut.
    run(&mut m, 200);
    let late_rec = |v: u32| Rec::Set(wire::SetParams { voice_id: id(v), frame_offset: 0, mask: wire::SET_PARAMS_MASK_SCORE, score: 100.0, ..Default::default() });
    let before = status::counters(&m.core).late_commands;
    let f = current(&m) - 256.0;
    send(&mut m, f, &[late_rec(40)]);
    run(&mut m, 4);
    assert_eq!(status::counters(&m.core).late_commands, before + 1, "counted late");
    assert_eq!(cap_of(&m), CONFIGURED, "after a gap, not the core's load");

    // Back on time for a while, then a batch with negative slack whose gap is ordinary: qualifies.
    for _ in 0..20 {
        let f = current(&m) + lead;
        send(&mut m, f, &[]);
        run(&mut m, 4);
    }
    let f = current(&m) - 64.0;
    send(&mut m, f, &[late_rec(39)]);
    run(&mut m, 1);
    assert_eq!(status::counters(&m.core).late_commands, before + 2);
    assert_eq!(cap_of(&m), 34);
    assert!(active(&m));
}

#[test]
fn negative_slack_alone_without_a_late_command_does_not_cut() {
    let mut m = rig(CONFIGURED);
    let lead = (4 * QUANTUM) as f64;
    for _ in 0..20 {
        let f = status::counters(&m.core).current_frame + lead;
        assert_eq!(audio_core::scheduler::submit(&mut m.core, &batch(f, &[])), 0);
        run(&mut m, 4);
    }
    let f = status::counters(&m.core).current_frame - 64.0;
    assert_eq!(audio_core::scheduler::submit(&mut m.core, &batch(f, &voices(0))), 0);
    run(&mut m, 4);
    assert_eq!(cap_of(&m), CONFIGURED);
}

#[test]
fn a_work_unit_ceiling_set_low_walks_the_cap_down_to_where_the_model_fits() {
    let mut m = rig(CONFIGURED);
    run(&mut m, 10);
    // 40 voices model 52,500 WU; a 60,000 budget puts its 70% line at 42,000 and 55% at 33,000.
    m.core.cap_mut().set_budget(60_000);
    let mut caps = Vec::new();
    for _ in 0..6 {
        run(&mut m, SECOND);
        caps.push((cap_of(&m), mixed(&m)));
    }
    // 40 -> 34 (45,648 WU > 42,000) -> 28 (38,748 WU: busy, holds).
    assert_eq!(caps.last(), Some(&(28, 28)));
    assert_eq!(caps[0], (34, 34));
    let p99 = m.core.cap().last_p99();
    assert_eq!(p99, 28 * wu::MIXED_VOICE + 12 * wu::VIRTUAL_VOICE + wu::BUS + wu::LIMITER);
    assert!(p99 as u64 * 1000 >= 60_000 * 550 && (p99 as u64) * 1000 <= 60_000 * 700);

    // The load ends (the budget back): 5 s of calm, then up once a second.
    m.core.cap_mut().set_budget(BUDGET_WU);
    let mut caps = Vec::new();
    for _ in 0..12 {
        run(&mut m, SECOND);
        caps.push(cap_of(&m));
    }
    assert_eq!(*caps.last().unwrap(), CONFIGURED);
    assert_eq!(&caps[..4], &[28, 28, 28, 28], "calm first");
}

#[test]
fn a_full_demoted_list_carries_the_rest_to_later_quanta() {
    // More demotes than one block's list holds can't happen at 64 voices; check the retry path by
    // filling the list first.
    let mut m = rig(CONFIGURED);
    run(&mut m, 10);
    let c = status::counters_mut(&mut m.core);
    while c.demoted.push(0) {}
    m.core.note_underruns(1);
    m.render();
    assert_eq!(cap_of(&m), 34);
    assert_eq!(m.core.cap().demoted, 0, "the list was full");
    status::counters_mut(&mut m.core).end_block();
    let demoted = run(&mut m, 1);
    assert_eq!(demoted.len(), 6, "demoted on the next quantum, once there was room");
}

#[test]
fn under_the_floor_nothing_happens() {
    let mut m = Mixer::over(core_with(8));
    m.submit(&voices(8));
    run(&mut m, 10);
    m.core.note_underruns(5);
    assert!(run(&mut m, 10).is_empty());
    assert_eq!(cap_of(&m), 8);
    assert!(!active(&m));
}

#[test]
fn p99_is_the_max_at_48k() {
    let mut m = rig(4);
    run(&mut m, 200);
    assert_eq!(m.core.cap().last_p99(), 4 * wu::MIXED_VOICE + wu::BUS + wu::LIMITER);
    assert_eq!(cap::NS_PER_WU, 1);
}

#[test]
fn a_large_cut_demotes_the_lowest_scores_64_a_quantum() {
    // 500 configured and mixed (scores shuffled across slots), one underrun: cap 425, 75 demotes.
    let mut m = Mixer::over(core_sized(512, 500));
    let score = |k: u32| (k * 211 % 500) as f32; // a permutation of 0..500 over k = 1..=500
    for chunk in 0..2u32 {
        let recs: Vec<Rec> = (0..250u32)
            .map(|j| {
                let k = chunk * 250 + j + 1;
                let Rec::Play(mut pl) = dc(id(k), ROOT, 0.0) else { unreachable!() };
                pl.gain = 1.0 / 1024.0;
                pl.score = score(k);
                Rec::Play(pl)
            })
            .collect();
        m.submit(&recs);
    }
    run(&mut m, 4);
    assert_eq!(mixed(&m), 500);
    m.core.note_underruns(1);
    let first = run(&mut m, 1);
    assert_eq!(cap_of(&m), 425);
    assert_eq!(first.len(), cap::DEMOTES_PER_QUANTUM);
    let rest = run(&mut m, 4);
    assert_eq!(rest.len(), 75 - cap::DEMOTES_PER_QUANTUM);
    let mut got: Vec<u32> = first.iter().chain(rest.iter()).map(|&v| score(v & 0xFFFF) as u32).collect();
    got.sort();
    assert_eq!(got, (0..75).collect::<Vec<u32>>(), "exactly the 75 lowest scores");
    run(&mut m, 2);
    assert_eq!(mixed(&m), 425);
}
