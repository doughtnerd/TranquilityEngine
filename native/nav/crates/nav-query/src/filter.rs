//! The query filter (Foxfire's `NavMeshQueryFilter`, `NavFold`, `NavAreas.ResolveCosts`, `NavCongestion`'s query
//! side): the per-agent rules every walking query follows. The C# passes runtime state (closed gates, switched-off
//! polygons, the congestion table) as `NativeArray`s; here they are borrowed slices.
use nav_format::consts::{NavAreas, NavGates};
use nav_format::{NavAreaInfo, NavPoly};
use nav_math::math::{self, max, min};
use nav_math::Hash128;

/// `NavFold.Delta`: how sharp a fold is, 0 to pi/2 radians: `min(angle, pi - angle)`.
pub fn nav_fold_delta(fold_angle: f32) -> f32 {
    min(fold_angle, math::PI - fold_angle)
}

/// A filter's cost multiplier per area id (`FixedList512Bytes<float>`: up to 64 here, one per area id).
#[derive(Clone, Copy, Debug)]
pub struct AreaCosts {
    values: [f32; 64],
    len: usize,
}

impl Default for AreaCosts {
    fn default() -> Self {
        Self::new()
    }
}

impl AreaCosts {
    /// Empty: every area costs 1.
    pub const fn new() -> Self {
        Self { values: [0.0; 64], len: 0 }
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub fn clear(&mut self) {
        self.len = 0;
    }
    /// Appends a cost (area id = the number of costs before it). Ignored past 64.
    pub fn push(&mut self, cost: f32) {
        if self.len < 64 {
            self.values[self.len] = cost;
            self.len += 1;
        }
    }
    pub fn as_slice(&self) -> &[f32] {
        &self.values[..self.len]
    }
    /// Sets an existing entry's cost.
    pub fn set(&mut self, area: usize, cost: f32) {
        self.values[area] = cost;
    }
    /// The cost multiplier for an area; 1 for areas it has no entry for.
    #[inline]
    pub fn cost(&self, area: i32) -> f32 {
        if area >= 0 && (area as usize) < self.len {
            self.values[area as usize]
        } else {
            1.0
        }
    }
}

/// An agent's override of one area (`NavMeshAgentAreaCost`): matched by the area's asset id.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AreaCostOverride {
    pub area_id: Hash128,
    pub excluded: bool,
    /// < 0 = the area's default cost.
    pub cost: f32,
}

/// `NavAreas.ResolveCosts`: an agent's cost per area id: a baked area table's default costs, then the agent's
/// overrides and exclusions, matched by area id. `min_cost` is the cheapest area the agent may enter, for A*
/// heuristics. Leaves everything untouched if the table is empty (every area then costs 1). `costs` must be empty
/// on entry (the C# appends to it).
pub fn resolve_area_costs(
    areas: &[NavAreaInfo],
    overrides: &[AreaCostOverride],
    costs: &mut AreaCosts,
    excluded: &mut u64,
    min_cost: &mut f32,
) {
    let area_count = areas.len().min(NavAreas::MAX as usize + 1);
    if area_count == 0 {
        return; // no area table: every area costs 1
    }
    for a in areas.iter().take(area_count) {
        costs.push(a.cost);
    }
    for o in overrides {
        for a in NavAreas::FIRST_CUSTOM as usize..area_count {
            if areas[a].id != o.area_id {
                continue;
            }
            if o.excluded {
                *excluded |= 1u64 << a;
            }
            if o.cost >= 0.0 {
                costs.set(a, o.cost);
            }
        }
    }
    *min_cost = f32::MAX;
    for a in NavAreas::WALKABLE as usize..area_count {
        if *excluded & (1u64 << a) == 0 {
            *min_cost = min(*min_cost, costs.as_slice()[a]);
        }
    }
    *min_cost = max(*min_cost, 1e-3);
}

/// One navmesh's slice of the frame's congestion reservation table (`NavCongestion`), read-only: per-polygon,
/// per-time-slot counts of agents expected there. The crowd owns and fills the table; a search only reads it.
#[derive(Clone, Copy, Debug)]
pub struct CongestionView<'a> {
    /// The whole table; this navmesh's slice starts at `offset`.
    pub loads: &'a [i32],
    pub offset: usize,
    /// Time slots per polygon.
    pub buckets: i32,
    /// Length of one slot.
    pub bucket_seconds: f32,
}

impl CongestionView<'_> {
    /// `IsCreated`.
    pub fn is_created(&self) -> bool {
        !self.loads.is_empty() && self.buckets > 0
    }
    /// Time slot for a time from now, or -1 beyond the window.
    #[inline]
    pub fn bucket_of(&self, seconds: f32) -> i32 {
        let b = math::floor(max(seconds, 0.0) / self.bucket_seconds) as i32;
        if b < self.buckets {
            b
        } else {
            -1
        }
    }
    #[inline]
    pub fn load(&self, poly: i32, bucket: i32) -> i32 {
        self.loads[self.offset + (poly as usize) * (self.buckets as usize) + bucket as usize]
    }
    /// Agents that fit side by side through a portal of this width (at least 1).
    #[inline]
    pub fn lanes(portal_width: f32, agent_radius: f32) -> f32 {
        max(1.0, math::floor(portal_width / max(2.0 * agent_radius, 1e-3)))
    }
}

/// Per-agent query rules (`NavMeshQueryFilter`). All costs are in world-distance units.
#[derive(Clone, Copy, Debug)]
pub struct NavMeshQueryFilter<'a> {
    /// Bit k set: polygons in orientation bin k may be used.
    pub allowed_bins: u64,
    /// Radians; folds whose [`nav_fold_delta`] is larger are not crossed.
    pub max_fold_angle: f32,
    /// Extra cost per radian of fold.
    pub fold_cost_per_radian: f32,
    /// Extra flat cost for going over a lip (outside corner).
    pub convex_fold_extra_cost: f32,
    /// Multiplies distance travelled on wall polygons.
    pub wall_cost_multiplier: f32,
    /// Multiplies distance travelled on ceiling polygons.
    pub ceiling_cost_multiplier: f32,
    /// Search budget.
    pub max_nodes: i32,

    pub can_jump: bool,
    /// Jump links rising more than this are skipped...
    pub max_jump_up_height: f32,
    /// ...or spanning more than this horizontally...
    pub max_jump_distance: f32,
    /// ...or dropping more than this.
    pub max_fall_distance: f32,
    /// Flat extra cost per jump.
    pub jump_cost: f32,

    /// Cost multiplier per area id (`NavPoly::area`). Empty: every area costs 1.
    pub area_costs: AreaCosts,
    /// Bit a set: polygons in area a are never entered.
    pub excluded_areas: u64,
    /// Cheapest usable area, for the A* heuristic (ignored while `area_costs` is empty).
    pub min_area_cost: f32,

    /// Gate states by gate index (`NavPoly::gate`): polygons of closed gates are never entered. `None`, or shorter
    /// than a gate's index: that gate counts as open.
    pub closed_gates: Option<&'a [bool]>,
    /// By polygon index: polygons an overlay has replaced, never entered or snapped to. `None`: none.
    pub switched_off: Option<&'a [bool]>,

    /// Reservations by other agents. Entering a polygon whose time slot is already full costs `congestion_cost` per
    /// agent over. `None`, or `congestion_cost` 0: congestion is ignored.
    pub congestion: Option<CongestionView<'a>>,
    pub congestion_cost: f32,
    /// To turn distance along the corridor into arrival time.
    pub agent_speed: f32,
    /// To turn portal width into lanes.
    pub agent_radius: f32,
}

impl<'a> NavMeshQueryFilter<'a> {
    /// `default(NavMeshQueryFilter)`: everything zero or off (no bin allowed, so no polygon passes).
    pub fn zeroed() -> Self {
        Self {
            allowed_bins: 0,
            max_fold_angle: 0.0,
            fold_cost_per_radian: 0.0,
            convex_fold_extra_cost: 0.0,
            wall_cost_multiplier: 0.0,
            ceiling_cost_multiplier: 0.0,
            max_nodes: 0,
            can_jump: false,
            max_jump_up_height: 0.0,
            max_jump_distance: 0.0,
            max_fall_distance: 0.0,
            jump_cost: 0.0,
            area_costs: AreaCosts::new(),
            excluded_areas: 0,
            min_area_cost: 0.0,
            closed_gates: None,
            switched_off: None,
            congestion: None,
            congestion_cost: 0.0,
            agent_speed: 0.0,
            agent_radius: 0.0,
        }
    }

    /// `NavMeshQueryFilter.Default(agentRadius)`.
    pub fn default_for(agent_radius: f32) -> Self {
        Self {
            allowed_bins: u64::MAX,
            max_fold_angle: math::PI,
            fold_cost_per_radian: agent_radius,
            convex_fold_extra_cost: 0.0,
            wall_cost_multiplier: 1.0,
            ceiling_cost_multiplier: 1.0,
            max_nodes: 4096,
            can_jump: false,
            ..Self::zeroed()
        }
    }

    /// The cheapest cost per unit of distance the agent can travel anywhere (its cheapest surface and area), so
    /// heuristics scaled by it never overestimate (`CheapestTravel`).
    pub fn cheapest_travel(&self) -> f32 {
        min(1.0, min(self.wall_cost_multiplier, self.ceiling_cost_multiplier))
            * (if self.area_costs.is_empty() { 1.0 } else { min(1.0, self.min_area_cost) })
    }

    /// True if this gate is closed (`NavGates.IsClosed` on the filter's gate states).
    #[inline]
    pub fn gate_closed(&self, gate: i32) -> bool {
        match self.closed_gates {
            Some(closed) => NavGates::is_closed(gate, closed),
            None => false,
        }
    }

    /// `PolyAllowed`: enough vertices, an allowed bin, an area not excluded, a gate not closed.
    #[inline]
    pub fn poly_allowed(&self, poly: &NavPoly) -> bool {
        poly.vert_count >= 3
            && (self.allowed_bins & 1u64.wrapping_shl(poly.bin as u32)) != 0
            && (self.excluded_areas & 1u64.wrapping_shl(poly.area as u32)) == 0
            && !self.gate_closed(poly.gate)
    }

    /// True if an overlay has replaced the polygon.
    #[inline]
    pub fn is_switched_off(&self, poly: i32) -> bool {
        match self.switched_off {
            Some(s) => poly >= 0 && (poly as usize) < s.len() && s[poly as usize],
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_delta_ignores_which_way_the_surfaces_face() {
        for (normals, delta) in [(30.0f32, 30.0f32), (150.0, 30.0), (90.0, 90.0), (0.0, 0.0)] {
            let d = nav_fold_delta(normals.to_radians()).to_degrees();
            assert!((d - delta).abs() < 1e-3, "{normals}: {d}");
        }
    }

    #[test]
    fn area_costs_resolve_with_overrides_and_exclusions() {
        let id = |n: u32| Hash128::new(n, 2, 0, 0);
        let info = |n: u32, cost: f32| NavAreaInfo { id: id(n), cost, ..NavAreaInfo::default() };
        let areas = [info(0, 0.0), info(0, 1.0), info(1, 5.0), info(2, 3.0)];
        let (mut costs, mut excluded, mut min_cost) = (AreaCosts::new(), 0u64, 0.0f32);
        resolve_area_costs(&areas, &[], &mut costs, &mut excluded, &mut min_cost);
        assert_eq!(costs.as_slice(), &[0.0, 1.0, 5.0, 3.0]);
        assert_eq!(min_cost, 1.0);

        let overrides = [
            AreaCostOverride { area_id: id(1), excluded: false, cost: 0.25 },
            AreaCostOverride { area_id: id(2), excluded: true, cost: -1.0 },
        ];
        let (mut costs, mut excluded, mut min_cost) = (AreaCosts::new(), 0u64, 0.0f32);
        resolve_area_costs(&areas, &overrides, &mut costs, &mut excluded, &mut min_cost);
        assert_eq!(costs.cost(2), 0.25);
        assert_eq!(costs.cost(3), 3.0);
        assert_eq!(excluded, 1 << 3);
        assert_eq!(min_cost, 0.25);
        assert_eq!(costs.cost(40), 1.0, "no entry: 1");

        // No table: everything untouched.
        let (mut costs, mut excluded, mut min_cost) = (AreaCosts::new(), 0u64, 7.0f32);
        resolve_area_costs(&[], &overrides, &mut costs, &mut excluded, &mut min_cost);
        assert!(costs.is_empty() && excluded == 0 && min_cost == 7.0);
    }

    #[test]
    fn poly_allowed_follows_bins_areas_and_gates() {
        let poly = NavPoly { vert_count: 4, bin: 2, area: 3, gate: 1, ..NavPoly::default() };
        let mut f = NavMeshQueryFilter::default_for(0.5);
        assert!(f.poly_allowed(&poly));
        f.allowed_bins = !(1 << 2);
        assert!(!f.poly_allowed(&poly));
        f.allowed_bins = u64::MAX;
        f.excluded_areas = 1 << 3;
        assert!(!f.poly_allowed(&poly));
        f.excluded_areas = 0;
        let closed = [false, true];
        f.closed_gates = Some(&closed);
        assert!(!f.poly_allowed(&poly));
        let open = [false, false];
        f.closed_gates = Some(&open);
        assert!(f.poly_allowed(&poly));
        assert!(!f.poly_allowed(&NavPoly { vert_count: 2, ..poly }));
    }

    #[test]
    fn congestion_buckets_and_lanes() {
        let loads = [0, 1, 2, 3];
        let c = CongestionView { loads: &loads, offset: 0, buckets: 2, bucket_seconds: 0.5 };
        assert_eq!(c.bucket_of(0.4), 0);
        assert_eq!(c.bucket_of(0.6), 1);
        assert_eq!(c.bucket_of(1.1), -1);
        assert_eq!(c.load(1, 1), 3);
        assert_eq!(CongestionView::lanes(3.0, 0.5), 3.0);
        assert_eq!(CongestionView::lanes(0.1, 0.5), 1.0);
    }
}
