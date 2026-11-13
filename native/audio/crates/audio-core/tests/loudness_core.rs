//! Ld2 (0171/0172 M5, architecture §4.4, api-and-models §4.2 `LOUD_CONFIG`, §4.3 `loudBuses`,
//! `loudEnergies`): core loudness driven through the core as the worklet drives it: `submit`,
//! `process` per quantum, `status::take` at a cadence. Every timing is on the audio clock (quanta
//! rendered between takes), never wall time.

mod common;

use audio_core::{loudness, status, QUANTUM};
use audio_dsp::loudness::{Meter, RING};
use audio_wire::generated as wire;
use common::*;

/// A looping sine clip.
const SINE: u32 = 2;
/// A looping quiet sine clip.
const QUIET: u32 = 3;
/// Frames per sub-block at 48 kHz.
const SUB: u64 = 4_800;

fn loud_config(gate_dbfs: f32, slots: &[u16]) -> Rec {
    let rec = wire::LoudConfig { voice_id: 0, frame_offset: wire::ASAP, tp_gate_dbfs: gate_dbfs, meters: vec![] };
    let mut b = vec![0u8; 20 + 4 * slots.len()];
    // Written by hand past 8 items (the generated writer refuses them; the core must drop them).
    rec.write(&mut b, 0).unwrap();
    b[16..20].copy_from_slice(&(slots.len() as u32).to_le_bytes());
    for (k, s) in slots.iter().enumerate() {
        b[20 + 4 * k..22 + 4 * k].copy_from_slice(&s.to_le_bytes());
    }
    let words = b.len() / 4;
    b[2..4].copy_from_slice(&(words as u16).to_le_bytes());
    Rec::Raw(b)
}

fn sine(amp: f32, hz: f32) -> Vec<f32> {
    // 48 kHz / 1,000 Hz: 48 frames a period; 4,800 frames is a whole number of periods.
    (0..4_800).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / RATE).sin()).collect()
}

/// Four buses under the root, a sine on bus 1 and a quiet one on bus 2.
fn scene() -> Mixer {
    let mut m = Mixer::new(8);
    m.load_clip(SINE, &sine(0.8, 1_000.0));
    m.load_clip(QUIET, &sine(0.05, 500.0));
    m.submit(&[config(&[ROOT, 0, 0, 0]), play(0x0001_0001, SINE, 1, MIXED | LOOP), play(0x0001_0002, QUIET, 2, MIXED | LOOP)]);
    m
}

/// One quantum, without keeping the output (long runs).
fn step(m: &mut Mixer) {
    m.core.process(m.frame);
    m.frame += QUANTUM as u64;
}

fn take(m: &mut Mixer) -> Option<wire::StatusBlock> {
    let mut out = vec![0u8; status::BUFFER_BYTES];
    let n = status::take(&mut m.core, &mut out, 0x400);
    (n > 0).then(|| wire::StatusBlock::read(&out[..n], 0).unwrap().0)
}

fn count(it: &wire::StatusLoudBusesItem) -> u32 {
    (it.flags as u32) & wire::LOUD_FLAG_NEW_BLOCKS_MASK
}

fn has(it: &wire::StatusLoudBusesItem, flag: u32) -> bool {
    it.flags as u32 & flag != 0
}

fn item(s: &wire::StatusBlock, slot: u16) -> wire::StatusLoudBusesItem {
    s.loud_buses.iter().find(|b| b.slot == slot).cloned().unwrap_or_else(|| panic!("no meter for slot {slot}"))
}

/// Each meter's energies in this block, by slot.
fn energies(s: &wire::StatusBlock, slot: u16) -> Vec<f32> {
    let mut off = 0usize;
    for b in &s.loud_buses {
        let n = count(b) as usize;
        if b.slot == slot {
            return s.loud_energies[off..off + n].to_vec();
        }
        off += n;
    }
    panic!("no meter for slot {slot}")
}

#[test]
fn nothing_is_metered_and_nothing_changes_until_a_loud_config() {
    let render = |metered: bool| {
        let mut m = scene();
        if metered {
            m.submit(&[loud_config(-7.0, &[1, 2, 3])]);
        }
        let out = m.render_n(200);
        let s = take(&mut m).unwrap();
        (out, s, status::counters(&m.core).mix)
    };
    let (plain, s, mix) = render(false);
    assert!(s.loud_buses.is_empty() && s.loud_energies.is_empty(), "no LOUD_CONFIG: no meter, the K1 block");
    assert_eq!((mix.wu_loudness, s.wu_loudness), (0.0, 0.0));
    assert_eq!(s.loud_sub_block_frames, 4_800, "loudSubBlockFrames from init");
    let (metered, s, _) = render(true);
    assert_eq!(s.loud_buses.len(), 4, "master and three buses");
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert!(plain.0.iter().any(|x| *x != 0.0));
    assert_eq!((bits(&plain.0), bits(&plain.1)), (bits(&metered.0), bits(&metered.1)), "the taps only read: the output is bit-identical");
}

/// Long runs at both STATUS cadences (6 quanta while batches flow, 48 idle): every sub-block the
/// meters close reaches a take exactly once, in order, none lost.
#[test]
fn no_sub_block_is_lost_at_either_cadence_over_a_long_run() {
    for cadence in [6u64, 48] {
        let mut m = scene();
        m.submit(&[loud_config(-7.0, &[1, 2])]);
        let quanta = 40 * 48_000 / QUANTUM as u64; // 40 s
        let slots = [loudness::OUTPUT_TAP, 1, 2];
        let mut next = [0u32; 3];
        let mut energies_seen = [0usize; 3];
        let mut takes = 0;
        for q in 1..=quanta {
            step(&mut m);
            if q % cadence != 0 {
                continue;
            }
            let s = take(&mut m).unwrap();
            takes += 1;
            assert_eq!(s.loud_buses.len(), 3);
            for (k, &slot) in slots.iter().enumerate() {
                let it = item(&s, slot);
                assert!(!has(&it, wire::LOUD_FLAG_LOST), "cadence {cadence}: nothing lost");
                assert_eq!(it.first_seq, next[k], "cadence {cadence}, slot {slot}: contiguous");
                assert_eq!(has(&it, wire::LOUD_FLAG_RESET), takes == 1, "reset on the first take only");
                next[k] += count(&it);
                let e = energies(&s, slot);
                assert!(e.iter().all(|x| x.is_finite() && *x >= 0.0));
                energies_seen[k] += e.len();
            }
        }
        // The run's end: one more take collects what the last cadence left.
        let s = take(&mut m).unwrap();
        for (k, &slot) in slots.iter().enumerate() {
            let it = item(&s, slot);
            assert_eq!(it.first_seq, next[k]);
            next[k] += count(&it);
            energies_seen[k] += energies(&s, slot).len();
        }
        let produced = (quanta * QUANTUM as u64 / SUB) as u32;
        assert_eq!(next, [produced; 3], "cadence {cadence}: produced = taken");
        assert_eq!(energies_seen, [produced as usize; 3]);
        assert_eq!(status::counters(&m.core).mix.loud_sub_blocks_lost, 0);
    }
}

/// A main stall is quanta rendered with no take: 3 s (30 sub-blocks) fits the 32-entry ring, 4 s
/// (40) overwrites the oldest 8, which the take flags `lost` (main sets `incomplete`).
#[test]
fn a_3_s_stall_loses_nothing_and_a_4_s_stall_is_flagged_lost() {
    for (seconds, lost) in [(3u64, 0u32), (4, 8)] {
        let mut m = scene();
        m.submit(&[loud_config(-7.0, &[1])]);
        let _ = take(&mut m).unwrap();
        // Stall `seconds` of audio-clock time: 48,000 × s frames, whole quanta.
        for _ in 0..seconds * 48_000 / QUANTUM as u64 {
            step(&mut m);
        }
        let s = take(&mut m).unwrap();
        let produced = (seconds * 10) as u32;
        for slot in [loudness::OUTPUT_TAP, 1] {
            let it = item(&s, slot);
            let n = produced.min(RING as u32);
            assert_eq!(count(&it), n, "{seconds} s: the sub-blocks the ring holds");
            assert_eq!(has(&it, wire::LOUD_FLAG_LOST), lost > 0, "{seconds} s: lost flag");
            assert_eq!(it.first_seq, produced - n, "{seconds} s: firstSeq shows the gap");
            assert_eq!(energies(&s, slot).len(), n as usize);
        }
        assert_eq!(status::counters(&m.core).mix.loud_sub_blocks_lost, 2 * lost, "two meters");
        // The next take carries only what is new.
        for _ in 0..(SUB / QUANTUM as u64 + 1) {
            step(&mut m);
        }
        let s = take(&mut m).unwrap();
        let it = item(&s, 1);
        assert!(!has(&it, wire::LOUD_FLAG_LOST));
        assert_eq!((it.first_seq, count(&it)), (produced, 1));
    }
}

/// A take whose buffer is too short writes nothing and advances nothing: the next one carries the
/// same sub-blocks and the same peak.
#[test]
fn a_failed_take_sends_the_same_sub_blocks_again() {
    let mut m = scene();
    m.submit(&[loud_config(-7.0, &[1])]);
    for _ in 0..(3 * SUB / QUANTUM as u64 + 1) {
        step(&mut m);
    }
    let mut short = vec![0u8; 300];
    assert_eq!(status::take(&mut m.core, &mut short, 0x400), 0);
    let s = take(&mut m).unwrap();
    let it = item(&s, 1);
    assert_eq!((it.first_seq, count(&it)), (0, 3));
    assert!(has(&it, wire::LOUD_FLAG_RESET), "the reset flag waits for a successful take");
    assert!(it.true_peak > 0.5);
    let s = take(&mut m).unwrap();
    let it = item(&s, 1);
    assert_eq!((it.first_seq, count(&it), it.true_peak), (3, 0, 0.0), "sent: the cursor moved, the peak cleared");
    assert!(!has(&it, wire::LOUD_FLAG_RESET));
}

/// Master's tap is the final output after the limiter: its energies are a stand-alone meter's over
/// the rendered output, bit for bit, and its peak stays at the 0 dBFS ceiling while the bus feeding
/// it peaks near 2. A bus's tap is post-fader: half the gain, a quarter of the energy.
#[test]
fn master_taps_after_the_limiter_and_buses_tap_post_fader() {
    let run = |bus_gain: f32| {
        let mut m = Mixer::new(8);
        m.load_clip(SINE, &sine(1.0, 1_000.0));
        // Two sines in phase on bus 1: the bus peaks near 2 (the pan law aside), well over the ceiling.
        m.submit(&[config(&[ROOT, 0]), play(0x0001_0001, SINE, 1, MIXED | LOOP), play(0x0001_0002, SINE, 1, MIXED | LOOP), loud_config(-7.0, &[1])]);
        if bus_gain != 1.0 {
            m.submit(&[Rec::Ramps(vec![lane_ramp(1, wire::LANE_AUTHORED, Some(bus_gain), None, 0)])]);
        }
        let _ = take(&mut m).unwrap();
        let mut reference = Meter::new(48_000.0);
        let mut ring = [0.0f32; RING];
        let mut want = Vec::new();
        for _ in 0..(4 * SUB / QUANTUM as u64) {
            let (l, r) = m.render();
            let before = reference.seq();
            reference.process(&l, &r, &mut ring);
            for e in before..reference.seq() {
                want.push(ring[e as usize % RING]);
            }
        }
        let s = take(&mut m).unwrap();
        (s, want)
    };
    let (s, want) = run(1.0);
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert_eq!(want.len(), 4);
    assert_eq!(bits(&energies(&s, loudness::OUTPUT_TAP)), bits(&want), "master = the output after the limiter");
    let master = item(&s, loudness::OUTPUT_TAP);
    let bus = item(&s, 1);
    assert!(bus.true_peak > 1.3, "the bus is over the ceiling: {}", bus.true_peak);
    assert!(master.true_peak <= 1.05, "the output is limited: {}", master.true_peak);
    let full = energies(&s, 1);
    let (s, _) = run(0.5);
    let half = energies(&s, 1);
    for (h, f) in half.iter().zip(&full) {
        assert!((h / f - 0.25).abs() < 1e-4, "post-fader: {h} against {f}");
    }
}

#[test]
fn loud_config_replaces_all_keeps_the_meters_that_stay_and_drops_what_it_must() {
    let mut m = scene();
    m.submit(&[loud_config(-7.0, &[1, 2])]);
    for _ in 0..(2 * SUB / QUANTUM as u64) {
        step(&mut m);
    }
    let s = take(&mut m).unwrap();
    let slots: Vec<u16> = s.loud_buses.iter().map(|b| b.slot).collect();
    assert_eq!(slots, vec![loudness::OUTPUT_TAP, 1, 2], "master first, then the buses");
    // Replace: 1 goes, 2 stays, 3 comes. It applies before the next quantum renders.
    m.submit(&[loud_config(-7.0, &[2, 3])]);
    let s = take(&mut m).unwrap();
    let slots: Vec<u16> = s.loud_buses.iter().map(|b| b.slot).collect();
    assert_eq!(slots, vec![loudness::OUTPUT_TAP, 3, 2], "3 takes the freed index");
    let (two, three) = (item(&s, 2), item(&s, 3));
    assert_eq!((two.first_seq, has(&two, wire::LOUD_FLAG_RESET)), (2, false), "a meter that stays keeps its sequence");
    assert_eq!((three.first_seq, count(&three), has(&three, wire::LOUD_FLAG_RESET)), (0, 0, true), "a new meter starts fresh");
    for _ in 0..(SUB / QUANTUM as u64 + 1) {
        step(&mut m);
    }
    let s = take(&mut m).unwrap();
    assert_eq!((count(&item(&s, 2)), count(&item(&s, 3))), (1, 1), "both meter from the next quantum");
    assert_eq!(status::counters(&m.core).mix.loud_meters_dropped, 0);
    // Duplicates, the output tap and a slot past the 4 configured buses drop (the eighth-item cap: below).
    m.submit(&[loud_config(-7.0, &[1, 1, loudness::OUTPUT_TAP, 99, 2, 3, 0, 1, 2, 3])]);
    let s = take(&mut m).unwrap();
    let mut slots: Vec<u16> = s.loud_buses.iter().map(|b| b.slot).collect();
    slots.sort();
    assert_eq!(slots, vec![0, 1, 2, 3, loudness::OUTPUT_TAP]);
    assert_eq!(status::counters(&m.core).mix.loud_meters_dropped, 6);
    // An empty list keeps master only.
    m.submit(&[loud_config(-7.0, &[])]);
    let s = take(&mut m).unwrap();
    assert_eq!(s.loud_buses.len(), 1);
    assert_eq!(s.loud_buses[0].slot, loudness::OUTPUT_TAP);
}

/// The gate (`tpGateDbfs`, the ceiling − 6 dB) skips the FIR on a quiet bus, never on master or on
/// a loud bus; the gated count is cumulative, the flag says "since the last take". A non-finite
/// gate runs the FIR every quantum.
#[test]
fn the_true_peak_gate_skips_quiet_quanta_off_master_and_counts_them() {
    let mut m = scene();
    m.submit(&[loud_config(-7.0, &[1, 2])]);
    let n = 100u32;
    for _ in 0..n {
        step(&mut m);
    }
    let s = take(&mut m).unwrap();
    let (master, loud, quiet) = (item(&s, loudness::OUTPUT_TAP), item(&s, 1), item(&s, 2));
    assert_eq!((master.gated_quanta, has(&master, wire::LOUD_FLAG_GATED), has(&master, wire::LOUD_FLAG_TP_GATE_ACTIVE)), (0, false, false), "master: every quantum");
    assert_eq!((loud.gated_quanta, has(&loud, wire::LOUD_FLAG_GATED), has(&loud, wire::LOUD_FLAG_TP_GATE_ACTIVE)), (0, false, true), "a loud bus reaches the gate");
    assert_eq!((quiet.gated_quanta, has(&quiet, wire::LOUD_FLAG_GATED), has(&quiet, wire::LOUD_FLAG_TP_GATE_ACTIVE)), (n, true, true), "a quiet bus is gated");
    let s = take(&mut m).unwrap();
    let quiet = item(&s, 2);
    assert_eq!((quiet.gated_quanta, has(&quiet, wire::LOUD_FLAG_GATED)), (n, false), "nothing rendered since: no new skip");
    // A gate change alone is not a reset (the meter keeps its sequence and count).
    m.submit(&[loud_config(f32::NAN, &[1, 2])]);
    for _ in 0..n {
        step(&mut m);
    }
    let s = take(&mut m).unwrap();
    let quiet = item(&s, 2);
    assert_eq!((quiet.gated_quanta, has(&quiet, wire::LOUD_FLAG_GATED), has(&quiet, wire::LOUD_FLAG_TP_GATE_ACTIVE), has(&quiet, wire::LOUD_FLAG_RESET)), (n, false, false, false));
    // Below the quiet bus's peak: it runs again.
    m.submit(&[loud_config(-40.0, &[1, 2])]);
    for _ in 0..n {
        step(&mut m);
    }
    assert_eq!(item(&take(&mut m).unwrap(), 2).gated_quanta, n);
}

/// `wuLoudness`: per meter and quantum `wu::METER`, plus `wu::TRUE_PEAK` when the FIR ran;
/// cumulative across takes, a failed take included.
#[test]
fn wu_loudness_counts_each_meter_and_each_fir() {
    let mut m = scene();
    m.submit(&[loud_config(-7.0, &[1, 2])]);
    let n = 60u64;
    for _ in 0..n {
        step(&mut m);
    }
    let per = (loudness::wu::METER + loudness::wu::TRUE_PEAK) as f64;
    // Master and the loud bus run the FIR, the quiet bus is gated.
    let want = n as f64 * (2.0 * per + loudness::wu::METER as f64);
    let mut short = vec![0u8; 300];
    assert_eq!(status::take(&mut m.core, &mut short, 0x400), 0);
    assert_eq!(status::counters(&m.core).mix.wu_loudness, want);
    let s = take(&mut m).unwrap();
    assert_eq!(s.wu_loudness, want, "counted once across the failed take");
    for _ in 0..n {
        step(&mut m);
    }
    assert_eq!(take(&mut m).unwrap().wu_loudness, 2.0 * want, "cumulative");
}

/// RESET reseeds the meters: the next take carries `reset` and a sequence from 0; the
/// configuration and the gate stay.
#[test]
fn reset_restarts_each_sequence_and_keeps_the_configuration() {
    let mut m = scene();
    m.submit(&[loud_config(-7.0, &[1, 2])]);
    for _ in 0..(3 * SUB / QUANTUM as u64) {
        step(&mut m);
    }
    let _ = take(&mut m).unwrap();
    m.submit(&[reset(true), play(0x0002_0001, QUIET, 2, MIXED | LOOP)]);
    let s = take(&mut m).unwrap();
    assert_eq!(s.loud_buses.len(), 3, "the configuration stays");
    for b in &s.loud_buses {
        assert!(has(b, wire::LOUD_FLAG_RESET), "slot {}", b.slot);
        assert_eq!((b.first_seq, count(b), b.gated_quanta), (0, 0, 0));
    }
    for _ in 0..(SUB / QUANTUM as u64 + 1) {
        step(&mut m);
    }
    let s = take(&mut m).unwrap();
    let quiet = item(&s, 2);
    assert_eq!((quiet.first_seq, count(&quiet), has(&quiet, wire::LOUD_FLAG_RESET)), (0, 1, false));
    assert!(has(&quiet, wire::LOUD_FLAG_TP_GATE_ACTIVE) && quiet.gated_quanta > 0, "the gate stays");
}

#[test]
fn items_past_the_eighth_meter_are_dropped_and_counted() {
    let mut m = Mixer::new(16);
    m.submit(&[config(&[ROOT, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), loud_config(-7.0, &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]);
    let s = take(&mut m).unwrap();
    let slots: Vec<u16> = s.loud_buses.iter().map(|b| b.slot).collect();
    assert_eq!(slots, vec![loudness::OUTPUT_TAP, 1, 2, 3, 4, 5, 6, 7, 8], "master and the first eight");
    assert_eq!(status::counters(&m.core).mix.loud_meters_dropped, 2);
    // A level: the next record that drops nothing reads 0.
    m.submit(&[loud_config(-7.0, &[1])]);
    assert_eq!(status::counters(&m.core).mix.loud_meters_dropped, 0);
}
