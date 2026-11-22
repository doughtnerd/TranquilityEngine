//! Node family `mixing`: blend by weight, enum and bool; additive; masked layers; time scale;
//! mirror; the inertialization node.
//!
//! T13r filled blend-by-weight, the timed crossfade, layers and the inertialization node; T31 adds
//! the rest. Declare the family's kinds in [`kind`] (append-only `u16`s, stored in
//! `myco.animgraph@1`) and match on them in [`evaluate`].
//!
//! # Poses and alpha
//!
//! A node's pose is its *real* part and its alpha says how much of the pose is real (a clip player
//! without a clip has alpha 0; a crossfade from nothing to a clip has the fade's weight). Blends
//! weight each input by its weight times its alpha, so fading a clip into an empty layer fades
//! the layer in, and an input whose effective weight is 0 is never evaluated. A blend's timing
//! ([`Phase::Timing`]) is its heaviest input's.
//!
//! # `BLEND2` (kind 0)
//!
//! Inputs `[a, b]`. Words: 0 `f32` weight of `b` in \[0, 1\]; 1 `u32` a float graph parameter
//! giving the weight instead, or `NONE`. No state.
//!
//! # `CROSSFADE` (kind 1)
//!
//! Inputs `[a, b]`: a timed crossfade between them. Words: 0 `u32` the side shown at start (0 `a`,
//! 1 `b`). State ([`crossfade`]): the active side, the fade's elapsed time and duration, and a
//! pending inertialization request. [`crossfade_to`] starts a fade (0 s is a cut);
//! [`request_inertialization`] asks the inertialization node above for a transition instead of a
//! blend (the switch is then a cut whose pop decays, Bollo's method).
//!
//! # `LAYER` (kind 2)
//!
//! Inputs `[base, overlay]`: the overlay over the base by the layer's weight, through a bone mask.
//! Words: 0 `u32` layer index (its weight is the instance's layer weight of that index), 1 `u32`
//! mode (0 override, 1 additive: the overlay is a delta pose), 2 `u32` mask: a string id of the
//! graph bound to a mask asset, or `NONE` (full body), 3 `f32` weight used when the instance has
//! no weight for the index, 4 `u32` a float parameter that scales the weight, or `NONE`. State
//! ([`layer`]): mask handle, mode. Root motion and timing are the base's.
//!
//! # `INERTIALIZE` (kind 3)
//!
//! Input `[source]`: passes its source through and, after a request
//! ([`EvalContext::request_inertialization`] from a node below it, routed to its nearest ancestor
//! inertialization node, in the same update), decays the difference between the instance's
//! previous output and the source's new pose with `anim-pose`'s inertializer (Bollo's quintic).
//! State ([`inertia`]): active flag, elapsed, duration, the captured poses' time step, a pending
//! flag, the request word, then the three captured poses (previous output, the one before, and
//! the source at the switch), so the transition survives snapshot and restore exactly: each frame
//! re-captures from them and evaluates at the elapsed time.
//!
//! # `BLEND_ENUM` (kind 4) and `BLEND_BOOL` (kind 5)
//!
//! Inputs: one per value (`BLEND_BOOL`: `[false, true]`). Words: 0 `u32` the int or bool
//! parameter that picks, 1 `f32` blend time in seconds (0 snaps). The picked input's weight rises
//! to 1 and the others fall to 0 at `1 / blend time` per second (Unreal's blend poses by enum);
//! a value out of range picks the nearest input. State: the picked index, then one weight per
//! input (at most [`MAX_BLEND_INPUTS`] inputs blend).
//!
//! # `ADDITIVE` (kind 6)
//!
//! Inputs `[base, source]` or `[base, source, reference]`: `source − reference` (or `source` as a
//! delta pose when there is no reference) added onto the base. Words: 0 `f32` weight (1 when
//! absent), 1 `u32` a float parameter giving the weight instead, or `NONE`. Root motion and timing
//! are the base's.
//!
//! # `TIME_SCALE` (kind 7)
//!
//! Input `[child]`, which it gates: the child advances at `dt × scale`. Words: 0 `f32` scale (1
//! when absent), 1 `u32` a float parameter giving it instead, or `NONE`. Negative plays the child
//! backwards.
//!
//! # `MIRROR` (kind 8)
//!
//! Input `[child]`: the child's pose reflected across the plane with normal `axis` through the
//! left/right map (the profile's, written by the compiler; ADR 0342, decision D18's local-frame
//! assumption). Words: 0 `u32` axis (0 X, 1 Y, 2 Z), 1 `u32` a bool parameter that switches it
//! on, or `NONE` (always on), then one `u32` per bone: the bone whose motion it takes (itself for
//! a centre bone; missing or out of range: itself). Root motion is mirrored too.

use anim_format::NONE;
use anim_pose::blend::lerp;
use anim_pose::mirror::mirror_transform;
use anim_pose::root::RootDelta;
use anim_pose::Axis;

use crate::dispatch::NodeStatus;
use crate::eval::{
    mix_roots, pose_from_words, pose_to_words, EvalContext, NodeData, Phase, Timing, SOA_WORDS,
};

/// The family's node kinds.
pub mod kind {
    /// Two inputs by a weight.
    pub const BLEND2: u16 = 0;
    /// A timed crossfade between two inputs.
    pub const CROSSFADE: u16 = 1;
    /// An overlay over a base by weight and mask.
    pub const LAYER: u16 = 2;
    /// Inertialization of transitions requested below it.
    pub const INERTIALIZE: u16 = 3;
    /// One input per value of an int parameter.
    pub const BLEND_ENUM: u16 = 4;
    /// Two inputs by a bool parameter.
    pub const BLEND_BOOL: u16 = 5;
    /// A delta (or a pose minus a reference) added onto a base.
    pub const ADDITIVE: u16 = 6;
    /// Its child at a scaled rate.
    pub const TIME_SCALE: u16 = 7;
    /// Its child mirrored.
    pub const MIRROR: u16 = 8;
}

/// The most inputs a weighted blend (enum, blend space, machine stack) folds.
pub const MAX_BLEND_INPUTS: usize = 32;

/// [`kind::LAYER`] mode: the overlay replaces the base by its weight.
pub const LAYER_OVERRIDE: u32 = 0;
/// [`kind::LAYER`] mode: the overlay is a delta added onto the base.
pub const LAYER_ADDITIVE: u32 = 1;

/// A crossfade's state words.
pub mod crossfade {
    pub const WORDS: u32 = 4;
    /// The side faded to (0 `a`, 1 `b`).
    pub const ACTIVE: usize = 0;
    /// Seconds since the fade started (f32 bits).
    pub const ELAPSED: usize = 1;
    /// The fade's length (f32 bits); 0 is a cut.
    pub const DURATION: usize = 2;
    /// An inertialization to request at the next update (f32 bits, 0 none).
    pub const INERTIA: usize = 3;
}

/// A layer's state words.
pub mod layer {
    pub const WORDS: u32 = 2;
    /// The mask's asset handle (0: full body).
    pub const MASK: usize = 0;
    /// `LAYER_OVERRIDE` or `LAYER_ADDITIVE`.
    pub const MODE: usize = 1;
}

/// An inertialization node's state words (fixed part; then three poses of `SOA_WORDS` per group).
pub mod inertia {
    pub const FIXED_WORDS: u32 = 6;
    pub const ACTIVE: usize = 0;
    pub const ELAPSED: usize = 1;
    pub const DURATION: usize = 2;
    pub const CAPTURE_DT: usize = 3;
    pub const PENDING: usize = 4;
    /// The longest duration requested by nodes below since the last update (f32 bits, 0 none).
    pub const REQUEST: usize = 5;
}

/// The parameter words of a [`kind::LAYER`].
pub fn layer_params(index: u32, mode: u32, mask: u32, weight: f32) -> [u32; 4] {
    [index, mode, mask, weight.to_bits()]
}

/// Starts a fade on a crossfade's state to `side` (0 or 1) over `duration` seconds (≤ 0: a cut).
pub fn crossfade_to(state: &mut [u32], side: u32, duration: f32) {
    state[crossfade::ACTIVE] = side.min(1);
    state[crossfade::ELAPSED] = 0.0f32.to_bits();
    let d = if duration.is_finite() && duration > 0.0 {
        duration
    } else {
        0.0
    };
    state[crossfade::DURATION] = d.to_bits();
}

/// Asks, at the crossfade's next update, for an inertialization of `duration` seconds.
pub fn request_inertialization(state: &mut [u32], duration: f32) {
    if duration.is_finite() && duration > 0.0 {
        state[crossfade::INERTIA] = duration.to_bits();
    }
}

/// The weight of side `b` a crossfade's state shows.
pub fn crossfade_weight(state: &[u32]) -> f32 {
    let active = state[crossfade::ACTIVE].min(1) as f32;
    let elapsed = f32::from_bits(state[crossfade::ELAPSED]);
    let duration = f32::from_bits(state[crossfade::DURATION]);
    if duration > 0.0 && elapsed < duration {
        let f = elapsed / duration;
        if active > 0.0 {
            f
        } else {
            1.0 - f
        }
    } else {
        active
    }
}

/// The side a crossfade's state fades to (0 or 1).
pub fn crossfade_side(state: &[u32]) -> u32 {
    state[crossfade::ACTIVE].min(1)
}

/// Whether a crossfade is mid-fade.
pub fn crossfade_fading(state: &[u32]) -> bool {
    let elapsed = f32::from_bits(state[crossfade::ELAPSED]);
    let duration = f32::from_bits(state[crossfade::DURATION]);
    duration > 0.0 && elapsed < duration
}

/// Sets a layer's mask handle (0: full body) and mode on its state.
pub fn set_layer(state: &mut [u32], mask: u32, mode: u32) {
    state[layer::MASK] = mask;
    state[layer::MODE] = mode.min(LAYER_ADDITIVE);
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::BLEND2 => blend2(cx, node),
        kind::CROSSFADE => crossfade_node(cx, node),
        kind::LAYER => layer_node(cx, node),
        kind::INERTIALIZE => inertialize(cx, node),
        kind::BLEND_ENUM | kind::BLEND_BOOL => blend_enum(cx, node),
        kind::ADDITIVE => additive(cx, node),
        kind::TIME_SCALE => time_scale(cx, node),
        kind::MIRROR => mirror(cx, node),
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

pub(crate) fn unit(w: f32) -> f32 {
    if w > 0.0 {
        if w < 1.0 {
            w
        } else {
            1.0
        }
    } else {
        0.0
    }
}

/// The pulled phases of a node with no usable input: rest pose, nothing real.
pub(crate) fn empty(cx: &mut EvalContext<'_>) {
    match cx.phase() {
        Phase::Pose => {
            let out = cx.out();
            cx.fill_rest(out);
        }
        Phase::Alpha => cx.set_alpha(0.0),
        Phase::Root => cx.set_root(RootDelta::identity()),
        Phase::Timing => cx.set_timing(Timing::default()),
        _ => {}
    }
}

/// The pulled phases of a pass-through node (alpha, root, timing and the weighted walks are its
/// input's; the pose too unless the caller handles Pose itself).
pub(crate) fn pass(cx: &mut EvalContext<'_>, input: u32) {
    match cx.phase() {
        Phase::Alpha => {
            let a = cx.eval_alpha(input);
            cx.set_alpha(a);
        }
        Phase::Root => {
            let r = cx.eval_root(input);
            cx.set_root(r);
        }
        Phase::Timing => {
            let t = cx.eval_timing(input);
            cx.set_timing(t);
        }
        Phase::Pose => {
            let out = cx.out();
            cx.eval_pose(input, out);
        }
        Phase::Tracks | Phase::Weights => {
            let w = cx.weight();
            cx.eval_tracks(input, w);
        }
        _ => {}
    }
}

/// The pulled phases of a blend of `items` (node, weight), weights already including each input's
/// alpha. `items` with weight 0 are skipped in Pose, Root and Alpha (but walked in the weighted
/// phases, for notify states). Timing is the heaviest item's.
pub(crate) fn weighted(cx: &mut EvalContext<'_>, items: &[(u32, f32)]) {
    match cx.phase() {
        Phase::Tracks | Phase::Weights => {
            let w = cx.weight();
            for &(n, wi) in items {
                cx.eval_tracks(n, w * wi);
            }
        }
        Phase::Alpha => {
            let total: f32 = items.iter().map(|i| i.1.max(0.0)).sum();
            cx.set_alpha(unit(total));
        }
        Phase::Timing => {
            let mut best: Option<(u32, f32)> = None;
            for &(n, w) in items {
                if best.is_none_or(|b| w > b.1) {
                    best = Some((n, w));
                }
            }
            let t = best.map_or(Timing::default(), |(n, _)| cx.eval_timing(n));
            cx.set_timing(t);
        }
        Phase::Root => {
            let mut total = 0.0f32;
            let mut acc = RootDelta::identity();
            for &(n, w) in items {
                if w > 0.0 {
                    total += w;
                    let r = cx.eval_root(n);
                    acc = if total == w {
                        r
                    } else {
                        mix_roots(acc, r, w / total)
                    };
                }
            }
            cx.set_root(acc);
        }
        Phase::Pose => {
            let out = cx.out();
            let mut total = 0.0f32;
            let mut tmp: Option<usize> = None;
            for &(n, w) in items {
                if w <= 0.0 {
                    continue;
                }
                total += w;
                if total == w {
                    cx.eval_pose(n, out);
                } else {
                    let t = match tmp {
                        Some(t) => t,
                        None => match cx.push_slot() {
                            Some(t) => {
                                tmp = Some(t);
                                t
                            }
                            None => break,
                        },
                    };
                    cx.eval_pose(n, t);
                    cx.lerp_slot_into(out, t, w / total);
                }
            }
            if total <= 0.0 {
                cx.fill_rest(out);
            }
            if tmp.is_some() {
                cx.pop_slot();
            }
        }
        _ => {}
    }
}

/// The pulled phases of a two-input blend showing `b` at weight `wb`.
fn mix2(cx: &mut EvalContext<'_>, node: NodeData<'_>, wb: f32) {
    let (Some(&a), Some(&b)) = (node.inputs.first(), node.inputs.get(1)) else {
        empty(cx);
        return;
    };
    let wb = unit(wb);
    let wa = 1.0 - wb;
    if cx.phase().is_weighted() {
        // Every input, weight 0 too, so notify states can end when their clip fades out.
        let w = cx.weight();
        cx.eval_tracks(a, w * wa);
        cx.eval_tracks(b, w * wb);
        return;
    }
    if cx.phase() == Phase::Timing {
        let t = cx.eval_timing(if wb > wa { b } else { a });
        cx.set_timing(t);
        return;
    }
    let ea = if wa > 0.0 { wa * cx.eval_alpha(a) } else { 0.0 };
    let eb = if wb > 0.0 { wb * cx.eval_alpha(b) } else { 0.0 };
    let total = ea + eb;
    match cx.phase() {
        Phase::Alpha => cx.set_alpha(unit(total)),
        Phase::Root => {
            let r = if total <= 0.0 {
                RootDelta::identity()
            } else if eb <= 0.0 {
                cx.eval_root(a)
            } else if ea <= 0.0 {
                cx.eval_root(b)
            } else {
                let ra = cx.eval_root(a);
                let rb = cx.eval_root(b);
                mix_roots(ra, rb, eb / total)
            };
            cx.set_root(r);
        }
        Phase::Pose => {
            let out = cx.out();
            if total <= 0.0 {
                cx.fill_rest(out);
            } else if eb <= 0.0 {
                cx.eval_pose(a, out);
            } else if ea <= 0.0 {
                cx.eval_pose(b, out);
            } else {
                let (Some(s1), Some(s2)) = (cx.push_slot(), cx.push_slot()) else {
                    cx.fill_rest(out);
                    return;
                };
                cx.eval_pose(a, s1);
                cx.eval_pose(b, s2);
                if let Some((pa, pb, po)) = cx.poses3(s1, s2, out) {
                    lerp(pa, pb, eb / total, po);
                }
                cx.pop_slot();
                cx.pop_slot();
            }
        }
        _ => {}
    }
}

/// A weight word, or a float parameter giving it.
fn weight_of(cx: &EvalContext<'_>, node: &NodeData<'_>, word: usize, param: usize, d: f32) -> f32 {
    let p = node.word_or_none(param);
    if p != NONE {
        cx.param_f32(p)
    } else {
        node.f32_or(word, d)
    }
}

fn blend2(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Layout | Phase::Init | Phase::Update => {}
        _ => {
            let w = weight_of(cx, &node, 0, 1, 0.0);
            mix2(cx, node, w);
        }
    }
}

fn crossfade_node(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Layout => cx.set_state_words(crossfade::WORDS, 0),
        Phase::Init => {
            let side = node.word(0);
            let s = cx.state();
            crossfade_to(s, side, 0.0);
            s[crossfade::INERTIA] = 0;
        }
        Phase::Update => {
            let dt = cx.dt();
            let s = cx.state();
            let request = f32::from_bits(s[crossfade::INERTIA]);
            s[crossfade::INERTIA] = 0;
            if dt > 0.0 {
                let elapsed = f32::from_bits(s[crossfade::ELAPSED]) + dt;
                let duration = f32::from_bits(s[crossfade::DURATION]);
                s[crossfade::ELAPSED] = elapsed.min(duration.max(0.0)).to_bits();
            }
            if request > 0.0 {
                cx.request_inertialization(request);
            }
        }
        _ => {
            let w = crossfade_weight(cx.state());
            mix2(cx, node, w);
        }
    }
}

fn layer_node(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Layout => cx.set_state_words(layer::WORDS, 0),
        Phase::Init => {
            let mask = cx.binding(node.word(2));
            let mode = node.word(1);
            set_layer(cx.state(), mask, mode);
        }
        Phase::Update => {}
        phase => {
            let (Some(&base), Some(&overlay)) = (node.inputs.first(), node.inputs.get(1)) else {
                empty(cx);
                return;
            };
            let index = node.params.first().copied().unwrap_or(NONE);
            let mut weight = unit(cx.layer_weight(index, node.f32_or(3, 1.0)));
            let scale = node.word_or_none(4);
            if scale != NONE {
                weight = unit(weight * cx.param_f32(scale));
            }
            if phase.is_weighted() {
                let w = cx.weight();
                cx.eval_tracks(base, w);
                cx.eval_tracks(overlay, w * weight);
                return;
            }
            if phase == Phase::Timing {
                let t = cx.eval_timing(base);
                cx.set_timing(t);
                return;
            }
            let w = if weight > 0.0 {
                weight * cx.eval_alpha(overlay)
            } else {
                0.0
            };
            match phase {
                Phase::Alpha => {
                    let ab = cx.eval_alpha(base);
                    let (mode, _) = layer_state(cx);
                    let a = if ab > 0.0 || mode == LAYER_ADDITIVE {
                        ab
                    } else if w > 0.0 {
                        // An empty base under a playing overlay: the overlay over the rest pose.
                        1.0
                    } else {
                        0.0
                    };
                    cx.set_alpha(a);
                }
                Phase::Root => {
                    let r = cx.eval_root(base);
                    cx.set_root(r);
                }
                Phase::Pose => layer_pose(cx, base, overlay, w),
                _ => {}
            }
        }
    }
}

fn layer_state(cx: &mut EvalContext<'_>) -> (u32, u32) {
    let s = cx.state();
    (s[layer::MODE], s[layer::MASK])
}

fn layer_pose(cx: &mut EvalContext<'_>, base: u32, overlay: u32, w: f32) {
    let out = cx.out();
    if w <= 0.0 {
        cx.eval_pose(base, out);
        return;
    }
    let (Some(s1), Some(s2)) = (cx.push_slot(), cx.push_slot()) else {
        cx.eval_pose(base, out);
        return;
    };
    cx.eval_pose(base, s1);
    cx.eval_pose(overlay, s2);
    let (mode, mask_handle) = layer_state(cx);
    let groups = cx.groups();
    let assets = cx.assets();
    let mask = if mask_handle != 0 {
        assets.mask(mask_handle).filter(|m| m.len() == groups)
    } else {
        None
    };
    if let Some((pb, po, out_pose)) = cx.poses3(s1, s2, out) {
        match (mode, mask) {
            (LAYER_ADDITIVE, Some(m)) => {
                anim_pose::additive::apply_additive_masked(pb, po, m, w, out_pose)
            }
            (LAYER_ADDITIVE, None) => anim_pose::additive::apply_additive(pb, po, w, out_pose),
            (_, Some(m)) => anim_pose::blend::blend_masked(pb, po, m, w, out_pose),
            (_, None) => lerp(pb, po, w, out_pose),
        }
    }
    cx.pop_slot();
    cx.pop_slot();
}

// `!(a < b)` is deliberate: true for NaN too.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn inertialize(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let Some(&source) = node.inputs.first() else {
        match cx.phase() {
            Phase::Layout => cx.set_state_words(inertia::FIXED_WORDS, 3 * SOA_WORDS as u32),
            _ => empty(cx),
        }
        return;
    };
    let fixed = inertia::FIXED_WORDS as usize;
    match cx.phase() {
        Phase::Layout => cx.set_state_words(inertia::FIXED_WORDS, 3 * SOA_WORDS as u32),
        Phase::Init => cx.state()[..fixed].fill(0),
        Phase::Update => {
            let dt = cx.dt();
            let history = cx.history();
            let g = cx.groups() * SOA_WORDS;
            let s = cx.state();
            let request = f32::from_bits(s[inertia::REQUEST]);
            s[inertia::REQUEST] = 0;
            if request > 0.0 {
                match history {
                    Some(h) if h.last.len() * SOA_WORDS == g && h.prev.len() * SOA_WORDS == g => {
                        pose_to_words(h.last, &mut s[fixed..fixed + g]);
                        pose_to_words(h.prev, &mut s[fixed + g..fixed + 2 * g]);
                        s[inertia::CAPTURE_DT] = h.dt.to_bits();
                        s[inertia::ACTIVE] = 1;
                        s[inertia::PENDING] = 1;
                        s[inertia::DURATION] = request.to_bits();
                        // The switch frame already shows one step of decay (anim-pose's
                        // "advance, then apply").
                        s[inertia::ELAPSED] = dt.max(0.0).to_bits();
                    }
                    // Nothing shown yet: the switch is a plain cut.
                    _ => s[inertia::ACTIVE] = 0,
                }
            } else if s[inertia::ACTIVE] != 0 && dt > 0.0 {
                let elapsed = f32::from_bits(s[inertia::ELAPSED]) + dt;
                s[inertia::ELAPSED] = elapsed.to_bits();
                if !(elapsed < f32::from_bits(s[inertia::DURATION])) && s[inertia::PENDING] == 0 {
                    s[inertia::ACTIVE] = 0;
                }
            }
        }
        Phase::Pose => {
            let out = cx.out();
            cx.eval_pose(source, out);
            if cx.state()[inertia::ACTIVE] == 0 {
                return;
            }
            let (Some(s1), Some(s2), Some(s3)) = (cx.push_slot(), cx.push_slot(), cx.push_slot())
            else {
                return;
            };
            let g = cx.groups() * SOA_WORDS;
            let bones = cx.skeleton().bones();
            if let Some((state, [po, p1, p2, p3])) = cx.state_and_slots([out, s1, s2, s3]) {
                if state[inertia::PENDING] != 0 {
                    pose_to_words(po, &mut state[fixed + 2 * g..fixed + 3 * g]);
                    state[inertia::PENDING] = 0;
                }
                pose_from_words(&state[fixed..fixed + g], p1);
                pose_from_words(&state[fixed + g..fixed + 2 * g], p2);
                pose_from_words(&state[fixed + 2 * g..fixed + 3 * g], p3);
            }
            let (dt, duration, elapsed) = {
                let s = cx.state();
                (
                    f32::from_bits(s[inertia::CAPTURE_DT]),
                    f32::from_bits(s[inertia::DURATION]),
                    f32::from_bits(s[inertia::ELAPSED]),
                )
            };
            if let Some((inert, [prev, prev_prev, new], o)) = cx.inertia_parts(s1, s2, s3, out) {
                if inert.bone_count() == bones {
                    inert.begin(prev, prev_prev, new, dt, duration);
                    inert.apply(elapsed, o);
                }
            }
            if !(elapsed < duration) {
                cx.state()[inertia::ACTIVE] = 0;
            }
            cx.pop_slot();
            cx.pop_slot();
            cx.pop_slot();
        }
        _ => pass(cx, source),
    }
}

fn blend_enum(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let n = node.inputs.len().min(MAX_BLEND_INPUTS);
    let pick = |cx: &EvalContext<'_>| -> usize {
        let v = cx.param_f32(node.word_or_none(0));
        if v > 0.0 && n > 0 {
            (v as usize).min(n - 1)
        } else {
            0
        }
    };
    match cx.phase() {
        Phase::Layout => cx.set_state_words(1 + n as u32, 0),
        Phase::Init => {
            let p = pick(cx);
            let s = cx.state();
            s.fill(0);
            s[0] = p as u32;
            if n > 0 {
                s[1 + p] = 1.0f32.to_bits();
            }
        }
        Phase::Update => {
            let p = pick(cx);
            let blend = node.f32_or(1, 0.0);
            let dt = cx.dt();
            let s = cx.state();
            s[0] = p as u32;
            let step = if blend > 0.0 { dt.abs() / blend } else { 1.0 };
            for (i, w) in s[1..1 + n].iter_mut().enumerate() {
                let v = f32::from_bits(*w);
                let t = if i == p { 1.0 } else { 0.0 };
                let v = if v < t {
                    (v + step).min(t)
                } else {
                    (v - step).max(t)
                };
                *w = v.to_bits();
            }
        }
        _ => {
            let mut items = [(0u32, 0.0f32); MAX_BLEND_INPUTS];
            let weighted_phase = cx.phase().is_weighted() || cx.phase() == Phase::Timing;
            let mut total = 0.0f32;
            for (i, item) in items.iter_mut().take(n).enumerate() {
                let w = f32::from_bits(cx.state()[1 + i]);
                let input = node.inputs[i];
                let e = if weighted_phase || w <= 0.0 {
                    w
                } else {
                    w * cx.eval_alpha(input)
                };
                total += w;
                *item = (input, e);
            }
            // Normalise by the weights (they sum to 1 except mid-change), keeping alpha.
            if total > 0.0 {
                for item in items.iter_mut().take(n) {
                    item.1 /= total;
                }
            }
            weighted(cx, &items[..n]);
        }
    }
}

fn additive(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let (Some(&base), Some(&source)) = (node.inputs.first(), node.inputs.get(1)) else {
        if let Some(&base) = node.inputs.first() {
            pass(cx, base);
        } else {
            empty(cx);
        }
        return;
    };
    let reference = node.inputs.get(2).copied();
    match cx.phase() {
        Phase::Layout | Phase::Init | Phase::Update => {}
        Phase::Tracks | Phase::Weights => {
            let w = cx.weight();
            let a = unit(weight_of(cx, &node, 0, 1, 1.0));
            cx.eval_tracks(base, w);
            cx.eval_tracks(source, w * a);
            if let Some(r) = reference {
                cx.eval_tracks(r, 0.0);
            }
        }
        Phase::Pose => {
            let out = cx.out();
            let w = weight_of(cx, &node, 0, 1, 1.0);
            if !(w != 0.0 && w.is_finite()) || cx.eval_alpha(source) <= 0.0 {
                cx.eval_pose(base, out);
                return;
            }
            let (Some(s1), Some(s2), Some(s3)) = (cx.push_slot(), cx.push_slot(), cx.push_slot())
            else {
                cx.eval_pose(base, out);
                return;
            };
            cx.eval_pose(base, s1);
            cx.eval_pose(source, s2);
            let delta = if let Some(r) = reference {
                cx.eval_pose(r, s3);
                if let Some((src, rf, o)) = cx.poses3(s2, s3, out) {
                    anim_pose::additive::make_additive(src, rf, o);
                }
                cx.copy_slot(out, s2);
                s2
            } else {
                s2
            };
            if let Some((b, d, o)) = cx.poses3(s1, delta, out) {
                anim_pose::additive::apply_additive(b, d, w, o);
            }
            cx.pop_slot();
            cx.pop_slot();
            cx.pop_slot();
        }
        _ => pass(cx, base),
    }
}

fn time_scale(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let Some(&child) = node.inputs.first() else {
        empty(cx);
        return;
    };
    match cx.phase() {
        Phase::Layout | Phase::Init => {}
        Phase::Update => {
            let scale = weight_of(cx, &node, 0, 1, 1.0);
            let dt = cx.dt() * scale;
            let ctx = cx.input_context(&node, 0);
            cx.update_context(ctx, dt);
        }
        _ => pass(cx, child),
    }
}

fn mirror(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let Some(&child) = node.inputs.first() else {
        empty(cx);
        return;
    };
    let axis = match node.word(0) {
        1 => Axis::Y,
        2 => Axis::Z,
        _ => Axis::X,
    };
    let enable = node.word_or_none(1);
    let on = enable == NONE || cx.param_f32(enable) != 0.0;
    match cx.phase() {
        Phase::Layout | Phase::Init | Phase::Update => {}
        Phase::Pose if on => {
            let out = cx.out();
            let Some(s1) = cx.push_slot() else {
                cx.eval_pose(child, out);
                return;
            };
            cx.eval_pose(child, s1);
            let bones = cx.skeleton().bones();
            let partners = &node.params[2.min(node.params.len())..];
            // Gather bone by bone (a partner can sit in any group).
            let mut i = 0;
            while i < bones {
                let g = i / anim_math::layout::LANES;
                let lanes: [anim_math::AosTransform; anim_math::layout::LANES] =
                    core::array::from_fn(|l| {
                        let b = g * anim_math::layout::LANES + l;
                        if b >= bones {
                            return anim_math::AosTransform::identity();
                        }
                        let p = partners.get(b).copied().unwrap_or(b as u32) as usize;
                        let p = if p < bones { p } else { b };
                        mirror_transform(anim_pose::bone(cx.pose(s1), p), axis)
                    });
                cx.pose_mut(out)[g] = anim_math::SoaTransform::from_aos(&lanes);
                i = (g + 1) * anim_math::layout::LANES;
            }
            cx.pop_slot();
        }
        Phase::Root if on => {
            let r = cx.eval_root(child);
            let (t, q) = (r.translation, r.rotation);
            let (translation, rotation) = match axis {
                Axis::X => (
                    anim_math::AosVec3::new(-t.x, t.y, t.z),
                    anim_math::AosQuat::new(q.x, -q.y, -q.z, q.w),
                ),
                Axis::Y => (
                    anim_math::AosVec3::new(t.x, -t.y, t.z),
                    anim_math::AosQuat::new(-q.x, q.y, -q.z, q.w),
                ),
                Axis::Z => (
                    anim_math::AosVec3::new(t.x, t.y, -t.z),
                    anim_math::AosQuat::new(-q.x, -q.y, q.z, q.w),
                ),
            };
            cx.set_root(RootDelta {
                translation,
                rotation,
            });
        }
        _ => pass(cx, child),
    }
}
