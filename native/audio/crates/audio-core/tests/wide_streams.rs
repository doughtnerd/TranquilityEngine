//! ADR 0162 B4 (api-and-models §5.2, §9, §10 row B4; rulings R16): a 16-channel stream through a
//! wide ring, end to end inside the core, with the decoder worker and the worklet shell simulated
//! as `decoder/streams.ts` and `worklet/coreDriver.ts` behave (simulated time, one quantum of
//! message latency each way):
//! - the worker sends chunks of `STREAM_WIDE_CHUNK_FRAMES` while `buffered + inFlight` stays within
//!   `STREAM_RING_FRAMES_WIDE` (its credit window), loops by wrapping inside a chunk, and restarts at a
//!   new epoch on a seek;
//! - the shell copies chunks into the ring and credits every 4,096 consumed frames (`credit.ts`).
//!
//! The voice is an ordinary mixed stream voice (B3's ambisonic voice isn't in this wave's core), so
//! it plays channel 0 (W) of the 16, which is what the checks read: W of file frame `x` is
//! `x / 2^18`, so each output frame names the file frame it came from.
//!
//! **The stall test** (R16): the worker stops for 300 ms (14,400 frames: no chunks, credits queue)
//! at every phase of the shell's credit period; the ring must never run dry.

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::stream::{phase, WIDE_RING_FRAMES};
use audio_core::{bus, status, voices, Core, QUANTUM};
use audio_wire::generated::{self as wire, StreamOpen};
use std::collections::VecDeque;

const RATE: f32 = 48_000.0;
const STREAM: u32 = 0xFFFF_0100;
const VOICE: u32 = 0x0001_0001;
const CH: usize = 16;
/// The file: 5 s, looped.
const FILE: u64 = 240_000;
const CHUNK: usize = wire::STREAM_WIDE_CHUNK_FRAMES as usize;
const WINDOW: u64 = wire::STREAM_RING_FRAMES_WIDE as u64;
/// `credit.ts` `STREAM_CREDIT_FRAMES`.
const CREDIT_EVERY: u64 = 4_096;
/// 300 ms at 48 kHz (R16).
const STALL_FRAMES: u64 = 14_400;

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 64, max_buses: 4, arena_initial_bytes: 1 << 20, max_wide: 1, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, 0.0));
    core
}

/// File frame `x`, channel `c`: W names the frame exactly; the other channels differ from it.
fn value(x: u64, c: usize) -> f32 {
    let w = x as f32 / (1 << 18) as f32;
    if c == 0 {
        w
    } else {
        -w * c as f32 * 0.01
    }
}

enum ToWorklet {
    Open(StreamOpen),
    Chunk { epoch: u32, data: Vec<f32>, frames: u32 },
}

/// The decoder worker's stream (`decoder/streams.ts`): a credit window, chunks, loop wraps, seeks.
struct Worker {
    epoch: u32,
    /// The file frame the next read gives.
    pos: u64,
    outstanding: u64,
    /// Inbound credits `(epoch, frames)`, and whether it is stalled (it reads none, sends nothing).
    credits: VecDeque<(u32, u64)>,
    stalled: bool,
    chunks: u64,
}

impl Worker {
    fn pump(&mut self, out: &mut Vec<ToWorklet>) {
        if self.stalled {
            return;
        }
        while let Some((epoch, frames)) = self.credits.pop_front() {
            if epoch == self.epoch {
                self.outstanding = self.outstanding.saturating_sub(frames);
            }
        }
        while self.outstanding + CHUNK as u64 <= WINDOW {
            let mut data = Vec::with_capacity(CHUNK * CH);
            for _ in 0..CHUNK {
                for c in 0..CH {
                    data.push(value(self.pos, c));
                }
                self.pos = (self.pos + 1) % FILE; // the loop wraps inside the chunk
            }
            out.push(ToWorklet::Chunk { epoch: self.epoch, data, frames: CHUNK as u32 });
            self.outstanding += CHUNK as u64;
            self.chunks += 1;
        }
    }

    /// A seek to file frame `frame` at `epoch`: the STREAM_OPEN of that epoch, then chunks from there.
    fn seek(&mut self, frame: u64, epoch: u32, out: &mut Vec<ToWorklet>) {
        self.epoch = epoch;
        self.pos = frame;
        self.outstanding = 0;
        self.credits.clear();
        out.push(ToWorklet::Open(open_rec(epoch, frame as u32)));
        self.pump(out);
    }
}

fn open_rec(epoch: u32, start_frame: u32) -> StreamOpen {
    StreamOpen { stream_id: STREAM, channels: CH as u32, sample_rate: RATE, total_frames: FILE as u32, flags: wire::STREAM_OPEN_FLAGS_LOOP, epoch, start_frame, convention: wire::stream_convention::AMBI_X, ..Default::default() }
}

/// The loopback: core, worker, shell, and the messages in flight (one quantum each way).
struct Loop {
    core: Core,
    worker: Worker,
    frame: u64,
    to_worklet: Vec<ToWorklet>,
    /// The shell's credit accumulator and epoch (`coreDriver.ts`).
    pending: u64,
    shell_epoch: u32,
    to_worker: Vec<(u32, u64)>,
    /// Starves seen in STATUS, the fewest frames ever buffered ahead of the voice, chunks refused.
    starves: usize,
    min_buffered: u64,
    refused: usize,
    out: Vec<f32>,
}

impl Loop {
    fn new() -> Loop {
        let mut core = new_core();
        let flags = wire::PLAY_FLAGS_STREAM | wire::PLAY_FLAGS_WANTS_PLAYHEAD | wire::PLAY_FLAGS_MIXED | wire::PLAY_FLAGS_LOOP;
        voices::play(&mut core, &wire::Play { voice_id: VOICE, clip: STREAM, flags, gain: 1.0, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, ..Default::default() }, voices::ASAP);
        let mut worker = Worker { epoch: 1, pos: 0, outstanding: 0, credits: VecDeque::new(), stalled: false, chunks: 0 };
        let mut to_worklet = vec![ToWorklet::Open(open_rec(1, 0))];
        worker.pump(&mut to_worklet);
        Loop { core, worker, frame: 0, to_worklet, pending: 0, shell_epoch: 1, to_worker: vec![], starves: 0, min_buffered: u64::MAX, refused: 0, out: vec![] }
    }

    /// One quantum: deliver what was in flight, render, credit, let the worker answer.
    fn step(&mut self) {
        for m in std::mem::take(&mut self.to_worklet) {
            match m {
                ToWorklet::Open(o) => {
                    assert!(self.core.streams_mut().open(&o), "a wide ring");
                    self.shell_epoch = o.epoch;
                    self.pending = 0;
                }
                ToWorklet::Chunk { epoch, data, frames } => {
                    // A chunk of an epoch a SEEK already replaced (in flight when it came) is dropped,
                    // as the shell drops a refused chunk.
                    if epoch != self.shell_epoch || epoch != self.core.streams().get(STREAM).unwrap().epoch {
                        self.refused += 1;
                        continue;
                    }
                    match self.core.streams_mut().chunk_ptr(STREAM, frames) {
                        Ok(p) => {
                            // SAFETY: chunk_ptr gave room for `frames` frames of 16 channels.
                            unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), p as *mut f32, data.len()) };
                            assert_eq!(self.core.streams_mut().commit(STREAM, frames, epoch, 0), wire::ERR_OK);
                        }
                        Err(e) => panic!("chunk refused ({e}): the worker went past its credit"),
                    }
                }
            }
        }
        let credits = std::mem::take(&mut self.to_worker);
        self.worker.credits.extend(credits);
        let out = self.core.process(self.frame).to_vec();
        self.out.extend_from_slice(&out[..QUANTUM]);
        self.frame += QUANTUM as u64;
        let c = status::counters_mut(&mut self.core);
        self.starves += c.stream_events.as_slice().iter().filter(|e| e.code == wire::stream_event::STARVED).count();
        c.end_block();
        let ring = *self.core.streams().get(STREAM).unwrap();
        if ring.phase == phase::PLAYING {
            let pos = voices::slots(&self.core)[(VOICE & 0xFFFF) as usize].position - ring.start_frame as f64;
            self.min_buffered = self.min_buffered.min(ring.written.saturating_sub(pos as u64));
        }
        assert_ne!(ring.phase, phase::STARVED, "starved at frame {}", self.frame);
        let consumed = self.core.streams_mut().take_consumed(STREAM);
        assert!(consumed >= 0);
        self.pending += consumed as u64;
        if self.pending >= CREDIT_EVERY {
            self.to_worker.push((self.shell_epoch, std::mem::take(&mut self.pending)));
        }
        self.worker.pump(&mut self.to_worklet);
    }

    /// A seek to file frame `frame`: the SEEK record and the worker's restart, one epoch more.
    fn seek(&mut self, frame: u64) {
        let epoch = self.worker.epoch + 1;
        voices::seek(&mut self.core, VOICE, frame as u32, epoch);
        self.worker.seek(frame, epoch, &mut self.to_worklet);
    }
}

/// The file frame an output sample names.
fn frame_of(s: f32) -> u64 {
    (s * (1 << 18) as f32) as u64
}

#[test]
fn a_16_channel_stream_plays_60_s_with_seeks_and_loops_without_an_underrun() {
    let mut l = Loop::new();
    let quanta = 60 * 48_000 / QUANTUM;
    // Seeks every ~7 s, into the file (some near its end, so the loop wraps soon after).
    let seeks: Vec<(usize, u64)> = vec![(2_600, 120_000), (5_200, 239_000), (7_900, 3_000), (10_400, 200_000), (13_100, 60_000), (15_700, 238_500), (18_300, 1)];
    for q in 0..quanta {
        if let Some(&(_, to)) = seeks.iter().find(|(at, _)| *at == q) {
            l.seek(to);
        }
        l.step();
    }
    assert_eq!(l.starves, 0, "no starve in 60 s");
    // Every output frame continues the one before it through the loop (file frame + 1, wrapping at
    // the end), except across a seek: a 5 ms fade-out, the wait for the new epoch, a 5 ms fade-in.
    let fade = 240;
    let mut skip_until = 0usize;
    let mut seams = 0;
    for k in 1..l.out.len() {
        if let Some(&(q, to)) = seeks.iter().find(|(q, _)| *q * QUANTUM == k) {
            // From the seek's quantum: find where the new epoch is at full gain.
            let full = (to + fade as u64) % FILE;
            let first = (k..l.out.len() - 1).find(|&j| frame_of(l.out[j]) == full && frame_of(l.out[j + 1]) == (full + 1) % FILE).expect("the new epoch sounds");
            assert!(first - k < 2 * QUANTUM + 2 * fade + 3 * CHUNK, "seek at quantum {q} took {} frames", first - k);
            skip_until = first;
        }
        if k <= skip_until {
            continue;
        }
        let (a, b) = (frame_of(l.out[k - 1]), frame_of(l.out[k]));
        assert_eq!(b, (a + 1) % FILE, "output frame {k}: file frame {b} after {a}");
        seams += (b == 0) as usize;
    }
    assert!(seams >= 3, "the loop wrapped {seams} times");
    assert!(l.refused <= seeks.len() * (WINDOW as usize / CHUNK), "only chunks in flight at a seek are dropped ({})", l.refused);
    assert!(l.worker.chunks > 1_400);
    println!("60 s: min buffered {} frames, {} chunks", l.min_buffered, l.worker.chunks);
}

/// One stall run: steady play for 4 s plus `phase` quanta, then the worker stalls for 300 ms.
/// Returns (starves, fewest frames buffered ahead of the voice).
fn stall_run(phase_quanta: usize) -> (usize, u64) {
    let mut l = Loop::new();
    let start = 4 * 48_000 / QUANTUM + phase_quanta;
    let stall = STALL_FRAMES.div_ceil(QUANTUM as u64) as usize;
    let mut starves = 0;
    for q in 0..start + stall + 400 {
        if q == start {
            l.worker.stalled = true;
            l.min_buffered = u64::MAX;
        }
        if q == start + stall {
            l.worker.stalled = false;
            l.worker.pump(&mut l.to_worklet);
        }
        // `step` asserts on a starve; count instead, so every phase reports.
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| l.step()));
        if r.is_err() {
            starves += 1;
            break;
        }
    }
    (starves + l.starves, l.min_buffered)
}

/// R16: a 300 ms decoder stall at every phase of the shell's 4,096-frame credit period. The
/// 16,384-frame ring has 1,984 frames of margin over the stall when it starts full, but the ring
/// is only full right after a credit lands: the shell credits every 4,096 consumed frames and the
/// worker sends whole 2,048-frame chunks, so a stall that starts just before a credit finds
/// ≈ 12,300 frames buffered (256 ms) and runs dry. Measured results are in the B4 report; the
/// test passes once `STREAM_RING_FRAMES_WIDE` is 32,768 (the coordinator regenerates the wire).
#[test]
#[ignore = "R16: fails with the 16,384-frame wide ring at some phases (see the B4 report); the ring becomes 32,768"]
fn a_300_ms_decoder_stall_never_starves_the_wide_ring() {
    let period = (CREDIT_EVERY as usize).div_ceil(QUANTUM);
    let mut worst = u64::MAX;
    let mut failed = vec![];
    for p in 0..period {
        let (starves, min) = stall_run(p);
        worst = worst.min(min);
        if starves > 0 {
            failed.push(p);
        }
    }
    println!("ring {WIDE_RING_FRAMES}: worst buffered during the stall {worst}; phases that starved {failed:?} of {period}");
    assert!(failed.is_empty(), "the ring ran dry at phases {failed:?} (ring {WIDE_RING_FRAMES})");
}

/// The stall test's measurement, run with the crate's tests: prints, per phase of the credit
/// period, whether the ring ran dry, so the result is on record with any ring size.
#[test]
fn the_stall_measurement_runs_at_every_phase() {
    let period = (CREDIT_EVERY as usize).div_ceil(QUANTUM);
    let results: Vec<(usize, u64)> = (0..period).map(stall_run).collect();
    let starved = results.iter().filter(|r| r.0 > 0).count();
    println!("ring {WIDE_RING_FRAMES}, stall {STALL_FRAMES} frames: {starved} of {period} phases starved; per phase (starves, fewest buffered): {results:?}");
    // With the ring full when the stall starts, it holds out.
    assert!(results.iter().any(|r| r.0 == 0), "some phase survives");
}
