//! ADR 0331 instance submixes (ABI 4.5), through `scheduler::submit` and `Core::process`:
//!
//! - the voices of a group with a submix mix into it, its chain runs, and it feeds its bus;
//! - voices of other groups (and of group 0) are untouched;
//! - a bypassed effect passes the signal through exactly; an unknown kind passes it through;
//! - an effect count of 0 frees the slot (the voices go straight to their bus again);
//! - a group configured on another slot moves there; RESET frees every slot;
//! - a malformed SUBMIX refuses the batch.

mod common;

use audio_core::submix;
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;

fn mixer() -> Mixer {
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    m
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

/// SUBMIX on `slot`: `group`, `bus` and `(type, on, params)` effects.
fn submix_rec(slot: u32, group: u16, bus: u16, effects: &[(u32, bool, &[f32])]) -> Rec {
    let s = wire::Submix {
        voice_id: slot,
        frame_offset: wire::ASAP,
        group,
        bus,
        parent: 0,
        reserved: 0,
        effects: effects
            .iter()
            .map(|&(type_, on, p)| {
                let mut a = [0.0f32; 8];
                a[..p.len()].copy_from_slice(p);
                wire::SubmixEffects { type_, flags: if on { wire::SUBMIX_FX_ON } else { 0 }, p: a }
            })
            .collect(),
    };
    raw(move |b| s.write(b, 0))
}

/// A looping mixed PLAY of `clip` on `bus` in `group`.
fn play_in(voice: u32, clip: u32, bus: u16, group: u16) -> Rec {
    let Rec::Play(mut p) = play(voice, clip, bus, MIXED | LOOP) else { unreachable!() };
    p.group = group;
    Rec::Play(p)
}

/// A clip at Nyquist (+1, -1, ...): a 500 Hz low-pass removes it.
fn nyquist(m: &mut Mixer, id: u32) {
    let clip: Vec<f32> = (0..8192).map(|i| if i % 2 == 0 { 0.5 } else { -0.5 }).collect();
    m.load_clip(id, &clip);
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |a, v| a.max(v.abs()))
}

const LOWPASS_500: &[f32] = &[500.0, 0.1, 0.0];

#[test]
fn a_groups_voices_run_its_chain_and_other_groups_are_untouched() {
    let mut m = mixer();
    nyquist(&mut m, 2);
    m.submit(&[config(&[ROOT, 0]), submix_rec(0, 5, 1, &[(wire::SUBMIX_FX_LOWPASS as u32, true, LOWPASS_500)]), play_in(V1, 2, 1, 5)]);
    assert_eq!(submix::active(&mut m.core), 1);
    assert_eq!(submix::slot_of(&mut m.core, 5), Some(0));
    m.render_n(4);
    let (l, r) = m.render();
    assert!(peak(&l) < 0.01 && peak(&r) < 0.01, "the submix's 500 Hz low-pass removes Nyquist: {} {}", peak(&l), peak(&r));
    // A voice of group 6 (no submix) on the same bus passes untouched.
    m.submit(&[play_in(V2, 2, 1, 6)]);
    m.render_n(2);
    let (l, _) = m.render();
    assert!((peak(&l) - 0.5).abs() < 0.01, "group 6 is not filtered: {}", peak(&l));
}

#[test]
fn a_voice_of_the_instance_on_another_bus_is_not_routed() {
    let mut m = mixer();
    nyquist(&mut m, 2);
    // The submix feeds bus 1; a voice of group 5 on bus 0 (a nested playlist's output override) plays straight.
    m.submit(&[config(&[ROOT, 0]), submix_rec(0, 5, 1, &[(wire::SUBMIX_FX_LOWPASS as u32, true, LOWPASS_500)]), play_in(V1, 2, 0, 5)]);
    m.render();
    let (l, _) = m.render();
    check(&l, 0.0, "unfiltered", |j| if j % 2 == 0 { 0.5 } else { -0.5 });
}

#[test]
fn a_bypassed_or_unknown_effect_passes_exactly_and_freeing_restores_the_direct_path() {
    let mut m = mixer();
    nyquist(&mut m, 2);
    m.submit(&[submix_rec(3, 9, 0, &[(wire::SUBMIX_FX_LOWPASS as u32, false, LOWPASS_500), (99, true, &[1.0, 2.0])]), play_in(V1, 2, 0, 9)]);
    m.render();
    let (l, _) = m.render();
    check(&l, 0.0, "bypassed and unknown effects pass the voice exactly", |j| if j % 2 == 0 { 0.5 } else { -0.5 });
    // Turned on: filtered.
    m.submit(&[submix_rec(3, 9, 0, &[(wire::SUBMIX_FX_LOWPASS as u32, true, LOWPASS_500)])]);
    m.render_n(4);
    assert!(peak(&m.render().0) < 0.01);
    // Freed: the voice goes straight to its bus again.
    m.submit(&[submix_rec(3, 0, 0, &[])]);
    assert_eq!(submix::active(&mut m.core), 0);
    m.render();
    let (l, _) = m.render();
    check(&l, 0.0, "freed", |j| if j % 2 == 0 { 0.5 } else { -0.5 });
}

#[test]
fn a_group_moves_to_its_new_slot_and_reset_frees_every_slot() {
    let mut m = mixer();
    m.submit(&[submix_rec(0, 4, 0, &[(wire::SUBMIX_FX_LOWPASS as u32, true, LOWPASS_500)]), submix_rec(1, 7, 0, &[(wire::SUBMIX_FX_HIGHPASS as u32, true, &[100.0])])]);
    assert_eq!(submix::active(&mut m.core), 2);
    m.submit(&[submix_rec(2, 4, 0, &[(wire::SUBMIX_FX_HIGHPASS as u32, true, &[100.0])])]);
    assert_eq!(submix::slot_of(&mut m.core, 4), Some(2));
    assert_eq!(submix::active(&mut m.core), 2);
    // Slot 1 taken over by group 8: group 7 loses its route.
    m.submit(&[submix_rec(1, 8, 0, &[(wire::SUBMIX_FX_HIGHPASS as u32, true, &[100.0])])]);
    assert_eq!(submix::slot_of(&mut m.core, 7), None);
    assert_eq!(submix::slot_of(&mut m.core, 8), Some(1));
    m.submit(&[reset(true)]);
    assert_eq!(submix::active(&mut m.core), 0);
    assert_eq!(submix::slot_of(&mut m.core, 4), None);
}

#[test]
fn a_compressor_with_makeup_raises_a_quiet_voice() {
    let mut m = mixer();
    let Rec::Play(mut p) = dc(V2, 0, 0.0) else { unreachable!() };
    p.group = 3;
    p.gain = 0.1;
    m.submit(&[Rec::Play(p)]);
    m.render_n(2);
    let base = m.render().0[64];
    // Threshold 0 dB (the voice is far below it), makeup 6 dB: group 3's voice comes up.
    m.submit(&[submix_rec(0, 3, 0, &[(wire::SUBMIX_FX_COMPRESSOR as u32, true, &[0.0, 4.0, 10.0, 120.0, 6.0, 0.0])])]);
    for _ in 0..400 {
        m.render();
    }
    let louder = m.render().0[64];
    assert!(louder > base + 0.05, "{base} -> {louder}");
}

#[test]
fn a_malformed_submix_refuses_the_batch() {
    let mut m = mixer();
    let Rec::Raw(mut b) = submix_rec(0, 1, 0, &[(wire::SUBMIX_FX_LOWPASS as u32, true, LOWPASS_500)]) else { unreachable!() };
    // Claim two effects in a record that holds one.
    b[16] = 2;
    assert_eq!(m.try_submit(&[Rec::Raw(b)]), wire::ERR_MALFORMED);
    assert_eq!(submix::active(&mut m.core), 0);
}
