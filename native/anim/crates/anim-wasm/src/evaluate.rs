//! Feature `evaluate`: the per-frame calls: `write_inputs` (commands into the instances' graph
//! state; the input view is read in place), `evaluate(world, pass, dt_scaled, dt_unscaled)` over
//! every due instance, and the output views (3×4 bone matrices, root-motion deltas, state-change
//! records). The layouts are `anim-wire` core's (`INPUT_*`, `ROOT_STRIDE`, `MATRIX_FLOATS`,
//! [`StateChange`]). Never allocates.
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
};
use anim_math::layout::soa_len;
use anim_math::{AosTransform, SoaTransform};
use anim_pose::inertialize::Inertializer;
use anim_wire::core::{
    Init, Play, SetLayer, StateChange, Stop, CHANGE_FINISHED, CHANGE_INTERRUPTED, CHANGE_REFUSED,
    COMMAND_BYTES, CULL_ALWAYS, CULL_MASK, CULL_ROOT_MOTION_ONLY, FLAG_BAKE_ROOT, FLAG_FIXED,
    FLAG_UNSCALED, FLAG_VISIBLE, INPUT_FLAGS, INPUT_LAYER_WEIGHTS, INPUT_LOD_STEP, INPUT_STRIDE,
    INPUT_TIME_SCALE, MATRIX_FLOATS, MAX_LAYERS, PASS_FIXED, ROOT_STRIDE, STATUS_BAD_RECORD,
    STATUS_MISMATCH,
};
use anim_wire::WireRecord;

use crate::assets::{split, Arena};
use crate::instances::{implicit, Instance, Table};

/// State-change records the buffer holds per instance (beyond a fixed reserve).
pub const CHANGES_PER_INSTANCE: usize = 2 * MAX_LAYERS as usize;
/// State-change records the buffer always has room for.
pub const CHANGES_RESERVE: usize = 256;

const INPUT_WORDS: usize = (INPUT_STRIDE / 4) as usize;
const ROOT_FLOATS: usize = (ROOT_STRIDE / 4) as usize;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the views (input and root rows, bone matrices), the command and state-change buffers, and the
/// evaluation scratch for the implicit graph at `max_bones`.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    let n = init.max_instances as u64;
    let bones = init.max_bones as u64;
    let groups = soa_len(init.max_bones as usize) as u64;
    let soa = core::mem::size_of::<SoaTransform>() as u64;
    let aos = core::mem::size_of::<AosTransform>() as u64;
    let views = n.saturating_mul(INPUT_STRIDE as u64 + ROOT_STRIDE as u64 + bones * 4 * MATRIX_FLOATS as u64);
    let changes = (n * CHANGES_PER_INSTANCE as u64 + CHANGES_RESERVE as u64) * StateChange::STRIDE as u64;
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
    pub commands: Vec<u8>,
    pub changes: Vec<u8>,
    pub change_count: usize,
    pub changes_dropped: u32,
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
            commands: vec![0; COMMAND_BYTES as usize],
            changes: vec![
                0;
                (max_instances * CHANGES_PER_INSTANCE + CHANGES_RESERVE)
                    * StateChange::STRIDE as usize
            ],
            change_count: 0,
            changes_dropped: 0,
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
            row[(INPUT_LAYER_WEIGHTS / 4) as usize + l] = layers.get(l).copied().unwrap_or(1.0).to_bits();
        }
        let roots = &mut self.roots[index * ROOT_FLOATS..(index + 1) * ROOT_FLOATS];
        roots.fill(0.0);
        roots[6] = 1.0;
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
    instance: u32,
}

impl Events for Sink<'_> {
    fn push(&mut self, e: StateEvent) {
        let kind = match e.kind {
            StateEventKind::Finished => CHANGE_FINISHED,
            StateEventKind::Interrupted => CHANGE_INTERRUPTED,
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

/// Applies the first `len` bytes of the command buffer. Returns the commands applied; refused ones
/// are reported as `CHANGE_REFUSED` records. Clears the change buffer first. An unknown opcode, or
/// a record cut off by `len`, ends the batch.
pub fn write_inputs(arena: &Arena, table: &mut Table, frame: &mut Frame, implicit: &Program, len: usize) -> u32 {
    frame.change_count = 0;
    frame.changes_dropped = 0;
    let len = len.min(frame.commands.len());
    let mut at = 0usize;
    let mut applied = 0u32;
    while at + 4 <= len {
        let opcode = u16::from_le_bytes([frame.commands[at], frame.commands[at + 1]]);
        let stride = match opcode {
            Play::OPCODE => Play::STRIDE,
            Stop::OPCODE => Stop::STRIDE,
            SetLayer::OPCODE => SetLayer::STRIDE,
            _ => break,
        } as usize;
        if at + stride > len {
            break;
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
                Ok(c) => (set_layer(arena, table, implicit, &c), c.instance, c.layer, 0),
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

fn implicit_instance<'t>(table: &'t mut Table, h: u32, layer: u32) -> Result<&'t mut Instance, u32> {
    let inst = table.get_mut(h)?;
    if inst.graph != 0 {
        return Err(STATUS_MISMATCH);
    }
    if layer >= MAX_LAYERS {
        return Err(STATUS_BAD_RECORD);
    }
    Ok(inst)
}

fn play(arena: &Arena, table: &mut Table, implicit_program: &Program, c: &Play) -> Result<[u32; 2], u32> {
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
    Ok(implicit::stop(implicit_program, &mut inst.state, groups, c.layer, c.fade, c.flags))
}

fn set_layer(arena: &Arena, table: &mut Table, implicit_program: &Program, c: &SetLayer) -> Result<[u32; 2], u32> {
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
    implicit::set_layer(implicit_program, &mut inst.state, groups, c.layer, c.mask, c.mode);
    Ok([0, 0])
}

/// Evaluates every instance of `world` in `pass`. Returns the state-change records waiting
/// (including those `write_inputs` left). Never allocates.
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
        let base = if flags & FLAG_UNSCALED != 0 { dt_unscaled } else { dt_scaled };
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
        };
        let mut sink = Sink {
            changes: &mut frame.changes,
            count: &mut frame.change_count,
            dropped: &mut frame.changes_dropped,
            instance: h,
        };
        program.update(&inputs, &mut inst.state, dt, &mut sink);
        inst.dt_since += dt;

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
            let slots = program.pose_slots() * groups;
            if frame.poses.len() < slots {
                continue;
            }
            let scratch = Scratch {
                poses: &mut frame.poses[..slots],
                sample: &mut frame.sample,
                inertializer,
            };
            let display = &mut frame.display[..groups];
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
