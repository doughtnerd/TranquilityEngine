//! ADR 0162 D1: the core's per-voice filters through the real render path (api-and-models §3.1,
//! §4.1, §4.2 SET_VOICE_FX, §10 D1; architecture §4.1; C17): `lpHz` for every mixed voice, ramped
//! in log-Hz and click-free; SET_VOICE_FX `hpHz`; off at or past 20 kHz / 20 Hz bit for bit;
//! ambisonic voices never filtered; the mixed-voice pool following the mix (STATUS `fxVoices`,
//! a full pool taking a fading voice's entry); a zone send reordering the chain while C4's tap is
//! still a no-op. M2's automation low-pass on the shared filter is held by `tests/automation.rs`
//! and the TS goldens (`audioGolden`, the event goldens), which must stay bit-identical.

mod common;

use audio_core::status;
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
/// A 1 kHz sine at 0.25, 4,800 frames (loops seamlessly).
const SINE: u32 = 2;
/// ±0.25 at Nyquist.
const NYQUIST: u32 = 3;

fn mixer() -> Mixer {
    let mut m = Mixer::new(4);
    let sine: Vec<f32> = (0..4_800).map(|i| 0.25 * (std::f32::consts::TAU * i as f32 / 48.0).sin()).collect();
    m.load_clip(SINE, &sine);
    let nyq: Vec<f32> = (0..4_800).map(|i| if i % 2 == 0 { 0.25 } else { -0.25 }).collect();
    m.load_clip(NYQUIST, &nyq);
    m
}

fn play_lp(voice: u32, clip: u32, flags: u16, lp_hz: f32) -> Rec {
    let Rec::Play(mut p) = play(voice, clip, 0, flags) else { unreachable!() };
    p.lp_hz = lp_hz;
    Rec::Play(p)
}

fn set_lp(voice: u32, lp_hz: f32, ramp_frames: u32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_LP_HZ, lp_hz, ramp_frames, ..Default::default() })
}

fn set_gain(voice: u32, gain: f32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_GAIN, gain, ..Default::default() })
}

fn voice_fx(voice: u32, mask: u32, hp_hz: f32, send: [f32; 4], ramp_frames: u32) -> Rec {
    let mut b = vec![0u8; wire::SetVoiceFx::FIXED_END];
    wire::SetVoiceFx { voice_id: voice, frame_offset: wire::ASAP, mask, ramp_frames, hp_hz, send, yaw: 0.0, aux_level: 0.0, aux_bus: wire::AUX_BUS_NONE as u16, reserved: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn set_mixed(voice: u32, mixed: bool, lp_hz: f32) -> Rec {
    let mut b = vec![0u8; wire::SetMixed::FIXED_END];
    wire::SetMixed { voice_id: voice, frame_offset: wire::ASAP, mixed: mixed as u32, gain: 1.0, dir_x: 0.0, dir_y: 0.0, dir_z: -1.0, lp_hz }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn bits(x: &[f32]) -> Vec<u32> {
    x.iter().map(|v| v.to_bits()).collect()
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |a, v| a.max(v.abs()))
}

fn max_step(x: &[f32]) -> f32 {
    x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

fn fx_voices(m: &Mixer) -> u16 {
    status::counters(&m.core).spatial.fx_voices
}

/// The left channel of `quanta` quanta of `recs` played from frame 0.
fn render(recs: Vec<Rec>, quanta: usize) -> Vec<f32> {
    let mut m = mixer();
    m.submit(&recs);
    m.render_n(quanta).0
}

#[test]
fn lp_hz_off_values_leave_the_voice_bit_for_bit() {
    let plain = render(vec![play_lp(V1, NYQUIST, MIXED | LOOP, OFF)], 6);
    assert!(peak(&plain) > 0.1);
    for off in [20_000.0, 22_000.0, 0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert_eq!(bits(&render(vec![play_lp(V1, NYQUIST, MIXED | LOOP, off)], 6)), bits(&plain), "lpHz {off} is off");
    }
    assert_ne!(bits(&render(vec![play_lp(V1, NYQUIST, MIXED | LOOP, 19_000.0)], 6)), bits(&plain), "19 kHz filters");
}

#[test]
fn lp_hz_filters_every_mixed_voice() {
    let mut m = mixer();
    m.submit(&[play_lp(V1, NYQUIST, MIXED | LOOP, 500.0)]);
    m.render_n(4);
    assert_eq!(fx_voices(&m), 1);
    let (l, r) = m.render();
    assert!(peak(&l) < 0.01 && peak(&r) < 0.01, "500 Hz removes Nyquist: {} {}", peak(&l), peak(&r));
    // Mono once: both channels carry the one filtered signal.
    assert_eq!(bits(&l), bits(&r));
}

#[test]
fn an_lp_hz_jump_on_a_playing_voice_ramps_click_free() {
    let reference = render(vec![play_lp(V1, SINE, MIXED | LOOP, OFF)], 12);
    let mut m = mixer();
    m.submit(&[play_lp(V1, SINE, MIXED | LOOP, OFF)]);
    let (before, _) = m.render_n(4);
    // rampFrames 0 on an audible voice: raised to the minimum and stretched to ≤ 1 octave per update.
    m.submit(&[set_lp(V1, 100.0, 0)]);
    let (during, _) = m.render_n(8);
    let mut all = before.clone();
    all.extend(&during);
    let bound = max_step(&reference);
    assert!(max_step(&all) <= 2.0 * bound, "step {} vs the unfiltered {}", max_step(&all), bound);
    assert!(peak(&during[during.len() - 128..]) < 0.25 * peak(&reference), "the low-pass took effect");
    // A ramp back up to LP_TOP switches it off again.
    m.submit(&[set_lp(V1, OFF, 256)]);
    m.render_n(16);
    assert_eq!(fx_voices(&m), 0);
}

#[test]
fn hp_hz_removes_dc() {
    let mut m = mixer();
    m.submit(&[dc(V1, 0, 0.0), voice_fx(V1, wire::SET_VOICE_FX_MASK_HP_HZ, 400.0, [0.0; 4], 0)]);
    m.render_n(20);
    let (l, _) = m.render();
    assert!(peak(&l) < 1e-3, "400 Hz high-pass removes DC: {}", peak(&l));
    // An ambisonic voice (PLAY bit 7) ignores lpHz and hpHz: it decodes through a bed or a private
    // decoder (B3), which this core lacks, so `tests/ambisonic_voices.rs` holds that check.
}

#[test]
fn the_pool_follows_the_mix() {
    let mut m = mixer();
    m.submit(&[play_lp(V1, NYQUIST, MIXED | LOOP, 500.0), play_lp(V2, NYQUIST, MIXED | LOOP, OFF)]);
    m.render_n(2);
    assert_eq!(fx_voices(&m), 1);
    // Demoted: the voice gives its entry back once its fade settles.
    m.submit(&[set_mixed(V1, false, 500.0)]);
    m.render_n(4);
    assert_eq!(fx_voices(&m), 0);
    // Promoted again: a fresh entry at the promote's lpHz.
    m.submit(&[set_mixed(V1, true, 800.0)]);
    m.render_n(2);
    assert_eq!(fx_voices(&m), 1);
    // SET_VOICE_FX on a virtual voice is dropped (main re-sends it with the promote).
    m.submit(&[set_mixed(V2, false, OFF)]);
    m.render_n(4);
    m.submit(&[voice_fx(V2, wire::SET_VOICE_FX_MASK_HP_HZ, 400.0, [0.0; 4], 0), set_mixed(V2, true, OFF)]);
    m.render_n(2);
    assert_eq!(fx_voices(&m), 1, "V2 promoted with no high-pass");
    // RESET clears the pool.
    m.submit(&[reset(true)]);
    m.render();
    assert_eq!(fx_voices(&m), 0);
}

#[test]
fn a_full_pool_takes_the_entry_of_a_voice_fading_out() {
    // `common::params` mixes at most 16.
    let mut m = mixer();
    let recs: Vec<Rec> = (1..=16u32).map(|i| play_lp(0x0001_0000 | i, NYQUIST, MIXED | LOOP, OFF)).collect();
    m.submit(&recs);
    m.render();
    // V1 starts fading out and a 17th voice is promoted in the same batch, filtered.
    let v17 = 0x0001_0000 | 17;
    m.submit(&[set_mixed(V1, false, OFF), play_lp(v17, NYQUIST, MIXED | LOOP, 500.0)]);
    m.render();
    assert_eq!(fx_voices(&m), 1, "the 17th voice holds V1's entry, filtered");
}

#[test]
fn a_zone_send_reorders_the_chain_and_the_no_op_tap_keeps_the_sound() {
    let base = vec![play_lp(V1, SINE, MIXED | LOOP, OFF), set_gain(V1, 0.5)];
    let plain = render(base, 4);
    let sending = render(vec![play_lp(V1, SINE, MIXED | LOOP, OFF), set_gain(V1, 0.5), voice_fx(V1, wire::SET_VOICE_FX_MASK_SENDS, 0.0, [0.5, 0.0, 0.0, 0.25], 0)], 4);
    for (a, b) in plain.iter().zip(&sending) {
        assert!((a - b).abs() <= 1e-6, "{a} vs {b}");
    }
}
