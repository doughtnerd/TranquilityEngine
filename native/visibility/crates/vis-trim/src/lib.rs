//! Import-time preparation of an occluder stand-in (ADR 0460 section 3, "Conservativeness rules (decided)"):
//!
//! - the **per-triangle error** of the stand-in against the original mesh, by dense sampling (a lattice over each
//!   triangle whose spacing is a fraction of the original's bounding-box diagonal, so a hole twice the tolerance cannot
//!   hide between samples), each sample measured to the nearest point of the original surface;
//! - **hole trimming:** triangles whose own error exceeds a fraction (0.5 %) of the diagonal are dropped, so closed
//!   doorways and windows reopen;
//! - the **edge-neighbour table** of the kept triangles, which tells the runtime which edges are silhouettes.
//!
//! The errors returned are the raw sampled errors. ADR 0460 doubles them before use (grazing silhouettes such as
//! terrain); the caller does that when it stores them.
// `!(x > 0.0)` rejects NaN on purpose.
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::needless_range_loop)]
use vis_raster::geom::tri_distance_sq;

/// "No neighbour": a boundary edge (or one shared by more than two triangles), always a silhouette at run time.
pub const NONE: u32 = u32::MAX;

/// An indexed triangle mesh: positions (x, y, z per vertex) and indices (three per triangle).
#[derive(Clone, Copy)]
pub struct Mesh<'a> {
    pub positions: &'a [f32],
    pub indices: &'a [u32],
}

#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Triangles whose error exceeds this fraction of the original's bounding-box diagonal are dropped (ADR: 0.005).
    pub trim_fraction: f32,
    /// The sampling lattice's spacing as a fraction of that diagonal (ADR spike: 0.005).
    pub spacing_fraction: f32,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            trim_fraction: 0.005,
            spacing_fraction: 0.005,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TrimError {
    /// A positions length that isn't a multiple of 3, an index list that isn't a multiple of 3, or an index out of range.
    BadMesh,
    /// The original has no triangles, or a vertex is not finite, or the options are not positive and finite.
    Unusable,
}

/// The trimmed stand-in.
#[derive(Clone, Debug, Default)]
pub struct Trimmed {
    /// For each kept triangle, its index in the stand-in's triangle list.
    pub kept: Vec<u32>,
    /// The kept triangles' vertex indices (into the stand-in's positions), three per triangle.
    pub indices: Vec<u32>,
    /// The kept triangles' sampled errors, world units (raw: not doubled).
    pub errors: Vec<f32>,
    /// The kept triangles' neighbours across edges a to b, b to c, c to a, as indices into the kept list, or [`NONE`].
    pub neighbors: Vec<u32>,
    /// Triangles dropped as closed holes.
    pub dropped: u32,
    /// The original's bounding-box diagonal.
    pub diagonal: f32,
    /// The largest error among the kept triangles.
    pub max_error: f32,
}

fn check(m: &Mesh) -> Result<(), TrimError> {
    if !m.positions.len().is_multiple_of(3) || !m.indices.len().is_multiple_of(3) {
        return Err(TrimError::BadMesh);
    }
    let nv = (m.positions.len() / 3) as u32;
    if m.indices.iter().any(|&i| i >= nv) {
        return Err(TrimError::BadMesh);
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------------------------- BVH

const LEAF: usize = 4;

struct Node {
    min: [f32; 3],
    max: [f32; 3],
    /// Internal: the index of the left child (the right is the next node after the left subtree: stored in `second`).
    /// Leaf: the first entry in the order list.
    first: u32,
    /// Internal: the right child's index. Leaf: unused.
    second: u32,
    /// 0 for an internal node.
    count: u32,
}

/// A bounding volume hierarchy over the original's triangles, for nearest-surface queries.
struct Bvh<'a> {
    pos: &'a [f32],
    idx: &'a [u32],
    nodes: Vec<Node>,
    order: Vec<u32>,
}

fn tri_pts(pos: &[f32], idx: &[u32], t: usize) -> [[f32; 3]; 3] {
    let p = |k: usize| {
        let v = idx[t * 3 + k] as usize * 3;
        [pos[v], pos[v + 1], pos[v + 2]]
    };
    [p(0), p(1), p(2)]
}

impl<'a> Bvh<'a> {
    fn new(m: &Mesh<'a>) -> Bvh<'a> {
        let nt = m.indices.len() / 3;
        let mut bvh = Bvh {
            pos: m.positions,
            idx: m.indices,
            nodes: Vec::with_capacity(nt / 2 + 1),
            order: (0..nt as u32).collect(),
        };
        let centroids: Vec<[f32; 3]> = (0..nt)
            .map(|t| {
                let p = tri_pts(m.positions, m.indices, t);
                [
                    (p[0][0] + p[1][0] + p[2][0]) / 3.0,
                    (p[0][1] + p[1][1] + p[2][1]) / 3.0,
                    (p[0][2] + p[1][2] + p[2][2]) / 3.0,
                ]
            })
            .collect();
        bvh.build(0, nt, &centroids);
        bvh
    }

    fn bounds(&self, lo: usize, hi: usize) -> ([f32; 3], [f32; 3]) {
        let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
        for &t in &self.order[lo..hi] {
            for p in tri_pts(self.pos, self.idx, t as usize) {
                for k in 0..3 {
                    mn[k] = mn[k].min(p[k]);
                    mx[k] = mx[k].max(p[k]);
                }
            }
        }
        (mn, mx)
    }

    /// Builds the subtree over `order[lo..hi]`, returns its node index.
    fn build(&mut self, lo: usize, hi: usize, c: &[[f32; 3]]) -> u32 {
        let (min, max) = self.bounds(lo, hi);
        let me = self.nodes.len() as u32;
        self.nodes.push(Node {
            min,
            max,
            first: lo as u32,
            second: 0,
            count: (hi - lo) as u32,
        });
        if hi - lo <= LEAF {
            return me;
        }
        // split at the median centroid along the widest axis
        let ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        let axis = if ext[0] >= ext[1] && ext[0] >= ext[2] {
            0
        } else if ext[1] >= ext[2] {
            1
        } else {
            2
        };
        let mid = (lo + hi) / 2;
        self.order[lo..hi].sort_by(|&a, &b| {
            c[a as usize][axis]
                .total_cmp(&c[b as usize][axis])
                .then(a.cmp(&b))
        });
        let left = self.build(lo, mid, c);
        let right = self.build(mid, hi, c);
        let n = &mut self.nodes[me as usize];
        n.first = left;
        n.second = right;
        n.count = 0;
        me
    }

    /// Squared distance from `p` to the nearest point of the mesh.
    fn nearest_sq(&self, p: [f32; 3]) -> f32 {
        let box_sq = |n: &Node| {
            let mut d2 = 0.0;
            for k in 0..3 {
                let d = (n.min[k] - p[k]).max(0.0).max(p[k] - n.max[k]);
                d2 += d * d;
            }
            d2
        };
        let mut best = f32::MAX;
        let mut stack = [0u32; 64];
        let mut sp = 1;
        stack[0] = 0;
        while sp > 0 {
            sp -= 1;
            let n = &self.nodes[stack[sp] as usize];
            if box_sq(n) >= best {
                continue;
            }
            if n.count > 0 {
                for &t in &self.order[n.first as usize..(n.first + n.count) as usize] {
                    let q = tri_pts(self.pos, self.idx, t as usize);
                    best = best.min(tri_distance_sq(p, q[0], q[1], q[2]));
                }
            } else {
                let (l, r) = (n.first, n.second);
                let (dl, dr) = (
                    box_sq(&self.nodes[l as usize]),
                    box_sq(&self.nodes[r as usize]),
                );
                // visit the nearer child first: push the farther one first
                let (near, far) = if dl <= dr { (l, r) } else { (r, l) };
                if sp + 2 <= stack.len() {
                    stack[sp] = far;
                    stack[sp + 1] = near;
                    sp += 2;
                }
            }
        }
        best
    }
}

// ------------------------------------------------------------------------------------------------------------- trim

/// The sampled error of triangle `t` of the stand-in: the largest distance from a lattice point of the triangle to the
/// original surface. Stops early once it exceeds `stop` (the triangle is going to be dropped; its exact error is moot).
fn triangle_error(bvh: &Bvh, standin: &Mesh, t: usize, spacing: f32, stop: f32) -> f32 {
    let [a, b, c] = tri_pts(standin.positions, standin.indices, t);
    let len = |p: [f32; 3], q: [f32; 3]| {
        let d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
    };
    let edge = len(a, b).max(len(b, c)).max(len(c, a));
    let n = ((edge / spacing).ceil().max(5.0) as usize).min(400);
    let stop_sq = stop * stop;
    let mut worst_sq = 0f32;
    for i in 0..=n {
        for j in 0..=n - i {
            let (u, v) = (i as f32 / n as f32, j as f32 / n as f32);
            let w = 1.0 - u - v;
            let p = [
                a[0] * w + b[0] * u + c[0] * v,
                a[1] * w + b[1] * u + c[1] * v,
                a[2] * w + b[2] * u + c[2] * v,
            ];
            worst_sq = worst_sq.max(bvh.nearest_sq(p));
            if worst_sq > stop_sq {
                return worst_sq.sqrt();
            }
        }
    }
    worst_sq.sqrt()
}

/// Measures every triangle of `standin` against `original`, drops those whose error exceeds
/// `options.trim_fraction` of the original's diagonal, and returns the rest with their errors and neighbour table.
pub fn trim(original: &Mesh, standin: &Mesh, options: &Options) -> Result<Trimmed, TrimError> {
    check(original)?;
    check(standin)?;
    let finite = original
        .positions
        .iter()
        .chain(standin.positions.iter())
        .all(|v| v.is_finite());
    if original.indices.is_empty()
        || !finite
        || !(options.trim_fraction > 0.0
            && options.trim_fraction.is_finite()
            && options.spacing_fraction > 0.0
            && options.spacing_fraction.is_finite())
    {
        return Err(TrimError::Unusable);
    }
    // the original's bounding box (over the vertices its triangles use)
    let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
    for &i in original.indices {
        let v = i as usize * 3;
        for k in 0..3 {
            mn[k] = mn[k].min(original.positions[v + k]);
            mx[k] = mx[k].max(original.positions[v + k]);
        }
    }
    let diagonal =
        ((mx[0] - mn[0]).powi(2) + (mx[1] - mn[1]).powi(2) + (mx[2] - mn[2]).powi(2)).sqrt();
    if !(diagonal > 0.0) {
        return Err(TrimError::Unusable);
    }
    let tau = options.trim_fraction * diagonal;
    let spacing = options.spacing_fraction * diagonal;
    let bvh = Bvh::new(original);
    let mut out = Trimmed {
        diagonal,
        ..Trimmed::default()
    };
    for t in 0..standin.indices.len() / 3 {
        let e = triangle_error(&bvh, standin, t, spacing, tau);
        if e > tau {
            out.dropped += 1;
            continue;
        }
        out.kept.push(t as u32);
        out.indices
            .extend_from_slice(&standin.indices[t * 3..t * 3 + 3]);
        out.errors.push(e);
        out.max_error = out.max_error.max(e);
    }
    out.neighbors = neighbors(standin.positions, &out.indices);
    Ok(out)
}

// ------------------------------------------------------------------------------------------------------ neighbours

/// The edge-neighbour table of a triangle list: per triangle, the triangle across each of its edges a to b, b to c, c to a
/// (an index into the list), or [`NONE`] for a boundary edge or one shared by more than two triangles. Vertices that
/// share a position bit for bit are one vertex, so a stand-in whose vertices aren't welded by index still joins up.
/// Triangles with a repeated vertex have no neighbours.
pub fn neighbors(positions: &[f32], indices: &[u32]) -> Vec<u32> {
    use std::collections::HashMap;
    let nt = indices.len() / 3;
    let mut id: HashMap<[u32; 3], u32> = HashMap::new();
    let mut weld = |v: u32| {
        let p = v as usize * 3;
        let key = [
            positions[p].to_bits(),
            positions[p + 1].to_bits(),
            positions[p + 2].to_bits(),
        ];
        let next = id.len() as u32;
        *id.entry(key).or_insert(next)
    };
    let mut edges: Vec<(u32, u32, u32, u8)> = Vec::with_capacity(nt * 3);
    for t in 0..nt {
        let v = [
            weld(indices[t * 3]),
            weld(indices[t * 3 + 1]),
            weld(indices[t * 3 + 2]),
        ];
        if v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            continue;
        }
        for k in 0..3 {
            let (a, b) = (v[k], v[(k + 1) % 3]);
            edges.push((a.min(b), a.max(b), t as u32, k as u8));
        }
    }
    edges.sort_unstable();
    let mut out = vec![NONE; nt * 3];
    let mut i = 0;
    while i < edges.len() {
        let mut j = i + 1;
        while j < edges.len() && edges[j].0 == edges[i].0 && edges[j].1 == edges[i].1 {
            j += 1;
        }
        if j - i == 2 {
            let (a, b) = (edges[i], edges[i + 1]);
            out[a.2 as usize * 3 + a.3 as usize] = b.2;
            out[b.2 as usize * 3 + b.3 as usize] = a.2;
        }
        i = j;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit square in the XY plane as two triangles, welded by index.
    fn square() -> (Vec<f32>, Vec<u32>) {
        (
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0],
            vec![0, 1, 2, 0, 2, 3],
        )
    }

    #[test]
    fn neighbours_join_across_the_shared_edge_only() {
        let (p, i) = square();
        // triangle 0 = (0,1,2): edges 0-1, 1-2, 2-0; triangle 1 = (0,2,3): edges 0-2, 2-3, 3-0. They share 2-0 / 0-2.
        assert_eq!(neighbors(&p, &i), vec![NONE, NONE, 1, 0, NONE, NONE]);
    }

    #[test]
    fn neighbours_weld_vertices_by_position() {
        // the same square with the second triangle's vertices duplicated, not shared
        let p = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0,
            0.0,
        ];
        let i = vec![0, 1, 2, 3, 4, 5];
        assert_eq!(neighbors(&p, &i), vec![NONE, NONE, 1, 0, NONE, NONE]);
    }

    #[test]
    fn an_exact_standin_keeps_everything_with_zero_error() {
        let (p, i) = square();
        let m = Mesh {
            positions: &p,
            indices: &i,
        };
        let t = trim(&m, &m, &Options::default()).unwrap();
        assert_eq!(t.dropped, 0);
        assert_eq!(t.kept, vec![0, 1]);
        assert!(t.max_error < 1e-5, "{}", t.max_error);
    }

    #[test]
    fn a_triangle_closing_a_hole_is_dropped() {
        // the original is a square ring with a big hole (four triangles' worth of border), the stand-in a full square
        let orig_p = vec![
            0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 0.0, 1.0, 1.0, 0.0, 3.0, 1.0,
            0.0, 3.0, 3.0, 0.0, 1.0, 3.0, 0.0,
        ];
        let orig_i = vec![
            0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
        ];
        let (sp, si) = (
            vec![0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 0.0],
            vec![0, 1, 2, 0, 2, 3],
        );
        let t = trim(
            &Mesh {
                positions: &orig_p,
                indices: &orig_i,
            },
            &Mesh {
                positions: &sp,
                indices: &si,
            },
            &Options::default(),
        )
        .unwrap();
        assert_eq!(
            t.dropped, 2,
            "both triangles of the full square cover the hole"
        );
        assert!(t.indices.is_empty());
    }

    #[test]
    fn a_bad_mesh_is_refused() {
        let (p, _) = square();
        let m = Mesh {
            positions: &p,
            indices: &[0, 1, 9],
        };
        assert_eq!(
            trim(&m, &m, &Options::default()).unwrap_err(),
            TrimError::BadMesh
        );
        let nan = vec![f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];
        let m = Mesh {
            positions: &nan,
            indices: &[0, 1, 2],
        };
        assert_eq!(
            trim(&m, &m, &Options::default()).unwrap_err(),
            TrimError::Unusable
        );
    }
}
