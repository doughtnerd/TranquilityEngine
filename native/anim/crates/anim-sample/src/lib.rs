//! `anim-sample` (ADR 0340): decompress and sample clips into SoA local poses; sample generic
//! property tracks; sample discrete and event tracks over a time window.
//!
//! Tested against `anim-offline::sample`.
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010).
//!
//! # Shape
//!
//! A [`ClipSampler`] is a small `Copy` value over a parsed [`ClipView`], reading one form: the
//! **compressed** form (`anim-compress`'s bitstream contract, documented in that crate) or the
//! **raw** form (f32 samples, for preview before compression). It never allocates and never
//! panics on a clip that parsed; every operation is deterministic (only `anim-math`'s operations,
//! no fused multiply-add).
//!
//! - [`ClipSampler::sample_pose`] writes a SoA local pose: the rest pose, with each bone track's
//!   channels applied (default channels keep the rest value, constants are copied, animated
//!   channels decoded at the two frames around `t`) and interpolated four bones at a time with
//!   SIMD: linear translation and scale, nlerp rotation (slerp when the clip sets `CLIP_SLERP`).
//! - [`ClipSampler::sample_track`] writes one property track (`float`, `vec2..4`, `color`, `quat`,
//!   `morph`, `curve`) into an output slice: linear, or nlerp/slerp for `quat` by its subtype.
//!
//! # Segment cache
//!
//! Decoding an animated sample needs its segment's range (two bytes per component, widened with
//! the clip range: two multiplies and an add). A [`SegmentCache`] keeps the last segment's ranges
//! already widened, in memory the caller owns (one per playing instance and clip;
//! [`ClipSampler::cache_len`] gives the sizes). Sequential playback stays in one segment for 16
//! frames, so most samples skip that work. Results are bit-identical with and without a cache.
//! A cache used with another clip, or too short, is refilled or ignored, never misread.

use anim_format::clip::{
    ChannelKind, ChannelMode, ClipView, CompressedView, QuatInterp, RotationFormat, TrackKind,
    CLIP_SLERP,
};
use anim_format::skeleton::SkeletonView;
use anim_format::NONE;
use anim_math::layout::{soa_len, LANES};
use anim_math::quant::{is_supported_bits, unpack_range, unpack_unorm};
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, Lane, SoaTransform};

/// Which stored form a sampler reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    /// The raw f32 samples.
    Raw,
    /// The compressed form.
    Compressed,
}

/// Why sampling was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleError {
    /// The clip doesn't carry the requested form.
    MissingForm,
    /// `rest` doesn't hold one transform per bone.
    RestLength,
    /// `scratch` is shorter than [`ClipSampler::scratch_len`].
    ScratchLength,
    /// `out` doesn't hold `soa_len(bone count)` groups.
    OutLength,
}

/// What [`ClipSampler::sample_track`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackSample {
    /// The value was written to `out[..width]`.
    Written,
    /// The track is a default channel: `out` is left as the caller filled it (the field default).
    Default,
    /// Not a sampled property track, out of range, or `out` too short; nothing written.
    Skipped,
}

/// Where `t` falls between frames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramePos {
    /// The earlier frame.
    pub f0: u32,
    /// The later frame (`f0` at the end).
    pub f1: u32,
    /// The weight of `f1`.
    pub alpha: f32,
}

/// Fills `out` with `skel`'s rest pose. Returns `false` (writing nothing) unless
/// `out.len() == skel.bone_count()`.
pub fn rest_pose(skel: &SkeletonView<'_>, out: &mut [AosTransform]) -> bool {
    if out.len() != skel.bone_count() {
        return false;
    }
    for (i, o) in out.iter_mut().enumerate() {
        if let Some(b) = skel.bone(i) {
            let [tx, ty, tz] = b.translation;
            let [rx, ry, rz, rw] = b.rotation;
            let [sx, sy, sz] = b.scale;
            *o = AosTransform::new(
                AosVec3::new(tx, ty, tz),
                AosQuat::new(rx, ry, rz, rw),
                AosVec3::new(sx, sy, sz),
            );
        }
    }
    true
}

/// The last decoded segment's ranges, in caller-owned memory (see the crate docs).
pub struct SegmentCache<'m> {
    key: usize,
    segment: u32,
    /// The cached segment's bits per frame and Σ animated widths.
    frame_bits: u64,
    width_sum: usize,
    ranges: &'m mut [f32],
}

impl<'m> SegmentCache<'m> {
    /// An empty cache over `ranges` (at least [`ClipSampler::cache_len`] floats).
    pub fn new(ranges: &'m mut [f32]) -> Self {
        SegmentCache {
            key: 0,
            segment: NONE,
            frame_bits: 0,
            width_sum: 0,
            ranges,
        }
    }
    /// Forgets the cached segment.
    pub fn clear(&mut self) {
        self.segment = NONE;
    }
}

/// A sampler over one form of a clip. `Copy`; holds only views into the clip's bytes.
#[derive(Clone, Copy)]
pub struct ClipSampler<'a> {
    view: ClipView<'a>,
    comp: Option<CompressedView<'a>>,
    frames: u32,
    rate: f32,
    bones: usize,
    slerp: bool,
}

/// A segment's decoding context.
#[derive(Clone, Copy)]
struct Seg<'a> {
    index: usize,
    data: &'a [u8],
    rates: &'a [u8],
    /// Bit position of the frame's first code.
    frame_pos: u64,
}

impl<'a> ClipSampler<'a> {
    /// A sampler over `form` of `view`.
    pub fn new(view: ClipView<'a>, form: Form) -> Result<Self, SampleError> {
        let comp = match form {
            Form::Compressed => Some(view.compressed().ok_or(SampleError::MissingForm)?),
            Form::Raw => {
                let sampled = (0..view.track_count())
                    .any(|i| view.track(i).is_some_and(|t| t.kind.is_sampled()));
                if sampled && view.raw().is_none() {
                    return Err(SampleError::MissingForm);
                }
                None
            }
        };
        Ok(ClipSampler {
            view,
            comp,
            frames: view.frame_count(),
            rate: view.sample_rate(),
            bones: view.bone_count() as usize,
            slerp: view.flags() & CLIP_SLERP != 0,
        })
    }

    /// The form this sampler reads.
    pub fn form(&self) -> Form {
        if self.comp.is_some() {
            Form::Compressed
        } else {
            Form::Raw
        }
    }

    /// The bone count poses have.
    pub fn bone_count(&self) -> usize {
        self.bones
    }

    /// AoS transforms of scratch [`sample_pose`](Self::sample_pose) needs: two per bone.
    pub fn scratch_len(&self) -> usize {
        2 * self.bones
    }

    /// Floats a [`SegmentCache`] needs: two per animated component (0 for the raw form).
    pub fn cache_len(&self) -> usize {
        let Some(c) = self.comp else { return 0 };
        let mut n = 0;
        for i in 0..c.channel_count() {
            if let Some(ch) = c.channel(i) {
                if ch.mode == ChannelMode::Animated {
                    n += 2 * ch.width as usize;
                }
            }
        }
        n
    }

    /// The frames around `t` seconds: `x = clamp(t · rate, 0, frames − 1)`.
    pub fn frame_pos(&self, t: f32) -> FramePos {
        let last = self.frames.saturating_sub(1);
        let x = t * self.rate;
        let x = if x >= 0.0 {
            Lane::min(x, last as f32)
        } else {
            0.0
        };
        let f0 = (x.floor() as u32).min(last);
        FramePos {
            f0,
            f1: (f0 + 1).min(last),
            alpha: x - f0 as f32,
        }
    }

    /// Samples the local pose at `t` seconds into `out` (`soa_len(bone count)` groups; padding
    /// lanes identity). `rest` is the skeleton's rest pose ([`rest_pose`]), `scratch` at least
    /// [`scratch_len`](Self::scratch_len) transforms. `cache` speeds up sequential playback of
    /// the compressed form. Never allocates.
    pub fn sample_pose(
        &self,
        t: f32,
        rest: &[AosTransform],
        scratch: &mut [AosTransform],
        out: &mut [SoaTransform],
        cache: Option<&mut SegmentCache<'_>>,
    ) -> Result<(), SampleError> {
        let n = self.bones;
        if rest.len() != n {
            return Err(SampleError::RestLength);
        }
        if scratch.len() < 2 * n {
            return Err(SampleError::ScratchLength);
        }
        if out.len() != soa_len(n) {
            return Err(SampleError::OutLength);
        }
        let (a, rest_b) = scratch.split_at_mut(n);
        let b = &mut rest_b[..n];
        a.copy_from_slice(rest);
        b.copy_from_slice(rest);
        let p = self.frame_pos(t);
        match self.comp {
            Some(c) => self.decode_pose(&c, p, a, b, cache),
            None => self.raw_pose(p, a, b),
        }
        let alpha = F32x4::splat(p.alpha);
        for (g, o) in out.iter_mut().enumerate() {
            let lanes = |pose: &[AosTransform]| -> [AosTransform; 4] {
                core::array::from_fn(|l| pose.get(g * LANES + l).copied().unwrap_or_default())
            };
            let ta = SoaTransform::from_aos(&lanes(a));
            let tb = SoaTransform::from_aos(&lanes(b));
            let rotation = if self.slerp {
                ta.rotation
                    .normalize_or_identity()
                    .slerp(tb.rotation.normalize_or_identity(), alpha)
                    .normalize_or_identity()
            } else {
                ta.rotation.nlerp(tb.rotation, alpha)
            };
            *o = SoaTransform::new(
                ta.translation.lerp(tb.translation, alpha),
                rotation,
                ta.scale.lerp(tb.scale, alpha),
            );
        }
        Ok(())
    }

    fn raw_pose(&self, p: FramePos, a: &mut [AosTransform], b: &mut [AosTransform]) {
        for i in 0..self.view.track_count() {
            let Some(t) = self.view.track(i) else {
                continue;
            };
            if t.kind != TrackKind::Bone {
                continue;
            }
            let Some(raw) = self.view.track_raw(i) else {
                continue;
            };
            let bone = t.binding.bone as usize;
            let frame = |f: u32| -> Option<AosTransform> {
                let s = raw.slice(f as usize * 10, 10)?;
                let v = |k: usize| s.get(k).unwrap_or(0.0);
                Some(AosTransform::new(
                    AosVec3::new(v(0), v(1), v(2)),
                    AosQuat::new(v(3), v(4), v(5), v(6)),
                    AosVec3::new(v(7), v(8), v(9)),
                ))
            };
            if let (Some(x), Some(y), true) = (frame(p.f0), frame(p.f1), bone < a.len()) {
                a[bone] = x;
                b[bone] = y;
            }
        }
    }

    /// Segment `index`'s bits per frame and the sum of animated widths (one pass over the
    /// channel table).
    fn seg_bits(&self, c: &CompressedView<'a>, index: usize) -> Option<(u64, usize)> {
        let rates = c.bit_rates(index)?;
        let mut frame_bits = 0u64;
        let mut width_sum = 0usize;
        for i in 0..c.channel_count() {
            let ch = c.channel(i)?;
            if ch.mode == ChannelMode::Animated {
                let r = *rates.get(ch.animated_index as usize)? as u64;
                frame_bits += r * ch.width as u64;
                width_sum += ch.width as usize;
            }
        }
        Some((frame_bits, width_sum))
    }

    /// The segment context of `frame` (in segment `index`, `frame_bits` per frame).
    fn seg(
        &self,
        c: &CompressedView<'a>,
        index: usize,
        frame: u32,
        frame_bits: u64,
    ) -> Option<Seg<'a>> {
        let s = c.segment(index)?;
        Some(Seg {
            index,
            data: c.segment_data(index)?,
            rates: c.bit_rates(index)?,
            frame_pos: frame.saturating_sub(s.start_frame) as u64 * frame_bits,
        })
    }

    /// Fills `cache` with segment `seg`'s widened ranges (if it fits and isn't already there).
    fn fill_cache(&self, c: &CompressedView<'a>, seg: usize, cache: &mut SegmentCache<'_>) -> bool {
        let key = c.data().as_ptr() as usize;
        if cache.key == key && cache.segment == seg as u32 {
            return true;
        }
        let Some((frame_bits, width_sum)) = self.seg_bits(c, seg) else {
            return false;
        };
        if cache.ranges.len() < 2 * width_sum {
            return false;
        }
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        let mut comp = 0usize;
        for i in 0..c.channel_count() {
            let Some(ch) = c.channel(i) else { return false };
            if ch.mode != ChannelMode::Animated {
                continue;
            }
            for k in 0..ch.width as usize {
                let (min, ext) =
                    seg_range(&clip_ranges, seg_ranges, &ch, k, seg * width_sum + comp + k);
                cache.ranges[2 * (comp + k)] = min;
                cache.ranges[2 * (comp + k) + 1] = ext;
            }
            comp += ch.width as usize;
        }
        cache.key = key;
        cache.segment = seg as u32;
        cache.frame_bits = frame_bits;
        cache.width_sum = width_sum;
        true
    }

    fn decode_pose(
        &self,
        c: &CompressedView<'a>,
        p: FramePos,
        a: &mut [AosTransform],
        b: &mut [AosTransform],
        cache: Option<&mut SegmentCache<'_>>,
    ) {
        let sf = c.segment_frames().max(1);
        let (i0, i1) = ((p.f0 / sf) as usize, (p.f1 / sf) as usize);
        // Bits per frame and widths: from the cache, else one pass over the channel table.
        let cache = cache.and_then(|cache| self.fill_cache(c, i0, cache).then_some(cache));
        let (cached, bits0, width_sum): (Option<&[f32]>, _, _) = match cache {
            Some(cache) => (Some(&*cache.ranges), cache.frame_bits, cache.width_sum),
            None => match self.seg_bits(c, i0) {
                Some((b, w)) => (None, b, w),
                None => return,
            },
        };
        let bits1 = if i1 == i0 {
            bits0
        } else {
            match self.seg_bits(c, i1) {
                Some((b, _)) => b,
                None => return,
            }
        };
        let (Some(s0), Some(s1)) = (self.seg(c, i0, p.f0, bits0), self.seg(c, i1, p.f1, bits1))
        else {
            return;
        };
        let format = c.rotation_format();
        let constants = c.constants();
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        let (mut pos0, mut pos1) = (s0.frame_pos, s1.frame_pos);
        let mut comp = 0usize; // animated components before this channel
                               // The current track's bone (`None`: not a bone track); a bone track's three channels
                               // are adjacent, so its record is read once.
        let mut track: (u32, Option<usize>) = (NONE, None);
        for i in 0..c.channel_count() {
            let Some(ch) = c.channel(i) else { return };
            if ch.track != track.0 {
                let Some(t) = self.view.track(ch.track as usize) else {
                    return;
                };
                let bone = (t.kind == TrackKind::Bone).then_some(t.binding.bone as usize);
                track = (ch.track, bone);
            }
            let w = ch.width as usize;
            let mut va = [0.0f32; 4];
            let mut vb = [0.0f32; 4];
            match ch.mode {
                ChannelMode::Default => continue,
                ChannelMode::Constant => {
                    for (k, v) in va.iter_mut().enumerate().take(w) {
                        *v = constants.get(ch.data_offset as usize + k).unwrap_or(0.0);
                    }
                    vb = va;
                }
                ChannelMode::Animated => {
                    let a_i = ch.animated_index as usize;
                    let r0 = s0.rates.get(a_i).copied().unwrap_or(0) as u32;
                    let r1 = s1.rates.get(a_i).copied().unwrap_or(0) as u32;
                    for k in 0..w.min(4) {
                        let (m0, e0) = match cached {
                            Some(r) => (r[2 * (comp + k)], r[2 * (comp + k) + 1]),
                            None => seg_range(
                                &clip_ranges,
                                seg_ranges,
                                &ch,
                                k,
                                s0.index * width_sum + comp + k,
                            ),
                        };
                        let (m1, e1) = if s1.index == s0.index {
                            (m0, e0)
                        } else {
                            seg_range(
                                &clip_ranges,
                                seg_ranges,
                                &ch,
                                k,
                                s1.index * width_sum + comp + k,
                            )
                        };
                        va[k] = decode(s0.data, pos0, r0, m0, e0);
                        vb[k] = decode(s1.data, pos1, r1, m1, e1);
                        pos0 += r0 as u64;
                        pos1 += r1 as u64;
                    }
                    comp += w;
                }
            }
            let Some(bone) = track.1.filter(|&b| b < a.len()) else {
                continue;
            };
            apply(&mut a[bone], ch.kind, &va, format);
            apply(&mut b[bone], ch.kind, &vb, format);
        }
    }

    /// Samples property track `track` at `t` seconds into `out[..width]`.
    pub fn sample_track(&self, track: usize, t: f32, out: &mut [f32]) -> TrackSample {
        let Some(info) = self.view.track(track) else {
            return TrackSample::Skipped;
        };
        let w = info.width as usize;
        if info.kind == TrackKind::Bone || !info.kind.is_sampled() || out.len() < w || w > 4 {
            return TrackSample::Skipped;
        }
        let p = self.frame_pos(t);
        let mut va = [0.0f32; 4];
        let mut vb = [0.0f32; 4];
        match self.comp {
            None => {
                let Some(raw) = self.view.track_raw(track) else {
                    return TrackSample::Skipped;
                };
                for k in 0..w {
                    va[k] = raw.get(p.f0 as usize * w + k).unwrap_or(0.0);
                    vb[k] = raw.get(p.f1 as usize * w + k).unwrap_or(0.0);
                }
            }
            Some(c) => match self.decode_value(&c, track, p) {
                Some(Some((x, y))) => {
                    va = x;
                    vb = y;
                }
                Some(None) => return TrackSample::Default,
                None => return TrackSample::Skipped,
            },
        }
        if info.kind == TrackKind::Quat {
            let qa = AosQuat::new(va[0], va[1], va[2], va[3]).normalize_or_identity();
            let qb = AosQuat::new(vb[0], vb[1], vb[2], vb[3]).normalize_or_identity();
            let q = if QuatInterp::from_u8(info.subtype) == Some(QuatInterp::Slerp) {
                qa.slerp(qb, p.alpha).normalize_or_identity()
            } else {
                qa.nlerp(qb, p.alpha)
            };
            out[..4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
        } else {
            for k in 0..w {
                out[k] = va[k] + (vb[k] - va[k]) * p.alpha;
            }
        }
        TrackSample::Written
    }

    /// A value channel's two frames: `Some(None)` for a default channel.
    #[allow(clippy::type_complexity)]
    fn decode_value(
        &self,
        c: &CompressedView<'a>,
        track: usize,
        p: FramePos,
    ) -> Option<Option<([f32; 4], [f32; 4])>> {
        // Channels are sorted by (track, kind): binary search for the track's value channel.
        let (mut lo, mut hi) = (0usize, c.channel_count());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if (c.channel(mid)?.track as usize) < track {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let ch = c.channel(lo)?;
        if ch.track as usize != track || ch.kind != ChannelKind::Value {
            return None;
        }
        let w = (ch.width as usize).min(4);
        let mut va = [0.0f32; 4];
        match ch.mode {
            ChannelMode::Default => return Some(None),
            ChannelMode::Constant => {
                for (k, v) in va.iter_mut().enumerate().take(w) {
                    *v = c.constants().get(ch.data_offset as usize + k)?;
                }
                return Some(Some((va, va)));
            }
            ChannelMode::Animated => {}
        }
        // Bits and components of the animated channels before this one.
        let a_i = ch.animated_index;
        let mut comp = 0usize;
        let mut width_sum = 0usize;
        let sf = c.segment_frames().max(1);
        let (i0, i1) = ((p.f0 / sf) as usize, (p.f1 / sf) as usize);
        let s0 = self.seg(c, i0, p.f0, self.seg_bits(c, i0)?.0)?;
        let s1 = self.seg(c, i1, p.f1, self.seg_bits(c, i1)?.0)?;
        let (mut pos0, mut pos1) = (s0.frame_pos, s1.frame_pos);
        for i in 0..c.channel_count() {
            let o = c.channel(i)?;
            if o.mode != ChannelMode::Animated {
                continue;
            }
            if o.animated_index < a_i {
                let ow = o.width as u64;
                pos0 += *s0.rates.get(o.animated_index as usize)? as u64 * ow;
                pos1 += *s1.rates.get(o.animated_index as usize)? as u64 * ow;
                comp += o.width as usize;
            }
            width_sum += o.width as usize;
        }
        let r0 = *s0.rates.get(a_i as usize)? as u32;
        let r1 = *s1.rates.get(a_i as usize)? as u32;
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        let mut vb = [0.0f32; 4];
        for k in 0..w {
            let (m0, e0) = seg_range(
                &clip_ranges,
                seg_ranges,
                &ch,
                k,
                s0.index * width_sum + comp + k,
            );
            let (m1, e1) = seg_range(
                &clip_ranges,
                seg_ranges,
                &ch,
                k,
                s1.index * width_sum + comp + k,
            );
            va[k] = decode(s0.data, pos0, r0, m0, e0);
            vb[k] = decode(s1.data, pos1, r1, m1, e1);
            pos0 += r0 as u64;
            pos1 += r1 as u64;
        }
        Some(Some((va, vb)))
    }
}

/// Component `k` of `ch`'s segment range at segment-range record `record`, widened into value
/// space: `(clip_min + (q_min / 255) · clip_extent, (q_extent / 255) · clip_extent)`.
#[inline]
fn seg_range(
    clip_ranges: &anim_format::F32s<'_>,
    seg_ranges: &[u8],
    ch: &anim_format::clip::Channel,
    k: usize,
    record: usize,
) -> (f32, f32) {
    let w = ch.width as usize;
    let cmin = clip_ranges.get(ch.data_offset as usize + k).unwrap_or(0.0);
    let cext = clip_ranges
        .get(ch.data_offset as usize + w + k)
        .unwrap_or(0.0);
    let q_min = seg_ranges.get(2 * record).copied().unwrap_or(0) as u32;
    let q_ext = seg_ranges.get(2 * record + 1).copied().unwrap_or(0) as u32;
    (
        unpack_range(q_min, 8, cmin, cext),
        unpack_unorm(q_ext, 8) * cext,
    )
}

/// Reads `bits` (≤ 32) bits at bit `pos`, least significant first; bytes past the end read 0.
#[inline]
fn read_bits(data: &[u8], pos: u64, bits: u32) -> u32 {
    let byte = (pos >> 3) as usize;
    let shift = (pos & 7) as u32;
    let mut word = [0u8; 8];
    match data.get(byte..byte.wrapping_add(8)) {
        Some(s) => word.copy_from_slice(s),
        None => {
            for (w, &d) in word.iter_mut().zip(data.get(byte..).unwrap_or(&[])) {
                *w = d;
            }
        }
    }
    let v = u64::from_le_bytes(word) >> shift;
    (v & ((1u64 << bits) - 1)) as u32
}

/// One sample of rate `bits` at bit `pos` in a segment range.
#[inline]
fn decode(data: &[u8], pos: u64, bits: u32, min: f32, ext: f32) -> f32 {
    match bits {
        0 => min,
        32 => f32::from_bits(read_bits(data, pos, 32)),
        b if is_supported_bits(b) => unpack_range(read_bits(data, pos, b), b, min, ext),
        _ => min,
    }
}

/// Applies a bone channel's decoded components.
#[inline]
fn apply(t: &mut AosTransform, kind: ChannelKind, v: &[f32; 4], format: RotationFormat) {
    match kind {
        ChannelKind::Rotation => {
            let w = match format {
                RotationFormat::QuatDropW => {
                    let d = 1.0 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
                    Lane::max(d, 0.0).sqrt()
                }
                RotationFormat::QuatFull => v[3],
            };
            t.rotation = AosQuat::new(v[0], v[1], v[2], w);
        }
        ChannelKind::Translation => t.translation = AosVec3::new(v[0], v[1], v[2]),
        ChannelKind::Scale => t.scale = AosVec3::new(v[0], v[1], v[2]),
        ChannelKind::Value => {}
    }
}
