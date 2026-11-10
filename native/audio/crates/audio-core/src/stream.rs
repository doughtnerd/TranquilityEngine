//! Stream rings (B3, M1b; architecture §2.3, §3.4, §5.1; api-and-models §4.1, §5).
//!
//! A stream is a voice whose PCM arrives while it plays: the decoder worker posts STREAM_OPEN, then
//! STREAM_CHUNKs of at most 4,096 interleaved f32 frames straight to the worklet (main is never on
//! the PCM path), pulled by STREAM_CREDITs the shell sends as frames are consumed. Each open stream
//! holds one **ring** of [`RING_FRAMES`] frames (32,768: the worker keeps `buffered + inFlight`
//! within it, 0.68 s at 48 kHz) in the `Streams` region.
//!
//! **Rings.** [`stream_count`] rings (4 to 16, a quarter of the mixed voices' sixteenths: 4 low,
//! 8 default, 16 high, architecture §5.3), each `RING_FRAMES + MAX_CHUNK_FRAMES` frames of up to 2
//! channels. A ring stores frames at `frame % RING_FRAMES`, interleaved at its stream's channel
//! count. [`chunk_ptr`] hands the shell one contiguous span for a chunk; a chunk that runs past
//! `RING_FRAMES` lands in the tail and [`commit`] copies that part to the ring's start, so the
//! shell's copy is always one `memcpy` (and the tail is never read).
//!
//! **Frames and positions.** `written` counts the frames committed in the stream's epoch; ring frame
//! `f` holds stream frame `start_frame + f`. The voice's `position` is in stream frames, so its
//! playhead is the stream's, and its ring frame is `position - start_frame`. `consumed` is the
//! number of ring frames the voice no longer needs (all but the 4-point resampler's frame behind
//! the read position); [`take_consumed`] reports its growth to the shell, which credits the worker.
//! A chunk that would overwrite unconsumed frames is refused (a worker past its credit).
//!
//! **States** (per ring, for its bound voice; architecture §2.3 Buffering, Playing, Starved,
//! Draining):
//! - `WAITING`: no data yet (PLAY before STREAM_OPEN, or the ring empty). The voice holds silent.
//!   It starts, at its gain (a clean onset, as a clip's PLAY), once [`START_FRAMES`] frames are in,
//!   or the input ended.
//! - `PLAYING`: renders. Each quantum a mixed voice checks it has the quantum plus a 5 ms fade of
//!   data ahead; when it hasn't, it fades out over the frames it still has (`STARVING`), so a
//!   starvation never clicks.
//! - `STARVED`: silent, position held (architecture §7: "hold, silence, 5 ms fade-in on refill");
//!   reported once in STATUS `starved` and as stream event 1. It resumes with a 5 ms fade-in once
//!   [`START_FRAMES`] frames are buffered, or the input ended. A virtual voice keeps time only while
//!   there is data, and starves without a fade (it is silent).
//! - The input ends with a chunk flagged `last` (or a STREAM_CLOSE, which ends it where it is);
//!   the voice then plays out what is buffered (Draining) and ends: stream event 2 (eos), or 3
//!   (error) when the stream was closed before its last chunk.
//!
//! **Lifetime.** STREAM_OPEN takes a free ring (none free: stream event 3, and the voice stays
//! waiting until main stops it). STREAM_CLOSE frees the ring when no voice holds it; otherwise the
//! voice drains and the ring is freed when the voice ends. A voice that ends first leaves its ring
//! orphaned (everything counts as consumed) until STREAM_CLOSE. RESET frees every ring.
//!
//! **Epochs** (B3b's seeks). A chunk whose epoch differs from the ring's is dropped by [`commit`]
//! (`ERR_STALE_EPOCH`); STREAM_OPEN with a new epoch for an open stream restarts its ring at the new
//! `startFrame` ([`open`]). SEEK's flush and fades are B3b's.
//!
//! Loops never leave PLAYING: the worker wraps to the loop start, so the ring sees one continuous
//! signal (the `wrapped` flag is B4's, for gapless trimming). `process` never allocates.

use audio_dsp::ramp::Ramp;
use audio_wire::generated::{self as wire, StreamOpen};

use crate::params::InitParams;

/// Frames in one ring (api-and-models §4.7: "ring 32,768 frames"; the wire's `STREAM_RING_FRAMES`).
pub const RING_FRAMES: usize = wire::STREAM_RING_FRAMES as usize;
/// Most frames in one STREAM_CHUNK (architecture §4.7: 4,096-frame chunks).
pub const MAX_CHUNK_FRAMES: usize = 4_096;
/// Channels a ring stores at most (a stream of more is downmixed by the worker).
pub const RING_CHANNELS: usize = 2;
/// Frames a ring's storage holds: the ring plus a tail a chunk may run into.
pub const RING_STORAGE_FRAMES: usize = RING_FRAMES + MAX_CHUNK_FRAMES;
/// Bytes of one ring's storage (f32 samples).
pub const RING_BYTES: usize = RING_STORAGE_FRAMES * RING_CHANNELS * 4;
/// Fewest and most rings (architecture §5.3: 4 low, 8 default, 16 high).
pub const MIN_STREAMS: usize = 4;
pub const MAX_STREAMS: usize = 16;
/// Frames buffered before a waiting or starved voice starts (one chunk; architecture §4.7 "start on
/// the first chunk").
pub const START_FRAMES: u64 = MAX_CHUNK_FRAMES as u64;
/// The starvation fade and the fade-in on refill (architecture §4.7: 5 ms).
pub const STARVE_FADE_SECONDS: f32 = 0.005;

/// Rings for these parameters: `max_mixed / 16`, clamped to 4..=16 (64 → 4, 128 → 8, 256 → 16).
pub fn stream_count(p: &InitParams) -> usize {
    (p.max_mixed as usize / 16).clamp(MIN_STREAMS, MAX_STREAMS)
}

/// The `Streams` region's size (architecture §5.1: *S* × 32,768 × channels × 4 B, plus the tails).
pub fn region_bytes(p: &InitParams) -> usize {
    stream_count(p) * RING_BYTES
}

/// A ring's phase for its voice (see the module notes).
pub mod phase {
    pub const WAITING: u8 = 0;
    pub const PLAYING: u8 = 1;
    /// Fading out for lack of data; STARVED when the fade settles.
    pub const STARVING: u8 = 2;
    pub const STARVED: u8 = 3;
}

/// What a ring reports at the next STATUS (moved there by `voices::report`).
pub mod pending {
    /// The voice starved: STATUS `starved` and stream event 1.
    pub const STARVED: u8 = 1 << 0;
    /// The voice drained to the end: stream event 2 (or 3 with `ERROR`).
    pub const ENDED: u8 = 1 << 1;
    /// STREAM_OPEN found no free ring, or the stream was closed before its last chunk: event 3.
    pub const ERROR: u8 = 1 << 2;
}

/// One ring's state. All-zero is a free ring.
#[derive(Clone, Copy, Debug, Default)]
pub struct Ring {
    /// Non-zero while open (STREAM_OPEN taken, no STREAM_CLOSE yet, or a voice still draining).
    pub open: u8,
    /// [`phase`].
    pub phase: u8,
    /// [`pending`] bits.
    pub pending: u8,
    /// The input ended: the last chunk arrived (`last`) or STREAM_CLOSE (`closed`).
    pub last: u8,
    pub closed: u8,
    /// Its voice ended before STREAM_CLOSE: everything written counts as consumed.
    pub orphan: u8,
    /// The stream id (STREAM_OPEN `streamId`).
    pub id: u32,
    /// The voice reading it (0 none yet).
    pub voice: u32,
    pub channels: u32,
    pub rate: f32,
    /// STREAM_OPEN `totalFrames` (`STREAM_TOTAL_FRAMES_UNKNOWN` when unknown).
    pub total_frames: u32,
    pub flags: u32,
    pub epoch: u32,
    /// The stream frame ring frame 0 holds.
    pub start_frame: u32,
    /// Frames committed in this epoch, consumed by the voice, and reported consumed.
    pub written: u64,
    pub consumed: u64,
    pub credited: u64,
    /// Frames the last `chunk_ptr` handed out, waiting for their `commit` (0 none).
    pub reserved: u32,
    /// The starvation fade (1 while playing).
    pub gain: Ramp,
    /// Chunks refused (stale epoch, past the credit window, too large); for tests.
    pub refused: u32,
}

impl Ring {
    /// The input ended: no more frames will arrive.
    pub fn input_done(&self) -> bool {
        self.last != 0 || self.closed != 0
    }
}

/// The rings and their storage. Built over the `Streams` region by `Core::new`.
pub struct StreamStore {
    rings: [Ring; MAX_STREAMS],
    count: usize,
    storage: &'static mut [f32],
}

impl Default for StreamStore {
    fn default() -> StreamStore {
        StreamStore { rings: [Ring::default(); MAX_STREAMS], count: 0, storage: &mut [] }
    }
}

impl StreamStore {
    /// The store over `region` (`region_bytes` long, 64-byte aligned, zeroed): `region.len() / RING_BYTES` rings.
    pub fn over(region: &'static mut [u8]) -> StreamStore {
        let count = (region.len() / RING_BYTES).min(MAX_STREAMS);
        // SAFETY: the region is 64-byte aligned (Layout) and a whole number of f32s; all-zero bytes
        // are valid f32s; only this store views it.
        let storage = unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut f32, region.len() / 4) };
        StreamStore { rings: [Ring::default(); MAX_STREAMS], count, storage }
    }

    /// Rings available.
    pub fn capacity(&self) -> usize {
        self.count
    }

    /// The open ring of stream `id`.
    pub fn index_of(&self, id: u32) -> Option<usize> {
        self.rings[..self.count].iter().position(|r| r.open != 0 && r.id == id)
    }

    pub fn ring(&self, index: usize) -> &Ring {
        &self.rings[index]
    }

    pub fn ring_mut(&mut self, index: usize) -> &mut Ring {
        &mut self.rings[index]
    }

    /// The open ring of stream `id`.
    pub fn get(&self, id: u32) -> Option<&Ring> {
        self.index_of(id).map(|i| &self.rings[i])
    }

    /// Open rings.
    pub fn open_count(&self) -> usize {
        self.rings[..self.count].iter().filter(|r| r.open != 0).count()
    }

    /// Ring `index`'s samples (`RING_STORAGE_FRAMES * RING_CHANNELS` f32).
    pub fn samples(&self, index: usize) -> &[f32] {
        let n = RING_STORAGE_FRAMES * RING_CHANNELS;
        &self.storage[index * n..(index + 1) * n]
    }

    /// The ring `index` and its samples at once (the render loop).
    pub fn split(&mut self, index: usize) -> (&mut Ring, &[f32]) {
        let n = RING_STORAGE_FRAMES * RING_CHANNELS;
        (&mut self.rings[index], &self.storage[index * n..(index + 1) * n])
    }

    /// STREAM_OPEN: takes a free ring for the stream, or restarts its ring for a new epoch. Returns
    /// false when no ring is free or the shape is unusable (the caller queues stream event 3).
    pub fn open(&mut self, o: &StreamOpen) -> bool {
        if o.channels == 0 || o.channels as usize > RING_CHANNELS || !(o.sample_rate > 0.0) {
            return false;
        }
        let index = match self.index_of(o.stream_id) {
            Some(i) => {
                if self.rings[i].epoch == o.epoch {
                    return true; // a repeat: nothing changes
                }
                i
            }
            None => match self.rings[..self.count].iter().position(|r| r.open == 0) {
                Some(i) => i,
                None => return false,
            },
        };
        let voice = self.rings[index].voice;
        let r = &mut self.rings[index];
        *r = Ring {
            open: 1,
            id: o.stream_id,
            voice,
            channels: o.channels,
            rate: o.sample_rate,
            total_frames: o.total_frames,
            flags: o.flags,
            epoch: o.epoch,
            start_frame: o.start_frame,
            gain: Ramp::at(1.0),
            ..Ring::default()
        };
        true
    }

    /// STREAM_CLOSE: the input ends; the ring is freed now if no voice holds it, else when it ends.
    pub fn close(&mut self, id: u32) -> bool {
        let Some(i) = self.index_of(id) else { return false };
        let r = &mut self.rings[i];
        if r.voice == 0 || r.orphan != 0 {
            *r = Ring::default();
        } else {
            if r.last == 0 {
                r.pending |= pending::ERROR;
            }
            r.closed = 1;
        }
        true
    }

    /// `voice` (reading stream `id`) ended: its ring is freed if closed, else orphaned.
    pub fn release(&mut self, id: u32, voice: u32) {
        let Some(i) = self.index_of(id) else { return };
        let r = &mut self.rings[i];
        if r.voice != voice && r.voice != 0 {
            return;
        }
        if r.closed != 0 {
            *r = Ring::default();
        } else {
            r.orphan = 1;
            r.consumed = r.written;
        }
    }

    /// RESET: every ring freed.
    pub fn clear(&mut self) {
        for r in self.rings.iter_mut() {
            *r = Ring::default();
        }
    }

    /// `myco_audio_stream_chunk_ptr`: where the shell copies `frames` interleaved f32 frames of
    /// stream `id`, or `Err` (`ERR_UNKNOWN_STREAM`, `ERR_BAD_ARG` for more than a chunk,
    /// `ERR_OVERSIZE` past the credit window).
    pub fn chunk_ptr(&mut self, id: u32, frames: u32) -> Result<*mut u8, i32> {
        let Some(i) = self.index_of(id) else { return Err(wire::ERR_UNKNOWN_STREAM) };
        let n = RING_STORAGE_FRAMES * RING_CHANNELS;
        let r = &mut self.rings[i];
        if frames == 0 || frames as usize > MAX_CHUNK_FRAMES || r.input_done() {
            r.refused += 1;
            return Err(wire::ERR_BAD_ARG);
        }
        if r.written + frames as u64 - r.consumed > RING_FRAMES as u64 {
            r.refused += 1;
            return Err(wire::ERR_OVERSIZE);
        }
        r.reserved = frames;
        let slot = (r.written % RING_FRAMES as u64) as usize;
        let at = i * n + slot * r.channels as usize;
        Ok(self.storage[at..].as_mut_ptr() as *mut u8)
    }

    /// `myco_audio_stream_commit`: the `frames` copied at the last `chunk_ptr` are the stream's next
    /// frames (`frames == 0` with no `chunk_ptr`: only the flags, e.g. an empty last chunk). A chunk
    /// of another epoch is dropped (`ERR_STALE_EPOCH`). `flags` bit0 is `last`.
    pub fn commit(&mut self, id: u32, frames: u32, epoch: u32, flags: u32) -> i32 {
        let Some(i) = self.index_of(id) else { return wire::ERR_UNKNOWN_STREAM };
        let n = RING_STORAGE_FRAMES * RING_CHANNELS;
        let r = &mut self.rings[i];
        let reserved = core::mem::replace(&mut r.reserved, 0);
        if epoch != r.epoch {
            r.refused += 1;
            return wire::ERR_STALE_EPOCH;
        }
        if frames != reserved || r.input_done() {
            r.refused += 1;
            return wire::ERR_BAD_ARG;
        }
        let ch = r.channels as usize;
        let slot = (r.written % RING_FRAMES as u64) as usize;
        let end = slot + frames as usize;
        if end > RING_FRAMES {
            // The part past the ring went to the tail: move it to the ring's start.
            let base = i * n;
            self.storage.copy_within(base + RING_FRAMES * ch..base + end * ch, base);
        }
        let r = &mut self.rings[i];
        r.written += frames as u64;
        if r.orphan != 0 {
            r.consumed = r.written;
        }
        if flags & wire::STREAM_CHUNK_FLAGS_LAST != 0 {
            r.last = 1;
        }
        wire::ERR_OK
    }

    /// `myco_audio_stream_consumed`: ring frames consumed since the last call (the shell's credit), or
    /// `ERR_UNKNOWN_STREAM`.
    pub fn take_consumed(&mut self, id: u32) -> i32 {
        let Some(i) = self.index_of(id) else { return wire::ERR_UNKNOWN_STREAM };
        let r = &mut self.rings[i];
        let delta = r.consumed.saturating_sub(r.credited).min(i32::MAX as u64);
        r.credited += delta;
        delta as i32
    }
}

/// Reads ring frame `f` (`< written`) of a ring with `ch` channels: `(left, right)`, mono copied.
#[inline(always)]
pub fn frame_at(samples: &[f32], ch: usize, f: u64) -> (f32, f32) {
    let at = (f % RING_FRAMES as u64) as usize * ch;
    if ch == 2 {
        (samples[at], samples[at + 1])
    } else {
        let s = samples[at];
        (s, s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(rings: usize) -> StreamStore {
        let bytes = rings * RING_BYTES;
        let l = std::alloc::Layout::from_size_align(bytes, 64).unwrap();
        // SAFETY: non-zero, zeroed, leaked on purpose ('static).
        let region = unsafe { core::slice::from_raw_parts_mut(std::alloc::alloc_zeroed(l), bytes) };
        StreamStore::over(region)
    }

    fn open_rec(id: u32, channels: u32, epoch: u32) -> StreamOpen {
        StreamOpen { stream_id: id, channels, sample_rate: 48_000.0, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, epoch, ..Default::default() }
    }

    fn write(s: &mut StreamStore, id: u32, frames: &[f32], ch: usize, epoch: u32, flags: u32) -> i32 {
        let n = frames.len() / ch;
        match s.chunk_ptr(id, n as u32) {
            Ok(p) => {
                // SAFETY: chunk_ptr handed out room for `n * ch` f32.
                unsafe { core::ptr::copy_nonoverlapping(frames.as_ptr(), p as *mut f32, frames.len()) };
                s.commit(id, n as u32, epoch, flags)
            }
            Err(e) => e,
        }
    }

    #[test]
    fn counts_follow_the_preset() {
        let p = |m| InitParams { sample_rate: 48_000.0, max_logical: 4_096, max_mixed: m, max_buses: 32, arena_initial_bytes: 0 };
        assert_eq!(stream_count(&p(64)), 4);
        assert_eq!(stream_count(&p(128)), 8);
        assert_eq!(stream_count(&p(256)), 16);
        assert_eq!(stream_count(&p(8)), 4);
        assert_eq!(region_bytes(&p(128)), 8 * RING_BYTES);
        assert!(RING_BYTES < 300 * 1024);
    }

    #[test]
    fn open_takes_a_ring_until_none_is_free() {
        let mut s = store(2);
        assert!(s.open(&open_rec(7, 2, 1)));
        assert!(s.open(&open_rec(8, 1, 1)));
        assert!(!s.open(&open_rec(9, 2, 1)), "no free ring");
        assert!(!s.open(&open_rec(10, 3, 1)), "three channels are the worker's to downmix");
        assert!(s.close(7));
        assert!(s.open(&open_rec(9, 2, 1)));
        assert_eq!(s.open_count(), 2);
    }

    #[test]
    fn chunks_wrap_through_the_tail_and_read_back_in_order() {
        let mut s = store(1);
        s.open(&open_rec(1, 2, 1));
        let mut next = 0.0f32;
        let mut total = 0u64;
        // 3,000-frame chunks don't divide the ring: every few chunks one runs into the tail.
        for _ in 0..40 {
            let chunk: Vec<f32> = (0..3_000 * 2).map(|k| next + k as f32).collect();
            next += 6_000.0;
            assert_eq!(write(&mut s, 1, &chunk, 2, 1, 0), wire::ERR_OK);
            total += 3_000;
            // The reader keeps up: everything but the newest 20,000 frames is consumed.
            let r = s.ring_mut(0);
            r.consumed = total.saturating_sub(20_000);
            let samples = s.samples(0);
            for f in (total - 3_000)..total {
                assert_eq!(frame_at(samples, 2, f), ((2 * f) as f32, (2 * f + 1) as f32), "frame {f}");
            }
        }
        assert_eq!(s.ring(0).written, 120_000);
    }

    #[test]
    fn a_chunk_past_the_credit_window_or_of_another_epoch_is_refused() {
        let mut s = store(1);
        s.open(&open_rec(1, 1, 3));
        let chunk = vec![0.5f32; 4_096];
        for _ in 0..8 {
            assert_eq!(write(&mut s, 1, &chunk, 1, 3, 0), wire::ERR_OK);
        }
        assert_eq!(write(&mut s, 1, &chunk, 1, 3, 0), wire::ERR_OVERSIZE, "32,768 frames unconsumed");
        s.ring_mut(0).consumed = 4_096;
        assert_eq!(write(&mut s, 1, &chunk, 1, 2, 0), wire::ERR_STALE_EPOCH);
        assert_eq!(s.ring(0).written, 32_768, "the stale chunk didn't land");
        assert_eq!(write(&mut s, 1, &chunk, 1, 3, wire::STREAM_CHUNK_FLAGS_LAST), wire::ERR_OK);
        assert!(s.ring(0).input_done());
        assert_eq!(write(&mut s, 1, &chunk, 1, 3, 0), wire::ERR_BAD_ARG, "nothing after the last chunk");
        assert_eq!(s.chunk_ptr(99, 16), Err(wire::ERR_UNKNOWN_STREAM));
    }

    #[test]
    fn consumed_frames_are_reported_once() {
        let mut s = store(1);
        s.open(&open_rec(4, 2, 1));
        s.ring_mut(0).consumed = 5_000;
        assert_eq!(s.take_consumed(4), 5_000);
        assert_eq!(s.take_consumed(4), 0);
        s.ring_mut(0).consumed = 9_096;
        assert_eq!(s.take_consumed(4), 4_096);
        assert_eq!(s.take_consumed(5), wire::ERR_UNKNOWN_STREAM);
    }

    #[test]
    fn close_frees_now_or_after_the_voice() {
        let mut s = store(1);
        s.open(&open_rec(1, 2, 1));
        s.ring_mut(0).voice = 0x0001_0003;
        s.close(1);
        assert!(s.get(1).is_some(), "held by its voice");
        assert_ne!(s.ring(0).pending & pending::ERROR, 0, "closed before its last chunk");
        s.release(1, 0x0001_0003);
        assert!(s.get(1).is_none());
        // A voice that ends first orphans the ring until STREAM_CLOSE.
        s.open(&open_rec(2, 2, 1));
        s.ring_mut(0).voice = 0x0001_0004;
        s.release(2, 0x0001_0004);
        assert_eq!(s.ring(0).orphan, 1);
        s.close(2);
        assert!(s.get(2).is_none());
    }

    #[test]
    fn a_new_epoch_restarts_the_ring() {
        let mut s = store(1);
        s.open(&open_rec(1, 2, 1));
        assert_eq!(write(&mut s, 1, &[0.25; 512], 2, 1, 0), wire::ERR_OK);
        assert!(s.open(&StreamOpen { start_frame: 9_000, ..open_rec(1, 2, 2) }));
        let r = s.ring(0);
        assert_eq!((r.written, r.epoch, r.start_frame), (0, 2, 9_000));
    }
}

/// The stream voice end to end inside the core (B3): PLAY, STREAM_OPEN, chunks, the render branch
/// in `voices.rs`, the reports, STREAM_CLOSE.
#[cfg(test)]
mod voice_tests {
    use super::*;
    use crate::voices::{self, state, ASAP};
    use crate::{status, Core, QUANTUM};
    use audio_wire::generated::Play;

    const ID: u32 = 0x0001_0002;
    const STREAM: u32 = 77;
    /// 5 ms at 48 kHz.
    const FADE: usize = 240;

    /// The test core of `voices`, with no limiter look-ahead (output frame = core frame).
    fn core() -> Core {
        let mut core = voices::tests::core();
        assert!(crate::bus::set_limiter_lookahead(&mut core, 0.0));
        core
    }

    /// A ramp a stream sends: frame `k` is `k / 100,000` (left) and `-k / 100,000` (right).
    fn sample(k: u64) -> (f32, f32) {
        let v = (k % 50_000) as f32 / 100_000.0;
        (v, -v)
    }

    fn play(core: &mut Core, mixed: bool) {
        let flags = wire::PLAY_FLAGS_STREAM | wire::PLAY_FLAGS_WANTS_PLAYHEAD | if mixed { wire::PLAY_FLAGS_MIXED } else { 0 };
        voices::play(core, &Play { voice_id: ID, clip: STREAM, flags, gain: 1.0, pitch: 1.0, dir_z: -1.0, ..Default::default() }, ASAP);
    }

    fn open(core: &mut Core) {
        let o = StreamOpen { stream_id: STREAM, channels: 2, sample_rate: 48_000.0, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, epoch: 1, ..Default::default() };
        assert!(core.streams_mut().open(&o));
    }

    /// Feeds stream frames `from..from + n` as one chunk.
    fn feed(core: &mut Core, from: u64, n: usize, last: bool) -> i32 {
        let data: Vec<f32> = (0..n as u64).flat_map(|k| { let (l, r) = sample(from + k); [l, r] }).collect();
        match core.streams_mut().chunk_ptr(STREAM, n as u32) {
            Ok(p) => {
                // SAFETY: room for `n` stereo frames.
                unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), p as *mut f32, data.len()) };
                core.streams_mut().commit(STREAM, n as u32, 1, if last { wire::STREAM_CHUNK_FLAGS_LAST } else { 0 })
            }
            Err(e) => e,
        }
    }

    /// Renders `quanta` quanta from `frame`; returns the left and right outputs.
    fn render(core: &mut Core, frame: &mut u64, quanta: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut l, mut r) = (vec![], vec![]);
        for _ in 0..quanta {
            let out = core.process(*frame).to_vec();
            l.extend_from_slice(&out[..QUANTUM]);
            r.extend_from_slice(&out[QUANTUM..]);
            *frame += QUANTUM as u64;
            status::counters_mut(core).end_block();
        }
        (l, r)
    }

    fn slot(core: &Core) -> voices::VoiceSlot {
        voices::slots(core)[(ID & 0xFFFF) as usize]
    }

    #[test]
    fn a_stream_waits_for_its_first_chunk_then_reads_the_ring_bit_for_bit() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        let (l, _) = render(&mut core, &mut frame, 4);
        assert!(l.iter().all(|s| *s == 0.0), "no STREAM_OPEN yet: silent");
        open(&mut core);
        assert_eq!(feed(&mut core, 0, 2_000, false), wire::ERR_OK);
        render(&mut core, &mut frame, 2);
        assert_eq!(slot(&core).position, 0.0, "less than a chunk buffered: still waiting");
        // 30 chunks: more than the ring, fed as the voice consumes them.
        let mut fed = 2_000u64;
        let (mut l, mut r) = (vec![], vec![]);
        for _ in 0..30 {
            while fed + 4_096 - core.streams().get(STREAM).unwrap().consumed <= RING_FRAMES as u64 {
                assert_eq!(feed(&mut core, fed, 4_096, false), wire::ERR_OK);
                fed += 4_096;
            }
            let (a, b) = render(&mut core, &mut frame, 32);
            l.extend(a);
            r.extend(b);
        }
        for (k, (a, b)) in l.iter().zip(&r).enumerate() {
            let (want_l, want_r) = sample(k as u64);
            assert_eq!((*a, *b), (want_l, want_r), "frame {k}");
        }
        assert!(core.streams().get(STREAM).unwrap().consumed >= l.len() as u64 - 1);
        assert_eq!(status::counters(&core).starved.len(), 0);
    }

    #[test]
    fn starving_fades_out_holds_reports_once_then_fades_back_in_from_the_held_frame() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        open(&mut core);
        assert_eq!(feed(&mut core, 0, 4_096, false), wire::ERR_OK);
        let (l, _) = render(&mut core, &mut frame, 40);
        // Plays the chunk, then fades out over 5 ms before the data ends, and stays silent.
        let first_faded = l.iter().enumerate().position(|(k, s)| *s != sample(k as u64).0).expect("fades");
        assert!(first_faded + FADE + 3 <= 4_096 && first_faded > 3_000, "fade starts at {first_faded}");
        for k in 0..FADE {
            let want = sample((first_faded + k) as u64).0 * (1.0 - (k + 1) as f32 / FADE as f32);
            assert!((l[first_faded + k] - want).abs() < 1e-6, "fade-out frame {k}: {} vs {want}", l[first_faded + k]);
        }
        assert!(l[first_faded + FADE..].iter().all(|s| *s == 0.0), "silent while starved");
        let held = slot(&core).position;
        assert_eq!(held as usize, first_faded + FADE, "the position holds where the fade ended");
        assert_eq!(core.streams().get(STREAM).unwrap().phase, phase::STARVED);
        // Reported once: in the first block after the starve (each render here ends a block).
        let (_, _) = render(&mut core, &mut frame, 4);
        assert_eq!(status::counters(&core).starved.len(), 0, "not again");
        // Data again: a 5 ms fade-in from the held frame.
        assert_eq!(feed(&mut core, 4_096, 4_096, false), wire::ERR_OK);
        let (l, _) = render(&mut core, &mut frame, 4);
        for k in 0..FADE {
            let want = sample(held as u64 + k as u64).0 * ((k + 1) as f32 / FADE as f32);
            assert!((l[k] - want).abs() < 1e-6, "fade-in frame {k}: {} vs {want}", l[k]);
        }
        for k in FADE..l.len() {
            assert_eq!(l[k], sample(held as u64 + k as u64).0, "frame {k} after the fade-in");
        }
    }

    #[test]
    fn the_starve_is_reported_in_status() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        open(&mut core);
        feed(&mut core, 0, 4_096, false);
        let mut starved = vec![];
        let mut events = vec![];
        for _ in 0..40 {
            core.process(frame);
            frame += QUANTUM as u64;
            let c = status::counters_mut(&mut core);
            starved.extend_from_slice(c.starved.as_slice());
            events.extend_from_slice(c.stream_events.as_slice());
            c.end_block();
        }
        assert_eq!(starved, vec![ID]);
        assert_eq!(events, vec![crate::counters::Event { id: STREAM, code: wire::stream_event::STARVED }]);
    }

    #[test]
    fn the_last_chunk_drains_ends_the_voice_and_close_frees_the_ring() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        open(&mut core);
        feed(&mut core, 0, 4_096, false);
        feed(&mut core, 4_096, 1_000, true);
        let mut ended = vec![];
        let mut events = vec![];
        let mut out = vec![];
        for _ in 0..50 {
            let o = core.process(frame).to_vec();
            out.extend_from_slice(&o[..QUANTUM]);
            frame += QUANTUM as u64;
            let c = status::counters_mut(&mut core);
            ended.extend_from_slice(c.ended.as_slice());
            events.extend_from_slice(c.stream_events.as_slice());
            c.end_block();
        }
        for k in 0..5_096 {
            assert_eq!(out[k], sample(k as u64).0, "frame {k}: no starve fade before the end");
        }
        assert!(out[5_096..].iter().all(|s| *s == 0.0));
        assert_eq!(ended, vec![ID]);
        assert_eq!(events, vec![crate::counters::Event { id: STREAM, code: wire::stream_event::EOS }]);
        assert_eq!(core.streams().get(STREAM).unwrap().orphan, 1, "the ring waits for STREAM_CLOSE");
        assert!(core.streams_mut().close(STREAM));
        assert_eq!(core.streams().open_count(), 0);
    }

    #[test]
    fn a_virtual_stream_keeps_time_only_over_its_data() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, false);
        open(&mut core);
        feed(&mut core, 0, 4_096, false);
        let (l, _) = render(&mut core, &mut frame, 40);
        assert!(l.iter().all(|s| *s == 0.0));
        let p = slot(&core).position;
        assert!(p <= 4_094.0 && p > 3_900.0, "held at the data's end: {p}");
        assert_eq!(core.streams().get(STREAM).unwrap().phase, phase::STARVED);
    }

    #[test]
    fn stop_ends_a_waiting_or_starved_stream_at_once_and_the_ring_waits_for_close() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        voices::stop(&mut core, ID, 480);
        render(&mut core, &mut frame, 1);
        assert_eq!(voices::live_count(&mut core), 0, "a waiting stream ends at once");
        play(&mut core, true);
        open(&mut core);
        render(&mut core, &mut frame, 1);
        voices::stop(&mut core, ID, 480);
        render(&mut core, &mut frame, 1);
        assert_eq!(slot(&core).state, state::FREE);
        assert!(core.streams().get(STREAM).is_some());
        core.streams_mut().close(STREAM);
        assert_eq!(core.streams().open_count(), 0);
    }

    #[test]
    fn a_44_1_khz_stream_resamples_like_a_clip() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        let o = StreamOpen { stream_id: STREAM, channels: 1, sample_rate: 44_100.0, total_frames: 20_000, epoch: 1, ..Default::default() };
        assert!(core.streams_mut().open(&o));
        let data: Vec<f32> = (0..8_192).map(|k| libm::sinf(k as f32 * 0.01) * 0.5).collect();
        for (i, c) in data.chunks(4_096).enumerate() {
            let p = core.streams_mut().chunk_ptr(STREAM, 4_096).unwrap();
            // SAFETY: room for 4,096 mono frames.
            unsafe { core::ptr::copy_nonoverlapping(c.as_ptr(), p as *mut f32, 4_096) };
            assert_eq!(core.streams_mut().commit(STREAM, 4_096, 1, (i == 1) as u32), wire::ERR_OK);
        }
        let (l, r) = render(&mut core, &mut frame, 80);
        // The clip resampler over the same samples.
        let mut pos = 0.0f64;
        let steps = vec![44_100.0f32 / 48_000.0; l.len()];
        let (mut want_l, mut want_r) = (vec![0.0; l.len()], vec![0.0; l.len()]);
        let src = audio_dsp::resample::Source { samples: audio_dsp::resample::Samples::F32(&data), channels: 1, frames: 8_192 };
        let n = audio_dsp::resample::lagrange(&src, &mut pos, &steps, false, &mut want_l, &mut want_r);
        for k in 0..n {
            assert!((l[k] - want_l[k]).abs() < 1e-6 && (r[k] - want_r[k]).abs() < 1e-6, "frame {k}: {} vs {}", l[k], want_l[k]);
        }
        assert_eq!(slot(&core).state, state::FREE, "drained and ended");
    }
}
