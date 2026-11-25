//! Node family `slots`: slots with sections (code-first one-shots over the graph, Unreal's slots and montages) and linked graphs swappable per instance at runtime.
//!
//! # `SLOT` (kind 0)
//!
//! Input `[source]` (always updated): passes it through until code plays a clip into the slot (a
//! `SLOTS` record names it; the `graph` family's `SLOT_PLAY`). Words: 0 `u32` a mask: a string id
//! bound to a mask asset, or `NONE` (full body).
//!
//! A play has a clip, the host's play id, a blend-in and a blend-out time, a speed and a
//! **section**: the clip range `[start, end)` it plays (`end` ≤ `start` or past the clip: the
//! clip's end), optionally looping ([`SECTION_LOOP`]). A queued next section
//! (`SLOT_NEXT_SECTION`) takes over seamlessly when the current one reaches its end (combo
//! chains). Without one, the play blends out so that it reaches weight 0 at the section's end, and
//! reports `SlotFinished` there. A new play while one is showing crossfades between the slot's two
//! players over its blend-in (the slot's weight continues from where it is); `SLOT_STOP` blends
//! out. The pose is the slot's clip over the source by the slot's weight through the mask; root
//! motion blends the same way; timing is the source's (a montage doesn't move its state
//! machine's exit times).
//!
//! State ([`slot`]): two players (the [`crate::sources::player`] layout) and the slot's switch,
//! weight, section and queued section words.
//!
//! # `LINKED` (kind 1)
//!
//! Runs another graph (a `LINKED` record names it, with its default graph's string id) inside its
//! own state words, swapped per instance at runtime (`LINK`; weapon layers, Lyra's pattern). The
//! linked graph's parameters take the values of the outer graph's parameters of the same name
//! and type, every update. Words: 0 `u32` state capacity (fixed words), 1 `u32` state capacity
//! (words per bone group), 2 `u32` depth capacity (extra pose-stack levels), 3 `u32` parameter
//! capacity. A graph that doesn't fit is refused ([`can_link`]). A link applies at the next update,
//! which initialises the linked graph; with nothing linked the node outputs nothing (alpha 0).
//! Timing and the weighted walks (Tracks) go into the linked graph; sync groups and the
//! debugger's node walk stop at its boundary.

use anim_format::NONE;
use anim_pose::root::RootDelta;

use crate::dispatch::NodeStatus;
use crate::eval::{
    mix_roots, Assets, EvalContext, NodeData, Phase, Program, StateEvent, StateEventKind,
};
use crate::mixing::{self, unit};
use crate::sources::{self, player, PLAYER_LOOP_SET};

/// The family's node kinds.
pub mod kind {
    /// A slot.
    pub const SLOT: u16 = 0;
    /// A linked graph.
    pub const LINKED: u16 = 1;
}

/// Section flag: loop the section until another command.
pub const SECTION_LOOP: u32 = 1;

/// A slot's state words.
pub mod slot {
    use crate::sources::player;
    pub const A: usize = 0;
    pub const B: usize = player::WORDS as usize;
    pub const ACTIVE: usize = 2 * player::WORDS as usize;
    pub const XF_ELAPSED: usize = ACTIVE + 1;
    pub const XF_DURATION: usize = ACTIVE + 2;
    /// 0 idle, 1 playing (blending in or holding), 2 blending out.
    pub const MODE: usize = ACTIVE + 3;
    pub const IN_ELAPSED: usize = ACTIVE + 4;
    pub const BLEND_IN: usize = ACTIVE + 5;
    pub const BLEND_OUT: usize = ACTIVE + 6;
    pub const OUT_ELAPSED: usize = ACTIVE + 7;
    pub const OUT_FROM: usize = ACTIVE + 8;
    pub const START: usize = ACTIVE + 9;
    pub const END: usize = ACTIVE + 10;
    pub const FLAGS: usize = ACTIVE + 11;
    pub const NEXT_VALID: usize = ACTIVE + 12;
    pub const NEXT_START: usize = ACTIVE + 13;
    pub const NEXT_END: usize = ACTIVE + 14;
    pub const NEXT_FLAGS: usize = ACTIVE + 15;
    pub const PLAY_ID: usize = ACTIVE + 16;
    pub const MASK: usize = ACTIVE + 17;
    pub const FINISHED: usize = ACTIVE + 18;
    pub const WORDS: u32 = (ACTIVE + 19) as u32;
}

/// A linked-graph node's state words (then the linked graph's blob).
pub mod linked {
    pub const HANDLE: usize = 0;
    pub const PENDING: usize = 1;
    pub const MAP_COUNT: usize = 2;
    pub const MAP: usize = 3;
}

/// A slot play.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlotPlay {
    pub clip: u32,
    pub play_id: u32,
    pub blend_in: f32,
    pub blend_out: f32,
    pub speed: f32,
    pub start: f32,
    pub end: f32,
    pub flags: u32,
}

fn f(s: &[u32], i: usize) -> f32 {
    f32::from_bits(s[i])
}

fn finite(v: f32, d: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        d
    }
}

/// The slot's weight from its state.
fn slot_weight(s: &[u32]) -> f32 {
    match s[slot::MODE] {
        1 => {
            let bi = f(s, slot::BLEND_IN);
            if bi > 0.0 {
                unit(f(s, slot::IN_ELAPSED) / bi)
            } else {
                1.0
            }
        }
        2 => {
            let bo = f(s, slot::BLEND_OUT);
            let from = f(s, slot::OUT_FROM);
            if bo > 0.0 {
                from * (1.0 - unit(f(s, slot::OUT_ELAPSED) / bo))
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

/// The weight of the active player within the slot (its internal crossfade).
fn xf_weight(s: &[u32]) -> f32 {
    let d = f(s, slot::XF_DURATION);
    if d > 0.0 {
        unit(f(s, slot::XF_ELAPSED) / d)
    } else {
        1.0
    }
}

fn player_at(side: u32) -> usize {
    if side == 0 {
        slot::A
    } else {
        slot::B
    }
}

/// Starts a play on a slot's state (the `graph` family's `SLOT_PLAY`). Returns the id of the play
/// it replaced (0 for none): the host reports it interrupted.
pub fn play(s: &mut [u32], p: &SlotPlay) -> u32 {
    let replaced = if s[slot::MODE] != 0 && s[slot::FINISHED] == 0 {
        s[slot::PLAY_ID]
    } else {
        0
    };
    let w = slot_weight(s);
    let showing = s[slot::MODE] != 0;
    let side = if showing {
        1 - s[slot::ACTIVE].min(1)
    } else {
        0
    };
    let at = player_at(side);
    sources::start_play(
        &mut s[at..at + player::WORDS as usize],
        p.clip,
        finite(p.start, 0.0).max(0.0),
        finite(p.speed, 1.0),
        PLAYER_LOOP_SET,
        0,
    );
    let blend_in = finite(p.blend_in, 0.0).max(0.0);
    if showing {
        s[slot::XF_ELAPSED] = 0;
        s[slot::XF_DURATION] = blend_in.to_bits();
    } else {
        let other = player_at(1 - side);
        sources::clear(&mut s[other..other + player::WORDS as usize]);
        s[slot::XF_ELAPSED] = 0;
        s[slot::XF_DURATION] = 0;
    }
    s[slot::ACTIVE] = side;
    s[slot::MODE] = 1;
    s[slot::BLEND_IN] = blend_in.to_bits();
    // The slot's weight continues from where it is.
    s[slot::IN_ELAPSED] = if showing { (w * blend_in).to_bits() } else { 0 };
    s[slot::BLEND_OUT] = finite(p.blend_out, 0.0).max(0.0).to_bits();
    s[slot::OUT_ELAPSED] = 0;
    s[slot::START] = finite(p.start, 0.0).max(0.0).to_bits();
    s[slot::END] = finite(p.end, 0.0).to_bits();
    s[slot::FLAGS] = p.flags;
    s[slot::NEXT_VALID] = 0;
    s[slot::PLAY_ID] = p.play_id;
    s[slot::FINISHED] = 0;
    replaced
}

/// Queues the section a slot's play continues with when its current section ends. `false` when
/// `play_id` isn't the slot's current play.
pub fn next_section(s: &mut [u32], play_id: u32, start: f32, end: f32, flags: u32) -> bool {
    if s[slot::MODE] != 1 || s[slot::PLAY_ID] != play_id {
        return false;
    }
    s[slot::NEXT_VALID] = 1;
    s[slot::NEXT_START] = finite(start, 0.0).max(0.0).to_bits();
    s[slot::NEXT_END] = finite(end, 0.0).to_bits();
    s[slot::NEXT_FLAGS] = flags;
    true
}

/// Blends a slot's play out over `fade` seconds (`play_id` 0: whatever plays). Returns the id it
/// stopped (0 for none or another play): the host reports it stopped.
pub fn stop(s: &mut [u32], play_id: u32, fade: f32) -> u32 {
    if s[slot::MODE] == 0 || (play_id != 0 && s[slot::PLAY_ID] != play_id) {
        return 0;
    }
    let id = if s[slot::FINISHED] == 0 {
        s[slot::PLAY_ID]
    } else {
        0
    };
    begin_out(s, finite(fade, 0.0).max(0.0));
    s[slot::FINISHED] = 1;
    id
}

fn begin_out(s: &mut [u32], fade: f32) {
    let w = slot_weight(s);
    s[slot::OUT_FROM] = w.to_bits();
    s[slot::BLEND_OUT] = fade.to_bits();
    s[slot::OUT_ELAPSED] = 0;
    s[slot::MODE] = if fade > 0.0 && w > 0.0 { 2 } else { 0 };
    s[slot::NEXT_VALID] = 0;
}

/// The play a slot's state shows (0 for none).
pub fn playing(s: &[u32]) -> u32 {
    if s[slot::MODE] == 1 && s[slot::FINISHED] == 0 {
        s[slot::PLAY_ID]
    } else {
        0
    }
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::SLOT => slot_node(cx, node),
        kind::LINKED => linked_node(cx, node),
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

/// Whether node `node`'s state words (a restored snapshot's) hold only what the evaluator can run:
/// a linked graph's parameter map, and the graph it runs, which must fit the slot, with that
/// graph's own blob checked in turn. (A slot's words index nothing.)
pub(crate) fn check_state(
    program: &Program,
    node: u32,
    kind: u16,
    s: &[u32],
    groups: usize,
    assets: &dyn Assets,
) -> bool {
    match kind {
        kind::LINKED => {
            let Some(params) = program.node_params(node) else {
                return false;
            };
            let (_, _, _, pcap) = capacity(params);
            let blob = linked::MAP + pcap as usize;
            if s.len() < blob {
                return false;
            }
            let map_count = s[linked::MAP_COUNT] as usize;
            if map_count > pcap as usize
                || s[linked::MAP..linked::MAP + map_count]
                    .iter()
                    .any(|&o| o != NONE && o as usize >= program.param_count())
            {
                return false;
            }
            let handle = s[linked::HANDLE];
            if handle == 0 {
                return true;
            }
            // A released graph runs nothing; one that is there must be one the slot could link.
            let Some(graph) = assets.graph(handle) else {
                return true;
            };
            let inner = graph.program;
            let side = program.side(node) as usize;
            map_count <= inner.param_count()
                && can_link(program, side, inner, groups)
                && s.get(blob..blob + inner.state_words(groups))
                    .is_some_and(|blob| inner.check_state(blob, groups, assets))
        }
        _ => true,
    }
}

fn update_slot(cx: &mut EvalContext<'_>, node: &NodeData<'_>) {
    let dt = cx.dt();
    let s = cx.state();
    if s[slot::MODE] == 0 {
        return;
    }
    let active = s[slot::ACTIVE].min(1);
    let fading = f(s, slot::XF_DURATION) > 0.0 && f(s, slot::XF_ELAPSED) < f(s, slot::XF_DURATION);
    sources::player_phase(cx, player_at(active), 1.0);
    if fading {
        sources::player_phase(cx, player_at(1 - active), 1.0);
    }
    let assets = cx.assets();
    let side = cx.program().side(node.index);
    let s = cx.state();
    let a = player_at(active);
    let clip = assets.clip(s[a + player::CLIP]);
    let duration = clip.map_or(0.0, |c| c.duration);
    let end_of = |e: f32, start: f32| {
        if e > start && e < duration {
            e
        } else {
            duration
        }
    };
    let xe = f(s, slot::XF_ELAPSED) + dt.abs();
    s[slot::XF_ELAPSED] = xe.min(f(s, slot::XF_DURATION).max(0.0)).to_bits();
    if s[slot::MODE] == 1 {
        let ie = f(s, slot::IN_ELAPSED) + dt.abs();
        s[slot::IN_ELAPSED] = ie.min(f(s, slot::BLEND_IN).max(0.0)).to_bits();
    } else if s[slot::MODE] == 2 {
        let oe = f(s, slot::OUT_ELAPSED) + dt.abs();
        s[slot::OUT_ELAPSED] = oe.to_bits();
        if oe >= f(s, slot::BLEND_OUT) {
            // An automatic blend-out (the section's end reached while fading) finishes the play;
            // a stop already marked it finished and reported it.
            let finished_here = s[slot::FINISHED] == 0;
            let id = s[slot::PLAY_ID];
            s[slot::FINISHED] = 1;
            s[slot::MODE] = 0;
            sources::clear(&mut s[slot::A..slot::A + player::WORDS as usize]);
            sources::clear(&mut s[slot::B..slot::B + player::WORDS as usize]);
            if finished_here && id != 0 {
                cx.emit(StateEvent {
                    kind: StateEventKind::SlotFinished,
                    layer: side,
                    play_id: id,
                });
            }
            return;
        }
    }
    if s[slot::FINISHED] != 0 {
        return;
    }
    // Sections.
    let start = f(s, slot::START);
    let end = end_of(f(s, slot::END), start);
    let time = sources::time_of(&s[a..]);
    let speed = f(s, a + player::SPEED);
    let forward = speed >= 0.0;
    let at_end = if forward { time >= end } else { time <= start };
    if at_end {
        let over = if forward { time - end } else { start - time };
        if s[slot::NEXT_VALID] != 0 {
            let ns = f(s, slot::NEXT_START);
            s[slot::START] = s[slot::NEXT_START];
            s[slot::END] = s[slot::NEXT_END];
            s[slot::FLAGS] = s[slot::NEXT_FLAGS];
            s[slot::NEXT_VALID] = 0;
            jump_to(s, a, ns + over);
            return;
        }
        if s[slot::FLAGS] & SECTION_LOOP != 0 && end > start {
            let t = if forward { start + over } else { end - over };
            jump_to(s, a, t);
            return;
        }
        // Finished: hold at the end.
        let held = if forward { end } else { start };
        s[a + player::TIME] = held.to_bits();
        s[slot::FINISHED] = 1;
        let id = s[slot::PLAY_ID];
        if s[slot::MODE] == 1 {
            begin_out(s, 0.0);
        }
        if id != 0 {
            cx.emit(StateEvent {
                kind: StateEventKind::SlotFinished,
                layer: side,
                play_id: id,
            });
        }
        return;
    }
    // Blend out so the weight reaches 0 at the section's end.
    let bo = f(s, slot::BLEND_OUT);
    if s[slot::MODE] == 1
        && s[slot::NEXT_VALID] == 0
        && s[slot::FLAGS] & SECTION_LOOP == 0
        && bo > 0.0
    {
        let left = if forward { end - time } else { time - start };
        let speed = speed.abs().max(1e-6);
        if left / speed <= bo {
            let w = slot_weight(s);
            s[slot::OUT_FROM] = w.to_bits();
            s[slot::MODE] = 2;
            // Already part-way through the blend-out.
            s[slot::OUT_ELAPSED] = (bo - left / speed).max(0.0).to_bits();
        }
    }
}

/// Moves the play's playhead into the next section (the window continues across the jump).
fn jump_to(s: &mut [u32], a: usize, t: f32) {
    let prev = f(s, a + player::PREV_TIME);
    s[a + player::TIME] = t.to_bits();
    s[a + player::DELTA] = (t - prev).to_bits();
    s[a + player::WRAPS] = 0;
}

fn slot_node(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let Some(&source) = node.inputs.first() else {
        if cx.phase() == Phase::Layout {
            cx.set_state_words(slot::WORDS, 0);
        } else {
            mixing::empty(cx);
        }
        return;
    };
    match cx.phase() {
        Phase::Layout => cx.set_state_words(slot::WORDS, 0),
        Phase::Init => {
            let mask = cx.binding(node.word_or_none(0));
            let s = cx.state();
            s.fill(0);
            s[slot::MASK] = mask;
        }
        Phase::Update => update_slot(cx, &node),
        Phase::Timing => {
            let t = cx.eval_timing(source);
            cx.set_timing(t);
        }
        Phase::Weights => {
            let w = cx.weight();
            cx.eval_tracks(source, w);
        }
        phase => {
            let (w, xf, active) = {
                let s = cx.state();
                (slot_weight(s), xf_weight(s), s[slot::ACTIVE].min(1))
            };
            let a = player_at(active);
            let b = player_at(1 - active);
            match phase {
                Phase::Tracks => {
                    let tw = cx.weight();
                    cx.eval_tracks(source, tw);
                    // The slot's players at their weights (their own windows end notify states).
                    for (at, pw) in [(a, w * xf), (b, w * (1.0 - xf))] {
                        tracks_at(cx, at, tw * pw);
                    }
                }
                Phase::Alpha => {
                    let sa = cx.eval_alpha(source);
                    cx.set_alpha(if w > 0.0 { 1.0f32.max(sa) } else { sa });
                }
                Phase::Root => {
                    let rs = cx.eval_root(source);
                    if w <= 0.0 {
                        cx.set_root(rs);
                        return;
                    }
                    let ra = player_root(cx, a);
                    let r = if xf < 1.0 {
                        let rb = player_root(cx, b);
                        mix_roots(rb, ra, xf)
                    } else {
                        ra
                    };
                    cx.set_root(mix_roots(rs, r, w));
                }
                Phase::Pose => slot_pose(cx, source, w, xf, a, b),
                _ => {}
            }
        }
    }
}

fn tracks_at(cx: &mut EvalContext<'_>, at: usize, weight: f32) {
    sources::player_tracks_at(cx, at, weight);
}

fn player_root(cx: &mut EvalContext<'_>, at: usize) -> RootDelta {
    sources::player_root_at(cx, at)
}

fn slot_pose(cx: &mut EvalContext<'_>, source: u32, w: f32, xf: f32, a: usize, b: usize) {
    let out = cx.out();
    if w <= 0.0 {
        cx.eval_pose(source, out);
        return;
    }
    let (Some(s_src), Some(s_a)) = (cx.push_slot(), cx.push_slot()) else {
        cx.eval_pose(source, out);
        return;
    };
    cx.eval_pose(source, s_src);
    // The players' poses are read only through the slot's mask (`blend_masked` keeps the source
    // bit for bit where it is 0), so they skip the bones it excludes.
    let groups = cx.groups();
    let mask_handle = cx.state()[slot::MASK];
    let mask = if mask_handle != 0
        && cx
            .assets()
            .mask(mask_handle)
            .is_some_and(|m| m.len() == groups)
    {
        mask_handle
    } else {
        0
    };
    let prev = cx.set_out(s_a);
    sources::player_pose_at(cx, a, (a == slot::B) as usize, mask);
    if xf < 1.0 {
        if let Some(s_b) = cx.push_slot() {
            cx.set_out(s_b);
            sources::player_pose_at(cx, b, (b == slot::B) as usize, mask);
            // s_a ← lerp(b, a, xf)
            cx.lerp_slot_into(s_b, s_a, xf);
            cx.copy_slot(s_b, s_a);
            cx.pop_slot();
        }
    }
    cx.set_out(prev);
    let mask = if mask != 0 {
        cx.assets().mask(mask)
    } else {
        None
    };
    if let Some((ps, pa, po)) = cx.poses3(s_src, s_a, out) {
        match mask {
            Some(m) => anim_pose::blend::blend_masked(ps, pa, m, w, po),
            None => anim_pose::blend::lerp(ps, pa, w, po),
        }
    }
    cx.pop_slot();
    cx.pop_slot();
}

// -------------------------------------------------------------------------------------------------
// Linked graphs
// -------------------------------------------------------------------------------------------------

/// A linked-graph node's declared depth capacity (from its parameter words).
pub(crate) fn linked_depth(words: &[u32]) -> u32 {
    words.get(2).copied().unwrap_or(0).min(64)
}

fn capacity(words: &[u32]) -> (u32, u32, u32, u32) {
    let w = |i: usize| words.get(i).copied().unwrap_or(0);
    (w(0), w(1), w(2).min(64), w(3).min(1024))
}

/// Whether `graph` fits linked-graph slot `index` of `outer` for a skeleton of `groups` bone
/// groups (state, pose stack and parameter capacities).
pub fn can_link(outer: &Program, index: usize, graph: &Program, groups: usize) -> bool {
    let Some(l) = outer.linked().get(index) else {
        return false;
    };
    let Some(words) = outer.node_params(l.node) else {
        return false;
    };
    let (fixed, per_group, depth, params) = capacity(words);
    let cap = fixed as usize + per_group as usize * groups;
    graph.state_words(groups) <= cap
        && graph.pose_slots() <= 4 + 3 * depth as usize
        && graph.param_count() <= params as usize
}

/// Links `graph` (a handle, 0 to unlink) into linked-graph slot `index`'s state at its next update.
pub fn link(outer: &Program, state: &mut [u32], groups: usize, index: usize, graph: u32) -> bool {
    let Some(l) = outer.linked().get(index) else {
        return false;
    };
    let s = outer.node_state(state, groups, l.node);
    s[linked::PENDING] = graph;
    true
}

/// The graph a linked-graph slot's state runs (0 for none).
pub fn linked_graph(outer: &Program, state: &mut [u32], groups: usize, index: usize) -> u32 {
    outer.linked().get(index).map_or(0, |l| {
        outer.node_state(state, groups, l.node)[linked::HANDLE]
    })
}

fn linked_node(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let (fixed, per_group, _, pcap) = capacity(node.params);
    let blob = linked::MAP + pcap as usize;
    match cx.phase() {
        Phase::Layout => cx.set_state_words(blob as u32 + fixed, per_group),
        Phase::Init => {
            let program = cx.program();
            let side = program.side(node.index) as usize;
            let default = program.linked().get(side).map_or(NONE, |l| l.extra);
            let handle = cx.binding(default);
            let s = cx.state();
            s[..blob].fill(0);
            s[linked::PENDING] = if handle != 0 { handle } else { NONE };
            // Applied now, so the default graph runs from the first frame.
            apply_link(cx, &node, blob);
        }
        Phase::Update => {
            apply_link(cx, &node, blob);
            let handle = cx.state()[linked::HANDLE];
            let Some(graph) = cx.assets().graph(handle) else {
                return;
            };
            let base = cx.state_offset() + blob;
            let dt = cx.dt();
            copy_params(cx, blob, graph.program, base);
            cx.with_program(graph, base, |cx| cx.update_context(0, dt));
        }
        Phase::Weights => {}
        phase => {
            let handle = cx.state()[linked::HANDLE];
            let Some(graph) = cx.assets().graph(handle) else {
                mixing::empty(cx);
                return;
            };
            let base = cx.state_offset() + blob;
            let output = graph.program.output();
            let _ = phase;
            cx.with_program(graph, base, |cx| cx.run_node(output));
        }
    }
}

/// Applies a pending link: builds the parameter map and initialises the linked graph.
fn apply_link(cx: &mut EvalContext<'_>, node: &NodeData<'_>, blob: usize) {
    let pending = cx.state()[linked::PENDING];
    if pending == NONE {
        return;
    }
    let (_, _, _, pcap) = capacity(node.params);
    let outer = cx.program();
    let groups = cx.groups();
    let side = outer.side(node.index) as usize;
    let fits = cx
        .assets()
        .graph(pending)
        .is_some_and(|g| can_link(outer, side, g.program, groups));
    {
        let s = cx.state();
        s[linked::PENDING] = NONE;
        s[linked::HANDLE] = if fits { pending } else { 0 };
        s[linked::MAP_COUNT] = 0;
    }
    let Some(graph) = cx.assets().graph(pending).filter(|_| fits) else {
        return;
    };
    let inner = graph.program;
    let n = inner.param_count().min(pcap as usize);
    for i in 0..n {
        let found = (0..outer.param_count()).find(|&o| {
            outer.param_hash(o) == inner.param_hash(i) && outer.param_type(o) == inner.param_type(i)
        });
        cx.state()[linked::MAP + i] = found.map_or(NONE, |o| o as u32);
    }
    cx.state()[linked::MAP_COUNT] = n as u32;
    let base = cx.state_offset() + blob;
    cx.with_program(graph, base, |cx| cx.init_all());
    copy_params(cx, blob, inner, base);
}

/// Copies the outer graph's mapped parameters into the linked graph's.
fn copy_params(cx: &mut EvalContext<'_>, blob: usize, inner: &Program, base: usize) {
    let _ = (blob, inner);
    let n = cx.state()[linked::MAP_COUNT] as usize;
    for i in 0..n {
        let o = cx.state()[linked::MAP + i];
        if o == NONE {
            continue;
        }
        let words = cx.param_words(o);
        cx.write_words(base + 4 * i, &words);
    }
}
