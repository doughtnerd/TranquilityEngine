//! Fold and jump clearance: the strategy interfaces of `Tiles/NavMeshStitcher.cs` (`IFoldClearance`,
//! `IJumpClearance`, `NoFoldClearance`, `NoJumpClearance`, `FoldCandidate`) and their heightfield implementations
//! `Tiles/HeightfieldFoldClearance.cs` and `Tiles/HeightfieldJumpClearance.cs`.
//!
//! Both test against the ground bin's solid heightfield (bin 0: identity frame, so local = world). The C# keeps
//! pointers to the grid-wide column heads; here the view is a [`GridHeightfield`] (`tiles::publish` builds it from the
//! per-tile heightfields: every column's spans, indexed by `x + z * width`, in one span pool) and the clearance structs
//! borrow it. All the maths is in doubles, as in the C#, so the samples land in the same cells everywhere.
//!
//! The stitcher calls [`FoldClearance::is_clear`] once per fold candidate and [`JumpClearance::is_clear`] per jump arc.
use nav_math::math::FLT_MIN_NORMAL;
use nav_math::{Double3, Float3};

use crate::tiles::GridHeightfield;
use crate::types::BinGrid;

/// A fold the stitcher is considering (`FoldCandidate`): two polygons of different bins meeting at an edge.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FoldCandidate {
    pub from_poly: i32,
    pub to_poly: i32,
    pub from_bin: i32,
    pub to_bin: i32,
    /// On `from_poly`.
    pub portal_a: Float3,
    pub portal_b: Float3,
    /// On `to_poly`.
    pub dest_a: Float3,
    pub dest_b: Float3,
    pub from_normal: Float3,
    pub to_normal: Float3,
    /// The polygons' centres: which side of each edge its polygon is on.
    pub from_center: Float3,
    pub to_center: Float3,
    pub convex: bool,
    /// Radians.
    pub fold_angle: f32,
}

/// Optional fold clearance test (`IFoldClearance`). Return false to reject a fold.
pub trait FoldClearance {
    fn is_clear(&self, candidate: &FoldCandidate) -> bool;
}

/// Jump clearance test (`IJumpClearance`). Return false if the arc from `from` to `to` (`NavMeshSurface.JumpArc`)
/// would pass through level geometry.
pub trait JumpClearance {
    fn is_clear(&self, from: Double3, to: Double3, arc_height: f64) -> bool;
}

impl<T: FoldClearance + ?Sized> FoldClearance for &T {
    fn is_clear(&self, candidate: &FoldCandidate) -> bool {
        (**self).is_clear(candidate)
    }
}

impl<T: JumpClearance + ?Sized> JumpClearance for &T {
    fn is_clear(&self, from: Double3, to: Double3, arc_height: f64) -> bool {
        (**self).is_clear(from, to, arc_height)
    }
}

/// Accepts every geometrically valid fold (`NoFoldClearance`).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoFoldClearance;

impl FoldClearance for NoFoldClearance {
    fn is_clear(&self, _candidate: &FoldCandidate) -> bool {
        true
    }
}

/// Accepts every jump (`NoJumpClearance`). Only for testing: jumps will go through walls.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoJumpClearance;

impl JumpClearance for NoJumpClearance {
    fn is_clear(&self, _from: Double3, _to: Double3, _arc_height: f64) -> bool {
        true
    }
}

/// `math.normalizesafe(double3)`: `v * rsqrt(dot(v, v))` unless `dot` is not above `FLT_MIN_NORMAL`, then zero.
fn normalize_safe(v: Double3) -> Double3 {
    let len = v.dot(v);
    if len > FLT_MIN_NORMAL as f64 { v * (1.0 / len.sqrt()) } else { Double3::default() }
}

/// `math.lerp(double3, double3, double)`: `x + s * (y - x)`.
fn lerp(x: Double3, y: Double3, s: f64) -> Double3 {
    x + (y - x) * s
}

/// Jump clearance against the ground bin's solid heightfield (`HeightfieldJumpClearance`). Samples the jump arc every
/// half cell and checks the agent's body at a few heights above it; any sample inside a solid span rejects the jump.
/// Points outside the heightfield count as clear. With no heightfield (`None`, or width 0) everything is clear.
#[derive(Clone, Copy, Debug)]
pub struct HeightfieldJumpClearance<'a> {
    pub heightfield: Option<&'a GridHeightfield>,
    /// 0 => no heightfield, everything is clear.
    pub width: i32,
    pub height: i32,
    /// Heightfield origin (bin 0 local min == world bounds min).
    pub bmin: Float3,
    pub cs: f32,
    pub ch: f32,
    /// World units.
    pub agent_height: f32,
}

impl<'a> HeightfieldJumpClearance<'a> {
    /// No heightfield: every jump is clear (the C#'s `default` struct).
    pub fn none() -> Self {
        Self { heightfield: None, width: 0, height: 0, bmin: Float3::default(), cs: 0.0, ch: 0.0, agent_height: 0.0 }
    }

    /// What `StitchProfileJob.Setup` builds: the tier's ground grid and its published solid heightfield.
    pub fn from_ground(ground: &BinGrid, heightfield: &'a GridHeightfield, agent_height: f32) -> Self {
        Self {
            heightfield: Some(heightfield),
            width: ground.width,
            height: ground.height,
            bmin: ground.bounds.min,
            cs: ground.cs,
            ch: ground.ch,
            agent_height,
        }
    }

    /// `NavMeshSurface.JumpArc` in doubles: the same trajectory agents fly.
    fn arc(from: Double3, to: Double3, arc_height: f64, t: f64) -> Double3 {
        let mut p = lerp(from, to, t);
        let k = arc_height + 0.5 * (to.y - from.y).abs();
        p.y += 4.0 * k * t * (1.0 - t);
        p
    }

    /// True if `p` (world space) is inside a solid span. Points outside the heightfield count as open.
    pub fn solid(&self, p: Double3) -> bool {
        let Some(hf) = self.heightfield else { return false };
        let bmin = self.bmin.to_double();
        let x = ((p.x - bmin.x) / self.cs as f64).floor() as i32;
        let z = ((p.z - bmin.z) / self.cs as f64).floor() as i32;
        if x < 0 || z < 0 || x >= self.width || z >= self.height {
            return false;
        }

        let y = ((p.y - bmin.y) / self.ch as f64).floor() as i32;
        for (smin, smax) in hf.column(x, z) {
            if y < smin {
                return false; // spans are sorted bottom to top
            }
            if y < smax {
                return true;
            }
        }
        false
    }
}

impl JumpClearance for HeightfieldJumpClearance<'_> {
    fn is_clear(&self, from: Double3, to: Double3, arc_height: f64) -> bool {
        if self.width <= 0 {
            return true;
        }

        // In doubles, so the samples land in the same cells everywhere (see NavExactMath).
        let length = (to - from).length() + 2.0 * arc_height;
        let steps = nav_math::math::max(2, (length / (0.5 * self.cs as f64)).ceil() as i32);

        // Body sample heights above the arc: just above the feet, middle, just below the head.
        let h0 = 2.0 * self.ch as f64;
        let h1 = 0.5 * self.agent_height as f64;
        let h2 = nav_math::math::max(h0, self.agent_height as f64 - self.ch as f64);

        // Skip the end samples: they sit on the take-off and landing surfaces. Coarse to fine: the middle sample, then
        // the quarters, eighths, ... Every i in [1, steps) is stride * odd for exactly one power-of-two stride.
        let mut stride = nav_math::math::ceilpow2(steps) / 2;
        while stride >= 1 {
            let mut i = stride;
            while i < steps {
                let c = Self::arc(from, to, arc_height, i as f64 / steps as f64);
                if self.solid(c + Double3::new(0.0, h0, 0.0))
                    || self.solid(c + Double3::new(0.0, h1, 0.0))
                    || self.solid(c + Double3::new(0.0, h2, 0.0))
                {
                    return false;
                }
                i += 2 * stride;
            }
            stride /= 2;
        }

        true
    }
}

/// Fold clearance against the ground bin's solid heightfield (`HeightfieldFoldClearance`). An outside fold takes the
/// agent round an edge, so the edge has to be in open air; each of the three tests of the C# (corner near, side clear,
/// ends at edge) is documented on its function.
#[derive(Clone, Copy, Debug)]
pub struct HeightfieldFoldClearance<'a> {
    /// Its solid spans; no heightfield (width 0): every fold is clear.
    pub heightfield: HeightfieldJumpClearance<'a>,
    /// The agent's, world units.
    pub radius: f32,
}

impl FoldClearance for HeightfieldFoldClearance<'_> {
    fn is_clear(&self, c: &FoldCandidate) -> bool {
        if !c.convex || self.heightfield.width <= 0 {
            return true;
        }
        if !self.corner_near(c.portal_a, c.dest_a, c) || !self.corner_near(c.portal_b, c.dest_b, c) {
            return false;
        }
        self.side_clear(c.portal_a, c.portal_b, c.from_normal, c.from_center)
            && self.side_clear(c.dest_a, c.dest_b, c.to_normal, c.to_center)
            && self.ends_at_edge(c.portal_a, c.portal_b, c.from_normal, c.from_center)
            && self.ends_at_edge(c.dest_a, c.dest_b, c.to_normal, c.to_center)
    }
}

impl HeightfieldFoldClearance<'_> {
    /// The corner between `p` (on the from polygon's edge) and `q` (on the to polygon's), as the stitcher's `FoldHinge`
    /// finds it: where the two surfaces, continued past their edges, meet. True if it's ahead of both edges and within a
    /// radius and two voxels of each, or if the surfaces run within 30 degrees of parallel there (a lip: `side_clear` and
    /// `ends_at_edge` decide).
    fn corner_near(&self, p: Float3, q: Float3, c: &FoldCandidate) -> bool {
        let (pd, qd) = (p.to_double(), q.to_double());
        let edge = normalize_safe(c.portal_b.to_double() - c.portal_a.to_double());
        let mut out_a = normalize_safe(edge.cross(c.from_normal.to_double()));
        if out_a.dot(pd - c.from_center.to_double()) < 0.0 {
            out_a = -out_a;
        }
        let mut out_b = normalize_safe(edge.cross(c.to_normal.to_double()));
        if out_b.dot(qd - c.to_center.to_double()) < 0.0 {
            out_b = -out_b;
        }

        let cos = out_a.dot(out_b);
        let den = 1.0 - cos * cos;
        if den < 0.25 {
            return true; // within 30 degrees of parallel: a lip (side_clear and ends_at_edge decide)
        }
        let w = pd - qd;
        let s = (cos * out_b.dot(w) - out_a.dot(w)) / den;
        let u = (out_b.dot(w) - cos * out_a.dot(w)) / den;
        let reach = self.radius as f64 + 2.0 * self.heightfield.cs as f64;
        s >= 0.0 && u >= 0.0 && s <= reach && u <= reach
    }

    /// One side of an outside fold: the surface ends at its edge a-b. In its plane (on the polygon edge's line and a
    /// quarter voxel either side), a radius plus 1.5 and 2 voxels past the polygon edge (erosion put the real edge about
    /// a radius past it), nothing solid.
    fn ends_at_edge(&self, a: Float3, b: Float3, normal: Float3, centre: Float3) -> bool {
        let (da, db, n) = (a.to_double(), b.to_double(), normal.to_double());
        let mid = (da + db) * 0.5;
        let mut away = normalize_safe(normalize_safe(db - da).cross(n));
        if away.dot(mid - centre.to_double()) < 0.0 {
            away = -away;
        }
        let cs = self.heightfield.cs as f64;
        let radius = self.radius as f64;
        for i in 0..=1 {
            for o in -1..=1 {
                if self.heightfield.solid(mid + n * (0.25 * cs * o as f64) + away * (radius + cs * (1.5 + 0.5 * i as f64))) {
                    return false;
                }
            }
        }
        true
    }

    /// One side of an outside fold: from the middle of edge a-b, two voxels off the surface (normal), out past the edge
    /// (in the surface's plane, away from its polygon's centre) for 2 radii + 2 voxels, sampled every half voxel.
    fn side_clear(&self, a: Float3, b: Float3, normal: Float3, centre: Float3) -> bool {
        let (da, db, n) = (a.to_double(), b.to_double(), normal.to_double());
        let mid = (da + db) * 0.5;
        let along = normalize_safe(db - da);
        let mut away = normalize_safe(along.cross(n));
        if away.dot(mid - centre.to_double()) < 0.0 {
            away = -away;
        }

        let cs = self.heightfield.cs as f64;
        let start = mid + n * (2.0 * cs);
        let length = 2.0 * self.radius as f64 + 2.0 * cs;
        let steps = nav_math::math::max(2, (length / (0.5 * cs)).ceil() as i32);
        for i in 0..=steps {
            if self.heightfield.solid(start + away * (length * i as f64 / steps as f64)) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_math::Float3;

    /// A 40 x 40 column grid, cs = ch = 1, with a solid slab [0, 4) on columns x in [10, 20) (all z) and a floor
    /// [0, 1) everywhere else.
    fn world() -> (BinGrid, GridHeightfield) {
        let grid = BinGrid { width: 40, height: 40, cs: 1.0, ch: 1.0, active: true, ..BinGrid::default() };
        let mut hf = GridHeightfield::new(&grid);
        for z in 0..40 {
            for x in 0..40 {
                let top = if (10..20).contains(&x) { 4 } else { 1 };
                let n = hf.pool.alloc();
                let s = hf.pool.get_mut(n);
                s.smin = 0;
                s.smax = top;
                s.area = 1;
                s.area_id = 1;
                hf.heads[(x + z * 40) as usize] = n;
            }
        }
        (grid, hf)
    }

    #[test]
    fn solid_matches_the_spans() {
        let (grid, hf) = world();
        let c = HeightfieldJumpClearance::from_ground(&grid, &hf, 2.0);
        assert!(c.solid(Double3::new(15.5, 2.5, 5.5)));
        assert!(!c.solid(Double3::new(15.5, 4.5, 5.5)));
        assert!(!c.solid(Double3::new(25.5, 2.5, 5.5))); // above the 1-high floor
        assert!(c.solid(Double3::new(25.5, 0.5, 5.5)));
        assert!(!c.solid(Double3::new(-5.0, 0.5, 5.5))); // outside is open
        assert!(!HeightfieldJumpClearance::none().solid(Double3::new(15.5, 2.5, 5.5)));
    }

    #[test]
    fn jump_through_a_wall_is_rejected_and_over_it_is_clear() {
        let (grid, hf) = world();
        let c = HeightfieldJumpClearance::from_ground(&grid, &hf, 2.0);
        // Flat jump across the slab at floor height + 1.
        assert!(!c.is_clear(Double3::new(5.5, 1.0, 5.5), Double3::new(25.5, 1.0, 5.5), 0.5));
        // A tall arc over the slab clears it (apex far above 4 + body).
        assert!(c.is_clear(Double3::new(5.5, 1.0, 5.5), Double3::new(25.5, 1.0, 5.5), 8.0));
        // A jump that stays on the floor side is clear.
        assert!(c.is_clear(Double3::new(2.5, 1.0, 5.5), Double3::new(8.5, 1.0, 5.5), 0.5));
        // No heightfield: always clear; and the no-op test.
        assert!(HeightfieldJumpClearance::none().is_clear(Double3::new(5.5, 1.0, 5.5), Double3::new(25.5, 1.0, 5.5), 0.0));
        assert!(NoJumpClearance.is_clear(Double3::default(), Double3::default(), 0.0));
    }

    #[test]
    fn jump_clearance_is_deterministic() {
        let (grid, hf) = world();
        let c = HeightfieldJumpClearance::from_ground(&grid, &hf, 2.0);
        let (a, b) = (Double3::new(3.25, 1.5, 7.75), Double3::new(23.5, 2.0, 9.125));
        let r = c.is_clear(a, b, 1.0);
        for _ in 0..4 {
            assert_eq!(c.is_clear(a, b, 1.0), r);
        }
    }

    /// An outside (convex) fold at the slab's top edge x = 10..: the from polygon is the slab top (normal +y, edge at
    /// x = 10 running along z), the to polygon the slab's -x face (normal -x).
    fn slab_corner() -> FoldCandidate {
        FoldCandidate {
            from_poly: 0,
            to_poly: 1,
            from_bin: 0,
            to_bin: 1,
            // Erosion keeps polygons about a radius from the corner: the top's edge is 0.5 in from x = 10.
            portal_a: Float3::new(10.5, 4.0, 10.0),
            portal_b: Float3::new(10.5, 4.0, 20.0),
            dest_a: Float3::new(10.0, 3.5, 10.0),
            dest_b: Float3::new(10.0, 3.5, 20.0),
            from_normal: Float3::new(0.0, 1.0, 0.0),
            to_normal: Float3::new(-1.0, 0.0, 0.0),
            from_center: Float3::new(15.0, 4.0, 15.0),
            to_center: Float3::new(10.0, 2.0, 15.0),
            convex: true,
            fold_angle: std::f32::consts::FRAC_PI_2,
        }
    }

    #[test]
    fn fold_over_a_free_edge_is_clear_and_a_buried_one_is_not() {
        let (grid, hf) = world();
        let clearance = HeightfieldFoldClearance { heightfield: HeightfieldJumpClearance::from_ground(&grid, &hf, 2.0), radius: 0.5 };
        let c = slab_corner();
        assert!(clearance.is_clear(&c), "free top edge of a slab is a valid wrap");

        // Concave folds and folds without a heightfield are accepted without testing.
        let mut concave = c;
        concave.convex = false;
        assert!(clearance.is_clear(&concave));
        let none = HeightfieldFoldClearance { heightfield: HeightfieldJumpClearance::none(), radius: 0.5 };
        assert!(none.is_clear(&c));
        assert!(NoFoldClearance.is_clear(&c));

        // Bury the way round the edge: a solid block just off the surface beside the edge. The same fold, with
        // the to-polygon's side blocked, is rejected.
        let mut blocked_hf = hf.clone();
        for z in 0..40 {
            for x in 5..10 {
                // Columns west of the slab: raise their solid to 8 (a wall next to the slab's -x face).
                let n = blocked_hf.pool.alloc();
                let s = blocked_hf.pool.get_mut(n);
                s.smin = 0;
                s.smax = 8;
                blocked_hf.heads[(x + z * 40) as usize] = n;
            }
        }
        let blocked = HeightfieldFoldClearance { heightfield: HeightfieldJumpClearance::from_ground(&grid, &blocked_hf, 2.0), radius: 0.5 };
        assert!(!blocked.is_clear(&c));
    }
}
