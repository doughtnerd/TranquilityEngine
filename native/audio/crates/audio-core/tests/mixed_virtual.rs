//! Mixed and virtual voices in the core (ADR 0157 A3.1; architecture §2.2, §4.7; api-and-models
//! §4.2 SET_MIXED): the 5 ms promote and demote fades, time kept while virtual (a promoted voice
//! resumes at the frame it would have reached), a fade turned round mid-way, a voice not started
//! yet changing with no fade, and the core's own demote (A3.3's path) reported in STATUS `demoted`.
//!
//! Each case submits BATCH messages written with `audio-wire`'s generated writers through
//! `scheduler::submit` and renders with `Core::process`, as `golden_native.rs` does.

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bus, scheduler, status, voices, Core, QUANTUM};
use audio_wire::generated as wire;

const RATE: f32 = 48_000.0;
/// 5 ms at 48 kHz.
const FADE: usize = 240;
const CLIP: u32 = 1;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const V3: u32 = 0x0001_0003;
const TOL: f32 = 1e-6;

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 16, max_mixed: 8, max_buses: 2, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose.
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh zeroed block of `layout.total()` bytes, page-aligned.
    let mut core = unsafe { Core::new(p, layout, base) };
    // These tests check SET_MIXED's fades frame by frame in core time; the limiter's look-ahead (A2.9, 1.5 ms by
    // default) would delay every output frame, so they run at 0 ms (no output latency).
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

enum Rec {
    Play(wire::Play),
    Mixed(wire::SetMixed),
}

struct Mixer {
    core: Core,
    frame: u64,
}

impl Mixer {
    /// A core with a mono clip whose sample `k` is `k / 100_000` (so the output says which frame is
    /// playing), 96,000 frames long.
    fn new() -> Mixer {
        let mut core = new_core();
        let frames = 96_000u32;
        core.clips_mut().reserve(CLIP, frames, 1, RATE, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = (0..frames).flat_map(|k| (k as f32 / 100_000.0).to_le_bytes()).collect();
        core.clips_mut().write(CLIP, 0, &bytes).unwrap();
        Mixer { core, frame: 0 }
    }

    fn submit(&mut self, recs: &[Rec]) {
        let size = |r: &Rec| match r {
            Rec::Play(_) => wire::Play::FIXED_END,
            Rec::Mixed(_) => wire::SetMixed::FIXED_END,
        };
        let body: usize = recs.iter().map(size).sum();
        let mut buf = vec![0u8; 32 + body];
        let mut at = 32;
        for r in recs {
            let n = match r {
                Rec::Play(p) => p.write(&mut buf, at),
                Rec::Mixed(m) => m.write(&mut buf, at),
            }
            .unwrap();
            at += n;
        }
        wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        wire::BatchHeader { first_frame: self.frame as f64, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), 0);
    }

    /// Renders `n` quanta; returns the left channel.
    fn render(&mut self, n: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for _ in 0..n {
            let o = self.core.process(self.frame);
            out.extend_from_slice(&o[..QUANTUM]);
            self.frame += QUANTUM as u64;
        }
        out
    }
}

fn play(voice: u32, mixed: bool) -> Rec {
    Rec::Play(wire::Play {
        voice_id: voice,
        frame_offset: wire::ASAP,
        clip: CLIP,
        flags: if mixed { wire::PLAY_FLAGS_MIXED } else { 0 },
        gain: 1.0,
        pitch: 1.0,
        dir_z: -1.0,
        lp_hz: 24_000.0,
        ..Default::default()
    })
}

fn set_mixed(voice: u32, mixed: bool, gain: f32) -> Rec {
    Rec::Mixed(wire::SetMixed { voice_id: voice, frame_offset: wire::ASAP, mixed: mixed as u32, gain, dir_x: 0.0, dir_y: 0.0, dir_z: -1.0, lp_hz: 24_000.0 })
}

/// The clip's sample at frame `k`.
fn clip_at(k: usize) -> f32 {
    k as f32 / 100_000.0
}

/// The spec ramp's value at frame `k` of an `n`-frame ramp from `a` to `b`.
fn ramp_at(a: f32, b: f32, n: usize, k: usize) -> f32 {
    if k + 1 >= n {
        b
    } else {
        a + (b - a) * (k + 1) as f32 / n as f32
    }
}

#[test]
fn a_virtual_voice_keeps_time_and_a_promote_fades_in_at_the_right_frame() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, false)]);
    let silent = m.render(10);
    assert!(silent.iter().all(|&s| s == 0.0), "a virtual voice renders nothing");
    assert_eq!(status::counters(&m.core).mixed_voices, 0);
    assert_eq!(status::counters(&m.core).live_voices, 1);
    m.submit(&[set_mixed(V1, true, 1.0)]);
    let out = m.render(3);
    // It started at frame 0, so after 10 quanta it plays clip frame 1280 + k, faded in over 5 ms.
    for (k, &s) in out.iter().enumerate() {
        let want = clip_at(10 * QUANTUM + k) * ramp_at(0.0, 1.0, FADE, k);
        assert!((s - want).abs() <= TOL, "frame {k}: {s}, expected {want}");
    }
    assert_eq!(status::counters(&m.core).mixed_voices, 1);
}

#[test]
fn a_demote_fades_out_over_5_ms_then_keeps_time_silently() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true)]);
    m.render(2);
    m.submit(&[set_mixed(V1, false, 1.0)]);
    let out = m.render(4);
    for (k, &s) in out.iter().enumerate() {
        let want = if k < FADE { clip_at(2 * QUANTUM + k) * ramp_at(1.0, 0.0, FADE, k) } else { 0.0 };
        assert!((s - want).abs() <= TOL, "frame {k}: {s}, expected {want}");
    }
    assert_eq!(status::counters(&m.core).mixed_voices, 0, "virtual once the fade settled");
    assert!(status::counters(&m.core).demoted.is_empty(), "main asked for it: not reported");
    // Promoted again: it resumes where it would be, 6 quanta in.
    m.submit(&[set_mixed(V1, true, 0.5)]);
    let out = m.render(3);
    for (k, &s) in out.iter().enumerate() {
        let want = clip_at(6 * QUANTUM + k) * 0.5 * ramp_at(0.0, 1.0, FADE, k);
        assert!((s - want).abs() <= TOL, "promoted frame {k}: {s}, expected {want}");
    }
}

#[test]
fn a_promote_during_a_demote_turns_round_without_a_jump() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true)]);
    m.render(1);
    m.submit(&[set_mixed(V1, false, 1.0)]);
    let out1 = m.render(1); // 128 of the 240 fade frames
    m.submit(&[set_mixed(V1, true, 1.0)]);
    let out2 = m.render(3);
    let last = out1[QUANTUM - 1] / clip_at(2 * QUANTUM - 1);
    let first = out2[0] / clip_at(2 * QUANTUM);
    assert!((last - ramp_at(1.0, 0.0, FADE, QUANTUM - 1)).abs() < 1e-4);
    assert!(first > last && first - last < 0.01, "the mix turns round from {last} (got {first})");
    let end = out2[3 * QUANTUM - 1] / clip_at(5 * QUANTUM - 1);
    assert!((end - 1.0).abs() < 1e-5, "back at full level ({end})");
    assert_eq!(status::counters(&m.core).mixed_voices, 1);
}

#[test]
fn a_voice_not_started_changes_with_no_fade() {
    let mut m = Mixer::new();
    // PLAY virtual and SET_MIXED 1 in one batch (main's selection promoted a fresh voice): a clean onset.
    m.submit(&[play(V1, false), set_mixed(V1, true, 1.0)]);
    let out = m.render(1);
    for (k, &s) in out.iter().enumerate() {
        assert!((s - clip_at(k)).abs() <= TOL, "frame {k}: {s}");
    }
    // PLAY mixed and SET_MIXED 0 in one batch: never heard.
    m.submit(&[play(V2, true), set_mixed(V2, false, 1.0)]);
    let before = m.render(1);
    for (k, &s) in before.iter().enumerate() {
        assert!((s - clip_at(QUANTUM + k)).abs() <= TOL, "only V1 sounds: frame {k}");
    }
}

#[test]
fn stale_set_mixed_is_dropped() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, false), set_mixed(0x0002_0001, true, 1.0)]);
    assert!(m.render(2).iter().all(|&s| s == 0.0));
}

#[test]
fn the_cores_demote_reports_and_takes_the_lowest_scores_first() {
    let mut m = Mixer::new();
    let mut p1 = play(V1, true);
    let mut p2 = play(V2, true);
    let mut p3 = play(V3, true);
    for (rec, score) in [(&mut p1, 3.0), (&mut p2, 1.0), (&mut p3, 2.0)] {
        if let Rec::Play(p) = rec {
            p.score = score;
        }
    }
    m.submit(&[p1, p2, p3]);
    m.render(1);
    assert_eq!(voices::mixed_live(&mut m.core), 3);
    assert_eq!(voices::demote_lowest(&mut m.core, 1), 2);
    assert_eq!(status::counters(&m.core).demoted.as_slice(), &[V2, V3], "lowest score first");
    assert_eq!(voices::mixed_live(&mut m.core), 1);
    assert!(!voices::demote(&mut m.core, V2), "already fading out");
    assert!(!voices::demote(&mut m.core, 0x0005_0001), "stale");
    m.render(3);
    assert_eq!(status::counters(&m.core).mixed_voices, 1, "two went virtual after their fade");
    assert_eq!(status::counters(&m.core).live_voices, 3, "and keep time");
}

#[test]
fn the_fade_is_5_ms_at_the_core_rate() {
    let m = Mixer::new();
    assert_eq!(voices::mix_fade_frames(&m.core), FADE as u32);
}
