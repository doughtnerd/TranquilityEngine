//! Paused voices in the core (ADR 0157 A3.7; api-and-models §4.2 SET_PAUSED; architecture §2.2:
//! "Paused: the playhead holds", "Paused --> Virtual: resume, then selection"): a mixed voice fades
//! out over 5 ms and then holds its position exactly, a resume (with main's promote in the same
//! batch) fades in from that same frame, a virtual voice holds at once, a resume during the fade
//! turns it round, a voice not started yet waits, RESET and a new PLAY clear the pause, a stop ends
//! a held voice, the cap's own demote leaves paused voices alone, and nothing allocates.
//!
//! Each case submits BATCH messages written with `audio-wire`'s generated writers through
//! `scheduler::submit` and renders with `Core::process`, as `mixed_virtual.rs` does (limiter
//! look-ahead 0, so output frames are core frames).

use std::alloc::{GlobalAlloc, System};
use std::cell::Cell;

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::voices::{self, state};
use audio_core::{bus, scheduler, status, Core, QUANTUM};
use audio_wire::generated as wire;

const RATE: f32 = 48_000.0;
/// 5 ms at 48 kHz: the pause fade (the promote and demote `mix` ramp).
const FADE: usize = 240;
const CLIP: u32 = 1;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const TOL: f32 = 1e-6;

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 16, max_mixed: 8, max_buses: 2, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose.
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh zeroed block of `layout.total()` bytes, page-aligned.
    let mut core = unsafe { Core::new(p, layout, base) };
    // Frame-by-frame checks in core time: no limiter look-ahead (A2.9).
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

enum Rec {
    Play(wire::Play),
    Mixed(wire::SetMixed),
    Paused(wire::SetPaused),
    Stop(wire::Stop),
    Reset(wire::Reset),
}

impl Rec {
    fn size(&self) -> usize {
        match self {
            Rec::Play(_) => wire::Play::FIXED_END,
            Rec::Mixed(_) => wire::SetMixed::FIXED_END,
            Rec::Paused(_) => wire::SetPaused::FIXED_END,
            Rec::Stop(_) => wire::Stop::FIXED_END,
            Rec::Reset(_) => wire::Reset::FIXED_END,
        }
    }

    fn write(&self, out: &mut [u8], at: usize) -> usize {
        match self {
            Rec::Play(r) => r.write(out, at),
            Rec::Mixed(r) => r.write(out, at),
            Rec::Paused(r) => r.write(out, at),
            Rec::Stop(r) => r.write(out, at),
            Rec::Reset(r) => r.write(out, at),
        }
        .unwrap()
    }
}

/// A BATCH of `recs` with `first_frame`.
fn batch(first_frame: u64, recs: &[Rec]) -> Vec<u8> {
    let body: usize = recs.iter().map(Rec::size).sum();
    let mut buf = vec![0u8; 32 + body];
    let mut at = 32;
    for r in recs {
        at += r.write(&mut buf, at);
    }
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: first_frame as f64, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
    buf
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
        let buf = batch(self.frame, recs);
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

    fn slot(&self, voice: u32) -> voices::VoiceSlot {
        voices::slots(&self.core)[(voice & 0xFFFF) as usize]
    }
}

fn play_at(voice: u32, mixed: bool, frame_offset: u32) -> Rec {
    Rec::Play(wire::Play {
        voice_id: voice,
        frame_offset,
        clip: CLIP,
        flags: if mixed { wire::PLAY_FLAGS_MIXED } else { 0 },
        gain: 1.0,
        pitch: 1.0,
        dir_z: -1.0,
        lp_hz: 24_000.0,
        ..Default::default()
    })
}

fn play(voice: u32, mixed: bool) -> Rec {
    play_at(voice, mixed, wire::ASAP)
}

fn set_mixed(voice: u32, mixed: bool) -> Rec {
    Rec::Mixed(wire::SetMixed { voice_id: voice, frame_offset: wire::ASAP, mixed: mixed as u32, gain: 1.0, dir_x: 0.0, dir_y: 0.0, dir_z: -1.0, lp_hz: 24_000.0 })
}

fn paused_at(voice: u32, paused: bool, frame_offset: u32) -> Rec {
    Rec::Paused(wire::SetPaused { voice_id: voice, frame_offset, paused: paused as u32 })
}

fn paused(voice: u32, p: bool) -> Rec {
    paused_at(voice, p, wire::ASAP)
}

fn stop(voice: u32, fade_frames: u32) -> Rec {
    Rec::Stop(wire::Stop { voice_id: voice, frame_offset: wire::ASAP, fade_frames, reason: 0 })
}

fn reset(keep_clips: bool) -> Rec {
    Rec::Reset(wire::Reset { voice_id: 0, frame_offset: wire::ASAP, keep_clips: keep_clips as u32 })
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

fn assert_frames(out: &[f32], want: impl Fn(usize) -> f32, what: &str) {
    for (k, &s) in out.iter().enumerate() {
        let w = want(k);
        assert!((s - w).abs() <= TOL, "{what}: frame {k}: {s}, expected {w}");
    }
}

#[test]
fn a_paused_voice_fades_out_holds_its_position_exactly_and_resumes_from_it_with_a_fade_in() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true)]);
    let out = m.render(10);
    assert_frames(&out, clip_at, "playing");

    // Pause (with main's SET_MIXED 0, sent by its selection in the same batch): 5 ms fade-out.
    m.submit(&[paused(V1, true), set_mixed(V1, false)]);
    let out = m.render(3);
    assert_frames(&out, |k| if k < FADE { clip_at(1_280 + k) * ramp_at(1.0, 0.0, FADE, k) } else { 0.0 }, "fade-out");
    let held = 1_280.0 + FADE as f64;
    assert_eq!(m.slot(V1).position, held, "holds at the frame the fade ended on");
    assert_eq!(status::counters(&m.core).mixed_voices, 0, "out of the mix");
    assert_eq!(status::counters(&m.core).live_voices, 1, "still live");

    let out = m.render(50);
    assert!(out.iter().all(|&s| s == 0.0), "silent while paused");
    assert_eq!(m.slot(V1).position, held, "not advancing while paused (unlike virtual)");

    // Resume, and main's selection promotes it in the same batch: a 5 ms fade-in from the held frame.
    m.submit(&[paused(V1, false), set_mixed(V1, true)]);
    let out = m.render(4);
    assert_frames(&out, |k| clip_at(held as usize + k) * ramp_at(0.0, 1.0, FADE, k), "fade-in");
    assert_eq!(status::counters(&m.core).mixed_voices, 1);
}

#[test]
fn the_fade_out_starts_at_a_stamped_frame() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true)]);
    m.render(10);
    // Frame 1_280 + 64: inside the next quantum.
    m.submit(&[paused_at(V1, true, 64)]);
    let out = m.render(3);
    assert_frames(&out, |k| if k < 64 { clip_at(1_280 + k) } else if k < 64 + FADE { clip_at(1_280 + k) * ramp_at(1.0, 0.0, FADE, k - 64) } else { 0.0 }, "stamped pause");
    assert_eq!(m.slot(V1).position, (1_280 + 64 + FADE) as f64);
    assert_eq!(status::counters(&m.core).late_commands, 0);
}

#[test]
fn a_paused_virtual_voice_holds_at_once() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, false)]);
    m.render(10);
    m.submit(&[paused(V1, true)]);
    m.render(20);
    assert_eq!(m.slot(V1).position, 1_280.0, "a virtual voice keeps time, but a paused one holds");
    // Resumed and left virtual (no room): keeps time from the held frame.
    m.submit(&[paused(V1, false)]);
    let out = m.render(2);
    assert!(out.iter().all(|&s| s == 0.0));
    assert_eq!(m.slot(V1).position, 1_280.0 + 256.0);
    m.submit(&[set_mixed(V1, true)]);
    let out = m.render(3);
    assert_frames(&out, |k| clip_at(1_536 + k) * ramp_at(0.0, 1.0, FADE, k), "promoted later");
}

#[test]
fn a_resume_during_the_fade_out_turns_it_round_without_a_jump() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true)]);
    m.render(10);
    m.submit(&[paused(V1, true)]);
    let out = m.render(1); // 128 of the 240 fade frames
    assert_frames(&out, |k| clip_at(1_280 + k) * ramp_at(1.0, 0.0, FADE, k), "fade-out");
    let mid = ramp_at(1.0, 0.0, FADE, 127);
    // Main didn't demote it (pause and resume in one frame): back to mixed from where the fade is.
    m.submit(&[paused(V1, false)]);
    let out = m.render(3);
    assert_frames(&out, |k| clip_at(1_408 + k) * ramp_at(mid, 1.0, FADE, k), "turned round");
    assert_eq!(status::counters(&m.core).mixed_voices, 1);
    assert_eq!(m.slot(V1).flags & (voices::flag::PAUSED | voices::flag::PAUSING), 0);

    // Pause and resume in the same batch: nothing heard changes.
    m.submit(&[paused(V1, true), paused(V1, false)]);
    let out = m.render(2);
    assert_frames(&out, |k| clip_at(1_792 + k), "pause and resume at once");
}

#[test]
fn a_resume_after_main_demoted_the_pausing_voice_completes_the_fade_and_keeps_time() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true)]);
    m.render(10);
    m.submit(&[paused(V1, true), set_mixed(V1, false)]);
    m.render(1);
    m.submit(&[paused(V1, false)]);
    let out = m.render(3);
    // The fade-out carries on (main thinks it virtual), then it is virtual, keeping time.
    assert_frames(&out, |k| if k < FADE - 128 { clip_at(1_408 + k) * ramp_at(1.0, 0.0, FADE, k + 128) } else { 0.0 }, "demoted");
    assert_eq!(status::counters(&m.core).mixed_voices, 0);
    assert_eq!(m.slot(V1).position, 1_280.0 + 4.0 * 128.0, "virtual, in time");
}

#[test]
fn a_voice_not_started_yet_waits_while_paused() {
    let mut m = Mixer::new();
    // Stamped to start at frame 256, paused in the same batch.
    m.submit(&[play_at(V1, true, 256), paused(V1, true)]);
    let out = m.render(10);
    assert!(out.iter().all(|&s| s == 0.0));
    assert_eq!(m.slot(V1).state, state::SCHEDULED, "doesn't start while paused");
    m.submit(&[paused(V1, false)]);
    let out = m.render(2);
    assert_frames(&out, clip_at, "starts at once from its start, at its gain");
    assert_eq!(status::counters(&m.core).late_commands, 0, "a resumed voice isn't late");

    // An asap PLAY paused at once.
    m.submit(&[play(V2, true), paused(V2, true)]);
    m.render(4);
    assert_eq!(m.slot(V2).state, state::SCHEDULED);
    assert_eq!(m.slot(V2).position, 0.0);
}

#[test]
fn reset_and_a_new_play_clear_the_pause() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true)]);
    m.render(2);
    m.submit(&[paused(V1, true)]);
    m.render(4);
    m.submit(&[reset(true), play(V1, true)]);
    let out = m.render(2);
    assert_frames(&out, clip_at, "after RESET");
    assert_eq!(m.slot(V1).flags & voices::flag::PAUSED, 0);

    // A new generation in the paused voice's slot (main's steal) isn't paused.
    m.submit(&[paused(V1, true)]);
    m.render(4);
    m.submit(&[play(0x0002_0001, true)]);
    assert_eq!(status::counters(&m.core).ended.as_slice().last(), Some(&V1), "the paused voice is replaced");
    let out = m.render(2);
    assert_frames(&out, clip_at, "the new voice");
}

#[test]
fn a_stop_ends_a_held_voice() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true), play(V2, false)]);
    m.render(2);
    m.submit(&[paused(V1, true), paused(V2, true)]);
    m.render(4);
    m.submit(&[stop(V1, 480), stop(V2, 0)]);
    m.render(1);
    assert_eq!(voices::live_count(&mut m.core), 0, "a held voice is silent: a fading stop ends it now");
    let ended = status::counters(&m.core).ended.as_slice().to_vec();
    assert!(ended.contains(&V1) && ended.contains(&V2));
}

#[test]
fn the_cores_demote_and_counts_leave_paused_voices_alone() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true), play(V2, true)]);
    m.render(2);
    m.submit(&[paused(V1, true)]);
    assert_eq!(voices::mixed_live(&mut m.core), 1, "a pausing voice doesn't count against the cap");
    assert!(!voices::demote(&mut m.core, V1), "already leaving the mix");
    assert_eq!(voices::demote_lowest(&mut m.core, 1), 0);
    assert!(status::counters(&m.core).demoted.is_empty());
    m.render(4);
    // A promote while paused is dropped (main never sends one).
    m.submit(&[set_mixed(V1, true)]);
    let out = m.render(1);
    assert_frames(&out, |k| clip_at(256 + 512 + k), "only V2");
}

// The allocation counter (as in `golden_native.rs`).
thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

fn allocations() -> u64 {
    ALLOCATIONS.with(Cell::get)
}

struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

#[test]
fn pause_and_resume_never_allocate() {
    let mut m = Mixer::new();
    m.submit(&[play(V1, true), play(V2, false), play_at(0x0001_0003, true, 50_000)]);
    m.render(2);
    // Every message written up front (each batch's firstFrame is the quantum it arrives before); one
    // stamped pause lands mid-quantum.
    let msgs = [
        batch(256, &[paused(V1, true), paused(V2, true), paused(0x0001_0003, true)]),
        batch(512, &[paused(V1, false), set_mixed(V1, true), paused(V2, false)]),
        batch(768, &[paused_at(V1, true, 40), paused(V1, false)]),
        batch(1_024, &[paused(V1, true), paused(V1, false), paused(0x0001_0003, false)]),
    ];
    let before = allocations();
    for msg in &msgs {
        assert_eq!(scheduler::submit(&mut m.core, msg), 0);
        for _ in 0..2 {
            m.core.process(m.frame);
            m.frame += QUANTUM as u64;
        }
    }
    assert_eq!(allocations(), before, "submit and process allocated");
}
