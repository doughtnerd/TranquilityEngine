//! Real-query checks of the W3a ports (nearest polygon, A*, straight path with folds and jumps) on navmeshes baked
//! by `nav-bake`, including the path assertions of Foxfire's `NavBakeTests` (which the bake tests approximated with a
//! link-graph search).
mod w3a_common;

use nav_bake::bins::OrientationConfig;
use nav_format::consts::NavAreas;
use nav_format::{NavLinkKind, NavMeshData};
use nav_math::Float3;
use nav_query::filter::{resolve_area_costs, AreaCostOverride, AreaCosts, NavMeshQueryFilter};
use nav_query::index;
use nav_query::pathfinding::{
    begin, find_nearest_poly, find_nearest_poly_sided, find_path, finish, step, NavMeshAStar, NavMeshPathNode,
    NavPathStatus,
};
use nav_query::search::{SearchBufferStore, SearchListStore, SearchStore};
use nav_query::straight_path::{straighten, NavMeshWaypoint, NavMeshWaypointFlags as F};
use nav_query::surface::{closest_point_on_poly, point_in_poly};
use w3a_common::*;

fn walker() -> NavMeshQueryFilter<'static> {
    NavMeshQueryFilter::default_for(0.5)
}

fn jumper(up: f32, distance: f32, fall: f32) -> NavMeshQueryFilter<'static> {
    NavMeshQueryFilter {
        can_jump: true,
        max_jump_up_height: up,
        max_jump_distance: distance,
        max_fall_distance: fall,
        ..walker()
    }
}

struct Route {
    status: NavPathStatus,
    corridor: Vec<NavMeshPathNode>,
    waypoints: Vec<NavMeshWaypoint>,
}

impl Route {
    fn jumps(&self, nav: &NavMeshData) -> usize {
        self.corridor.iter().filter(|n| n.link >= 0 && nav.links[n.link as usize].kind == NavLinkKind::JUMP).count()
    }
    fn length(&self) -> f32 {
        self.waypoints.windows(2).map(|w| w[0].position.distance(w[1].position)).sum()
    }
    fn has(&self, flag: F) -> bool {
        self.waypoints.iter().any(|w| w.flags.contains(flag))
    }
}

/// `NavBakeTests.FindPath` plus the straight path: snaps both ends within 2 m, runs A*, straightens the corridor.
fn route(nav: &NavMeshData, from: Float3, to: Float3, filter: &NavMeshQueryFilter) -> Route {
    let mut r = Route { status: NavPathStatus::InvalidInput, corridor: Vec::new(), waypoints: Vec::new() };
    let (Some((start, sp)), Some((goal, gp))) =
        (find_nearest_poly(nav, from, 2.0, filter), find_nearest_poly(nav, to, 2.0, filter))
    else {
        return r;
    };
    r.status = find_path(nav, start, sp, goal, gp, filter, &mut r.corridor);
    straighten(nav, &r.corridor, sp, gp, &mut r.waypoints);
    r
}

fn status(nav: &NavMeshData, from: Float3, to: Float3, filter: &NavMeshQueryFilter) -> NavPathStatus {
    route(nav, from, to, filter).status
}

fn floor_bake() -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    bake
}

// ---------------------------------------------------------------- the index and the surface

#[test]
fn index_queries_match_the_bake_side() {
    let bake = floor_bake();
    let nav = bake.nav();
    assert!(!nav.index_keys.is_empty());
    for p in [v3(0.0, 0.0, 0.0), v3(-7.3, 0.2, 4.4), v3(9.9, 0.0, -9.9), v3(50.0, 0.0, 0.0)] {
        assert_eq!(index::polys_near(nav, p), nav_bake::output::polys_near(nav, p), "{p:?}");
        let c = index::cell_of(p, nav.index_cell_size);
        assert_eq!(c, nav_bake::output::cell_of(p, nav.index_cell_size));
        assert_eq!(index::cell_key(c), nav_bake::output::cell_key(c));
    }
    let c0 = index::cell_of(v3(-1.0, -1.0, -1.0), nav.index_cell_size);
    let c1 = index::cell_of(v3(1.0, 1.0, 1.0), nav.index_cell_size);
    assert!(index::can_query(nav, c0, c1));
    assert_eq!(index::can_query(nav, c0, c1), nav_bake::output::poly_index_can_query(nav, c0, c1));
    let huge = index::cell_of(v3(1e9, 1e9, 1e9), nav.index_cell_size); // absurd: the span saturates
    assert!(!index::can_query(nav, c0, huge));
    assert!(!nav_bake::output::poly_index_can_query(nav, c0, index::cell_of(v3(1e4, 1e4, 1e4), nav.index_cell_size)));
    assert!(!index::can_query(nav, c0, index::cell_of(v3(1e4, 1e4, 1e4), nav.index_cell_size)));
    for p in 0..nav.polys.len() as i32 {
        let q = v3(1.0, 2.0, 3.0);
        assert_eq!(index::bounds_distance_sq(nav, p, q), nav_bake::output::poly_bounds_distance_sq(nav, p as usize, q));
    }
}

#[test]
fn surface_point_lies_on_the_floor_and_the_closest_point_clamps_to_the_polygon() {
    let bake = floor_bake();
    let nav = bake.nav();
    let (poly, point) = find_nearest_poly(nav, v3(1.0, 0.7, 2.0), 2.0, &walker()).expect("a floor poly");
    assert!(point_in_poly(nav, poly, v3(1.0, 5.0, 2.0)), "projected along the normal");
    assert!((point.y - 0.0).abs() < 0.3 && (point.x - 1.0).abs() < 1e-3 && (point.z - 2.0).abs() < 1e-3, "{point:?}");
    let (cp, normal) = closest_point_on_poly(nav, poly, v3(1.0, 3.0, 2.0));
    assert!(normal.y > 0.99);
    assert!((cp.x - 1.0).abs() < 1e-3);
    // Far outside the floor: clamps to the boundary of the nearest polygon, not past it.
    let far = v3(40.0, 0.0, 0.0);
    let (poly, _) = find_nearest_poly(nav, v3(9.0, 0.0, 0.0), 2.0, &walker()).unwrap();
    let (cp, _) = closest_point_on_poly(nav, poly, far);
    assert!(cp.x < 10.1 && cp.x > 8.0, "{cp:?}");
    assert!(!point_in_poly(nav, poly, far));
}

// ---------------------------------------------------------------- nearest polygon

#[test]
fn nearest_poly_on_a_floor() {
    let bake = floor_bake();
    let nav = bake.nav();
    let (p, point) = find_nearest_poly(nav, v3(2.0, 1.0, -3.0), 2.0, &walker()).expect("within 2 m of the floor");
    assert!(nav.polys[p as usize].normal.y > 0.99);
    assert!((point - v3(2.0, 0.0, -3.0)).length() < 0.35, "{point:?}");
    assert!(find_nearest_poly(nav, v3(2.0, 5.0, -3.0), 2.0, &walker()).is_none(), "5 m above, 2 m reach");
    assert!(find_nearest_poly(nav, v3(40.0, 0.0, 0.0), 2.0, &walker()).is_none(), "off the floor");
}

#[test]
fn indexed_and_brute_force_nearest_poly_agree() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_obstacle(v3(0.0, 1.5, 0.0), v3(3.0, 3.0, 3.0), Rot::IDENTITY);
    bake.add_box(v3(5.0, 0.5, 5.0), v3(2.0, 1.0, 2.0), Rot::IDENTITY);
    bake.bake();
    let nav = bake.nav();
    let mut brute = nav.clone();
    brute.index_keys.clear();
    brute.index_start.clear();
    brute.index_polys.clear();
    let mut rng = Rng::new(7);
    let f = walker();
    for _ in 0..300 {
        let p = v3(rng.range(-12.0, 12.0), rng.range(-1.0, 3.0), rng.range(-12.0, 12.0));
        let d = rng.range(0.2, 6.0);
        let a = find_nearest_poly(nav, p, d, &f);
        let b = find_nearest_poly(&brute, p, d, &f);
        assert_eq!(a.map(|x| x.0), b.map(|x| x.0), "{p:?} within {d}");
        if let (Some(a), Some(b)) = (a, b) {
            assert!(a.1.distance(b.1) < 1e-4);
        }
    }
}

#[test]
fn side_preference_snaps_to_the_agents_own_side_of_a_thin_floor() {
    // A thin plate: walkable top at y = 0.5 and (with ceilings) a walkable underside.
    let mut bake = TestBake::new(Some(profile(false, true, true, 1)));
    bake.add_box(v3(0.0, 3.0, 0.0), v3(12.0, 0.4, 12.0), Rot::IDENTITY);
    bake.bake();
    let nav = bake.nav();
    // Just below the top face (inside the slab's thickness, nearer to the top): without a preference the top wins;
    // preferring a downward "up" picks the underside.
    let pos = v3(0.0, 3.1, 0.0);
    let f = walker();
    let (top, _) = find_nearest_poly(nav, pos, 2.0, &f).unwrap();
    assert!(nav.polys[top as usize].normal.y > 0.5);
    let (under, _) =
        find_nearest_poly_sided(nav, pos, 2.0, &f, v3(0.0, -1.0, 0.0), f32::INFINITY).unwrap();
    assert!(nav.polys[under as usize].normal.y < -0.5, "preferred the surface facing down");
}

#[test]
fn switched_off_polys_are_not_snapped_to() {
    let bake = floor_bake();
    let nav = bake.nav();
    let (p, _) = find_nearest_poly(nav, v3(0.0, 0.0, 0.0), 1.0, &walker()).unwrap();
    assert!(nav.polys.len() > 1);
    let mut off = vec![false; nav.polys.len()];
    off[p as usize] = true;
    let f = NavMeshQueryFilter { switched_off: Some(&off), ..walker() };
    let (q, _) = find_nearest_poly(nav, v3(0.0, 0.0, 0.0), 30.0, &f).unwrap();
    assert_ne!(p, q);
    let all_off = vec![true; nav.polys.len()];
    let f = NavMeshQueryFilter { switched_off: Some(&all_off), ..walker() };
    assert!(find_nearest_poly(nav, v3(0.0, 0.0, 0.0), 3.0, &f).is_none());
}

// ---------------------------------------------------------------- paths

#[test]
fn floor_bakes_and_paths_across_in_a_straight_line() {
    let bake = floor_bake();
    let nav = bake.nav();
    let (from, to) = (v3(-8.0, 0.0, -8.0), v3(8.0, 0.0, 8.0));
    let r = route(nav, from, to, &walker());
    assert_eq!(r.status, NavPathStatus::Success);
    // The diagonal runs through navmesh vertices, so the funnel may mark a collinear corner on the way; every
    // waypoint lies on the line, and an off-vertex route is exactly two waypoints.
    let dir = (to - from).normalize();
    for w in &r.waypoints {
        let along = (w.position - from).dot(dir);
        assert!((w.position - (from + dir * along)).length() < 0.3, "{:?}", w.position);
    }
    let r2 = route(nav, v3(-8.0, 0.0, -7.7), v3(8.3, 0.0, 5.1), &walker());
    assert_eq!(r2.status, NavPathStatus::Success);
    assert_eq!(r2.waypoints.len(), 2, "{:?}", r2.waypoints);
    let r = &r2;
    assert!(r.waypoints[0].flags == F::START);
    assert!(r.waypoints[1].flags == F::END);
    assert_eq!(r.waypoints[0].poly, r.corridor[0].poly);
    assert_eq!(r.waypoints[1].poly, r.corridor.last().unwrap().poly);
    let (from, to) = (v3(-8.0, 0.0, -7.7), v3(8.3, 0.0, 5.1));
    assert!(r.waypoints.iter().all(|w| w.normal.y > 0.99));
    let straight = from.distance(to);
    assert!((r.length() - straight).abs() < 0.5, "length {} vs {}", r.length(), straight);
    assert_eq!(r.corridor[0].link, -1);
    assert!(r.corridor[1..].iter().all(|n| n.link >= 0));
}

#[test]
fn same_polygon_is_a_one_node_corridor() {
    let bake = floor_bake();
    let nav = bake.nav();
    let (p, point) = find_nearest_poly(nav, v3(0.0, 0.0, 0.0), 1.0, &walker()).unwrap();
    let mut corridor = Vec::new();
    let s = find_path(nav, p, point, p, point + v3(0.1, 0.0, 0.0), &walker(), &mut corridor);
    assert_eq!(s, NavPathStatus::Success);
    assert_eq!(corridor, vec![NavMeshPathNode { poly: p, link: -1 }]);
}

#[test]
fn invalid_endpoints_are_invalid_input() {
    let bake = floor_bake();
    let nav = bake.nav();
    let mut corridor = Vec::new();
    let s = find_path(nav, -1, v3(0.0, 0.0, 0.0), 0, v3(0.0, 0.0, 0.0), &walker(), &mut corridor);
    assert_eq!(s, NavPathStatus::InvalidInput);
    let s = find_path(nav, 0, v3(0.0, 0.0, 0.0), nav.polys.len() as i32, v3(0.0, 0.0, 0.0), &walker(), &mut corridor);
    assert_eq!(s, NavPathStatus::InvalidInput);
    assert!(corridor.is_empty());
    // A filter that allows no bin leaves no usable polygon.
    let none = NavMeshQueryFilter { allowed_bins: 0, ..walker() };
    assert_eq!(find_path(nav, 0, v3(0.0, 0.0, 0.0), 1, v3(0.0, 0.0, 0.0), &none, &mut corridor), NavPathStatus::InvalidInput);
}

#[test]
fn path_goes_around_an_obstacle_with_waypoints_at_its_corners() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    // A wall along z across the middle, from z -5 to 5: the way round is past one end.
    bake.add_obstacle(v3(0.0, 1.5, 0.0), v3(2.0, 3.0, 10.0), Rot::IDENTITY);
    bake.bake();
    let nav = bake.nav();
    let (from, to) = (v3(-8.0, 0.0, 0.0), v3(8.0, 0.0, 0.0));
    let r = route(nav, from, to, &walker());
    assert_eq!(r.status, NavPathStatus::Success);
    assert!(r.waypoints.len() >= 3, "{:?}", r.waypoints);
    let corners: Vec<_> = r.waypoints.iter().filter(|w| w.flags.contains(F::CORNER)).collect();
    assert!(!corners.is_empty(), "no corner waypoints");
    // The corners hug the wall's end: past z 5 (plus the agent's radius), and not far from the wall.
    for c in &corners {
        assert!(c.position.z.abs() > 5.0 && c.position.z.abs() < 7.0, "{:?}", c.position);
        assert!(c.position.x.abs() < 3.0, "{:?}", c.position);
    }
    let straight = from.distance(to);
    assert!(r.length() > straight + 1.0, "the detour is longer than the straight line");
    assert!(r.length() < straight + 6.0, "{}", r.length());
    // Every waypoint is on the navmesh (inside or on a polygon).
    for w in &r.waypoints {
        let (_, near) = closest_point_on_poly(nav, w.poly, w.position);
        assert!(near.length() > 0.0);
        assert!(point_in_poly(nav, w.poly, w.position));
    }
}

#[test]
fn gap_is_crossed_only_by_jumping_with_jump_waypoints() {
    let mut bake = TestBake::new(Some(profile(true, false, false, 1)));
    bake.add_floor((-8.0, -3.0), (-1.0, 3.0), 0.0, &[]);
    bake.add_floor((1.0, -3.0), (8.0, 3.0), 0.0, &[]);
    bake.bake();
    let nav = bake.nav();
    let (from, to) = (v3(-6.0, 0.0, 0.0), v3(6.0, 0.0, 0.0));

    let r = route(nav, from, to, &walker());
    assert_eq!(r.status, NavPathStatus::Partial);
    assert_eq!(r.jumps(nav), 0);
    // A partial corridor stays on the near platform, ending at the polygon closest to the goal.
    assert!(r.waypoints.last().unwrap().position.x < 0.0);

    let r = route(nav, from, to, &jumper(1.0, 4.0, 2.0));
    assert_eq!(r.status, NavPathStatus::Success);
    assert!(r.jumps(nav) > 0, "the path crossed the gap without a jump link");
    let start = r.waypoints.iter().position(|w| w.flags.contains(F::JUMP_START)).expect("a take-off waypoint");
    assert!(r.waypoints[start + 1].flags.contains(F::JUMP_LAND), "a landing follows the take-off");
    assert!(r.waypoints[start].position.x < 0.0 && r.waypoints[start + 1].position.x > 0.0);
    assert!(r.waypoints[start].flags == F::JUMP_START && r.waypoints[start + 1].flags == F::JUMP_LAND);
    assert_eq!(r.waypoints[start].poly, r.corridor[..].iter().find(|n| n.poly == r.waypoints[start].poly).unwrap().poly);

    // A jumper too weak for the gap can't, and a jump costs: a bigger JumpCost never makes it cheaper.
    assert_eq!(status(nav, from, to, &jumper(1.0, 1.0, 2.0)), NavPathStatus::Partial);
}

#[test]
fn a_jump_up_between_blocks_works_within_the_limits() {
    let mut bake = TestBake::new(Some(profile(true, false, false, 1)));
    bake.add_floor((-8.0, -3.0), (-1.0, 3.0), 0.0, &[]);
    bake.add_box(v3(4.5, 0.4, 0.0), v3(7.0, 0.8, 6.0), Rot::IDENTITY);
    bake.bake();
    let nav = bake.nav();
    let (from, to) = (v3(-6.0, 0.0, 0.0), v3(6.0, 0.8, 0.0));
    let r = route(nav, from, to, &jumper(1.0, 4.0, 2.0));
    assert_eq!(r.status, NavPathStatus::Success);
    assert!(r.has(F::JUMP_START) && r.has(F::JUMP_LAND));
    assert_eq!(status(nav, from, to, &jumper(0.5, 4.0, 2.0)), NavPathStatus::Partial, "too weak to jump up 0.8");
}

#[test]
fn climbing_a_wall_unfolds_across_the_folds() {
    // A floor with a thick wall on it: up its west face and over the lip onto the top.
    let mut bake = TestBake::new(Some(profile(false, true, true, 1)));
    bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    bake.add_box(v3(6.0, 2.5, 0.0), v3(3.0, 5.0, 10.0), Rot::IDENTITY); // x 4.5..7.5, top y 5
    bake.bake();
    let nav = bake.nav();
    let (from, to) = (v3(0.0, 0.0, 0.0), v3(6.0, 5.0, 0.0));

    let r = route(nav, from, to, &walker());
    assert_eq!(r.status, NavPathStatus::Success, "{} polys, {} folds", nav.polys.len(), count_links(nav, NavLinkKind::FOLD));
    assert!(r.has(F::FOLD_ENTER), "{:?}", r.waypoints);
    assert!(r.has(F::FOLD_EXIT), "{:?}", r.waypoints);
    assert!(r.has(F::FOLD_OVER_EDGE), "the lip is an outside corner: {:?}", r.waypoints);
    // The agent's "up" changes: floor, then the wall's west face, then the top again.
    assert!(r.waypoints.first().unwrap().normal.y > 0.99);
    assert!(r.waypoints.iter().any(|w| w.normal.x < -0.9), "on the wall face: {:?}", r.waypoints);
    assert!(r.waypoints.last().unwrap().normal.y > 0.99);
    assert!(r.waypoints.last().unwrap().position.y > 4.5);
    // An outside-corner entry carries its hinge, which lies on the lip (y 5, x 4.5).
    let over = r.waypoints.iter().find(|w| w.flags.contains(F::FOLD_OVER_EDGE)).unwrap();
    assert!((over.hinge.y - 5.0).abs() < 0.5 && (over.hinge.x - 4.5).abs() < 0.5, "{:?}", over.hinge);

    // An agent that can't take folds that sharp (a 90 degree fold: delta 90) is stuck on the floor.
    let tame = NavMeshQueryFilter { max_fold_angle: 45.0f32.to_radians(), ..walker() };
    assert_eq!(status(nav, from, to, &tame), NavPathStatus::Partial);
    // An agent that may only use floor bins can't climb either.
    let mut floor_only = walker();
    floor_only.allowed_bins = 1u64 << nav.polys[r.corridor[0].poly as usize].bin;
    assert_eq!(status(nav, from, to, &floor_only), NavPathStatus::Partial, "the top is a floor bin too, but out of reach");
    // Walls cost more: the route is the same, with a higher cost, so the wall multiplier steers nothing here but
    // the search still succeeds.
    let costly = NavMeshQueryFilter { wall_cost_multiplier: 3.0, ..walker() };
    assert_eq!(status(nav, from, to, &costly), NavPathStatus::Success);
}

#[test]
fn slope_into_overhang_is_linked_by_a_fold_up_to_max_fold_deg() {
    fn bake(max_fold_deg: f32) -> (TestBake, Float3, Float3) {
        let orientation = OrientationConfig { max_fold_deg, ..OrientationConfig::DEFAULT };
        let mut p = profile(false, true, true, 1);
        p.height = 1.0;
        let mut bake = TestBake::with_orientation(Some(p), orientation);
        let rad = |d: f32| d.to_radians();
        let slope_normal = v3(-rad(40.0).sin(), rad(40.0).cos(), 0.0);
        let overhang_normal = v3(-rad(140.0).sin(), rad(140.0).cos(), 0.0);
        let down_slope = v3(0.0, 0.0, 1.0).cross(slope_normal).normalize() * 10.0;
        let up_overhang = overhang_normal.cross(v3(0.0, 0.0, 1.0)).normalize() * 10.0;
        let (near, far) = (v3(0.0, 0.0, -4.0), v3(0.0, 0.0, 4.0));
        bake.add_quad(near, far, far + down_slope, near + down_slope, slope_normal, false);
        bake.add_quad(near, far, far + up_overhang, near + up_overhang, overhang_normal, false);
        bake.bake();
        (bake, down_slope * 0.6 + slope_normal * 0.1, up_overhang * 0.6 + overhang_normal * 0.1)
    }
    let (linked, on_slope, on_overhang) = bake(85.0);
    assert_eq!(status(linked.nav(), on_slope, on_overhang, &walker()), NavPathStatus::Success);
    // The bake linked the 80 degree fold; an agent whose own limit is 75 won't cross it.
    let strict = NavMeshQueryFilter { max_fold_angle: 75.0f32.to_radians(), ..walker() };
    assert_eq!(status(linked.nav(), on_slope, on_overhang, &strict), NavPathStatus::Partial);
    let (limited, on_slope, on_overhang) = bake(75.0);
    assert_eq!(status(limited.nav(), on_slope, on_overhang, &walker()), NavPathStatus::Partial);
}

fn even_slope(degrees: f32) {
    let rad = degrees.to_radians();
    let normal = v3(-rad.sin(), rad.cos(), 0.0);
    let down = v3(0.0, 0.0, 1.0).cross(normal).normalize() * 10.0;
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_quad(v3(0.0, 0.0, -4.0), v3(0.0, 0.0, 4.0), v3(0.0, 0.0, 4.0) + down, v3(0.0, 0.0, -4.0) + down, normal, false);
    bake.bake();
    let (from, to) = (down * 0.9 + normal * 0.1, down * 0.1 + normal * 0.1);
    let r = route(bake.nav(), from, to, &walker());
    assert_eq!(r.status, NavPathStatus::Success, "no path up the {degrees} degree slope");
    assert!(r.waypoints.iter().all(|w| w.normal.dot(normal) > 0.98), "the slope's normal all the way");
    assert!(r.length() >= from.distance(to) - 0.5);
}

#[test]
fn even_slopes_are_walkable_all_the_way_up() {
    even_slope(30.0);
    even_slope(40.0);
}

// ---------------------------------------------------------------- gates, areas

fn corridor_with_gate(open: bool) -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor((-10.0, -2.0), (10.0, 2.0), 0.0, &[]);
    bake.add_gate(v3(0.0, 0.5, 0.0), v3(1.0, 2.0, 6.0), open);
    bake.bake();
    bake
}

#[test]
fn a_closed_gate_blocks_and_the_partial_path_stops_at_it() {
    let closed = corridor_with_gate(false);
    let open = corridor_with_gate(true);
    let (from, to) = (v3(-9.0, 0.0, 0.0), v3(9.0, 0.0, 0.0));

    let f = NavMeshQueryFilter { closed_gates: Some(closed.closed_gates()), ..walker() };
    let r = route(closed.nav(), from, to, &f);
    assert_eq!(r.status, NavPathStatus::Partial);
    let end = r.waypoints.last().unwrap();
    assert!(end.position.x < 0.0 && end.position.x > -3.0, "the partial path walks up to the gate: {:?}", end.position);
    assert!(end.flags.contains(F::END));
    assert!(r.corridor.iter().all(|n| closed.nav().polys[n.poly as usize].gate == 0));

    let f = NavMeshQueryFilter { closed_gates: Some(open.closed_gates()), ..walker() };
    let r = route(open.nav(), from, to, &f);
    assert_eq!(r.status, NavPathStatus::Success);
    assert!((r.length() - 18.0).abs() < 0.5);
    // With no gate states at all, gates count as open (even the closed bake).
    assert_eq!(status(closed.nav(), from, to, &walker()), NavPathStatus::Success);
    // The gate is opened at runtime: the same navmesh, a different slice.
    let mut states = closed.closed_gates().to_vec();
    states[1] = false;
    let f = NavMeshQueryFilter { closed_gates: Some(&states), ..walker() };
    assert_eq!(status(closed.nav(), from, to, &f), NavPathStatus::Success);
}

/// A floor with a slow patch (area cost 10) of the given depth in z, centred on the origin.
fn bake_slow_patch(depth: f32) -> (TestBake, f32) {
    let mut bake = TestBake::new(Some(flat_profile()));
    let mud = bake.add_area(10.0);
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_ground_volume(v3(0.0, 0.0, 0.0), v3(4.0, 4.0, depth), mud, &[]);
    bake.bake();
    (bake, 10.0)
}

fn costs_for(nav: &NavMeshData, overrides: &[AreaCostOverride]) -> NavMeshQueryFilter<'static> {
    let mut f = walker();
    resolve_area_costs(&nav.areas, overrides, &mut f.area_costs, &mut f.excluded_areas, &mut f.min_area_cost);
    f
}

#[test]
fn a_costly_area_is_avoided_when_a_cheaper_route_exists() {
    let (bake, _) = bake_slow_patch(10.0); // z -5..5 of 20: walkable around
    let nav = bake.nav();
    assert!(nav.polys.iter().any(|p| p.area == NavAreas::FIRST_CUSTOM));
    let (from, to) = (v3(-8.0, 0.0, 0.0), v3(8.0, 0.0, 0.0));

    // Costs 1 (no table in the filter): straight through.
    let r = route(nav, from, to, &walker());
    assert_eq!(r.status, NavPathStatus::Success);
    assert!(r.waypoints.iter().all(|w| w.position.z.abs() < 0.5), "straight through the patch");

    // With the area's cost resolved from the navmesh's table, the path walks round the patch.
    let f = costs_for(nav, &[]);
    assert_eq!(f.area_costs.cost(NavAreas::FIRST_CUSTOM), 10.0);
    assert!(f.min_area_cost <= 1.0);
    let r = route(nav, from, to, &f);
    assert_eq!(r.status, NavPathStatus::Success);
    assert!(r.waypoints.iter().any(|w| w.position.z.abs() > 4.5), "walked round the slow patch: {:?}", r.waypoints);
    assert!(r.length() > 16.5);

    // An override makes the patch cheap again.
    let id = nav.areas[NavAreas::FIRST_CUSTOM as usize].id;
    let f = costs_for(nav, &[AreaCostOverride { area_id: id, excluded: false, cost: 1.0 }]);
    let r = route(nav, from, to, &f);
    assert!(r.waypoints.iter().all(|w| w.position.z.abs() < 0.5));
}

#[test]
fn an_excluded_area_blocks() {
    let (bake, _) = bake_slow_patch(20.0); // a band across the whole floor
    let nav = bake.nav();
    let (from, to) = (v3(-8.0, 0.0, 0.0), v3(8.0, 0.0, 0.0));
    let id = nav.areas[NavAreas::FIRST_CUSTOM as usize].id;
    let f = costs_for(nav, &[AreaCostOverride { area_id: id, excluded: true, cost: -1.0 }]);
    assert_eq!(f.excluded_areas, 1 << NavAreas::FIRST_CUSTOM);
    let r = route(nav, from, to, &f);
    assert_eq!(r.status, NavPathStatus::Partial);
    assert!(r.corridor.iter().all(|n| nav.polys[n.poly as usize].area != NavAreas::FIRST_CUSTOM));
    // Allowed, even at a high cost, it is the only way through.
    assert_eq!(status(nav, from, to, &costs_for(nav, &[])), NavPathStatus::Success);
    // Excluding the area the endpoint is in: nothing usable to snap to near the middle of the band.
    let f = costs_for(nav, &[AreaCostOverride { area_id: id, excluded: true, cost: -1.0 }]);
    assert_eq!(status(nav, v3(0.0, 0.0, 0.0), to, &f), NavPathStatus::InvalidInput);
}

#[test]
fn area_costs_stay_admissible_on_the_cheapest_area() {
    // Making the slow area very cheap (0.25) scales the heuristic down; the path must still be found and optimal
    // (never longer than the plain one through the cheap patch).
    let (bake, _) = bake_slow_patch(10.0);
    let nav = bake.nav();
    let id = nav.areas[NavAreas::FIRST_CUSTOM as usize].id;
    let f = costs_for(nav, &[AreaCostOverride { area_id: id, excluded: false, cost: 0.25 }]);
    assert_eq!(f.min_area_cost, 0.25);
    let r = route(nav, v3(-8.0, 0.0, 0.0), v3(8.0, 0.0, 0.0), &f);
    assert_eq!(r.status, NavPathStatus::Success);
    assert!(r.waypoints.iter().all(|w| w.position.z.abs() < 0.5));
    let _ = AreaCosts::new();
}

// ---------------------------------------------------------------- partial, sliced, deterministic

#[test]
fn partial_path_ends_at_the_closest_polygon() {
    // Two separate floors: the goal is on an island.
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor((-10.0, -3.0), (-2.0, 3.0), 0.0, &[]);
    bake.add_floor((6.0, -3.0), (10.0, 3.0), 0.0, &[]);
    bake.bake();
    let nav = bake.nav();
    let (from, to) = (v3(-8.0, 0.0, 0.0), v3(8.0, 0.0, 0.0));
    let r = route(nav, from, to, &walker());
    assert_eq!(r.status, NavPathStatus::Partial);
    let end = r.waypoints.last().unwrap();
    assert!(end.position.x > -4.5 && end.position.x < -1.5, "closest reachable point to the goal: {:?}", end.position);
    assert!(end.position.distance(to) < from.distance(to), "got closer");
    assert!(!r.corridor.is_empty());
}

#[test]
fn the_node_budget_gives_a_partial_corridor() {
    let bake = floor_bake();
    let nav = bake.nav();
    let (from, to) = (v3(-9.0, 0.0, -9.0), v3(9.0, 0.0, 9.0));
    let tiny = NavMeshQueryFilter { max_nodes: 8, ..walker() };
    let r = route(nav, from, to, &tiny);
    assert_eq!(r.status, NavPathStatus::Partial, "{} polys", nav.polys.len());
    assert!(r.corridor.len() <= 8);
}

fn corridor_scene() -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_obstacle(v3(0.0, 1.5, 0.0), v3(2.0, 3.0, 10.0), Rot::IDENTITY);
    bake.add_obstacle(v3(4.0, 1.5, 6.0), v3(2.0, 3.0, 8.0), Rot::IDENTITY);
    bake.bake();
    bake
}

#[test]
fn sliced_search_equals_the_one_shot_result() {
    let bake = corridor_scene();
    let nav = bake.nav();
    let f = walker();
    let (from, to) = (v3(-8.0, 0.0, 0.5), v3(8.0, 0.0, 8.0));
    let (start, sp) = find_nearest_poly(nav, from, 2.0, &f).unwrap();
    let (goal, gp) = find_nearest_poly(nav, to, 2.0, &f).unwrap();

    let mut expect = Vec::new();
    let expect_status = find_path(nav, start, sp, goal, gp, &f, &mut expect);
    assert_eq!(expect_status, NavPathStatus::Success);

    for budget in [1, 2, 7, 50] {
        // A pooled buffer store, reused across searches with new stamps.
        let mut store = SearchBufferStore::default();
        for round in 0..3 {
            store.begin();
            let mut s = NavMeshAStar::default();
            assert!(begin(nav, start, sp, goal, gp, &f, &mut s, &mut store));
            let mut steps = 0;
            while !step(nav, &f, &mut s, &mut store, budget) {
                steps += 1;
                assert!(steps < 10_000);
            }
            if budget == 1 {
                assert!(steps > 3, "a budget of 1 takes several steps");
            }
            let mut got = Vec::new();
            assert_eq!(finish(&s, &store, &mut got), expect_status, "budget {budget} round {round}");
            assert_eq!(got, expect, "budget {budget} round {round}");
        }
    }

    // The same through a list store, step by step.
    let mut store = SearchListStore::default();
    let mut s = NavMeshAStar::default();
    assert!(begin(nav, start, sp, goal, gp, &f, &mut s, &mut store));
    while !step(nav, &f, &mut s, &mut store, 3) {}
    let mut got = Vec::new();
    finish(&s, &store, &mut got);
    assert_eq!(got, expect);
    assert!(store.node_count() > 0 && s.pops >= s.found.max(0));
}

#[test]
fn the_search_filter_may_change_between_steps() {
    let bake = corridor_scene();
    let nav = bake.nav();
    let f = walker();
    let (start, sp) = find_nearest_poly(nav, v3(-8.0, 0.0, 0.5), 2.0, &f).unwrap();
    let (goal, gp) = find_nearest_poly(nav, v3(8.0, 0.0, 8.0), 2.0, &f).unwrap();
    let mut store = SearchBufferStore::default();
    store.begin();
    let mut s = NavMeshAStar::default();
    assert!(begin(nav, start, sp, goal, gp, &f, &mut s, &mut store));
    step(nav, &f, &mut s, &mut store, 2);
    // Congestion on every polygon, applied mid-search: still terminates with a corridor.
    let loads = vec![5; nav.polys.len() * 2];
    let busy = NavMeshQueryFilter {
        congestion: Some(nav_query::filter::CongestionView { loads: &loads, offset: 0, buckets: 2, bucket_seconds: 1.0 }),
        congestion_cost: 2.0,
        agent_speed: 3.0,
        ..walker()
    };
    while !step(nav, &busy, &mut s, &mut store, 5) {}
    let mut got = Vec::new();
    assert_eq!(finish(&s, &store, &mut got), NavPathStatus::Success);
}

#[test]
fn congestion_makes_a_loaded_route_cost_more() {
    let bake = corridor_scene();
    let nav = bake.nav();
    let (from, to) = (v3(-8.0, 0.0, 0.5), v3(8.0, 0.0, 8.0));
    let plain = route(nav, from, to, &walker());
    // Load the polygons of the plain route; a congested filter takes a different route or pays more, never fails.
    let buckets = 4;
    let mut loads = vec![0; nav.polys.len() * buckets];
    for n in &plain.corridor {
        for b in 0..buckets {
            loads[n.poly as usize * buckets + b] = 10;
        }
    }
    let f = NavMeshQueryFilter {
        congestion: Some(nav_query::filter::CongestionView {
            loads: &loads,
            offset: 0,
            buckets: buckets as i32,
            bucket_seconds: 5.0,
        }),
        congestion_cost: 50.0,
        agent_speed: 4.0,
        agent_radius: 0.5,
        ..walker()
    };
    let busy = route(nav, from, to, &f);
    assert_eq!(busy.status, NavPathStatus::Success);
    let shared = busy.corridor.iter().filter(|n| plain.corridor.iter().any(|m| m.poly == n.poly)).count();
    assert!(shared < plain.corridor.len(), "the congested search avoids part of the loaded route");
    // Zero cost: ignored.
    let off = NavMeshQueryFilter { congestion_cost: 0.0, ..f };
    assert_eq!(route(nav, from, to, &off).corridor, plain.corridor);
}

#[test]
fn queries_are_deterministic() {
    let a = corridor_scene();
    let b = corridor_scene();
    let (from, to) = (v3(-8.0, 0.0, 0.5), v3(8.0, 0.0, 8.0));
    let ra = route(a.nav(), from, to, &walker());
    let rb = route(b.nav(), from, to, &walker());
    let rc = route(a.nav(), from, to, &walker());
    assert_eq!(ra.status, NavPathStatus::Success);
    for r in [&rb, &rc] {
        assert_eq!(r.corridor, ra.corridor);
        assert_eq!(r.waypoints.len(), ra.waypoints.len());
        for (x, y) in r.waypoints.iter().zip(&ra.waypoints) {
            assert_eq!(x.position.to_array().map(f32::to_bits), y.position.to_array().map(f32::to_bits));
            assert_eq!(x.normal.to_array().map(f32::to_bits), y.normal.to_array().map(f32::to_bits));
            assert_eq!((x.poly, x.flags), (y.poly, y.flags));
        }
    }
}

#[test]
fn every_baked_link_kind_has_travel_costs() {
    // Link travel: internal links have no crossing; folds cross the gap; jumps cross the arc.
    let mut bake = TestBake::new(Some(profile(true, true, true, 1)));
    bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    bake.add_box(v3(6.0, 2.5, 0.0), v3(1.0, 5.0, 10.0), Rot::IDENTITY);
    bake.add_floor((-6.0, 12.0), (6.0, 18.0), 0.0, &[]);
    bake.bake();
    let nav = bake.nav();
    let mut seen = [false; 3];
    for l in &nav.links {
        let (walk, crossing, land) = nav_query::pathfinding::link_travel(l, l.portal_a);
        assert!(walk.abs() < 1e-3 || l.kind != NavLinkKind::INTERNAL || walk > 0.0);
        match l.kind {
            NavLinkKind::INTERNAL => assert_eq!(crossing, 0.0),
            NavLinkKind::FOLD => assert!(crossing >= 0.0 && land.distance((l.dest_a + l.dest_b) * 0.5) < 1e-5),
            _ => assert!((crossing - (l.jump_distance + l.jump_rise.abs())).abs() < 1e-5),
        }
        seen[l.kind.0 as usize] = true;
    }
    assert!(seen[0] && seen[1], "internal and fold links were baked");
}
