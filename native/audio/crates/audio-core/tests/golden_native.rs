//! Native goldens for the core's voices (ADR 0157, api-and-models sec. 8; task A1.2, leaf A1.2-L4).
//!
//! Each scenario builds a `Core` over a zeroed, page-aligned block, puts a generated clip in its
//! `ClipStore`, submits BATCH messages written with `audio-wire`'s generated writers through
//! `audio_core::scheduler::submit` (the path `myco_audio_submit` takes), renders quanta with
//! `Core::process`, and checks the samples against values computed here from the spec. A2.7 later
//! adds the Vitest wasm layer; these stay (plan, F7).
//!
//! The expectations are in core time (the frame a voice renders at); `Mixer::expect` checks them
//! against the output the master limiter's fixed latency later (A2.9; `common::Heard`).

mod common;

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bus, scheduler, status, Core, QUANTUM};
use common::{Heard, L, R};
use audio_wire::generated as wire;
use std::alloc::{GlobalAlloc, System};
use std::cell::Cell;

/// Sample tolerance (the spec's 1e-6).
const TOL: f32 = 1e-6;
/// Tolerance for the panner's gains (equal-power trigonometry, ramped matrix).
const PAN_TOL: f32 = 1e-5;

/// The envelope's sequence number; the scenarios send one BATCH each time, so any value serves.
const SEQ: u32 = 1;
const CLIP_A: u32 = 1;
const CLIP_B: u32 = 2;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const MIXED: u16 = wire::PLAY_FLAGS_MIXED;
const LOOP: u16 = wire::PLAY_FLAGS_LOOP;
const SPATIAL: u16 = wire::PLAY_FLAGS_SPATIAL;
const FRONT: [f32; 3] = [0.0, 0.0, -1.0];

fn params() -> InitParams {
    InitParams { sample_rate: 48_000.0, max_logical: 64, max_mixed: 16, max_buses: 4, arena_initial_bytes: 0, ..InitParams::default() }
}

/// A core over a leaked, zeroed, page-aligned block, as `myco_audio_init` would get from the heap.
fn new_core() -> Core {
    let p = params();
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: `base` is a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// One record of a BATCH, written by `audio-wire`'s generated writers.
enum Rec {
    Play(wire::Play),
    Stop(wire::Stop),
    Set(wire::SetParams),
    Fade(wire::Fade),
}

impl Rec {
    fn size(&self) -> usize {
        match self {
            Rec::Play(_) => wire::Play::FIXED_END,
            Rec::Stop(_) => wire::Stop::FIXED_END,
            Rec::Set(_) => wire::SetParams::FIXED_END,
            Rec::Fade(_) => wire::Fade::FIXED_END,
        }
    }

    fn write(&self, out: &mut [u8], at: usize) {
        let n = match self {
            Rec::Play(r) => r.write(out, at),
            Rec::Stop(r) => r.write(out, at),
            Rec::Set(r) => r.write(out, at),
            Rec::Fade(r) => r.write(out, at),
        }
        .unwrap();
        assert_eq!(n, self.size());
    }
}

/// A PLAY: mixed or not as `flags` says, gain 1, pitch 1, facing forward, asap. Tests set what
/// they need.
fn play(voice: u32, clip: u32, flags: u16) -> wire::Play {
    wire::Play {
        voice_id: voice,
        frame_offset: wire::ASAP,
        clip,
        bus: 0,
        flags,
        group: 0,
        reserved: 0,
        gain: 1.0,
        pitch: 1.0,
        dir_x: FRONT[0],
        dir_y: FRONT[1],
        dir_z: FRONT[2],
        lp_hz: 24_000.0,
        score: 0.0,
        start_offset_frames: 0,
    }
}

/// A STOP, asap, with no fade.
fn stop(voice: u32) -> wire::Stop {
    wire::Stop { voice_id: voice, frame_offset: wire::ASAP, fade_frames: 0, reason: 0 }
}

/// A SET_PARAMS asap that changes only what `mask` names, over `ramp_frames`.
fn set_params(voice: u32, mask: u32, ramp_frames: u32) -> wire::SetParams {
    wire::SetParams {
        voice_id: voice,
        frame_offset: wire::ASAP,
        mask,
        gain: 0.0,
        pitch: 0.0,
        dir_x: 0.0,
        dir_y: 0.0,
        dir_z: 0.0,
        lp_hz: 0.0,
        score: 0.0,
        bus: 0,
        ramp_frames,
        flags: 0,
    }
}

/// A FADE asap.
fn fade(voice: u32, target: f32, frames: u32, flags: u32) -> wire::Fade {
    wire::Fade { voice_id: voice, frame_offset: wire::ASAP, target, frames, flags }
}

/// A core that renders quanta in order, from context frame 0.
struct Mixer {
    core: Core,
    frame: u64,
    /// The output as heard and the expectations in core time.
    heard: Heard,
    /// The first frame of the last `render` or `render_n`.
    span: usize,
}

impl Mixer {
    fn new() -> Mixer {
        let core = new_core();
        let latency = bus::output_latency_frames(&core) as usize;
        Mixer { core, frame: 0, heard: Heard::new(latency), span: 0 }
    }

    /// Expects channel `ch` of the last `render`/`render_n` to be `want(k)` at frame `k` of the
    /// span, in core time, and checks the heard output (`Heard::expect`).
    fn expect(&mut self, ch: usize, tol: f32, what: &str, want: impl Fn(usize) -> f32) {
        self.expect_from(self.span, ch, tol, what, want);
    }

    /// As `expect`, from frame `start` to the end of what was rendered.
    fn expect_from(&mut self, start: usize, ch: usize, tol: f32, what: &str, want: impl Fn(usize) -> f32) {
        let len = self.heard.len() - start;
        self.heard.expect(ch, start, len, tol, what, want);
    }

    /// Reserves a mono f32 clip and writes its samples.
    fn load_clip(&mut self, id: u32, rate: f32, samples: &[f32]) {
        self.core.clips_mut().reserve(id, samples.len() as u32, 1, rate, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.core.clips_mut().write(id, 0, &bytes).unwrap();
    }

    /// Submits one BATCH of `recs` with the header's `first_frame`, and asserts it was accepted.
    fn submit(&mut self, first_frame: f64, recs: &[Rec]) {
        let body: usize = recs.iter().map(Rec::size).sum();
        // 16 B envelope + 16 B batch header + the records.
        let mut buf = vec![0u8; 32 + body];
        let mut at = 32;
        for rec in recs {
            rec.write(&mut buf, at);
            at += rec.size();
        }
        wire::Envelope::new(wire::kind::BATCH, SEQ, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        wire::BatchHeader { first_frame, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), 0);
    }

    /// Renders the next quantum; returns its left and right channels.
    fn render(&mut self) -> (Vec<f32>, Vec<f32>) {
        self.span = self.heard.len();
        self.quantum()
    }

    fn quantum(&mut self) -> (Vec<f32>, Vec<f32>) {
        let out = self.core.process(self.frame);
        let pair = (out[..QUANTUM].to_vec(), out[QUANTUM..2 * QUANTUM].to_vec());
        self.heard.push(&pair.0, &pair.1);
        self.frame += QUANTUM as u64;
        pair
    }

    /// Renders `n` quanta; returns their left and right channels, concatenated.
    fn render_n(&mut self, n: usize) -> (Vec<f32>, Vec<f32>) {
        self.span = self.heard.len();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        for _ in 0..n {
            let (l, r) = self.quantum();
            left.extend(l);
            right.extend(r);
        }
        (left, right)
    }

    /// Whether `voice` is in the STATUS `ended` list (the list accumulates; nothing clears it here).
    fn is_ended(&self, voice: u32) -> bool {
        status::counters(&self.core).ended.as_slice().contains(&voice)
    }
}

fn assert_near(actual: f32, want: f32, tol: f32, what: &str) {
    assert!((actual - want).abs() <= tol, "{what}: got {actual}, expected {want}");
}

/// The spec's linear ramp: from `start` towards `target` over `n` frames, frame k of the ramp
/// being `start + (target - start) * (k + 1) / n`, and `target` once the ramp is over.
fn ramp_to(start: f32, target: f32, n: usize, k: usize) -> f32 {
    if k < n {
        start + (target - start) * (k + 1) as f32 / n as f32
    } else {
        target
    }
}

/// The clip x[i] = (i + 1) / 512: exact binary values, all distinct.
fn ramp(n: usize) -> Vec<f32> {
    (0..n).map(|i| (i + 1) as f32 / 512.0).collect()
}

/// The half-speed sample of the voices' 4-point resampler (`resample::lagrange`, A3.6): even
/// frames are x[k/2]; odd frames the midpoint (-x[m-1] + 9 x[m] + 9 x[m+1] - x[m+2]) / 16, where a
/// frame before the clip's start holds the first one and a frame past its end holds the last one.
/// (On a ramp that is the mean of x[m] and x[m+1] away from the edges, as linear gives.)
fn half_speed(x: &[f32], k: usize) -> f32 {
    if k % 2 == 0 {
        x[k / 2]
    } else {
        let m = (k - 1) / 2;
        let at = |j: isize| x[j.clamp(0, x.len() as isize - 1) as usize];
        let m = m as isize;
        (-at(m - 1) + 9.0 * at(m) + 9.0 * at(m + 1) - at(m + 2)) / 16.0
    }
}

/// A 200-frame ramp played for four quanta at `pitch` from a clip at `rate`: the half-speed shape
/// (400 frames sound, then silence), ended only after the fourth quantum.
fn check_half_speed(rate: f32, pitch: f32) {
    let x = ramp(200);
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, rate, &x);
    let mut p = play(V1, CLIP_A, MIXED);
    p.pitch = pitch;
    m.submit(0.0, &[Rec::Play(p)]);
    for q in 0..4 {
        let (l, r) = m.render();
        assert_eq!(l, r);
        assert_eq!(m.is_ended(V1), q == 3, "ended after quantum {q}");
    }
    m.expect_from(0, L, TOL, "half speed", |k| if k < 400 { half_speed(&x, k) } else { 0.0 });
}

/// The left and right gains of a spatial DC-1.0 voice at `dir`, after one quantum. Every frame of
/// that quantum must carry the same pair.
fn spatial_gains(dir: [f32; 3]) -> (f32, f32) {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    let mut p = play(V1, CLIP_A, MIXED | SPATIAL | LOOP);
    p.dir_x = dir[0];
    p.dir_y = dir[1];
    p.dir_z = dir[2];
    m.submit(0.0, &[Rec::Play(p)]);
    let (l, r) = m.render();
    // The first frame heard after the limiter's latency (silence before it).
    let d = m.heard.latency;
    let (gl, gr) = (l[d], r[d]);
    m.expect(L, PAN_TOL, "left gain across the quantum", |_| gl);
    m.expect(R, PAN_TOL, "right gain across the quantum", |_| gr);
    (gl, gr)
}

// The allocation counter: every allocation on this thread goes through `CountingAlloc`, so the
// count moves only when something allocates. The thread-local is `const` and has no destructor,
// so reading or bumping it never allocates itself.
thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

fn allocations() -> u64 {
    ALLOCATIONS.with(Cell::get)
}

fn bump_allocations() {
    ALLOCATIONS.with(|c| c.set(c.get() + 1));
}

struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        bump_allocations();
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        bump_allocations();
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, new_size: usize) -> *mut u8 {
        bump_allocations();
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

#[test]
fn one_shot_plays_its_clip_once_then_ends() {
    let x = ramp(300);
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &x);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED))]);
    for q in 0..3 {
        let (l, r) = m.render();
        assert_eq!(l, r, "a non-spatial voice sounds equally on both channels");
        assert_eq!(m.is_ended(V1), q == 2, "ended after quantum {q}");
    }
    m.expect_from(0, L, TOL, "one shot", |g| if g < 300 { x[g] } else { 0.0 });
}

#[test]
fn gain_scales_the_clip() {
    let x = ramp(300);
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &x);
    let mut p = play(V1, CLIP_A, MIXED);
    p.gain = 0.5;
    m.submit(0.0, &[Rec::Play(p)]);
    let (l, r) = m.render_n(3);
    assert_eq!(l, r);
    m.expect(L, TOL, "half level", |g| if g < 300 { 0.5 * x[g] } else { 0.0 });
}

#[test]
fn a_virtual_voice_is_silent_but_ends_on_time() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &ramp(300));
    // No PLAY_FLAGS_MIXED: the voice is virtual.
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, 0))]);
    for q in 0..3 {
        m.render();
        m.expect(L, TOL, "virtual left", |_| 0.0);
        m.expect(R, TOL, "virtual right", |_| 0.0);
        assert_eq!(m.is_ended(V1), q == 2, "ended after quantum {q}");
    }
}

#[test]
fn pitch_two_plays_every_other_frame() {
    let x = ramp(200);
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &x);
    let mut p = play(V1, CLIP_A, MIXED);
    p.pitch = 2.0;
    m.submit(0.0, &[Rec::Play(p)]);
    let (l, r) = m.render();
    assert_eq!(l, r);
    m.expect(L, TOL, "double speed", |k| if k < 100 { x[2 * k] } else { 0.0 });
    assert!(m.is_ended(V1), "the 200-frame clip is spent after one quantum");
}

#[test]
fn pitch_half_interpolates_between_frames() {
    check_half_speed(48_000.0, 0.5);
}

#[test]
fn a_clip_at_half_the_context_rate_plays_at_half_speed() {
    check_half_speed(24_000.0, 1.0);
}

#[test]
fn a_loop_wraps_seamlessly_and_never_ends() {
    let x = ramp(100);
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &x);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED | LOOP))]);
    let (l, r) = m.render_n(3);
    assert_eq!(l, r);
    m.expect(L, TOL, "loop", |g| x[g % 100]);
    assert!(!m.is_ended(V1), "a loop never ends");
}

#[test]
fn stop_ends_a_loop_at_the_next_quantum() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED | LOOP))]);
    m.render();
    m.expect(L, TOL, "playing", |_| 1.0);
    m.submit(0.0, &[Rec::Stop(stop(V1))]);
    m.render();
    m.expect(L, TOL, "silent after the stop", |_| 0.0);
    m.expect(R, TOL, "silent after the stop, right", |_| 0.0);
    assert!(m.is_ended(V1));
}

#[test]
fn stop_with_a_fade_ramps_to_silence_then_ends() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED | LOOP))]);
    m.render();
    m.expect(L, TOL, "playing", |_| 1.0);
    let mut s = stop(V1);
    s.fade_frames = 64;
    m.submit(0.0, &[Rec::Stop(s)]);
    m.render();
    m.expect(L, TOL, "fade out", |k| ramp_to(1.0, 0.0, 64, k));
    assert!(m.is_ended(V1));
}

#[test]
fn fade_with_stop_at_end_ends_the_voice() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED | LOOP))]);
    m.render();
    m.expect(L, TOL, "playing", |_| 1.0);
    m.submit(0.0, &[Rec::Fade(fade(V1, 0.0, 32, wire::FADE_FLAGS_STOP_AT_END))]);
    m.render();
    m.expect(L, TOL, "fade to zero, then stop", |k| ramp_to(1.0, 0.0, 32, k));
    assert!(m.is_ended(V1));

    // Without the flag, the fade holds its target and the loop plays on.
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED | LOOP))]);
    m.render();
    m.submit(0.0, &[Rec::Fade(fade(V1, 0.5, 32, 0))]);
    m.render();
    m.expect(L, TOL, "fade to a half, held", |k| ramp_to(1.0, 0.5, 32, k));
    assert!(!m.is_ended(V1));
    m.render();
    m.expect(L, TOL, "held at a half", |_| 0.5);
    assert!(!m.is_ended(V1));
}

#[test]
fn set_params_gain_ramps_over_ramp_frames() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED | LOOP))]);
    m.render();
    m.expect(L, TOL, "playing", |_| 1.0);
    let mut s = set_params(V1, wire::SET_PARAMS_MASK_GAIN, 64);
    s.gain = 0.5;
    m.submit(0.0, &[Rec::Set(s)]);
    m.render();
    m.expect(L, TOL, "gain ramp", |k| ramp_to(1.0, 0.5, 64, k));
}

#[test]
fn a_stamped_play_starts_at_its_sample_offset() {
    let x = ramp(300);
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &x);
    m.render();
    m.expect(L, TOL, "silence before the play", |_| 0.0);
    // Absolute frame 200 + 10 = 210, inside the quantum at 128.
    let mut p = play(V1, CLIP_A, MIXED);
    p.frame_offset = 10;
    m.submit(200.0, &[Rec::Play(p)]);
    let (l, r) = m.render_n(2);
    assert_eq!(l, r);
    m.expect(L, TOL, "stamped start", |i| {
        let g = 128 + i;
        if g < 210 {
            0.0
        } else {
            x.get(g - 210).copied().unwrap_or(0.0)
        }
    });
    assert_eq!(status::counters(&m.core).late_commands, 0);
}

#[test]
fn a_late_stamped_play_starts_at_once_and_counts_late() {
    let x = ramp(300);
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &x);
    m.render_n(2);
    m.expect(L, TOL, "silence before the play", |_| 0.0);
    // Absolute frame 5, but the quantum at 256 has already begun: it starts at once, from x[0].
    let mut p = play(V1, CLIP_A, MIXED);
    p.frame_offset = 5;
    m.submit(0.0, &[Rec::Play(p)]);
    let (l, r) = m.render();
    assert_eq!(l, r);
    m.expect(L, TOL, "late start from the clip's beginning", |k| x[k]);
    let c = status::counters(&m.core);
    assert_eq!(c.late_commands, 1);
    assert_eq!(c.max_lateness_frames, 251);
}

#[test]
fn a_stamped_stop_cuts_at_its_sample_offset() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.submit(0.0, &[Rec::Play(play(V1, CLIP_A, MIXED | LOOP))]);
    m.render_n(2);
    m.expect(L, TOL, "playing", |_| 1.0);
    assert!(!m.is_ended(V1));
    // Absolute frame 300: the third quantum (256..383) is cut 44 frames in.
    let mut s = stop(V1);
    s.frame_offset = 0;
    m.submit(300.0, &[Rec::Stop(s)]);
    m.render();
    m.expect(L, TOL, "cut at frame 300", |k| if k < 44 { 1.0 } else { 0.0 });
    assert!(m.is_ended(V1));
}

#[test]
fn a_spatial_source_pans_with_blinks_equal_power_gains() {
    // Blink's EqualPowerPanner: azimuth = atan2(dirX, -dirZ), mono p = (az + 90) / 180,
    // L = cos(pi/2 p), R = sin(pi/2 p).
    let (l, r) = spatial_gains([0.0, 0.0, -1.0]);
    assert_near(l, 0.70710677, PAN_TOL, "straight ahead, left");
    assert_near(r, 0.70710677, PAN_TOL, "straight ahead, right");

    let (l, r) = spatial_gains([0.5, 0.0, -0.8660254]);
    assert_near(l, 0.5, PAN_TOL, "30 degrees right, left");
    assert_near(r, 0.8660254, PAN_TOL, "30 degrees right, right");

    let (l, r) = spatial_gains([-1.0, 0.0, 0.0]);
    assert_near(l, 1.0, PAN_TOL, "hard left, left");
    assert_near(r, 0.0, PAN_TOL, "hard left, right");
}

#[test]
fn a_moving_source_ramps_from_left_to_right() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    let mut p = play(V1, CLIP_A, MIXED | SPATIAL | LOOP);
    p.dir_x = -1.0;
    p.dir_z = 0.0;
    m.submit(0.0, &[Rec::Play(p)]);
    m.render();
    m.expect(L, PAN_TOL, "hard left at the start", |_| 1.0);
    m.expect(R, PAN_TOL, "silent right at the start", |_| 0.0);

    let mut s = set_params(V1, wire::SET_PARAMS_MASK_DIR, 128);
    s.dir_x = 1.0;
    s.dir_y = 0.0;
    s.dir_z = 0.0;
    m.submit(0.0, &[Rec::Set(s)]);
    let (l, r) = m.render();
    m.expect(L, PAN_TOL, "left ramps down", |k| 1.0 - (k + 1) as f32 / 128.0);
    m.expect(R, PAN_TOL, "right ramps up", |k| (k + 1) as f32 / 128.0);
    assert!(l.windows(2).all(|w| w[1] <= w[0] + TOL), "left is non-increasing");
    assert!(r.windows(2).all(|w| w[1] + TOL >= w[0]), "right is non-decreasing");

    // The end of the ramp is heard in the next quantum, the limiter's latency later.
    let (l, r) = m.render();
    let d = m.heard.latency;
    assert!(l[d - 1].abs() < 1e-6, "left is silent at the end of the ramp");
    assert_near(r[d - 1], 1.0, PAN_TOL, "right at the end of the ramp");
    m.expect(L, 1e-6, "left stays silent after the ramp", |_| 0.0);
    m.expect(R, PAN_TOL, "hard right after the ramp", |_| 1.0);
}

#[test]
fn a_new_generation_replaces_the_voice_in_its_slot() {
    let old = 0x0001_0003;
    let new = 0x0002_0003;
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.load_clip(CLIP_B, 48_000.0, &[0.25f32; 100]);
    m.submit(0.0, &[Rec::Play(play(old, CLIP_A, MIXED | LOOP))]);
    m.render();
    m.expect(L, TOL, "the first generation", |_| 1.0);

    // Same index 3, new generation: the old voice is replaced, not added to.
    m.submit(0.0, &[Rec::Play(play(new, CLIP_B, MIXED | LOOP))]);
    m.render();
    m.expect(L, TOL, "the replacement alone, left", |_| 0.25);
    m.expect(R, TOL, "the replacement alone, right", |_| 0.25);
    assert!(m.is_ended(old), "the old generation ends");
    assert!(!m.is_ended(new));

    // A stop for the stale generation leaves the replacement playing.
    m.submit(0.0, &[Rec::Stop(stop(old))]);
    m.render();
    m.expect(L, TOL, "after a stop for the old generation", |_| 0.25);
    assert!(!m.is_ended(new), "the replacement is still playing");
}

#[test]
fn process_never_allocates() {
    let mut m = Mixer::new();
    m.load_clip(CLIP_A, 48_000.0, &[1.0f32; 100]);
    m.load_clip(CLIP_B, 48_000.0, &ramp(300));
    // Everything that allocates happens here, before the count is read.
    let mut spatial = play(V2, CLIP_A, MIXED | SPATIAL | LOOP);
    spatial.dir_x = 0.5;
    spatial.dir_z = -0.8660254;
    let mut stamped = play(0x0001_0003, CLIP_B, MIXED);
    stamped.frame_offset = 37;
    let mut mid_gain = set_params(V1, wire::SET_PARAMS_MASK_GAIN, 64);
    mid_gain.gain = 0.5;
    // Absolute frame 300: inside the quantum at 256, so it applies mid-quantum.
    mid_gain.frame_offset = 300;
    m.submit(
        0.0,
        &[
            Rec::Play(play(V1, CLIP_A, MIXED | LOOP)),
            Rec::Play(spatial),
            Rec::Play(stamped),
            Rec::Play(play(0x0001_0004, CLIP_B, MIXED | LOOP | wire::PLAY_FLAGS_WANTS_PLAYHEAD)),
            Rec::Set(mid_gain),
        ],
    );

    let before = allocations();
    let mut sink = 0.0f32;
    for q in 0..20u64 {
        let out = m.core.process(q * QUANTUM as u64);
        sink += out.iter().sum::<f32>();
    }
    assert_eq!(allocations(), before, "process allocated");
    assert!(sink.is_finite());
}
