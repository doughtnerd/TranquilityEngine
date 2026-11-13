//! G9b (0171/0172 M5c, E3's finding): a level rule's trigger far under its threshold never dips the
//! target, at the voice's start included. E3's Playwright saw a −52 dBFS trigger against a −30 dBFS
//! threshold dip Music to ≈ 0.82 at the voice's start. On the core the gain computer gives exactly
//! 1 there (`sidechain::gain_goal`), and these checks hold it to that with E3's ingredients: an RMS
//! level rule, the trigger bus compressed (`audioMixLive.ts`'s SFX: its makeup gain lifts what the
//! detector reads), a loud trigger voice first (ducking, then stopped and released), then a quiet
//! one. The detector, the follower and the compressor carry nothing from the loud voice that dips
//! the quiet one: the target is bit for bit the scene without the rule.
//!
//! The dip E3 measured is a voice **started loud**: `AudioSource.play` sent the PLAY at gain 1 and
//! its volume in a later SET_PARAMS (fixed main-side: `AudioSource.play` now starts the voice at its
//! volume and pitch). The last check shows that mechanism on the core: the same quiet trigger
//! started at gain 1 and turned down a frame later (the next BATCH) does dip the target, as it should (it was loud).

mod common;

use audio_core::duck;
use audio_wire::generated as wire;
use common::*;

const Q: usize = audio_core::QUANTUM;

/// E3's SFX compressor (`tests/e2e/audioMixLive.ts`): threshold −24, knee 30, ratio 8, attack 3 ms, release 250 ms.
fn compressed_config() -> Rec {
    let comp = wire::BusConfigBusesEffects { type_: 2, p: [-24.0, 30.0, 8.0, 0.003, 0.25, 0.0, 0.0] };
    Rec::Config(wire::BusConfig {
        voice_id: 0,
        frame_offset: wire::ASAP,
        buses: vec![
            wire::BusConfigBuses { parent: ROOT, effects: vec![] },
            wire::BusConfigBuses { parent: 0, effects: vec![] },
            wire::BusConfigBuses { parent: 0, effects: vec![comp] },
            wire::BusConfigBuses { parent: 0, effects: vec![] },
        ],
    })
}

/// E3's rule (`audio-mix-c.spec.ts` `LEVEL`): SFX (2) ducks Music (1), RMS, −30 dBFS, amount 0.3, attack 50 ms, release 400 ms.
fn rule() -> Rec {
    let r = wire::BusDuckRules { target: 1, trigger: 2, flags: wire::DUCK_FLAG_LEVEL | wire::DUCK_FLAG_RMS, threshold_db: -30.0, amount: 0.3, attack: 0.05, release: 0.4 };
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + wire::BusDuckRules::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: vec![r] }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn gain(voice: u32, g: f32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_GAIN, gain: g, ..Default::default() })
}

/// A 1 kHz sine at −23 dBFS peak (E3's reference tone), one second.
const SINE: u32 = 2;
fn sine() -> Vec<f32> {
    let peak = 10f32.powf(-23.0 / 20.0);
    (0..48_000).map(|i| peak * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / RATE).sin()).collect()
}

fn sine_play(voice: u32, bus: u16, g: f32) -> Rec {
    let Rec::Play(mut p) = play(voice, SINE, bus, MIXED | LOOP) else { unreachable!() };
    p.gain = g;
    Rec::Play(p)
}

/// Master, Music (1: a DC 1.0 voice at fader 0.25), SFX (2: compressed, fader 0 so the output is
/// Music alone; the tap is pre-fader), UI (3). With `with_rule`, E3's level rule.
fn scene(with_rule: bool) -> Mixer {
    let mut m = Mixer::new(8);
    m.set_lookahead(0.0);
    m.load_clip(SINE, &sine());
    m.submit(&[compressed_config(), gains(0, &[1.0, 0.25, 0.0, 1.0]), dc(0x0001_0001, 1, 0.0)]);
    if with_rule {
        m.submit(&[rule()]);
    }
    m
}

/// The loud trigger (the tone at full scale, −26 dBFS RMS, over −30; the compressor's makeup lifts
/// it further) for 1 s, turned to silence, then 5 s for the release (12 of its time constants: settled on exactly 1); returns the deepest duck gain of the run.
fn loud_then_released(m: &mut Mixer) -> f32 {
    m.submit(&[sine_play(0x0002_0002, 2, 1.0)]);
    let during = m.render_n(375).0;
    m.submit(&[gain(0x0002_0002, 0.0)]); // turned down to silence, as Sc1's release check does
    let after = m.render_n(1875).0;
    during.iter().chain(&after).map(|x| x / 0.25).fold(1.0, f32::min)
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

#[test]
fn a_trigger_far_under_its_threshold_never_dips_the_target_at_its_start() {
    // The quiet trigger: the tone at 0.02 (≈ −60 dBFS RMS before the compressor's makeup), started
    // at its gain, after a loud trigger has ducked and released; 2 s of it.
    let run = |with_rule: bool| {
        let mut m = scene(with_rule);
        let loud = loud_then_released(&mut m);
        if with_rule {
            assert!(loud < 0.35, "the loud trigger ducks ({loud})");
            let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
            assert_eq!(d.followers[0].gain, 1.0, "released to exactly 1 before the quiet voice");
        }
        m.submit(&[sine_play(0x0003_0003, 2, 0.02)]);
        let quiet = m.render_n(750);
        if with_rule {
            let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
            assert!(d.detectors[0].level_db < -36.0, "the quiet trigger reads far under -30 dBFS ({} dB)", d.detectors[0].level_db);
        }
        quiet
    };
    let plain = run(false);
    let ruled = run(true);
    let worst = ruled.0.iter().map(|x| x / 0.25).fold(1.0, f32::min);
    assert_eq!((bits(&ruled.0), bits(&ruled.1)), (bits(&plain.0), bits(&plain.1)), "the target's duck gain is exactly 1 at every sample (lowest {worst})");
}

#[test]
fn a_quiet_trigger_first_heard_at_full_gain_does_dip_the_target() {
    // The mechanism behind E3's dip: the same voice started at gain 1 and turned down to 0.02 a
    // frame later (6 quanta, the next BATCH at 60 Hz) reads loud for that frame (and the compressor's makeup lifts it), so the duck
    // attacks before it releases. Main must start a voice at its volume (`AudioSource.play`).
    let mut m = scene(true);
    loud_then_released(&mut m);
    m.submit(&[sine_play(0x0003_0003, 2, 1.0)]);
    let mut out = m.render_n(6).0;
    m.submit(&[gain(0x0003_0003, 0.02)]);
    out.extend(m.render_n(1875).0);
    let worst = out.iter().map(|x| x / 0.25).fold(1.0, f32::min);
    eprintln!("G9b: a quiet trigger first heard at gain 1 for 6 quanta dips the target to {worst:.4}");
    assert!(worst < 0.999, "a loud first frame dips the target ({worst})");
    assert_eq!(out[out.len() - Q..].iter().map(|x| x / 0.25).fold(1.0, f32::min), 1.0, "and releases to exactly 1");
}
