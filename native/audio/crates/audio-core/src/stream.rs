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
//! **Epochs and seeks** (B3b; api-and-models §4.1 "Stream seek protocol"). A seek restarts the stream
//! at a new, larger epoch. Two messages carry it and either may arrive first: the SEEK record (main
//! to core, through the batch) and STREAM_OPEN of the new epoch (worker to worklet). The first to
//! arrive restarts the ring ([`StreamStore::open`], [`StreamStore::seek`]): the ring is flushed
//! (`written` 0, the new epoch, the new `start_frame`), so a chunk of any other epoch is refused by
//! [`StreamStore::commit`] (`ERR_STALE_EPOCH`) and nothing from before the seek can reach the ring.
//! A restart for an epoch that is not newer (a late SEEK after a newer OPEN) changes nothing. A
//! SEEK that comes first leaves the ring `awaiting_open` (no chunk is taken until the OPEN of that
//! epoch gives the shape).
//!
//! **The seek fade.** The flushed audio is gone, but the voice is mid-waveform, so the restart
//! first copies the next [`FADE_TAIL_FRAMES`] frames the voice has not read yet to the ring's
//! **tail** area (`seeking`). The voice fades out over 5 ms from that copy, then holds silent
//! while the new epoch's first chunk arrives (`phase::WAITING`) and fades in over 5 ms from the
//! target frame. A seek during a seek fade keeps the first tail; a seek while starved, waiting or
//! virtual has nothing to fade. The playhead jumps to the target when the fade-out ends.
//!
//! **Ring classes** (ADR 0162 B4, R16; api-and-models §4.6, §5.2). A stream of 1-2 channels takes a
//! **narrow** ring (above); one of 3-16 channels (an ambisonic stream: 4, 9 or 16) takes a **wide**
//! ring in the `Wide` region: [`WIDE_RING_FRAMES`] frames (16,384) of up to 16 channels, chunks of at
//! most [`WIDE_CHUNK_FRAMES`] (2,048, 128 KB at 16 channels), `max_wide` of them. STREAM_OPEN with no
//! wide ring free is refused like one with no narrow ring free (stream event 3). Both classes are one
//! store and one code path: ring `i` is narrow below [`StreamStore::narrow_count`] and wide from
//! there, and every ring operation takes its frames, chunk limit and storage from its [`Class`]. A
//! ring's storage holds its frames interleaved at the stream's channel count in either class.
//! [`frame_at`] tells the classes apart by the storage's length; [`tail`] finds a ring's seek-fade
//! copy and [`frame_n`] / [`read_planar`] read N channels (the ambisonic voice's read, B3).
//!
//! Loops never leave PLAYING: the worker wraps to the loop start, so the ring sees one continuous
//! signal (the `wrapped` flag is B4's, for gapless trimming). `process` never allocates.
//!
//! **Splices** (ADR 0158 §4, M2 E4.4: region loops and their release). The worker loops a region by
//! wrapping from `loopEnd` to `loopStart`, up to a ring (0.68 s) ahead of the voice, so a release
//! (or a region change) that must land at the end of the voice's current pass may find that pass's
//! wrap, and the next pass, already in the ring. The worker then restarts the stream at a new epoch
//! whose STREAM_OPEN says *continue*, not *seek*: a restart whose `loopEnd` is not 0 is a splice.
//! Its `startFrame` is the stream frame (on the voice's playhead) where the new epoch's first frame
//! goes, inside what the ring holds; the ring keeps every frame before it, drops the rest and takes
//! the new epoch's chunks from there, with no fade and no wait, so the seam is gapless and lands on
//! that exact frame. `loopStart`/`loopEnd` name the region (the one it loops from there with
//! `loop`, else the one it left); the core needs neither. A splice the voice has already read past
//! (or that isn't in the ring yet) restarts the ring there as a seek does: a 5 ms fade, then the new
//! epoch from `startFrame` (the release lands late, by what the voice had played past it, plus the
//! wait). Plain seeks and first opens keep `loopEnd` 0 on a restart.

use audio_dsp::ramp::Ramp;
use audio_wire::generated::{self as wire, StreamOpen};

use crate::params::InitParams;

/// Frames in one ring (api-and-models §4.7: "ring 32,768 frames"; the wire's `STREAM_RING_FRAMES`).
pub const RING_FRAMES: usize = wire::STREAM_RING_FRAMES as usize;
/// Most frames in one STREAM_CHUNK (architecture §4.7: 4,096-frame chunks).
pub const MAX_CHUNK_FRAMES: usize = 4_096;
/// Channels a narrow ring stores at most (a stream of more takes a wide ring, B4).
pub const RING_CHANNELS: usize = 2;
/// Frames of the seek fade's copy (B3b): the 5 ms fade at 48 kHz is 240 frames, read at up to
/// 6x steps with the resampler's neighbours (a bigger step shortens the fade, never clicks).
pub const FADE_TAIL_FRAMES: usize = 1_536;
/// Frames a ring's storage holds: the ring, a tail a chunk may run into, then the seek fade's copy.
pub const RING_STORAGE_FRAMES: usize = RING_FRAMES + MAX_CHUNK_FRAMES + FADE_TAIL_FRAMES;
/// Where the seek fade's copy starts in a ring's samples (f32 index).
pub const TAIL_OFFSET: usize = (RING_FRAMES + MAX_CHUNK_FRAMES) * RING_CHANNELS;
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

/// ADR 0162 R16 (§5.2): frames of a wide (3-16 channel) ring.
pub const WIDE_RING_FRAMES: usize = wire::STREAM_RING_FRAMES_WIDE as usize;
/// Frames in one chunk of a wide stream (128 KB at 16 channels).
pub const WIDE_CHUNK_FRAMES: usize = wire::STREAM_WIDE_CHUNK_FRAMES as usize;
/// Channels a wide ring stores.
pub const WIDE_CHANNELS: usize = wire::STREAM_MAX_CHANNELS as usize;
/// Bytes of one wide ring's storage: the ring, a chunk's tail and the seek fade's copy, 16 channels
/// of f32 (C8: 16 × (16,384 + 2,048 + 1,536) × 4 B = 1.22 MiB).
pub const WIDE_RING_BYTES: usize = WIDE_CHANNELS * (WIDE_RING_FRAMES + WIDE_CHUNK_FRAMES + FADE_TAIL_FRAMES) * 4;

/// The `Wide` region's size (C8): `max_wide` wide rings. K2 lays it out; B4 gives it its ring class.
pub const fn wide_region_bytes(p: &InitParams) -> usize {
    p.max_wide as usize * WIDE_RING_BYTES
}

/// Most wide rings (`InitParams::MAX_WIDE`).
pub const MAX_WIDE: usize = InitParams::MAX_WIDE as usize;
/// Most rings of both classes.
const MAX_RINGS: usize = MAX_STREAMS + MAX_WIDE;

/// A ring class's shape (B4): its frames, its largest chunk and the channels its storage holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Class {
    pub frames: usize,
    pub chunk: usize,
    pub channels: usize,
}

impl Class {
    /// f32s of one ring's storage: the ring, a chunk's tail, the seek fade's copy.
    pub const fn floats(self) -> usize {
        (self.frames + self.chunk + FADE_TAIL_FRAMES) * self.channels
    }
    /// Where the seek fade's copy starts (f32 index).
    pub const fn tail_offset(self) -> usize {
        (self.frames + self.chunk) * self.channels
    }
}

/// The narrow class: 1-2 channels, 32,768 frames, 4,096-frame chunks.
pub const NARROW: Class = Class { frames: RING_FRAMES, chunk: MAX_CHUNK_FRAMES, channels: RING_CHANNELS };
/// The wide class (R16): 3-16 channels, 16,384 frames, 2,048-frame chunks.
pub const WIDE: Class = Class { frames: WIDE_RING_FRAMES, chunk: WIDE_CHUNK_FRAMES, channels: WIDE_CHANNELS };

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
    /// B3b: 0, or the voice is fading out the old epoch's audio from the tail copy: 1 until the
    /// voice starts the fade, 2 while it runs.
    pub seeking: u8,
    /// A SEEK restarted the ring before the new epoch's STREAM_OPEN gave the shape.
    pub awaiting_open: u8,
    /// The voice fades in when this epoch starts (a seek, not a first start).
    pub fade_in: u8,
    /// The seek fade's copy: its frame count, the stream frame of its first frame, its channels.
    pub tail_len: u32,
    pub tail_frame0: u32,
    pub tail_channels: u32,
    /// Splices taken (E4.4; see the module notes); for tests.
    pub splices: u32,
}

impl Ring {
    /// The input ended: no more frames will arrive.
    pub fn input_done(&self) -> bool {
        self.last != 0 || self.closed != 0
    }
}

/// The rings and their storage. Built over the `Streams` and `Wide` regions by `Core::new`.
pub struct StreamStore {
    rings: [Ring; MAX_RINGS],
    /// Narrow rings (`0..count`), then wide rings (`count..count + wide`).
    count: usize,
    wide: usize,
    storage: &'static mut [f32],
    wide_storage: &'static mut [f32],
}

impl Default for StreamStore {
    fn default() -> StreamStore {
        StreamStore { rings: [Ring::default(); MAX_RINGS], count: 0, wide: 0, storage: &mut [], wide_storage: &mut [] }
    }
}

/// `region` (64-byte aligned, zeroed, a whole number of f32s) as f32s.
fn floats(region: &'static mut [u8]) -> &'static mut [f32] {
    if region.len() < 4 {
        return &mut []; // an empty region's pointer needn't be aligned
    }
    // SAFETY: the region is 64-byte aligned (Layout) and a whole number of f32s; all-zero bytes are
    // valid f32s; only this store views it.
    unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut f32, region.len() / 4) }
}

impl StreamStore {
    /// The store over the `Streams` region (`region_bytes` long: `len / RING_BYTES` narrow rings) and
    /// the `Wide` region (`wide_region_bytes`: `len / WIDE_RING_BYTES` wide rings), both 64-byte
    /// aligned and zeroed.
    pub fn over(region: &'static mut [u8], wide: &'static mut [u8]) -> StreamStore {
        let count = (region.len() / RING_BYTES).min(MAX_STREAMS);
        let wide_count = (wide.len() / WIDE_RING_BYTES).min(MAX_WIDE);
        StreamStore { rings: [Ring::default(); MAX_RINGS], count, wide: wide_count, storage: floats(region), wide_storage: floats(wide) }
    }

    /// Rings available, both classes (ring indices are `0..capacity()`).
    pub fn capacity(&self) -> usize {
        self.count + self.wide
    }

    /// Narrow rings: ring `i` is wide from here.
    pub fn narrow_count(&self) -> usize {
        self.count
    }

    /// Ring `i`'s class.
    pub fn class(&self, i: usize) -> Class {
        if i < self.count {
            NARROW
        } else {
            WIDE
        }
    }

    /// Ring `i`'s class and storage.
    fn parts(&mut self, i: usize) -> (&mut Ring, &mut [f32], Class) {
        let (storage, k, c) = if i < self.count { (&mut *self.storage, i, NARROW) } else { (&mut *self.wide_storage, i - self.count, WIDE) };
        let n = c.floats();
        (&mut self.rings[i], &mut storage[k * n..(k + 1) * n], c)
    }

    /// The open ring of stream `id`.
    pub fn index_of(&self, id: u32) -> Option<usize> {
        self.rings[..self.capacity()].iter().position(|r| r.open != 0 && r.id == id)
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
        self.rings[..self.capacity()].iter().filter(|r| r.open != 0).count()
    }

    /// Ring `index`'s samples (its class's [`Class::floats`] f32).
    pub fn samples(&self, index: usize) -> &[f32] {
        let (storage, k) = if index < self.count { (&*self.storage, index) } else { (&*self.wide_storage, index - self.count) };
        let n = self.class(index).floats();
        &storage[k * n..(k + 1) * n]
    }

    /// The ring `index` and its samples at once (the render loop).
    pub fn split(&mut self, index: usize) -> (&mut Ring, &[f32]) {
        let (ring, samples, _) = self.parts(index);
        (ring, samples)
    }

    /// STREAM_OPEN: takes a free ring for the stream, or restarts its ring for a new epoch (a
    /// repeat, or an older epoch, changes nothing; a seek's SEEK may have restarted it already,
    /// then this gives the shape). Returns false when no ring is free or the shape is unusable
    /// (the caller queues stream event 3).
    pub fn open(&mut self, o: &StreamOpen) -> bool {
        if o.channels == 0 || o.channels as usize > WIDE_CHANNELS || !(o.sample_rate > 0.0) {
            return false;
        }
        // B4: 1-2 channels take a narrow ring, 3-16 a wide one.
        let wide = o.channels as usize > RING_CHANNELS;
        match self.index_of(o.stream_id) {
            Some(i) => {
                if wide != (i >= self.count) {
                    return false; // a restart can't change the class
                }
                let r = &mut self.rings[i];
                if r.epoch == o.epoch {
                    if r.awaiting_open != 0 {
                        r.awaiting_open = 0;
                        r.channels = o.channels;
                        r.rate = o.sample_rate;
                        r.total_frames = o.total_frames;
                        r.flags = o.flags;
                        r.start_frame = o.start_frame;
                    }
                    return true; // a repeat: nothing changes
                }
                if newer(o.epoch, r.epoch) && !(o.loop_end != 0 && self.splice(i, o)) {
                    self.restart(i, o.epoch, o.start_frame, Some(o));
                }
                true
            }
            None => match (if wide { self.count..self.capacity() } else { 0..self.count }).find(|&i| self.rings[i].open == 0) {
                Some(i) => {
                    self.rings[i] = Ring {
                        open: 1,
                        id: o.stream_id,
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
                None => false,
            },
        }
    }

    /// SEEK of stream `id` (B3b): restarts its ring at `epoch` and stream frame `frame` now, ahead
    /// of the worker's STREAM_OPEN of that epoch. An epoch that is not newer than the ring's (the
    /// OPEN came first, or a late SEEK) or a closed stream changes nothing. Returns false for an
    /// unknown stream.
    pub fn seek(&mut self, id: u32, epoch: u32, frame: u32) -> bool {
        let Some(i) = self.index_of(id) else { return false };
        if newer(epoch, self.rings[i].epoch) {
            self.restart(i, epoch, frame, None);
        }
        true
    }

    /// Flushes ring `i` for `epoch` starting at stream frame `start_frame` (`shape` from its
    /// STREAM_OPEN, or none: the SEEK came first and the ring awaits it). Copies what the voice
    /// would read next to the tail for the seek fade unless it is fading already. A closed stream
    /// keeps its ring as it is (it is draining toward its end).
    fn restart(&mut self, i: usize, epoch: u32, start_frame: u32, shape: Option<&StreamOpen>) {
        let old = self.rings[i];
        if old.closed != 0 {
            return;
        }
        let mut ring = Ring {
            open: 1,
            id: old.id,
            voice: old.voice,
            channels: old.channels,
            rate: old.rate,
            total_frames: old.total_frames,
            flags: old.flags,
            epoch,
            start_frame,
            gain: Ramp::at(1.0),
            awaiting_open: shape.is_none() as u8,
            fade_in: 1,
            seeking: old.seeking,
            tail_len: old.tail_len,
            tail_frame0: old.tail_frame0,
            tail_channels: old.tail_channels,
            ..Ring::default()
        };
        if let Some(o) = shape {
            ring.channels = o.channels;
            ring.rate = o.sample_rate;
            ring.total_frames = o.total_frames;
            ring.flags = o.flags;
        }
        if old.seeking != 0 {
            ring.gain = old.gain; // the earlier fade-out goes on
        } else if old.voice != 0
            && old.orphan == 0
            && (old.phase == phase::PLAYING || old.phase == phase::STARVING)
            && old.written > old.consumed
        {
            let from = old.consumed;
            let len = (old.written - from).min(FADE_TAIL_FRAMES as u64);
            let ch = old.channels as usize;
            let (_, storage, c) = self.parts(i);
            for f in 0..len as usize {
                let src = ((from + f as u64) % c.frames as u64) as usize * ch;
                storage.copy_within(src..src + ch, c.tail_offset() + f * ch);
            }
            ring.seeking = 1;
            ring.tail_len = len as u32;
            ring.tail_frame0 = old.start_frame.wrapping_add(from as u32);
            ring.tail_channels = old.channels;
            ring.gain = old.gain;
        }
        self.rings[i] = ring;
    }

    /// A splice (see the module notes): ring `i` keeps its frames before stream frame
    /// `o.start_frame` and takes epoch `o.epoch`'s chunks from there. False (the caller restarts the
    /// ring instead) when the voice has read that frame already (it reads up to 3 frames past
    /// `consumed`), the ring doesn't hold it, or the ring is closed, seeking or awaiting an OPEN.
    fn splice(&mut self, i: usize, o: &StreamOpen) -> bool {
        let r = &mut self.rings[i];
        if r.closed != 0 || r.orphan != 0 || r.seeking != 0 || r.awaiting_open != 0 || o.start_frame < r.start_frame {
            return false;
        }
        let at = (o.start_frame - r.start_frame) as u64;
        if at > r.written || at < r.consumed + 4 || o.channels != r.channels {
            return false;
        }
        r.epoch = o.epoch;
        r.written = at;
        r.reserved = 0;
        r.last = 0;
        r.flags = o.flags;
        r.total_frames = o.total_frames;
        r.splices = r.splices.wrapping_add(1);
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
        let (r, storage, c) = self.parts(i);
        if frames == 0 || frames as usize > c.chunk || r.input_done() || r.awaiting_open != 0 {
            r.refused += 1;
            return Err(wire::ERR_BAD_ARG);
        }
        if r.written + frames as u64 - r.consumed > c.frames as u64 {
            r.refused += 1;
            return Err(wire::ERR_OVERSIZE);
        }
        r.reserved = frames;
        let slot = (r.written % c.frames as u64) as usize;
        Ok(storage[slot * r.channels as usize..].as_mut_ptr() as *mut u8)
    }

    /// `myco_audio_stream_commit`: the `frames` copied at the last `chunk_ptr` are the stream's next
    /// frames (`frames == 0` with no `chunk_ptr`: only the flags, e.g. an empty last chunk). A chunk
    /// of another epoch is dropped (`ERR_STALE_EPOCH`). `flags` bit0 is `last`.
    pub fn commit(&mut self, id: u32, frames: u32, epoch: u32, flags: u32) -> i32 {
        let Some(i) = self.index_of(id) else { return wire::ERR_UNKNOWN_STREAM };
        let (r, storage, c) = self.parts(i);
        let reserved = core::mem::replace(&mut r.reserved, 0);
        if epoch != r.epoch {
            r.refused += 1;
            return wire::ERR_STALE_EPOCH;
        }
        if frames != reserved || r.input_done() || r.awaiting_open != 0 {
            r.refused += 1;
            return wire::ERR_BAD_ARG;
        }
        let ch = r.channels as usize;
        let slot = (r.written % c.frames as u64) as usize;
        let end = slot + frames as usize;
        if end > c.frames {
            // The part past the ring went to the tail: move it to the ring's start.
            storage.copy_within(c.frames * ch..end * ch, 0);
        }
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

/// `a` is a later epoch than `b` (epochs only grow; the comparison wraps).
fn newer(a: u32, b: u32) -> bool {
    a != b && (a.wrapping_sub(b) as i32) > 0
}

/// Where ring frame `f` of a ring's storage `samples` starts (f32 index, `ch` channels). The class
/// follows from the storage's length (a wide ring's is the longer); a seek-fade copy ([`tail`]) is
/// shorter than either, and its frames (under 1,536) are below both rings' lengths.
#[inline(always)]
fn slot_at(samples: &[f32], ch: usize, f: u64) -> usize {
    // Both lengths are powers of two: the index is a mask.
    let frames = if samples.len() > NARROW.floats() { WIDE_RING_FRAMES } else { RING_FRAMES } as u64;
    (f & (frames - 1)) as usize * ch
}
const _: () = assert!(RING_FRAMES.is_power_of_two() && WIDE_RING_FRAMES.is_power_of_two());

/// Reads ring frame `f` (`< written`) of a ring with `ch` channels: `(left, right)`, mono copied
/// (and channel 0 of a wide ring, B4: its W).
#[inline(always)]
pub fn frame_at(samples: &[f32], ch: usize, f: u64) -> (f32, f32) {
    let at = slot_at(samples, ch, f);
    if ch == 2 {
        (samples[at], samples[at + 1])
    } else {
        let s = samples[at];
        (s, s)
    }
}

/// B4: ring frame `f`'s `ch` interleaved samples, either class (the N-channel [`frame_at`]).
#[inline(always)]
pub fn frame_n(samples: &[f32], ch: usize, f: u64) -> &[f32] {
    let at = slot_at(samples, ch, f);
    &samples[at..at + ch]
}

/// B4: the seek fade's copy in a ring's storage `samples`, either class (a voice reads it with
/// [`frame_at`] / [`frame_n`] at the ring's `tail_channels`). The narrow class's is `TAIL_OFFSET`.
pub fn tail(samples: &[f32]) -> &[f32] {
    &samples[if samples.len() > NARROW.floats() { WIDE.tail_offset() } else { TAIL_OFFSET }..]
}

/// B4 (for B3's ambisonic stream voice): one output frame `i` of an N-channel stream read, the
/// stream voice's 4-point Lagrange (`resample::weights(t)`) over ring frames `idx - 1 ..= idx + 2`
/// (clamped to `0..=last`), times `g`, channel `c` into `out[c * len + i]` (planar rows of `len`, as
/// `resample::lagrange_n`). `samples` is a ring's storage (or its [`tail`]) holding `ch` channels.
#[allow(clippy::too_many_arguments)]
pub fn read_planar(samples: &[f32], ch: usize, idx: u64, t: f32, last: u64, g: f32, out: &mut [f32], len: usize, i: usize) {
    let w = audio_dsp::resample::weights(t);
    let a = frame_n(samples, ch, idx.saturating_sub(1).min(last));
    let b = frame_n(samples, ch, idx.min(last));
    let c = frame_n(samples, ch, (idx + 1).min(last));
    let d = frame_n(samples, ch, (idx + 2).min(last));
    for k in 0..ch {
        out[k * len + i] = (w[0] * a[k] + w[1] * b[k] + w[2] * c[k] + w[3] * d[k]) * g;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A zeroed, 64-byte aligned region of `bytes`, leaked ('static).
    fn region(bytes: usize) -> &'static mut [u8] {
        if bytes == 0 {
            return &mut [];
        }
        let l = std::alloc::Layout::from_size_align(bytes, 64).unwrap();
        // SAFETY: non-zero, zeroed, leaked on purpose ('static).
        unsafe { core::slice::from_raw_parts_mut(std::alloc::alloc_zeroed(l), bytes) }
    }

    fn store(rings: usize) -> StreamStore {
        StreamStore::over(region(rings * RING_BYTES), &mut [])
    }

    fn stores(narrow: usize, wide: usize) -> StreamStore {
        StreamStore::over(region(narrow * RING_BYTES), region(wide * WIDE_RING_BYTES))
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
        let p = |m| InitParams { sample_rate: 48_000.0, max_logical: 4_096, max_mixed: m, max_buses: 32, arena_initial_bytes: 0, ..InitParams::default() };
        assert_eq!(stream_count(&p(64)), 4);
        assert_eq!(stream_count(&p(128)), 8);
        assert_eq!(stream_count(&p(256)), 16);
        assert_eq!(stream_count(&p(8)), 4);
        assert_eq!(region_bytes(&p(128)), 8 * RING_BYTES);
        assert!(RING_BYTES < 320 * 1024);
    }

    #[test]
    fn open_takes_a_ring_until_none_is_free() {
        let mut s = store(2);
        assert!(s.open(&open_rec(7, 2, 1)));
        assert!(s.open(&open_rec(8, 1, 1)));
        assert!(!s.open(&open_rec(9, 2, 1)), "no free ring");
        assert!(!s.open(&open_rec(10, 3, 1)), "three channels need a wide ring, and there is none");
        assert!(s.close(7));
        assert!(s.open(&open_rec(9, 2, 1)));
        assert_eq!(s.open_count(), 2);
    }

    #[test]
    fn wide_streams_take_wide_rings_and_narrow_ones_narrow_rings() {
        let mut s = stores(1, 2);
        assert_eq!((s.capacity(), s.narrow_count()), (3, 1));
        assert!(s.open(&open_rec(1, 16, 1)));
        assert!(s.open(&open_rec(2, 2, 1)));
        assert!(s.open(&open_rec(3, 4, 1)));
        assert_eq!((s.index_of(1), s.index_of(2), s.index_of(3)), (Some(1), Some(0), Some(2)));
        assert!(!s.open(&open_rec(4, 9, 1)), "no wide ring free");
        assert!(!s.open(&open_rec(5, 1, 1)), "no narrow ring free");
        assert!(!s.open(&open_rec(6, 17, 1)), "17 channels");
        assert!(!s.open(&open_rec(1, 2, 2)), "a restart can't move a stream to the other class");
        assert_eq!(s.class(1), WIDE);
        s.close(1);
        assert!(s.open(&open_rec(4, 9, 1)));
        // Without a `Wide` region, a wide stream is refused.
        assert!(!store(2).open(&open_rec(1, 4, 1)));
    }

    #[test]
    fn wide_chunks_are_2048_frames_at_most_wrap_and_keep_within_16384() {
        let mut s = stores(0, 1);
        assert!(s.open(&open_rec(1, 16, 1)));
        let ch = 16;
        assert_eq!(write(&mut s, 1, &vec![0.0; 2_049 * ch], ch, 1, 0), wire::ERR_BAD_ARG, "more than a wide chunk");
        let mut total = 0u64;
        // 1,500-frame chunks don't divide the ring: some run into the tail.
        for _ in 0..60 {
            let chunk: Vec<f32> = (0..1_500 * ch as u64).map(|k| (total * ch as u64 + k) as f32).collect();
            assert_eq!(write(&mut s, 1, &chunk, ch, 1, 0), wire::ERR_OK);
            total += 1_500;
            let samples = s.samples(0);
            assert_eq!(samples.len(), WIDE.floats());
            for f in (total - 1_500)..total {
                let want: Vec<f32> = (0..ch as u64).map(|c| (f * ch as u64 + c) as f32).collect();
                assert_eq!(frame_n(samples, ch, f), &want[..], "frame {f}");
                assert_eq!(frame_at(samples, ch, f).0, want[0]);
            }
            s.ring_mut(0).consumed = total.saturating_sub(12_000);
        }
        // The window: 16,384 frames unconsumed at most.
        s.ring_mut(0).consumed = total - 14_000;
        assert_eq!(write(&mut s, 1, &vec![0.0; 2_048 * ch], ch, 1, 0), wire::ERR_OK);
        assert_eq!(write(&mut s, 1, &vec![0.0; 1_000 * ch], ch, 1, 0), wire::ERR_OVERSIZE);
    }

    #[test]
    fn a_wide_restart_copies_the_unread_frames_to_its_own_tail() {
        let mut s = stores(1, 1);
        assert!(s.open(&open_rec(1, 9, 1)));
        let ch = 9;
        let ramp: Vec<f32> = (0..2_000 * ch).map(|k| k as f32).collect();
        assert_eq!(write(&mut s, 1, &ramp, ch, 1, 0), wire::ERR_OK);
        let r = s.ring_mut(1);
        r.voice = 0x0001_0003;
        r.phase = phase::PLAYING;
        r.consumed = 100;
        assert!(s.seek(1, 2, 9_000));
        let r = *s.ring(1);
        assert_eq!((r.seeking, r.tail_len, r.tail_frame0, r.tail_channels), (1, FADE_TAIL_FRAMES as u32, 100, 9));
        let t = tail(s.samples(1));
        for f in 0..FADE_TAIL_FRAMES as u64 {
            let want: Vec<f32> = (0..ch).map(|c| ((100 + f as usize) * ch + c) as f32).collect();
            assert_eq!(frame_n(t, ch, f), &want[..], "tail frame {f}");
        }
        assert_eq!(tail(s.samples(0)).len(), FADE_TAIL_FRAMES * RING_CHANNELS, "a narrow ring's tail is TAIL_OFFSET on");
    }

    #[test]
    fn read_planar_is_the_stream_voices_lagrange_per_channel() {
        let mut s = stores(0, 1);
        assert!(s.open(&open_rec(1, 4, 1)));
        let data: Vec<f32> = (0..64 * 4).map(|k| libm::sinf(k as f32 * 0.37)).collect();
        assert_eq!(write(&mut s, 1, &data, 4, 1, 0), wire::ERR_OK);
        let samples = s.samples(0);
        let mut out = [0.0f32; 4 * 8];
        for i in 0..8 {
            read_planar(samples, 4, 10 + i as u64, 0.25, 63, 0.5, &mut out, 8, i);
        }
        let w = audio_dsp::resample::weights(0.25);
        for c in 0..4 {
            for i in 0..8 {
                let x = |f: usize| data[f * 4 + c];
                let want = (w[0] * x(9 + i) + w[1] * x(10 + i) + w[2] * x(11 + i) + w[3] * x(12 + i)) * 0.5;
                assert_eq!(out[c * 8 + i], want, "channel {c} frame {i}");
            }
        }
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

    #[test]
    fn a_seek_before_its_open_flushes_the_ring_and_waits_for_the_shape() {
        let mut s = store(1);
        s.open(&open_rec(1, 2, 1));
        assert_eq!(write(&mut s, 1, &[0.25; 512], 2, 1, 0), wire::ERR_OK);
        assert!(s.seek(1, 2, 7_000));
        let r = s.ring(0);
        assert_eq!((r.written, r.consumed, r.epoch, r.start_frame, r.awaiting_open), (0, 0, 2, 7_000, 1));
        // The old epoch's chunk (in flight when the seek came) can't land, nor can any before the OPEN.
        assert_eq!(write(&mut s, 1, &[0.5; 512], 2, 1, 0), wire::ERR_BAD_ARG, "awaiting the OPEN");
        assert_eq!(write(&mut s, 1, &[0.5; 512], 2, 2, 0), wire::ERR_BAD_ARG);
        // The OPEN of that epoch gives the shape and keeps the ring (nothing flushed twice).
        assert!(s.open(&StreamOpen { start_frame: 7_000, total_frames: 99_000, ..open_rec(1, 2, 2) }));
        let r = s.ring(0);
        assert_eq!((r.awaiting_open, r.start_frame, r.total_frames), (0, 7_000, 99_000));
        assert_eq!(write(&mut s, 1, &[0.5; 512], 2, 1, 0), wire::ERR_STALE_EPOCH, "the old epoch is dropped");
        assert_eq!(write(&mut s, 1, &[0.5; 512], 2, 2, 0), wire::ERR_OK);
        assert_eq!(s.ring(0).written, 256);
        // A repeat of the SEEK (or of the OPEN) changes nothing.
        assert!(s.seek(1, 2, 7_000));
        assert!(s.open(&open_rec(1, 2, 2)));
        assert_eq!(s.ring(0).written, 256);
    }

    #[test]
    fn a_splice_keeps_the_ring_before_its_frame_and_takes_the_new_epoch_from_there() {
        let mut s = store(1);
        s.open(&StreamOpen { start_frame: 1_000, ..open_rec(1, 1, 1) });
        let ramp: Vec<f32> = (0..8_000).map(|k| k as f32).collect();
        assert_eq!(write(&mut s, 1, &ramp[..4_096], 1, 1, 0), wire::ERR_OK);
        assert_eq!(write(&mut s, 1, &ramp[4_096..], 1, 1, 0), wire::ERR_OK);
        s.ring_mut(0).voice = 0x0001_0003;
        s.ring_mut(0).phase = phase::PLAYING;
        s.ring_mut(0).consumed = 2_000;
        s.ring_mut(0).credited = 1_500;
        // Continue at stream frame 7,000 (ring frame 6,000): epoch 2, and `loopEnd` names the region left.
        assert!(s.open(&StreamOpen { start_frame: 7_000, loop_start: 100, loop_end: 7_000, ..open_rec(1, 1, 2) }));
        let r = *s.ring(0);
        assert_eq!((r.epoch, r.start_frame, r.written, r.consumed, r.credited, r.seeking, r.splices), (2, 1_000, 6_000, 2_000, 1_500, 0, 1));
        assert_eq!(write(&mut s, 1, &[-1.0; 512], 1, 1, 0), wire::ERR_STALE_EPOCH, "the old epoch's chunks are dropped");
        assert_eq!(write(&mut s, 1, &[-1.0; 512], 1, 2, 0), wire::ERR_OK);
        let samples = s.samples(0);
        assert_eq!(frame_at(samples, 1, 5_999).0, 5_999.0, "kept");
        assert_eq!(frame_at(samples, 1, 6_000).0, -1.0, "the new epoch from the splice");
        assert_eq!(s.ring(0).written, 6_512);
    }

    #[test]
    fn a_splice_the_voice_has_read_or_that_the_ring_lacks_restarts_it_as_a_seek() {
        for (at, consumed) in [(1_000 + 2_003, 2_000), (1_000 + 9_000, 2_000)] {
            let mut s = store(1);
            s.open(&StreamOpen { start_frame: 1_000, ..open_rec(1, 1, 1) });
            assert_eq!(write(&mut s, 1, &[0.25; 4_096], 1, 1, 0), wire::ERR_OK);
            let r = s.ring_mut(0);
            r.voice = 0x0001_0003;
            r.phase = phase::PLAYING;
            r.consumed = consumed;
            assert!(s.open(&StreamOpen { start_frame: at, loop_end: 7_000, ..open_rec(1, 1, 2) }));
            let r = *s.ring(0);
            assert_eq!((r.epoch, r.start_frame, r.written, r.splices, r.seeking), (2, at, 0, 0, 1), "at {at}");
        }
        // A restart with `loopEnd` 0 is a seek, wherever it lands.
        let mut s = store(1);
        s.open(&open_rec(1, 1, 1));
        assert_eq!(write(&mut s, 1, &[0.25; 4_096], 1, 1, 0), wire::ERR_OK);
        assert!(s.open(&StreamOpen { start_frame: 3_000, ..open_rec(1, 1, 2) }));
        assert_eq!((s.ring(0).start_frame, s.ring(0).written, s.ring(0).splices), (3_000, 0, 0));
    }

    #[test]
    fn an_older_epoch_never_restarts_a_ring() {
        let mut s = store(1);
        s.open(&open_rec(1, 2, 1));
        // The OPEN of epoch 3 came before the SEEK of epoch 2 (two quick seeks, two channels).
        assert!(s.open(&StreamOpen { start_frame: 300, ..open_rec(1, 2, 3) }));
        assert_eq!(write(&mut s, 1, &[0.5; 64], 2, 3, 0), wire::ERR_OK);
        assert!(s.seek(1, 2, 200));
        assert!(s.open(&StreamOpen { start_frame: 200, ..open_rec(1, 2, 2) }));
        let r = s.ring(0);
        assert_eq!((r.epoch, r.start_frame, r.written), (3, 300, 32));
        assert!(!s.seek(9, 4, 0), "an unknown stream");
        assert!(newer(1, 0xFFFF_FFFF), "epochs wrap");
    }

    #[test]
    fn a_closed_stream_keeps_draining_through_a_seek() {
        let mut s = store(1);
        s.open(&open_rec(1, 2, 1));
        s.ring_mut(0).voice = 0x0001_0003;
        assert_eq!(write(&mut s, 1, &[0.5; 64], 2, 1, 0), wire::ERR_OK);
        s.close(1);
        s.seek(1, 2, 0);
        assert_eq!((s.ring(0).epoch, s.ring(0).written, s.ring(0).closed), (1, 32, 1));
    }

    #[test]
    fn a_restart_copies_the_unread_audio_for_the_fade_once() {
        let mut s = store(1);
        s.open(&open_rec(1, 1, 1));
        let ramp: Vec<f32> = (0..2_000).map(|k| k as f32).collect();
        assert_eq!(write(&mut s, 1, &ramp, 1, 1, 0), wire::ERR_OK);
        let r = s.ring_mut(0);
        r.voice = 0x0001_0003;
        r.phase = phase::PLAYING;
        r.consumed = 300; // the voice is at frame 301
        assert!(s.seek(1, 2, 50_000));
        let r = *s.ring(0);
        assert_eq!((r.seeking, r.tail_len, r.tail_frame0, r.tail_channels), (1, FADE_TAIL_FRAMES as u32, 300, 1));
        let tail = &s.samples(0)[TAIL_OFFSET..TAIL_OFFSET + FADE_TAIL_FRAMES];
        assert!(tail.iter().enumerate().all(|(k, v)| *v == (300 + k) as f32), "the next frames, copied");
        // A second seek during the fade keeps the first copy.
        assert!(s.seek(1, 3, 60_000));
        let r = *s.ring(0);
        assert_eq!((r.epoch, r.start_frame, r.seeking, r.tail_frame0), (3, 60_000, 1, 300));
        // A voice with nothing buffered (waiting or starved) has nothing to fade.
        let mut s = store(1);
        s.open(&open_rec(1, 1, 1));
        s.ring_mut(0).voice = 0x0001_0003;
        assert!(s.seek(1, 2, 0));
        assert_eq!((s.ring(0).seeking, s.ring(0).tail_len), (0, 0));
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

    /// Feeds epoch `epoch`'s stream frames `from..from + n` as one chunk.
    fn feed_epoch(core: &mut Core, epoch: u32, from: u64, n: usize, last: bool) -> i32 {
        let data: Vec<f32> = (0..n as u64).flat_map(|k| { let (l, r) = sample(from + k); [l, r] }).collect();
        match core.streams_mut().chunk_ptr(STREAM, n as u32) {
            Ok(p) => {
                // SAFETY: room for `n` stereo frames.
                unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), p as *mut f32, data.len()) };
                core.streams_mut().commit(STREAM, n as u32, epoch, if last { wire::STREAM_CHUNK_FLAGS_LAST } else { 0 })
            }
            Err(e) => e,
        }
    }

    fn open_epoch(core: &mut Core, epoch: u32, start_frame: u32) {
        let o = StreamOpen { stream_id: STREAM, channels: 2, sample_rate: 48_000.0, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, epoch, start_frame, ..Default::default() };
        assert!(core.streams_mut().open(&o));
    }

    /// A stream playing steadily at frame 5,000+: three chunks fed, 40 quanta rendered.
    fn playing(core: &mut Core, frame: &mut u64) {
        play(core, true);
        open(core);
        for k in 0..3 {
            assert_eq!(feed(core, k * 4_096, 4_096, false), wire::ERR_OK);
        }
        render(core, frame, 40);
    }

    /// Asserts a seek's audio: `out` starts with the old audio fading out from `old_pos` over 5 ms,
    /// then nothing until `gap_end`, then the new epoch from `new_pos` fading in over 5 ms and
    /// bit for bit after. No frame of it may be from the old audio after the fade.
    fn check_seek(out: &[f32], old_pos: usize, gap_end: usize, new_pos: u64) {
        for k in 0..FADE {
            let want = sample((old_pos + k) as u64).0 * (1.0 - (k + 1) as f32 / FADE as f32);
            assert!((out[k] - want).abs() < 1e-6, "fade-out frame {k}: {} vs {want}", out[k]);
        }
        assert!(out[FADE..gap_end].iter().all(|s| *s == 0.0), "silent between the fade-out and the new audio");
        for k in 0..FADE {
            let want = sample(new_pos + k as u64).0 * ((k + 1) as f32 / FADE as f32);
            assert!((out[gap_end + k] - want).abs() < 1e-6, "fade-in frame {k}: {} vs {want}", out[gap_end + k]);
        }
        for k in FADE..out.len() - gap_end {
            assert_eq!(out[gap_end + k], sample(new_pos + k as u64).0, "frame {k} after the fade-in");
        }
    }

    #[test]
    fn a_seek_fades_out_the_old_audio_flushes_and_fades_in_the_new_epoch() {
        for open_first in [false, true] {
            let mut core = core();
            let mut frame = 0;
            playing(&mut core, &mut frame);
            let before = core.streams().get(STREAM).unwrap().consumed;
            let old_pos = slot(&core).position as usize;
            assert!(old_pos > 5_000 && old_pos < 8_000, "mid-ring at {old_pos}");
            // The SEEK record and the worker's OPEN, in either order.
            if open_first {
                open_epoch(&mut core, 2, 30_000);
                voices::seek(&mut core, ID, 30_000, 2);
            } else {
                voices::seek(&mut core, ID, 30_000, 2);
                assert!(core.streams().get(STREAM).unwrap().awaiting_open != 0);
                open_epoch(&mut core, 2, 30_000);
            }
            // An old chunk that was in flight lands nowhere.
            assert_eq!(feed_epoch(&mut core, 1, 12_288, 4_096, false), wire::ERR_STALE_EPOCH);
            let ring = *core.streams().get(STREAM).unwrap();
            assert_eq!((ring.epoch, ring.written, ring.consumed), (2, 0, 0));
            assert_eq!(core.streams_mut().take_consumed(STREAM), 0, "nothing of the old ring is owed (the shell drops it)");
            // The old audio fades out; the new has not arrived: silence, the position at the target.
            let (l1, _) = render(&mut core, &mut frame, 6);
            let mut out = l1.clone();
            assert_eq!(slot(&core).position, 30_000.0, "the playhead is at the target once the fade is done");
            // Chunks of the new epoch arrive.
            assert_eq!(feed_epoch(&mut core, 2, 30_000, 4_096, false), wire::ERR_OK);
            let gap = out.len();
            let (l2, _) = render(&mut core, &mut frame, 20);
            out.extend(l2);
            check_seek(&out[..gap + 20 * QUANTUM], old_pos, gap, 30_000);
            assert!(before > 0);
            // The ring's credit starts again from the new epoch.
            assert!(core.streams_mut().take_consumed(STREAM) > 0);
            assert_eq!(core.streams().get(STREAM).unwrap().seeking, 0);
        }
    }

    #[test]
    fn nothing_before_the_seek_is_heard_after_its_fade() {
        let mut core = core();
        let mut frame = 0;
        playing(&mut core, &mut frame);
        // Old audio is the ramp below 12,288; the target is far above it and its audio is distinct.
        voices::seek(&mut core, ID, 40_000, 2);
        open_epoch(&mut core, 2, 40_000);
        assert_eq!(feed_epoch(&mut core, 2, 40_000, 4_096, false), wire::ERR_OK);
        let (l, _) = render(&mut core, &mut frame, 24);
        // After the fade-out: silence, then the new epoch (values 0.4 up, fading in over 5 ms); the
        // old audio (values under 0.13) is never heard again.
        let first = l.iter().skip(FADE).position(|s| *s != 0.0).expect("the new epoch sounds") + FADE;
        assert!(l[FADE..first].iter().all(|s| *s == 0.0));
        for (k, s) in l.iter().enumerate().skip(first + FADE) {
            assert!(*s >= 0.399, "frame {k}: {s} is from before the seek");
        }
    }

    #[test]
    fn a_splice_plays_on_gaplessly_into_the_new_epoch_at_its_frame() {
        let mut core = core();
        let mut frame = 0;
        playing(&mut core, &mut frame); // at stream frame 5,120, 12,288 frames in the ring
        // E4.4: the pass ends at stream frame 8,000; what follows there is epoch 2's (frames 30,000 on).
        let o = StreamOpen { stream_id: STREAM, channels: 2, sample_rate: 48_000.0, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, epoch: 2, start_frame: 8_000, loop_start: 1_000, loop_end: 8_000, ..Default::default() };
        assert!(core.streams_mut().open(&o));
        for k in 0..2 {
            assert_eq!(feed_epoch(&mut core, 2, 30_000 + k * 4_096, 4_096, false), wire::ERR_OK);
        }
        let (l, r) = render(&mut core, &mut frame, 40);
        for k in 0..l.len() {
            let pos = 5_120 + k as u64;
            let want = if pos < 8_000 { sample(pos) } else { sample(30_000 + pos - 8_000) };
            assert_eq!((l[k], r[k]), want, "frame {k} (stream frame {pos})");
        }
        assert_eq!(slot(&core).position, 5_120.0 + l.len() as f64, "the playhead runs on through the seam");
        assert_eq!(core.streams().get(STREAM).unwrap().splices, 1);
        assert_eq!(status::counters(&core).starved.len(), 0);
    }

    #[test]
    fn a_seek_during_starvation_restarts_from_the_target() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        open(&mut core);
        assert_eq!(feed(&mut core, 0, 4_096, false), wire::ERR_OK);
        render(&mut core, &mut frame, 40);
        assert_eq!(core.streams().get(STREAM).unwrap().phase, phase::STARVED);
        voices::seek(&mut core, ID, 20_000, 2);
        open_epoch(&mut core, 2, 20_000);
        let ring = *core.streams().get(STREAM).unwrap();
        assert_eq!((ring.seeking, ring.tail_len), (0, 0), "silent already: nothing to fade out");
        let (l, _) = render(&mut core, &mut frame, 4);
        assert!(l.iter().all(|s| *s == 0.0));
        assert_eq!(slot(&core).position, 20_000.0, "the playhead is at the target while it waits");
        assert_eq!(feed_epoch(&mut core, 2, 20_000, 4_096, false), wire::ERR_OK);
        let (l, _) = render(&mut core, &mut frame, 4);
        for k in 0..FADE {
            let want = sample(20_000 + k as u64).0 * ((k + 1) as f32 / FADE as f32);
            assert!((l[k] - want).abs() < 1e-6, "fade-in frame {k}: {} vs {want}", l[k]);
        }
        assert_eq!(l[FADE], sample(20_000 + FADE as u64).0);
        assert_eq!(status::counters(&core).starved.len(), 0, "the seek is not a second starve");
    }

    #[test]
    fn a_seek_while_waiting_for_the_first_chunk_starts_at_the_target() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, true);
        open(&mut core);
        assert_eq!(feed(&mut core, 0, 1_000, false), wire::ERR_OK);
        render(&mut core, &mut frame, 4);
        voices::seek(&mut core, ID, 5_000, 2);
        open_epoch(&mut core, 2, 5_000);
        assert_eq!(feed_epoch(&mut core, 2, 5_000, 4_096, false), wire::ERR_OK);
        let (l, _) = render(&mut core, &mut frame, 4);
        for k in 0..FADE {
            let want = sample(5_000 + k as u64).0 * ((k + 1) as f32 / FADE as f32);
            assert!((l[k] - want).abs() < 1e-6, "fade-in frame {k}");
        }
        assert_eq!(slot(&core).position, 5_000.0 + 4.0 * QUANTUM as f64);
    }

    #[test]
    fn a_second_seek_during_the_fade_keeps_the_fade_and_lands_on_the_second_target() {
        let mut core = core();
        let mut frame = 0;
        playing(&mut core, &mut frame);
        let old_pos = slot(&core).position as usize;
        voices::seek(&mut core, ID, 30_000, 2);
        open_epoch(&mut core, 2, 30_000);
        let (a, _) = render(&mut core, &mut frame, 1);
        voices::seek(&mut core, ID, 9_000, 3);
        open_epoch(&mut core, 3, 9_000);
        let (b, _) = render(&mut core, &mut frame, 5);
        let mut out = a;
        out.extend(b);
        for k in 0..FADE {
            let want = sample((old_pos + k) as u64).0 * (1.0 - (k + 1) as f32 / FADE as f32);
            assert!((out[k] - want).abs() < 1e-6, "one continuous fade-out, frame {k}");
        }
        assert!(out[FADE..].iter().all(|s| *s == 0.0));
        assert_eq!(slot(&core).position, 9_000.0);
        assert_eq!(feed_epoch(&mut core, 3, 9_000, 4_096, false), wire::ERR_OK);
        let (l, _) = render(&mut core, &mut frame, 4);
        assert_eq!(l[FADE], sample(9_000 + FADE as u64).0);
    }

    #[test]
    fn a_seek_past_the_end_of_a_stream_without_loop_ends_it() {
        let mut core = core();
        let mut frame = 0;
        playing(&mut core, &mut frame);
        voices::seek(&mut core, ID, 90_000, 2);
        open_epoch(&mut core, 2, 90_000);
        // The worker has nothing at the target: one empty last chunk.
        assert_eq!(core.streams_mut().commit(STREAM, 0, 2, wire::STREAM_CHUNK_FLAGS_LAST), wire::ERR_OK);
        render(&mut core, &mut frame, 8);
        assert_eq!(slot(&core).state, state::FREE.max(slot(&core).state), "ended or freed");
        let ended = status::counters(&core).ended.as_slice().contains(&ID);
        let events = status::counters(&core).stream_events.as_slice().iter().any(|e| e.id == STREAM && e.code == wire::stream_event::EOS);
        assert!(ended || events || slot(&core).state != state::PLAYING, "the voice ended after the seek fade");
    }

    #[test]
    fn a_virtual_voice_seeks_at_once_without_a_fade() {
        let mut core = core();
        let mut frame = 0;
        play(&mut core, false);
        open(&mut core);
        for k in 0..3 {
            assert_eq!(feed(&mut core, k * 4_096, 4_096, false), wire::ERR_OK);
        }
        render(&mut core, &mut frame, 20);
        voices::seek(&mut core, ID, 30_000, 2);
        open_epoch(&mut core, 2, 30_000);
        render(&mut core, &mut frame, 1);
        assert_eq!(slot(&core).position, 30_000.0);
        assert_eq!(core.streams().get(STREAM).unwrap().seeking, 0);
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
