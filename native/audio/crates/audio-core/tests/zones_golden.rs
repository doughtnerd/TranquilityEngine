//! Zone slots through the core (ADR 0162 C3, api-and-models §9 "Golden" and §10 C3): two blending
//! zones, ring-out then slot off, a rebuild (RESET, ZONE_CONFIG waiting for its kernel, the kernel,
//! the fade-in), the shared-return scale, the kernel budget and the load-shedding ladder. The
//! expectations are computed from the spec: a slot's wet is C1's instance over the same kernel and
//! input (its output never depends on the stagger phase), times `wet` and the fade, added to its
//! return bus, heard after the master limiter's fixed look-ahead.

mod zones_common;

use audio_core::{bus, clips, zones, QUANTUM};
use audio_dsp::convolver::instance::{state_bytes, Instance, SHARED_PHASE};
use audio_dsp::convolver::kernel::Kernel;
use audio_dsp::convolver::{Scratch, SCRATCH_BYTES};
use audio_wire::generated as wire;
use zones_common::*;

fn bytes_of(v: &mut [u64]) -> &mut [u8] {
    // SAFETY: a u64 buffer viewed as its bytes.
    unsafe { core::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, v.len() * 8) }
}

/// C1's instance over `blob`, fed `input(q)` (both channels) for `n` quanta: the dry convolution.
fn reference(blob: &[u8], n: usize, input: impl Fn(usize) -> [f32; QUANTUM]) -> (Vec<f32>, Vec<f32>) {
    let mut kb = vec![0u64; blob.len().div_ceil(8)];
    bytes_of(&mut kb)[..blob.len()].copy_from_slice(blob);
    let kernel = Kernel::parse(&bytes_of(&mut kb)[..blob.len()]).unwrap();
    let mut sb = vec![0u64; SCRATCH_BYTES / 8];
    let mut scratch = Scratch::from_bytes(bytes_of(&mut sb)).unwrap();
    scratch.fill_twiddles();
    let mut st = vec![0u64; state_bytes(kernel.tail_parts()).div_ceil(8)];
    Instance::start(kernel, bytes_of(&mut st), SHARED_PHASE).unwrap();
    let (mut l, mut r) = (Vec::new(), Vec::new());
    for q in 0..n {
        let x = input(q);
        let (mut ol, mut or) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
        Instance::attach(kernel, bytes_of(&mut st)).unwrap().process(&mut scratch, &x, &x, &mut ol, &mut or);
        l.extend(ol);
        r.extend(or);
    }
    (l, r)
}

/// The 100 ms fade-in's gain at frame `n` of the slot's first rendered quantum (`Ramp`'s steps).
fn fade_in(n: usize) -> f32 {
    let mut ramp = audio_dsp::ramp::Ramp::at(0.0);
    ramp.set_target(1.0, RATE as u32 / 10);
    let mut g = 0.0;
    for _ in 0..=n {
        g = ramp.next();
    }
    g
}

/// Asserts `heard` (output frames) is `want(core frame)` after the limiter's look-ahead.
fn expect_heard(heard: &[f32], latency: usize, tol: f32, what: &str, want: impl Fn(usize) -> f32) {
    for (h, &a) in heard.iter().enumerate() {
        let w = if h < latency { 0.0 } else { want(h - latency) };
        assert!((a - w).abs() <= tol, "{what}: heard frame {h} is {a}, expected {w}");
    }
}

#[test]
fn two_zones_blend_into_their_return_buses() {
    let (b1, b2) = (kernel_blob(IR_FRAMES, 1), kernel_blob(IR_FRAMES, 2));
    let n = 120;
    let x1 = |q: usize| noise(q as u32);
    let x2 = |q: usize| noise(1000 + q as u32).map(|v| v * 0.5);
    let mut z = Zones::new(3);
    let latency = bus::output_latency_frames(&z.core) as usize;
    load_kernel(&mut z.core, K1, &b1);
    load_kernel(&mut z.core, K2, &b2);
    z.config(1.0, 0, &[active(K1, 1.0), active(K2, 0.5)]);
    assert_eq!((z.state(0), z.state(1), z.state(2)), (zone_state::FADING_IN, zone_state::FADING_IN, zone_state::OFF));
    let (mut l, mut r) = (Vec::new(), Vec::new());
    for q in 0..n {
        z.feed(0, &x1(q));
        z.feed(1, &x2(q));
        let (a, b) = z.render();
        l.extend(a);
        r.extend(b);
    }
    assert_eq!((z.state(0), z.state(1)), (zone_state::ACTIVE, zone_state::ACTIVE), "faded in after 100 ms");
    let (r1l, r1r) = reference(&b1, n, x1);
    let (r2l, r2r) = reference(&b2, n, x2);
    let want_l = |i: usize| fade_in(i) * (r1l[i] + 0.5 * r2l[i]);
    let want_r = |i: usize| fade_in(i) * (r1r[i] + 0.5 * r2r[i]);
    assert!(peak(&r1l) > 0.01 && peak(&r2l) > 0.01, "the references are heard");
    expect_heard(&l, latency, 2e-5, "left", want_l);
    expect_heard(&r, latency, 2e-5, "right", want_r);
    let s = audio_core::status::counters(&z.core).spatial;
    assert_eq!((s.zone_slots, s.zones_active, s.zones_ringing), (3, 2, 0));
    assert_eq!(s.zones[0].kernel_id, K1);
    assert!(s.zones[0].wet_peak > 0.0 && s.zone_used_kb > 0);
    assert_eq!(s.work_zones, 2 * zones::SLOT_WU);
}

#[test]
fn a_return_bus_takes_the_bus_gain_and_an_unknown_bus_goes_to_the_root() {
    let blob = kernel_blob(IR_FRAMES, 3);
    let run = |bus: u16, gain: f32| {
        let mut z = Zones::new(1);
        // Two buses under the root; bus 1 at `gain`.
        let mut cfg = vec![0u8; 0];
        let rec = wire::BusConfig {
            voice_id: 0,
            frame_offset: wire::ASAP,
            buses: vec![wire::BusConfigBuses { parent: wire::BUS_ROOT as u16, effects: vec![] }, wire::BusConfigBuses { parent: 0, effects: vec![] }],
        };
        cfg.resize(64, 0);
        let len = rec.write(&mut cfg, 0).unwrap();
        cfg.truncate(len);
        let mut mix = vec![0u8; 64];
        let rec = wire::BusMix { voice_id: 0, frame_offset: wire::ASAP, ramp_frames: 0, buses: vec![wire::BusMixBuses { gain: 1.0, lp_hz: 24_000.0 }, wire::BusMixBuses { gain, lp_hz: 24_000.0 }] };
        let len = rec.write(&mut mix, 0).unwrap();
        mix.truncate(len);
        z.submit(&[cfg, mix]);
        load_kernel(&mut z.core, K1, &blob);
        z.config(1.0, 0, &[(K1, bus, zone_slot_state::ACTIVE as u8, 1.0, IR_FRAMES)]);
        z.run(60, |q| Some((0, noise(q as u32)))).0
    };
    let root = run(0, 1.0);
    let half = run(1, 0.5);
    let unknown = run(7, 0.5);
    for i in 0..root.len() {
        assert!((half[i] - 0.5 * root[i]).abs() < 1e-6, "bus 1 at 0.5, frame {i}");
        assert_eq!(unknown[i], root[i], "an unconfigured return bus goes to bus 0, frame {i}");
    }
    assert!(peak(&root) > 0.01);
}

#[test]
fn a_released_zone_rings_out_then_its_slot_is_off() {
    let blob = kernel_blob(IR_FRAMES, 4);
    let mut z = Zones::new(3);
    load_kernel(&mut z.core, K1, &blob);
    z.config(1.0, 0, &[active(K1, 1.0)]);
    z.run(60, |q| Some((0, noise(q as u32))));
    z.config(1.0, 0, &[(K1, 0, zone_slot_state::RELEASE as u8, 1.0, IR_FRAMES)]);
    assert_eq!(z.state(0), zone_state::RINGING_OUT);
    // Sends are ignored now; the tail goes on for the IR's length.
    let (tail, _) = z.run(20, |q| Some((0, noise(500 + q as u32))));
    assert!(peak(&tail[QUANTUM * 10..]) > 1e-4, "the tail rings");
    let ir_quanta = (IR_FRAMES as usize).div_ceil(QUANTUM);
    let mut off_at = None;
    for q in 0..ir_quanta + 80 {
        z.render();
        if z.state(0) == zone_state::OFF {
            off_at = Some(20 + q);
            break;
        }
        assert_eq!(z.state(0), zone_state::RINGING_OUT);
    }
    let off_at = off_at.expect("the slot goes off once the tail has rung out");
    assert!(off_at > ir_quanta && off_at <= ir_quanta + zones::IDLE_MARGIN_QUANTA as usize + 2, "off after {off_at} quanta");
    let (after, _) = z.run(10, |_| None);
    assert!(after.iter().all(|&v| v.abs() < 1e-7), "silent once off");
    // An off slot takes a new kernel at once.
    load_kernel(&mut z.core, K2, &kernel_blob(IR_FRAMES, 5));
    z.config(1.0, 0, &[active(K2, 1.0)]);
    assert_eq!(z.state(0), zone_state::FADING_IN);
}

#[test]
fn a_rebuild_waits_for_the_kernel_then_fades_in() {
    let blob = kernel_blob(IR_FRAMES, 6);
    let n = 60;
    let x = |q: usize| noise(7 + q as u32);
    let mut z = Zones::new(3);
    let latency = bus::output_latency_frames(&z.core) as usize;
    load_kernel(&mut z.core, K1, &blob);
    z.config(1.0, 0, &[active(K1, 1.0)]);
    z.run(40, |q| Some((0, x(q))));
    // REPLAY after a rebuild: RESET 0 (clips go), ZONE_CONFIG before its kernel.
    z.submit(&[reset_rec(false), zone_config(1.0, 0, &[active(K1, 1.0)])]);
    assert_eq!(z.state(0), zone_state::WAITING_KERNEL, "held waiting for its kernel");
    let (silent, _) = z.run(10, |q| Some((0, x(q))));
    assert!(silent.iter().all(|&v| v.abs() < 1e-6), "a zone that isn't resident plays dry (silent wet)");
    assert_eq!(audio_core::status::counters(&z.core).spatial.zones[0].state as u32, zone_state::WAITING_KERNEL);
    load_kernel(&mut z.core, K1, &blob);
    assert_eq!(z.state(0), zone_state::FADING_IN);
    let (l, _) = z.run(n, |q| Some((0, x(q))));
    // The slot restarted clean (RESET also cleared the limiter's delay line): the reference from
    // its first quantum, with a fresh fade.
    let (rl, _) = reference(&blob, n, x);
    expect_heard(&l, latency, 2e-5, "after the rebuild", |i| fade_in(i) * rl[i]);
}

#[test]
fn the_shared_reverb_return_follows_shared_return_gain() {
    use audio_core::fx::kind;
    let run = |shared: Option<f32>| {
        let mut z = Zones::new(1);
        let mut cfg = vec![0u8; 64];
        let rec = wire::BusConfig {
            voice_id: 0,
            frame_offset: wire::ASAP,
            buses: vec![wire::BusConfigBuses {
                parent: wire::BUS_ROOT as u16,
                effects: vec![wire::BusConfigBusesEffects { type_: kind::REVERB_SEND, p: [0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] }],
            }],
        };
        let len = rec.write(&mut cfg, 0).unwrap();
        cfg.truncate(len);
        z.submit(&[cfg]);
        if let Some(g) = shared {
            z.config(g, 0, &[]);
        }
        // A DC clip voice on bus 0 feeds the shared reverb.
        let samples = [0.25f32; 64];
        z.core.clips_mut().reserve(1, 64, 1, RATE, audio_core::clips::ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        z.core.clips_mut().write(1, 0, &bytes).unwrap();
        let play = wire::Play {
            voice_id: 0x0001_0001,
            frame_offset: wire::ASAP,
            clip: 1,
            bus: 0,
            flags: wire::PLAY_FLAGS_MIXED | wire::PLAY_FLAGS_LOOP,
            gain: 1.0,
            pitch: 1.0,
            dir_z: -1.0,
            lp_hz: 24_000.0,
            ..Default::default()
        };
        let mut p = vec![0u8; 128];
        let len = play.write(&mut p, 0).unwrap();
        p.truncate(len);
        z.submit(&[p]);
        z.run(80, |_| None).0
    };
    let none = run(None);
    let unity = run(Some(1.0));
    let half = run(Some(0.5));
    let dry = 0.25f32;
    assert_eq!(none, unity, "a ZONE_CONFIG at unity changes nothing (M1's path)");
    let mut heard = false;
    for i in 0..none.len() {
        let wet_full = none[i] - dry;
        let wet_half = half[i] - dry;
        if i > 200 {
            assert!((wet_half - 0.5 * wet_full).abs() < 1e-5, "frame {i}: {wet_half} vs {wet_full}");
            heard |= wet_full.abs() > 1e-3;
        }
    }
    assert!(heard, "the shared reverb is heard");
    let z = Zones::new(0);
    assert_eq!(zones::shared_return_gain(&z.core), 1.0);
}

#[test]
fn zone_kernels_stay_within_their_budget() {
    let blob = kernel_blob(IR_FRAMES, 8);
    let mut z = Zones::new(1);
    assert_eq!(reserve_kernel(&mut z.core, K1, &blob), wire::ERR_OK);
    assert_eq!(reserve_kernel(&mut z.core, K2, &blob), wire::ERR_CEILING, "one kernel per slot");
    assert_eq!(clips::free(&mut z.core, K1), wire::ERR_OK);
    assert_eq!(reserve_kernel(&mut z.core, K2, &blob), wire::ERR_OK, "room again once freed");
    // Without slots there is no budget; ids and channels are checked.
    let mut none = Zones::new(0);
    assert_eq!(reserve_kernel(&mut none.core, K1, &blob), wire::ERR_CEILING);
    assert_eq!(clips::reserve(&mut z.core, 5, 4, 1, RATE, wire::clip_format::ZONE_KERNEL), wire::ERR_BAD_ARG, "not a zone kernel id");
    assert_eq!(clips::reserve(&mut z.core, K3, 4, 2, RATE, wire::clip_format::ZONE_KERNEL), wire::ERR_BAD_ARG, "format 3 is one channel");
    // Format 5 (zone IR PCM, for C3b): stereo f32, stored, never a voice's source, not resident.
    let mut p = Zones::new(2);
    assert_eq!(clips::reserve(&mut p.core, K1, 1000, 2, RATE, wire::clip_format::ZONE_IR_PCM), wire::ERR_OK);
    let pcm: Vec<u8> = (0..2000).flat_map(|i| (i as f32 * 1e-3).to_le_bytes()).collect();
    assert_eq!(clips::write(&mut p.core, K1, 0, &pcm), wire::ERR_OK);
    assert!(p.core.clips().frames(K1).is_none() && p.core.clips().zone_kernel(K1).is_none());
    assert!(!p.core.clips().is_resident(K1) || p.core.clips().events_len() == 0, "no resident event before C3b prepares it");
    assert_eq!(clips::reserve(&mut p.core, K2, 1000, 1, RATE, wire::clip_format::ZONE_IR_PCM), wire::ERR_BAD_ARG, "format 5 is stereo");
}

#[test]
fn the_ladder_cuts_releasing_tails_then_allows_one_active_zone_fewer() {
    // 16 mixed voices: the adaptive cap sits at its floor from the start.
    // A 1.25 s IR in the releasing slot, so its tail still rings when the first step comes.
    const LONG: u32 = 60_000;
    let (b1, b2) = (kernel_blob(IR_FRAMES, 9), kernel_blob(LONG, 10));
    let mut z = Zones::over(core_with(zone_params(3, LONG)));
    load_kernel(&mut z.core, K1, &b1);
    load_kernel(&mut z.core, K2, &b2);
    z.config(1.0, 0, &[active(K1, 1.0), active(K2, 0.5)]);
    z.run(10, |q| Some((0, noise(q as u32))));
    z.run(10, |q| Some((1, noise(77 + q as u32))));
    z.config(1.0, 0, &[active(K1, 1.0), (K2, 0, zone_slot_state::RELEASE as u8, 0.5, LONG)]);
    assert_eq!(z.state(1), zone_state::RINGING_OUT);
    let second = quanta(1000) + 2;
    let mut underruns = 0;
    let mut tick = |z: &mut Zones| {
        underruns += 1;
        z.core.note_underruns(underruns);
        z.feed(0, &noise(3));
        z.render();
    };
    // Underruns for less than a second: nothing yet.
    for _ in 0..second - 4 {
        tick(&mut z);
    }
    assert_eq!(zones::shed_steps(&z.core), 0);
    for _ in 0..6 {
        tick(&mut z);
    }
    assert_eq!(zones::shed_steps(&z.core), 1, "step 1 after a second at the floor");
    assert_eq!(z.state(1), zone_state::EVICTING, "the releasing tail is cut");
    for _ in 0..quanta(100) + 1 {
        tick(&mut z);
    }
    assert_eq!(z.state(1), zone_state::OFF, "cut within 100 ms");
    assert_eq!(z.state(0), zone_state::ACTIVE, "active zones stay on step 1");
    for _ in 0..second {
        tick(&mut z);
    }
    assert_eq!(zones::shed_steps(&z.core), 2, "step 2 after another second");
    assert_eq!(z.state(0), zone_state::EVICTING, "one active zone fewer");
    assert_eq!(zones::area(&z.core).active_limit, 0);
    for _ in 0..quanta(150) + 1 {
        tick(&mut z);
    }
    assert_eq!(z.state(0), zone_state::OFF);
    // A start past the limit is refused with `refusedSlot`.
    z.config(1.0, 0, &[active(K2, 1.0)]);
    assert_eq!(z.state(0), zone_state::OFF);
    assert!(z.events().contains(&(0, zone_event::REFUSED_SLOT as u8)), "{:?}", z.events());
    for _ in 0..3 * second {
        tick(&mut z);
    }
    assert_eq!(zones::shed_steps(&z.core), 2, "two steps at most");
}

#[test]
fn the_ladder_gives_its_steps_back_one_per_hold_and_a_re_trip_doubles_the_hold() {
    // ADR 0170. 16 mixed voices: the cap sits at its floor from the start.
    let mut z = Zones::over(core_with(zone_params(3, IR_FRAMES)));
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 13));
    load_kernel(&mut z.core, K2, &kernel_blob(IR_FRAMES, 14));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    z.run(10, |q| Some((0, noise(q as u32))));
    let mut underruns = 0;
    let mut shed_to = |z: &mut Zones, steps: u32| {
        let mut n = 0;
        while zones::shed_steps(&z.core) < steps {
            n += 1;
            assert!(n < 3 * quanta(1000), "the ladder steps within 3 s");
            underruns += 1;
            z.core.note_underruns(underruns);
            z.render();
        }
    };
    shed_to(&mut z, 2);
    assert_eq!(zones::area(&z.core).active_limit, 0);
    z.run(quanta(150) + 1, |_| None);
    assert_eq!(z.state(0), zone_state::OFF, "the active zone was evicted");
    // 20 s clean: step 2 comes back, step 1 stays.
    let hold = quanta(20_000);
    z.run(hold - quanta(150) - 3, |_| None);
    assert_eq!(zones::shed_steps(&z.core), 2, "held for 20 s");
    z.run(3, |_| None);
    assert_eq!(zones::shed_steps(&z.core), 1, "step 2 given back");
    assert_eq!(zones::area(&z.core).active_limit, zones::NO_LIMIT);
    assert_eq!(zones::area(&z.core).cut_tails, 1, "step 1 still in force");
    // Main's next ZONE_CONFIG starts the zone again, fading in over 100 ms (no jump).
    z.config(1.0, 0, &[active(K1, 1.0)]);
    assert_eq!(z.state(0), zone_state::FADING_IN);
    z.run(quanta(100) + 2, |q| Some((0, noise(q as u32))));
    assert_eq!(z.state(0), zone_state::ACTIVE);
    // Underruns again before the next give-back: a re-trip takes step 2 again and doubles the hold.
    shed_to(&mut z, 2);
    assert_eq!(z.core.cap().ladder().retrips, 1);
    assert_eq!(z.core.cap().ladder().hold(), (2 * 20 * RATE as u32) as u64, "40 s");
    z.run(quanta(20_000) + 2, |_| None);
    assert_eq!(zones::shed_steps(&z.core), 2, "not after 20 s now");
    z.run(quanta(20_000), |_| None);
    assert_eq!(zones::shed_steps(&z.core), 1, "after 40 s");
    // 40 s more: step 1 comes back, and a release rings out in full again.
    z.config(1.0, 0, &[active(K2, 1.0)]);
    z.run(quanta(40_000) + 2, |q| Some((0, noise(q as u32))));
    assert_eq!(zones::shed_steps(&z.core), 0, "idle");
    assert_eq!(zones::area(&z.core).cut_tails, 0);
    assert_eq!(z.core.cap().ladder().restores, 3);
    z.config(1.0, 0, &[(K2, 0, zone_slot_state::RELEASE as u8, 1.0, IR_FRAMES)]);
    assert_eq!(z.state(0), zone_state::RINGING_OUT, "the tail rings out again");
}

#[test]
fn the_ladder_waits_for_the_cap_floor_and_continuing_underruns() {
    // 64 mixed voices: the cap is above its floor until underruns bring it down.
    let mut p = zone_params(1, IR_FRAMES);
    p.max_mixed = 64;
    let mut z = Zones::over(core_with(p));
    load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 11));
    z.config(1.0, 0, &[active(K1, 1.0)]);
    // One underrun a second for 3 s: above the floor, the cap sheds voices, never zones.
    for s in 1..=3u32 {
        z.core.note_underruns(s);
        for _ in 0..quanta(1000) {
            z.render();
        }
    }
    assert!(z.core.cap().cap() > z.core.cap().config().floor);
    assert_eq!(zones::shed_steps(&z.core), 0);
}

#[test]
fn the_aux_accumulator_is_there_with_or_without_zone_slots() {
    for slots in [0u32, 1, 3] {
        let mut z = Zones::new(slots);
        assert_eq!(zones::slot_count(&z.core), slots as usize);
        let aux = zones::aux_accumulator(&mut z.core.regions_mut().zones[..]);
        assert_eq!(aux.len(), 8 * 2 * QUANTUM, "{slots} slots: one planar stereo quantum per bus (8 buses)");
        assert!(aux.iter().all(|&v| v == 0.0));
        aux.fill(1.0); // never overlaps a slot
        if slots > 0 {
            assert_eq!(z.state(0), zone_state::OFF);
            load_kernel(&mut z.core, K1, &kernel_blob(IR_FRAMES, 12));
            z.config(1.0, 0, &[active(K1, 1.0)]);
            assert_eq!(z.state(0), zone_state::FADING_IN);
        }
    }
}
