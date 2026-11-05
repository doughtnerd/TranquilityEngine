//! Agents' query filters (Foxfire's `NavMeshAgentUtility.ToFilter` and `NavFlightAgent.ToFilter`), shared by every
//! step that searches (path requests, routes, flow fields, avoidance clipping), plus small maths the steps share.
//!
//! The area cost overrides an agent searches with are the world's (`Navigation.setAreaCost`, ADR 0065) and then its own
//! ([`effective_area_costs`]): an agent's own override of an area wins over the world's. Gates, switched-off polygons
//! and congestion are per navmesh and per search: callers set `closed_gates`, `switched_off` and `congestion` on the
//! returned filter.
use crate::components::NavMeshAgentAreaCost;
use crate::settings::NavMeshAgent;
use nav_format::{NavMeshData, NavVolumeData};
use nav_math::{Float3, Float4};
use nav_query::filter::{resolve_area_costs, NavMeshQueryFilter};
use nav_query::volume::{NavVolumeQueryFilter, MAX_AREAS};

/// The world's overrides, then the agent's (an area the agent overrides takes the agent's).
pub fn effective_area_costs(world: &[NavMeshAgentAreaCost], own: &[NavMeshAgentAreaCost]) -> Vec<NavMeshAgentAreaCost> {
    let mut out: Vec<NavMeshAgentAreaCost> = world.iter().filter(|w| !own.iter().any(|o| o.area_id == w.area_id)).copied().collect();
    out.extend_from_slice(own);
    out
}

/// `NavMeshAgentUtility.ToFilter`: an agent's abilities on a navmesh (its bins), and its area costs resolved against
/// the navmesh's area table. No gates, switched-off polygons or congestion.
pub fn walk_filter(agent: &NavMeshAgent, nav: &NavMeshData, area_costs: &[NavMeshAgentAreaCost]) -> NavMeshQueryFilter<'static> {
    let mut allowed = 0u64;
    for (k, bin) in nav.bins.iter().enumerate().take(64) {
        let tilt = bin.tilt_deg;
        let ok = tilt < 45.0 || if tilt <= 135.0 { agent.can_climb_walls } else { agent.can_walk_ceilings };
        if ok {
            allowed |= 1u64 << k;
        }
    }
    let mut f = NavMeshQueryFilter::zeroed();
    f.allowed_bins = allowed;
    f.max_fold_angle = agent.max_fold_angle_deg.to_radians();
    f.fold_cost_per_radian = agent.radius;
    f.convex_fold_extra_cost = 0.0;
    f.wall_cost_multiplier = agent.wall_cost_multiplier;
    f.ceiling_cost_multiplier = agent.ceiling_cost_multiplier;
    f.max_nodes = agent.max_search_nodes;
    f.can_jump = agent.can_jump;
    f.max_jump_up_height = agent.max_jump_up_height;
    f.max_jump_distance = agent.max_jump_distance;
    f.max_fall_distance = agent.max_fall_distance;
    f.jump_cost = agent.jump_cost;
    f.congestion_cost = agent.congestion_cost;
    f.agent_speed = agent.speed;
    f.agent_radius = agent.radius;
    let (mut excluded, mut min_cost) = (0u64, f.min_area_cost);
    resolve_area_costs(&nav.areas, area_costs, &mut f.area_costs, &mut excluded, &mut min_cost);
    f.excluded_areas = excluded;
    f.min_area_cost = min_cost;
    f
}

/// `NavFlightAgent.ToFilter`: the volume's area costs with the agent's overrides and exclusions.
pub fn flight_filter(volume: &NavVolumeData, area_costs: &[NavMeshAgentAreaCost]) -> NavVolumeQueryFilter {
    let mut f = NavVolumeQueryFilter::default();
    let mut costs = nav_query::filter::AreaCosts::new();
    let (mut excluded, mut min_cost) = (0u64, 0.0f32);
    resolve_area_costs(&volume.areas, area_costs, &mut costs, &mut excluded, &mut min_cost);
    for (a, &c) in costs.as_slice().iter().enumerate().take(MAX_AREAS) {
        f.area_costs[a] = c;
        f.area_cost_count = a + 1;
    }
    f.excluded_areas = excluded;
    f.min_area_cost = min_cost;
    f
}

/// Rotates `v` by the unit quaternion `q` (x, y, z, w): `math.mul(q, v)`.
pub fn quat_rotate(q: Float4, v: Float3) -> Float3 {
    let u = Float3::new(q.x, q.y, q.z);
    let t = u.cross(v) * 2.0;
    v + t * q.w + u.cross(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_format::{NavAreaInfo, OrientationBin};
    use nav_math::Hash128;

    #[test]
    fn walk_filter_allows_bins_by_ability_and_resolves_areas() {
        let nav = NavMeshData {
            bins: vec![
                OrientationBin { tilt_deg: 0.0, ..Default::default() },
                OrientationBin { tilt_deg: 90.0, ..Default::default() },
                OrientationBin { tilt_deg: 180.0, ..Default::default() },
            ],
            areas: vec![
                NavAreaInfo::default(),
                NavAreaInfo { cost: 1.0, ..Default::default() },
                NavAreaInfo { id: Hash128::new(9, 0, 0, 0), cost: 3.0, ..Default::default() },
            ],
            ..Default::default()
        };
        let agent = NavMeshAgent { can_climb_walls: true, ..NavMeshAgent::default() };
        let own = [NavMeshAgentAreaCost { area_id: Hash128::new(9, 0, 0, 0), excluded: false, cost: 0.5 }];
        let world = [NavMeshAgentAreaCost { area_id: Hash128::new(9, 0, 0, 0), excluded: true, cost: -1.0 }];
        let costs = effective_area_costs(&world, &own);
        assert_eq!(costs.len(), 1, "the agent's own override wins");
        let f = walk_filter(&agent, &nav, &costs);
        assert_eq!(f.allowed_bins, 0b011);
        assert_eq!(f.area_costs.cost(2), 0.5);
        assert_eq!(f.excluded_areas, 0);
        let f = walk_filter(&agent, &nav, &world);
        assert_ne!(f.excluded_areas & (1 << 2), 0);
    }

    #[test]
    fn quaternion_rotation_turns_up_into_the_rotated_up() {
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let q = Float4::new(0.0, 0.0, s, s); // 90 degrees about z
        let v = quat_rotate(q, Float3::new(0.0, 1.0, 0.0));
        assert!((v - Float3::new(-1.0, 0.0, 0.0)).length() < 1e-5, "{v:?}");
        assert_eq!(quat_rotate(Float4::new(0.0, 0.0, 0.0, 1.0), Float3::new(1.0, 2.0, 3.0)), Float3::new(1.0, 2.0, 3.0));
    }
}
