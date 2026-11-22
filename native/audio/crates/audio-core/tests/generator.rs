//! Generator voices through the core (ADR 0346 §3, ABI 5.1).

mod common;

use common::*;

/// The reserved clip id of an oscillator (`GEN_CLIP_ID_FIRST` + 1).
const OSC: u32 = 0xFFFF_0301;

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

#[test]
fn a_looping_oscillator_play_sounds_with_no_clip_uploaded() {
    let mut m = Mixer::new(4);
    m.submit(&[play(1 << 16 | 1, OSC, ROOT, MIXED | LOOP)]);
    let (l, _) = m.render_n(40);
    // The oscillator's defaults: a 440 Hz sine at -12 dB (0.25 peak, 0.177 RMS), centred.
    let tail = &l[l.len() - 2_048..];
    assert!(rms(tail) > 0.1, "the oscillator sounds: rms {}", rms(tail));
}
