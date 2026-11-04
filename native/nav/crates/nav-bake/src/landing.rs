//! Takeoff/landing links between a navmesh and a flight volume (`Authoring/Baking/Jobs/BuildLandingLinksJob.cs`, and
//! the pair gathering of `NavigationBakingSystem.BuildLandingLinks`).
//!
//! Floor-bin polygons up to the pair's slope limit get a link at their centre, and large polygons a few more towards
//! their corners; each link's air point is the first free flight cell straight above the ground point, searched from
//! just above the ground up to the flyer's radius plus a few cells (the ground's own padding is blocked up to about
//! the radius). No free cell in that range (a low roof, a ledge under an overhang) means no link.
//!
//! Entry points: [`landing_pairs`] (which (navmesh group, volume group) pairs to build, with their steepest slope),
//! [`build_landing_links`] (one pair), [`build_all_landing_links`] (all pairs).
use nav_format::{NavLandingLink, NavLandingLinksData, NavMeshData, NavVolumeData};
use nav_math::exact;
use nav_math::math::{self, clamp};
use nav_math::{Float3, Hash128};

use crate::settings::{BakeFlyer, BakeProfile};
use crate::volume::{base_cell_size, cell_size_at, leaf_at};

/// Flight cells searched past the radius (`ExtraCells`).
const EXTRA_CELLS: f32 = 3.0;

/// A walking-and-flying agent type and the pair it links through (`NavBakeHybrid`).
#[derive(Clone, Debug, PartialEq)]
pub struct LandingHybrid {
    pub id: Hash128,
    pub name: String,
    /// Index into [`LandingPairs::pairs`].
    pub pair: usize,
}

/// The (navmesh group, flight volume group) pairs some agent type walks on and flies through.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LandingPairs {
    /// (navmesh group, volume group), in order of first appearance.
    pub pairs: Vec<(i32, i32)>,
    /// Per pair: the cosine of the steepest landing slope any of its agent types takes.
    pub min_slope_cos: Vec<f32>,
    pub hybrids: Vec<LandingHybrid>,
}

/// Pairs are found from the agent types listed as both walker and flyer (`agents`, `flyers`, with their groups from
/// `Grouping::agent_group`), each built once with the steepest landing slope among its agent types.
pub fn landing_pairs(
    agents: &[BakeProfile],
    flyers: &[BakeFlyer],
    agent_group: &[usize],
    flyer_group: &[usize],
) -> LandingPairs {
    let mut out = LandingPairs::default();
    for (a, agent) in agents.iter().enumerate() {
        for (f, flyer) in flyers.iter().enumerate() {
            if agent.id != flyer.id {
                continue;
            }
            let pair = (agent_group[a] as i32, flyer_group[f] as i32);
            let cos = exact::cos(exact::radians(clamp(flyer.max_landing_slope_deg, 0.0, 89.0)));
            let mut p = 0;
            while p < out.pairs.len() && out.pairs[p] != pair {
                p += 1;
            }
            if p == out.pairs.len() {
                out.pairs.push(pair);
                out.min_slope_cos.push(cos);
            } else {
                out.min_slope_cos[p] = math::min(out.min_slope_cos[p], cos);
            }
            out.hybrids.push(LandingHybrid { id: agent.id, name: agent.name.clone(), pair: p });
        }
    }
    out
}

/// Builds every pair's links (`navs` by navmesh group, `volumes` by volume group; a missing one gives `None` for the
/// pair, as the C# leaves the output unset).
pub fn build_all_landing_links(
    navs: &[Option<&NavMeshData>],
    volumes: &[Option<&NavVolumeData>],
    pairs: &LandingPairs,
) -> Vec<Option<NavLandingLinksData>> {
    pairs
        .pairs
        .iter()
        .zip(&pairs.min_slope_cos)
        .map(|(&(n, v), &min_cos)| match (navs.get(n as usize).copied().flatten(), volumes.get(v as usize).copied().flatten()) {
            (Some(nav), Some(volume)) => Some(build_landing_links(nav, volume, min_cos)),
            _ => None,
        })
        .collect()
}

/// `BuildLandingLinksJob.Execute` for one pair: floor-bin polygons whose normal is at least `min_slope_cos` up get
/// links; the result's `poly_start` has one entry per polygon plus one, `leaf_start` one per leaf plus one, `by_leaf`
/// groups links by leaf (a stable counting sort).
pub fn build_landing_links(nav: &NavMeshData, volume: &NavVolumeData, min_slope_cos: f32) -> NavLandingLinksData {
    let mut links: Vec<NavLandingLink> = Vec::with_capacity(256);
    let mut poly_start = vec![0i32; nav.polys.len() + 1];
    let up = Float3::new(0.0, 1.0, 0.0);

    for (p, poly) in nav.polys.iter().enumerate() {
        poly_start[p] = links.len() as i32;
        if poly.bin != 0 {
            continue; // floors only, for now
        }
        let slope_cos = poly.normal.dot(up);
        if slope_cos < min_slope_cos {
            continue;
        }

        try_add(volume, p as i32, poly.center, slope_cos, &mut links);

        // Large polygons: also part-way to each corner, so links aren't sparse on big floors.
        let vert = |i: i32| nav.verts[nav.poly_verts[(poly.vert_start + i) as usize] as usize];
        let mut reach = 0f32;
        for i in 0..poly.vert_count {
            reach = math::max(reach, poly.center.distance(vert(i)));
        }
        if reach < 4.0 * base_cell_size(volume) {
            continue;
        }
        for i in 0..poly.vert_count {
            try_add(volume, p as i32, poly.center.lerp(vert(i), 0.6), slope_cos, &mut links);
        }
    }

    poly_start[nav.polys.len()] = links.len() as i32;
    build(volume, &links, poly_start)
}

fn try_add(v: &NavVolumeData, poly: i32, ground: Float3, slope_cos: f32, links: &mut Vec<NavLandingLink>) {
    let top = v.agent_radius + EXTRA_CELLS * base_cell_size(v);
    let mut h = 0.5 * cell_size_at(v, ground);
    while h <= top {
        let air = ground + Float3::new(0.0, h, 0.0);
        let leaf = leaf_at(v, air);
        if leaf >= 0 {
            // One link per (polygon, leaf): a big open leaf above a polygon would otherwise get several.
            let mut i = links.len();
            while i > 0 && links[i - 1].poly == poly {
                i -= 1;
                if links[i].leaf == leaf {
                    return;
                }
            }
            links.push(NavLandingLink { poly, leaf, ground, air, slope_cos });
            return;
        }
        let step = 0.5 * cell_size_at(v, ground + Float3::new(0.0, h, 0.0));
        if step.is_nan() || step <= 0.0 {
            return; // a zero-sized cell would never advance (the C# would loop forever)
        }
        h += step;
    }
}

fn build(v: &NavVolumeData, links: &[NavLandingLink], poly_start: Vec<i32>) -> NavLandingLinksData {
    // Group by leaf with a counting sort: stable, so the result only depends on the links' order.
    let mut leaf_start = vec![0i32; v.leaves.len() + 1];
    for link in links {
        leaf_start[link.leaf as usize + 1] += 1;
    }
    for l in 0..v.leaves.len() {
        leaf_start[l + 1] += leaf_start[l];
    }
    let mut fill = vec![0i32; v.leaves.len()];
    let mut by_leaf = vec![0i32; links.len()];
    for (i, link) in links.iter().enumerate() {
        let leaf = link.leaf as usize;
        by_leaf[(leaf_start[leaf] + fill[leaf]) as usize] = i as i32;
        fill[leaf] += 1;
    }
    NavLandingLinksData { links: links.to_vec(), poly_start, by_leaf, leaf_start }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::build_area_table;
    use crate::volume::{bake_flight_volumes_from_triangles, FlightVolumeInput};
    use nav_format::NavPoly;

    fn f3(x: f32, y: f32, z: f32) -> Float3 {
        Float3::new(x, y, z)
    }

    /// A navmesh of floor quads, one polygon each: `(min x, min z, max x, max z, y, normal)`.
    fn nav_of(quads: &[(f32, f32, f32, f32, f32, Float3)]) -> NavMeshData {
        let mut nav = NavMeshData::default();
        for &(x0, z0, x1, z1, y, normal) in quads {
            let start = nav.verts.len() as i32;
            nav.verts.extend([f3(x0, y, z0), f3(x0, y, z1), f3(x1, y, z1), f3(x1, y, z0)]);
            let vert_start = nav.poly_verts.len() as i32;
            nav.poly_verts.extend([start, start + 1, start + 2, start + 3]);
            nav.polys.push(NavPoly {
                vert_start,
                vert_count: 4,
                bin: 0,
                area: 1,
                center: f3((x0 + x1) * 0.5, y, (z0 + z1) * 0.5),
                normal,
                ..NavPoly::default()
            });
        }
        nav
    }

    /// The 12 triangles of an axis-aligned box.
    fn floor_tris(min: Float3, max: Float3) -> Vec<[Float3; 3]> {
        let p = |x: bool, y: bool, z: bool| {
            f3(if x { max.x } else { min.x }, if y { max.y } else { min.y }, if z { max.z } else { min.z })
        };
        let face = |a: Float3, b: Float3, c: Float3, d: Float3| [[a, b, c], [a, c, d]];
        let mut t = Vec::new();
        t.extend(face(p(false, true, false), p(false, true, true), p(true, true, true), p(true, true, false)));
        t.extend(face(p(false, false, false), p(true, false, false), p(true, false, true), p(false, false, true)));
        t.extend(face(p(false, false, false), p(false, false, true), p(false, true, true), p(false, true, false)));
        t.extend(face(p(true, false, false), p(true, true, false), p(true, true, true), p(true, false, true)));
        t.extend(face(p(false, false, false), p(false, true, false), p(true, true, false), p(true, false, false)));
        t.extend(face(p(false, false, true), p(true, false, true), p(true, true, true), p(false, true, true)));
        t
    }

    fn floor_volume(headroom: f32) -> NavVolumeData {
        let flyers = [BakeFlyer::test_flyer(0.5, 1.0, headroom, 100, 30.0)];
        let tris = floor_tris(f3(0.0, 0.0, 0.0), f3(16.0, 1.0, 16.0));
        let input = FlightVolumeInput {
            flyers: &flyers,
            modifier_volumes: &[],
            resolution_volumes: &[],
            area_table: &build_area_table(&[]),
            bounded: false,
        };
        let mut out = bake_flight_volumes_from_triangles(&tris, f3(0.0, 0.0, 0.0), f3(16.0, 4.0, 16.0), &input);
        out.volumes.remove(0)
    }

    #[test]
    fn a_floor_links_to_the_air_above_it() {
        let v = floor_volume(3.0);
        let nav = nav_of(&[(2.0, 2.0, 4.0, 4.0, 1.0, f3(0.0, 1.0, 0.0))]);
        let cos30 = exact::cos(exact::radians(30.0));
        let links = build_landing_links(&nav, &v, cos30);
        assert_eq!(links.links.len(), 1); // small polygon: centre only
        let l = links.links[0];
        assert_eq!((l.poly, l.ground), (0, f3(3.0, 1.0, 3.0)));
        // The cell just above the floor is blocked by the radius padding: the first free sample is 2.0 above the floor.
        assert_eq!(l.air, f3(3.0, 3.0, 3.0));
        assert!(l.leaf >= 0 && leaf_at(&v, l.air) == l.leaf);
        assert_eq!(l.slope_cos, 1.0);
        assert_eq!(links.poly_start, vec![0, 1]);
        assert_eq!(links.leaf_start.len(), v.leaves.len() + 1);
        assert_eq!(links.leaf_start[v.leaves.len()], 1);
        assert_eq!(links.by_leaf, vec![0]);
        assert_eq!(links.leaf_start[l.leaf as usize + 1] - links.leaf_start[l.leaf as usize], 1);
    }

    #[test]
    fn large_polygons_get_corner_links_into_distinct_leaves_only() {
        let v = floor_volume(3.0);
        let nav = nav_of(&[(0.0, 0.0, 16.0, 16.0, 1.0, f3(0.0, 1.0, 0.0))]);
        let links = build_landing_links(&nav, &v, 0.5);
        // Centre plus four corners (reach 11.3 >= 4 base cells); each air point's leaf is unique per polygon.
        assert!(links.links.len() >= 2 && links.links.len() <= 5, "{}", links.links.len());
        let mut leaves: Vec<i32> = links.links.iter().map(|l| l.leaf).collect();
        leaves.sort_unstable();
        leaves.dedup();
        assert_eq!(leaves.len(), links.links.len());
        assert_eq!(links.poly_start, vec![0, links.links.len() as i32]);
        // by_leaf is a permutation grouped by leaf.
        let mut seen = links.by_leaf.clone();
        seen.sort_unstable();
        assert_eq!(seen, (0..links.links.len() as i32).collect::<Vec<_>>());
    }

    #[test]
    fn steep_slopes_get_no_links() {
        let v = floor_volume(3.0);
        let steep = f3(0.0, 1.0, 0.0); // straight up: cos 1, for contrast
        let tilted = f3(0.866, 0.5, 0.0); // 60 degrees from up: cos 0.5
        let nav = nav_of(&[
            (2.0, 2.0, 4.0, 4.0, 1.0, tilted),
            (6.0, 6.0, 8.0, 8.0, 1.0, steep),
            (10.0, 10.0, 12.0, 12.0, 1.0, tilted),
        ]);
        let cos30 = exact::cos(exact::radians(30.0));
        let links = build_landing_links(&nav, &v, cos30);
        assert_eq!(links.links.len(), 1);
        assert_eq!(links.links[0].poly, 1);
        assert_eq!(links.poly_start, vec![0, 0, 1, 1]);
        // A 61 degree limit takes the tilted ones too.
        let cos60 = exact::cos(exact::radians(61.0));
        assert_eq!(build_landing_links(&nav, &v, cos60).links.len(), 3);
    }

    #[test]
    fn walls_and_ceilings_are_not_floors_and_roofs_block_links() {
        let v = floor_volume(3.0);
        let mut nav = nav_of(&[(2.0, 2.0, 4.0, 4.0, 1.0, f3(0.0, 1.0, 0.0))]);
        nav.polys[0].bin = 3;
        assert!(build_landing_links(&nav, &v, 0.0).links.is_empty());

        // A ground point outside the volume finds no free cell.
        let nav = nav_of(&[(40.0, 40.0, 42.0, 42.0, 1.0, f3(0.0, 1.0, 0.0))]);
        assert!(build_landing_links(&nav, &v, 0.0).links.is_empty());
    }

    #[test]
    fn deterministic() {
        let v = floor_volume(3.0);
        let nav = nav_of(&[(0.0, 0.0, 16.0, 16.0, 1.0, f3(0.0, 1.0, 0.0)), (2.0, 2.0, 4.0, 4.0, 1.0, f3(0.0, 1.0, 0.0))]);
        assert_eq!(build_landing_links(&nav, &v, 0.5), build_landing_links(&nav, &v, 0.5));
    }

    #[test]
    fn pairs_take_the_steepest_slope_per_pair() {
        let walker = |id: u32| BakeProfile::test_profile(false, false, false, id);
        let agents = [walker(1), walker(2), walker(3)];
        let mut f1 = BakeFlyer::test_flyer(0.5, 1.0, 0.0, 1, 60.0);
        f1.name = "a".into();
        let f2 = BakeFlyer::test_flyer(0.5, 1.0, 0.0, 2, 20.0);
        let f3_ = BakeFlyer::test_flyer(0.5, 1.0, 0.0, 9, 45.0); // flies only: no pair
        let pairs = landing_pairs(&agents, &[f1, f2, f3_], &[0, 0, 1], &[0, 0, 1]);
        assert_eq!(pairs.pairs, vec![(0, 0)]);
        let expect = exact::cos(exact::radians(20.0));
        assert_eq!(pairs.min_slope_cos[0], math::min(exact::cos(exact::radians(60.0)), expect));
        assert_eq!(pairs.hybrids.len(), 2);
        assert!(pairs.hybrids.iter().all(|h| h.pair == 0));
    }
}
