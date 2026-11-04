//! Flight-volume queries (Foxfire's `NavVolumePathfinding` in `Runtime/Lib/NavVolume.cs`): which free
//! octree leaf holds a point, snapping a point to free air, segment clearance (with resolution blocks), and
//! the sliced flight A* over [`SearchStore`] followed by line-of-sight smoothing.
//!
//! The port keeps Foxfire's float operation order and tie-breaks. Differences from the C#:
//! * points go to a `Vec<Float3>`; the perf counters (`NavPerf`) are not ported;
//! * the area-cost table is a fixed `[f32; 64]` plus a count (area ids are 6 bits, [`NavAreas::MAX`]), where
//!   Foxfire uses a `FixedList512Bytes<float>`; an area past the table's length costs 1;
//! * [`FlightPathStatus`] stands in for `NavPathStatus` until the walking A* port defines the shared enum.
use crate::search::{SearchNode, SearchOpen, SearchStore};
use nav_format::{NavVolumeData, NavVolumeLeaf};
use nav_math::math::{clamp, max, min};
use nav_math::{Float3, Int3};

/// The heuristic's scale, a hair under 1 so ties break towards the cheaper path (`HeuristicScale`).
const HEURISTIC_SCALE: f32 = 0.999;

/// How many `SnapToFreeAbove` rises are tried (`GoalRiseSnaps`).
pub const GOAL_RISE_SNAPS: i32 = 10;

/// How many area ids a filter prices (area ids are 6 bits).
pub const MAX_AREAS: usize = 64;

/// The result of a flight path query: the same statuses as a walking one (Success; Partial, ending at the
/// reachable point nearest the goal; InvalidInput, an end farther from free air than the snap distance).
pub use crate::pathfinding::NavPathStatus as FlightPathStatus;

/// How a flyer prices the areas of a flight volume (`NavVolumeQueryFilter`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavVolumeQueryFilter {
    /// By area id; the first `area_cost_count` entries are in use, 0 entries = every area costs 1.
    pub area_costs: [f32; MAX_AREAS],
    pub area_cost_count: usize,
    /// Bit a set => leaves in area a are never entered.
    pub excluded_areas: u64,
    /// Cheapest usable area, for the A* heuristic (ignored while there are no area costs).
    pub min_area_cost: f32,
}

impl Default for NavVolumeQueryFilter {
    /// `default(NavVolumeQueryFilter)`: no costs, nothing excluded.
    fn default() -> Self {
        Self { area_costs: [0.0; MAX_AREAS], area_cost_count: 0, excluded_areas: 0, min_area_cost: 0.0 }
    }
}

impl NavVolumeQueryFilter {
    /// A filter that prices each area as the volume's bake says, never entering the `excluded` areas (what
    /// `NavFlightAgent.ToFilter` gives without overrides, and what Foxfire's flight tests build by hand).
    pub fn for_volume(v: &NavVolumeData, excluded: &[i32]) -> Self {
        let mut f = Self::default();
        for (a, info) in v.areas.iter().take(MAX_AREAS).enumerate() {
            f.area_costs[a] = info.cost;
            f.area_cost_count = a + 1;
        }
        for &a in excluded {
            f.excluded_areas |= 1u64 << (a & 63);
        }
        f.min_area_cost = f32::MAX;
        for a in 0..f.area_cost_count {
            if !f.excluded(a as i32) {
                f.min_area_cost = min(f.min_area_cost, f.area_costs[a]);
            }
        }
        f
    }

    /// The cost multiplier of an area (1 while there are no costs, or past the table).
    #[inline]
    pub fn cost(&self, area: i32) -> f32 {
        if self.area_cost_count == 0 || area < 0 || area as usize >= self.area_cost_count {
            1.0
        } else {
            self.area_costs[area as usize]
        }
    }

    #[inline]
    pub fn excluded(&self, area: i32) -> bool {
        self.excluded_areas & (1u64 << (area & 63)) != 0
    }
}

/// The state of one flight search between steps (`NavFlightAStar`): its snapped ends and leaves, and how far
/// it got. Nodes, open set and key table live in a [`SearchStore`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavFlightAStar {
    /// Snapped to free air.
    pub start: Float3,
    pub goal: Float3,
    pub start_leaf: i32,
    pub goal_leaf: i32,
    pub h_scale: f32,
    pub max_nodes: i32,
    /// The goal's node once reached, -1 before.
    pub found: i32,
    /// The node nearest the goal so far (a partial path ends there).
    pub best_node: i32,
    pub best_h: f32,
    pub finished: bool,
}

// ---------------------------------------------------------------------------------------------------------
// Cells and leaves
// ---------------------------------------------------------------------------------------------------------

#[inline]
fn to_int3(v: Float3) -> Int3 {
    Int3::new(v.x as i32, v.y as i32, v.z as i32)
}

#[inline]
fn int3_to_float(c: Int3) -> Float3 {
    Float3::new(c.x as f32, c.y as f32, c.z as f32)
}

#[inline]
fn base_index(v: &NavVolumeData, b: Int3) -> usize {
    (b.x + v.base_dims.x * (b.y + v.base_dims.y * b.z)) as usize
}

/// The free leaf containing `p`, or -1 (blocked or outside the volume) (`LeafAt`).
pub fn leaf_at(v: &NavVolumeData, p: Float3) -> i32 {
    leaf_at_cell(v, to_int3(((p - v.origin) / v.cell_size).floor()))
}

/// The free leaf containing finest cell `c`, or -1 (blocked or outside the volume) (`LeafAtCell`).
pub fn leaf_at_cell(v: &NavVolumeData, c: Int3) -> i32 {
    if c.x < 0 || c.y < 0 || c.z < 0 || c.x >= v.dims.x || c.y >= v.dims.y || c.z >= v.dims.z {
        return -1;
    }
    let b = c / v.base_scale;
    let entry = v.base_leaf[base_index(v, b)];
    if entry >= -1 {
        return entry;
    }

    let block = v.blocks[(-2 - entry) as usize];
    let n = v.base_scale / block.scale;
    let f = (c - b * v.base_scale) / block.scale;
    v.block_leaf[(block.start + f.x + n * (f.y + n * f.z)) as usize]
}

/// Edge of a base cell, world units (`BaseCellSize`).
pub fn base_cell_size(v: &NavVolumeData) -> f32 {
    v.cell_size * v.base_scale as f32
}

/// Edge of the grid cell at `p`, world units: a refined block's cell inside a resolution region, else a base
/// cell (`CellSizeAt`).
pub fn cell_size_at(v: &NavVolumeData, p: Float3) -> f32 {
    if v.blocks.is_empty() {
        return base_cell_size(v);
    }
    let c = to_int3(((p - v.origin) / v.cell_size).floor());
    if c.x < 0 || c.y < 0 || c.z < 0 || c.x >= v.dims.x || c.y >= v.dims.y || c.z >= v.dims.z {
        return base_cell_size(v);
    }
    let b = c / v.base_scale;
    let entry = v.base_leaf[base_index(v, b)];
    if entry >= -1 {
        base_cell_size(v)
    } else {
        v.blocks[(-2 - entry) as usize].scale as f32 * v.cell_size
    }
}

/// The world centre of a leaf (`LeafCenter`).
pub fn leaf_center(v: &NavVolumeData, leaf: &NavVolumeLeaf) -> Float3 {
    v.origin + (int3_to_float(leaf.min) + Float3::splat(0.5 * leaf.size as f32)) * v.cell_size
}

/// The leaf containing `p`, or the nearest free cell within `max_distance` (searched in growing cube shells of
/// base cells, looking inside refined ones). Returns -1 if none. `snapped` is `p` itself, or the point of the
/// free cell found nearest `p` (just inside it) (`SnapToFree`). Not its centre: a coarse cell's centre can be
/// farther than `max_distance` when its nearest point isn't, as for a flyer just outside its volume's face.
pub fn snap_to_free(v: &NavVolumeData, p: Float3, max_distance: f32) -> (i32, Float3) {
    let mut snapped = p;
    let leaf = leaf_at(v, p);
    if leaf >= 0 {
        return (leaf, snapped);
    }

    let bs = base_cell_size(v);
    let c0 = to_int3(((p - v.origin) / bs).floor());
    let max_r = (max_distance / bs).ceil() as i32;
    let mut best_d2 = max_distance * max_distance;
    let mut best = -1i32;

    // Shell 0 is p's own base cell: it only has something to offer if it's refined (p's cell in it is blocked).
    // Cells of shell r are at least (r - 1) base cells from p: stop once that's past the best found.
    let mut r = 0;
    while r <= max_r && (best < 0 || (r - 1) as f32 * bs < best_d2.sqrt()) {
        for z in (c0.z - r)..=(c0.z + r) {
            for y in (c0.y - r)..=(c0.y + r) {
                for x in (c0.x - r)..=(c0.x + r) {
                    let c = Int3::new(x, y, z);
                    let d = c - c0;
                    let shell = (d.x.abs()).max(d.y.abs()).max(d.z.abs());
                    if shell != r {
                        continue; // shell only
                    }
                    if c.x < 0 || c.y < 0 || c.z < 0 || c.x >= v.base_dims.x || c.y >= v.base_dims.y || c.z >= v.base_dims.z {
                        continue;
                    }
                    let entry = v.base_leaf[base_index(v, c)];
                    if entry == -1 {
                        continue;
                    }

                    let cell_min = v.origin + int3_to_float(c) * bs;
                    if entry >= 0 {
                        consider(cell_min, bs, entry, p, &mut best_d2, &mut best, &mut snapped);
                        continue;
                    }

                    let block = v.blocks[(-2 - entry) as usize];
                    let n = v.base_scale / block.scale;
                    let fs = block.scale as f32 * v.cell_size;
                    for i in 0..n * n * n {
                        let l = v.block_leaf[(block.start + i) as usize];
                        if l < 0 {
                            continue;
                        }
                        let f = Int3::new(i % n, i / n % n, i / (n * n));
                        consider(cell_min + int3_to_float(f) * fs, fs, l, p, &mut best_d2, &mut best, &mut snapped);
                    }
                }
            }
        }
        r += 1;
    }

    (best, snapped)
}

/// `SnapToFree`, or if `p` is farther than `max_distance` from free space, the free space nearest a point above
/// it, up to [`GOAL_RISE_SNAPS`] x `max_distance` up: for a flight goal on or near the ground (a walker's goal,
/// under the free air an agent of this radius has), which flyers get as close to as they can
/// (`SnapToFreeAbove`). One `snap_to_free` per step.
pub fn snap_to_free_above(v: &NavVolumeData, p: Float3, max_distance: f32) -> (i32, Float3) {
    let (mut leaf, mut snapped) = snap_to_free(v, p, max_distance);
    let step = max(max_distance, 0.5);
    let mut i = 1;
    while leaf < 0 && i <= GOAL_RISE_SNAPS {
        let (l, s) = snap_to_free(v, p + Float3::new(0.0, i as f32 * step, 0.0), max_distance);
        leaf = l;
        snapped = s;
        i += 1;
    }
    (leaf, snapped)
}

/// The free cell at `min` (`size` wide), if its point nearest `p` is the nearest yet (`Consider`).
fn consider(min: Float3, size: f32, leaf: i32, p: Float3, best_d2: &mut f32, best: &mut i32, snapped: &mut Float3) {
    let inset = 0.01 * size;
    let nearest = p.clamp(min + Float3::splat(inset), min + Float3::splat(size) - Float3::splat(inset));
    let d2 = nearest.distance_sq(p);
    if d2 >= *best_d2 {
        return;
    }
    *best_d2 = d2;
    *best = leaf;
    *snapped = nearest;
}

// ---------------------------------------------------------------------------------------------------------
// Segment clearance
// ---------------------------------------------------------------------------------------------------------

/// True if a-b stays in free space (see [`all_along`] for how it's checked) (`SegmentClear`).
pub fn segment_clear(v: &NavVolumeData, a: Float3, b: Float3) -> bool {
    all_along(v, a, b, &FreeCheck)
}

/// True if a-b stays in free space the filter allows, in areas costing at most `max_cost`: smoothing may only
/// shortcut through areas no costlier than the path it replaces (`SegmentClear` with a filter).
pub fn segment_clear_filtered(v: &NavVolumeData, filter: &NavVolumeQueryFilter, a: Float3, b: Float3, max_cost: f32) -> bool {
    all_along(v, a, b, &AreaCheck { filter, max_cost })
}

trait LeafCheck {
    fn ok(&self, v: &NavVolumeData, leaf: i32) -> bool;
}

struct FreeCheck;
impl LeafCheck for FreeCheck {
    fn ok(&self, _v: &NavVolumeData, leaf: i32) -> bool {
        leaf >= 0
    }
}

struct AreaCheck<'a> {
    filter: &'a NavVolumeQueryFilter,
    max_cost: f32,
}
impl LeafCheck for AreaCheck<'_> {
    fn ok(&self, v: &NavVolumeData, leaf: i32) -> bool {
        if leaf < 0 {
            return false;
        }
        let area = v.leaves[leaf as usize].area as i32;
        !self.filter.excluded(area) && self.filter.cost(area) <= self.max_cost
    }
}

/// True if `check` passes for every leaf along a-b (-1 for blocked or outside). Without resolution regions: a
/// sample every half cell, as always. With them: every base cell the segment crosses and, inside refined
/// ones, every block cell (a grid walk at each level), so a thin obstacle in fine cells can't fall between
/// samples (`AllAlong`).
fn all_along<T: LeafCheck>(v: &NavVolumeData, a: Float3, b: Float3, check: &T) -> bool {
    if v.blocks.is_empty() {
        let len = a.distance(b);
        let steps = max(1.0, (len / (0.5 * v.cell_size)).ceil()) as i32;
        for i in 0..=steps {
            if !check.ok(v, leaf_at(v, a.lerp(b, i as f32 / steps as f32))) {
                return false;
            }
        }
        return true;
    }

    // The volume is a box, so a segment with both ends inside stays inside.
    if !check.ok(v, leaf_at(v, a)) || !check.ok(v, leaf_at(v, b)) {
        return false;
    }

    let bs = base_cell_size(v);
    let ga = (a - v.origin) / bs;
    let gb = (b - v.origin) / bs;
    let mut walk = GridWalk::new(ga, gb, v.base_dims);
    loop {
        let c = walk.cell;
        let entry = v.base_leaf[base_index(v, c)];
        if entry >= -1 {
            if !check.ok(v, entry) {
                return false;
            }
        } else {
            let block = v.blocks[(-2 - entry) as usize];
            let n = v.base_scale / block.scale;
            let cf = int3_to_float(c);
            let mut inner = GridWalk::new(
                (ga.lerp(gb, walk.t) - cf) * n as f32,
                (ga.lerp(gb, walk.t_exit) - cf) * n as f32,
                Int3::splat(n),
            );
            loop {
                let f = inner.cell;
                if !check.ok(v, v.block_leaf[(block.start + f.x + n * (f.y + n * f.z)) as usize]) {
                    return false;
                }
                if !inner.advance() {
                    break;
                }
            }
        }
        if !walk.advance() {
            break;
        }
    }

    true
}

/// The cells of a grid a segment crosses, in order (Amanatides and Woo). Coordinates are in cells; `t` and
/// `t_exit` are where the segment enters and leaves the current cell, as fractions of its length (`GridWalk`).
struct GridWalk {
    cell: Int3,
    t: f32,
    t_exit: f32,
    end: Int3,
    step: Int3,
    dims: Int3,
    t_max: Float3,
    t_delta: Float3,
}

impl GridWalk {
    fn new(from: Float3, to: Float3, dims: Int3) -> Self {
        let clamp_cell = |p: Float3| {
            let c = to_int3(p.floor());
            Int3::new(
                clamp(c.x, 0, dims.x - 1),
                clamp(c.y, 0, dims.y - 1),
                clamp(c.z, 0, dims.z - 1),
            )
        };
        let cell = clamp_cell(from);
        let end = clamp_cell(to);
        let d = to - from;
        let sign = d.sign();
        let step = to_int3(sign);
        let inf = f32::INFINITY;
        let sel = |zero: bool, v: f32| if zero { inf } else { v };
        let t_delta = Float3::new(
            sel(step.x == 0, (1.0 / d.x).abs()),
            sel(step.y == 0, (1.0 / d.y).abs()),
            sel(step.z == 0, (1.0 / d.z).abs()),
        );
        let boundary = Float3::new(
            (cell.x + step.x.max(0)) as f32,
            (cell.y + step.y.max(0)) as f32,
            (cell.z + step.z.max(0)) as f32,
        );
        let t_max = Float3::new(
            sel(step.x == 0, (boundary.x - from.x) / d.x),
            sel(step.y == 0, (boundary.y - from.y) / d.y),
            sel(step.z == 0, (boundary.z - from.z) / d.z),
        );
        let t_exit = min(t_max.cmin(), 1.0);
        Self { cell, t: 0.0, t_exit, end, step, dims, t_max, t_delta }
    }

    /// Moves to the next cell; false once past the segment's end.
    fn advance(&mut self) -> bool {
        if self.t_exit >= 1.0 || self.cell == self.end {
            return false;
        }
        let axis = if self.t_max.x <= self.t_max.y && self.t_max.x <= self.t_max.z {
            0
        } else if self.t_max.y <= self.t_max.z {
            1
        } else {
            2
        };
        self.cell[axis] += self.step[axis];
        if self.cell[axis] < 0 || self.cell[axis] >= self.dims[axis] {
            return false;
        }
        self.t = self.t_max[axis];
        let delta = self.t_delta[axis];
        self.t_max[axis] += delta;
        self.t_exit = min(self.t_max.cmin(), 1.0);
        true
    }
}

// ---------------------------------------------------------------------------------------------------------
// Flight A*
// ---------------------------------------------------------------------------------------------------------

/// A* over free octree leaves, each step costing its distance times its leaf's area cost (excluded areas are
/// never entered), then line-of-sight smoothing that never cuts through a costlier area than the path it
/// shortens. Writes world-space points from start to goal (or to the reachable point closest to the goal, with
/// status [`FlightPathStatus::Partial`]) (`FindPath`).
pub fn find_path(
    v: &NavVolumeData,
    filter: &NavVolumeQueryFilter,
    start: Float3,
    goal: Float3,
    max_snap_distance: f32,
    max_nodes: i32,
    points: &mut Vec<Float3>,
) -> FlightPathStatus {
    find_path_counted(v, filter, start, goal, max_snap_distance, max_nodes, points).0
}

/// `find_path`, also giving the number of nodes the search created.
pub fn find_path_counted(
    v: &NavVolumeData,
    filter: &NavVolumeQueryFilter,
    start: Float3,
    goal: Float3,
    max_snap_distance: f32,
    max_nodes: i32,
    points: &mut Vec<Float3>,
) -> (FlightPathStatus, usize) {
    points.clear();
    let mut store = crate::search::SearchListStore::default();
    let mut search = NavFlightAStar::default();
    let mut status = FlightPathStatus::InvalidInput;
    let mut expanded = 0;
    if begin(v, filter, start, goal, max_snap_distance, max_nodes, &mut search, &mut store) {
        while !step(v, filter, &mut search, &mut store, i32::MAX) {}
        status = finish(v, filter, &search, &store, points);
        expanded = store.node_count();
    }
    (status, expanded)
}

/// Starts a flight search (`find_path` split so it can run a slice at a time): snaps both ends to free air and
/// offers the start. False (invalid input) if either end is more than `max_snap_distance` from free air
/// (`Begin`). The caller starts a new search on a buffer store with `SearchBufferStore::begin` first.
#[allow(clippy::too_many_arguments)]
pub fn begin<S: SearchStore>(
    v: &NavVolumeData,
    filter: &NavVolumeQueryFilter,
    start: Float3,
    goal: Float3,
    max_snap_distance: f32,
    max_nodes: i32,
    s: &mut NavFlightAStar,
    store: &mut S,
) -> bool {
    store.clear();
    *s = NavFlightAStar { found: -1, finished: true, ..NavFlightAStar::default() };
    let (start_leaf, start_snapped) = snap_to_free(v, start, max_snap_distance);
    s.start_leaf = start_leaf;
    s.start = start_snapped;
    let (goal_leaf, goal_snapped) = snap_to_free(v, goal, max_snap_distance);
    s.goal_leaf = goal_leaf;
    s.goal = goal_snapped;
    if s.start_leaf < 0 || s.goal_leaf < 0 {
        return false;
    }

    s.h_scale = HEURISTIC_SCALE * if filter.area_cost_count == 0 { 1.0 } else { filter.min_area_cost };
    s.max_nodes = max(max_nodes, 1);
    let h0 = s.start.distance(s.goal) * s.h_scale;
    s.best_h = h0;
    store.add_node(
        s.start_leaf as i64,
        SearchNode { item: s.start_leaf, parent: -1, g: 0.0, f: h0, pos: s.start, ..SearchNode::default() },
    );
    if s.start_leaf == s.goal_leaf {
        s.found = 0; // one leaf: straight there
        return true;
    }

    store.push(SearchOpen { f: h0, node: 0 });
    s.finished = false;
    true
}

/// Expands up to `max_nodes` leaves. True once the search is over: the goal leaf is reached or the open set is
/// empty (the node budget, `max_nodes` of `begin`, ends it that way too) (`Step`).
pub fn step<S: SearchStore>(
    v: &NavVolumeData,
    filter: &NavVolumeQueryFilter,
    s: &mut NavFlightAStar,
    store: &mut S,
    max_nodes: i32,
) -> bool {
    let mut expanded = 0;
    while !s.finished && expanded < max_nodes {
        if store.open_count() == 0 {
            s.finished = true;
            break;
        }

        let item = store.pop();
        let mut cur = store.get_node(item.node);
        if cur.closed() || item.f > cur.f {
            continue;
        }
        cur.set_closed(true);
        store.set_node(item.node, cur);
        expanded += 1;

        if cur.item == s.goal_leaf {
            s.found = item.node;
            s.finished = true;
            break;
        }

        let hc = cur.pos.distance(s.goal);
        if hc < s.best_h {
            s.best_h = hc;
            s.best_node = item.node;
        }

        let leaf = v.leaves[cur.item as usize];
        let leaf_cost = filter.cost(leaf.area as i32);
        for k in 0..leaf.neighbor_count {
            let nl = v.neighbors[(leaf.neighbor_start + k) as usize];
            let next = v.leaves[nl as usize];
            if filter.excluded(next.area as i32) {
                continue;
            }

            // Enter the neighbour at its point nearest the current position: that point lies on the shared face,
            // so the segment stays inside the two free cubes.
            let mn = v.origin + int3_to_float(next.min) * v.cell_size;
            let mx = mn + Float3::splat(next.size as f32 * v.cell_size);
            let inset = 0.01 * v.cell_size;
            let pos = cur.pos.clamp(mn + Float3::splat(inset), mx - Float3::splat(inset));

            // The step from cur.pos to the shared face runs through the current leaf.
            let mut g_cost = cur.g + cur.pos.distance(pos) * leaf_cost;
            let h = if nl == s.goal_leaf { 0.0 } else { pos.distance(s.goal) * s.h_scale };
            if nl == s.goal_leaf {
                g_cost += pos.distance(s.goal) * filter.cost(next.area as i32);
            }

            if let Some(ni) = store.try_get_node(nl as i64) {
                let mut n = store.get_node(ni);
                if g_cost >= n.g {
                    continue;
                }
                n.parent = item.node;
                n.g = g_cost;
                n.f = g_cost + h;
                n.pos = pos;
                n.set_closed(false);
                store.set_node(ni, n);
                store.push(SearchOpen { f: n.f, node: ni });
            } else {
                if store.node_count() >= s.max_nodes as usize {
                    continue;
                }
                let idx = store.add_node(
                    nl as i64,
                    SearchNode { item: nl, parent: item.node, g: g_cost, f: g_cost + h, pos, ..SearchNode::default() },
                );
                store.push(SearchOpen { f: g_cost + h, node: idx });
            }
        }
    }

    s.finished
}

/// Writes the finished search's points: the leaf path walked back from the goal (or the leaf that got closest,
/// partial), then line-of-sight smoothing that never cuts through a costlier area than the path it shortens
/// (`Finish`).
pub fn finish<S: SearchStore>(
    v: &NavVolumeData,
    filter: &NavVolumeQueryFilter,
    s: &NavFlightAStar,
    store: &S,
    points: &mut Vec<Float3>,
) -> FlightPathStatus {
    points.clear();
    let mut raw: Vec<Float3> = Vec::with_capacity(64);
    let mut raw_leaves: Vec<i32> = Vec::with_capacity(64); // the leaf each raw point is in
    let reached = s.found >= 0;
    let last = if reached { s.found } else { s.best_node };
    let mut n = last;
    while n >= 0 {
        let node = store.get_node(n);
        raw.push(node.pos);
        raw_leaves.push(node.item);
        n = node.parent;
    }
    raw.reverse();
    raw_leaves.reverse();

    if reached {
        raw.push(s.goal);
        raw_leaves.push(s.goal_leaf);
    }

    // Line-of-sight smoothing: from each anchor, jump to the farthest point still in view, through areas no
    // costlier than the most expensive leaf the raw path visits on the way there.
    points.push(raw[0]);
    let mut anchor = 0usize;
    while anchor < raw.len() - 1 {
        let mut next = anchor + 1;
        let mut j = raw.len() - 1;
        while j > anchor + 1 {
            let mut max_cost = 0.0f32;
            for &leaf in &raw_leaves[anchor..=j] {
                max_cost = max(max_cost, filter.cost(v.leaves[leaf as usize].area as i32));
            }
            if segment_clear_filtered(v, filter, raw[anchor], raw[j], max_cost) {
                next = j;
                break;
            }
            j -= 1;
        }

        points.push(raw[next]);
        anchor = next;
    }

    if reached {
        FlightPathStatus::Success
    } else {
        FlightPathStatus::Partial
    }
}
