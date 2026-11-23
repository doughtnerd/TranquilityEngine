//! Graph debug state for the editor's graph debugger (ADR 0352, 0353): node weights and phases,
//! state machines with their transition blockers, and request lifetimes, written to the `debug`
//! wire family by `anim-wasm` for instances flagged for debugging.
//!
//! [`collect`] reads an instance's state after its update (it changes nothing but the walk's
//! scratch) and reports, in this order:
//!
//! 1. every node the output's weighted walk reaches ([`NodeView`]: its effective weight, summed
//!    when several paths reach it, and its timing clip's playhead and normalised time), in walk
//!    order, at most [`MAX_NODES`];
//! 2. for every state machine among them ([`MachineView`]): current and target state, the
//!    transition in progress and its fade, state time and normalised time, travel target, the last
//!    transition fired; then each candidate transition of the current state in the order the
//!    machine tries them, with what blocks it ([`Blocker`]: the failing comparison and its
//!    operand's current value, a higher-priority candidate that is also ready, interrupts
//!    disallowed, exit time / marker / normalised time not reached, travelling elsewhere);
//! 3. every request name the conditions read, with its remaining lifetime (0: not live).
//!
//! Never allocates.

pub use crate::logic::{Blocker, MachineView};

use crate::dispatch::Family;
use crate::eval::{EvalContext, Inputs, Phase, Program, Visit};

/// The most nodes one report lists.
pub const MAX_NODES: usize = 256;

/// One active node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NodeView {
    pub node: u32,
    pub weight: f32,
    /// Its timing clip (0: none), playhead and normalised playhead.
    pub clip: u32,
    pub time: f32,
    pub normalized: f32,
}

/// One candidate transition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransitionView {
    /// The machine's index in the graph's `MACHINES`.
    pub machine: u32,
    pub transition: u32,
    pub target: u32,
    pub blocker: Blocker,
}

/// Where a report goes.
pub trait DebugSink {
    fn node(&mut self, view: NodeView);
    fn machine(&mut self, machine: u32, view: MachineView);
    fn transition(&mut self, view: TransitionView);
    fn request(&mut self, name: u32, life: f32);
}

struct Nodes {
    list: [(u32, f32); MAX_NODES],
    len: usize,
}

impl Visit for Nodes {
    fn node(&mut self, node: u32, weight: f32) {
        if let Some(e) = self.list[..self.len].iter_mut().find(|e| e.0 == node) {
            e.1 += weight;
        } else if self.len < MAX_NODES {
            self.list[self.len] = (node, weight);
            self.len += 1;
        }
    }
}

/// Reports an instance's debug state to `sink` (module docs). Never allocates.
pub fn collect(
    program: &Program,
    inputs: &Inputs<'_>,
    state: &mut [u32],
    sink: &mut dyn DebugSink,
) {
    let mut nodes = Nodes {
        list: [(0, 0.0); MAX_NODES],
        len: 0,
    };
    program.visit(inputs, state, &mut nodes);
    let mut events = NoEvents;
    let mut cx = EvalContext::with(
        program,
        Phase::Timing,
        inputs,
        state,
        &mut events,
        None,
        0.0,
    );
    for &(node, weight) in &nodes.list[..nodes.len] {
        let t = cx.eval_timing(node);
        let normalized = if t.duration > 0.0 {
            t.time / t.duration
        } else {
            0.0
        };
        sink.node(NodeView {
            node,
            weight,
            clip: t.clip,
            time: t.time,
            normalized,
        });
    }
    for &(node, _) in &nodes.list[..nodes.len] {
        if program.node_kind(node) != Some((Family::Logic, crate::logic::kind::STATE_MACHINE)) {
            continue;
        }
        let machine = program.side(node);
        if machine == anim_format::NONE {
            continue;
        }
        let view = crate::logic::view(&mut cx, node);
        sink.machine(machine, view);
        crate::logic::candidates(&mut cx, node, &mut |t, blocker| {
            let target = program.transitions.get(t as usize).map_or(0, |x| x.target);
            sink.transition(TransitionView {
                machine,
                transition: t,
                target,
                blocker,
            });
        });
    }
    for &name in program.requests() {
        let life = program
            .request_state(cx.blob(), name)
            .map_or(0.0, |w| f32::from_bits(*w));
        sink.request(name, life.max(0.0));
    }
}

struct NoEvents;
impl crate::eval::Events for NoEvents {
    fn push(&mut self, _: crate::eval::StateEvent) {}
}
