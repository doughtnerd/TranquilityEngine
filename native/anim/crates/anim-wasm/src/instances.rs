//! Feature `instances`: the instance table (handles are index plus generation, so a handle to a
//! destroyed Animator is a no-op), per-instance state snapshot and restore, and the LOD fields.
//!
//! # An instance
//!
//! One Animator: a skeleton handle, a graph handle (0: the implicit graph, [`implicit`]), the
//! World it belongs to, and what evaluation keeps between frames, allocated at creation:
//!
//! - the graph state blob (`Program::state_words` words: parameters, playheads, fades, layer
//!   masks, inertialization buffers);
//! - the last two evaluated local poses and the time between them (update-rate LOD interpolates
//!   between them; inertialization measures velocity from them);
//! - LOD counters (frames since the last evaluation, time since it, a stale flag after culling).
//!
//! Its row in every view is its handle's index.
//!
//! # Snapshot
//!
//! [`Table::snapshot`] writes all of that (not the host's input row) as little-endian `u32`
//! words: a header ([`SNAPSHOT_HEADER_WORDS`]: magic, version, graph and skeleton handles, state
//! words, bone groups, history count, frames since evaluation, history step, time since
//! evaluation, stale flag, reserved), the state blob, then the two poses. Restoring it into an
//! instance of the same graph and skeleton makes every later evaluation identical to the
//! original's (prediction rollback, ADR 0370).

pub mod implicit;

use anim_graph::eval::{pose_from_words, pose_to_words, Program, SOA_WORDS};
use anim_math::layout::{soa_len, LANES};
use anim_math::SoaTransform;
use anim_sample::FrameCache;
use anim_wire::core::{
    Init, HANDLE_INDEX_MASK, STATUS_BAD_RECORD, STATUS_FULL, STATUS_MISMATCH, STATUS_OK,
    STATUS_STALE_HANDLE,
};

use crate::assets::{handle, split};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// per instance its table entry, the implicit graph's state blob for `max_bones`, and its two
/// history poses.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    let groups = soa_len(init.max_bones as usize) as u64;
    let program = &implicit::program();
    let state = program.state_words(groups as usize) as u64 * 4;
    let poses = 2 * groups * core::mem::size_of::<SoaTransform>() as u64;
    let bones = groups as usize * LANES;
    let players = (player_slots(program)
        * (FrameCache::header_len(bones) * 4
            + FrameCache::frames_len(bones) * core::mem::size_of::<SoaTransform>()))
        as u64;
    let entry = core::mem::size_of::<Slot>() as u64;
    (init.max_instances as u64).saturating_mul(entry + state + poses + players)
}

/// T82r: frame-cache slots for `program`: one per clip player (`Program::clip_players`).
pub(crate) fn player_slots(program: &Program) -> usize {
    program.clip_players()
}

/// Snapshot magic (`"ANSN"` little-endian).
pub const SNAPSHOT_MAGIC: u32 = 0x4E53_4E41;
/// Snapshot layout version.
pub const SNAPSHOT_VERSION: u32 = 1;
/// Words before the state blob.
pub const SNAPSHOT_HEADER_WORDS: usize = 12;

/// One live instance.
pub struct Instance {
    pub world: u32,
    pub skeleton: u32,
    /// 0: the implicit graph.
    pub graph: u32,
    pub groups: usize,
    pub state: Vec<u32>,
    pub last: Vec<SoaTransform>,
    pub prev: Vec<SoaTransform>,
    /// Evaluated poses held (0, 1 or 2).
    pub history: u32,
    /// Seconds between `prev` and `last`.
    pub history_dt: f32,
    /// Frames since the last pose evaluation.
    pub since: u32,
    /// Seconds advanced since the last pose evaluation.
    pub dt_since: f32,
    /// The pose froze (culled); the next evaluation restarts the history.
    pub stale: bool,
    /// Flagged for the graph debugger (`graph` family `DEBUG`; not part of snapshots).
    pub debug: bool,
    /// T82r: the clip players' frame caches (`anim_sample::FrameCache`, a slot per clip player
    /// of the program): the slots' headers and their frames. Not part of snapshots: the pose
    /// doesn't depend on them.
    pub player_headers: Vec<u32>,
    pub player_frames: Vec<SoaTransform>,
    /// T82r: the instance's row of the bone-matrix view holds `last`'s matrices (the last frame
    /// it was visible showed `last` itself, not an LOD blend), so a frame showing a `last` with
    /// the same bits skips rebuilding them. Not part of snapshots (a restore clears it).
    pub shown_last: bool,
    /// T70: the bones whose model-space and skinning matrices `evaluate` writes (`set_eval_mask`:
    /// a mask's bones with weight above 0 and their ancestors); empty: every bone. A server World
    /// sets it to the bones gameplay reads. Not part of snapshots (host state, like the input row).
    pub eval_bones: Vec<bool>,
}

struct Slot {
    generation: u16,
    instance: Option<Instance>,
}

/// The instance table.
#[derive(Default)]
pub struct Table {
    slots: Vec<Slot>,
    free: Vec<u16>,
    capacity: usize,
}

impl Table {
    /// A table for at most `capacity` instances.
    pub fn new(capacity: usize) -> Table {
        Table {
            slots: Vec::with_capacity(capacity),
            free: Vec::new(),
            capacity: capacity.min(HANDLE_INDEX_MASK as usize),
        }
    }

    /// Creates an instance with a fresh state blob; the caller initialises it.
    pub fn create(
        &mut self,
        world: u32,
        skeleton: u32,
        graph: u32,
        program: &Program,
        groups: usize,
    ) -> Result<u32, u32> {
        let instance = Instance {
            world,
            skeleton,
            graph,
            groups,
            state: vec![0; program.state_words(groups)],
            last: vec![SoaTransform::identity(); groups],
            prev: vec![SoaTransform::identity(); groups],
            history: 0,
            history_dt: 0.0,
            since: 0,
            dt_since: 0.0,
            stale: false,
            debug: false,
            shown_last: false,
            eval_bones: Vec::new(),
            player_headers: vec![0; player_slots(program) * FrameCache::header_len(groups * LANES)],
            player_frames: vec![
                SoaTransform::identity();
                player_slots(program) * FrameCache::frames_len(groups * LANES)
            ],
        };
        if let Some(index) = self.free.pop() {
            let slot = &mut self.slots[index as usize];
            slot.instance = Some(instance);
            return Ok(handle(index as usize, slot.generation));
        }
        if self.slots.len() >= self.capacity {
            return Err(STATUS_FULL);
        }
        self.slots.push(Slot {
            generation: 1,
            instance: Some(instance),
        });
        Ok(handle(self.slots.len() - 1, 1))
    }

    /// Destroys an instance; its handle goes stale.
    pub fn destroy(&mut self, h: u32) -> u32 {
        let (index, generation) = split(h);
        match self.slots.get_mut(index) {
            Some(slot) if slot.generation == generation && slot.instance.is_some() => {
                slot.instance = None;
                slot.generation = slot.generation.wrapping_add(1).max(1);
                self.free.push(index as u16);
                STATUS_OK
            }
            _ => STATUS_STALE_HANDLE,
        }
    }

    /// The live instance of `h`.
    pub fn get_mut(&mut self, h: u32) -> Result<&mut Instance, u32> {
        let (index, generation) = split(h);
        match self.slots.get_mut(index) {
            Some(Slot {
                generation: g,
                instance: Some(i),
            }) if *g == generation => Ok(i),
            _ => Err(STATUS_STALE_HANDLE),
        }
    }

    /// Every live instance with its handle.
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (u32, &mut Instance)> + '_ {
        self.slots.iter_mut().enumerate().filter_map(|(i, s)| {
            let g = s.generation;
            s.instance.as_mut().map(|inst| (handle(i, g), inst))
        })
    }

    /// The snapshot size of `h` in bytes.
    pub fn snapshot_bytes(&mut self, h: u32) -> Result<u32, u32> {
        let inst = self.get_mut(h)?;
        Ok(snapshot_words(inst) as u32 * 4)
    }

    /// Writes `h`'s snapshot into `out` (at least [`Table::snapshot_bytes`] long).
    pub fn snapshot(&mut self, h: u32, out: &mut [u8]) -> u32 {
        let inst = match self.get_mut(h) {
            Ok(i) => i,
            Err(e) => return e,
        };
        let words = snapshot_words(inst);
        if out.len() < words * 4 {
            return STATUS_BAD_RECORD;
        }
        let header = [
            SNAPSHOT_MAGIC,
            SNAPSHOT_VERSION,
            inst.graph,
            inst.skeleton,
            inst.state.len() as u32,
            inst.groups as u32,
            inst.history,
            inst.since,
            inst.history_dt.to_bits(),
            inst.dt_since.to_bits(),
            inst.stale as u32,
            0,
        ];
        let g = inst.groups * SOA_WORDS;
        let mut poses = vec![0u32; 2 * g];
        pose_to_words(&inst.last, &mut poses[..g]);
        pose_to_words(&inst.prev, &mut poses[g..]);
        let all = header.iter().chain(&inst.state).chain(&poses);
        for (w, o) in all.zip(out.as_chunks_mut::<4>().0) {
            o.copy_from_slice(&w.to_le_bytes());
        }
        STATUS_OK
    }

    /// Restores `h` from a snapshot of an instance of the same graph and skeleton.
    pub fn restore(&mut self, h: u32, bytes: &[u8]) -> u32 {
        let inst = match self.get_mut(h) {
            Ok(i) => i,
            Err(e) => return e,
        };
        let word = |i: usize| -> Option<u32> {
            bytes
                .get(4 * i..4 * i + 4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        };
        let words = snapshot_words(inst);
        if bytes.len() != words * 4
            || word(0) != Some(SNAPSHOT_MAGIC)
            || word(1) != Some(SNAPSHOT_VERSION)
        {
            return STATUS_BAD_RECORD;
        }
        if word(2) != Some(inst.graph)
            || word(3) != Some(inst.skeleton)
            || word(4) != Some(inst.state.len() as u32)
            || word(5) != Some(inst.groups as u32)
        {
            return STATUS_MISMATCH;
        }
        let read = |i: usize| word(i).unwrap_or(0);
        let history = read(6).min(2);
        let (since, history_dt, dt_since, stale) = (
            read(7),
            f32::from_bits(read(8)),
            f32::from_bits(read(9)),
            read(10) != 0,
        );
        let n = inst.state.len();
        let base = SNAPSHOT_HEADER_WORDS;
        for (i, s) in inst.state.iter_mut().enumerate() {
            *s = read(base + i);
        }
        let g = inst.groups * SOA_WORDS;
        let mut poses = vec![0u32; 2 * g];
        for (i, p) in poses.iter_mut().enumerate() {
            *p = read(base + n + i);
        }
        pose_from_words(&poses[..g], &mut inst.last);
        pose_from_words(&poses[g..], &mut inst.prev);
        inst.history = history;
        inst.since = since;
        inst.history_dt = history_dt;
        inst.dt_since = dt_since;
        inst.stale = stale;
        inst.shown_last = false;
        STATUS_OK
    }
}

fn snapshot_words(inst: &Instance) -> usize {
    SNAPSHOT_HEADER_WORDS + inst.state.len() + 2 * inst.groups * SOA_WORDS
}
