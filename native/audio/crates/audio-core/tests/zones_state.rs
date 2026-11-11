//! The zone slot state machine (ADR 0162 C3, leaf L-C3a; contracts C5, C7, OD2; api-and-models §9
//! "zone slot machine (waiting kernel, fade in, active, release, ring out, off, refused)"): every
//! ZONE_CONFIG transition of `zones.rs`'s table, the STATUS `zones`/`zoneEvents` it reports, and
//! both slot paths: the standby slot (high and default: 3 slots, a released zone rings out in its
//! own slot while the incoming zone takes the spare) and the eviction fade (low: 1 slot, the
//! outgoing zone fades out over 150 ms before the incoming one takes the slot).
//!
//! Helpers are in `zones_common` (a core with zone slots, kernels uploaded as format 3 clips,
//! ZONE_CONFIG records, slot input fed directly).

mod zones_common;

#[allow(unused_imports)]
use audio_core::{bus, clips, status, zones, QUANTUM};
#[allow(unused_imports)]
use audio_wire::generated as wire;
#[allow(unused_imports)]
use zones_common::*;

/// Quanta of a 100 ms fade-in at 48 kHz (4,800 frames, 128 per quantum): ACTIVE on the 38th.
const FADE_IN_QUANTA: usize = 38;
/// Quanta of a 150 ms eviction fade (7,200 frames): OFF on the quantum the fade reaches 0, the 57th.
const EVICT_QUANTA: usize = 57;

/// Quanta of silent input after which a ringing slot is off: `quantaSinceInput` must exceed
/// `ceil(irFrames / 128) + IDLE_MARGIN_QUANTA`, so the render that counts past it turns it off.
fn ring_out_quanta() -> usize {
    (IR_FRAMES as usize).div_ceil(QUANTUM) + zones::IDLE_MARGIN_QUANTA as usize + 1
}

/// Whether slot `k` holds a fed input (sends are accepted).
fn held(z: &Zones, k: usize) -> bool {
    zones::slot_header(&z.core, k).is_some_and(|h| h.input.iter().any(|v| *v != 0.0))
}

/// The zone events of `code` on slot `slot`, since the start of the test.
fn count_events(z: &Zones, slot: u8, code: u32) -> usize {
    z.events().iter().filter(|e| e.0 == slot && e.1 as u32 == code).count()
}

/// Feeds each slot in `slots` a quantum of noise and renders one quantum.
fn tick(z: &mut Zones, slots: &[usize], seed: u32) -> (Vec<f32>, Vec<f32>) {
    for &k in slots {
        z.feed(k, &noise(seed + k as u32));
    }
    z.render()
}

/// Runs `n` quanta feeding `slots`, then asserts each `(slot, state)` in `want`.
fn run_to(z: &mut Zones, slots: &[usize], n: usize, want: &[(usize, u32)]) {
    for q in 0..n {
        tick(z, slots, q as u32);
    }
    for &(k, state) in want {
        assert_eq!(z.state(k), state, "slot {k} after {n} quanta");
    }
}

#[test]
fn an_active_slot_waits_for_its_kernel_and_is_silent() {
    let mut z = Zones::new(3);
    z.config(1.0, 0, &[active(K1, 1.0)]);
    assert_eq!(z.state(0), zone_state::WAITING_KERNEL);
    // The kernel is absent: the slot accepts sends and holds them, but makes no wet.
    z.feed(0, &noise(1));
    assert!(held(&z, 0), "a waiting slot accepts sends");
    let (l, r) = tick(&mut z, &[0], 2);
    let (more_l, more_r) = z.run(60, |q| Some((0, noise(10 + q as u32))));
    assert!(peak(&l) == 0.0 && peak(&r) == 0.0 && peak(&more_l) == 0.0 && peak(&more_r) == 0.0, "silent while waiting");
    assert_eq!(z.state(0), zone_state::WAITING_KERNEL, "still waiting");
    let s = status::counters(&z.core).spatial;
    assert_eq!((s.zones[0].kernel_id, s.zones[0].state), (K1, zone_state::WAITING_KERNEL as u8));
    assert_eq!((s.zones_active, s.zones_ringing), (1, 0), "a waiting slot counts as active");
}

#[test]
fn the_kernel_arriving_starts_the_slot_fading_in_over_100_ms() {
    let mut z = Zones::new(3);
    z.config(1.0, 0, &[active(K1, 1.0)]);
    assert_eq!(z.state(0), zone_state::WAITING_KERNEL);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 21));
    assert_eq!(z.state(0), zone_state::FADING_IN, "the arrival starts it at once");
    for q in 0..FADE_IN_QUANTA {
        tick(&mut z, &[0], q as u32);
        let want = if q + 1 < FADE_IN_QUANTA { zone_state::FADING_IN } else { zone_state::ACTIVE };
        assert_eq!(z.state(0), want, "after {} quanta", q + 1);
    }
}

#[test]
fn a_resident_kernel_starts_fading_in_on_arrival_of_zone_config() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 22));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    assert_eq!(z.state(0), zone_state::FADING_IN, "resident: fading in without waiting");
    for q in 0..FADE_IN_QUANTA {
        tick(&mut z, &[0], q as u32);
        let want = if q + 1 < FADE_IN_QUANTA { zone_state::FADING_IN } else { zone_state::ACTIVE };
        assert_eq!(z.state(0), want, "after {} quanta", q + 1);
    }
}

#[test]
fn a_faded_in_slot_is_active_and_a_repeated_config_changes_nothing() {
    let blob = kernel_blob(IR_FRAMES, 23);
    let (mut a, mut b) = (Zones::new(3), Zones::new(3));
    for z in [&mut a, &mut b] {
        load_kernel(&mut z.core, K1, &blob);
        z.config(1.0, 0, &[active(K1, 1.0)]);
    }
    run_to(&mut a, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    run_to(&mut b, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    let (mut la, mut lb) = (Vec::new(), Vec::new());
    for q in 0..30u32 {
        for _ in 0..3 {
            a.config(1.0, 0, &[active(K1, 1.0)]);
        }
        assert_eq!(a.state(0), zone_state::ACTIVE, "a repeated config doesn't restart the fade");
        la.extend(tick(&mut a, &[0], 500 + q).0);
        lb.extend(tick(&mut b, &[0], 500 + q).0);
    }
    assert!(peak(&lb) > 0.01, "the slot is heard");
    assert_eq!(la, lb, "repeated configs change nothing");
}

#[test]
fn wet_ramps_without_restarting_the_slot() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 24));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    // Wet 1 to 0.5 over 100 ms: the slot stays active the whole way, and the ramp lands on 0.5.
    z.config(1.0, 4_800, &[active(K1, 0.5)]);
    assert_eq!(z.state(0), zone_state::ACTIVE, "a wet change doesn't restart the fade");
    for q in 0..FADE_IN_QUANTA {
        tick(&mut z, &[0], 700 + q as u32);
        assert_eq!(z.state(0), zone_state::ACTIVE, "quantum {q} of the ramp");
    }
    let h = zones::slot_header(&z.core, 0).unwrap();
    assert!(h.wet.is_settled() && (h.wet.value - 0.5).abs() < 1e-6, "wet landed on 0.5: {}", h.wet.value);
    assert!(h.fade.is_settled() && h.fade.value == 1.0, "the fade wasn't touched");
}

#[test]
fn release_ignores_sends_and_rings_out_then_the_slot_is_off() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 25));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::RELEASE as u8, 1.0, IR_FRAMES)]);
    assert_eq!(z.state(0), zone_state::RINGING_OUT);
    z.feed(0, &noise(900));
    assert!(!held(&z, 0), "a ringing slot ignores sends");
    let mut tail = Vec::new();
    let mut off_at = None;
    for q in 1..=ring_out_quanta() {
        let (l, _) = z.render();
        if z.state(0) == zone_state::OFF {
            off_at = Some(q);
            break;
        }
        assert_eq!(z.state(0), zone_state::RINGING_OUT, "quantum {q} after the release");
        tail.extend(l);
    }
    assert_eq!(off_at, Some(ring_out_quanta()), "off once quantaSinceInput passes ceil(irFrames/128) + 50");
    assert!(peak(&tail[QUANTUM * 10..]) > 1e-4, "the tail rings out");
    let (after, _) = z.run(5, |_| None);
    assert!(after.iter().all(|&v| v.abs() == 0.0), "silent once off");
    let s = status::counters(&z.core).spatial;
    assert_eq!((s.zones_active, s.zones_ringing), (0, 0));
}

#[test]
fn a_ringing_slot_set_active_again_is_active_without_a_new_fade() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 26));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::RELEASE as u8, 1.0, IR_FRAMES)]);
    z.run(5, |_| None);
    assert_eq!(z.state(0), zone_state::RINGING_OUT, "still ringing");
    z.config(1.0, 0, &[active(K1, 1.0)]);
    assert_eq!(z.state(0), zone_state::ACTIVE, "back to active at once, the fade having finished");
    let h = zones::slot_header(&z.core, 0).unwrap();
    assert!(h.fade.is_settled() && h.fade.value == 1.0, "no new fade-in");
    z.feed(0, &noise(901));
    assert!(held(&z, 0), "sends are accepted again");
    run_to(&mut z, &[0], 5, &[(0, zone_state::ACTIVE)]);
}

#[test]
fn release_or_evict_of_a_waiting_slot_turns_it_off() {
    for state in [zone_slot_state::RELEASE, zone_slot_state::EVICT] {
        let mut z = Zones::new(3);
        z.config(1.0, 0, &[active(K1, 1.0)]);
        assert_eq!(z.state(0), zone_state::WAITING_KERNEL);
        z.config(1.0, 0, &[(K1, 0, state as u8, 1.0, IR_FRAMES)]);
        assert_eq!(z.state(0), zone_state::OFF, "state {state}: off, not waiting");
        // Its kernel arriving later doesn't start a slot that is off.
        load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 27));
        z.run(3, |_| None);
        assert_eq!(z.state(0), zone_state::OFF, "state {state}: the kernel doesn't revive it");
        assert_eq!(zones::slot_header(&z.core, 0).unwrap().kernel_id, 0);
    }
}

#[test]
fn kernel_id_zero_fades_an_active_slot_out_instead_of_cutting_it() {
    let blob = kernel_blob(IR_FRAMES, 28);
    let (mut z, mut uncut) = (Zones::new(3), Zones::new(3));
    for c in [&mut z, &mut uncut] {
        load_kernel(&mut c.core, K1, &blob);
        c.config(1.0, 0, &[active(K1, 1.0)]);
        run_to(c, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    }
    z.config(1.0, 0, &[(0, 0, zone_slot_state::ACTIVE as u8, 1.0, 0)]);
    assert_eq!(z.state(0), zone_state::EVICTING, "kernel 0 evicts");
    for q in 0..EVICT_QUANTA {
        let x = noise(200 + q as u32);
        z.feed(0, &x);
        uncut.feed(0, &x);
        let (la, _) = z.render();
        let (lb, _) = uncut.render();
        if q == 0 {
            // The first quantum is the uncut slot's, its fade just begun: not a cut.
            assert!(peak(&lb) > 1e-3 && peak(&la) > 0.9 * peak(&lb), "not cut: {} vs {}", peak(&la), peak(&lb));
        }
        let want = if q + 1 < EVICT_QUANTA { zone_state::EVICTING } else { zone_state::OFF };
        assert_eq!(z.state(0), want, "after {} quanta", q + 1);
    }
}

#[test]
fn a_new_kernel_in_a_slot_that_is_not_off_is_refused_once() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 29));
    load_kernel(&mut z.core, K2, &kernel_blob(IR_FRAMES, 30));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], 10, &[(0, zone_state::FADING_IN)]);
    for _ in 0..3 {
        z.config(1.0, 0, &[active(K2, 1.0)]);
    }
    run_to(&mut z, &[0], 40, &[(0, zone_state::ACTIVE)]);
    assert_eq!(zones::slot_header(&z.core, 0).unwrap().kernel_id, K1, "the slot keeps its kernel");
    assert_eq!(z.state(1), zone_state::OFF, "K2 starts nowhere");
    assert_eq!(count_events(&z, 0, zone_event::REFUSED_KERNEL), 1, "{:?}", z.events());
}

#[test]
fn a_slot_past_max_zone_slots_is_refused() {
    let mut z = Zones::new(2);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 31));
    load_kernel(&mut z.core, K2, &kernel_blob(IR_FRAMES, 32));
    z.config(1.0, 0, &[active(K1, 1.0), active(K2, 1.0), active(K3, 1.0)]);
    assert_eq!(zones::slot_count(&z.core), 2);
    assert_eq!(count_events(&z, 2, zone_event::REFUSED_SLOT), 1, "{:?}", z.events());
    assert_eq!((z.state(0), z.state(1), z.state(2)), (zone_state::FADING_IN, zone_state::FADING_IN, zone_state::OFF));
}

#[test]
fn a_bad_kernel_blob_is_reported_once_and_the_slot_keeps_waiting() {
    // At another rate than the context's.
    let mut z = Zones::new(1);
    load_kernel(&mut z.core, K1, &kernel_blob_at(IR_FRAMES, 33, 44_100.0));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], 5, &[(0, zone_state::WAITING_KERNEL)]);
    assert_eq!(count_events(&z, 0, zone_event::BAD_BLOB), 1, "{:?}", z.events());

    // Longer than the slot holds: a 24,000-frame slot takes a 60,000-frame kernel's bytes, but
    // not its tail.
    let mut long = Zones::over(core_with(zone_params(4, 24_000)));
    load_kernel(&mut long.core, K1, &kernel_blob(60_000, 34));
    long.config(1.0, 0, &[active(K1, 1.0)]);
    long.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut long, &[0], 5, &[(0, zone_state::WAITING_KERNEL)]);
    assert_eq!(count_events(&long, 0, zone_event::BAD_BLOB), 1, "{:?}", long.events());
}

#[test]
fn evict_fades_out_over_150_ms_then_the_slot_is_off() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 35));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::EVICT as u8, 1.0, IR_FRAMES)]);
    assert_eq!(z.state(0), zone_state::EVICTING);
    for q in 1..=EVICT_QUANTA {
        z.feed(0, &noise(300 + q as u32));
        assert!(!held(&z, 0), "an evicting slot ignores sends");
        z.render();
        let want = if q < EVICT_QUANTA { zone_state::EVICTING } else { zone_state::OFF };
        assert_eq!(z.state(0), want, "quantum {q} of the eviction");
    }
    assert_eq!(zones::slot_header(&z.core, 0).unwrap().kernel_id, 0, "the slot is free");
    let (after, _) = z.run(3, |_| None);
    assert!(after.iter().all(|&v| v.abs() == 0.0), "silent once off");
}

#[test]
fn low_preset_swaps_zones_with_the_eviction_fade() {
    // One slot: the outgoing zone is evicted, and the incoming one is refused until the slot is off.
    // The budget is a kernel per slot, so K2 is uploaded only once K1 is gone.
    let mut z = Zones::new(1);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 36));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::EVICT as u8, 1.0, IR_FRAMES)]);
    z.config(1.0, 0, &[active(K2, 1.0)]);
    z.config(1.0, 0, &[active(K2, 1.0)]);
    assert_eq!(z.state(0), zone_state::EVICTING, "the incoming zone waits for the slot");
    assert_eq!(zones::slot_header(&z.core, 0).unwrap().kernel_id, K1, "K1 still holds the slot");
    assert_eq!(count_events(&z, 0, zone_event::REFUSED_KERNEL), 1, "{:?}", z.events());
    for q in 1..=EVICT_QUANTA {
        tick(&mut z, &[], q as u32);
        let want = if q < EVICT_QUANTA { zone_state::EVICTING } else { zone_state::OFF };
        assert_eq!(z.state(0), want, "quantum {q} of the eviction");
    }
    assert_eq!(clips::free(&mut z.core, K1), wire::ERR_OK);
    load_kernel(&mut z.core, K2, &kernel_blob(IR_FRAMES, 37));
    z.config(1.0, 0, &[active(K2, 1.0)]);
    assert_eq!(z.state(0), zone_state::FADING_IN, "the incoming zone takes the slot once it is off");
    assert_eq!(zones::slot_header(&z.core, 0).unwrap().kernel_id, K2);
    run_to(&mut z, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
}

#[test]
fn high_and_default_presets_swap_zones_through_the_standby_slot() {
    // Three slots (two active, one standby): the incoming zone takes the spare while the released
    // one rings out in its own slot.
    let mut z = Zones::new(3);
    for k in [K1, K2, K3] {
        load_kernel(&mut z.core, k, &kernel_blob(IR_FRAMES, k));
    }
    z.config(1.0, 0, &[active(K1, 1.0), active(K2, 1.0)]);
    run_to(&mut z, &[0, 1], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE), (1, zone_state::ACTIVE)]);
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::RELEASE as u8, 1.0, IR_FRAMES), active(K2, 1.0), active(K3, 1.0)]);
    assert_eq!((z.state(0), z.state(1), z.state(2)), (zone_state::RINGING_OUT, zone_state::ACTIVE, zone_state::FADING_IN));
    // The released zone's slot takes no new kernel while it rings (every slot is in the record: a
    // missing one is kernel 0, which would evict it).
    z.config(1.0, 0, &[active(K4, 1.0), active(K2, 1.0), active(K3, 1.0)]);
    assert_eq!(zones::slot_header(&z.core, 0).unwrap().kernel_id, K1, "the ringing slot keeps K1");
    assert_eq!(count_events(&z, 0, zone_event::REFUSED_KERNEL), 1);
    // The incoming zone is active; the released one is still ringing out at 38 quanta.
    run_to(&mut z, &[1, 2], FADE_IN_QUANTA, &[(0, zone_state::RINGING_OUT), (2, zone_state::ACTIVE)]);
    let s = status::counters(&z.core).spatial;
    assert_eq!((s.zones_active, s.zones_ringing), (2, 1), "two active or standing by, one ringing");
    // Then the tail has rung out and slot 0 is off, while the other two stay active.
    run_to(&mut z, &[1, 2], ring_out_quanta() - FADE_IN_QUANTA, &[(0, zone_state::OFF), (1, zone_state::ACTIVE), (2, zone_state::ACTIVE)]);
}

#[test]
fn reset_turns_every_slot_off() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 38));
    load_kernel(&mut z.core, K2, &kernel_blob(IR_FRAMES, 39));
    z.config(0.5, 0, &[active(K1, 1.0), active(K2, 0.5)]);
    run_to(&mut z, &[0, 1], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE), (1, zone_state::ACTIVE)]);
    assert_eq!(zones::shared_return_gain(&z.core), 0.5);
    z.submit(&[reset_rec(false)]);
    assert_eq!((z.state(0), z.state(1), z.state(2)), (zone_state::OFF, zone_state::OFF, zone_state::OFF));
    // STATUS's counts are those of the last render.
    tick(&mut z, &[], 0);
    let s = status::counters(&z.core).spatial;
    assert_eq!((s.zones_active, s.zones_ringing), (0, 0));
    assert_eq!(zones::shared_return_gain(&z.core), 1.0, "the shared return is back at 1");
}

#[test]
fn status_reports_every_slot_and_the_counts() {
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 40));
    load_kernel(&mut z.core, K3, &kernel_blob(IR_FRAMES, 41));
    // Slot 0 resident and active, slot 1 waiting for K2 (never loaded), slot 2 ringing out.
    z.config(1.0, 0, &[active(K1, 1.0), active(K2, 1.0), active(K3, 1.0)]);
    run_to(&mut z, &[0, 2], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE), (2, zone_state::ACTIVE)]);
    z.config(1.0, 0, &[active(K1, 1.0), active(K2, 1.0), (K3, 0, zone_slot_state::RELEASE as u8, 1.0, IR_FRAMES)]);
    run_to(&mut z, &[0], 2, &[(0, zone_state::ACTIVE), (2, zone_state::RINGING_OUT)]);
    let s = status::counters(&z.core).spatial;
    assert_eq!(s.zone_slots, 3);
    assert_eq!((s.zones[0].kernel_id, s.zones[0].state), (K1, zone_state::ACTIVE as u8));
    assert!(s.zones[0].wet_peak > 0.0, "the active slot's wet peak");
    assert_eq!((s.zones[1].kernel_id, s.zones[1].state), (K2, zone_state::WAITING_KERNEL as u8));
    assert_eq!((s.zones[2].kernel_id, s.zones[2].state), (K3, zone_state::RINGING_OUT as u8));
    assert_eq!(s.zones[2].quanta_since_input, 2, "the ringing slot's silence");
    assert_eq!((s.zones_active, s.zones_ringing), (2, 1), "waiting and active count as active, ringing as ringing");
    assert!(s.zone_used_kb > 0, "the kernels are resident");
}

#[test]
fn freeing_a_running_slots_kernel_sends_it_back_to_waiting() {
    let blob = kernel_blob(IR_FRAMES, 42);
    let mut z = Zones::new(1);
    load_kernel(&mut z.core, K1, &blob);
    z.config(1.0, 0, &[active(K1, 1.0)]);
    run_to(&mut z, &[0], FADE_IN_QUANTA, &[(0, zone_state::ACTIVE)]);
    assert_eq!(clips::free(&mut z.core, K1), wire::ERR_OK);
    tick(&mut z, &[0], 800);
    assert_eq!(z.state(0), zone_state::WAITING_KERNEL, "back to waiting on the next render");
    assert_eq!(zones::slot_header(&z.core, 0).unwrap().kernel_id, K1, "the slot keeps its kernel id");
    // The master limiter's look-ahead still carries the last wet for a while; then it is silent.
    assert!((bus::output_latency_frames(&z.core) as usize) < 7 * QUANTUM, "the look-ahead is shorter than the check");
    let (l, _) = z.run(8, |q| Some((0, noise(810 + q as u32))));
    assert!(peak(&l[7 * QUANTUM..]) == 0.0, "silent while waiting");
    assert_eq!(z.state(0), zone_state::WAITING_KERNEL, "still waiting");
    // The kernel back: the slot fades in again.
    load_kernel(&mut z.core, K1, &blob);
    assert_eq!(z.state(0), zone_state::FADING_IN, "the returning kernel restarts the slot");
}
