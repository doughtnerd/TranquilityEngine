//! The implicit graph (ADR 0372, decision D5): what an instance without a graph asset runs, so
//! code-first `play`, `crossfade`, `stop` and layer weights go through the same interpreter as
//! authored graphs.
//!
//! It is an ordinary compiled `myco.animgraph@1`, built here once per core and loaded through
//! [`Program::from_view`] like any asset:
//!
//! ```text
//! per layer l < MAX_LAYERS:  ClipPlayer A(3l) ─┐
//!                            ClipPlayer B(3l+1)┴─ Crossfade(3l+2)
//! Layer(3L+l-1) for l ≥ 1:   [previous result, Crossfade(l)]   (index l, override, full body, weight 1)
//! Inertialize(4L-1):         [Layer(4L-2)]                      ← the output
//! ```
//!
//! A play goes to the layer's idle player and fades the crossfade to it (Animancer's model with
//! two states per layer); a play arriving mid-fade, or with `PLAY_INERTIALIZE`, cuts and asks the
//! output's inertialization node to decay the pop instead (Unreal's recommendation for interrupted
//! blends).

use anim_format::graph::{AnimGraph, AnimGraphView, Node};
use anim_format::{graph::family, NONE};
use anim_graph::eval::Program;
use anim_graph::mixing::{self, LAYER_OVERRIDE};
use anim_graph::sources::{self, PLAYER_LOOP, PLAYER_LOOP_SET};
use anim_wire::core::{MAX_LAYERS, PLAY_INERTIALIZE, PLAY_LOOP, PLAY_ONCE};

const L: u32 = MAX_LAYERS;

fn player(layer: u32, side: u32) -> u32 {
    3 * layer + side
}

fn crossfade(layer: u32) -> u32 {
    3 * layer + 2
}

fn layer_node(layer: u32) -> u32 {
    3 * L + layer - 1
}

fn inertialize() -> u32 {
    4 * L - 1
}

/// The implicit graph's file model.
pub fn graph() -> AnimGraph {
    let mut nodes = Vec::new();
    let mut inputs = Vec::new();
    let mut words = Vec::new();
    let mut node = |family: u8, kind: u16, ins: &[u32], params: &[u32]| {
        nodes.push(Node {
            family,
            kind,
            inputs_first: inputs.len() as u32,
            inputs_count: ins.len() as u32,
            params_first: words.len() as u32,
            params_count: params.len() as u32,
            name: NONE,
        });
        inputs.extend_from_slice(ins);
        words.extend_from_slice(params);
    };
    for l in 0..L {
        let p = sources::clip_player_params(NONE, 1.0, 0, 0.0, l);
        node(family::SOURCES, sources::kind::CLIP_PLAYER, &[], &p);
        node(family::SOURCES, sources::kind::CLIP_PLAYER, &[], &p);
        node(
            family::MIXING,
            mixing::kind::CROSSFADE,
            &[player(l, 0), player(l, 1)],
            &[0],
        );
    }
    let mut below = crossfade(0);
    for l in 1..L {
        let p = mixing::layer_params(l, LAYER_OVERRIDE, NONE, 1.0);
        node(
            family::MIXING,
            mixing::kind::LAYER,
            &[below, crossfade(l)],
            &p,
        );
        below = layer_node(l);
    }
    node(family::MIXING, mixing::kind::INERTIALIZE, &[below], &[]);
    AnimGraph {
        name: NONE,
        output: inertialize(),
        skeleton: NONE,
        nodes,
        inputs,
        param_blocks: words,
        ..AnimGraph::default()
    }
}

/// The implicit graph's program.
pub fn program() -> Program {
    let bytes = graph()
        .write()
        .expect("the implicit graph is a valid myco.animgraph@1");
    let view = AnimGraphView::parse(&bytes).expect("written graphs parse");
    Program::from_view(&view).expect("the implicit graph builds")
}

fn player_flags(flags: u32) -> u32 {
    if flags & PLAY_LOOP != 0 {
        PLAYER_LOOP_SET | PLAYER_LOOP
    } else if flags & PLAY_ONCE != 0 {
        PLAYER_LOOP_SET
    } else {
        0
    }
}

/// A code-first play on `layer` (below `MAX_LAYERS`). Returns the ids of the plays it interrupted
/// (0 where none).
#[allow(clippy::too_many_arguments)]
pub fn play(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    layer: u32,
    clip: u32,
    play_id: u32,
    fade: f32,
    speed: f32,
    start: f32,
    flags: u32,
) -> [u32; 2] {
    let (side, fading) = {
        let x = program.node_state(state, groups, crossfade(layer));
        (mixing::crossfade_side(x), mixing::crossfade_fading(x))
    };
    let target = 1 - side;
    let old = sources::interrupt(program.node_state(state, groups, player(layer, side)));
    let replaced = sources::start_play(
        program.node_state(state, groups, player(layer, target)),
        clip,
        start,
        speed,
        player_flags(flags),
        play_id,
    );
    switch(
        program, state, groups, layer, side, target, fade, fading, flags,
    );
    [old, replaced]
}

/// Fades `layer` out to nothing. Returns the id of the play it interrupted (0 for none).
pub fn stop(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    layer: u32,
    fade: f32,
    flags: u32,
) -> [u32; 2] {
    let (side, fading) = {
        let x = program.node_state(state, groups, crossfade(layer));
        (mixing::crossfade_side(x), mixing::crossfade_fading(x))
    };
    let target = 1 - side;
    let old = sources::interrupt(program.node_state(state, groups, player(layer, side)));
    let replaced = sources::clear(program.node_state(state, groups, player(layer, target)));
    switch(
        program, state, groups, layer, side, target, fade, fading, flags,
    );
    [old, replaced]
}

#[allow(clippy::too_many_arguments)]
fn switch(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    layer: u32,
    side: u32,
    target: u32,
    fade: f32,
    fading: bool,
    flags: u32,
) {
    let fade = if fade.is_finite() { fade } else { 0.0 };
    let inertial = fade > 0.0 && (flags & PLAY_INERTIALIZE != 0 || fading);
    let x = program.node_state(state, groups, crossfade(layer));
    if fade <= 0.0 || inertial {
        mixing::crossfade_to(x, target, 0.0);
        if inertial {
            mixing::request_inertialization(x, fade);
        }
        sources::clear(program.node_state(state, groups, player(layer, side)));
    } else {
        mixing::crossfade_to(x, target, fade);
    }
}

/// A layer's mask handle (0: full body) and mode, for layers 1 and up.
pub fn set_layer(
    program: &Program,
    state: &mut [u32],
    groups: usize,
    layer: u32,
    mask: u32,
    mode: u32,
) {
    if (1..L).contains(&layer) {
        mixing::set_layer(
            program.node_state(state, groups, layer_node(layer)),
            mask,
            mode,
        );
    }
}
