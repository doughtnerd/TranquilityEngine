//! The KD-tree build (offline, at bake; allocates).
//!
//! Median splits on the dimension of greatest weighted spread `(max − min)·√weight` (ties: the
//! lowest dimension), over the rows a node holds. Entries are ordered by `(value, frame index)`
//! (a total order, so the build is deterministic); the left child takes the first `⌊n/2⌋` and the
//! right the rest, and the split value is the right half's smallest value. So every left value is
//! `≤ split` and every right value `≥ split`, which is all the search's bound needs. A node with
//! at most `leaf_size` entries, or whose rows are all equal, is a leaf; a leaf's entries are in
//! frame order. Nodes are numbered in pre-order, so children follow their parent.

use anim_format::posedb::{KdNode, KdTree};

/// Builds the tree over `matrix` (`dims` normalised values per row, unpadded) with per-dim
/// distance scales `scale` (`√weight`). `leaf_size` is clamped to at least 1.
pub fn build(matrix: &[f32], dims: usize, scale: &[f32], leaf_size: usize) -> KdTree {
    let n = matrix.len().checked_div(dims).unwrap_or(0);
    let mut indices: Vec<u32> = (0..n as u32).collect();
    let mut nodes = Vec::new();
    let b = Builder {
        matrix,
        dims,
        scale,
        leaf: leaf_size.max(1),
    };
    b.node(&mut nodes, &mut indices, 0);
    KdTree { nodes, indices }
}

struct Builder<'a> {
    matrix: &'a [f32],
    dims: usize,
    scale: &'a [f32],
    leaf: usize,
}

impl Builder<'_> {
    fn value(&self, frame: u32, dim: usize) -> f32 {
        self.matrix[frame as usize * self.dims + dim]
    }

    fn node(&self, nodes: &mut Vec<KdNode>, idx: &mut [u32], first: usize) -> u32 {
        let me = nodes.len();
        nodes.push(KdNode::Leaf { first: 0, count: 0 });
        let leaf = |nodes: &mut Vec<KdNode>, idx: &mut [u32]| {
            idx.sort_unstable();
            nodes[me] = KdNode::Leaf {
                first: first as u32,
                count: idx.len() as u32,
            };
            me as u32
        };
        if idx.len() <= self.leaf {
            return leaf(nodes, idx);
        }
        let mut axis = 0;
        let mut spread = 0.0f32;
        for d in 0..self.dims {
            let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
            for &f in idx.iter() {
                let v = self.value(f, d);
                lo = lo.min(v);
                hi = hi.max(v);
            }
            let s = (hi - lo) * self.scale[d];
            if s > spread {
                spread = s;
                axis = d;
            }
        }
        if !(spread > 0.0) {
            return leaf(nodes, idx);
        }
        let m = idx.len() / 2;
        idx.select_nth_unstable_by(m, |&a, &b| {
            self.value(a, axis)
                .total_cmp(&self.value(b, axis))
                .then(a.cmp(&b))
        });
        let split = self.value(idx[m], axis);
        let (l, r) = idx.split_at_mut(m);
        let left = self.node(nodes, l, first);
        let right = self.node(nodes, r, first + m);
        nodes[me] = KdNode::Inner {
            axis: axis as u32,
            split,
            left,
            right,
        };
        me as u32
    }
}
