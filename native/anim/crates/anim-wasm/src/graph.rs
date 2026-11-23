//! Feature `graph`: graph assets and their instance state: parameters (the blackboard view and
//! `SET_PARAM`), requests, `travel` and `jump`, slot plays with sections, linked-graph selections,
//! layer weights, the seed, pose captures, the debug flag, and the graph state-change records
//! (wire family `graph`, whose module documents the layouts).
//!
//! `write_inputs` (feature `evaluate`) applies the blackboard's dirty rows first, then routes
//! every `graph`-family command in the buffer here ([`apply`]). Commands only write words of the
//! instance's state blob (or its input row); anything that needs the graph to run (entering a
//! state, initialising a linked graph) happens at the next update, so commands never allocate and
//! snapshots taken between frames stay exact.

use anim_format::graph::ParamType;
use anim_graph::dispatch::Family;
use anim_graph::eval::{Program, DEFAULT_SEED};
use anim_graph::{logic, slots, sources};
use anim_wire::core::{
    Init, INPUT_LAYER_WEIGHTS, INPUT_STRIDE, MAX_LAYERS, STATUS_BAD_RECORD, STATUS_MISMATCH,
    STATUS_TOO_LARGE,
};
use anim_wire::graph::{
    CapturePose, Debug, GraphChange, Jump, LayerWeight, Link, Request, SetParam, SetSeed,
    SlotNextSection, SlotPlay, SlotStop, Travel, BLACKBOARD_PARAMS, BLACKBOARD_STRIDE,
    BLACKBOARD_VALUES, DEBUG_ON, GRAPH_SLOT_INTERRUPTED, REASON_INTERRUPTED, REASON_STOPPED,
    STATUS_NO_SUCH, STATUS_UNREACHABLE,
};
use anim_wire::WireRecord;

use crate::assets::{split, Arena};
use crate::instances::{Instance, Table};

/// Graph state-change records the buffer holds per instance (beyond a fixed reserve).
pub const GRAPH_CHANGES_PER_INSTANCE: usize = 16;
/// Graph state-change records the buffer always has room for.
pub const GRAPH_CHANGES_RESERVE: usize = 256;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the blackboard rows and the graph state-change buffer.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    let n = init.max_instances as u64;
    let changes = (n * GRAPH_CHANGES_PER_INSTANCE as u64 + GRAPH_CHANGES_RESERVE as u64)
        * GraphChange::STRIDE as u64;
    n.saturating_mul(BLACKBOARD_STRIDE as u64)
        .saturating_add(changes)
}

/// The graph state-change buffer.
#[derive(Default)]
pub struct GraphChanges {
    pub bytes: Vec<u8>,
    pub count: usize,
    pub dropped: u32,
}

impl GraphChanges {
    /// A buffer for `max_instances` instances.
    pub fn new(max_instances: usize) -> GraphChanges {
        GraphChanges {
            bytes: vec![
                0;
                (max_instances * GRAPH_CHANGES_PER_INSTANCE + GRAPH_CHANGES_RESERVE)
                    * GraphChange::STRIDE as usize
            ],
            count: 0,
            dropped: 0,
        }
    }

    /// Empties it (every `write_inputs`).
    pub fn clear(&mut self) {
        self.count = 0;
        self.dropped = 0;
    }

    /// Appends a record (counted in `dropped` when full). Never allocates.
    pub fn push(&mut self, c: GraphChange) {
        let stride = GraphChange::STRIDE as usize;
        let at = self.count * stride;
        match self.bytes.get_mut(at..at + stride) {
            Some(out) => {
                let _ = c.encode_into(out);
                self.count += 1;
            }
            None => self.dropped = self.dropped.saturating_add(1),
        }
    }

    /// The records written.
    pub fn written(&self) -> &[u8] {
        &self.bytes[..self.count * GraphChange::STRIDE as usize]
    }
}

/// The stride of a `graph` family command, or `None` for another opcode.
pub fn command_stride(opcode: u16) -> Option<usize> {
    Some(match opcode {
        SetParam::OPCODE => SetParam::STRIDE,
        Request::OPCODE => Request::STRIDE,
        Travel::OPCODE => Travel::STRIDE,
        Jump::OPCODE => Jump::STRIDE,
        SlotPlay::OPCODE => SlotPlay::STRIDE,
        SlotNextSection::OPCODE => SlotNextSection::STRIDE,
        SlotStop::OPCODE => SlotStop::STRIDE,
        Link::OPCODE => Link::STRIDE,
        LayerWeight::OPCODE => LayerWeight::STRIDE,
        SetSeed::OPCODE => SetSeed::STRIDE,
        CapturePose::OPCODE => CapturePose::STRIDE,
        Debug::OPCODE => Debug::STRIDE,
        _ => return None,
    } as usize)
}

/// A refusal: the status, the instance, the index the command named and its play id.
pub type Refusal = (u32, u32, u32, u32);

fn graph_instance<'t>(
    arena: &'t Arena,
    table: &'t mut Table,
    h: u32,
) -> Result<(&'t Program, &'t mut Instance), u32> {
    let inst = table.get_mut(h)?;
    if inst.graph == 0 {
        return Err(STATUS_MISMATCH);
    }
    let g = arena.graph(inst.graph)?;
    Ok((&g.program, inst))
}

/// Normalises a parameter's words for its type: `None` when a float isn't finite.
fn clean_words(ty: ParamType, mut w: [u32; 4]) -> Option<[u32; 4]> {
    let floats = match ty {
        ParamType::Float => 1,
        ParamType::Vec2 => 2,
        ParamType::Vec3 => 3,
        ParamType::Quat => 4,
        ParamType::Bool => {
            w = [(w[0] != 0) as u32, 0, 0, 0];
            0
        }
        ParamType::Int | ParamType::Node => {
            w = [w[0], 0, 0, 0];
            0
        }
    };
    for (i, v) in w.iter_mut().enumerate() {
        if i < floats {
            if !f32::from_bits(*v).is_finite() {
                return None;
            }
        } else if floats > 0 {
            *v = 0;
        }
    }
    Some(w)
}

/// Copies every live graph instance's dirty blackboard parameters into its state and clears the
/// masks. Never allocates.
pub fn apply_blackboard(arena: &Arena, table: &mut Table, blackboard: &mut [u32]) {
    let row_words = (BLACKBOARD_STRIDE / 4) as usize;
    for (h, inst) in table.iter_mut() {
        if inst.graph == 0 {
            continue;
        }
        let (index, _) = split(h);
        let Some(row) = blackboard.get_mut(index * row_words..(index + 1) * row_words) else {
            continue;
        };
        let dirty = row[0] as u64 | (row[1] as u64) << 32;
        if dirty == 0 {
            continue;
        }
        row[0] = 0;
        row[1] = 0;
        let Ok(g) = arena.graph(inst.graph) else {
            continue;
        };
        let program = &g.program;
        let n = program.param_count().min(BLACKBOARD_PARAMS as usize);
        for i in 0..n {
            if dirty & (1u64 << i) == 0 {
                continue;
            }
            let at = (BLACKBOARD_VALUES / 4) as usize + 4 * i;
            let w = [row[at], row[at + 1], row[at + 2], row[at + 3]];
            let Some(ty) = program.param_type(i) else {
                continue;
            };
            if let Some(w) = clean_words(ty, w) {
                program.param_state(&mut inst.state, i).copy_from_slice(&w);
            }
        }
    }
}

/// Applies one `graph` family command (`bytes` is exactly its record). Never allocates.
pub fn apply(
    arena: &Arena,
    table: &mut Table,
    inputs: &mut [u32],
    changes: &mut GraphChanges,
    opcode: u16,
    bytes: &[u8],
) -> Result<(), Refusal> {
    let bad = |i: u32| (STATUS_BAD_RECORD, i, 0, 0);
    match opcode {
        SetParam::OPCODE => {
            let c = SetParam::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.param, 0);
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            let i = c.param as usize;
            let ty = program.param_type(i).ok_or(r(STATUS_NO_SUCH))?;
            if ty.id() as u32 != c.param_type {
                return Err(r(STATUS_NO_SUCH));
            }
            let w = clean_words(ty, [c.w0, c.w1, c.w2, c.w3]).ok_or(r(STATUS_BAD_RECORD))?;
            program.param_state(&mut inst.state, i).copy_from_slice(&w);
        }
        Request::OPCODE => {
            let c = Request::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.name, 0);
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            let life = if c.lifetime.is_finite() && c.lifetime > 0.0 {
                c.lifetime
            } else {
                0.25
            };
            let w = program
                .request_state(&mut inst.state, c.name)
                .ok_or(r(STATUS_NO_SUCH))?;
            *w = life.to_bits();
        }
        Travel::OPCODE | Jump::OPCODE => {
            let (instance, machine, state, travel) = if opcode == Travel::OPCODE {
                let c = Travel::decode(bytes).map_err(|_| bad(0))?;
                (c.instance, c.machine, c.state, true)
            } else {
                let c = Jump::decode(bytes).map_err(|_| bad(0))?;
                (c.instance, c.machine, c.state, false)
            };
            let r = |s: u32| (s, instance, machine, 0);
            let (program, inst) = graph_instance(arena, table, instance).map_err(r)?;
            let groups = inst.groups;
            match program.machine(machine as usize) {
                Some((_, count)) if state < count => {}
                _ => return Err(r(STATUS_NO_SUCH)),
            }
            if travel {
                logic::travel(program, &mut inst.state, groups, machine as usize, state)
                    .map_err(|_| r(STATUS_UNREACHABLE))?;
            } else {
                logic::jump(program, &mut inst.state, groups, machine as usize, state)
                    .map_err(|_| r(STATUS_NO_SUCH))?;
            }
        }
        SlotPlay::OPCODE => {
            let c = SlotPlay::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.slot, c.play_id);
            let skeleton = table.get_mut(c.instance).map_err(r)?.skeleton;
            let bones = arena.skeleton(skeleton).map_err(r)?.bones();
            let clip = arena.clip_asset(c.clip).map_err(r)?;
            if bones != 0 && clip.bone_count != 0 && clip.bone_count as usize != bones {
                return Err(r(STATUS_MISMATCH));
            }
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            let groups = inst.groups;
            let list = program.slots();
            let slot = *list.get(c.slot as usize).ok_or(r(STATUS_NO_SUCH))?;
            // A play stops the other slots of its group (Unreal's slot groups).
            if slot.extra != anim_format::NONE {
                for (k, other) in list.iter().enumerate() {
                    if k != c.slot as usize && other.extra == slot.extra {
                        let s = program.node_state(&mut inst.state, groups, other.node);
                        let id = slots::stop(s, 0, c.blend_in);
                        report(changes, c.instance, k as u32, id, REASON_INTERRUPTED);
                    }
                }
            }
            let s = program.node_state(&mut inst.state, groups, slot.node);
            let replaced = slots::play(
                s,
                &slots::SlotPlay {
                    clip: c.clip,
                    play_id: c.play_id,
                    blend_in: c.blend_in,
                    blend_out: c.blend_out,
                    speed: c.speed,
                    start: c.start,
                    end: c.end,
                    flags: c.flags,
                },
            );
            report(changes, c.instance, c.slot, replaced, REASON_INTERRUPTED);
        }
        SlotNextSection::OPCODE => {
            let c = SlotNextSection::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.slot, c.play_id);
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            let groups = inst.groups;
            let slot = *program
                .slots()
                .get(c.slot as usize)
                .ok_or(r(STATUS_NO_SUCH))?;
            let s = program.node_state(&mut inst.state, groups, slot.node);
            if !slots::next_section(s, c.play_id, c.start, c.end, c.flags) {
                return Err(r(STATUS_NO_SUCH));
            }
        }
        SlotStop::OPCODE => {
            let c = SlotStop::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.slot, c.play_id);
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            let groups = inst.groups;
            let slot = *program
                .slots()
                .get(c.slot as usize)
                .ok_or(r(STATUS_NO_SUCH))?;
            let s = program.node_state(&mut inst.state, groups, slot.node);
            let id = slots::stop(s, c.play_id, c.fade);
            report(changes, c.instance, c.slot, id, REASON_STOPPED);
        }
        Link::OPCODE => {
            let c = Link::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.linked, 0);
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            let groups = inst.groups;
            if c.linked as usize >= program.linked().len() {
                return Err(r(STATUS_NO_SUCH));
            }
            if c.graph != 0 {
                let g = arena.graph(c.graph).map_err(r)?;
                if !slots::can_link(program, c.linked as usize, &g.program, groups) {
                    return Err(r(STATUS_TOO_LARGE));
                }
            }
            slots::link(program, &mut inst.state, groups, c.linked as usize, c.graph);
        }
        LayerWeight::OPCODE => {
            let c = LayerWeight::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.layer, 0);
            table.get_mut(c.instance).map_err(r)?;
            if c.layer >= MAX_LAYERS {
                return Err(r(STATUS_NO_SUCH));
            }
            if !c.weight.is_finite() {
                return Err(r(STATUS_BAD_RECORD));
            }
            let (index, _) = split(c.instance);
            let at = index * (INPUT_STRIDE / 4) as usize
                + (INPUT_LAYER_WEIGHTS / 4) as usize
                + c.layer as usize;
            if let Some(w) = inputs.get_mut(at) {
                *w = c.weight.clamp(0.0, 1.0).to_bits();
            }
        }
        SetSeed::OPCODE => {
            let c = SetSeed::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, 0, 0);
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            *program.rng_state(&mut inst.state) = if c.seed == 0 { DEFAULT_SEED } else { c.seed };
        }
        CapturePose::OPCODE => {
            let c = CapturePose::decode(bytes).map_err(|_| bad(0))?;
            let r = |s: u32| (s, c.instance, c.node, 0);
            let (program, inst) = graph_instance(arena, table, c.instance).map_err(r)?;
            if program.node_kind(c.node) != Some((Family::Sources, sources::kind::POSE_SNAPSHOT)) {
                return Err(r(STATUS_NO_SUCH));
            }
            if inst.history == 0 {
                return Err(r(STATUS_MISMATCH));
            }
            let groups = inst.groups;
            let (state, last) = (&mut inst.state, &inst.last);
            sources::capture(program.node_state(state, groups, c.node), last);
        }
        Debug::OPCODE => {
            let c = Debug::decode(bytes).map_err(|_| bad(0))?;
            let inst = table
                .get_mut(c.instance)
                .map_err(|s| (s, c.instance, 0, 0))?;
            inst.debug = c.flags & DEBUG_ON != 0;
        }
        _ => return Err(bad(0)),
    }
    Ok(())
}

fn report(changes: &mut GraphChanges, instance: u32, slot: u32, id: u32, reason: u32) {
    if id != 0 {
        changes.push(GraphChange {
            instance,
            kind: GRAPH_SLOT_INTERRUPTED,
            index: slot,
            value: id,
            reason,
        });
    }
}
