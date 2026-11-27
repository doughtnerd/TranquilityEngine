//! Feature `timeline`: timeline programs and their sampling (wire family `timeline`, whose docs
//! define what a timeline is, its commands, wrap modes, views and blocks).
//!
//! # Shape
//!
//! [`Timelines`] is a table of instance slots (handles are `generation << 16 | index`), sized once
//! (`timelines_configure`): creating and binding allocate (setup calls), updating never does. An
//! instance is a playhead ([`anim_sample::timeline`]) over a [`Source`]:
//!
//! - **a clip used as a timeline:** each frame the playhead's windows go to the root clip's
//!   [`BoundClip::evaluate`] (its property columns become block 0, its keyed tracks' records go
//!   to the record buffer), and every `subclip` record it produces drives a nested clip: the nested
//!   window is `(local_time - local_delta, local_delta)` with [`WINDOW_START`] when the entry was
//!   entered (T20r's note), the weight is the entry's blend weight times its parent's. Depth 1
//!   entries' columns are mixed per subclip track into that track's block
//!   ([`anim_sample::timeline::mix_add`]); deeper entries contribute records only. A [`Node`] per
//!   subclip key (and per nesting path) keeps that entry's notify-state bits; they end when the
//!   entry is exited, the timeline is stopped, killed or retired.
//! - **a sequence:** tween members at offsets (`myco_tween::seq`'s program over [`Spec`]s, ADR
//!   0424 spike), one block each.
//!
//! # Outputs
//!
//! Instances write into two global regions (`values`: u32 words; `weights`: one f32 per block)
//! allocated at creation, plus the frame's `tracks` records, [`TimelineChange`] records and the
//! list of instances evaluated this frame. `begin_frame` clears the records, changes and list.
//! Values of an instance retired this frame stay readable until the next create or bind.

use anim_format::clip::KeyData;
use anim_format::NONE;
use anim_sample::timeline::{
    advance, mix_add, mix_begin, mix_resolve, Playhead, SubclipTrack, Wrap,
};
use anim_sample::{
    TrackRecord, TrackSink, Window, SUBCLIP_ENTERED, SUBCLIP_EXITED, WINDOW_SEEK, WINDOW_START,
};
use anim_wire::core::{
    Init, PASS_FIXED, STATUS_BAD_RECORD, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE,
};
use anim_wire::timeline::{
    SeqCreate, SeqMember, TimelineBlock, TimelineChange, TimelineControl, TimelineCreate,
    TimelineInfo, BLOCK_MEMBER, BLOCK_ROOT, BLOCK_SUBCLIP, CHANGE_DESTROYED, CHANGE_FINISHED,
    CHANGE_KILLED, CHANGE_LOOPED, CHANGE_MEMBER_DONE, DEFAULT_MAX_TIMELINES, DEFAULT_RECORD_BYTES,
    FLAG_PLAY, MAX_DEPTH, OP_DESTROYED, OP_KILL, OP_PAUSE, OP_PLAY, OP_SEEK, OP_SET_SPEED, OP_STOP,
};
use anim_wire::tween::TIME_FIXED;
use anim_wire::tween::TIME_UNSCALED;
use anim_wire::WireRecord;

use crate::assets::{handle, split, Arena};
use crate::tracks::RecordWriter;
use crate::tweens::Spec;
use myco_tween::seq::{self, Member};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the default table, its record buffer and an estimate of its values.
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    Timelines::bytes_for(
        DEFAULT_MAX_TIMELINES as usize,
        DEFAULT_RECORD_BYTES as usize,
    )
}

/// The most timeline instances (handle indices are 16 bits).
pub const MAX_TIMELINES: usize = 0xFFFF;
/// The most members of one sequence.
pub const MAX_MEMBERS: u32 = 4096;
/// Subclip records one frame's evaluation of one instance can hold (more are dropped).
const SUBS_CAPACITY: usize = 256;

/// A subclip record waiting to drive its nested clip.
#[derive(Clone, Copy)]
struct Sub {
    key: u32,
    flags: u32,
    local_time: f32,
    local_delta: f32,
    weight: f32,
}

/// The node of one subclip key at one nesting path: its clip and its notify-state words.
#[derive(Clone, Copy)]
struct Node {
    parent: u32,
    /// The clip whose key this is.
    owner: u32,
    key: u32,
    /// The bound nested clip handle, 0 when unbound.
    asset: u32,
    open: u32,
    words: u32,
    /// The value block a depth-1 node mixes into, or `NONE`.
    block: u32,
}

#[derive(Clone, Copy)]
struct Block {
    kind: u32,
    /// Relative to the instance's value offset.
    offset: u32,
    words: u32,
    track: u32,
    column: u32,
    host_id: u32,
    /// A subclip block's layout clip (0 otherwise).
    layout: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pending {
    None,
    Kill,
    Destroy,
}

struct Inst {
    live: bool,
    pending: Pending,
    world: u32,
    host_id: u32,
    time_mode: u32,
    wrap: Wrap,
    speed: f32,
    head: Playhead,
    playing: bool,
    /// The first playing window has run.
    started: bool,
    finished: bool,
    /// A seek waiting for the next evaluation (the target), or NaN.
    seek: f32,
    /// Evaluate once at the playhead (created or stopped).
    dirty: bool,
    /// A stop waiting for the next evaluation.
    stop_pending: bool,
    duration: f32,
    value_off: u32,
    weight_off: u32,
    words: u32,
    blocks: Vec<Block>,
    // Clip source.
    root: u32,
    binds: Vec<[u32; 3]>,
    nodes: Vec<Node>,
    root_open: u32,
    open: Vec<u32>,
    scratch: Vec<u32>,
    acc: Vec<u32>,
    best: Vec<f32>,
    totals: Vec<f32>,
    // Sequence source.
    members: Vec<Member>,
    is_seq: bool,
    order: Vec<u32>,
}

impl Inst {
    fn new() -> Inst {
        Inst {
            live: false,
            pending: Pending::None,
            world: 0,
            host_id: 0,
            time_mode: 0,
            wrap: Wrap::Once,
            speed: 1.0,
            head: Playhead::default(),
            playing: false,
            started: false,
            finished: false,
            seek: f32::NAN,
            dirty: false,
            stop_pending: false,
            duration: 0.0,
            value_off: 0,
            weight_off: 0,
            words: 0,
            blocks: Vec::new(),
            root: 0,
            binds: Vec::new(),
            nodes: Vec::new(),
            root_open: 0,
            open: Vec::new(),
            scratch: Vec::new(),
            acc: Vec::new(),
            best: Vec::new(),
            totals: Vec::new(),
            members: Vec::new(),
            is_seq: false,
            order: Vec::new(),
        }
    }
}

struct Slot {
    generation: u16,
    inst: Inst,
}

/// The frame's `tracks` records, packed back to back across instances.
#[derive(Default)]
struct Records {
    buf: Vec<u8>,
    len: usize,
    count: u32,
    dropped: u32,
}

/// The frame's [`TimelineChange`] records.
#[derive(Default)]
struct Changes {
    buf: Vec<u8>,
    count: usize,
    dropped: u32,
}

impl Changes {
    fn push(&mut self, change: TimelineChange) {
        let stride = TimelineChange::STRIDE as usize;
        let at = self.count * stride;
        match self.buf.get_mut(at..at + stride) {
            Some(out) => {
                let _ = change.encode_into(out);
                self.count += 1;
            }
            None => self.dropped = self.dropped.saturating_add(1),
        }
    }
}

/// First-fit allocator over a growing array of words (for the value and weight regions).
#[derive(Default)]
struct Regions {
    free: Vec<(u32, u32)>,
    end: u32,
}

impl Regions {
    fn with_capacity(n: usize) -> Regions {
        Regions {
            free: Vec::with_capacity(n),
            end: 0,
        }
    }

    /// Offset of `n` words; the caller grows its array to [`Regions::end`] when it grew.
    fn alloc(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        if let Some(i) = self.free.iter().position(|&(_, len)| len >= n) {
            let (off, len) = self.free[i];
            if len == n {
                self.free.remove(i);
            } else {
                self.free[i] = (off + n, len - n);
            }
            return off;
        }
        let off = self.end;
        self.end += n;
        off
    }

    /// Returns a region (within the reserved capacity, so it never allocates).
    fn release(&mut self, off: u32, n: u32) {
        if n == 0 {
            return;
        }
        if self.free.len() == self.free.capacity() {
            return; // a leak beats an allocation inside evaluate; the capacity is sized to never fill
        }
        self.free.push((off, n));
        self.free.sort_unstable();
        let mut w = 0;
        for r in 0..self.free.len() {
            let cur = self.free[r];
            if w > 0 && self.free[w - 1].0 + self.free[w - 1].1 == cur.0 {
                self.free[w - 1].1 += cur.1;
            } else {
                self.free[w] = cur;
                w += 1;
            }
        }
        self.free.truncate(w);
    }
}

/// The timeline table.
#[derive(Default)]
pub struct Timelines {
    slots: Vec<Slot>,
    free: Vec<u16>,
    values: Vec<u32>,
    weights: Vec<f32>,
    value_regions: Regions,
    weight_regions: Regions,
    rec: Records,
    changes: Changes,
    active: Vec<u32>,
    active_count: usize,
    subs: Vec<Sub>,
}

fn finite_or(x: f32, default: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        default
    }
}

impl Timelines {
    /// Bytes a table of `max` instances and `record_bytes` of records uses (the instances'
    /// values excluded: they grow with what is created).
    pub fn bytes_for(max: usize, record_bytes: usize) -> u64 {
        let per = core::mem::size_of::<Slot>() + 4 + 2 * TimelineChange::STRIDE as usize + 16;
        (max as u64) * per as u64 + record_bytes as u64
    }

    /// A table of `max` instances (at most [`MAX_TIMELINES`]) and `record_bytes` of frame records.
    pub fn new(max: usize, record_bytes: usize) -> Timelines {
        let max = max.min(MAX_TIMELINES);
        let mut slots = Vec::with_capacity(max);
        for _ in 0..max {
            slots.push(Slot {
                generation: 1,
                inst: Inst::new(),
            });
        }
        Timelines {
            slots,
            free: (0..max as u16).rev().collect(),
            values: Vec::new(),
            weights: Vec::new(),
            value_regions: Regions::with_capacity(max + 2),
            weight_regions: Regions::with_capacity(max + 2),
            rec: Records {
                buf: vec![0; record_bytes],
                ..Records::default()
            },
            changes: Changes {
                buf: vec![0; (4 * max + 16) * TimelineChange::STRIDE as usize],
                ..Changes::default()
            },
            active: vec![0; max],
            active_count: 0,
            subs: Vec::with_capacity(SUBS_CAPACITY),
        }
    }

    /// Clears the frame's records, changes and evaluated list (a frame's start).
    pub fn begin_frame(&mut self) {
        self.rec.len = 0;
        self.rec.count = 0;
        self.rec.dropped = 0;
        self.changes.count = 0;
        self.changes.dropped = 0;
        self.active_count = 0;
    }

    fn live(&mut self, h: u32) -> Option<&mut Inst> {
        let (index, generation) = split(h);
        match self.slots.get_mut(index) {
            Some(s)
                if s.generation == generation && s.inst.live && s.inst.pending == Pending::None =>
            {
                Some(&mut s.inst)
            }
            _ => None,
        }
    }

    fn allocate(&mut self, words: u32, blocks: u32) -> (u32, u32) {
        let v = self.value_regions.alloc(words);
        let w = self.weight_regions.alloc(blocks);
        let (vend, wend) = (
            self.value_regions.end as usize,
            self.weight_regions.end as usize,
        );
        if self.values.len() < vend {
            self.values.resize(vend, 0);
        }
        if self.weights.len() < wend {
            self.weights.resize(wend, 0.0);
        }
        self.values[v as usize..(v + words) as usize].fill(0);
        self.weights[w as usize..(w + blocks) as usize].fill(0.0);
        (v, w)
    }

    /// Creates an instance of the clip `c.clip` used as a timeline. `Err` is a `STATUS_*`.
    pub fn create_clip(&mut self, arena: &Arena, record: &[u8]) -> Result<u32, u32> {
        let c = TimelineCreate::decode(record).map_err(|_| STATUS_BAD_RECORD)?;
        let duration = arena.clip_asset(c.clip)?.duration;
        let index = self.free.pop().ok_or(STATUS_FULL)? as usize;
        let inst = &mut self.slots[index].inst;
        inst.reset(
            c.world,
            c.host_id,
            c.time_mode,
            c.wrap,
            c.speed,
            c.flags,
            c.start,
            duration,
        );
        inst.root = c.clip;
        inst.is_seq = false;
        let generation = self.slots[index].generation;
        if let Err(e) = self.relayout(arena, index) {
            self.discard(index);
            return Err(e);
        }
        Ok(handle(index, generation))
    }

    /// Creates a sequence from a [`SeqCreate`] record followed by its [`SeqMember`] records.
    pub fn create_sequence(&mut self, record: &[u8]) -> Result<u32, u32> {
        let head = SeqCreate::decode(record).map_err(|_| STATUS_BAD_RECORD)?;
        if head.members > MAX_MEMBERS {
            return Err(STATUS_BAD_RECORD);
        }
        let stride = SeqMember::STRIDE as usize;
        let body = &record[(SeqCreate::STRIDE as usize).min(record.len())..];
        if body.len() < stride * head.members as usize {
            return Err(STATUS_BAD_RECORD);
        }
        let mut members = Vec::with_capacity(head.members as usize);
        for i in 0..head.members as usize {
            let m = SeqMember::decode(&body[i * stride..]).map_err(|_| STATUS_BAD_RECORD)?;
            let spec = Spec::new(
                m.value_kind,
                m.width,
                m.ease,
                m.flags,
                m.loops,
                m.duration,
                m.delay,
                [m.from0, m.from1, m.from2, m.from3],
                [m.to0, m.to1, m.to2, m.to3],
            )
            .ok_or(STATUS_BAD_RECORD)?;
            members.push(Member::new(spec, m.offset, m.host_id));
        }
        let duration = seq::duration(&members);
        let index = self.free.pop().ok_or(STATUS_FULL)? as usize;
        let generation = self.slots[index].generation;
        let mut blocks = Vec::with_capacity(members.len());
        let mut words = 0;
        for (i, m) in members.iter().enumerate() {
            blocks.push(Block {
                kind: BLOCK_MEMBER,
                offset: words,
                words: m.spec.width as u32,
                track: i as u32,
                column: 0,
                host_id: m.host_id,
                layout: 0,
            });
            words += m.spec.width as u32;
        }
        // Columns come from the member records again (the spec doesn't keep them).
        for (i, b) in blocks.iter_mut().enumerate() {
            if let Ok(m) = SeqMember::decode(&body[i * stride..]) {
                b.column = m.column;
            }
        }
        let (v, w) = self.allocate(words, blocks.len() as u32);
        let inst = &mut self.slots[index].inst;
        let d = if duration.is_finite() {
            duration as f32
        } else {
            f32::INFINITY
        };
        inst.reset(
            head.world,
            head.host_id,
            head.time_mode,
            head.wrap,
            head.speed,
            head.flags,
            0.0,
            d,
        );
        inst.is_seq = true;
        inst.members = members;
        inst.order = Vec::with_capacity(inst.members.len());
        inst.blocks = blocks;
        inst.value_off = v;
        inst.weight_off = w;
        inst.words = words;
        Ok(handle(index, generation))
    }

    /// Frees a slot that never went live.
    fn discard(&mut self, index: usize) {
        let inst = &mut self.slots[index].inst;
        self.value_regions.release(inst.value_off, inst.words);
        self.weight_regions
            .release(inst.weight_off, inst.blocks.len() as u32);
        inst.live = false;
        inst.words = 0;
        inst.blocks.clear();
        self.free.push(index as u16);
    }

    /// Binds a subclip string id of `owner`'s string table to a clip, then lays the instance out
    /// again (its value region may move: read `info` after binding). A `STATUS_*`.
    pub fn bind(&mut self, arena: &Arena, h: u32, owner: u32, string_id: u32, asset: u32) -> u32 {
        let (index, _) = split(h);
        let Some(inst) = self.live(h) else {
            return STATUS_STALE_HANDLE;
        };
        if inst.is_seq {
            return STATUS_BAD_RECORD;
        }
        if asset != 0 && arena.clip_asset(asset).is_err() {
            return STATUS_STALE_HANDLE;
        }
        match inst
            .binds
            .iter_mut()
            .find(|b| b[0] == owner && b[1] == string_id)
        {
            Some(b) => b[2] = asset,
            None => inst.binds.push([owner, string_id, asset]),
        }
        match self.relayout(arena, index) {
            Ok(()) => STATUS_OK,
            Err(e) => e,
        }
    }

    /// Builds the nodes and blocks of a clip instance and (re)allocates its outputs.
    fn relayout(&mut self, arena: &Arena, index: usize) -> Result<(), u32> {
        let root = arena.clip_asset(self.slots[index].inst.root)?;
        let inst = &mut self.slots[index].inst;
        let old = (
            inst.value_off,
            inst.words,
            inst.weight_off,
            inst.blocks.len() as u32,
        );
        inst.nodes.clear();
        let mut open_words = root.bindings.notify_words() as u32;
        inst.root_open = 0;
        build_nodes(
            arena,
            &inst.binds,
            inst.root,
            NONE,
            1,
            &mut inst.nodes,
            &mut open_words,
        );
        inst.open.clear();
        inst.open.resize(open_words as usize, 0);

        inst.blocks.clear();
        let root_words = root.bindings.column_words() as u32;
        inst.blocks.push(Block {
            kind: BLOCK_ROOT,
            offset: 0,
            words: root_words,
            track: 0,
            column: NONE,
            host_id: NONE,
            layout: inst.root,
        });
        let mut words = root_words;
        let mut max_scratch = 0usize;
        let tracks: Vec<SubclipTrack> = root.bindings.subclip_tracks().collect();
        for t in tracks {
            // The block's layout is the first bound entry's clip.
            let first = inst.nodes.iter().find(|n| {
                n.parent == NONE
                    && n.owner == inst.root
                    && n.asset != 0
                    && n.key >= t.first_key
                    && n.key < t.first_key + t.key_count
            });
            let Some(layout_asset) = first.map(|n| n.asset) else {
                continue;
            };
            let Ok(layout) = arena.clip_asset(layout_asset) else {
                continue;
            };
            let block = inst.blocks.len() as u32;
            let w = layout.bindings.column_words() as u32;
            inst.blocks.push(Block {
                kind: BLOCK_SUBCLIP,
                offset: words,
                words: w,
                track: t.track,
                column: NONE,
                host_id: NONE,
                layout: layout_asset,
            });
            words += w;
            max_scratch = max_scratch.max(w as usize);
            for n in inst.nodes.iter_mut() {
                let compatible = n.parent == NONE
                    && n.owner == inst.root
                    && n.key >= t.first_key
                    && n.key < t.first_key + t.key_count
                    && arena
                        .clip_asset(n.asset)
                        .is_ok_and(|a| layout.bindings.same_layout(&a.bindings));
                if compatible {
                    n.block = block;
                }
            }
        }
        inst.scratch.clear();
        inst.scratch.resize(max_scratch, 0);
        inst.acc.clear();
        inst.acc.resize(words as usize, 0);
        inst.best.clear();
        inst.best.resize(words as usize, 0.0);
        inst.totals.clear();
        inst.totals.resize(inst.blocks.len(), 0.0);
        inst.words = words;
        let nblocks = inst.blocks.len() as u32;
        if old.1 != words || old.3 != nblocks {
            self.value_regions.release(old.0, old.1);
            self.weight_regions.release(old.2, old.3);
            let (v, w) = self.allocate(words, nblocks);
            let inst = &mut self.slots[index].inst;
            inst.value_off = v;
            inst.weight_off = w;
        }
        Ok(())
    }

    /// Applies a [`TimelineControl`] record's bytes; a `STATUS_*`.
    pub fn control(&mut self, record: &[u8]) -> u32 {
        let Ok(c) = TimelineControl::decode(record) else {
            return STATUS_BAD_RECORD;
        };
        let Some(inst) = self.live(c.handle) else {
            return STATUS_STALE_HANDLE;
        };
        match c.op {
            OP_PLAY => {
                if inst.finished {
                    inst.head = Playhead {
                        time: if inst.speed >= 0.0 {
                            0.0
                        } else {
                            inst.duration
                        },
                        dir: 1.0,
                    };
                    inst.started = false;
                    inst.finished = false;
                }
                inst.playing = true;
            }
            OP_PAUSE => inst.playing = false,
            OP_STOP => {
                inst.playing = false;
                inst.stop_pending = true;
            }
            OP_SEEK => inst.seek = finite_or(c.value, 0.0),
            OP_SET_SPEED => inst.speed = finite_or(c.value, 1.0),
            OP_KILL => inst.pending = Pending::Kill,
            OP_DESTROYED => inst.pending = Pending::Destroy,
            _ => return STATUS_BAD_RECORD,
        }
        STATUS_OK
    }

    /// An instance's [`TimelineInfo`], or `None` for a stale handle.
    pub fn info(&self, h: u32) -> Option<TimelineInfo> {
        let (index, generation) = split(h);
        let s = self.slots.get(index)?;
        (s.generation == generation && s.inst.live).then_some(TimelineInfo {
            instance: h,
            value_offset: s.inst.value_off,
            value_words: s.inst.words,
            weight_offset: s.inst.weight_off,
            blocks: s.inst.blocks.len() as u32,
            duration: s.inst.duration,
        })
    }

    /// Bytes of an instance's block records (0 for a stale handle).
    pub fn block_bytes(&self, h: u32) -> usize {
        let (index, generation) = split(h);
        self.slots
            .get(index)
            .filter(|s| s.generation == generation && s.inst.live)
            .map_or(0, |s| s.inst.blocks.len() * TimelineBlock::STRIDE as usize)
    }

    /// Writes an instance's [`TimelineBlock`] records into `out`; the bytes written (0 for a stale
    /// handle or a short `out`).
    pub fn write_blocks(&self, h: u32, out: &mut [u8]) -> usize {
        let (index, generation) = split(h);
        let Some(s) = self
            .slots
            .get(index)
            .filter(|s| s.generation == generation && s.inst.live)
        else {
            return 0;
        };
        let stride = TimelineBlock::STRIDE as usize;
        if out.len() < s.inst.blocks.len() * stride {
            return 0;
        }
        for (i, b) in s.inst.blocks.iter().enumerate() {
            let _ = TimelineBlock {
                index: i as u32,
                kind: b.kind,
                offset: b.offset,
                words: b.words,
                track: b.track,
                column: b.column,
                host_id: b.host_id,
            }
            .encode_into(&mut out[i * stride..]);
        }
        s.inst.blocks.len() * stride
    }

    /// Instances evaluated this frame (handles).
    pub fn active(&self) -> &[u32] {
        &self.active
    }

    /// How many of [`Timelines::active`] are valid.
    pub fn active_count(&self) -> usize {
        self.active_count
    }

    /// The value words.
    pub fn values(&self) -> &[u32] {
        &self.values
    }

    /// The block weights.
    pub fn weights(&self) -> &[f32] {
        &self.weights
    }

    /// The frame's `tracks` records (bytes written, count, dropped).
    pub fn records(&self) -> (&[u8], u32, u32) {
        (
            &self.rec.buf[..self.rec.len],
            self.rec.count,
            self.rec.dropped,
        )
    }

    /// The records buffer, whole (for its address).
    pub fn records_buffer(&self) -> &[u8] {
        &self.rec.buf
    }

    /// The change records' count.
    pub fn change_count(&self) -> usize {
        self.changes.count
    }

    /// The change buffer.
    pub fn changes(&self) -> &[u8] {
        &self.changes.buf
    }

    /// Changes dropped this frame.
    pub fn changes_dropped(&self) -> u32 {
        self.changes.dropped
    }

    fn retire(&mut self, index: usize) {
        let slot = &mut self.slots[index];
        slot.inst.live = false;
        slot.generation = slot.generation.wrapping_add(1).max(1);
        self.value_regions
            .release(slot.inst.value_off, slot.inst.words);
        self.weight_regions
            .release(slot.inst.weight_off, slot.inst.blocks.len() as u32);
        self.free.push(index as u16);
    }

    /// Advances the instances of `world` in `pass`. Never allocates.
    pub fn update(
        &mut self,
        arena: &Arena,
        world: u32,
        pass: u32,
        dt_scaled: f32,
        dt_unscaled: f32,
    ) {
        for index in 0..self.slots.len() {
            if !self.slots[index].inst.live || self.slots[index].inst.world != world {
                continue;
            }
            let generation = self.slots[index].generation;
            let h = handle(index, generation);
            let pending = self.slots[index].inst.pending;
            if pending != Pending::None {
                let (kind, time, host_id) = {
                    let i = &self.slots[index].inst;
                    let kind = if pending == Pending::Kill {
                        CHANGE_KILLED
                    } else {
                        CHANGE_DESTROYED
                    };
                    (kind, i.head.time, i.host_id)
                };
                if pending == Pending::Kill {
                    self.run(arena, index, h, Step::EndStates);
                }
                self.changes.push(TimelineChange {
                    instance: h,
                    host_id,
                    kind,
                    member: NONE,
                    time,
                });
                self.retire(index);
                continue;
            }
            let inst = &self.slots[index].inst;
            if (inst.time_mode == TIME_FIXED) != (pass == PASS_FIXED) {
                continue;
            }
            let base = if inst.time_mode == TIME_UNSCALED {
                dt_unscaled
            } else {
                dt_scaled
            };
            let delta = finite_or(base, 0.0) * inst.speed;
            self.run(arena, index, h, Step::Frame(delta));
        }
    }
}

/// What [`Timelines::run`] does to an instance.
enum Step {
    /// A frame: pending stop and seek, then the playing windows.
    Frame(f32),
    /// End every open notify state (killed).
    EndStates,
}

/// Where a clip instance's window records go: subclip records wait in `subs`, the rest go to the
/// frame's record writer.
struct Collect<'a, 'w> {
    writer: &'a mut RecordWriter<'w>,
    subs: &'a mut Vec<Sub>,
}

impl TrackSink for Collect<'_, '_> {
    fn push(&mut self, record: TrackRecord) {
        if let TrackRecord::Subclip {
            key,
            flags,
            local_time,
            local_delta,
            weight,
            ..
        } = record
        {
            if self.subs.len() < SUBS_CAPACITY {
                self.subs.push(Sub {
                    key,
                    flags,
                    local_time,
                    local_delta,
                    weight,
                });
            }
        } else {
            self.writer.push(record);
        }
    }
}

fn lookup(binds: &[[u32; 3]], owner: u32, id: u32) -> u32 {
    binds
        .iter()
        .find(|b| b[0] == owner && b[1] == id)
        .map_or(0, |b| b[2])
}

/// Builds the node list below clip `owner`: one node per subclip key, depth-first.
fn build_nodes(
    arena: &Arena,
    binds: &[[u32; 3]],
    owner: u32,
    parent: u32,
    depth: u32,
    nodes: &mut Vec<Node>,
    open_words: &mut u32,
) {
    let Ok(c) = arena.clip_asset(owner) else {
        return;
    };
    let mut ki = 0;
    while let Some(k) = c.bindings.key(ki) {
        if let KeyData::Subclip { clip: sid, .. } = k.data {
            let asset = lookup(binds, owner, sid);
            let nested = arena.clip_asset(asset).ok();
            let words = nested.map_or(0, |a| a.bindings.notify_words() as u32);
            let index = nodes.len() as u32;
            nodes.push(Node {
                parent,
                owner,
                key: ki as u32,
                asset: if nested.is_some() { asset } else { 0 },
                open: *open_words,
                words,
                block: NONE,
            });
            *open_words += words;
            if nested.is_some() && depth < MAX_DEPTH - 1 {
                build_nodes(arena, binds, asset, index, depth + 1, nodes, open_words);
            }
        }
        ki += 1;
    }
}

impl Inst {
    #[allow(clippy::too_many_arguments)]
    fn reset(
        &mut self,
        world: u32,
        host_id: u32,
        time_mode: u32,
        wrap: u32,
        speed: f32,
        flags: u32,
        start: f32,
        duration: f32,
    ) {
        self.live = true;
        self.pending = Pending::None;
        self.world = world;
        self.host_id = host_id;
        self.time_mode = time_mode;
        self.wrap = Wrap::from_id(wrap);
        self.speed = finite_or(speed, 1.0);
        self.duration = if duration > 0.0 { duration } else { 0.0 };
        let t = finite_or(start, 0.0);
        self.head = Playhead {
            time: t.clamp(0.0, self.duration),
            dir: 1.0,
        };
        self.playing = flags & FLAG_PLAY != 0;
        self.started = false;
        self.finished = false;
        self.seek = f32::NAN;
        self.stop_pending = false;
        self.dirty = !self.playing;
        self.value_off = 0;
        self.weight_off = 0;
        self.words = 0;
        self.blocks.clear();
        self.binds.clear();
        self.nodes.clear();
        self.open.clear();
        self.members.clear();
    }
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/// What one clip instance's windows write: its output regions and where records go.
struct Ctx<'a, 'w> {
    arena: &'a Arena,
    nodes: &'a [Node],
    blocks: &'a [Block],
    open: &'a mut [u32],
    scratch: &'a mut [u32],
    acc: &'a mut [u32],
    best: &'a mut [f32],
    totals: &'a mut [f32],
    writer: &'a mut RecordWriter<'w>,
    subs: &'a mut Vec<Sub>,
    seek: bool,
}

impl Ctx<'_, '_> {
    /// Drives the nested clips of the subclip records in `subs[start..]` (the records `owner`'s
    /// evaluation just produced, under `parent`), recursing into theirs. `depth` is the nesting
    /// level of these entries (1: directly under the root).
    fn children(&mut self, parent: u32, owner: u32, depth: u32, parent_weight: f32, start: usize) {
        let end = self.subs.len();
        for i in start..end {
            let s = self.subs[i];
            let Some(ni) = self
                .nodes
                .iter()
                .position(|n| n.parent == parent && n.owner == owner && n.key == s.key)
            else {
                continue;
            };
            let node = self.nodes[ni];
            let Ok(clip) = self.arena.clip_asset(node.asset) else {
                continue;
            };
            let Some(bound) = clip.bound() else {
                continue;
            };
            let w = s.weight * parent_weight;
            let window = Window {
                from: s.local_time - s.local_delta,
                delta: s.local_delta,
                looping: clip.bindings.looping(),
                flags: if self.seek { WINDOW_SEEK } else { 0 }
                    | if s.flags & SUBCLIP_ENTERED != 0 {
                        WINDOW_START
                    } else {
                        0
                    },
            };
            let n = clip.bindings.column_words();
            let mix = depth == 1 && node.block != NONE && w > 0.0 && n <= self.scratch.len();
            let cols: &mut [u32] = if mix {
                let c = &mut self.scratch[..n];
                c.fill(0);
                c
            } else {
                &mut []
            };
            let open = &mut self.open[node.open as usize..(node.open + node.words) as usize];
            self.writer.set_clip(node.asset);
            let at = self.subs.len();
            let mut sink = Collect {
                writer: &mut *self.writer,
                subs: &mut *self.subs,
            };
            bound.evaluate(&window, w, open, cols, &mut sink);
            if mix {
                let b = self.blocks[node.block as usize];
                if let Ok(layout) = self.arena.clip_asset(b.layout) {
                    let range = b.offset as usize..(b.offset + b.words) as usize;
                    mix_add(
                        &layout.bindings,
                        &mut self.acc[range.clone()],
                        &mut self.best[range],
                        &self.scratch[..n],
                        w,
                    );
                    self.totals[node.block as usize] += w;
                }
            }
            self.children(ni as u32, node.asset, depth + 1, w, at);
            self.subs.truncate(at);
            if s.flags & SUBCLIP_EXITED != 0 {
                self.end_node(ni, s.local_time);
            }
        }
    }

    /// Ends the open notify states of node `ni` and of every node below it.
    fn end_node(&mut self, ni: usize, time: f32) {
        let node = self.nodes[ni];
        if let Ok(clip) = self.arena.clip_asset(node.asset) {
            let open = &mut self.open[node.open as usize..(node.open + node.words) as usize];
            self.writer.set_clip(node.asset);
            clip.bindings
                .end_notify_states(time, 0.0, open, &mut *self.writer);
        }
        for j in 0..self.nodes.len() {
            if self.nodes[j].parent == ni as u32 {
                self.end_node(j, time);
            }
        }
    }
}

/// Splits a clip instance into a [`Ctx`] and runs `f` with it and the instance's output slices.
#[allow(clippy::too_many_arguments)]
fn with_ctx<R>(
    arena: &Arena,
    inst: &mut Inst,
    values: &mut [u32],
    weights: &mut [f32],
    writer: &mut RecordWriter<'_>,
    subs: &mut Vec<Sub>,
    seek: bool,
    f: impl FnOnce(&mut Ctx<'_, '_>, &mut [u32], &mut [f32], &[Block]) -> R,
) -> R {
    let v0 = inst.value_off as usize;
    let w0 = inst.weight_off as usize;
    let (nodes, blocks) = (&inst.nodes, &inst.blocks);
    let out_v = &mut values[v0..v0 + inst.words as usize];
    let out_w = &mut weights[w0..w0 + blocks.len()];
    let mut ctx = Ctx {
        arena,
        nodes,
        blocks,
        open: &mut inst.open,
        scratch: &mut inst.scratch,
        acc: &mut inst.acc,
        best: &mut inst.best,
        totals: &mut inst.totals,
        writer,
        subs,
        seek,
    };
    f(&mut ctx, out_v, out_w, blocks)
}

/// Evaluates the root clip over one window and the subclip entries it drives; writes the blocks.
fn eval_clip_window(
    arena: &Arena,
    inst: &mut Inst,
    values: &mut [u32],
    weights: &mut [f32],
    writer: &mut RecordWriter<'_>,
    subs: &mut Vec<Sub>,
    window: Window,
) {
    let Ok(root) = arena.clip_asset(inst.root) else {
        return;
    };
    let Some(bound) = root.bound() else {
        return;
    };
    let root_words = root.bindings.notify_words();
    let root_handle = inst.root;
    let seek = window.flags & WINDOW_SEEK != 0;
    with_ctx(
        arena,
        inst,
        values,
        weights,
        writer,
        subs,
        seek,
        |ctx, out_v, out_w, blocks| {
            for (i, b) in blocks.iter().enumerate().skip(1) {
                let r = b.offset as usize..(b.offset + b.words) as usize;
                mix_begin(&mut ctx.acc[r.clone()], &mut ctx.best[r]);
                ctx.totals[i] = 0.0;
            }
            let root_cols = &mut out_v[..blocks[0].words as usize];
            ctx.writer.set_clip(root_handle);
            let at = ctx.subs.len();
            let mut sink = Collect {
                writer: &mut *ctx.writer,
                subs: &mut *ctx.subs,
            };
            bound.evaluate(
                &window,
                1.0,
                &mut ctx.open[..root_words],
                root_cols,
                &mut sink,
            );
            ctx.children(NONE, root_handle, 1, 1.0, at);
            ctx.subs.truncate(at);
            out_w[0] = 1.0;
            for (i, b) in blocks.iter().enumerate().skip(1) {
                let total = ctx.totals[i];
                if total > 0.0 {
                    if let Ok(layout) = ctx.arena.clip_asset(b.layout) {
                        let r = b.offset as usize..(b.offset + b.words) as usize;
                        mix_resolve(&layout.bindings, &ctx.acc[r.clone()], total, &mut out_v[r]);
                    }
                    out_w[i] = total.min(1.0);
                } else {
                    out_w[i] = 0.0;
                }
            }
        },
    );
}

/// Ends every open notify state of a clip instance (killed, stopped, retired) and clears them.
fn end_all(
    arena: &Arena,
    inst: &mut Inst,
    values: &mut [u32],
    weights: &mut [f32],
    writer: &mut RecordWriter<'_>,
    subs: &mut Vec<Sub>,
    time: f32,
) {
    let Ok(root) = arena.clip_asset(inst.root) else {
        return;
    };
    let root_words = root.bindings.notify_words();
    let root_handle = inst.root;
    with_ctx(
        arena,
        inst,
        values,
        weights,
        writer,
        subs,
        false,
        |ctx, _, _, _| {
            ctx.writer.set_clip(root_handle);
            root.bindings.end_notify_states(
                time,
                0.0,
                &mut ctx.open[..root_words],
                &mut *ctx.writer,
            );
            for j in 0..ctx.nodes.len() {
                if ctx.nodes[j].parent == NONE {
                    ctx.end_node(j, time);
                }
            }
            ctx.open.fill(0);
        },
    );
}

/// Evaluates every sequence member at time `t` (writes the blocks) and reports the members that
/// completed (`emit`), ordered by completion time.
#[allow(clippy::too_many_arguments)]
fn eval_seq(
    arena: &Arena,
    inst: &mut Inst,
    values: &mut [u32],
    weights: &mut [f32],
    changes: &mut Changes,
    h: u32,
    t: f32,
    emit: bool,
) {
    let v0 = inst.value_off as usize;
    let w0 = inst.weight_off as usize;
    let blocks = &inst.blocks;
    seq::eval(
        arena,
        &mut inst.members,
        t,
        emit,
        &mut inst.order,
        |i, value| {
            let b = blocks[i];
            if let Some(v) = value {
                for (k, x) in v.iter().enumerate().take(b.words as usize) {
                    values[v0 + b.offset as usize + k] = x.to_bits();
                }
                weights[w0 + i] = 1.0;
            } else {
                weights[w0 + i] = 0.0;
            }
        },
    );
    let members = &inst.members;
    let end = |i: u32| members[i as usize].end();
    for &i in &inst.order {
        changes.push(TimelineChange {
            instance: h,
            host_id: inst.host_id,
            kind: CHANGE_MEMBER_DONE,
            member: members[i as usize].host_id,
            time: (end(i) as f32).min(t),
        });
    }
}

impl Timelines {
    /// One instance's step (see [`Step`]).
    fn run(&mut self, arena: &Arena, index: usize, h: u32, step: Step) {
        let Timelines {
            slots,
            values,
            weights,
            rec,
            changes,
            active,
            active_count,
            subs,
            ..
        } = self;
        let inst = &mut slots[index].inst;
        let start = rec.len.min(rec.buf.len());
        let mut writer = RecordWriter::new(&mut rec.buf[start..], h);
        let mut evaluated = false;
        let mut retire = false;
        match step {
            Step::EndStates => {
                if !inst.is_seq {
                    let t = inst.head.time;
                    end_all(arena, inst, values, weights, &mut writer, subs, t);
                }
            }
            Step::Frame(delta) => {
                // A stop: end the open states, rewind, and show time 0.
                if inst.stop_pending {
                    inst.stop_pending = false;
                    if inst.is_seq {
                        for m in inst.members.iter_mut() {
                            m.done = false;
                        }
                    } else {
                        let t = inst.head.time;
                        end_all(arena, inst, values, weights, &mut writer, subs, t);
                    }
                    inst.head = Playhead::default();
                    inst.started = false;
                    inst.finished = false;
                    inst.seek = f32::NAN;
                    inst.dirty = true;
                }
                // A seek, or the first look at a created or stopped instance: no events.
                let target = if !inst.seek.is_nan() {
                    let s = inst.seek;
                    inst.seek = f32::NAN;
                    Some(wrap_seek(inst.wrap, inst.duration, s))
                } else if inst.dirty {
                    Some(inst.head.time)
                } else {
                    None
                };
                inst.dirty = false;
                if let Some(t) = target {
                    if inst.is_seq {
                        eval_seq(arena, inst, values, weights, changes, h, t, false);
                        inst.head.time = t;
                    } else {
                        let from = inst.head.time;
                        let w = Window::new(from, t - from, false).with(WINDOW_SEEK);
                        eval_clip_window(arena, inst, values, weights, &mut writer, subs, w);
                        inst.head.time = (from + (t - from)).clamp(0.0, inst.duration);
                    }
                    evaluated = true;
                }
                if inst.playing {
                    let first = !inst.started;
                    let adv = advance(inst.wrap, inst.duration, &mut inst.head, delta, first);
                    if inst.is_seq {
                        let (d, forward) = (inst.duration, delta >= 0.0);
                        match inst.wrap {
                            Wrap::Loop if adv.wraps > 0 => {
                                let edge = if forward { d } else { 0.0 };
                                eval_seq(arena, inst, values, weights, changes, h, edge, true);
                            }
                            Wrap::PingPong => {
                                let n = adv.count;
                                for (i, w) in adv.windows().iter().enumerate() {
                                    if i + 1 < n {
                                        let edge = if w.delta >= 0.0 { d } else { 0.0 };
                                        eval_seq(
                                            arena, inst, values, weights, changes, h, edge, true,
                                        );
                                    }
                                }
                            }
                            _ => {}
                        }
                        let t = inst.head.time;
                        eval_seq(arena, inst, values, weights, changes, h, t, true);
                    } else {
                        for w in adv.windows() {
                            eval_clip_window(arena, inst, values, weights, &mut writer, subs, *w);
                        }
                    }
                    inst.started = true;
                    evaluated = true;
                    if adv.wraps > 0 {
                        changes.push(TimelineChange {
                            instance: h,
                            host_id: inst.host_id,
                            kind: CHANGE_LOOPED,
                            member: NONE,
                            time: inst.head.time,
                        });
                    }
                    if adv.finished && !inst.finished {
                        inst.finished = true;
                        inst.playing = false;
                        changes.push(TimelineChange {
                            instance: h,
                            host_id: inst.host_id,
                            kind: CHANGE_FINISHED,
                            member: NONE,
                            time: inst.head.time,
                        });
                        retire = inst.wrap == Wrap::Once;
                    }
                }
                if retire && !inst.is_seq {
                    let t = inst.head.time;
                    end_all(arena, inst, values, weights, &mut writer, subs, t);
                }
            }
        }
        let header = writer.header(0);
        rec.len = start + header.record_bytes as usize;
        rec.count += header.record_count;
        rec.dropped += header.dropped;
        if evaluated && *active_count < active.len() {
            active[*active_count] = h;
            *active_count += 1;
        }
        if retire {
            self.retire(index);
        }
    }
}

/// A seek target folded into the timeline: wrapped for loops, clamped otherwise.
fn wrap_seek(wrap: Wrap, duration: f32, t: f32) -> f32 {
    if wrap == Wrap::Loop && duration > 0.0 && duration.is_finite() {
        let r = t - (t / duration).floor() * duration;
        if r >= 0.0 && r < duration {
            r
        } else {
            0.0
        }
    } else {
        t.clamp(0.0, duration)
    }
}
