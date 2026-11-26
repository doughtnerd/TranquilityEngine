//! [`FrameCache`]: the last two decoded frames of one playing clip, in caller memory (see the
//! crate docs, "Frame cache").

use anim_math::layout::soa_len;
use anim_math::{AosTransform, F32x4, SoaTransform};

use crate::{BoundClip, SampleError};

/// Header words: bones, tag, clip key (2), rest key (2), the two held frames, the slot to
/// replace next, the sampling mask's key (2). (T82r and D144 kept the widened ranges of the
/// segment decoded last after the header, up to 24 words per bone; D146 moved them into the
/// clip's binding table, every segment's computed once and shared by every player.)
const HEADER: usize = 11;
const BONES: usize = 0;
const TAG: usize = 1;
const CLIP: usize = 2;
const REST: usize = 4;
const FRAME: usize = 6;
const NEXT: usize = 8;
const MASK: usize = 9;
/// A held-frame word meaning "none".
const NO_FRAME: u32 = u32::MAX;

/// The last two frames a clip player decoded, packed four bones at a time as the interpolation
/// reads them, in memory the caller owns ([`header_len`](Self::header_len) words and
/// [`frames_len`](Self::frames_len) transforms; one per playing clip player). Its contents are
/// checked on every use against the clip, the rest pose, the bone count and the caller's `tag`,
/// so any memory may be handed in, and the same memory may serve another player or clip later
/// (it is refilled). Never part of a snapshot: results don't depend on what it holds.
pub struct FrameCache<'m> {
    header: &'m mut [u32],
    frames: &'m mut [SoaTransform],
    tag: u32,
}

impl<'m> FrameCache<'m> {
    /// Header words a cache for `bones` bones needs (the same for any bone count since D146).
    pub const fn header_len(bones: usize) -> usize {
        let _ = bones;
        HEADER
    }

    /// Transforms a cache for `bones` bones needs: two frames of `soa_len(bones)` groups.
    pub const fn frames_len(bones: usize) -> usize {
        2 * bones.div_ceil(4)
    }

    /// A cache over `header` and `frames`. `tag` must change whenever memory a cached clip or
    /// rest pose lived in may since hold another (the core passes its asset epoch, bumped on
    /// every release).
    pub fn new(header: &'m mut [u32], frames: &'m mut [SoaTransform], tag: u32) -> Self {
        FrameCache {
            header,
            frames,
            tag,
        }
    }

    /// Forgets the held frames.
    pub fn clear(&mut self) {
        if self.header.len() >= HEADER {
            self.header[FRAME] = NO_FRAME;
            self.header[FRAME + 1] = NO_FRAME;
        }
    }
}

/// The lanes of group `g` a sampling mask keeps (weight above 0; every lane without a mask).
#[inline(always)]
pub(crate) fn lanes_on(only: Option<&[F32x4]>, g: usize) -> u8 {
    match only {
        None => 0b1111,
        Some(m) => m.get(g).map_or(0, |w| {
            let w = w.to_array();
            (w[0] > 0.0) as u8
                | ((w[1] > 0.0) as u8) << 1
                | ((w[2] > 0.0) as u8) << 2
                | ((w[3] > 0.0) as u8) << 3
        }),
    }
}

/// [`BoundClip::sample_pose_cached`] and [`BoundClip::sample_pose_masked`].
pub(crate) fn sample(
    clip: &BoundClip<'_, '_>,
    t: f32,
    rest: &[AosTransform],
    scratch: &mut [AosTransform],
    out: &mut [SoaTransform],
    cache: &mut FrameCache<'_>,
    only: Option<&[F32x4]>,
) -> Result<(), SampleError> {
    let s = clip.sampler;
    let n = s.bone_count();
    let groups = soa_len(n);
    let Some(c) = s.comp else {
        return clip.sample_pose(t, rest, scratch, out, None);
    };
    if cache.header.len() < HEADER || cache.frames.len() < FrameCache::frames_len(n) {
        return clip.sample_pose(t, rest, scratch, out, None);
    }
    if rest.len() != n {
        return Err(SampleError::RestLength);
    }
    if scratch.len() < n {
        return Err(SampleError::ScratchLength);
    }
    if out.len() != groups {
        return Err(SampleError::OutLength);
    }
    // A mask of another length keeps every bone.
    let only = only.filter(|m| m.len() == groups);
    let p = s.frame_pos(t);
    let bind = clip.bindings;
    if bind.frame_seg(&c, p.f0).is_none() || bind.frame_seg(&c, p.f1).is_none() {
        // A frame without its segment: the uncached path decodes nothing, so neither do we.
        return clip.sample_pose(t, rest, scratch, out, None);
    }
    let split = |v: u64| [v as u32, (v >> 32) as u32];
    let key = split(c.data().as_ptr() as usize as u64);
    let rest_key = split(rest.as_ptr() as usize as u64);
    // The held frames' bones outside the mask hold stale values, so a frame decoded under one
    // mask is never read under another (the tag covers a released mask's memory reused).
    let mask_key = split(only.map_or(0, |m| m.as_ptr() as usize as u64));
    let h = &mut cache.header[..HEADER];
    if h[BONES] != n as u32
        || h[TAG] != cache.tag
        || h[CLIP..CLIP + 2] != key
        || h[REST..REST + 2] != rest_key
        || h[MASK..MASK + 2] != mask_key
    {
        h.copy_from_slice(&[
            n as u32,
            cache.tag,
            key[0],
            key[1],
            rest_key[0],
            rest_key[1],
            NO_FRAME,
            NO_FRAME,
            0,
            mask_key[0],
            mask_key[1],
        ]);
    }
    let frames = &mut *cache.frames;
    // The slot of each frame, decoding the ones not held (into the slot the other doesn't use).
    let mut slot_of = |f: u32, keep: u32, h: &mut [u32]| -> usize {
        if let Some(k) = (0..2).find(|&k| h[FRAME + k] == f) {
            return k;
        }
        let k = if h[FRAME] == keep {
            1
        } else if h[FRAME + 1] == keep {
            0
        } else {
            h[NEXT] as usize & 1
        };
        let r = bind.segment_ranges(bind.segment_of(f) as usize);
        // A slot holding a frame holds this clip's decode over this rest pose (the header was
        // reset on any change), so only its animated values change.
        let held = h[FRAME + k] != NO_FRAME;
        let slot = &mut frames[k * groups..(k + 1) * groups];
        bind.decode_frame_soa(&c, f, rest, slot, r, held, only);
        h[FRAME + k] = f;
        h[NEXT] = (k as u32 + 1) & 1;
        k
    };
    let ka = slot_of(p.f0, p.f1, h);
    let kb = if p.f1 == p.f0 {
        ka
    } else {
        slot_of(p.f1, p.f0, h)
    };
    let alpha = F32x4::splat(p.alpha);
    let (fa, fb) = (
        &frames[ka * groups..(ka + 1) * groups],
        &frames[kb * groups..(kb + 1) * groups],
    );
    for (g, ((o, ta), tb)) in out.iter_mut().zip(fa).zip(fb).enumerate() {
        if only.is_some() && lanes_on(only, g) == 0 {
            continue;
        }
        *o = s.interpolate_group(*ta, *tb, alpha);
    }
    Ok(())
}
