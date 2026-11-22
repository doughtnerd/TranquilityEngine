//! The per-clip binding table: everything [`ClipSampler`] would otherwise re-read from the clip's
//! records on every sample, decoded once.
//!
//! [`ClipBindings::new`] reads the track table, the compressed channel table, the per-segment bit
//! rates and the key lists once (it allocates; build it when the clip loads). It then holds:
//!
//! - per compressed channel: kind, mode, width, data offset, animated index, the animated
//!   components before it, and its bone (resolved from the track record, `NONE` for value
//!   channels and bones out of range);
//! - per segment: bits per frame; per segment and animated value channel: the channel's bit
//!   offset inside a frame (so one property track decodes without walking the channel table);
//! - per bone track of the raw form: its bone and raw offset;
//! - per track: kind, subtype, width, binding, value channel and output column;
//! - every key, decoded; the instant keys (notifies, markers, audio, control) merged into one list
//!   sorted by (time, track, key); the notify states; the sync markers sorted by time.
//!
//! [`ClipBindings::bind`] pairs the table with a sampler of the same clip and form into a
//! [`BoundClip`], whose `sample_pose` and `sample_track` give **the same bits** as the
//! sampler's own (they run the same decode arithmetic in the same order; only the bookkeeping
//! moved), and which samples track windows ([`crate::window`]).
//!
//! # Output columns
//!
//! Each property track the Animator writes to the ECS gets a column of 32-bit words in a
//! per-clip column block ([`ClipBindings::column_words`] words, in track order): sampled value
//! tracks (`float`..`vec4`, `color`, `quat`, `morph`, `curve`) `width` f32 words, `discrete` one
//! u32 word (the current key's payload id), `activation` one u32 word (0 or 1). Bone tracks feed
//! the pose and the keyed event kinds feed records, so they have no column.

use anim_format::clip::{
    Binding, ChannelKind, ChannelMode, ClipView, CompressedView, Key, KeyData, MarkerKind,
    TrackKind,
};
use anim_format::NONE;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_pose::sync::SyncMarker;

use crate::Form;
use crate::{
    apply, blend_track, decode, seg_range, ClipSampler, FramePos, SampleError, Seg, SegmentCache,
    TrackSample,
};

/// A compressed channel, decoded.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ChanBind {
    kind: ChannelKind,
    mode: ChannelMode,
    width: u8,
    data_offset: u32,
    animated_index: u32,
    /// Animated components of the channels before this one.
    comp: u32,
    /// The bone this channel drives, or `NONE`.
    bone: u32,
}

/// A track record, decoded, with its column and value channel.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TrackBind {
    pub(crate) kind: TrackKind,
    pub(crate) subtype: u8,
    pub(crate) width: u8,
    pub(crate) binding: Binding,
    raw_offset: u32,
    /// The compressed value channel (index into `channels`), or `NONE`.
    channel: u32,
    /// Rank among animated value channels, or `NONE`.
    value: u32,
    pub(crate) first_key: u32,
    pub(crate) key_count: u32,
    pub(crate) column: u32,
}

/// An instant key in the merged crossing list.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Cross {
    pub(crate) time: f32,
    pub(crate) track: u32,
    pub(crate) key: u32,
}

/// A notify state (an event key with `end > time`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct StateKey {
    pub(crate) track: u32,
    pub(crate) key: u32,
}

/// A column's word type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnType {
    /// f32 words (sampled value tracks).
    F32,
    /// u32 words (`discrete` payload ids, `activation` 0/1).
    U32,
}

/// One track's output column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Column {
    /// The track index.
    pub track: u32,
    /// The track's kind.
    pub kind: TrackKind,
    /// The words' type.
    pub ty: ColumnType,
    /// The first word in the clip's column block.
    pub offset: u32,
    /// Words (the track width; 1 for `discrete` and `activation`).
    pub width: u32,
    /// A dropped default channel of the compressed form: never written, so the field keeps its
    /// default and `animation.Apply` can skip it.
    pub default: bool,
}

/// The per-clip binding table (see the module docs). Build once per clip and form.
#[derive(Clone, Debug)]
pub struct ClipBindings {
    form: Form,
    frame_count: u32,
    pub(crate) duration: f32,
    pub(crate) looping: bool,
    segment_frames: u32,
    channels: Vec<ChanBind>,
    seg_frame_bits: Vec<u64>,
    /// Per segment, per animated value channel: its bit offset inside a frame.
    value_offsets: Vec<u32>,
    value_animated: usize,
    width_sum: usize,
    /// Raw form: (bone, raw offset) per bone track.
    raw_bones: Vec<(u32, u32)>,
    pub(crate) tracks: Vec<TrackBind>,
    pub(crate) keys: Vec<Key>,
    pub(crate) crossings: Vec<Cross>,
    pub(crate) states: Vec<StateKey>,
    sync: Vec<SyncMarker>,
    column_words: u32,
}

impl ClipBindings {
    /// The table for `sampler`'s clip and form. Allocates; never panics on a parsed clip.
    pub fn new(sampler: &ClipSampler<'_>) -> Self {
        let view = sampler.view;
        let bones = sampler.bone_count();
        let (tracks, keys, column_words) = read_tracks(&view);
        let mut b = ClipBindings {
            form: sampler.form(),
            frame_count: view.frame_count(),
            duration: view.duration(),
            looping: view.flags() & anim_format::clip::CLIP_LOOP != 0,
            segment_frames: 1,
            channels: Vec::new(),
            seg_frame_bits: Vec::new(),
            value_offsets: Vec::new(),
            value_animated: 0,
            width_sum: 0,
            raw_bones: Vec::new(),
            tracks,
            keys,
            crossings: Vec::new(),
            states: Vec::new(),
            sync: Vec::new(),
            column_words,
        };
        match sampler.comp {
            Some(c) => b.read_channels(&c, bones),
            None => {
                for t in &b.tracks {
                    if t.kind == TrackKind::Bone && t.raw_offset != NONE {
                        b.raw_bones.push((t.binding.bone, t.raw_offset));
                    }
                }
            }
        }
        b.read_keys();
        b
    }

    fn read_channels(&mut self, c: &CompressedView<'_>, bones: usize) {
        self.segment_frames = c.segment_frames().max(1);
        let mut comp = 0u32;
        // (animated index, width) of every animated channel, and the animated index of every
        // animated value channel, in value order.
        let mut animated: Vec<(u32, u32)> = Vec::new();
        let mut values: Vec<u32> = Vec::new();
        for i in 0..c.channel_count() {
            let Some(ch) = c.channel(i) else { break };
            let track = self.tracks.get_mut(ch.track as usize);
            let bone = match &track {
                Some(t) if t.kind == TrackKind::Bone && (t.binding.bone as usize) < bones => {
                    t.binding.bone
                }
                _ => NONE,
            };
            if let (Some(t), ChannelKind::Value) = (track, ch.kind) {
                t.channel = i as u32;
                if ch.mode == ChannelMode::Animated {
                    t.value = values.len() as u32;
                    values.push(ch.animated_index);
                }
            }
            self.channels.push(ChanBind {
                kind: ch.kind,
                mode: ch.mode,
                width: ch.width,
                data_offset: ch.data_offset,
                animated_index: ch.animated_index,
                comp,
                bone,
            });
            if ch.mode == ChannelMode::Animated {
                animated.push((ch.animated_index, ch.width as u32));
                comp += ch.width as u32;
            }
        }
        self.width_sum = comp as usize;
        self.value_animated = values.len();
        // Bits before each animated index, per segment (the bitstream is in animated order).
        let mut before = vec![0u64; animated.len() + 1];
        for s in 0..c.segment_count() {
            let rates = c.bit_rates(s).unwrap_or(&[]);
            let mut per = vec![0u64; animated.len()];
            for &(ai, w) in &animated {
                if let Some(slot) = per.get_mut(ai as usize) {
                    *slot = rates.get(ai as usize).copied().unwrap_or(0) as u64 * w as u64;
                }
            }
            for (i, p) in per.iter().enumerate() {
                before[i + 1] = before[i] + p;
            }
            self.seg_frame_bits.push(before[animated.len()]);
            for &ai in &values {
                self.value_offsets
                    .push(before.get(ai as usize).copied().unwrap_or(0) as u32);
            }
        }
    }

    fn read_keys(&mut self) {
        for (ti, t) in self.tracks.iter().enumerate() {
            for k in t.first_key..t.first_key + t.key_count {
                let Some(key) = self.keys.get(k as usize) else {
                    continue;
                };
                match key.data {
                    KeyData::Event { .. } if key.end > key.time => self.states.push(StateKey {
                        track: ti as u32,
                        key: k,
                    }),
                    KeyData::Event { .. }
                    | KeyData::Marker { .. }
                    | KeyData::Audio { .. }
                    | KeyData::Control { .. } => self.crossings.push(Cross {
                        time: key.time,
                        track: ti as u32,
                        key: k,
                    }),
                    _ => {}
                }
                if let KeyData::Marker {
                    kind: MarkerKind::Sync,
                    name,
                } = key.data
                {
                    self.sync.push(SyncMarker {
                        id: name,
                        time: key.time,
                    });
                }
            }
        }
        // Stable: ties keep (track, key) order.
        self.crossings.sort_by(|a, b| a.time.total_cmp(&b.time));
        self.sync.sort_by(|a, b| a.time.total_cmp(&b.time));
    }

    /// Pairs the table with `sampler`, which must read the clip and form it was built from.
    pub fn bind<'a, 'b>(
        &'b self,
        sampler: ClipSampler<'a>,
    ) -> Result<BoundClip<'a, 'b>, SampleError> {
        let v = sampler.view;
        let mut ok = sampler.form() == self.form
            && v.track_count() == self.tracks.len()
            && v.frame_count() == self.frame_count
            && v.duration() == self.duration;
        if let Some(c) = sampler.comp {
            ok &= c.channel_count() == self.channels.len()
                && c.segment_count() == self.seg_frame_bits.len()
                && c.segment_frames().max(1) == self.segment_frames;
        }
        if !ok {
            return Err(SampleError::Bindings);
        }
        Ok(BoundClip {
            sampler,
            bindings: self,
        })
    }

    /// Pairs the table with `sampler` without [`bind`](Self::bind)'s checks: for a caller that
    /// keeps a pair `bind` accepted together and pairs it on every sample (a loaded clip asset).
    /// A mismatched pair samples wrong values, never out of bounds (every read is checked).
    pub fn pair_unchecked<'a, 'b>(&'b self, sampler: ClipSampler<'a>) -> BoundClip<'a, 'b> {
        BoundClip {
            sampler,
            bindings: self,
        }
    }

    /// The form the table was built for.
    pub fn form(&self) -> Form {
        self.form
    }

    /// The clip's duration, seconds.
    pub fn duration(&self) -> f32 {
        self.duration
    }

    /// Whether the clip's header says it loops.
    pub fn looping(&self) -> bool {
        self.looping
    }

    /// The number of tracks.
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// Words of the clip's column block.
    pub fn column_words(&self) -> usize {
        self.column_words as usize
    }

    /// Track `track`'s output column, if it has one.
    pub fn column(&self, track: usize) -> Option<Column> {
        let t = self.tracks.get(track)?;
        if t.column == NONE {
            return None;
        }
        let (ty, width) = match t.kind {
            TrackKind::Discrete | TrackKind::Activation => (ColumnType::U32, 1),
            _ => (ColumnType::F32, t.width as u32),
        };
        let default = t.channel != NONE
            && self
                .channels
                .get(t.channel as usize)
                .is_some_and(|c| c.mode == ChannelMode::Default);
        Some(Column {
            track: track as u32,
            kind: t.kind,
            ty,
            offset: t.column,
            width,
            default,
        })
    }

    /// Every column, in track (and offset) order.
    pub fn columns(&self) -> impl Iterator<Item = Column> + '_ {
        (0..self.tracks.len()).filter_map(|i| self.column(i))
    }

    /// The number of notify states (event keys with `end > time`).
    pub fn notify_state_count(&self) -> usize {
        self.states.len()
    }

    /// u32 words of per-playing-clip notify-state memory (one bit per notify state).
    pub fn notify_words(&self) -> usize {
        self.states.len().div_ceil(32)
    }

    /// Key `index` (its index in the clip's `KEYS` section).
    pub fn key(&self, index: usize) -> Option<Key> {
        self.keys.get(index).copied()
    }

    /// The clip's sync markers (`marker` keys of kind `sync`, every marker track), sorted by time:
    /// the input of `anim_pose::sync::SyncClip` for phase sync.
    pub fn sync_markers(&self) -> &[SyncMarker] {
        &self.sync
    }

    /// Floats a [`SegmentCache`] needs (as [`ClipSampler::cache_len`]).
    pub fn cache_len(&self) -> usize {
        2 * self.width_sum
    }

    // -----------------------------------------------------------------------------------------
    // Decoding (the same arithmetic as `ClipSampler`'s record path, in the same order)
    // -----------------------------------------------------------------------------------------

    pub(crate) fn raw_pose(
        &self,
        s: &ClipSampler<'_>,
        p: FramePos,
        a: &mut [AosTransform],
        b: &mut [AosTransform],
    ) {
        let Some(raw) = s.view.raw() else { return };
        for &(bone, off) in &self.raw_bones {
            let frame = |f: u32| -> Option<AosTransform> {
                let s = raw.slice(off as usize + f as usize * 10, 10)?;
                let v = |k: usize| s.get(k).unwrap_or(0.0);
                Some(AosTransform::new(
                    AosVec3::new(v(0), v(1), v(2)),
                    AosQuat::new(v(3), v(4), v(5), v(6)),
                    AosVec3::new(v(7), v(8), v(9)),
                ))
            };
            let bone = bone as usize;
            if let (Some(x), Some(y), true) = (frame(p.f0), frame(p.f1), bone < a.len()) {
                a[bone] = x;
                b[bone] = y;
            }
        }
    }

    fn seg<'a>(&self, c: &CompressedView<'a>, index: usize, frame: u32) -> Option<Seg<'a>> {
        let bits = *self.seg_frame_bits.get(index)?;
        let start = index as u32 * self.segment_frames;
        Some(Seg {
            index,
            data: c.segment_data(index)?,
            rates: c.bit_rates(index)?,
            frame_pos: frame.saturating_sub(start) as u64 * bits,
        })
    }

    fn fill_cache(&self, c: &CompressedView<'_>, seg: usize, cache: &mut SegmentCache<'_>) -> bool {
        let key = c.data().as_ptr() as usize;
        if cache.key == key && cache.segment == seg as u32 {
            return true;
        }
        let Some(&frame_bits) = self.seg_frame_bits.get(seg) else {
            return false;
        };
        let width_sum = self.width_sum;
        if cache.ranges.len() < 2 * width_sum {
            return false;
        }
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        for ch in &self.channels {
            if ch.mode != ChannelMode::Animated {
                continue;
            }
            let comp = ch.comp as usize;
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
        }
        cache.key = key;
        cache.segment = seg as u32;
        cache.frame_bits = frame_bits;
        cache.width_sum = width_sum;
        true
    }

    pub(crate) fn decode_pose(
        &self,
        c: &CompressedView<'_>,
        p: FramePos,
        a: &mut [AosTransform],
        b: &mut [AosTransform],
        cache: Option<&mut SegmentCache<'_>>,
    ) {
        let sf = self.segment_frames;
        let (i0, i1) = ((p.f0 / sf) as usize, (p.f1 / sf) as usize);
        let cache = cache.and_then(|cache| self.fill_cache(c, i0, cache).then_some(cache));
        let cached: Option<&[f32]> = cache.map(|c| &*c.ranges);
        let width_sum = self.width_sum;
        let (Some(s0), Some(s1)) = (self.seg(c, i0, p.f0), self.seg(c, i1, p.f1)) else {
            return;
        };
        let format = c.rotation_format();
        let constants = c.constants();
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        let (mut pos0, mut pos1) = (s0.frame_pos, s1.frame_pos);
        for ch in &self.channels {
            let w = ch.width as usize;
            let mut va = [0.0f32; 4];
            let mut vb = [0.0f32; 4];
            match ch.mode {
                ChannelMode::Default => continue,
                ChannelMode::Constant => {
                    if ch.bone == NONE {
                        continue;
                    }
                    for (k, v) in va.iter_mut().enumerate().take(w) {
                        *v = constants.get(ch.data_offset as usize + k).unwrap_or(0.0);
                    }
                    vb = va;
                }
                ChannelMode::Animated => {
                    let a_i = ch.animated_index as usize;
                    let r0 = s0.rates.get(a_i).copied().unwrap_or(0) as u32;
                    let r1 = s1.rates.get(a_i).copied().unwrap_or(0) as u32;
                    let n = w.min(4);
                    if ch.bone == NONE {
                        // A value channel between bone channels: skip its codes.
                        pos0 += r0 as u64 * n as u64;
                        pos1 += r1 as u64 * n as u64;
                        continue;
                    }
                    let comp = ch.comp as usize;
                    for k in 0..n {
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
                }
            }
            let bone = ch.bone as usize;
            if bone < a.len() {
                apply(&mut a[bone], ch.kind, &va, format);
                apply(&mut b[bone], ch.kind, &vb, format);
            }
        }
    }

    pub(crate) fn sample_track(
        &self,
        s: &ClipSampler<'_>,
        track: usize,
        t: f32,
        out: &mut [f32],
    ) -> TrackSample {
        let Some(tb) = self.tracks.get(track) else {
            return TrackSample::Skipped;
        };
        let w = tb.width as usize;
        if tb.kind == TrackKind::Bone || !tb.kind.is_sampled() || out.len() < w || w > 4 {
            return TrackSample::Skipped;
        }
        let p = s.frame_pos(t);
        let mut va = [0.0f32; 4];
        let mut vb = [0.0f32; 4];
        match s.comp {
            None => {
                let Some(raw) = s.view.raw() else {
                    return TrackSample::Skipped;
                };
                if tb.raw_offset == NONE {
                    return TrackSample::Skipped;
                }
                let base = tb.raw_offset as usize;
                for k in 0..w {
                    va[k] = raw.get(base + p.f0 as usize * w + k).unwrap_or(0.0);
                    vb[k] = raw.get(base + p.f1 as usize * w + k).unwrap_or(0.0);
                }
            }
            Some(c) => match self.decode_value(&c, tb, p) {
                Some(Some((x, y))) => {
                    va = x;
                    vb = y;
                }
                Some(None) => return TrackSample::Default,
                None => return TrackSample::Skipped,
            },
        }
        blend_track(tb.kind, tb.subtype, w, &va, &vb, p.alpha, out);
        TrackSample::Written
    }

    #[allow(clippy::type_complexity)]
    fn decode_value(
        &self,
        c: &CompressedView<'_>,
        tb: &TrackBind,
        p: FramePos,
    ) -> Option<Option<([f32; 4], [f32; 4])>> {
        let ch = self.channels.get(tb.channel as usize)?;
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
        let sf = self.segment_frames;
        let (i0, i1) = ((p.f0 / sf) as usize, (p.f1 / sf) as usize);
        let s0 = self.seg(c, i0, p.f0)?;
        let s1 = self.seg(c, i1, p.f1)?;
        let nv = self.value_animated;
        let vi = tb.value as usize;
        let mut pos0 = s0.frame_pos + *self.value_offsets.get(i0 * nv + vi)? as u64;
        let mut pos1 = s1.frame_pos + *self.value_offsets.get(i1 * nv + vi)? as u64;
        let a_i = ch.animated_index as usize;
        let r0 = *s0.rates.get(a_i)? as u32;
        let r1 = *s1.rates.get(a_i)? as u32;
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        let (comp, width_sum) = (ch.comp as usize, self.width_sum);
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

/// Decodes the track table and every key; assigns columns.
fn read_tracks(view: &ClipView<'_>) -> (Vec<TrackBind>, Vec<Key>, u32) {
    let mut tracks = Vec::with_capacity(view.track_count());
    let mut keys = Vec::new();
    let mut words = 0u32;
    for i in 0..view.track_count() {
        let first = keys.len() as u32;
        let Some(t) = view.track(i) else {
            // Unreachable on a parsed clip; keeps indices aligned.
            tracks.push(TrackBind {
                kind: TrackKind::Event,
                subtype: 0,
                width: 0,
                binding: Binding::none(),
                raw_offset: NONE,
                channel: NONE,
                value: NONE,
                first_key: first,
                key_count: 0,
                column: NONE,
            });
            continue;
        };
        keys.extend(view.track_keys(i));
        let width = match t.kind {
            TrackKind::Bone => 0,
            k if k.is_sampled() => t.width as u32,
            TrackKind::Discrete | TrackKind::Activation => 1,
            _ => 0,
        };
        let column = if width > 0 { words } else { NONE };
        words += width;
        tracks.push(TrackBind {
            kind: t.kind,
            subtype: t.subtype,
            width: t.width,
            binding: t.binding,
            raw_offset: t.raw_offset,
            channel: NONE,
            value: NONE,
            first_key: first,
            key_count: keys.len() as u32 - first,
            column,
        });
    }
    (tracks, keys, words)
}

/// A [`ClipSampler`] paired with its clip's [`ClipBindings`]. `Copy`.
#[derive(Clone, Copy)]
pub struct BoundClip<'a, 'b> {
    pub(crate) sampler: ClipSampler<'a>,
    pub(crate) bindings: &'b ClipBindings,
}

impl<'a, 'b> BoundClip<'a, 'b> {
    /// The sampler.
    pub fn sampler(&self) -> &ClipSampler<'a> {
        &self.sampler
    }

    /// The binding table.
    pub fn bindings(&self) -> &'b ClipBindings {
        self.bindings
    }

    /// [`ClipSampler::sample_pose`] through the binding table: the same bits, without re-reading
    /// the channel and track records.
    pub fn sample_pose(
        &self,
        t: f32,
        rest: &[AosTransform],
        scratch: &mut [AosTransform],
        out: &mut [SoaTransform],
        cache: Option<&mut SegmentCache<'_>>,
    ) -> Result<(), SampleError> {
        self.sampler
            .pose_impl(Some(self.bindings), t, rest, scratch, out, cache)
    }

    /// [`ClipSampler::sample_track`] through the binding table: the same bits.
    pub fn sample_track(&self, track: usize, t: f32, out: &mut [f32]) -> TrackSample {
        self.bindings.sample_track(&self.sampler, track, t, out)
    }
}
