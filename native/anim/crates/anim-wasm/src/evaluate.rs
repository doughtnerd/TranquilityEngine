//! Feature `evaluate`: the per-frame calls: `write_inputs` (commands into the instances' graph
//! state; the input view is read in place), `evaluate(world, pass, dt_scaled, dt_unscaled)` over
//! every due instance, and the output views (3×4 bone matrices, root-motion deltas, state-change
//! records). The layouts are `anim-wire` core's (`INPUT_*`, `ROOT_STRIDE`, `MATRIX_FLOATS`,
//! [`StateChange`]). Never allocates.
//!
//! T31 additions: `write_inputs` applies the blackboard view's dirty parameters, then routes the
//! `graph` family's commands to [`crate::graph`] (refusals are `CHANGE_REFUSED` records like the
//! core's); graph state events (states entered and exited, slot plays, requests) go to the graph
//! state-change buffer; the frame also owns the blackboard rows and the debug buffer.
//!
//! T40 additions (hooks, each one line or a few): the frame owns the `rig` family's views
//! ([`crate::rig::RigViews`]); `write_inputs` routes `rig` commands to [`crate::rig::apply`];
//! `evaluate` gives each instance its rig rows (`Inputs::rig`) and clears its ray row before a
//! pose evaluation.
//!
//! # Per instance, per frame
//!
//! 1. `dt` = `dt_scaled` (or `dt_unscaled` with `FLAG_UNSCALED`) × the row's time scale.
//! 2. **Update** every node: playheads advance and fades run even when the pose is culled or
//!    skipped by LOD, so events and root motion stay exact and a layer fading back in is in step.
//! 3. **Root motion**, unless culled `whenVisible`: written to the root view every frame.
//! 4. Culled (`whenVisible` or `rootMotionOnly` while not visible): the pose freezes (bone matrices
//!    keep their last values) and the next visible frame starts the history afresh.
//! 5. **Pose** when due: on the first frame, after culling, and then every `lodStep` frames. The
//!    two last poses are kept; between evaluations the shown pose is
//!    `lerp(prev, last, (frames since + 1) / lodStep)` (one LOD step of latency, as Unreal's
//!    update-rate optimisation), so with step 1 it is the pose just evaluated.
//! 6. **Matrices:** local to model space, times the skeleton's inverse bind matrices, into the
//!    instance's row of the matrix view.

use anim_graph::eval::{
    Events, History, Inputs, Program, Scratch, SkeletonPose, StateEvent, StateEventKind,
    TrackOutput,
};
use anim_math::layout::soa_len;
use anim_math::{AosTransform, SoaTransform};
use anim_pose::inertialize::Inertializer;
use anim_sample::Window;
use anim_wire::core::{
    Init, Play, SetLayer, StateChange, Stop, CHANGE_FINISHED, CHANGE_INTERRUPTED, CHANGE_REFUSED,
    COMMAND_BYTES, CULL_ALWAYS, CULL_MASK, CULL_ROOT_MOTION_ONLY, FLAG_BAKE_ROOT, FLAG_FIXED,
    FLAG_UNSCALED, FLAG_VISIBLE, INPUT_FLAGS, INPUT_LAYER_WEIGHTS, INPUT_LOD_STEP, INPUT_STRIDE,
    INPUT_TIME_SCALE, MATRIX_FLOATS, MAX_LAYERS, PASS_FIXED, ROOT_STRIDE, STATUS_BAD_RECORD,
    STATUS_MISMATCH, TRACK_COLUMNS, TRACK_COLUMN_CLIP, TRACK_COLUMN_WORDS, TRACK_HEADER,
    TRACK_RECORDS, TRACK_STRIDE,
};
use anim_wire::WireRecord;

use crate::assets::{split, Arena};
use crate::graph::GraphChanges;
use crate::instances::{implicit, Instance, Table};
use crate::tracks::{self, RecordWriter};

/// State-change records the buffer holds per instance (beyond a fixed reserve).
pub const CHANGES_PER_INSTANCE: usize = 2 * MAX_LAYERS as usize;
/// State-change records the buffer always has room for.
pub const CHANGES_RESERVE: usize = 256;

const INPUT_WORDS: usize = (INPUT_STRIDE / 4) as usize;
const ROOT_FLOATS: usize = (ROOT_STRIDE / 4) as usize;
const TRACK_WORDS: usize = (TRACK_STRIDE / 4) as usize;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the views (input and root rows, bone matrices), the command and state-change buffers, and the
/// evaluation scratch for the implicit graph at `max_bones`.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    let n = init.max_instances as u64;
    let bones = init.max_bones as u64;
    let groups = soa_len(init.max_bones as usize) as u64;
    let soa = core::mem::size_of::<SoaTransform>() as u64;
    let aos = core::mem::size_of::<AosTransform>() as u64;
    let views = n.saturating_mul(
        INPUT_STRIDE as u64 + ROOT_STRIDE as u64 + bones * 4 * MATRIX_FLOATS as u64,
    );
    let changes =
        (n * CHANGES_PER_INSTANCE as u64 + CHANGES_RESERVE as u64) * StateChange::STRIDE as u64;
    let slots = implicit::program().pose_slots() as u64;
    // Pose stack, display pose, sampling scratch (2 per bone), model space, inertializer state.
    let scratch = (slots + 1) * groups * soa + 3 * bones * aos + bones * 64;
    views
        .saturating_add(changes)
        .saturating_add(COMMAND_BYTES as u64)
        .saturating_add(scratch)
}

/// The views and scratch, sized at `init` (scratch grows in load calls only).
#[derive(Default)]
pub struct Frame {
    pub max_bones: usize,
    pub inputs: Vec<u32>,
    pub matrices: Vec<f32>,
    pub roots: Vec<f32>,
    pub tracks: Vec<u32>,
    pub commands: Vec<u8>,
    pub changes: Vec<u8>,
    pub change_count: usize,
    pub changes_dropped: u32,
    /// The blackboard view (`graph` family, `BLACKBOARD_STRIDE` bytes per instance index).
    pub blackboard: Vec<u32>,
    /// The graph state-change records.
    pub graph_changes: GraphChanges,
    /// The debug buffer (`debug` family).
    pub debug: Vec<u8>,
    /// The rig input and ray output views (`rig` family, T40).
    pub rig: crate::rig::RigViews,
    poses: Vec<SoaTransform>,
    display: Vec<SoaTransform>,
    sample: Vec<AosTransform>,
    model: Vec<AosTransform>,
    inertializers: Vec<Inertializer>,
}

impl Frame {
    /// Views for `max_instances` rows of `max_bones` bones.
    pub fn new(max_instances: usize, max_bones: usize, slots: usize) -> Frame {
        let groups = soa_len(max_bones);
        Frame {
            max_bones,
            inputs: vec![0; max_instances * INPUT_WORDS],
            matrices: vec![0.0; max_instances * max_bones * MATRIX_FLOATS as usize],
            roots: vec![0.0; max_instances * ROOT_FLOATS],
            tracks: vec![0; max_instances * TRACK_WORDS],
            commands: vec![0; COMMAND_BYTES as usize],
            changes: vec![
                0;
                (max_instances * CHANGES_PER_INSTANCE + CHANGES_RESERVE)
                    * StateChange::STRIDE as usize
            ],
            change_count: 0,
            changes_dropped: 0,
            blackboard: vec![0; max_instances * (anim_wire::graph::BLACKBOARD_STRIDE / 4) as usize],
            graph_changes: GraphChanges::new(max_instances),
            debug: vec![0; anim_wire::debug::DEBUG_BYTES as usize],
            rig: crate::rig::RigViews::new(max_instances),
            poses: vec![SoaTransform::identity(); slots * groups],
            display: vec![SoaTransform::identity(); groups],
            sample: vec![AosTransform::identity(); 2 * max_bones],
            model: vec![AosTransform::identity(); max_bones],
            inertializers: Vec::new(),
        }
    }

    /// Makes room for a program needing `slots` pose slots (load calls only).
    pub fn reserve_slots(&mut self, slots: usize) {
        let need = slots * soa_len(self.max_bones);
        if self.poses.len() < need {
            self.poses.resize(need, SoaTransform::identity());
        }
    }

    /// Makes sure an inertializer for `bones` bones exists (load calls only).
    pub fn reserve_inertializer(&mut self, bones: usize) {
        if !self.inertializers.iter().any(|i| i.bone_count() == bones) {
            self.inertializers.push(Inertializer::new(bones));
        }
    }

    /// Fills instance row `index` of the input view with defaults: time scale 1, LOD step 1,
    /// visible, layer weights from `layers` (1 where it has none).
    pub fn default_inputs(&mut self, index: usize, layers: &[f32]) {
        let row = &mut self.inputs[index * INPUT_WORDS..(index + 1) * INPUT_WORDS];
        row.fill(0);
        row[(INPUT_TIME_SCALE / 4) as usize] = 1.0f32.to_bits();
        row[(INPUT_LOD_STEP / 4) as usize] = 1;
        row[(INPUT_FLAGS / 4) as usize] = FLAG_VISIBLE;
        for l in 0..MAX_LAYERS as usize {
            row[(INPUT_LAYER_WEIGHTS / 4) as usize + l] =
                layers.get(l).copied().unwrap_or(1.0).to_bits();
        }
        let roots = &mut self.roots[index * ROOT_FLOATS..(index + 1) * ROOT_FLOATS];
        roots.fill(0.0);
        roots[6] = 1.0;
        self.tracks[index * TRACK_WORDS..(index + 1) * TRACK_WORDS].fill(0);
        let bb = (anim_wire::graph::BLACKBOARD_STRIDE / 4) as usize;
        if let Some(row) = self.blackboard.get_mut(index * bb..(index + 1) * bb) {
            row.fill(0);
        }
        self.rig.default_row(index);
    }

    fn push_change(&mut self, change: StateChange) {
        let stride = StateChange::STRIDE as usize;
        let at = self.change_count * stride;
        match self.changes.get_mut(at..at + stride) {
            Some(out) => {
                let _ = change.encode_into(out);
                self.change_count += 1;
            }
            None => self.changes_dropped = self.changes_dropped.saturating_add(1),
        }
    }
}

/// Writes a play's events into the change buffer.
struct Sink<'f> {
    changes: &'f mut [u8],
    count: &'f mut usize,
    dropped: &'f mut u32,
    graph: &'f mut GraphChanges,
    instance: u32,
}

impl Events for Sink<'_> {
    fn push(&mut self, e: StateEvent) {
        use anim_wire::graph::*;
        let graph = |kind: u32, reason: u32| GraphChange {
            instance: self.instance,
            kind,
            index: e.layer,
            value: e.play_id,
            reason,
        };
        let kind = match e.kind {
            StateEventKind::Finished => CHANGE_FINISHED,
            StateEventKind::Interrupted => CHANGE_INTERRUPTED,
            other => {
                let c = match other {
                    StateEventKind::StateEntered => graph(GRAPH_STATE_ENTERED, 0),
                    StateEventKind::StateExited => graph(GRAPH_STATE_EXITED, 0),
                    StateEventKind::SlotFinished => graph(GRAPH_SLOT_FINISHED, REASON_FINISHED),
                    StateEventKind::SlotInterrupted => {
                        graph(GRAPH_SLOT_INTERRUPTED, REASON_INTERRUPTED)
                    }
                    StateEventKind::SlotStopped => graph(GRAPH_SLOT_INTERRUPTED, REASON_STOPPED),
                    StateEventKind::RequestConsumed => graph(GRAPH_REQUEST_CONSUMED, 0),
                    _ => graph(GRAPH_REQUEST_EXPIRED, 0),
                };
                self.graph.push(c);
                return;
            }
        };
        let stride = StateChange::STRIDE as usize;
        let at = *self.count * stride;
        match self.changes.get_mut(at..at + stride) {
            Some(out) => {
                let _ = StateChange {
                    instance: self.instance,
                    layer: e.layer,
                    kind,
                    play_id: e.play_id,
                    status: 0,
                }
                .encode_into(out);
                *self.count += 1;
            }
            None => *self.dropped = self.dropped.saturating_add(1),
        }
    }
}

/// Feeds clip players' windows to `tracks`' sampling: records into the instance's record region,
/// columns of the highest-weight clip into its column block.
struct TrackOut<'a, 'b> {
    arena: &'a Arena,
    writer: RecordWriter<'b>,
    columns: &'b mut [u32],
    best: f32,
    column_clip: u32,
    column_words: u32,
}

impl TrackOutput for TrackOut<'_, '_> {
    fn window(&mut self, clip: u32, window: &Window, weight: f32, open: &mut [u32]) {
        let Ok(c) = self.arena.clip_asset(clip) else {
            return;
        };
        let Some(bound) = c.bound() else {
            return;
        };
        let n = c.bindings.column_words();
        let columns: &mut [u32] = if weight > self.best && n <= self.columns.len() {
            self.best = weight;
            self.column_clip = clip;
            self.column_words = n as u32;
            &mut self.columns[..n]
        } else {
            &mut []
        };
        tracks::evaluate_clip(
            &bound,
            clip,
            window,
            weight,
            open,
            columns,
            &mut self.writer,
        );
    }

    fn end(&mut self, clip: u32, time: f32, open: &mut [u32]) {
        if let Ok(c) = self.arena.clip_asset(clip) {
            tracks::end_clip(&c.bindings, clip, time, 0.0, open, &mut self.writer);
        }
    }
}

/// `words` as bytes (wasm and every target the core builds for are little-endian, the layout's
/// byte order).
fn as_bytes(words: &mut [u32]) -> &mut [u8] {
    // SAFETY: u8 has no alignment requirement and every bit pattern is valid for both types; the
    // slice covers exactly the words' memory and borrows it for its lifetime.
    unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr().cast::<u8>(), words.len() * 4) }
}

/// Applies the first `len` bytes of the command buffer. Returns the commands applied; refused ones
/// are reported as `CHANGE_REFUSED` records. Clears the change buffer first. An unknown opcode, or
/// a record cut off by `len`, ends the batch.
pub fn write_inputs(
    arena: &Arena,
    table: &mut Table,
    frame: &mut Frame,
    implicit: &Program,
    len: usize,
) -> u32 {
    frame.change_count = 0;
    frame.changes_dropped = 0;
    frame.graph_changes.clear();
    crate::graph::apply_blackboard(arena, table, &mut frame.blackboard);
    let len = len.min(frame.commands.len());
    let mut at = 0usize;
    let mut applied = 0u32;
    while at + 4 <= len {
        let opcode = u16::from_le_bytes([frame.commands[at], frame.commands[at + 1]]);
        let stride = match opcode {
            Play::OPCODE => Play::STRIDE as usize,
            Stop::OPCODE => Stop::STRIDE as usize,
            SetLayer::OPCODE => SetLayer::STRIDE as usize,
            op => match crate::graph::command_stride(op).or(crate::rig::command_stride(op)) {
                Some(s) => s,
                None => break,
            },
        };
        if at + stride > len {
            break;
        }
        if crate::rig::command_stride(opcode).is_some() {
            // A rig command (T40): writes the instance's state words.
            if let Err((status, instance, layer, play_id)) =
                crate::rig::apply(arena, table, opcode, &frame.commands[at..at + stride])
            {
                frame.push_change(StateChange {
                    instance,
                    layer,
                    kind: CHANGE_REFUSED,
                    play_id,
                    status,
                });
            } else {
                applied += 1;
            }
            at += stride;
            continue;
        }
        if crate::graph::command_stride(opcode).is_some() {
            // A graph command: copied out of the buffer (at most 64 bytes) so the frame can be
            // written while it applies.
            let mut record = [0u8; 64];
            let n = stride.min(record.len());
            record[..n].copy_from_slice(&frame.commands[at..at + n]);
            match crate::graph::apply(
                arena,
                table,
                &mut frame.inputs,
                &mut frame.graph_changes,
                opcode,
                &record[..n],
            ) {
                Ok(()) => applied += 1,
                Err((status, instance, layer, play_id)) => frame.push_change(StateChange {
                    instance,
                    layer,
                    kind: CHANGE_REFUSED,
                    play_id,
                    status,
                }),
            }
            at += stride;
            continue;
        }
        let bytes = &frame.commands[at..at + stride];
        let result = match opcode {
            Play::OPCODE => match Play::decode(bytes) {
                Ok(c) => {
                    let r = play(arena, table, implicit, &c);
                    (r, c.instance, c.layer, c.play_id)
                }
                Err(_) => (Err(STATUS_BAD_RECORD), 0, 0, 0),
            },
            Stop::OPCODE => match Stop::decode(bytes) {
                Ok(c) => (stop(table, implicit, &c), c.instance, c.layer, 0),
                Err(_) => (Err(STATUS_BAD_RECORD), 0, 0, 0),
            },
            _ => match SetLayer::decode(bytes) {
                Ok(c) => (
                    set_layer(arena, table, implicit, &c),
                    c.instance,
                    c.layer,
                    0,
                ),
                Err(_) => (Err(STATUS_BAD_RECORD), 0, 0, 0),
            },
        };
        match result {
            (Ok(interrupted), instance, layer, _) => {
                applied += 1;
                for id in interrupted.into_iter().filter(|id| *id != 0) {
                    frame.push_change(StateChange {
                        instance,
                        layer,
                        kind: CHANGE_INTERRUPTED,
                        play_id: id,
                        status: 0,
                    });
                }
            }
            (Err(status), instance, layer, play_id) => frame.push_change(StateChange {
                instance,
                layer,
                kind: CHANGE_REFUSED,
                play_id,
                status,
            }),
        }
        at += stride;
    }
    applied
}

fn implicit_instance(table: &mut Table, h: u32, layer: u32) -> Result<&mut Instance, u32> {
    let inst = table.get_mut(h)?;
    if inst.graph != 0 {
        return Err(STATUS_MISMATCH);
    }
    if layer >= MAX_LAYERS {
        return Err(STATUS_BAD_RECORD);
    }
    Ok(inst)
}

fn play(
    arena: &Arena,
    table: &mut Table,
    implicit_program: &Program,
    c: &Play,
) -> Result<[u32; 2], u32> {
    let skeleton = table.get_mut(c.instance)?.skeleton;
    let bones = arena.skeleton(skeleton)?.bones();
    let clip = arena.clip_asset(c.clip)?;
    if clip.bone_count != 0 && clip.bone_count as usize != bones {
        return Err(STATUS_MISMATCH);
    }
    let inst = implicit_instance(table, c.instance, c.layer)?;
    let groups = inst.groups;
    Ok(implicit::play(
        implicit_program,
        &mut inst.state,
        groups,
        c.layer,
        c.clip,
        c.play_id,
        c.fade,
        c.speed,
        c.start,
        c.flags,
    ))
}

fn stop(table: &mut Table, implicit_program: &Program, c: &Stop) -> Result<[u32; 2], u32> {
    let inst = implicit_instance(table, c.instance, c.layer)?;
    let groups = inst.groups;
    Ok(implicit::stop(
        implicit_program,
        &mut inst.state,
        groups,
        c.layer,
        c.fade,
        c.flags,
    ))
}

fn set_layer(
    arena: &Arena,
    table: &mut Table,
    implicit_program: &Program,
    c: &SetLayer,
) -> Result<[u32; 2], u32> {
    if c.layer == 0 {
        return Err(STATUS_BAD_RECORD);
    }
    let skeleton = table.get_mut(c.instance)?.skeleton;
    if c.mask != 0 {
        let bones = arena.skeleton(skeleton)?.bones();
        if arena.mask_asset(c.mask)?.bones != bones {
            return Err(STATUS_MISMATCH);
        }
    }
    let inst = implicit_instance(table, c.instance, c.layer)?;
    let groups = inst.groups;
    implicit::set_layer(
        implicit_program,
        &mut inst.state,
        groups,
        c.layer,
        c.mask,
        c.mode,
    );
    Ok([0, 0])
}

/// Evaluates every instance of `world` in `pass`. Returns the state-change records waiting
/// (including those `write_inputs` left). Never allocates.
#[allow(clippy::too_many_arguments)]
pub fn evaluate(
    arena: &Arena,
    table: &mut Table,
    frame: &mut Frame,
    implicit_program: &Program,
    world: u32,
    pass: u32,
    dt_scaled: f32,
    dt_unscaled: f32,
) -> u32 {
    let max_bones = frame.max_bones;
    let rig_inputs = &frame.rig.inputs[..];
    let rig_rays = core::cell::Cell::from_mut(&mut frame.rig.rays[..]).as_slice_of_cells();
    for (h, inst) in table.iter_mut() {
        if inst.world != world {
            continue;
        }
        let (index, _) = split(h);
        let row = &frame.inputs[index * INPUT_WORDS..(index + 1) * INPUT_WORDS];
        let flags = row[(INPUT_FLAGS / 4) as usize];
        if (flags & FLAG_FIXED != 0) != (pass == PASS_FIXED) {
            continue;
        }
        let Ok(skel) = arena.skeleton(inst.skeleton) else {
            continue;
        };
        let (program, bindings) = if inst.graph == 0 {
            (implicit_program, &[][..])
        } else {
            match arena.graph(inst.graph) {
                Ok(g) => (&g.program, g.bindings.as_slice()),
                Err(_) => continue,
            }
        };
        let scale = f32::from_bits(row[(INPUT_TIME_SCALE / 4) as usize]);
        let base = if flags & FLAG_UNSCALED != 0 {
            dt_unscaled
        } else {
            dt_scaled
        };
        let mut dt = base * scale;
        if !dt.is_finite() {
            dt = 0.0;
        }
        let step = row[(INPUT_LOD_STEP / 4) as usize].max(1);
        let mut weights = [0.0f32; MAX_LAYERS as usize];
        for (l, w) in weights.iter_mut().enumerate() {
            *w = f32::from_bits(row[(INPUT_LAYER_WEIGHTS / 4) as usize + l]);
        }
        let visible = flags & FLAG_VISIBLE != 0;
        let cull = flags & CULL_MASK;
        let frozen = !visible && cull != CULL_ALWAYS;

        let skeleton = SkeletonPose {
            parents: &skel.parents,
            rest: &skel.rest,
            rest_soa: &skel.rest_soa,
            identity: &skel.identity,
            bind_soa: &skel.bind_soa,
        };
        let history = (inst.history >= 2).then_some(History {
            last: &inst.last,
            prev: &inst.prev,
            dt: inst.history_dt,
        });
        let inputs = Inputs {
            assets: arena,
            skeleton,
            bindings,
            layer_weights: &weights,
            history,
            bake_root: flags & FLAG_BAKE_ROOT != 0,
            rig: crate::rig::row_inputs(rig_inputs, rig_rays, index, skel),
        };
        let mut sink = Sink {
            changes: &mut frame.changes,
            count: &mut frame.change_count,
            dropped: &mut frame.changes_dropped,
            graph: &mut frame.graph_changes,
            instance: h,
        };
        program.update(&inputs, &mut inst.state, dt, &mut sink);
        inst.dt_since += dt;

        // Track outputs every frame, culled or not (events and notify states stay exact).
        let region = &mut frame.tracks[index * TRACK_WORDS..(index + 1) * TRACK_WORDS];
        let (head, rest) = region.split_at_mut((TRACK_COLUMNS / 4) as usize);
        let (columns, records) = rest.split_at_mut(((TRACK_RECORDS - TRACK_COLUMNS) / 4) as usize);
        debug_assert_eq!(columns.len(), TRACK_COLUMN_WORDS as usize);
        let mut out = TrackOut {
            arena,
            writer: RecordWriter::new(as_bytes(records), h),
            columns,
            best: 0.0,
            column_clip: 0,
            column_words: 0,
        };
        program.tracks(&inputs, &mut inst.state, &mut out);
        let header = out.writer.header(out.column_words);
        let column_clip = out.column_clip;
        let _ = header.encode_into(&mut as_bytes(head)[TRACK_HEADER as usize..]);
        head[(TRACK_COLUMN_CLIP / 4) as usize] = column_clip;

        let root = &mut frame.roots[index * ROOT_FLOATS..(index + 1) * ROOT_FLOATS];
        if !frozen || cull == CULL_ROOT_MOTION_ONLY {
            let d = program.root(&inputs, &mut inst.state);
            root[..7].copy_from_slice(&[
                d.translation.x,
                d.translation.y,
                d.translation.z,
                d.rotation.x,
                d.rotation.y,
                d.rotation.z,
                d.rotation.w,
            ]);
        } else {
            root[..7].copy_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        }
        if frozen {
            inst.stale = true;
            continue;
        }

        let groups = inst.groups;
        inst.since = inst.since.saturating_add(1);
        let due = inst.history == 0 || inst.stale || inst.since >= step;
        if due {
            let Some(inertializer) = frame
                .inertializers
                .iter_mut()
                .find(|i| i.bone_count() == skel.bones())
            else {
                continue;
            };
            // T41: slots of the largest skeleton (`reserve_slots` sizes the stack so), so a
            // retarget node's source graph on another skeleton has room after the outer slots.
            let slots = program.pose_slots() * soa_len(max_bones);
            if frame.poses.len() < slots {
                continue;
            }
            let scratch = Scratch {
                poses: &mut frame.poses[..slots],
                sample: &mut frame.sample,
                inertializer,
            };
            let display = &mut frame.display[..groups];
            crate::rig::clear_rays(rig_rays, index);
            program.pose(&inputs, &mut inst.state, scratch, display);
            if inst.history == 0 || inst.stale {
                inst.prev.copy_from_slice(display);
                inst.last.copy_from_slice(display);
                inst.history = 1;
                inst.history_dt = 0.0;
            } else {
                core::mem::swap(&mut inst.prev, &mut inst.last);
                inst.last.copy_from_slice(display);
                inst.history = 2;
                inst.history_dt = inst.dt_since;
            }
            inst.dt_since = 0.0;
            inst.since = 0;
            inst.stale = false;
        }
        let display = &mut frame.display[..groups];
        if step <= 1 || inst.history < 2 {
            display.copy_from_slice(&inst.last);
        } else {
            let t = (inst.since + 1) as f32 / step as f32;
            anim_pose::blend::lerp(&inst.prev, &inst.last, t, display);
        }
        let bones = skel.bones();
        let model = &mut frame.model[..bones];
        anim_pose::model::model_space(&skel.parents, display, model);
        let at = index * max_bones * MATRIX_FLOATS as usize;
        let out = &mut frame.matrices[at..at + bones * MATRIX_FLOATS as usize];
        anim_pose::model::skinning_from_model(model, &skel.inverse_bind, out);
    }
    frame.change_count as u32
}
