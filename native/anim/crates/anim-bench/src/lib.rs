//! `anim-bench` (ADR 0350, "Budgets"): criterion benchmarks for the core's budgets, run with
//! `cargo bench -p anim-bench`. The budgets are tripwires, logged, never acceptance criteria:
//!
//! - 100 characters, 80 bones, a state machine with a 2D blend space, an upper-body slot, two-bone
//!   IK on both feet and a look-at: ≤ 1.5 ms per frame;
//! - motion matching, 20 characters, a synthetic 30-minute database: ≤ 0.6 ms per frame;
//! - 1,000 property tweens: ≤ 0.2 ms per frame.
//!
//! T82r. The scenarios ([`scenario`]) drive the native core through `anim_wasm::init::Core`, the
//! same calls the wasm boundary exports, over the test suites' synthetic skeletons, clips and
//! databases (included from their `tests/common` folders, as the suites include each other's).
//! Two bench targets:
//!
//! - `benches/budgets.rs`: the three budget scenarios end to end (plus the one-clip, crossfade and
//!   locomotion steps toward the first);
//! - `benches/parts.rs`: the parts (sampling 60/80 bones cached/uncached raw/compressed, the rig
//!   stack alone, matching search KD/brute force, tweens, retargeting, skinning matrices).
//!
//! The example `fixtures` writes the same scenarios' files for the Node benchmarks on the built
//! wasm (`anim-wasm/bench_budgets.mjs`): `cargo run --release -p anim-bench --example fixtures -- DIR`.

/// anim-wasm's test helpers: synthetic skeletons and clips (anim-compress's generators, as
/// `common::synth`), the graph builder and the rig records.
#[path = "../../anim-wasm/tests/common/mod.rs"]
#[allow(clippy::all)]
pub mod common;

/// anim-match's test helpers: the 8-bone matching skeleton and procedural gaits.
#[path = "../../anim-match/tests/common/mod.rs"]
#[allow(dead_code, clippy::all)]
pub mod mcommon;

/// anim-retarget's test helpers: parametric humanoid rigs and random poses.
#[path = "../../anim-retarget/tests/common/mod.rs"]
#[allow(dead_code, clippy::all)]
pub mod rcommon;

pub mod scenario;
