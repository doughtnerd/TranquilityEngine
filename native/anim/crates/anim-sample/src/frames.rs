//! [`FrameCache`]: the last two decoded frames of one playing clip, in caller memory (see the
//! crate docs, "Frame cache").

use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};

use crate::{BoundClip, SampleError};

/// Header words: bones, tag, clip key (2), rest key (2), the two held frames, the slot to
/// replace next.
const HEADER: usize = 9;
const BONES: usize = 0;
const TAG: usize = 1;
const CLIP: usize = 2;
const REST: usize = 4;
const FRAME: usize = 6;
const NEXT: usize = 8;
/// Words per transform (f32 bits: translation, rotation, scale).
const WORDS: usize = 10;
/// A held-frame word meaning "none".
const NO_FRAME: u32 = u32::MAX;

/// The last two frames a clip player decoded, in memory the caller owns
/// ([`words_for`](Self::words_for) words; one per playing clip player). Its contents are
/// checked on every use against the clip, the rest pose, the bone count and the caller's `tag`,
/// so any memory may be handed in, and the same memory may serve another player or clip later
/// (it is refilled). Never part of a snapshot: results don't depend on what it holds.
pub struct FrameCache<'m> {
    words: &'m mut [u32],
    tag: u32,
}

impl<'m> FrameCache<'m> {
    /// Words a cache for `bones` bones needs.
    pub const fn words_for(bones: usize) -> usize {
        HEADER + 2 * bones * WORDS
    }

    /// A cache over `words`. `tag` must change whenever memory a cached clip or rest pose lived
    /// in may since hold another (the core passes its asset epoch, bumped on every release).
    pub fn new(words: &'m mut [u32], tag: u32) -> Self {
        FrameCache { words, tag }
    }

    /// Forgets the held frames.
    pub fn clear(&mut self) {
        if self.words.len() >= HEADER {
            self.words[FRAME] = NO_FRAME;
            self.words[FRAME + 1] = NO_FRAME;
        }
    }

    fn slot(&self, k: usize, bones: usize) -> &[u32] {
        let at = HEADER + k * bones * WORDS;
        &self.words[at..at + bones * WORDS]
    }

    fn slot_mut(&mut self, k: usize, bones: usize) -> &mut [u32] {
        let at = HEADER + k * bones * WORDS;
        &mut self.words[at..at + bones * WORDS]
    }

    /// The slot holding frame `f`.
    fn find(&self, f: u32) -> Option<usize> {
        (0..2).find(|&k| self.words[FRAME + k] == f)
    }

    /// Copies `pose` into a slot for frame `f`, keeping the slot that holds `keep`.
    fn store(&mut self, f: u32, keep: u32, pose: &[AosTransform]) {
        let bones = pose.len();
        let k = if self.words[FRAME] == keep {
            1
        } else if self.words[FRAME + 1] == keep {
            0
        } else {
            self.words[NEXT] as usize & 1
        };
        for (t, w) in pose.iter().zip(self.slot_mut(k, bones).chunks_exact_mut(WORDS)) {
            w.copy_from_slice(&to_words(t));
        }
        self.words[FRAME + k] = f;
        self.words[NEXT] = (k as u32 + 1) & 1;
    }

    /// Copies held frame `f` (if held) into `out`.
    fn load(&self, f: u32, out: &mut [AosTransform]) -> bool {
        let Some(k) = self.find(f) else {
            return false;
        };
        let bones = out.len();
        for (t, w) in out.iter_mut().zip(self.slot(k, bones).chunks_exact(WORDS)) {
            *t = from_words(w);
        }
        true
    }
}

fn to_words(t: &AosTransform) -> [u32; WORDS] {
    [
        t.translation.x,
        t.translation.y,
        t.translation.z,
        t.rotation.x,
        t.rotation.y,
        t.rotation.z,
        t.rotation.w,
        t.scale.x,
        t.scale.y,
        t.scale.z,
    ]
    .map(f32::to_bits)
}

fn from_words(w: &[u32]) -> AosTransform {
    let f = |k: usize| f32::from_bits(w[k]);
    AosTransform::new(
        AosVec3::new(f(0), f(1), f(2)),
        AosQuat::new(f(3), f(4), f(5), f(6)),
        AosVec3::new(f(7), f(8), f(9)),
    )
}

/// [`BoundClip::sample_pose_cached`].
pub(crate) fn sample(
    clip: &BoundClip<'_, '_>,
    t: f32,
    rest: &[AosTransform],
    scratch: &mut [AosTransform],
    out: &mut [SoaTransform],
    cache: &mut FrameCache<'_>,
) -> Result<(), SampleError> {
    let s = &clip.sampler;
    let n = s.bone_count();
    let Some(c) = s.comp else {
        return clip.sample_pose(t, rest, scratch, out, None);
    };
    if cache.words.len() < FrameCache::words_for(n) {
        return clip.sample_pose(t, rest, scratch, out, None);
    }
    if rest.len() != n {
        return Err(SampleError::RestLength);
    }
    if scratch.len() < 2 * n {
        return Err(SampleError::ScratchLength);
    }
    if out.len() != soa_len(n) {
        return Err(SampleError::OutLength);
    }
    let p = s.frame_pos(t);
    let bind = clip.bindings;
    if bind.frame_seg(&c, p.f0).is_none() || bind.frame_seg(&c, p.f1).is_none() {
        // A frame without its segment: the uncached path decodes nothing, so neither do we.
        return clip.sample_pose(t, rest, scratch, out, None);
    }
    let split = |v: u64| [v as u32, (v >> 32) as u32];
    let key = split(c.data().as_ptr() as usize as u64);
    let rest_key = split(rest.as_ptr() as usize as u64);
    let w = &mut *cache.words;
    if w[BONES] != n as u32
        || w[TAG] != cache.tag
        || w[CLIP..CLIP + 2] != key
        || w[REST..REST + 2] != rest_key
    {
        w[BONES] = n as u32;
        w[TAG] = cache.tag;
        w[CLIP..CLIP + 2].copy_from_slice(&key);
        w[REST..REST + 2].copy_from_slice(&rest_key);
        w[FRAME] = NO_FRAME;
        w[FRAME + 1] = NO_FRAME;
        w[NEXT] = 0;
    }
    let (a, rest_b) = scratch.split_at_mut(n);
    let b = &mut rest_b[..n];
    if !cache.load(p.f0, a) {
        a.copy_from_slice(rest);
        bind.decode_frame(&c, p.f0, a);
        cache.store(p.f0, p.f1, a);
    }
    if p.f1 == p.f0 {
        b.copy_from_slice(a);
    } else if !cache.load(p.f1, b) {
        b.copy_from_slice(rest);
        bind.decode_frame(&c, p.f1, b);
        cache.store(p.f1, p.f0, b);
    }
    s.interpolate(p, a, b, out);
    Ok(())
}
