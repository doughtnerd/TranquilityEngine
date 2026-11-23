//! ADR 0362 items 2 and 3 (ABI 6.1) through `scheduler::submit` and `Core::process`:
//!
//! - **Reverse** (PLAY flag `reverse`): a PCM clip voice reads its clip backwards, its positions counted from the clip's
//!   end: on a ramp clip (sample `k` is `k / 10000`, under the master limiter) the output tells the frame read. A start offset, a SET_LOOP region
//!   and a LOOPS program are in those reversed positions, so loops run backwards inside the clip; a virtual reversed
//!   voice keeps the same time; stream voices ignore the flag.
//! - **Amp envelope** (AMP_ENVELOPE): on the DC clip (every sample 1) the output is the envelope's gain, frame for
//!   frame, bit for bit with `audio_dsp::adsr`: from a stamped start inside a quantum, from an offset (a voice starting
//!   inside its clip), across a virtual stretch (it keeps time), held while paused, and removed by a record with the
//!   flag clear.

mod common;

use audio_core::voices;
use audio_dsp::adsr::{Adsr, KEY_OFF_NONE};
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const RAMP: u32 = 2;
const N: usize = 4000;

fn mixer() -> Mixer {
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    let clip: Vec<f32> = (0..N).map(|i| i as f32 / 10_000.0).collect();
    m.load_clip(RAMP, &clip);
    m
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

fn frames(l: &[f32]) -> Vec<i32> {
    l.iter().map(|&s| (s * 10_000.0).round() as i32).collect()
}

fn reversed_play(voice: u32, offset: u32, flags: u16) -> Rec {
    match play(voice, RAMP, 0, flags | wire::PLAY_FLAGS_REVERSE) {
        Rec::Play(mut p) => {
            p.start_offset_frames = offset;
            Rec::Play(p)
        }
        _ => unreachable!(),
    }
}

fn set_loop(voice: u32, start: u32, end: u32, looping: bool, frame_offset: u32) -> Rec {
    let l = wire::SetLoop { voice_id: voice, frame_offset, loop_start_frame: start, loop_end_frame: end, flags: looping as u32 };
    raw(move |b| l.write(b, 0))
}

fn envelope(voice: u32, e: Adsr, offset: u32, on: bool) -> Rec {
    let rec = wire::AmpEnvelope {
        voice_id: voice,
        frame_offset: wire::ASAP,
        flags: if on { wire::AMP_ENV_ON } else { 0 },
        attack_frames: e.attack,
        hold_frames: e.hold,
        decay_frames: e.decay,
        sustain: e.sustain,
        release_frames: e.release,
        key_off_frame: e.key_off,
        offset_frames: offset,
    };
    raw(move |b| rec.write(b, 0))
}

fn mixed(voice: u32, on: bool) -> Rec {
    let m = wire::SetMixed { voice_id: voice, frame_offset: wire::ASAP, mixed: on as u32, gain: 1.0, dir_x: 0.0, dir_y: 0.0, dir_z: -1.0, lp_hz: 24_000.0 };
    raw(move |b| m.write(b, 0))
}

fn paused(voice: u32, on: bool) -> Rec {
    let p = wire::SetPaused { voice_id: voice, frame_offset: wire::ASAP, paused: on as u32 };
    raw(move |b| p.write(b, 0))
}

const ENV: Adsr = Adsr { attack: 100, hold: 50, decay: 100, release: 200, key_off: 1_000, sustain: 0.5 };

#[test]
fn a_reversed_voice_reads_its_clip_backwards_and_ends_at_its_start() {
    let mut m = mixer();
    m.submit(&[reversed_play(V1, 0, MIXED)]);
    let (l, _) = m.render_n(33);
    let f = frames(&l);
    let want: Vec<i32> = (0..N as i32).rev().collect();
    assert_eq!(&f[..N], &want[..]);
    assert!(l[N..].iter().all(|&x| x == 0.0), "silent past the clip's first frame");
    assert_eq!(voices::live_count(&mut m.core), 0, "it ended there");
}

#[test]
fn a_start_offset_counts_from_the_clip_end() {
    let mut m = mixer();
    m.submit(&[reversed_play(V1, 1_000, MIXED)]);
    let (l, _) = m.render_n(2);
    assert_eq!(&frames(&l)[..5], &[2999, 2998, 2997, 2996, 2995]);
}

#[test]
fn a_loop_region_runs_backwards_inside_the_clip_and_a_release_plays_on_down_to_the_start() {
    let mut m = mixer();
    // Reversed positions 100..200 are clip frames 3899 down to 3800.
    m.submit(&[reversed_play(V1, 0, MIXED), set_loop(V1, 100, 200, true, wire::ASAP)]);
    let (l, _) = m.render_n(4);
    let f = frames(&l);
    let want: Vec<i32> = (3800..4000).rev().chain((3800..3900).rev()).chain((3800..3900).rev()).chain((3800..3900).rev()).chain((3888..3900).rev()).collect();
    assert_eq!(f, want);
    let frame = m.frame;
    m.submit(&[set_loop(V1, 0, 0, false, (frame + 10 - m.frame) as u32)]);
    let (l, _) = m.render_n(2);
    let f = frames(&l);
    // Released inside its pass: it finishes the pass (down to 3800) and goes on below the loop.
    let at = f.iter().position(|&x| x == 3799).expect("it leaves the loop downwards");
    assert_eq!(f[at - 1], 3800);
    assert!(f[at..].windows(2).all(|w| w[1] == w[0] - 1));
}

#[test]
fn a_virtual_reversed_voice_keeps_the_same_time() {
    let mut a = mixer();
    let mut b = mixer();
    a.submit(&[reversed_play(V1, 0, MIXED)]);
    b.submit(&[reversed_play(V1, 0, 0)]);
    a.render_n(3);
    b.render_n(3);
    b.submit(&[mixed(V1, true)]);
    let (la, _) = a.render_n(4);
    let (lb, _) = b.render_n(4);
    // Once the promote's fade-in has settled the two read the same frames.
    let fade = (0.005 * RATE) as usize + 1;
    assert_eq!(frames(&la)[fade..], frames(&lb)[fade..]);
}

#[test]
fn a_stream_voice_ignores_the_reverse_flag() {
    let mut m = mixer();
    m.submit(&[reversed_play(V1, 0, MIXED | wire::PLAY_FLAGS_STREAM)]);
    m.render_n(1);
    let s = voices::slots(&m.core)[1];
    assert_eq!(s.flags2 & voices::flag2::REVERSE, 0);
}

/// The DC clip looping, mixed, with `rec` behind its PLAY; `n` quanta of the left channel.
fn dc_with(m: &mut Mixer, play_rec: Rec, recs: Vec<Rec>, n: usize) -> Vec<f32> {
    let mut all = vec![play_rec];
    all.extend(recs);
    m.submit(&all);
    m.render_n(n).0
}

fn dc_play(voice: u32, flags: u16) -> Rec {
    play(voice, DC, 0, flags | wire::PLAY_FLAGS_LOOP)
}

#[test]
fn the_envelope_is_the_adsr_gain_frame_for_frame() {
    let mut m = mixer();
    let l = dc_with(&mut m, dc_play(V1, MIXED), vec![envelope(V1, ENV, 0, true)], 12);
    for (t, &x) in l.iter().enumerate() {
        assert_eq!(x.to_bits(), ENV.gain(t as u64).to_bits(), "frame {t}");
    }
    assert_eq!(l[100], 1.0);
    assert_eq!(l[500], 0.5);
    assert!(l[1_200..].iter().all(|&x| x == 0.0), "silent after the release");
}

#[test]
fn a_stamped_start_and_an_offset_start_the_envelope_on_the_voice_first_frame() {
    let mut m = mixer();
    let mut p = dc_play(V1, MIXED);
    if let Rec::Play(ref mut q) = p {
        q.frame_offset = 37;
    }
    let l = dc_with(&mut m, p, vec![envelope(V1, ENV, 120, true)], 4);
    assert!(l[..37].iter().all(|&x| x == 0.0));
    for t in 37..l.len() {
        assert_eq!(l[t].to_bits(), ENV.gain((t - 37 + 120) as u64).to_bits(), "frame {t}");
    }
}

#[test]
fn a_virtual_stretch_keeps_the_envelope_time_and_a_pause_holds_it() {
    let mut m = mixer();
    let unbounded = Adsr { attack: 2_000, hold: 0, decay: 0, release: 0, key_off: KEY_OFF_NONE, sustain: 1.0 };
    dc_with(&mut m, dc_play(V1, 0), vec![envelope(V1, unbounded, 0, true)], 2);
    m.submit(&[mixed(V1, true)]);
    let (l, _) = m.render_n(4);
    // After the promote's fade the gain is the envelope's at the frame it would have reached mixed.
    let fade = (0.005 * RATE) as usize + 1;
    for k in fade..l.len() {
        assert_eq!(l[k].to_bits(), unbounded.gain((256 + k) as u64).to_bits(), "frame {k}");
    }
    // Paused: its fade-out renders (and moves the envelope) for the mix fade, then it holds, out of the mix, for 4
    // quanta; resumed and promoted (as main does), the envelope goes on from where the fade-out ended.
    let mix_fade = voices::mix_fade_frames(&m.core) as usize;
    m.submit(&[paused(V1, true)]);
    m.render_n(6);
    m.submit(&[paused(V1, false), mixed(V1, true)]);
    let (l, _) = m.render_n(4);
    let at = 256 + 512 + mix_fade;
    for k in mix_fade + 1..l.len() {
        assert_eq!(l[k].to_bits(), unbounded.gain((at + k) as u64).to_bits(), "frame {k} after the resume");
    }
}

#[test]
fn a_record_with_the_flag_clear_removes_the_envelope() {
    let mut m = mixer();
    dc_with(&mut m, dc_play(V1, MIXED), vec![envelope(V1, ENV, 0, true)], 1);
    m.submit(&[envelope(V1, ENV, 0, false)]);
    let (l, _) = m.render_n(1);
    assert!(l.iter().all(|&x| x == 1.0));
}

#[test]
fn a_reversed_voice_takes_an_envelope_too() {
    let mut m = mixer();
    m.submit(&[reversed_play(V1, 0, MIXED), envelope(V1, ENV, 0, true)]);
    let (l, _) = m.render_n(10);
    for (t, &x) in l.iter().enumerate().take(1_200) {
        let s = (N - 1 - t) as f32 / 10_000.0;
        assert_eq!(x.to_bits(), (s * ENV.gain(t as u64)).to_bits(), "frame {t}");
    }
}
