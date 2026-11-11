//! Spike S1 (audio M4): stamped starts of stream voices in the real Rust audio core.
//!
//! The rig drives `audio_core::Core` natively, the way `audio-core/tests/wide_streams.rs` does: BATCH records go
//! through `scheduler::submit` (the path `myco_audio_submit` takes), stream rings are filled with
//! `streams_mut().open/chunk_ptr/commit` at quantum boundaries (as the worklet shell does between `process()` calls),
//! and credits flow back with one quantum of latency each way. The decoder worker is a model (`Feed`): it opens
//! the stream and commits 4,096-frame chunks from `ready_at`, keeps `buffered + inFlight <= 32,768`
//! (`src/plugins/audio/runtime/decoder/credit.ts:8-22`), and its throughput is a parameter.
//!
//! Signals: `src(piece, stem, k)` is a click (0.5) at k = 0, then dyadic noise in +-0.25 (21 bits, exact in f32), so the
//! first non-zero sample is frame 0 of the file, any shift shows as an error, and sums of up to 8 voices at gain 1/8
//! are exact to within one f32 ulp. Stereo (R differs from L).

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::stream::{phase, RING_FRAMES};
use audio_core::{bus, scheduler, status, voices, Core, QUANTUM};
use audio_wire::generated::{self as wire, StreamOpen};
use std::collections::VecDeque;

pub const RATE: f32 = 48_000.0;
pub const Q: u64 = QUANTUM as u64;
pub const CHUNK: usize = 4_096;
pub const WINDOW: u64 = RING_FRAMES as u64;
pub const STREAM0: u32 = 0xFFFF_0100;

fn splitmix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// File frame `k` of stem `stem` of piece `piece`: a click at 0, then exact dyadic noise.
pub fn src(piece: u32, stem: u32, k: u64) -> (f32, f32) {
    if k == 0 {
        return (0.5, 0.5);
    }
    let h = splitmix(k ^ ((piece as u64) << 40) ^ ((stem as u64) << 52));
    let a = ((h & 0xF_FFFF) as i32 - 0x8_0000) as f32 / (1 << 21) as f32;
    let b = (((h >> 20) & 0xF_FFFF) as i32 - 0x8_0000) as f32 / (1 << 21) as f32;
    (a, b)
}

pub fn new_core(max_mixed: u32) -> (Core, *mut u8, std::alloc::Layout) {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed, max_buses: 4, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; freed in `Rig::drop`, after the core is last used.
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    (core, base, block)
}

/// One piece of a stream's timeline: from stream frame `from` the stream carries `(piece, stem)` at file frame
/// `file + (s - from)`, wrapped into `region` (start, end exclusive) when it has one.
#[derive(Clone, Copy)]
pub struct Seg {
    pub from: u64,
    pub piece: u32,
    pub stem: u32,
    pub file: u64,
    pub region: Option<(u64, u64)>,
}

impl Seg {
    pub fn at(&self, s: u64) -> (f32, f32) {
        let mut f = self.file + (s - self.from);
        if let Some((a, b)) = self.region {
            if f >= b {
                f = a + (f - a) % (b - a);
            }
        }
        src(self.piece, self.stem, f)
    }
}

/// The decoder worker's side of one stream (a model of `decoder/streams.ts` + the shell's credits).
pub struct Feed {
    pub id: u32,
    pub segs: Vec<Seg>,
    /// Frames the stream has in all (a file that ends: the last chunk is flagged `last`), or None.
    pub total: Option<u64>,
    /// The quantum-start frame from which STREAM_OPEN and the first chunk reach the ring.
    pub ready_at: u64,
    /// Frames in the first chunk (a partial first chunk shows the START_FRAMES wait).
    pub first_chunk: usize,
    /// Chunks the worker decodes and posts per quantum (throughput).
    pub chunks_per_q: usize,
    pub opened: bool,
    pub refused_open: bool,
    sent: u64,
    credited: u64,
    credits: VecDeque<u64>,
    pending: u64,
    to_worker: Vec<u64>,
    epoch: u32,
    pub done: bool,
    /// A splice's new epoch sends no chunk before this frame.
    pub hold_until: u64,
}

impl Feed {
    pub fn new(index: u32, seg: Seg, ready_at: u64) -> Feed {
        Feed { id: STREAM0 + index, segs: vec![seg], total: None, ready_at, first_chunk: CHUNK, chunks_per_q: 1, opened: false, refused_open: false, sent: 0, credited: 0, credits: VecDeque::new(), pending: 0, to_worker: vec![], epoch: 1, done: false, hold_until: 0 }
    }

    fn sample(&self, s: u64) -> (f32, f32) {
        self.segs.iter().rev().find(|g| g.from <= s).unwrap().at(s)
    }

    fn open_rec(&self, epoch: u32, start_frame: u32, loop_end: u32) -> StreamOpen {
        StreamOpen { stream_id: self.id, channels: 2, sample_rate: RATE, total_frames: self.total.map_or(wire::STREAM_TOTAL_FRAMES_UNKNOWN, |t| t as u32), epoch, start_frame, loop_end, ..Default::default() }
    }

    /// One quantum boundary: STREAM_OPEN if due, credits in, chunks out.
    fn deliver(&mut self, core: &mut Core, frame: u64) {
        if frame < self.ready_at || self.refused_open {
            return;
        }
        if !self.opened {
            if !core.streams_mut().open(&self.open_rec(1, 0, 0)) {
                self.refused_open = true;
                return;
            }
            self.opened = true;
        }
        while let Some(c) = self.credits.pop_front() {
            self.credited += c;
        }
        let mut n = 0;
        while frame >= self.hold_until && !self.done && n < self.chunks_per_q && self.sent - self.credited + CHUNK as u64 <= WINDOW {
            let cap = if self.sent == 0 { self.first_chunk } else { CHUNK };
            let frames = match self.total {
                Some(t) => (t - self.sent).min(cap as u64) as usize,
                None => cap,
            };
            let last = self.total.is_some_and(|t| self.sent + frames as u64 >= t);
            if frames > 0 {
                let p = core.streams_mut().chunk_ptr(self.id, frames as u32).expect("chunk within the credit window");
                // SAFETY: chunk_ptr gave room for `frames` interleaved stereo f32 frames.
                let dst = unsafe { std::slice::from_raw_parts_mut(p as *mut f32, frames * 2) };
                for i in 0..frames {
                    let (l, r) = self.sample(self.sent + i as u64);
                    dst[2 * i] = l;
                    dst[2 * i + 1] = r;
                }
            }
            let flags = if last { wire::STREAM_CHUNK_FLAGS_LAST } else { 0 };
            assert_eq!(core.streams_mut().commit(self.id, frames as u32, self.epoch, flags), wire::ERR_OK);
            self.sent += frames as u64;
            self.done = last;
            n += 1;
        }
    }

    /// After the quantum: the shell's credit (every 4,096 consumed frames, `credit.ts`).
    fn after(&mut self, core: &mut Core) {
        if !self.opened {
            return;
        }
        let c = core.streams_mut().take_consumed(self.id);
        if c > 0 {
            self.pending += c as u64;
        }
        if self.pending >= CHUNK as u64 {
            self.to_worker.push(std::mem::take(&mut self.pending));
        }
        for c in self.to_worker.drain(..) {
            self.credits.push_back(c);
        }
    }

    /// A splice (ADR 0158 E4.4, `stream.rs` "Splices"): the stream continues at stream frame `at` with `seg`
    /// (a new epoch whose STREAM_OPEN has `loopEnd != 0`); chunks of the new epoch follow from `ready_at`.
    pub fn splice(&mut self, core: &mut Core, at: u64, seg: Seg, ready_at: u64) -> bool {
        self.epoch += 1;
        let ok = core.streams_mut().open(&self.open_rec(self.epoch, at as u32, 1));
        self.sent = at;
        self.done = false;
        self.segs.push(Seg { from: at, ..seg });
        self.hold_until = ready_at;
        ok
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Records

fn envelope(first_frame: f64, recs: &[Vec<u8>]) -> Vec<u8> {
    let body: usize = recs.iter().map(|r| r.len()).sum();
    let mut buf = vec![0u8; 32 + body];
    let mut off = 32;
    for r in recs {
        buf[off..off + r.len()].copy_from_slice(r);
        off += r.len();
    }
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
    buf
}

pub fn rec_play(voice: u32, clip: u32, stream: bool, frame_offset: u32, gain: f32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Play::FIXED_END];
    let flags = wire::PLAY_FLAGS_MIXED | if stream { wire::PLAY_FLAGS_STREAM | wire::PLAY_FLAGS_WANTS_PLAYHEAD } else { 0 };
    wire::Play { voice_id: voice, frame_offset, clip, flags, gain, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, ..Default::default() }.write(&mut b, 0).unwrap();
    b
}

pub fn rec_stop(voice: u32, frame_offset: u32, fade: u32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: voice, frame_offset, fade_frames: fade, reason: 0 }.write(&mut b, 0).unwrap();
    b
}

pub fn rec_fade_out(voice: u32, frame_offset: u32, frames: u32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id: voice, frame_offset, target: 0.0, frames, flags: wire::FADE_FLAGS_STOP_AT_END }.write(&mut b, 0).unwrap();
    b
}

pub fn rec_gain(voice: u32, frame_offset: u32, gain: f32, ramp: u32) -> Vec<u8> {
    let mut b = vec![0u8; wire::SetParams::FIXED_END];
    wire::SetParams { voice_id: voice, frame_offset, mask: wire::SET_PARAMS_MASK_GAIN, gain, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, ramp_frames: ramp, ..Default::default() }.write(&mut b, 0).unwrap();
    b
}

pub fn voice_id(i: u32) -> u32 {
    0x0001_0000 | (i + 1)
}

// ---------------------------------------------------------------------------------------------------------------------
// The rig

pub struct Rig {
    pub core: Core,
    pub frame: u64,
    pub feeds: Vec<Feed>,
    pub out: [Vec<f32>; 2],
    /// Per tracked voice: (slot index, summed position advance, first frame it advanced).
    track: Vec<(usize, f64, Option<u64>)>,
    pub starved: usize,
    block: (*mut u8, std::alloc::Layout),
}

impl Drop for Rig {
    fn drop(&mut self) {
        // SAFETY: the block came from `alloc_zeroed` with this layout; the core (no Drop) is not used again.
        unsafe { std::alloc::dealloc(self.block.0, self.block.1) };
    }
}

impl Rig {
    pub fn new(max_mixed: u32) -> Rig {
        let (core, base, layout) = new_core(max_mixed);
        Rig { core, frame: 0, feeds: vec![], out: [vec![], vec![]], track: vec![], starved: 0, block: (base, layout) }
    }

    /// Submits records now (`first_frame` = the current frame). A stamped record is `stamp - frame` ahead.
    pub fn submit(&mut self, recs: &[Vec<u8>]) {
        let msg = envelope(self.frame as f64, recs);
        assert_eq!(scheduler::submit(&mut self.core, &msg), 0, "batch refused");
    }

    pub fn off(&self, stamp: u64) -> u32 {
        assert!(stamp >= self.frame, "stamp {stamp} is behind frame {}", self.frame);
        (stamp - self.frame) as u32
    }

    /// Tracks voice `i` (id `voice_id(i)`) for its start frame.
    pub fn watch(&mut self, i: u32) {
        self.track.push(((voice_id(i) & 0xFFFF) as usize, 0.0, None));
    }

    /// First frame (absolute) at which watched voice number `n` rendered, from its playhead's advance.
    pub fn started(&self, n: usize) -> Option<u64> {
        self.track[n].2
    }

    pub fn step(&mut self) {
        let frame = self.frame;
        for f in self.feeds.iter_mut() {
            f.deliver(&mut self.core, frame);
        }
        let before: Vec<f64> = self.track.iter().map(|t| voices::slots(&self.core)[t.0].position).collect();
        let out = self.core.process(frame).to_vec();
        self.out[0].extend_from_slice(&out[..QUANTUM]);
        self.out[1].extend_from_slice(&out[QUANTUM..2 * QUANTUM]);
        for (t, b) in self.track.iter_mut().zip(before) {
            let after = voices::slots(&self.core)[t.0].position;
            let played = (after - b).round() as i64;
            if played > 0 && t.2.is_none() {
                // The voice rendered the last `played` frames of this quantum (pitch 1, rate ratio 1).
                t.2 = Some(frame + Q - played as u64);
            }
            t.1 += after - b;
        }
        let c = status::counters_mut(&mut self.core);
        self.starved += c.stream_events.as_slice().iter().filter(|e| e.code == wire::stream_event::STARVED).count();
        c.end_block();
        for f in self.feeds.iter_mut() {
            f.after(&mut self.core);
        }
        self.frame += Q;
    }

    pub fn run_to(&mut self, frame: u64) {
        while self.frame < frame {
            self.step();
        }
    }

    pub fn late(&self) -> (u32, u32) {
        let c = status::counters(&self.core);
        (c.late_commands, c.max_lateness_frames)
    }

    pub fn ring_phase(&self, i: u32) -> Option<u8> {
        self.core.streams().get(STREAM0 + i).map(|r| r.phase)
    }

    pub fn first_nonzero(&self, from: u64) -> Option<u64> {
        (from as usize..self.out[0].len()).find(|&t| self.out[0][t] != 0.0 || self.out[1][t] != 0.0).map(|t| t as u64)
    }
}

pub const PLAYING: u8 = phase::PLAYING;

/// `(max |residual|, first frame with |residual| > tol, frames over tol)` of the heard output against
/// `want(t) -> (l, r)` over `from..to`.
pub fn null_test(rig: &Rig, from: u64, to: u64, tol: f32, want: impl Fn(u64) -> (f32, f32)) -> (f32, Option<u64>, usize) {
    let (mut max, mut first, mut over) = (0f32, None, 0usize);
    for t in from..to {
        let (l, r) = want(t);
        let e = (rig.out[0][t as usize] - l).abs().max((rig.out[1][t as usize] - r).abs());
        max = max.max(e);
        if e > tol {
            over += 1;
            first.get_or_insert(t);
        }
    }
    (max, first, over)
}
