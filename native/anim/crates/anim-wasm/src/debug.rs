//! Feature `debug`: graph debug records for the editor (wire family `debug`, whose module documents
//! the layout). Pulled per instance: [`write`] fills the debug buffer from an instance's state
//! after its last `evaluate`, only for instances flagged with the `graph` family's `DEBUG`
//! command, through `anim-graph`'s [`collect`]. Never allocates.

use anim_graph::debug::{collect, Blocker, DebugSink, MachineView, NodeView, TransitionView};
use anim_graph::eval::{History, Inputs, SkeletonPose};
use anim_wire::core::{
    Init, FLAG_BAKE_ROOT, INPUT_FLAGS, INPUT_LAYER_WEIGHTS, INPUT_STRIDE, MAX_LAYERS,
};
use anim_wire::debug::{
    DebugHeader, DebugMachine, DebugNode, DebugRequest, DebugTransition, BLOCK_CONDITION,
    BLOCK_INTERRUPT, BLOCK_READY, BLOCK_SHADOWED, BLOCK_TRAVEL, BLOCK_WHEN, DEBUG_BYTES,
};
use anim_wire::WireRecord;

use crate::assets::{split, Arena};
use crate::instances::Table;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the debug buffer.
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    DEBUG_BYTES as u64
}

struct Writer<'b> {
    out: &'b mut [u8],
    at: usize,
    header: DebugHeader,
}

impl Writer<'_> {
    fn put<R: WireRecord>(&mut self, r: &R) -> bool {
        let stride = R::DESC.stride as usize;
        match self.out.get_mut(self.at..self.at + stride) {
            Some(o) => {
                let _ = r.encode_into(o);
                self.at += stride;
                true
            }
            None => {
                self.header.dropped += 1;
                false
            }
        }
    }
}

impl DebugSink for Writer<'_> {
    fn node(&mut self, v: NodeView) {
        if self.put(&DebugNode {
            node: v.node,
            weight: v.weight,
            clip: v.clip,
            time: v.time,
            normalized: v.normalized,
        }) {
            self.header.nodes += 1;
        }
    }

    fn machine(&mut self, machine: u32, v: MachineView) {
        if self.put(&DebugMachine {
            machine,
            current: v.current,
            target: v.target,
            active: v.active,
            elapsed: v.elapsed,
            duration: v.duration,
            state_time: v.state_time,
            normalized: v.norm,
            travel: v.travel,
            last_fired: v.last_fired,
            entries: v.entries,
        }) {
            self.header.machines += 1;
        }
    }

    fn transition(&mut self, v: TransitionView) {
        let (blocker, detail, value) = match v.blocker {
            Blocker::Ready => (BLOCK_READY, 0, 0.0),
            Blocker::Condition { cond, value } => (BLOCK_CONDITION, cond, value),
            Blocker::Shadowed { by } => (BLOCK_SHADOWED, by, 0.0),
            Blocker::Interrupt => (BLOCK_INTERRUPT, 0, 0.0),
            Blocker::When => (BLOCK_WHEN, 0, 0.0),
            Blocker::Travel => (BLOCK_TRAVEL, 0, 0.0),
        };
        if self.put(&DebugTransition {
            machine: v.machine,
            transition: v.transition,
            target: v.target,
            blocker,
            detail,
            value,
        }) {
            self.header.transitions += 1;
        }
    }

    fn request(&mut self, name: u32, life: f32) {
        if self.put(&DebugRequest { name, life }) {
            self.header.requests += 1;
        }
    }
}

/// Writes instance `h`'s debug report into `out`; returns the bytes written (0 for a stale handle,
/// an implicit-graph instance, or one not flagged). Never allocates.
pub fn write(arena: &Arena, table: &mut Table, inputs_view: &[u32], h: u32, out: &mut [u8]) -> u32 {
    let Ok(inst) = table.get_mut(h) else {
        return 0;
    };
    if !inst.debug || inst.graph == 0 {
        return 0;
    }
    let (Ok(skel), Ok(graph)) = (arena.skeleton(inst.skeleton), arena.graph(inst.graph)) else {
        return 0;
    };
    let (index, _) = split(h);
    let row = &inputs_view[index * (INPUT_STRIDE / 4) as usize..][..(INPUT_STRIDE / 4) as usize];
    let mut weights = [0.0f32; MAX_LAYERS as usize];
    for (l, w) in weights.iter_mut().enumerate() {
        *w = f32::from_bits(row[(INPUT_LAYER_WEIGHTS / 4) as usize + l]);
    }
    let history = (inst.history >= 2).then_some(History {
        last: &inst.last,
        prev: &inst.prev,
        dt: inst.history_dt,
    });
    let inputs = Inputs {
        assets: arena,
        skeleton: SkeletonPose {
            parents: &skel.parents,
            rest: &skel.rest,
            rest_soa: &skel.rest_soa,
            identity: &skel.identity,
            bind_soa: &skel.bind_soa,
        },
        bindings: &graph.bindings,
        layer_weights: &weights,
        history,
        bake_root: row[(INPUT_FLAGS / 4) as usize] & FLAG_BAKE_ROOT != 0,
    };
    let head = DebugHeader::STRIDE as usize;
    if out.len() < head {
        return 0;
    }
    let (first, rest) = out.split_at_mut(head);
    let mut w = Writer {
        out: rest,
        at: 0,
        header: DebugHeader {
            instance: h,
            ..DebugHeader::default()
        },
    };
    collect(&graph.program, &inputs, &mut inst.state, &mut w);
    w.header.record_bytes = w.at as u32;
    let _ = w.header.encode_into(first);
    (head + w.at) as u32
}
