//! Node family `plugin`: third-party nodes, calling a plugin's sandboxed wasm module through
//! `anim-plugin-sdk`'s ABI (ADR 0370, "Third-party graph and rig nodes"). Filled by T45 (core
//! half). Declare the family's kinds in [`kind`] (append-only `u16`s, stored in
//! `myco.animgraph@1`) and match on them in [`evaluate`].
//!
//! # `PLUGIN_NODE` (kind 0)
//!
//! One node kind of one plugin module. Inputs: the poses it takes (at least the descriptor's
//! input count; extra inputs are ignored). Parameter words ([`word`]):
//!
//! | word | type | meaning |
//! |---|---|---|
//! | 0 | u32 | the module: a string id of the graph bound (`graph_bind`) to a module handle from `plugin_register` |
//! | 1 | u32 | the node kind in the module (the descriptor's `kind`) |
//! | 2 | u32 | the kind's per-instance state bytes as the compiler read them from the descriptor (the blob's size is fixed at load, before modules are known; a mismatch at run time is a fault) |
//! | 3 | u32 | `n`, the parameter block's words |
//! | 4 … 4+n | u32 | the parameter block (the descriptor's layout; missing words take the descriptor's defaults) |
//! | 4+n | u32 | `m`, parameter bindings |
//! | then | 3 × u32 | `m` bindings: block word offset, word count (≤ 4), graph parameter whose words are copied there each evaluation (animatable parameters) |
//!
//! State ([`state`]): fault flags ([`FAULTED`], [`REPORTED`]), the last fault's status, the module
//! handle, a reserved word, then the module's per-instance state (`state_stride(state bytes)`
//! bytes as words, zeroed on init). **The core owns it** (D62): it is copied out for each call and
//! back only when the call succeeds, so it survives a module reload and joins snapshots.
//!
//! Pose phase: input 0 is evaluated into the node's own slot (it is the pass-through), inputs
//! 1… one by one through a scratch slot, each converted from SoA groups to the ABI's AoS layout
//! (10 floats per bone) in the host's [`CallBuffers`]; the parameter block (with bindings applied)
//! and the state are staged beside them; the host runs the call ([`PluginHost::call`]). On
//! success the output is converted back (a non-finite value is a fault) and the state copied
//! back. On a fault (any non-zero status) the slot keeps input 0 (the rest pose for a 0-input
//! node), the state stays as it was, [`FAULTED`] and the status are set, and the first fault of
//! the node instance is reported to the host ([`PluginHost::fault`]); later evaluations try
//! again. Alpha, root motion and timing are input 0's (alpha 1 with no inputs); the weighted
//! walks visit every input.
//!
//! # Calls are per instance (decision for T45)
//!
//! The ABI evaluates a batch of instances of one kind on one skeleton, but the graph pulls poses
//! depth-first per instance, and a plugin node's inputs are that instance's own sub-graph, so
//! correctness first: each evaluation is one call with `count = 1`, nested plugin nodes included
//! (the buffers are a stack). The path to batching keeps this module's call shape: a host may
//! evaluate the instances of one program in lock-step, node level by node level, and hand the
//! module the instances of a level together; nothing in the graph format or the state layout
//! changes for it.

use core::cell::RefCell;

use anim_format::NONE;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_plugin_sdk::abi::{state_stride, BONE_FLOATS};

use crate::dispatch::NodeStatus;
use crate::eval::{EvalContext, NodeData, Phase};

/// The family's node kinds.
pub mod kind {
    /// A third-party node (module docs).
    pub const PLUGIN_NODE: u16 = 0;
}

/// `PLUGIN_NODE` parameter word indices (module docs).
pub mod word {
    pub const MODULE: usize = 0;
    pub const KIND: usize = 1;
    pub const STATE_BYTES: usize = 2;
    pub const BLOCK_WORDS: usize = 3;
    pub const BLOCK: usize = 4;
}

/// `PLUGIN_NODE` state word offsets.
pub mod state {
    /// [`super::FAULTED`] | [`super::REPORTED`].
    pub const FLAGS: usize = 0;
    /// The last fault's status (0: none yet).
    pub const STATUS: usize = 1;
    /// The module's handle (resolved through the graph's bindings on init).
    pub const MODULE: usize = 2;
    /// The module's per-instance state starts here.
    pub const FIXED: usize = 4;
}

/// State flag: the last evaluation faulted (its input 0 passed through).
pub const FAULTED: u32 = 1;
/// State flag: this node instance's fault was reported.
pub const REPORTED: u32 = 2;

/// Core-side fault statuses (the module's own are `anim_plugin_sdk::abi::Status`; the host adds
/// its own for traps). The `plugin` wire family repeats them.
pub mod fault {
    /// No module of that handle, or no node of that kind in it.
    pub const NO_MODULE: u32 = 0x0901;
    /// The node's state size or input count differs from the module's descriptor.
    pub const MISMATCH: u32 = 0x0902;
    /// The host's call buffers are too small for the call.
    pub const NO_ROOM: u32 = 0x0903;
    /// No host runs plugin modules.
    pub const NO_HOST: u32 = 0x0904;
    /// The module wrote a non-finite value into the output pose.
    pub const NOT_FINITE: u32 = 0x0906;
}

/// What a module's descriptor says about one node kind.
#[derive(Clone, Copy, Debug)]
pub struct NodeInfo<'a> {
    /// Pose inputs.
    pub inputs: u32,
    /// Per-instance state bytes.
    pub state_bytes: u32,
    /// Whether the call passes the skeleton's parents.
    pub needs_skeleton: bool,
    /// The default parameter block (its length is the block's words).
    pub defaults: &'a [u32],
}

/// One call: one instance (`count = 1`), every buffer in the ABI's layout (`anim_plugin_sdk::abi`).
pub struct Call<'a> {
    pub module: u32,
    pub kind: u32,
    pub bones: u32,
    /// Pose inputs in `input`.
    pub inputs: u32,
    /// The skeleton's parents when the node needs them, else empty.
    pub parents: &'a [u16],
    /// `inputs × bones × 10` floats.
    pub input: &'a [f32],
    /// `bones × 10` floats, written by the module.
    pub output: &'a mut [f32],
    /// The parameter block.
    pub params: &'a [u32],
    /// The per-instance state, `state_stride(state_bytes) / 4` words, read and written.
    pub state: &'a mut [u32],
    /// The graph's step, seconds.
    pub dt: f32,
}

/// A node instance's first fault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fault {
    /// The node's index in its program.
    pub node: u32,
    pub module: u32,
    pub kind: u32,
    /// The module's, the host's or a core [`fault`] status.
    pub status: u32,
}

/// The host's call buffers: a stack (nested plugin nodes push above their parent's frame), sized
/// in load calls ([`CallBuffers::reserve`]) so evaluation never allocates.
#[derive(Default, Debug)]
pub struct CallBuffers {
    floats: Vec<f32>,
    words: Vec<u32>,
    floats_top: usize,
    words_top: usize,
}

impl CallBuffers {
    /// Grows the buffers to hold at least `floats` pose floats and `words` parameter and state
    /// words (load calls only; never shrinks).
    pub fn reserve(&mut self, floats: usize, words: usize) {
        if self.floats.len() < floats {
            self.floats.resize(floats, 0.0);
        }
        if self.words.len() < words {
            self.words.resize(words, 0);
        }
    }

    /// The floats and words held.
    pub fn capacity(&self) -> (usize, usize) {
        (self.floats.len(), self.words.len())
    }

    fn push(&mut self, floats: usize, words: usize) -> Option<(usize, usize)> {
        let f = self.floats_top;
        let w = self.words_top;
        if f + floats > self.floats.len() || w + words > self.words.len() {
            return None;
        }
        self.floats_top += floats;
        self.words_top += words;
        Some((f, w))
    }

    fn pop(&mut self, at: (usize, usize)) {
        self.floats_top = at.0;
        self.words_top = at.1;
    }
}

/// What runs third-party node modules (anim-wasm: the imported host function; tests: a native
/// stub). Reached through [`crate::eval::Assets::plugins`].
pub trait PluginHost {
    /// Node `kind` of module `module`, or `None`.
    fn node(&self, module: u32, kind: u32) -> Option<NodeInfo<'_>>;
    /// The call buffers.
    fn buffers(&self) -> &RefCell<CallBuffers>;
    /// Runs one call; returns 0 on success, else a fault status.
    fn call(&self, call: Call<'_>) -> u32;
    /// Reports a node instance's first fault.
    fn fault(&self, fault: Fault);
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::PLUGIN_NODE => plugin_node(cx, &node),
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

fn state_words(node: &NodeData<'_>) -> usize {
    state_stride(node.word(word::STATE_BYTES) as usize) / 4
}

fn plugin_node(cx: &mut EvalContext<'_>, node: &NodeData<'_>) {
    let first = node.inputs.first().copied();
    match cx.phase() {
        Phase::Layout => cx.set_state_words((state::FIXED + state_words(node)) as u32, 0),
        Phase::Init => {
            let module = cx.binding(node.word_or_none(word::MODULE));
            let s = cx.state();
            s.fill(0);
            s[state::MODULE] = module;
        }
        Phase::Update => {}
        Phase::Pose => pose(cx, node),
        Phase::Alpha if first.is_none() => cx.set_alpha(1.0),
        Phase::Tracks | Phase::Weights => {
            let w = cx.weight();
            for &input in node.inputs {
                cx.eval_tracks(input, w);
            }
        }
        _ => match first {
            Some(input) => crate::mixing::pass(cx, input),
            None => crate::mixing::empty(cx),
        },
    }
}

/// SoA groups to the ABI's AoS floats (`out` at least `bones × 10`).
fn to_aos(pose: &[SoaTransform], bones: usize, out: &mut [f32]) {
    for (g, group) in pose.iter().enumerate() {
        for (l, t) in group.to_aos().iter().enumerate() {
            let b = g * 4 + l;
            if b >= bones {
                return;
            }
            out[b * BONE_FLOATS..(b + 1) * BONE_FLOATS].copy_from_slice(&[
                t.translation.x,
                t.translation.y,
                t.translation.z,
                t.rotation.x,
                t.rotation.y,
                t.rotation.z,
                t.rotation.w,
                t.scale.x,
                t.scale.y,
                t.scale.z,
            ]);
        }
    }
}

/// The ABI's AoS floats back to SoA groups (padding lanes identity).
fn from_aos(floats: &[f32], bones: usize, pose: &mut [SoaTransform]) {
    for (g, group) in pose.iter_mut().enumerate() {
        let lanes: [AosTransform; 4] = core::array::from_fn(|l| {
            let b = g * 4 + l;
            if b >= bones {
                return AosTransform::identity();
            }
            let f = &floats[b * BONE_FLOATS..(b + 1) * BONE_FLOATS];
            AosTransform::new(
                AosVec3::new(f[0], f[1], f[2]),
                AosQuat::new(f[3], f[4], f[5], f[6]),
                AosVec3::new(f[7], f[8], f[9]),
            )
        });
        *group = SoaTransform::from_aos(&lanes);
    }
}

fn pose(cx: &mut EvalContext<'_>, node: &NodeData<'_>) {
    let out = cx.out();
    match node.inputs.first() {
        Some(&input) => cx.eval_pose(input, out),
        None => cx.fill_rest(out),
    }
    let status = call(cx, node, out);
    let s = cx.state();
    if status == 0 {
        s[state::FLAGS] &= !FAULTED;
        return;
    }
    let first = s[state::FLAGS] & REPORTED == 0;
    s[state::FLAGS] |= FAULTED | REPORTED;
    s[state::STATUS] = status;
    let module = s[state::MODULE];
    if first {
        if let Some(host) = cx.assets().plugins() {
            host.fault(Fault {
                node: node.index,
                module,
                kind: node.word(word::KIND),
                status,
            });
        }
    }
}

/// Runs the call; on success the output is in slot `out` and the state copied back. Returns 0 or
/// a fault status (slot `out` then still holds input 0).
fn call(cx: &mut EvalContext<'_>, node: &NodeData<'_>, out: usize) -> u32 {
    let Some(host) = cx.assets().plugins() else {
        return fault::NO_HOST;
    };
    let module = cx.state()[state::MODULE];
    let kind = node.word(word::KIND);
    let Some(info) = host.node(module, kind) else {
        return fault::NO_MODULE;
    };
    let swords = state_words(node);
    if info.state_bytes != node.word(word::STATE_BYTES) || node.inputs.len() < info.inputs as usize
    {
        return fault::MISMATCH;
    }
    let skel = cx.skeleton();
    let bones = skel.bones();
    let pose_floats = bones * BONE_FLOATS;
    let inputs = info.inputs as usize;
    let pwords = info.defaults.len();
    let Some(frame) = host
        .buffers()
        .borrow_mut()
        .push((inputs + 1) * pose_floats, pwords + swords)
    else {
        return fault::NO_ROOM;
    };
    let (fa, wa) = frame;
    // Input 0 is already in `out`; the others through a scratch slot, one at a time (a nested
    // plugin node pushes its own frame above this one meanwhile).
    if inputs > 0 {
        to_aos(
            cx.pose(out),
            bones,
            &mut host.buffers().borrow_mut().floats[fa..],
        );
    }
    for (j, &input) in node.inputs.iter().enumerate().take(inputs).skip(1) {
        let Some(slot) = cx.push_slot() else {
            host.buffers().borrow_mut().pop(frame);
            return fault::NO_ROOM;
        };
        cx.eval_pose(input, slot);
        let at = fa + j * pose_floats;
        to_aos(
            cx.pose(slot),
            bones,
            &mut host.buffers().borrow_mut().floats[at..],
        );
        cx.pop_slot();
    }
    // The parameter block: defaults, the node's words, then the bindings.
    {
        let mut b = host.buffers().borrow_mut();
        let params = &mut b.words[wa..wa + pwords];
        params.copy_from_slice(info.defaults);
        let n = node.word(word::BLOCK_WORDS) as usize;
        let block = node.params.get(word::BLOCK..word::BLOCK + n).unwrap_or(&[]);
        for (p, w) in params.iter_mut().zip(block) {
            *p = *w;
        }
        let at = word::BLOCK + n;
        let m = node.word(at) as usize;
        for k in 0..m {
            let o = node.word(at + 1 + 3 * k) as usize;
            let count = (node.word(at + 2 + 3 * k) as usize).min(4);
            let param = node.word_or_none(at + 3 + 3 * k);
            if param == NONE {
                continue;
            }
            let v = cx.param_words(param);
            for (i, w) in v.iter().take(count).enumerate() {
                if let Some(p) = params.get_mut(o + i) {
                    *p = *w;
                }
            }
        }
        let st = &cx.state()[state::FIXED..state::FIXED + swords];
        b.words[wa + pwords..wa + pwords + swords].copy_from_slice(st);
    }
    let parents = if info.needs_skeleton {
        skel.parents
    } else {
        &[]
    };
    let status = {
        let mut guard = host.buffers().borrow_mut();
        let b = &mut *guard;
        let (inp, rest) = b.floats[fa..].split_at_mut(inputs * pose_floats);
        let (params, st) = b.words[wa..wa + pwords + swords].split_at_mut(pwords);
        let status = host.call(Call {
            module,
            kind,
            bones: bones as u32,
            inputs: inputs as u32,
            parents,
            input: inp,
            output: &mut rest[..pose_floats],
            params,
            state: st,
            dt: cx.dt(),
        });
        if status == 0 && rest[..pose_floats].iter().any(|v| !v.is_finite()) {
            fault::NOT_FINITE
        } else {
            status
        }
    };
    if status == 0 {
        let b = host.buffers().borrow();
        from_aos(
            &b.floats[fa + inputs * pose_floats..fa + (inputs + 1) * pose_floats],
            bones,
            cx.pose_mut(out),
        );
        let st = &b.words[wa + pwords..wa + pwords + swords];
        cx.state()[state::FIXED..state::FIXED + swords].copy_from_slice(st);
    }
    host.buffers().borrow_mut().pop(frame);
    status
}
