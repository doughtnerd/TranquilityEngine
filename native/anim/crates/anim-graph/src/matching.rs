//! Node family `matching`: the motion-matching database node, calling `anim-match` (`match` is a
//! Rust keyword). Filled by T42 (node half). Declare the family's kinds in [`kind`] (append-only
//! `u16`s, stored in `myco.animgraph@1`) and match on them in [`evaluate`].
//!
//! # `POSE_DATABASE` (kind 0)
//!
//! Plays whatever the database search picks (ADR 0372's motion matching). Inputs: none, or one: a
//! `logic` `CHOOSER` whose rows pick [`kind::MATCH_TAGS`] nodes (a chooser table gating the search
//! by tags; any other input is ignored). To pick a *database* with a chooser, put
//! `POSE_DATABASE` nodes in its rows instead.
//!
//! Parameter words ([`word`] has the indices; absent words read their default):
//!
//! | word | type | meaning |
//! |---|---|---|
//! | 0 | u32 | the database: a string id of the graph bound to a `myco.posedb@1` asset (`graph_bind`) |
//! | 1 | u32 | flags: [`FLAG_BRUTE_FORCE`] searches every row instead of the KD-tree (same result) |
//! | 2 | u32 | search every this many updates (0 or absent: 6, D60) |
//! | 3 | f32 | the trajectory cost that forces a search at once (2) |
//! | 4 | f32 | continuation bias: how much cheaper the best frame must be to switch (0.1) |
//! | 5 | f32 | seconds between switches (0.2) |
//! | 6 | u32 | frames either side of the playing frame a search skips (6) |
//! | 7, 8 | f32 | the trajectory springs' velocity and facing half-lives (0.3, 0.2) |
//! | 9 | f32 | the inertialization requested on a switch, seconds (0.2) |
//! | 10 | u32 | graph parameter: the character's world position (vec2 `x z`, or vec3 `x y z`), or `NONE` |
//! | 11 | u32 | graph parameter: its world yaw (float, radians about +Y, 0 faces +Z), or `NONE` |
//! | 12 | u32 | graph parameter: its controller's world ground velocity (vec2/vec3), or `NONE` |
//! | 13 | u32 | graph parameter: the desired world ground velocity (vec2/vec3), or `NONE` (= velocity) |
//! | 14 | u32 | graph parameter: the desired yaw (float), or `NONE` (= yaw) |
//! | 15 | u32 | graph parameter: the LOD multiplier (int or float ≥ 1; the search runs every word-2 × it updates, ADR 0370's "search drops to every N frames"), or `NONE` (1) |
//! | 16–27 | u32 | tag masks: `required`, `excluded`, `any` (four words each: tag `t` is bit `t % 32` of word `t / 32`) |
//! | 28–39 | u32 | graph parameters (int) whose value ORs into the mask word at the same position (12 of them, `NONE` for none) |
//!
//! **Inputs come from graph parameters** (decision for T42): the character controller's state and
//! what the player wants are per-frame values the host already writes through the blackboard
//! (`graph` family), they are part of the instance blob (so a restored snapshot predicts exactly as
//! before), and no new per-instance view is needed. The tag filter is the OR of the static masks,
//! the parameter words and the chooser's picked `MATCH_TAGS` row.
//!
//! Per update, in this order (anim-match's crate docs): the trajectory predictor advances to the
//! inputs and predicts at the database's offsets; the query is built from the instance's last two
//! output poses (the pose history; the rest pose before there are two) in character space (each
//! pose's own root-bone frame, so baked and unbaked poses both work), with the character's world
//! movement between those two poses (recorded by this node's Pose phase) as the root delta; the
//! controller decides. The controller's playhead is the time of the pose the query was built from
//! (the one shown last), so its continuation is compared with that pose, and the clip player runs
//! one step ahead of it (the pose shown next); without that offset the continuation always looks a
//! frame off and the search keeps jumping to the same phase a cycle away. A **switch** starts the
//! embedded clip player at the picked clip (the database's clip list, bound with `posedb_bind`) and
//! time plus the step, and asks the nearest ancestor
//! `INERTIALIZE` node for a transition (the graph's routing); a switch to within one database frame
//! of what already plays keeps playing. Root motion is the matched clip's root curve; on a switch
//! update it is the old clip's last step. Notifies and timing are the player's.
//!
//! **Mirrored copies** (T70): a database clip entry flagged `CLIP_MIRRORED` names the same clip as
//! its original; while one plays, the pose is mirrored through the database's mirror table (the
//! `MIRROR` node's per-bone operations, through one scratch slot) and the root motion across its
//! axis, so the character shows what the bake measured.
//!
//! State ([`state`]): the clip player ([`crate::sources::player`] layout), the database handle,
//! the update counter and the last search's update, the last update's flags
//! ([`MATCH_SWITCHED`], [`MATCH_SEARCHED`]), frame and cost, the inputs' world position and yaw,
//! the world position and yaw at the last two poses, a switch-update root delta, then the
//! controller and the trajectory predictor as words. Fixed size; snapshot and restore are a copy.
//!
//! # `MATCH_TAGS` (kind 1)
//!
//! A tag filter for a chooser row: words 0–11 are `required`, `excluded`, `any` masks as
//! `POSE_DATABASE`'s 16–27. No inputs, no state, no pose (alpha 0).

use anim_format::NONE;
use anim_match::{
    build_query_from, BoneSource, CharacterFrame, ControllerSettings, MatchController, MatchDb,
    SearchMode, TagFilter, TagMask, Trajectory, TrajectoryInput, TrajectoryPredictor,
    TrajectorySettings, TAG_WORDS,
};
use anim_math::trig::sin_cos;
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_pose::root::RootDelta;
use anim_pose::Axis;

use crate::dispatch::{Family, NodeStatus};
use crate::eval::{EvalContext, NodeData, Phase, Program};
use crate::sources::{self, player};

/// The family's node kinds.
pub mod kind {
    /// The motion-matching database node (module docs).
    pub const POSE_DATABASE: u16 = 0;
    /// A tag filter a chooser row picks.
    pub const MATCH_TAGS: u16 = 1;
}

/// A loaded pose database as the node sees it.
#[derive(Clone, Copy)]
pub struct MatchRef<'a> {
    pub db: &'a MatchDb,
    /// A clip asset handle per database clip index (0: unbound; a switch to it shows nothing).
    pub clips: &'a [u32],
}

/// The most `F32x4` lanes a query may have (256 feature dims); `posedb_load` refuses larger.
pub const MAX_QUERY_LANES: usize = 64;
/// The deepest bone chain the query's model-space walk follows.
const MAX_CHAIN: usize = 256;

/// `POSE_DATABASE` flag: brute-force search.
pub const FLAG_BRUTE_FORCE: u32 = 1;
/// Last-update flag: a switch happened.
pub const MATCH_SWITCHED: u32 = 1;
/// Last-update flag: a search ran.
pub const MATCH_SEARCHED: u32 = 2;

/// `POSE_DATABASE` parameter word indices (module docs).
pub mod word {
    pub const DATABASE: usize = 0;
    pub const FLAGS: usize = 1;
    pub const INTERVAL: usize = 2;
    pub const FORCE: usize = 3;
    pub const BIAS: usize = 4;
    pub const MIN_SWITCH: usize = 5;
    pub const NEIGHBOURS: usize = 6;
    pub const VELOCITY_HALF_LIFE: usize = 7;
    pub const FACING_HALF_LIFE: usize = 8;
    pub const BLEND: usize = 9;
    pub const POSITION: usize = 10;
    pub const YAW: usize = 11;
    pub const VELOCITY: usize = 12;
    pub const DESIRED_VELOCITY: usize = 13;
    pub const DESIRED_YAW: usize = 14;
    pub const LOD: usize = 15;
    /// Three masks of four words: required, excluded, any.
    pub const TAGS: usize = 16;
    /// Twelve int parameters, one per mask word.
    pub const TAG_PARAMS: usize = 28;
    /// Words of a complete block.
    pub const WORDS: usize = 40;
}

/// `POSE_DATABASE` state word offsets.
pub mod state {
    use super::player;
    /// The clip player.
    pub const PLAYER: usize = 0;
    /// The database's asset handle.
    pub const DB: usize = player::WORDS as usize;
    /// Updates run (wrapping).
    pub const UPDATES: usize = DB + 1;
    /// The update count at the last search (`NONE`: never).
    pub const LAST_SEARCH: usize = DB + 2;
    /// The last update's `MATCH_*` flags.
    pub const FLAGS: usize = DB + 3;
    /// The database frame playing (`NONE`: none).
    pub const FRAME: usize = DB + 4;
    /// Its cost against the query (f32 bits).
    pub const COST: usize = DB + 5;
    /// The inputs' world position `x z` and yaw this update.
    pub const WORLD: usize = DB + 6;
    /// The world position and yaw at the last pose, then at the one before, then how many are
    /// recorded (0–2).
    pub const POSE_LAST: usize = DB + 9;
    pub const POSE_PREV: usize = DB + 12;
    pub const POSE_COUNT: usize = DB + 15;
    /// A switch update's root delta (translation 3, rotation 4) and its flag.
    pub const SWITCH_ROOT: usize = DB + 16;
    pub const SWITCH_FLAG: usize = DB + 23;
    /// The controller's words.
    pub const CONTROLLER: usize = DB + 24;
    /// The predictor's words.
    pub const PREDICTOR: usize = CONTROLLER + super::MatchController::WORDS;
    /// T70: 1 while the playing clip entry is a mirrored copy (played through the database's
    /// mirror table).
    pub const MIRRORED: usize = PREDICTOR + super::TrajectoryPredictor::WORDS;
    /// Words of state.
    pub const WORDS: usize = MIRRORED + 1;
}

/// What a `POSE_DATABASE` node's state shows (the live debugger's `match` family records).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MatchView {
    /// The database's asset handle.
    pub database: u32,
    /// The playing clip's asset handle (0: none) and its playhead.
    pub clip: u32,
    pub time: f32,
    /// The database frame playing (`NONE`: none) and its last cost.
    pub frame: u32,
    pub cost: f32,
    /// Updates run, and the update count at the last search (`NONE`: never).
    pub updates: u32,
    pub last_search: u32,
    /// The last update's `MATCH_*` flags.
    pub flags: u32,
    /// T70: a mirrored copy plays.
    pub mirrored: bool,
}

/// The view of a `POSE_DATABASE` node's state words (`None` for a block too short).
pub fn view(s: &[u32]) -> Option<MatchView> {
    if s.len() < state::WORDS {
        return None;
    }
    Some(MatchView {
        database: s[state::DB],
        clip: sources::clip_of(s),
        time: sources::time_of(s),
        frame: s[state::FRAME],
        cost: f32::from_bits(s[state::COST]),
        updates: s[state::UPDATES],
        last_search: s[state::LAST_SEARCH],
        flags: s[state::FLAGS],
        mirrored: s[state::MIRRORED] != 0,
    })
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::POSE_DATABASE => database(cx, &node),
        kind::MATCH_TAGS => {
            if cx.phase() != Phase::Layout {
                crate::mixing::empty(cx);
            }
        }
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

fn controller_settings(cx: &EvalContext<'_>, node: &NodeData<'_>) -> ControllerSettings {
    let d = ControllerSettings::default();
    let interval = match node.word(word::INTERVAL) {
        0 => d.search_interval,
        n => n,
    };
    let lod = match node.word_or_none(word::LOD) {
        NONE => 1,
        p => {
            let v = cx.param_f32(p);
            if v >= 1.0 {
                (v as u32).max(1)
            } else {
                1
            }
        }
    };
    ControllerSettings {
        search_interval: interval.saturating_mul(lod),
        force_threshold: node.f32_or(word::FORCE, d.force_threshold),
        continuation_bias: node.f32_or(word::BIAS, d.continuation_bias),
        min_switch_interval: node.f32_or(word::MIN_SWITCH, d.min_switch_interval),
        ignore_neighbours: node
            .params
            .get(word::NEIGHBOURS)
            .copied()
            .unwrap_or(d.ignore_neighbours),
        mode: if node.word(word::FLAGS) & FLAG_BRUTE_FORCE != 0 {
            SearchMode::BruteForce
        } else {
            SearchMode::KdTree
        },
    }
}

fn database(cx: &mut EvalContext<'_>, node: &NodeData<'_>) {
    match cx.phase() {
        Phase::Layout => cx.set_state_words(state::WORDS as u32, 0),
        Phase::Init => {
            let db = cx.binding(node.word_or_none(word::DATABASE));
            let settings = controller_settings(cx, node);
            let s = cx.state();
            s.fill(0);
            s[state::DB] = db;
            s[state::LAST_SEARCH] = NONE;
            s[state::FRAME] = NONE;
            s[state::COST] = f32::INFINITY.to_bits();
            MatchController::new(settings).write_words(&mut s[state::CONTROLLER..]);
            TrajectoryPredictor::new().write_words(&mut s[state::PREDICTOR..]);
        }
        Phase::Update => update(cx, node),
        Phase::Pose => {
            sources::player_pose_at(cx, state::PLAYER, 0, 0);
            if cx.state()[state::MIRRORED] != 0 {
                mirror_out(cx);
            }
            // The world position this pose was taken at (the query's root delta, next update).
            let s = cx.state();
            s.copy_within(state::POSE_LAST..state::POSE_LAST + 3, state::POSE_PREV);
            s.copy_within(state::WORLD..state::WORLD + 3, state::POSE_LAST);
            s[state::POSE_COUNT] = (s[state::POSE_COUNT] + 1).min(2);
        }
        Phase::Root => {
            let s = cx.state();
            if s[state::SWITCH_FLAG] != 0 {
                let w = |i: usize| f32::from_bits(s[state::SWITCH_ROOT + i]);
                let delta = RootDelta {
                    translation: AosVec3::new(w(0), w(1), w(2)),
                    rotation: AosQuat::new(w(3), w(4), w(5), w(6)),
                };
                cx.set_root(delta);
            } else if s[state::MIRRORED] != 0 {
                let r = sources::player_root_at(cx, state::PLAYER);
                let axis = node_db(cx).map_or(Axis::X, mirror_axis);
                cx.set_root(mirror_root(r, axis));
            } else {
                sources::player_phase(cx, state::PLAYER, 1.0);
            }
        }
        Phase::Weights => cx.collect_player(),
        _ => sources::player_phase(cx, state::PLAYER, 1.0),
    }
}

/// The node's database (its state's handle), if bound and loaded.
fn node_db<'d>(cx: &mut EvalContext<'d>) -> Option<&'d MatchDb> {
    let h = cx.state()[state::DB];
    if h == 0 {
        return None;
    }
    cx.assets().match_db(h).map(|m| m.db)
}

/// The axis of a database's mirror table (X without one).
fn mirror_axis(db: &MatchDb) -> Axis {
    match db.mirror_table().first() {
        Some(1) => Axis::Y,
        Some(2) => Axis::Z,
        _ => Axis::X,
    }
}

/// A root delta mirrored across the plane with normal `axis` (as the `MIRROR` node mirrors it).
fn mirror_root(r: RootDelta, axis: Axis) -> RootDelta {
    let m = anim_pose::mirror::mirror_transform(
        AosTransform::new(r.translation, r.rotation, AosVec3::splat(1.0)),
        axis,
    );
    RootDelta {
        translation: m.translation,
        rotation: m.rotation,
    }
}

/// T70: mirrors the current out slot through the database's mirror table (a mirrored copy
/// playing), through a scratch slot; without a slot or a table the pose stays as it is.
fn mirror_out(cx: &mut EvalContext<'_>) {
    let Some(db) = node_db(cx) else {
        return;
    };
    let table = db.mirror_table();
    if table.is_empty() {
        return;
    }
    let axis = mirror_axis(db);
    let out = cx.out();
    let Some(tmp) = cx.push_slot() else {
        return;
    };
    cx.copy_slot(out, tmp);
    let parents = cx.skeleton().parents;
    if let Some((src, dst)) = cx.poses2(tmp, out) {
        if src.len() == anim_math::layout::soa_len(parents.len()) && dst.len() == src.len() {
            anim_pose::mirror::mirror_by_words(src, &table[1..], parents, axis, dst);
        }
    }
    cx.pop_slot();
}

/// The ground `x z` of a vec2 (`x y`) or vec3 (`x y z`) parameter, `None` for `NONE`. `words`
/// reads a parameter's four words.
fn ground(program: &Program, words: &dyn Fn(u32) -> [u32; 4], param: u32) -> Option<[f32; 2]> {
    if param == NONE || param as usize >= program.param_count() {
        return None;
    }
    let w = words(param);
    let f = |i: usize| {
        let v = f32::from_bits(w[i]);
        if v.is_finite() {
            v
        } else {
            0.0
        }
    };
    Some(match program.param_type(param as usize) {
        Some(anim_format::graph::ParamType::Vec3) => [f(0), f(2)],
        _ => [f(0), f(1)],
    })
}

/// A float parameter's value from its words (ints and bools as their value; not finite: 0), as
/// `EvalContext::param_f32` reads it.
fn scalar_of(program: &Program, index: u32, w: [u32; 4]) -> f32 {
    if index as usize >= program.param_count() {
        return 0.0;
    }
    match program.param_type(index as usize) {
        Some(anim_format::graph::ParamType::Int) => w[0] as i32 as f32,
        Some(anim_format::graph::ParamType::Bool) => (w[0] != 0) as u32 as f32,
        _ => {
            let v = f32::from_bits(w[0]);
            if v.is_finite() {
                v
            } else {
                0.0
            }
        }
    }
}

/// The trajectory input of a node with parameter words `params`; `words` reads a graph
/// parameter's four words.
fn trajectory_input_from(
    program: &Program,
    params: &[u32],
    words: &dyn Fn(u32) -> [u32; 4],
) -> TrajectoryInput {
    let at = |i: usize| params.get(i).copied().unwrap_or(NONE);
    let scalar = |i: usize| match at(i) {
        NONE => None,
        p => Some(scalar_of(program, p, words(p))),
    };
    let position = ground(program, words, at(word::POSITION)).unwrap_or([0.0; 2]);
    let velocity = ground(program, words, at(word::VELOCITY)).unwrap_or([0.0; 2]);
    let yaw = scalar(word::YAW).unwrap_or(0.0);
    TrajectoryInput {
        position,
        yaw,
        velocity,
        desired_velocity: ground(program, words, at(word::DESIRED_VELOCITY)).unwrap_or(velocity),
        desired_yaw: scalar(word::DESIRED_YAW).unwrap_or(yaw),
    }
}

fn trajectory_input(cx: &EvalContext<'_>, node: &NodeData<'_>) -> TrajectoryInput {
    trajectory_input_from(cx.program(), node.params, &|p| cx.param_words(p))
}

fn trajectory_settings(params: &[u32]) -> TrajectorySettings {
    let f = |i: usize, d: f32| match params.get(i) {
        Some(w) if f32::from_bits(*w).is_finite() => f32::from_bits(*w),
        _ => d,
    };
    TrajectorySettings {
        velocity_half_life: f(word::VELOCITY_HALF_LIFE, 0.3),
        facing_half_life: f(word::FACING_HALF_LIFE, 0.2),
    }
}

/// T70, the live debugger: the trajectory top-level `POSE_DATABASE` node `node` of an instance
/// predicted at its last update, at `db`'s offsets, in the character's frame (`state` the
/// instance's blob, `groups` its bone groups). The prediction is a pure function of the node's
/// predictor words and the parameters that update read, both still in the blob until the next
/// `write_inputs`. `false` when the node isn't a pose-database node. Never allocates.
pub fn predicted_trajectory(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    node: u32,
    db: &MatchDb,
    out: &mut Trajectory,
) -> bool {
    if program.node_kind(node) != Some((Family::Matching, kind::POSE_DATABASE)) {
        return false;
    }
    let params = program.node_params(node).unwrap_or(&[]);
    let input = {
        let blob: &[u32] = state;
        let words = |p: u32| {
            let at = 4 * p as usize;
            blob.get(at..at + 4)
                .map_or([0; 4], |w| [w[0], w[1], w[2], w[3]])
        };
        trajectory_input_from(program, params, &words)
    };
    let s = program.node_state(state, groups, node);
    if s.len() < state::WORDS {
        return false;
    }
    let predictor = TrajectoryPredictor::read_words(&s[state::PREDICTOR..]);
    predictor.predict(
        &input,
        &trajectory_settings(params),
        db.trajectory_offsets(),
        out,
    );
    true
}

/// ORs three masks of four words (required, excluded, any) from `words` into `f`.
fn or_masks(f: &mut TagFilter, words: &[u32]) {
    for (k, w) in words.iter().take(3 * TAG_WORDS).enumerate() {
        let m = match k / TAG_WORDS {
            0 => &mut f.required,
            1 => &mut f.excluded,
            _ => &mut f.any,
        };
        m.0[k % TAG_WORDS] |= *w;
    }
}

/// The node `pick` of chooser node `chooser` leads to (a row's result, the fallback, or `NONE`).
fn chooser_result(program: &Program, chooser: u32, pick: u32) -> u32 {
    let Some(c) = program.choosers.get(program.side(chooser) as usize) else {
        return NONE;
    };
    if c.node != chooser || pick == NONE {
        NONE
    } else if pick < c.rows.1 {
        program
            .rows
            .get((c.rows.0 + pick) as usize)
            .map_or(NONE, |r| r.node)
    } else {
        c.fallback
    }
}

fn tag_filter(cx: &mut EvalContext<'_>, node: &NodeData<'_>) -> TagFilter {
    let mut f = TagFilter {
        required: TagMask::EMPTY,
        excluded: TagMask::EMPTY,
        any: TagMask::EMPTY,
    };
    let stat = node
        .params
        .get(word::TAGS..word::TAGS + 3 * TAG_WORDS)
        .unwrap_or(&[]);
    or_masks(&mut f, stat);
    let mut from_params = [0u32; 3 * TAG_WORDS];
    for (k, w) in from_params.iter_mut().enumerate() {
        let p = node.word_or_none(word::TAG_PARAMS + k);
        if p != NONE {
            *w = cx.param_words(p)[0];
        }
    }
    or_masks(&mut f, &from_params);
    let program = cx.program();
    if let Some(&chooser) = node.inputs.first() {
        if program.node_kind(chooser) == Some((Family::Logic, crate::logic::kind::CHOOSER)) {
            let pick = crate::logic::chooser_pick(cx.node_state(chooser));
            let result = chooser_result(program, chooser, pick);
            if program.node_kind(result) == Some((Family::Matching, kind::MATCH_TAGS)) {
                if let Some(words) = program.node_params(result) {
                    or_masks(&mut f, words);
                }
            }
        }
    }
    f
}

/// Bone `b`'s model-space transform in `pose` (local SoA): the chain composed from its root, the
/// same operations as `anim_math::layout::local_to_model`.
fn model(parents: &[u16], pose: &[SoaTransform], b: usize) -> AosTransform {
    let local = |i: usize| pose[i / 4].lane(i % 4);
    let mut chain = [0u16; MAX_CHAIN];
    let mut n = 0;
    let mut i = b;
    loop {
        if n == MAX_CHAIN {
            break;
        }
        chain[n] = i as u16;
        n += 1;
        let p = parents[i];
        if p == anim_math::layout::NO_PARENT || p as usize >= i {
            break;
        }
        i = p as usize;
    }
    let mut m = local(chain[n - 1] as usize);
    for k in (0..n - 1).rev() {
        m = m.compose(local(chain[k] as usize));
    }
    m
}

/// The query's bones: the last two output poses in character space.
struct PoseBones<'a> {
    parents: &'a [u16],
    last: &'a [SoaTransform],
    prev: &'a [SoaTransform],
    frame_last: CharacterFrame,
    frame_prev: CharacterFrame,
}

impl<'a> PoseBones<'a> {
    fn new(
        parents: &'a [u16],
        rest: &[AosTransform],
        last: &'a [SoaTransform],
        prev: &'a [SoaTransform],
        root: usize,
    ) -> Self {
        let rest_root = rest.get(root).map_or(AosQuat::identity(), |t| t.rotation);
        Self {
            parents,
            last,
            prev,
            frame_last: CharacterFrame::from_root(model(parents, last, root), rest_root),
            frame_prev: CharacterFrame::from_root(model(parents, prev, root), rest_root),
        }
    }
}

impl BoneSource for PoseBones<'_> {
    fn bone(&self, bone: u32) -> Option<(AosTransform, AosTransform)> {
        let b = bone as usize;
        if b >= self.parents.len() {
            return None;
        }
        let at = |frame: &CharacterFrame, pose: &[SoaTransform]| {
            let m = model(self.parents, pose, b);
            AosTransform::new(frame.point3_to_local(m.translation), m.rotation, m.scale)
        };
        Some((
            at(&self.frame_last, self.last),
            at(&self.frame_prev, self.prev),
        ))
    }
}

/// The character's movement from world (`p0`, `yaw0`) to (`p1`, `yaw1`), in the frame at the first.
fn world_delta(p0: [f32; 2], yaw0: f32, p1: [f32; 2], yaw1: f32) -> RootDelta {
    let (s, c) = sin_cos(yaw0);
    let frame = CharacterFrame {
        position: p0,
        forward: [s, c],
    };
    let d = frame.vector_to_local([p1[0] - p0[0], p1[1] - p0[1]]);
    let (hs, hc) = sin_cos(0.5 * anim_match::spring::wrap_angle(yaw1 - yaw0));
    RootDelta {
        translation: AosVec3::new(d[0], 0.0, d[1]),
        rotation: AosQuat::new(0.0, hs, 0.0, hc),
    }
}

fn update(cx: &mut EvalContext<'_>, node: &NodeData<'_>) {
    let dt = cx.dt();
    let assets = cx.assets();
    cx.state()[state::SWITCH_FLAG] = 0;
    let handle = cx.state()[state::DB];
    let found = if handle != 0 {
        assets.match_db(handle)
    } else {
        None
    };
    let Some(m) = found else {
        // No database: whatever plays keeps playing.
        sources::player_phase(cx, state::PLAYER, 1.0);
        return;
    };
    let db = m.db;
    let lanes = db.lanes();
    let input = trajectory_input(cx, node);
    let ts = trajectory_settings(node.params);
    let mut predictor = TrajectoryPredictor::read_words(&cx.state()[state::PREDICTOR..]);
    predictor.update(dt, &input, &ts);
    let mut trajectory = Trajectory::default();
    predictor.predict(&input, &ts, db.trajectory_offsets(), &mut trajectory);

    // The query's pose: the last two output poses, or the rest pose before there are two.
    let skel = cx.skeleton();
    let playing = sources::clip_of(cx.state());
    let root = if playing != 0 {
        assets
            .clip(playing)
            .map_or(0, |c| c.root_bone as usize)
            .min(skel.bones().saturating_sub(1))
    } else {
        0
    };
    let delta = {
        let s = cx.state();
        let w = |i: usize| f32::from_bits(s[i]);
        if s[state::POSE_COUNT] >= 2 {
            world_delta(
                [w(state::POSE_PREV), w(state::POSE_PREV + 1)],
                w(state::POSE_PREV + 2),
                [w(state::POSE_LAST), w(state::POSE_LAST + 1)],
                w(state::POSE_LAST + 2),
            )
        } else {
            RootDelta::identity()
        }
    };
    let (last, prev, pose_dt, delta) = match cx.history() {
        Some(h) if h.last.len() == skel.groups() && h.prev.len() == skel.groups() => {
            (h.last, h.prev, h.dt, delta)
        }
        _ => (skel.rest_soa, skel.rest_soa, 0.0, RootDelta::identity()),
    };
    let mut query = [F32x4::splat(0.0); MAX_QUERY_LANES];
    let built = lanes <= MAX_QUERY_LANES && skel.bones() > 0 && {
        let bones = PoseBones::new(skel.parents, skel.rest, last, prev, root);
        build_query_from(db, &bones, delta, pose_dt, &trajectory, &mut query[..lanes]).is_ok()
    };
    let tags = tag_filter(cx, node);
    let settings = controller_settings(cx, node);
    let mut controller = MatchController::read_words(settings, &cx.state()[state::CONTROLLER..]);
    let out = if built {
        Some(controller.update(db, dt, &query[..lanes], &tags))
    } else {
        None
    };

    let mut started = false;
    if let Some(o) = out.filter(|o| o.switched) {
        let target = m.clips.get(o.clip as usize).copied().unwrap_or(0);
        let want_mirror = db.clip_mirrored(o.clip) as u32;
        let rate = db.sample_rate();
        let s = cx.state();
        let current = sources::clip_of(s);
        let was_mirrored = s[state::MIRRORED];
        let near = current == target
            && target != 0
            && was_mirrored == want_mirror
            && (sources::time_of(s) - o.time).abs() <= 1.0 / rate;
        if !near {
            // The old clip's last step is this update's root motion.
            sources::player_phase(cx, state::PLAYER, 1.0);
            let mut r = sources::player_root_at(cx, state::PLAYER);
            if was_mirrored != 0 {
                r = mirror_root(r, mirror_axis(db));
            }
            let s = cx.state();
            s[state::MIRRORED] = want_mirror;
            let words = [
                r.translation.x,
                r.translation.y,
                r.translation.z,
                r.rotation.x,
                r.rotation.y,
                r.rotation.z,
                r.rotation.w,
            ];
            for (o, v) in s[state::SWITCH_ROOT..state::SWITCH_ROOT + 7]
                .iter_mut()
                .zip(words)
            {
                *o = v.to_bits();
            }
            s[state::SWITCH_FLAG] = (current != 0) as u32;
            // The controller's time is the pose shown last (the query's), the player's the one
            // shown next: one step ahead.
            sources::start_play(
                &mut s[state::PLAYER..state::PLAYER + player::WORDS as usize],
                target,
                o.time + dt,
                1.0,
                0,
                0,
            );
            if current != 0 {
                let blend = node.f32_or(word::BLEND, 0.2);
                cx.request_inertialization(blend);
            }
            started = true;
        }
    }
    if !started {
        sources::player_phase(cx, state::PLAYER, 1.0);
    }

    let s = cx.state();
    s[state::UPDATES] = s[state::UPDATES].wrapping_add(1);
    let mut flags = 0;
    if let Some(o) = out {
        if o.searched {
            flags |= MATCH_SEARCHED;
            s[state::LAST_SEARCH] = s[state::UPDATES];
        }
        if o.switched {
            flags |= MATCH_SWITCHED;
        }
        s[state::FRAME] = o.frame;
        s[state::COST] = o.cost.to_bits();
    }
    s[state::FLAGS] = flags;
    s[state::WORLD] = input.position[0].to_bits();
    s[state::WORLD + 1] = input.position[1].to_bits();
    s[state::WORLD + 2] = input.yaw.to_bits();
    controller.write_words(&mut s[state::CONTROLLER..]);
    predictor.write_words(&mut s[state::PREDICTOR..]);
}
