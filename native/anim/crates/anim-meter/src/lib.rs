//! `anim-meter` (ADR 0340, "Third-party graph and rig nodes"; audio 0338): the instruction-budget
//! (fuel) pass. It rewrites a third-party node module at load so that it counts the work it does
//! and stops at its budget.
//!
//! Compiled into the editor's loader wasm in Phase B, not into the runtime module.
//!
//! Stub (T02). Filled by T45.
