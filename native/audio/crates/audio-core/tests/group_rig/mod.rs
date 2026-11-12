//! 0166 M4a (C2c, C2d): the rig the group hold and slip rebase tests share. C2b's `group_start.rs`
//! rig with waveforms instead of DC, so a member off by a frame shows in the output: a decoded
//! clip `c` holds `wave(c, k)` at frame `k`, a stream `s` holds `wave(s, k)` on both channels at its
//! stream frame `k`. Every run is deterministic, so a run with a hold is checked against a reference
//! run without one: a null test.
#![allow(dead_code)]

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::status::{self, BUFFER_BYTES};
use audio_core::group_hold::{self, FLAG_FADING};
use audio_core::groups::state as gstate;
use audio_core::voices::{self, state};
use audio_core::{bus, groups, scheduler, Core, InitParams, QUANTUM};
use audio_wire::generated::{self as wire, Envelope, StatusBlock, StreamOpen};

pub const RATE: f32 = 48_000.0;
pub const Q: u64 = QUANTUM as u64;
/// A decoded member's clip frames (longer than any test runs).
pub const CLIP_FRAMES: u32 = 4 * 48_000;

/// Sample `k` of source `id`: a quiet sine of its own frequency (the limiter never acts).
pub fn wave(id: u32, k: u64) -> f32 {
    let w = 0.011 + 0.0037 * (id % 17) as f64;
    (0.02 * (k as f64 * w).sin()) as f32
}

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 64, max_buses: 4, arena_initial_bytes: 0, max_music_rings: 8, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

/// A core, the next quantum's frame, and every output sample so far (left channel).
pub struct Rig {
    pub core: Core,
    pub frame: u64,
    pub out: Vec<f32>,
}

impl Rig {
    pub fn new() -> Rig {
        Rig { core: new_core(), frame: 0, out: Vec::new() }
    }

    /// The output latency: the sample of frame `f` is `out[f + latency]`.
    pub fn latency(&self) -> usize {
        bus::output_latency_frames(&self.core) as usize
    }

    /// The output sample of context frame `f`.
    pub fn at(&self, f: u64) -> f32 {
        self.out[f as usize + self.latency()]
    }

    /// A decoded mono clip `id` holding `wave(id, k)`.
    pub fn clip(&mut self, id: u32) {
        self.core.clips_mut().reserve(id, CLIP_FRAMES, 1, RATE, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = (0..CLIP_FRAMES as u64).flat_map(|k| wave(id, k).to_le_bytes()).collect();
        self.core.clips_mut().write(id, 0, &bytes).unwrap();
    }

    /// STREAM_OPEN of music stream `id` (stereo, epoch 1).
    pub fn open(&mut self, id: u32) {
        let o = StreamOpen { stream_id: id, channels: 2, sample_rate: RATE, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, flags: wire::STREAM_OPEN_FLAG_MUSIC, epoch: 1, ..Default::default() };
        let mut buf = vec![0u8; StreamOpen::FIXED_END];
        Envelope::new(wire::kind::STREAM_OPEN, 0, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        o.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), wire::ERR_OK);
    }

    /// Commits the next `frames` frames of stream `id`'s wave, in chunks of at most 4,096.
    pub fn feed(&mut self, id: u32, mut frames: u32) {
        while frames > 0 {
            let n = frames.min(4_096);
            let first = self.core.streams().get(id).expect("open").written;
            let p = self.core.streams_mut().chunk_ptr(id, n).expect("room for the chunk") as *mut f32;
            for i in 0..n as usize {
                let s = wave(id, first + i as u64);
                // SAFETY: chunk_ptr handed out room for `n` stereo f32 frames.
                unsafe {
                    *p.add(2 * i) = s;
                    *p.add(2 * i + 1) = s;
                }
            }
            assert_eq!(self.core.streams_mut().commit(id, n, 1, 0), wire::ERR_OK);
            frames -= n;
        }
    }

    pub fn submit(&mut self, recs: &[Vec<u8>]) {
        let body: usize = recs.iter().map(|r| r.len()).sum();
        let mut buf = vec![0u8; 32 + body];
        let mut at = 32;
        for r in recs {
            buf[at..at + r.len()].copy_from_slice(r);
            at += r.len();
        }
        Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        wire::BatchHeader { first_frame: self.frame as f64, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), wire::ERR_OK);
    }

    /// Renders `n` quanta.
    pub fn render(&mut self, n: usize) {
        for _ in 0..n {
            let out = self.core.process(self.frame);
            self.out.extend_from_slice(&out[..QUANTUM]);
            status::after_quantum(&mut self.core);
            self.frame += Q;
        }
    }

    /// Renders up to and including the quantum holding `frame`.
    pub fn render_through(&mut self, frame: u64) {
        while self.frame <= frame {
            self.render(1);
        }
    }

    pub fn slot(&self, voice: u32) -> voices::VoiceSlot {
        voices::slots(&self.core)[(voice & 0xFFFF) as usize]
    }

    pub fn entry(&self, index: usize) -> groups::GroupEntry {
        groups::entries_of(self.core.regions().groups)[index]
    }

    pub fn take(&mut self) -> StatusBlock {
        let mut out = vec![0u8; BUFFER_BYTES];
        let n = status::take(&mut self.core, &mut out, 0);
        assert!(n > 0);
        StatusBlock::read(&out, 0).expect("the generated reader accepts the block").0
    }
}

pub const fn voice(i: u32) -> u32 {
    0x0001_0000 | i
}

/// PLAY of `voice_id` on `clip` (a stream id with `stream`), `at` frames into the batch, `gate`.
pub fn play(voice_id: u32, clip: u32, stream: bool, at: u32, gate: u16) -> Vec<u8> {
    let mut flags = wire::PLAY_FLAGS_MIXED;
    if stream {
        flags |= wire::PLAY_FLAGS_STREAM;
    }
    let p = wire::Play { voice_id, frame_offset: at, clip, bus: 0, flags, gain: 1.0, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, gate, ..Default::default() };
    let mut b = vec![0u8; wire::Play::FIXED_END];
    p.write(&mut b, 0).unwrap();
    b
}

/// FADE of `voice_id` to `target` over `frames`, `at` frames into the batch.
pub fn fade(voice_id: u32, at: u32, target: f32, frames: u32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id, frame_offset: at, target, frames, ..Default::default() }.write(&mut b, 0).unwrap();
    b
}

/// The `groupStarts` items: (group id, flags, slip, start frame).
pub fn group_starts(s: &StatusBlock) -> Vec<(u16, u16, u32, u64)> {
    s.group_starts.iter().map(|g| (g.group_id, g.flags, g.slip_frames, (g.start_frame_hi as u64) << 32 | g.start_frame_lo as u64)).collect()
}

/// The largest |a[i] − b[i]|.
pub fn max_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

/// The stamp of every test group.
pub const STAMP: u32 = 1_000;
/// Frames a ring with plenty is fed (it never runs dry in these runs).
pub const PLENTY: u32 = 16_384;
/// Frames the starving ring is fed first: it runs dry about 5,600 frames after the start.
pub const SHORT: u32 = 6_000;

pub fn hold_fade() -> u64 {
    group_hold::hold_fade_frames(RATE) as u64
}

pub fn fade_in() -> u64 {
    (0.005 * RATE).round() as u64
}

/// Group `id` on `clips` (decoded members, first) and `streams` (`(stream id, frames fed)`), every
/// member stamped at [`STAMP`]. Returns the members.
pub fn group(r: &mut Rig, id: u32, clips: &[u32], streams: &[(u32, u32)]) -> Vec<u32> {
    let size = (clips.len() + streams.len()) as u32;
    let gate = wire::pack_gate(id, size);
    let mut recs = Vec::new();
    let mut members = Vec::new();
    for (i, &c) in clips.iter().enumerate() {
        r.clip(c);
        members.push(voice(i as u32));
        recs.push(play(voice(i as u32), c, false, STAMP, gate));
    }
    for (j, &(s, frames)) in streams.iter().enumerate() {
        r.open(s);
        r.feed(s, frames);
        let v = voice((clips.len() + j) as u32);
        members.push(v);
        recs.push(play(v, s, true, STAMP, gate));
    }
    r.submit(&recs);
    members
}

/// What a held run saw: the frame the joint fade started (`q`), the hold's start (`q` + the fade),
/// the resume frame and its slip.
#[derive(Debug)]
pub struct Hold {
    pub q: u64,
    pub hold_start: u64,
    pub resume: u64,
    pub slip: u64,
}

/// Renders a run whose `starver` stream was fed short until the joint fade starts, then
/// `held_quanta` more quanta after the hold's start, refeeds the starver (8,192 frames), and renders
/// until `total` quanta have been rendered. Returns what it saw.
pub fn hold_run(r: &mut Rig, starver: u32, held_quanta: usize, total: usize) -> Hold {
    let mut q = None;
    while q.is_none() {
        r.render(1);
        assert!(r.out.len() < total * QUANTUM_USIZE, "the joint fade never started");
        if r.entry(0).flags & FLAG_FADING != 0 {
            q = Some(r.frame - Q);
        }
    }
    let q = q.unwrap();
    assert_eq!(group_starts(&r.take()).len(), 1, "the start, reported");
    let hold_start = q + hold_fade();
    r.render_through(hold_start);
    assert_eq!(r.entry(0).state, gstate::HELD, "held once the fade has run");
    assert_eq!(r.entry(0).flags & FLAG_FADING, 0);
    r.render(held_quanta);
    assert_eq!(r.entry(0).state, gstate::HELD, "held while the ring is short");
    assert_eq!(r.take().groups_held, 1, "one hold counted");
    r.feed(starver, 8_192);
    let resume = r.frame;
    r.render(total - r.out.len() / QUANTUM_USIZE);
    let s = r.take();
    let starts = group_starts(&s);
    assert_eq!(starts.len(), 1, "one resume reported: {starts:?}");
    let (id, flags, slip, at) = starts[0];
    assert_eq!(id, r.entry(0).id);
    assert_eq!(flags, wire::GROUP_START_HELD as u16, "a resume, not late");
    assert_eq!(at, resume, "resumed in the quantum the ring was ready");
    assert_eq!(slip as u64, resume - hold_start, "the slip is the hold's length");
    assert_eq!(s.max_slip_frames, slip, "maxSlipFrames");
    assert_eq!(s.groups_held, 1, "cumulative: still the one hold");
    Hold { q, hold_start, resume, slip: slip as u64 }
}

pub const QUANTUM_USIZE: usize = Q as usize;

/// The held run against the reference, around `h`: equal before the fade; through the fade the
/// reference times the fade (only when `faded`, every member a stream); silent through the hold;
/// through the fade-in the reference (from the hold's start) times the fade-in (`faded`); then the
/// reference delayed by the slip, exactly. Returns the null's span.
pub fn check_null(held: &Rig, reference: &Rig, h: &Hold, faded: bool) -> usize {
    let lat = held.latency() as u64;
    assert!(h.q > STAMP as u64 + 1_000, "the group played before the fade");
    // Before the fade: the same run.
    assert_eq!(&held.out[..(h.q + lat) as usize], &reference.out[..(h.q + lat) as usize], "equal before the hold");
    if faded {
        let n = hold_fade();
        for k in 0..n {
            let g = 1.0 - (k + 1) as f32 / n as f32;
            let (b, a) = (held.at(h.q + k), reference.at(h.q + k));
            assert!((b - a * g).abs() < 1e-6, "the joint fade at frame {}: {b} vs {a} × {g}", h.q + k);
        }
    }
    for f in h.hold_start..h.resume {
        assert_eq!(held.at(f), 0.0, "silent through the hold (frame {f})");
    }
    let fi = fade_in();
    if faded {
        for k in 0..fi {
            let g = (k + 1) as f32 / fi as f32;
            let (b, a) = (held.at(h.resume + k), reference.at(h.hold_start + k));
            assert!((b - a * g).abs() < 1e-6, "the fade-in at frame {}: {b} vs {a} × {g}", h.resume + k);
        }
    }
    // After the fade-in: the reference delayed by the slip (the null).
    let from = (h.resume + fi + lat) as usize;
    let to = held.out.len();
    let b = &held.out[from..to];
    let a = &reference.out[from - h.slip as usize..to - h.slip as usize];
    assert!(a.iter().any(|&s| s.abs() > 0.01), "the reference sounds there");
    assert_eq!(max_diff(b, a), 0.0, "null after the resume: every member resumed on one frame, where it held");
    to - from
}

/// Every member's playhead is the same (they started together and held together).
pub fn same_playhead(r: &Rig, members: &[u32]) {
    let p = r.slot(members[0]).position;
    for &m in members {
        assert_eq!(r.slot(m).state, state::PLAYING, "member {m:#x} plays");
        assert_eq!(r.slot(m).position, p, "member {m:#x}'s playhead");
    }
}

