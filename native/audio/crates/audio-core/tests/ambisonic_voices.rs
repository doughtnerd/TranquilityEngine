//! ADR 0162 B3: the core's ambisonic voice end to end through `scheduler::submit` and
//! `Core::process` (api-and-models §1.6, §4.2 LISTENER, §10 B3; architecture §2.3, §3.5).
//!
//! The clips are DC: every channel of a 4, 9 or 16-channel clip holds a source's SN3D gains at one
//! direction, so the decoded output is constant and a turn shows as a change of level. Without the
//! MagLS filters every bed and private decoder decodes through the baked matrix (R9), whose gains
//! for a field are `bed_matrix::gains`; the expected outputs are the matrix gains of the source's
//! harmonics at the **rotated direction** (computed with `encode_gains`, not with the core's
//! rotation), truncated to the clip's order. The limiter's look-ahead is 0 (core time).
//!
//! - a 90 degree turn of the listener (and a clip's yaw) moves the image, at orders 1 to 3, through
//!   a bed and through a private decoder;
//! - at head speeds (up to 720 degrees a second, LISTENER every 16 ms) the ramped rotation is
//!   within 0.1 dB of the exact rotation at every sample;
//! - private decoders: decode into the voice's bus before its effects, are shared by the voices of
//!   one bus, are freed when idle; a bed shared from an ancestor folds the bus's gain;
//! - `maxClips` stealing in the core (lowest score, older first at equal scores);
//! - an ambisonic voice is never filtered; STATUS `ambisonicVoices`; a plain voice on an ambisonic
//!   clip pans its W as mono; LISTENER without a `Beds` region and RESET.

mod common;

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{status, Core};
use audio_dsp::ambisonic::{encode_gains, engine_to_ambix, CHANNELS};
use audio_wire::generated as wire;
use common::*;

const AMB: u16 = wire::PLAY_FLAGS_AMBISONIC;
/// The clip ids: `CLIP + channels`.
const CLIP: u32 = 100;
/// The DC level of the source the clips encode.
const A: f32 = 0.25;
const FRONT: [f32; 3] = [0.0, 0.0, -1.0];
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const V3: u32 = 0x0001_0003;
const V4: u32 = 0x0001_0004;

fn core_with(max_beds: u32, max_wide: u32) -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 16, max_buses: 4, arena_initial_bytes: 1 << 22, max_beds, max_wide, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// The source's harmonics at engine direction `dir`, truncated to `channels`.
fn field(dir: [f32; 3], channels: usize) -> [f32; CHANNELS] {
    let mut y = encode_gains(engine_to_ambix(dir), 3);
    y[channels..].fill(0.0);
    y
}

/// The matrix decode of the source at `dir` (order of `channels`), times `A`.
fn want(dir: [f32; 3], channels: usize) -> (f32, f32) {
    let (l, r) = audio_dsp::bed_matrix::gains(&field(dir, channels));
    (A * l, A * r)
}

/// A mixer over `core` (look-ahead 0) holding DC clips of 1, 4, 9 and 16 channels encoding a source
/// in front.
fn mixer(core: Core) -> Mixer {
    let mut m = Mixer::over(core);
    m.set_lookahead(0.0);
    for ch in [1usize, 4, 9, 16] {
        let y = field(FRONT, ch);
        let frames = 64;
        let samples: Vec<f32> = (0..frames).flat_map(|_| (0..ch).map(|c| A * y[c])).collect();
        m.core.clips_mut().reserve(CLIP + ch as u32, frames as u32, ch as u32, RATE, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        m.core.clips_mut().write(CLIP + ch as u32, 0, &bytes).unwrap();
    }
    m
}

fn amb(voice: u32, channels: usize, bus: u16, score: f32) -> Rec {
    let Rec::Play(mut p) = play(voice, CLIP + channels as u32, bus, MIXED | LOOP | AMB) else { unreachable!() };
    p.score = score;
    Rec::Play(p)
}

/// The world-to-listener quaternion of a head turned `deg` degrees to the left (about +Y): the
/// inverse turn, so a source in front ends up on the listener's right for `deg` 90.
fn head_left(deg: f32) -> [f32; 4] {
    let a = -deg.to_radians() / 2.0;
    [0.0, a.sin(), 0.0, a.cos()]
}

/// The engine direction `dir` turned by `deg` degrees about +Y (counter-clockwise seen from above).
fn turn(dir: [f32; 3], deg: f32) -> [f32; 3] {
    let (s, c) = deg.to_radians().sin_cos();
    [c * dir[0] + s * dir[2], dir[1], -s * dir[0] + c * dir[2]]
}

fn listener(q: [f32; 4], ramp_frames: u32, snap: bool) -> Rec {
    let mut b = vec![0u8; wire::Listener::FIXED_END];
    wire::Listener { voice_id: 0, frame_offset: wire::ASAP, qx: q[0], qy: q[1], qz: q[2], qw: q[3], ramp_frames, flags: if snap { wire::LISTENER_FLAGS_SNAP } else { 0 } }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn voice_fx(voice: u32, mask: u32, hp_hz: f32, yaw: f32) -> Rec {
    let mut b = vec![0u8; wire::SetVoiceFx::FIXED_END];
    wire::SetVoiceFx { voice_id: voice, frame_offset: wire::ASAP, mask, ramp_frames: 0, hp_hz, send: [0.0; 4], yaw, aux_level: 0.0, aux_bus: wire::AUX_BUS_NONE as u16, reserved: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn bed_config(bed_slot: &[u8], host_bus: &[u16]) -> Rec {
    let mut b = vec![0u8; 256];
    let n = wire::BedConfig { voice_id: 0, frame_offset: wire::ASAP, bed_slot: bed_slot.to_vec(), host_bus: host_bus.to_vec() }.write(&mut b, 0).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

fn db(a: f32, b: f32) -> f32 {
    (20.0 * (a.abs() / b.abs()).log10()).abs()
}

/// Asserts the last quantum of `(l, r)` is `(wl, wr)` within 0.05 dB.
fn expect_level(out: &(Vec<f32>, Vec<f32>), w: (f32, f32), what: &str) {
    let n = out.0.len();
    for i in n - 128..n {
        assert!(db(out.0[i], w.0) < 0.05 && db(out.1[i], w.1) < 0.05, "{what}: frame {i} is ({}, {}), expected ({}, {})", out.0[i], out.1[i], w.0, w.1);
    }
}

#[test]
fn a_90_degree_turn_moves_the_image_at_every_order_through_a_bed_and_a_private_decoder() {
    for ch in [4usize, 9, 16] {
        for bed in [false, true] {
            let what = format!("{ch} channels, {}", if bed { "bed" } else { "private decoder" });
            let mut m = mixer(core_with(bed as u32, 1));
            let mut recs = vec![config(&[ROOT]), gains(0, &[1.0])];
            if bed {
                recs.push(bed_config(&[0], &[0]));
            }
            recs.push(amb(V1, ch, ROOT, 1.0));
            m.submit(&recs);
            let ahead = m.render_n(2);
            expect_level(&ahead, want(FRONT, ch), &format!("{what}, facing it"));
            assert!(db(ahead.0[200], ahead.1[200]) < 1e-3, "{what}: in front, centred");
            // The head turns 90 degrees left (a cut): the source is on the right.
            m.submit(&[listener(head_left(90.0), 0, true)]);
            let turned = m.render_n(2);
            let right = turn(FRONT, -90.0);
            assert!((right[0] - 1.0).abs() < 1e-6);
            expect_level(&turned, want(right, ch), &format!("{what}, turned left"));
            assert!(turned.1[200] > 2.0 * turned.0[200], "{what}: the image moved right ({}, {})", turned.0[200], turned.1[200]);
            // The clip's yaw turns the field back by 90 degrees (positive yaw: counter-clockwise).
            m.submit(&[voice_fx(V1, wire::SET_VOICE_FX_MASK_YAW, 0.0, core::f32::consts::FRAC_PI_2)]);
            let back = m.render_n(2);
            expect_level(&back, want(FRONT, ch), &format!("{what}, yaw 90 undoes the turn"));
            assert_eq!(status::counters(&m.core).spatial.ambisonic_voices, 1);
        }
    }
}

#[test]
fn a_clip_yaw_alone_turns_the_field_left() {
    let mut m = mixer(core_with(0, 1));
    m.submit(&[amb(V1, 16, ROOT, 1.0), voice_fx(V1, wire::SET_VOICE_FX_MASK_YAW, 0.0, core::f32::consts::FRAC_PI_2)]);
    let out = m.render_n(3);
    expect_level(&out, want(turn(FRONT, 90.0), 16), "yaw 90");
    assert!(out.0[300] > 2.0 * out.1[300], "on the left");
}

/// The head turns at `deg_per_s` (left, LISTENER every 768 frames ≈ 16 ms, each ramping over those
/// frames as main sends it): every output sample is within 0.1 dB of the matrix decode of the
/// source rotated exactly to that sample's angle.
fn head_speed_error(deg_per_s: f32, ch: usize) -> f32 {
    let mut m = mixer(core_with(0, 1));
    m.submit(&[amb(V1, ch, ROOT, 1.0)]);
    m.render_n(2);
    let frames_per_update = 768usize;
    let per_update = deg_per_s * frames_per_update as f32 / RATE;
    let mut worst = 0.0f32;
    let mut angle = 0.0f32;
    for _ in 0..40 {
        let next = angle + per_update;
        m.submit(&[listener(head_left(next), frames_per_update as u32, false)]);
        let (l, r) = m.render_n(frames_per_update / 128);
        for i in 0..frames_per_update {
            let a = angle + per_update * (i + 1) as f32 / frames_per_update as f32;
            let (wl, wr) = want(turn(FRONT, -a), ch);
            for (got, w) in [(l[i], wl), (r[i], wr)] {
                // Only where the channel carries the image (above -20 dB of the source).
                if w.abs() > 0.1 * A {
                    worst = worst.max(db(got, w));
                }
            }
        }
        angle = next;
    }
    worst
}

#[test]
fn rotation_follows_head_speeds_within_a_tenth_of_a_db() {
    for ch in [4usize, 16] {
        for speed in [90.0f32, 360.0, 720.0] {
            let worst = head_speed_error(speed, ch);
            eprintln!("{ch} channels at {speed} deg/s: worst {worst:.4} dB");
            assert!(worst < 0.1, "{ch} channels at {speed} deg/s: {worst} dB");
        }
    }
}

#[test]
fn a_private_decoder_decodes_into_its_bus_before_its_effects_and_a_shared_bed_folds() {
    // Bus 1 (gain 0.5) under the root; no bed: a private decoder hosted by bus 1.
    let mut m = mixer(core_with(1, 1));
    m.submit(&[config(&[ROOT, 0]), gains(0, &[1.0, 0.5]), amb(V1, 16, 1, 1.0)]);
    let out = m.render_n(3);
    let (wl, wr) = want(FRONT, 16);
    expect_level(&out, (0.5 * wl, 0.5 * wr), "private decoder on bus 1");
    assert!(status::counters(&m.core).spatial.work_bed > 0, "its work in workBed");
    assert_eq!(status::counters(&m.core).spatial.beds_active, 0, "not a bed");
    // Bus 1 shares the root's bed: the voice folds bus 1's gain into its rotation.
    m.submit(&[bed_config(&[0, 0], &[0])]);
    let out = m.render_n(4);
    expect_level(&out, (0.5 * wl, 0.5 * wr), "shared bed on bus 1");
}

#[test]
fn voices_of_one_bus_share_a_private_decoder_and_an_idle_one_is_freed() {
    // Two private decoders, three voices: two on the root share one, one on bus 1 takes the other.
    let mut m = mixer(core_with(0, 2));
    let (wl, wr) = want(FRONT, 4);
    m.submit(&[config(&[ROOT, 0]), gains(0, &[1.0, 1.0]), amb(V1, 4, ROOT, 1.0), amb(V2, 4, ROOT, 1.0)]);
    let out = m.render_n(3);
    expect_level(&out, (2.0 * wl, 2.0 * wr), "two voices, one decoder");
    m.submit(&[stop_now(V1), stop_now(V2)]);
    m.render_n(4);
    // Both decoders are free again: two voices on two buses each get one.
    m.submit(&[amb(V3, 4, ROOT, 1.0), amb(V4, 4, 1, 1.0)]);
    let out = m.render_n(3);
    expect_level(&out, (2.0 * wl, 2.0 * wr), "two buses, two decoders");
}

#[test]
fn a_voice_with_no_free_private_decoder_is_silent_and_takes_one_once_free() {
    // One private decoder on the root; a voice on bus 1 finds none until the root's is idle.
    let mut m = mixer(core_with(0, 1));
    m.submit(&[config(&[ROOT, 0]), gains(0, &[1.0, 1.0]), amb(V1, 4, ROOT, 1.0)]);
    m.render_n(2);
    // A higher score on bus 1: V1 is stolen and fades out while it still holds the root's decoder.
    m.submit(&[amb(V2, 4, 1, 2.0)]);
    m.render_n(6);
    let out = m.render_n(2);
    expect_level(&out, want(FRONT, 4), "bus 1's voice, once the root's decoder was freed");
}

fn stop_now(voice: u32) -> Rec {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: voice, frame_offset: wire::ASAP, fade_frames: 0, ..Default::default() }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn ended(m: &Mixer) -> Vec<u32> {
    status::counters(&m.core).ended.as_slice().to_vec()
}

#[test]
fn max_clips_steals_the_lowest_score_older_first_at_equal_scores() {
    // (STATUS `ended` accumulates here: nothing writes the block.)
    let mut m = mixer(core_with(0, 1));
    m.submit(&[amb(V1, 4, ROOT, 1.0)]);
    m.render_n(2);
    // A higher score: V1 fades out (5 ms) and ends.
    m.submit(&[amb(V2, 4, ROOT, 2.0)]);
    m.render();
    assert!(ended(&m).is_empty(), "V1 is fading out");
    m.render_n(3);
    assert_eq!(ended(&m), vec![V1], "V1 stolen");
    // A lower score: the newcomer itself goes, at once.
    m.submit(&[amb(V3, 4, ROOT, 0.5)]);
    m.render();
    assert_eq!(ended(&m), vec![V1, V3]);
    // An equal score: the older voice (V2) goes.
    m.submit(&[amb(V4, 4, ROOT, 2.0)]);
    m.render_n(4);
    assert_eq!(ended(&m), vec![V1, V3, V2]);
    let out = m.render_n(2);
    expect_level(&out, want(FRONT, 4), "V4 plays alone");
    assert_eq!(status::counters(&m.core).spatial.ambisonic_voices, 1);
    // Plain voices don't count against maxClips.
    m.submit(&[play(0x0001_0005, DC, ROOT, MIXED | LOOP)]);
    m.render();
    assert_eq!(ended(&m).len(), 3);
}

#[test]
fn max_clips_0_or_no_decoder_region_steals_every_ambisonic_voice() {
    let mut m = mixer(core_with(2, 0));
    m.submit(&[amb(V1, 4, ROOT, 9.0)]);
    m.render();
    assert_eq!(ended(&m), vec![V1]);
}

#[test]
fn an_ambisonic_voice_is_never_filtered() {
    let render = |recs: Vec<Rec>| {
        let mut m = mixer(core_with(0, 1));
        m.submit(&recs);
        m.render_n(4)
    };
    let plain = render(vec![amb(V1, 16, ROOT, 1.0)]);
    let Rec::Play(mut p) = amb(V1, 16, ROOT, 1.0) else { unreachable!() };
    p.lp_hz = 300.0;
    let filtered = render(vec![Rec::Play(p), voice_fx(V1, wire::SET_VOICE_FX_MASK_HP_HZ, 400.0, 0.0)]);
    assert_eq!(plain, filtered);
    assert!(plain.0.iter().any(|x| x.abs() > 0.05));
}

#[test]
fn a_plain_spatial_voice_on_an_ambisonic_clip_pans_its_w_as_mono() {
    let render = |clip: u32| {
        let mut m = mixer(core_with(0, 1));
        let Rec::Play(mut p) = play(V1, clip, ROOT, MIXED | LOOP | SPATIAL) else { unreachable!() };
        (p.dir_x, p.dir_z) = (0.6, -0.8);
        m.submit(&[Rec::Play(p)]);
        m.render_n(3)
    };
    // The 1-channel clip holds W (A · 1): the same signal as the 16-channel clip's channel 0.
    assert_eq!(render(CLIP + 16), render(CLIP + 1));
}

#[test]
fn listener_without_a_beds_region_is_dropped_and_reset_restores_the_identity() {
    let mut m = mixer(core_with(0, 0));
    m.submit(&[listener(head_left(90.0), 0, true)]);
    m.render();
    let mut m = mixer(core_with(0, 1));
    m.submit(&[listener(head_left(90.0), 0, true), amb(V1, 4, ROOT, 1.0)]);
    let out = m.render_n(2);
    expect_level(&out, want(turn(FRONT, -90.0), 4), "turned");
    m.submit(&[reset(true), amb(V2, 4, ROOT, 1.0)]);
    let out = m.render_n(3);
    expect_level(&out, want(FRONT, 4), "after RESET");
}
