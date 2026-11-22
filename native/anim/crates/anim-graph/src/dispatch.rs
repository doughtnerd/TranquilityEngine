//! The node-dispatch table, written once (T02). A node is a [`Family`] plus a `u16` kind; the table
//! routes it to the family module's `evaluate`, which matches on its own kinds. Adding a node kind
//! changes only its family's module; adding a family is a change to this file (and to the graph
//! format's family ids), which needs the coordinator.

use crate::eval::{EvalContext, NodeData};
use crate::{logic, matching, mixing, physics, plugin, retarget, rig, slots, sources, sync};

/// The node families. The discriminant is the family id stored in `myco.animgraph@1`'s node
/// table: append-only, never renumbered.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    /// Clip players, blend spaces, pose snapshot, reference and bind pose.
    Sources = 0,
    /// State machines, transitions, requests, choosers and the seeded random selector.
    Logic = 1,
    /// Blend by weight, enum and bool; additive; masked layers; mirror.
    Mixing = 2,
    /// Slots with sections and linked graphs.
    Slots = 3,
    /// Sync groups, markers and notify weights.
    Sync = 4,
    /// The rig stack's nodes (`anim-rig`).
    Rig = 5,
    /// Runtime retargeting (`anim-retarget`).
    Retarget = 6,
    /// Motion matching's database node (`anim-match`).
    Matching = 7,
    /// Physical-animation drive targets and the physical-pose blend (`anim-physics`).
    Physics = 8,
    /// Third-party nodes (`anim-plugin-sdk`'s ABI).
    Plugin = 9,
}

impl Family {
    /// Every family, in id order.
    pub const ALL: [Family; 10] = [
        Family::Sources,
        Family::Logic,
        Family::Mixing,
        Family::Slots,
        Family::Sync,
        Family::Rig,
        Family::Retarget,
        Family::Matching,
        Family::Physics,
        Family::Plugin,
    ];

    /// The family with id `id`, or `None` for an id no family has.
    pub fn from_id(id: u8) -> Option<Family> {
        Family::ALL.get(id as usize).copied()
    }

    /// The family's id.
    pub fn id(self) -> u8 {
        self as u8
    }
}

/// What evaluating a node did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeStatus {
    /// The node ran.
    Done,
    /// Its family has no node of this kind (a graph from a newer build): the caller passes the
    /// input pose through and reports once.
    UnknownKind,
}

/// Evaluates one node: routes `kind` to `family`'s module.
pub fn dispatch(
    cx: &mut EvalContext<'_>,
    family: Family,
    kind: u16,
    node: NodeData<'_>,
) -> NodeStatus {
    match family {
        Family::Sources => sources::evaluate(cx, kind, node),
        Family::Logic => logic::evaluate(cx, kind, node),
        Family::Mixing => mixing::evaluate(cx, kind, node),
        Family::Slots => slots::evaluate(cx, kind, node),
        Family::Sync => sync::evaluate(cx, kind, node),
        Family::Rig => rig::evaluate(cx, kind, node),
        Family::Retarget => retarget::evaluate(cx, kind, node),
        Family::Matching => matching::evaluate(cx, kind, node),
        Family::Physics => physics::evaluate(cx, kind, node),
        Family::Plugin => plugin::evaluate(cx, kind, node),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_ids_round_trip() {
        for (i, family) in Family::ALL.iter().enumerate() {
            assert_eq!(family.id() as usize, i);
            assert_eq!(Family::from_id(family.id()), Some(*family));
        }
        assert_eq!(Family::from_id(Family::ALL.len() as u8), None);
    }

    #[test]
    fn every_family_reports_unknown_kinds() {
        // Through the program builder: a node of each family with a kind none has is counted.
        use anim_format::graph::{AnimGraph, AnimGraphView, Node};
        use anim_format::NONE;
        let graph = AnimGraph {
            name: NONE,
            output: 0,
            skeleton: NONE,
            strings: Vec::new(),
            nodes: Family::ALL
                .iter()
                .map(|f| Node {
                    family: f.id(),
                    kind: u16::MAX,
                    inputs_first: 0,
                    inputs_count: 0,
                    params_first: 0,
                    params_count: 0,
                    name: NONE,
                })
                .collect(),
            ..AnimGraph::default()
        };
        let bytes = graph.write().unwrap();
        let program = crate::eval::Program::from_view(&AnimGraphView::parse(&bytes).unwrap()).unwrap();
        assert_eq!(program.unknown_nodes(), Family::ALL.len() as u32);
        let _ = (dispatch, NodeStatus::Done, core::mem::size_of::<EvalContext<'_>>());
        let _: Option<NodeData<'_>> = None;
    }
}
