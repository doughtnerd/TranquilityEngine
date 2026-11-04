//! The chunk border band (`NavigationBakingSystem.BuildBorder`, blob layout in `Tiles/NavChunkBorder.cs`).
//!
//! A chunk with bounds keeps what overlays need to rebuild its edge tiles when a neighbour loads: every triangle that
//! reaches into a band along a side face (unclipped, in content order), how far its geometry reaches past each face
//! (`overhang`), and how its navmeshes were built (profiles with their ground grid layout, agent types, area ids).
//! The result is `nav_format::NavChunkBorderData` (`NavChunkBorderBlob`).
//!
//! Self-contained: it reads the bake's triangles (after classification, with bin / profile mask / area filled), the
//! grouped profiles and their tiers' ground grids, and nothing from the tile builder. The orchestrator
//! (`bake.rs`) calls [`build_border`] after the grids and triangles exist.
use nav_format::{NavAreaInfo, NavBorderAgent, NavBorderProfile, NavChunkBorderData};
use nav_math::math;
use nav_math::{Float3, Float4};

use crate::settings::{BakeProfile, Grids, NavChunkBounds};
use crate::types::{border_grid_from, triangle_content_cmp, TriangleData};

/// What [`build_border`] reads.
pub struct BorderInput<'a> {
    pub chunk: &'a NavChunkBounds,
    /// Every bake triangle (navmesh surfaces and obstacles, in content order).
    pub triangles: &'a [TriangleData],
    /// The navmesh groups (profiles), index = profile bit.
    pub profiles: &'a [BakeProfile],
    /// `profile_tier[p]`: profile p's resolution tier (index into the grids' tiers).
    pub profile_tier: &'a [usize],
    pub grids: &'a Grids,
    /// The listed (ungrouped) walking agent types and the group each belongs to.
    pub agents: &'a [BakeProfile],
    pub agent_group: &'a [usize],
    /// The baked area table (id per area index).
    pub area_table: &'a [NavAreaInfo],
}

/// For a chunk with bounds, its border data: how far its geometry reaches past each side face, every triangle in a
/// band along the faces (unclipped), and its profiles, agent types and area ids. `None` without profiles (nothing was
/// baked, so there is nothing to rebuild). The chunk must have bounds (callers pass `Some` only then).
pub fn build_border(input: &BorderInput) -> Option<NavChunkBorderData> {
    if input.profiles.is_empty() {
        return None;
    }
    let min = input.chunk.min;
    let max = input.chunk.max;

    // The band inside each face: the deepest overlay plus the tile border, in the coarsest tier.
    let mut band = 0.0f32;
    for p in 0..input.profiles.len() {
        let ground = input.grids.get(input.profile_tier[p], 0);
        band = math::max(band, (input.chunk.max_overlay_depth * ground.tile_size + ground.border) as f32 * ground.cs);
    }

    let mut overhang = Float4::default();
    let mut picked: Vec<usize> = Vec::with_capacity(256);
    for (i, triangle) in input.triangles.iter().enumerate() {
        let lo = triangle.a.min_v(triangle.b).min_v(triangle.c);
        let hi = triangle.a.max_v(triangle.b).max_v(triangle.c);
        if hi.y < min.y || lo.y > max.y {
            continue;
        }

        let mut take = false;
        for face in 0..4usize {
            let axis = if face & 1 == 0 { 0 } else { 2 }; // XMin, ZMax, XMax, ZMin
            let along = 2 - axis;
            let high = face == 1 || face == 2; // ZMax, XMax
            if lo[along] > max[along] + band || hi[along] < min[along] - band {
                continue; // beside this face
            }

            let reaches_band = if high { hi[axis] >= max[axis] - band } else { lo[axis] <= min[axis] + band };
            take |= reaches_band;
            let beyond = if high { hi[axis] - max[axis] } else { min[axis] - lo[axis] };
            if beyond > 0.0 && lo[along] <= max[along] && hi[along] >= min[along] {
                overhang[face] = math::max(overhang[face], beyond);
            }
        }

        if take {
            picked.push(i);
        }
    }

    // Content order. Ties are identical triangles, so an unstable order can't show; sort_by is stable anyway.
    picked.sort_by(|&a, &b| triangle_content_cmp(&input.triangles[a], &input.triangles[b]));

    let triangles: Vec<TriangleData> = picked.iter().map(|&i| input.triangles[i]).collect();
    let profiles: Vec<NavBorderProfile> = input
        .profiles
        .iter()
        .enumerate()
        .map(|(p, profile)| NavBorderProfile {
            bit: p as i32,
            agent: profile.tile_agent(),
            grid: border_grid_from(input.grids.get(input.profile_tier[p], 0)),
        })
        .collect();
    let agents: Vec<NavBorderAgent> = input
        .agents
        .iter()
        .enumerate()
        .map(|(a, agent)| NavBorderAgent { agent_type: agent.id, profile: input.agent_group[a] as i32 })
        .collect();
    let areas = input.area_table.iter().map(|a| a.id).collect();

    Some(NavChunkBorderData {
        box_min: min,
        box_max: max,
        overhang,
        min_depth: input.chunk.min_overlay_depth,
        max_depth: input.chunk.max_overlay_depth,
        triangles,
        profiles,
        agents,
        areas,
    })
}

/// A triangle's world AABB, for callers that need the same lo/hi the band test uses.
pub fn triangle_bounds(t: &TriangleData) -> (Float3, Float3) {
    (t.a.min_v(t.b).min_v(t.c), t.a.max_v(t.b).max_v(t.c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bins::{BinSetMetadata, OrientationBinSet, OrientationConfig, SurfaceRing};
    use crate::settings::{build_area_table, build_grids, build_tiers, group_agents};
    use nav_math::Hash128;

    fn flat_tri(x0: f32, x1: f32, z0: f32, z1: f32, area: i32) -> TriangleData {
        TriangleData {
            a: Float3::new(x0, 0.0, z0),
            b: Float3::new(x0, 0.0, z1),
            c: Float3::new(x1, 0.0, z0),
            bin: 0,
            walkable_for: 1,
            area,
        }
    }

    fn setup() -> (NavChunkBounds, Vec<BakeProfile>, Grids, Vec<usize>) {
        let cfg = OrientationConfig::DEFAULT;
        let set = OrientationBinSet::create(&cfg, &[SurfaceRing::DEFAULT]).unwrap();
        let meta = BinSetMetadata::new(&set, &cfg);
        let chunk = NavChunkBounds {
            min: Float3::new(0.0, 0.0, 0.0),
            max: Float3::new(64.0, 10.0, 64.0),
            min_overlay_depth: 1,
            max_overlay_depth: 1,
        };
        let bins = set.bake_bins(chunk.min, chunk.max);
        let profile = BakeProfile::test_profile(false, false, false, 1);
        let g = group_agents(&[profile], &[0]);
        let tiers = build_tiers(&g.groups, &[], &[]);
        let grids = build_grids(&tiers, &bins, &meta, 64, Some(&chunk));
        (chunk, g.groups, grids, tiers.profile_tier)
    }

    #[test]
    fn band_and_overhang() {
        let (chunk, profiles, grids, profile_tier) = setup();
        // band = (1 * 64 + 5) * 0.25 = 17.25
        let tris = vec![
            flat_tri(20.0, 30.0, 20.0, 30.0, 1), // middle of the chunk: not in any band
            flat_tri(60.0, 70.0, 20.0, 30.0, 1), // crosses the XMax face by 6
            flat_tri(-4.0, 2.0, 20.0, 30.0, 1),  // crosses the XMin face by 4
            flat_tri(20.0, 30.0, 40.0, 50.0, 1), // within 17.25 of ZMax? 50 >= 64 - 17.25 = 46.75: yes
            flat_tri(200.0, 210.0, 200.0, 210.0, 1), // far away (past no face's band)
        ];
        let agents = [profiles[0].clone()];
        let table = build_area_table(&[]);
        let b = build_border(&BorderInput {
            chunk: &chunk,
            triangles: &tris,
            profiles: &profiles,
            profile_tier: &profile_tier,
            grids: &grids,
            agents: &agents,
            agent_group: &[0],
            area_table: &table,
        })
        .unwrap();
        assert_eq!(b.triangles.len(), 3);
        assert!(!b.triangles.iter().any(|t| t.a.x == 20.0 && t.a.z == 20.0));
        assert!(!b.triangles.iter().any(|t| t.a.x == 200.0));
        // Per face (XMin, ZMax, XMax, ZMin).
        assert_eq!(b.overhang, Float4::new(4.0, 0.0, 6.0, 0.0));
        assert_eq!((b.box_min, b.box_max), (chunk.min, chunk.max));
        assert_eq!((b.min_depth, b.max_depth), (1, 1));
        assert_eq!(b.profiles.len(), 1);
        assert_eq!(b.profiles[0].bit, 0);
        assert_eq!(b.profiles[0].agent.radius, 0.5);
        assert_eq!(b.profiles[0].grid.tile_size, 64);
        assert_eq!(b.agents, vec![NavBorderAgent { agent_type: Hash128::new(1, 0, 0, 0), profile: 0 }]);
        assert_eq!(b.areas.len(), 2);
        // Triangles come out in content order.
        let xs: Vec<f32> = b.triangles.iter().map(|t| t.a.x).collect();
        assert_eq!(xs, vec![-4.0, 20.0, 60.0]);
    }

    #[test]
    fn triangles_above_or_below_the_box_are_skipped() {
        let (chunk, profiles, grids, profile_tier) = setup();
        let mut high = flat_tri(60.0, 70.0, 20.0, 30.0, 1);
        high.a.y = 50.0;
        high.b.y = 50.0;
        high.c.y = 50.0;
        let b = build_border(&BorderInput {
            chunk: &chunk,
            triangles: &[high],
            profiles: &profiles,
            profile_tier: &profile_tier,
            grids: &grids,
            agents: &[],
            agent_group: &[],
            area_table: &[],
        })
        .unwrap();
        assert!(b.triangles.is_empty());
        assert_eq!(b.overhang, Float4::default());
    }

    #[test]
    fn no_profiles_no_border() {
        let (chunk, _, grids, _) = setup();
        let b = build_border(&BorderInput {
            chunk: &chunk,
            triangles: &[],
            profiles: &[],
            profile_tier: &[],
            grids: &grids,
            agents: &[],
            agent_group: &[],
            area_table: &[],
        });
        assert!(b.is_none());
    }

    #[test]
    fn deterministic() {
        let (chunk, profiles, grids, profile_tier) = setup();
        let tris: Vec<_> = (0..20).map(|i| flat_tri(58.0 + i as f32 * 0.3, 70.0, 20.0, 30.0 + i as f32, 1)).collect();
        let run = || {
            build_border(&BorderInput {
                chunk: &chunk,
                triangles: &tris,
                profiles: &profiles,
                profile_tier: &profile_tier,
                grids: &grids,
                agents: &[],
                agent_group: &[],
                area_table: &[],
            })
            .unwrap()
        };
        assert_eq!(run(), run());
        let (lo, hi) = triangle_bounds(&tris[0]);
        assert!(lo.x <= hi.x);
    }
}
