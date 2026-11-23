//! ADR 0345 instance submixes (ABI 4.5), through `scheduler::submit` and `Core::process`:
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
    level_rec(slot, group, bus, 0, effects)
}

/// SUBMIX on `slot` feeding `parent` (slot + 1; 0 the bus), ABI 4.9.
fn level_rec(slot: u32, group: u16, bus: u16, parent: u16, effects: &[(u32, bool, &[f32])]) -> Rec {
    let s = wire::Submix {
        voice_id: slot,
        frame_offset: wire::ASAP,
        group,
        bus,
        parent,
        reserved: 0,
        effects: effects
            .iter()
            .map(|&(type_, on, p)| {
                let mut a = [0.0f32; 16];
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
    // ABI 4.9: the slot it left keeps running, ungrouped (a tail), until main frees it.
    assert_eq!(submix::active(&mut m.core), 3);
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

// --- ABI 4.9: per-level submixes, ROUTE, tails --------------------------------------------------

/// ROUTE `voice` into `slot` (`None`: back to its group's route).
fn route(voice: u32, slot: Option<u16>) -> Rec {
    let r = wire::Route { voice_id: voice, frame_offset: wire::ASAP, submix: slot.map_or(0, |s| s + 1), reserved: 0 };
    raw(move |b| r.write(b, 0))
}

fn stop(voice: u32) -> Rec {
    raw(move |b| wire::Stop { voice_id: voice, frame_offset: wire::ASAP, fade_frames: 0, reason: 0, shape: 0 }.write(b, 0))
}

const GAIN_6: &[f32] = &[6.0];
const SIX_DB: f32 = 1.995_262_3;

/// The DC clip at 0.2 (so +12 dB stays under the master limiter's ceiling).
fn quiet_dc(voice: u32) -> Rec {
    let Rec::Play(mut p) = dc(voice, 0, 0.0) else { unreachable!() };
    p.gain = 0.2;
    Rec::Play(p)
}

#[test]
fn a_nested_levels_chain_runs_on_its_own_voices_and_feeds_its_parents_chain() {
    let mut m = mixer();
    nyquist(&mut m, 2);
    // Slot 0: the instance's root chain (group 5, +6 dB). Slot 1: a nested level (no group) with a
    // 500 Hz low-pass, feeding slot 0. Slot 2: a deeper level (+6 dB) feeding slot 1.
    m.submit(&[
        submix_rec(0, 5, 0, &[(wire::SUBMIX_FX_GAIN as u32, true, GAIN_6)]),
        level_rec(1, 0, 0, 1, &[(wire::SUBMIX_FX_LOWPASS as u32, true, LOWPASS_500)]),
        level_rec(2, 0, 0, 2, &[(wire::SUBMIX_FX_GAIN as u32, true, GAIN_6)]),
        play_in(V1, 2, 0, 5),
        route(V1, Some(1)),
    ]);
    assert_eq!(submix::active(&mut m.core), 3);
    m.render_n(4);
    let (l, _) = m.render();
    assert!(peak(&l) < 0.02, "the nested level's low-pass applies to its voice: {}", peak(&l));
    // A voice of the instance outside that level gets the root's +6 dB only (no low-pass).
    m.submit(&[play_in(V2, 2, 0, 5)]);
    m.render_n(2);
    let (l, _) = m.render();
    assert!((peak(&l) - 0.5 * SIX_DB).abs() < 0.03, "root chain only: {}", peak(&l));
    // DC through the deepest level: +6 dB there, then the low-pass (DC passes), then the root's +6 dB.
    const V3: u32 = 0x0001_0003;
    let Rec::Play(mut p) = dc(V3, 0, 0.0) else { unreachable!() };
    p.gain = 0.2;
    p.group = 5;
    m.submit(&[stop(V1), stop(V2), Rec::Play(p), route(V3, Some(2))]);
    m.render_n(64);
    let (l, _) = m.render();
    assert!((l[64] - 0.2 * SIX_DB * SIX_DB).abs() < 0.01, "both gains, through every level: {}", l[64]);
}

#[test]
fn a_level_whose_parent_is_freed_feeds_its_bus_and_a_loop_of_parents_is_cut() {
    let mut m = mixer();
    m.submit(&[
        submix_rec(0, 5, 0, &[(wire::SUBMIX_FX_GAIN as u32, true, GAIN_6)]),
        level_rec(1, 0, 0, 1, &[(wire::SUBMIX_FX_GAIN as u32, true, &[0.0])]),
        quiet_dc(V1),
        route(V1, Some(1)),
    ]);
    m.render_n(8);
    let x = m.render().0[64];
    assert!((x - 0.2 * SIX_DB).abs() < 0.01, "{x}");
    m.submit(&[submix_rec(0, 0, 0, &[])]);
    m.render_n(2);
    assert!((m.render().0[64] - 0.2).abs() < 0.01, "the parent went: straight to the bus");
    // Slots 2 and 3 name each other: neither runs into the other (both feed the bus).
    m.submit(&[level_rec(2, 0, 0, 4, &[(wire::SUBMIX_FX_GAIN as u32, true, GAIN_6)]), level_rec(3, 0, 0, 3, &[(wire::SUBMIX_FX_GAIN as u32, true, GAIN_6)]), route(V1, Some(2))]);
    m.render_n(8);
    assert!((m.render().0[64] - 0.2 * SIX_DB).abs() < 0.01, "one level gain, not a feedback loop");
}

/// A 64-frame burst of 0.5 (then silence), played once.
fn burst(m: &mut Mixer, id: u32) {
    let clip: Vec<f32> = (0..64).map(|_| 0.5).collect();
    m.load_clip(id, &clip);
}

#[test]
fn a_one_shot_voices_delay_rings_after_the_voice_has_ended_and_after_its_group_detaches() {
    for detach in [false, true] {
        let mut m = mixer();
        burst(&mut m, 3);
        // A 20 ms (960-frame) delay, 50 % feedback, all wet.
        let delay = &[20.0f32, 50.0, 100.0][..];
        let Rec::Play(mut p) = play(V1, 3, 0, MIXED) else { unreachable!() };
        p.group = 5;
        let root = if detach { 5 } else { 0 };
        m.submit(&[level_rec(4, root, 0, 0, &[(wire::SUBMIX_FX_DELAY as u32, true, delay)]), Rec::Play(p)]);
        if !detach {
            m.submit(&[route(V1, Some(4))]);
        }
        m.render_n(2);
        assert_eq!(audio_core::voices::live_count(&mut m.core), 0, "the one-shot has ended");
        if detach {
            // The instance ended: main keeps its slot (group 0, the same chain) until its tail is out.
            m.submit(&[level_rec(4, 0, 0, 0, &[(wire::SUBMIX_FX_DELAY as u32, true, delay)])]);
            assert_eq!(submix::slot_of(&mut m.core, 5), None);
        }
        let mut heard = Vec::new();
        for _ in 0..30 {
            heard.extend(m.render().0);
        }
        // Rendered from frame 256: echoes at 960, 1920 (0.5, 0.25 of the burst, all wet).
        let at = |f: usize| peak(&heard[f - 256..f - 256 + 64]);
        assert!(at(960) > 0.2, "first echo after the voice ended (detach {detach}): {}", at(960));
        assert!(at(1920) > 0.1, "second echo: {}", at(1920));
        assert!(at(1500) < 1e-4, "silence between echoes");
        assert_eq!(submix::active(&mut m.core), 1);
    }
}
