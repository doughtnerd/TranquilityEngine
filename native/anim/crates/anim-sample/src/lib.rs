//! `anim-sample` (ADR 0370): decompress and sample clips into SoA local poses; sample generic
//! property tracks; sample discrete, event and the other keyed tracks over a time window.
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
//!
//! # Frame cache
//!
//! A playing clip samples a moving time, and at a display rate above the clip's sample rate
//! consecutive samples mostly share their frames (`f0` of one is `f0` or `f1` of the last). A
//! [`FrameCache`] (T82r; ozz-animation's sampling context) keeps the last two frames a player
//! decoded, in memory the caller owns (one per playing clip player), so
//! [`BoundClip::sample_pose_cached`] decodes only frames it doesn't hold and redoes only the
//! interpolation. It holds exactly the decoded values, keyed by the clip's bytes, the rest pose
//! and a caller tag (bumped when assets are released, so memory reused by another clip never
//! matches), so results are bit-identical with and without it, and a cache can be dropped or
//! cleared at any time (it is never part of a snapshot).
//!
//! # Binding table
//!
//! A [`ClipSampler`] reads the clip's 16-byte channel and 32-byte track records as it samples,
//! which suits one-off sampling. A playing clip builds a [`ClipBindings`] once (when it loads;
//! that allocates) and samples through the [`BoundClip`] it pairs with the sampler: the same bits
//! (the same arithmetic in the same order; a test holds them equal), without the record parsing.
//! See [`bind`'s docs](ClipBindings) for what it holds, and its output columns.
//!
//! # Track windows
//!
//! [`window`] samples the keyed kinds (`discrete`, `activation`, `event` notifies and notify
//! states, `marker`, `subclip`, `control`, `audio`) over a playhead move `(t_prev, t_now]`, with
//! loops, reverse play, seeks and weight gating, into caller-provided column words and a
//! [`TrackSink`] of [`TrackRecord`]s. Tested against `anim-offline::sample`'s window reference.
//!
//! # Engine curves
//!
//! [`curve`] (T70) reads engine-curve keys from the host and evaluates them with the shared
//! `myco-curve` crate (the audio core's evaluator, held to `curve.ts` by its parity test): curve
//! assets for easing, and uniform sampling of source and runtime curve tracks.

use anim_format::clip::{
    ChannelKind, ChannelMode, ClipView, CompressedView, QuatInterp, RotationFormat, TrackKind,
    CLIP_SLERP,
};
use anim_format::skeleton::SkeletonView;
use anim_format::NONE;
use anim_math::layout::{soa_len, LANES};
use anim_math::quant::{is_supported_bits, unpack_range, unpack_range4, unpack_unorm};
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, Lane, SoaTransform};

mod bind;
pub mod curve;
mod frames;
pub mod timeline;
pub mod window;

pub use bind::{BoundClip, ClipBindings, Column, ColumnType};
pub use frames::FrameCache;
pub use window::{
    NotifyPhase, TrackRecord, TrackSink, Window, MAX_WRAPS, SUBCLIP_ENTERED, SUBCLIP_EXITED,
    WINDOW_SEEK, WINDOW_START,
};

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
    /// The [`ClipBindings`] were built for another clip or form.
    Bindings,
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

/// Group `g` of an AoS pose packed four bones at a time (lanes past the pose: the default
/// transform).
#[inline(always)]
pub(crate) fn group(pose: &[AosTransform], g: usize) -> SoaTransform {
    SoaTransform::from_aos(&core::array::from_fn(|l| {
        pose.get(g * LANES + l).copied().unwrap_or_default()
    }))
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
    pub(crate) key: usize,
    pub(crate) segment: u32,
    /// The cached segment's bits per frame and Σ animated widths.
    pub(crate) frame_bits: u64,
    pub(crate) width_sum: usize,
    pub(crate) ranges: &'m mut [f32],
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
    pub(crate) view: ClipView<'a>,
    pub(crate) comp: Option<CompressedView<'a>>,
    frames: u32,
    rate: f32,
    bones: usize,
    slerp: bool,
}

/// A segment's decoding context.
#[derive(Clone, Copy)]
pub(crate) struct Seg<'a> {
    pub(crate) index: usize,
    pub(crate) data: &'a [u8],
    pub(crate) rates: &'a [u8],
    /// Bit position of the frame's first code.
    pub(crate) frame_pos: u64,
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
        self.pose_impl(None, t, rest, scratch, out, cache)
    }

    /// [`sample_pose`](Self::sample_pose), decoding through `bind` when given (the same values,
    /// bit for bit).
    pub(crate) fn pose_impl(
        &self,
        bind: Option<&ClipBindings>,
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
        match (self.comp, bind) {
            (Some(c), Some(bind)) => bind.decode_pose(&c, p, a, b, cache),
            (Some(c), None) => self.decode_pose(&c, p, a, b, cache),
            (None, Some(bind)) => bind.raw_pose(self, p, a, b),
            (None, None) => self.raw_pose(p, a, b),
        }
        self.interpolate(p, a, b, out);
        Ok(())
    }

    /// The pose between the decoded frames `a` (at `p.f0`) and `b` (at `p.f1`) into `out`.
    pub(crate) fn interpolate(
        &self,
        p: FramePos,
        a: &[AosTransform],
        b: &[AosTransform],
        out: &mut [SoaTransform],
    ) {
        let alpha = F32x4::splat(p.alpha);
        for (g, o) in out.iter_mut().enumerate() {
            *o = self.interpolate_group(group(a, g), group(b, g), alpha);
        }
    }

    /// One group of [`interpolate`](Self::interpolate), from the frames' groups (as [`group`]
    /// packs them).
    #[inline(always)]
    pub(crate) fn interpolate_group(
        &self,
        ta: SoaTransform,
        tb: SoaTransform,
        alpha: F32x4,
    ) -> SoaTransform {
        let rotation = if self.slerp {
            ta.rotation
                .normalize_or_identity()
                .slerp(tb.rotation.normalize_or_identity(), alpha)
                .normalize_or_identity()
        } else {
            ta.rotation.nlerp(tb.rotation, alpha)
        };
        SoaTransform::new(
            ta.translation.lerp(tb.translation, alpha),
            rotation,
            ta.scale.lerp(tb.scale, alpha),
        )
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
                let (min, ext) = seg_range(
                    &clip_ranges,
                    seg_ranges,
                    ch.width,
                    ch.data_offset,
                    k,
                    seg * width_sum + comp + k,
                );
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
                                ch.width,
                                ch.data_offset,
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
                                ch.width,
                                ch.data_offset,
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
        blend_track(info.kind, info.subtype, w, &va, &vb, p.alpha, out);
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
                ch.width,
                ch.data_offset,
                k,
                s0.index * width_sum + comp + k,
            );
            let (m1, e1) = seg_range(
                &clip_ranges,
                seg_ranges,
                ch.width,
                ch.data_offset,
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

/// Interpolates a property track's two frames into `out[..w]`: nlerp or slerp (by `subtype`) for
/// `quat`, linear otherwise.
#[inline]
pub(crate) fn blend_track(
    kind: TrackKind,
    subtype: u8,
    w: usize,
    va: &[f32; 4],
    vb: &[f32; 4],
    alpha: f32,
    out: &mut [f32],
) {
    if kind == TrackKind::Quat {
        let qa = AosQuat::new(va[0], va[1], va[2], va[3]).normalize_or_identity();
        let qb = AosQuat::new(vb[0], vb[1], vb[2], vb[3]).normalize_or_identity();
        let q = if QuatInterp::from_u8(subtype) == Some(QuatInterp::Slerp) {
            qa.slerp(qb, alpha).normalize_or_identity()
        } else {
            qa.nlerp(qb, alpha)
        };
        out[..4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
    } else {
        for k in 0..w {
            out[k] = va[k] + (vb[k] - va[k]) * alpha;
        }
    }
}

/// Component `k` of a channel's segment range at segment-range record `record`, widened into value
/// space: `(clip_min + (q_min / 255) · clip_extent, (q_extent / 255) · clip_extent)`.
#[inline]
pub(crate) fn seg_range(
    clip_ranges: &anim_format::F32s<'_>,
    seg_ranges: &[u8],
    width: u8,
    data_offset: u32,
    k: usize,
    record: usize,
) -> (f32, f32) {
    let w = width as usize;
    let cmin = clip_ranges.get(data_offset as usize + k).unwrap_or(0.0);
    let cext = clip_ranges.get(data_offset as usize + w + k).unwrap_or(0.0);
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
    (read_word(data, pos) & ((1u64 << bits) - 1)) as u32
}

/// The 64 bits from byte `pos / 8` on (bytes past the end read 0), shifted right by `pos % 8`:
/// bit `pos + i` is bit `i` for `i < 64 − pos % 8`.
#[inline]
pub(crate) fn read_word(data: &[u8], pos: u64) -> u64 {
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
    u64::from_le_bytes(word) >> shift
}

/// One sample of rate `bits` at bit `pos` in a segment range.
#[inline]
pub(crate) fn decode(data: &[u8], pos: u64, bits: u32, min: f32, ext: f32) -> f32 {
    match bits {
        0 => min,
        32 => f32::from_bits(read_bits(data, pos, 32)),
        b if is_supported_bits(b) => unpack_range(read_bits(data, pos, b), b, min, ext),
        _ => min,
    }
}

/// `n` (≤ 4) consecutive samples of rate `bits` from bit `pos`, each in its own range: lane `k <
/// n` is `decode(data, pos + k·bits, bits, min[k], ext[k])`, bit for bit (lanes from `n` on are
/// unspecified). When the codes fit one 64-bit read they are unpacked four at a time (the same
/// correctly rounded division, multiply and add per lane as [`unpack_range`]).
#[inline(always)]
pub(crate) fn decode_n(
    data: &[u8],
    pos: u64,
    bits: u32,
    n: usize,
    min: [f32; 4],
    ext: [f32; 4],
) -> [f32; 4] {
    if is_supported_bits(bits) && (pos & 7) + n as u64 * bits as u64 <= 64 {
        let word = read_word(data, pos);
        let mask = (1u64 << bits) - 1;
        let code = |k: usize| {
            if k < n {
                ((word >> (k as u32 * bits)) & mask) as u32
            } else {
                0
            }
        };
        unpack_range4(
            [code(0), code(1), code(2), code(3)],
            bits,
            F32x4::from_array(min),
            F32x4::from_array(ext),
        )
        .to_array()
    } else {
        decode_each(data, pos, bits, n, min, ext)
    }
}

/// [`decode_n`] one sample at a time (rates of 0 or 32 bits, or codes past one 64-bit read).
#[cold]
#[inline(never)]
fn decode_each(
    data: &[u8],
    pos: u64,
    bits: u32,
    n: usize,
    min: [f32; 4],
    ext: [f32; 4],
) -> [f32; 4] {
    core::array::from_fn(|k| {
        if k < n {
            decode(data, pos + (k as u32 * bits) as u64, bits, min[k], ext[k])
        } else {
            0.0
        }
    })
}

/// The rotation's w from its decoded components.
#[inline(always)]
fn rotation_w(v: &[f32; 4], format: RotationFormat) -> f32 {
    match format {
        RotationFormat::QuatDropW => {
            let d = 1.0 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
            Lane::max(d, 0.0).sqrt()
        }
        RotationFormat::QuatFull => v[3],
    }
}

/// Applies a bone channel's decoded components.
#[inline]
pub(crate) fn apply(t: &mut AosTransform, kind: ChannelKind, v: &[f32; 4], format: RotationFormat) {
    match kind {
        ChannelKind::Rotation => {
            let w = rotation_w(v, format);
            t.rotation = AosQuat::new(v[0], v[1], v[2], w);
        }
        ChannelKind::Translation => t.translation = AosVec3::new(v[0], v[1], v[2]),
        ChannelKind::Scale => t.scale = AosVec3::new(v[0], v[1], v[2]),
        ChannelKind::Value => {}
    }
}

/// [`apply`] into lane `bone % 4` of group `bone / 4` of a SoA pose: the same values.
#[inline(always)]
pub(crate) fn apply_soa(
    pose: &mut [SoaTransform],
    bone: usize,
    kind: ChannelKind,
    v: &[f32; 4],
    format: RotationFormat,
) {
    let Some(g) = pose.get_mut(bone / LANES) else {
        return;
    };
    let w = if kind == ChannelKind::Rotation {
        rotation_w(v, format)
    } else {
        0.0
    };
    // One branch on the lane, then constant-lane writes.
    match bone % LANES {
        0 => put_lane(g, 0, kind, v, w),
        1 => put_lane(g, 1, kind, v, w),
        2 => put_lane(g, 2, kind, v, w),
        _ => put_lane(g, 3, kind, v, w),
    }
}

/// [`apply_soa`]'s writes into lane `l` of `g` (`w`: the rotation's w).
#[inline(always)]
fn put_lane(g: &mut SoaTransform, l: usize, kind: ChannelKind, v: &[f32; 4], w: f32) {
    match kind {
        ChannelKind::Rotation => {
            let q = &mut g.rotation;
            q.x = q.x.with_lane(l, v[0]);
            q.y = q.y.with_lane(l, v[1]);
            q.z = q.z.with_lane(l, v[2]);
            q.w = q.w.with_lane(l, w);
        }
        ChannelKind::Translation | ChannelKind::Scale => {
            let p = if kind == ChannelKind::Translation {
                &mut g.translation
            } else {
                &mut g.scale
            };
            p.x = p.x.with_lane(l, v[0]);
            p.y = p.y.with_lane(l, v[1]);
            p.z = p.z.with_lane(l, v[2]);
        }
        ChannelKind::Value => {}
    }
}
