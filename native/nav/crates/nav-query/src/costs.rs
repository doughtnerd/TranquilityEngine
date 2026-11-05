//! Runtime cost volumes (ADR 0070, new in Myco): oriented boxes placed during play that multiply the cost of travel
//! through the polygons (and flight leaves) whose centres they contain, or make them impassable, without a rebake.
//!
//! A volume applies to some agent types (none listed: all) and to the ground, the air or both. Overlapping volumes
//! multiply; an excluding volume wins over any multiplier. A per-polygon table holds the result for one navmesh and
//! agent type: 1 for untouched polygons, [`EXCLUDED`] for impassable ones. Searches read it through
//! `NavMeshQueryFilter::poly_costs` (walking) or the flight searches' `leaf_costs`, the way they read closed gates.
use nav_format::{NavMeshData, NavVolumeData};
use nav_math::math::min;
use nav_math::{Float3, Hash128};

/// A table entry for a polygon or leaf no agent of the type may enter.
pub const EXCLUDED: f32 = f32::INFINITY;

/// One volume, as the host sends it: the box `center` ± `half_size` in the space `world_to_local` maps world points
/// into (the node's inverse world matrix, rows of a 3x4 affine transform, so scale, rotation and skew all work).
#[derive(Clone, Debug, PartialEq)]
pub struct CostVolume {
    pub world_to_local: [f32; 12],
    pub center: Float3,
    pub half_size: Float3,
    /// Multiplier, >= 0.
    pub cost: f32,
    /// Impassable instead.
    pub excluded: bool,
    /// Agent types it applies to; empty = every type.
    pub agents: Vec<Hash128>,
    /// Applies to navmesh polygons.
    pub ground: bool,
    /// Applies to flight volume leaves.
    pub air: bool,
}

impl CostVolume {
    /// An axis-aligned box (tests, simple hosts).
    pub fn aabb(center: Float3, size: Float3, cost: f32) -> Self {
        Self {
            world_to_local: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            center,
            half_size: size * 0.5,
            cost,
            excluded: false,
            agents: Vec::new(),
            ground: true,
            air: true,
        }
    }

    /// True if the volume applies to this agent type.
    pub fn applies_to(&self, agent_type: Hash128) -> bool {
        self.agents.is_empty() || self.agents.contains(&agent_type)
    }

    /// True if world point `p` is inside the box (faces included).
    pub fn contains(&self, p: Float3) -> bool {
        let m = &self.world_to_local;
        let l = Float3::new(
            m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
            m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
            m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
        );
        let d = l - self.center;
        d.x.abs() <= self.half_size.x && d.y.abs() <= self.half_size.y && d.z.abs() <= self.half_size.z
    }

    /// The volume's multiplier as a table factor ([`EXCLUDED`] when excluding; negative costs count as 0).
    fn factor(&self) -> f32 {
        if self.excluded {
            EXCLUDED
        } else if self.cost.is_nan() {
            1.0
        } else {
            self.cost.max(0.0)
        }
    }
}

/// The combined factor at `p` of the volumes in `active` (1 if none contains it).
fn factor_at(volumes: &[&CostVolume], p: Float3) -> f32 {
    let mut f = 1.0f32;
    for v in volumes {
        if v.contains(p) {
            if v.excluded {
                return EXCLUDED;
            }
            f *= v.factor();
        }
    }
    f
}

/// The volumes that apply to `agent_type` on the ground (`air` false) or in the air.
fn active(volumes: &[CostVolume], agent_type: Hash128, air: bool) -> Vec<&CostVolume> {
    volumes.iter().filter(|v| (if air { v.air } else { v.ground }) && v.applies_to(agent_type)).collect()
}

/// A navmesh's per-polygon table for one agent type: by polygon, its centre's combined factor. None when no volume
/// touches any polygon (every polygon costs 1), so untouched navmeshes need no table.
pub fn poly_cost_table(nav: &NavMeshData, volumes: &[CostVolume], agent_type: Hash128) -> Option<Vec<f32>> {
    let act = active(volumes, agent_type, false);
    if act.is_empty() {
        return None;
    }
    let table: Vec<f32> = nav.polys.iter().map(|p| factor_at(&act, p.center)).collect();
    table.iter().any(|&c| c != 1.0).then_some(table)
}

/// A flight volume's per-leaf table for one agent type, like [`poly_cost_table`] (leaf centres).
pub fn leaf_cost_table(volume: &NavVolumeData, volumes: &[CostVolume], agent_type: Hash128) -> Option<Vec<f32>> {
    let act = active(volumes, agent_type, true);
    if act.is_empty() {
        return None;
    }
    let table: Vec<f32> = volume.leaves.iter().map(|l| factor_at(&act, crate::volume::leaf_center(volume, l))).collect();
    table.iter().any(|&c| c != 1.0).then_some(table)
}

/// The cheapest factor in a table, at most 1 (for A* heuristics: multipliers below 1 make travel cheaper).
pub fn min_cost(table: &[f32]) -> f32 {
    table.iter().fold(1.0f32, |m, &c| min(m, c))
}

/// An entry of a table, 1 past its end or without one.
#[inline]
pub fn cost_at(table: Option<&[f32]>, index: i32) -> f32 {
    match table {
        Some(t) if index >= 0 && (index as usize) < t.len() => t[index as usize],
        _ => 1.0,
    }
}

/// True if a table marks the entry impassable.
#[inline]
pub fn excluded_at(table: Option<&[f32]>, index: i32) -> bool {
    cost_at(table, index) == EXCLUDED
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_format::NavPoly;

    fn nav_with_centres(centres: &[Float3]) -> NavMeshData {
        NavMeshData { polys: centres.iter().map(|&c| NavPoly { center: c, vert_count: 3, ..NavPoly::default() }).collect(), ..NavMeshData::default() }
    }

    #[test]
    fn boxes_multiply_and_exclusion_wins() {
        let nav = nav_with_centres(&[Float3::new(0.0, 0.0, 0.0), Float3::new(5.0, 0.0, 0.0), Float3::new(20.0, 0.0, 0.0)]);
        let a = Hash128::new(1, 0, 0, 0);
        let mut v1 = CostVolume::aabb(Float3::new(0.0, 0.0, 0.0), Float3::splat(4.0), 4.0);
        let v2 = CostVolume::aabb(Float3::new(2.0, 0.0, 0.0), Float3::new(12.0, 2.0, 2.0), 0.5);
        assert_eq!(poly_cost_table(&nav, &[v1.clone(), v2.clone()], a), Some(vec![2.0, 0.5, 1.0]));
        assert_eq!(min_cost(&[2.0, 0.5, 1.0]), 0.5);
        assert_eq!(min_cost(&[4.0]), 1.0);
        v1.excluded = true;
        let t = poly_cost_table(&nav, &[v1, v2], a).unwrap();
        assert!(t[0] == EXCLUDED && excluded_at(Some(&t), 0) && !excluded_at(Some(&t), 1));
        assert_eq!(poly_cost_table(&nav, &[CostVolume::aabb(Float3::new(100.0, 0.0, 0.0), Float3::splat(1.0), 3.0)], a), None, "touches nothing");
        assert_eq!(cost_at(None, 3), 1.0);
    }

    #[test]
    fn agents_and_domains_filter_volumes() {
        let nav = nav_with_centres(&[Float3::default()]);
        let (a, b) = (Hash128::new(1, 0, 0, 0), Hash128::new(2, 0, 0, 0));
        let mut v = CostVolume::aabb(Float3::default(), Float3::splat(2.0), 3.0);
        v.agents = vec![a];
        assert_eq!(poly_cost_table(&nav, std::slice::from_ref(&v), a), Some(vec![3.0]));
        assert_eq!(poly_cost_table(&nav, std::slice::from_ref(&v), b), None);
        v.ground = false;
        assert_eq!(poly_cost_table(&nav, &[v], a), None, "air only");
    }

    #[test]
    fn oriented_boxes_use_the_inverse_matrix() {
        // A node at x = 10, rotated 90 degrees about Y, scaled 2: world-to-local is the inverse.
        // Local (x, z) -> world (10 + 2z, -2x)... inverse: local x = -world z / 2, local z = (world x - 10) / 2.
        let mut v = CostVolume::aabb(Float3::default(), Float3::new(1.0, 1.0, 4.0), 5.0);
        v.world_to_local = [0.0, 0.0, -0.5, 0.0, 0.0, 0.5, 0.0, 0.0, 0.5, 0.0, 0.0, -5.0];
        assert!(v.contains(Float3::new(13.9, 0.0, 0.0)), "local z = 1.95");
        assert!(!v.contains(Float3::new(14.1, 0.0, 0.0)));
        assert!(v.contains(Float3::new(10.0, 0.0, 0.9)));
        assert!(!v.contains(Float3::new(10.0, 0.0, 1.1)), "local x = -0.55");
    }
}
