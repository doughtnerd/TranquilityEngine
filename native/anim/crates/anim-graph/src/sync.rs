//! Node family `sync`: sync groups, markers and notify weights.
//!
//! # `SYNC_GROUP` (kind 0)
//!
//! Input `[child]`. After the child's sub-graph has advanced, every clip player under it follows
//! the heaviest one's (the leader's) phase by sync markers (`anim_pose::sync`, decision D20:
//! the same marker sequence keeps feet aligned however the markers are spaced; a clip without the
//! marker falls back to normalised time). Followers that advanced this frame keep their window
//! (from their previous playhead to the synced one, so notifies and root motion follow); players
//! at weight 0 seek. No words, no state; everything else is the child's. Blend spaces sync their
//! own samples the same way ([`crate::sources`]'s `BS_SYNC`).
//!
//! # `NOTIFY_GATE` (kind 1)
//!
//! Input `[child]`: scales the weight its sub-graph's notifies see (ADR 0352: a notify fires when
//! its clip's weight passes its threshold), so a layer can mute or halve its events without
//! changing its pose. Words: 0 `f32` factor (1 when absent), 1 `u32` a float parameter giving it
//! instead, or `NONE`.

use anim_format::NONE;

use crate::dispatch::NodeStatus;
use crate::eval::{EvalContext, NodeData, Phase};
use crate::mixing;
use crate::sources;

/// The family's node kinds.
pub mod kind {
    /// Members follow the leader's phase.
    pub const SYNC_GROUP: u16 = 0;
    /// Scales the notify weight of a sub-graph.
    pub const NOTIFY_GATE: u16 = 1;
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    let Some(&child) = node.inputs.first() else {
        if matches!(kind, kind::SYNC_GROUP | kind::NOTIFY_GATE) {
            mixing::empty(cx);
            return NodeStatus::Done;
        }
        return NodeStatus::UnknownKind;
    };
    match kind {
        kind::SYNC_GROUP => match cx.phase() {
            Phase::Update => sync_group(cx, child),
            Phase::Layout | Phase::Init => {}
            _ => mixing::pass(cx, child),
        },
        kind::NOTIFY_GATE => match cx.phase() {
            Phase::Tracks => {
                let p = node.word_or_none(1);
                let factor = if p != NONE {
                    cx.param_f32(p)
                } else {
                    node.f32_or(0, 1.0)
                };
                let w = cx.weight();
                cx.eval_tracks(child, w * factor.max(0.0));
            }
            Phase::Layout | Phase::Init | Phase::Update => {}
            _ => mixing::pass(cx, child),
        },
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

fn sync_group(cx: &mut EvalContext<'_>, child: u32) {
    let (players, n) = cx.collect(child, 1.0);
    if n < 2 {
        return;
    }
    let mut leader = 0usize;
    for (i, p) in players[..n].iter().enumerate() {
        if p.1 > players[leader].1 {
            leader = i;
        }
    }
    let lnode = players[leader].0;
    let t = cx.eval_timing(lnode);
    let Some(phase) = sources::phase_of(cx, &t) else {
        return;
    };
    for (i, &(p, w)) in players[..n].iter().enumerate() {
        if i != leader && p != lnode {
            sources::sync_player(cx, p, phase, w > 0.0);
        }
    }
}
