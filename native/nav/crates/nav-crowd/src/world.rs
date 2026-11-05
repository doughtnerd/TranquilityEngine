//! What the host tells the crowd each tick besides commands ([`WorldInput`]), the host targets agents chase, surround
//! and flow to ([`Targets`]), and the avoidance obstacles ([`Obstacles`]).
//!
//! Foxfire reads these from entities (a chased entity's `LocalTransform`, `NavSurround` and `NavFlowGoal` on target
//! entities, `NavAvoidanceObstacle` entities). Myco's targets are scene nodes the TS side knows: it registers them by a
//! [`TargetId`] of its choosing (commands), and sends their positions each tick here. A target that's an agent is named
//! by its [`AgentId`] instead (`TargetRef::Agent`) and needs no input. Surround slots and flow goals attach to host
//! targets only; to surround or flow to an agent, register a target for its node as well.
use crate::components::{NavAvoidanceObstacle, NavAvoidanceObstacleState, NavFlowGoal, NavSurround};
use crate::ids::{AgentId, ObstacleId, SlotTable, TargetId};
use nav_math::Float3;
use std::collections::BTreeMap;

/// A host target's position this tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TargetInput {
    pub id: TargetId,
    pub position: Float3,
}

/// The per-tick input that isn't in the agent and obstacle buffers ([`crate::boundary`]).
#[derive(Clone, Copy, Debug, Default)]
pub struct WorldInput<'a> {
    /// Host targets' positions (any order). Targets not listed keep their last position.
    pub targets: &'a [TargetInput],
}

/// A host target.
#[derive(Clone, Debug, Default)]
pub struct Target {
    pub position: Float3,
    /// `NavSurround` on the target.
    pub surround: Option<NavSurround>,
    /// `NavSurroundHolder`: the agent holding each slot (ground slots, then air slots); grown on the first claim.
    pub holders: Vec<Option<AgentId>>,
    /// `NavFlowGoal` on the target.
    pub flow_goal: Option<NavFlowGoal>,
}

/// The host's targets, by id.
#[derive(Clone, Debug, Default)]
pub struct Targets {
    map: BTreeMap<TargetId, Target>,
}

impl Targets {
    pub fn get(&self, id: TargetId) -> Option<&Target> {
        self.map.get(&id)
    }
    pub fn get_mut(&mut self, id: TargetId) -> Option<&mut Target> {
        self.map.get_mut(&id)
    }
    /// The target, made (at the origin) if new.
    pub fn entry(&mut self, id: TargetId) -> &mut Target {
        self.map.entry(id).or_default()
    }
    pub fn remove(&mut self, id: TargetId) -> bool {
        self.map.remove(&id).is_some()
    }
    pub fn iter(&self) -> impl Iterator<Item = (TargetId, &Target)> {
        self.map.iter().map(|(k, v)| (*k, v))
    }
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (TargetId, &mut Target)> {
        self.map.iter_mut().map(|(k, v)| (*k, v))
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Takes this tick's positions.
    pub fn apply_input(&mut self, input: &[TargetInput]) {
        for t in input {
            self.entry(t.id).position = t.position;
        }
    }
}

/// Avoidance obstacles (`NavAvoidanceObstacle` entities): rows by [`ObstacleId`], like agents
/// ([`crate::agents::AgentStore`]); positions come in through the obstacle buffer ([`crate::boundary`]).
#[derive(Clone, Debug, Default)]
pub struct Obstacles {
    pub slots: SlotTable,
    pub position: Vec<Float3>,
    pub up: Vec<Float3>,
    pub obstacle: Vec<NavAvoidanceObstacle>,
    pub state: Vec<NavAvoidanceObstacleState>,
}

impl Obstacles {
    pub fn reserve(&mut self) -> ObstacleId {
        let (h, grew) = self.slots.reserve();
        if grew {
            let n = self.slots.capacity();
            self.position.resize(n, Float3::default());
            self.up.resize(n, Float3::new(0.0, 1.0, 0.0));
            self.obstacle.resize(n, NavAvoidanceObstacle { radius: 0.0, height: 0.0, layers: 0 });
            self.state.resize(n, NavAvoidanceObstacleState::default());
        }
        ObstacleId(h)
    }

    pub fn activate(&mut self, id: ObstacleId, obstacle: NavAvoidanceObstacle, position: Float3) -> bool {
        if !self.slots.activate(id.0) {
            return false;
        }
        let r = id.row();
        self.obstacle[r] = obstacle;
        self.position[r] = position;
        self.state[r] = NavAvoidanceObstacleState::default();
        true
    }

    pub fn remove(&mut self, id: ObstacleId) -> bool {
        self.slots.free(id.0)
    }

    pub fn is_live(&self, id: ObstacleId) -> bool {
        self.slots.is_live(id.0)
    }

    pub fn live_rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots.live_rows()
    }

    pub fn capacity(&self) -> usize {
        self.slots.capacity()
    }

    /// `NavAvoidanceObstacleState`: velocity measured from the position change since the last tick.
    pub fn measure(&mut self, dt: f32) {
        for r in self.slots.live_rows().collect::<Vec<_>>() {
            let s = &mut self.state[r];
            let p = self.position[r];
            if s.initialized && dt > 0.0 {
                s.velocity = (p - s.previous_position) / dt;
            } else {
                s.velocity = Float3::default();
                s.initialized = true;
            }
            s.previous_position = p;
        }
    }
}
