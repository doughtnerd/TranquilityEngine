//! Overlays (Foxfire `Tiles/NavOverlayBuild.cs`, and the input copying of `NavOverlaySystem.Schedule`): rebuilding the
//! navmesh across a chunk's edge from the chunk border blobs (its own and its neighbours').
//!
//! A chunk with Chunk Bounds bakes its edge tiles as if the ground ended at its faces. When a neighbour is loaded,
//! the runtime rebuilds those tiles with the neighbour's real geometry past the face (the border data holds every
//! triangle in a band along the faces, unclipped), as a navmesh of its own, the *overlay*. The chunk's own
//! polygons in the replaced tiles are switched off while the overlay stands, and the overlay is joined to the
//! kept polygons along the inner line (between replaced and kept tiles) and, by the seams, to the neighbours.
//!
//! [`build_overlay`] is pure: borders and the chunk's baked navmesh in, the overlay's navmesh, its tiles and its
//! joins to the interior out. Parallel jobs of the C# are sequential loops here (each tile only reads shared data).
use std::cmp::Ordering;

use nav_format::{NavAreas, NavChunkBorderData, NavChunkFace, NavLinkKind, NavMeshData};
use nav_math::math;
use nav_math::{Float3, Int2};

use crate::clearance::{NoFoldClearance, NoJumpClearance};
use crate::stitcher::{self, BinPolyMesh, JumpSettings, StitchSettings};
use crate::tiles;
use crate::types::{border_grid_to_bin_grid, triangle_content_cmp, BakeSteps, BinGrid, NavTileHeightfield, TaskSteps, TriangleData};
use nav_recast::FFBounds;

/// A loaded neighbour across one of the chunk's faces, for the agent type being rebuilt.
#[derive(Clone, Copy, Debug)]
pub struct OverlayNeighbour<'a> {
    /// The neighbour's border data (its triangles are rasterized into this chunk's border columns).
    pub border: &'a NavChunkBorderData,
    /// The chunk's own face the neighbour lies across (`NavChunkFace`).
    pub face: NavChunkFace,
    /// The neighbour's profile index for the agent type (`NavBorderAgent::profile`).
    pub profile: usize,
}

/// What one overlay build reads (`OverlayBuild`'s inputs, before they're copied out of the blobs).
#[derive(Clone, Debug)]
pub struct OverlayInput<'a> {
    /// The chunk's own border data.
    pub border: &'a NavChunkBorderData,
    /// The chunk's profile index for the agent type (`NavBorderAgent::profile`).
    pub profile: usize,
    /// The chunk's baked navmesh for the agent type: its bins, areas and tile ranges, and the polygons the overlay
    /// replaces. Must have been baked with Chunk Bounds (tile ranges).
    pub base: &'a NavMeshData,
    /// The loaded neighbours. The order doesn't change the result (triangles come out in content order per tile),
    /// but keep it by chunk id as the planner does.
    pub neighbours: &'a [OverlayNeighbour<'a>],
}

/// A join between the overlay and the rest of its chunk's navmesh, on the inner line (between replaced and kept
/// tiles): `base_poly` (a kept polygon of the chunk's navmesh) to `overlay_poly` (of the overlay's). `a0`-`a1` is
/// the stretch on `base_poly`'s edge, `b0`-`b1` on `overlay_poly`'s (`b0` pairs with `a0`). Both grids are the
/// same, so they lie on the same line (`NavOverlayLink`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OverlayLink {
    pub base_poly: i32,
    pub overlay_poly: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
}

/// A kept polygon's link into a tile an overlay replaces: where the overlay must join it (world space).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OverlayInteriorPortal {
    pub poly: i32,
    pub a: Float3,
    pub b: Float3,
}

/// What a build makes.
#[derive(Clone, Debug, Default)]
pub struct OverlayOutput {
    /// The overlay's navmesh (the rebuilt tiles stitched together; no jumps: an overlay keeps no heightfield to
    /// clear them against). Its `seam_edges` are on the chunk's faces (open and closed).
    pub nav: NavMeshData,
    /// The tiles rebuilt, by tile coordinate in the ground grid.
    pub tiles: Vec<Int2>,
    /// Their interior corners in grid columns (`tile * tile_size`, `NavOverlayTile::origin`, `NavTileRange::origin`).
    pub tile_origins: Vec<Int2>,
    /// Per tile: it had walkable polygons in the overlay.
    pub valid: Vec<bool>,
    /// The overlay's joins to the chunk's kept polygons.
    pub links: Vec<OverlayLink>,
    /// The faces with a loaded neighbour, bits by `NavChunkFace`.
    pub open_sides: i32,
    pub tile_size: i32,
    /// The triangles the tiles were built from (the chunk's and its neighbours').
    pub triangle_count: usize,
    /// The kept polygons' portals into replaced tiles.
    pub interior_portals: Vec<OverlayInteriorPortal>,
}

/// A neighbour's area index as this chunk's: the same asset id, or plain walkable if it doesn't list it
/// (`NavOverlaySystem.MapArea`).
pub fn map_area(area: i32, from: &NavChunkBorderData, to: &NavChunkBorderData) -> i32 {
    if area <= NavAreas::WALKABLE || area as usize >= from.areas.len() {
        return if area <= NavAreas::WALKABLE { area } else { NavAreas::WALKABLE };
    }
    let id = from.areas[area as usize];
    for i in NavAreas::FIRST_CUSTOM as usize..to.areas.len() {
        if to.areas[i] == id {
            return i as i32;
        }
    }
    NavAreas::WALKABLE
}

/// The overlay for a chunk's agent type, or None if the input can't be built (the profile index is out of range).
/// The same input always gives the same bits.
pub fn build_overlay(input: &OverlayInput) -> Option<OverlayOutput> {
    let border = input.border;
    let nav = input.base;
    let profile = *border.profiles.get(input.profile)?;
    let mut grid = border_grid_to_bin_grid(&profile.grid, border.box_min, border.box_max);
    let tile_world = grid.tile_size as f32 * grid.cs;

    // How deep each face rebuilds: enough tiles for the neighbour's reach into this box, plus the tile border.
    let mut depth = [0i32; 4];
    for n in input.neighbours {
        let reach = n.border.overhang[opposite_index(n.face)] + grid.border as f32 * grid.cs;
        let tiles = math::clamp((reach / tile_world).ceil() as i32, border.min_depth, border.max_depth);
        let f = n.face.0 as usize;
        depth[f] = math::max(depth[f], tiles);
        grid.open_sides |= 1 << n.face.0;
    }

    let mut tile_list: Vec<Int2> = Vec::with_capacity(16);
    for tz in 0..grid.tiles_z {
        for tx in 0..grid.tiles_x {
            if tx < depth[NavChunkFace::X_MIN.0 as usize]
                || tx >= grid.tiles_x - depth[NavChunkFace::X_MAX.0 as usize]
                || tz < depth[NavChunkFace::Z_MIN.0 as usize]
                || tz >= grid.tiles_z - depth[NavChunkFace::Z_MAX.0 as usize]
            {
                tile_list.push(Int2::new(tx, tz));
            }
        }
    }

    // Triangles: the chunk's own, and each neighbour's remapped to this chunk's profile bit, bins and areas.
    let bit = 1u32 << profile.bit;
    let mut triangles: Vec<TriangleData> = Vec::with_capacity(border.triangles.len() * 2);
    for t in &border.triangles {
        let mut t = *t;
        t.walkable_for = if t.walkable_for & bit != 0 { bit } else { 0 };
        triangles.push(t);
    }
    for n in input.neighbours {
        let other = n.border;
        let other_bit = 1u32 << other.profiles.get(n.profile)?.bit;
        for t in &other.triangles {
            let mut t = *t;
            t.walkable_for = if t.walkable_for & other_bit != 0 { bit } else { 0 };
            t.bin = if t.bin == 0 { 0 } else { 1 }; // only the ground grid is rebuilt: any other bin is solid in it
            t.area = map_area(t.area, other, border);
            triangles.push(t);
        }
    }

    // The kept polygons' links into replaced tiles: where the overlay joins the rest of the navmesh.
    let mut replaced = vec![false; nav.polys.len()];
    for range in &nav.tile_ranges {
        let tile = Int2::new(range.origin.x / grid.tile_size, range.origin.y / grid.tile_size);
        if !tile_list.contains(&tile) {
            continue;
        }
        for p in range.poly_start..range.poly_start + range.poly_count {
            replaced[p as usize] = true;
        }
    }
    let mut interior: Vec<OverlayInteriorPortal> = Vec::with_capacity(64);
    for (p, poly) in nav.polys.iter().enumerate() {
        if replaced[p] {
            continue;
        }
        for l in poly.link_start..poly.link_start + poly.link_count {
            let link = &nav.links[l as usize];
            if link.kind == NavLinkKind::INTERNAL && replaced[link.to_poly as usize] {
                interior.push(OverlayInteriorPortal { poly: p as i32, a: link.portal_a, b: link.portal_b });
            }
        }
    }

    // One overlay tile per index: its triangles (by bordered bounds, in content order), rasterized and built.
    let steps = BakeSteps::disabled();
    let mut meshes: Vec<Option<BinPolyMesh>> = Vec::with_capacity(tile_list.len());
    for t in &tile_list {
        meshes.push(build_tile(&grid, *t, &profile.agent, profile.bit, &triangles, &steps));
    }

    let output = stitch_tiles(&grid, nav, &profile.agent, &meshes, &interior);
    Some(OverlayOutput {
        nav: output.0,
        tile_origins: tile_list.iter().map(|t| Int2::new(t.x * grid.tile_size, t.y * grid.tile_size)).collect(),
        valid: meshes.iter().map(|m| m.is_some()).collect(),
        tiles: tile_list,
        links: output.1,
        open_sides: grid.open_sides,
        tile_size: grid.tile_size,
        triangle_count: triangles.len(),
        interior_portals: interior,
    })
}

fn opposite_index(face: NavChunkFace) -> usize {
    (face.0 ^ 2) as usize
}

/// `OverlayTileJob.Execute`: one tile's triangles rasterized and built. The ground grid's frame is the identity: the
/// tile's bounds are world bounds.
fn build_tile(
    grid: &BinGrid,
    t: Int2,
    agent: &nav_format::NavTileAgent,
    profile_bit: i32,
    triangles: &[TriangleData],
    steps: &BakeSteps,
) -> Option<BinPolyMesh> {
    let interior = grid.tile_interior(t.x, t.y);
    let bordered = Int2::new(interior.x + 2 * grid.border, interior.y + 2 * grid.border);
    let origin_x = t.x * grid.tile_size - grid.border;
    let origin_z = t.y * grid.tile_size - grid.border;
    let min = grid.bounds.min + Float3::new(origin_x as f32 * grid.cs, 0.0, origin_z as f32 * grid.cs);
    let mut tile = NavTileHeightfield {
        bounds: FFBounds {
            center: Float3::default(),
            min,
            max: Float3::new(min.x + bordered.x as f32 * grid.cs, grid.bounds.max.y, min.z + bordered.y as f32 * grid.cs),
        },
        width: bordered.x,
        height: bordered.y,
        border: grid.border,
        interior,
        origin_x,
        origin_z,
        ..NavTileHeightfield::default()
    };

    // Padded by a column for the rasterizer's rounding, as the bake's bucketing pads.
    let lo = (tile.bounds.min.x - grid.cs, tile.bounds.min.z - grid.cs);
    let hi = (tile.bounds.max.x + grid.cs, tile.bounds.max.z + grid.cs);
    let mut order: Vec<i32> = Vec::with_capacity(64);
    for (i, tri) in triangles.iter().enumerate() {
        let tmin = tri.a.min_v(tri.b).min_v(tri.c);
        let tmax = tri.a.max_v(tri.b).max_v(tri.c);
        if tmax.x >= lo.0 && tmax.z >= lo.1 && tmin.x <= hi.0 && tmin.z <= hi.1 {
            order.push(i as i32);
        }
    }
    order.sort_by(|&a, &b| -> Ordering { triangle_content_cmp(&triangles[a as usize], &triangles[b as usize]) });

    let mut task = TaskSteps::default();
    let mut ticks = 0u64;
    tiles::rasterize(grid, &mut tile, triangles, &order, steps, &mut task, &mut ticks);
    tiles::build(grid, &tile, agent, profile_bit, 0, &[], &[], steps, &mut task, &mut ticks)
}

/// `OverlayStitchJob.Execute`: stitches the overlay's tiles into its navmesh (no jumps: an overlay keeps no
/// heightfield to clear them against), and joins it to the chunk's kept polygons along the inner line: each kept
/// polygon's link into a replaced tile is matched to the overlay's open edges on the same line.
fn stitch_tiles(
    grid: &BinGrid,
    base: &NavMeshData,
    agent: &nav_format::NavTileAgent,
    meshes: &[Option<BinPolyMesh>],
    interior: &[OverlayInteriorPortal],
) -> (NavMeshData, Vec<OverlayLink>) {
    let built: Vec<&BinPolyMesh> = meshes.iter().flatten().collect();
    let mut settings = StitchSettings::from_agent(agent.radius, grid.cs, grid.ch, agent.max_simplification_error);
    settings.seam_height_tolerance = base.seam_height_tolerance;
    let mut jump = JumpSettings::default_for(grid.cs, grid.ch, 1);
    jump.enabled = false;
    let (nav, _) = stitcher::stitch_refs(
        &built,
        &base.bins,
        &base.bin_adjacency,
        &settings,
        &NoFoldClearance,
        &jump,
        &NoJumpClearance,
        None,
        Some(&base.areas),
    );
    let links = join(&nav, interior, base.seam_height_tolerance);
    (nav, links)
}

/// Kept polygons' portals into replaced tiles, matched to the overlay's open edges on the same line
/// (`OverlayStitchJob.Join`).
fn join(overlay: &NavMeshData, interior: &[OverlayInteriorPortal], tolerance: f32) -> Vec<OverlayLink> {
    const EPS: f32 = 1e-3;
    let mut links = Vec::new();
    for portal in interior {
        // Inner lines are tile edges: x or z constant.
        let axis = if math::abs(portal.a.x - portal.b.x) < EPS { 0 } else { 2 };
        let along = 2 - axis;
        let (p0, p1) = (portal.a[along], portal.b[along]);
        for edge in &overlay.open_edges {
            if math::abs(edge.a[axis] - portal.a[axis]) > EPS || math::abs(edge.b[axis] - portal.a[axis]) > EPS {
                continue;
            }
            let lo = math::max(math::min(p0, p1), math::min(edge.a[along], edge.b[along]));
            let hi = math::min(math::max(p0, p1), math::max(edge.a[along], edge.b[along]));
            if hi - lo <= EPS {
                continue;
            }
            let a0 = at(portal.a, portal.b, along, lo);
            let a1 = at(portal.a, portal.b, along, hi);
            let b0 = at(edge.a, edge.b, along, lo);
            let b1 = at(edge.a, edge.b, along, hi);
            if math::abs(a0.y - b0.y) > tolerance || math::abs(a1.y - b1.y) > tolerance {
                continue;
            }
            links.push(OverlayLink { base_poly: portal.poly, overlay_poly: edge.poly, a0, a1, b0, b1 });
        }
    }
    links
}

fn at(a: Float3, b: Float3, along: usize, s: f32) -> Float3 {
    let span = b[along] - a[along];
    let t = if math::abs(span) < 1e-6 { 0.0 } else { math::saturate((s - a[along]) / span) };
    let mut p = a.lerp(b, t);
    p[along] = s;
    p
}
