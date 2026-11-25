//! The runtime database: a `myco.posedb@1` file loaded for search.
//!
//! [`MatchDb::new`] runs once, when the database loads (it allocates, like `anim-sample`'s
//! `ClipBindings`): it copies the matrix into 16-byte aligned [`F32x4`] rows with each dim
//! multiplied by `√weight` of its feature (so a search's squared distance is the weighted cost
//! `Σ weight·(q − r)²` with no per-dim multiply), checks the tree (depth at most
//! [`MAX_KD_DEPTH`], every frame in exactly one leaf, every entry on its side of every split
//! above it), stores the rows in leaf order and gives every node the bounding box of its rows
//! (D147), which bounds the tree search exactly. Everything after that reads it and never
//! allocates.

use crate::{MAX_KD_DEPTH, MAX_TAGS, MAX_TRAJECTORY, TAG_WORDS};
use anim_format::posedb::{words_per_frame, Feature, FeatureKind, FrameRef, KdNode, PoseDbView};
use anim_format::NONE;
use anim_math::{F32x4, Lane};

/// Tag bits, one per database tag (tag `t` is bit `t % 32` of word `t / 32`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TagMask(pub [u32; TAG_WORDS]);

impl TagMask {
    /// No tags.
    pub const EMPTY: Self = Self([0; TAG_WORDS]);

    /// This mask with tag `tag` set (ignored past [`MAX_TAGS`]).
    pub fn with(mut self, tag: usize) -> Self {
        if tag < MAX_TAGS {
            self.0[tag / 32] |= 1 << (tag % 32);
        }
        self
    }

    /// Whether no tag is set.
    pub fn is_empty(&self) -> bool {
        self.0.iter().all(|&w| w == 0)
    }
}

/// Which frames a search may pick, by tag: a frame passes when it has every `required` tag, no
/// `excluded` tag, and at least one `any` tag (when `any` isn't empty). The default passes all.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TagFilter {
    pub required: TagMask,
    pub excluded: TagMask,
    pub any: TagMask,
}

impl TagFilter {
    /// Whether the filter passes every frame.
    pub fn is_open(&self) -> bool {
        self.required.is_empty() && self.excluded.is_empty() && self.any.is_empty()
    }
}

/// A [`TagFilter`] checked against a database's tag count (see `MatchDb::prepare`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Prepared {
    required: [u32; TAG_WORDS],
    excluded: [u32; TAG_WORDS],
    any: [u32; TAG_WORDS],
    need_any: bool,
    /// Every frame passes.
    open: bool,
}

/// Why a database couldn't be loaded for search.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadError {
    /// More than [`MAX_TAGS`] tags.
    TooManyTags,
    /// More than [`MAX_TRAJECTORY`] distinct trajectory time offsets.
    TooManyTrajectorySamples,
    /// The KD-tree is deeper than [`MAX_KD_DEPTH`], misses or repeats a frame, or has an entry on
    /// the wrong side of a split.
    KdTree(&'static str),
}

/// A KD node's children or entries (the search bounds a node by its box, `MatchDb::boxes`; the
/// file's splits are only checked at load).
#[derive(Clone, Copy, Debug)]
pub(crate) enum Node {
    Inner { left: u32, right: u32 },
    Leaf { first: u32, count: u32 },
}

/// Consecutive frames of one clip: frame `first + k` is at `start + k / sample_rate`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Run {
    pub clip: u32,
    pub first: u32,
    pub count: u32,
    pub start: f32,
}

/// A database loaded for search.
pub struct MatchDb {
    pub(crate) dims: usize,
    pub(crate) lanes: usize,
    pub(crate) rate: f32,
    /// The weighted feature rows, `lanes` per frame. With a KD-tree, in leaf order (the frames of
    /// `indices`, in that order), so a leaf's rows are contiguous; `slots` maps a frame to its row.
    pub(crate) rows: Vec<F32x4>,
    /// Frame → row position when `rows` is in leaf order; empty when it is in frame order.
    pub(crate) slots: Vec<u32>,
    /// With a KD-tree: per node, the bounding box of its rows (`lanes` lane-wise minimums, then
    /// `lanes` maximums), which bounds the search (`search`'s docs, "KD bound").
    pub(crate) boxes: Vec<F32x4>,
    pub(crate) mean: Vec<f32>,
    pub(crate) std: Vec<f32>,
    /// `√weight` per dim.
    pub(crate) scale: Vec<f32>,
    /// 1 on trajectory dims, 0 elsewhere, per lane.
    pub(crate) trajectory_mask: Vec<F32x4>,
    pub(crate) features: Vec<Feature>,
    pub(crate) frames: Vec<FrameRef>,
    pub(crate) tag_words: usize,
    pub(crate) tags: Vec<u32>,
    pub(crate) nodes: Vec<Node>,
    pub(crate) indices: Vec<u32>,
    pub(crate) runs: Vec<Run>,
    pub(crate) offsets: [f32; MAX_TRAJECTORY],
    pub(crate) offset_count: usize,
    /// T70: each clip entry's `CLIP_*` flags (empty: none) and the mirror table.
    pub(crate) clip_flags: Vec<u32>,
    pub(crate) mirror: Vec<u32>,
}

impl MatchDb {
    /// Loads `view` for search (allocates; once per database).
    pub fn new(view: &PoseDbView<'_>) -> Result<Self, LoadError> {
        let dims = view.dims();
        let stride = view.row_stride();
        let lanes = stride / 4;
        let n = view.frame_count();
        let tags = view.tag_count();
        if tags > MAX_TAGS {
            return Err(LoadError::TooManyTags);
        }
        let features: Vec<Feature> = (0..view.feature_count())
            .filter_map(|i| view.feature(i))
            .collect();
        let mut scale = vec![0.0f32; stride];
        let mut traj = vec![0.0f32; stride];
        let mut offsets = [0.0f32; MAX_TRAJECTORY];
        let mut offset_count = 0;
        for f in &features {
            let range = f.first_dim as usize..f.first_dim as usize + f.dims as usize;
            scale[range.clone()].fill(f.weight.sqrt());
            if matches!(
                f.kind,
                FeatureKind::TrajectoryPosition | FeatureKind::TrajectoryDirection
            ) {
                traj[range].fill(1.0);
                let known = offsets[..offset_count]
                    .iter()
                    .any(|o| o.to_bits() == f.time_offset.to_bits());
                if !known {
                    if offset_count == MAX_TRAJECTORY {
                        return Err(LoadError::TooManyTrajectorySamples);
                    }
                    offsets[offset_count] = f.time_offset;
                    offset_count += 1;
                }
            }
        }
        offsets[..offset_count].sort_by(f32::total_cmp);
        let to_lanes = |v: &[f32]| -> Vec<F32x4> {
            v.as_chunks::<4>()
                .0
                .iter()
                .map(|c| F32x4::from_array(*c))
                .collect()
        };
        let matrix = view.matrix();
        let mut rows = Vec::with_capacity(n * lanes);
        let mut buf = [0.0f32; 4];
        for i in 0..n * lanes {
            for (k, b) in buf.iter_mut().enumerate() {
                let d = (i % lanes) * 4 + k;
                *b = matrix.get(i * 4 + k).unwrap_or(0.0) * scale[d];
            }
            rows.push(F32x4::from_array(buf));
        }
        let frames: Vec<FrameRef> = (0..n).filter_map(|i| view.frame(i)).collect();
        let rate = view.sample_rate();

        let mut runs: Vec<Run> = Vec::new();
        for (i, f) in frames.iter().enumerate() {
            let extend = runs.last().is_some_and(|r| {
                r.clip == f.clip
                    && r.first as usize + r.count as usize == i
                    && ((f.time - r.start) * rate - r.count as f32).abs() < 0.25
            });
            if extend {
                if let Some(r) = runs.last_mut() {
                    r.count += 1;
                }
            } else {
                runs.push(Run {
                    clip: f.clip,
                    first: i as u32,
                    count: 1,
                    start: f.time,
                });
            }
        }

        let mut nodes = Vec::with_capacity(view.kd_node_count());
        for i in 0..view.kd_node_count() {
            nodes.push(match view.kd_node(i) {
                Some(KdNode::Inner { left, right, .. }) => Node::Inner { left, right },
                Some(KdNode::Leaf { first, count }) => Node::Leaf { first, count },
                None => Node::Leaf { first: 0, count: 0 },
            });
        }
        let mut db = MatchDb {
            dims,
            lanes,
            rate,
            rows,
            slots: Vec::new(),
            boxes: Vec::new(),
            mean: view.mean().to_vec(),
            std: view.std().to_vec(),
            scale,
            trajectory_mask: to_lanes(&traj),
            features,
            frames,
            tag_words: words_per_frame(tags),
            tags: (0..n)
                .flat_map(|i| view.frame_tags(i).map(|w| w.to_vec()).unwrap_or_default())
                .collect(),
            nodes,
            indices: view.kd_indices().to_vec(),
            runs,
            offsets,
            offset_count,
            clip_flags: (0..view.clips().len())
                .map(|i| view.clip_flags(i))
                .collect(),
            mirror: view.mirror().to_vec(),
        };
        if !db.nodes.is_empty() {
            db.check_tree(view)?;
            if db.indices.len() == n {
                // Every frame in exactly one leaf (checked): store the rows in leaf order, so a
                // leaf scan reads memory in sequence instead of one random row per frame.
                let mut leaf_rows = Vec::with_capacity(db.rows.len());
                let mut slots = vec![0u32; n];
                for (j, &f) in db.indices.iter().enumerate() {
                    let f = f as usize;
                    leaf_rows.extend_from_slice(&db.rows[f * lanes..(f + 1) * lanes]);
                    slots[f] = j as u32;
                }
                db.rows = leaf_rows;
                db.slots = slots;
            }
            db.boxes = vec![F32x4::splat(0.0); 2 * lanes * db.nodes.len()];
            db.fill_box(0);
        }
        Ok(db)
    }

    /// Fills node `node`'s bounding box (and its subtree's): the lane-wise minimum and maximum of
    /// its rows (a leaf) or of its children's boxes. The tree was checked (depth at most
    /// [`MAX_KD_DEPTH`], every frame in one leaf), so this recursion ends.
    fn fill_box(&mut self, node: u32) {
        let lanes = self.lanes;
        let at = 2 * lanes * node as usize;
        let (lo, hi) = (F32x4::splat(f32::INFINITY), F32x4::splat(f32::NEG_INFINITY));
        let mut b = (vec![lo; lanes], vec![hi; lanes]);
        match self.nodes[node as usize] {
            Node::Leaf { first, count } => {
                for j in first as usize..(first + count) as usize {
                    for (k, r) in self.leaf_row(j).iter().enumerate() {
                        b.0[k] = b.0[k].min(*r);
                        b.1[k] = b.1[k].max(*r);
                    }
                }
            }
            Node::Inner { left, right } => {
                for child in [left, right] {
                    self.fill_box(child);
                    let c = 2 * lanes * child as usize;
                    for k in 0..lanes {
                        b.0[k] = b.0[k].min(self.boxes[c + k]);
                        b.1[k] = b.1[k].max(self.boxes[c + lanes + k]);
                    }
                }
            }
        }
        self.boxes[at..at + lanes].copy_from_slice(&b.0);
        self.boxes[at + lanes..at + 2 * lanes].copy_from_slice(&b.1);
    }

    /// Checks the tree's depth, coverage and split invariant against the file's values.
    fn check_tree(&self, view: &PoseDbView<'_>) -> Result<(), LoadError> {
        let n = self.frames.len();
        let mut seen = vec![false; n];
        let mut covered = 0usize;
        // The path's splits as (axis, split, went left).
        let mut path: Vec<(u32, f32, bool)> = Vec::with_capacity(MAX_KD_DEPTH);
        self.check_node(view, 0, &mut path, &mut seen, &mut covered)?;
        if covered != n {
            return Err(LoadError::KdTree("a frame is in no leaf"));
        }
        Ok(())
    }

    fn check_node(
        &self,
        view: &PoseDbView<'_>,
        node: u32,
        path: &mut Vec<(u32, f32, bool)>,
        seen: &mut [bool],
        covered: &mut usize,
    ) -> Result<(), LoadError> {
        if path.len() >= MAX_KD_DEPTH {
            return Err(LoadError::KdTree("deeper than MAX_KD_DEPTH"));
        }
        match view.kd_node(node as usize) {
            Some(KdNode::Inner {
                axis,
                split,
                left,
                right,
            }) => {
                path.push((axis, split, true));
                self.check_node(view, left, path, seen, covered)?;
                path.pop();
                path.push((axis, split, false));
                self.check_node(view, right, path, seen, covered)?;
                path.pop();
            }
            Some(KdNode::Leaf { first, count }) => {
                for k in first..first + count {
                    let f = self.indices[k as usize] as usize;
                    if std::mem::replace(&mut seen[f], true) {
                        return Err(LoadError::KdTree("a frame is in two leaves"));
                    }
                    *covered += 1;
                    let row = view.row(f).ok_or(LoadError::KdTree("row"))?;
                    for &(axis, split, left) in path.iter() {
                        let v = row.get(axis as usize).unwrap_or(0.0);
                        if (left && v > split) || (!left && v < split) {
                            return Err(LoadError::KdTree("an entry is on the wrong side"));
                        }
                    }
                }
            }
            None => return Err(LoadError::KdTree("node")),
        }
        Ok(())
    }

    /// Feature dims per frame.
    pub fn dims(&self) -> usize {
        self.dims
    }
    /// [`F32x4`] lanes per row and per query (`row stride / 4`).
    pub fn lanes(&self) -> usize {
        self.lanes
    }
    /// A zeroed query buffer of [`lanes`](Self::lanes) (allocates; make one per character).
    pub fn new_query(&self) -> Vec<F32x4> {
        vec![F32x4::splat(0.0); self.lanes]
    }
    /// Frames.
    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }
    /// Frame `i`'s clip and time.
    pub fn frame(&self, i: usize) -> Option<FrameRef> {
        self.frames.get(i).copied()
    }
    /// The database's sample rate, Hz.
    pub fn sample_rate(&self) -> f32 {
        self.rate
    }
    /// The schema.
    pub fn features(&self) -> &[Feature] {
        &self.features
    }
    /// Per-dim means.
    pub fn mean(&self) -> &[f32] {
        &self.mean
    }
    /// Per-dim standard deviations.
    pub fn std(&self) -> &[f32] {
        &self.std
    }
    /// The distinct trajectory time offsets of the schema, ascending: where a
    /// [`Trajectory`](crate::trajectory::Trajectory) must be predicted.
    pub fn trajectory_offsets(&self) -> &[f32] {
        &self.offsets[..self.offset_count]
    }
    /// Whether the database has a KD-tree.
    pub fn has_kd_tree(&self) -> bool {
        !self.nodes.is_empty()
    }
    /// Whether frame `i` has tag `tag`.
    pub fn has_tag(&self, i: usize, tag: usize) -> bool {
        tag / 32 < self.tag_words
            && self
                .tags
                .get(i * self.tag_words + tag / 32)
                .is_some_and(|w| w & (1 << (tag % 32)) != 0)
    }
    /// Whether frame `i` passes `filter`.
    #[inline]
    pub fn passes(&self, i: usize, filter: &TagFilter) -> bool {
        self.prepare(filter)
            .is_some_and(|p| self.passes_prepared(i, &p))
    }

    /// `filter` reduced to the database's tag words, or `None` when no frame can pass (a
    /// required tag, or every `any` tag, past the database's tags).
    pub(crate) fn prepare(&self, filter: &TagFilter) -> Option<Prepared> {
        let w = self.tag_words;
        let beyond = |m: &TagMask| m.0[w..].iter().any(|&x| x != 0);
        let within = |m: &TagMask| m.0[..w].iter().any(|&x| x != 0);
        if beyond(&filter.required) || (!filter.any.is_empty() && !within(&filter.any)) {
            return None;
        }
        Some(Prepared {
            required: filter.required.0,
            excluded: filter.excluded.0,
            any: filter.any.0,
            need_any: !filter.any.is_empty(),
            open: !within(&filter.required) && !within(&filter.excluded) && filter.any.is_empty(),
        })
    }

    /// [`passes`](Self::passes) with a prepared filter.
    #[inline(always)]
    pub(crate) fn passes_prepared(&self, i: usize, p: &Prepared) -> bool {
        if p.open {
            return true;
        }
        let w = self.tag_words;
        let words = &self.tags[i * w..i * w + w];
        let mut any = false;
        for (k, &f) in words.iter().enumerate() {
            if f & p.required[k] != p.required[k] || f & p.excluded[k] != 0 {
                return false;
            }
            any |= f & p.any[k] != 0;
        }
        any || !p.need_any
    }
    /// T70: whether clip entry `clip` is a mirrored copy (`CLIP_MIRRORED`; played mirrored
    /// through [`mirror_table`](Self::mirror_table)).
    pub fn clip_mirrored(&self, clip: u32) -> bool {
        self.clip_flags
            .get(clip as usize)
            .is_some_and(|f| f & anim_format::posedb::CLIP_MIRRORED != 0)
    }

    /// T70: the mirror table (the axis, then a `MIRROR`-node word per bone; empty: none).
    pub fn mirror_table(&self) -> &[u32] {
        &self.mirror
    }

    /// Frame `frame`'s trajectory features in the character's frame (T70, the live debugger's
    /// matched trajectory): one sample per distinct trajectory offset, de-normalised (`row / √weight
    /// · std + mean`). A feature of weight 0 can't be recovered and reads as its mean. `false`
    /// for a frame out of range. Never allocates.
    pub fn frame_trajectory(&self, frame: usize, out: &mut crate::trajectory::Trajectory) -> bool {
        if frame >= self.frames.len() {
            return false;
        }
        let row = if self.slots.is_empty() {
            frame
        } else {
            self.slots[frame] as usize
        };
        let lanes = &self.rows[row * self.lanes..(row + 1) * self.lanes];
        let value = |d: usize| {
            let r = lanes[d / 4].to_array()[d % 4];
            let s = self.scale[d];
            let n = if s > 0.0 { r / s } else { 0.0 };
            n * self.std[d] + self.mean[d]
        };
        *out = crate::trajectory::Trajectory::default();
        out.count = self.offset_count;
        out.offsets[..self.offset_count].copy_from_slice(&self.offsets[..self.offset_count]);
        for f in &self.features {
            let at = (0..self.offset_count)
                .find(|&i| self.offsets[i].to_bits() == f.time_offset.to_bits());
            let (Some(i), d) = (at, f.first_dim as usize) else {
                continue;
            };
            let v = [value(d), value(d + 1)];
            match f.kind {
                FeatureKind::TrajectoryPosition => out.positions[i] = v,
                FeatureKind::TrajectoryDirection => out.directions[i] = v,
                _ => {}
            }
        }
        true
    }

    /// The frame playing clip `clip` at `time` follows: the nearest frame of a run of that clip
    /// holding `time` (within half a frame of its ends), or `None`.
    pub fn frame_at(&self, clip: u32, time: f32) -> Option<u32> {
        for r in &self.runs {
            if r.clip != clip {
                continue;
            }
            let k = ((time - r.start) * self.rate).round_ties_even();
            if k >= 0.0 && k < r.count as f32 {
                return Some(r.first + k as u32);
            }
        }
        None
    }
}

/// A tag's index by name in a parsed database (setup-time lookup), or `None`.
pub fn tag_index(view: &PoseDbView<'_>, name: &str) -> Option<usize> {
    let strings = view.strings();
    view.tag_names()
        .iter()
        .position(|id| id != NONE && strings.get(id) == Some(name))
}
