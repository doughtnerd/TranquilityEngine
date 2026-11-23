//! Node family `retarget`: the runtime retarget node, calling `anim-retarget` (ADR 0352, T41).
//!
//! # `RETARGET` (kind 0)
//!
//! No inputs. Runs a **source graph** (another graph asset, like a linked graph) on the retarget
//! map's **source skeleton**, inside its own state words, and retargets its output pose onto the
//! instance's skeleton (the map's target) with `RetargetMap::retarget`: chain transfer, root
//! scaling per axis and the IK pinning pass (decision D47). Unreal's "Retarget Pose From Mesh",
//! with the source evaluated in the same instance so the result is deterministic and snapshots
//! stay exact.
//!
//! Parameter words:
//!
//! | word | type | meaning |
//! |---|---|---|
//! | 0 | u32 | the retarget map: a string id bound to a retarget-map asset (`anim-wasm`'s `retarget_map_create`) |
//! | 1 | u32 | the source graph: a string id bound to a graph asset |
//! | 2 | u32 | state capacity: words the source graph may use at the source skeleton's size |
//! | 3 | u32 | depth capacity: the source graph's pose-stack levels (at most 64) |
//! | 4 | u32 | parameter capacity (at most 1024) |
//! | 5, 6, 7 | u32 | the retarget root's translation per model axis x, y, z: 0 scaled by the leg ratio, 1 unscaled, 2 locked (`RootAxis`) |
//! | 8 | u32 | IK goals listed (at most [`MAX_GOALS`]), in the map's goal order |
//! | 9 + 2k | f32 | goal `k`'s pin weight in \[0, 1\] |
//! | 10 + 2k | u32 | a float parameter giving goal `k`'s weight instead (curves drive it through computed parameters), or `NONE` |
//!
//! The source graph's parameters take the values of this graph's parameters of the same name and
//! type, every update (as a linked graph's). A source graph that doesn't fit the capacities, a
//! map whose target isn't the instance's skeleton (bone count), or a missing map or graph makes the
//! node output nothing (alpha 0). Root motion is the source graph's, its translation scaled per
//! axis like the root (scaled: by the leg ratio; locked: none). Timing and the Tracks walk go into
//! the source graph; sync groups and the debugger's walk stop at the boundary.
//!
//! State ([`state`]): the source graph's handle when it fits (else 0), the map's handle, the
//! parameter map, then the source graph's blob. The map's `RetargetScratch` holds nothing between
//! frames (every buffer is rewritten by each call), so it lives with the map asset (one per map,
//! shared by its instances; evaluation is single-threaded) instead of in the blob: the blob alone
//! is the node's state, and snapshots stay exact.
//!
//! The source graph's poses live in the pose stack after the slots the outer graph has reserved
//! ([`EvalContext::with_skeleton`]); the node adds its depth capacity plus two levels to the
//! program's depth, and the host gives the stack room for `pose_slots()` slots of its largest
//! skeleton, so a source skeleton up to the core's `max_bones` fits.

use core::cell::RefCell;

use anim_format::NONE;
use anim_pose::root::RootDelta;
use anim_retarget::{RetargetMap, RetargetOptions, RetargetScratch, RootAxis};

use crate::dispatch::NodeStatus;
use crate::eval::{lerp_into, EvalContext, GraphRef, NodeData, Phase, Program, SkeletonPose};

/// The family's node kinds.
pub mod kind {
    /// Retargets a source graph's pose from another skeleton.
    pub const RETARGET: u16 = 0;
}

/// The most IK goals a node lists (the Humanoid profile has four).
pub const MAX_GOALS: usize = 8;

/// A retarget map as the node sees it (the host's asset).
#[derive(Clone, Copy)]
pub struct RetargetRef<'a> {
    pub map: &'a RetargetMap,
    /// The map's scratch (see the module docs). Borrowed for one retarget call.
    pub scratch: &'a RefCell<RetargetScratch>,
    /// The source skeleton (the source graph evaluates against it).
    pub source: SkeletonPose<'a>,
}

/// The node's state words (then the source graph's blob, after the parameter map).
pub mod state {
    pub const GRAPH: usize = 0;
    pub const MAP: usize = 1;
    pub const MAP_COUNT: usize = 2;
    pub const PARAM_MAP: usize = 3;
}

/// The words of a node (module docs), for compilers and tests.
#[derive(Clone, Copy, Debug)]
pub struct RetargetParams {
    pub map: u32,
    pub graph: u32,
    pub state_capacity: u32,
    pub depth_capacity: u32,
    pub param_capacity: u32,
    pub root_axes: [RootAxis; 3],
    /// Per goal: constant weight and a float parameter (or `NONE`).
    pub goals: [(f32, u32); MAX_GOALS],
    pub goal_count: usize,
}

impl RetargetParams {
    /// The parameter words.
    pub fn words(&self) -> Vec<u32> {
        let axis = |a: RootAxis| match a {
            RootAxis::Scaled => 0,
            RootAxis::Unscaled => 1,
            RootAxis::Locked => 2,
        };
        let n = self.goal_count.min(MAX_GOALS);
        let mut w = vec![
            self.map,
            self.graph,
            self.state_capacity,
            self.depth_capacity,
            self.param_capacity,
            axis(self.root_axes[0]),
            axis(self.root_axes[1]),
            axis(self.root_axes[2]),
            n as u32,
        ];
        for &(weight, param) in &self.goals[..n] {
            w.push(weight.to_bits());
            w.push(param);
        }
        w
    }
}

fn caps(words: &[u32]) -> (u32, u32, u32) {
    let w = |i: usize| words.get(i).copied().unwrap_or(0);
    (w(2), w(3).min(64), w(4).min(1024))
}

/// The extra pose-stack levels a node of `kind` needs (its source graph's), for the program's
/// depth.
pub(crate) fn node_depth(kind: u16, words: &[u32]) -> u32 {
    if kind == kind::RETARGET {
        caps(words).1 + 2
    } else {
        0
    }
}

fn root_axis(w: u32) -> RootAxis {
    match w {
        1 => RootAxis::Unscaled,
        2 => RootAxis::Locked,
        _ => RootAxis::Scaled,
    }
}

/// Whether `graph` fits a node with `words` for a source skeleton of `groups` bone groups.
fn fits(words: &[u32], graph: &Program, groups: usize) -> bool {
    let (cap, depth, params) = caps(words);
    graph.state_words(groups) <= cap as usize
        && graph.pose_slots() <= 4 + 3 * depth as usize
        && graph.param_count() <= params as usize
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::RETARGET => {
            retarget_node(cx, node);
            NodeStatus::Done
        }
        _ => NodeStatus::UnknownKind,
    }
}

/// The active source graph and map of the current node, when both resolve and the map's target
/// is the instance's skeleton.
fn active<'a>(cx: &mut EvalContext<'a>) -> Option<(GraphRef<'a>, RetargetRef<'a>)> {
    let (g, m) = {
        let s = cx.state();
        (s[state::GRAPH], s[state::MAP])
    };
    let assets = cx.assets();
    let graph = assets.graph(g)?;
    let r = assets.retarget(m)?;
    (r.map.target_bone_count() == cx.skeleton().bones()
        && r.map.source_bone_count() == r.source.bones())
    .then_some((graph, r))
}

fn retarget_node(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let (cap, _, pcap) = caps(node.params);
    let blob = state::PARAM_MAP + pcap as usize;
    match cx.phase() {
        Phase::Layout => cx.set_state_words(blob as u32 + cap, 0),
        Phase::Init => init(cx, &node, blob),
        Phase::Update => {
            let Some((graph, r)) = active(cx) else {
                return;
            };
            let base = cx.state_offset() + blob;
            let dt = cx.dt();
            copy_params(cx, base);
            cx.with_skeleton(graph, base, r.source, |cx| cx.update_context(0, dt));
        }
        Phase::Weights => {}
        Phase::Alpha => {
            let Some((graph, r)) = active(cx) else {
                cx.set_alpha(0.0);
                return;
            };
            let base = cx.state_offset() + blob;
            let output = graph.program.output();
            let a = cx.with_skeleton(graph, base, r.source, |cx| cx.eval_alpha(output));
            cx.set_alpha(a);
        }
        Phase::Pose => pose(cx, &node, blob),
        Phase::Root => {
            let Some((graph, r)) = active(cx) else {
                cx.set_root(RootDelta::identity());
                return;
            };
            let base = cx.state_offset() + blob;
            let output = graph.program.output();
            let d = cx.with_skeleton(graph, base, r.source, |cx| cx.eval_root(output));
            let ratio = r.map.leg_ratio();
            let scale = |v: f32, w: u32| match root_axis(w) {
                RootAxis::Scaled => v * ratio,
                RootAxis::Unscaled => v,
                RootAxis::Locked => 0.0,
            };
            let t = d.translation;
            cx.set_root(RootDelta {
                translation: anim_math::AosVec3::new(
                    scale(t.x, node.word(5)),
                    scale(t.y, node.word(6)),
                    scale(t.z, node.word(7)),
                ),
                rotation: d.rotation,
            });
        }
        _ => {
            // Timing and Tracks: the source graph's.
            let Some((graph, r)) = active(cx) else {
                return;
            };
            let base = cx.state_offset() + blob;
            let output = graph.program.output();
            cx.with_skeleton(graph, base, r.source, |cx| cx.run_node(output));
        }
    }
}

fn init(cx: &mut EvalContext<'_>, node: &NodeData<'_>, blob: usize) {
    let g = cx.binding(node.word_or_none(1));
    let m = cx.binding(node.word_or_none(0));
    {
        let s = cx.state();
        s[..blob].fill(0);
        s[state::MAP] = m;
    }
    let assets = cx.assets();
    let Some(r) = assets.retarget(m) else {
        return;
    };
    let Some(graph) = assets.graph(g) else {
        return;
    };
    if !fits(node.params, graph.program, r.source.groups()) {
        return;
    }
    cx.state()[state::GRAPH] = g;
    if active(cx).is_none() {
        cx.state()[state::GRAPH] = 0;
        return;
    }
    // The parameter map: each source-graph parameter's outer parameter of the same name and type.
    let outer = cx.program();
    let inner = graph.program;
    let (_, _, pcap) = caps(node.params);
    let n = inner.param_count().min(pcap as usize);
    for i in 0..n {
        let found = (0..outer.param_count()).find(|&o| {
            outer.param_hash(o) == inner.param_hash(i) && outer.param_type(o) == inner.param_type(i)
        });
        cx.state()[state::PARAM_MAP + i] = found.map_or(NONE, |o| o as u32);
    }
    cx.state()[state::MAP_COUNT] = n as u32;
    let base = cx.state_offset() + blob;
    cx.with_skeleton(graph, base, r.source, |cx| cx.init_all());
    copy_params(cx, base);
}

/// Copies the outer graph's mapped parameters into the source graph's.
fn copy_params(cx: &mut EvalContext<'_>, base: usize) {
    let n = cx.state()[state::MAP_COUNT] as usize;
    for i in 0..n {
        let o = cx.state()[state::PARAM_MAP + i];
        if o == NONE {
            continue;
        }
        let words = cx.param_words(o);
        cx.write_words(base + 4 * i, &words);
    }
}

fn pose(cx: &mut EvalContext<'_>, node: &NodeData<'_>, blob: usize) {
    let out = cx.out();
    let Some((graph, r)) = active(cx) else {
        cx.fill_rest(out);
        return;
    };
    let base = cx.state_offset() + blob;
    let output = graph.program.output();
    let ok = cx.with_skeleton(graph, base, r.source, |cx| {
        let alpha = cx.eval_alpha(output);
        let Some(s0) = cx.push_slot() else {
            return false;
        };
        cx.eval_pose(output, s0);
        if alpha < 1.0 {
            // Less than a whole pose: the rest of it is the source's rest pose (as at the top).
            let rest = cx.skeleton().rest_soa;
            lerp_into(cx.pose_mut(s0), rest, 1.0 - alpha.max(0.0));
        }
        cx.pop_slot();
        true
    });
    let mut weights = [0.0f32; MAX_GOALS];
    let n = (node.word(8) as usize).min(MAX_GOALS);
    for (k, w) in weights.iter_mut().enumerate().take(n) {
        let param = node.word_or_none(10 + 2 * k);
        let v = if param == NONE {
            node.f32_or(9 + 2 * k, 0.0)
        } else {
            cx.param_f32(param)
        };
        *w = if v > 0.0 { v.min(1.0) } else { 0.0 };
    }
    let opts = RetargetOptions {
        root_axes: [
            root_axis(node.word(5)),
            root_axis(node.word(6)),
            root_axis(node.word(7)),
        ],
        ik_weights: &weights[..n],
    };
    let done = ok
        && match (
            cx.scope_region_and_slot(r.source.groups(), out),
            r.scratch.try_borrow_mut(),
        ) {
            (Some((src, dst)), Ok(mut scratch)) => {
                r.map.retarget(src, &opts, &mut scratch, dst).is_ok()
            }
            _ => false,
        };
    if !done {
        cx.fill_rest(out);
    }
}
