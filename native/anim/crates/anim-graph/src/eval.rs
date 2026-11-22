//! The interpreter: a compiled graph turned into a runtime [`Program`], the [`EvalContext`] every
//! node sees, and a node's compiled data ([`NodeData`]).
//!
//! # Program
//!
//! [`Program::from_view`] copies a parsed `myco.animgraph@1` into flat tables once, at load (it
//! allocates; nothing after it does): the node table (family, kind, input range, parameter-word
//! range), an evaluation order (every node after its inputs), the graph's depth, its parameter
//! defaults and layer defaults, and each node's **state layout**.
//!
//! # Instance state
//!
//! Every instance of a program owns one blob of `u32` words ([`Program::state_words`]): first the
//! graph parameters (4 words each, as `PARAMS` stores defaults), then each node's state in node
//! order. A node declares its state size in the [`Phase::Layout`] phase as *fixed words plus words
//! per bone group* (a group is four bones, `anim_math::layout`), so one program serves skeletons
//! of any size and a node's offset is `a + b · groups`. The blob is plain words, so snapshot and
//! restore are a copy (prediction, ADR 0340), and evaluation is deterministic.
//!
//! # Phases
//!
//! Families have one entry point, `evaluate(cx, kind, node)` routed by [`crate::dispatch`]; the
//! phase is in the context ([`EvalContext::phase`]):
//!
//! | Phase | Order | What a node does |
//! |---|---|---|
//! | [`Phase::Layout`] | once per node at load | [`EvalContext::set_state_words`] |
//! | [`Phase::Init`] | every node, evaluation order | fills its state from its parameters |
//! | [`Phase::Update`] | every node, evaluation order | advances time by [`EvalContext::dt`], fades, emits state events |
//! | [`Phase::Alpha`] | pulled from the output | [`EvalContext::set_alpha`]: how much real pose it outputs (0 = nothing, e.g. a player without a clip) |
//! | [`Phase::Pose`] | pulled from the output | writes its local pose into [`EvalContext::out`], pulling inputs with [`EvalContext::eval_pose`] |
//! | [`Phase::Root`] | pulled from the output | [`EvalContext::set_root`]: its root-motion delta this step |
//!
//! Pulled phases let a blend skip an input of weight 0 (Unreal's relevance), so an idle layer
//! costs nothing; [`Phase::Update`] still runs every node, so playheads advance everywhere (time
//! stays consistent when a layer fades back in).
//!
//! Poses live on a stack of scratch slots ([`Program::pose_slots`] of them, each
//! `soa_len(bones)` groups) that the caller owns; a node pulling inputs reserves slots with
//! [`EvalContext::push_slot`] and gives them back with [`EvalContext::pop_slot`].
//!
//! # Extension points (T31 and later families)
//!
//! - A node kind is added in its family module: declare the kind, its parameter words, its state
//!   layout (Layout phase) and its phases. Nothing here changes.
//! - State machines, slots and linked graphs read their side tables from the graph view at load;
//!   [`Program`] keeps what the minimal families need and is the place to add their flat copies.
//! - A node of a kind its family doesn't know (a newer graph) is handled here: its pose is its
//!   first input's (or the rest pose), its alpha and root likewise; [`Program::unknown_nodes`]
//!   counts them so the loader reports it once.

use anim_format::graph::{AnimGraphView, ParamValue};
use anim_format::{F32s, NONE};
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_pose::inertialize::Inertializer;
use anim_pose::root::RootDelta;
use anim_sample::ClipSampler;

use crate::dispatch::{dispatch, Family, NodeStatus};

/// Words per [`SoaTransform`] in a state blob: ten components (translation 3, rotation 4,
/// scale 3) of four lanes.
pub const SOA_WORDS: usize = 40;

/// The phase an [`EvalContext`] runs (module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Layout,
    Init,
    Update,
    Alpha,
    Pose,
    Root,
}

/// A loaded clip as nodes see it.
#[derive(Clone, Copy)]
pub struct ClipRef<'a> {
    /// The sampler over the clip's compressed form (or raw form when it has no compressed form).
    pub sampler: ClipSampler<'a>,
    /// Seconds.
    pub duration: f32,
    /// The clip's `CLIP_LOOP` flag.
    pub looping: bool,
    /// The clip's `CLIP_ADDITIVE` flag: it samples a delta pose (over identity, not the rest pose).
    pub additive: bool,
    /// Its root curve (x, y, z, yaw per frame) and the frame rate and count it is sampled at.
    pub root_curve: Option<F32s<'a>>,
    pub sample_rate: f32,
    pub frame_count: u32,
    /// The root-motion bone, or `NONE`.
    pub root_bone: u32,
}

/// What the interpreter reads from the host's asset arena. Handles are opaque to the graph; a
/// stale or released handle answers `None`, and the node behaves as if it had nothing.
pub trait Assets {
    /// The clip of `handle`.
    fn clip(&self, handle: u32) -> Option<ClipRef<'_>>;
    /// The bone mask of `handle`, packed like a pose (`soa_len(bones)` groups of four weights).
    fn mask(&self, handle: u32) -> Option<&[F32x4]>;
}

/// A playback event for the host (play promises, `AnimatorStateChanges`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateEventKind {
    /// A play reached its end (a non-looping clip at its last frame).
    Finished,
    /// A play was replaced or stopped before it finished.
    Interrupted,
}

/// One playback event: the play's id (given by the host when it started the play) and its layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StateEvent {
    pub kind: StateEventKind,
    pub layer: u32,
    pub play_id: u32,
}

/// Where events go. Never allocates in the host's implementation.
pub trait Events {
    fn push(&mut self, event: StateEvent);
}

/// The skeleton an instance evaluates against.
#[derive(Clone, Copy)]
pub struct SkeletonPose<'a> {
    /// Parents first; `parents.len()` is the bone count.
    pub parents: &'a [u16],
    /// The rest pose, one transform per bone (sampling's default values).
    pub rest: &'a [AosTransform],
    /// The rest pose packed (`soa_len(bones)` groups): the pose of a node with nothing to play.
    pub rest_soa: &'a [SoaTransform],
    /// Identity per bone: the "rest" an additive clip samples over.
    pub identity: &'a [AosTransform],
}

impl SkeletonPose<'_> {
    /// Bones.
    pub fn bones(&self) -> usize {
        self.parents.len()
    }
    /// Bone groups (four bones each).
    pub fn groups(&self) -> usize {
        soa_len(self.parents.len())
    }
}

/// The instance's last two evaluated output poses (for inertialization), `dt` seconds apart.
#[derive(Clone, Copy)]
pub struct History<'a> {
    pub last: &'a [SoaTransform],
    pub prev: &'a [SoaTransform],
    pub dt: f32,
}

/// Everything an evaluation reads besides the instance's state.
#[derive(Clone, Copy)]
pub struct Inputs<'a> {
    pub assets: &'a dyn Assets,
    pub skeleton: SkeletonPose<'a>,
    /// The graph's bindings: an asset handle per string id of the graph's string table (0: none).
    /// Parameter words that name assets (clip players' clips, layers' masks) resolve through it.
    pub bindings: &'a [u32],
    /// The instance's layer weights (the host's input view), by layer index.
    pub layer_weights: &'a [f32],
    pub history: Option<History<'a>>,
    /// Clip players remove the root motion of their clip's root bone from the pose (it is reported
    /// as the root delta instead).
    pub bake_root: bool,
}

/// Scratch the caller owns; sized by the program and skeleton (see [`Program::pose_slots`]).
pub struct Scratch<'a> {
    /// `pose_slots · groups` transforms.
    pub poses: &'a mut [SoaTransform],
    /// At least `2 · bones` transforms (sampling).
    pub sample: &'a mut [AosTransform],
    /// An inertializer for exactly this skeleton's bone count.
    pub inertializer: &'a mut Inertializer,
}

/// Why a graph can't become a program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgramError {
    /// A node's parameter range or input range is out of its table (the format checks this; a
    /// program built another way could get it wrong).
    Range,
    /// The state blob would pass `u32` words.
    TooLarge,
}

#[derive(Clone, Copy, Debug)]
struct ProgNode {
    family: Family,
    kind: u16,
    inputs: (u32, u32),
    params: (u32, u32),
    /// The state offset is `off_fixed + off_group · groups`; its length `len_fixed + len_group ·
    /// groups`.
    off_fixed: u32,
    off_group: u32,
    len_fixed: u32,
    len_group: u32,
}

/// A compiled graph ready to run (module docs). Built once per graph asset; shared by every
/// instance of it.
#[derive(Clone, Debug)]
pub struct Program {
    nodes: Vec<ProgNode>,
    inputs: Vec<u32>,
    params: Vec<u32>,
    order: Vec<u32>,
    output: u32,
    depth: u32,
    param_defaults: Vec<[u32; 4]>,
    layer_defaults: Vec<f32>,
    state_fixed: u32,
    state_group: u32,
    unknown: u32,
}

impl Program {
    /// The program of a parsed graph. Allocates (load time only).
    pub fn from_view(view: &AnimGraphView<'_>) -> Result<Program, ProgramError> {
        let n = view.node_count();
        let mut nodes = Vec::with_capacity(n);
        let mut inputs = Vec::new();
        let blocks = view.param_blocks();
        let params: Vec<u32> = blocks.iter().collect();
        for i in 0..n {
            let node = view.node(i).ok_or(ProgramError::Range)?;
            let family = Family::from_id(node.family).ok_or(ProgramError::Range)?;
            let first = inputs.len() as u32;
            let list = view.node_inputs(i).ok_or(ProgramError::Range)?;
            for k in 0..list.len() {
                let input = list.get(k).ok_or(ProgramError::Range)?;
                if input as usize >= n {
                    return Err(ProgramError::Range);
                }
                inputs.push(input);
            }
            let end = node.params_first as u64 + node.params_count as u64;
            if end > params.len() as u64 {
                return Err(ProgramError::Range);
            }
            nodes.push(ProgNode {
                family,
                kind: node.kind,
                inputs: (first, list.len() as u32),
                params: (node.params_first, node.params_count),
                off_fixed: 0,
                off_group: 0,
                len_fixed: 0,
                len_group: 0,
            });
        }
        let param_defaults = (0..view.param_count())
            .filter_map(|i| view.param(i))
            .map(|p| param_words(p.default))
            .collect::<Vec<_>>();
        let layer_defaults = (0..view.layer_count())
            .filter_map(|i| view.layer(i))
            .map(|l| l.weight)
            .collect();
        let output = view.output();
        if output as usize >= n {
            return Err(ProgramError::Range);
        }
        let mut program = Program {
            nodes,
            inputs,
            params,
            order: Vec::new(),
            output,
            depth: 0,
            param_defaults,
            layer_defaults,
            state_fixed: 0,
            state_group: 0,
            unknown: 0,
        };
        program.order = program.topological_order();
        program.depth = program.longest_chain();
        program.layout()?;
        Ok(program)
    }

    /// Every node after its inputs (iterative depth-first search; the format guarantees a DAG).
    fn topological_order(&self) -> Vec<u32> {
        let n = self.nodes.len();
        let mut state = vec![0u8; n]; // 0 new, 1 on the stack, 2 done
        let mut order = Vec::with_capacity(n);
        let mut stack: Vec<(u32, u32)> = Vec::new();
        for start in 0..n as u32 {
            if state[start as usize] != 0 {
                continue;
            }
            stack.push((start, 0));
            state[start as usize] = 1;
            while let Some(&mut (node, ref mut next)) = stack.last_mut() {
                let (first, count) = self.nodes[node as usize].inputs;
                if *next < count {
                    let input = self.inputs[(first + *next) as usize];
                    *next += 1;
                    if state[input as usize] == 0 {
                        state[input as usize] = 1;
                        stack.push((input, 0));
                    }
                } else {
                    state[node as usize] = 2;
                    order.push(node);
                    stack.pop();
                }
            }
        }
        order
    }

    /// The most nodes on one input chain (1 for a lone node).
    fn longest_chain(&self) -> u32 {
        let mut depth = vec![0u32; self.nodes.len()];
        let mut most = 0;
        for &i in &self.order {
            let (first, count) = self.nodes[i as usize].inputs;
            let below = (first..first + count)
                .map(|k| depth[self.inputs[k as usize] as usize])
                .max()
                .unwrap_or(0);
            depth[i as usize] = below + 1;
            most = most.max(below + 1);
        }
        most
    }

    /// Runs the Layout phase: each node's state size, then the offsets.
    fn layout(&mut self) -> Result<(), ProgramError> {
        let mut fixed = 4u64 * self.param_defaults.len() as u64;
        let mut group = 0u64;
        let mut unknown = 0;
        for i in 0..self.nodes.len() {
            let mut sink = NoEvents;
            let mut cx = EvalContext::bare(self, Phase::Layout, &mut sink);
            let status = cx.run(i as u32);
            let (lf, lg) = cx.layout;
            if status == NodeStatus::UnknownKind {
                unknown += 1;
            }
            let node = &mut self.nodes[i];
            node.off_fixed = u32::try_from(fixed).map_err(|_| ProgramError::TooLarge)?;
            node.off_group = u32::try_from(group).map_err(|_| ProgramError::TooLarge)?;
            node.len_fixed = lf;
            node.len_group = lg;
            fixed += lf as u64;
            group += lg as u64;
        }
        self.state_fixed = u32::try_from(fixed).map_err(|_| ProgramError::TooLarge)?;
        self.state_group = u32::try_from(group).map_err(|_| ProgramError::TooLarge)?;
        self.unknown = unknown;
        Ok(())
    }

    /// Nodes whose family has no node of their kind (they pass their first input through).
    pub fn unknown_nodes(&self) -> u32 {
        self.unknown
    }

    /// The number of nodes.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// The output node.
    pub fn output(&self) -> u32 {
        self.output
    }

    /// The default weights of the graph's layers (its `LAYERS` table), by layer index.
    pub fn layer_defaults(&self) -> &[f32] {
        &self.layer_defaults
    }

    /// Words of instance state for a skeleton of `groups` bone groups.
    pub fn state_words(&self, groups: usize) -> usize {
        self.state_fixed as usize + self.state_group as usize * groups
    }

    /// Pose slots a [`Scratch`] needs: the output, two per pulled level, and three for an
    /// inertialization's captured poses.
    pub fn pose_slots(&self) -> usize {
        4 + 3 * self.depth as usize
    }

    /// The state words of node `node` within an instance's blob (`groups` bone groups).
    pub fn node_state<'s>(&self, state: &'s mut [u32], groups: usize, node: u32) -> &'s mut [u32] {
        let n = &self.nodes[node as usize];
        let at = n.off_fixed as usize + n.off_group as usize * groups;
        let len = n.len_fixed as usize + n.len_group as usize * groups;
        &mut state[at..at + len]
    }

    /// The graph parameter `index`'s four words within a blob.
    pub fn param_state<'s>(&self, state: &'s mut [u32], index: usize) -> &'s mut [u32] {
        &mut state[4 * index..4 * index + 4]
    }

    /// Fills a fresh instance blob (`state_words(groups)` long): parameter defaults, then every
    /// node's Init phase.
    pub fn init_state(&self, inputs: &Inputs<'_>, state: &mut [u32]) {
        state.fill(0);
        for (i, d) in self.param_defaults.iter().enumerate() {
            state[4 * i..4 * i + 4].copy_from_slice(d);
        }
        let mut sink = NoEvents;
        let mut cx = EvalContext::with(self, Phase::Init, inputs, state, &mut sink, None, 0.0);
        for &i in &self.order {
            cx.run(i);
        }
    }

    /// Advances every node by `dt` seconds (playheads, fades), emitting state events. Never
    /// allocates.
    pub fn update(&self, inputs: &Inputs<'_>, state: &mut [u32], dt: f32, events: &mut dyn Events) {
        let mut cx = EvalContext::with(self, Phase::Update, inputs, state, events, None, dt);
        for &i in &self.order {
            cx.run(i);
        }
    }

    /// The output's local pose into `out` (`groups` transforms). Never allocates.
    pub fn pose(
        &self,
        inputs: &Inputs<'_>,
        state: &mut [u32],
        scratch: Scratch<'_>,
        out: &mut [SoaTransform],
    ) {
        let groups = inputs.skeleton.groups();
        let mut sink = NoEvents;
        let mut cx = EvalContext::with(
            self,
            Phase::Alpha,
            inputs,
            state,
            &mut sink,
            Some(scratch),
            0.0,
        );
        let alpha = cx.eval_alpha(self.output);
        let slot = cx.push_slot();
        match slot {
            Some(slot) => {
                cx.eval_pose(self.output, slot);
                let pose = cx.pose(slot);
                if alpha >= 1.0 {
                    out.copy_from_slice(pose);
                } else {
                    // Less than a whole pose (an empty or fading-in base): the rest of it is rest.
                    anim_pose::blend::lerp(inputs.skeleton.rest_soa, pose, alpha, out);
                }
            }
            None => out.copy_from_slice(&inputs.skeleton.rest_soa[..groups]),
        }
    }

    /// The output's root-motion delta for the last update, in the character's frame at the start
    /// of the step. Never allocates.
    pub fn root(&self, inputs: &Inputs<'_>, state: &mut [u32]) -> RootDelta {
        let mut sink = NoEvents;
        let mut cx = EvalContext::with(self, Phase::Root, inputs, state, &mut sink, None, 0.0);
        let alpha = cx.eval_alpha(self.output);
        let delta = cx.eval_root(self.output);
        scale_root(delta, alpha)
    }
}

/// `delta` weighted by `alpha` toward identity.
pub fn scale_root(delta: RootDelta, alpha: f32) -> RootDelta {
    if alpha >= 1.0 {
        return delta;
    }
    mix_roots(RootDelta::identity(), delta, alpha.max(0.0))
}

/// `lerp(a, b, t)` of two root deltas (translation linearly, rotation by nlerp).
pub fn mix_roots(a: RootDelta, b: RootDelta, t: f32) -> RootDelta {
    let s = 1.0 - t;
    let mut rb = b.rotation;
    let dot = a.rotation.x * rb.x + a.rotation.y * rb.y + a.rotation.z * rb.z + a.rotation.w * rb.w;
    if dot < 0.0 {
        rb = AosQuat::new(-rb.x, -rb.y, -rb.z, -rb.w);
    }
    RootDelta {
        translation: AosVec3::new(
            a.translation.x * s + b.translation.x * t,
            a.translation.y * s + b.translation.y * t,
            a.translation.z * s + b.translation.z * t,
        ),
        rotation: AosQuat::new(
            a.rotation.x * s + rb.x * t,
            a.rotation.y * s + rb.y * t,
            a.rotation.z * s + rb.z * t,
            a.rotation.w * s + rb.w * t,
        )
        .normalize_or_identity(),
    }
}

fn param_words(v: ParamValue) -> [u32; 4] {
    let f = |x: &[f32]| {
        let mut w = [0u32; 4];
        for (o, v) in w.iter_mut().zip(x) {
            *o = v.to_bits();
        }
        w
    };
    match v {
        ParamValue::Float(x) => f(&[x]),
        ParamValue::Int(x) => [x as u32, 0, 0, 0],
        ParamValue::Bool(x) => [x as u32, 0, 0, 0],
        ParamValue::Vec2(x) => f(&x),
        ParamValue::Vec3(x) => f(&x),
        ParamValue::Quat(x) => f(&x),
        ParamValue::Node(x) => [x, 0, 0, 0],
    }
}

struct NoEvents;
impl Events for NoEvents {
    fn push(&mut self, _: StateEvent) {}
}

struct NoAssets;
impl Assets for NoAssets {
    fn clip(&self, _: u32) -> Option<ClipRef<'_>> {
        None
    }
    fn mask(&self, _: u32) -> Option<&[F32x4]> {
        None
    }
}

static NO_ASSETS: NoAssets = NoAssets;

/// The state a node evaluates against: its instance's blob, the skeleton, the inputs, the pose
/// stack and the phase's results. Borrowed for one evaluation; never allocates.
pub struct EvalContext<'a> {
    phase: Phase,
    program: &'a Program,
    inputs: Inputs<'a>,
    state: &'a mut [u32],
    events: &'a mut dyn Events,
    scratch: Option<Scratch<'a>>,
    groups: usize,
    dt: f32,
    node: u32,
    out: usize,
    next_slot: usize,
    alpha: f32,
    root: RootDelta,
    layout: (u32, u32),
    inertia_request: f32,
}

const EMPTY_SKELETON: SkeletonPose<'static> = SkeletonPose {
    parents: &[],
    rest: &[],
    rest_soa: &[],
    identity: &[],
};

impl<'a> EvalContext<'a> {
    /// A context with no instance (the Layout phase).
    fn bare(program: &'a Program, phase: Phase, events: &'a mut dyn Events) -> Self {
        EvalContext {
            phase,
            program,
            inputs: Inputs {
                assets: &NO_ASSETS,
                skeleton: EMPTY_SKELETON,
                bindings: &[],
                layer_weights: &[],
                history: None,
                bake_root: false,
            },
            state: &mut [],
            events,
            scratch: None,
            groups: 0,
            dt: 0.0,
            node: 0,
            out: 0,
            next_slot: 0,
            alpha: 0.0,
            root: RootDelta::identity(),
            layout: (0, 0),
            inertia_request: 0.0,
        }
    }

    fn with(
        program: &'a Program,
        phase: Phase,
        inputs: &Inputs<'a>,
        state: &'a mut [u32],
        events: &'a mut dyn Events,
        scratch: Option<Scratch<'a>>,
        dt: f32,
    ) -> Self {
        let mut cx = EvalContext::bare(program, phase, events);
        cx.groups = inputs.skeleton.groups();
        cx.inputs = *inputs;
        cx.state = state;
        cx.scratch = scratch;
        cx.dt = dt;
        cx
    }

    /// Runs node `i` in the current phase; handles unknown kinds (module docs).
    fn run(&mut self, i: u32) -> NodeStatus {
        let program = self.program;
        let n = program.nodes[i as usize];
        let saved = self.node;
        self.node = i;
        self.layout = (0, 0);
        let data = NodeData {
            index: i,
            inputs: &program.inputs[n.inputs.0 as usize..(n.inputs.0 + n.inputs.1) as usize],
            params: &program.params[n.params.0 as usize..(n.params.0 + n.params.1) as usize],
        };
        let status = dispatch(self, n.family, n.kind, data);
        if status == NodeStatus::UnknownKind {
            let first = data.inputs.first().copied();
            match (self.phase, first) {
                (Phase::Alpha, Some(input)) => {
                    let a = self.eval_alpha(input);
                    self.alpha = a;
                }
                (Phase::Alpha, None) => self.alpha = 0.0,
                (Phase::Pose, Some(input)) => {
                    let out = self.out;
                    self.eval_pose(input, out);
                }
                (Phase::Pose, None) => self.fill_rest(self.out),
                (Phase::Root, Some(input)) => {
                    let r = self.eval_root(input);
                    self.root = r;
                }
                (Phase::Root, None) => self.root = RootDelta::identity(),
                _ => {}
            }
        }
        self.node = saved;
        status
    }

    /// The phase this evaluation runs.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Seconds this update advances (Update phase; 0 otherwise).
    pub fn dt(&self) -> f32 {
        self.dt
    }

    /// Bone groups of the skeleton.
    pub fn groups(&self) -> usize {
        self.groups
    }

    /// The skeleton.
    pub fn skeleton(&self) -> SkeletonPose<'a> {
        self.inputs.skeleton
    }

    /// The asset arena.
    pub fn assets(&self) -> &'a dyn Assets {
        self.inputs.assets
    }

    /// The asset bound to string id `id` of the graph (0 for none or `NONE`).
    pub fn binding(&self, id: u32) -> u32 {
        if id == NONE {
            return 0;
        }
        self.inputs.bindings.get(id as usize).copied().unwrap_or(0)
    }

    /// The instance's weight for layer `index`, or `fallback` when the host gave none.
    pub fn layer_weight(&self, index: u32, fallback: f32) -> f32 {
        self.inputs
            .layer_weights
            .get(index as usize)
            .copied()
            .unwrap_or(fallback)
    }

    /// Whether clip players bake root motion out of their poses.
    pub fn bake_root(&self) -> bool {
        self.inputs.bake_root
    }

    /// The instance's last two evaluated output poses.
    pub fn history(&self) -> Option<History<'a>> {
        self.inputs.history
    }

    /// Layout phase: this node's state is `fixed` words plus `per_group` words per bone group.
    pub fn set_state_words(&mut self, fixed: u32, per_group: u32) {
        self.layout = (fixed, per_group);
    }

    /// The current node's state words.
    pub fn state(&mut self) -> &mut [u32] {
        let groups = self.groups;
        let node = self.node;
        self.program.node_state(self.state, groups, node)
    }

    /// Graph parameter `index` as a float (0 when out of range).
    pub fn param_f32(&self, index: u32) -> f32 {
        let at = 4 * index as usize;
        self.state.get(at).map_or(0.0, |w| f32::from_bits(*w))
    }

    /// Emits a state event.
    pub fn emit(&mut self, event: StateEvent) {
        self.events.push(event);
    }

    /// Update phase: asks the nearest inertialization node above for a transition of `duration`
    /// seconds (the longest request of the frame wins).
    pub fn request_inertialization(&mut self, duration: f32) {
        if duration > self.inertia_request {
            self.inertia_request = duration;
        }
    }

    /// Takes the frame's inertialization request (0 for none).
    pub fn take_inertialization(&mut self) -> f32 {
        core::mem::replace(&mut self.inertia_request, 0.0)
    }

    /// Alpha phase: the current node's alpha.
    pub fn set_alpha(&mut self, alpha: f32) {
        self.alpha = alpha;
    }

    /// Root phase: the current node's delta.
    pub fn set_root(&mut self, delta: RootDelta) {
        self.root = delta;
    }

    /// The alpha of node `node` (pulled).
    pub fn eval_alpha(&mut self, node: u32) -> f32 {
        let phase = core::mem::replace(&mut self.phase, Phase::Alpha);
        self.alpha = 0.0;
        self.run(node);
        self.phase = phase;
        self.alpha
    }

    /// The root delta of node `node` (pulled).
    pub fn eval_root(&mut self, node: u32) -> RootDelta {
        let phase = core::mem::replace(&mut self.phase, Phase::Root);
        self.root = RootDelta::identity();
        self.run(node);
        self.phase = phase;
        self.root
    }

    /// Evaluates node `node`'s pose into slot `slot`.
    pub fn eval_pose(&mut self, node: u32, slot: usize) {
        let phase = core::mem::replace(&mut self.phase, Phase::Pose);
        let out = core::mem::replace(&mut self.out, slot);
        self.run(node);
        self.out = out;
        self.phase = phase;
    }

    /// Pose phase: the slot the current node writes.
    pub fn out(&self) -> usize {
        self.out
    }

    /// Reserves a pose slot; `None` when the stack is exhausted (a node then writes the rest pose).
    pub fn push_slot(&mut self) -> Option<usize> {
        let groups = self.groups.max(1);
        let len = self.scratch.as_ref().map_or(0, |s| s.poses.len() / groups);
        if self.next_slot < len {
            self.next_slot += 1;
            Some(self.next_slot - 1)
        } else {
            None
        }
    }

    /// Gives back the last reserved slot.
    pub fn pop_slot(&mut self) {
        self.next_slot = self.next_slot.saturating_sub(1);
    }

    fn slot_range(&self, slot: usize) -> core::ops::Range<usize> {
        slot * self.groups..(slot + 1) * self.groups
    }

    /// Slot `slot`'s pose.
    pub fn pose(&self, slot: usize) -> &[SoaTransform] {
        let r = self.slot_range(slot);
        match &self.scratch {
            Some(s) => &s.poses[r],
            None => &[],
        }
    }

    /// Slot `slot`'s pose, writable.
    pub fn pose_mut(&mut self, slot: usize) -> &mut [SoaTransform] {
        let r = self.slot_range(slot);
        match &mut self.scratch {
            Some(s) => &mut s.poses[r],
            None => &mut [],
        }
    }

    /// Two input slots and an output slot (all different); `None` without scratch or for equal
    /// slots.
    pub fn poses3(
        &mut self,
        a: usize,
        b: usize,
        out: usize,
    ) -> Option<(&[SoaTransform], &[SoaTransform], &mut [SoaTransform])> {
        let g = self.groups;
        let s = self.scratch.as_mut()?;
        let [pa, pb, po] = split_slots(s.poses, g, [a, b, out])?;
        Some((pa, pb, po))
    }

    /// Copies slot `from` into slot `to`.
    pub fn copy_slot(&mut self, from: usize, to: usize) {
        if from == to {
            return;
        }
        let g = self.groups;
        if let Some(s) = &mut self.scratch {
            s.poses.copy_within(from * g..from * g + g, to * g);
        }
    }

    /// Writes the rest pose into slot `slot`.
    pub fn fill_rest(&mut self, slot: usize) {
        let rest = self.inputs.skeleton.rest_soa;
        let pose = self.pose_mut(slot);
        if pose.len() == rest.len() {
            pose.copy_from_slice(rest);
        }
    }

    /// Slot `slot` and the sampling scratch, for sampling a clip into the slot.
    pub fn pose_and_sample_scratch(&mut self, slot: usize) -> (&mut [SoaTransform], &mut [AosTransform]) {
        let r = self.slot_range(slot);
        match &mut self.scratch {
            Some(s) => (&mut s.poses[r], &mut *s.sample),
            None => (&mut [], &mut []),
        }
    }

    /// The current node's state words and `N` distinct pose slots, all writable at once.
    #[allow(clippy::type_complexity)]
    pub fn state_and_slots<const N: usize>(
        &mut self,
        slots: [usize; N],
    ) -> Option<(&mut [u32], [&mut [SoaTransform]; N])> {
        let g = self.groups;
        let node = self.node;
        let s = self.scratch.as_mut()?;
        let poses = split_slots(s.poses, g, slots)?;
        Some((self.program.node_state(self.state, g, node), poses))
    }

    /// The inertializer scratch with slots `a`, `b`, `c` (shared) and `out` (mutable), distinct.
    #[allow(clippy::type_complexity)]
    pub fn inertia_parts(
        &mut self,
        a: usize,
        b: usize,
        c: usize,
        out: usize,
    ) -> Option<(&mut Inertializer, [&[SoaTransform]; 3], &mut [SoaTransform])> {
        let g = self.groups;
        let s = self.scratch.as_mut()?;
        let [pa, pb, pc, po] = split_slots(s.poses, g, [a, b, c, out])?;
        Some((&mut *s.inertializer, [pa, pb, pc], po))
    }
}

/// `N` distinct slots of `g` transforms each from a pose stack, mutable at once; `None` when two
/// are equal or one is past the end. Never allocates.
fn split_slots<const N: usize>(
    poses: &mut [SoaTransform],
    g: usize,
    slots: [usize; N],
) -> Option<[&mut [SoaTransform]; N]> {
    let mut order: [usize; N] = core::array::from_fn(|i| i);
    order.sort_unstable_by_key(|&i| slots[i]);
    let mut out: [Option<&mut [SoaTransform]>; N] = core::array::from_fn(|_| None);
    let mut rest = poses;
    let mut base = 0usize;
    for &i in &order {
        let s = slots[i];
        if s < base {
            return None;
        }
        let skip = (s - base) * g;
        if rest.len() < skip + g {
            return None;
        }
        let (_, r) = core::mem::take(&mut rest).split_at_mut(skip);
        let (p, r) = r.split_at_mut(g);
        out[i] = Some(p);
        rest = r;
        base = s + 1;
    }
    if out.iter().any(|o| o.is_none()) {
        return None;
    }
    Some(out.map(|o| o.unwrap_or_default()))
}

/// Writes `pose` into `words` (`SOA_WORDS` per group).
pub fn pose_to_words(pose: &[SoaTransform], words: &mut [u32]) {
    for (t, w) in pose.iter().zip(words.chunks_exact_mut(SOA_WORDS)) {
        let comps = [
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
        ];
        for (c, o) in comps.iter().zip(w.chunks_exact_mut(4)) {
            o.copy_from_slice(&c.to_bits_array());
        }
    }
}

/// Reads `pose` back from `words` (the inverse of [`pose_to_words`], bit for bit).
pub fn pose_from_words(words: &[u32], pose: &mut [SoaTransform]) {
    for (t, w) in pose.iter_mut().zip(words.chunks_exact(SOA_WORDS)) {
        let c = |k: usize| {
            F32x4::new(
                f32::from_bits(w[4 * k]),
                f32::from_bits(w[4 * k + 1]),
                f32::from_bits(w[4 * k + 2]),
                f32::from_bits(w[4 * k + 3]),
            )
        };
        t.translation.x = c(0);
        t.translation.y = c(1);
        t.translation.z = c(2);
        t.rotation.x = c(3);
        t.rotation.y = c(4);
        t.rotation.z = c(5);
        t.rotation.w = c(6);
        t.scale.x = c(7);
        t.scale.y = c(8);
        t.scale.z = c(9);
    }
}

/// One node's entry in a compiled graph.
#[derive(Clone, Copy, Debug)]
pub struct NodeData<'a> {
    /// The node's index in the graph.
    pub index: u32,
    /// Its inputs (node indices).
    pub inputs: &'a [u32],
    /// Its parameter words, as the graph compiler laid them out for its kind (the family module
    /// documents them).
    pub params: &'a [u32],
}

impl NodeData<'_> {
    /// Parameter word `i` (0 when absent: a shorter block from an older compiler reads defaults).
    pub fn word(&self, i: usize) -> u32 {
        self.params.get(i).copied().unwrap_or(0)
    }
    /// Parameter word `i` as a float, or `default` when absent or not finite.
    pub fn f32_or(&self, i: usize, default: f32) -> f32 {
        match self.params.get(i) {
            Some(w) => {
                let v = f32::from_bits(*w);
                if v.is_finite() {
                    v
                } else {
                    default
                }
            }
            None => default,
        }
    }
}
