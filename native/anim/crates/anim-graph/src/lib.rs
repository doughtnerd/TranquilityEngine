//! `anim-graph` (ADR 0340, 0342): runs compiled graph programs (`myco.animgraph@1`). State machines
//! (transitions, requests, `travel` pathfinding), blend spaces 1D and 2D (triangulated), slots,
//! linked graphs, sync groups, notify windows, chooser tables.
//!
//! Nodes are grouped in **families**, one module each, so the task that owns a family changes only
//! its module (plan: T31 owns `sources`, `logic`, `mixing`, `slots` and `sync`; T40 `rig`; T41
//! `retarget`; T42 `matching`; T44r `physics`; T45 `plugin`). A node is identified by its
//! [`Family`] and a `u16` kind within the family; [`dispatch`] (written once) routes it to its
//! family's `evaluate`, and the family matches on its own kinds.
//!
//! [`EvalContext`] and [`NodeData`] are the seam T13r filled with the interpreter's state. T31
//! completed the families it owns (`sources`, `logic`, `mixing`, `slots`, `sync`, each module
//! documents its kinds, parameter words and state layout), added update contexts (gated
//! sub-graphs), ancestor inertialization routing, linked-graph program windows, the Timing and
//! Weights phases ([`eval`]), the debugger's report ([`debug`]) and the 2D blend space's
//! triangulation (`sources::triangulate`, leaf L31a). `dispatch.rs` is unchanged.

pub mod debug;
pub mod dispatch;
pub mod eval;

pub mod logic;
pub mod matching;
pub mod mixing;
pub mod physics;
pub mod plugin;
pub mod retarget;
pub mod rig;
pub mod slots;
pub mod sources;
pub mod sync;

pub use dispatch::{dispatch, Family, NodeStatus};
pub use eval::{EvalContext, NodeData};
