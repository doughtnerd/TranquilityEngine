//! The interpreter: a compiled graph turned into a runtime [`Program`], the [`EvalContext`] every
//! node sees, and a node's compiled data ([`NodeData`]).
//!
//! # Program
//!
//! [`Program::from_view`] copies a parsed `myco.animgraph@1` into flat tables once, at load (it
//! allocates; nothing after it does): the node table (family, kind, input range, parameter-word
//! range), the side tables (state machines, states, transitions, interrupt lists, condition
//! programs, chooser tables, slots, linked graphs), an evaluation order (every node after its
//! *children*: inputs, state roots, bridge nodes and chooser results), the graph's depth, its
//! parameter defaults and layer defaults, per-node load-time data ([`NodeData::aux`]: a blend
//! space's triangulation), the travel tables (next hop per machine, state pair), the update
//! contexts, the inertialization routing, and each node's **state layout**.
//!
//! # Instance state
//!
//! Every instance of a program owns one blob of `u32` words ([`Program::state_words`]): first the
//! **globals** (the graph parameters, 4 words each as `PARAMS` stores defaults; then one word per
//! request name the conditions read, its remaining lifetime as f32 bits, 0 when not live; then the
//! random generator's state), then each node's state in node order. A node declares its state
//! size in the [`Phase::Layout`] phase as *fixed words plus words per bone group* (a group is four
//! bones, `anim_math::layout`), so one program serves skeletons of any size and a node's offset is
//! `a + b · groups`. The blob is plain words, so snapshot and restore are a copy (prediction, ADR
//! 0370), and evaluation is deterministic.
//!
//! # Phases
//!
//! Families have one entry point, `evaluate(cx, kind, node)` routed by [`crate::dispatch`]; the
//! phase is in the context ([`EvalContext::phase`]):
//!
//! | Phase | Order | What a node does |
//! |---|---|---|
//! | [`Phase::Layout`] | once per node at load | [`EvalContext::set_state_words`] |
//! | [`Phase::Init`] | evaluation order, every node (or a context's nodes on entry) | fills its state from its parameters |
//! | [`Phase::Update`] | evaluation order, a context's direct members | advances time by [`EvalContext::dt`], fades, transitions, emits state events |
//! | [`Phase::Alpha`] | pulled from the output | [`EvalContext::set_alpha`]: how much real pose it outputs (0 = nothing, e.g. a player without a clip) |
//! | [`Phase::Pose`] | pulled from the output | writes its local pose into [`EvalContext::out`], pulling inputs with [`EvalContext::eval_pose`] |
//! | [`Phase::Root`] | pulled from the output | [`EvalContext::set_root`]: its root-motion delta this step |
//! | [`Phase::Tracks`] | pulled from the output, every input (weight 0 too) | clip players report their playhead's window at their effective weight ([`EvalContext::weight`]) to the host's [`TrackOutput`] |
//! | [`Phase::Timing`] | pulled | [`EvalContext::set_timing`]: the clip that times the node (its highest-weight clip player's playhead), for exit times, markers and normalised time |
//! | [`Phase::Weights`] | pulled, like Tracks | clip players register with [`EvalContext::collect_player`] at their effective weight (sync groups, blend-space sync, the debugger's active-node walk) |
//!
//! Pulled phases let a blend skip an input of weight 0 (Unreal's relevance), so an idle layer
//! costs nothing.
//!
//! # Update contexts (T31)
//!
//! Some nodes **gate** their children: a state machine (its states' sub-graphs and bridge nodes),
//! the random selector and the blend spaces (their inputs), a time-scale node (its input) and a
//! chooser (its row results). Each gated edge opens an *update context*; a node belongs to the
//! deepest context every path to it passes through (the lowest common ancestor of its incoming
//! edges' contexts). [`Program::update`] runs the root context's members in evaluation order;
//! a gating node runs a child context's members when (and at the rate) it wants with
//! [`EvalContext::update_context`], and re-initialises one on entry with
//! [`EvalContext::init_context`]. So an inactive state doesn't advance, a state restarts when it
//! is entered, and a blend space's samples advance at the blend space's synced rate. Nodes outside
//! any gate keep T13r's rule: every node updates every frame.
//!
//! Poses live on a stack of scratch slots ([`Program::pose_slots`] of them, each
//! `soa_len(bones)` groups) that the caller owns; a node pulling inputs reserves slots with
//! [`EvalContext::push_slot`] and gives them back with [`EvalContext::pop_slot`].
//!
//! # Inertialization routing (T31)
//!
//! [`EvalContext::request_inertialization`] writes the request into the requesting node's
//! nearest *ancestor* inertialization node (computed at load over the children edges; with
//! several parents, the lowest-index parent's route wins), not merely the next one in evaluation
//! order. Inside a linked graph without one, the request goes to the linked node's own ancestor.
//!
//! # Linked graphs (T31)
//!
//! A linked-graph node runs another program inside its own state words: the context swaps
//! program, bindings and state window ([`EvalContext::with_program`]), so the inner graph's nodes
//! address their own blob region and parameters exactly as at top level.
//!
//! # Extension points (later families)
//!
//! - A node kind is added in its family module: declare the kind, its parameter words, its state
//!   layout (Layout phase) and its phases. Nothing here changes.
//! - A node of a kind its family doesn't know (a newer graph) is handled here: its pose is its
//!   first input's (or the rest pose), its alpha, root and timing likewise; [`Program::unknown_nodes`]
//!   counts them so the loader reports it once.
//!
//! # T40 hooks (the rig family)
//!
//! Three additions, each the minimum the rig nodes can't do without: [`Inputs::rig`] (the
//! per-frame IK targets, ray hits, ray-request outputs, character transform and rig LOD, plus the
//! skeleton's joint limits and roles, read through [`EvalContext::rig`]); [`ClipRef::cues`] and
//! [`ClipRef::distance`] (motion-warp windows named by cue markers; distance matching's travel
//! curve); and the rig family's `DISTANCE_MATCH` gating its input (it advances its child at a
//! computed rate, as `TIME_SCALE` does at a fixed one).

use anim_format::frames::FrameClock;
use anim_format::graph::{
    AnimGraphView, CondNode, CondProgram, How, Interrupt, Operand, ParamType, ParamValue,
    Transition,
};
use anim_format::{F32s, NONE};
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_pose::inertialize::Inertializer;
use anim_pose::root::RootDelta;
use anim_pose::sync::SyncMarker;
use anim_sample::{BoundClip, Window};

use crate::dispatch::{dispatch, Family, NodeStatus};

/// Words per [`SoaTransform`] in a state blob: ten components (translation 3, rotation 4,
/// scale 3) of four lanes.
pub const SOA_WORDS: usize = 40;

/// The most clip players one [`Phase::Weights`] walk collects (sync groups, blend-space sync).
pub const MAX_COLLECTED: usize = 32;

/// The phase an [`EvalContext`] runs (module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Layout,
    Init,
    Update,
    Alpha,
    Pose,
    Root,
    Tracks,
    Timing,
    Weights,
}

impl Phase {
    /// The weighted walks (every input visited with its effective weight).
    pub fn is_weighted(self) -> bool {
        matches!(self, Phase::Tracks | Phase::Weights)
    }
}

/// The FNV-1a 32-bit hash of a name's UTF-8 bytes. Graph strings and clip strings are separate
/// tables, so names that must match across them (sync and exit markers, curves, linked-graph
/// parameters) are compared by this hash.
pub fn name_hash(name: &str) -> u32 {
    let mut h = 0x811C_9DC5u32;
    for b in name.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// A loaded clip as nodes see it.
#[derive(Clone, Copy)]
pub struct ClipRef<'a> {
    /// The clip's sampler (its compressed form, else its raw form) with its binding table.
    pub bound: BoundClip<'a, 'a>,
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
    /// Its sync markers sorted by time, each `id` the [`name_hash`] of its name (so phases match
    /// across clips whose string tables differ).
    pub sync: &'a [SyncMarker],
    /// Its `exit` markers' times, sorted.
    pub exits: &'a [f32],
    /// Its `curve` tracks: ([`name_hash`] of the curve name, track index).
    pub curves: &'a [(u32, u32)],
    /// Its `cue` markers sorted by time, ids as [`name_hash`] (T40: motion-warp windows named in
    /// the clip, ADR 0372).
    pub cues: &'a [SyncMarker],
    /// Its root curve's cumulative ground travel per frame (`anim_rig::warp::cumulative_distance`
    /// over the curve's positions, up +Y; empty without a curve). T40: distance matching.
    pub distance: &'a [f32],
}

impl ClipRef<'_> {
    /// Where its frames (root curve, travel) sit in time: frame `i` at `min(i / rate, duration)`.
    pub fn frame_clock(&self) -> FrameClock {
        FrameClock::new(self.duration, self.sample_rate, self.frame_count)
    }
}

/// A loaded graph as a linked-graph node sees it.
#[derive(Clone, Copy)]
pub struct GraphRef<'a> {
    pub program: &'a Program,
    /// An asset handle per string id of that graph.
    pub bindings: &'a [u32],
}

/// What the interpreter reads from the host's asset arena. Handles are opaque to the graph; a
/// stale or released handle answers `None`, and the node behaves as if it had nothing.
pub trait Assets {
    /// The clip of `handle`.
    fn clip(&self, handle: u32) -> Option<ClipRef<'_>>;
    /// The bone mask of `handle`, packed like a pose (`soa_len(bones)` groups of four weights).
    fn mask(&self, handle: u32) -> Option<&[F32x4]>;
    /// The graph of `handle` (linked graphs).
    fn graph(&self, _handle: u32) -> Option<GraphRef<'_>> {
        None
    }
    /// The retarget map of `handle` (the `retarget` family's node, T41).
    fn retarget(&self, _handle: u32) -> Option<crate::retarget::RetargetRef<'_>> {
        None
    }
    /// The pose database of `handle` (T42: the `matching` family's database node).
    fn match_db(&self, _handle: u32) -> Option<crate::matching::MatchRef<'_>> {
        None
    }
    /// The host that runs third-party node modules (T45: the `plugin` family), if any.
    fn plugins(&self) -> Option<&dyn crate::plugin::PluginHost> {
        None
    }
    /// A tag that changes whenever memory a released asset lived in may hold another (T82r: the
    /// clip players' `FrameCache` tag).
    fn cache_epoch(&self) -> u32 {
        0
    }
}

/// A playback event for the host (play promises, `AnimatorStateChanges`, the graph family's
/// state-change records).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateEventKind {
    /// A play reached its end (a non-looping clip at its last frame). `layer`, `play_id`.
    Finished,
    /// A play was replaced or stopped before it finished. `layer`, `play_id`.
    Interrupted,
    /// A machine entered a state: `layer` the machine index, `play_id` the state (local index).
    StateEntered,
    /// A machine left a state (it stopped contributing): as [`StateEventKind::StateEntered`].
    StateExited,
    /// A slot play reached its end: `layer` the slot index, `play_id` the play.
    SlotFinished,
    /// A slot play was replaced by another play.
    SlotInterrupted,
    /// A slot play was stopped by a command.
    SlotStopped,
    /// A request was consumed: `layer` its name string id, `play_id` the transition index.
    RequestConsumed,
    /// A request's lifetime ran out: `layer` its name string id.
    RequestExpired,
}

/// One playback event (see [`StateEventKind`] for what `layer` and `play_id` hold).
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

/// Where clip players report what their tracks did this frame (the host samples the clip's
/// property and event tracks over the window, `anim-sample`'s windows, into its outputs).
pub trait TrackOutput {
    /// Clip `clip` played over `window` at effective weight `weight`; `open` is the play's
    /// notify-state bits.
    fn window(&mut self, clip: u32, window: &Window, weight: f32, open: &mut [u32]);
    /// Clip `clip`'s play ended early (replaced or cleared) at clip time `time`: end its open
    /// notify states.
    fn end(&mut self, clip: u32, time: f32, open: &mut [u32]);
}

/// A visitor of every node a [`Phase::Weights`] walk reaches, with its effective weight (the
/// debugger's active-node list).
pub trait Visit {
    fn node(&mut self, node: u32, weight: f32);
}

/// What times a node: the playhead of its highest-weight clip ([`Phase::Timing`]). `clip` 0: none.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Timing {
    /// The clip's asset handle (0: nothing plays).
    pub clip: u32,
    /// Clip time now, seconds.
    pub time: f32,
    /// Clip time before the last update.
    pub prev: f32,
    /// The last update's signed travel (`speed × dt`, unwrapped).
    pub delta: f32,
    /// The clip's duration.
    pub duration: f32,
    /// Whether the play loops.
    pub looping: bool,
    /// A sub-machine sits in an exit state (its parent's `when: exit` transitions may leave).
    pub exit: bool,
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
    /// The bind pose (local transforms of the inverse bind matrices' model pose), packed. Empty:
    /// the rest pose.
    pub bind_soa: &'a [SoaTransform],
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
    /// The rig stack's per-frame inputs and outputs (T40: IK targets, ray hits and requests, the
    /// character's transform, rig LOD) and the skeleton's joint limits and roles;
    /// [`RigInputs::NONE`](crate::rig::RigInputs::NONE) when there are none.
    pub rig: crate::rig::RigInputs<'a>,
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
    /// A machine, chooser, slot or linked-graph table entry names a node of another kind, or a
    /// node another entry already names (the evaluator reads that node's state as the entry's).
    Kind,
}

/// Records that table entry `index` owns `node`, which must be a `(family, kind)` node no other
/// entry owns.
fn claim(
    side: &mut [u32],
    nodes: &[ProgNode],
    node: u32,
    want: (Family, u16),
    index: usize,
) -> Result<(), ProgramError> {
    let n = nodes.get(node as usize).ok_or(ProgramError::Range)?;
    if (n.family, n.kind) != want || side[node as usize] != NONE {
        return Err(ProgramError::Kind);
    }
    side[node as usize] = index as u32;
    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct ProgNode {
    family: Family,
    kind: u16,
    inputs: (u32, u32),
    params: (u32, u32),
    aux: (u32, u32),
    /// The state offset is `off_fixed + off_group · groups`; its length `len_fixed + len_group ·
    /// groups`.
    off_fixed: u32,
    off_group: u32,
    len_fixed: u32,
    len_group: u32,
}

/// A state machine as the logic family reads it.
#[derive(Clone, Copy, Debug)]
pub struct MachineInfo {
    pub node: u32,
    pub name: u32,
    /// First state (global index) and count; states are addressed by local index.
    pub states: (u32, u32),
    pub entry: u32,
    /// First any-state transition and count.
    pub any: (u32, u32),
    /// The machine's next-hop table in the program's hop list (`count²` words).
    pub hops: u32,
}

/// A state.
#[derive(Clone, Copy, Debug)]
pub struct StateInfo {
    pub name: u32,
    /// Its sub-graph's root.
    pub node: u32,
    /// Its transitions in priority order.
    pub transitions: (u32, u32),
    pub flags: u32,
    /// The update context of its sub-graph.
    pub ctx: u32,
}

/// A chooser table.
#[derive(Clone, Copy, Debug)]
pub struct ChooserInfo {
    pub node: u32,
    pub rows: (u32, u32),
    pub fallback: u32,
    pub fallback_ctx: u32,
}

/// A chooser row: condition program, result node, its update context.
#[derive(Clone, Copy, Debug)]
pub struct RowInfo {
    pub condition: u32,
    pub node: u32,
    pub ctx: u32,
}

/// A slot or linked-graph entry: name string id, node, and the group string id (slots) or default
/// graph string id (linked graphs).
#[derive(Clone, Copy, Debug)]
pub struct NamedNode {
    pub name: u32,
    pub node: u32,
    pub extra: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Ctx {
    parent: u32,
    depth: u32,
    direct: (u32, u32),
    all: (u32, u32),
}

/// A compiled graph ready to run (module docs). Built once per graph asset; shared by every
/// instance of it.
#[derive(Clone, Debug)]
pub struct Program {
    nodes: Vec<ProgNode>,
    inputs: Vec<u32>,
    params: Vec<u32>,
    aux: Vec<u32>,
    order: Vec<u32>,
    output: u32,
    depth: u32,
    param_defaults: Vec<[u32; 4]>,
    param_types: Vec<ParamType>,
    param_hashes: Vec<u32>,
    layer_defaults: Vec<f32>,
    /// Request name string ids, sorted; a request's lifetime word is `requests_at + index`.
    requests: Vec<u32>,
    string_hashes: Vec<u32>,
    state_fixed: u32,
    state_group: u32,
    unknown: u32,
    pub(crate) machines: Vec<MachineInfo>,
    pub(crate) states: Vec<StateInfo>,
    pub(crate) transitions: Vec<Transition>,
    /// The update context of each transition's bridge node (`NONE` without one).
    pub(crate) trans_ctx: Vec<u32>,
    pub(crate) interrupts: Vec<u32>,
    pub(crate) cond_programs: Vec<CondProgram>,
    pub(crate) conds: Vec<CondNode>,
    pub(crate) choosers: Vec<ChooserInfo>,
    pub(crate) rows: Vec<RowInfo>,
    pub(crate) slots: Vec<NamedNode>,
    pub(crate) linked: Vec<NamedNode>,
    /// Next-hop transitions (global index or `NONE`) per machine, `from · count + to`.
    pub(crate) hops: Vec<u32>,
    /// Per node: its index in the side table its kind uses (machine, chooser, slot, linked), or
    /// `NONE`.
    side: Vec<u32>,
    /// Per input edge: the update context it opens (`NONE`: not gated).
    input_ctx: Vec<u32>,
    ctxs: Vec<Ctx>,
    ctx_lists: Vec<u32>,
    node_ctx: Vec<u32>,
    inertia_target: Vec<u32>,
    /// T82r: per node, the frame-cache slot of its first clip player (`NONE` for kinds without
    /// players; a slot node has two, a clip player and a database node one), and the slot count
    /// (`Program::pose_cached`).
    player_ordinal: Vec<u32>,
    player_count: u32,
}

/// Which (family, kind) pairs gate their inputs (module docs).
fn gates_inputs(family: Family, kind: u16) -> bool {
    match family {
        Family::Sources => matches!(
            kind,
            crate::sources::kind::BLEND_SPACE_1D | crate::sources::kind::BLEND_SPACE_2D
        ),
        Family::Logic => kind == crate::logic::kind::RANDOM,
        Family::Mixing => kind == crate::mixing::kind::TIME_SCALE,
        Family::Rig => crate::rig::gates_input(kind),
        _ => false,
    }
}

fn is_inertializer(n: &ProgNode) -> bool {
    n.family == Family::Mixing && n.kind == crate::mixing::kind::INERTIALIZE
}

/// What an edge of the children graph opens.
#[derive(Clone, Copy)]
enum EdgeRef {
    /// A plain input (not gated) or a gated one: index into `inputs`.
    Input(u32),
    State(u32),
    Bridge(u32),
    Row(u32),
    Fallback(u32),
}

impl Program {
    /// The program of a parsed graph. Allocates (load time only).
    pub fn from_view(view: &AnimGraphView<'_>) -> Result<Program, ProgramError> {
        let n = view.node_count();
        let mut nodes = Vec::with_capacity(n);
        let mut inputs = Vec::new();
        let blocks = view.param_blocks();
        let params: Vec<u32> = blocks.iter().collect();
        let mut aux = Vec::new();
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
            let words = &params[node.params_first as usize..end as usize];
            let aux_first = aux.len() as u32;
            if family == Family::Sources {
                crate::sources::build_aux(node.kind, words, list.len(), &mut aux);
            }
            nodes.push(ProgNode {
                family,
                kind: node.kind,
                inputs: (first, list.len() as u32),
                params: (node.params_first, node.params_count),
                aux: (aux_first, aux.len() as u32 - aux_first),
                off_fixed: 0,
                off_group: 0,
                len_fixed: 0,
                len_group: 0,
            });
        }
        let strings = view.strings();
        let string_hashes: Vec<u32> = strings.iter().map(name_hash).collect();
        let mut param_defaults = Vec::new();
        let mut param_types = Vec::new();
        let mut param_hashes = Vec::new();
        for p in (0..view.param_count()).filter_map(|i| view.param(i)) {
            param_defaults.push(param_words(p.default));
            param_types.push(p.default.ty());
            param_hashes.push(string_hashes.get(p.name as usize).copied().unwrap_or(0));
        }
        let layer_defaults = (0..view.layer_count())
            .filter_map(|i| view.layer(i))
            .map(|l| l.weight)
            .collect();
        let output = view.output();
        if output as usize >= n {
            return Err(ProgramError::Range);
        }
        let mut side = vec![NONE; n];
        let machines_v: Vec<_> = (0..view.machine_count())
            .filter_map(|i| view.machine(i))
            .collect();
        let states_v: Vec<_> = (0..view.state_count())
            .filter_map(|i| view.state(i))
            .collect();
        let transitions: Vec<Transition> = (0..view.transition_count())
            .filter_map(|i| view.transition(i))
            .collect();
        let mut machines = Vec::new();
        for (mi, m) in machines_v.iter().enumerate() {
            claim(
                &mut side,
                &nodes,
                m.node,
                (Family::Logic, crate::logic::kind::STATE_MACHINE),
                mi,
            )?;
            machines.push(MachineInfo {
                node: m.node,
                name: m.name,
                states: (m.states_first, m.states_count),
                entry: m.entry,
                any: (m.any_first, m.any_count),
                hops: 0,
            });
        }
        let states = states_v
            .iter()
            .map(|s| StateInfo {
                name: s.name,
                node: s.node,
                transitions: (s.transitions_first, s.transitions_count),
                flags: s.flags,
                ctx: NONE,
            })
            .collect();
        let mut choosers = Vec::new();
        for (ci, c) in (0..view.chooser_count())
            .filter_map(|i| view.chooser(i))
            .enumerate()
        {
            claim(
                &mut side,
                &nodes,
                c.node,
                (Family::Logic, crate::logic::kind::CHOOSER),
                ci,
            )?;
            choosers.push(ChooserInfo {
                node: c.node,
                rows: (c.rows_first, c.rows_count),
                fallback: c.fallback,
                fallback_ctx: NONE,
            });
        }
        let rows = (0..view.chooser_row_count())
            .filter_map(|i| view.chooser_row(i))
            .map(|r| RowInfo {
                condition: r.condition,
                node: r.node,
                ctx: NONE,
            })
            .collect();
        let mut slots = Vec::new();
        for (si, s) in (0..view.slot_count())
            .filter_map(|i| view.slot(i))
            .enumerate()
        {
            claim(
                &mut side,
                &nodes,
                s.node,
                (Family::Slots, crate::slots::kind::SLOT),
                si,
            )?;
            slots.push(NamedNode {
                name: s.name,
                node: s.node,
                extra: s.group,
            });
        }
        let mut linked = Vec::new();
        for (li, l) in (0..view.linked_count())
            .filter_map(|i| view.linked(i))
            .enumerate()
        {
            claim(
                &mut side,
                &nodes,
                l.node,
                (Family::Slots, crate::slots::kind::LINKED),
                li,
            )?;
            linked.push(NamedNode {
                name: l.name,
                node: l.node,
                extra: l.default_graph,
            });
        }
        let conds: Vec<CondNode> = (0..view.condition_count())
            .filter_map(|i| view.condition(i))
            .collect();
        let mut requests: Vec<u32> = conds
            .iter()
            .filter_map(|c| match c {
                CondNode::Compare {
                    operand: Operand::Request(id),
                    ..
                } => Some(*id),
                _ => None,
            })
            .collect();
        crate::sources::triangulate::sort_small(&mut requests, |a, b| a < b);
        requests.dedup();
        let trans_n = transitions.len();
        let input_n = inputs.len();
        let mut program = Program {
            nodes,
            inputs,
            params,
            aux,
            order: Vec::new(),
            output,
            depth: 0,
            param_defaults,
            param_types,
            param_hashes,
            layer_defaults,
            requests,
            string_hashes,
            state_fixed: 0,
            state_group: 0,
            unknown: 0,
            machines,
            states,
            transitions,
            trans_ctx: vec![NONE; trans_n],
            interrupts: view.interrupts().to_vec(),
            cond_programs: (0..view.program_count())
                .filter_map(|i| view.program(i))
                .collect(),
            conds,
            choosers,
            rows,
            slots,
            linked,
            hops: Vec::new(),
            side,
            input_ctx: vec![NONE; input_n],
            ctxs: Vec::new(),
            ctx_lists: Vec::new(),
            node_ctx: vec![0; n],
            inertia_target: vec![NONE; n],
            player_ordinal: vec![NONE; n],
            player_count: 0,
        };
        for (i, node) in program.nodes.iter().enumerate() {
            let players = match (node.family, node.kind) {
                (Family::Sources, crate::sources::kind::CLIP_PLAYER) => 1,
                (Family::Slots, crate::slots::kind::SLOT) => 2,
                (Family::Matching, crate::matching::kind::POSE_DATABASE) => 1,
                _ => 0,
            };
            if players > 0 {
                program.player_ordinal[i] = program.player_count;
                program.player_count += players;
            }
        }
        let children = program.children();
        program.order = topological_order(&children);
        program.depth = program.longest_chain(&children);
        program.contexts(&children);
        program.route_inertialization(&children);
        program.build_hops();
        program.layout()?;
        Ok(program)
    }

    /// Every node's children (inputs, state roots, bridges, chooser results) with the edge each is.
    fn children(&self) -> Vec<Vec<(u32, EdgeRef)>> {
        let mut out: Vec<Vec<(u32, EdgeRef)>> = vec![Vec::new(); self.nodes.len()];
        for (i, n) in self.nodes.iter().enumerate() {
            for k in n.inputs.0..n.inputs.0 + n.inputs.1 {
                out[i].push((self.inputs[k as usize], EdgeRef::Input(k)));
            }
        }
        for m in &self.machines {
            for s in m.states.0..m.states.0 + m.states.1 {
                if let Some(st) = self.states.get(s as usize) {
                    out[m.node as usize].push((st.node, EdgeRef::State(s)));
                }
            }
            let mut ranges = vec![m.any];
            for s in m.states.0..m.states.0 + m.states.1 {
                if let Some(st) = self.states.get(s as usize) {
                    ranges.push(st.transitions);
                }
            }
            for (first, count) in ranges {
                for t in first..first + count {
                    if let Some(Transition {
                        how: How::Bridge { node, .. },
                        ..
                    }) = self.transitions.get(t as usize)
                    {
                        out[m.node as usize].push((*node, EdgeRef::Bridge(t)));
                    }
                }
            }
        }
        for (ci, c) in self.choosers.iter().enumerate() {
            for r in c.rows.0..c.rows.0 + c.rows.1 {
                if let Some(row) = self.rows.get(r as usize) {
                    out[c.node as usize].push((row.node, EdgeRef::Row(r)));
                }
            }
            if c.fallback != NONE {
                out[c.node as usize].push((c.fallback, EdgeRef::Fallback(ci as u32)));
            }
        }
        out
    }

    /// The most nodes on one children chain (1 for a lone node), plus each linked-graph node's
    /// declared depth capacity.
    fn longest_chain(&self, children: &[Vec<(u32, EdgeRef)>]) -> u32 {
        let mut depth = vec![0u32; self.nodes.len()];
        let mut most = 0;
        for &i in &self.order {
            let below = children[i as usize]
                .iter()
                .map(|(c, _)| depth[*c as usize])
                .max()
                .unwrap_or(0);
            let n = &self.nodes[i as usize];
            let extra = if n.family == Family::Slots && n.kind == crate::slots::kind::LINKED {
                let words = &self.params[n.params.0 as usize..(n.params.0 + n.params.1) as usize];
                crate::slots::linked_depth(words)
            } else if n.family == Family::Retarget {
                // T41: the source graph's declared depth, run in its own region of the stack.
                let words = &self.params[n.params.0 as usize..(n.params.0 + n.params.1) as usize];
                crate::retarget::node_depth(n.kind, words)
            } else {
                0
            };
            depth[i as usize] = below + 1 + extra;
            most = most.max(depth[i as usize]);
        }
        most
    }

    /// Builds the update contexts (module docs).
    fn contexts(&mut self, children: &[Vec<(u32, EdgeRef)>]) {
        let n = self.nodes.len();
        let mut ctxs = vec![Ctx::default()];
        let mut keys: Vec<(u32, u32, u32)> = Vec::new(); // (gating node, child, ctx)
        let mut candidate: Vec<Option<u32>> = vec![None; n];
        let lca = |ctxs: &[Ctx], mut a: u32, mut b: u32| {
            while ctxs[a as usize].depth > ctxs[b as usize].depth {
                a = ctxs[a as usize].parent;
            }
            while ctxs[b as usize].depth > ctxs[a as usize].depth {
                b = ctxs[b as usize].parent;
            }
            while a != b {
                a = ctxs[a as usize].parent;
                b = ctxs[b as usize].parent;
            }
            a
        };
        for &p in self.order.iter().rev() {
            let pc = candidate[p as usize].unwrap_or(0);
            self.node_ctx[p as usize] = pc;
            let node = self.nodes[p as usize];
            for &(child, edge) in &children[p as usize] {
                let gated = match edge {
                    EdgeRef::Input(_) => gates_inputs(node.family, node.kind),
                    _ => true,
                };
                let c = if gated {
                    let id = match keys.iter().find(|k| k.0 == p && k.1 == child) {
                        Some(k) => k.2,
                        None => {
                            let id = ctxs.len() as u32;
                            ctxs.push(Ctx {
                                parent: pc,
                                depth: ctxs[pc as usize].depth + 1,
                                ..Ctx::default()
                            });
                            keys.push((p, child, id));
                            id
                        }
                    };
                    match edge {
                        EdgeRef::Input(k) => self.input_ctx[k as usize] = id,
                        EdgeRef::State(s) => self.states[s as usize].ctx = id,
                        EdgeRef::Bridge(t) => self.trans_ctx[t as usize] = id,
                        EdgeRef::Row(r) => self.rows[r as usize].ctx = id,
                        EdgeRef::Fallback(ci) => self.choosers[ci as usize].fallback_ctx = id,
                    }
                    id
                } else {
                    pc
                };
                let slot = &mut candidate[child as usize];
                *slot = Some(match *slot {
                    None => c,
                    Some(prev) => lca(&ctxs, prev, c),
                });
            }
        }
        // Member lists in evaluation order: direct members, then every descendant's.
        let mut lists = Vec::new();
        for (ci, ctx) in ctxs.iter_mut().enumerate() {
            let first = lists.len() as u32;
            for &i in &self.order {
                if self.node_ctx[i as usize] == ci as u32 {
                    lists.push(i);
                }
            }
            ctx.direct = (first, lists.len() as u32 - first);
        }
        let parents: Vec<u32> = ctxs.iter().map(|c| c.parent).collect();
        let within = |mut c: u32, ancestor: u32| loop {
            if c == ancestor {
                return true;
            }
            if c == 0 {
                return false;
            }
            c = parents[c as usize];
        };
        for (ci, ctx) in ctxs.iter_mut().enumerate() {
            let first = lists.len() as u32;
            for &i in &self.order {
                if within(self.node_ctx[i as usize], ci as u32) {
                    lists.push(i);
                }
            }
            ctx.all = (first, lists.len() as u32 - first);
        }
        self.ctxs = ctxs;
        self.ctx_lists = lists;
    }

    /// Each node's nearest ancestor inertialization node (module docs).
    fn route_inertialization(&mut self, children: &[Vec<(u32, EdgeRef)>]) {
        let n = self.nodes.len();
        let mut parents: Vec<Vec<u32>> = vec![Vec::new(); n];
        for (p, list) in children.iter().enumerate() {
            for &(c, _) in list {
                parents[c as usize].push(p as u32);
            }
        }
        for &c in self.order.iter().rev() {
            let mut ps = parents[c as usize].clone();
            crate::sources::triangulate::sort_small(&mut ps, |a, b| a < b);
            ps.dedup();
            let target = ps.iter().find_map(|&p| {
                if is_inertializer(&self.nodes[p as usize]) {
                    Some(p)
                } else {
                    let t = self.inertia_target[p as usize];
                    (t != NONE).then_some(t)
                }
            });
            self.inertia_target[c as usize] = target.unwrap_or(NONE);
        }
    }

    /// The candidate transitions out of local state `s` of machine `m`, in the order the machine
    /// tries them: any-state transitions (except those into `s`), then the state's own.
    pub(crate) fn candidates(&self, m: &MachineInfo, s: u32) -> impl Iterator<Item = u32> + '_ {
        let st = self.states.get((m.states.0 + s) as usize);
        let (first, count) = st.map_or((0, 0), |st| st.transitions);
        let any = m.any.0..m.any.0 + m.any.1;
        any.filter(move |&t| self.transitions.get(t as usize).map(|t| t.target) != Some(s))
            .chain(first..first + count)
    }

    /// Next-hop tables: breadth-first from every state over the candidate transitions, so the path
    /// is shortest by transition count with ties going to the earlier (higher-priority) candidate.
    fn build_hops(&mut self) {
        let mut hops = Vec::new();
        for mi in 0..self.machines.len() {
            let m = self.machines[mi];
            let count = m.states.1 as usize;
            self.machines[mi].hops = hops.len() as u32;
            let base = hops.len();
            hops.resize(base + count * count, NONE);
            for from in 0..count {
                // first[s]: the first transition of the path from `from` to `s`.
                let mut first = vec![NONE; count];
                let mut seen = vec![false; count];
                seen[from] = true;
                let mut queue = std::collections::VecDeque::from([from as u32]);
                while let Some(x) = queue.pop_front() {
                    for t in self.candidates(&m, x).collect::<Vec<_>>() {
                        let target = self.transitions[t as usize].target as usize;
                        if target < count && !seen[target] {
                            seen[target] = true;
                            first[target] = if x as usize == from {
                                t
                            } else {
                                first[x as usize]
                            };
                            queue.push_back(target as u32);
                        }
                    }
                }
                hops[base + from * count..base + (from + 1) * count].copy_from_slice(&first);
            }
        }
        self.hops = hops;
    }

    /// Runs the Layout phase: each node's state size, then the offsets.
    fn layout(&mut self) -> Result<(), ProgramError> {
        let mut fixed = self.globals_words() as u64;
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

    /// Words of globals: parameters, request lifetimes, the random generator.
    fn globals_words(&self) -> usize {
        4 * self.param_defaults.len() + self.requests.len() + 1
    }

    fn requests_at(&self) -> usize {
        4 * self.param_defaults.len()
    }

    fn rng_at(&self) -> usize {
        4 * self.param_defaults.len() + self.requests.len()
    }

    /// Nodes whose family has no node of their kind (they pass their first input through).
    pub fn unknown_nodes(&self) -> u32 {
        self.unknown
    }

    /// The number of nodes.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// The clip players of the program's nodes (clip player and database nodes one each, slots
    /// two): the frame-cache slots [`pose_cached`](Self::pose_cached) uses (T82r).
    pub fn clip_players(&self) -> usize {
        self.player_count as usize
    }

    /// Node `node`'s family and kind.
    pub fn node_kind(&self, node: u32) -> Option<(Family, u16)> {
        self.nodes.get(node as usize).map(|n| (n.family, n.kind))
    }

    /// The output node.
    pub fn output(&self) -> u32 {
        self.output
    }

    /// The default weights of the graph's layers (its `LAYERS` table), by layer index.
    pub fn layer_defaults(&self) -> &[f32] {
        &self.layer_defaults
    }

    /// The number of graph parameters.
    pub fn param_count(&self) -> usize {
        self.param_defaults.len()
    }

    /// Parameter `i`'s type.
    pub fn param_type(&self, i: usize) -> Option<ParamType> {
        self.param_types.get(i).copied()
    }

    /// Parameter `i`'s name hash ([`name_hash`]).
    pub fn param_hash(&self, i: usize) -> u32 {
        self.param_hashes.get(i).copied().unwrap_or(0)
    }

    /// The [`name_hash`] of string id `id` of the graph (0 for none).
    pub fn string_hash(&self, id: u32) -> u32 {
        self.string_hashes.get(id as usize).copied().unwrap_or(0)
    }

    /// The request names the conditions read (string ids, sorted).
    pub fn requests(&self) -> &[u32] {
        &self.requests
    }

    /// The number of state machines.
    pub fn machine_count(&self) -> usize {
        self.machines.len()
    }

    /// Machine `m`'s node and state count.
    pub fn machine(&self, m: usize) -> Option<(u32, u32)> {
        self.machines.get(m).map(|x| (x.node, x.states.1))
    }

    /// The number of transitions.
    pub fn transition_count(&self) -> usize {
        self.transitions.len()
    }

    /// The slots (`SLOTS` order): name string id, node, group string id.
    pub fn slots(&self) -> &[NamedNode] {
        &self.slots
    }

    /// The linked-graph slots (`LINKED` order): name string id, node, default graph string id.
    pub fn linked(&self) -> &[NamedNode] {
        &self.linked
    }

    /// Node `node`'s parameter words.
    pub fn node_params(&self, node: u32) -> Option<&[u32]> {
        let n = self.nodes.get(node as usize)?;
        self.params
            .get(n.params.0 as usize..(n.params.0 + n.params.1) as usize)
    }

    /// Node `node`'s index in its kind's side table, or `NONE`.
    pub fn side(&self, node: u32) -> u32 {
        self.side.get(node as usize).copied().unwrap_or(NONE)
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
        let (at, len) = self.node_range(groups, node);
        &mut state[at..at + len]
    }

    /// Whether `state`, a blob of this program for a skeleton of `groups` bone groups (a restored
    /// snapshot's), holds only what the evaluator can run: the words that name a state,
    /// transition, node, pick or linked graph, or count entries, are in range. The evaluator
    /// indexes with those words unchecked, so a host refuses a blob that fails this.
    pub fn check_state(&self, state: &[u32], groups: usize, assets: &dyn Assets) -> bool {
        if state.len() != self.state_words(groups) {
            return false;
        }
        (0..self.nodes.len() as u32).all(|i| {
            let n = self.nodes[i as usize];
            let (at, len) = self.node_range(groups, i);
            let Some(s) = state.get(at..at + len) else {
                return false;
            };
            match n.family {
                Family::Logic => crate::logic::check_state(self, i, n.kind, s),
                Family::Slots => crate::slots::check_state(self, i, n.kind, s, groups, assets),
                Family::Physics => crate::physics::check_state(n.kind, s),
                Family::Retarget => crate::retarget::check_state(self, i, n.kind, s, assets),
                _ => true,
            }
        })
    }

    fn node_range(&self, groups: usize, node: u32) -> (usize, usize) {
        let n = &self.nodes[node as usize];
        let at = n.off_fixed as usize + n.off_group as usize * groups;
        let len = n.len_fixed as usize + n.len_group as usize * groups;
        (at, len)
    }

    /// The graph parameter `index`'s four words within a blob.
    pub fn param_state<'s>(&self, state: &'s mut [u32], index: usize) -> &'s mut [u32] {
        &mut state[4 * index..4 * index + 4]
    }

    /// The lifetime word of request name `name` (a string id) within a blob, if the graph reads it.
    pub fn request_state<'s>(&self, state: &'s mut [u32], name: u32) -> Option<&'s mut u32> {
        let i = self.requests.binary_search(&name).ok()?;
        state.get_mut(self.requests_at() + i)
    }

    /// The random generator's word within a blob.
    pub fn rng_state<'s>(&self, state: &'s mut [u32]) -> &'s mut u32 {
        &mut state[self.rng_at()]
    }

    /// Fills a fresh instance blob (`state_words(groups)` long): parameter defaults, then every
    /// node's Init phase.
    pub fn init_state(&self, inputs: &Inputs<'_>, state: &mut [u32]) {
        state.fill(0);
        self.init_globals(state);
        let mut sink = NoEvents;
        let mut cx = EvalContext::with(self, Phase::Init, inputs, state, &mut sink, None, 0.0);
        for &i in &self.order {
            cx.run(i);
        }
    }

    fn init_globals(&self, state: &mut [u32]) {
        for (i, d) in self.param_defaults.iter().enumerate() {
            state[4 * i..4 * i + 4].copy_from_slice(d);
        }
        state[self.rng_at()] = DEFAULT_SEED;
    }

    /// Advances every node by `dt` seconds (playheads, fades, transitions), then ages the live
    /// requests, emitting state events. Never allocates.
    pub fn update(&self, inputs: &Inputs<'_>, state: &mut [u32], dt: f32, events: &mut dyn Events) {
        let mut cx = EvalContext::with(self, Phase::Update, inputs, state, events, None, dt);
        cx.update_context(0, dt);
        cx.age_requests(dt);
    }

    /// The output's local pose into `out` (`groups` transforms). Never allocates.
    pub fn pose(
        &self,
        inputs: &Inputs<'_>,
        state: &mut [u32],
        scratch: Scratch<'_>,
        out: &mut [SoaTransform],
    ) {
        self.pose_cached(inputs, state, scratch, (&mut [], &mut []), out);
    }

    /// [`pose`](Self::pose), with memory for the clip players' frame caches (T82r,
    /// `anim_sample::FrameCache`): `players` holds the slots' headers
    /// (`FrameCache::header_len(bones)` words each) and frames (an equal share each), one per clip
    /// player ([`clip_players`](Self::clip_players) slots give each of the program's players its
    /// own; linked graphs' players may share one, which is then refilled). The pose doesn't depend on the slots' contents, so the caller
    /// keeps them out of snapshots. Never allocates.
    pub fn pose_cached(
        &self,
        inputs: &Inputs<'_>,
        state: &mut [u32],
        scratch: Scratch<'_>,
        players: (&mut [u32], &mut [SoaTransform]),
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
        let slots = players.0.len() / anim_sample::FrameCache::header_len(inputs.skeleton.bones());
        cx.player_header_len = anim_sample::FrameCache::header_len(inputs.skeleton.bones());
        cx.player_frame_len = players.1.len().checked_div(slots).unwrap_or(0);
        cx.player_headers = players.0;
        cx.player_frames = players.1;
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

    /// Reports every clip player's window of the last update to `out`, with the weight the
    /// output gives it (Tracks phase). Never allocates.
    pub fn tracks(&self, inputs: &Inputs<'_>, state: &mut [u32], out: &mut dyn TrackOutput) {
        let mut sink = NoEvents;
        let mut cx = EvalContext::with(self, Phase::Tracks, inputs, state, &mut sink, None, 0.0);
        cx.tracks = Some(out);
        cx.eval_tracks(self.output, 1.0);
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

    /// Visits every node the output's weighted walk reaches with its effective weight (Weights
    /// phase; the debugger). Never allocates.
    pub fn visit(&self, inputs: &Inputs<'_>, state: &mut [u32], visit: &mut dyn Visit) {
        let mut sink = NoEvents;
        let mut cx = EvalContext::with(self, Phase::Weights, inputs, state, &mut sink, None, 0.0);
        cx.visit = Some(visit);
        cx.eval_weights(self.output, 1.0);
    }

    /// Node `node`'s timing (Timing phase). Never allocates.
    pub fn timing(&self, inputs: &Inputs<'_>, state: &mut [u32], node: u32) -> Timing {
        let mut sink = NoEvents;
        let mut cx = EvalContext::with(self, Phase::Timing, inputs, state, &mut sink, None, 0.0);
        cx.eval_timing(node)
    }
}

/// The random generator's state in a fresh blob (the host reseeds it from the World's seeded
/// generator with the `graph` family's `SET_SEED`).
pub const DEFAULT_SEED: u32 = 0x9E37_79B9;

/// Every node after its children (iterative depth-first search; the format guarantees a DAG).
fn topological_order(children: &[Vec<(u32, EdgeRef)>]) -> Vec<u32> {
    let n = children.len();
    let mut state = vec![0u8; n]; // 0 new, 1 on the stack, 2 done
    let mut order = Vec::with_capacity(n);
    let mut stack: Vec<(u32, usize)> = Vec::new();
    for start in 0..n as u32 {
        if state[start as usize] != 0 {
            continue;
        }
        stack.push((start, 0));
        state[start as usize] = 1;
        while let Some(&mut (node, ref mut next)) = stack.last_mut() {
            let list = &children[node as usize];
            if *next < list.len() {
                let child = list[*next].0;
                *next += 1;
                if state[child as usize] == 0 {
                    state[child as usize] = 1;
                    stack.push((child, 0));
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

/// `acc ← lerp(acc, b, t)` in place, per transform (nlerp, as `anim_pose::blend::lerp`).
pub fn lerp_into(acc: &mut [SoaTransform], b: &[SoaTransform], t: f32) {
    let tl = F32x4::splat(t);
    for (a, b) in acc.iter_mut().zip(b) {
        *a = anim_pose::blend::lerp_transform(*a, *b, tl);
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

/// The program window a context runs (the top-level graph or a linked graph).
#[derive(Clone, Copy)]
pub struct ProgramWindow<'a> {
    program: &'a Program,
    bindings: &'a [u32],
    base: usize,
}

/// The state a node evaluates against: its instance's blob, the skeleton, the inputs, the pose
/// stack and the phase's results. Borrowed for one evaluation; never allocates.
pub struct EvalContext<'a> {
    phase: Phase,
    program: &'a Program,
    /// The current program's first word in `state` (0 at top level; a linked graph's region).
    base: usize,
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
    timing: Timing,
    layout: (u32, u32),
    weight: f32,
    tracks: Option<&'a mut dyn TrackOutput>,
    visit: Option<&'a mut dyn Visit>,
    collected: [(u32, f32); MAX_COLLECTED],
    collected_len: usize,
    /// Inside a linked graph: the outer window and the linked node's inertialization target.
    outer: Option<(ProgramWindow<'a>, u32)>,
    /// T82r: the clip players' frame caches (`anim_sample::FrameCache`): a header per slot and
    /// `player_frames` transforms per slot (empty: none).
    player_headers: &'a mut [u32],
    player_frames: &'a mut [SoaTransform],
    player_header_len: usize,
    player_frame_len: usize,
    /// The first transform of slot 0 in the pose stack (0 at top level; inside a skeleton scope,
    /// where the scope's region starts: T41).
    slot_base: usize,
    /// T70: while a context initialises for a `jump` with an offset, the offset (normalised
    /// cycles, seconds) clip players start at (`init_context_at`); (0, 0) otherwise.
    init_at: (f32, f32),
}

const EMPTY_SKELETON: SkeletonPose<'static> = SkeletonPose {
    parents: &[],
    rest: &[],
    rest_soa: &[],
    identity: &[],
    bind_soa: &[],
};

impl<'a> EvalContext<'a> {
    /// A context with no instance (the Layout phase).
    fn bare(program: &'a Program, phase: Phase, events: &'a mut dyn Events) -> Self {
        EvalContext {
            phase,
            program,
            base: 0,
            inputs: Inputs {
                assets: &NO_ASSETS,
                skeleton: EMPTY_SKELETON,
                bindings: &[],
                layer_weights: &[],
                history: None,
                bake_root: false,
                rig: crate::rig::RigInputs::NONE,
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
            timing: Timing::default(),
            layout: (0, 0),
            weight: 0.0,
            tracks: None,
            visit: None,
            collected: [(0, 0.0); MAX_COLLECTED],
            collected_len: 0,
            outer: None,
            slot_base: 0,
            init_at: (0.0, 0.0),
            player_headers: &mut [],
            player_frames: &mut [],
            player_header_len: 0,
            player_frame_len: 0,
        }
    }

    pub(crate) fn with(
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
        if self.phase == Phase::Weights {
            let w = self.weight;
            if let Some(v) = self.visit.as_deref_mut() {
                v.node(i, w);
            }
        }
        let data = NodeData {
            index: i,
            inputs: &program.inputs[n.inputs.0 as usize..(n.inputs.0 + n.inputs.1) as usize],
            params: &program.params[n.params.0 as usize..(n.params.0 + n.params.1) as usize],
            aux: &program.aux[n.aux.0 as usize..(n.aux.0 + n.aux.1) as usize],
            input_first: n.inputs.0,
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
                (Phase::Timing, Some(input)) => {
                    let t = self.eval_timing(input);
                    self.timing = t;
                }
                (Phase::Tracks | Phase::Weights, _) => {
                    let w = self.weight;
                    for &input in data.inputs {
                        self.eval_tracks(input, w);
                    }
                }
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

    /// The program being run (the linked graph's inside a linked-graph node).
    pub fn program(&self) -> &'a Program {
        self.program
    }

    /// The current node's index.
    pub fn node(&self) -> u32 {
        self.node
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

    /// The rig stack's inputs and outputs (T40).
    pub fn rig(&self) -> crate::rig::RigInputs<'a> {
        self.inputs.rig
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
        let node = self.node;
        self.node_state(node)
    }

    /// Node `node`'s state words (of the current program).
    pub fn node_state(&mut self, node: u32) -> &mut [u32] {
        let (at, len) = self.program.node_range(self.groups, node);
        let at = self.base + at;
        &mut self.state[at..at + len]
    }

    /// The current program's whole state window (a linked graph's region inside the blob).
    pub fn window_state(&mut self, words: usize) -> Option<&mut [u32]> {
        self.state.get_mut(self.base..self.base + words)
    }

    /// The whole blob.
    pub(crate) fn blob(&mut self) -> &mut [u32] {
        self.state
    }

    /// Writes `words` at word `at` of the whole blob (a linked graph's parameters).
    pub fn write_words(&mut self, at: usize, words: &[u32]) {
        if let Some(d) = self.state.get_mut(at..at + words.len()) {
            d.copy_from_slice(words);
        }
    }

    /// Graph parameter `index`'s four words (zeros when out of range).
    pub fn param_words(&self, index: u32) -> [u32; 4] {
        let at = self.base + 4 * index as usize;
        if (index as usize) < self.program.param_count() {
            if let Some(w) = self.state.get(at..at + 4) {
                return [w[0], w[1], w[2], w[3]];
            }
        }
        [0; 4]
    }

    /// Graph parameter `index` as a float (0 when out of range). Ints and bools read as their
    /// value.
    pub fn param_f32(&self, index: u32) -> f32 {
        let w = self.param_words(index)[0];
        match self.program.param_type(index as usize) {
            Some(ParamType::Int) => w as i32 as f32,
            Some(ParamType::Bool) => (w != 0) as u32 as f32,
            Some(_) => {
                let v = f32::from_bits(w);
                if v.is_finite() {
                    v
                } else {
                    0.0
                }
            }
            None => 0.0,
        }
    }

    /// Whether request `name` (a string id) is live.
    pub fn request_live(&mut self, name: u32) -> bool {
        self.request_word(name)
            .is_some_and(|w| f32::from_bits(*w) > 0.0)
    }

    fn request_word(&mut self, name: u32) -> Option<&mut u32> {
        let i = self.program.requests.binary_search(&name).ok()?;
        let at = self.base + self.program.requests_at() + i;
        self.state.get_mut(at)
    }

    /// Consumes request `name` (it is no longer live) and reports it with `transition`.
    pub fn consume_request(&mut self, name: u32, transition: u32) {
        if let Some(w) = self.request_word(name) {
            if f32::from_bits(*w) > 0.0 {
                *w = 0;
                self.emit(StateEvent {
                    kind: StateEventKind::RequestConsumed,
                    layer: name,
                    play_id: transition,
                });
            }
        }
    }

    fn age_requests(&mut self, dt: f32) {
        let program = self.program;
        for (i, &name) in program.requests.iter().enumerate() {
            let at = self.base + program.requests_at() + i;
            let Some(w) = self.state.get_mut(at) else {
                continue;
            };
            let life = f32::from_bits(*w);
            if life > 0.0 {
                let left = life - dt.max(0.0);
                if left > 0.0 {
                    *w = left.to_bits();
                } else {
                    *w = 0;
                    self.emit(StateEvent {
                        kind: StateEventKind::RequestExpired,
                        layer: name,
                        play_id: NONE,
                    });
                }
            }
        }
    }

    /// The next value of the instance's random generator (xorshift32; in the blob, so replays and
    /// restores repeat it).
    pub fn random_u32(&mut self) -> u32 {
        let at = self.base + self.program.rng_at();
        let Some(w) = self.state.get_mut(at) else {
            return 0;
        };
        let mut x = if *w == 0 { DEFAULT_SEED } else { *w };
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *w = x;
        x
    }

    /// A random float in `[0, 1)`.
    pub fn random_unit(&mut self) -> f32 {
        (self.random_u32() >> 8) as f32 * (1.0 / (1u32 << 24) as f32)
    }

    /// Emits a state event.
    pub fn emit(&mut self, event: StateEvent) {
        self.events.push(event);
    }

    /// Asks the current node's nearest ancestor inertialization node for a transition of
    /// `duration` seconds (the longest request of the frame wins). Update phase.
    pub fn request_inertialization(&mut self, duration: f32) {
        if duration.is_nan() || duration <= 0.0 {
            return;
        }
        let target = self.program.inertia_target[self.node as usize];
        if target != NONE {
            let s = self.node_state(target);
            raise_request(s, duration);
        } else if let Some((w, t)) = self.outer {
            if t != NONE {
                let (at, len) = w.program.node_range(self.groups, t);
                let at = w.base + at;
                if let Some(s) = self.state.get_mut(at..at + len) {
                    raise_request(s, duration);
                }
            }
        }
    }

    /// Alpha phase: the current node's alpha.
    pub fn set_alpha(&mut self, alpha: f32) {
        self.alpha = alpha;
    }

    /// Root phase: the current node's delta.
    pub fn set_root(&mut self, delta: RootDelta) {
        self.root = delta;
    }

    /// Timing phase: the current node's timing.
    pub fn set_timing(&mut self, timing: Timing) {
        self.timing = timing;
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

    /// The timing of node `node` (pulled).
    pub fn eval_timing(&mut self, node: u32) -> Timing {
        let phase = core::mem::replace(&mut self.phase, Phase::Timing);
        self.timing = Timing::default();
        self.run(node);
        self.phase = phase;
        self.timing
    }

    /// Tracks or Weights phase: the weight the output gives the current node.
    pub fn weight(&self) -> f32 {
        self.weight
    }

    /// Tracks phase: the host's track output.
    pub fn track_output(&mut self) -> Option<&mut (dyn TrackOutput + 'a)> {
        self.tracks.as_deref_mut()
    }

    /// Runs node `node`'s weighted walk at effective weight `weight`: the current weighted phase
    /// (Tracks or Weights), or Tracks from any other.
    pub fn eval_tracks(&mut self, node: u32, weight: f32) {
        let next = if self.phase == Phase::Weights {
            Phase::Weights
        } else {
            Phase::Tracks
        };
        let phase = core::mem::replace(&mut self.phase, next);
        let saved = core::mem::replace(&mut self.weight, weight);
        self.run(node);
        self.weight = saved;
        self.phase = phase;
    }

    /// Runs node `node`'s Weights walk at `weight`.
    pub fn eval_weights(&mut self, node: u32, weight: f32) {
        let phase = core::mem::replace(&mut self.phase, Phase::Weights);
        let saved = core::mem::replace(&mut self.weight, weight);
        self.run(node);
        self.weight = saved;
        self.phase = phase;
    }

    /// Weights phase: a clip player registers itself at its effective weight.
    pub fn collect_player(&mut self) {
        if self.collected_len < MAX_COLLECTED {
            self.collected[self.collected_len] = (self.node, self.weight);
            self.collected_len += 1;
        }
    }

    /// The clip players under `node` with their effective weights below it (starting at
    /// `weight`), in walk order; at most [`MAX_COLLECTED`]. Never allocates.
    pub fn collect(&mut self, node: u32, weight: f32) -> ([(u32, f32); MAX_COLLECTED], usize) {
        let saved_len = self.collected_len;
        let saved = self.collected;
        self.collected_len = 0;
        let visit = self.visit.take();
        self.eval_weights(node, weight);
        self.visit = visit;
        let out = (self.collected, self.collected_len);
        self.collected = saved;
        self.collected_len = saved_len;
        out
    }

    /// Evaluates node `node`'s pose into slot `slot`.
    pub fn eval_pose(&mut self, node: u32, slot: usize) {
        let phase = core::mem::replace(&mut self.phase, Phase::Pose);
        let out = core::mem::replace(&mut self.out, slot);
        self.run(node);
        self.out = out;
        self.phase = phase;
    }

    /// Runs update context `ctx`'s direct members (evaluation order) by `dt` seconds.
    pub fn update_context(&mut self, ctx: u32, dt: f32) {
        let program = self.program;
        let Some(c) = program.ctxs.get(ctx as usize) else {
            return;
        };
        let phase = core::mem::replace(&mut self.phase, Phase::Update);
        let saved = core::mem::replace(&mut self.dt, dt);
        for k in c.direct.0..c.direct.0 + c.direct.1 {
            self.run(program.ctx_lists[k as usize]);
        }
        self.dt = saved;
        self.phase = phase;
    }

    /// Re-initialises update context `ctx` (every node in it and in the contexts below it).
    pub fn init_context(&mut self, ctx: u32) {
        let program = self.program;
        let Some(c) = program.ctxs.get(ctx as usize) else {
            return;
        };
        let phase = core::mem::replace(&mut self.phase, Phase::Init);
        for k in c.all.0..c.all.0 + c.all.1 {
            self.run(program.ctx_lists[k as usize]);
        }
        self.phase = phase;
    }

    /// [`init_context`](Self::init_context) with clip players starting `norm` cycles plus `secs`
    /// seconds into their clips (a `jump` with an offset, T70; see `sources::clip_player`).
    pub fn init_context_at(&mut self, ctx: u32, norm: f32, secs: f32) {
        let saved = core::mem::replace(&mut self.init_at, (norm, secs));
        self.init_context(ctx);
        self.init_at = saved;
    }

    /// The offset a clip player initialising now starts at: (normalised cycles, seconds).
    pub fn init_offset(&self) -> (f32, f32) {
        self.init_at
    }

    /// The update context input `k` of the current node opens (`NONE`: not gated).
    pub fn input_context(&self, node: &NodeData<'_>, k: usize) -> u32 {
        self.program
            .input_ctx
            .get(node.input_first as usize + k)
            .copied()
            .unwrap_or(NONE)
    }

    /// Runs `f` with `graph` as the program, its state window at word `base` of the blob (a
    /// linked graph). Phases, slots and outputs carry through.
    pub fn with_program<R>(
        &mut self,
        graph: GraphRef<'a>,
        base: usize,
        f: impl FnOnce(&mut Self) -> R,
    ) -> R {
        let target = self.program.inertia_target[self.node as usize];
        let outer = ProgramWindow {
            program: self.program,
            bindings: self.inputs.bindings,
            base: self.base,
        };
        let saved_outer = self.outer.replace((outer, target));
        let saved_node = self.node;
        self.program = graph.program;
        self.inputs.bindings = graph.bindings;
        self.base = base;
        let r = f(self);
        self.program = outer.program;
        self.inputs.bindings = outer.bindings;
        self.base = outer.base;
        self.outer = saved_outer;
        self.node = saved_node;
        r
    }

    /// Runs node `i` of the current program in the current phase (a linked graph's output).
    pub fn run_node(&mut self, i: u32) {
        if (i as usize) < self.program.nodes.len() {
            self.run(i);
        }
    }

    /// Init phase over every node of the current program (a linked graph on link).
    pub fn init_all(&mut self) {
        let program = self.program;
        if let Some(s) = self.window_state(program.state_words(self.groups)) {
            s.fill(0);
            program.init_globals(s);
        }
        let phase = core::mem::replace(&mut self.phase, Phase::Init);
        for &i in &program.order {
            self.run(i);
        }
        self.phase = phase;
    }

    /// Pose phase: the slot the current node writes.
    pub fn out(&self) -> usize {
        self.out
    }

    /// Pose phase: makes `slot` the slot the current node writes; returns the previous one.
    pub fn set_out(&mut self, slot: usize) -> usize {
        core::mem::replace(&mut self.out, slot)
    }

    /// The current node's first state word's index in the whole blob.
    pub fn state_offset(&self) -> usize {
        self.base + self.program.node_range(self.groups, self.node).0
    }

    /// Runs `f` as if node `node` (of the current program) were the current node.
    pub fn as_node<R>(&mut self, node: u32, f: impl FnOnce(&mut Self) -> R) -> R {
        let saved = core::mem::replace(&mut self.node, node);
        let r = f(self);
        self.node = saved;
        r
    }

    /// Reserves a pose slot; `None` when the stack is exhausted (a node then writes the rest pose).
    pub fn push_slot(&mut self) -> Option<usize> {
        let groups = self.groups.max(1);
        let base = self.slot_base;
        let len = self
            .scratch
            .as_ref()
            .map_or(0, |s| s.poses.len().saturating_sub(base) / groups);
        if self.next_slot < len {
            self.next_slot += 1;
            Some(self.next_slot - 1)
        } else {
            None
        }
    }

    /// The first transform of slot 0 ([`EvalContext::with_skeleton`] moves it), within the stack.
    fn stack_base(&self) -> usize {
        let len = self.scratch.as_ref().map_or(0, |s| s.poses.len());
        self.slot_base.min(len)
    }

    /// Gives back the last reserved slot.
    pub fn pop_slot(&mut self) {
        self.next_slot = self.next_slot.saturating_sub(1);
    }

    fn slot_range(&self, slot: usize) -> core::ops::Range<usize> {
        self.slot_base + slot * self.groups..self.slot_base + (slot + 1) * self.groups
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
        let sb = self.stack_base();
        let s = self.scratch.as_mut()?;
        let [pa, pb, po] = split_slots(&mut s.poses[sb..], g, [a, b, out])?;
        Some((pa, pb, po))
    }

    /// An input slot and an output slot (different); `None` without scratch or for equal slots.
    pub fn poses2(
        &mut self,
        a: usize,
        out: usize,
    ) -> Option<(&[SoaTransform], &mut [SoaTransform])> {
        let g = self.groups;
        let sb = self.stack_base();
        let s = self.scratch.as_mut()?;
        let [pa, po] = split_slots(&mut s.poses[sb..], g, [a, out])?;
        Some((pa, po))
    }

    /// `out ← lerp(out, from, t)` for two distinct slots (an accumulating blend).
    pub fn lerp_slot_into(&mut self, out: usize, from: usize, t: f32) {
        let g = self.groups;
        let sb = self.stack_base();
        if let Some(s) = self.scratch.as_mut() {
            if let Some([po, pf]) = split_slots(&mut s.poses[sb..], g, [out, from]) {
                lerp_into(po, pf, t);
            }
        }
    }

    /// Copies slot `from` into slot `to`.
    pub fn copy_slot(&mut self, from: usize, to: usize) {
        if from == to {
            return;
        }
        let g = self.groups;
        let sb = self.stack_base();
        if let Some(s) = &mut self.scratch {
            s.poses
                .copy_within(sb + from * g..sb + from * g + g, sb + to * g);
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

    /// [`pose_and_sample_scratch`](Self::pose_and_sample_scratch) plus the current node's frame
    /// cache slot for its player `sub` (T82r; `None` without one) and the cache tag
    /// ([`Assets::cache_epoch`]).
    #[allow(clippy::type_complexity)]
    pub fn pose_sample_and_cache(
        &mut self,
        slot: usize,
        sub: usize,
    ) -> (
        &mut [SoaTransform],
        &mut [AosTransform],
        Option<(&mut [u32], &mut [SoaTransform])>,
        u32,
    ) {
        let tag = self.inputs.assets.cache_epoch();
        let r = self.slot_range(slot);
        let hw = self.player_header_len;
        let fw = self.player_frame_len;
        let count = if fw == 0 || hw == 0 {
            0
        } else {
            (self.player_headers.len() / hw).min(self.player_frames.len() / fw)
        };
        let cache = if count == 0 {
            None
        } else {
            // The player's ordinal in its program: distinct slots for a program's players; a
            // linked graph's (at its own state base) shift theirs, and may share a slot.
            let ordinal = self.program.player_ordinal.get(self.node as usize).copied();
            match ordinal {
                Some(o) if o != NONE => {
                    let k = (o as usize + sub + self.base) % count;
                    Some((
                        &mut self.player_headers[k * hw..(k + 1) * hw],
                        &mut self.player_frames[k * fw..(k + 1) * fw],
                    ))
                }
                _ => None,
            }
        };
        match &mut self.scratch {
            Some(s) => (&mut s.poses[r], &mut *s.sample, cache, tag),
            None => (&mut [], &mut [], cache, tag),
        }
    }

    /// Slot `slot` and the sampling scratch, for sampling a clip into the slot.
    pub fn pose_and_sample_scratch(
        &mut self,
        slot: usize,
    ) -> (&mut [SoaTransform], &mut [AosTransform]) {
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
        let sb = self.stack_base();
        let (at, len) = self.program.node_range(g, self.node);
        let at = self.base + at;
        let s = self.scratch.as_mut()?;
        let poses = split_slots(&mut s.poses[sb..], g, slots)?;
        Some((&mut self.state[at..at + len], poses))
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
        let sb = self.stack_base();
        let s = self.scratch.as_mut()?;
        let [pa, pb, pc, po] = split_slots(&mut s.poses[sb..], g, [a, b, c, out])?;
        Some((&mut *s.inertializer, [pa, pb, pc], po))
    }

    // ---------------------------------------------------------------------------------------------
    // Skeleton scopes (T41: the retarget node's source graph) and the physics family's accessor
    // (T44r). Additions only; nothing above depends on them except `slot_base` in the slot helpers.
    // ---------------------------------------------------------------------------------------------

    /// Runs `f` with `graph` as the program, its state window at word `base` of the blob, on
    /// another skeleton (the retarget node's source graph, T41). Inside, the skeleton, bone groups
    /// and bindings are the scope's; there is no output history and no layer weights (layers use
    /// their defaults); slots are a fresh stack of the scope's group size starting right after the
    /// slots reserved so far ([`EvalContext::scope_region_and_slot`] reads the scope's slot 0
    /// afterwards); inertialization requests stay inside (an ancestor on the outer skeleton can't
    /// take them). Phases and outputs carry through, as in [`EvalContext::with_program`].
    pub fn with_skeleton<R>(
        &mut self,
        graph: GraphRef<'a>,
        base: usize,
        skeleton: SkeletonPose<'a>,
        f: impl FnOnce(&mut Self) -> R,
    ) -> R {
        let saved = (
            self.program,
            self.inputs,
            self.base,
            self.outer.take(),
            self.node,
            self.groups,
            self.slot_base,
            self.next_slot,
            self.out,
        );
        self.slot_base += self.next_slot * self.groups;
        self.next_slot = 0;
        self.program = graph.program;
        self.inputs.bindings = graph.bindings;
        self.inputs.skeleton = skeleton;
        self.inputs.history = None;
        self.inputs.layer_weights = &[];
        self.base = base;
        self.groups = skeleton.groups();
        let r = f(self);
        (
            self.program,
            self.inputs,
            self.base,
            self.outer,
            self.node,
            self.groups,
            self.slot_base,
            self.next_slot,
            self.out,
        ) = saved;
        r
    }

    /// After a [`EvalContext::with_skeleton`] scope: its slot 0's first `len` transforms (the
    /// scope's region starts right after the slots reserved now) and the reserved slot `out`,
    /// writable, at once. `None` without scratch, when `out` isn't reserved, or past the stack.
    pub fn scope_region_and_slot(
        &mut self,
        len: usize,
        out: usize,
    ) -> Option<(&[SoaTransform], &mut [SoaTransform])> {
        if out >= self.next_slot {
            return None;
        }
        let g = self.groups;
        let start = self.slot_base + self.next_slot * g;
        let o = self.slot_base + out * g;
        let s = self.scratch.as_mut()?;
        if s.poses.len() < start + len {
            return None;
        }
        let (head, tail) = s.poses.split_at_mut(start);
        Some((&tail[..len], &mut head[o..o + g]))
    }

    /// The current node's state words, slot `slot` and the sampling scratch (at least two
    /// transforms per bone), all writable at once (the physical-pose node, T44r).
    #[allow(clippy::type_complexity)]
    pub fn state_slot_sample(
        &mut self,
        slot: usize,
    ) -> Option<(&mut [u32], &mut [SoaTransform], &mut [AosTransform])> {
        let g = self.groups;
        let (at, len) = self.program.node_range(g, self.node);
        let at = self.base + at;
        let r = self.slot_range(slot);
        let s = self.scratch.as_mut()?;
        let pose = s.poses.get_mut(r)?;
        Some((&mut self.state[at..at + len], pose, &mut *s.sample))
    }
}

fn raise_request(s: &mut [u32], duration: f32) {
    if let Some(w) = s.get_mut(crate::mixing::inertia::REQUEST) {
        if duration > f32::from_bits(*w) {
            *w = duration.to_bits();
        }
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
    for (t, w) in pose.iter().zip(words.as_chunks_mut::<SOA_WORDS>().0) {
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
        for (c, o) in comps.iter().zip(w.as_chunks_mut::<4>().0) {
            o.copy_from_slice(&c.to_bits_array());
        }
    }
}

/// Reads `pose` back from `words` (the inverse of [`pose_to_words`], bit for bit).
pub fn pose_from_words(words: &[u32], pose: &mut [SoaTransform]) {
    for (t, w) in pose.iter_mut().zip(words.as_chunks::<SOA_WORDS>().0) {
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
    /// What its family computed from them at load (a blend space's triangulation).
    pub aux: &'a [u32],
    /// Its first input's index in the program's input list (for the edges' update contexts).
    pub input_first: u32,
}

impl NodeData<'_> {
    /// Parameter word `i` (0 when absent: a shorter block from an older compiler reads defaults).
    pub fn word(&self, i: usize) -> u32 {
        self.params.get(i).copied().unwrap_or(0)
    }
    /// Parameter word `i`, or `NONE` when absent.
    pub fn word_or_none(&self, i: usize) -> u32 {
        self.params.get(i).copied().unwrap_or(NONE)
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

/// The interrupt list of a transition (`Never`: empty, `Any`: `None`).
pub(crate) fn interrupt_allows(program: &Program, active: u32, candidate: u32) -> bool {
    match program
        .transitions
        .get(active as usize)
        .map(|t| t.interrupt)
    {
        Some(Interrupt::Any) => true,
        Some(Interrupt::List { first, count }) => program
            .interrupts
            .get(first as usize..(first + count) as usize)
            .is_some_and(|l| l.contains(&candidate)),
        _ => false,
    }
}
