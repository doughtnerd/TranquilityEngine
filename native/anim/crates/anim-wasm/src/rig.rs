//! Feature `rig`: the rig stack's inputs and outputs (wire family `rig`, whose module documents
//! the layouts): the rig input view (character transform, rig LOD, IK target slots, last frame's
//! ray hits), the ray output view (grounder ray requests), and the `WARP_TARGET` and `RIG_RESET`
//! commands. The rig nodes themselves are `anim-graph`'s `rig` family.
//!
//! `evaluate` (feature `evaluate`) hands each instance its rows as `anim_graph::rig::RigInputs`
//! ([`RigViews::inputs`]) with the skeleton's joint limits and roles, and clears its ray row before
//! a pose evaluation ([`RigViews::clear_rays`]). Commands only write words of the instance's state
//! blob (a motion-warp target, a reset flag), so they never allocate and snapshots taken between
//! frames stay exact.

use core::cell::Cell;

use anim_graph::dispatch::Family;
use anim_graph::eval::Program;
use anim_graph::rig::{self as rig_nodes, kind, view, RigInputs};
use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_wire::core::{Init, STATUS_BAD_RECORD, STATUS_MISMATCH};
use anim_wire::graph::STATUS_NO_SUCH;
use anim_wire::rig::{
    RigReset, WarpTarget, HIT_FLAGS, HIT_NORMAL, HIT_POINT, HIT_STRIDE, NODE_ALL, RAY_DIRECTION,
    RAY_FLAGS, RAY_LENGTH, RAY_ORIGIN, RAY_ROW_STRIDE, RAY_STRIDE, RIG_CHARACTER_POSITION,
    RIG_CHARACTER_ROTATION, RIG_CHARACTER_SCALE, RIG_HITS, RIG_INPUT_STRIDE, RIG_LOD,
    RIG_MAX_RAYS, RIG_MAX_TARGETS, RIG_TARGETS, TARGET_FLAGS, TARGET_POSITION,
    TARGET_POSITION_WEIGHT, TARGET_ROTATION, TARGET_ROTATION_WEIGHT, TARGET_STRIDE, WARP_CLEAR,
};
use anim_wire::WireRecord;

use crate::assets::{Arena, SkeletonAsset};
use crate::instances::Table;

const INPUT_WORDS: usize = (RIG_INPUT_STRIDE / 4) as usize;
const RAY_ROW_WORDS: usize = (RAY_ROW_STRIDE / 4) as usize;

// The wire layout in bytes is the node family's layout in words.
const _: () = {
    assert!(RIG_MAX_TARGETS as usize == view::MAX_TARGETS);
    assert!(TARGET_STRIDE as usize == 4 * view::TARGET_WORDS);
    assert!(TARGET_POSITION as usize == 4 * view::TARGET_POSITION);
    assert!(TARGET_ROTATION as usize == 4 * view::TARGET_ROTATION);
    assert!(TARGET_POSITION_WEIGHT as usize == 4 * view::TARGET_POSITION_WEIGHT);
    assert!(TARGET_ROTATION_WEIGHT as usize == 4 * view::TARGET_ROTATION_WEIGHT);
    assert!(TARGET_FLAGS as usize == 4 * view::TARGET_FLAGS);
    assert!(RIG_MAX_RAYS as usize == view::MAX_RAYS);
    assert!(HIT_STRIDE as usize == 4 * view::HIT_WORDS);
    assert!(HIT_POINT as usize == 4 * view::HIT_POINT);
    assert!(HIT_NORMAL as usize == 4 * view::HIT_NORMAL);
    assert!(HIT_FLAGS as usize == 4 * view::HIT_FLAGS);
    assert!(RAY_STRIDE as usize == 4 * view::RAY_WORDS);
    assert!(RAY_ORIGIN as usize == 4 * view::RAY_ORIGIN);
    assert!(RAY_DIRECTION as usize == 4 * view::RAY_DIRECTION);
    assert!(RAY_LENGTH as usize == 4 * view::RAY_LENGTH);
    assert!(RAY_FLAGS as usize == 4 * view::RAY_FLAGS);
};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the rig input and ray output rows.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    (init.max_instances as u64).saturating_mul(RIG_INPUT_STRIDE as u64 + RAY_ROW_STRIDE as u64)
}

/// The rig input and ray output views.
#[derive(Default)]
pub struct RigViews {
    /// `RIG_INPUT_STRIDE` bytes per instance index.
    pub inputs: Vec<u32>,
    /// `RAY_ROW_STRIDE` bytes per instance index.
    pub rays: Vec<u32>,
}

impl RigViews {
    /// Views for `max_instances` rows.
    pub fn new(max_instances: usize) -> RigViews {
        RigViews {
            inputs: vec![0; max_instances * INPUT_WORDS],
            rays: vec![0; max_instances * RAY_ROW_WORDS],
        }
    }

    /// Row `index` with defaults: the identity transform, LOD 0, no targets, no hits, no rays.
    pub fn default_row(&mut self, index: usize) {
        if let Some(row) = self
            .inputs
            .get_mut(index * INPUT_WORDS..(index + 1) * INPUT_WORDS)
        {
            row.fill(0);
            row[(RIG_CHARACTER_ROTATION / 4) as usize + 3] = 1.0f32.to_bits();
            for k in 0..3 {
                row[(RIG_CHARACTER_SCALE / 4) as usize + k] = 1.0f32.to_bits();
            }
        }
        if let Some(row) = self
            .rays
            .get_mut(index * RAY_ROW_WORDS..(index + 1) * RAY_ROW_WORDS)
        {
            row.fill(0);
        }
    }
}

/// Clears row `index` of the ray output view (before its pose is evaluated).
pub fn clear_rays(rays: &[Cell<u32>], index: usize) {
    if let Some(row) = rays.get(index * RAY_ROW_WORDS..(index + 1) * RAY_ROW_WORDS) {
        for c in row {
            c.set(0);
        }
    }
}

/// Instance row `index`'s rig inputs from the input view `inputs` and the ray output view `rays`
/// (as cells, so the rig nodes write requests through the evaluation's shared inputs), with
/// `skel`'s limits and roles.
pub fn row_inputs<'a>(
    inputs: &'a [u32],
    rays: &'a [Cell<u32>],
    index: usize,
    skel: &'a SkeletonAsset,
) -> RigInputs<'a> {
    let Some(row) = inputs.get(index * INPUT_WORDS..(index + 1) * INPUT_WORDS) else {
        return RigInputs {
            limits: &skel.limits,
            roles: &skel.roles,
            ..RigInputs::NONE
        };
    };
    let f = |byte: u32, k: usize| {
        let v = f32::from_bits(row[(byte / 4) as usize + k]);
        if v.is_finite() {
            v
        } else {
            0.0
        }
    };
    let p = |byte: u32| AosVec3::new(f(byte, 0), f(byte, 1), f(byte, 2));
    let character = AosTransform::new(
        p(RIG_CHARACTER_POSITION),
        AosQuat::new(
            f(RIG_CHARACTER_ROTATION, 0),
            f(RIG_CHARACTER_ROTATION, 1),
            f(RIG_CHARACTER_ROTATION, 2),
            f(RIG_CHARACTER_ROTATION, 3),
        )
        .normalize_or_identity(),
        p(RIG_CHARACTER_SCALE),
    );
    let targets = (RIG_TARGETS / 4) as usize;
    let hits = (RIG_HITS / 4) as usize;
    RigInputs {
        character,
        lod: row[(RIG_LOD / 4) as usize],
        targets: &row[targets..hits],
        hits: &row[hits..],
        rays: rays
            .get(index * RAY_ROW_WORDS..(index + 1) * RAY_ROW_WORDS)
            .unwrap_or(&[]),
        limits: &skel.limits,
        roles: &skel.roles,
    }
}

/// The stride of a `rig` family command, or `None` for another opcode.
pub fn command_stride(opcode: u16) -> Option<usize> {
    Some(match opcode {
        WarpTarget::OPCODE => WarpTarget::STRIDE,
        RigReset::OPCODE => RigReset::STRIDE,
        _ => return None,
    } as usize)
}

/// A refusal: the status, the instance, the node the command named and 0.
pub type Refusal = (u32, u32, u32, u32);

fn is_rig(program: &Program, node: u32) -> Option<u16> {
    match program.node_kind(node) {
        Some((Family::Rig, k)) => Some(k),
        _ => None,
    }
}

/// Applies one `rig` family command (`bytes` is the whole record).
pub fn apply(arena: &Arena, table: &mut Table, opcode: u16, bytes: &[u8]) -> Result<(), Refusal> {
    let bad = (STATUS_BAD_RECORD, 0, 0, 0);
    let (instance, node) = match opcode {
        WarpTarget::OPCODE => {
            let c = WarpTarget::decode(bytes).map_err(|_| bad)?;
            (c.instance, c.node)
        }
        RigReset::OPCODE => {
            let c = RigReset::decode(bytes).map_err(|_| bad)?;
            (c.instance, c.node)
        }
        _ => return Err(bad),
    };
    let r = |s: u32| (s, instance, node, 0);
    let inst = table.get_mut(instance).map_err(r)?;
    if inst.graph == 0 {
        return Err(r(STATUS_MISMATCH));
    }
    let program = &arena.graph(inst.graph).map_err(r)?.program;
    let groups = inst.groups;
    if opcode == RigReset::OPCODE && node == NODE_ALL {
        for n in 0..program.node_count() as u32 {
            if is_rig(program, n).is_some() {
                rig_nodes::request_reset(program.node_state(&mut inst.state, groups, n));
            }
        }
        return Ok(());
    }
    if node as usize >= program.node_count() {
        return Err(r(STATUS_NO_SUCH));
    }
    let k = is_rig(program, node).ok_or(r(STATUS_MISMATCH))?;
    let state = program.node_state(&mut inst.state, groups, node);
    if opcode == RigReset::OPCODE {
        rig_nodes::request_reset(state);
        return Ok(());
    }
    if k != kind::MOTION_WARP {
        return Err(r(STATUS_MISMATCH));
    }
    let c = WarpTarget::decode(bytes).map_err(|_| bad)?;
    if c.flags & WARP_CLEAR != 0 {
        rig_nodes::clear_warp_target(state);
        return Ok(());
    }
    let v = [c.px, c.py, c.pz, c.rx, c.ry, c.rz, c.rw];
    if v.iter().any(|x| !x.is_finite()) {
        return Err(r(STATUS_BAD_RECORD));
    }
    rig_nodes::set_warp_target(
        state,
        AosVec3::new(c.px, c.py, c.pz),
        AosQuat::new(c.rx, c.ry, c.rz, c.rw),
    );
    Ok(())
}
