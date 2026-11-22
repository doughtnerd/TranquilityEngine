//! ABI 4.8 (ADR 0330, 0331): the mix's remaining core features, through `scheduler::submit` and
//! `Core::process`:
//!
//! - BUS_AUTOMATE `fx` bindings drive a catalogue parameter of a bus effect from a global parameter
//!   (a log2 curve for frequencies), reaching it across one quantum; a held parameter (a snapshot
//!   override) ignores its automation;
//! - BUS_AUTOMATE `send` bindings add their dB to a send's level;
//! - SUBMIX_AUTOMATE drives an instance submix's effect from a local parameter of its group;
//! - a BUS_RAMP with law `Decibel` fades linearly in dB (its midpoint is the dB midpoint);
//! - effect memory that runs out says so in STATUS (`fxStarved`, `fxStarvedOwner`).

mod common;

use audio_core::{bus, status};
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;

fn mixer(buses: u32) -> Mixer {
    let mut m = Mixer::new(buses);
    m.set_lookahead(0.0);
    m
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 8192];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

fn cat(kind: u32, p: &[f32]) -> wire::BusConfigBusesEffects {
    let mut a = [0.0f32; 7];
    a[..p.len()].copy_from_slice(p);
    wire::BusConfigBusesEffects { type_: wire::BUS_FX_CATALOGUE + kind, p: a }
}

fn tree(buses: Vec<(u16, Vec<wire::BusConfigBusesEffects>)>) -> Rec {
    Rec::Config(wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses: buses.into_iter().map(|(parent, effects)| wire::BusConfigBuses { parent, effects }).collect() })
}

/// One linear curve per key list, from curve `first`.
fn curves(first: u32, list: &[&[(f32, f32)]]) -> Rec {
    let c = wire::Curves {
        voice_id: 0,
        frame_offset: wire::ASAP,
        first_curve: first,
        curves: list
            .iter()
            .map(|keys| wire::CurvesCurves { reserved: 0, keys: keys.iter().map(|&(x, y)| wire::CurvesCurvesKeys { x, y, interp: 0, in_dx: 0.0, in_dy: 0.0, out_dx: 0.0, out_dy: 0.0 }).collect() })
            .collect(),
    };
    raw(move |b| c.write(b, 0))
}

fn param(group: u16, slot: u16, value: f32) -> Rec {
    let p = wire::Param { voice_id: 0, frame_offset: wire::ASAP, group, slot, value, seek_per_second: 0.0 };
    raw(move |b| p.write(b, 0))
}

const GLOBAL: u16 = wire::PARAM_GLOBAL as u16;

fn fx_target(slot: u32, param: u32, log: bool) -> u32 {
    wire::AUTO_TARGET_FX | slot << wire::AUTO_TARGET_SLOT_SHIFT | param << wire::AUTO_TARGET_PARAM_SHIFT | if log { wire::AUTO_TARGET_LOG } else { 0 }
}

fn send_target(to: u32) -> u32 {
    wire::AUTO_TARGET_SEND | to << wire::AUTO_TARGET_SLOT_SHIFT
}

fn bus_automate(bus: u32, bindings: &[(u16, u16, u32)]) -> Rec {
    let a = wire::BusAutomate { voice_id: bus, frame_offset: wire::ASAP, bindings: bindings.iter().map(|&(param, curve, target)| wire::BusAutomateBindings { param, curve, target }).collect() };
    raw(move |b| a.write(b, 0))
}

fn submix_automate(slot: u32, bindings: &[(u16, u16, u32)]) -> Rec {
    let a = wire::SubmixAutomate { voice_id: slot, frame_offset: wire::ASAP, bindings: bindings.iter().map(|&(param, curve, target)| wire::SubmixAutomateBindings { param, curve, target }).collect() };
    raw(move |b| a.write(b, 0))
}

fn sends(bus: u32, items: &[(u16, f32)]) -> Rec {
    let rec = wire::BusSends { voice_id: bus, frame_offset: wire::ASAP, sends: items.iter().map(|&(to, level)| wire::BusSendsSends { to, flags: 0, level, frames: 0 }).collect() };
    raw(move |b| rec.write(b, 0))
}

/// A looping DC voice on `bus` at `gain`.
fn dc_at(voice: u32, bus: u16, gain: f32) -> Rec {
    let Rec::Play(mut p) = dc(voice, bus, 0.0) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

fn db(g: f32) -> f32 {
    20.0 * g.log10()
}

#[test]
fn an_fx_binding_drives_a_bus_effects_parameter_across_one_quantum() {
    // Bus 1 runs a gain effect at 0 dB; global parameter 0 drives its gain through curve 0 (0 -> 0 dB, 1 -> -12 dB).
    let mut m = mixer(4);
    m.submit(&[tree(vec![(ROOT, vec![]), (0, vec![cat(wire::SUBMIX_FX_GAIN, &[0.0])])]), dc_at(V1, 1, 0.25), curves(0, &[&[(0.0, 0.0), (1.0, -12.0)]]), bus_automate(1, &[(GLOBAL, 0, fx_target(0, 0, false))])]);
    m.render_n(4);
    let (l, _) = m.render();
    let base = l[127];
    assert!(base > 0.1 && l.iter().all(|&x| (x - base).abs() < 1e-6), "at 0 the gain is 0 dB and steady: {base}");
    m.submit(&[param(0, 0, 1.0)]);
    let (l, _) = m.render();
    assert!(l.windows(2).all(|w| w[1] <= w[0] + 1e-7), "it moves across the quantum, never back");
    assert!((db(l[127] / base) + 12.0).abs() < 1e-3, "it reaches -12 dB at the quantum's end: {} dB", db(l[127] / base));
    assert!(l[0] > l[127] + 0.5 * base, "not a step at the quantum's start");
    m.submit(&[param(0, 0, 0.5)]);
    m.render();
    let (l, _) = m.render();
    assert!((db(l[127] / base) + 6.0).abs() < 1e-3, "half-way: -6 dB");
}

#[test]
fn a_log_fx_binding_takes_two_to_the_curve_and_a_held_parameter_ignores_it() {
    // A low-pass's cutoff from a log2 curve: parameter 0.5 between log2(200) and log2(3200) is 800 Hz.
    let mut m = mixer(4);
    let lp = cat(wire::SUBMIX_FX_LOWPASS, &[20_000.0, 0.0, 0.0]);
    m.submit(&[tree(vec![(ROOT, vec![]), (0, vec![lp])]), dc_at(V1, 1, 0.25), curves(0, &[&[(0.0, 200f32.log2()), (1.0, 3200f32.log2())]]), param(0, 0, 0.5), bus_automate(1, &[(GLOBAL, 0, fx_target(0, 0, true))])]);
    m.render_n(2);
    let cutoff = bus::slots(&m.core)[1].fx.slots[0].fx.target[0];
    assert!((cutoff - 800.0).abs() < 0.5, "{cutoff}");
    // Held (bit 0 of the type's held byte): the sent cutoff stays whatever the automation says.
    let mut held = cat(wire::SUBMIX_FX_LOWPASS, &[5_000.0, 0.0, 0.0]);
    held.type_ |= 1 << wire::BUS_FX_HELD_SHIFT;
    m.submit(&[tree(vec![(ROOT, vec![]), (0, vec![held])])]);
    m.render_n(2);
    assert_eq!(bus::slots(&m.core)[1].fx.slots[0].fx.target[0], 5_000.0);
}

#[test]
fn a_send_binding_adds_its_db_to_the_send() {
    // Bus 2 sends into return 1 at 0.5; a send binding adds the curve's dB (0 -> 0 dB, 1 -> -6 dB).
    let mut m = mixer(4);
    m.submit(&[config(&[ROOT, 0, 0]), dc_at(V1, 2, 0.25), sends(2, &[(1, 0.5)]), curves(0, &[&[(0.0, 0.0), (1.0, -6.0)]]), bus_automate(2, &[(GLOBAL, 0, send_target(1))])]);
    m.submit(&[sends(2, &[])]);
    m.render_n(2);
    let dry = m.render().0[127];
    m.submit(&[sends(2, &[(1, 0.5)])]);
    m.render_n(2);
    let (l, _) = m.render();
    assert!((l[127] - dry * 1.5).abs() < 1e-5, "dry plus the send at 0.5: {} vs {}", l[127], dry * 1.5);
    m.submit(&[param(0, 0, 1.0)]);
    m.render();
    let (l, _) = m.render();
    let want = dry * (1.0 + 0.5 * 10f32.powf(-6.0 / 20.0));
    assert!((l[127] - want).abs() < 1e-5, "the send 6 dB down: {} vs {want}", l[127]);
    // A send the bindings don't name keeps its level.
    m.submit(&[bus_automate(2, &[(GLOBAL, 0, send_target(3))])]);
    m.render_n(2);
    assert!((m.render().0[127] - dry * 1.5).abs() < 1e-5);
}

#[test]
fn a_submix_binding_drives_its_chain_from_a_local_parameter() {
    // Instance group 5's submix on bus 1 runs a gain effect; its local parameter 2 drives the gain (0 -> 0 dB, 1 -> +6 dB),
    // so the effect opens above its configured value.
    let mut m = mixer(4);
    let s = wire::Submix { voice_id: 0, frame_offset: wire::ASAP, group: 5, bus: 1, effects: vec![wire::SubmixEffects { type_: wire::SUBMIX_FX_GAIN, flags: wire::SUBMIX_FX_ON, p: [0.0; 8] }] };
    let Rec::Play(mut p) = dc_at(V1, 1, 0.25) else { unreachable!() };
    p.group = 5;
    m.submit(&[config(&[ROOT, 0]), raw(move |b| s.write(b, 0)), Rec::Play(p), curves(0, &[&[(0.0, 0.0), (1.0, 6.0)]]), submix_automate(0, &[(2, 0, fx_target(0, 0, false))])]);
    m.render_n(4);
    let base = m.render().0[127];
    assert!(base > 0.1);
    m.submit(&[param(5, 2, 1.0)]);
    m.render();
    let (l, _) = m.render();
    assert!((db(l[127] / base) - 6.0).abs() < 1e-3, "{} dB", db(l[127] / base));
    // Count 0 clears the bindings (the effect keeps the last value it was given).
    m.submit(&[submix_automate(0, &[]), param(5, 2, 0.0)]);
    m.render_n(2);
    assert!((db(m.render().0[127] / base) - 6.0).abs() < 1e-3);
}

#[test]
fn a_decibel_bus_ramp_fades_linearly_in_db() {
    // The snapshot lane from 1 to 0.01 (-40 dB) over 1,024 frames: at its midpoint -20 dB (linear in gain would be ~-6 dB).
    let frames = 1024u32;
    let mut m = mixer(4);
    m.submit(&[config(&[ROOT, 0]), dc_at(V1, 1, 0.25)]);
    m.render_n(4);
    let base = m.render().0[127];
    let mut r = lane_ramp(1, wire::LANE_SNAPSHOT, Some(0.01), None, frames);
    r.shape = wire::pack_ramp_shape(wire::fade_law::DECIBEL, 0, 0);
    m.submit(&[raw(move |b| r.write(b, 0))]);
    let (l, _) = m.render_n(frames as usize / 128);
    for k in [127usize, 511, 767, 1023] {
        let want = -40.0 * (k + 1) as f32 / frames as f32;
        assert!((db(l[k] / base) - want).abs() < 0.01, "frame {k}: {} dB, want {want}", db(l[k] / base));
    }
    // A ramp back to 1 from there in dB, and one to 0 (no dB law for silence) ramps linearly.
    let mut down = lane_ramp(1, wire::LANE_SNAPSHOT, Some(0.0), None, 256);
    down.shape = wire::pack_ramp_shape(wire::fade_law::DECIBEL, 0, 0);
    m.submit(&[raw(move |b| down.write(b, 0))]);
    let (l, _) = m.render_n(2);
    assert!((l[127] - base * 0.01 * 0.5).abs() < 1e-6, "linear to 0: half-way at half the level");
    assert_eq!(l[255], 0.0);
}

#[test]
fn starved_effect_memory_is_reported_in_status_with_its_owner() {
    let mut m = mixer(4);
    let mut out = vec![0u8; wire::STATUS_BUFFER_BYTES as usize];
    m.render();
    status::take(&mut m.core, &mut out, 0);
    let (s, _) = wire::StatusBlock::read(&out, 0).unwrap();
    assert_eq!((s.fx_starved, s.fx_starved_owner), (0, wire::FX_STARVED_NONE as u16));
    // Sixteen 2-second delays (each a 2 s stereo line) can't all fit in 20 s of effect memory.
    let delays = || (0..8).map(|_| cat(wire::SUBMIX_FX_DELAY, &[2_000.0, 0.0, 50.0])).collect::<Vec<_>>();
    m.submit(&[tree(vec![(ROOT, vec![]), (0, delays()), (0, delays())])]);
    m.render();
    status::take(&mut m.core, &mut out, 0);
    let (s, _) = wire::StatusBlock::read(&out, 0).unwrap();
    assert!(s.fx_starved > 0, "some delays got no memory");
    assert_eq!(s.fx_starved_owner, 2, "the last bus configured starved");
}
