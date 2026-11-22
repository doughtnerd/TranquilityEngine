//! Node family `sources`: clip players, blend spaces 1D and 2D (triangulated, `follow.glideMs`, root speed), pose snapshot, reference and bind pose.
//!
//! Seam (T02); filled by T13r (clip player) and T31. Declare the family's kinds in [`kind`] (append-only `u16`s,
//! stored in `myco.animgraph@1`) and match on them in [`evaluate`].

use crate::dispatch::NodeStatus;
use crate::eval::{EvalContext, NodeData};

/// The family's node kinds.
pub mod kind {}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(_cx: &mut EvalContext<'_>, kind: u16, _node: NodeData<'_>) -> NodeStatus {
    let _ = kind;
    NodeStatus::UnknownKind
}
