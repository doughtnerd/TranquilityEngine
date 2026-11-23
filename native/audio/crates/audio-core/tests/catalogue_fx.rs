//! ADR 0345's DSP in the core (ABI 4.6), through `scheduler::submit` and `Core::process`:
//!
//! - catalogue effects on a bus chain (`BUS_FX_CATALOGUE + kind`) run, with up to eight effects a bus;
//! - a submix runs the heavy kinds on effect memory, which the sweep gives back when the slot goes free;
//! - a sidechain compressor ducks its bus by its key bus's level, the key mixed first whatever the indices;
//! - RESET clears a delay's line (no tail survives it);
//! - an edited catalogue parameter glides (no step at the edit).

mod common;

use audio_core::{fxmem, submix};
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;

fn mixer(buses: u32) -> Mixer {
    let mut m = Mixer::new(buses);
    m.set_lookahead(0.0);
    m
}

fn cat(kind: u32, p: &[f32]) -> wire::BusConfigBusesEffects {
    let mut a = [0.0f32; 16];
    a[..p.len()].copy_from_slice(p);
    wire::BusConfigBusesEffects { type_: wire::BUS_FX_CATALOGUE + kind, p: a }
}

fn tree(buses: Vec<(u16, Vec<wire::BusConfigBusesEffects>)>) -> Rec {
    Rec::Config(wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses: buses.into_iter().map(|(parent, effects)| wire::BusConfigBuses { parent, effects }).collect() })
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

fn submix_rec(slot: u32, group: u16, bus: u16, effects: &[(u32, &[f32])]) -> Rec {
    let s = wire::Submix {
        voice_id: slot,
        frame_offset: wire::ASAP,
        group,
        bus,
        parent: 0,
        reserved: 0,
        effects: effects
            .iter()
            .map(|&(type_, p)| {
                let mut a = [0.0f32; 16];
                a[..p.len()].copy_from_slice(p);
                wire::SubmixEffects { type_, flags: wire::SUBMIX_FX_ON, p: a }
            })
            .collect(),
    };
    raw(move |b| s.write(b, 0))
}

fn play_in(voice: u32, clip: u32, bus: u16, group: u16, flags: u16) -> Rec {
    let Rec::Play(mut p) = play(voice, clip, bus, flags) else { unreachable!() };
    p.group = group;
    Rec::Play(p)
}

/// A looping DC voice on `bus` at `gain` (quiet enough that two never reach the master limiter).
fn dc_at(voice: u32, bus: u16, gain: f32) -> Rec {
    let Rec::Play(mut p) = dc(voice, bus, 0.0) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

fn mean(x: &[f32]) -> f32 {
    x.iter().sum::<f32>() / x.len() as f32
}

#[test]
fn a_bus_runs_eight_catalogue_effects() {
    // Bus 1: seven unity-ish effects (EQ at 0 dB, saturation 0 %, distortion mix 0, bit-crush mix 0, chorus mix 0,
    // delay mix 0, limiter at 0 dB) and a -6 dB gain: DC comes out at half the dry level.
    let unity = vec![
        cat(wire::SUBMIX_FX_EQ, &[0.0, 0.0, 0.0]),
        cat(wire::SUBMIX_FX_SATURATION, &[0.0]),
        cat(wire::SUBMIX_FX_DISTORTION, &[0.5, 0.0]),
        cat(wire::SUBMIX_FX_BITCRUSH, &[8.0, 4.0, 0.0]),
        cat(wire::SUBMIX_FX_CHORUS, &[1.0, 50.0, 0.0]),
        cat(wire::SUBMIX_FX_DELAY, &[100.0, 50.0, 0.0]),
        cat(wire::SUBMIX_FX_LIMITER, &[0.0, 50.0]),
    ];
    let mut dry = mixer(4);
    dry.submit(&[tree(vec![(ROOT, vec![]), (0, unity.clone())]), dc(V1, 1, 0.0)]);
    dry.render_n(8);
    let (dl, _) = dry.render();
    let mut fx = unity;
    fx.push(cat(wire::SUBMIX_FX_GAIN, &[-6.0]));
    let mut m = mixer(4);
    m.submit(&[tree(vec![(ROOT, vec![]), (0, fx)]), dc(V1, 1, 0.0)]);
    assert_eq!(audio_core::bus::slots(&m.core)[1].fx.count, 8);
    m.render_n(8);
    let (l, _) = m.render();
    let g = 10f32.powf(-6.0 / 20.0);
    assert!((mean(&l) - g * mean(&dl)).abs() < 1e-4, "{} vs {}", mean(&l), g * mean(&dl));
    let (used, starved) = fxmem::usage(m.core.regions_mut());
    assert!(used > 0 && starved == 0, "the chorus and the delay hold effect memory: {used} blocks");
}

#[test]
fn a_submix_delay_echoes_and_its_memory_goes_back_when_the_slot_frees() {
    let mut m = mixer(4);
    // A one-sample click clip.
    let mut click = vec![0.0f32; 48_000];
    click[0] = 1.0;
    m.load_clip(2, &click);
    let d_ms = 20.0;
    m.submit(&[config(&[ROOT, 0]), submix_rec(0, 5, 1, &[(wire::SUBMIX_FX_DELAY, &[d_ms, 50.0, 100.0])]), play_in(V1, 2, 1, 5, MIXED)]);
    let (used, _) = fxmem::usage(m.core.regions_mut());
    assert!(used > 0);
    let (l, _) = m.render_n(30);
    let d = (d_ms * RATE / 1000.0) as usize;
    let first = l.iter().position(|x| x.abs() > 1e-3).expect("an echo");
    assert_eq!(first, d, "the first echo at the delay (mix 100 %: no dry)");
    let second = l[d + 1..].iter().position(|x| x.abs() > 1e-3).map(|i| i + d + 1).unwrap();
    assert_eq!(second, 2 * d);
    assert!((l[second] / l[first] - 0.5).abs() < 1e-3, "feedback 50 %");
    m.submit(&[submix_rec(0, 0, 1, &[])]);
    assert_eq!(submix::active(&mut m.core), 0);
    assert_eq!(fxmem::usage(m.core.regions_mut()).0, 0, "the sweep gave the delay's memory back");
}

#[test]
fn reset_clears_a_bus_delays_line() {
    let mut m = mixer(4);
    let mut click = vec![0.0f32; 48_000];
    click[0] = 1.0;
    m.load_clip(2, &click);
    m.submit(&[tree(vec![(ROOT, vec![]), (0, vec![cat(wire::SUBMIX_FX_DELAY, &[50.0, 0.0, 100.0])])]), play(V1, 2, 1, MIXED)]);
    m.render_n(4);
    m.submit(&[reset(true)]);
    let (l, _) = m.render_n(30);
    assert!(l.iter().all(|x| x.abs() < 1e-6), "the echo due at 50 ms was cleared by RESET");
}

#[test]
fn a_sidechain_compressor_ducks_by_its_key_and_the_key_mixes_first() {
    // Bus 1 (index lower than its key) carries a sidechain compressor keyed on bus 2; the key bus plays DC at 0 dBFS-ish.
    let sc = cat(wire::SUBMIX_FX_SIDECHAIN, &[-30.0, 10.0, 50.0, 2.0]);
    let mut m = mixer(4);
    m.submit(&[tree(vec![(ROOT, vec![]), (0, vec![sc]), (0, vec![])]), dc_at(V1, 1, 0.25)]);
    m.render_n(16);
    let (quiet, _) = m.render();
    let before = mean(&quiet);
    m.submit(&[dc_at(V2, 2, 0.25)]);
    m.render_n(40);
    // The output is bus 1 (ducked) plus bus 2 (the key): take the key's own level off.
    let (both, _) = m.render();
    let key_alone = before; // bus 2 plays the same DC voice at the same level
    let ducked = mean(&both) - key_alone;
    assert!(ducked < before * 0.2, "ducked by tens of dB: {ducked} vs {before}");
    assert!(ducked > 0.0);
    let a = audio_core::bus::area(&m.core);
    assert_eq!(a.is_key[2], 1);
    assert!(a.key_db[2].is_finite());
    let order = &a.order[..3];
    assert!(order.iter().position(|&b| b == 2) < order.iter().position(|&b| b == 1), "the key mixes before its reader: {order:?}");
}

#[test]
fn an_edited_catalogue_gain_glides_instead_of_stepping() {
    let mut m = mixer(4);
    m.submit(&[tree(vec![(ROOT, vec![]), (0, vec![cat(wire::SUBMIX_FX_GAIN, &[0.0])])]), dc(V1, 1, 0.0)]);
    m.render_n(8);
    let (base, _) = m.render();
    let level = base[127];
    m.submit(&[tree(vec![(ROOT, vec![]), (0, vec![cat(wire::SUBMIX_FX_GAIN, &[-12.0])])])]);
    let (l, _) = m.render_n(12);
    let biggest = l.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
    assert!(biggest < level * 0.01, "no step: {biggest} against {level}");
    let g = 10f32.powf(-12.0 / 20.0);
    assert!((l[l.len() - 1] - level * g).abs() < 1e-4, "landed on -12 dB");
}
