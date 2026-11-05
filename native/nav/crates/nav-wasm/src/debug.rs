//! Debug geometry as flat `f32` arrays for the editor's and runtime's debug drawing (ADR 0065's *Editor*).
//!
//! | function | stride | layout |
//! |---|---|---|
//! | [`navmesh_lines`] | 7 | a xyz, b xyz, kind ([`LINE_EDGE`], [`LINE_INTERNAL`], [`LINE_FOLD`], [`LINE_JUMP`], [`LINE_SEAM_EDGE`]) |
//! | [`navmesh_triangles`] | 11 | a xyz, b xyz, c xyz, bin, area (polygons fanned) |
//! | [`volume_leaves`] | 5 | min xyz (world), edge length (world), area |
//! | [`landing_links`] | 6 | ground xyz, air xyz |
//! | [`seams`] | 7 | a xyz, b xyz, kind (0 polygon link on A's side, 1 flight leaf link's rectangle diagonal) |
//! | [`agent_paths`] | 7 | a xyz, b xyz, agent row |
use nav_format::{NavLandingLinksData, NavLinkKind, NavMeshData, NavVolumeData};
use nav_math::Float3;

/// A polygon edge with no neighbour (the navmesh's outline).
pub const LINE_EDGE: f32 = 0.0;
/// A polygon edge shared with a neighbour in the same bin (drawn once).
pub const LINE_INTERNAL: f32 = 1.0;
/// A fold link's hinge (between surfaces of two bins).
pub const LINE_FOLD: f32 = 2.0;
/// A jump link, from its portal's middle to its landing's middle.
pub const LINE_JUMP: f32 = 3.0;
/// A polygon edge on the chunk bounds' side faces (where seams join).
pub const LINE_SEAM_EDGE: f32 = 4.0;

fn seg(out: &mut Vec<f32>, a: Float3, b: Float3, k: f32) {
    out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z, k]);
}

/// Polygon edges and links (see the module table).
pub fn navmesh_lines(nav: &NavMeshData) -> Vec<f32> {
    let mut out = Vec::new();
    for (p, poly) in nav.polys.iter().enumerate() {
        let n = poly.vert_count.max(0) as usize;
        let links = &nav.links[(poly.link_start.max(0) as usize).min(nav.links.len())..((poly.link_start + poly.link_count).max(0) as usize).min(nav.links.len())];
        for i in 0..n {
            let a = nav.verts[nav.poly_verts[poly.vert_start as usize + i] as usize];
            let b = nav.verts[nav.poly_verts[poly.vert_start as usize + (i + 1) % n] as usize];
            let mid = (a + b) * 0.5;
            // An internal link whose portal lies on this edge: shared (draw from the lower polygon only).
            let shared = links.iter().find(|l| {
                let m = (l.portal_a + l.portal_b) * 0.5;
                l.kind == NavLinkKind::INTERNAL && (m.distance_sq(mid) < 1e-4 || on_segment(a, b, m))
            });
            match shared {
                Some(l) if (l.to_poly as usize) < p => {}
                Some(_) => seg(&mut out, a, b, LINE_INTERNAL),
                None => seg(&mut out, a, b, LINE_EDGE),
            }
        }
        for l in links {
            if l.kind == NavLinkKind::FOLD && (l.to_poly as usize) > p {
                seg(&mut out, l.hinge_a, l.hinge_b, LINE_FOLD);
            } else if l.kind == NavLinkKind::JUMP {
                seg(&mut out, (l.portal_a + l.portal_b) * 0.5, (l.dest_a + l.dest_b) * 0.5, LINE_JUMP);
            }
        }
    }
    for e in &nav.seam_edges {
        seg(&mut out, e.a, e.b, LINE_SEAM_EDGE);
    }
    out
}

fn on_segment(a: Float3, b: Float3, p: Float3) -> bool {
    let ab = b - a;
    let len2 = ab.dot(ab);
    if len2 <= 0.0 {
        return false;
    }
    let t = (p - a).dot(ab) / len2;
    (0.0..=1.0).contains(&t) && (a + ab * t).distance_sq(p) < 1e-4
}

/// Polygons as triangle fans with their bin and area (for filled drawing, coloured by bin or area).
pub fn navmesh_triangles(nav: &NavMeshData) -> Vec<f32> {
    let mut out = Vec::new();
    for poly in &nav.polys {
        let n = poly.vert_count.max(0) as usize;
        if n < 3 {
            continue;
        }
        let v = |i: usize| nav.verts[nav.poly_verts[poly.vert_start as usize + i] as usize];
        let a = v(0);
        for i in 1..n - 1 {
            let (b, c) = (v(i), v(i + 1));
            out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, poly.bin as f32, poly.area as f32]);
        }
    }
    out
}

/// Free flight leaves as cubes.
pub fn volume_leaves(v: &NavVolumeData) -> Vec<f32> {
    let mut out = Vec::with_capacity(v.leaves.len() * 5);
    for leaf in &v.leaves {
        let min = v.origin + Float3::new(leaf.min.x as f32, leaf.min.y as f32, leaf.min.z as f32) * v.cell_size;
        out.extend_from_slice(&[min.x, min.y, min.z, leaf.size as f32 * v.cell_size, leaf.area as f32]);
    }
    out
}

/// [`volume_leaves`], keeping only leaves in area `area` (by id; none if the volume doesn't list it) and, with
/// `refined_only`, only leaves whose cell is smaller than the volume's base cell (inside a resolution region).
pub fn filtered_volume_leaves(v: &NavVolumeData, area: Option<nav_math::Hash128>, refined_only: bool) -> Vec<f32> {
    let area_index = match area {
        Some(id) => match v.areas.iter().position(|a| a.id == id) {
            Some(i) => Some(i as i32),
            None => return Vec::new(),
        },
        None => None,
    };
    let base = nav_query::volume::base_cell_size(v);
    let mut out = Vec::new();
    for leaf in &v.leaves {
        if area_index.is_some_and(|a| leaf.area as i32 != a) {
            continue;
        }
        if refined_only && nav_query::volume::cell_size_at(v, nav_query::volume::leaf_center(v, leaf)) >= base {
            continue;
        }
        let min = v.origin + Float3::new(leaf.min.x as f32, leaf.min.y as f32, leaf.min.z as f32) * v.cell_size;
        out.extend_from_slice(&[min.x, min.y, min.z, leaf.size as f32 * v.cell_size, leaf.area as f32]);
    }
    out
}

/// Landing links, ground point to air point.
pub fn landing_links(l: &NavLandingLinksData) -> Vec<f32> {
    let mut out = Vec::with_capacity(l.links.len() * 6);
    for k in &l.links {
        out.extend_from_slice(&[k.ground.x, k.ground.y, k.ground.z, k.air.x, k.air.y, k.air.z]);
    }
    out
}

/// The live seams' links.
pub fn seams(seams: &[nav_query::seams::Seam]) -> Vec<f32> {
    let mut out = Vec::new();
    for s in seams {
        for l in &s.poly_links {
            seg(&mut out, l.a0, l.a1, 0.0);
        }
        for l in &s.leaf_links {
            seg(&mut out, l.min, l.max, 1.0);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_format::{NavLink, NavPoly};

    #[test]
    fn a_two_triangle_square_draws_its_outline_and_one_shared_edge() {
        let nav = NavMeshData {
            verts: vec![Float3::new(0.0, 0.0, 0.0), Float3::new(1.0, 0.0, 0.0), Float3::new(1.0, 0.0, 1.0), Float3::new(0.0, 0.0, 1.0)],
            poly_verts: vec![0, 1, 2, 0, 2, 3],
            polys: vec![
                NavPoly { vert_start: 0, vert_count: 3, link_start: 0, link_count: 1, ..Default::default() },
                NavPoly { vert_start: 3, vert_count: 3, link_start: 1, link_count: 1, ..Default::default() },
            ],
            links: vec![
                NavLink { to_poly: 1, portal_a: Float3::new(1.0, 0.0, 1.0), portal_b: Float3::new(0.0, 0.0, 0.0), ..Default::default() },
                NavLink { to_poly: 0, portal_a: Float3::new(0.0, 0.0, 0.0), portal_b: Float3::new(1.0, 0.0, 1.0), ..Default::default() },
            ],
            ..Default::default()
        };
        let lines = navmesh_lines(&nav);
        assert_eq!(lines.len() / 7, 5);
        assert_eq!(lines.chunks(7).filter(|l| l[6] == LINE_INTERNAL).count(), 1);
        assert_eq!(navmesh_triangles(&nav).len(), 22);
    }
}
