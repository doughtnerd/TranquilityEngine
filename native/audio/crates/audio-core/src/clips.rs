//! The clip store (contract K11): where voices find their PCM.
//!
//! **This is the plan's one deliberate stub replacement.** The API below (`reserve`, `write`,
//! `frames`, `free`) is the seam: A1.3b replaces only the *body* of [`ClipStore`] with the slab
//! arena over the `ClipDirectory` and `Arena` regions (architecture §5.2), and nothing that calls
//! it changes. Until then a plain `Vec` sits behind it, sorted by clip id.
//!
//! Rules that hold for both bodies:
//! - `reserve`, `write` and `free` run from `onmessage` only (the `clip_*` exports, `submit`), never
//!   inside `process`; they may allocate (the `Vec` here) or grow memory (the arena).
//! - `frames` runs inside `process`: it never allocates and is O(log n) or better.
//! - Clips are interleaved, 1 or 2 channels, f32 or int16, each at its own sample rate.

use audio_dsp::resample::{Samples, Source};
use audio_wire::generated as wire;

/// A clip's sample format (CLIP_BEGIN `format`, api-and-models §4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipFormat {
    F32,
    I16,
}

impl ClipFormat {
    /// The wire's `format` value (0 f32, 1 int16). HRIR data (2) isn't a voice clip (H2).
    pub fn from_wire(format: u32) -> Option<ClipFormat> {
        match format {
            wire::clip_format::F32 => Some(ClipFormat::F32),
            wire::clip_format::I16 => Some(ClipFormat::I16),
            _ => None,
        }
    }

    /// Bytes per sample.
    pub fn sample_bytes(self) -> usize {
        match self {
            ClipFormat::F32 => 4,
            ClipFormat::I16 => 2,
        }
    }
}

/// A resident clip as a voice reads it.
#[derive(Clone, Copy, Debug)]
pub struct Clip<'a> {
    pub source: Source<'a>,
    /// The clip's own rate, in Hz.
    pub sample_rate: f32,
}

enum Pcm {
    F32(Vec<f32>),
    I16(Vec<i16>),
}

struct Entry {
    id: u32,
    channels: u32,
    frames: u32,
    sample_rate: f32,
    pcm: Pcm,
}

/// Every clip the core holds, by clip id (the main thread's registry id, api-and-models §3).
#[derive(Default)]
pub struct ClipStore {
    /// Sorted by `id`. A1.3b: the slab arena replaces this.
    entries: Vec<Entry>,
}

impl ClipStore {
    /// An empty store. Doesn't allocate.
    pub const fn new() -> ClipStore {
        ClipStore { entries: Vec::new() }
    }

    /// Reserves zeroed space for a clip of `frames` frames (`myco_audio_clip_reserve`).
    /// Refuses (`ERR_BAD_ARG`) an id that's already held, `channels` other than 1 or 2, zero
    /// frames, or a rate that isn't positive and finite. `onmessage` only.
    pub fn reserve(&mut self, id: u32, frames: u32, channels: u32, sample_rate: f32, format: ClipFormat) -> Result<(), i32> {
        if !(channels == 1 || channels == 2) || frames == 0 || !(sample_rate > 0.0 && sample_rate.is_finite()) {
            return Err(wire::ERR_BAD_ARG);
        }
        let at = match self.find(id) {
            Ok(_) => return Err(wire::ERR_BAD_ARG),
            Err(at) => at,
        };
        let len = frames as usize * channels as usize;
        let pcm = match format {
            ClipFormat::F32 => Pcm::F32(vec![0.0; len]),
            ClipFormat::I16 => Pcm::I16(vec![0; len]),
        };
        self.entries.insert(at, Entry { id, channels, frames, sample_rate, pcm });
        Ok(())
    }

    /// Copies little-endian samples in the clip's format into the clip, starting at frame
    /// `frame_offset` (`myco_audio_clip_write`, and the chunk path's copy). `bytes` must be whole
    /// frames and fit inside the clip. `ERR_UNKNOWN_CLIP` for an id not reserved, `ERR_BAD_ARG`
    /// for a range that doesn't fit.
    pub fn write(&mut self, id: u32, frame_offset: u32, bytes: &[u8]) -> Result<(), i32> {
        let at = self.find(id).map_err(|_| wire::ERR_UNKNOWN_CLIP)?;
        let e = &mut self.entries[at];
        let channels = e.channels as usize;
        let (sample_bytes, total) = match &e.pcm {
            Pcm::F32(v) => (4, v.len()),
            Pcm::I16(v) => (2, v.len()),
        };
        if bytes.len() % (sample_bytes * channels) != 0 {
            return Err(wire::ERR_BAD_ARG);
        }
        let first = frame_offset as usize * channels;
        let count = bytes.len() / sample_bytes;
        if first.checked_add(count).map_or(true, |end| end > total) {
            return Err(wire::ERR_BAD_ARG);
        }
        match &mut e.pcm {
            Pcm::F32(v) => {
                for (dst, src) in v[first..first + count].iter_mut().zip(bytes.chunks_exact(4)) {
                    *dst = f32::from_le_bytes([src[0], src[1], src[2], src[3]]);
                }
            }
            Pcm::I16(v) => {
                for (dst, src) in v[first..first + count].iter_mut().zip(bytes.chunks_exact(2)) {
                    *dst = i16::from_le_bytes([src[0], src[1]]);
                }
            }
        }
        Ok(())
    }

    /// The clip's frames, or `None` when `id` isn't held. Never allocates (`process` calls it).
    pub fn frames(&self, id: u32) -> Option<Clip<'_>> {
        let e = &self.entries[self.find(id).ok()?];
        let samples = match &e.pcm {
            Pcm::F32(v) => Samples::F32(v),
            Pcm::I16(v) => Samples::I16(v),
        };
        Some(Clip { source: Source { samples, channels: e.channels, frames: e.frames }, sample_rate: e.sample_rate })
    }

    /// Drops the clip (`myco_audio_clip_free`). `ERR_UNKNOWN_CLIP` when `id` isn't held. Voices
    /// still on it end at their next quantum (main frees a clip only when no voice uses it).
    pub fn free(&mut self, id: u32) -> Result<(), i32> {
        let at = self.find(id).map_err(|_| wire::ERR_UNKNOWN_CLIP)?;
        self.entries.remove(at);
        Ok(())
    }

    /// Drops every clip (RESET with `keepClips = 0`).
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Clips held.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn find(&self, id: u32) -> Result<usize, usize> {
        self.entries.binary_search_by_key(&id, |e| e.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_bytes(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn reserve_write_read_free() {
        let mut s = ClipStore::new();
        s.reserve(7, 4, 2, 44_100.0, ClipFormat::F32).unwrap();
        s.write(7, 1, &f32_bytes(&[0.5, -0.5, 0.25, -0.25])).unwrap();
        let clip = s.frames(7).unwrap();
        assert_eq!(clip.sample_rate, 44_100.0);
        assert_eq!((clip.source.channels, clip.source.frames), (2, 4));
        match clip.source.samples {
            Samples::F32(v) => assert_eq!(v, &[0.0, 0.0, 0.5, -0.5, 0.25, -0.25, 0.0, 0.0]),
            Samples::I16(_) => panic!("f32 clip"),
        }
        s.free(7).unwrap();
        assert!(s.frames(7).is_none());
        assert_eq!(s.free(7), Err(wire::ERR_UNKNOWN_CLIP));
    }

    #[test]
    fn int16_clips_keep_their_samples() {
        let mut s = ClipStore::new();
        s.reserve(1, 2, 1, 48_000.0, ClipFormat::I16).unwrap();
        s.write(1, 0, &[0x00, 0x40, 0x00, 0xC0]).unwrap();
        match s.frames(1).unwrap().source.samples {
            Samples::I16(v) => assert_eq!(v, &[16_384, -16_384]),
            Samples::F32(_) => panic!("int16 clip"),
        }
    }

    #[test]
    fn bad_reserves_and_writes_are_refused() {
        let mut s = ClipStore::new();
        assert_eq!(s.reserve(1, 4, 3, 48_000.0, ClipFormat::F32), Err(wire::ERR_BAD_ARG));
        assert_eq!(s.reserve(1, 0, 1, 48_000.0, ClipFormat::F32), Err(wire::ERR_BAD_ARG));
        assert_eq!(s.reserve(1, 4, 1, f32::NAN, ClipFormat::F32), Err(wire::ERR_BAD_ARG));
        s.reserve(1, 4, 1, 48_000.0, ClipFormat::F32).unwrap();
        assert_eq!(s.reserve(1, 4, 1, 48_000.0, ClipFormat::F32), Err(wire::ERR_BAD_ARG), "already held");
        assert_eq!(s.write(1, 3, &f32_bytes(&[1.0, 1.0])), Err(wire::ERR_BAD_ARG), "past the end");
        assert_eq!(s.write(1, 0, &[0, 0, 0]), Err(wire::ERR_BAD_ARG), "not whole frames");
        assert_eq!(s.write(2, 0, &f32_bytes(&[1.0])), Err(wire::ERR_UNKNOWN_CLIP));
    }

    #[test]
    fn ids_stay_sorted() {
        let mut s = ClipStore::new();
        for id in [9, 3, 6, 1] {
            s.reserve(id, 1, 1, 48_000.0, ClipFormat::F32).unwrap();
        }
        for id in [1, 3, 6, 9] {
            assert!(s.frames(id).is_some());
        }
        assert_eq!(s.len(), 4);
    }
}
