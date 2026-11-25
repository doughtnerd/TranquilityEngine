//! Nearest-frame search: brute force over every row, or the KD-tree with branch and bound.
//!
//! # The cost
//!
//! `cost(q, r) = Σ weight_d · (q_d − r_d)²` over the normalised dims, computed as the squared
//! distance between the query and the database's `√weight`-scaled rows, four dims per
//! [`F32x4`]: each lane accumulates its dims in order, then the lanes are summed
//! `(l0 + l1) + (l2 + l3)`. Both search modes call the same distance, so they compute the same
//! bits for a frame.
//!
//! # Exactness
//!
//! Both modes return the frame of least cost among the frames that pass the filter, ties going to
//! the lower frame index. Pruning never changes that:
//!
//! - **early out:** a row is dropped once a partial sum exceeds the best cost. Rounding is
//!   monotonic and every term is ≥ 0, so a partial sum never exceeds the full one;
//! - **KD bound:** a node is skipped when a lower bound of its entries' costs exceeds the best
//!   cost. Each node keeps the bounding box of its rows (built at load); the bound is the squared
//!   offset of the query from the box (per dim: to the nearest face, 0 inside), summed in the
//!   distance's own order (lane by lane, then the lanes). Every entry lies in the box, so on each
//!   dim `|q − r| ≥` the offset, and the bound is the distance's own computation with every term
//!   replaced by one no larger: subtraction, multiplication and addition of non-negative values
//!   round monotonically, so the computed cost of any entry is at least the computed bound, bit
//!   for bit;
//! - comparisons are strict (`>`), so a frame that ties the best is still evaluated and the
//!   index tie-break applies.

use crate::db::{MatchDb, Node, Prepared, TagFilter};
use anim_math::{F32x4, Lane};

/// Which search runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SearchMode {
    /// Every row (SIMD, early out).
    BruteForce,
    /// The KD-tree when the database has one, else brute force.
    #[default]
    KdTree,
}

/// Frames a search skips: those of clip `clip` with index in `first..=last` (around the playing
/// frame, so a search doesn't pick its own neighbourhood).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Skip {
    pub clip: u32,
    pub first: u32,
    pub last: u32,
}

/// What a search may pick.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchFilter {
    pub tags: TagFilter,
    pub skip: Option<Skip>,
}

/// A search result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Match {
    /// Database frame index.
    pub frame: u32,
    /// Its cost.
    pub cost: f32,
    /// The frame's clip (index into the database's clip list).
    pub clip: u32,
    /// The frame's time in the clip, seconds.
    pub time: f32,
}

#[inline(always)]
fn hsum(v: F32x4) -> f32 {
    let a = v.to_array();
    (a[0] + a[1]) + (a[2] + a[3])
}

/// The squared distance between `q` and `r` (equal lengths), or some partial sum greater than
/// `limit` once one is (checked once, after the first half of the lanes: the schema puts the
/// pose features first, which separate frames most).
#[inline(always)]
pub(crate) fn distance(q: &[F32x4], r: &[F32x4], limit: f32) -> f32 {
    let n = q.len().min(r.len());
    let (q, r) = (&q[..n], &r[..n]);
    let half = n.div_ceil(2);
    let mut acc = F32x4::splat(0.0);
    for (a, b) in q[..half].iter().zip(&r[..half]) {
        let d = *a - *b;
        acc = acc + d * d;
    }
    if half < n {
        let s = hsum(acc);
        if s > limit {
            return s;
        }
    }
    for (a, b) in q[half..].iter().zip(&r[half..]) {
        let d = *a - *b;
        acc = acc + d * d;
    }
    hsum(acc)
}

struct Best {
    cost: f32,
    frame: u32,
}

/// One KD search's query, filter and best frame so far.
struct KdWalk<'q> {
    q: &'q [F32x4],
    skip: Option<Skip>,
    tags: &'q Prepared,
    best: Best,
}

impl Best {
    #[inline(always)]
    fn offer(&mut self, cost: f32, frame: u32) {
        if cost < self.cost || (cost == self.cost && frame < self.frame) {
            self.cost = cost;
            self.frame = frame;
        }
    }
}

impl MatchDb {
    /// Frame `i`'s row.
    #[inline(always)]
    fn row(&self, i: usize) -> &[F32x4] {
        let at = match self.slots.get(i) {
            Some(&s) => s as usize,
            None => i,
        };
        &self.rows[at * self.lanes..(at + 1) * self.lanes]
    }

    /// The row at leaf position `j` (the frame `indices[j]`).
    #[inline(always)]
    pub(crate) fn leaf_row(&self, j: usize) -> &[F32x4] {
        if self.slots.is_empty() {
            self.row(self.indices[j] as usize)
        } else {
            &self.rows[j * self.lanes..(j + 1) * self.lanes]
        }
    }

    /// The frame stored at row position `j` (see `rows`).
    #[inline(always)]
    fn frame_of(&self, j: usize) -> usize {
        if self.slots.is_empty() {
            j
        } else {
            self.indices[j] as usize
        }
    }

    #[inline(always)]
    fn allowed(&self, i: usize, skip: Option<Skip>, tags: &Prepared) -> bool {
        if let Some(s) = skip {
            if (i as u32).wrapping_sub(s.first) <= s.last.wrapping_sub(s.first)
                && self.frames[i].clip == s.clip
            {
                return false;
            }
        }
        self.passes_prepared(i, tags)
    }

    /// The weighted cost of frame `frame` against `query` (`lanes()` long). `f32::INFINITY` when
    /// out of range.
    pub fn cost(&self, query: &[F32x4], frame: usize) -> f32 {
        if frame >= self.frames.len() {
            return f32::INFINITY;
        }
        distance(query, self.row(frame), f32::INFINITY)
    }

    /// The weighted cost of frame `frame` against `query` over the trajectory dims only.
    pub fn trajectory_cost(&self, query: &[F32x4], frame: usize) -> f32 {
        if frame >= self.frames.len() {
            return f32::INFINITY;
        }
        let mut acc = F32x4::splat(0.0);
        for ((q, r), m) in query.iter().zip(self.row(frame)).zip(&self.trajectory_mask) {
            let d = (*q - *r) * *m;
            acc = acc + d * d;
        }
        hsum(acc)
    }

    /// The least-cost frame passing `filter`, or `None` when none does (or `query` isn't
    /// `lanes()` long). Never allocates.
    pub fn search(
        &self,
        query: &[F32x4],
        filter: &SearchFilter,
        mode: SearchMode,
    ) -> Option<Match> {
        if query.len() != self.lanes || self.frames.is_empty() {
            return None;
        }
        let tags = self.prepare(&filter.tags)?;
        let best = if mode == SearchMode::KdTree && !self.nodes.is_empty() {
            self.search_kd(query, filter.skip, &tags)
        } else {
            self.search_brute(query, filter.skip, &tags)
        };
        (best.frame != u32::MAX).then(|| {
            let f = self.frames[best.frame as usize];
            Match {
                frame: best.frame,
                cost: best.cost,
                clip: f.clip,
                time: f.time,
            }
        })
    }

    fn search_brute(&self, q: &[F32x4], skip: Option<Skip>, tags: &Prepared) -> Best {
        let mut best = Best {
            cost: f32::INFINITY,
            frame: u32::MAX,
        };
        // In storage order: the result, the least (cost, frame), doesn't depend on the order
        // (`offer` breaks ties by frame; a frame stopped early costs more than the best so far).
        for (j, row) in self.rows.chunks_exact(self.lanes).enumerate() {
            let i = self.frame_of(j);
            if !self.allowed(i, skip, tags) {
                continue;
            }
            let d = distance(q, row, best.cost);
            best.offer(d, i as u32);
        }
        best
    }

    /// The box bound of node `node`: `Σ off²` in [`distance`]'s order, `off` per dim the query's
    /// offset from the nearest face of the node's box (0 inside it).
    #[inline(always)]
    fn box_cost(&self, q: &[F32x4], node: u32) -> f32 {
        let lanes = self.lanes;
        let at = 2 * lanes * node as usize;
        let (lo, hi) = (
            &self.boxes[at..at + lanes],
            &self.boxes[at + lanes..at + 2 * lanes],
        );
        let zero = F32x4::splat(0.0);
        let mut acc = zero;
        for ((q, lo), hi) in q.iter().zip(lo).zip(hi) {
            let below = F32x4::select(q.lt(*lo), *q - *lo, zero);
            let o = F32x4::select(q.gt(*hi), *q - *hi, below);
            acc = acc + o * o;
        }
        hsum(acc)
    }

    fn search_kd(&self, q: &[F32x4], skip: Option<Skip>, tags: &Prepared) -> Best {
        let mut walk = KdWalk {
            q,
            skip,
            tags,
            best: Best {
                cost: f32::INFINITY,
                frame: u32::MAX,
            },
        };
        let root = self.box_cost(q, 0);
        self.kd_visit(0, root, &mut walk);
        walk.best
    }

    /// Visits `node`, whose every entry costs at least `bound`: depth first, the child with the
    /// lower bound first (recursion is at most [`MAX_KD_DEPTH`](crate::MAX_KD_DEPTH) deep,
    /// checked at load).
    fn kd_visit(&self, node: u32, bound: f32, w: &mut KdWalk<'_>) {
        if bound > w.best.cost {
            return;
        }
        match self.nodes[node as usize] {
            Node::Leaf { first, count } => {
                let range = first as usize..(first + count) as usize;
                for (j, &f) in range.clone().zip(&self.indices[range]) {
                    let i = f as usize;
                    if !self.allowed(i, w.skip, w.tags) {
                        continue;
                    }
                    let d = distance(w.q, self.leaf_row(j), w.best.cost);
                    w.best.offer(d, f);
                }
            }
            Node::Inner { left, right } => {
                let (bl, br) = (self.box_cost(w.q, left), self.box_cost(w.q, right));
                if bl <= br {
                    self.kd_visit(left, bl, w);
                    self.kd_visit(right, br, w);
                } else {
                    self.kd_visit(right, br, w);
                    self.kd_visit(left, bl, w);
                }
            }
        }
    }
}
