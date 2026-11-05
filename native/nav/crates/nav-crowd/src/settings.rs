//! Agent type settings and the runtime settings (Foxfire's `NavMeshAgent`, `NavFlightAgent`, `NavAvoidance`,
//! `NavMotion`, `NavigationRuntimeSettings`), with the same fields (snake_case), defaults and helpers.
//!
//! Foxfire bakes each agent type's settings into blobs every agent of the type points at (`NavMeshAgentConfig.Settings`
//! and so on). Here an [`AgentTypeSettings`] holds them as `Arc`s, made once per type from the project settings
//! (ADR 0065's `navigation` section of `project.json`), and agents clone the `Arc`s ([`crate::components`]). The bake
//! only needs the bake-relevant part: [`AgentTypeSettings::to_bake`] gives `nav_bake::settings::NavAgentSettings`.
use nav_bake::settings::{FlightAgent, NavAgentSettings, WalkAgent};
use nav_math::Hash128;
use std::sync::Arc;

/// `NavEase`: how speed eases at the ends of a journey (tween names). The easing maths is `motion.rs`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavEase {
    #[default]
    Constant = 0,
    InSine,
    OutSine,
    InOutSine,
    InQuad,
    OutQuad,
    InOutQuad,
    InCubic,
    OutCubic,
    InOutCubic,
    InQuart,
    OutQuart,
    InOutQuart,
}

/// `NavMotion`: an agent type's motion easing (walking and flying each have one).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavMotion {
    pub ease: NavEase,
    /// Seconds from setting off to full speed (In and InOut eases).
    pub ease_in_time: f32,
    /// Seconds from full speed to the stop at the goal (Out and InOut eases).
    pub ease_out_time: f32,
}

impl Default for NavMotion {
    /// `NavMotion.Default`.
    fn default() -> Self {
        Self { ease: NavEase::Constant, ease_in_time: 1.0, ease_out_time: 1.0 }
    }
}

/// `NavMeshAgent`: a walking agent type's settings (shared by every agent of the type). World units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavMeshAgent {
    // Body
    pub radius: f32,
    pub height: f32,
    pub step_height: f32,
    /// Distance from the surface to the node's pivot, along the surface normal.
    pub pivot_offset: f32,
    // Movement
    pub speed: f32,
    /// Orientation smoothing rate (1/s).
    pub turn_speed: f32,
    pub motion: NavMotion,
    // Surfaces
    pub can_climb_walls: bool,
    pub can_walk_ceilings: bool,
    /// Sharpest fold crossed, 0-90 degrees.
    pub max_fold_angle_deg: f32,
    pub wall_cost_multiplier: f32,
    pub ceiling_cost_multiplier: f32,
    // Jumping
    pub can_jump: bool,
    pub max_jump_up_height: f32,
    pub max_jump_distance: f32,
    pub max_fall_distance: f32,
    pub jump_arc_height: f32,
    pub jump_cost: f32,
    pub jump_apex_speed: f32,
    pub jump_rise_gravity: f32,
    pub jump_fall_gravity: f32,
    // Path following
    pub waypoint_reached_distance: f32,
    pub arrival_distance: f32,
    pub max_snap_distance: f32,
    pub max_search_nodes: i32,
    /// Seconds without getting closer to the next waypoint before skipping it; 0 = never.
    pub stuck_skip_time: f32,
    pub flow_field_portal_middles: bool,
    // Repathing
    /// Seconds between timed repaths; 0 = never on a timer.
    pub repath_interval: f32,
    /// Repath if pushed this far off the current segment; 0 = off.
    pub off_path_distance: f32,
    // Congestion
    pub congestion_cost: f32,
}

impl Default for NavMeshAgent {
    /// `NavMeshAgent.Default()`.
    fn default() -> Self {
        Self {
            radius: 5.0,
            height: 10.0,
            step_height: 2.0,
            pivot_offset: 5.0,
            speed: 50.0,
            turn_speed: 30.0,
            motion: NavMotion::default(),
            can_climb_walls: false,
            can_walk_ceilings: false,
            max_fold_angle_deg: 90.0,
            wall_cost_multiplier: 1.5,
            ceiling_cost_multiplier: 2.0,
            can_jump: false,
            max_jump_up_height: 50.0,
            max_jump_distance: 20.0,
            max_fall_distance: 100.0,
            jump_arc_height: 20.0,
            jump_cost: 1.25,
            jump_apex_speed: 150.0,
            jump_rise_gravity: 40.0,
            jump_fall_gravity: 60.0,
            waypoint_reached_distance: 5.0,
            arrival_distance: 10.0,
            max_snap_distance: 10.0,
            max_search_nodes: 4096,
            stuck_skip_time: 2.0,
            flow_field_portal_middles: false,
            repath_interval: 2.0,
            off_path_distance: 50.0,
            congestion_cost: 30.0,
        }
    }
}

/// `NavFlightAgent`: a flying agent type's settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavFlightAgent {
    pub radius: f32,
    pub speed: f32,
    pub turn_speed: f32,
    pub motion: NavMotion,
    pub waypoint_reached_distance: f32,
    pub arrival_distance: f32,
    pub max_snap_distance: f32,
    pub max_search_nodes: i32,
    pub repath_interval: f32,
    pub off_path_distance: f32,
    // Walking and flying
    /// Longest flight between takeoff and landing; 0 = unlimited.
    pub max_flight_distance: f32,
    pub land_when_out_of_reach: bool,
    pub hover_at_chunk_faces: bool,
    pub flight_cost_multiplier: f32,
    pub takeoff_cost: f32,
    pub landing_cost: f32,
    pub takeoff_speed: f32,
    pub max_landing_slope_deg: f32,
    pub takeoff_height: f32,
    pub walk_instead_ratio: f32,
    // Separation
    pub separation_strength: f32,
    pub separation_radius_scale: f32,
    pub max_separation_neighbors: i32,
    /// Copied from the type's avoidance settings: the layers it is on and pushes off.
    pub layers: u32,
    pub avoid_layers: u32,
}

impl NavFlightAgent {
    pub const DEFAULT_SEPARATION_RADIUS_SCALE: f32 = 1.5;
    pub const DEFAULT_MAX_SEPARATION_NEIGHBORS: i32 = 8;

    /// `PersonalRadius`.
    pub fn personal_radius(&self) -> f32 {
        self.radius * if self.separation_radius_scale > 0.0 { self.separation_radius_scale } else { Self::DEFAULT_SEPARATION_RADIUS_SCALE }
    }

    /// `SeparationNeighbors`: at most 16.
    pub fn separation_neighbors(&self) -> i32 {
        (if self.max_separation_neighbors > 0 { self.max_separation_neighbors } else { Self::DEFAULT_MAX_SEPARATION_NEIGHBORS }).min(16)
    }

    /// `CrossingReach`.
    pub fn crossing_reach(&self) -> f32 {
        self.waypoint_reached_distance.max(2.0 * self.radius).min(0.5 * self.max_snap_distance.max(1.0))
    }
}

impl Default for NavFlightAgent {
    /// `NavFlightAgent.Default()`.
    fn default() -> Self {
        Self {
            radius: 5.0,
            speed: 40.0,
            turn_speed: 30.0,
            motion: NavMotion::default(),
            waypoint_reached_distance: 10.0,
            arrival_distance: 100.0,
            max_snap_distance: 10.0,
            max_search_nodes: 4096 * 2,
            repath_interval: 2.0,
            off_path_distance: 50.0,
            max_flight_distance: 0.0,
            land_when_out_of_reach: false,
            hover_at_chunk_faces: false,
            flight_cost_multiplier: 1.0,
            takeoff_cost: 20.0,
            landing_cost: 20.0,
            takeoff_speed: 20.0,
            max_landing_slope_deg: 30.0,
            takeoff_height: 20.0,
            walk_instead_ratio: 1.5,
            separation_strength: 1.0,
            separation_radius_scale: Self::DEFAULT_SEPARATION_RADIUS_SCALE,
            max_separation_neighbors: Self::DEFAULT_MAX_SEPARATION_NEIGHBORS,
            layers: 1,
            avoid_layers: u32::MAX,
        }
    }
}

/// `NavAvoidance`: an agent type's local avoidance (ORCA) settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavAvoidance {
    /// 0 = the agent's radius.
    pub radius: f32,
    pub neighbor_distance: f32,
    /// At most 30.
    pub max_neighbors: i32,
    pub time_horizon: f32,
    pub obstacle_time_horizon: f32,
    /// 0-99, lower is more important.
    pub priority: i32,
    /// The avoidance layer the agent is on (bits).
    pub layers: u32,
    /// Layers it steers around.
    pub avoid_layers: u32,
}

impl Default for NavAvoidance {
    /// `NavAvoidance.Default()`.
    fn default() -> Self {
        Self {
            radius: 0.0,
            neighbor_distance: 60.0,
            max_neighbors: 10,
            time_horizon: 1.5,
            obstacle_time_horizon: 0.5,
            priority: 50,
            layers: 1,
            avoid_layers: u32::MAX,
        }
    }
}

/// One agent type from the project settings (`NavAgentSettings`): whether it walks, flies or both, its settings for
/// each, and its avoidance. The `Arc`s are what agents of the type share.
#[derive(Clone, Debug)]
pub struct AgentTypeSettings {
    pub id: Hash128,
    pub name: String,
    /// Some: it walks (`Can Walk`).
    pub walk: Option<Arc<NavMeshAgent>>,
    /// Some: it flies (`Can Fly`). Walk and fly: hybrid routes.
    pub flight: Option<Arc<NavFlightAgent>>,
    /// Some: walkers avoid (ORCA); flyers take their layers from it.
    pub avoidance: Option<Arc<NavAvoidance>>,
    /// Lone agents of this type may join groups going to the same place (`Join Groups`).
    pub join_groups: bool,
}

impl AgentTypeSettings {
    /// A walker with default settings.
    pub fn walker(name: &str, id: Hash128, walk: NavMeshAgent) -> Self {
        Self { id, name: name.to_string(), walk: Some(Arc::new(walk)), flight: None, avoidance: None, join_groups: false }
    }

    /// A flyer with default settings.
    pub fn flyer(name: &str, id: Hash128, flight: NavFlightAgent) -> Self {
        Self { id, name: name.to_string(), walk: None, flight: Some(Arc::new(flight)), avoidance: None, join_groups: false }
    }

    pub fn with_avoidance(mut self, avoidance: NavAvoidance) -> Self {
        if let Some(f) = &self.flight {
            let mut f = **f;
            f.layers = avoidance.layers;
            f.avoid_layers = avoidance.avoid_layers;
            self.flight = Some(Arc::new(f));
        }
        self.avoidance = Some(Arc::new(avoidance));
        self
    }

    pub fn can_walk(&self) -> bool {
        self.walk.is_some()
    }

    pub fn can_fly(&self) -> bool {
        self.flight.is_some()
    }

    /// The bake's view of the type (`nav_bake::settings::NavAgentSettings`): only what shapes the navmesh and volume.
    pub fn to_bake(&self) -> NavAgentSettings {
        let mut a = NavAgentSettings::new(&self.name, self.id);
        a.can_walk = self.walk.is_some();
        if let Some(w) = &self.walk {
            a.walk = WalkAgent {
                radius: w.radius,
                height: w.height,
                step_height: w.step_height,
                can_climb_walls: w.can_climb_walls,
                can_walk_ceilings: w.can_walk_ceilings,
                can_jump: w.can_jump,
                max_jump_up_height: w.max_jump_up_height,
                max_jump_distance: w.max_jump_distance,
                max_fall_distance: w.max_fall_distance,
                jump_arc_height: w.jump_arc_height,
            };
        }
        a.can_fly = self.flight.is_some();
        if let Some(f) = &self.flight {
            a.flight = FlightAgent { radius: f.radius, max_landing_slope_deg: f.max_landing_slope_deg };
        }
        a
    }
}

/// The project's agent types, by id. Agents name their type by id ([`crate::components::AgentDesc::agent_type`]).
#[derive(Clone, Debug, Default)]
pub struct AgentTypes {
    types: Vec<AgentTypeSettings>,
}

impl AgentTypes {
    pub fn new(types: Vec<AgentTypeSettings>) -> Self {
        let mut types = types;
        types.sort_by_key(|t| t.id);
        types.dedup_by_key(|t| t.id);
        Self { types }
    }

    pub fn get(&self, id: Hash128) -> Option<&AgentTypeSettings> {
        self.types.binary_search_by_key(&id, |t| t.id).ok().map(|i| &self.types[i])
    }

    pub fn iter(&self) -> impl Iterator<Item = &AgentTypeSettings> {
        self.types.iter()
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }
}

/// `NavigationRuntimeSettings`: the world's runtime budgets and switches.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavigationRuntimeSettings {
    /// Most ground path searches running at once; 0 = 256.
    pub max_paths_per_frame: i32,
    /// Seconds ahead agents reserve polygons (congestion); 0 = off.
    pub congestion_window: f32,
    pub congestion_slot: f32,
    pub congestion_repath_interval: f32,
    pub idle_agents_hold_ground: bool,
    /// 0 = 64.
    pub flow_field_memory_mb: f32,
    /// Frames between an avoiding agent's full neighbour searches; 0 = 3.
    pub avoidance_neighbor_refresh: i32,
}

impl NavigationRuntimeSettings {
    pub const DEFAULT_MAX_PATHS_PER_FRAME: i32 = 32;
    pub const DEFAULT_CONGESTION_WINDOW: f32 = 4.0;
    pub const DEFAULT_CONGESTION_SLOT: f32 = 0.5;
    pub const DEFAULT_CONGESTION_REPATH_INTERVAL: f32 = 1.5;
    pub const DEFAULT_AVOIDANCE_NEIGHBOR_REFRESH: i32 = 3;
    pub const DEFAULT_FLOW_FIELD_MEMORY_MB: f32 = 64.0;

    pub fn avoidance_refresh_frames(&self) -> i32 {
        if self.avoidance_neighbor_refresh > 0 { self.avoidance_neighbor_refresh } else { Self::DEFAULT_AVOIDANCE_NEIGHBOR_REFRESH }
    }

    pub fn flow_field_memory_bytes(&self) -> usize {
        ((if self.flow_field_memory_mb > 0.0 { self.flow_field_memory_mb } else { Self::DEFAULT_FLOW_FIELD_MEMORY_MB }) * 1024.0 * 1024.0) as usize
    }

    /// Path searches at once: 0 means 256.
    pub fn path_searches(&self) -> usize {
        if self.max_paths_per_frame > 0 { self.max_paths_per_frame as usize } else { 256 }
    }

    /// `Validated()`.
    pub fn validated(&self) -> Self {
        Self {
            max_paths_per_frame: self.max_paths_per_frame.max(0),
            congestion_window: self.congestion_window.max(0.0),
            congestion_slot: self.congestion_slot.max(0.05),
            congestion_repath_interval: self.congestion_repath_interval.max(0.0),
            idle_agents_hold_ground: self.idle_agents_hold_ground,
            flow_field_memory_mb: self.flow_field_memory_mb.max(0.0),
            avoidance_neighbor_refresh: self.avoidance_neighbor_refresh.max(0),
        }
    }
}

impl Default for NavigationRuntimeSettings {
    fn default() -> Self {
        Self {
            max_paths_per_frame: Self::DEFAULT_MAX_PATHS_PER_FRAME,
            congestion_window: Self::DEFAULT_CONGESTION_WINDOW,
            congestion_slot: Self::DEFAULT_CONGESTION_SLOT,
            congestion_repath_interval: Self::DEFAULT_CONGESTION_REPATH_INTERVAL,
            idle_agents_hold_ground: false,
            flow_field_memory_mb: Self::DEFAULT_FLOW_FIELD_MEMORY_MB,
            avoidance_neighbor_refresh: 0,
        }
    }
}

/// Everything a [`crate::Crowd`] is made with.
#[derive(Clone, Debug, Default)]
pub struct CrowdSettings {
    pub agent_types: AgentTypes,
    pub runtime: NavigationRuntimeSettings,
    /// A label for log lines (Foxfire's world name).
    pub label: String,
}
