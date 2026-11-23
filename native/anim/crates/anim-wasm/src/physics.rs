//! Feature `physics` (T44r): ragdoll descriptions, the physics rows and their views (wire family
//! `physics`, which documents the layouts and the per-step order), the drive step, the
//! physical-pose readback and the get-up capture.
//!
//! | Call | Does |
//! |---|---|
//! | `ragdoll_build(skeleton_bytes, profile)` | the default description (`RagdollInfo` + one `RagdollBone` per bone) from a skeleton file's joint ranges, else its roles' profile defaults (profile 0: Humanoid), pelvis = the profile's hips |
//! | `ragdoll_create(skeleton, bytes)` | a validated description as an arena asset |
//! | `physics_configure(max_rows)` | sizes the rows and views for the core's `max_bones` (drops every row) |
//! | `physics_attach(instance, ragdoll)` / `physics_detach(instance)` | a row for an instance (its index, or `NONE`) |
//! | `physics_read(world)` | after the physics step: the input rows into each attached instance's `PHYSICAL_POSE` nodes |
//! | `physics_drive(world)` | after the fixed `evaluate`: the drive targets and get-up facing into the output rows |
//! | `physics_capture(instance, physical_node, snapshot_node)` | get-up: the physical pose into a `POSE_SNAPSHOT` node |
//! | `physics_in_ptr`, `physics_out_ptr`, `physics_in_row_bytes`, `physics_out_row_bytes` | the views |
//!
//! The drive source is the first `PHYSICS_BLEND` node (node order) of the instance's graph: its
//! stored animated pose and the one before it (`anim_graph::physics::drive_source`); without one,
//! the instance's last two output poses. Nothing here allocates after `physics_configure` and the
//! load calls.

use anim_format::skeleton::{JointRange, SkeletonView};
use anim_graph::eval::Program;
use anim_graph::{physics as nodes, sources, Family};
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_physics::pose::{bone_from_body, BodyPose};
use anim_physics::{
    facing, getup_state, BoneDesc, Drive, DriveInput, DriveScratch, Facing, FrontAxis, Ragdoll,
    RagdollDesc, NO_BONE,
};
use anim_retarget::bake::SkeletonData;
use anim_wire::core::{
    Init, STATUS_BAD_ASSET, STATUS_BAD_RECORD, STATUS_MISMATCH, STATUS_NOT_INITIALIZED, STATUS_OK,
    STATUS_WRONG_KIND,
};
use anim_wire::graph::STATUS_NO_SUCH;
use anim_wire::physics::{
    BodyIn, DriveOut, RagdollBone, RagdollInfo, RowControl, RowOut, BODY_SIMULATED, BONE_BODY,
    FACING_DOWN, FACING_NONE, FACING_UP, NONE, ROW_DRIVES, ROW_FACING, STATUS_NO_ROW,
};
use anim_wire::WireRecord;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::assets::Asset;
use crate::init::{with, Core};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// none until `physics_configure` asks for rows.
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}

/// A ragdoll description asset.
pub struct RagdollAsset {
    pub ragdoll: Ragdoll,
}

#[derive(Clone, Copy, Default)]
struct Row {
    /// The instance handle (0: free).
    instance: u32,
    ragdoll: u32,
}

/// The rows, views and scratch.
#[derive(Default)]
pub struct Physics {
    max_bones: usize,
    rows: Vec<Row>,
    input: Vec<u32>,
    output: Vec<u32>,
    scratch: Option<DriveScratch>,
    drives: Vec<Drive>,
    now: Vec<SoaTransform>,
    prev: Vec<SoaTransform>,
    model: Vec<AosTransform>,
    multipliers: Vec<f32>,
}

fn in_row_bytes(max_bones: usize) -> usize {
    RowControl::STRIDE as usize + max_bones * BodyIn::STRIDE as usize
}

fn out_row_bytes(max_bones: usize) -> usize {
    RowOut::STRIDE as usize + max_bones * DriveOut::STRIDE as usize
}

fn bytes(words: &[u32]) -> &[u8] {
    // SAFETY: u8 has no alignment requirement and every bit pattern is valid; the slice covers
    // exactly the words' memory for their borrow.
    unsafe { core::slice::from_raw_parts(words.as_ptr().cast::<u8>(), words.len() * 4) }
}

fn bytes_mut(words: &mut [u32]) -> &mut [u8] {
    // SAFETY: as `bytes`, mutably.
    unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr().cast::<u8>(), words.len() * 4) }
}

impl Physics {
    fn in_row(&self, row: usize) -> &[u8] {
        let n = in_row_bytes(self.max_bones);
        &bytes(&self.input)[row * n..(row + 1) * n]
    }

    fn body_in(&self, row: usize, bone: usize) -> Option<BodyIn> {
        let at = RowControl::STRIDE as usize + bone * BodyIn::STRIDE as usize;
        BodyIn::decode(self.in_row(row).get(at..)?).ok()
    }

    fn control(&self, row: usize) -> Option<RowControl> {
        RowControl::decode(self.in_row(row)).ok()
    }
}

fn body_pose(b: &BodyIn) -> Option<BodyPose> {
    let v = [
        b.pos_x, b.pos_y, b.pos_z, b.rot_x, b.rot_y, b.rot_z, b.rot_w,
    ];
    v.iter().all(|x| x.is_finite()).then(|| BodyPose {
        position: AosVec3::new(b.pos_x, b.pos_y, b.pos_z),
        rotation: AosQuat::new(b.rot_x, b.rot_y, b.rot_z, b.rot_w).normalize_or_identity(),
    })
}

fn first_node(program: &Program, kind: u16) -> Option<u32> {
    (0..program.node_count() as u32)
        .find(|&n| program.node_kind(n) == Some((Family::Physics, kind)))
}

/// The default description of a skeleton file (see the module docs).
fn build_desc(view: &SkeletonView<'_>, profile: &anim_retarget::Profile) -> RagdollDesc {
    let data = SkeletonData::from_view(view);
    let n = data.parents.len();
    let has_ranges = view
        .section(anim_format::skeleton::section::JOINT_RANGES)
        .is_some();
    // The pelvis: the bone with the profile's hips role, else (a skeleton whose root and hips are
    // one bone stores only the root role) the bone with its root role.
    let with_role = |role: u16| {
        (role != anim_format::skeleton::NO_ROLE)
            .then(|| (0..n).find(|&b| view.role(b) == Some(role)))
            .flatten()
    };
    let pelvis = with_role(profile.hips).or_else(|| with_role(profile.root));
    let role_range = |r: u16| profile.roles.get(r as usize).and_then(|r| r.range);
    let ranges: Vec<Option<JointRange>> = (0..n)
        .map(|b| {
            if has_ranges {
                view.joint_range(b)
            } else {
                view.role(b).and_then(role_range)
            }
        })
        .collect();
    let pelvis = pelvis.map_or(NO_BONE, |b| b as u16);
    RagdollDesc::from_skeleton(&data.parents, &ranges, pelvis)
}

fn encode_desc(desc: &RagdollDesc) -> Vec<u8> {
    let mut out = RagdollInfo {
        bone_count: desc.bones.len() as u32,
        pelvis: if desc.pelvis == NO_BONE {
            NONE
        } else {
            desc.pelvis as u32
        },
        front: desc.front as u32,
    }
    .encode();
    for b in &desc.bones {
        let (q, r) = (b.joint_frame, b.range);
        out.extend_from_slice(
            &RagdollBone {
                flags: if b.body { BONE_BODY } else { 0 },
                frame_x: q.x,
                frame_y: q.y,
                frame_z: q.z,
                frame_w: q.w,
                swing_y: r.swing_y,
                swing_z: r.swing_z,
                twist_min: r.twist_min,
                twist_max: r.twist_max,
                stiffness: b.stiffness,
                damping: b.damping,
                max_force: b.max_force,
                strength: b.strength,
                pin: b.pin,
            }
            .encode(),
        );
    }
    out
}

fn decode_desc(bytes: &[u8]) -> Result<RagdollDesc, u32> {
    let info = RagdollInfo::decode(bytes).map_err(|_| STATUS_BAD_RECORD)?;
    let n = info.bone_count as usize;
    let (head, stride) = (RagdollInfo::STRIDE as usize, RagdollBone::STRIDE as usize);
    if bytes.len() != head + n * stride {
        return Err(STATUS_MISMATCH);
    }
    let mut bones = Vec::with_capacity(n);
    for i in 0..n {
        let b = RagdollBone::decode(&bytes[head + i * stride..]).map_err(|_| STATUS_BAD_RECORD)?;
        bones.push(BoneDesc {
            body: b.flags & BONE_BODY != 0,
            joint_frame: AosQuat::new(b.frame_x, b.frame_y, b.frame_z, b.frame_w),
            range: JointRange {
                swing_y: b.swing_y,
                swing_z: b.swing_z,
                twist_min: b.twist_min,
                twist_max: b.twist_max,
            },
            stiffness: b.stiffness,
            damping: b.damping,
            max_force: b.max_force,
            strength: b.strength,
            pin: b.pin,
        });
    }
    Ok(RagdollDesc {
        bones,
        pelvis: if info.pelvis == NONE || info.pelvis > u16::MAX as u32 {
            NO_BONE
        } else {
            info.pelvis as u16
        },
        front: FrontAxis::from_u32(info.front).ok_or(STATUS_BAD_ASSET)?,
    })
}

impl Core {
    fn ragdoll_asset(&self, handle: u32) -> Result<&Ragdoll, u32> {
        match self.arena.get(handle)? {
            Asset::Ragdoll(r) => Ok(&r.ragdoll),
            _ => Err(STATUS_WRONG_KIND),
        }
    }

    /// The default ragdoll description of a skeleton file (module docs); empty on failure.
    pub fn ragdoll_build(&mut self, skeleton: &[u8], profile: u32) -> Vec<u8> {
        if !self.started {
            self.last_status = STATUS_NOT_INITIALIZED;
            return Vec::new();
        }
        let r = (|| {
            let view = SkeletonView::parse(skeleton).map_err(|_| STATUS_BAD_ASSET)?;
            let p = self.retarget_profile(profile)?;
            Ok(encode_desc(&build_desc(&view, p)))
        })();
        match r {
            Ok(b) => {
                self.last_status = STATUS_OK;
                b
            }
            Err(e) => {
                self.last_status = e;
                Vec::new()
            }
        }
    }

    /// Validates a ragdoll description for a skeleton asset; its handle, or 0 (`last_status`).
    pub fn ragdoll_create(&mut self, skeleton: u32, bytes: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = (|| {
            let desc = decode_desc(bytes)?;
            let skel = self.arena.skeleton(skeleton)?;
            Ragdoll::new(desc, &skel.parents).map_err(|_| STATUS_BAD_ASSET)
        })();
        let r = r.and_then(|ragdoll| {
            self.arena
                .insert(Asset::Ragdoll(Box::new(RagdollAsset { ragdoll })))
        });
        self.handle(r)
    }

    /// Sizes the physics rows and views (drops every row). Returns a status.
    pub fn physics_configure(&mut self, max_rows: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        let rows = max_rows.min(anim_wire::core::HANDLE_INDEX_MASK) as usize;
        let b = self.max_bones;
        self.physics = Physics {
            max_bones: b,
            rows: vec![Row::default(); rows],
            input: vec![0; rows * in_row_bytes(b) / 4],
            output: vec![0; rows * out_row_bytes(b) / 4],
            scratch: Some(DriveScratch::new(b)),
            drives: vec![Drive::default(); b],
            now: vec![SoaTransform::identity(); soa_len(b)],
            prev: vec![SoaTransform::identity(); soa_len(b)],
            model: vec![AosTransform::identity(); b],
            multipliers: vec![1.0; b],
        };
        STATUS_OK
    }

    /// Gives `instance` a physics row driven by `ragdoll` (its skeleton's); returns the row index,
    /// or `NONE` (`last_status`: `STATUS_NO_ROW` when every row is taken). Attaching again
    /// re-binds the instance's row. The input row is reset to its defaults.
    pub fn physics_attach(&mut self, instance: u32, ragdoll: u32) -> u32 {
        if !self.started {
            self.last_status = STATUS_NOT_INITIALIZED;
            return NONE;
        }
        let r = (|| {
            let bones = self.ragdoll_asset(ragdoll)?.bone_count();
            let inst = self.table.get_mut(instance)?;
            let skel = self.arena.skeleton(inst.skeleton)?;
            if skel.bones() != bones {
                return Err(STATUS_MISMATCH);
            }
            let p = &mut self.physics;
            let row = p
                .rows
                .iter()
                .position(|r| r.instance == instance)
                .or_else(|| p.rows.iter().position(|r| r.instance == 0))
                .ok_or(STATUS_NO_ROW)?;
            p.rows[row] = Row { instance, ragdoll };
            let (ni, no) = (in_row_bytes(p.max_bones), out_row_bytes(p.max_bones));
            let input = &mut bytes_mut(&mut p.input)[row * ni..(row + 1) * ni];
            let _ = RowControl {
                strength: 1.0,
                pin: 1.0,
                getup_from_back: NONE,
                getup_from_front: NONE,
            }
            .encode_into(input);
            for b in 0..p.max_bones {
                let at = RowControl::STRIDE as usize + b * BodyIn::STRIDE as usize;
                let _ = BodyIn {
                    rot_w: 1.0,
                    multiplier: 1.0,
                    ..BodyIn::default()
                }
                .encode_into(&mut input[at..]);
            }
            let output = &mut bytes_mut(&mut p.output)[row * no..(row + 1) * no];
            output.fill(0);
            let _ = RowOut {
                instance,
                flags: 0,
                facing: FACING_NONE,
                getup: NONE,
                bone_count: bones as u32,
            }
            .encode_into(output);
            Ok(row as u32)
        })();
        match r {
            Ok(row) => {
                self.last_status = STATUS_OK;
                row
            }
            Err(e) => {
                self.last_status = e;
                NONE
            }
        }
    }

    /// Frees `instance`'s row. Returns a status.
    pub fn physics_detach(&mut self, instance: u32) -> u32 {
        match self
            .physics
            .rows
            .iter_mut()
            .find(|r| r.instance == instance && instance != 0)
        {
            Some(r) => {
                *r = Row::default();
                STATUS_OK
            }
            None => STATUS_NO_ROW,
        }
    }

    /// Copies each attached instance's input row (in `world`) into its graph's `PHYSICAL_POSE`
    /// nodes: simulated bodies become bone poses (`bone_from_body` with the joint frames).
    /// Returns the rows applied. Never allocates.
    pub fn physics_read(&mut self, world: u32) -> u32 {
        if !self.started {
            return 0;
        }
        let mut applied = 0;
        for row in 0..self.physics.rows.len() {
            let Row { instance, ragdoll } = self.physics.rows[row];
            if instance == 0 {
                continue;
            }
            let Ok(inst) = self.table.get_mut(instance) else {
                continue;
            };
            if inst.world != world || inst.graph == 0 {
                continue;
            }
            let (Ok(g), Ok(Asset::Ragdoll(rd))) =
                (self.arena.graph(inst.graph), self.arena.get(ragdoll))
            else {
                continue;
            };
            let (program, rd) = (&g.program, &rd.ragdoll);
            let groups = inst.groups;
            let bones = rd.bone_count();
            for node in 0..program.node_count() as u32 {
                if program.node_kind(node) != Some((Family::Physics, nodes::kind::PHYSICAL_POSE)) {
                    continue;
                }
                let state = program.node_state(&mut inst.state, groups, node);
                let mut any = false;
                for b in 0..bones {
                    let d = &rd.desc().bones[b];
                    let pose = self
                        .physics
                        .body_in(row, b)
                        .filter(|x| d.body && x.flags & BODY_SIMULATED != 0)
                        .and_then(|x| body_pose(&x))
                        .map(|p| bone_from_body(&p, d.joint_frame));
                    any |= pose.is_some();
                    nodes::write_body(state, b, pose);
                }
                nodes::set_valid(state, any);
            }
            applied += 1;
        }
        applied
    }

    /// Writes each attached instance's (in `world`) drive targets and get-up facing into its
    /// output row (module docs). Returns the rows written. Never allocates.
    pub fn physics_drive(&mut self, world: u32) -> u32 {
        if !self.started {
            return 0;
        }
        let mut written = 0;
        for row in 0..self.physics.rows.len() {
            let Row { instance, ragdoll } = self.physics.rows[row];
            if instance == 0 {
                continue;
            }
            let Ok(inst) = self.table.get_mut(instance) else {
                continue;
            };
            if inst.world != world {
                continue;
            }
            let Ok(Asset::Ragdoll(rd)) = self.arena.get(ragdoll) else {
                continue;
            };
            let rd = &rd.ragdoll;
            let groups = inst.groups;
            let bones = rd.bone_count();
            let p = &mut self.physics;
            let program = (inst.graph != 0)
                .then(|| self.arena.graph(inst.graph).ok())
                .flatten()
                .map(|g| &g.program);
            let blend =
                program.and_then(|pr| first_node(pr, nodes::kind::PHYSICS_BLEND).map(|n| (pr, n)));
            let (count, dt) = match blend {
                Some((pr, n)) => {
                    let state = pr.node_state(&mut inst.state, groups, n);
                    nodes::drive_source(state, groups, &mut p.now[..groups], &mut p.prev[..groups])
                }
                None => {
                    if inst.history >= 1 {
                        p.now[..groups].copy_from_slice(&inst.last);
                    }
                    if inst.history >= 2 {
                        p.prev[..groups].copy_from_slice(&inst.prev);
                    }
                    (inst.history.min(2), inst.history_dt)
                }
            };
            for b in 0..bones {
                p.multipliers[b] = p.body_in(row, b).map_or(1.0, |x| x.multiplier);
            }
            let control = p.control(row).unwrap_or_default();
            let mut flags = 0;
            if count >= 1 {
                let input = DriveInput {
                    now: &p.now[..groups],
                    prev: (count >= 2).then_some(&p.prev[..groups]),
                    dt,
                    strength: control.strength,
                    pin: control.pin,
                    multipliers: &p.multipliers[..bones],
                };
                if let Some(scratch) = p.scratch.as_mut() {
                    if rd.drive(&input, scratch, &mut p.drives[..bones]).is_ok() {
                        flags |= ROW_DRIVES;
                    }
                }
            }
            // Get-up facing from the simulated pelvis.
            let pelvis = rd.pelvis() as usize;
            let face = p
                .body_in(row, pelvis)
                .filter(|x| x.flags & BODY_SIMULATED != 0)
                .and_then(|x| body_pose(&x))
                .map(|b| {
                    let bone = bone_from_body(&b, rd.desc().bones[pelvis].joint_frame);
                    facing(bone.rotation, rd.desc().front)
                });
            let (facing_v, getup) = match face {
                Some(f) => {
                    flags |= ROW_FACING;
                    let v = if f == Facing::Up {
                        FACING_UP
                    } else {
                        FACING_DOWN
                    };
                    (
                        v,
                        getup_state(f, control.getup_from_back, control.getup_from_front),
                    )
                }
                None => (FACING_NONE, NONE),
            };
            let no = out_row_bytes(p.max_bones);
            let out = &mut bytes_mut(&mut p.output)[row * no..(row + 1) * no];
            let _ = RowOut {
                instance,
                flags,
                facing: facing_v,
                getup,
                bone_count: bones as u32,
            }
            .encode_into(out);
            if flags & ROW_DRIVES != 0 {
                for (b, d) in p.drives[..bones].iter().enumerate() {
                    let at = RowOut::STRIDE as usize + b * DriveOut::STRIDE as usize;
                    let (t, w, bp) = (d.target, d.angular_velocity, d.body);
                    let _ = DriveOut {
                        flags: d.flags,
                        parent_body: if d.parent_body == NO_BONE {
                            NONE
                        } else {
                            d.parent_body as u32
                        },
                        target_x: t.x,
                        target_y: t.y,
                        target_z: t.z,
                        target_w: t.w,
                        vel_x: w.x,
                        vel_y: w.y,
                        vel_z: w.z,
                        stiffness: d.stiffness,
                        damping: d.damping,
                        max_force: d.max_force,
                        pin: d.pin,
                        pos_x: bp.position.x,
                        pos_y: bp.position.y,
                        pos_z: bp.position.z,
                        rot_x: bp.rotation.x,
                        rot_y: bp.rotation.y,
                        rot_z: bp.rotation.z,
                        rot_w: bp.rotation.w,
                    }
                    .encode_into(&mut out[at..]);
                }
            }
            written += 1;
        }
        written
    }

    /// Get-up: captures the physical pose of `physical_node` (a `PHYSICAL_POSE`; bones it doesn't
    /// simulate take the instance's last output) into `snapshot_node` (a `POSE_SNAPSHOT`), which
    /// then outputs it (the get-up state blends from it). Returns a status.
    pub fn physics_capture(
        &mut self,
        instance: u32,
        physical_node: u32,
        snapshot_node: u32,
    ) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        let r = (|| {
            let inst = self.table.get_mut(instance)?;
            let g = self.arena.graph(inst.graph)?;
            let skel = self.arena.skeleton(inst.skeleton)?;
            let program = &g.program;
            if program.node_kind(physical_node)
                != Some((Family::Physics, nodes::kind::PHYSICAL_POSE))
                || program.node_kind(snapshot_node)
                    != Some((Family::Sources, sources::kind::POSE_SNAPSHOT))
            {
                return Err(STATUS_NO_SUCH);
            }
            let groups = inst.groups;
            let p = &mut self.physics;
            if p.now.len() < groups || p.model.len() < skel.bones() {
                return Err(STATUS_NO_ROW);
            }
            let pose = &mut p.now[..groups];
            if inst.history >= 1 {
                pose.copy_from_slice(&inst.last);
            } else {
                pose.copy_from_slice(&skel.rest_soa);
            }
            let state = program.node_state(&mut inst.state, groups, physical_node);
            if !nodes::physical_to_local(state, &skel.parents, pose, &mut p.model) {
                return Err(STATUS_MISMATCH);
            }
            sources::capture(
                program.node_state(&mut inst.state, groups, snapshot_node),
                pose,
            );
            Ok(())
        })();
        match r {
            Ok(()) => STATUS_OK,
            Err(e) => e,
        }
    }

    /// The input view's bytes per row.
    pub fn physics_in_row_bytes(&self) -> u32 {
        in_row_bytes(self.physics.max_bones) as u32
    }

    /// The output view's bytes per row.
    pub fn physics_out_row_bytes(&self) -> u32 {
        out_row_bytes(self.physics.max_bones) as u32
    }

    /// The input view (words).
    pub fn physics_input_mut(&mut self) -> &mut [u32] {
        &mut self.physics.input
    }

    /// The output view (words).
    pub fn physics_output(&self) -> &[u32] {
        &self.physics.output
    }
}

/// The default ragdoll description of a skeleton file (empty: see `last_status`).
#[wasm_bindgen]
pub fn ragdoll_build(skeleton: &[u8], profile: u32) -> Vec<u8> {
    with(|c| c.ragdoll_build(skeleton, profile))
}

/// Creates a ragdoll description asset for a skeleton; its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn ragdoll_create(skeleton: u32, bytes: &[u8]) -> u32 {
    with(|c| c.ragdoll_create(skeleton, bytes))
}

/// Sizes the physics rows and views; returns a status.
#[wasm_bindgen]
pub fn physics_configure(max_rows: u32) -> u32 {
    with(|c| c.physics_configure(max_rows))
}

/// Gives an instance a physics row; returns its index or `NONE` (see `last_status`).
#[wasm_bindgen]
pub fn physics_attach(instance: u32, ragdoll: u32) -> u32 {
    with(|c| c.physics_attach(instance, ragdoll))
}

/// Frees an instance's physics row; returns a status.
#[wasm_bindgen]
pub fn physics_detach(instance: u32) -> u32 {
    with(|c| c.physics_detach(instance))
}

/// After the physics step: the simulated bodies into the physical-pose nodes. Returns rows applied.
#[wasm_bindgen]
pub fn physics_read(world: u32) -> u32 {
    with(|c| c.physics_read(world))
}

/// After the fixed evaluate: the drive targets into the output view. Returns rows written.
#[wasm_bindgen]
pub fn physics_drive(world: u32) -> u32 {
    with(|c| c.physics_drive(world))
}

/// Get-up: the physical pose into a pose-snapshot node; returns a status.
#[wasm_bindgen]
pub fn physics_capture(instance: u32, physical_node: u32, snapshot_node: u32) -> u32 {
    with(|c| c.physics_capture(instance, physical_node, snapshot_node))
}

/// The byte offset of the physics input view.
#[wasm_bindgen]
pub fn physics_in_ptr() -> u32 {
    with(|c| Core::addr(&c.physics.input))
}

/// The byte offset of the physics output view.
#[wasm_bindgen]
pub fn physics_out_ptr() -> u32 {
    with(|c| Core::addr(&c.physics.output))
}

/// The input view's bytes per row.
#[wasm_bindgen]
pub fn physics_in_row_bytes() -> u32 {
    with(|c| c.physics_in_row_bytes())
}

/// The output view's bytes per row.
#[wasm_bindgen]
pub fn physics_out_row_bytes() -> u32 {
    with(|c| c.physics_out_row_bytes())
}
