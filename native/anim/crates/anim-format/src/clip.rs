//! `myco.anim@1`: a compiled clip (ADR 0371), in the [container] layout.
//!
//! Magic `"MYCOANIM"`, version [`FORMAT_VERSION`]. Header flags: [`CLIP_LOOP`] (1),
//! [`CLIP_ADDITIVE`] (2), [`CLIP_SLERP`] (4: bone rotations slerp instead of nlerp).
//!
//! A clip may carry the **raw** form (f32 samples, for preview before compression), the
//! **compressed** form (ACL-style, filled by `anim-compress`), or both. A clip with any sampled
//! track carries at least one.
//!
//! # Sections
//!
//! | kind | name | align | count | record | required |
//! |---|---|---|---|---|---|
//! | 1 | `STRINGS` | 4 | strings | [string table](crate::strings) | yes |
//! | 2 | `INFO` | 4 | 1 | 32 B | yes |
//! | 3 | `TRACKS` | 4 | tracks | 32 B | yes |
//! | 4 | `KEYS` | 4 | keys | 32 B | no (no keyed tracks) |
//! | 5 | `RAW` | 16 | f32 values | 4 B | no |
//! | 6 | `ROOT_CURVE` | 16 | frames | 16 B | no |
//! | 16 | `COMP_INFO` | 4 | 1 | 32 B | compressed group |
//! | 17 | `COMP_CHANNELS` | 4 | channels | 16 B | compressed group |
//! | 18 | `COMP_CONSTANTS` | 16 | f32 values | 4 B | compressed group |
//! | 19 | `COMP_CLIP_RANGES` | 16 | f32 values | 4 B | compressed group |
//! | 20 | `COMP_SEGMENTS` | 4 | segments | 16 B | compressed group |
//! | 21 | `COMP_BIT_RATES` | 4 | bytes | 1 B | compressed group |
//! | 22 | `COMP_SEGMENT_RANGES` | 4 | bytes | 1 B | compressed group |
//! | 23 | `COMP_DATA` | 16 | bytes | 1 B (opaque) | compressed group |
//!
//! The compressed group is all eight sections or none.
//!
//! ## `INFO` (32 bytes)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | f32 | duration, seconds (finite, ≥ 0) |
//! | 4 | f32 | sample rate, Hz (finite, > 0; default 30) |
//! | 8 | u32 | frame count: samples per sampled track (≥ 1; [`frame_count`](crate::frames::frame_count): `ceil(duration · rate − 1e-6) + 1`, frame `i` at `min(i / rate, duration)`, [`crate::frames`]) |
//! | 12 | u32 | track count (= `TRACKS` count) |
//! | 16 | u32 | clip name string id (or `NONE`) |
//! | 20 | u32 | bone count of the skeleton the clip was made for (0: no skeleton; then no bone tracks) |
//! | 24 | u32 | root-motion bone index (or `NONE`) |
//! | 28 | u32 | reserved (0) |
//!
//! ## `TRACKS` (32 bytes each)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u8 | kind ([`TrackKind`]) |
//! | 1 | u8 | flags: [`TRACK_CONSTANT`] (1, every frame equal), [`TRACK_DEFAULT`] (2, equals the rest pose / field default) |
//! | 2 | u8 | subtype: `discrete` → [`DiscreteType`]; `quat` → [`QuatInterp`]; else 0 |
//! | 3 | u8 | width: f32 per frame ([`TrackKind::width`]; 0 for keyed kinds) |
//! | 4 | u32 | bone index (`bone` tracks; `< INFO.bone count`), else `NONE` |
//! | 8 | u32 | node path string id (relative to the Animator's node), or `NONE` |
//! | 12 | u32 | component id string id (e.g. `engine.MeshRenderer`), or `NONE` |
//! | 16 | u32 | field path string id (morph: target name; curve: curve name), or `NONE` |
//! | 20 | u32 | raw offset: first f32 in `RAW` (sampled kinds with a raw form; a multiple of 4), else `NONE` |
//! | 24 | u32 | first key in `KEYS` (keyed kinds), else 0 |
//! | 28 | u32 | key count (keyed kinds), else 0 |
//!
//! Bone tracks have a bone index and no strings; other tracks have bone index `NONE`.
//! Raw offsets and key ranges are canonical: tracks in order, raw blocks packed at 4-float
//! boundaries (padding 0), key ranges contiguous and covering `KEYS` exactly.
//!
//! ## `RAW`
//!
//! Per sampled track, `frame count * width` f32, frame-major. A bone frame is 10 floats:
//! translation xyz, rotation xyzw, scale xyz.
//!
//! ## `KEYS` (32 bytes each; sorted by time within a track; `0 ≤ time ≤ end`)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | f32 | time (start), seconds |
//! | 4 | f32 | end, seconds (= time for instant kinds) |
//! | 8 | u32 x 5 | words `a..e`, per kind (below; unused words 0) |
//! | 28 | u32 | reserved (0) |
//!
//! | kind | end | a | b | c | d | e |
//! |---|---|---|---|---|---|---|
//! | discrete | = time | value: bool 0/1, enum index, or asset string id | | | | |
//! | event | ≥ time (> time: a notify state) | method string id | args JSON string id or `NONE` | weight threshold f32 in \[0, 1\] | flags: [`EVENT_ALWAYS`] | |
//! | marker | = time | [`MarkerKind`] | name string id or `NONE` | | | |
//! | audio | ≥ time | audio asset string id | params JSON string id or `NONE` | | | |
//! | activation | ≥ time (an active range) | | | | | |
//! | control | ≥ time | [`ControlKind`] | target string id or `NONE` | payload JSON string id or `NONE` | | |
//! | subclip | ≥ time | clip asset string id | offset f32 | speed f32 | blend in f32 ≥ 0 | blend out f32 ≥ 0 |
//!
//! ## `ROOT_CURVE` (16 bytes per frame; count = frame count)
//!
//! Translation xyz (model space, relative to frame 0) and yaw (radians about +Y, unwrapped),
//! at the clip's sample rate. Read by predicted root motion (ADR 0370).
//!
//! ## Compressed form (ACL-style uniform sampling)
//!
//! Each sampled track is split into **channels**: a bone track into rotation, translation and
//! scale (in that order); any other sampled track into one value channel. A channel is
//! *default* (dropped: equals the rest pose / default), *constant* (one value in
//! `COMP_CONSTANTS`) or *animated* (clip range in `COMP_CLIP_RANGES`, samples in the bitstream).
//! Frames are cut into segments of `segment frames` (16 by default; the last may be shorter).
//!
//! `COMP_INFO` (32 bytes):
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | segment frames (≥ 1; [`SEGMENT_FRAMES`]) |
//! | 4 | u32 | segment count (= `ceil(frame count / segment frames)`) |
//! | 8 | u32 | channel count (= `COMP_CHANNELS` count) |
//! | 12 | u32 | animated channel count |
//! | 16 | u8 | rotation format ([`RotationFormat`]: 0 quat drop-w, width 3; 1 full quat, width 4) |
//! | 17 | u8 x 3 | reserved (0) |
//! | 20 | f32 | maximum error the compressor measured (finite, ≥ 0) |
//! | 24 | u32 x 2 | reserved (0) |
//!
//! `COMP_CHANNELS` (16 bytes each), sorted by (track, channel kind), covering every sampled
//! track exactly:
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | track index (a sampled track) |
//! | 4 | u8 | channel kind ([`ChannelKind`]) |
//! | 5 | u8 | mode ([`ChannelMode`]) |
//! | 6 | u8 | width (components: rotation 3 or 4 by rotation format; translation, scale 3; value = track width) |
//! | 7 | u8 | reserved (0) |
//! | 8 | u32 | data offset: constant → first f32 of `width` in `COMP_CONSTANTS`; animated → first f32 of `width` minimums then `width` extents (≥ 0) in `COMP_CLIP_RANGES`; default → `NONE` |
//! | 12 | u32 | animated index (rank among animated channels), else `NONE` |
//!
//! `COMP_SEGMENTS` (16 bytes each): start frame (`= i * segment frames`), frame count, data
//! offset (bytes into `COMP_DATA`: segment 0 at 0, each next one at `align4` of the previous
//! one's end), data size (bytes; at least [`segment_bits`]` / 8` rounded up; any slack a decoder
//! wants for wide reads goes inside it). `COMP_DATA`'s count is the last segment's end.
//!
//! `COMP_BIT_RATES`: one u8 per (segment, animated channel), segment-major: bits per component
//! from {0, 3..=16, 19, 23, 32} (32 = raw f32; 0 = constant within the segment).
//!
//! `COMP_SEGMENT_RANGES`: per (segment, animated channel, component), segment-major, two u8:
//! the segment's minimum and extent, quantised to 8 bits within the channel's clip range
//! (count = segments × Σ animated widths × 2).
//!
//! `COMP_DATA`: the per-segment bitstreams, opaque to this crate (`anim-compress` defines the
//! packing).

use crate::bytes::*;
use crate::container::{self, records, Container, FormatSpec, Layout, SectionEntry, SectionSpec};
use crate::error::{FormatError, Result};
use crate::macros::u8_enum;
use crate::strings::{self, StringTable};

/// Magic bytes.
pub const MAGIC: [u8; 8] = *b"MYCOANIM";
/// The format's name.
pub const FORMAT: &str = "myco.anim@1";
/// The format version this build reads and writes.
pub const FORMAT_VERSION: u32 = 1;

/// Header flag: the clip loops.
pub const CLIP_LOOP: u32 = 1;
/// Header flag: the clip is additive.
pub const CLIP_ADDITIVE: u32 = 2;
/// Header flag: bone rotations interpolate with slerp (default nlerp).
pub const CLIP_SLERP: u32 = 4;
const CLIP_FLAGS: u32 = CLIP_LOOP | CLIP_ADDITIVE | CLIP_SLERP;

/// Track flag: every frame holds the same value.
pub const TRACK_CONSTANT: u8 = 1;
/// Track flag: the track equals the rest pose or the field default.
pub const TRACK_DEFAULT: u8 = 2;
const TRACK_FLAGS: u8 = TRACK_CONSTANT | TRACK_DEFAULT;

/// Event key flag: fire whatever the clip's weight (else above the threshold).
pub const EVENT_ALWAYS: u32 = 1;

/// The default segment length of the compressed form (ACL).
pub const SEGMENT_FRAMES: u32 = 16;

/// Section kinds.
pub mod section {
    /// String table.
    pub const STRINGS: u32 = 1;
    /// Clip info.
    pub const INFO: u32 = 2;
    /// Track table.
    pub const TRACKS: u32 = 3;
    /// Key lists.
    pub const KEYS: u32 = 4;
    /// Raw f32 samples.
    pub const RAW: u32 = 5;
    /// Root curve.
    pub const ROOT_CURVE: u32 = 6;
    /// Compressed: info.
    pub const COMP_INFO: u32 = 16;
    /// Compressed: channel descriptors.
    pub const COMP_CHANNELS: u32 = 17;
    /// Compressed: constant channel values.
    pub const COMP_CONSTANTS: u32 = 18;
    /// Compressed: clip ranges of animated channels.
    pub const COMP_CLIP_RANGES: u32 = 19;
    /// Compressed: segment table.
    pub const COMP_SEGMENTS: u32 = 20;
    /// Compressed: bit rate per segment and animated channel.
    pub const COMP_BIT_RATES: u32 = 21;
    /// Compressed: segment ranges.
    pub const COMP_SEGMENT_RANGES: u32 = 22;
    /// Compressed: opaque bitstreams.
    pub const COMP_DATA: u32 = 23;
}

const INFO_LEN: usize = 32;
const TRACK_LEN: usize = 32;
const KEY_LEN: usize = 32;
const ROOT_LEN: usize = 16;
const COMP_INFO_LEN: usize = 32;
const CHANNEL_LEN: usize = 16;
const SEGMENT_LEN: usize = 16;

const fn sec(
    kind: u32,
    name: &'static str,
    align: usize,
    stride: usize,
    required: bool,
) -> SectionSpec {
    SectionSpec {
        kind,
        name,
        align,
        layout: Layout::Records(stride),
        required,
    }
}

static SPEC: FormatSpec = FormatSpec {
    magic: MAGIC,
    version: FORMAT_VERSION,
    known_flags: CLIP_FLAGS,
    sections: &[
        SectionSpec {
            kind: section::STRINGS,
            name: "STRINGS",
            align: 4,
            layout: Layout::Custom,
            required: true,
        },
        sec(section::INFO, "INFO", 4, INFO_LEN, true),
        sec(section::TRACKS, "TRACKS", 4, TRACK_LEN, true),
        sec(section::KEYS, "KEYS", 4, KEY_LEN, false),
        sec(section::RAW, "RAW", 16, 4, false),
        sec(section::ROOT_CURVE, "ROOT_CURVE", 16, ROOT_LEN, false),
        sec(section::COMP_INFO, "COMP_INFO", 4, COMP_INFO_LEN, false),
        sec(
            section::COMP_CHANNELS,
            "COMP_CHANNELS",
            4,
            CHANNEL_LEN,
            false,
        ),
        sec(section::COMP_CONSTANTS, "COMP_CONSTANTS", 16, 4, false),
        sec(section::COMP_CLIP_RANGES, "COMP_CLIP_RANGES", 16, 4, false),
        sec(
            section::COMP_SEGMENTS,
            "COMP_SEGMENTS",
            4,
            SEGMENT_LEN,
            false,
        ),
        sec(section::COMP_BIT_RATES, "COMP_BIT_RATES", 4, 1, false),
        sec(
            section::COMP_SEGMENT_RANGES,
            "COMP_SEGMENT_RANGES",
            4,
            1,
            false,
        ),
        sec(section::COMP_DATA, "COMP_DATA", 16, 1, false),
    ],
};

const COMP_GROUP: [u32; 8] = [
    section::COMP_INFO,
    section::COMP_CHANNELS,
    section::COMP_CONSTANTS,
    section::COMP_CLIP_RANGES,
    section::COMP_SEGMENTS,
    section::COMP_BIT_RATES,
    section::COMP_SEGMENT_RANGES,
    section::COMP_DATA,
];

u8_enum! {
    /// A track's kind (ADR 0371). The id is stored; append-only.
    pub enum TrackKind {
        /// Bone translation, rotation, scale.
        Bone = 0,
        /// One float.
        Float = 1,
        /// Two floats.
        Vec2 = 2,
        /// Three floats.
        Vec3 = 3,
        /// Four floats.
        Vec4 = 4,
        /// RGBA.
        Color = 5,
        /// A node field's rotation.
        Quat = 6,
        /// Bool, enum or asset reference, stepped.
        Discrete = 7,
        /// One morph target weight.
        Morph = 8,
        /// Notifies and notify states.
        Event = 9,
        /// Audio events or clips.
        Audio = 10,
        /// Node active ranges.
        Activation = 11,
        /// Nested clips or timelines.
        Subclip = 12,
        /// Particle, camera and slot controls.
        Control = 13,
        /// Sync, exit, hit and cue markers.
        Marker = 14,
        /// A named float exposed to the graph.
        Curve = 15,
    }
}

impl TrackKind {
    /// f32 per frame for sampled kinds; 0 for keyed kinds.
    pub fn width(self) -> u8 {
        match self {
            TrackKind::Bone => 10,
            TrackKind::Float | TrackKind::Morph | TrackKind::Curve => 1,
            TrackKind::Vec2 => 2,
            TrackKind::Vec3 => 3,
            TrackKind::Vec4 | TrackKind::Color | TrackKind::Quat => 4,
            _ => 0,
        }
    }
    /// Whether the kind is uniformly sampled (raw / compressed).
    pub fn is_sampled(self) -> bool {
        self.width() > 0
    }
    /// Whether the kind is stored as a key list.
    pub fn is_keyed(self) -> bool {
        !self.is_sampled()
    }
}

u8_enum! {
    /// A `discrete` track's value type (the track subtype).
    pub enum DiscreteType {
        /// 0 or 1.
        Bool = 0,
        /// An enum index.
        Enum = 1,
        /// An asset reference string id.
        Asset = 2,
    }
}

u8_enum! {
    /// A `quat` track's interpolation (the track subtype).
    pub enum QuatInterp {
        /// Normalised lerp.
        Nlerp = 0,
        /// Spherical lerp.
        Slerp = 1,
    }
}

u8_enum! {
    /// A marker key's vocabulary (audio 0342's sample markers).
    pub enum MarkerKind {
        /// Named phase-sync point.
        Sync = 0,
        /// Where a transition may leave.
        Exit = 1,
        /// The impact point a play can align to.
        Hit = 2,
        /// A named point scripts can seek to.
        Cue = 3,
    }
}

u8_enum! {
    /// A control key's action.
    pub enum ControlKind {
        /// Play a particle effect.
        ParticlePlay = 0,
        /// Stop a particle effect.
        ParticleStop = 1,
        /// Cut to a camera.
        CameraCut = 2,
        /// Play into a nested Animator's slot.
        SlotPlay = 3,
    }
}

u8_enum! {
    /// How bone rotations are stored in the compressed form.
    pub enum RotationFormat {
        /// xyz with w ≥ 0 reconstructed (width 3).
        QuatDropW = 0,
        /// xyzw (width 4).
        QuatFull = 1,
    }
}

u8_enum! {
    /// Which part of a track a compressed channel holds.
    pub enum ChannelKind {
        /// Bone rotation.
        Rotation = 0,
        /// Bone translation.
        Translation = 1,
        /// Bone scale.
        Scale = 2,
        /// A non-bone track's value.
        Value = 3,
    }
}

u8_enum! {
    /// How a compressed channel is stored.
    pub enum ChannelMode {
        /// Dropped: equals the rest pose / default.
        Default = 0,
        /// One value in `COMP_CONSTANTS`.
        Constant = 1,
        /// Range-reduced, quantised samples in the bitstream.
        Animated = 2,
    }
}

/// Whether `bits` is an allowed bits-per-component value.
pub fn is_valid_bit_rate(bits: u8) -> bool {
    matches!(bits, 0 | 3..=16 | 19 | 23 | 32)
}

/// Bits one segment's bitstream holds at least: `frames * Σ bits[i] * widths[i]` over the
/// animated channels (pairs of `bit_rates` and `widths`, in animated order).
pub fn segment_bits(frames: u32, bit_rates: &[u8], widths: &[u8]) -> u64 {
    let per_frame: u64 = bit_rates
        .iter()
        .zip(widths)
        .map(|(&b, &w)| b as u64 * w as u64)
        .sum();
    per_frame * frames as u64
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

/// What a track drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Binding {
    /// Bone index (`bone` tracks), else `NONE`.
    pub bone: u32,
    /// Node path string id, or `NONE`.
    pub node_path: u32,
    /// Component id string id, or `NONE`.
    pub component: u32,
    /// Field path string id, or `NONE`.
    pub field: u32,
}

impl Binding {
    /// A bone binding.
    pub fn bone(index: u32) -> Self {
        Binding {
            bone: index,
            node_path: NONE,
            component: NONE,
            field: NONE,
        }
    }
    /// A property binding.
    pub fn property(node_path: u32, component: u32, field: u32) -> Self {
        Binding {
            bone: NONE,
            node_path,
            component,
            field,
        }
    }
    /// No target (clip-level tracks: events, markers).
    pub fn none() -> Self {
        Binding {
            bone: NONE,
            node_path: NONE,
            component: NONE,
            field: NONE,
        }
    }
}

/// A key's payload, by track kind.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum KeyData {
    /// `discrete`: bool 0/1, enum index or asset string id.
    Discrete { value: u32 },
    /// `event`: a notify (end = time) or notify state.
    Event {
        method: u32,
        args: u32,
        threshold: f32,
        always: bool,
    },
    /// `marker`.
    Marker { kind: MarkerKind, name: u32 },
    /// `audio`.
    Audio { asset: u32, params: u32 },
    /// `activation`: the node is active over `[time, end]`.
    Activation,
    /// `control`.
    Control {
        kind: ControlKind,
        target: u32,
        payload: u32,
    },
    /// `subclip`.
    Subclip {
        clip: u32,
        offset: f32,
        speed: f32,
        blend_in: f32,
        blend_out: f32,
    },
}

impl KeyData {
    /// The track kind this payload belongs to.
    pub fn kind(&self) -> TrackKind {
        match self {
            KeyData::Discrete { .. } => TrackKind::Discrete,
            KeyData::Event { .. } => TrackKind::Event,
            KeyData::Marker { .. } => TrackKind::Marker,
            KeyData::Audio { .. } => TrackKind::Audio,
            KeyData::Activation => TrackKind::Activation,
            KeyData::Control { .. } => TrackKind::Control,
            KeyData::Subclip { .. } => TrackKind::Subclip,
        }
    }
    fn words(&self) -> [u32; 5] {
        match *self {
            KeyData::Discrete { value } => [value, 0, 0, 0, 0],
            KeyData::Event {
                method,
                args,
                threshold,
                always,
            } => [
                method,
                args,
                threshold.to_bits(),
                always as u32 * EVENT_ALWAYS,
                0,
            ],
            KeyData::Marker { kind, name } => [kind.id() as u32, name, 0, 0, 0],
            KeyData::Audio { asset, params } => [asset, params, 0, 0, 0],
            KeyData::Activation => [0; 5],
            KeyData::Control {
                kind,
                target,
                payload,
            } => [kind.id() as u32, target, payload, 0, 0],
            KeyData::Subclip {
                clip,
                offset,
                speed,
                blend_in,
                blend_out,
            } => [
                clip,
                offset.to_bits(),
                speed.to_bits(),
                blend_in.to_bits(),
                blend_out.to_bits(),
            ],
        }
    }
    /// Decodes words stored for a track of `kind` (`None` for a sampled kind or bad enum).
    fn from_words(kind: TrackKind, w: [u32; 5]) -> Option<KeyData> {
        let e = f32::from_bits;
        Some(match kind {
            TrackKind::Discrete => KeyData::Discrete { value: w[0] },
            TrackKind::Event => KeyData::Event {
                method: w[0],
                args: w[1],
                threshold: e(w[2]),
                always: w[3] & EVENT_ALWAYS != 0,
            },
            TrackKind::Marker => KeyData::Marker {
                kind: MarkerKind::from_u8(u8::try_from(w[0]).ok()?)?,
                name: w[1],
            },
            TrackKind::Audio => KeyData::Audio {
                asset: w[0],
                params: w[1],
            },
            TrackKind::Activation => KeyData::Activation,
            TrackKind::Control => KeyData::Control {
                kind: ControlKind::from_u8(u8::try_from(w[0]).ok()?)?,
                target: w[1],
                payload: w[2],
            },
            TrackKind::Subclip => KeyData::Subclip {
                clip: w[0],
                offset: e(w[1]),
                speed: e(w[2]),
                blend_in: e(w[3]),
                blend_out: e(w[4]),
            },
            _ => return None,
        })
    }
}

/// One key of a keyed track.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Key {
    /// Start time, seconds.
    pub time: f32,
    /// End time, seconds (= `time` for instant keys).
    pub end: f32,
    /// The payload.
    pub data: KeyData,
}

/// One track of the owned model.
#[derive(Clone, Debug, PartialEq)]
pub struct Track {
    /// The kind.
    pub kind: TrackKind,
    /// [`TRACK_CONSTANT`] / [`TRACK_DEFAULT`].
    pub flags: u8,
    /// Per kind: [`DiscreteType`] or [`QuatInterp`] id, else 0.
    pub subtype: u8,
    /// The target.
    pub binding: Binding,
    /// Raw samples (`frame count * width`, frame-major) when the clip has the raw form; else empty.
    pub raw: Vec<f32>,
    /// Keys (keyed kinds), sorted by time.
    pub keys: Vec<Key>,
}

/// A compressed channel descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Channel {
    /// The sampled track.
    pub track: u32,
    /// Rotation, translation, scale or value.
    pub kind: ChannelKind,
    /// Default, constant or animated.
    pub mode: ChannelMode,
    /// Components.
    pub width: u8,
    /// See the layout table: an f32 index into constants or clip ranges, or `NONE`.
    pub data_offset: u32,
    /// Rank among animated channels, or `NONE`.
    pub animated_index: u32,
}

/// A compressed segment descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    /// First frame.
    pub start_frame: u32,
    /// Frames in the segment.
    pub frame_count: u32,
    /// Bytes into `COMP_DATA`.
    pub data_offset: u32,
    /// Bytes of bitstream.
    pub data_size: u32,
}

/// The compressed form, as stored.
#[derive(Clone, Debug, PartialEq)]
pub struct Compressed {
    /// Frames per segment.
    pub segment_frames: u32,
    /// How rotations are stored.
    pub rotation_format: RotationFormat,
    /// The compressor's measured maximum error.
    pub max_error: f32,
    /// Channel descriptors.
    pub channels: Vec<Channel>,
    /// Constant channel values.
    pub constants: Vec<f32>,
    /// Animated channels' clip ranges (minimums then extents).
    pub clip_ranges: Vec<f32>,
    /// Segment descriptors.
    pub segments: Vec<Segment>,
    /// Bits per component, per (segment, animated channel).
    pub bit_rates: Vec<u8>,
    /// Segment minimum / extent bytes, per (segment, animated channel, component).
    pub segment_ranges: Vec<u8>,
    /// The bitstreams.
    pub data: Vec<u8>,
}

/// The owned model of a `myco.anim@1` file.
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    /// Header flags ([`CLIP_LOOP`], [`CLIP_ADDITIVE`], [`CLIP_SLERP`]).
    pub flags: u32,
    /// Name string id, or `NONE`.
    pub name: u32,
    /// Seconds.
    pub duration: f32,
    /// Hz.
    pub sample_rate: f32,
    /// Samples per sampled track.
    pub frame_count: u32,
    /// The skeleton's bone count (0: none).
    pub bone_count: u32,
    /// Root-motion bone, or `NONE`.
    pub root_bone: u32,
    /// The string table.
    pub strings: Vec<String>,
    /// Tracks.
    pub tracks: Vec<Track>,
    /// Whether the raw form is present (each sampled track's `raw` is then filled).
    pub has_raw: bool,
    /// Root curve: translation xyz + yaw per frame.
    pub root_curve: Option<Vec<[f32; 4]>>,
    /// The compressed form.
    pub compressed: Option<Compressed>,
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

impl Clip {
    /// Writes the file. The output is parsed back before it is returned, so a model that would
    /// make an invalid file is refused with the reader's error.
    pub fn write(&self) -> Result<Vec<u8>> {
        let mut w = container::Writer::new(&SPEC, self.flags);
        w.section(
            section::STRINGS,
            self.strings.len(),
            strings::write(&self.strings)?,
        )?;

        let mut o = Out::default();
        o.f32(self.duration);
        o.f32(self.sample_rate);
        o.u32(self.frame_count);
        o.u32(to_u32("tracks", self.tracks.len())?);
        o.u32(self.name);
        o.u32(self.bone_count);
        o.u32(self.root_bone);
        o.u32(0);
        w.section(section::INFO, 1, o.finish())?;

        let mut tracks = Out::default();
        let mut keys = Out::default();
        let mut raw = Out::default();
        let mut key_count = 0usize;
        for t in &self.tracks {
            if t.kind.is_sampled() && !t.keys.is_empty() {
                return Err(FormatError::Inconsistent {
                    what: "sampled track with keys",
                });
            }
            if (t.kind.is_keyed() || !self.has_raw) && !t.raw.is_empty() {
                return Err(FormatError::Inconsistent {
                    what: "raw samples without a raw form",
                });
            }
            if t.keys.iter().any(|k| k.data.kind() != t.kind) {
                return Err(FormatError::Inconsistent {
                    what: "key payload of another kind",
                });
            }
            let raw_offset = if t.kind.is_sampled() && self.has_raw {
                raw.pad_to(16);
                let off = to_u32("raw samples", raw.buf.len() / 4)?;
                raw.f32s(&t.raw);
                off
            } else {
                NONE
            };
            let (first, count) = if t.kind.is_keyed() {
                (to_u32("keys", key_count)?, to_u32("keys", t.keys.len())?)
            } else {
                (0, 0)
            };
            for k in &t.keys {
                keys.f32(k.time);
                keys.f32(k.end);
                keys.u32s(&k.data.words());
                keys.u32(0);
            }
            if t.kind.is_keyed() {
                key_count += t.keys.len();
            }
            tracks.u8(t.kind.id());
            tracks.u8(t.flags);
            tracks.u8(t.subtype);
            tracks.u8(t.kind.width());
            tracks.u32(t.binding.bone);
            tracks.u32(t.binding.node_path);
            tracks.u32(t.binding.component);
            tracks.u32(t.binding.field);
            tracks.u32(raw_offset);
            tracks.u32(first);
            tracks.u32(count);
        }
        w.section(section::TRACKS, self.tracks.len(), tracks.finish())?;
        if key_count > 0 {
            w.section(section::KEYS, key_count, keys.finish())?;
        }
        if self.has_raw {
            let n = raw.buf.len() / 4;
            w.section(section::RAW, n, raw.finish())?;
        }
        if let Some(rc) = &self.root_curve {
            let mut o = Out::default();
            for f in rc {
                o.f32s(f);
            }
            w.section(section::ROOT_CURVE, rc.len(), o.finish())?;
        }
        if let Some(c) = &self.compressed {
            write_compressed(&mut w, c)?;
        }
        let bytes = w.finish()?;
        ClipView::parse(&bytes)?;
        Ok(bytes)
    }
}

fn write_compressed(w: &mut container::Writer, c: &Compressed) -> Result<()> {
    let animated = c
        .channels
        .iter()
        .filter(|ch| ch.mode == ChannelMode::Animated)
        .count();
    let mut o = Out::default();
    o.u32(c.segment_frames);
    o.u32(to_u32("segments", c.segments.len())?);
    o.u32(to_u32("channels", c.channels.len())?);
    o.u32(to_u32("channels", animated)?);
    o.u8(c.rotation_format.id());
    o.bytes(&[0, 0, 0]);
    o.f32(c.max_error);
    o.u32(0);
    o.u32(0);
    w.section(section::COMP_INFO, 1, o.finish())?;
    let mut o = Out::default();
    for ch in &c.channels {
        o.u32(ch.track);
        o.u8(ch.kind.id());
        o.u8(ch.mode.id());
        o.u8(ch.width);
        o.u8(0);
        o.u32(ch.data_offset);
        o.u32(ch.animated_index);
    }
    w.section(section::COMP_CHANNELS, c.channels.len(), o.finish())?;
    let mut o = Out::default();
    o.f32s(&c.constants);
    w.section(section::COMP_CONSTANTS, c.constants.len(), o.finish())?;
    let mut o = Out::default();
    o.f32s(&c.clip_ranges);
    w.section(section::COMP_CLIP_RANGES, c.clip_ranges.len(), o.finish())?;
    let mut o = Out::default();
    for s in &c.segments {
        o.u32s(&[s.start_frame, s.frame_count, s.data_offset, s.data_size]);
    }
    w.section(section::COMP_SEGMENTS, c.segments.len(), o.finish())?;
    w.section(
        section::COMP_BIT_RATES,
        c.bit_rates.len(),
        c.bit_rates.clone(),
    )?;
    w.section(
        section::COMP_SEGMENT_RANGES,
        c.segment_ranges.len(),
        c.segment_ranges.clone(),
    )?;
    w.section(section::COMP_DATA, c.data.len(), c.data.clone())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/// A track record, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrackInfo {
    /// The kind.
    pub kind: TrackKind,
    /// Track flags.
    pub flags: u8,
    /// Subtype.
    pub subtype: u8,
    /// f32 per frame.
    pub width: u8,
    /// The target.
    pub binding: Binding,
    /// First f32 in `RAW`, or `NONE`.
    pub raw_offset: u32,
    /// First key.
    pub first_key: u32,
    /// Key count.
    pub key_count: u32,
}

fn read_track(mut r: Rd<'_>) -> Option<TrackInfo> {
    let kind = TrackKind::from_u8(r.u8())?;
    Some(TrackInfo {
        kind,
        flags: r.u8(),
        subtype: r.u8(),
        width: r.u8(),
        binding: Binding {
            bone: r.u32(),
            node_path: r.u32(),
            component: r.u32(),
            field: r.u32(),
        },
        raw_offset: r.u32(),
        first_key: r.u32(),
        key_count: r.u32(),
    })
}

fn read_key(mut r: Rd<'_>) -> (f32, f32, [u32; 5], u32) {
    (r.f32(), r.f32(), r.u32s::<5>(), r.u32())
}

/// A validated, zero-copy view of a `myco.anim@1` buffer.
#[derive(Clone, Copy)]
pub struct ClipView<'a> {
    c: Container<'a>,
    strings: StringTable<'a>,
    info: [u32; 8],
}

impl<'a> ClipView<'a> {
    /// Parses and validates `bytes` (every section, record and cross-reference).
    pub fn parse(bytes: &'a [u8]) -> Result<Self> {
        let c = container::parse(&SPEC, bytes)?;
        let strings =
            StringTable::parse(c.count(section::STRINGS) as u32, c.data(section::STRINGS))?;
        let info_count = c.count(section::INFO);
        if info_count != 1 {
            return Err(FormatError::BadCount {
                what: "INFO records",
                count: info_count as u64,
                expected: 1,
            });
        }
        let info = Rd::new(c.data(section::INFO)).u32s::<8>();
        let v = ClipView { c, strings, info };
        v.validate()?;
        Ok(v)
    }

    fn validate(&self) -> Result<()> {
        let c = &self.c;
        let duration = self.duration();
        if !(duration.is_finite() && duration >= 0.0) {
            return Err(FormatError::BadFloat { what: "duration" });
        }
        let rate = self.sample_rate();
        if !(rate.is_finite() && rate > 0.0) {
            return Err(FormatError::BadFloat {
                what: "sample rate",
            });
        }
        let frames = self.frame_count();
        if frames == 0 {
            return Err(FormatError::InvalidValue {
                what: "frame count",
                value: 0,
            });
        }
        let track_count = c.count(section::TRACKS);
        if self.info[3] as usize != track_count {
            return Err(FormatError::BadCount {
                what: "INFO track count",
                count: self.info[3] as u64,
                expected: track_count as u64,
            });
        }
        self.strings.check("clip name", self.info[4])?;
        let bone_count = self.bone_count();
        check_opt_index("root bone", self.info[6], bone_count as usize)?;
        check_zero("INFO reserved", self.info[7])?;

        let has_raw = c.get(section::RAW).is_some();
        let raw = F32s::new(c.data(section::RAW));
        let keys = c.data(section::KEYS);
        let key_total = c.count(section::KEYS);
        let mut next_key = 0u64;
        let mut next_raw = 0usize;
        let mut any_sampled = false;
        for r in records(c.data(section::TRACKS), TRACK_LEN) {
            let t = read_track(r).ok_or_else(|| {
                let mut r = r;
                FormatError::InvalidValue {
                    what: "track kind",
                    value: r.u8() as u32,
                }
            })?;
            if t.width != t.kind.width() {
                return Err(FormatError::InvalidValue {
                    what: "track width",
                    value: t.width as u32,
                });
            }
            if t.flags & !TRACK_FLAGS != 0 {
                return Err(FormatError::InvalidValue {
                    what: "track flags",
                    value: t.flags as u32,
                });
            }
            let subtype_ok = match t.kind {
                TrackKind::Discrete => DiscreteType::from_u8(t.subtype).is_some(),
                TrackKind::Quat => QuatInterp::from_u8(t.subtype).is_some(),
                _ => t.subtype == 0,
            };
            if !subtype_ok {
                return Err(FormatError::InvalidValue {
                    what: "track subtype",
                    value: t.subtype as u32,
                });
            }
            let b = t.binding;
            if t.kind == TrackKind::Bone {
                check_index("bone", b.bone, bone_count as usize)?;
                if b.node_path != NONE || b.component != NONE || b.field != NONE {
                    return Err(FormatError::Inconsistent {
                        what: "bone track with a property binding",
                    });
                }
            } else {
                if b.bone != NONE {
                    return Err(FormatError::Inconsistent {
                        what: "non-bone track with a bone index",
                    });
                }
                self.strings.check("node path", b.node_path)?;
                self.strings.check("component", b.component)?;
                self.strings.check("field path", b.field)?;
            }
            if t.kind.is_sampled() {
                any_sampled = true;
                if t.first_key != 0 || t.key_count != 0 {
                    return Err(FormatError::Inconsistent {
                        what: "sampled track with keys",
                    });
                }
                if has_raw {
                    let start = align4(next_raw);
                    if (next_raw..start).any(|i| raw.get(i) != Some(0.0)) {
                        return Err(FormatError::NonZeroPadding { section: "RAW" });
                    }
                    if t.raw_offset as usize != start {
                        return Err(FormatError::Inconsistent {
                            what: "raw offsets not canonical",
                        });
                    }
                    let n = frames as usize * t.width as usize;
                    check_range("raw samples", t.raw_offset, n as u32, raw.len())?;
                    next_raw = start + n;
                } else if t.raw_offset != NONE {
                    return Err(FormatError::Inconsistent {
                        what: "raw offset without RAW",
                    });
                }
            } else {
                if t.raw_offset != NONE {
                    return Err(FormatError::Inconsistent {
                        what: "keyed track with a raw offset",
                    });
                }
                if t.first_key as u64 != next_key {
                    return Err(FormatError::Inconsistent {
                        what: "key ranges not canonical",
                    });
                }
                check_range("keys", t.first_key, t.key_count, key_total)?;
                next_key += t.key_count as u64;
                self.validate_keys(&t, keys)?;
            }
        }
        if next_key != key_total as u64 {
            return Err(FormatError::BadCount {
                what: "keys referenced by tracks",
                count: next_key,
                expected: key_total as u64,
            });
        }
        if has_raw {
            if next_raw != raw.len() {
                return Err(FormatError::BadCount {
                    what: "RAW values",
                    count: raw.len() as u64,
                    expected: next_raw as u64,
                });
            }
            if raw.iter().any(|x| !x.is_finite()) {
                return Err(FormatError::BadFloat { what: "raw sample" });
            }
        }
        if let Some(rc) = c.get(section::ROOT_CURVE) {
            if rc.entry.count != frames {
                return Err(FormatError::BadCount {
                    what: "ROOT_CURVE frames",
                    count: rc.entry.count as u64,
                    expected: frames as u64,
                });
            }
            if F32s::new(rc.data).iter().any(|x| !x.is_finite()) {
                return Err(FormatError::BadFloat { what: "root curve" });
            }
        }
        let comp_present = COMP_GROUP.iter().filter(|&&k| c.get(k).is_some()).count();
        if comp_present != 0 && comp_present != COMP_GROUP.len() {
            return Err(FormatError::MissingSection {
                section: "compressed group",
            });
        }
        if any_sampled && !has_raw && comp_present == 0 {
            return Err(FormatError::MissingSection {
                section: "RAW or compressed",
            });
        }
        if comp_present != 0 {
            self.validate_compressed()?;
        }
        Ok(())
    }

    fn validate_keys(&self, t: &TrackInfo, keys: &[u8]) -> Result<()> {
        let duration = self.duration();
        let mut prev = f32::NEG_INFINITY;
        for i in t.first_key..t.first_key + t.key_count {
            let r = container::record(keys, KEY_LEN, i as usize).ok_or(
                FormatError::IndexOutOfRange {
                    what: "key",
                    index: i,
                    len: 0,
                },
            )?;
            let (time, end, w, reserved) = read_key(r);
            check_zero("key reserved", reserved)?;
            if !(time.is_finite()
                && end.is_finite()
                && time >= 0.0
                && end >= time
                && end <= duration)
            {
                return Err(FormatError::BadFloat { what: "key time" });
            }
            if time < prev {
                return Err(FormatError::Inconsistent {
                    what: "keys not sorted by time",
                });
            }
            prev = time;
            let instant = matches!(t.kind, TrackKind::Discrete | TrackKind::Marker);
            if instant && end != time {
                return Err(FormatError::Inconsistent {
                    what: "instant key with an end",
                });
            }
            let data = KeyData::from_words(t.kind, w).ok_or(FormatError::InvalidValue {
                what: "key enum",
                value: w[0],
            })?;
            if data.words() != w {
                return Err(FormatError::NonZeroReserved {
                    what: "unused key words",
                });
            }
            let s = &self.strings;
            match data {
                KeyData::Discrete { value } => match DiscreteType::from_u8(t.subtype) {
                    Some(DiscreteType::Bool) if value > 1 => {
                        return Err(FormatError::InvalidValue {
                            what: "bool key",
                            value,
                        })
                    }
                    Some(DiscreteType::Asset) => s.check("asset key", value)?,
                    _ => {}
                },
                KeyData::Event {
                    method,
                    args,
                    threshold,
                    ..
                } => {
                    check_index("event method", method, s.len())?;
                    s.check("event args", args)?;
                    if !(0.0..=1.0).contains(&threshold) {
                        return Err(FormatError::BadFloat {
                            what: "event threshold",
                        });
                    }
                }
                KeyData::Marker { name, .. } => s.check("marker name", name)?,
                KeyData::Audio { asset, params } => {
                    check_index("audio asset", asset, s.len())?;
                    s.check("audio params", params)?;
                }
                KeyData::Activation => {}
                KeyData::Control {
                    target, payload, ..
                } => {
                    s.check("control target", target)?;
                    s.check("control payload", payload)?;
                }
                KeyData::Subclip {
                    clip,
                    offset,
                    speed,
                    blend_in,
                    blend_out,
                } => {
                    check_index("subclip clip", clip, s.len())?;
                    check_finite("subclip offset", offset)?;
                    check_finite("subclip speed", speed)?;
                    if !(blend_in >= 0.0
                        && blend_in.is_finite()
                        && blend_out >= 0.0
                        && blend_out.is_finite())
                    {
                        return Err(FormatError::BadFloat {
                            what: "subclip blend",
                        });
                    }
                }
            }
        }
        Ok(())
    }

    fn validate_compressed(&self) -> Result<()> {
        let c = &self.c;
        let frames = self.frame_count();
        let mut r = Rd::new(c.data(section::COMP_INFO));
        if c.count(section::COMP_INFO) != 1 {
            return Err(FormatError::BadCount {
                what: "COMP_INFO records",
                count: c.count(section::COMP_INFO) as u64,
                expected: 1,
            });
        }
        let seg_frames = r.u32();
        let seg_count = r.u32();
        let ch_count = r.u32();
        let animated_count = r.u32();
        let rot = r.u8();
        let reserved = [r.u8(), r.u8(), r.u8()];
        let max_error = r.f32();
        let reserved2 = [r.u32(), r.u32()];
        if seg_frames == 0 {
            return Err(FormatError::InvalidValue {
                what: "segment frames",
                value: 0,
            });
        }
        let expect_segs = frames.div_ceil(seg_frames);
        if seg_count != expect_segs || c.count(section::COMP_SEGMENTS) != seg_count as usize {
            return Err(FormatError::BadCount {
                what: "segments",
                count: seg_count as u64,
                expected: expect_segs as u64,
            });
        }
        if ch_count as usize != c.count(section::COMP_CHANNELS) {
            return Err(FormatError::BadCount {
                what: "COMP_INFO channel count",
                count: ch_count as u64,
                expected: c.count(section::COMP_CHANNELS) as u64,
            });
        }
        let rot = RotationFormat::from_u8(rot).ok_or(FormatError::InvalidValue {
            what: "rotation format",
            value: rot as u32,
        })?;
        if reserved != [0; 3] || reserved2 != [0; 2] {
            return Err(FormatError::NonZeroReserved { what: "COMP_INFO" });
        }
        if !(max_error.is_finite() && max_error >= 0.0) {
            return Err(FormatError::BadFloat { what: "max error" });
        }

        // Channels: sorted, covering every sampled track with its expected channel set.
        let constants = F32s::new(c.data(section::COMP_CONSTANTS));
        let ranges = F32s::new(c.data(section::COMP_CLIP_RANGES));
        check_all_finite("compressed constant", &constants.to_vec())?;
        let mut expected: Vec<(u32, ChannelKind, u8)> = Vec::new();
        for (i, r) in records(c.data(section::TRACKS), TRACK_LEN).enumerate() {
            let Some(t) = read_track(r) else { continue };
            let i = i as u32;
            match t.kind {
                TrackKind::Bone => {
                    let rw = if rot == RotationFormat::QuatDropW {
                        3
                    } else {
                        4
                    };
                    expected.push((i, ChannelKind::Rotation, rw));
                    expected.push((i, ChannelKind::Translation, 3));
                    expected.push((i, ChannelKind::Scale, 3));
                }
                k if k.is_sampled() => expected.push((i, ChannelKind::Value, k.width())),
                _ => {}
            }
        }
        if expected.len() != ch_count as usize {
            return Err(FormatError::BadCount {
                what: "compressed channels",
                count: ch_count as u64,
                expected: expected.len() as u64,
            });
        }
        let mut widths: Vec<u8> = Vec::new();
        for (ch, exp) in self.compressed_channels().zip(&expected) {
            let ch = ch?;
            if (ch.track, ch.kind, ch.width) != *exp {
                return Err(FormatError::Inconsistent {
                    what: "compressed channel order or width",
                });
            }
            match ch.mode {
                ChannelMode::Default => {
                    if ch.data_offset != NONE || ch.animated_index != NONE {
                        return Err(FormatError::Inconsistent {
                            what: "default channel with data",
                        });
                    }
                }
                ChannelMode::Constant => {
                    check_range(
                        "constant values",
                        ch.data_offset,
                        ch.width as u32,
                        constants.len(),
                    )?;
                    if ch.animated_index != NONE {
                        return Err(FormatError::Inconsistent {
                            what: "constant channel with an animated index",
                        });
                    }
                }
                ChannelMode::Animated => {
                    check_range(
                        "clip range values",
                        ch.data_offset,
                        2 * ch.width as u32,
                        ranges.len(),
                    )?;
                    if ch.animated_index as usize != widths.len() {
                        return Err(FormatError::Inconsistent {
                            what: "animated index not its rank",
                        });
                    }
                    for k in 0..ch.width as usize {
                        let min = ranges.get(ch.data_offset as usize + k).unwrap_or(f32::NAN);
                        let ext = ranges
                            .get(ch.data_offset as usize + ch.width as usize + k)
                            .unwrap_or(f32::NAN);
                        if !(min.is_finite() && ext.is_finite() && ext >= 0.0) {
                            return Err(FormatError::BadFloat { what: "clip range" });
                        }
                    }
                    widths.push(ch.width);
                }
            }
        }
        if widths.len() != animated_count as usize {
            return Err(FormatError::BadCount {
                what: "COMP_INFO animated channels",
                count: animated_count as u64,
                expected: widths.len() as u64,
            });
        }
        let rates = c.data(section::COMP_BIT_RATES);
        let expect_rates = seg_count as u64 * widths.len() as u64;
        if rates.len() as u64 != expect_rates {
            return Err(FormatError::BadCount {
                what: "bit rates",
                count: rates.len() as u64,
                expected: expect_rates,
            });
        }
        if let Some(&b) = rates.iter().find(|&&b| !is_valid_bit_rate(b)) {
            return Err(FormatError::InvalidValue {
                what: "bit rate",
                value: b as u32,
            });
        }
        let width_sum: u64 = widths.iter().map(|&w| w as u64).sum();
        let expect_ranges = seg_count as u64 * width_sum * 2;
        let seg_ranges = c.count(section::COMP_SEGMENT_RANGES) as u64;
        if seg_ranges != expect_ranges {
            return Err(FormatError::BadCount {
                what: "segment ranges",
                count: seg_ranges,
                expected: expect_ranges,
            });
        }
        let data_len = c.data(section::COMP_DATA).len() as u64;
        let mut prev_end = 0u64;
        for (i, mut r) in records(c.data(section::COMP_SEGMENTS), SEGMENT_LEN).enumerate() {
            let s = Segment {
                start_frame: r.u32(),
                frame_count: r.u32(),
                data_offset: r.u32(),
                data_size: r.u32(),
            };
            let start = i as u64 * seg_frames as u64;
            let count = (frames as u64 - start).min(seg_frames as u64);
            if s.start_frame as u64 != start || s.frame_count as u64 != count {
                return Err(FormatError::Inconsistent {
                    what: "segment frames",
                });
            }
            if s.data_offset as u64 != (prev_end + 3) & !3 {
                return Err(FormatError::Inconsistent {
                    what: "segment data offsets not packed",
                });
            }
            let end = s.data_offset as u64 + s.data_size as u64;
            if end > data_len {
                return Err(FormatError::RangeOutOfBounds {
                    what: "segment data",
                    first: s.data_offset,
                    count: s.data_size,
                    len: len_u32(data_len as usize),
                });
            }
            prev_end = end;
            let seg_rates = &rates[i * widths.len()..(i + 1) * widths.len()];
            let bits = segment_bits(s.frame_count, seg_rates, &widths);
            if (s.data_size as u64) * 8 < bits {
                return Err(FormatError::BadCount {
                    what: "segment data bits",
                    count: s.data_size as u64 * 8,
                    expected: bits,
                });
            }
        }
        if prev_end != data_len {
            return Err(FormatError::BadCount {
                what: "COMP_DATA bytes past the last segment",
                count: data_len,
                expected: prev_end,
            });
        }
        Ok(())
    }

    // -- accessors ------------------------------------------------------------------------------

    /// Header flags.
    pub fn flags(&self) -> u32 {
        self.c.flags
    }
    /// Seconds.
    pub fn duration(&self) -> f32 {
        f32::from_bits(self.info[0])
    }
    /// Hz.
    pub fn sample_rate(&self) -> f32 {
        f32::from_bits(self.info[1])
    }
    /// Samples per sampled track.
    pub fn frame_count(&self) -> u32 {
        self.info[2]
    }
    /// The clip's time-to-frame mapping (its last frame at its duration, [`crate::frames`]).
    pub fn frame_clock(&self) -> crate::frames::FrameClock {
        crate::frames::FrameClock::new(self.duration(), self.sample_rate(), self.frame_count())
    }
    /// Name string id.
    pub fn name(&self) -> u32 {
        self.info[4]
    }
    /// Skeleton bone count (0: none).
    pub fn bone_count(&self) -> u32 {
        self.info[5]
    }
    /// Root-motion bone, or `NONE`.
    pub fn root_bone(&self) -> u32 {
        self.info[6]
    }
    /// The string table.
    pub fn strings(&self) -> StringTable<'a> {
        self.strings
    }
    /// A section's table entry (offsets for typed-array views), if present.
    pub fn section(&self, kind: u32) -> Option<SectionEntry> {
        self.c.entry(kind)
    }
    /// Every present section's entry, in kind order.
    pub fn sections(&self) -> impl Iterator<Item = SectionEntry> + '_ {
        self.c.entries()
    }
    /// The number of tracks.
    pub fn track_count(&self) -> usize {
        self.c.count(section::TRACKS)
    }
    /// Track `i`.
    pub fn track(&self, i: usize) -> Option<TrackInfo> {
        container::record(self.c.data(section::TRACKS), TRACK_LEN, i).and_then(read_track)
    }
    /// Track `i`'s raw samples (`frame count * width`, frame-major), if the raw form is present.
    pub fn track_raw(&self, i: usize) -> Option<F32s<'a>> {
        let t = self.track(i)?;
        if t.raw_offset == NONE {
            return None;
        }
        F32s::new(self.c.data(section::RAW)).slice(
            t.raw_offset as usize,
            self.frame_count() as usize * t.width as usize,
        )
    }
    /// Track `i`'s keys (empty for sampled tracks).
    pub fn track_keys(&self, i: usize) -> impl Iterator<Item = Key> + 'a {
        let keys = self.c.data(section::KEYS);
        let t = self.track(i);
        let (kind, first, count) = t.map_or((TrackKind::Float, 0, 0), |t| {
            (t.kind, t.first_key, t.key_count)
        });
        (first..first + count).filter_map(move |k| {
            let (time, end, w, _) = read_key(container::record(keys, KEY_LEN, k as usize)?);
            Some(Key {
                time,
                end,
                data: KeyData::from_words(kind, w)?,
            })
        })
    }
    /// The whole raw section (every track's block), if present.
    pub fn raw(&self) -> Option<F32s<'a>> {
        self.c.get(section::RAW).map(|s| F32s::new(s.data))
    }
    /// The root curve: 4 floats (x, y, z, yaw) per frame.
    pub fn root_curve(&self) -> Option<F32s<'a>> {
        self.c.get(section::ROOT_CURVE).map(|s| F32s::new(s.data))
    }
    /// Root curve frame `i`.
    pub fn root_frame(&self, i: usize) -> Option<[f32; 4]> {
        let rc = self.root_curve()?;
        let s = rc.slice(i.checked_mul(4)?, 4)?;
        Some([s.get(0)?, s.get(1)?, s.get(2)?, s.get(3)?])
    }
    /// The compressed form, if present.
    pub fn compressed(&self) -> Option<CompressedView<'a>> {
        self.c.get(section::COMP_INFO)?;
        Some(CompressedView { c: self.c })
    }
    fn compressed_channels(&self) -> impl Iterator<Item = Result<Channel>> + 'a {
        records(self.c.data(section::COMP_CHANNELS), CHANNEL_LEN).map(read_channel)
    }

    /// Decodes the whole file into the owned model.
    pub fn to_clip(&self) -> Clip {
        let has_raw = self.c.get(section::RAW).is_some();
        let tracks = (0..self.track_count())
            .filter_map(|i| {
                let t = self.track(i)?;
                Some(Track {
                    kind: t.kind,
                    flags: t.flags,
                    subtype: t.subtype,
                    binding: t.binding,
                    raw: self.track_raw(i).map(|r| r.to_vec()).unwrap_or_default(),
                    keys: self.track_keys(i).collect(),
                })
            })
            .collect();
        let root_curve = self.root_curve().map(|rc| {
            (0..rc.len() / 4)
                .filter_map(|i| self.root_frame(i))
                .collect()
        });
        Clip {
            flags: self.flags(),
            name: self.name(),
            duration: self.duration(),
            sample_rate: self.sample_rate(),
            frame_count: self.frame_count(),
            bone_count: self.bone_count(),
            root_bone: self.root_bone(),
            strings: self.strings.to_vec(),
            tracks,
            has_raw,
            root_curve,
            compressed: self.compressed().map(|c| c.to_compressed()),
        }
    }
}

fn read_channel(mut r: Rd<'_>) -> Result<Channel> {
    let track = r.u32();
    let kind = r.u8();
    let mode = r.u8();
    let width = r.u8();
    let reserved = r.u8();
    let data_offset = r.u32();
    let animated_index = r.u32();
    check_zero("channel reserved", reserved as u32)?;
    Ok(Channel {
        track,
        kind: ChannelKind::from_u8(kind).ok_or(FormatError::InvalidValue {
            what: "channel kind",
            value: kind as u32,
        })?,
        mode: ChannelMode::from_u8(mode).ok_or(FormatError::InvalidValue {
            what: "channel mode",
            value: mode as u32,
        })?,
        width,
        data_offset,
        animated_index,
    })
}

/// A zero-copy view of the compressed sections (validated with the clip).
#[derive(Clone, Copy)]
pub struct CompressedView<'a> {
    c: Container<'a>,
}

impl<'a> CompressedView<'a> {
    fn info(&self) -> Rd<'a> {
        Rd::new(self.c.data(section::COMP_INFO))
    }
    /// Frames per segment.
    pub fn segment_frames(&self) -> u32 {
        self.info().u32()
    }
    /// How rotations are stored.
    pub fn rotation_format(&self) -> RotationFormat {
        let mut r = self.info();
        r.u32s::<4>();
        RotationFormat::from_u8(r.u8()).unwrap_or(RotationFormat::QuatDropW)
    }
    /// The measured maximum error.
    pub fn max_error(&self) -> f32 {
        let mut r = self.info();
        r.u32s::<5>();
        r.f32()
    }
    /// The number of channels.
    pub fn channel_count(&self) -> usize {
        self.c.count(section::COMP_CHANNELS)
    }
    /// The number of animated channels.
    pub fn animated_count(&self) -> usize {
        let mut r = self.info();
        r.u32s::<3>();
        r.u32() as usize
    }
    /// Channel `i`.
    pub fn channel(&self, i: usize) -> Option<Channel> {
        container::record(self.c.data(section::COMP_CHANNELS), CHANNEL_LEN, i)
            .and_then(|r| read_channel(r).ok())
    }
    /// The number of segments.
    pub fn segment_count(&self) -> usize {
        self.c.count(section::COMP_SEGMENTS)
    }
    /// Segment `i`.
    pub fn segment(&self, i: usize) -> Option<Segment> {
        let mut r = container::record(self.c.data(section::COMP_SEGMENTS), SEGMENT_LEN, i)?;
        Some(Segment {
            start_frame: r.u32(),
            frame_count: r.u32(),
            data_offset: r.u32(),
            data_size: r.u32(),
        })
    }
    /// Constant channel values.
    pub fn constants(&self) -> F32s<'a> {
        F32s::new(self.c.data(section::COMP_CONSTANTS))
    }
    /// Animated channels' clip ranges.
    pub fn clip_ranges(&self) -> F32s<'a> {
        F32s::new(self.c.data(section::COMP_CLIP_RANGES))
    }
    /// Segment `segment`'s bit rates, one per animated channel.
    pub fn bit_rates(&self, segment: usize) -> Option<&'a [u8]> {
        let n = self.animated_count();
        let a = segment.checked_mul(n)?;
        self.c
            .data(section::COMP_BIT_RATES)
            .get(a..a.checked_add(n)?)
    }
    /// Every segment range byte.
    pub fn segment_ranges(&self) -> &'a [u8] {
        self.c.data(section::COMP_SEGMENT_RANGES)
    }
    /// The bitstreams.
    pub fn data(&self) -> &'a [u8] {
        self.c.data(section::COMP_DATA)
    }
    /// Segment `i`'s bitstream.
    pub fn segment_data(&self, i: usize) -> Option<&'a [u8]> {
        let s = self.segment(i)?;
        let a = s.data_offset as usize;
        self.data().get(a..a.checked_add(s.data_size as usize)?)
    }
    /// The owned model.
    pub fn to_compressed(&self) -> Compressed {
        Compressed {
            segment_frames: self.segment_frames(),
            rotation_format: self.rotation_format(),
            max_error: self.max_error(),
            channels: (0..self.channel_count())
                .filter_map(|i| self.channel(i))
                .collect(),
            constants: self.constants().to_vec(),
            clip_ranges: self.clip_ranges().to_vec(),
            segments: (0..self.segment_count())
                .filter_map(|i| self.segment(i))
                .collect(),
            bit_rates: self.c.data(section::COMP_BIT_RATES).to_vec(),
            segment_ranges: self.segment_ranges().to_vec(),
            data: self.data().to_vec(),
        }
    }
}
