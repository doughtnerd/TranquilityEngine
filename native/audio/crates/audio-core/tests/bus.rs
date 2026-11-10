//! BUS_CONFIG, BUS_MIX and MASTER apply cases (api-and-models §4.2; task A2.1, leaf L2).
//!
//! Every case submits real BATCH messages and renders quanta, then reads the output, the bus state
//! (`audio_core::bus`) and the counters (K12). The DC clip makes each level exact.

mod common;

use audio_core::bus;
use audio_core::fx::kind;
use audio_core::status;
use audio_wire::generated as wire;
use common::*;

const TOL: f32 = 1e-6;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;

#[test]
fn before_any_bus_config_voices_play_at_unity_through_one_root() {
    let mut m = Mixer::new(8);
    assert_eq!(bus::count(&m.core), 1);
    assert_eq!(status::counters(&m.core).bus_count, 0, "no peaks are sent before BUS_CONFIG");
    m.submit(&[dc(V1, 5, 0.0)]);
    let (l, r) = m.render();
    check(&l, TOL, "unity, left", |_| 1.0);
    check(&r, TOL, "unity, right", |_| 1.0);
}

#[test]
fn bus_config_sets_the_tree_and_the_status_bus_count() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0, 1])]);
    assert_eq!(bus::count(&m.core), 4);
    assert_eq!(status::counters(&m.core).bus_count, 4);
    let s = bus::slots(&m.core);
    assert_eq!([s[0].parent, s[1].parent, s[2].parent, s[3].parent], [ROOT, 0, 0, 1]);
    assert_eq!([s[0].depth, s[1].depth, s[2].depth, s[3].depth], [0, 1, 1, 2]);
    assert_eq!(&bus::area(&m.core).order[..4], &[3, 1, 2, 0], "deepest first");
    assert!(s[..4].iter().all(|b| b.gain.value == 1.0 && b.lp.value == OFF), "new buses start at unity, low-pass off");
}

#[test]
fn gains_multiply_down_the_tree() {
    let mut m = Mixer::new(8);
    // 0 root; 1 under 0; 2 under 1.
    m.submit(&[config(&[ROOT, 0, 1]), gains(0, &[0.5, 0.5, 0.5]), dc(V1, 2, 0.0), dc(V2, 1, 0.0)]);
    let (l, r) = m.render();
    // V1: 0.5^3; V2: 0.5^2.
    check(&l, TOL, "tree, left", |_| 0.125 + 0.25);
    check(&r, TOL, "tree, right", |_| 0.125 + 0.25);
}

#[test]
fn a_muted_bus_silences_its_voices_only() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0]), gains(0, &[1.0, 0.0, 1.0]), dc(V1, 1, 0.0), dc(V2, 2, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "only bus 2 sounds", |_| 1.0);
}

#[test]
fn a_voice_on_an_unconfigured_bus_goes_to_the_root() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0]), gains(0, &[0.5, 0.0]), dc(V1, 7, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "bus 7 routes to bus 0", |_| 0.5);
}

#[test]
fn set_params_moves_a_voice_to_another_bus() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0]), gains(0, &[1.0, 0.25, 0.75]), dc(V1, 1, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "on bus 1", |_| 0.25);
    m.submit(&[set_bus(V1, 2)]);
    let (l, _) = m.render();
    check(&l, TOL, "on bus 2", |_| 0.75);
}

#[test]
fn buses_past_max_buses_are_dropped_and_counted() {
    let mut m = Mixer::new(4);
    m.submit(&[config(&[ROOT, 0, 0, 0, 0, 0])]);
    assert_eq!(bus::count(&m.core), 4);
    assert_eq!(bus::area(&m.core).dropped, 2);
    assert_eq!(status::counters(&m.core).bus_count, 4);
}

#[test]
fn bad_parents_and_cycles_are_repaired_to_the_first_root() {
    let mut m = Mixer::new(8);
    // 1 is its own parent, 2 is out of range, 3 and 4 form a cycle.
    m.submit(&[config(&[ROOT, 1, 40, 4, 3]), gains(0, &[0.5, 1.0, 1.0, 1.0, 1.0])]);
    for b in 1..5u16 {
        m.submit(&[dc(0x0001_0000 | b as u32, b, 0.0)]);
    }
    let (l, _) = m.render();
    check(&l, TOL, "four voices, each through the root at 0.5", |_| 2.0);
    let s = bus::slots(&m.core);
    for b in 0..5 {
        let mut at = b;
        let mut steps = 0;
        while s[at].parent != ROOT {
            at = s[at].parent as usize;
            steps += 1;
            assert!(steps <= 5, "bus {b} loops");
        }
        assert_eq!(at, 0);
    }
}

#[test]
fn an_empty_bus_config_keeps_one_root() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[]), dc(V1, 3, 0.0)]);
    assert_eq!(bus::count(&m.core), 1);
    let (l, _) = m.render();
    check(&l, TOL, "through the kept root", |_| 1.0);
}

#[test]
fn reconfiguring_keeps_the_gains_of_kept_buses_and_starts_new_ones_at_unity() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0]), gains(0, &[0.5, 0.25])]);
    m.submit(&[config(&[ROOT, 0, 0])]);
    let s = bus::slots(&m.core);
    assert_eq!([s[0].gain.target, s[1].gain.target, s[2].gain.target], [0.5, 0.25, 1.0]);
    m.submit(&[config(&[ROOT])]);
    assert_eq!(bus::count(&m.core), 1);
    assert_eq!(bus::slots(&m.core)[1].gain.target, 0.0, "a removed bus is silent");
}

#[test]
fn bus_mix_ramps_the_gain_from_the_next_quantum() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0]), dc(V1, 1, 0.0)]);
    m.render();
    m.submit(&[gains(200, &[1.0, 0.0])]);
    let (l, _) = m.render_n(2);
    check(&l, TOL, "gain ramp across two quanta", |k| ramp_to(1.0, 0.0, 200, k));
}

#[test]
fn bus_mix_entries_past_the_tree_are_dropped_and_missing_ones_keep_their_gain() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0]), gains(0, &[0.5, 0.5])]);
    m.submit(&[gains(0, &[0.25, 0.75, 0.1, 0.1])]);
    assert_eq!(bus::area(&m.core).dropped, 2);
    m.submit(&[gains(0, &[1.0])]);
    let s = bus::slots(&m.core);
    assert_eq!((s[0].gain.target, s[1].gain.target), (1.0, 0.75));
}

#[test]
fn non_finite_and_negative_values_are_neutralised() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0]), gains(0, &[0.5, 0.5, 0.5])]);
    m.submit(&[mix(0, &[(f32::NAN, f32::INFINITY), (-1.0, 500.0), (f32::INFINITY, -5.0)])]);
    let s = bus::slots(&m.core);
    assert_eq!(s[0].gain.target, 0.5, "NaN keeps the old target");
    assert_eq!(s[0].lp.target, OFF, "a non-finite cut-off is off");
    assert_eq!(s[1].gain.target, 0.0, "negative is 0");
    assert_eq!(s[1].lp.target, 500.0);
    assert_eq!(s[2].gain.target, 0.5, "infinity keeps the old target");
    assert_eq!(s[2].lp.target, 0.0, "a negative cut-off clamps to 0");
}

#[test]
fn the_snapshot_cut_off_ramps_per_quantum() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0]), mix(256, &[(1.0, OFF), (1.0, 800.0)])]);
    m.render();
    let lp = bus::slots(&m.core)[1].lp;
    assert!((lp.value - (OFF + (800.0 - OFF) * 0.5)).abs() < 0.01, "half way after one quantum: {}", lp.value);
    m.render();
    assert_eq!(bus::slots(&m.core)[1].lp.value, 800.0);
}

#[test]
fn master_volume_and_mute_ramp_the_output() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT]), dc(V1, 0, 0.0), master(0.5, false, 0)]);
    let (l, _) = m.render();
    check(&l, TOL, "volume 0.5", |_| 0.5);
    m.submit(&[master(0.5, true, 64)]);
    let (l, _) = m.render();
    check(&l, TOL, "mute ramps to 0", |k| ramp_to(0.5, 0.0, 64, k));
    m.submit(&[master(f32::NAN, false, 0)]);
    let (l, _) = m.render();
    check(&l, TOL, "unmute restores the last volume", |_| 0.5);
}

#[test]
fn a_stamped_bus_mix_applies_on_arrival() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT]), dc(V1, 0, 0.0)]);
    let Rec::Mix(mut r) = gains(0, &[0.25]) else { unreachable!() };
    r.frame_offset = 10_000;
    m.submit(&[Rec::Mix(r)]);
    let (l, _) = m.render();
    check(&l, TOL, "applied at once", |_| 0.25);
}

#[test]
fn effects_are_stored_per_bus_and_unknown_types_dropped() {
    let mut m = Mixer::new(8);
    m.submit(&[config_fx(&[
        (ROOT, vec![(kind::COMPRESSOR, -24.0, 30.0)]),
        // Send 0: the shared reverb (A2.2b) runs but adds no wet signal to the check below.
        (0, vec![(kind::LOWPASS, 800.0, 1.0), (kind::REVERB_SEND, 0.0, 0.0), (77, 0.0, 0.0)]),
        (0, vec![(kind::HIGHPASS, 120.0, 0.0); 6]),
    ])]);
    let s = bus::slots(&m.core);
    assert_eq!(s[0].fx.kinds().collect::<Vec<_>>(), vec![kind::COMPRESSOR]);
    assert_eq!(s[1].fx.kinds().collect::<Vec<_>>(), vec![kind::LOWPASS, kind::REVERB_SEND, kind::NONE]);
    assert_eq!(s[2].fx.kinds().count(), audio_core::fx::MAX_EFFECTS);
    let a = bus::area(&m.core);
    assert_eq!(a.dropped, 1 + 2, "one unknown type, two past the limit");
    assert_eq!(a.has_reverb, 1);
    // The stubs pass everything through: a voice on bus 1 is still at unity.
    m.submit(&[dc(V1, 1, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "stubbed effects pass through", |_| 1.0);
}

#[test]
fn a_bus_config_whose_entries_overrun_the_record_refuses_the_batch() {
    let mut m = Mixer::new(8);
    let mut msg = batch(0.0, &[dc(V1, 0, 0.0), config_fx(&[(ROOT, vec![(kind::LOWPASS, 500.0, 0.0)])])]);
    // The BUS_CONFIG starts after the PLAY (32 + 56); its bus's effectCount is at +16 +2.
    let at = 32 + wire::Play::FIXED_END + 16 + 2;
    msg[at..at + 2].copy_from_slice(&3u16.to_le_bytes());
    assert_eq!(audio_core::scheduler::submit(&mut m.core, &msg), wire::ERR_MALFORMED);
    assert_eq!(audio_core::voices::live_count(&mut m.core), 0, "the PLAY before it didn't apply");
    assert_eq!(bus::count(&m.core), 1);
}

#[test]
fn a_bus_mix_whose_count_overruns_the_record_refuses_the_batch() {
    let mut m = Mixer::new(8);
    let mut msg = batch(0.0, &[gains(0, &[0.5])]);
    msg[32 + 12..32 + 16].copy_from_slice(&5u32.to_le_bytes());
    assert_eq!(audio_core::scheduler::submit(&mut m.core, &msg), wire::ERR_MALFORMED);
    assert_eq!(bus::slots(&m.core)[0].gain.target, 1.0);
}

#[test]
fn meters_report_peaks_through_status_and_decay() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0]), gains(0, &[1.0, 0.5, 1.0]), dc(V1, 1, -1.0)]);
    m.render();
    let c = status::counters(&m.core);
    assert_eq!(c.bus_count, 3);
    let p = c.sent_peaks();
    assert!((p[1].l - 0.5).abs() < 1e-5 && p[1].r.abs() < 1e-5, "bus 1 hard left at 0.5: {:?}", p[1]);
    assert!((p[0].l - 0.5).abs() < 1e-5, "the root carries it too");
    assert_eq!((p[2].l, p[2].r), (0.0, 0.0));
    // Silence the voice: the meter falls 20 dB/s, so 375 quanta (one second) later it is a tenth.
    m.submit(&[gains(0, &[1.0, 0.0, 1.0])]);
    for _ in 0..375 {
        m.render();
    }
    let l = status::counters(&m.core).peaks[1].l;
    assert!((l - 0.05).abs() < 1e-4, "{l}");
    // STATUS carries them.
    let mut out = vec![0u8; status::BUFFER_BYTES];
    let n = status::take(&mut m.core, &mut out, 0);
    let block = wire::StatusBlock::read(&out[..n], 0).unwrap().0;
    assert_eq!(block.peaks.len(), 3);
    assert!((block.peaks[1].l - l).abs() < 1e-9);
}

#[test]
fn reset_keeps_the_tree_and_gains_and_clears_meters() {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0]), gains(0, &[1.0, 0.5]), dc(V1, 1, 0.0)]);
    m.render();
    m.submit(&[gains(10_000, &[1.0, 0.0]), master(0.25, false, 10_000)]);
    m.render();
    m.submit(&[reset(true)]);
    let s = bus::slots(&m.core);
    assert_eq!(bus::count(&m.core), 2);
    assert_eq!((s[1].gain.value, s[1].gain.remaining), (0.0, 0), "ramps settle on their targets");
    assert_eq!(s[1].meter.l, 0.0);
    assert_eq!(bus::area(&m.core).master.value, 0.25);
    assert_eq!(status::counters(&m.core).peaks[1].l, 0.0);
    m.submit(&[dc(V2, 0, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "the root still at unity under MASTER 0.25", |_| 0.25);
}
