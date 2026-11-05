//! Where each agent crosses from one graph (or volume) into the next (Foxfire's `Lib/NavCrossing.cs`).
//!
//! A route crosses a seam by one link: a polygon edge pair (walkers) or a leaf pair's rectangle (flyers), often a
//! metre or two wide, and every agent sharing the route used to head for that one link, so they queued at it. The
//! links of a seam that touch each other form a span (one stretch of open seam, connected on both sides), and each
//! agent crosses the route's span where its way from where it is to where it goes next is straightest.
//!
//! The links live in the route graph (`NavGraphLink`, `NavAirLink`, `NavAirFrontier`); these functions read them
//! through small traits ([`PortalLink`], [`FaceLink`], [`FrontierRect`]) so they don't depend on its layout.
//! [`CrossingPortal`], [`CrossingFace`] and [`CrossingFrontier`] are plain implementations.
use nav_math::math::{self, max, min};
use nav_math::{Float3, Hash128};

/// How close link ends (or rectangle sides) count as touching.
pub const TOUCH: f32 = 0.05;

const NUDGE: f32 = 0.05; // a face point is put this far back on the near side, as FacePoint does

/// Weight of the way on past a face (to the next leg's end) against the way to it, when a flyer chooses where to
/// cross. At 1 every flyer crosses on its straight line to the next leg's end, and as those all meet there, a
/// crowd narrows toward one point at the face. At a half, like light into a slower medium, a flyer turns at most
/// 30 degrees off straight across toward it, so the crowd keeps most of its width.
pub const ONWARD: f32 = 0.5;

/// Seconds of flight a flyer carries on for past a face while its next leg's path is searched.
pub const CARRY_SECONDS: f32 = 0.5;

// ---------------------------------------------------------------------------------------------------------
// The links, as the crossing sees them
// ---------------------------------------------------------------------------------------------------------

/// A walker's link from one graph to another (`NavGraphLink`): the portal `a0`-`a1`, its span and which of its
/// ends meet another portal of the span.
pub trait PortalLink {
    fn from_graph(&self) -> i32;
    fn to_graph(&self) -> i32;
    fn a0(&self) -> Float3;
    fn a1(&self) -> Float3;
    fn span(&self) -> i32;
    fn set_span(&mut self, span: i32);
    /// Bit 0: `a0` meets another portal of the span; bit 1: `a1` does.
    fn joined(&self) -> u8;
    fn set_joined(&mut self, joined: u8);
}

/// A flyer's link from one volume to another (`NavAirLink`): the face rectangle `min`-`max`, flat along x or z.
pub trait FaceLink {
    fn from_volume(&self) -> i32;
    fn to_volume(&self) -> i32;
    fn min(&self) -> Float3;
    fn max(&self) -> Float3;
    fn span(&self) -> i32;
    fn set_span(&mut self, span: i32);
}

/// A rectangle of a volume's face with nothing loaded beyond it (`NavAirFrontier`).
pub trait FrontierRect {
    fn volume(&self) -> i32;
    /// The `NavChunkFace` value.
    fn face(&self) -> i32;
    fn min(&self) -> Float3;
    fn max(&self) -> Float3;
    fn span(&self) -> i32;
    fn set_span(&mut self, span: i32);
}

/// A plain [`PortalLink`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CrossingPortal {
    pub from_graph: i32,
    pub to_graph: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
    pub span: i32,
    pub joined: u8,
}

impl PortalLink for CrossingPortal {
    fn from_graph(&self) -> i32 {
        self.from_graph
    }
    fn to_graph(&self) -> i32 {
        self.to_graph
    }
    fn a0(&self) -> Float3 {
        self.a0
    }
    fn a1(&self) -> Float3 {
        self.a1
    }
    fn span(&self) -> i32 {
        self.span
    }
    fn set_span(&mut self, span: i32) {
        self.span = span;
    }
    fn joined(&self) -> u8 {
        self.joined
    }
    fn set_joined(&mut self, joined: u8) {
        self.joined = joined;
    }
}

/// A plain [`FaceLink`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CrossingFace {
    pub from_volume: i32,
    pub to_volume: i32,
    pub min: Float3,
    pub max: Float3,
    pub span: i32,
}

impl FaceLink for CrossingFace {
    fn from_volume(&self) -> i32 {
        self.from_volume
    }
    fn to_volume(&self) -> i32 {
        self.to_volume
    }
    fn min(&self) -> Float3 {
        self.min
    }
    fn max(&self) -> Float3 {
        self.max
    }
    fn span(&self) -> i32 {
        self.span
    }
    fn set_span(&mut self, span: i32) {
        self.span = span;
    }
}

/// A plain [`FrontierRect`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CrossingFrontier {
    pub volume: i32,
    pub face: i32,
    pub min: Float3,
    pub max: Float3,
    pub span: i32,
}

impl FrontierRect for CrossingFrontier {
    fn volume(&self) -> i32 {
        self.volume
    }
    fn face(&self) -> i32 {
        self.face
    }
    fn min(&self) -> Float3 {
        self.min
    }
    fn max(&self) -> Float3 {
        self.max
    }
    fn span(&self) -> i32 {
        self.span
    }
    fn set_span(&mut self, span: i32) {
        self.span = span;
    }
}

/// `NavRouteGraphs.Key`: a pair of graphs (or a volume and a face) as one key.
pub fn pair_key(a: i32, b: i32) -> i64 {
    ((a as i64) << 32) | (b as u32 as i64)
}

// ---------------------------------------------------------------------------------------------------------
// Aiming, lookups, carrying on
// ---------------------------------------------------------------------------------------------------------

/// Where an agent heads after crossing into leg `k`: that leg's end (its exit), or on the last leg the goal, or
/// the edge it waits at. `leg_ends` are the legs' ends (`NavChunkLeg.End`), in order (`NavCrossing.Aim`).
pub fn aim(leg_ends: &[Float3], k: usize, to_edge: bool, goal: Float3) -> Float3 {
    if k + 1 < leg_ends.len() {
        return leg_ends[k];
    }
    if to_edge {
        leg_ends[leg_ends.len() - 1]
    } else {
        goal
    }
}

/// The index of the graph of `chunk`'s navmesh (or its overlay's) among `(chunk, overlay)` pairs, or None
/// (`NavCrossing.GraphOf`).
pub fn graph_of(graphs: impl IntoIterator<Item = (Hash128, bool)>, chunk: Hash128, overlay: bool) -> Option<usize> {
    graphs.into_iter().position(|(c, o)| c == chunk && o == overlay)
}

/// The index of the volume of `chunk` among the volumes' chunks, or None (`NavCrossing.VolumeOf`).
pub fn volume_of(volumes: impl IntoIterator<Item = Hash128>, chunk: Hash128) -> Option<usize> {
    volumes.into_iter().position(|c| c == chunk)
}

/// Keeps a flyer that just reached a face flying on while its next leg's path is searched (a few frames in a
/// crowd): straight at `target`, for [`CARRY_SECONDS`] of flight at most, as the last point of the path it has
/// (`NavCrossing.CarryOn`). Returns the point to fly to (the path's `Next`), or None if it should stay as it is:
/// the path is empty or failed (the caller checks), or the flyer is within `arrival` of the target. The caller
/// then sets `NextIndex = Count - 1`, `Prev = position`, `Next` = the result and the state to following.
/// `arrival` is the path's own arrival distance if it has one (above 0), else the flyer's.
pub fn carry_on_next(position: Float3, target: Float3, path_arrival: f32, flyer_arrival: f32, flyer_speed: f32) -> Option<Float3> {
    let to = target - position;
    let dist = to.length();
    let arrival = if path_arrival > 0.0 { path_arrival } else { flyer_arrival };
    if dist <= arrival {
        return None;
    }
    Some(position + to * (min(dist, max(flyer_speed * CARRY_SECONDS, 2.0 * arrival)) / dist))
}

// ---------------------------------------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------------------------------------

/// The crossing of the seam link from graph `from` into graph `to` whose portal is `a`-`b`, for an agent at `p`
/// going on to `q`: over the links of that link's span, the point where p to it to q is shortest, kept `radius`
/// from the span's ends (as the portal point keeps it from a portal's; not from where two of its portals meet).
/// `a`-`b` become the chosen portal. `None` (a, b, point unchanged) if no such link is loaded (`BestPortal`).
#[allow(clippy::too_many_arguments)]
pub fn best_portal<L: PortalLink>(links: &[L], from: i32, to: i32, p: Float3, q: Float3, radius: f32, a: &mut Float3, b: &mut Float3, point: &mut Float3) -> bool {
    let mut span = -1;
    for link in links {
        if link.from_graph() == from && link.to_graph() == to && link.a0() == *a && link.a1() == *b {
            span = link.span();
            break;
        }
    }
    if span < 0 {
        return false;
    }
    let mut best = f32::MAX;
    for link in links {
        if link.span() != span || link.from_graph() != from || link.to_graph() != to {
            continue;
        }
        let x = on_portal(
            link.a0(),
            link.a1(),
            p,
            q,
            if link.joined() & 1 != 0 { 0.0 } else { radius },
            if link.joined() & 2 != 0 { 0.0 } else { radius },
        );
        let cost = p.distance(x) + x.distance(q);
        if cost >= best {
            continue;
        }
        best = cost;
        *a = link.a0();
        *b = link.a1();
        *point = x;
    }
    true
}

fn cross(a: (f32, f32), b: (f32, f32)) -> f32 {
    a.0 * b.1 - a.1 * b.0
}

/// The point of portal `a`-`b` (kept `inset_a` from a, `inset_b` from b; its middle if it's narrower) where p to
/// it to q is about shortest (`OnPortal`).
pub fn on_portal(a: Float3, b: Float3, p: Float3, q: Float3, inset_a: f32, inset_b: f32) -> Float3 {
    let ab = b - a;
    let length = ab.length();
    if length <= inset_a + inset_b || length < 1e-4 {
        return a + ab * 0.5;
    }
    let t0 = inset_a / length;
    let t1 = 1.0 - inset_b / length;

    // Where p-q crosses the portal's line, seen from above (straight through, if that's on the portal); else the
    // nearer usable end. The cost along the portal is convex, so the best of those is the best point.
    let pq = (q.x - p.x, q.z - p.z);
    let denom = cross((ab.x, ab.z), pq);
    let t = if math::abs(denom) > 1e-6 { cross((p.x - a.x, p.z - a.z), pq) / denom } else { (p - a).dot(ab) / (length * length) };
    let x = a + ab * math::clamp(t, t0, t1);
    let lo = a + ab * t0;
    let hi = a + ab * t1;
    let cx = p.distance(x) + x.distance(q);
    let cl = p.distance(lo) + lo.distance(q);
    let ch = p.distance(hi) + hi.distance(q);
    if cl < cx && cl <= ch {
        lo
    } else if ch < cx {
        hi
    } else {
        x
    }
}

/// The point of portal `a`-`b` (`radius` from its ends; its middle if it's narrower) where the way from p to it
/// plus `weight` times the way on to q is shortest. With weight below 1 the agent crosses nearer square to the
/// portal than its straight line to q ([`ONWARD`]): agents heading for one point beyond keep apart at the
/// portal. The cost is convex along the portal: a ternary search (`OnPortalToward`).
pub fn on_portal_toward(a: Float3, b: Float3, p: Float3, q: Float3, radius: f32, weight: f32) -> Float3 {
    let ab = b - a;
    let length = ab.length();
    if length <= 2.0 * radius || length < 1e-4 {
        return a + ab * 0.5;
    }
    let mut lo = radius / length;
    let mut hi = 1.0 - lo;
    for _ in 0..24 {
        let m1 = lo + (hi - lo) / 3.0;
        let m2 = hi - (hi - lo) / 3.0;
        let x1 = a + ab * m1;
        let x2 = a + ab * m2;
        if p.distance(x1) + weight * x1.distance(q) <= p.distance(x2) + weight * x2.distance(q) {
            hi = m2;
        } else {
            lo = m1;
        }
    }
    a + ab * (0.5 * (lo + hi))
}

// ---------------------------------------------------------------------------------------------------------
// Flyers
// ---------------------------------------------------------------------------------------------------------

fn select3(a: Float3, b: Float3, c: [bool; 3]) -> Float3 {
    Float3::new(if c[0] { b.x } else { a.x }, if c[1] { b.y } else { a.y }, if c[2] { b.z } else { a.z })
}

fn le3(a: Float3, b: Float3) -> [bool; 3] {
    [a.x <= b.x, a.y <= b.y, a.z <= b.z]
}

fn ge3(a: Float3, b: Float3) -> [bool; 3] {
    [a.x >= b.x, a.y >= b.y, a.z >= b.z]
}

/// `BestPortal` for flyers: over the air links of the span of the link from volume `from` into volume `to`
/// whose rectangle is `min`-`max`, the face point where p to it to q is shortest, kept `radius` in from the
/// span's outline (not from where its rectangles meet) and nudged back to p's side, as the face point does.
/// `min`-`max` become the chosen rectangle (`BestFace`).
#[allow(clippy::too_many_arguments)]
pub fn best_face<L: FaceLink>(links: &[L], from: i32, to: i32, p: Float3, q: Float3, radius: f32, min_out: &mut Float3, max_out: &mut Float3, point: &mut Float3) -> bool {
    let lo = min_out.min_v(*max_out);
    let hi = min_out.max_v(*max_out);
    let mut span = -1;
    for link in links {
        if link.from_volume() == from && link.to_volume() == to && link.min() == lo && link.max() == hi {
            span = link.span();
            break;
        }
    }
    if span < 0 {
        return false;
    }

    // The span's bounds: a rectangle's side on them is the span's edge, kept radius from; one inside meets another.
    let mut span_lo = lo;
    let mut span_hi = hi;
    for link in links {
        if link.span() != span || link.from_volume() != from || link.to_volume() != to {
            continue;
        }
        span_lo = span_lo.min_v(link.min());
        span_hi = span_hi.max_v(link.max());
    }

    let mut best = f32::MAX;
    for link in links {
        if link.span() != span || link.from_volume() != from || link.to_volume() != to {
            continue;
        }
        let x = on_face(link.min(), link.max(), span_lo, span_hi, p, q, radius);
        let cost = p.distance(x) + ONWARD * x.distance(q);
        if cost >= best {
            continue;
        }
        best = cost;
        *min_out = link.min();
        *max_out = link.max();
        *point = x;
    }
    true
}

/// The point of face rectangle `lo`-`hi` where crossing costs least (the way to it plus [`ONWARD`] times the way
/// on to q), or nearest that: kept `radius` in from the sides it shares with the span's bounds
/// `span_lo`-`span_hi`, put a nudge back on p's side (`OnFace`).
pub fn on_face(lo: Float3, hi: Float3, span_lo: Float3, span_hi: Float3, p: Float3, q: Float3, radius: f32) -> Float3 {
    let size = hi - lo;
    let inset = Float3::splat(radius).min_v(size * 0.5);
    let inset_lo = select3(Float3::splat(0.0), inset, le3(lo, span_lo + Float3::splat(TOUCH)));
    let inset_hi = select3(Float3::splat(0.0), inset, ge3(hi, span_hi - Float3::splat(TOUCH)));
    let axis = if size.x < size.z { 0 } else { 2 }; // the face is flat along x or z

    // Snell's law: sin(angle off square at p's side) = Onward * sin(angle at q's side). Taken from p's foot on
    // the face (q's angle seen from there), which is close for a flyer near the face, where it matters.
    let mut foot = p;
    foot[axis] = lo[axis];
    let mut to_q = q - foot;
    let hq = math::abs(to_q[axis]);
    to_q[axis] = 0.0;
    let lateral = to_q.length();
    let mut x = foot;
    if lateral > 1e-4 {
        let sin = ONWARD * lateral / (lateral * lateral + hq * hq).sqrt();
        let hp = math::abs(p[axis] - lo[axis]);
        x += to_q * (min(lateral, hp * sin / (1.0 - sin * sin).sqrt()) / lateral);
    }

    x = x.clamp(lo + inset_lo, hi - inset_hi);
    x[axis] = lo[axis] + if p[axis] < lo[axis] { -NUDGE } else { NUDGE };
    x
}

/// Where a flyer at p waits at the edge of loaded space instead of `edge`, the one point of the frontier nearest
/// its goal that its route ends at (and every flyer sharing the route with it): the point nearest p of the
/// frontier rectangles of the same open stretch (`span`) in `volume`, kept `radius` in from the stretch's outline.
/// A crowd waits along the edge in the width it came with. `edge` if it's on no frontier rectangle of `volume`
/// (`EdgeWait`).
pub fn edge_wait<F: FrontierRect>(frontier: &[F], volume: i32, edge: Float3, p: Float3, radius: f32) -> Float3 {
    let mut span = -1;
    for f in frontier {
        if f.volume() == volume && edge.distance_sq(edge.clamp(f.min(), f.max())) <= TOUCH * TOUCH {
            span = f.span();
            break;
        }
    }
    if span < 0 {
        return edge;
    }
    let mut span_lo = edge;
    let mut span_hi = edge;
    for f in frontier {
        if f.span() != span || f.volume() != volume {
            continue;
        }
        span_lo = span_lo.min_v(f.min());
        span_hi = span_hi.max_v(f.max());
    }

    let mut best = f32::MAX;
    let mut point = edge;
    for f in frontier {
        if f.span() != span || f.volume() != volume {
            continue;
        }
        let size = f.max() - f.min();
        let inset = Float3::splat(radius).min_v(size * 0.5);
        let zero = Float3::splat(0.0);
        let lo = f.min() + select3(zero, inset, le3(f.min(), span_lo + Float3::splat(TOUCH)));
        let hi = f.max() - select3(zero, inset, ge3(f.max(), span_hi - Float3::splat(TOUCH)));
        let x = p.clamp(lo, hi);
        let d = p.distance_sq(x);
        if d >= best {
            continue;
        }
        best = d;
        point = x;
    }
    point
}

// ---------------------------------------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------------------------------------

/// A link's bounds (grown by [`TOUCH`]), its pair of graphs, and its place along the seam to sweep by.
#[derive(Clone, Copy)]
struct Boxed {
    pair: i64,
    /// min.x + min.z: boxes that touch differ in it by less than their own extent.
    start: f32,
    /// max.x + max.z.
    end: f32,
    min: Float3,
    max: Float3,
    index: usize,
}

impl Boxed {
    fn of(pair: i64, min: Float3, max: Float3, index: usize) -> Self {
        let min = min - Float3::splat(TOUCH);
        let max = max + Float3::splat(TOUCH);
        Self { pair, start: min.x + min.z, end: max.x + max.z, min, max, index }
    }
}

fn all_le(a: Float3, b: Float3) -> bool {
    a.x <= b.x && a.y <= b.y && a.z <= b.z
}

/// The pairs of links (by index) of the same two graphs whose boxes overlap. Sorts `boxes` by (pair, start); ties
/// keep their input order, which can't show: spans take the lowest index of a group, joins are unordered.
fn touching(boxes: &mut [Boxed]) -> Vec<(usize, usize)> {
    let mut out = Vec::with_capacity(boxes.len());
    boxes.sort_by(|a, b| a.pair.cmp(&b.pair).then(a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal)));
    for i in 0..boxes.len() {
        let a = boxes[i];
        // Sorted by start: a box that overlaps a has start <= a.end (min <= a's max on x and on z), so the sweep
        // stops at the first that doesn't.
        for b in &boxes[i + 1..] {
            if b.pair != a.pair || b.start > a.end {
                break;
            }
            if all_le(b.min, a.max) && all_le(a.min, b.max) {
                out.push((a.index, b.index));
            }
        }
    }
    out
}

fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]]; // halve the path
        i = parent[i];
    }
    i
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let a = root(parent, a);
    let b = root(parent, b);
    if a != b {
        parent[a.max(b)] = a.min(b);
    }
}

fn meets(end: Float3, other_a0: Float3, other_a1: Float3) -> bool {
    end.distance_sq(other_a0) <= TOUCH * TOUCH || end.distance_sq(other_a1) <= TOUCH * TOUCH
}

/// Numbers the links' spans (`NavGraphLink.Span`): links between the same two graphs whose portals touch get one
/// number, the index of one of them; and marks the portal ends that meet another's (`Joined`). Each group is
/// swept in order along the seam, so a seam of n links costs about n log n, not n squared (`FillSpans`).
pub fn fill_spans_portals<L: PortalLink>(links: &mut [L]) {
    let mut boxes: Vec<Boxed> = Vec::with_capacity(links.len());
    for (i, link) in links.iter_mut().enumerate() {
        link.set_joined(0);
        let (a0, a1) = (link.a0(), link.a1());
        boxes.push(Boxed::of(pair_key(link.from_graph(), link.to_graph()), a0.min_v(a1), a0.max_v(a1), i));
    }
    let mut parent: Vec<usize> = (0..links.len()).collect();
    for (i, j) in touching(&mut boxes) {
        union(&mut parent, i, j);
        let (i0, i1, j0, j1) = (links[i].a0(), links[i].a1(), links[j].a0(), links[j].a1());
        let mut ji = links[i].joined();
        let mut jj = links[j].joined();
        if meets(i0, j0, j1) {
            ji |= 1;
        }
        if meets(i1, j0, j1) {
            ji |= 2;
        }
        if meets(j0, i0, i1) {
            jj |= 1;
        }
        if meets(j1, i0, i1) {
            jj |= 2;
        }
        links[i].set_joined(ji);
        links[j].set_joined(jj);
    }
    for i in 0..links.len() {
        let r = root(&mut parent, i);
        links[i].set_span(r as i32);
    }
}

/// `FillSpans` for the edge of loaded space (`NavAirFrontier.Span`): rectangles of one volume's face that touch.
pub fn fill_spans_frontier<F: FrontierRect>(frontier: &mut [F]) {
    let mut boxes: Vec<Boxed> = frontier.iter().enumerate().map(|(i, f)| Boxed::of(pair_key(f.volume(), f.face()), f.min(), f.max(), i)).collect();
    let mut parent: Vec<usize> = (0..frontier.len()).collect();
    for (i, j) in touching(&mut boxes) {
        union(&mut parent, i, j);
    }
    for i in 0..frontier.len() {
        let r = root(&mut parent, i);
        frontier[i].set_span(r as i32);
    }
}

/// `FillSpans` for air links (`NavAirLink.Span`): rectangles of the same face that touch.
pub fn fill_spans_faces<L: FaceLink>(links: &mut [L]) {
    let mut boxes: Vec<Boxed> = links.iter().enumerate().map(|(i, l)| Boxed::of(pair_key(l.from_volume(), l.to_volume()), l.min(), l.max(), i)).collect();
    let mut parent: Vec<usize> = (0..links.len()).collect();
    for (i, j) in touching(&mut boxes) {
        union(&mut parent, i, j);
    }
    for i in 0..links.len() {
        let r = root(&mut parent, i);
        links[i].set_span(r as i32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Float3 {
        Float3::new(x, y, z)
    }

    fn portal(from: i32, to: i32, z0: f32, z1: f32) -> CrossingPortal {
        let (a0, a1) = (v(0.0, 0.0, z0), v(0.0, 0.0, z1));
        CrossingPortal { from_graph: from, to_graph: to, a0, a1, b0: a0, b1: a1, ..Default::default() }
    }

    fn face(min: Float3, max: Float3) -> CrossingFace {
        CrossingFace { from_volume: 0, to_volume: 1, min, max, span: 0 }
    }

    #[test]
    fn fill_spans_joins_touching_portals_of_the_same_pair_only() {
        // A seam along x = 0: three portals end to end, a gap, a fourth; and the first again from the other side.
        let mut links = vec![portal(0, 1, 0.0, 2.0), portal(0, 1, 2.0, 4.0), portal(0, 1, 4.0, 5.0), portal(0, 1, 9.0, 12.0), portal(1, 0, 0.0, 2.0)];
        fill_spans_portals(&mut links);
        assert_eq!(links[0].span, links[1].span, "end to end");
        assert_eq!(links[1].span, links[2].span, "end to end");
        assert_ne!(links[2].span, links[3].span, "past a gap");
        assert_ne!(links[0].span, links[4].span, "the other way across");
        // The ends that meet another portal are joined; the span's outer ends aren't.
        assert_eq!(links[0].joined, 2);
        assert_eq!(links[1].joined, 3);
        assert_eq!(links[2].joined, 1);
        assert_eq!(links[3].joined, 0);
        assert_eq!(links[0].span, 0, "the span is the lowest index");
    }

    #[test]
    fn best_portal_crosses_where_the_way_on_is_straight_within_the_routes_span() {
        let mut links: Vec<CrossingPortal> = (0..4).map(|i| portal(0, 1, 2.0 * i as f32, 2.0 * i as f32 + 2.0)).collect(); // z 0..8, one span
        links.push(portal(0, 1, 20.0, 30.0)); // another stretch of the seam, beyond a wall
        fill_spans_portals(&mut links);

        // The route crosses by the first portal; this walker, at z 6 and going on to z 6 past the seam, goes straight.
        let (mut a, mut b) = (links[0].a0, links[0].a1);
        let mut point = Float3::default();
        assert!(best_portal(&links, 0, 1, v(-10.0, 0.0, 6.0), v(10.0, 0.0, 6.0), 0.5, &mut a, &mut b, &mut point));
        assert!((point.z - 6.0).abs() < 1e-3, "straight across, though two portals meet there: {}", point.z);
        assert!(point.x.abs() < 1e-3);
        assert!(a.z <= 6.0 && b.z >= 6.0, "the portal it crosses by");

        // Heading for z 25: the span ends at z 8 (less the radius); the other stretch isn't the route's.
        a = links[0].a0;
        b = links[0].a1;
        assert!(best_portal(&links, 0, 1, v(-10.0, 0.0, 6.0), v(10.0, 0.0, 25.0), 0.5, &mut a, &mut b, &mut point));
        assert!((point.z - 7.5).abs() < 1e-3, "as far along as the span goes: {}", point.z);

        // A portal that isn't a link between those graphs: unchanged.
        a = v(5.0, 0.0, 5.0);
        let before = (a, b, point);
        assert!(!best_portal(&links, 0, 1, Float3::default(), Float3::default(), 0.5, &mut a, &mut b, &mut point));
        assert_eq!(before, (a, b, point));
    }

    #[test]
    fn best_face_crosses_the_rectangle_the_way_on_goes_through() {
        // A face at x = 0, tiled by two touching rectangles (low and high) and one beyond a gap.
        let mut links = vec![face(v(0.0, 0.0, 0.0), v(0.0, 10.0, 10.0)), face(v(0.0, 10.0, 0.0), v(0.0, 20.0, 10.0)), face(v(0.0, 0.0, 30.0), v(0.0, 20.0, 40.0))];
        fill_spans_faces(&mut links);
        assert_eq!(links[0].span, links[1].span);
        assert_ne!(links[0].span, links[2].span);

        let (mut min, mut max) = (links[0].min, links[0].max);
        let mut point = Float3::default();
        assert!(best_face(&links, 0, 1, v(-20.0, 15.0, 5.0), v(20.0, 15.0, 5.0), 1.0, &mut min, &mut max, &mut point));
        assert!((point.y - 15.0).abs() < 1e-3, "straight through, high");
        assert!((point.z - 5.0).abs() < 1e-3);
        assert!(point.x < 0.0, "on the near side of the face");
        assert_eq!(min, links[1].min, "the high rectangle");
    }

    #[test]
    fn best_face_a_crowd_keeps_its_width_through_the_face() {
        // One wide face at x = 0; a crowd 40 m wide, 10 m short of it, all going on to one point 10 m past it.
        let mut links = vec![face(v(0.0, 0.0, -100.0), v(0.0, 50.0, 100.0))];
        fill_spans_faces(&mut links);
        let q = v(10.0, 20.0, 0.0);
        let cross_at = |z: f32| {
            let (mut min, mut max) = (links[0].min, links[0].max);
            let mut point = Float3::default();
            best_face(&links, 0, 1, v(-10.0, 20.0, z), q, 1.0, &mut min, &mut max, &mut point);
            point.z
        };
        let left = cross_at(-20.0);
        let right = cross_at(20.0);
        assert!(right - left > 28.0, "most of the 40 m stays: straight lines to the point would cross 20 m apart: {}", right - left);
        assert!(right - left < 40.0, "each still leans toward where it goes");
        assert!(cross_at(0.0).abs() < 1e-3, "one in line with the point goes straight");
    }

    #[test]
    fn edge_wait_each_waits_where_the_edge_is_nearest_it_within_the_stretch() {
        // The edge of loaded space at z = 64 (volume 0's ZMax face), two touching rectangles, and one beyond a gap.
        let rect = |x0: f32, x1: f32| CrossingFrontier { volume: 0, face: 1, min: v(x0, 0.0, 64.0), max: v(x1, 30.0, 64.0), span: 0 };
        let mut frontier = vec![rect(0.0, 20.0), rect(20.0, 40.0), rect(60.0, 80.0)];
        fill_spans_frontier(&mut frontier);
        let edge = v(5.0, 10.0, 64.0); // the route's one point, nearest its goal

        let a = edge_wait(&frontier, 0, edge, v(30.0, 12.0, 40.0), 2.0);
        assert_eq!(a, v(30.0, 12.0, 64.0), "straight ahead of it, across the join of two rectangles");
        let b = edge_wait(&frontier, 0, edge, v(70.0, 12.0, 40.0), 2.0);
        assert!((b.x - 38.0).abs() < 1e-3, "the stretch's end, short of its radius; not the rectangle past the gap: {}", b.x);
        assert_eq!(edge_wait(&frontier, 1, edge, Float3::default(), 2.0), edge, "no frontier of that volume there");
    }

    #[test]
    fn carry_on_flies_on_toward_the_target_for_a_short_way() {
        let next = carry_on_next(Float3::default(), v(100.0, 0.0, 0.0), 0.5, 1.0, 10.0).expect("flies on");
        assert!((next.x - 10.0 * CARRY_SECONDS).abs() < 1e-3, "half a second of flight: {}", next.x);
        assert!(carry_on_next(v(99.8, 0.0, 0.0), v(100.0, 0.0, 0.0), 0.5, 1.0, 10.0).is_none(), "already within arrival");
        // Slow flyers still go at least twice the arrival distance.
        let near = carry_on_next(Float3::default(), v(100.0, 0.0, 0.0), 0.0, 3.0, 1.0).unwrap();
        assert!((near.x - 6.0).abs() < 1e-4);
    }

    #[test]
    fn aim_and_lookups() {
        let ends = [v(1.0, 0.0, 0.0), v(2.0, 0.0, 0.0), v(3.0, 0.0, 0.0)];
        let goal = v(9.0, 0.0, 0.0);
        assert_eq!(aim(&ends, 0, false, goal), ends[0]);
        assert_eq!(aim(&ends, 2, false, goal), goal);
        assert_eq!(aim(&ends, 2, true, goal), ends[2]);
        let (c1, c2) = (Hash128::new(1, 0, 0, 0), Hash128::new(2, 0, 0, 0));
        assert_eq!(graph_of([(c1, false), (c1, true), (c2, false)], c1, true), Some(1));
        assert_eq!(graph_of([(c1, false)], c1, true), None);
        assert_eq!(volume_of([c1, c2], c2), Some(1));
    }
}
