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
//! - **KD bound:** a far child is skipped when `max(bound, (q_axis − split)²)` exceeds the best
//!   cost. Every entry of the far child lies beyond the split (`left ≤ split ≤ right`, checked at
//!   load), so its own term on that axis, and so its cost, is at least that;
//! - comparisons are strict (`>`), so a frame that ties the best is still evaluated and the
//!   index tie-break applies.

use crate::db::{MatchDb, Node, TagFilter};
use crate::MAX_KD_DEPTH;
use anim_math::F32x4;

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
/// `limit` once one is (checked every two lanes).
#[inline(always)]
pub(crate) fn distance(q: &[F32x4], r: &[F32x4], limit: f32) -> f32 {
    let mut acc = F32x4::splat(0.0);
    let n = q.len().min(r.len());
    let mut i = 0;
    while i + 2 <= n {
        let d0 = q[i] - r[i];
        let d1 = q[i + 1] - r[i + 1];
        acc = acc + d0 * d0;
        acc = acc + d1 * d1;
        i += 2;
        if i < n {
            let s = hsum(acc);
            if s > limit {
                return s;
            }
        }
    }
    if i < n {
        let d = q[i] - r[i];
        acc = acc + d * d;
    }
    hsum(acc)
}

struct Best {
    cost: f32,
    frame: u32,
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
    #[inline(always)]
    fn row(&self, i: usize) -> &[F32x4] {
        &self.rows[i * self.lanes..(i + 1) * self.lanes]
    }

    #[inline(always)]
    fn allowed(&self, i: usize, filter: &SearchFilter, open: bool) -> bool {
        if let Some(s) = filter.skip {
            if (i as u32).wrapping_sub(s.first) <= s.last.wrapping_sub(s.first)
                && self.frames[i].clip == s.clip
            {
                return false;
            }
        }
        open || self.passes(i, &filter.tags)
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
        for ((q, r), m) in query
            .iter()
            .zip(self.row(frame))
            .zip(&self.trajectory_mask)
        {
            let d = (*q - *r) * *m;
            acc = acc + d * d;
        }
        hsum(acc)
    }

    /// The least-cost frame passing `filter`, or `None` when none does (or `query` isn't
    /// `lanes()` long). Never allocates.
    pub fn search(&self, query: &[F32x4], filter: &SearchFilter, mode: SearchMode) -> Option<Match> {
        if query.len() != self.lanes || self.frames.is_empty() {
            return None;
        }
        let best = if mode == SearchMode::KdTree && !self.nodes.is_empty() {
            self.search_kd(query, filter)
        } else {
            self.search_brute(query, filter)
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

    fn search_brute(&self, q: &[F32x4], filter: &SearchFilter) -> Best {
        let open = filter.tags.is_open();
        let mut best = Best {
            cost: f32::INFINITY,
            frame: u32::MAX,
        };
        for (i, row) in self.rows.chunks_exact(self.lanes).enumerate() {
            if !self.allowed(i, filter, open) {
                continue;
            }
            let d = distance(q, row, best.cost);
            best.offer(d, i as u32);
        }
        best
    }

    fn search_kd(&self, q: &[F32x4], filter: &SearchFilter) -> Best {
        let open = filter.tags.is_open();
        let mut best = Best {
            cost: f32::INFINITY,
            frame: u32::MAX,
        };
        // Depth-first; the near child is pushed last so it pops first. At most one pending far
        // child per level, plus the near one: MAX_KD_DEPTH + 1 entries.
        let mut stack = [(0u32, 0.0f32); MAX_KD_DEPTH + 2];
        let mut sp = 1;
        while sp > 0 {
            sp -= 1;
            let (node, bound) = stack[sp];
            if bound > best.cost {
                continue;
            }
            match self.nodes[node as usize] {
                Node::Leaf { first, count } => {
                    for &f in &self.indices[first as usize..(first + count) as usize] {
                        let i = f as usize;
                        if !self.allowed(i, filter, open) {
                            continue;
                        }
                        let d = distance(q, self.row(i), best.cost);
                        best.offer(d, f);
                    }
                }
                Node::Inner {
                    axis,
                    split,
                    left,
                    right,
                } => {
                    let a = axis as usize;
                    let qa = q[a / 4].to_array()[a % 4];
                    let diff = qa - split;
                    let (near, far) = if diff < 0.0 {
                        (left, right)
                    } else {
                        (right, left)
                    };
                    let far_bound = bound.max(diff * diff);
                    if far_bound <= best.cost && sp + 2 <= stack.len() {
                        stack[sp] = (far, far_bound);
                        sp += 1;
                    }
                    if sp < stack.len() {
                        stack[sp] = (near, bound);
                        sp += 1;
                    }
                }
            }
        }
        best
    }
}
