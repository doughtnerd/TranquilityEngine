//! Stage 2: string pulling across a corridor that folds between surfaces (Foxfire's `NavMeshStraightPath.cs`).
//!
//! Every polygon in a bin is projected onto that bin's (t, b) plane, the same 2D simplification Detour makes for
//! floors. At each fold, the next bin's plane is "unfolded" with a rigid 2D transform that lays its destination
//! portal parallel to the source portal, one gap-width further on. The funnel then runs in this single flat plane,
//! and the resulting straight segments are mapped back to 3D, with extra waypoints wherever a segment crosses a
//! fold.
//!
//! Jumps split the corridor: the funnel runs separately on each stretch between jumps, ending at the take-off point
//! and restarting at the landing point, so every jump is a pair of waypoints (`JUMP_START`, `JUMP_LAND`).
//!
//! Caveat: a corridor that wraps more than about 180 degrees around something (all the way round a pillar via its
//! sides) can overlap itself when unfolded. Results stay valid but may not be the shortest path there.
use crate::pathfinding::NavMeshPathNode;
use crate::surface::{closest_point_on_poly, link_hinge_at, to_plane};
use nav_format::{NavLinkKind, NavMeshData, OrientationBin};
use nav_math::math::{max, saturate};
use nav_math::{Float2, Float3};
use std::ops::{BitAnd, BitOr, BitOrAssign};

/// `NavMeshWaypointFlags`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NavMeshWaypointFlags(pub u8);

impl NavMeshWaypointFlags {
    pub const NONE: Self = Self(0);
    pub const START: Self = Self(1 << 0);
    pub const END: Self = Self(1 << 1);
    /// Funnel apex: the path turns here.
    pub const CORNER: Self = Self(1 << 2);
    /// On the edge of the surface being left, at a fold.
    pub const FOLD_ENTER: Self = Self(1 << 3);
    /// On the edge of the surface being entered, after crossing the fold gap.
    pub const FOLD_EXIT: Self = Self(1 << 4);
    /// Take-off point of a jump; the segment to the next waypoint is a jump arc.
    pub const JUMP_START: Self = Self(1 << 5);
    /// Landing point of a jump.
    pub const JUMP_LAND: Self = Self(1 << 6);
    /// With `FOLD_ENTER`: the fold is an outside corner, crossed via the waypoint's hinge.
    pub const FOLD_OVER_EDGE: Self = Self(1 << 7);

    /// True if every bit of `other` is set.
    #[inline]
    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
    /// True if any bit of `other` is set.
    #[inline]
    pub fn intersects(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }
}
impl BitOr for NavMeshWaypointFlags {
    type Output = Self;
    #[inline]
    fn bitor(self, o: Self) -> Self {
        Self(self.0 | o.0)
    }
}
impl BitOrAssign for NavMeshWaypointFlags {
    #[inline]
    fn bitor_assign(&mut self, o: Self) {
        self.0 |= o.0;
    }
}
impl BitAnd for NavMeshWaypointFlags {
    type Output = Self;
    #[inline]
    fn bitand(self, o: Self) -> Self {
        Self(self.0 & o.0)
    }
}

/// `NavMeshWaypoint`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavMeshWaypoint {
    /// On the walkable surface (snapped to the detail mesh).
    pub position: Float3,
    /// Surface normal at `position`: the agent's "up" from here on.
    pub normal: Float3,
    pub poly: i32,
    pub flags: NavMeshWaypointFlags,
    /// `FOLD_OVER_EDGE`: the corner the segment to the next waypoint pivots around.
    pub hinge: Float3,
}

const KIND_START: u8 = 0;
const KIND_INTERNAL: u8 = 1;
const KIND_FOLD_SOURCE: u8 = 2;
const KIND_FOLD_DEST: u8 = 3;
const KIND_END: u8 = 4;
const KIND_JUMP_SOURCE: u8 = 5;
const KIND_JUMP_DEST: u8 = 6;

const EPS: f32 = 1e-4;

#[derive(Clone, Copy, Debug, Default)]
struct Portal {
    /// Unfolded 2D.
    l: Float2,
    r: Float2,
    /// World space.
    l3: Float3,
    r3: Float3,
    /// Polygon a point on this portal belongs to.
    poly: i32,
    kind: u8,
    /// `KIND_FOLD_SOURCE`: the fold link it crosses (its hinge).
    link: i32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Unfold {
    bin: i32,
    cos: f32,
    sin: f32,
    offset: Float2,
}

impl Unfold {
    fn apply(&self, bin: &OrientationBin, p: Float3) -> Float2 {
        let q = to_plane(bin, p);
        Float2::new(self.cos * q.x - self.sin * q.y, self.sin * q.x + self.cos * q.y) + self.offset
    }
}

/// Straightens a corridor into waypoints (`Straighten`): the funnel over the corridor's portals, unfolded across
/// folds, with extra waypoints at fold crossings and a pair at every jump. `waypoints` is cleared first.
pub fn straighten(
    nav: &NavMeshData,
    corridor: &[NavMeshPathNode],
    start_pos: Float3,
    goal_pos: Float3,
    waypoints: &mut Vec<NavMeshWaypoint>,
) {
    waypoints.clear();
    if corridor.is_empty() {
        return;
    }

    let first_poly = corridor[0].poly;
    let last_poly = corridor[corridor.len() - 1].poly;

    // Clamp the ends onto their polygons (a partial corridor won't contain the goal).
    let start_pos = closest_point_on_poly(nav, first_poly, start_pos).0;
    let goal_pos = closest_point_on_poly(nav, last_poly, goal_pos).0;

    let mut portals: Vec<Portal> = Vec::with_capacity(corridor.len() * 2 + 2);
    build_portals(nav, corridor, start_pos, goal_pos, &mut portals);

    // Funnel over the unfolded portals, one stretch per jump-free part of the corridor. Each apex is recorded as
    // (portal index, side): side 0 = left, 1 = right.
    let mut apexes: Vec<(usize, u8)> = Vec::with_capacity(16);
    let mut range_start = 0;
    for i in 0..portals.len() {
        if portals[i].kind == KIND_JUMP_SOURCE || i == portals.len() - 1 {
            run_funnel(&portals, range_start, i, &mut apexes);
            range_start = i + 1; // the jump's landing portal starts the next stretch
        }
    }

    // Map back to 3D, inserting fold crossings between consecutive apexes.
    for k in 0..apexes.len() {
        let apex = apexes[k];
        let ap = portals[apex.0];
        let p3 = if apex.1 == 0 { ap.l3 } else { ap.r3 };

        let mut flags = if ap.kind == KIND_START {
            NavMeshWaypointFlags::START
        } else if ap.kind == KIND_END {
            NavMeshWaypointFlags::END
        } else {
            NavMeshWaypointFlags::CORNER
        };

        // A corner that sits on a fold edge is also that fold's entry or exit point; without this flag the mover
        // can't tell the next (or previous) segment crosses a fold.
        let mut hinge = Float3::splat(0.0);
        if ap.kind == KIND_FOLD_SOURCE {
            let (f, h) = fold_entry(nav, &ap, p3);
            flags |= f;
            hinge = h;
        } else if ap.kind == KIND_FOLD_DEST {
            flags |= NavMeshWaypointFlags::FOLD_EXIT;
        } else if ap.kind == KIND_JUMP_SOURCE {
            flags = NavMeshWaypointFlags::JUMP_START;
        } else if ap.kind == KIND_JUMP_DEST {
            flags = NavMeshWaypointFlags::JUMP_LAND;
        }

        add_waypoint(nav, waypoints, p3, ap.poly, flags, hinge);

        if k + 1 >= apexes.len() {
            break;
        }

        let next = apexes[k + 1];
        let a2 = if apex.1 == 0 { ap.l } else { ap.r };
        let np = portals[next.0];
        let b2 = if next.1 == 0 { np.l } else { np.r };

        for i in apex.0 + 1..next.0 {
            let pt = portals[i];
            if pt.kind != KIND_FOLD_SOURCE && pt.kind != KIND_FOLD_DEST {
                continue;
            }

            let u = segment_portal_param(a2, b2, pt.l, pt.r);
            let c3 = pt.l3.lerp(pt.r3, u);
            let mut crossing_hinge = Float3::splat(0.0);
            let flags = if pt.kind == KIND_FOLD_SOURCE {
                let (f, h) = fold_entry(nav, &pt, c3);
                crossing_hinge = h;
                f
            } else {
                NavMeshWaypointFlags::FOLD_EXIT
            };
            add_waypoint(nav, waypoints, c3, pt.poly, flags, crossing_hinge);
        }
    }
}

// ---------------------------------------------------------------- portal unfolding

fn build_portals(
    nav: &NavMeshData,
    corridor: &[NavMeshPathNode],
    start_pos: Float3,
    goal_pos: Float3,
    portals: &mut Vec<Portal>,
) {
    let poly0 = corridor[0].poly;
    let mut frame = Unfold { bin: nav.polys[poly0 as usize].bin, cos: 1.0, sin: 0.0, offset: Float2::splat(0.0) };
    let mut bin = nav.bins[frame.bin as usize];

    let s2 = frame.apply(&bin, start_pos);
    portals.push(Portal { l: s2, r: s2, l3: start_pos, r3: start_pos, poly: poly0, kind: KIND_START, link: 0 });

    let mut prev_center = frame.apply(&bin, nav.polys[poly0 as usize].center);

    for i in 1..corridor.len() {
        let prev_poly = corridor[i - 1].poly;
        let poly = corridor[i].poly;
        let link = &nav.links[corridor[i].link as usize];

        let a2 = frame.apply(&bin, link.portal_a);
        let b2 = frame.apply(&bin, link.portal_b);
        let fwd = forward(a2, b2, prev_center);

        if link.kind == NavLinkKind::INTERNAL {
            portals.push(make_portal(a2, b2, link.portal_a, link.portal_b, fwd, poly, KIND_INTERNAL));
        } else if link.kind == NavLinkKind::JUMP {
            // Take-off point ends this funnel stretch; the landing point starts a new one in a fresh frame, so
            // nothing needs to line up across the jump.
            portals.push(Portal {
                l: a2,
                r: a2,
                l3: link.portal_a,
                r3: link.portal_a,
                poly: prev_poly,
                kind: KIND_JUMP_SOURCE,
                link: 0,
            });

            let new_bin = nav.polys[poly as usize].bin;
            frame = Unfold { bin: new_bin, cos: 1.0, sin: 0.0, offset: Float2::splat(0.0) };
            bin = nav.bins[new_bin as usize];

            let land2 = frame.apply(&bin, link.dest_a);
            portals.push(Portal {
                l: land2,
                r: land2,
                l3: link.dest_a,
                r3: link.dest_a,
                poly,
                kind: KIND_JUMP_DEST,
                link: 0,
            });
        } else {
            // Source edge, still in the current surface's frame.
            let mut source = make_portal(a2, b2, link.portal_a, link.portal_b, fwd, prev_poly, KIND_FOLD_SOURCE);
            source.link = corridor[i].link;
            portals.push(source);

            // Unfold the next surface: lay its edge parallel to the source edge, one gap-width further on.
            let gap = 0.5 * (link.portal_a.distance(link.dest_a) + link.portal_b.distance(link.dest_b));
            let target_a = a2 + fwd * gap;
            let target_b = b2 + fwd * gap;

            let new_bin = nav.polys[poly as usize].bin;
            let nb = nav.bins[new_bin as usize];
            let raw_a = Float2::new(link.dest_a.dot(nb.t), link.dest_a.dot(nb.b));
            let raw_b = Float2::new(link.dest_b.dot(nb.t), link.dest_b.dot(nb.b));

            let from = raw_b - raw_a;
            let to = target_b - target_a;
            let ang = cross(from, to).atan2(from.dot(to));
            frame = Unfold { bin: new_bin, cos: ang.cos(), sin: ang.sin(), offset: Float2::splat(0.0) };
            let raw_mid = (raw_a + raw_b) * 0.5;
            let rotated_mid = Float2::new(
                frame.cos * raw_mid.x - frame.sin * raw_mid.y,
                frame.sin * raw_mid.x + frame.cos * raw_mid.y,
            );
            frame.offset = (target_a + target_b) * 0.5 - rotated_mid;
            bin = nb;

            // Destination edge, in the new surface's (unfolded) frame.
            let da2 = frame.apply(&bin, link.dest_a);
            let db2 = frame.apply(&bin, link.dest_b);
            portals.push(make_portal(da2, db2, link.dest_a, link.dest_b, fwd, poly, KIND_FOLD_DEST));
        }

        prev_center = frame.apply(&bin, nav.polys[poly as usize].center);
    }

    let last_poly = corridor[corridor.len() - 1].poly;
    let g2 = frame.apply(&bin, goal_pos);
    portals.push(Portal { l: g2, r: g2, l3: goal_pos, r3: goal_pos, poly: last_poly, kind: KIND_END, link: 0 });
}

/// Unit normal of the portal pointing away from the polygon we are coming from.
fn forward(a: Float2, b: Float2, from_center: Float2) -> Float2 {
    let e = b - a;
    let mut n = Float2::new(-e.y, e.x).normalize_safe(Float2::splat(0.0));
    if n.dot((a + b) * 0.5 - from_center) < 0.0 {
        n = -n;
    }
    n
}

/// Left endpoint = the one on the left of the travel direction (positive cross product).
fn make_portal(a2: Float2, b2: Float2, a3: Float3, b3: Float3, fwd: Float2, poly: i32, kind: u8) -> Portal {
    let mid = (a2 + b2) * 0.5;
    let a_is_left = cross(fwd, a2 - mid) > 0.0;
    if a_is_left {
        Portal { l: a2, r: b2, l3: a3, r3: b3, poly, kind, link: 0 }
    } else {
        Portal { l: b2, r: a2, l3: b3, r3: a3, poly, kind, link: 0 }
    }
}

// ---------------------------------------------------------------- funnel (Mononen's SSFA)

/// Funnel over `portals[first..=last]`; `portals[first]` and `portals[last]` must be points.
fn run_funnel(portals: &[Portal], first: usize, last: usize, apexes: &mut Vec<(usize, u8)>) {
    let mut apex = portals[first].l;
    let mut left = portals[first].l;
    let mut right = portals[first].r;
    let (mut left_index, mut right_index) = (first, first);
    let (mut left_side, mut right_side) = (0u8, 1u8);

    add_apex(apexes, first, 0);

    let mut i = first + 1;
    while i <= last {
        let l = portals[i].l;
        let r = portals[i].r;

        // Tighten the right side.
        if tri_area2(apex, right, r) <= 0.0 {
            if v_equal(apex, right) || tri_area2(apex, left, r) > 0.0 {
                right = r;
                right_index = i;
                right_side = 1;
            } else {
                // Right crossed over left: left becomes the new apex.
                apex = left;
                let (apex_index, apex_side) = (left_index, left_side);
                add_apex(apexes, apex_index, apex_side);

                left = apex;
                right = apex;
                left_index = apex_index;
                right_index = apex_index;
                left_side = apex_side;
                right_side = apex_side;
                i = apex_index + 1;
                continue;
            }
        }

        // Tighten the left side.
        if tri_area2(apex, left, l) >= 0.0 {
            if v_equal(apex, left) || tri_area2(apex, right, l) < 0.0 {
                left = l;
                left_index = i;
                left_side = 0;
            } else {
                // Left crossed over right: right becomes the new apex.
                apex = right;
                let (apex_index, apex_side) = (right_index, right_side);
                add_apex(apexes, apex_index, apex_side);

                left = apex;
                right = apex;
                left_index = apex_index;
                right_index = apex_index;
                left_side = apex_side;
                right_side = apex_side;
                i = apex_index + 1;
                continue;
            }
        }
        i += 1;
    }

    add_apex(apexes, last, 0);
}

fn add_apex(apexes: &mut Vec<(usize, u8)>, portal_index: usize, side: u8) {
    if let Some(&last) = apexes.last() {
        if last.0 == portal_index && last.1 == side {
            return;
        }
    }
    apexes.push((portal_index, side));
}

// ---------------------------------------------------------------- helpers

/// Flags for a fold's entry point `p`, and the hinge to cross it by if it's an outside corner.
fn fold_entry(nav: &NavMeshData, portal: &Portal, p: Float3) -> (NavMeshWaypointFlags, Float3) {
    let link = &nav.links[portal.link as usize];
    if link.convex == 0 {
        return (NavMeshWaypointFlags::FOLD_ENTER, Float3::splat(0.0));
    }
    (NavMeshWaypointFlags::FOLD_ENTER | NavMeshWaypointFlags::FOLD_OVER_EDGE, link_hinge_at(link, p))
}

fn add_waypoint(
    nav: &NavMeshData,
    waypoints: &mut Vec<NavMeshWaypoint>,
    p: Float3,
    poly: i32,
    flags: NavMeshWaypointFlags,
    hinge: Float3,
) {
    let (snapped, normal) = closest_point_on_poly(nav, poly, p);

    if let Some(last) = waypoints.last_mut() {
        if last.position.distance_sq(snapped) < EPS * EPS {
            last.flags |= flags; // merge coincident points (e.g. a corner exactly on a fold edge)
            if flags.contains(NavMeshWaypointFlags::FOLD_OVER_EDGE) {
                last.hinge = hinge;
            }
            return;
        }
    }

    waypoints.push(NavMeshWaypoint { position: snapped, normal, poly, flags, hinge });
}

/// Where segment a->b crosses the line through portal (l, r), as a 0..1 parameter along the portal.
fn segment_portal_param(a: Float2, b: Float2, l: Float2, r: Float2) -> f32 {
    let d = b - a;
    let e = r - l;
    let denom = cross(d, e);
    if nav_math::math::abs(denom) < 1e-8 {
        // Parallel: use the projection of the segment midpoint.
        return saturate((((a + b) * 0.5) - l).dot(e) / max(e.length_sq(), 1e-8));
    }
    saturate(cross(l - a, d) / denom)
}

#[inline]
fn cross(a: Float2, b: Float2) -> f32 {
    a.x * b.y - a.y * b.x
}

/// Same as Detour's dtTriArea2D, in the unfolded plane.
#[inline]
fn tri_area2(a: Float2, b: Float2, c: Float2) -> f32 {
    (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y)
}

#[inline]
fn v_equal(a: Float2, b: Float2) -> bool {
    a.distance_sq(b) < EPS * EPS
}
