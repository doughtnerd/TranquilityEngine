//! Neighbour grids, ORCA avoidance, making way, flight separation (Foxfire's `NavNeighborGridSystem`,
//! `NavFlightNeighborGridSystem`, `NavAvoidanceSystem` with `NavAvoidanceJob` / `NavAvoidanceMemberJob` /
//! `NavMakeWayJob`, `NavFlightSeparationSystem`, and the ORCA half of `Lib/NavMeshAvoidance.cs`).
//!
//! * [`neighbor_grids`]: gathers the tick's ground bodies (avoiding walkers on the ground, active or not, and the
//!   obstacles from [`Obstacles`] with their measured velocity) into [`AvoidanceSystems::ground_grid`], and the
//!   airborne ones (flyers, separating or idle) into [`AvoidanceSystems::flight_grid`]. Both are counting-sort bucket
//!   grids ([`NeighborGrid::build`]): bodies keep their gather order within a bucket (agents by row, then obstacles by
//!   row), so every query is deterministic.
//! * [`avoid`]: per agent type (in type id order), over the agents with `agents.steering` on: ORCA against the nearest
//!   neighbours in range ([`NeighborGrid::find_neighbors`]; lists refreshed every
//!   `runtime.avoidance_refresh_frames()` ticks with agents taking turns, re-measured in between: the Verlet list in
//!   `AgentData::neighbours`), the result clipped to the navmesh, written to `agents.steered`; then group members
//!   (their group's `member_priority`, ghost group, slot rank), then the idle agents asked to make way
//!   (`agents.make_way`, unless `runtime.idle_agents_hold_ground`). Each pass sees the marks set before it.
//! * [`separate`]: flyers with steering on push off the nearest overlapping airborne neighbours.
//!
//! Foxfire's jobs are parallel; here each is a loop over rows in ascending order. Where a job reads state another
//! work item of the same job writes (the make-way marks), a pass reads what was set *before* it began, as the C# jobs
//! do per chunk.
//!
//! # Deviations
//!
//! * `NavMeshAvoidance.MoveAlongSurface` and `LocatePoly` aren't in `nav-query` yet, so the navmesh clip uses private
//!   ports of them in this file (module [`clip`]); swap them for the shared ones when they land.
//! * `avoid` does nothing on a tick with `dt <= 0` (Foxfire divides by it).
//! * `Unity.Mathematics.Random` (the direction that parts two coincident flyers) is [`Random`] here: the xorshift is
//!   Unity's, the seeding follows 1.2.x; only the symmetry breaking depends on it.
use crate::agents::{AgentData, AgentStore};
use crate::components::{NavAvoidanceNeighbor, NavGroup};
use crate::ids::{AgentId, ObstacleId};
use crate::settings::{NavAvoidance, NavFlightAgent};
use crate::tick::Frame;
use crate::world::Obstacles;
use nav_format::NavMeshData;
use nav_math::math::{self, max, min};
use nav_math::{Float2, Float3, Hash128, Int3};
use nav_query::chunks::NavChunks;
use std::collections::BTreeMap;

/// `NavMeshAvoidance.MaxLines`.
pub const MAX_LINES: usize = 30;
/// `NavAvoidanceSteer.GroupTieBreak`: the priority gap a tie between two groups counts as (a 0.3 / 0.7 split).
pub const GROUP_TIE_BREAK: i32 = 10;
const EPSILON: f32 = 1e-5;

// ---------------------------------------------------------------------------------------------------------------------
// Bodies and the grid
// ---------------------------------------------------------------------------------------------------------------------

/// `AvoidanceBodyKind`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BodyKind {
    /// An agent avoiding this tick: shares the avoidance.
    #[default]
    Steering = 0,
    /// An agent that isn't steering (idle, arrived, jumping, crossing a fold): others do all the avoiding.
    Passive = 1,
    /// A `NavAvoidanceObstacle`.
    Obstacle = 2,
}

/// One body in a neighbour grid (`AvoidanceBody`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NeighborBody {
    /// Agents: the surface contact point (flyers: the centre); obstacles: the bottom of the cylinder.
    pub position: Float3,
    pub velocity: Float3,
    pub up: Float3,
    pub radius: f32,
    pub height: f32,
    /// 0 for obstacles.
    pub neighbor_distance: f32,
    pub layers: u32,
    pub priority: i32,
    /// Agent row, or `-1 - obstacle row`.
    pub owner: i32,
    pub kind: BodyKind,
    /// A flyer: `position` is its centre, `height` 0, `radius` its personal space.
    pub airborne: bool,
    /// A group member's group (its row + 1), 0 for none: breaks ties between groups ([`responsibility`]).
    pub group: i32,
    /// A group member's slot + 1, 0 for none: breaks ties within its group.
    pub rank: i32,
}

impl NeighborBody {
    /// `Center`.
    #[inline]
    pub fn center(&self) -> Float3 {
        self.position + self.up * (self.height * 0.5)
    }
    pub fn is_obstacle(&self) -> bool {
        self.kind == BodyKind::Obstacle
    }
}

/// `math.hash(int3)`.
#[inline]
pub fn hash_int3(v: Int3) -> u32 {
    (v.x as u32)
        .wrapping_mul(0xCD266C89)
        .wrapping_add((v.y as u32).wrapping_mul(0xF1852A33))
        .wrapping_add((v.z as u32).wrapping_mul(0x77E35E77))
        .wrapping_add(0xDB4F0B91)
}

/// `math.hash(int2)`.
#[inline]
pub fn hash_int2(x: i32, y: i32) -> u32 {
    (x as u32).wrapping_mul(0x83B58237).wrapping_add((y as u32).wrapping_mul(0x833E3E29)).wrapping_add(0xA9D919BF)
}

/// A hash grid of bodies (`NavNeighborGrid` + `NavNeighbors`): bodies stored sorted by bucket, each with its cell
/// (cells sharing a bucket are told apart by it) and its index in the gather order. An obstacle appears once per cell
/// its bounds touch.
#[derive(Clone, Debug, Default)]
pub struct NeighborGrid {
    /// Per axis (`CellSize`).
    pub cell_size: Float3,
    /// The largest personal space of an airborne body, 0 if none.
    pub air_radius: f32,
    /// The gathered bodies, agents then obstacles (cleared and refilled each tick before [`NeighborGrid::build`]).
    pub gathered: Vec<NeighborBody>,
    /// By bucket (`Sorted`).
    pub bodies: Vec<NeighborBody>,
    /// Gather index of each entry (`SortedIndex`).
    pub index: Vec<i32>,
    pub cells: Vec<Int3>,
    /// Bucket count + 1 prefix sums (`BucketStart`).
    pub bucket_start: Vec<i32>,
    /// By agent row / obstacle row: an index into `bodies`, or -1 (`SortedOf`, rebuilt each time).
    pub of_agent: Vec<i32>,
    pub of_obstacle: Vec<i32>,
}

impl NeighborGrid {
    /// A grid over `bodies` (tests, tools).
    pub fn from_bodies(bodies: Vec<NeighborBody>) -> Self {
        let mut g = Self { gathered: bodies, ..Self::default() };
        g.build();
        g
    }

    /// `BuildNeighborGridJob`: the cell size, each entry's bucket, bucket counts and prefix sums, a scatter in gather
    /// order.
    pub fn build(&mut self) {
        // Cells of half the largest neighbour distance across, at least 4 agent radii and half the largest obstacle's
        // extent; at least 3 agent heights tall; flyers' cells at least their largest personal space across.
        let mut across = 1e-2f32;
        let mut tall = 1e-2f32;
        let mut air = 0.0f32;
        for body in &self.gathered {
            if body.kind == BodyKind::Obstacle {
                across = max(across, 0.5 * extent(body));
                continue;
            }
            if body.airborne {
                across = max(across, body.radius);
                air = max(air, body.radius);
                continue;
            }
            across = max(across, max(0.5 * body.neighbor_distance, 4.0 * body.radius));
            tall = max(tall, 3.0 * body.height);
        }
        let cell = Float3::new(across, max(across, tall), across);
        self.cell_size = cell;
        self.air_radius = air;

        let mut entries = 0usize;
        for body in &self.gathered {
            if body.kind != BodyKind::Obstacle {
                entries += 1;
                continue;
            }
            let (lo, hi) = span(body, cell);
            let size = (hi.x - lo.x + 1) as usize * (hi.y - lo.y + 1) as usize * (hi.z - lo.z + 1) as usize;
            entries += size;
        }

        let mut cells: Vec<Int3> = Vec::with_capacity(entries);
        let mut owners: Vec<i32> = Vec::with_capacity(entries);
        for (i, body) in self.gathered.iter().enumerate() {
            if body.kind != BodyKind::Obstacle {
                cells.push(cell_of(body.position, cell));
                owners.push(i as i32);
                continue;
            }
            let (lo, hi) = span(body, cell);
            for z in lo.z..=hi.z {
                for y in lo.y..=hi.y {
                    for x in lo.x..=hi.x {
                        cells.push(Int3::new(x, y, z));
                        owners.push(i as i32);
                    }
                }
            }
        }

        // Counting sort into buckets: twice as many buckets as entries keeps collisions rare.
        let buckets = math::ceilpow2(max(2 * entries as i32, 16)) as usize;
        self.bucket_start.clear();
        self.bucket_start.resize(buckets + 1, 0);
        let mut keys: Vec<usize> = Vec::with_capacity(entries);
        for c in &cells {
            let k = hash(*c, buckets);
            keys.push(k);
            self.bucket_start[k + 1] += 1;
        }
        for b in 1..=buckets {
            self.bucket_start[b] += self.bucket_start[b - 1];
        }
        let mut cursor: Vec<i32> = self.bucket_start[..buckets].to_vec();
        self.bodies.clear();
        self.bodies.resize(entries, NeighborBody::default());
        self.index.clear();
        self.index.resize(entries, 0);
        self.cells.clear();
        self.cells.resize(entries, Int3::default());
        for i in 0..entries {
            let k = cursor[keys[i]] as usize;
            cursor[keys[i]] += 1;
            self.bodies[k] = self.gathered[owners[i] as usize];
            self.index[k] = owners[i];
            self.cells[k] = cells[i];
        }

        // Where each body is this tick (backwards, so an obstacle in several cells maps to its first entry).
        for v in self.of_agent.iter_mut() {
            *v = -1;
        }
        for v in self.of_obstacle.iter_mut() {
            *v = -1;
        }
        for k in (0..entries).rev() {
            let owner = self.bodies[k].owner;
            if owner >= 0 {
                let r = owner as usize;
                if self.of_agent.len() <= r {
                    self.of_agent.resize(r + 1, -1);
                }
                self.of_agent[r] = k as i32;
            } else {
                let r = (-1 - owner) as usize;
                if self.of_obstacle.len() <= r {
                    self.of_obstacle.resize(r + 1, -1);
                }
                self.of_obstacle[r] = k as i32;
            }
        }
    }

    /// `TryGetBody`: where the body with this owner code is in `bodies` this tick.
    pub fn try_get_body(&self, owner: i32) -> Option<usize> {
        let k = if owner >= 0 { self.of_agent.get(owner as usize) } else { self.of_obstacle.get((-1 - owner) as usize) }.copied()?;
        (k >= 0 && (k as usize) < self.bodies.len() && self.bodies[k as usize].owner == owner).then_some(k as usize)
    }

    /// `Bucket`: the range of `bodies` in `cell`'s bucket; check `cells[i] == cell`, as other cells can share it.
    #[inline]
    pub fn bucket(&self, cell: Int3) -> (usize, usize) {
        let b = hash(cell, self.bucket_start.len() - 1);
        (self.bucket_start[b] as usize, self.bucket_start[b + 1] as usize)
    }

    /// The body's index in the gather order (an obstacle in several cells has one).
    pub fn gather_index(&self, j: usize) -> i32 {
        self.index[j]
    }

    /// `NavAvoidanceSteer.FindNeighbors`: the closest `max_neighbors` (at most 30) bodies this agent avoids, sorted
    /// by squared distance in its plane (indices into `bodies`; `distances` parallel). Members of the `ghost` group
    /// are left out. Searches columns of cells in rings outward, over the height band's layers, skipping columns past
    /// the range or past the farthest of a full list.
    #[allow(clippy::too_many_arguments)]
    pub fn find_neighbors(
        &self,
        self_owner: i32,
        pos: Float3,
        up: Float3,
        avoidance: &NavAvoidance,
        height: f32,
        neighbors: &mut Vec<i32>,
        distances: &mut Vec<f32>,
        ghost: i32,
    ) {
        neighbors.clear();
        distances.clear();
        let max_neighbors = avoidance.max_neighbors.clamp(0, MAX_LINES as i32) as usize;
        if max_neighbors == 0 {
            return;
        }
        let cell = self.cell_size;
        let range = avoidance.neighbor_distance;
        let mut lo = cell_of(pos - Float3::splat(range), cell);
        let mut hi = cell_of(pos + Float3::splat(range), cell);
        let centre = cell_of(pos, cell);

        // Upright (the usual case): distance in the ground plane, bodies within a band of heights; search columns of
        // cells in rings, over only the band's layers. Up a little off vertical (up to 8 degrees) the plane and band
        // lean: the bounds allow for it. On walls and ceilings every cell in range, in 3D.
        let upright = math::abs(up.y) > 0.99;
        let mut slack = 0.0f32;
        if upright {
            let tilt = Float2::new(up.x, up.z).length();
            let lean = tilt * range;
            let below = (if up.y > 0.0 { 2.0 * height } else { height }) + lean;
            let above = (if up.y > 0.0 { height } else { 2.0 * height }) + lean;
            lo.y = cell_of(pos - Float3::new(0.0, below, 0.0), cell).y;
            hi.y = cell_of(pos + Float3::new(0.0, above, 0.0), cell).y;
            slack = tilt * (below + above);
        }

        let rings = if upright { math::max(math::max(hi.x - centre.x, hi.z - centre.z), math::max(centre.x - lo.x, centre.z - lo.z)) } else { 0 };
        for ring in 0..=rings {
            if ring > 1 && neighbors.len() >= max_neighbors {
                let away = max((ring - 1) as f32 * cell.x - slack, 0.0);
                if away * away >= distances[neighbors.len() - 1] {
                    break;
                }
            }
            let (z0, z1) = if upright { (max(lo.z, centre.z - ring), min(hi.z, centre.z + ring)) } else { (lo.z, hi.z) };
            let (x0, x1) = if upright { (max(lo.x, centre.x - ring), min(hi.x, centre.x + ring)) } else { (lo.x, hi.x) };
            for z in z0..=z1 {
                for x in x0..=x1 {
                    if upright {
                        if max((x - centre.x).abs(), (z - centre.z).abs()) != ring {
                            continue; // an inner ring's: done
                        }
                        let corner = Float2::new(x as f32, z as f32) * Float2::new(cell.x, cell.z);
                        let gap = Float2::new(
                            max(max(corner.x - pos.x, pos.x - (corner.x + cell.x)), 0.0),
                            max(max(corner.y - pos.z, pos.z - (corner.y + cell.z)), 0.0),
                        );
                        let near = max(gap.length() - slack, 0.0);
                        if near > range {
                            continue;
                        }
                        if neighbors.len() >= max_neighbors && near * near >= distances[neighbors.len() - 1] {
                            continue;
                        }
                    }
                    for y in lo.y..=hi.y {
                        let at = Int3::new(x, y, z);
                        let (start, end) = self.bucket(at);
                        for j in start..end {
                            if self.cells[j] != at {
                                continue; // another cell in the same bucket
                            }
                            let Some(d2) = self.accept(j, self_owner, pos, up, avoidance, height, range, ghost) else { continue };
                            if self.bodies[j].kind == BodyKind::Obstacle && listed(self, self.index[j], neighbors) {
                                continue; // obstacles can be in several cells
                            }
                            insert(j as i32, d2, max_neighbors, neighbors, distances);
                        }
                    }
                }
            }
        }
    }

    /// `Accept`: body `j` as this agent's neighbour, with its squared distance in the agent's plane; None if it isn't
    /// one (a flyer, itself, on layers it doesn't avoid, in the ghost group, on another surface, outside its height
    /// band or out of range).
    #[allow(clippy::too_many_arguments)]
    #[inline]
    fn accept(&self, j: usize, self_owner: i32, pos: Float3, up: Float3, avoidance: &NavAvoidance, height: f32, range: f32, ghost: i32) -> Option<f32> {
        let body = &self.bodies[j];
        if body.airborne || body.owner == self_owner || (body.layers & avoidance.avoid_layers) == 0 {
            return None; // flyers separate among themselves
        }
        if ghost != 0 && body.group == ghost {
            return None;
        }
        let obstacle = body.kind == BodyKind::Obstacle;
        if !obstacle && body.up.dot(up) < 0.5 {
            return None; // on another surface
        }
        // Height overlap along this agent's up.
        let rel = (if obstacle { body.center() } else { body.position }) - pos;
        let h = rel.dot(up);
        let low = if obstacle { h - body.height * 0.5 } else { h };
        let high = if obstacle { h + body.height * 0.5 } else { h + body.height };
        if high < 0.0 || low > height {
            return None;
        }
        let planar = rel - up * h;
        let reach = range + if obstacle { body.radius } else { 0.0 };
        let d2 = planar.length_sq();
        (d2 <= reach * reach).then_some(d2)
    }

    /// `CachedNeighbors`: the bodies a Verlet list names (`owners`, as owner codes), re-measured where they are now:
    /// one that's gone, or out of range now, drops out.
    #[allow(clippy::too_many_arguments)]
    pub fn cached_neighbors(
        &self,
        owners: impl Iterator<Item = i32>,
        self_owner: i32,
        pos: Float3,
        up: Float3,
        avoidance: &NavAvoidance,
        height: f32,
        neighbors: &mut Vec<i32>,
        distances: &mut Vec<f32>,
    ) {
        neighbors.clear();
        distances.clear();
        let max_neighbors = avoidance.max_neighbors.clamp(0, MAX_LINES as i32) as usize;
        for owner in owners {
            let Some(j) = self.try_get_body(owner) else { continue }; // gone, or not avoided this tick
            let Some(d2) = self.accept(j, self_owner, pos, up, avoidance, height, avoidance.neighbor_distance, 0) else { continue };
            insert(j as i32, d2, max_neighbors, neighbors, distances);
        }
    }

    /// `NavFlightSeparationJob.FindOverlapping`: the nearest `max_neighbors` airborne bodies (other than self, on
    /// avoided layers, outside the ghost group) whose personal space overlaps one of radius `personal` at `pos`.
    #[allow(clippy::too_many_arguments)]
    pub fn find_overlapping(
        &self,
        self_owner: i32,
        pos: Float3,
        personal: f32,
        avoid_layers: u32,
        max_neighbors: usize,
        neighbors: &mut Vec<i32>,
        distances: &mut Vec<f32>,
        ghost: i32,
    ) {
        neighbors.clear();
        distances.clear();
        let cell = self.cell_size;
        let range = personal + self.air_radius; // no overlap past this, whatever the neighbour's size
        let lo = cell_of(pos - Float3::splat(range), cell);
        let hi = cell_of(pos + Float3::splat(range), cell);
        for z in lo.z..=hi.z {
            for y in lo.y..=hi.y {
                for x in lo.x..=hi.x {
                    let at = Int3::new(x, y, z);
                    let corner = Float3::new(at.x as f32, at.y as f32, at.z as f32) * cell;
                    let gap = Float3::new(
                        max(max(corner.x - pos.x, pos.x - (corner.x + cell.x)), 0.0),
                        max(max(corner.y - pos.y, pos.y - (corner.y + cell.y)), 0.0),
                        max(max(corner.z - pos.z, pos.z - (corner.z + cell.z)), 0.0),
                    );
                    let near = gap.length();
                    if near > range {
                        continue;
                    }
                    if neighbors.len() >= max_neighbors && near * near >= distances[neighbors.len() - 1] {
                        continue;
                    }
                    let (start, end) = self.bucket(at);
                    for j in start..end {
                        if self.cells[j] != at {
                            continue;
                        }
                        let body = &self.bodies[j];
                        if !body.airborne || body.owner == self_owner || (body.layers & avoid_layers) == 0 {
                            continue;
                        }
                        if ghost != 0 && body.group == ghost {
                            continue;
                        }
                        let reach = personal + body.radius;
                        let d2 = pos.distance_sq(body.position);
                        if d2 >= reach * reach {
                            continue;
                        }
                        insert(j as i32, d2, max_neighbors, neighbors, distances);
                    }
                }
            }
        }
    }
}

#[inline]
fn extent(body: &NeighborBody) -> f32 {
    body.radius + body.height * 0.5
}

fn span(body: &NeighborBody, cell: Float3) -> (Int3, Int3) {
    let e = Float3::splat(extent(body));
    let c = body.center();
    (cell_of(c - e, cell), cell_of(c + e, cell))
}

/// `NavNeighbors.CellOf`.
#[inline]
pub fn cell_of(p: Float3, cell: Float3) -> Int3 {
    let q = (p / cell).floor();
    Int3::new(q.x as i32, q.y as i32, q.z as i32)
}

#[inline]
fn hash(cell: Int3, buckets: usize) -> usize {
    (hash_int3(cell) & (buckets as u32 - 1)) as usize
}

/// True if the body gathered as `index` is already among `neighbors` (an obstacle found in another cell).
fn listed(grid: &NeighborGrid, index: i32, neighbors: &[i32]) -> bool {
    neighbors.iter().any(|&n| grid.index[n as usize] == index)
}

/// `Insert`: into the sorted list, dropping the farthest if full.
#[inline]
pub fn insert(index: i32, d2: f32, max_neighbors: usize, neighbors: &mut Vec<i32>, distances: &mut Vec<f32>) {
    if neighbors.len() >= max_neighbors {
        if d2 >= distances[neighbors.len() - 1] {
            return;
        }
        neighbors.pop();
        distances.pop();
    }
    let mut at = neighbors.len();
    while at > 0 && distances[at - 1] > d2 {
        at -= 1;
    }
    neighbors.insert(at, index);
    distances.insert(at, d2);
}

/// The avoidance steps' state between ticks.
#[derive(Clone, Debug, Default)]
pub struct AvoidanceSystems {
    pub ground_grid: NeighborGrid,
    pub flight_grid: NeighborGrid,
}

// ---------------------------------------------------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------------------------------------------------

/// An enabled group member's group handle and slot.
fn member_of(d: &AgentData) -> Option<(AgentId, i32)> {
    d.group_member.filter(|m| m.enabled).map(|m| (m.group, m.slot))
}

/// `NavGroupPriority.Key`: the group's row + 1.
#[inline]
fn group_key(group: AgentId) -> i32 {
    if group.is_none() {
        0
    } else {
        group.index() as i32 + 1
    }
}

/// The group body's `NavGroup`, if it still exists.
fn group_of(agents: &AgentStore, group: AgentId) -> Option<NavGroup> {
    let r = agents.row(group)?;
    agents.data[r].group.as_deref().map(|g| g.group)
}

fn flying(d: &AgentData) -> bool {
    d.route.as_deref().is_some_and(|x| x.flying)
}

/// `NavNeighborGridSystem` + `NavFlightNeighborGridSystem`.
pub fn neighbor_grids(sys: &mut AvoidanceSystems, agents: &AgentStore, obstacles: &Obstacles, _frame: &Frame) {
    // Ground bodies: avoiding agents on the ground (steering or not: passive agents are avoided too), then obstacles.
    let g = &mut sys.ground_grid;
    g.gathered.clear();
    for r in agents.active_rows() {
        let d = &agents.data[r];
        if !d.kind.walks() || flying(d) {
            continue;
        }
        let (Some(av), Some(walk)) = (&d.avoidance, &d.walk) else { continue };
        let (avoidance, agent) = (&*av.settings, &*walk.settings);
        let active = agents.steering[r];
        let surface = &agents.surface[r];
        let member = member_of(d);
        let priority = match member {
            Some((gr, _)) => group_of(agents, gr).map_or(avoidance.priority, |gp| min(avoidance.priority, gp.member_priority)),
            None => avoidance.priority,
        };
        g.gathered.push(NeighborBody {
            position: surface.surface_position,
            velocity: if active { agents.steered[r] } else { Float3::default() },
            up: surface.up.normalize_safe(Float3::UP),
            radius: if avoidance.radius > 0.0 { avoidance.radius } else { agent.radius },
            height: agent.height,
            neighbor_distance: avoidance.neighbor_distance,
            layers: avoidance.layers,
            priority,
            owner: r as i32,
            kind: if active { BodyKind::Steering } else { BodyKind::Passive },
            airborne: false,
            group: member.map_or(0, |(gr, _)| group_key(gr)),
            rank: member.map_or(0, |(_, slot)| max(slot + 1, 0)),
        });
    }
    for r in obstacles.live_rows() {
        let o = &obstacles.obstacle[r];
        let up = obstacles.up[r].normalize_safe(Float3::UP);
        g.gathered.push(NeighborBody {
            position: obstacles.position[r] - up * (o.height * 0.5),
            velocity: obstacles.state[r].velocity,
            up,
            radius: o.radius,
            height: o.height,
            neighbor_distance: 0.0,
            layers: o.layers,
            priority: 0,
            owner: -1 - r as i32,
            kind: BodyKind::Obstacle,
            airborne: false,
            group: 0,
            rank: 0,
        });
    }
    g.build();

    // Airborne bodies: every flyer (separating or not: idle ones are pushed off too) that isn't walking.
    let f = &mut sys.flight_grid;
    f.gathered.clear();
    for r in agents.active_rows() {
        let d = &agents.data[r];
        if !d.kind.flies() || d.route.as_deref().is_some_and(|x| x.walking) {
            continue;
        }
        let Some(fl) = &d.flight else { continue };
        let personal = fl.settings.personal_radius();
        let active = agents.steering[r];
        f.gathered.push(NeighborBody {
            position: agents.position[r],
            velocity: if active { agents.steered[r] } else { Float3::default() },
            up: Float3::UP,
            radius: personal,
            height: 0.0,
            neighbor_distance: 2.0 * personal,
            layers: fl.settings.layers,
            priority: 0,
            owner: r as i32,
            kind: if active { BodyKind::Steering } else { BodyKind::Passive },
            airborne: true,
            group: member_of(d).map_or(0, |(gr, _)| group_key(gr)),
            rank: 0,
        });
    }
    f.build();
}

// ---------------------------------------------------------------------------------------------------------------------
// ORCA (NavMeshAvoidance)
// ---------------------------------------------------------------------------------------------------------------------

/// A half-plane constraint on velocity: allowed velocities lie left of `direction` through `point` (`OrcaLine`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OrcaLine {
    pub point: Float2,
    pub direction: Float2,
}

#[inline]
fn det(a: Float2, b: Float2) -> f32 {
    a.x * b.y - a.y * b.x
}

/// `NeighborLine`: the ORCA half-plane for one neighbour, in the agent's 2D frame. `rel_pos` and `rel_vel` are the
/// neighbour's position and the agent's velocity relative to each other (other - self, self - other); `responsibility`
/// the share of the avoidance this agent takes: 0.5 between equals, 1 against something that won't avoid back.
pub fn neighbor_line(
    velocity: Float2,
    rel_pos: Float2,
    rel_vel: Float2,
    combined_radius: f32,
    time_horizon: f32,
    time_step: f32,
    responsibility: f32,
) -> OrcaLine {
    let dist_sq = rel_pos.length_sq();
    let combined_radius_sq = combined_radius * combined_radius;
    let direction;
    let u;

    if dist_sq > combined_radius_sq {
        // No collision yet: project onto the truncated velocity-obstacle cone.
        let inv_time_horizon = 1.0 / time_horizon;
        let w = rel_vel - rel_pos * inv_time_horizon; // from the cutoff centre to the relative velocity
        let w_length_sq = w.length_sq();
        let dot1 = w.dot(rel_pos);

        if dot1 < 0.0 && dot1 * dot1 > combined_radius_sq * w_length_sq {
            // Project onto the cutoff circle.
            let w_length = w_length_sq.sqrt();
            let unit_w = w / max(w_length, EPSILON);
            direction = Float2::new(unit_w.y, -unit_w.x);
            u = unit_w * (combined_radius * inv_time_horizon - w_length);
        } else {
            // Project onto a leg of the cone.
            let leg = (dist_sq - combined_radius_sq).sqrt();
            direction = if det(rel_pos, w) > 0.0 {
                Float2::new(rel_pos.x * leg - rel_pos.y * combined_radius, rel_pos.x * combined_radius + rel_pos.y * leg) / dist_sq
            } else {
                -Float2::new(rel_pos.x * leg + rel_pos.y * combined_radius, -rel_pos.x * combined_radius + rel_pos.y * leg) / dist_sq
            };
            u = direction * rel_vel.dot(direction) - rel_vel;
        }
    } else {
        // Already overlapping: separate within one time step.
        let inv_time_step = 1.0 / time_step;
        let w = rel_vel - rel_pos * inv_time_step;
        let w_length = w.length();
        let unit_w = if w_length > EPSILON {
            w / w_length
        } else {
            Float2::new(-rel_pos.y, rel_pos.x).normalize_safe(Float2::new(1.0, 0.0)) // any direction
        };
        direction = Float2::new(unit_w.y, -unit_w.x);
        u = unit_w * (combined_radius * inv_time_step - w_length);
    }

    OrcaLine { point: velocity + u * responsibility, direction }
}

/// `Solve`: the velocity closest to `preferred` that satisfies every line, within `max_speed`. If the lines can't
/// all be satisfied (a crowd pressing in), the one that violates them least.
pub fn solve(lines: &[OrcaLine], max_speed: f32, preferred: Float2) -> Float2 {
    let mut result = Float2::default();
    let fail = linear_program2(lines, max_speed, preferred, false, &mut result);
    if fail < lines.len() {
        linear_program3(lines, 0, fail, max_speed, &mut result);
    }
    result
}

fn linear_program1(lines: &[OrcaLine], line_no: usize, radius: f32, opt_velocity: Float2, direction_opt: bool, result: &mut Float2) -> bool {
    let line = lines[line_no];
    let dot = line.point.dot(line.direction);
    let discriminant = dot * dot + radius * radius - line.point.length_sq();
    if discriminant < 0.0 {
        return false; // the speed circle misses this line entirely
    }
    let sqrt_disc = discriminant.sqrt();
    let mut t_left = -dot - sqrt_disc;
    let mut t_right = -dot + sqrt_disc;

    for other in &lines[..line_no] {
        let denominator = det(line.direction, other.direction);
        let numerator = det(other.direction, line.point - other.point);
        if math::abs(denominator) <= EPSILON {
            if numerator < 0.0 {
                return false; // parallel and on the wrong side
            }
            continue;
        }
        let t = numerator / denominator;
        if denominator >= 0.0 {
            t_right = min(t_right, t);
        } else {
            t_left = max(t_left, t);
        }
        if t_left > t_right {
            return false;
        }
    }

    if direction_opt {
        *result = if opt_velocity.dot(line.direction) > 0.0 { line.point + line.direction * t_right } else { line.point + line.direction * t_left };
    } else {
        let t = math::clamp(line.direction.dot(opt_velocity - line.point), t_left, t_right);
        *result = line.point + line.direction * t;
    }
    true
}

fn linear_program2(lines: &[OrcaLine], radius: f32, opt_velocity: Float2, direction_opt: bool, result: &mut Float2) -> usize {
    if direction_opt {
        *result = opt_velocity * radius;
    } else if opt_velocity.length_sq() > radius * radius {
        *result = opt_velocity.normalize() * radius;
    } else {
        *result = opt_velocity;
    }

    for i in 0..lines.len() {
        if det(lines[i].direction, lines[i].point - *result) <= 0.0 {
            continue; // already satisfied
        }
        let previous = *result;
        if !linear_program1(lines, i, radius, opt_velocity, direction_opt, result) {
            *result = previous;
            return i;
        }
    }
    lines.len()
}

fn linear_program3(lines: &[OrcaLine], num_obstacle_lines: usize, begin_line: usize, radius: f32, result: &mut Float2) {
    let mut distance = 0.0f32;
    let mut projected: Vec<OrcaLine> = Vec::with_capacity(lines.len());
    for i in begin_line..lines.len() {
        let line = lines[i];
        if det(line.direction, line.point - *result) <= distance {
            continue;
        }

        // Minimise the largest violation: project the other lines onto this one.
        projected.clear();
        projected.extend_from_slice(&lines[..num_obstacle_lines]);
        for other in &lines[num_obstacle_lines..i] {
            let determinant = det(line.direction, other.direction);
            let point = if math::abs(determinant) <= EPSILON {
                if line.direction.dot(other.direction) > 0.0 {
                    continue; // same direction
                }
                (line.point + other.point) * 0.5
            } else {
                line.point + line.direction * (det(other.direction, line.point - other.point) / determinant)
            };
            let direction = (other.direction - line.direction).normalize_safe(Float2::default());
            projected.push(OrcaLine { point, direction });
        }

        let previous = *result;
        if linear_program2(&projected, radius, Float2::new(-line.direction.y, line.direction.x), true, result) < projected.len() {
            *result = previous; // floating-point error: keep the last result
        }
        distance = det(line.direction, line.point - *result);
    }
}

/// `Responsibility`: the share of the avoidance this agent takes against `other`: half between equals, more if the
/// other is more important (lower priority), all of it against passive agents and obstacles. Members of two different
/// groups at the same priority: the older group (lower row) goes first, as if the other were `GROUP_TIE_BREAK` less
/// important. Likewise two members of one group (`rank`): the one bound for the slot nearer the front goes first.
#[inline]
pub fn responsibility(own_priority: i32, group: i32, other: &NeighborBody, rank: i32) -> f32 {
    if other.kind != BodyKind::Steering {
        return 1.0;
    }
    let mut more_important = other.priority - own_priority; // > 0: this agent is more important
    if more_important == 0 && group != 0 && other.group != 0 && other.group != group {
        more_important = if other.group > group { GROUP_TIE_BREAK } else { -GROUP_TIE_BREAK };
    } else if more_important == 0 && group != 0 && other.group == group && rank > 0 && other.rank > 0 && rank != other.rank {
        more_important = if other.rank > rank { GROUP_TIE_BREAK } else { -GROUP_TIE_BREAK };
    }
    0.5 - 0.4 * math::clamp(more_important as f32 / 20.0, -1.0, 1.0)
}

// ---------------------------------------------------------------------------------------------------------------------
// Steering one agent (NavAvoidanceSteer)
// ---------------------------------------------------------------------------------------------------------------------

/// What one agent's steer reads.
struct Input {
    row: usize,
    /// Last tick's steered velocity (path follow starts it at desired).
    current: Float3,
    desired: Float3,
    avoidance: NavAvoidance,
    speed: f32,
    agent_radius: f32,
    height: f32,
    snap: f32,
    pos: Float3,
    up: Float3,
    entry: usize,
    prev_poly: i32,
    next_poly: i32,
    struggling: bool,
    group: i32,
    ghost: i32,
    rank: i32,
}

#[derive(Default)]
struct Scratch {
    neighbors: Vec<i32>,
    distances: Vec<f32>,
    lines: Vec<OrcaLine>,
}

/// The tick-wide state `NavAvoidanceSteer` carries.
struct Steer<'a> {
    grid: &'a NeighborGrid,
    snapshot: &'a NavChunks,
    agent_slots: &'a crate::ids::SlotTable,
    obstacle_slots: &'a crate::ids::SlotTable,
    dt: f32,
    marks: bool,
    refresh_frames: i32,
    frame: i64,
}

impl Steer<'_> {
    /// `NavAvoidanceSteer.Steer`: avoids the agent's neighbours, clips the move to its navmesh, returns steered.
    #[allow(clippy::too_many_arguments)]
    fn steer(
        &self,
        yielding: bool,
        s: &mut Scratch,
        make_way: &mut [bool],
        inp: &Input,
        poly: &mut i32,
        cache: Option<&mut Vec<NavAvoidanceNeighbor>>,
    ) -> Float3 {
        let entry = &self.snapshot.entries[inp.entry];
        let Some(nav) = entry.nav.as_deref() else {
            return inp.desired; // its chunk's navmesh went (the path is about to be dropped): nothing to clip to
        };
        let forward = inp.desired.normalize_safe(any_perpendicular(inp.up)); // the 2D frame's first axis
        let refresh = cache.is_none()
            || self.refresh_frames <= 1
            || cache.as_deref().is_some_and(|c| c.is_empty())
            || (self.frame + inp.row as i64) % self.refresh_frames as i64 == 0;
        let velocity = self.avoid_neighbors(yielding, s, make_way, inp, forward, cache, refresh);
        let gates = self.snapshot.gates_of(inp.entry);
        clip::keep_on_navmesh(nav, gates, poly, inp.snap, inp.prev_poly, inp.next_poly, inp.pos, inp.up, velocity, self.dt)
    }

    /// `AvoidNeighbors`: ORCA in the surface plane.
    #[allow(clippy::too_many_arguments)]
    fn avoid_neighbors(
        &self,
        yielding: bool,
        s: &mut Scratch,
        make_way: &mut [bool],
        inp: &Input,
        e1: Float3,
        cache: Option<&mut Vec<NavAvoidanceNeighbor>>,
        refresh: bool,
    ) -> Float3 {
        let avoidance = &inp.avoidance;
        let (pos, up) = (inp.pos, inp.up);
        let e2 = up.cross(e1);
        let radius = if avoidance.radius > 0.0 { avoidance.radius } else { inp.agent_radius };
        let velocity = to2(inp.current, e1, e2);
        let owner = inp.row as i32;
        let grid = self.grid;

        s.neighbors.clear();
        s.distances.clear();
        if !inp.struggling {
            match cache {
                Some(cache) if !refresh => {
                    let owners = cache.iter().filter_map(|n| self.owner_of(*n));
                    grid.cached_neighbors(owners, owner, pos, up, avoidance, inp.height, &mut s.neighbors, &mut s.distances);
                }
                Some(cache) => {
                    // The cache keeps twice as many as it avoids (a Verlet list's margin): one that comes nearer than
                    // those it avoided, between searches, is in it. This tick avoids the nearest max_neighbors.
                    let mut wide = *avoidance;
                    wide.max_neighbors = min(MAX_LINES as i32, 2 * avoidance.max_neighbors);
                    grid.find_neighbors(owner, pos, up, &wide, inp.height, &mut s.neighbors, &mut s.distances, inp.ghost);
                    cache.clear();
                    for &n in &s.neighbors {
                        if let Some(id) = self.neighbor_id(grid.bodies[n as usize].owner) {
                            cache.push(id);
                        }
                    }
                    let keep = min(s.neighbors.len() as i32, math::clamp(avoidance.max_neighbors, 0, MAX_LINES as i32)) as usize;
                    s.neighbors.truncate(keep); // sorted nearest first
                    s.distances.truncate(keep);
                }
                None => {
                    grid.find_neighbors(owner, pos, up, avoidance, inp.height, &mut s.neighbors, &mut s.distances, inp.ghost);
                }
            }
        }

        // Where it means to go, for making way: an agent its neighbours hold back still wants through; one stepping
        // aside has no wish of its own, so its current move.
        let heading = if yielding { velocity } else { to2(inp.desired, e1, e2) };
        s.lines.clear();
        for n in 0..s.neighbors.len() {
            let body = &grid.bodies[s.neighbors[n] as usize];
            if self.marks
                && body.kind == BodyKind::Passive
                && (if yielding { body.priority >= avoidance.priority } else { body.priority > avoidance.priority })
            {
                ask_to_make_way(make_way, body, to2(body.position - pos, e1, e2), heading, radius, avoidance.time_horizon);
            }
            let obstacle = body.kind == BodyKind::Obstacle;
            let rel = (if obstacle { body.center() } else { body.position }) - pos;
            let horizon = max(if obstacle { avoidance.obstacle_time_horizon } else { avoidance.time_horizon }, 0.01);
            s.lines.push(neighbor_line(
                velocity,
                to2(rel, e1, e2),
                velocity - to2(body.velocity, e1, e2),
                radius + body.radius,
                horizon,
                self.dt,
                responsibility(avoidance.priority, inp.group, body, inp.rank),
            ));
        }

        let preferred = to2(inp.desired, e1, e2);
        let chosen = if !s.lines.is_empty() { solve(&s.lines, inp.speed, preferred) } else { preferred };
        e1 * chosen.x + e2 * chosen.y
    }

    /// The Verlet list entry for the body with this owner code.
    fn neighbor_id(&self, owner: i32) -> Option<NavAvoidanceNeighbor> {
        if owner >= 0 {
            self.agent_slots.handle_of(owner as usize).map(|h| NavAvoidanceNeighbor::Agent(AgentId(h)))
        } else {
            self.obstacle_slots.handle_of((-1 - owner) as usize).map(|h| NavAvoidanceNeighbor::Obstacle(ObstacleId(h)))
        }
    }

    /// The owner code of a Verlet list entry, None if its agent or obstacle is gone.
    fn owner_of(&self, n: NavAvoidanceNeighbor) -> Option<i32> {
        match n {
            NavAvoidanceNeighbor::Agent(a) => self.agent_slots.is_live(a.0).then(|| a.row() as i32),
            NavAvoidanceNeighbor::Obstacle(o) => self.obstacle_slots.is_live(o.0).then(|| -1 - o.row() as i32),
        }
    }
}

/// `AskToMakeWay`: turns `body`'s make-way on if this agent, keeping on as it means to (`heading`, relative to the
/// idle body at `rel`), would pass within its radius plus a margin of it within `horizon` seconds.
fn ask_to_make_way(make_way: &mut [bool], body: &NeighborBody, rel: Float2, heading: Float2, radius: f32, horizon: f32) {
    let speed2 = heading.length_sq();
    if speed2 < 1e-4 {
        return;
    }
    let t = rel.dot(heading) / speed2; // when it passes closest
    if t < 0.0 || t > max(horizon, 0.5) {
        return;
    }
    if (rel - heading * t).length_sq() > math::square(1.25 * (radius + body.radius)) {
        return;
    }
    if body.owner >= 0 {
        if let Some(m) = make_way.get_mut(body.owner as usize) {
            *m = true;
        }
    }
}

#[inline]
fn to2(v: Float3, e1: Float3, e2: Float3) -> Float2 {
    Float2::new(v.dot(e1), v.dot(e2))
}

#[inline]
fn any_perpendicular(up: Float3) -> Float3 {
    let axis = if math::abs(up.y) < 0.9 { Float3::UP } else { Float3::new(1.0, 0.0, 0.0) };
    up.cross(axis).normalize()
}

// ---------------------------------------------------------------------------------------------------------------------
// The avoidance step
// ---------------------------------------------------------------------------------------------------------------------

/// The per-agent facts a steer needs from its record.
struct Dims {
    avoidance: NavAvoidance,
    speed: f32,
    radius: f32,
    height: f32,
    snap: f32,
}

fn dims(d: &AgentData) -> Option<Dims> {
    let av = d.avoidance.as_ref()?;
    let walk = d.walk.as_ref()?;
    let s = &*walk.settings;
    Some(Dims { avoidance: *av.settings, speed: walk.speed(), radius: s.radius, height: s.height, snap: max(s.max_snap_distance, s.step_height) })
}

/// `NavAvoidanceSystem`.
pub fn avoid(sys: &mut AvoidanceSystems, agents: &mut AgentStore, obstacles: &Obstacles, frame: &Frame) {
    if frame.dt <= 0.0 || frame.dt.is_nan() {
        return;
    }
    let snapshot = frame.world.snapshot();
    let mut by_type: BTreeMap<Hash128, Vec<usize>> = BTreeMap::new();
    for r in agents.active_rows() {
        let d = &agents.data[r];
        if d.kind.walks() && d.avoidance.is_some() && d.walk.is_some() && d.walker.is_some() && !flying(d) {
            by_type.entry(d.agent_type).or_default().push(r);
        }
    }
    if by_type.is_empty() {
        return;
    }

    let steer = Steer {
        grid: &sys.ground_grid,
        snapshot,
        agent_slots: &agents.slots,
        obstacle_slots: &obstacles.slots,
        dt: frame.dt,
        marks: !frame.runtime.idle_agents_hold_ground,
        refresh_frames: frame.runtime.avoidance_refresh_frames(),
        frame: frame.tick as i64,
    };
    let mut scratch = Scratch::default();
    let make_way_on = steer.marks;

    for rows in by_type.values() {
        // ---- NavAvoidanceJob: agents on their own path.
        for &r in rows {
            if !agents.steering[r] {
                continue;
            }
            let entry = agents.chunk[r].entry;
            if entry < 0 || entry as usize >= snapshot.entries.len() {
                continue;
            }
            let d = &agents.data[r];
            if member_of(d).is_some() {
                continue;
            }
            let Some(dm) = dims(d) else { continue };
            let walker = d.walker.as_deref().unwrap();
            let elements = &walker.elements;
            let prev_poly = elements.get(max(0, walker.path.next_index - 1) as usize).map_or(-1, |e| e.poly);
            let next_poly = elements.get(walker.path.next_index.max(0) as usize).map_or(-1, |e| e.poly);
            let struggling = walker.progress.struggling(&d.walk.as_ref().unwrap().settings);
            let surface = agents.surface[r];
            let inp = Input {
                row: r,
                current: agents.steered[r],
                desired: agents.desired[r],
                avoidance: dm.avoidance,
                speed: dm.speed,
                agent_radius: dm.radius,
                height: dm.height,
                snap: dm.snap,
                pos: surface.surface_position,
                up: surface.up.normalize_safe(Float3::UP),
                entry: entry as usize,
                prev_poly,
                next_poly,
                struggling,
                group: 0,
                ghost: 0,
                rank: 0,
            };
            let d = &mut agents.data[r];
            let walker = d.walker.as_deref_mut().unwrap();
            let v = steer.steer(false, &mut scratch, &mut agents.make_way, &inp, &mut walker.avoidance_state.poly, Some(&mut d.neighbours));
            agents.steered[r] = v;
        }

        // ---- NavAvoidanceMemberJob: group members.
        for &r in rows {
            if !agents.steering[r] {
                continue;
            }
            let Some((group, slot)) = member_of(&agents.data[r]) else { continue };
            let entry = agents.chunk[r].entry;
            if entry < 0 || entry as usize >= snapshot.entries.len() {
                continue; // no chunk: paused
            }
            let Some(dm) = dims(&agents.data[r]) else { continue };
            let mut avoidance = dm.avoidance;
            let group_data = group_of(agents, group);
            if let Some(g) = &group_data {
                avoidance.priority = min(avoidance.priority, g.member_priority);
            }
            let surface = agents.surface[r];
            let nav = snapshot.entries[entry as usize].nav.as_deref();
            let d = &mut agents.data[r];
            let walker = d.walker.as_deref_mut().unwrap();
            if walker.avoidance_state.poly < 0 {
                if let Some(nav) = nav {
                    walker.avoidance_state.poly = clip::nearest_poly_any(nav, surface.surface_position, dm.snap);
                }
            }
            let key = group_key(group);
            let inp = Input {
                row: r,
                current: agents.steered[r],
                desired: agents.desired[r],
                avoidance,
                speed: dm.speed,
                agent_radius: dm.radius,
                height: dm.height,
                snap: dm.snap,
                pos: surface.surface_position,
                up: surface.up.normalize_safe(Float3::UP),
                entry: entry as usize,
                prev_poly: -1,
                next_poly: -1,
                struggling: false,
                group: key,
                ghost: if group_data.is_some_and(|g| g.pass_through_each_other) { key } else { 0 },
                rank: max(slot + 1, 0),
            };
            let v = steer.steer(false, &mut scratch, &mut agents.make_way, &inp, &mut walker.avoidance_state.poly, None);
            agents.steered[r] = v;
        }

        // ---- NavMakeWayJob: the idle agents those asked to make way step aside (and pass it on).
        if !make_way_on {
            continue;
        }
        let asked: Vec<usize> = rows.iter().copied().filter(|&r| agents.make_way[r]).collect();
        for r in asked {
            agents.make_way[r] = false; // asked again next tick if someone's still coming
            let entry = agents.chunk[r].entry;
            if entry < 0 || entry as usize >= snapshot.entries.len() || !agents.surface[r].initialized {
                continue;
            }
            let Some(dm) = dims(&agents.data[r]) else { continue };
            let surface = agents.surface[r];
            let nav = snapshot.entries[entry as usize].nav.as_deref();
            let d = &mut agents.data[r];
            let walker = d.walker.as_deref_mut().unwrap();
            if walker.avoidance_state.poly < 0 {
                if let Some(nav) = nav {
                    walker.avoidance_state.poly = clip::nearest_poly_any(nav, surface.surface_position, dm.snap);
                }
            }
            let inp = Input {
                row: r,
                current: agents.steered[r],
                desired: Float3::default(),
                avoidance: dm.avoidance,
                speed: dm.speed,
                agent_radius: dm.radius,
                height: dm.height,
                snap: dm.snap,
                pos: surface.surface_position,
                up: surface.up.normalize_safe(Float3::UP),
                entry: entry as usize,
                prev_poly: -1,
                next_poly: -1,
                struggling: false,
                group: 0,
                ghost: 0,
                rank: 0,
            };
            let v = steer.steer(true, &mut scratch, &mut agents.make_way, &inp, &mut walker.avoidance_state.poly, None);
            agents.steered[r] = v;
            if v.length_sq() < 1e-4 {
                continue;
            }
            agents.steering[r] = true;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Flight separation
// ---------------------------------------------------------------------------------------------------------------------

/// `Unity.Mathematics.Random` (xorshift32).
#[derive(Clone, Copy, Debug)]
pub struct Random {
    state: u32,
}

impl Random {
    pub fn new(seed: u32) -> Self {
        let mut r = Self { state: seed };
        r.next_state();
        r
    }
    /// `CreateFromIndex`.
    pub fn from_index(index: u32) -> Self {
        let mut r = Self::new(index ^ 0x6E624EB7);
        r.next_state();
        r
    }
    fn next_state(&mut self) -> u32 {
        let t = self.state;
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17;
        self.state ^= self.state << 5;
        t
    }
    pub fn next_float(&mut self) -> f32 {
        f32::from_bits(0x3f800000 | (self.next_state() >> 9)) - 1.0
    }
    /// `NextFloat3Direction`.
    pub fn next_float3_direction(&mut self) -> Float3 {
        let (rx, ry) = (self.next_float(), self.next_float());
        let z = rx * 2.0 - 1.0;
        let r = max(1.0 - z * z, 0.0).sqrt();
        let angle = ry * (2.0 * math::PI);
        let (s, c) = angle.sin_cos();
        Float3::new(c * r, s * r, z)
    }
}

/// `Apart`: a direction to part two flyers in the same spot: from both rows, so each picks the opposite of the
/// other's.
fn apart(me: usize, other: usize) -> Float3 {
    let (low, high) = if me < other { (me, other) } else { (other, me) };
    let direction = Random::from_index(hash_int2(low as i32, high as i32)).next_float3_direction();
    if me < other {
        direction
    } else {
        -direction
    }
}

/// `NavFlightSeparationJob.Steer`: `desired` plus this flyer's pushes off its overlapping neighbours, at most `speed`.
/// Members of the `ghost` group don't push.
pub fn separation_steer(grid: &NeighborGrid, self_owner: i32, pos: Float3, desired: Float3, speed: f32, flyer: &NavFlightAgent, ghost: i32) -> Float3 {
    let personal = flyer.personal_radius();
    let mut neighbors = Vec::with_capacity(16);
    let mut distances = Vec::with_capacity(16);
    grid.find_overlapping(self_owner, pos, personal, flyer.avoid_layers, flyer.separation_neighbors() as usize, &mut neighbors, &mut distances, ghost);

    let mut push = Float3::default();
    for n in 0..neighbors.len() {
        let body = &grid.bodies[neighbors[n] as usize];
        let reach = personal + body.radius;
        let d = distances[n].sqrt();
        let away = if d > 1e-4 { (pos - body.position) / d } else { apart(self_owner as usize, body.owner as usize) };
        push += away * (1.0 - d / reach);
    }

    let velocity = desired + push * (flyer.separation_strength * speed);
    let length = velocity.length();
    if length > speed {
        velocity * (speed / length)
    } else {
        velocity
    }
}

/// `NavFlightSeparationSystem`.
pub fn separate(sys: &mut AvoidanceSystems, agents: &mut AgentStore, _frame: &Frame) {
    for r in agents.active_rows().collect::<Vec<_>>() {
        if !agents.steering[r] {
            continue;
        }
        let d = &agents.data[r];
        if !d.kind.flies() || d.flyer.is_none() || d.route.as_deref().is_some_and(|x| x.walking) {
            continue;
        }
        let Some(fl) = &d.flight else { continue };
        let mut ghost = 0;
        if let Some((gr, _)) = member_of(d) {
            if group_of(agents, gr).is_some_and(|g| g.pass_through_each_other) {
                ghost = group_key(gr);
            }
        }
        let settings = *fl.settings;
        let speed = fl.speed();
        let steered = separation_steer(&sys.flight_grid, r as i32, agents.position[r], agents.desired[r], speed, &settings, ghost);
        agents.steered[r] = steered;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Staying on the navmesh (NavMeshAvoidance's navmesh half; LocatePoly and MoveAlongSurface are walkers.rs's)
// ---------------------------------------------------------------------------------------------------------------------

/// `KeepOnNavmesh` with `LocatePoly` and `MoveAlongSurface`.
pub mod clip {
    use super::*;
    pub use crate::walkers::{faces, locate_poly, move_along_surface};
    use nav_query::filter::NavMeshQueryFilter;
    use nav_query::pathfinding::find_nearest_poly;
    use nav_query::surface::{closest_point_on_poly, point_in_poly};

    /// `FindNearestPoly` with every bin allowed.
    pub fn nearest_poly_any(nav: &NavMeshData, pos: Float3, max_distance: f32) -> i32 {
        let mut f = NavMeshQueryFilter::zeroed();
        f.allowed_bins = u64::MAX;
        find_nearest_poly(nav, pos, max_distance, &f).map_or(-1, |(p, _)| p)
    }

    /// `OffMesh`: folds one polygon into the off-mesh distances.
    #[allow(clippy::too_many_arguments)]
    fn off_mesh(nav: &NavMeshData, poly: i32, up: Float3, pos: Float3, target: Float3, off_now: &mut f32, off_then: &mut f32, on_mesh: &mut Float3) {
        if !faces(nav, poly, up) {
            return;
        }
        *off_now = min(*off_now, pos.distance(closest_point_on_poly(nav, poly, pos).0));
        let cp = closest_point_on_poly(nav, poly, target).0;
        let d = target.distance(cp);
        if d >= *off_then {
            return;
        }
        *off_then = d;
        *on_mesh = cp;
    }

    /// `KeepOnNavmesh`: clips this tick's move to the navmesh and tracks the polygon under the agent (`poly`). On a
    /// polygon the move slides along the mesh. Off it (coming off a fold, or nudged past its edge) it may move along
    /// the mesh or back towards it, never further away.
    #[allow(clippy::too_many_arguments)]
    pub fn keep_on_navmesh(
        nav: &NavMeshData,
        closed_gates: &[bool],
        poly: &mut i32,
        snap: f32,
        mut prev_poly: i32,
        mut next_poly: i32,
        pos: Float3,
        up: Float3,
        velocity: Float3,
        dt: f32,
    ) -> Float3 {
        *poly = locate_poly(nav, pos, up, *poly, prev_poly, next_poly, snap);
        if *poly < 0 {
            return velocity;
        }
        if prev_poly < 0 {
            prev_poly = *poly; // no segment (a group member): only the located polygon
        }
        if next_poly < 0 {
            next_poly = *poly;
        }

        if point_in_poly(nav, *poly, pos) {
            let (target, end_poly) = move_along_surface(nav, *poly, pos, pos + velocity * dt, closed_gates);
            *poly = end_poly;
            return (target - pos) / dt;
        }

        let mut next = pos + velocity * dt;
        let mut off_now = f32::MAX;
        let mut off_then = f32::MAX;
        let mut on_mesh = next;
        off_mesh(nav, *poly, up, pos, next, &mut off_now, &mut off_then, &mut on_mesh);
        off_mesh(nav, prev_poly, up, pos, next, &mut off_now, &mut off_then, &mut on_mesh);
        off_mesh(nav, next_poly, up, pos, next, &mut off_now, &mut off_then, &mut on_mesh);
        if off_now < f32::MAX && off_then > off_now {
            next = on_mesh + (next - on_mesh) * (off_now / max(off_then, 1e-5));
            return (next - pos) / dt;
        }
        velocity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orca_two_head_on_agents_get_opposite_sideways_lines() {
        // Agent at origin heading +x, neighbour at (4, 0) heading -x, radius 0.5 each, horizon 2, equal share.
        let v = Float2::new(1.0, 0.0);
        let line = neighbor_line(v, Float2::new(4.0, 0.0), Float2::new(2.0, 0.0), 1.0, 2.0, 0.02, 0.5);
        // The preferred velocity violates the half-plane, so solving moves it off the line of approach.
        let chosen = solve(&[line], 1.5, v);
        assert!(det(line.direction, line.point - chosen) <= 1e-4);
        assert!(chosen.y.abs() > 1e-3, "{chosen:?}");
    }

    #[test]
    fn orca_without_lines_keeps_the_preferred_velocity_within_speed() {
        assert_eq!(solve(&[], 2.0, Float2::new(1.0, 0.0)), Float2::new(1.0, 0.0));
        let c = solve(&[], 2.0, Float2::new(10.0, 0.0));
        assert!((c.length() - 2.0).abs() < 1e-5);
    }

    #[test]
    fn responsibility_by_priority_and_kind() {
        let steering = |priority, group, rank| NeighborBody { kind: BodyKind::Steering, priority, group, rank, ..NeighborBody::default() };
        assert_eq!(responsibility(50, 0, &steering(50, 0, 0), 0), 0.5);
        assert!(responsibility(50, 0, &steering(70, 0, 0), 0) < 0.5, "a less important neighbour: this one takes less");
        assert!(responsibility(50, 0, &steering(30, 0, 0), 0) > 0.5, "a more important neighbour: this one takes more");
        assert_eq!(responsibility(50, 0, &NeighborBody { kind: BodyKind::Passive, ..NeighborBody::default() }, 0), 1.0);
        assert!((responsibility(50, 3, &steering(50, 4, 0), 0) - 0.3).abs() < 1e-6, "ties between groups: the older group takes the smaller share");
        assert!((responsibility(50, 4, &steering(50, 3, 0), 0) - 0.7).abs() < 1e-6);
    }

    #[test]
    fn insert_keeps_the_nearest_sorted() {
        let (mut n, mut d) = (Vec::new(), Vec::new());
        for (i, d2) in [5.0f32, 1.0, 3.0, 4.0, 2.0].into_iter().enumerate() {
            insert(i as i32, d2, 3, &mut n, &mut d);
        }
        assert_eq!(d, vec![1.0, 2.0, 3.0]);
        assert_eq!(n, vec![1, 4, 2]);
    }
}
