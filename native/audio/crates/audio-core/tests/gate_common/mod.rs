//! Shared rig for C3's gate goldens (0166 M4a; api-and-models §9 "Golden", §10 row C3): the
//! alignment harness (`alignment_harness.rs`) and the `gate_*.rs` null tests.
//!
//! It drives the real `audio_core::Core` natively as the worklet shell does: BATCH records and
//! STREAM_OPEN through `scheduler::submit` (the path `myco_audio_submit` takes), STREAM_CHUNK frames
//! copied with `streams_mut().chunk_ptr` + `commit` between quanta, and each quantum
//! `process` + `status::after_quantum` + `clips::flush_events` (`myco_audio_process`). The limiter's
//! look-ahead is 0, so output frames are core frames.
//!
//! **The decoder worker** is a model ([`Feed`]): from its `ready_at` quantum it opens the music
//! stream and commits its first 4,096-frame chunk in the same gap between quanta (so the ring is
//! ready from that quantum on), then one chunk per quantum while the ring has room for it (the
//! credit window: `written − consumed + 4,096 ≤ 32,768`). A `total` stream ends with a LAST chunk.
//!
//! **Signals, exact in f32** so the sums null to an ulp and any one-frame shift of any member shows:
//! - a decoded member is a mono f32 clip of the fixture fill `lcg` (Z3's, `in_voice_goldens.rs`):
//!   heard as L = R = sample;
//! - a streamed member is stereo [`noise32`] (a 32-bit hash of the stream frame, L and R
//!   different), addressable by frame so the wasm half can rebuild any chunk.
//!
//! **Fixtures** (`src/plugins/audio/runtime/golden/gate-<scene>.json`, written with
//! `UPDATE_GOLDENS=1`): Z3's format (preset, clips, steps, frames, FNV-1a 64 digest) plus
//! `maxMusicRings` in the preset, two stream steps (`open`: a whole STREAM_OPEN message in hex;
//! `chunk`: a STREAM_CHUNK described by its stream, epoch, first stream frame, frames, flags and
//! `noise32` seed) and the scene's `groupStarts`. `golden/audioGoldenGate.test.ts` replays them on
//! the loopback host with the real wasm (native equals wasm).
#![allow(dead_code)]

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::status::{self, BUFFER_BYTES};
use audio_core::stream::RING_FRAMES;
use audio_core::voices::{self, VoiceSlot};
use audio_core::{bus, clips, scheduler, Core, QUANTUM};
use audio_wire::generated::{self as wire, Envelope, StatusBlock, StreamOpen};

pub const Q: u64 = QUANTUM as u64;
/// The worker's chunk (`decoder/streams.ts`), and the frames a ring needs to be ready.
pub const CHUNK: u32 = 4_096;
/// A decoded member's clip amplitude (a power of two: every lcg sample is exact).
pub const CLIP_AMP: f32 = 0.5;
/// A streamed member's amplitude.
pub const STREAM_AMP: f32 = 0.25;
/// The fixtures' preset (beside `LOOPBACK_PRESET`'s other values, which don't change the output).
pub const MAX_LOGICAL: u32 = 64;
pub const MAX_MIXED: u32 = 64;
pub const MAX_BUSES: u32 = 4;
pub const MUSIC_RINGS: u32 = 8;

pub const fn voice(i: u32) -> u32 {
    0x0001_0000 | (i + 1)
}

/// Stream frame `k`, channel `ch` (0 L, 1 R) of the stream whose seed is `seed`: a 32-bit
/// integer hash, scaled exactly (`(h >> 8) / 2²⁴ − 0.5` is a 24-bit fraction; × 0.25 is exact).
/// `audioGoldenGate.test.ts`' `noise32` is the same function with `Math.imul`.
pub fn noise32(seed: u32, k: u32, ch: u32) -> f32 {
    let mut h = seed ^ k.wrapping_mul(2).wrapping_add(ch).wrapping_mul(0x9E37_79B1);
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^= h >> 16;
    STREAM_AMP * ((h >> 8) as f32 / 16_777_216.0 - 0.5)
}

/// The fixture's `lcg` clip (`in_voice_goldens.rs`' `lcg`): `state = state·1,664,525 +
/// 1,013,904,223` (mod 2³²) before each sample; the sample is `amp·((state >> 8)/2²⁴ − 0.5)`.
pub fn lcg(seed: u32, amp: f32, frames: usize) -> Vec<f32> {
    let mut state = seed;
    (0..frames)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            amp * ((state >> 8) as f32 / 16_777_216.0 - 0.5)
        })
        .collect()
}

/// FNV-1a 64 over the left channel's f32 bytes (little-endian), then the right's.
pub fn fnv1a64(left: &[f32], right: &[f32]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in left.iter().chain(right) {
        for b in x.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One stream as the decoder worker feeds it.
pub struct Feed {
    pub id: u32,
    pub seed: u32,
    /// The quantum frame before which STREAM_OPEN and the first chunk are committed.
    pub ready_at: u64,
    /// Frames in the first chunk (less than 4,096: the ring isn't ready until the next one).
    pub first_chunk: u32,
    /// The stream's length, if it ends (its last chunk carries LAST).
    pub total: Option<u32>,
    /// No chunk after the first before this frame (a stalled worker).
    pub stall_until: u64,
    opened: bool,
    sent: u32,
    done: bool,
}

impl Feed {
    pub fn new(id: u32, seed: u32, ready_at: u64) -> Feed {
        Feed { id, seed, ready_at, first_chunk: CHUNK, total: None, stall_until: 0, opened: false, sent: 0, done: false }
    }
}

/// One member of a group: a decoded clip or a streamed music stream, and its gain.
#[derive(Clone, Copy, Debug)]
pub enum Source {
    /// Clip id and lcg seed.
    Clip { id: u32, seed: u32 },
    /// Stream id and noise32 seed.
    Stream { id: u32, seed: u32 },
}

#[derive(Clone, Copy, Debug)]
pub struct Member {
    pub voice: u32,
    pub source: Source,
    pub gain: f32,
}

/// What the scene is recording for its fixture.
struct Recorder {
    clips: Vec<String>,
    steps: Vec<String>,
    /// Quanta rendered since the last non-run step (merged into one `run`).
    run: usize,
}

pub struct Rig {
    pub core: Core,
    pub rate: f32,
    /// The next quantum's first frame.
    pub frame: u64,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// The output frame `left[0]` carries.
    pub out_origin: u64,
    pub feeds: Vec<Feed>,
    /// Clip samples by id (the reference reads them).
    clip_data: Vec<(u32, Vec<f32>)>,
    rec: Option<Recorder>,
    block: (*mut u8, std::alloc::Layout),
}

impl Drop for Rig {
    fn drop(&mut self) {
        // SAFETY: the block came from `alloc_zeroed` with this layout; the core (no Drop) is not used again.
        unsafe { std::alloc::dealloc(self.block.0, self.block.1) };
    }
}

impl Rig {
    /// A core at `rate` with the fixtures' preset (4 general rings, 8 music rings), the limiter's
    /// look-ahead 0.
    pub fn new(rate: f32) -> Rig {
        let p = InitParams { sample_rate: rate, max_logical: MAX_LOGICAL, max_mixed: MAX_MIXED, max_buses: MAX_BUSES, arena_initial_bytes: 0, max_music_rings: MUSIC_RINGS, ..InitParams::default() };
        let layout = Layout::new(&p);
        let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
        // SAFETY: non-zero size, zeroed, page-aligned; freed in `Drop`, after the core is last used.
        let base = unsafe { std::alloc::alloc_zeroed(block) };
        // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
        let mut core = unsafe { Core::new(p, layout, base) };
        assert!(bus::set_limiter_lookahead(&mut core, 0.0));
        assert_eq!(bus::output_latency_frames(&core), 0);
        Rig { core, rate, frame: 0, left: Vec::new(), right: Vec::new(), out_origin: 0, feeds: Vec::new(), clip_data: Vec::new(), rec: None, block: (base, block) }
    }

    /// A 48 kHz rig that records its steps for a fixture.
    pub fn recording() -> Rig {
        let mut r = Rig::new(48_000.0);
        r.rec = Some(Recorder { clips: Vec::new(), steps: Vec::new(), run: 0 });
        r
    }

    /// Starts the rig at `frame` (a quantum boundary) without rendering what came before: the core
    /// takes any frame, and a case of the harness needs only its last few quanta.
    pub fn skip_to(&mut self, frame: u64) {
        assert!(self.rec.is_none() && self.left.is_empty() && frame % Q == 0);
        self.frame = frame;
        self.out_origin = frame;
    }

    fn flush_run(&mut self) {
        if let Some(rec) = self.rec.as_mut() {
            if rec.run > 0 {
                rec.steps.push(format!("{{\"run\":{}}}", rec.run));
                rec.run = 0;
            }
        }
    }

    /// Loads decoded clip `id`: `frames` mono f32 frames of `lcg(seed, CLIP_AMP)` at the rig's rate.
    pub fn clip(&mut self, id: u32, seed: u32, frames: usize) {
        let samples = lcg(seed, CLIP_AMP, frames);
        self.core.clips_mut().reserve(id, frames as u32, 1, self.rate, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.core.clips_mut().write(id, 0, &bytes).unwrap();
        if let Some(rec) = self.rec.as_mut() {
            rec.clips.push(format!("{{\"id\":{id},\"frames\":{frames},\"fill\":\"lcg\",\"seed\":{seed},\"amp\":{CLIP_AMP}}}"));
        }
        self.clip_data.push((id, samples));
    }

    /// Clip `id`'s sample `k` (0 past its end).
    pub fn clip_sample(&self, id: u32, k: u64) -> f32 {
        let c = &self.clip_data.iter().find(|c| c.0 == id).expect("a loaded clip").1;
        c.get(k as usize).copied().unwrap_or(0.0)
    }

    /// STREAM_OPEN of music stream `id` (stereo, epoch 1, the rig's rate), as the worker posts it.
    fn open(&mut self, id: u32, total: Option<u32>) {
        let o = StreamOpen { stream_id: id, channels: 2, sample_rate: self.rate, total_frames: total.unwrap_or(wire::STREAM_TOTAL_FRAMES_UNKNOWN), flags: wire::STREAM_OPEN_FLAG_MUSIC, epoch: 1, ..Default::default() };
        let mut buf = vec![0u8; StreamOpen::FIXED_END];
        Envelope::new(wire::kind::STREAM_OPEN, 0, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
        o.write(&mut buf, 0).unwrap();
        assert_eq!(scheduler::submit(&mut self.core, &buf), wire::ERR_OK, "STREAM_OPEN {id} taken");
        self.flush_run();
        if let Some(rec) = self.rec.as_mut() {
            rec.steps.push(format!("{{\"open\":\"{}\"}}", hex(&buf)));
        }
    }

    /// Commits `frames` frames of stream `id` from stream frame `from` (`noise32(seed)`).
    fn chunk(&mut self, id: u32, seed: u32, from: u32, frames: u32, last: bool) {
        let p = self.core.streams_mut().chunk_ptr(id, frames).expect("room for the chunk") as *mut f32;
        for i in 0..frames {
            for ch in 0..2 {
                // SAFETY: chunk_ptr handed out room for `frames` stereo f32 frames.
                unsafe { *p.add((2 * i + ch) as usize) = noise32(seed, from + i, ch) };
            }
        }
        let flags = if last { wire::STREAM_CHUNK_FLAGS_LAST } else { 0 };
        assert_eq!(self.core.streams_mut().commit(id, frames, 1, flags), wire::ERR_OK);
        self.flush_run();
        if let Some(rec) = self.rec.as_mut() {
            rec.steps.push(format!("{{\"chunk\":{{\"stream\":{id},\"epoch\":1,\"from\":{from},\"frames\":{frames},\"flags\":{flags},\"seed\":{seed}}}}}"));
        }
    }

    /// The worker's turn between quanta: every feed that is due opens, sends its first chunk, or
    /// sends its next one if the ring has room.
    fn pump(&mut self) {
        let frame = self.frame;
        for n in 0..self.feeds.len() {
            let f = &self.feeds[n];
            if frame < f.ready_at || f.done {
                continue;
            }
            let (id, seed, total, opened, sent) = (f.id, f.seed, f.total, f.opened, f.sent);
            if !opened {
                self.open(id, total);
                self.feeds[n].opened = true;
            } else if frame < f.stall_until {
                continue;
            } else {
                let ring = *self.core.streams().get(id).expect("an open ring");
                if ring.written - ring.consumed + CHUNK as u64 > RING_FRAMES as u64 {
                    continue;
                }
            }
            let cap = if sent == 0 { self.feeds[n].first_chunk } else { CHUNK };
            let frames = total.map_or(cap, |t| (t - sent).min(cap));
            let last = total.is_some_and(|t| sent + frames >= t);
            self.chunk(id, seed, sent, frames, last);
            let f = &mut self.feeds[n];
            f.sent += frames;
            f.done = last;
        }
    }

    /// One BATCH of `recs` at the next quantum's frame (a record's offset counts from it).
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
        self.flush_run();
        if let Some(rec) = self.rec.as_mut() {
            rec.steps.push(format!("{{\"send\":\"{}\",\"count\":{}}}", hex(&buf[32..]), recs.len()));
        }
    }

    /// The offset of `stamp` from the next quantum's frame (a PLAY's `frame_offset`).
    pub fn off(&self, stamp: u64) -> u32 {
        assert!(stamp >= self.frame, "stamp {stamp} behind frame {}", self.frame);
        (stamp - self.frame) as u32
    }

    /// The worker's turn, then one quantum as `myco_audio_process` renders it.
    pub fn step(&mut self) {
        self.pump();
        let out = self.core.process(self.frame);
        self.left.extend_from_slice(&out[..QUANTUM]);
        self.right.extend_from_slice(&out[QUANTUM..2 * QUANTUM]);
        status::after_quantum(&mut self.core);
        clips::flush_events(&mut self.core);
        self.frame += Q;
        if let Some(rec) = self.rec.as_mut() {
            rec.run += 1;
        }
    }

    /// Renders until the next quantum's frame is at least `frame`.
    pub fn run_to(&mut self, frame: u64) {
        while self.frame < frame {
            self.step();
        }
    }

    pub fn slot(&self, v: u32) -> VoiceSlot {
        voices::slots(&self.core)[(v & 0xFFFF) as usize]
    }

    pub fn take(&mut self) -> StatusBlock {
        let mut out = vec![0u8; BUFFER_BYTES];
        let n = status::take(&mut self.core, &mut out, 0);
        assert!(n > 0);
        StatusBlock::read(&out, 0).expect("the generated reader accepts the block").0
    }

    /// The output at frame `t` (L, R).
    pub fn out(&self, t: u64) -> (f32, f32) {
        let i = (t - self.out_origin) as usize;
        (self.left[i], self.right[i])
    }

    /// `members` started at `start`, heard at frame `t`: the sum of each member's source at
    /// `t − start`, times its gain (0 before `start`).
    pub fn reference(&self, members: &[Member], start: u64, t: u64) -> (f32, f32) {
        if t < start {
            return (0.0, 0.0);
        }
        let k = t - start;
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for m in members {
            match m.source {
                Source::Clip { id, .. } => {
                    let s = m.gain * self.clip_sample(id, k);
                    l += s;
                    r += s;
                }
                Source::Stream { id, seed } => {
                    let total = self.feeds.iter().find(|f| f.id == id).and_then(|f| f.total).unwrap_or(u32::MAX);
                    if k < total as u64 {
                        l += m.gain * noise32(seed, k as u32, 0);
                        r += m.gain * noise32(seed, k as u32, 1);
                    }
                }
            }
        }
        (l, r)
    }

    /// `(max |residual|, first frame over tol, frames over tol)` of the output over `from..to`
    /// against `members` started at `start`.
    pub fn null(&self, members: &[Member], start: u64, from: u64, to: u64, tol: f32) -> (f32, Option<u64>, usize) {
        let (mut max, mut first, mut over) = (0f32, None, 0usize);
        for t in from..to {
            let (wl, wr) = self.reference(members, start, t);
            let (l, r) = self.out(t);
            let e = (l - wl).abs().max((r - wr).abs());
            max = max.max(e);
            if e > tol {
                over += 1;
                first.get_or_insert(t);
            }
        }
        (max, first, over)
    }

    /// Writes (`UPDATE_GOLDENS=1`) or compares `golden/<scene>.json` (`scene` is `gate-…`). `group_starts` are the
    /// scene's `(groupId, flags, slipFrames, startFrame)` events; `null` its largest error against
    /// the reference and the bound it is held to.
    pub fn finish(mut self, scene: &str, about: &str, group_starts: &[(u16, u16, u32, u64)], null: (f32, f32)) {
        self.flush_run();
        assert!(scene.starts_with("gate-"), "{scene}: a gate fixture's name");
        let rec = self.rec.take().expect("a recording rig");
        assert!(self.left.iter().chain(&self.right).all(|x| x.is_finite()), "{scene}: finite output");
        assert!(null.0 <= null.1, "{scene}: null {:e} over {:e}", null.0, null.1);
        let starts: Vec<String> = group_starts.iter().map(|g| format!("{{\"groupId\":{},\"flags\":{},\"slipFrames\":{},\"startFrame\":{}}}", g.0, g.1, g.2, g.3)).collect();
        let json = format!(
            "{{\"scene\":\"{scene}\",\"about\":\"{about}\",\"preset\":{{\"maxLogical\":{MAX_LOGICAL},\"maxMixed\":{MAX_MIXED},\"maxBuses\":{MAX_BUSES},\"limiterLookaheadMs\":0,\"maxMusicRings\":{MUSIC_RINGS}}},\"clips\":[{}],\"steps\":[{}],\"frames\":{},\"fnv1a64\":\"{}\",\"groupStarts\":[{}],\"null\":{{\"maxError\":{:e},\"tolerance\":{:e}}}}}\n",
            rec.clips.join(","),
            rec.steps.join(","),
            self.left.len(),
            fnv1a64(&self.left, &self.right),
            starts.join(","),
            null.0,
            null.1,
        );
        let path = format!("{}/../../../../src/plugins/audio/runtime/golden/{scene}.json", env!("CARGO_MANIFEST_DIR"));
        if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") {
            std::fs::write(&path, json).unwrap();
            return;
        }
        let want = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{scene}: no fixture; run UPDATE_GOLDENS=1 cargo test -p audio-core --test gate_mixed --test gate_late (native/audio)"));
        assert!(want == json, "{scene}: the scene no longer matches golden/{scene}.json (rerun with UPDATE_GOLDENS=1 and review the diff)");
    }
}

/// A gated PLAY of `m` in a group with gate `gate`, `at` frames past the batch's first frame.
pub fn play(m: &Member, at: u32, gate: u16) -> Vec<u8> {
    let (clip, stream) = match m.source {
        Source::Clip { id, .. } => (id, false),
        Source::Stream { id, .. } => (id, true),
    };
    let mut flags = wire::PLAY_FLAGS_MIXED;
    if stream {
        flags |= wire::PLAY_FLAGS_STREAM;
    }
    let p = wire::Play { voice_id: m.voice, frame_offset: at, clip, bus: wire::BUS_ROOT as u16, flags, gain: m.gain, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, gate, ..Default::default() };
    let mut b = vec![0u8; wire::Play::FIXED_END];
    p.write(&mut b, 0).unwrap();
    b
}

/// The STATUS block's `groupStarts` as `(groupId, flags, slipFrames, startFrame)`.
pub fn group_starts(s: &StatusBlock) -> Vec<(u16, u16, u32, u64)> {
    s.group_starts.iter().map(|g| (g.group_id, g.flags, g.slip_frames, (g.start_frame_hi as u64) << 32 | g.start_frame_lo as u64)).collect()
}

/// Every member's playhead has advanced `frames` frames: they started on one frame.
pub fn same_playhead(r: &Rig, members: &[Member], frames: u64, what: &str) {
    for m in members {
        let s = r.slot(m.voice);
        assert_eq!(s.state, voices::state::PLAYING, "{what}: member {:#x} plays", m.voice);
        assert_eq!(s.position, frames as f64, "{what}: member {:#x} ({:?})'s playhead", m.voice, m.source);
    }
}
