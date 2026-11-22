//! Node family `logic`: state machines (priority transitions, `when`/`how` with `bridge`, inertialization, requests with lifetimes, `travel` pathfinding, `jump`, any-state, sub-machines), chooser tables and the seeded random selector.
//!
//! # `STATE_MACHINE` (kind 0)
//!
//! A node named by a `MACHINES` record; its states' sub-graphs (and its bridge nodes) are gated
//! update contexts, so only contributing states advance and a state restarts when it is entered.
//! No parameter words.
//!
//! **The blend stack.** The machine shows up to [`MAX_ENTRIES`] entries, oldest first, each a state
//! (or a bridge) fading in over its transition's duration and shape: entry `i` contributes
//! `wᵢ · Π_{j>i} (1 − wⱼ)` with `w₀ = 1` (Unreal's blend stack). When an entry finishes fading in,
//! the entries below it leave (reported `StateExited`). A transition that interrupts a fade pushes
//! another entry; with the stack full, the oldest leaves at once and the transition asks the
//! ancestor inertialization node to absorb the pop.
//!
//! **Each update:** a pending `jump` cuts first; then every entry's context advances by `dt`;
//! the current state's time and normalised time grow; finished fades collapse the stack; a bridge
//! that reached its `exit` marker (or end) enters its target; then **one** transition may fire:
//! any-state transitions first (except those into the current state), then the current state's,
//! each list in its priority order. A transition fires when
//!
//! - no transition is in progress, or the one in progress lets it interrupt (`canInterrupt`:
//!   never, any, or its list), and
//! - its `when` holds for the current state's timing (its highest-weight clip): `now`; `exit`
//!   (the clip crossed an `exit` marker this update, else its end — a non-looping clip held at its
//!   end counts — or a sub-machine sits in an exit state); `marker:<name>` (it crossed a sync
//!   marker of that name); a normalised time (reached: `norm ≥ v`, the fractional part for a
//!   looping clip and `v < 1`), and
//! - its condition holds. A request the condition reads is consumed when the transition fires
//!   (reported `RequestConsumed`).
//!
//! While travelling (`travel`), only the next transition on the path is considered, its condition
//! ignored (its `when` and the interrupt rules still apply); travel ends at the target. The path
//! comes from the program's next-hop table: shortest by transition count, ties to the earlier
//! candidate in the order above.
//!
//! **How:** `cut` drops every entry; `crossfade` pushes the target fading in with the shape;
//! `inertialize` cuts and asks the ancestor inertialization node for the duration; `bridge`
//! pushes the bridge node fading in, and when the bridge reaches its `exit` marker (or end) pushes
//! the target fading in over the same duration and shape. Entering a state re-initialises its
//! context and reports `StateEntered`.
//!
//! **Fade shapes** (the transition's shape id): 0 linear, 1 smooth (`3x² − 2x³`), 2 ease in
//! (`x²`), 3 ease out (`1 − (1 − x)²`); others read as linear.
//!
//! State words ([`machine`]): current state, target (mid-transition), the transition in progress,
//! state time, normalised time, travel target, pending jump, entry count, the last transition
//! fired, the entries retired this update (walked once at weight 0 in Tracks so their notify
//! states end), then the entries (state or bridge, elapsed, duration, shape, root node).
//!
//! Timing is the newest entry's, with `exit` set while the current state is an exit state.
//!
//! # `RANDOM` (kind 1)
//!
//! Inputs: the choices (gated: only the pick advances). Picks once each time it is initialised
//! (when its state is entered), from the instance's seeded generator (in the blob, so replays and
//! restores repeat it). Words: 0 `u32` mode ([`RANDOM_WEIGHTED`], [`RANDOM_SHUFFLE`],
//! [`RANDOM_ROUND_ROBIN`]), 1 `u32` avoid-repeat count (weighted: none of the last N picks while
//! another choice has weight, at most 8; shuffle: with N ≥ 1, a new cycle doesn't start with the
//! last pick), 2… `f32` weight per input (weighted; 1 when absent). State: the pick, the history
//! count, the last 8 picks, the shuffle's used mask (at most 32 inputs). Everything else is the
//! pick's.
//!
//! # `CHOOSER` (kind 2)
//!
//! A node named by a `CHOOSERS` record: the first row whose condition holds picks its result
//! node, else the fallback (else nothing). Results are gated. Words: 0 `u32` flags
//! ([`CHOOSER_EVERY_UPDATE`]: re-evaluate each update, else only when initialised), 1 `f32` blend
//! time when the pick changes. Conditions read parameters and requests (state time and
//! normalised time read 0; a chooser consumes no request). State: the pick, the previous pick
//! fading out, the fade's elapsed and duration.

use anim_format::graph::{CmpOp, CondNode, How, Operand, ParamType, When, STATE_EXIT};
use anim_format::NONE;
use anim_math::Lane;

use crate::dispatch::NodeStatus;
use crate::eval::{
    interrupt_allows, EvalContext, MachineInfo, NodeData, Phase, Program, StateEvent,
    StateEventKind, Timing,
};
use crate::mixing::{self, unit};

/// The family's node kinds.
pub mod kind {
    /// A state machine (a `MACHINES` record names it).
    pub const STATE_MACHINE: u16 = 0;
    /// The seeded random selector.
    pub const RANDOM: u16 = 1;
    /// A chooser table (a `CHOOSERS` record names it).
    pub const CHOOSER: u16 = 2;
}

/// The most entries a machine's blend stack holds.
pub const MAX_ENTRIES: usize = 4;
/// The most retired entries walked at weight 0 in one Tracks phase.
const MAX_RETIRED: usize = 4;
/// An entry's kind bit: a bridge (the low bits: its transition), else a state (local index).
const BRIDGE: u32 = 0x8000_0000;

/// [`kind::RANDOM`] mode: weighted, avoiding the last N picks.
pub const RANDOM_WEIGHTED: u32 = 0;
/// [`kind::RANDOM`] mode: every choice once per cycle, in random order.
pub const RANDOM_SHUFFLE: u32 = 1;
/// [`kind::RANDOM`] mode: in order.
pub const RANDOM_ROUND_ROBIN: u32 = 2;
/// [`kind::CHOOSER`] flag: re-evaluate the rows every update.
pub const CHOOSER_EVERY_UPDATE: u32 = 1;

/// A state machine's state words.
pub mod machine {
    pub const CURRENT: usize = 0;
    pub const TARGET: usize = 1;
    pub const ACTIVE: usize = 2;
    pub const STATE_TIME: usize = 3;
    pub const NORM: usize = 4;
    pub const TRAVEL: usize = 5;
    pub const JUMP: usize = 6;
    pub const COUNT: usize = 7;
    pub const LAST_FIRED: usize = 8;
    pub const RETIRED_COUNT: usize = 9;
    pub const RETIRED: usize = 10;
    pub const ENTRIES: usize = 14;
    /// Words per entry: kind (state, or `BRIDGE | transition`), elapsed, duration, shape, root.
    pub const ENTRY_WORDS: usize = 5;
    pub const WORDS: u32 = (ENTRIES + super::MAX_ENTRIES * ENTRY_WORDS) as u32;
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::STATE_MACHINE => state_machine(cx, node),
        kind::RANDOM => random(cx, node),
        kind::CHOOSER => chooser(cx, node),
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

// -------------------------------------------------------------------------------------------------
// Conditions
// -------------------------------------------------------------------------------------------------

/// What a condition reads besides parameters and requests.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CondEnv {
    pub state_time: f32,
    pub norm: f32,
    pub timing: Timing,
}

/// A condition's outcome: whether it holds, and the first failing comparison (condition node
/// index and the operand's current value) when it doesn't.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CondOutcome {
    pub pass: bool,
    pub failing: Option<(u32, f32)>,
}

/// The value of an operand (floats; ints and bools as their value) and whether it compares as an
/// int.
fn operand(cx: &mut EvalContext<'_>, env: &CondEnv, op: Operand) -> (f32, Option<i32>) {
    let program = cx.program();
    match op {
        Operand::Param(i) => {
            let w = cx.param_words(i)[0];
            match program.param_type(i as usize) {
                Some(ParamType::Int) => (w as i32 as f32, Some(w as i32)),
                Some(ParamType::Bool) => ((w != 0) as u32 as f32, Some((w != 0) as i32)),
                _ => (f32::from_bits(w), None),
            }
        }
        Operand::StateTime => (env.state_time, None),
        Operand::NormalizedTime => (env.norm, None),
        Operand::SyncPhase => {
            let v = crate::sources::phase_of(cx, &env.timing).map_or(0.0, |p| {
                if p.marker == anim_pose::sync::NO_MARKER {
                    p.normalized
                } else {
                    p.marker as f32 + p.fraction
                }
            });
            (v, None)
        }
        Operand::Curve(id) => {
            let hash = program.string_hash(id);
            let v = cx
                .assets()
                .clip(env.timing.clip)
                .and_then(|c| {
                    let track = c.curves.iter().find(|x| x.0 == hash)?.1;
                    let mut out = [0.0f32; 4];
                    c.bound
                        .sample_track(track as usize, env.timing.time, &mut out);
                    Some(out[0])
                })
                .unwrap_or(0.0);
            (v, None)
        }
        Operand::Request(id) => {
            let live = cx.request_live(id) as i32;
            (live as f32, Some(live))
        }
    }
}

fn compare(op: CmpOp, a: f32, b: f32) -> bool {
    match op {
        CmpOp::Eq => a == b,
        CmpOp::Ne => a != b,
        CmpOp::Lt => a < b,
        CmpOp::Le => a <= b,
        CmpOp::Gt => a > b,
        CmpOp::Ge => a >= b,
    }
}

fn compare_i(op: CmpOp, a: i32, b: i32) -> bool {
    match op {
        CmpOp::Eq => a == b,
        CmpOp::Ne => a != b,
        CmpOp::Lt => a < b,
        CmpOp::Le => a <= b,
        CmpOp::Gt => a > b,
        CmpOp::Ge => a >= b,
    }
}

/// Evaluates condition program `index` (`NONE`: always true). Never allocates.
pub(crate) fn condition(cx: &mut EvalContext<'_>, index: u32, env: &CondEnv) -> CondOutcome {
    let ok = CondOutcome {
        pass: true,
        failing: None,
    };
    if index == NONE {
        return ok;
    }
    let program = cx.program();
    let Some(p) = program.cond_programs.get(index as usize).copied() else {
        return ok;
    };
    let mut at = p.first;
    let end = p.first + p.count;
    eval_tree(cx, program, &mut at, end, env)
}

fn eval_tree(
    cx: &mut EvalContext<'_>,
    program: &Program,
    at: &mut u32,
    end: u32,
    env: &CondEnv,
) -> CondOutcome {
    let i = *at;
    *at += 1;
    let Some(node) = program.conds.get(i as usize).copied().filter(|_| i < end) else {
        return CondOutcome {
            pass: true,
            failing: None,
        };
    };
    match node {
        CondNode::Compare {
            operand: o,
            op,
            value,
        } => {
            let (v, int) = operand(cx, env, o);
            let pass = match int {
                Some(iv) => compare_i(op, iv, value as i32),
                None => compare(op, v, f32::from_bits(value)),
            };
            CondOutcome {
                pass,
                failing: (!pass).then_some((i, v)),
            }
        }
        CondNode::All(k) | CondNode::Any(k) => {
            let all = matches!(node, CondNode::All(_));
            let mut pass = all;
            let mut failing = None;
            for _ in 0..k {
                let r = eval_tree(cx, program, at, end, env);
                if all {
                    if !r.pass && pass {
                        pass = false;
                        failing = r.failing;
                    }
                } else if r.pass {
                    pass = true;
                    failing = None;
                } else if !pass && failing.is_none() {
                    failing = r.failing;
                }
            }
            CondOutcome {
                pass,
                failing: if pass { None } else { failing },
            }
        }
    }
}

/// Consumes every live request condition program `index` reads, reporting `transition`.
fn consume_requests(cx: &mut EvalContext<'_>, index: u32, transition: u32) {
    let program = cx.program();
    let Some(p) = program.cond_programs.get(index as usize).copied() else {
        return;
    };
    for i in p.first..p.first + p.count {
        if let Some(CondNode::Compare {
            operand: Operand::Request(id),
            ..
        }) = program.conds.get(i as usize)
        {
            cx.consume_request(*id, transition);
        }
    }
}

// -------------------------------------------------------------------------------------------------
// Timing helpers
// -------------------------------------------------------------------------------------------------

fn ceil(x: f32) -> f32 {
    -Lane::floor(-x)
}

/// Whether the window from `prev` by `delta` crosses clip time `m` (the window rule: forward
/// `(a, b]`, reverse `[b, a)`, every loop cycle when looping).
pub(crate) fn crossed(t: &Timing, m: f32) -> bool {
    let (a, d) = (t.prev, t.delta);
    if !(d != 0.0) {
        return false;
    }
    let b = a + d;
    let dur = t.duration;
    if t.looping && dur > 0.0 {
        if d > 0.0 {
            Lane::floor((b - m) / dur) > Lane::floor((a - m) / dur)
        } else {
            ceil((a - m) / dur) > ceil((b - m) / dur)
        }
    } else if d > 0.0 {
        a < m && m <= b
    } else {
        b <= m && m < a
    }
}

/// `when: exit` for a timing: an `exit` marker crossed, else the end (crossed, or held at it), or
/// a sub-machine in an exit state.
pub(crate) fn exit_reached(cx: &EvalContext<'_>, t: &Timing) -> bool {
    if t.exit {
        return true;
    }
    let Some(clip) = cx.assets().clip(t.clip) else {
        return false;
    };
    if !clip.exits.is_empty() {
        return clip.exits.iter().any(|&m| crossed(t, m));
    }
    if t.looping {
        crossed(t, t.duration)
    } else if t.delta >= 0.0 {
        t.time >= t.duration
    } else {
        t.time <= 0.0
    }
}

/// `when: marker:<hash>`: a sync marker of that name crossed.
fn marker_crossed(cx: &EvalContext<'_>, t: &Timing, hash: u32) -> bool {
    cx.assets()
        .clip(t.clip)
        .is_some_and(|c| c.sync.iter().any(|m| m.id == hash && crossed(t, m.time)))
}

/// Whether transition `index`'s `when` holds.
pub(crate) fn when_holds(cx: &EvalContext<'_>, index: u32, env: &CondEnv) -> bool {
    let program = cx.program();
    let Some(t) = program.transitions.get(index as usize) else {
        return false;
    };
    match t.when {
        When::Now => true,
        When::Exit => exit_reached(cx, &env.timing),
        When::Marker(id) => marker_crossed(cx, &env.timing, program.string_hash(id)),
        When::NormalizedTime(v) => {
            if env.timing.looping && v < 1.0 {
                env.norm - Lane::floor(env.norm) >= v || env.norm >= v.max(1.0)
            } else {
                env.norm >= v
            }
        }
    }
}

fn shape(id: u32, x: f32) -> f32 {
    let x = unit(x);
    match id {
        1 => x * x * (3.0 - 2.0 * x),
        2 => x * x,
        3 => 1.0 - (1.0 - x) * (1.0 - x),
        _ => x,
    }
}

// -------------------------------------------------------------------------------------------------
// State machine
// -------------------------------------------------------------------------------------------------

/// One blend-stack entry.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Entry {
    pub kind: u32,
    pub elapsed: f32,
    pub duration: f32,
    pub shape: u32,
    pub root: u32,
}

impl Entry {
    fn read(s: &[u32], i: usize) -> Entry {
        let at = machine::ENTRIES + i * machine::ENTRY_WORDS;
        Entry {
            kind: s[at],
            elapsed: f32::from_bits(s[at + 1]),
            duration: f32::from_bits(s[at + 2]),
            shape: s[at + 3],
            root: s[at + 4],
        }
    }
    fn write(&self, s: &mut [u32], i: usize) {
        let at = machine::ENTRIES + i * machine::ENTRY_WORDS;
        s[at] = self.kind;
        s[at + 1] = self.elapsed.to_bits();
        s[at + 2] = self.duration.to_bits();
        s[at + 3] = self.shape;
        s[at + 4] = self.root;
    }
    /// Its fade-in weight.
    pub fn weight(&self) -> f32 {
        if self.duration > 0.0 && self.elapsed < self.duration {
            shape(self.shape, self.elapsed / self.duration)
        } else {
            1.0
        }
    }
    fn faded_in(&self) -> bool {
        !(self.duration > 0.0 && self.elapsed < self.duration)
    }
}

fn info(cx: &EvalContext<'_>, node: u32) -> Option<(usize, MachineInfo)> {
    let program = cx.program();
    let m = program.side(node) as usize;
    program
        .machines
        .get(m)
        .filter(|x| x.node == node)
        .map(|x| (m, *x))
}

fn state_ctx(program: &Program, m: &MachineInfo, s: u32) -> (u32, u32) {
    program
        .states
        .get((m.states.0 + s) as usize)
        .filter(|_| s < m.states.1)
        .map_or((anim_format::NONE, anim_format::NONE), |st| {
            (st.node, st.ctx)
        })
}

fn entry_ctx(program: &Program, m: &MachineInfo, e: &Entry) -> u32 {
    if e.kind & BRIDGE != 0 {
        program
            .trans_ctx
            .get((e.kind & !BRIDGE) as usize)
            .copied()
            .unwrap_or(NONE)
    } else {
        state_ctx(program, m, e.kind).1
    }
}

fn entries(s: &[u32]) -> ([Entry; MAX_ENTRIES], usize) {
    let n = (s[machine::COUNT] as usize).min(MAX_ENTRIES);
    let mut out = [Entry {
        kind: 0,
        elapsed: 0.0,
        duration: 0.0,
        shape: 0,
        root: NONE,
    }; MAX_ENTRIES];
    for (i, e) in out.iter_mut().enumerate().take(n) {
        *e = Entry::read(s, i);
    }
    (out, n)
}

/// Each entry's contribution (`wᵢ · Π_{j>i} (1 − wⱼ)`).
pub(crate) fn contributions(list: &[Entry]) -> [f32; MAX_ENTRIES] {
    let mut c = [0.0f32; MAX_ENTRIES];
    let mut above = 1.0f32;
    for i in (0..list.len()).rev() {
        let w = if i == 0 { 1.0 } else { list[i].weight() };
        c[i] = w * above;
        above *= 1.0 - w;
    }
    c
}

fn retire(cx: &mut EvalContext<'_>, mi: usize, e: &Entry, keep: &[Entry]) {
    let s = cx.state();
    let r = s[machine::RETIRED_COUNT] as usize;
    if r < MAX_RETIRED && e.root != NONE {
        s[machine::RETIRED + r] = e.root;
        s[machine::RETIRED_COUNT] = (r + 1) as u32;
    }
    if e.kind & BRIDGE == 0 && !keep.iter().any(|k| k.kind == e.kind) {
        cx.emit(StateEvent {
            kind: StateEventKind::StateExited,
            layer: mi as u32,
            play_id: e.kind,
        });
    }
}

fn set_entries(cx: &mut EvalContext<'_>, list: &[Entry]) {
    let s = cx.state();
    for (i, e) in list.iter().enumerate() {
        e.write(s, i);
    }
    s[machine::COUNT] = list.len() as u32;
}

/// Enters local state `s` of the machine (re-initialises it): returns its entry.
fn enter(
    cx: &mut EvalContext<'_>,
    mi: usize,
    m: &MachineInfo,
    s: u32,
    duration: f32,
    shape: u32,
) -> Entry {
    let ctx = state_ctx(cx.program(), m, s).1;
    cx.init_context(ctx);
    entered(cx, mi, m, s, duration, shape)
}

/// Makes local state `s` current (its context already initialised): returns its entry. The
/// machine's own Init uses it directly: the loop that initialises the machine has initialised its
/// states' contexts (they come first in evaluation order), so a random selector there picks once.
fn entered(
    cx: &mut EvalContext<'_>,
    mi: usize,
    m: &MachineInfo,
    s: u32,
    duration: f32,
    shape: u32,
) -> Entry {
    let program = cx.program();
    let (root, _) = state_ctx(program, m, s);
    let st = cx.state();
    st[machine::CURRENT] = s;
    st[machine::TARGET] = NONE;
    st[machine::STATE_TIME] = 0;
    st[machine::NORM] = 0;
    if st[machine::TRAVEL] == s {
        st[machine::TRAVEL] = NONE;
    }
    cx.emit(StateEvent {
        kind: StateEventKind::StateEntered,
        layer: mi as u32,
        play_id: s,
    });
    Entry {
        kind: s,
        elapsed: 0.0,
        duration: if duration > 0.0 { duration } else { 0.0 },
        shape,
        root,
    }
}

/// Pushes `e` on top of the stack (dropping the oldest when full, which asks for an
/// inertialization of `duration`).
fn push(cx: &mut EvalContext<'_>, mi: usize, e: Entry) {
    let (mut list, mut n) = entries(cx.state());
    if n == MAX_ENTRIES {
        let old = list[0];
        list.copy_within(1..n, 0);
        n -= 1;
        retire(cx, mi, &old, &list[..n]);
        cx.request_inertialization(e.duration);
    }
    list[n] = e;
    n += 1;
    set_entries(cx, &list[..n]);
}

/// Cuts to `e`: every other entry leaves.
fn cut_to(cx: &mut EvalContext<'_>, mi: usize, e: Entry) {
    let (list, n) = entries(cx.state());
    let keep = [e];
    for old in &list[..n] {
        retire(cx, mi, old, &keep);
    }
    set_entries(cx, &keep);
}

fn fire(cx: &mut EvalContext<'_>, mi: usize, m: &MachineInfo, t: u32) {
    let program = cx.program();
    let Some(tr) = program.transitions.get(t as usize).copied() else {
        return;
    };
    if tr.condition != NONE {
        consume_requests(cx, tr.condition, t);
    }
    let target = tr.target;
    {
        let s = cx.state();
        s[machine::LAST_FIRED] = t;
        s[machine::ACTIVE] = NONE;
    }
    match tr.how {
        How::Cut => {
            let e = enter(cx, mi, m, target, 0.0, 0);
            cut_to(cx, mi, e);
        }
        How::Inertialize { duration } => {
            let e = enter(cx, mi, m, target, 0.0, 0);
            cut_to(cx, mi, e);
            cx.request_inertialization(duration);
        }
        How::Crossfade { duration, shape } => {
            let e = enter(cx, mi, m, target, duration, shape);
            push(cx, mi, e);
            if duration > 0.0 {
                cx.state()[machine::ACTIVE] = t;
            }
        }
        How::Bridge {
            node,
            duration,
            shape,
        } => {
            let ctx = program.trans_ctx.get(t as usize).copied().unwrap_or(NONE);
            cx.init_context(ctx);
            push(
                cx,
                mi,
                Entry {
                    kind: BRIDGE | t,
                    elapsed: 0.0,
                    duration: duration.max(0.0),
                    shape,
                    root: node,
                },
            );
            let s = cx.state();
            s[machine::ACTIVE] = t;
            s[machine::TARGET] = target;
        }
    }
}

/// The environment the current state's transitions see.
fn env_of(cx: &mut EvalContext<'_>) -> CondEnv {
    let (list, n) = entries(cx.state());
    let current = cx.state()[machine::CURRENT];
    let s = cx.state();
    let (state_time, norm) = (
        f32::from_bits(s[machine::STATE_TIME]),
        f32::from_bits(s[machine::NORM]),
    );
    // The newest entry of the current state times it.
    let root = list[..n]
        .iter()
        .rev()
        .find(|e| e.kind == current)
        .map_or(NONE, |e| e.root);
    let timing = if root != NONE {
        cx.eval_timing(root)
    } else {
        Timing::default()
    };
    CondEnv {
        state_time,
        norm,
        timing,
    }
}

/// Why a candidate transition doesn't fire (the debugger), or that it would.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Blocker {
    /// It would fire (the first ready candidate).
    Ready,
    /// Its condition is false: the first failing comparison (condition node) and the operand's
    /// current value.
    Condition { cond: u32, value: f32 },
    /// It is ready, but an earlier candidate is too.
    Shadowed { by: u32 },
    /// A transition is in progress and doesn't let it interrupt.
    Interrupt,
    /// Its `when` (exit time, marker, normalised time) hasn't been reached.
    When,
    /// The machine is travelling along another path.
    Travel,
}

/// Evaluates candidate `t` of the current state: what (if anything) blocks it.
fn check(cx: &mut EvalContext<'_>, t: u32, env: &CondEnv, active: u32, travel_hop: u32) -> Blocker {
    if active != NONE && !interrupt_allows(cx.program(), active, t) {
        return Blocker::Interrupt;
    }
    if travel_hop != NONE && t != travel_hop {
        return Blocker::Travel;
    }
    if !when_holds(cx, t, env) {
        return Blocker::When;
    }
    if travel_hop == NONE {
        let cond = cx.program().transitions[t as usize].condition;
        let r = condition(cx, cond, env);
        if !r.pass {
            let (c, v) = r.failing.unwrap_or((NONE, 0.0));
            return Blocker::Condition { cond: c, value: v };
        }
    }
    Blocker::Ready
}

fn travel_hop(program: &Program, m: &MachineInfo, current: u32, travel: u32) -> u32 {
    if travel == NONE || travel >= m.states.1 || current >= m.states.1 {
        return NONE;
    }
    let count = m.states.1;
    program
        .hops
        .get((m.hops + current * count + travel) as usize)
        .copied()
        .unwrap_or(NONE)
}

/// Calls `f` with every candidate transition of machine `node`'s current state and its blocker,
/// in the order the machine tries them (the debugger). Never allocates.
pub(crate) fn candidates(cx: &mut EvalContext<'_>, node: u32, f: &mut dyn FnMut(u32, Blocker)) {
    let Some((_, m)) = info(cx, node) else {
        return;
    };
    let (current, active, travel) = {
        let s = cx.node_state(node);
        (s[machine::CURRENT], s[machine::ACTIVE], s[machine::TRAVEL])
    };
    let env = with_node(cx, node, env_of);
    let program = cx.program();
    let hop = travel_hop(program, &m, current, travel);
    let mut first: Option<u32> = None;
    for t in program.candidates(&m, current) {
        let b = with_node(cx, node, |cx| check(cx, t, &env, active, hop));
        let b = match (b, first) {
            (Blocker::Ready, Some(by)) => Blocker::Shadowed { by },
            (Blocker::Ready, None) => {
                first = Some(t);
                Blocker::Ready
            }
            (b, _) => b,
        };
        f(t, b);
    }
}

/// A machine's state for the debugger.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MachineView {
    pub current: u32,
    pub target: u32,
    pub active: u32,
    pub elapsed: f32,
    pub duration: f32,
    pub state_time: f32,
    pub norm: f32,
    pub travel: u32,
    pub last_fired: u32,
    pub entries: u32,
}

/// Machine `node`'s state words, read.
pub(crate) fn view(cx: &mut EvalContext<'_>, node: u32) -> MachineView {
    let s = cx.node_state(node);
    let (list, n) = entries(s);
    let top = list[..n].last().copied();
    MachineView {
        current: s[machine::CURRENT],
        target: s[machine::TARGET],
        active: s[machine::ACTIVE],
        elapsed: top.map_or(0.0, |e| e.elapsed),
        duration: top.map_or(0.0, |e| e.duration),
        state_time: f32::from_bits(s[machine::STATE_TIME]),
        norm: f32::from_bits(s[machine::NORM]),
        travel: s[machine::TRAVEL],
        last_fired: s[machine::LAST_FIRED],
        entries: n as u32,
    }
}

/// Runs `f` as if node `node` were the current node.
fn with_node<'a, R>(
    cx: &mut EvalContext<'a>,
    node: u32,
    f: impl FnOnce(&mut EvalContext<'a>) -> R,
) -> R {
    cx.as_node(node, f)
}

fn state_machine(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    if cx.phase() == Phase::Layout {
        cx.set_state_words(machine::WORDS, 0);
        return;
    }
    let Some((mi, m)) = info(cx, node.index) else {
        mixing::empty(cx);
        return;
    };
    match cx.phase() {
        Phase::Layout => {}
        Phase::Init => {
            let s = cx.state();
            s.fill(0);
            for w in [
                machine::TARGET,
                machine::ACTIVE,
                machine::TRAVEL,
                machine::JUMP,
                machine::LAST_FIRED,
            ] {
                s[w] = NONE;
            }
            let entry = m.entry.min(m.states.1.saturating_sub(1));
            if m.states.1 == 0 {
                return;
            }
            let e = entered(cx, mi, &m, entry, 0.0, 0);
            set_entries(cx, &[e]);
        }
        Phase::Update => update_machine(cx, mi, &m),
        Phase::Tracks | Phase::Weights => {
            let w = cx.weight();
            let (list, n) = entries(cx.state());
            let c = contributions(&list[..n]);
            for (e, ci) in list[..n].iter().zip(c) {
                if e.root != NONE {
                    cx.eval_tracks(e.root, w * ci);
                }
            }
            if cx.phase() == Phase::Tracks {
                let s = cx.state();
                let r = (s[machine::RETIRED_COUNT] as usize).min(MAX_RETIRED);
                let mut retired = [NONE; MAX_RETIRED];
                retired[..r].copy_from_slice(&s[machine::RETIRED..machine::RETIRED + r]);
                s[machine::RETIRED_COUNT] = 0;
                for &root in &retired[..r] {
                    cx.eval_tracks(root, 0.0);
                }
            }
        }
        Phase::Timing => {
            let (list, n) = entries(cx.state());
            let current = cx.state()[machine::CURRENT];
            let active = cx.state()[machine::ACTIVE];
            let mut t = match list[..n].last() {
                Some(e) if e.root != NONE => cx.eval_timing(e.root),
                _ => Timing::default(),
            };
            let program = cx.program();
            let exit_state = program
                .states
                .get((m.states.0 + current) as usize)
                .is_some_and(|st| st.flags & STATE_EXIT != 0);
            t.exit = exit_state && active == NONE;
            cx.set_timing(t);
        }
        _ => {
            let (list, n) = entries(cx.state());
            let c = contributions(&list[..n]);
            let mut items = [(0u32, 0.0f32); MAX_ENTRIES];
            for i in 0..n {
                let e = list[i];
                let a = if e.root != NONE && c[i] > 0.0 {
                    c[i] * cx.eval_alpha(e.root)
                } else {
                    0.0
                };
                items[i] = (e.root, a);
            }
            mixing::weighted(cx, &items[..n]);
        }
    }
}

fn update_machine(cx: &mut EvalContext<'_>, mi: usize, m: &MachineInfo) {
    let dt = cx.dt();
    let program = cx.program();
    if m.states.1 == 0 {
        return;
    }
    // A pending jump cuts first.
    let jump = cx.state()[machine::JUMP];
    if jump != NONE {
        cx.state()[machine::JUMP] = NONE;
        if jump < m.states.1 {
            cx.state()[machine::ACTIVE] = NONE;
            let e = enter(cx, mi, m, jump, 0.0, 0);
            cut_to(cx, mi, e);
        }
    }
    // Advance the entries and their contexts (a state twice in the stack advances once).
    let (mut list, mut n) = entries(cx.state());
    for i in 0..n {
        list[i].elapsed = (list[i].elapsed + dt.abs()).min(list[i].duration.max(0.0));
        let ctx = entry_ctx(program, m, &list[i]);
        let seen = list[..i].iter().any(|e| entry_ctx(program, m, e) == ctx);
        if !seen {
            cx.update_context(ctx, dt);
        }
    }
    // Collapse: entries below the newest fully faded-in one leave.
    if let Some(k) = (0..n).rev().find(|&i| list[i].faded_in()) {
        if k > 0 {
            let keep: [Entry; MAX_ENTRIES] = core::array::from_fn(|i| list[(k + i).min(n - 1)]);
            let kept = n - k;
            for old in &list[..k] {
                retire(cx, mi, old, &keep[..kept]);
            }
            list[..kept].copy_from_slice(&keep[..kept]);
            n = kept;
        }
    }
    set_entries(cx, &list[..n]);
    let top = list[n - 1];
    {
        let s = cx.state();
        let active = s[machine::ACTIVE];
        if active != NONE && top.faded_in() && top.kind & BRIDGE == 0 {
            s[machine::ACTIVE] = NONE;
        }
        let st = f32::from_bits(s[machine::STATE_TIME]) + dt;
        s[machine::STATE_TIME] = st.to_bits();
    }
    let mut env = env_of(cx);
    if env.timing.duration > 0.0 {
        let norm = env.norm + env.timing.delta.abs() / env.timing.duration;
        cx.state()[machine::NORM] = norm.to_bits();
        env.norm = norm;
    }
    // A bridge that reached its exit enters its target.
    if top.kind & BRIDGE != 0 {
        let bt = cx.eval_timing(top.root);
        if exit_reached(cx, &bt) || bt.clip == 0 {
            let t = top.kind & !BRIDGE;
            if let Some(tr) = program.transitions.get(t as usize).copied() {
                if let How::Bridge {
                    duration, shape, ..
                } = tr.how
                {
                    let e = enter(cx, mi, m, tr.target, duration, shape);
                    push(cx, mi, e);
                    cx.state()[machine::ACTIVE] = if duration > 0.0 { t } else { NONE };
                }
            }
            return;
        }
    }
    // One transition.
    let (current, active, travel) = {
        let s = cx.state();
        (s[machine::CURRENT], s[machine::ACTIVE], s[machine::TRAVEL])
    };
    let hop = travel_hop(program, m, current, travel);
    if travel != NONE && hop == NONE {
        cx.state()[machine::TRAVEL] = NONE;
    }
    for t in program.candidates(m, current) {
        if check(cx, t, &env, active, hop) == Blocker::Ready {
            fire(cx, mi, m, t);
            return;
        }
    }
}

/// Asks machine `machine` (an index into the program's machines) of an instance's blob to travel to
/// local state `target`. `Ok(false)` when it is already there; `Err(())` when no path leads there.
#[allow(clippy::result_unit_err)]
pub fn travel(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    machine: usize,
    target: u32,
) -> Result<bool, ()> {
    let m = *program.machines.get(machine).ok_or(())?;
    if target >= m.states.1 {
        return Err(());
    }
    let s = program.node_state(state, groups, m.node);
    let current = s[self::machine::CURRENT];
    let pending = s[self::machine::TARGET];
    let from = if pending != NONE { pending } else { current };
    if from == target && current == target {
        s[self::machine::TRAVEL] = NONE;
        return Ok(false);
    }
    if travel_hop(program, &m, current, target) == NONE
        && travel_hop(program, &m, from, target) == NONE
    {
        return Err(());
    }
    s[self::machine::TRAVEL] = target;
    Ok(true)
}

/// Asks machine `machine` to cut to local state `target` at its next update.
#[allow(clippy::result_unit_err)]
pub fn jump(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    machine: usize,
    target: u32,
) -> Result<(), ()> {
    let m = *program.machines.get(machine).ok_or(())?;
    if target >= m.states.1 {
        return Err(());
    }
    let s = program.node_state(state, groups, m.node);
    s[self::machine::JUMP] = target;
    s[self::machine::TRAVEL] = NONE;
    Ok(())
}

/// The current state (local index) of machine `machine` in a blob.
pub fn current_state(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    machine: usize,
) -> Option<u32> {
    let m = program.machines.get(machine)?;
    Some(program.node_state(state, groups, m.node)[self::machine::CURRENT])
}

// -------------------------------------------------------------------------------------------------
// Random selector
// -------------------------------------------------------------------------------------------------

mod rnd {
    pub const PICK: usize = 0;
    pub const HISTORY_COUNT: usize = 1;
    pub const HISTORY: usize = 2;
    pub const HISTORY_LEN: usize = 8;
    pub const USED: usize = 10;
    pub const WORDS: u32 = 11;
}

fn random_pick(cx: &mut EvalContext<'_>, node: &NodeData<'_>) -> u32 {
    let n = node.inputs.len().min(32);
    if n == 0 {
        return 0;
    }
    let mode = node.word(0);
    let avoid = node.word(1) as usize;
    let (hist_n, history, used, last) = {
        let s = cx.state();
        let hn = (s[rnd::HISTORY_COUNT] as usize).min(rnd::HISTORY_LEN);
        let mut h = [NONE; rnd::HISTORY_LEN];
        h[..hn].copy_from_slice(&s[rnd::HISTORY..rnd::HISTORY + hn]);
        let last = if hn > 0 { h[0] } else { NONE };
        (hn, h, s[rnd::USED], last)
    };
    let pick = match mode {
        RANDOM_ROUND_ROBIN => {
            if last == NONE {
                0
            } else {
                (last + 1) % n as u32
            }
        }
        RANDOM_SHUFFLE => {
            let full = if n == 32 { u32::MAX } else { (1u32 << n) - 1 };
            let mut avail = !used & full;
            let mut used = used;
            if avail == 0 {
                used = 0;
                avail = full;
                if avoid >= 1 && n > 1 && last != NONE {
                    avail &= !(1u32 << last);
                }
            }
            let k = cx.random_u32() % avail.count_ones().max(1);
            let mut bits = avail;
            for _ in 0..k {
                bits &= bits - 1;
            }
            let pick = bits.trailing_zeros().min(n as u32 - 1);
            cx.state()[rnd::USED] = used | (1 << pick);
            pick
        }
        _ => {
            let weight = |i: usize| node.f32_or(2 + i, 1.0).max(0.0);
            let recent =
                |i: usize| history[..hist_n.min(avoid.min(rnd::HISTORY_LEN))].contains(&(i as u32));
            let mut total: f32 = (0..n).filter(|&i| !recent(i)).map(weight).sum();
            let restrict = total > 0.0;
            if !restrict {
                total = (0..n).map(weight).sum();
            }
            let r = cx.random_unit() * total;
            let mut acc = 0.0f32;
            let mut pick = None;
            for i in 0..n {
                if restrict && recent(i) {
                    continue;
                }
                let w = weight(i);
                if w <= 0.0 && total > 0.0 {
                    continue;
                }
                acc += w;
                if r < acc || total <= 0.0 {
                    pick = Some(i as u32);
                    break;
                }
            }
            // Rounding at the top end: the last eligible choice.
            pick.unwrap_or_else(|| {
                (0..n)
                    .rev()
                    .find(|&i| !(restrict && recent(i)) && (weight(i) > 0.0 || total <= 0.0))
                    .unwrap_or(0) as u32
            })
        }
    };
    let s = cx.state();
    s.copy_within(
        rnd::HISTORY..rnd::HISTORY + rnd::HISTORY_LEN - 1,
        rnd::HISTORY + 1,
    );
    s[rnd::HISTORY] = pick;
    s[rnd::HISTORY_COUNT] = (hist_n + 1).min(rnd::HISTORY_LEN) as u32;
    s[rnd::PICK] = pick;
    pick
}

fn random(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Layout => cx.set_state_words(rnd::WORDS, 0),
        // The pick's context was initialised by the loop that initialises this node.
        Phase::Init => {
            random_pick(cx, &node);
        }
        Phase::Update => {
            let pick = cx.state()[rnd::PICK] as usize;
            let ctx = cx.input_context(&node, pick);
            let dt = cx.dt();
            cx.update_context(ctx, dt);
        }
        _ => {
            let pick = cx.state()[rnd::PICK] as usize;
            match node.inputs.get(pick) {
                Some(&input) => mixing::pass(cx, input),
                None => mixing::empty(cx),
            }
        }
    }
}

/// The pick of a random selector's state (the debugger, tests through the core).
pub fn random_choice(state: &[u32]) -> u32 {
    state[rnd::PICK]
}

// -------------------------------------------------------------------------------------------------
// Chooser
// -------------------------------------------------------------------------------------------------

mod ch {
    pub const PICK: usize = 0;
    pub const PREV: usize = 1;
    pub const ELAPSED: usize = 2;
    pub const DURATION: usize = 3;
    pub const WORDS: u32 = 4;
}

/// The chooser's pick: a row index, the row count for the fallback, or `NONE`.
fn choose(cx: &mut EvalContext<'_>, chooser: usize) -> u32 {
    let program = cx.program();
    let Some(c) = program.choosers.get(chooser).copied() else {
        return NONE;
    };
    let env = CondEnv::default();
    for r in 0..c.rows.1 {
        let row = program.rows[(c.rows.0 + r) as usize];
        if condition(cx, row.condition, &env).pass {
            return r;
        }
    }
    if c.fallback != NONE {
        c.rows.1
    } else {
        NONE
    }
}

fn pick_target(program: &Program, chooser: usize, pick: u32) -> (u32, u32) {
    let Some(c) = program.choosers.get(chooser) else {
        return (NONE, NONE);
    };
    if pick == NONE {
        (NONE, NONE)
    } else if pick < c.rows.1 {
        let r = program.rows[(c.rows.0 + pick) as usize];
        (r.node, r.ctx)
    } else {
        (c.fallback, c.fallback_ctx)
    }
}

fn chooser(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    if cx.phase() == Phase::Layout {
        cx.set_state_words(ch::WORDS, 0);
        return;
    }
    let program = cx.program();
    let ci = program.side(node.index) as usize;
    if program
        .choosers
        .get(ci)
        .is_none_or(|c| c.node != node.index)
    {
        mixing::empty(cx);
        return;
    }
    match cx.phase() {
        Phase::Init => {
            let pick = choose(cx, ci);
            let s = cx.state();
            s[ch::PICK] = pick;
            s[ch::PREV] = NONE;
            s[ch::ELAPSED] = 0;
            s[ch::DURATION] = 0;
        }
        Phase::Update => {
            let dt = cx.dt();
            let (pick, prev) = {
                let s = cx.state();
                (s[ch::PICK], s[ch::PREV])
            };
            if node.word(0) & CHOOSER_EVERY_UPDATE != 0 {
                let new = choose(cx, ci);
                if new != pick {
                    let (_, ctx) = pick_target(program, ci, new);
                    cx.init_context(ctx);
                    let blend = node.f32_or(1, 0.0).max(0.0);
                    let s = cx.state();
                    s[ch::PREV] = if blend > 0.0 { pick } else { NONE };
                    s[ch::PICK] = new;
                    s[ch::ELAPSED] = 0;
                    s[ch::DURATION] = blend.to_bits();
                }
            }
            let (pick, prev2) = {
                let s = cx.state();
                (s[ch::PICK], s[ch::PREV])
            };
            let _ = prev;
            let (_, ctx) = pick_target(program, ci, pick);
            cx.update_context(ctx, dt);
            if prev2 != NONE {
                let (_, pctx) = pick_target(program, ci, prev2);
                if pctx != ctx {
                    cx.update_context(pctx, dt);
                }
                let s = cx.state();
                let e = f32::from_bits(s[ch::ELAPSED]) + dt.abs();
                s[ch::ELAPSED] = e.to_bits();
                if e >= f32::from_bits(s[ch::DURATION]) {
                    s[ch::PREV] = NONE;
                }
            }
        }
        _ => {
            let (pick, prev, e, d) = {
                let s = cx.state();
                (
                    s[ch::PICK],
                    s[ch::PREV],
                    f32::from_bits(s[ch::ELAPSED]),
                    f32::from_bits(s[ch::DURATION]),
                )
            };
            let (cur, _) = pick_target(program, ci, pick);
            let (old, _) = pick_target(program, ci, prev);
            let f = if prev != NONE && d > 0.0 {
                unit(e / d)
            } else {
                1.0
            };
            let mut items = [(0u32, 0.0f32); 2];
            let mut k = 0;
            let weighted_phase = cx.phase().is_weighted() || cx.phase() == Phase::Timing;
            for (n, w) in [(old, 1.0 - f), (cur, f)] {
                if n == NONE {
                    continue;
                }
                let a = if weighted_phase || w <= 0.0 {
                    w
                } else {
                    w * cx.eval_alpha(n)
                };
                items[k] = (n, a);
                k += 1;
            }
            mixing::weighted(cx, &items[..k]);
        }
    }
}

/// The pick of a chooser's state: a row index, the row count for the fallback, or `NONE`.
pub fn chooser_pick(state: &[u32]) -> u32 {
    state[ch::PICK]
}
