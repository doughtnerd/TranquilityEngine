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
    RotationFormat, TrackKind,
};
use anim_format::NONE;
use anim_math::quant::{is_supported_bits, unorm_max};
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, Lane, SoaTransform};
use anim_pose::sync::SyncMarker;

use crate::frames::lanes_on;
use crate::Form;
use crate::{
    apply, apply_soa, blend_track, decode, decode_n, group, read_word, seg_range, ClipSampler,
    FrameCache, FramePos, SampleError, Seg, SegmentCache, TrackSample,
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
    /// Rank among the animated channels (its ranges' slot in a frame cache), or `NONE`.
    rank: u32,
}

/// The animated channels of one kind (translation, rotation or scale) on the four bones of one SoA
/// group, decoded together (`ClipBindings::decode_grouped`). Each has three components.
#[derive(Clone, Copy, Debug)]
pub(crate) struct GroupOp {
    group: u32,
    kind: ChannelKind,
    /// Bit `l` set: lane `l` has a channel (its rank in `ranks[l]`).
    lanes: u8,
    ranks: [u32; 4],
}

/// Words per [`GroupOp`] in a frame cache's range block: per lane its rate and bit offset in the
/// frame, then four minimums per component (x, y, z), then four extents per component.
const GROUP_WORDS: usize = 8 + 24;
/// Where a range block's extents start.
const GROUP_EXT: usize = 8 + 12;

/// Lane `l` of a group op whose range block is `w`: its three codes and `2^rate − 1`, or `slow`
/// when its codes don't fit one 64-bit read or its rate is 0, 32 or unsupported (no channel:
/// zero codes).
#[inline(always)]
fn lane_codes(
    data: &[u8],
    frame_pos: u64,
    w: &[u32; GROUP_WORDS],
    lanes: u8,
    l: usize,
) -> ([u32; 3], f32, bool) {
    if lanes & (1 << l) == 0 {
        return ([0; 3], 1.0, false);
    }
    let r = w[l];
    let pos = frame_pos + w[4 + l] as u64;
    if r != 0 && is_supported_bits(r) && (pos & 7) + 3 * r as u64 <= 64 {
        let word = read_word(data, pos);
        let mask = (1u64 << r) - 1;
        let c = |k: u32| ((word >> (k * r)) & mask) as u32;
        ([c(0), c(1), c(2)], unorm_max(r) as f32, false)
    } else {
        ([0; 3], 1.0, true)
    }
}

/// Whether a sampling mask keeps `bone` (every bone without a mask).
#[inline(always)]
fn keeps(only: Option<&[F32x4]>, bone: u32) -> bool {
    only.is_none() || lanes_on(only, bone as usize / 4) & (1 << (bone % 4)) != 0
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
    /// The animated channels (indices into `channels`), in channel order, and whether every bone
    /// field (translation, rotation, scale) is written by at most one channel, so a frame decoded
    /// over another frame of the same clip rewrites only the animated ones.
    animated_channels: Vec<ChanBind>,
    exclusive: bool,
    /// With `exclusive`, when every animated bone channel is a translation, scale or (w-dropped)
    /// rotation of width 3: the channels by group and kind, decoded four lanes at a time (empty
    /// otherwise; a clip storing full rotations decodes channel by channel).
    group_ops: Vec<GroupOp>,
    /// Per animated channel (rank order) of a grouped clip: `4 × op + lane`, or `NONE`.
    group_slots: Vec<u32>,
    /// Every segment's [`frame_ranges`](Self::frame_ranges), `frame_ranges_len()` words each
    /// (D146: one table per clip, shared by every player, instead of a copy per player's frame
    /// cache).
    seg_ranges: Vec<u32>,
    /// Raw form: (bone, raw offset) per bone track.
    raw_bones: Vec<(u32, u32)>,
    pub(crate) tracks: Vec<TrackBind>,
    pub(crate) keys: Vec<Key>,
    pub(crate) crossings: Vec<Cross>,
    pub(crate) states: Vec<StateKey>,
    /// The tracks with an output column, the `activation` tracks and the `subclip` tracks, in
    /// track order (so a window visits only those, not every bone track).
    pub(crate) column_tracks: Vec<u32>,
    pub(crate) activation_tracks: Vec<u32>,
    pub(crate) subclip_tracks: Vec<u32>,
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
            animated_channels: Vec::new(),
            exclusive: true,
            group_ops: Vec::new(),
            group_slots: Vec::new(),
            seg_ranges: Vec::new(),
            raw_bones: Vec::new(),
            tracks,
            keys,
            crossings: Vec::new(),
            states: Vec::new(),
            column_tracks: Vec::new(),
            activation_tracks: Vec::new(),
            subclip_tracks: Vec::new(),
            sync: Vec::new(),
            column_words,
        };
        match sampler.comp {
            Some(c) => {
                b.read_channels(&c, bones);
                let len = b.frame_ranges_len();
                let mut ranges = vec![0u32; len * b.seg_frame_bits.len()];
                if len > 0 {
                    for (seg, out) in ranges.chunks_exact_mut(len).enumerate() {
                        b.frame_ranges(&c, seg, out);
                    }
                }
                b.seg_ranges = ranges;
            }
            None => {
                for t in &b.tracks {
                    if t.kind == TrackKind::Bone && t.raw_offset != NONE {
                        b.raw_bones.push((t.binding.bone, t.raw_offset));
                    }
                }
            }
        }
        b.read_keys();
        for (i, t) in b.tracks.iter().enumerate() {
            if t.column != NONE {
                b.column_tracks.push(i as u32);
            }
            match t.kind {
                TrackKind::Activation => b.activation_tracks.push(i as u32),
                TrackKind::Subclip => b.subclip_tracks.push(i as u32),
                _ => {}
            }
        }
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
                rank: if ch.mode == ChannelMode::Animated {
                    animated.len() as u32
                } else {
                    NONE
                },
            });
            if ch.mode == ChannelMode::Animated {
                animated.push((ch.animated_index, ch.width as u32));
                comp += ch.width as u32;
            }
        }
        self.width_sum = comp as usize;
        self.value_animated = values.len();
        // Which bone fields each channel writes (as `apply`), to find fields written twice.
        let mut written = vec![0u8; bones];
        for ch in &self.channels {
            if ch.mode == ChannelMode::Animated {
                self.animated_channels.push(*ch);
            }
            if ch.mode == ChannelMode::Default || ch.bone == NONE {
                continue;
            }
            let bit = match ch.kind {
                ChannelKind::Translation => 1,
                ChannelKind::Rotation => 2,
                ChannelKind::Scale => 4,
                ChannelKind::Value => 0,
            };
            if let Some(w) = written.get_mut(ch.bone as usize) {
                if *w & bit != 0 {
                    self.exclusive = false;
                }
                *w |= bit;
            }
        }
        self.build_group_ops(c.rotation_format(), bones);
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

    /// Fills `group_ops` when the clip's animated bone channels allow it (see the field).
    fn build_group_ops(&mut self, format: RotationFormat, bones: usize) {
        if !self.exclusive || format != RotationFormat::QuatDropW {
            return;
        }
        // (group, kind) -> op index.
        let mut index = vec![[NONE; 3]; bones.div_ceil(4)];
        let mut ops: Vec<GroupOp> = Vec::new();
        for ch in &self.animated_channels {
            if ch.bone == NONE {
                continue;
            }
            let slot = match ch.kind {
                ChannelKind::Translation => 0,
                ChannelKind::Rotation => 1,
                ChannelKind::Scale => 2,
                ChannelKind::Value => return,
            };
            if ch.width != 3 {
                return;
            }
            let (g, l) = (ch.bone as usize / 4, ch.bone as usize % 4);
            let Some(at) = index.get_mut(g) else { return };
            if at[slot] == NONE {
                at[slot] = ops.len() as u32;
                ops.push(GroupOp {
                    group: g as u32,
                    kind: ch.kind,
                    lanes: 0,
                    ranks: [NONE; 4],
                });
            }
            let op = &mut ops[at[slot] as usize];
            op.lanes |= 1 << l;
            op.ranks[l] = ch.rank;
        }
        let mut slots = vec![NONE; self.animated_channels.len()];
        for (i, op) in ops.iter().enumerate() {
            for (l, &rank) in op.ranks.iter().enumerate() {
                if let Some(s) = slots.get_mut(rank as usize) {
                    *s = (4 * i + l) as u32;
                }
            }
        }
        self.group_ops = ops;
        self.group_slots = slots;
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
        sampler: &'b ClipSampler<'a>,
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
    pub fn pair_unchecked<'a, 'b>(&'b self, sampler: &'b ClipSampler<'a>) -> BoundClip<'a, 'b> {
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

    /// The segment holding frame `f`, if its records are there.
    pub(crate) fn frame_seg<'a>(&self, c: &CompressedView<'a>, f: u32) -> Option<Seg<'a>> {
        self.seg(c, (f / self.segment_frames) as usize, f)
    }

    /// The index of the segment holding frame `f`.
    pub(crate) fn segment_of(&self, f: u32) -> u32 {
        f / self.segment_frames
    }

    /// Segment `seg`'s [`frame_ranges`](Self::frame_ranges), computed when the table was built.
    pub(crate) fn segment_ranges(&self, seg: usize) -> Option<&[u32]> {
        let len = self.frame_ranges_len();
        self.seg_ranges.get(seg * len..(seg + 1) * len)
    }

    /// Words [`frame_ranges`](Self::frame_ranges) writes: [`GROUP_WORDS`] per group op of a
    /// grouped clip, else eight per animated channel.
    pub(crate) fn frame_ranges_len(&self) -> usize {
        if self.group_ops.is_empty() {
            8 * self.animated_channels.len()
        } else {
            GROUP_WORDS * self.group_ops.len()
        }
    }

    /// Segment `seg`'s widened ranges (`seg_range`'s values, as f32 bits) into `out`. A grouped
    /// clip: [`GROUP_WORDS`] per group op (each lane's rate and bit offset in a frame, then the
    /// minimums and extents per component, four lanes each); otherwise eight words per animated
    /// channel in rank order: the minimum of each component (up to four, then 0), then the extent
    /// of each. `out` holds at least [`frame_ranges_len`](Self::frame_ranges_len) words.
    pub(crate) fn frame_ranges(&self, c: &CompressedView<'_>, seg: usize, out: &mut [u32]) {
        let width_sum = self.width_sum;
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        let range = |ch: &ChanBind, k: usize| {
            seg_range(
                &clip_ranges,
                seg_ranges,
                ch.width,
                ch.data_offset,
                k,
                seg * width_sum + ch.comp as usize + k,
            )
        };
        if self.group_ops.is_empty() {
            for (ch, o) in self
                .animated_channels
                .iter()
                .zip(out.as_chunks_mut::<8>().0)
            {
                o.fill(0);
                for k in 0..(ch.width as usize).min(4) {
                    let (min, ext) = range(ch, k);
                    o[k] = min.to_bits();
                    o[4 + k] = ext.to_bits();
                }
            }
            return;
        }
        let rates = c.bit_rates(seg).unwrap_or(&[]);
        let rate =
            |ch: &ChanBind| rates.get(ch.animated_index as usize).copied().unwrap_or(0) as u32;
        let len = self.frame_ranges_len().min(out.len());
        out[..len].fill(0);
        // Each channel's bit offset in a frame: the codes of the animated channels before it (as
        // `decode_channels` advances its position).
        let mut off = 0u64;
        for (ch, &slot) in self.animated_channels.iter().zip(&self.group_slots) {
            let r = rate(ch);
            let (op, l) = (slot as usize / 4, slot as usize % 4);
            let o = (slot != NONE).then(|| out.get_mut(op * GROUP_WORDS..(op + 1) * GROUP_WORDS));
            if let Some(Some(o)) = o {
                o[l] = r;
                o[4 + l] = off as u32;
                for k in 0..3 {
                    let (min, ext) = range(ch, k);
                    o[8 + 4 * k + l] = min.to_bits();
                    o[GROUP_EXT + 4 * k + l] = ext.to_bits();
                }
            }
            off += r as u64 * (ch.width as u64).min(4);
        }
    }

    /// Decodes frame `f` alone over `rest` into `out` (`soa_len(rest.len())` groups, packed as
    /// `group` packs a pose): the values [`decode_pose`](Self::decode_pose) writes into `a` when
    /// `f` is its `f0`, or into `b` when it is its `f1`, bit for bit (each value is decoded from
    /// its own segment's range either way). `ranges`, when given, holds the segment's
    /// [`frame_ranges`](Self::frame_ranges) (the same values `seg_range` computes). With `held`,
    /// `out` already holds another frame
    /// of this clip decoded by this call over the same `rest`; when no bone field is written by
    /// two channels (`exclusive`), only the animated channels are rewritten (the rest pose and
    /// the constant channels are already there). The caller
    /// checks [`frame_seg`](Self::frame_seg) first; without it nothing is written.
    ///
    /// With `only` (a sampling mask, one weight per bone packed like a pose), bones whose weight
    /// isn't above 0 may be skipped: their values in `out` are left as they were or written, so
    /// the caller reads only the bones the mask keeps (each written bone gets the same bits).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn decode_frame_soa(
        &self,
        c: &CompressedView<'_>,
        f: u32,
        rest: &[AosTransform],
        out: &mut [SoaTransform],
        ranges: Option<&[u32]>,
        held: bool,
        only: Option<&[F32x4]>,
    ) {
        let Some(s) = self.frame_seg(c, f) else {
            return;
        };
        let n = rest.len();
        let format = c.rotation_format();
        if !(held && self.exclusive) {
            for (g, o) in out.iter_mut().enumerate() {
                if only.is_none() || lanes_on(only, g) != 0 {
                    *o = group(rest, g);
                }
            }
            if !self.exclusive {
                // A field written twice: every channel in order, so the last write wins.
                self.decode_channels(c, &s, n, out, ranges, format, false, only);
                return;
            }
            let constants = c.constants();
            for ch in &self.channels {
                if ch.mode != ChannelMode::Constant || ch.bone == NONE || !keeps(only, ch.bone) {
                    continue;
                }
                let mut v = [0.0f32; 4];
                for (k, v) in v.iter_mut().enumerate().take(ch.width as usize) {
                    *v = constants.get(ch.data_offset as usize + k).unwrap_or(0.0);
                }
                if (ch.bone as usize) < n {
                    apply_soa(out, ch.bone as usize, ch.kind, &v, format);
                }
            }
        }
        match ranges {
            Some(rg) if rg.len() >= self.frame_ranges_len() => {
                if self.group_ops.is_empty() {
                    self.decode_animated(&s, n, out, rg, format, only)
                } else {
                    self.decode_grouped(&s, out, rg, only)
                }
            }
            _ => self.decode_channels(c, &s, n, out, ranges, format, true, only),
        }
    }

    /// [`decode_animated`](Self::decode_animated) for a grouped clip: each group op's lanes are
    /// read one by one and unpacked four at a time (per lane the same division, multiply and add
    /// as `decode`; a lane whose codes don't fit one 64-bit read, or whose rate is 0, 32 or
    /// unsupported, goes through `decode`), and the rotation's w is computed four at a time with
    /// `apply`'s operations. Lanes without a channel keep their values. An op none of whose lanes
    /// `only` keeps is skipped.
    #[inline(always)]
    fn decode_grouped(
        &self,
        s: &Seg<'_>,
        out: &mut [SoaTransform],
        rg: &[u32],
        only: Option<&[F32x4]>,
    ) {
        let (zero, one) = (F32x4::splat(0.0), F32x4::splat(1.0));
        for (op, w) in self.group_ops.iter().zip(rg.as_chunks::<GROUP_WORDS>().0) {
            if only.is_some() && op.lanes & lanes_on(only, op.group as usize) == 0 {
                continue;
            }
            let Some(g) = out.get_mut(op.group as usize) else {
                continue;
            };
            let read = |l: usize| lane_codes(s.data, s.frame_pos, w, op.lanes, l);
            let ((c0, m0, s0), (c1, m1, s1)) = (read(0), read(1));
            let ((c2, m2, s2), (c3, m3, s3)) = (read(2), read(3));
            let slow = s0 as u8 | (s1 as u8) << 1 | (s2 as u8) << 2 | (s3 as u8) << 3;
            let lanes = |o: usize| {
                F32x4::new(
                    f32::from_bits(w[o]),
                    f32::from_bits(w[o + 1]),
                    f32::from_bits(w[o + 2]),
                    f32::from_bits(w[o + 3]),
                )
            };
            let max = F32x4::new(m0, m1, m2, m3);
            let comp = |k: usize| {
                let c = F32x4::from_u32_array([c0[k], c1[k], c2[k], c3[k]]);
                lanes(8 + 4 * k) + c / max * lanes(GROUP_EXT + 4 * k)
            };
            let mut v = [comp(0), comp(1), comp(2)];
            if slow != 0 {
                for l in 0..4 {
                    if slow & (1 << l) == 0 {
                        continue;
                    }
                    let (r, pos) = (w[l], s.frame_pos + w[4 + l] as u64);
                    for (k, vk) in v.iter_mut().enumerate() {
                        let x = decode(
                            s.data,
                            pos + (k as u32 * r) as u64,
                            r,
                            f32::from_bits(w[8 + 4 * k + l]),
                            f32::from_bits(w[GROUP_EXT + 4 * k + l]),
                        );
                        *vk = vk.with_lane(l, x);
                    }
                }
            }
            let keep = op.lanes != 0b1111;
            let sel = |new: F32x4, old: F32x4| {
                if keep {
                    let on = |l: u8| if op.lanes & (1 << l) != 0 { 1.0 } else { 0.0 };
                    F32x4::select(F32x4::new(on(0), on(1), on(2), on(3)).gt(zero), new, old)
                } else {
                    new
                }
            };
            match op.kind {
                ChannelKind::Rotation => {
                    // `apply`'s w for a w-dropped rotation.
                    let d = one - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
                    let rw = d.max(zero).sqrt();
                    let q = &mut g.rotation;
                    q.x = sel(v[0], q.x);
                    q.y = sel(v[1], q.y);
                    q.z = sel(v[2], q.z);
                    q.w = sel(rw, q.w);
                }
                ChannelKind::Translation | ChannelKind::Scale => {
                    let p = if op.kind == ChannelKind::Translation {
                        &mut g.translation
                    } else {
                        &mut g.scale
                    };
                    p.x = sel(v[0], p.x);
                    p.y = sel(v[1], p.y);
                    p.z = sel(v[2], p.z);
                }
                ChannelKind::Value => {}
            }
        }
    }

    /// The animated channels of segment `s`'s frame into `out` (bones below `n`), their ranges
    /// from `rg` ([`frame_ranges`](Self::frame_ranges)): the hot loop of a cached decode.
    #[inline(always)]
    fn decode_animated(
        &self,
        s: &Seg<'_>,
        n: usize,
        out: &mut [SoaTransform],
        rg: &[u32],
        format: RotationFormat,
        only: Option<&[F32x4]>,
    ) {
        let mut pos = s.frame_pos;
        for (ch, w8) in self.animated_channels.iter().zip(rg.as_chunks::<8>().0) {
            let r = s
                .rates
                .get(ch.animated_index as usize)
                .copied()
                .unwrap_or(0) as u32;
            let m = (ch.width as usize).min(4);
            let bone = ch.bone as usize;
            if bone < n && keeps(only, ch.bone) {
                let min = [w8[0], w8[1], w8[2], w8[3]].map(f32::from_bits);
                let ext = [w8[4], w8[5], w8[6], w8[7]].map(f32::from_bits);
                let v = decode_n(s.data, pos, r, m, min, ext);
                apply_soa(out, bone, ch.kind, &v, format);
            }
            pos += r as u64 * m as u64;
        }
    }

    /// The channels of segment `s`'s frame into `out` (bones below `n`): only the animated ones
    /// with `animated_only`, else every channel in order (constants included). Bones `only`
    /// doesn't keep are skipped.
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    fn decode_channels(
        &self,
        c: &CompressedView<'_>,
        s: &Seg<'_>,
        n: usize,
        out: &mut [SoaTransform],
        ranges: Option<&[u32]>,
        format: RotationFormat,
        animated_only: bool,
        only: Option<&[F32x4]>,
    ) {
        let width_sum = self.width_sum;
        let constants = c.constants();
        let clip_ranges = c.clip_ranges();
        let seg_ranges = c.segment_ranges();
        let mut pos = s.frame_pos;
        let mut one = |ch: &ChanBind, pos: &mut u64| {
            let w = ch.width as usize;
            let mut v = [0.0f32; 4];
            match ch.mode {
                ChannelMode::Default => return,
                ChannelMode::Constant => {
                    if ch.bone == NONE || !keeps(only, ch.bone) {
                        return;
                    }
                    for (k, v) in v.iter_mut().enumerate().take(w) {
                        *v = constants.get(ch.data_offset as usize + k).unwrap_or(0.0);
                    }
                }
                ChannelMode::Animated => {
                    let a_i = ch.animated_index as usize;
                    let r = s.rates.get(a_i).copied().unwrap_or(0) as u32;
                    let m = w.min(4);
                    if ch.bone == NONE || !keeps(only, ch.bone) {
                        *pos += r as u64 * m as u64;
                        return;
                    }
                    let comp = ch.comp as usize;
                    let rank = ch.rank as usize;
                    let mut min = [0.0f32; 4];
                    let mut ext = [0.0f32; 4];
                    for k in 0..m {
                        (min[k], ext[k]) = match ranges {
                            Some(r) => (
                                f32::from_bits(r[8 * rank + k]),
                                f32::from_bits(r[8 * rank + 4 + k]),
                            ),
                            None => seg_range(
                                &clip_ranges,
                                seg_ranges,
                                ch.width,
                                ch.data_offset,
                                k,
                                s.index * width_sum + comp + k,
                            ),
                        };
                    }
                    v = decode_n(s.data, *pos, r, m, min, ext);
                    *pos += r as u64 * m as u64;
                }
            }
            let bone = ch.bone as usize;
            if bone < n {
                apply_soa(out, bone, ch.kind, &v, format);
            }
        };
        if animated_only {
            for ch in &self.animated_channels {
                one(ch, &mut pos);
            }
        } else {
            for ch in &self.channels {
                one(ch, &mut pos);
            }
        }
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

/// A [`ClipSampler`] paired with its clip's [`ClipBindings`]: two references, `Copy` (a sampler
/// holds its clip's parsed section tables, over a kilobyte, so it is borrowed, not copied, on
/// every sample).
#[derive(Clone, Copy)]
pub struct BoundClip<'a, 'b> {
    pub(crate) sampler: &'b ClipSampler<'a>,
    pub(crate) bindings: &'b ClipBindings,
}

impl<'a, 'b> BoundClip<'a, 'b> {
    /// The sampler.
    pub fn sampler(&self) -> &'b ClipSampler<'a> {
        self.sampler
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

    /// [`sample_pose`](Self::sample_pose) through a [`FrameCache`]: decodes only the frames
    /// around `t` the cache doesn't hold (the same bits as without it). The raw form, or a
    /// cache too short for the clip, samples as `sample_pose` does without a cache.
    pub fn sample_pose_cached(
        &self,
        t: f32,
        rest: &[AosTransform],
        scratch: &mut [AosTransform],
        out: &mut [SoaTransform],
        cache: &mut FrameCache<'_>,
    ) -> Result<(), SampleError> {
        crate::frames::sample(self, t, rest, scratch, out, cache, None)
    }

    /// [`sample_pose_cached`](Self::sample_pose_cached) for a caller that reads only the bones
    /// whose weight in `only` (one per bone, packed like a pose: `soa_len(bones)` groups; any other
    /// length keeps every bone) is above 0, such as a layer blended through that bone mask: those
    /// bones get the same bits, and the others may hold any values (their channels aren't
    /// decoded). The cache holds frames decoded under one mask (it refills when the mask changes).
    pub fn sample_pose_masked(
        &self,
        t: f32,
        rest: &[AosTransform],
        scratch: &mut [AosTransform],
        out: &mut [SoaTransform],
        cache: &mut FrameCache<'_>,
        only: &[F32x4],
    ) -> Result<(), SampleError> {
        crate::frames::sample(self, t, rest, scratch, out, cache, Some(only))
    }

    /// [`ClipSampler::sample_track`] through the binding table: the same bits.
    pub fn sample_track(&self, track: usize, t: f32, out: &mut [f32]) -> TrackSample {
        self.bindings.sample_track(self.sampler, track, t, out)
    }
}
