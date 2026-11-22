//! `anim-rig` (ADR 0340): the post-process rig stack.
//!
//! - IK: two-bone, FABRIK, CCD, full-body IK (a FABRIK-based solver over chains with a centre of mass);
//! - look-at and aim;
//! - foot grounder (raycast results are passed in by the boundary);
//! - spring bones (verlet with collision spheres and capsules);
//! - copy, limit and damp constraints;
//! - distance, stride, orientation and motion warping.
//!
//! Solvers work on poses; the graph's `rig` node family (`anim-graph::rig`) calls them.
//! Tested against `anim-offline::rig`.
//!
//! Stub (T02). Filled by T40.
