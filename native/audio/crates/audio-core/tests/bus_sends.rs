//! ADR 0330 bus-to-return sends (ABI 4.7), through `scheduler::submit` and `Core::process`:
//!
//! - a send adds the bus's post-fader signal, at its level, into its return, which runs its own
//!   inserts and fader; the return mixes after its senders whatever the slot indices;
//! - a level edit ramps; a muted send ramps to 0 and keeps its level;
//! - a malformed BUS_SENDS refuses the batch; RESET lands the ramps.

mod common;

use audio_core::bus;
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;

fn mixer(buses: u32) -> Mixer {
    let mut m = Mixer::new(buses);
    m.set_lookahead(0.0);
    m
}

fn sends(bus: u32, items: &[(u16, bool, f32, u32)]) -> Rec {
    let rec = wire::BusSends {
        voice_id: bus,
        frame_offset: wire::ASAP,
        sends: items.iter().map(|&(to, muted, level, frames)| wire::BusSendsSends { to, flags: if muted { wire::BUS_SEND_MUTED as u16 } else { 0 }, level, frames }).collect(),
    };
    let mut b = vec![0u8; 1024];
    let n = rec.write(&mut b, 0).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

/// A quiet DC voice on `bus` (two paths never reach the master limiter).
fn dc_at(voice: u32, bus: u16, gain: f32) -> Rec {
    let Rec::Play(mut p) = dc(voice, bus, 0.0) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

fn last(m: &mut Mixer) -> f32 {
    let (l, _) = m.render();
    l[127]
}

#[test]
fn a_send_feeds_its_return_post_fader_and_the_return_mixes_after_it() {
    // Bus 1 is the return (a lower index than its sender), bus 2 the sender; both under the root.
    let mut m = mixer(4);
    m.submit(&[config(&[ROOT, 0, 0]), dc_at(V1, 2, 0.25)]);
    m.render_n(4);
    let dry = last(&mut m);
    m.submit(&[sends(2, &[(1, false, 0.5, 0)])]);
    m.render_n(2);
    let wet = last(&mut m);
    assert!((wet - dry * 1.5).abs() < 1e-5, "dry plus half through the return: {wet} vs {dry}");
    let order = &bus::area(&m.core).order[..3];
    assert!(order.iter().position(|&b| b == 2) < order.iter().position(|&b| b == 1), "{order:?}");
    // Post-fader: halving the sender's fader halves both paths.
    m.submit(&[mix(0, &[(1.0, OFF), (1.0, OFF), (0.5, OFF)])]);
    m.render_n(2);
    assert!((last(&mut m) - wet * 0.5).abs() < 1e-5);
}

#[test]
fn a_level_edit_ramps_and_a_mute_ramps_to_zero_keeping_the_level() {
    let mut m = mixer(4);
    m.submit(&[config(&[ROOT, 0, 0]), dc_at(V1, 2, 0.25), sends(2, &[(1, false, 1.0, 0)])]);
    m.render_n(4);
    let full = last(&mut m);
    m.submit(&[sends(2, &[(1, true, 1.0, 256)])]);
    let (l, _) = m.render_n(2);
    assert!(l.windows(2).all(|w| w[1] <= w[0] + 1e-7), "a monotone fade, no step");
    assert!((l[255] - full / 2.0).abs() < 1e-5, "muted: the return path gone");
    let s = bus::slots(&m.core)[2].sends;
    assert_eq!((s.count, s.list[0].level, s.list[0].gain.target), (1, 1.0, 0.0), "the level kept");
    m.submit(&[sends(2, &[(1, false, 1.0, 0)])]);
    m.render();
    assert!((last(&mut m) - full).abs() < 1e-5, "unmuted at its level");
}

#[test]
fn bad_records_and_reset() {
    let mut m = mixer(4);
    m.submit(&[config(&[ROOT, 0, 0])]);
    let Rec::Raw(mut b) = sends(2, &[(1, false, 1.0, 0)]) else { unreachable!() };
    b[12] = 9; // claims 9 sends
    assert_ne!(m.try_submit(&[Rec::Raw(b)]), 0, "a malformed BUS_SENDS refuses the batch");
    m.submit(&[sends(2, &[(1, false, 1.0, 10_000), (2, false, 1.0, 0), (9, false, 1.0, 0)])]);
    m.submit(&[reset(true)]);
    let s = bus::slots(&m.core)[2].sends;
    assert_eq!(s.count, 3, "kept as sent (the self and out-of-range sends are skipped at render)");
    assert!(s.list[0].gain.is_settled() && s.list[0].gain.value == 1.0, "RESET lands the ramp");
    m.render_n(2);
}
