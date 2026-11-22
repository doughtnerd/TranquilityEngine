//! `anim-bench` (ADR 0340, "Budgets"): criterion benchmarks for the core's budgets, run with
//! `cargo bench`. The budgets are tripwires, logged, never acceptance criteria:
//!
//! - 100 characters, 80 bones, a state machine with a 2D blend space, an upper-body slot, two-bone
//!   IK on both feet and a look-at: ≤ 1.5 ms per frame;
//! - motion matching, 20 characters, a synthetic 30-minute database: ≤ 0.6 ms per frame;
//! - 1,000 property tweens: ≤ 0.2 ms per frame.
//!
//! Stub (T02). Filled by T82r.
