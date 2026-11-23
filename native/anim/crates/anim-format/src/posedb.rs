//! `myco.posedb@1`: a baked motion-matching pose database (ADR 0352), in the
//! [container] layout.
//!
//! Magic `"MYCOPSDB"`, version [`FORMAT_VERSION`], no header flags (0).
//!
//! # Sections
//!
//! | kind | name | align | count | record | required |
//! |---|---|---|---|---|---|
//! | 1 | `STRINGS` | 4 | strings | [string table](crate::strings) | yes |
//! | 2 | `INFO` | 4 | 1 | 32 B | yes |
//! | 3 | `FEATURES` | 4 | features | 24 B | yes |
//! | 4 | `NORMALIZATION` | 16 | 2 × dims | f32 | yes |
//! | 5 | `MATRIX` | 16 | frames × row stride | f32 | yes |
//! | 6 | `FRAMES` | 4 | frames | 8 B | yes |
//! | 7 | `CLIPS` | 4 | clips | u32 | yes |
//! | 8 | `TAG_NAMES` | 4 | tags | u32 | with `TAGS` |
//! | 9 | `TAGS` | 4 | frames × words per frame | u32 | with `TAG_NAMES` |
//! | 10 | `KD_NODES` | 4 | nodes | 16 B | with `KD_INDICES` |
//! | 11 | `KD_INDICES` | 4 | frame indices | u32 | with `KD_NODES` |
//!
//! ## `INFO` (32 bytes)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | frame count (= `FRAMES` count) |
//! | 4 | u32 | dims: feature dimensions per frame (≥ 1) |
//! | 8 | u32 | row stride in f32 (= `align4(dims)`, so each row is 16-byte aligned) |
//! | 12 | u32 | feature count (= `FEATURES` count) |
//! | 16 | u32 | clip count (= `CLIPS` count) |
//! | 20 | u32 | tag count (= `TAG_NAMES` count; 0 when absent) |
//! | 24 | f32 | sample rate of the baked frames, Hz (finite, > 0) |
//! | 28 | u32 | skeleton string id, or `NONE` |
//!
//! ## `FEATURES` (24 bytes each; their dims tile `[0, dims)` in order)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u8 | kind ([`FeatureKind`]) |
//! | 1 | u8 | reserved (0) |
//! | 2 | u16 | dims of this feature (bone position/velocity 3; trajectory position/direction 2; custom ≥ 1) |
//! | 4 | u32 | bone index (bone kinds), else `NONE` |
//! | 8 | u32 | first dim (column) in a row |
//! | 12 | f32 | weight (finite, ≥ 0) |
//! | 16 | f32 | time offset, seconds (trajectory samples; past < 0; else 0) |
//! | 20 | u32 | name string id, or `NONE` |
//!
//! ## `NORMALIZATION`
//!
//! `dims` means, then `dims` standard deviations (finite, > 0). A row stores
//! `(value - mean) / std`.
//!
//! ## `MATRIX`
//!
//! `frames` rows of `row stride` f32; columns past `dims` are 0. Finite.
//!
//! ## `FRAMES` (8 bytes each)
//!
//! `u32` clip index into `CLIPS`, `f32` time in that clip (finite, ≥ 0).
//!
//! ## `CLIPS`, `TAG_NAMES`
//!
//! `u32` string ids (clip asset references; tag names).
//!
//! ## `TAGS`
//!
//! Per frame, `ceil(tags / 32)` u32 words; bit `t % 32` of word `t / 32` set when the frame has
//! tag `t`. Bits at or past the tag count are 0.
//!
//! ## `KD_NODES` (16 bytes each; node 0 is the root)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | split dim (< dims), or `NONE` for a leaf |
//! | 4 | f32 | split value (finite; leaf 0) |
//! | 8 | u32 | inner: left child; leaf: first entry in `KD_INDICES` |
//! | 12 | u32 | inner: right child; leaf: entry count |
//!
//! Children have larger indices than their parent (so the tree has no cycles).
//! `KD_INDICES` holds frame indices.

use crate::bytes::*;
use crate::container::{self, Container, FormatSpec, Layout, SectionEntry, SectionSpec};
use crate::error::{FormatError, Result};
use crate::macros::u8_enum;
use crate::strings::{self, StringTable};

/// Magic bytes.
pub const MAGIC: [u8; 8] = *b"MYCOPSDB";
/// The format's name.
pub const FORMAT: &str = "myco.posedb@1";
/// The format version this build reads and writes.
pub const FORMAT_VERSION: u32 = 1;

/// Section kinds.
pub mod section {
    /// String table.
    pub const STRINGS: u32 = 1;
    /// Database info.
    pub const INFO: u32 = 2;
    /// Feature schema.
    pub const FEATURES: u32 = 3;
    /// Means and standard deviations.
    pub const NORMALIZATION: u32 = 4;
    /// Feature matrix.
    pub const MATRIX: u32 = 5;
    /// Frame-to-clip map.
    pub const FRAMES: u32 = 6;
    /// Clip references.
    pub const CLIPS: u32 = 7;
    /// Tag names.
    pub const TAG_NAMES: u32 = 8;
    /// Tag bitsets.
    pub const TAGS: u32 = 9;
    /// KD-tree nodes.
    pub const KD_NODES: u32 = 10;
    /// KD-tree leaf entries.
    pub const KD_INDICES: u32 = 11;
}

const INFO_LEN: usize = 32;
const FEATURE_LEN: usize = 24;
const FRAME_LEN: usize = 8;
const KD_LEN: usize = 16;

static SPEC: FormatSpec = FormatSpec {
    magic: MAGIC,
    version: FORMAT_VERSION,
    known_flags: 0,
    sections: &[
        SectionSpec {
            kind: section::STRINGS,
            name: "STRINGS",
            align: 4,
            layout: Layout::Custom,
            required: true,
        },
        SectionSpec {
            kind: section::INFO,
            name: "INFO",
            align: 4,
            layout: Layout::Records(INFO_LEN),
            required: true,
        },
        SectionSpec {
            kind: section::FEATURES,
            name: "FEATURES",
            align: 4,
            layout: Layout::Records(FEATURE_LEN),
            required: true,
        },
        SectionSpec {
            kind: section::NORMALIZATION,
            name: "NORMALIZATION",
            align: 16,
            layout: Layout::Records(4),
            required: true,
        },
        SectionSpec {
            kind: section::MATRIX,
            name: "MATRIX",
            align: 16,
            layout: Layout::Records(4),
            required: true,
        },
        SectionSpec {
            kind: section::FRAMES,
            name: "FRAMES",
            align: 4,
            layout: Layout::Records(FRAME_LEN),
            required: true,
        },
        SectionSpec {
            kind: section::CLIPS,
            name: "CLIPS",
            align: 4,
            layout: Layout::Records(4),
            required: true,
        },
        SectionSpec {
            kind: section::TAG_NAMES,
            name: "TAG_NAMES",
            align: 4,
            layout: Layout::Records(4),
            required: false,
        },
        SectionSpec {
            kind: section::TAGS,
            name: "TAGS",
            align: 4,
            layout: Layout::Records(4),
            required: false,
        },
        SectionSpec {
            kind: section::KD_NODES,
            name: "KD_NODES",
            align: 4,
            layout: Layout::Records(KD_LEN),
            required: false,
        },
        SectionSpec {
            kind: section::KD_INDICES,
            name: "KD_INDICES",
            align: 4,
            layout: Layout::Records(4),
            required: false,
        },
    ],
};

u8_enum! {
    /// What a feature measures.
    pub enum FeatureKind {
        /// A bone's model-space position (3 dims).
        BonePosition = 0,
        /// A bone's model-space velocity (3 dims).
        BoneVelocity = 1,
        /// A trajectory sample's ground-plane position (2 dims).
        TrajectoryPosition = 2,
        /// A trajectory sample's ground-plane facing (2 dims).
        TrajectoryDirection = 3,
        /// Anything else (≥ 1 dims).
        Custom = 4,
    }
}

impl FeatureKind {
    /// The fixed dims of the kind, or `None` for custom.
    pub fn dims(self) -> Option<u16> {
        match self {
            FeatureKind::BonePosition | FeatureKind::BoneVelocity => Some(3),
            FeatureKind::TrajectoryPosition | FeatureKind::TrajectoryDirection => Some(2),
            FeatureKind::Custom => None,
        }
    }
    /// Whether the kind names a bone.
    pub fn has_bone(self) -> bool {
        matches!(self, FeatureKind::BonePosition | FeatureKind::BoneVelocity)
    }
}

/// One feature of the schema.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Feature {
    /// What it measures.
    pub kind: FeatureKind,
    /// Its dims.
    pub dims: u16,
    /// Bone index (bone kinds), else `NONE`.
    pub bone: u32,
    /// First column.
    pub first_dim: u32,
    /// Weight.
    pub weight: f32,
    /// Trajectory time offset, seconds.
    pub time_offset: f32,
    /// Name string id, or `NONE`.
    pub name: u32,
}

/// Where a database frame comes from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameRef {
    /// Index into the clip list.
    pub clip: u32,
    /// Time in the clip, seconds.
    pub time: f32,
}

/// A KD-tree node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum KdNode {
    /// Split on `axis` at `split`.
    Inner {
        axis: u32,
        split: f32,
        left: u32,
        right: u32,
    },
    /// `KD_INDICES[first..first + count]`.
    Leaf { first: u32, count: u32 },
}

/// The KD-tree.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct KdTree {
    /// Nodes; 0 is the root.
    pub nodes: Vec<KdNode>,
    /// Leaf entries (frame indices).
    pub indices: Vec<u32>,
}

/// The owned model of a `myco.posedb@1` file.
#[derive(Clone, Debug, PartialEq)]
pub struct PoseDb {
    /// Hz.
    pub sample_rate: f32,
    /// Skeleton string id, or `NONE`.
    pub skeleton: u32,
    /// The string table.
    pub strings: Vec<String>,
    /// Feature dims per frame.
    pub dims: u32,
    /// The schema.
    pub features: Vec<Feature>,
    /// Per-dim means.
    pub mean: Vec<f32>,
    /// Per-dim standard deviations.
    pub std: Vec<f32>,
    /// `frames.len() * dims` normalised values, row-major, unpadded (the writer pads rows).
    pub matrix: Vec<f32>,
    /// Frame-to-clip map.
    pub frames: Vec<FrameRef>,
    /// Clip asset string ids.
    pub clips: Vec<u32>,
    /// Tag name string ids.
    pub tag_names: Vec<u32>,
    /// `frames.len() * words_per_frame(tag_names.len())` words (empty with no tags).
    pub tags: Vec<u32>,
    /// The KD-tree, if baked.
    pub kd_tree: Option<KdTree>,
}

/// u32 words of tag bits per frame for `tags` tags.
pub fn words_per_frame(tags: usize) -> usize {
    tags.div_ceil(32)
}

impl PoseDb {
    /// Writes the file (parsed back before it is returned).
    pub fn write(&self) -> Result<Vec<u8>> {
        let dims = self.dims as usize;
        let stride = align4(dims);
        if self.matrix.len() != self.frames.len() * dims {
            return Err(FormatError::BadCount {
                what: "matrix values",
                count: self.matrix.len() as u64,
                expected: (self.frames.len() * dims) as u64,
            });
        }
        let mut w = container::Writer::new(&SPEC, 0);
        w.section(
            section::STRINGS,
            self.strings.len(),
            strings::write(&self.strings)?,
        )?;
        let mut o = Out::default();
        o.u32s(&[
            to_u32("frames", self.frames.len())?,
            self.dims,
            to_u32("row stride", stride)?,
            to_u32("features", self.features.len())?,
            to_u32("clips", self.clips.len())?,
            to_u32("tags", self.tag_names.len())?,
        ]);
        o.f32(self.sample_rate);
        o.u32(self.skeleton);
        w.section(section::INFO, 1, o.finish())?;
        let mut o = Out::default();
        for f in &self.features {
            o.u8(f.kind.id());
            o.u8(0);
            o.u16(f.dims);
            o.u32(f.bone);
            o.u32(f.first_dim);
            o.f32(f.weight);
            o.f32(f.time_offset);
            o.u32(f.name);
        }
        w.section(section::FEATURES, self.features.len(), o.finish())?;
        let mut o = Out::default();
        o.f32s(&self.mean);
        o.f32s(&self.std);
        w.section(
            section::NORMALIZATION,
            self.mean.len() + self.std.len(),
            o.finish(),
        )?;
        let mut o = Out::default();
        if dims > 0 {
            for row in self.matrix.chunks_exact(dims) {
                o.f32s(row);
                for _ in dims..stride {
                    o.f32(0.0);
                }
            }
        }
        w.section(section::MATRIX, self.frames.len() * stride, o.finish())?;
        let mut o = Out::default();
        for f in &self.frames {
            o.u32(f.clip);
            o.f32(f.time);
        }
        w.section(section::FRAMES, self.frames.len(), o.finish())?;
        w.section(section::CLIPS, self.clips.len(), u32_bytes(&self.clips))?;
        if !self.tag_names.is_empty() || !self.tags.is_empty() {
            w.section(
                section::TAG_NAMES,
                self.tag_names.len(),
                u32_bytes(&self.tag_names),
            )?;
            w.section(section::TAGS, self.tags.len(), u32_bytes(&self.tags))?;
        }
        if let Some(kd) = &self.kd_tree {
            let mut o = Out::default();
            for n in &kd.nodes {
                match *n {
                    KdNode::Inner {
                        axis,
                        split,
                        left,
                        right,
                    } => {
                        o.u32(axis);
                        o.f32(split);
                        o.u32s(&[left, right]);
                    }
                    KdNode::Leaf { first, count } => {
                        o.u32(NONE);
                        o.f32(0.0);
                        o.u32s(&[first, count]);
                    }
                }
            }
            w.section(section::KD_NODES, kd.nodes.len(), o.finish())?;
            w.section(
                section::KD_INDICES,
                kd.indices.len(),
                u32_bytes(&kd.indices),
            )?;
        }
        let bytes = w.finish()?;
        PoseDbView::parse(&bytes)?;
        Ok(bytes)
    }
}

fn u32_bytes(v: &[u32]) -> Vec<u8> {
    let mut o = Out::default();
    o.u32s(v);
    o.finish()
}

fn read_feature(mut r: Rd<'_>) -> Result<Feature> {
    let kind = r.u8();
    let reserved = r.u8();
    check_zero("feature reserved", reserved as u32)?;
    Ok(Feature {
        kind: FeatureKind::from_u8(kind).ok_or(FormatError::InvalidValue {
            what: "feature kind",
            value: kind as u32,
        })?,
        dims: r.u16(),
        bone: r.u32(),
        first_dim: r.u32(),
        weight: r.f32(),
        time_offset: r.f32(),
        name: r.u32(),
    })
}

fn read_kd(mut r: Rd<'_>) -> (KdNode, u32) {
    let axis = r.u32();
    let split = r.f32();
    let a = r.u32();
    let b = r.u32();
    if axis == NONE {
        (KdNode::Leaf { first: a, count: b }, split.to_bits())
    } else {
        (
            KdNode::Inner {
                axis,
                split,
                left: a,
                right: b,
            },
            0,
        )
    }
}

/// A validated, zero-copy view of a `myco.posedb@1` buffer.
#[derive(Clone, Copy)]
pub struct PoseDbView<'a> {
    c: Container<'a>,
    strings: StringTable<'a>,
    info: [u32; 8],
}

impl<'a> PoseDbView<'a> {
    /// Parses and validates `bytes`.
    pub fn parse(bytes: &'a [u8]) -> Result<Self> {
        let c = container::parse(&SPEC, bytes)?;
        let strings =
            StringTable::parse(c.count(section::STRINGS) as u32, c.data(section::STRINGS))?;
        if c.count(section::INFO) != 1 {
            return Err(FormatError::BadCount {
                what: "INFO records",
                count: c.count(section::INFO) as u64,
                expected: 1,
            });
        }
        let info = Rd::new(c.data(section::INFO)).u32s::<8>();
        let v = PoseDbView { c, strings, info };
        v.validate()?;
        Ok(v)
    }

    fn validate(&self) -> Result<()> {
        let c = &self.c;
        let frames = self.frame_count();
        let dims = self.dims();
        let count = |what, have: usize, expected: usize| {
            if have == expected {
                Ok(())
            } else {
                Err(FormatError::BadCount {
                    what,
                    count: have as u64,
                    expected: expected as u64,
                })
            }
        };
        count("INFO frame count", frames, c.count(section::FRAMES))?;
        if dims == 0 {
            return Err(FormatError::InvalidValue {
                what: "dims",
                value: 0,
            });
        }
        count("INFO row stride", self.row_stride(), align4(dims))?;
        count(
            "INFO feature count",
            self.info[3] as usize,
            c.count(section::FEATURES),
        )?;
        count(
            "INFO clip count",
            self.info[4] as usize,
            c.count(section::CLIPS),
        )?;
        count(
            "INFO tag count",
            self.tag_count(),
            c.count(section::TAG_NAMES),
        )?;
        let rate = self.sample_rate();
        if !(rate.is_finite() && rate > 0.0) {
            return Err(FormatError::BadFloat {
                what: "sample rate",
            });
        }
        self.strings.check("skeleton", self.info[7])?;

        let mut next = 0u64;
        for r in container::records(c.data(section::FEATURES), FEATURE_LEN) {
            let f = read_feature(r)?;
            if f.dims == 0 || f.kind.dims().is_some_and(|d| d != f.dims) {
                return Err(FormatError::InvalidValue {
                    what: "feature dims",
                    value: f.dims as u32,
                });
            }
            if f.first_dim as u64 != next {
                return Err(FormatError::Inconsistent {
                    what: "features don't tile the row in order",
                });
            }
            next += f.dims as u64;
            if f.kind.has_bone() == (f.bone == NONE) {
                return Err(FormatError::Inconsistent {
                    what: "feature bone",
                });
            }
            if !(f.weight.is_finite() && f.weight >= 0.0) {
                return Err(FormatError::BadFloat {
                    what: "feature weight",
                });
            }
            check_finite("feature time offset", f.time_offset)?;
            self.strings.check("feature name", f.name)?;
        }
        if next != dims as u64 {
            return Err(FormatError::BadCount {
                what: "feature dims",
                count: next,
                expected: dims as u64,
            });
        }

        count(
            "NORMALIZATION values",
            c.count(section::NORMALIZATION),
            2 * dims,
        )?;
        let norm = F32s::new(c.data(section::NORMALIZATION));
        for (i, v) in norm.iter().enumerate() {
            if !v.is_finite() || (i >= dims && v <= 0.0) {
                return Err(FormatError::BadFloat {
                    what: "normalization",
                });
            }
        }
        let stride = self.row_stride();
        count(
            "MATRIX values",
            c.count(section::MATRIX),
            frames.saturating_mul(stride),
        )?;
        let m = F32s::new(c.data(section::MATRIX));
        for (i, v) in m.iter().enumerate() {
            let pad = i % stride >= dims;
            if !v.is_finite() || (pad && v.to_bits() != 0) {
                return Err(FormatError::BadFloat {
                    what: "matrix value or row padding",
                });
            }
        }
        let n_clips = c.count(section::CLIPS);
        for mut r in container::records(c.data(section::FRAMES), FRAME_LEN) {
            check_index("frame clip", r.u32(), n_clips)?;
            let t = r.f32();
            if !(t.is_finite() && t >= 0.0) {
                return Err(FormatError::BadFloat { what: "frame time" });
            }
        }
        for id in U32s::new(c.data(section::CLIPS)).iter() {
            check_index("clip", id, self.strings.len())?;
        }

        let has_names = c.get(section::TAG_NAMES).is_some();
        if has_names != c.get(section::TAGS).is_some() {
            return Err(FormatError::MissingSection {
                section: "TAG_NAMES with TAGS",
            });
        }
        for id in U32s::new(c.data(section::TAG_NAMES)).iter() {
            check_index("tag name", id, self.strings.len())?;
        }
        let tags = self.tag_count();
        let wpf = words_per_frame(tags);
        count(
            "TAGS words",
            c.count(section::TAGS),
            if has_names { frames * wpf } else { 0 },
        )?;
        if wpf > 0 && !tags.is_multiple_of(32) {
            let mask = !0u32 << (tags % 32);
            let words = U32s::new(c.data(section::TAGS));
            for f in 0..frames {
                if words.get(f * wpf + wpf - 1).unwrap_or(0) & mask != 0 {
                    return Err(FormatError::Inconsistent {
                        what: "tag bits past the tag count",
                    });
                }
            }
        }

        let has_kd = c.get(section::KD_NODES).is_some();
        if has_kd != c.get(section::KD_INDICES).is_some() {
            return Err(FormatError::MissingSection {
                section: "KD_NODES with KD_INDICES",
            });
        }
        let n_kd = c.count(section::KD_NODES);
        let n_idx = c.count(section::KD_INDICES);
        if has_kd && n_kd == 0 {
            return Err(FormatError::BadCount {
                what: "KD nodes",
                count: 0,
                expected: 1,
            });
        }
        for (i, r) in container::records(c.data(section::KD_NODES), KD_LEN).enumerate() {
            match read_kd(r) {
                (KdNode::Leaf { first, count }, split_bits) => {
                    check_zero("KD leaf split", split_bits)?;
                    check_range("KD leaf", first, count, n_idx)?;
                }
                (
                    KdNode::Inner {
                        axis,
                        split,
                        left,
                        right,
                    },
                    _,
                ) => {
                    check_index("KD split dim", axis, dims)?;
                    check_finite("KD split", split)?;
                    for child in [left, right] {
                        if child as usize <= i || child as usize >= n_kd {
                            return Err(FormatError::IndexOutOfRange {
                                what: "KD child",
                                index: child,
                                len: len_u32(n_kd),
                            });
                        }
                    }
                }
            }
        }
        for f in U32s::new(c.data(section::KD_INDICES)).iter() {
            check_index("KD frame", f, frames)?;
        }
        Ok(())
    }

    // -- accessors ------------------------------------------------------------------------------

    /// The number of frames.
    pub fn frame_count(&self) -> usize {
        self.info[0] as usize
    }
    /// Feature dims per frame.
    pub fn dims(&self) -> usize {
        self.info[1] as usize
    }
    /// f32 per matrix row (dims rounded up to 4).
    pub fn row_stride(&self) -> usize {
        self.info[2] as usize
    }
    /// The number of tags.
    pub fn tag_count(&self) -> usize {
        self.info[5] as usize
    }
    /// Hz.
    pub fn sample_rate(&self) -> f32 {
        f32::from_bits(self.info[6])
    }
    /// Skeleton string id.
    pub fn skeleton(&self) -> u32 {
        self.info[7]
    }
    /// The string table.
    pub fn strings(&self) -> StringTable<'a> {
        self.strings
    }
    /// A section's table entry, if present.
    pub fn section(&self, kind: u32) -> Option<SectionEntry> {
        self.c.entry(kind)
    }
    /// The number of features.
    pub fn feature_count(&self) -> usize {
        self.c.count(section::FEATURES)
    }
    /// Feature `i`.
    pub fn feature(&self, i: usize) -> Option<Feature> {
        read_feature(container::record(
            self.c.data(section::FEATURES),
            FEATURE_LEN,
            i,
        )?)
        .ok()
    }
    /// Per-dim means.
    pub fn mean(&self) -> F32s<'a> {
        let n = F32s::new(self.c.data(section::NORMALIZATION));
        n.slice(0, self.dims()).unwrap_or(n)
    }
    /// Per-dim standard deviations.
    pub fn std(&self) -> F32s<'a> {
        let n = F32s::new(self.c.data(section::NORMALIZATION));
        n.slice(self.dims(), self.dims()).unwrap_or(n)
    }
    /// The whole matrix (rows of `row_stride`, 16-byte aligned in the file).
    pub fn matrix(&self) -> F32s<'a> {
        F32s::new(self.c.data(section::MATRIX))
    }
    /// Row `i`'s `dims` values.
    pub fn row(&self, i: usize) -> Option<F32s<'a>> {
        self.matrix()
            .slice(i.checked_mul(self.row_stride())?, self.dims())
    }
    /// Frame `i`'s source.
    pub fn frame(&self, i: usize) -> Option<FrameRef> {
        let mut r = container::record(self.c.data(section::FRAMES), FRAME_LEN, i)?;
        Some(FrameRef {
            clip: r.u32(),
            time: r.f32(),
        })
    }
    /// Clip asset string ids.
    pub fn clips(&self) -> U32s<'a> {
        U32s::new(self.c.data(section::CLIPS))
    }
    /// Tag name string ids.
    pub fn tag_names(&self) -> U32s<'a> {
        U32s::new(self.c.data(section::TAG_NAMES))
    }
    /// Frame `i`'s tag words.
    pub fn frame_tags(&self, i: usize) -> Option<U32s<'a>> {
        let w = words_per_frame(self.tag_count());
        U32s::new(self.c.data(section::TAGS)).slice(i.checked_mul(w)?, w)
    }
    /// Whether frame `frame` has tag `tag`.
    pub fn has_tag(&self, frame: usize, tag: usize) -> bool {
        tag < self.tag_count()
            && self
                .frame_tags(frame)
                .and_then(|w| w.get(tag / 32))
                .is_some_and(|w| w & (1 << (tag % 32)) != 0)
    }
    /// The number of KD-tree nodes (0 without a tree).
    pub fn kd_node_count(&self) -> usize {
        self.c.count(section::KD_NODES)
    }
    /// KD-tree node `i`.
    pub fn kd_node(&self, i: usize) -> Option<KdNode> {
        container::record(self.c.data(section::KD_NODES), KD_LEN, i).map(|r| read_kd(r).0)
    }
    /// KD-tree leaf entries.
    pub fn kd_indices(&self) -> U32s<'a> {
        U32s::new(self.c.data(section::KD_INDICES))
    }

    /// The owned model.
    pub fn to_posedb(&self) -> PoseDb {
        let frames = self.frame_count();
        PoseDb {
            sample_rate: self.sample_rate(),
            skeleton: self.skeleton(),
            strings: self.strings.to_vec(),
            dims: self.dims() as u32,
            features: (0..self.feature_count())
                .filter_map(|i| self.feature(i))
                .collect(),
            mean: self.mean().to_vec(),
            std: self.std().to_vec(),
            matrix: (0..frames)
                .filter_map(|i| self.row(i))
                .flat_map(|r| r.to_vec())
                .collect(),
            frames: (0..frames).filter_map(|i| self.frame(i)).collect(),
            clips: self.clips().to_vec(),
            tag_names: self.tag_names().to_vec(),
            tags: U32s::new(self.c.data(section::TAGS)).to_vec(),
            kd_tree: self.c.get(section::KD_NODES).map(|_| KdTree {
                nodes: (0..self.kd_node_count())
                    .filter_map(|i| self.kd_node(i))
                    .collect(),
                indices: self.kd_indices().to_vec(),
            }),
        }
    }
}
