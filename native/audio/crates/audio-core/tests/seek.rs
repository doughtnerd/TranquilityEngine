//! SEEK records for clip voices (ADR 0157 B3b; api-and-models §4.2 SEEK): a mixed voice fades out
//! over 5 ms (the `mix` ramp), jumps to the clip frame and fades back in from it; a virtual voice
//! jumps at once; a loop wraps the target and a one-shot clamps it to the end; a later SEEK before
//! the jump replaces the target; a voice not started yet starts at the target; a stale id is
//! dropped. (Stream voices' SEEK is tested with the rings, in `stream.rs`.)
//!
//! Each case submits BATCH messages through `scheduler::submit` and renders with `Core::process`
//! (limiter look-ahead 0, so output frames are core frames), as `paused.rs` does.

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::voices::{self, state};
use audio_core::{bus, scheduler, Core, QUANTUM};
use audio_wire::generated as wire;

const RATE: f32 = 48_000.0;
/// 5 ms at 48 kHz.
const FADE: usize = 240;
const CLIP: u32 = 1;
const V1: u32 = 0x0001_0001;
const FRAMES: u32 = 96_000;
const TOL: f32 = 1e-6;

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 16, max_mixed: 8, max_buses: 2, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose.
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh zeroed block of `layout.total()` bytes, page-aligned.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

enum Rec {
    Play(wire::Play),
    Seek(wire::Seek),
}

impl Rec {
    fn size(&self) -> usize {
        match self {
            Rec::Play(_) => wire::Play::FIXED_END,
            Rec::Seek(_) => wire::Seek::FIXED_END,
        }
    }

    fn write(&self, out: &mut [u8], at: usize) -> usize {
        match self {
            Rec::Play(r) => r.write(out, at),
            Rec::Seek(r) => r.write(out, at),
        }
        .unwrap()
    }
}

struct Mixer {
    core: Core,
    frame: u64,
}

impl Mixer {
    /// A core with a mono clip whose sample `k` is `k / 100_000` (so the output says which frame is playing).
    fn new() -> Mixer {
        let mut core = new_core();
        core.clips_mut().reserve(CLIP, FRAMES, 1, RATE, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = (0..FRAMES).flat_map(|k| (k as f32 / 100_000.0).to_le_bytes()).collect();
        core.clips_mut().write(CLIP, 0, &bytes).unwrap();
        Mixer { core, frame: 0 }
    }

    fn submit(&mut self, recs: &[Rec]) {
        let body: usize = recs.iter().map(Rec::size).sum();
        let mut buf = vec![0u8; 32 + body];
        let mut at = 32;
        for r in recs {
            at += r.write(&mut buf, at);
        }
        wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        wire::BatchHeader { first_frame: self.frame as f64, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), 0);
    }

    fn render(&mut self, n: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for _ in 0..n {
            let o = self.core.process(self.frame);
            out.extend_from_slice(&o[..QUANTUM]);
            self.frame += QUANTUM as u64;
        }
        out
    }

    fn slot(&self) -> voices::VoiceSlot {
        voices::slots(&self.core)[(V1 & 0xFFFF) as usize]
    }
}

fn play(mixed: bool, looping: bool) -> Rec {
    let mut flags = if mixed { wire::PLAY_FLAGS_MIXED } else { 0 };
    if looping {
        flags |= wire::PLAY_FLAGS_LOOP;
    }
    Rec::Play(wire::Play { voice_id: V1, frame_offset: wire::ASAP, clip: CLIP, flags, gain: 1.0, pitch: 1.0, dir_z: -1.0, lp_hz: 24_000.0, ..Default::default() })
}

fn seek(voice: u32, frame: u32) -> Rec {
    Rec::Seek(wire::Seek { voice_id: voice, frame_offset: wire::ASAP, clip_frame: frame, epoch: 0 })
}

fn clip_at(k: usize) -> f32 {
    k as f32 / 100_000.0
}

fn ramp(a: f32, b: f32, n: usize, k: usize) -> f32 {
    if k + 1 >= n {
        b
    } else {
        a + (b - a) * (k + 1) as f32 / n as f32
    }
}

fn check(out: &[f32], want: impl Fn(usize) -> f32, what: &str) {
    for (k, &s) in out.iter().enumerate() {
        let w = want(k);
        assert!((s - w).abs() <= TOL, "{what}: frame {k}: {s}, expected {w}");
    }
}

#[test]
fn a_mixed_voice_fades_out_jumps_and_fades_back_in_from_the_target() {
    let mut m = Mixer::new();
    m.submit(&[play(true, false)]);
    check(&m.render(10), clip_at, "playing");
    m.submit(&[seek(V1, 50_000)]);
    let out = m.render(6);
    // 5 ms of the old audio fading out, then the new from the target fading in over 5 ms, then exact.
    check(&out[..FADE], |k| clip_at(1_280 + k) * ramp(1.0, 0.0, FADE, k), "fade-out");
    // The voice renders only to the end of the fade; the rest of that quantum is silent and the
    // jump lands at the start of the next (frame 256), where its frame k is `50_000 + k`.
    let at = 2 * QUANTUM;
    check(&out[FADE..at], |_| 0.0, "the rest of the quantum");
    check(&out[at..at + FADE], |k| clip_at(50_000 + k) * ramp(0.0, 1.0, FADE, k), "fade-in");
    check(&out[at + FADE..], |k| clip_at(50_000 + FADE + k), "after the fade-in");
    assert_eq!(m.slot().start_frame, 0, "the pending seek is cleared");
}

#[test]
fn a_virtual_voice_seeks_at_once_and_keeps_time_from_the_target() {
    let mut m = Mixer::new();
    m.submit(&[play(false, false)]);
    m.render(10);
    m.submit(&[seek(V1, 20_000)]);
    m.render(1);
    assert_eq!(m.slot().position, 20_000.0 + QUANTUM as f64);
}

#[test]
fn a_loop_wraps_the_target_and_a_one_shot_clamps_it_to_the_end() {
    let mut m = Mixer::new();
    m.submit(&[play(false, true)]);
    m.render(2);
    m.submit(&[seek(V1, FRAMES + 1_000)]);
    m.render(1);
    assert_eq!(m.slot().position, 1_000.0 + QUANTUM as f64, "wrapped");

    let mut m = Mixer::new();
    m.submit(&[play(false, false)]);
    m.render(2);
    m.submit(&[seek(V1, FRAMES + 1_000)]);
    m.render(1);
    assert_eq!(m.slot().state, state::FREE, "a seek past the end of a one-shot ends it");
}

#[test]
fn a_second_seek_before_the_jump_replaces_the_target_and_a_stale_id_is_dropped() {
    let mut m = Mixer::new();
    m.submit(&[play(true, false)]);
    m.render(4);
    m.submit(&[seek(V1, 10_000)]);
    m.render(1); // 128 of the 240 fade frames
    m.submit(&[seek(V1, 70_000), seek(0x0002_0001, 5)]);
    let out = m.render(5);
    // The fade-out went on unbroken (one ramp from the first seek), then the second target.
    check(&out[..FADE - QUANTUM], |k| clip_at(640 + k) * ramp(1.0, 0.0, FADE, QUANTUM + k), "one continuous fade-out");
    // The fade-out ended mid-quantum (frame 112 of this render); the second target lands on the next quantum.
    let at = QUANTUM;
    check(&out[FADE - QUANTUM..at], |_| 0.0, "the rest of the quantum");
    check(&out[at..at + FADE], |k| clip_at(70_000 + k) * ramp(0.0, 1.0, FADE, k), "fade-in at the second target");
}

#[test]
fn a_voice_not_started_yet_starts_at_the_target() {
    let mut m = Mixer::new();
    let mut p = play(true, false);
    if let Rec::Play(ref mut r) = p {
        r.frame_offset = 4 * QUANTUM as u32;
    }
    m.submit(&[p]);
    m.submit(&[seek(V1, 30_000)]);
    let out = m.render(8);
    check(&out[4 * QUANTUM..4 * QUANTUM + 8], |k| clip_at(30_000 + k), "starts at the target");
}
