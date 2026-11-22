//! Node family `physics`: physical-animation drive targets and the physical-pose blend input, calling `anim-physics`.
//!
//! Seam (T02); filled by T44r. Declare the family's kinds in [`kind`] (append-only `u16`s,
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
