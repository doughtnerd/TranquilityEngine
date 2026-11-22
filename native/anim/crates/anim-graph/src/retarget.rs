//! Node family `retarget`: the runtime retarget node, calling `anim-retarget`.
//!
//! Seam (T02); filled by T41. Declare the family's kinds in [`kind`] (append-only `u16`s,
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
