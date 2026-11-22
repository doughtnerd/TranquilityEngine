//! The setup calls and the core: `init` reads the one generated init record (`anim-wire` family
//! `core`), answers with the memory the core needs for it (ADR 0340, after audio 0327/0328) and
//! (re)starts the [`Core`] with those limits; `source_hash` returns the hash of `native/anim/`
//! the module was built from (the staleness check).
//!
//! [`Core`] is the whole animation core as a Rust value (asset arena, instance table, views and
//! scratch). The module keeps one per page, and the `#[wasm_bindgen]` functions below are thin
//! wrappers over it with plain numeric and byte-slice signatures: no JavaScript objects cross,
//! and per-frame data moves through the views (`anim-wire` core documents the frame).

use std::cell::RefCell;

use anim_graph::eval::{Inputs, Program, SkeletonPose};
use anim_math::layout::soa_len;
use anim_wire::core::{
    Init, MemoryNeeded, HANDLE_INDEX_MASK, STATUS_BAD_RECORD, STATUS_NOT_INITIALIZED, STATUS_OK,
    STATUS_TOO_LARGE,
};
use anim_wire::WireRecord;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::assets::{split, Arena};
use crate::evaluate::{self as frame_calls, Frame};
use crate::instances::{implicit, Table};
use crate::timeline::Timelines;
use crate::tweens::Tweens;
use crate::{
    assets, debug, evaluate, graph, instances, matching, physics, plugin, retarget, rig, timeline,
    tracks, tweens,
};
use anim_wire::timeline::{DEFAULT_MAX_TIMELINES, DEFAULT_RECORD_BYTES};
use anim_wire::tween::DEFAULT_MAX_TWEENS;

/// The source hash `build.rs` embedded.
static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

/// The bytes of one wasm memory page.
const PAGE_BYTES: u64 = 64 * 1024;

/// The reply to an init record.
fn memory_needed(init: Option<&Init>) -> MemoryNeeded {
    let Some(init) = init else {
        return MemoryNeeded {
            status: STATUS_BAD_RECORD,
            bytes: 0,
            pages: 0,
        };
    };
    let too_large = MemoryNeeded {
        status: STATUS_TOO_LARGE,
        bytes: 0,
        pages: 0,
    };
    if init.max_instances > HANDLE_INDEX_MASK || init.max_bones > HANDLE_INDEX_MASK {
        return too_large;
    }
    let total = total_bytes(init);
    match u32::try_from(total) {
        Ok(bytes) => MemoryNeeded {
            status: STATUS_OK,
            bytes,
            pages: total.div_ceil(PAGE_BYTES) as u32,
        },
        Err(_) => too_large,
    }
}

/// Every feature's share, saturating (an overflow reads as too large).
fn total_bytes(init: &Init) -> u64 {
    [
        assets::bytes_needed(init),
        instances::bytes_needed(init),
        evaluate::bytes_needed(init),
        tracks::bytes_needed(init),
        graph::bytes_needed(init),
        rig::bytes_needed(init),
        retarget::bytes_needed(init),
        matching::bytes_needed(init),
        tweens::bytes_needed(init),
        timeline::bytes_needed(init),
        physics::bytes_needed(init),
        plugin::bytes_needed(init),
        debug::bytes_needed(init),
    ]
    .iter()
    .fold(0u64, |sum, b| sum.saturating_add(*b))
}

/// The animation core.
pub struct Core {
    started: bool,
    max_bones: usize,
    arena: Arena,
    table: Table,
    frame: Frame,
    implicit: Program,
    last_status: u32,
    tweens: Tweens,
    timelines: Timelines,
}

impl Default for Core {
    fn default() -> Self {
        Core::new()
    }
}

impl Core {
    /// A core that hasn't been through `init` (every call answers `STATUS_NOT_INITIALIZED`).
    pub fn new() -> Core {
        Core {
            started: false,
            max_bones: 0,
            arena: Arena::default(),
            table: Table::default(),
            frame: Frame::default(),
            implicit: implicit::program(),
            last_status: STATUS_NOT_INITIALIZED,
            tweens: Tweens::default(),
            timelines: Timelines::default(),
        }
    }

    /// Reads an `INIT` record and answers `MEMORY_NEEDED`; when the status is `STATUS_OK` the core
    /// restarts with those limits (every earlier handle is gone).
    pub fn init(&mut self, record: &[u8]) -> MemoryNeeded {
        let init = Init::decode(record).ok();
        let reply = memory_needed(init.as_ref());
        if let (Some(init), STATUS_OK) = (init, reply.status) {
            let instances = init.max_instances as usize;
            let bones = init.max_bones as usize;
            self.max_bones = bones;
            self.arena = Arena::with_capacity(64);
            self.table = Table::new(instances);
            self.frame = Frame::new(instances, bones, self.implicit.pose_slots());
            self.tweens = Tweens::new(DEFAULT_MAX_TWEENS as usize);
            self.timelines = Timelines::new(
                DEFAULT_MAX_TIMELINES as usize,
                DEFAULT_RECORD_BYTES as usize,
            );
            self.started = true;
            self.last_status = STATUS_OK;
        }
        reply
    }

    /// Why the last call that returns a handle returned 0 (or `STATUS_UNKNOWN_NODES` after a graph
    /// load that succeeded with nodes this build doesn't know).
    pub fn last_status(&self) -> u32 {
        self.last_status
    }

    fn handle(&mut self, r: Result<u32, u32>) -> u32 {
        match r {
            Ok(h) => {
                self.last_status = STATUS_OK;
                h
            }
            Err(e) => {
                self.last_status = e;
                0
            }
        }
    }

    /// Loads a `myco.skel@1` file; 0 on failure.
    pub fn load_skeleton(&mut self, bytes: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.arena.load_skeleton(bytes, self.max_bones);
        if let Ok(h) = r {
            if let Ok(s) = self.arena.skeleton(h) {
                let bones = s.bones();
                self.frame.reserve_inertializer(bones);
            }
        }
        self.handle(r)
    }

    /// Loads a `myco.anim@1` file; 0 on failure.
    pub fn load_clip(&mut self, bytes: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.arena.load_clip(bytes);
        self.handle(r)
    }

    /// Loads a `myco.animgraph@1` file; 0 on failure.
    pub fn load_graph(&mut self, bytes: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        match self.arena.load_graph(bytes) {
            Ok((h, status)) => {
                if let Ok(g) = self.arena.graph(h) {
                    let slots = g.program.pose_slots();
                    self.frame.reserve_slots(slots);
                }
                self.last_status = status;
                h
            }
            Err(e) => self.handle(Err(e)),
        }
    }

    /// Loads a bone mask (one weight per bone); 0 on failure.
    pub fn load_mask(&mut self, weights: &[f32]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.arena.load_mask(weights);
        self.handle(r)
    }

    /// Releases an asset. Instances using it stop evaluating (a skeleton or graph) or show nothing
    /// for it (a clip or mask).
    pub fn release(&mut self, handle: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.arena.release(handle)
    }

    /// Binds string id `id` of a graph to a clip or mask (0 unbinds), for instances created later.
    pub fn graph_bind(&mut self, graph: u32, id: u32, asset: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.arena.bind(graph, id, asset)
    }

    /// The address of a clip's or graph's bytes in memory (for host views), 0 for none.
    pub fn asset_bytes_addr(&self, handle: u32) -> usize {
        self.arena.bytes_addr(handle)
    }

    /// Creates an instance in `world` for a skeleton and a graph (0: the implicit graph). Its
    /// input row is filled with defaults. 0 on failure.
    pub fn create_instance(&mut self, world: u32, skeleton: u32, graph: u32) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.create(world, skeleton, graph);
        self.handle(r)
    }

    fn create(&mut self, world: u32, skeleton: u32, graph: u32) -> Result<u32, u32> {
        let skel = self.arena.skeleton(skeleton)?;
        let (program, bindings) = if graph == 0 {
            (&self.implicit, &[][..])
        } else {
            let g = self.arena.graph(graph)?;
            (&g.program, g.bindings.as_slice())
        };
        let groups = soa_len(skel.bones());
        let h = self.table.create(world, skeleton, graph, program, groups)?;
        let layers: Vec<f32> = program.layer_defaults().to_vec();
        let inst = self.table.get_mut(h)?;
        let inputs = Inputs {
            assets: &self.arena,
            skeleton: SkeletonPose {
                parents: &skel.parents,
                rest: &skel.rest,
                rest_soa: &skel.rest_soa,
                identity: &skel.identity,
                bind_soa: &skel.bind_soa,
            },
            bindings,
            layer_weights: &[],
            history: None,
            bake_root: false,
        };
        program.init_state(&inputs, &mut inst.state);
        let (index, _) = split(h);
        self.frame.default_inputs(index, &layers);
        Ok(h)
    }

    /// Destroys an instance.
    pub fn destroy_instance(&mut self, handle: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.table.destroy(handle)
    }

    /// The bytes of an instance's snapshot (0 for a stale handle).
    pub fn snapshot_bytes(&mut self, handle: u32) -> u32 {
        self.table.snapshot_bytes(handle).unwrap_or(0)
    }

    /// Writes an instance's state into `out` ([`Core::snapshot_bytes`] long).
    pub fn snapshot(&mut self, handle: u32, out: &mut [u8]) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.table.snapshot(handle, out)
    }

    /// Restores an instance from a snapshot of an instance of the same graph and skeleton.
    pub fn restore(&mut self, handle: u32, bytes: &[u8]) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.table.restore(handle, bytes)
    }

    /// The input view (words; `INPUT_STRIDE` bytes per instance index).
    pub fn inputs_mut(&mut self) -> &mut [u32] {
        &mut self.frame.inputs
    }

    /// The command buffer.
    pub fn commands_mut(&mut self) -> &mut [u8] {
        &mut self.frame.commands
    }

    /// Applies the first `len` bytes of the command buffer (see `anim-wire` core). Returns the
    /// commands applied.
    pub fn write_inputs(&mut self, len: u32) -> u32 {
        if !self.started {
            return 0;
        }
        // T22r: tween and timeline outputs are per frame, cleared here.
        self.tweens.begin_frame();
        self.timelines.begin_frame();
        frame_calls::write_inputs(
            &self.arena,
            &mut self.table,
            &mut self.frame,
            &self.implicit,
            len as usize,
        )
    }

    /// Evaluates `world`'s instances in `pass`. Returns the state-change records waiting.
    pub fn evaluate(&mut self, world: u32, pass: u32, dt_scaled: f32, dt_unscaled: f32) -> u32 {
        if !self.started {
            return 0;
        }
        let changes = frame_calls::evaluate(
            &self.arena,
            &mut self.table,
            &mut self.frame,
            &self.implicit,
            world,
            pass,
            dt_scaled,
            dt_unscaled,
        );
        // T22r: the tween table and the timeline instances advance after the animators.
        self.tweens.update(world, pass, dt_scaled, dt_unscaled);
        self.timelines
            .update(&self.arena, world, pass, dt_scaled, dt_unscaled);
        changes
    }

    /// The bone-matrix view (`max_bones · 12` floats per instance index).
    pub fn matrices(&self) -> &[f32] {
        &self.frame.matrices
    }

    /// The root-motion view (`ROOT_STRIDE / 4` floats per instance index).
    pub fn roots(&self) -> &[f32] {
        &self.frame.roots
    }

    /// The state-change records (`StateChange::STRIDE` bytes each; `evaluate` returns the count).
    pub fn changes(&self) -> &[u8] {
        &self.frame.changes
            [..self.frame.change_count * anim_wire::core::StateChange::STRIDE as usize]
    }

    /// State changes dropped this frame because the buffer was full.
    pub fn changes_dropped(&self) -> u32 {
        self.frame.changes_dropped
    }

    /// Bytes of a clip's `COLUMN` records (`tracks` family; 0 for a stale handle).
    pub fn clip_column_bytes(&self, clip: u32) -> u32 {
        self.arena
            .clip_asset(clip)
            .map_or(0, |c| crate::tracks::column_records_len(&c.bindings) as u32)
    }

    /// Writes a clip's `COLUMN` records (where each property track's column sits in its block)
    /// into `out`; returns the bytes written (0 for a stale handle or a short `out`).
    pub fn clip_columns(&self, clip: u32, out: &mut [u8]) -> u32 {
        self.arena
            .clip_asset(clip)
            .ok()
            .and_then(|c| crate::tracks::write_columns(&c.bindings, out))
            .unwrap_or(0) as u32
    }

    /// The track regions (`TRACK_STRIDE` bytes per instance index, as words).
    pub fn tracks(&self) -> &[u32] {
        &self.frame.tracks
    }

    /// The blackboard view (words; `graph` family `BLACKBOARD_STRIDE` bytes per instance index).
    pub fn blackboard_mut(&mut self) -> &mut [u32] {
        &mut self.frame.blackboard
    }

    /// The graph state-change records (`graph` family `GRAPH_CHANGE`) since the last
    /// `write_inputs`.
    pub fn graph_changes(&self) -> &[u8] {
        self.frame.graph_changes.written()
    }

    /// Graph state changes dropped because the buffer was full.
    pub fn graph_changes_dropped(&self) -> u32 {
        self.frame.graph_changes.dropped
    }

    /// Writes instance `handle`'s debug report (`debug` family) into the debug buffer; returns its
    /// bytes (0 unless the instance is flagged with `DEBUG`).
    pub fn debug_write(&mut self, handle: u32) -> u32 {
        if !self.started {
            return 0;
        }
        crate::debug::write(
            &self.arena,
            &mut self.table,
            &self.frame.inputs,
            handle,
            &mut self.frame.debug,
        )
    }

    /// The debug buffer.
    pub fn debug(&self) -> &[u8] {
        &self.frame.debug
    }

    /// The bytes of asset files the arena holds.
    pub fn arena_bytes(&self) -> usize {
        self.arena.held_bytes()
    }

    // ---- T22r: tweens and timelines (see `anim-wire` families `tween` and `timeline`) ----

    /// Resizes the tween table (setup: every tween is dropped). Returns a status.
    pub fn tweens_configure(&mut self, max_tweens: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        if max_tweens as usize > crate::tweens::MAX_TWEENS {
            return STATUS_TOO_LARGE;
        }
        self.tweens = Tweens::new(max_tweens as usize);
        STATUS_OK
    }

    /// Creates a tween from a `TWEEN_CREATE` record; 0 on failure.
    pub fn tween_create(&mut self, record: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.tweens.create(record);
        self.handle(r)
    }

    /// Applies a `TWEEN_CONTROL` record; returns a status.
    pub fn tween_control(&mut self, record: &[u8]) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.tweens.control(record)
    }

    /// Resizes the timeline table and its frame record buffer (setup: every instance is dropped).
    pub fn timelines_configure(&mut self, max_timelines: u32, record_bytes: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        if max_timelines as usize > crate::timeline::MAX_TIMELINES {
            return STATUS_TOO_LARGE;
        }
        self.timelines = Timelines::new(max_timelines as usize, record_bytes as usize);
        STATUS_OK
    }

    /// Creates an instance of a clip used as a timeline; 0 on failure.
    pub fn timeline_create(&mut self, record: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.timelines.create_clip(&self.arena, record);
        self.handle(r)
    }

    /// Creates a sequence from `SEQ_CREATE` plus its `SEQ_MEMBER` records; 0 on failure.
    pub fn timeline_create_sequence(&mut self, bytes: &[u8]) -> u32 {
        if !self.started {
            return self.handle(Err(STATUS_NOT_INITIALIZED));
        }
        let r = self.timelines.create_sequence(bytes);
        self.handle(r)
    }

    /// Binds a subclip string id of `owner` to a clip; returns a status.
    pub fn timeline_bind(&mut self, instance: u32, owner: u32, string_id: u32, asset: u32) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.timelines
            .bind(&self.arena, instance, owner, string_id, asset)
    }

    /// Applies a `TIMELINE_CONTROL` record; returns a status.
    pub fn timeline_control(&mut self, record: &[u8]) -> u32 {
        if !self.started {
            return STATUS_NOT_INITIALIZED;
        }
        self.timelines.control(record)
    }

    /// Writes an instance's `TIMELINE_INFO` into `out`; the bytes written (0: stale or short).
    pub fn timeline_info(&self, instance: u32, out: &mut [u8]) -> u32 {
        match self.timelines.info(instance) {
            Some(info) if info.encode_into(out).is_ok() => {
                anim_wire::timeline::TimelineInfo::STRIDE
            }
            _ => 0,
        }
    }

    /// Bytes of an instance's `TIMELINE_BLOCK` records.
    pub fn timeline_block_bytes(&self, instance: u32) -> u32 {
        self.timelines.block_bytes(instance) as u32
    }

    /// Writes an instance's `TIMELINE_BLOCK` records into `out`; the bytes written.
    pub fn timeline_blocks(&self, instance: u32, out: &mut [u8]) -> u32 {
        self.timelines.write_blocks(instance, out) as u32
    }

    /// The tween table (for tests and host views).
    pub fn tweens(&self) -> &Tweens {
        &self.tweens
    }

    /// The timeline table (for tests and host views).
    pub fn timelines(&self) -> &Timelines {
        &self.timelines
    }

    fn addr<T>(v: &[T]) -> u32 {
        v.as_ptr() as usize as u32
    }
}

thread_local! {
    /// The page's core (wasm is single-threaded: this is one static).
    static CORE: RefCell<Core> = RefCell::new(Core::new());
}

fn with<R>(f: impl FnOnce(&mut Core) -> R) -> R {
    CORE.with(|c| f(&mut c.borrow_mut()))
}

/// Reads an `INIT` record and returns a `MEMORY_NEEDED` record (both `anim-wire` family `core`);
/// on `STATUS_OK` the core restarts with those limits. Never throws: a malformed record is
/// answered with `STATUS_BAD_RECORD`.
#[wasm_bindgen]
pub fn init(record: &[u8]) -> Vec<u8> {
    with(|c| c.init(record)).encode()
}

/// The source hash the module was built from, as 32 lowercase hex digits.
#[wasm_bindgen]
pub fn source_hash() -> String {
    SOURCE_HASH.iter().map(|b| format!("{b:02x}")).collect()
}

/// Why the last call returning a handle returned 0 (`STATUS_*`).
#[wasm_bindgen]
pub fn last_status() -> u32 {
    with(|c| c.last_status())
}

/// Loads a `myco.skel@1` file (copied in); returns its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn load_skeleton(bytes: &[u8]) -> u32 {
    with(|c| c.load_skeleton(bytes))
}

/// Loads a `myco.anim@1` file (copied in); returns its handle, or 0.
#[wasm_bindgen]
pub fn load_clip(bytes: &[u8]) -> u32 {
    with(|c| c.load_clip(bytes))
}

/// Loads a `myco.animgraph@1` file (copied in); returns its handle, or 0.
#[wasm_bindgen]
pub fn load_graph(bytes: &[u8]) -> u32 {
    with(|c| c.load_graph(bytes))
}

/// Loads a bone mask (one weight per bone); returns its handle, or 0.
#[wasm_bindgen]
pub fn load_mask(weights: &[f32]) -> u32 {
    with(|c| c.load_mask(weights))
}

/// Releases an asset; returns a status.
#[wasm_bindgen]
pub fn release(handle: u32) -> u32 {
    with(|c| c.release(handle))
}

/// Binds a graph's string id to a clip or mask handle (0 unbinds); returns a status.
#[wasm_bindgen]
pub fn graph_bind(graph: u32, string_id: u32, asset: u32) -> u32 {
    with(|c| c.graph_bind(graph, string_id, asset))
}

/// Creates an instance; returns its handle, or 0.
#[wasm_bindgen]
pub fn create_instance(world: u32, skeleton: u32, graph: u32) -> u32 {
    with(|c| c.create_instance(world, skeleton, graph))
}

/// Destroys an instance; returns a status.
#[wasm_bindgen]
pub fn destroy_instance(handle: u32) -> u32 {
    with(|c| c.destroy_instance(handle))
}

/// The byte length of an instance's snapshot (0 for a stale handle).
#[wasm_bindgen]
pub fn snapshot_bytes(handle: u32) -> u32 {
    with(|c| c.snapshot_bytes(handle))
}

/// Writes an instance's snapshot into `out`; returns a status.
#[wasm_bindgen]
pub fn snapshot(handle: u32, out: &mut [u8]) -> u32 {
    with(|c| c.snapshot(handle, out))
}

/// Restores an instance from a snapshot; returns a status.
#[wasm_bindgen]
pub fn restore(handle: u32, bytes: &[u8]) -> u32 {
    with(|c| c.restore(handle, bytes))
}

/// Applies the first `len` bytes of the command buffer; returns the commands applied.
#[wasm_bindgen]
pub fn write_inputs(len: u32) -> u32 {
    with(|c| c.write_inputs(len))
}

/// Evaluates a World's instances in a pass; returns the state-change records waiting.
#[wasm_bindgen]
pub fn evaluate(world: u32, pass: u32, dt_scaled: f32, dt_unscaled: f32) -> u32 {
    with(|c| c.evaluate(world, pass, dt_scaled, dt_unscaled))
}

/// The input view's byte offset in memory.
#[wasm_bindgen]
pub fn inputs_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.inputs))
}

/// The command buffer's byte offset in memory (`COMMAND_BYTES` long).
#[wasm_bindgen]
pub fn commands_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.commands))
}

/// The bone-matrix view's byte offset in memory.
#[wasm_bindgen]
pub fn matrices_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.matrices))
}

/// The root-motion view's byte offset in memory.
#[wasm_bindgen]
pub fn roots_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.roots))
}

/// The state-change records' byte offset in memory.
#[wasm_bindgen]
pub fn changes_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.changes))
}

/// The track regions' byte offset in memory (`TRACK_STRIDE` bytes per instance index).
#[wasm_bindgen]
pub fn tracks_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.tracks))
}

/// Bytes of a clip's `COLUMN` records.
#[wasm_bindgen]
pub fn clip_column_bytes(clip: u32) -> u32 {
    with(|c| c.clip_column_bytes(clip))
}

/// Writes a clip's `COLUMN` records into `out`; returns the bytes written.
#[wasm_bindgen]
pub fn clip_columns(clip: u32, out: &mut [u8]) -> u32 {
    with(|c| c.clip_columns(clip, out))
}

/// State changes dropped this frame because the buffer was full.
#[wasm_bindgen]
pub fn changes_dropped() -> u32 {
    with(|c| c.changes_dropped())
}

/// The blackboard view's byte offset in memory (`graph` family, `BLACKBOARD_STRIDE` bytes per
/// instance index).
#[wasm_bindgen]
pub fn blackboard_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.blackboard))
}

/// The graph state-change records' byte offset in memory.
#[wasm_bindgen]
pub fn graph_changes_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.graph_changes.bytes))
}

/// The number of graph state-change records waiting (since the last `write_inputs`).
#[wasm_bindgen]
pub fn graph_change_count() -> u32 {
    with(|c| c.frame.graph_changes.count as u32)
}

/// The debug buffer's byte offset in memory (`debug` family, `DEBUG_BYTES` long).
#[wasm_bindgen]
pub fn debug_ptr() -> u32 {
    with(|c| Core::addr(&c.frame.debug))
}

/// Writes an instance's debug report into the debug buffer; returns its byte length (0 unless the
/// instance is flagged for debugging).
#[wasm_bindgen]
pub fn debug_write(handle: u32) -> u32 {
    with(|c| c.debug_write(handle))
}

/// The byte offset of a clip's or graph's file bytes in memory (0 for none).
#[wasm_bindgen]
pub fn asset_bytes_ptr(handle: u32) -> u32 {
    with(|c| c.asset_bytes_addr(handle) as u32)
}

// ---- T22r: tweens and timelines ----

/// Resizes the tween table (`DEFAULT_MAX_TWEENS` by default); drops every tween. Returns a status.
#[wasm_bindgen]
pub fn tweens_configure(max_tweens: u32) -> u32 {
    with(|c| c.tweens_configure(max_tweens))
}

/// Creates a tween from a `TWEEN_CREATE` record; returns its handle, or 0 (see `last_status`).
#[wasm_bindgen]
pub fn tween_create(record: &[u8]) -> u32 {
    with(|c| c.tween_create(record))
}

/// Applies a `TWEEN_CONTROL` record (pause, resume, kill, destroyed); returns a status.
#[wasm_bindgen]
pub fn tween_control(record: &[u8]) -> u32 {
    with(|c| c.tween_control(record))
}

/// Tween output rows this frame.
#[wasm_bindgen]
pub fn tween_values_count() -> u32 {
    with(|c| c.tweens.rows() as u32)
}

/// The byte offset of the tween rows' column ids (`u32` each).
#[wasm_bindgen]
pub fn tween_columns_ptr() -> u32 {
    with(|c| Core::addr(c.tweens.columns()))
}

/// The byte offset of the tween rows' values (four `f32` each).
#[wasm_bindgen]
pub fn tween_values_ptr() -> u32 {
    with(|c| Core::addr(c.tweens.values()))
}

/// `TWEEN_CHANGE` records this frame.
#[wasm_bindgen]
pub fn tween_changes_count() -> u32 {
    with(|c| c.tweens.change_count() as u32)
}

/// The byte offset of the tween change records.
#[wasm_bindgen]
pub fn tween_changes_ptr() -> u32 {
    with(|c| Core::addr(c.tweens.changes()))
}

/// Tween changes dropped this frame because the buffer was full.
#[wasm_bindgen]
pub fn tween_changes_dropped() -> u32 {
    with(|c| c.tweens.dropped())
}

/// Resizes the timeline table and the frame record buffer; drops every instance. Returns a status.
#[wasm_bindgen]
pub fn timelines_configure(max_timelines: u32, record_bytes: u32) -> u32 {
    with(|c| c.timelines_configure(max_timelines, record_bytes))
}

/// Creates an instance of a clip used as a timeline (`TIMELINE_CREATE`); returns its handle or 0.
#[wasm_bindgen]
pub fn timeline_create(record: &[u8]) -> u32 {
    with(|c| c.timeline_create(record))
}

/// Creates a sequence (`SEQ_CREATE` then its `SEQ_MEMBER` records); returns its handle or 0.
#[wasm_bindgen]
pub fn timeline_create_sequence(bytes: &[u8]) -> u32 {
    with(|c| c.timeline_create_sequence(bytes))
}

/// Binds a subclip string id of `owner`'s string table to a clip handle; returns a status. The
/// instance's outputs may move: read `timeline_info` after binding.
#[wasm_bindgen]
pub fn timeline_bind(instance: u32, owner: u32, string_id: u32, asset: u32) -> u32 {
    with(|c| c.timeline_bind(instance, owner, string_id, asset))
}

/// Applies a `TIMELINE_CONTROL` record; returns a status.
#[wasm_bindgen]
pub fn timeline_control(record: &[u8]) -> u32 {
    with(|c| c.timeline_control(record))
}

/// Writes an instance's `TIMELINE_INFO` into `out`; returns the bytes written (0: stale or short).
#[wasm_bindgen]
pub fn timeline_info(instance: u32, out: &mut [u8]) -> u32 {
    with(|c| c.timeline_info(instance, out))
}

/// Bytes of an instance's `TIMELINE_BLOCK` records.
#[wasm_bindgen]
pub fn timeline_block_bytes(instance: u32) -> u32 {
    with(|c| c.timeline_block_bytes(instance))
}

/// Writes an instance's `TIMELINE_BLOCK` records into `out`; returns the bytes written.
#[wasm_bindgen]
pub fn timeline_blocks(instance: u32, out: &mut [u8]) -> u32 {
    with(|c| c.timeline_blocks(instance, out))
}

/// Timeline instances evaluated this frame.
#[wasm_bindgen]
pub fn timeline_active_count() -> u32 {
    with(|c| c.timelines.active_count() as u32)
}

/// The byte offset of the evaluated instances' handles (`u32` each).
#[wasm_bindgen]
pub fn timeline_active_ptr() -> u32 {
    with(|c| Core::addr(c.timelines.active()))
}

/// The byte offset of the timeline value words.
#[wasm_bindgen]
pub fn timeline_values_ptr() -> u32 {
    with(|c| Core::addr(c.timelines.values()))
}

/// The byte offset of the timeline block weights (`f32` each).
#[wasm_bindgen]
pub fn timeline_weights_ptr() -> u32 {
    with(|c| Core::addr(c.timelines.weights()))
}

/// Bytes of `tracks` records the timelines wrote this frame.
#[wasm_bindgen]
pub fn timeline_records_len() -> u32 {
    with(|c| c.timelines.records().0.len() as u32)
}

/// How many `tracks` records the timelines wrote this frame.
#[wasm_bindgen]
pub fn timeline_records_count() -> u32 {
    with(|c| c.timelines.records().1)
}

/// How many `tracks` records did not fit this frame.
#[wasm_bindgen]
pub fn timeline_records_dropped() -> u32 {
    with(|c| c.timelines.records().2)
}

/// The byte offset of the timelines' `tracks` records.
#[wasm_bindgen]
pub fn timeline_records_ptr() -> u32 {
    with(|c| Core::addr(c.timelines.records_buffer()))
}

/// `TIMELINE_CHANGE` records this frame.
#[wasm_bindgen]
pub fn timeline_changes_count() -> u32 {
    with(|c| c.timelines.change_count() as u32)
}

/// The byte offset of the timeline change records.
#[wasm_bindgen]
pub fn timeline_changes_ptr() -> u32 {
    with(|c| Core::addr(c.timelines.changes()))
}

/// Timeline changes dropped this frame because the buffer was full.
#[wasm_bindgen]
pub fn timeline_changes_dropped() -> u32 {
    with(|c| c.timelines.changes_dropped())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(init: Init) -> MemoryNeeded {
        MemoryNeeded::decode(&Core::new().init(&init.encode()).encode())
            .expect("init answers with a MEMORY_NEEDED record")
    }

    #[test]
    fn answers_the_memory_needed() {
        let r = reply(Init {
            max_instances: 16,
            max_bones: 64,
            arena_initial_bytes: 1 << 20,
        });
        assert_eq!(r.status, STATUS_OK);
        assert!(r.bytes >= 1 << 20, "at least the arena");
        assert_eq!(r.pages as u64, (r.bytes as u64).div_ceil(PAGE_BYTES));
        let more = reply(Init {
            max_instances: 16,
            max_bones: 128,
            arena_initial_bytes: 1 << 20,
        });
        assert!(more.bytes > r.bytes, "more bones need more memory");
        let more = reply(Init {
            max_instances: 32,
            max_bones: 64,
            arena_initial_bytes: 1 << 20,
        });
        assert!(more.bytes > r.bytes, "more instances need more memory");
    }

    #[test]
    fn refuses_a_malformed_record() {
        let mut bytes = Init::default().encode();
        bytes[2] ^= 0xff;
        let r = MemoryNeeded::decode(&init(&bytes)).unwrap();
        assert_eq!(
            r,
            MemoryNeeded {
                status: STATUS_BAD_RECORD,
                bytes: 0,
                pages: 0
            }
        );
        let r = MemoryNeeded::decode(&init(&[1, 2, 3])).unwrap();
        assert_eq!(r.status, STATUS_BAD_RECORD);
    }

    #[test]
    fn reports_parameters_past_4_gib() {
        let r = reply(Init {
            max_instances: u32::MAX,
            max_bones: u32::MAX,
            arena_initial_bytes: 0,
        });
        assert_eq!(
            r,
            MemoryNeeded {
                status: STATUS_TOO_LARGE,
                bytes: 0,
                pages: 0
            }
        );
        let r = reply(Init {
            max_instances: 60_000,
            max_bones: 1_000,
            arena_initial_bytes: 0,
        });
        assert_eq!(r.status, STATUS_TOO_LARGE, "about 6 GB of views");
    }

    #[test]
    fn source_hash_is_32_hex_digits() {
        let h = source_hash();
        assert_eq!(h.len(), 32);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn calls_before_init_refuse() {
        let mut core = Core::new();
        assert_eq!(core.load_clip(&[0; 64]), 0);
        assert_eq!(core.last_status(), STATUS_NOT_INITIALIZED);
        assert_eq!(core.evaluate(0, 0, 0.1, 0.1), 0);
    }
}
