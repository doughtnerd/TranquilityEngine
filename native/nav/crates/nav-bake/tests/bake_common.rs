//! Shared fixture for the `bake_*` integration tests: a port of Foxfire's `TestNavBake` (procedural scenes baked
//! without a scene), plus a link-graph "pathfinder" standing in for `NavMeshPathfinding` (queries come in a later wave:
//! a path exists if a breadth-first search over the navmesh's links reaches the goal polygon).
//!
//! Not a test target of its own (no tests); each `bake_*.rs` includes it with `mod bake_common;`.
#![allow(dead_code)]

use std::collections::VecDeque;

use nav_bake::bake::{bake_chunk, BakeCaches, BakeInput, BakeMesh, BakeOutput};
use nav_bake::bins::OrientationConfig;
use nav_bake::settings::{BakeFlyer, BakeProfile, ModifierTargets, NavAgentSettings, NavArea, NavBakeSettings, VoxelSizing};
use nav_bake::settings::{GateVolume, ModifierVolume, ResolutionVolume};
use nav_format::{NavLinkKind, NavMeshData, NavVolumeData};
use nav_math::math::Float4x4;
use nav_math::{Float3, Float4, Hash128};

pub fn v3(x: f32, y: f32, z: f32) -> Float3 {
    Float3::new(x, y, z)
}

// ---------------------------------------------------------------------------------------------------------
// A little maths: rotations and a deterministic random source (the tests' scenes, not the bake's)
// ---------------------------------------------------------------------------------------------------------

/// A rotation as a 3x3 matrix (rows).
#[derive(Clone, Copy, Debug)]
pub struct Rot(pub [[f32; 3]; 3]);

impl Rot {
    pub const IDENTITY: Rot = Rot([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);

    pub fn x(rad: f32) -> Rot {
        let (s, c) = rad.sin_cos();
        Rot([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])
    }
    pub fn y(rad: f32) -> Rot {
        let (s, c) = rad.sin_cos();
        Rot([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    }
    pub fn z(rad: f32) -> Rot {
        let (s, c) = rad.sin_cos();
        Rot([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    }
    /// `a * b`: b first, then a.
    pub fn then(self, b: Rot) -> Rot {
        let mut r = [[0.0f32; 3]; 3];
        for (i, row) in r.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = (0..3).map(|k| self.0[i][k] * b.0[k][j]).sum();
            }
        }
        Rot(r)
    }
    /// Unity's `quaternion.Euler(x, y, z)` order (ZXY: y applied first).
    pub fn euler(x: f32, y: f32, z: f32) -> Rot {
        Rot::z(z).then(Rot::x(x)).then(Rot::y(y))
    }
    pub fn apply(self, v: Float3) -> Float3 {
        let m = &self.0;
        v3(
            m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
            m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
            m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
        )
    }
}

/// xorshift64*: a fixed, seedable source for scattered scenes.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1)
    }
    pub fn next_u32(&mut self) -> u32 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545F4914F6CDD1D) >> 32) as u32
    }
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (self.next_u32() as f32 / 4294967296.0) * (hi - lo)
    }
}

// ---------------------------------------------------------------------------------------------------------
// TestNavBake
// ---------------------------------------------------------------------------------------------------------

/// `TestNavBake.Profile()`: radius 0.5, height 2, step 0.5, 0.25 x 0.2 voxels (set explicitly), jump limits 1 / 4 / 2
/// with a 1 m arc. Floors only by default.
pub fn profile(can_jump: bool, walls: bool, ceilings: bool, id: u32) -> BakeProfile {
    BakeProfile::test_profile(can_jump, walls, ceilings, id)
}

pub fn flat_profile() -> BakeProfile {
    profile(false, false, false, 1)
}

/// `TestNavBake.Flyer()`: radius 5, 0.5 m cells, no headroom, id 100, landing slope 30.
pub fn flyer() -> BakeFlyer {
    BakeFlyer::test_flyer(5.0, 0.5, 0.0, 100, 30.0)
}

pub fn flyer_with(radius: f32, cell_size: f32, headroom: f32) -> BakeFlyer {
    BakeFlyer::test_flyer(radius, cell_size, headroom, 100, 30.0)
}

/// `TestNavBake.HybridAgent()`: the test walker and a flyer with the same id (radius 1, 0.5 m cells, 10 m headroom).
pub fn hybrid(radius: f32, cell_size: f32, headroom: f32, max_landing_slope_deg: f32, id: u32, can_jump: bool) -> (BakeProfile, BakeFlyer) {
    (profile(can_jump, false, false, id), BakeFlyer::test_flyer(radius, cell_size, headroom, id, max_landing_slope_deg))
}

fn walker_settings(p: &BakeProfile) -> NavAgentSettings {
    let mut a = NavAgentSettings::new(&p.name, p.id);
    a.walk.radius = p.radius;
    a.walk.height = p.height;
    a.walk.step_height = p.step_height;
    a.walk.can_climb_walls = p.build_walls;
    a.walk.can_walk_ceilings = p.build_ceilings;
    a.walk.can_jump = p.can_jump;
    a.walk.max_jump_up_height = p.max_jump_up_height;
    a.walk.max_jump_distance = p.max_jump_distance;
    a.walk.max_fall_distance = p.max_fall_distance;
    a.walk.jump_arc_height = p.jump_arc_height;
    a
}

fn fly(a: &mut NavAgentSettings, f: &BakeFlyer) {
    a.can_fly = true;
    a.flight.radius = f.radius;
    a.flight.max_landing_slope_deg = f.max_landing_slope_deg;
}

/// A scene baked without a subscene: the meshes, volumes and agent types, and the bake caches of a live rebake.
pub struct TestBake {
    pub settings: NavBakeSettings,
    pub meshes: Vec<BakeMesh>,
    pub caches: BakeCaches,
    gates: u32,
    areas: u32,
    /// The last bake.
    pub out: BakeOutput,
}

impl TestBake {
    /// `new TestNavBake(profile)`: `None` for flyers only.
    pub fn new(p: Option<BakeProfile>) -> Self {
        Self::with_orientation(p, OrientationConfig::DEFAULT)
    }

    pub fn with_orientation(p: Option<BakeProfile>, orientation: OrientationConfig) -> Self {
        let mut settings = NavBakeSettings::default();
        settings.setup.orientation = orientation;
        settings.setup.voxels = VoxelSizing::Fixed;
        // The profile's own voxels (every agent type of one setup shares them).
        settings.setup.cell_size = 0.25;
        settings.setup.cell_height = 0.2;
        settings.chunk.chunk_grid = 0.0;
        let mut b = Self { settings, meshes: Vec::new(), caches: BakeCaches::new(), gates: 0, areas: 0, out: BakeOutput::default() };
        if let Some(p) = p {
            b.add_agent(p);
        }
        b
    }

    /// Another walking agent type. Fixed voxels: the setup's size follows the first profile.
    pub fn add_agent(&mut self, p: BakeProfile) {
        if self.settings.setup.agents.is_empty() {
            self.settings.setup.cell_size = p.cell_size;
            self.settings.setup.cell_height = p.cell_height;
        }
        self.settings.setup.build = p.build;
        self.settings.setup.agents.push(walker_settings(&p));
    }

    /// A flying agent type. The setup's fixed flight cell size and headroom follow the first flyer.
    pub fn add_flyer(&mut self, f: BakeFlyer) {
        let first = !self.settings.setup.agents.iter().any(|a| a.can_fly);
        if first {
            self.settings.setup.flight_voxels = VoxelSizing::Fixed;
            self.settings.setup.flight_cell_size = f.cell_size;
            self.settings.setup.flight_headroom_radii = if f.radius > 0.0 { f.headroom / f.radius } else { 0.0 };
            self.settings.setup.flight_open_to_sky_only = f.open_to_sky_only;
        }
        let mut a = NavAgentSettings::new(&f.name, f.id);
        a.can_walk = false;
        fly(&mut a, &f);
        self.settings.setup.agents.push(a);
    }

    /// An agent type that walks and flies (same id): what links its navmesh and flight volume.
    pub fn add_hybrid(&mut self, walker: BakeProfile, f: BakeFlyer) {
        let first = !self.settings.setup.agents.iter().any(|a| a.can_fly);
        if first {
            self.settings.setup.flight_voxels = VoxelSizing::Fixed;
            self.settings.setup.flight_cell_size = f.cell_size;
            self.settings.setup.flight_headroom_radii = f.headroom / f.radius;
        }
        if self.settings.setup.agents.iter().all(|a| !a.can_walk) {
            self.settings.setup.cell_size = walker.cell_size;
            self.settings.setup.cell_height = walker.cell_height;
        }
        self.settings.setup.build = walker.build;
        let mut a = walker_settings(&walker);
        fly(&mut a, &f);
        self.settings.setup.agents.push(a);
    }

    /// Bakes only inside this world-space box (`NavChunkAuthoring`'s Chunk Bounds), unsnapped.
    pub fn set_chunk_bounds(&mut self, min: Float3, max: Float3, min_depth: i32, max_depth: i32) {
        let c = &mut self.settings.chunk;
        c.use_chunk_bounds = true;
        c.center = (min + max) * 0.5;
        c.size = max - min;
        c.chunk_grid = 0.0;
        c.min_overlay_depth = min_depth;
        c.max_overlay_depth = max_depth;
    }

    pub fn set_tile_size(&mut self, tile_size: i32) {
        self.settings.setup.tile_size = tile_size;
    }

    /// A horizontal, upward-facing quad from min to max (x, z) at height y; walkable for `walkable_for` (none = every
    /// agent type).
    pub fn add_floor(&mut self, min: (f32, f32), max: (f32, f32), y: f32, walkable_for: &[Hash128]) {
        let positions = vec![v3(min.0, y, min.1), v3(max.0, y, min.1), v3(max.0, y, max.1), v3(min.0, y, max.1)];
        let mesh = BakeMesh::nav_mesh(positions, vec![0, 2, 1, 0, 3, 2]).with_walkable_for(walkable_for.to_vec());
        self.meshes.push(mesh);
    }

    pub fn add_floor_simple(&mut self, min: f32, max: f32) {
        self.add_floor((min, min), (max, max), 0.0, &[]);
    }

    /// A one-sided quad (a, b, c, d around its edge), wound so its walkable side faces along `normal`.
    pub fn add_quad(&mut self, a: Float3, b: Float3, c: Float3, d: Float3, normal: Float3, obstacle: bool) {
        let facing = (b - a).cross(c - a).dot(normal) > 0.0;
        let indices = if facing { vec![0, 1, 2, 0, 2, 3] } else { vec![0, 2, 1, 0, 3, 2] };
        let positions = vec![a, b, c, d];
        self.meshes.push(if obstacle { BakeMesh::obstacle(positions, indices) } else { BakeMesh::nav_mesh(positions, indices) });
    }

    fn box_mesh(center: Float3, size: Float3, rot: Rot, obstacle: bool) -> Vec<(Float3, Float3, Float3, Float3, Float3)> {
        let h = size * 0.5;
        let mut quads = Vec::new();
        for axis in 0..3 {
            for sign in [-1.0f32, 1.0] {
                let mut n = Float3::default();
                n[axis] = sign;
                let mut u = Float3::default();
                u[(axis + 1) % 3] = 1.0;
                let mut v = Float3::default();
                v[(axis + 2) % 3] = 1.0;
                let c = n * h;
                let du = u * h;
                let dv = v * h;
                let corner = |local: Float3| center + rot.apply(local);
                quads.push((corner(c - du - dv), corner(c + du - dv), corner(c + du + dv), corner(c - du + dv), rot.apply(n)));
            }
        }
        let _ = obstacle;
        quads
    }

    /// A closed box (six outward-facing quads), centred on `center`, rotated.
    pub fn add_box(&mut self, center: Float3, size: Float3, rot: Rot) {
        for (a, b, c, d, n) in Self::box_mesh(center, size, rot, false) {
            self.add_quad(a, b, c, d, n, false);
        }
    }

    /// A closed box tagged as an obstacle: solid for every agent type, never walkable, blocks flight cells.
    pub fn add_obstacle(&mut self, center: Float3, size: Float3, rot: Rot) {
        for (a, b, c, d, n) in Self::box_mesh(center, size, rot, true) {
            self.add_quad(a, b, c, d, n, true);
        }
    }

    pub fn add_mesh(&mut self, positions: Vec<Float3>, indices: Vec<u32>, obstacle: bool) {
        self.meshes.push(if obstacle { BakeMesh::obstacle(positions, indices) } else { BakeMesh::nav_mesh(positions, indices) });
    }

    /// How many meshes exist so far; pass it to [`remove_meshes_since`](Self::remove_meshes_since).
    pub fn mesh_mark(&self) -> usize {
        self.meshes.len()
    }

    pub fn remove_meshes_since(&mut self, mark: usize) {
        self.meshes.truncate(mark);
    }

    fn box_to_world(center: Float3, size: Float3) -> Float4x4 {
        Float4x4::new(
            Float4::new(size.x, 0.0, 0.0, 0.0),
            Float4::new(0.0, size.y, 0.0, 0.0),
            Float4::new(0.0, 0.0, size.z, 0.0),
            Float4::new(center.x, center.y, center.z, 1.0),
        )
    }

    /// An axis-aligned gate box.
    pub fn add_gate(&mut self, center: Float3, size: Float3, open: bool) {
        self.gates += 1;
        let id = Hash128::new(self.gates, 1, 0, 0);
        self.settings.gates.push(GateVolume::from_box(Self::box_to_world(center, size), id, open));
    }

    /// A custom area with the given cost; returns its id. Its index is `NavAreas::FIRST_CUSTOM` + the areas before it.
    pub fn add_area(&mut self, cost: f32) -> Hash128 {
        self.areas += 1;
        let id = Hash128::new(self.areas, 2, 0, 0);
        self.settings.setup.areas.push(NavArea { id, default_cost: cost, color: Float4::splat(1.0) });
        id
    }

    /// An axis-aligned modifier volume setting the ground and/or air area inside it (`applies_to`: `ModifierTargets`).
    pub fn add_modifier_volume(&mut self, center: Float3, size: Float3, area: Hash128, applies_to: u8, affected: &[Hash128]) {
        self.settings.modifier_volumes.push(ModifierVolume::from_box(Self::box_to_world(center, size), area, applies_to, affected.to_vec()));
    }

    pub fn add_ground_volume(&mut self, center: Float3, size: Float3, area: Hash128, affected: &[Hash128]) {
        self.add_modifier_volume(center, size, area, ModifierTargets::GROUND, affected);
    }

    /// An axis-aligned resolution region: flight cells of about `cell_size` inside it.
    pub fn add_resolution_volume(&mut self, center: Float3, size: Float3, cell_size: f32, affected: &[Hash128]) {
        self.settings.resolution_volumes.push(ResolutionVolume::from_box(Self::box_to_world(center, size), cell_size, affected.to_vec()));
    }

    pub fn input(&self) -> BakeInput {
        BakeInput {
            meshes: self.meshes.clone(),
            settings: self.settings.clone(),
            scene_path: "scenes/test.scene".to_string(),
            chunk_node_id: "chunk".to_string(),
        }
    }

    /// Runs one bake; the caches carry over, so baking again after a change is a live rebake.
    pub fn bake(&mut self) -> &mut Self {
        let input = self.input();
        self.out = bake_chunk(&input, &mut self.caches);
        self
    }

    /// The first agent type's navmesh.
    pub fn nav(&self) -> &NavMeshData {
        &self.out.file.navmeshes[0].data
    }

    pub fn navs(&self) -> Vec<&NavMeshData> {
        self.out.file.navmeshes.iter().map(|s| &s.data).collect()
    }

    /// The first flight volume.
    pub fn volume(&self) -> &NavVolumeData {
        &self.out.file.volumes[0].data
    }

    pub fn fingerprint(&self) -> u64 {
        nav_format::fingerprint::hash_navmesh(self.nav())
    }

    pub fn reused_tiles(&self) -> i32 {
        self.out.report.reused_tiles
    }
    pub fn reused_tasks(&self) -> i32 {
        self.out.report.reused_tasks
    }
    pub fn tile_count(&self) -> i32 {
        self.out.report.tiles
    }
    pub fn task_count(&self) -> i32 {
        self.out.report.tasks
    }

    /// The bake's file bytes (`myco.nav@1`).
    pub fn bytes(&self) -> Vec<u8> {
        nav_format::write(&self.out.file)
    }

    /// Gate starting states by gate index.
    pub fn closed_gates(&self) -> &[bool] {
        &self.out.gates_closed
    }

    /// True if the flight volume has no free space at `p` (blocked, padded, or outside the bounds).
    pub fn is_flight_blocked(&self, p: Float3, volume: usize) -> bool {
        nav_bake::volume::leaf_at(&self.out.file.volumes[volume].data, p) < 0
    }
}

// ---------------------------------------------------------------------------------------------------------
// The link graph "pathfinder"
// ---------------------------------------------------------------------------------------------------------

/// What a query agent may do (`NavMeshQueryFilter`).
#[derive(Clone, Debug)]
pub struct Filter {
    pub can_jump: bool,
    pub max_jump_up: f32,
    pub max_jump_distance: f32,
    pub max_fall: f32,
    pub closed_gates: Vec<bool>,
}

impl Filter {
    pub fn walker() -> Self {
        Filter { can_jump: false, max_jump_up: 0.0, max_jump_distance: 0.0, max_fall: 0.0, closed_gates: Vec::new() }
    }
    pub fn jumper(up: f32, distance: f32, fall: f32) -> Self {
        Filter { can_jump: true, max_jump_up: up, max_jump_distance: distance, max_fall: fall, closed_gates: Vec::new() }
    }
    pub fn with_gates(mut self, closed: &[bool]) -> Self {
        self.closed_gates = closed.to_vec();
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathStatus {
    Success,
    /// The goal polygon can't be reached.
    Partial,
    /// An end isn't near the navmesh.
    InvalidInput,
}

/// Closest point on triangle abc to p (Ericson, Real-Time Collision Detection), in doubles.
fn closest_on_triangle(p: Float3, a: Float3, b: Float3, c: Float3) -> Float3 {
    let (p, a, b, c) = (p.to_double(), a.to_double(), b.to_double(), c.to_double());
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    let r = |q: nav_math::Double3| q.to_float();
    if d1 <= 0.0 && d2 <= 0.0 {
        return r(a);
    }
    let bp = p - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return r(b);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return r(a + ab * (d1 / (d1 - d3)));
    }
    let cp = p - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return r(c);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return r(a + ac * (d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        return r(b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))));
    }
    let denom = 1.0 / (va + vb + vc);
    r(a + ab * (vb * denom) + ac * (vc * denom))
}

pub fn poly_verts(nav: &NavMeshData, p: usize) -> Vec<Float3> {
    let poly = &nav.polys[p];
    (0..poly.vert_count).map(|i| nav.verts[nav.poly_verts[(poly.vert_start + i) as usize] as usize]).collect()
}

/// Distance from `p` to polygon `poly` (its convex fan of triangles).
pub fn distance_to_poly(nav: &NavMeshData, poly: usize, p: Float3) -> f32 {
    let v = poly_verts(nav, poly);
    let mut best = f32::MAX;
    for i in 1..v.len().saturating_sub(1) {
        best = best.min(closest_on_triangle(p, v[0], v[i], v[i + 1]).distance(p));
    }
    best
}

/// The polygon nearest to `p` within `max_distance` (`FindNearestPoly`).
pub fn nearest_poly(nav: &NavMeshData, p: Float3, max_distance: f32) -> Option<usize> {
    let mut best: Option<(usize, f32)> = None;
    for i in 0..nav.polys.len() {
        if nav.polys[i].area == 0 || nav.polys[i].vert_count < 3 {
            continue;
        }
        let (lo, hi) = (nav.poly_min[i], nav.poly_max[i]);
        if p.x < lo.x - max_distance || p.y < lo.y - max_distance || p.z < lo.z - max_distance {
            continue;
        }
        if p.x > hi.x + max_distance || p.y > hi.y + max_distance || p.z > hi.z + max_distance {
            continue;
        }
        let d = distance_to_poly(nav, i, p);
        if d <= max_distance && best.is_none_or(|(_, b)| d < b) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

/// Snaps both ends (within 2 m) and searches the link graph; returns the status and the jump links used by the path
/// found (the fewest-link path; `jumps` counts jump links in it).
pub fn find_path(nav: &NavMeshData, from: Float3, to: Float3, filter: &Filter) -> (PathStatus, usize) {
    let (Some(start), Some(goal)) = (nearest_poly(nav, from, 2.0), nearest_poly(nav, to, 2.0)) else {
        return (PathStatus::InvalidInput, 0);
    };
    let closed = |p: usize| {
        let g = nav.polys[p].gate;
        g > 0 && (g as usize) < filter.closed_gates.len() && filter.closed_gates[g as usize]
    };
    let usable = |l: &nav_format::NavLink| -> bool {
        if l.kind != NavLinkKind::JUMP {
            return true;
        }
        filter.can_jump && jump_allowed(l, filter)
    };
    // 0-1 BFS: jumps cost 1, everything else 0, so the path found uses the fewest jumps.
    let n = nav.polys.len();
    let mut dist = vec![usize::MAX; n];
    let mut queue = VecDeque::new();
    if closed(start) {
        return (PathStatus::Partial, 0);
    }
    dist[start] = 0;
    queue.push_back(start);
    while let Some(p) = queue.pop_front() {
        let poly = &nav.polys[p];
        for l in 0..poly.link_count {
            let link = &nav.links[(poly.link_start + l) as usize];
            if !usable(link) {
                continue;
            }
            let q = link.to_poly as usize;
            if closed(q) {
                continue;
            }
            let cost = (link.kind == NavLinkKind::JUMP) as usize;
            if dist[p] + cost < dist[q] {
                dist[q] = dist[p] + cost;
                if cost == 0 {
                    queue.push_front(q);
                } else {
                    queue.push_back(q);
                }
            }
        }
    }
    if dist[goal] == usize::MAX {
        (PathStatus::Partial, 0)
    } else {
        (PathStatus::Success, dist[goal])
    }
}

/// A jump link is baked for the most capable agent; each agent's own limits filter it (`jump_rise` is the height
/// gained, negative for a drop; `jump_distance` the horizontal reach).
pub fn jump_allowed(l: &nav_format::NavLink, f: &Filter) -> bool {
    let up_ok = l.jump_rise <= f.max_jump_up + 1e-3;
    let fall_ok = -l.jump_rise <= f.max_fall + 1e-3;
    up_ok && fall_ok && l.jump_distance <= f.max_jump_distance + 1e-3
}

/// How many links of `kind` the navmesh has.
pub fn count_links(nav: &NavMeshData, kind: NavLinkKind) -> usize {
    nav.links.iter().filter(|l| l.kind == kind).count()
}

/// Seam edges on `face`: their total length along the face.
pub fn coverage(nav: &NavMeshData, face: nav_format::NavChunkFace) -> f32 {
    let mut total = 0.0;
    for e in &nav.seam_edges {
        if e.face != face {
            continue;
        }
        total += if face == nav_format::NavChunkFace::X_MIN || face == nav_format::NavChunkFace::X_MAX {
            (e.b.z - e.a.z).abs()
        } else {
            (e.b.x - e.a.x).abs()
        };
    }
    total
}

/// World bounds of a navmesh's vertices.
pub fn vert_bounds(nav: &NavMeshData) -> (Float3, Float3) {
    let mut lo = Float3::splat(f32::MAX);
    let mut hi = Float3::splat(f32::MIN);
    for v in &nav.verts {
        lo = lo.min_v(*v);
        hi = hi.max_v(*v);
    }
    (lo, hi)
}
