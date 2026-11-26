//! The standalone module's sequence player (ADR 0420): sequences and parallel groups without the
//! animation core, with the core's records and semantics.
//!
//! The program is `myco_tween::seq`'s (members at offsets, their evaluation and completion order),
//! the one the core's timelines run. Playing it is the core's timeline instance, cut down to what a
//! sequence uses: the playhead and its wrap modes, speed, play, pause, stop, seek, kill and
//! destroyed, one value block and one weight per member, and the `TimelineChange` records
//! (`CHANGE_MEMBER_DONE`, `CHANGE_LOOPED`, `CHANGE_FINISHED`, `CHANGE_KILLED`,
//! `CHANGE_DESTROYED`). The records are `anim-wire`'s `timeline` family (`SeqCreate`,
//! `SeqMember`, `TimelineControl`, `TimelineInfo`, `TimelineBlock`, `TimelineChange`), so a host
//! drives this player exactly as it drives the core's sequences; `tests/parity.rs` runs both on the
//! same records and compares every value and record.
//!
//! The playhead arithmetic is `anim-sample`'s `timeline::advance` for the cases a sequence reads
//! (the end time, loop wraps, pingpong legs, finishing); a sequence has no track windows, so only
//! a leg's direction is kept. The table is sized once ([`Sequences::new`]); creating allocates (a
//! setup call), updating never does.

use anim_wire::core::{STATUS_BAD_RECORD, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE};
use anim_wire::timeline::{
    SeqCreate, SeqMember, TimelineBlock, TimelineChange, TimelineControl, TimelineInfo,
    BLOCK_MEMBER, CHANGE_DESTROYED, CHANGE_FINISHED, CHANGE_KILLED, CHANGE_LOOPED,
    CHANGE_MEMBER_DONE, FLAG_PLAY, NONE, OP_DESTROYED, OP_KILL, OP_PAUSE, OP_PLAY, OP_SEEK,
    OP_SET_SPEED, OP_STOP, WRAP_HOLD, WRAP_LOOP, WRAP_PINGPONG,
};
use anim_wire::tween::{TIME_FIXED, TIME_UNSCALED};
use anim_wire::WireRecord;
use myco_tween::host::{handle, split, PASS_FIXED};
use myco_tween::seq::{self, Member};
use myco_tween::{Curves, Spec};

/// The most sequences (handle indices are 16 bits), as the core's `MAX_TIMELINES`.
pub const MAX_SEQUENCES: usize = 0xFFFF;
/// The most members of one sequence, as the core's.
pub const MAX_MEMBERS: u32 = 4096;
/// The most legs one pingpong move takes (`anim-sample`'s `MAX_LEGS`).
const MAX_LEGS: usize = 4;
/// A looping move is capped at this many durations (`anim-sample`'s `MAX_WRAPS`).
const MAX_WRAPS: f32 = 4.0;

fn finite_or(x: f32, default: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        default
    }
}

// ------------------------------------------------------------------------------------------------
// The playhead (`anim-sample` timeline's `Wrap`, `Playhead` and `advance`, for sequences)

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Wrap {
    Once,
    Hold,
    Loop,
    PingPong,
}

impl Wrap {
    fn from_id(id: u32) -> Wrap {
        match id {
            WRAP_HOLD => Wrap::Hold,
            WRAP_LOOP => Wrap::Loop,
            WRAP_PINGPONG => Wrap::PingPong,
            _ => Wrap::Once,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Playhead {
    time: f32,
    dir: f32,
}

impl Default for Playhead {
    fn default() -> Self {
        Playhead {
            time: 0.0,
            dir: 1.0,
        }
    }
}

/// What a move did: its legs' signed lengths (only their signs are read), whether it finished,
/// and how many times it wrapped or turned.
struct Advance {
    legs: [f32; MAX_LEGS],
    count: usize,
    finished: bool,
    wraps: u32,
}

/// `time` folded into a looping timeline of `d` seconds (`anim-pose`'s `SyncClip::wrap_time`).
fn wrap_time(d: f32, time: f32) -> f32 {
    if !(d > 0.0) || time.is_nan() || time.abs() == f32::INFINITY {
        return 0.0;
    }
    let t = time - (time / d).floor() * d;
    if t >= d || t < 0.0 {
        0.0
    } else {
        t
    }
}

/// Moves `head` by `delta` seconds in a timeline of `duration` (`anim-sample`'s `advance`).
fn advance(wrap: Wrap, duration: f32, head: &mut Playhead, delta: f32) -> Advance {
    let d = if duration > 0.0 { duration } else { 0.0 };
    let delta = finite_or(delta, 0.0);
    let t0 = if head.time > 0.0 {
        head.time.min(d)
    } else {
        0.0
    };
    let mut out = Advance {
        legs: [0.0; MAX_LEGS],
        count: 0,
        finished: false,
        wraps: 0,
    };
    match wrap {
        Wrap::Loop if d > 0.0 && d.is_finite() => {
            let capped = delta.clamp(-MAX_WRAPS * d, MAX_WRAPS * d);
            let a = t0 - (t0 / d).floor() * d;
            let b = a + capped;
            out.wraps = (b / d).floor().abs() as u32;
            out.legs[0] = delta;
            out.count = 1;
            // The looping window's end (`Window::end_time`): from and travel folded, travel capped.
            let start = wrap_time(d, t0);
            head.time = wrap_time(d, start + capped);
        }
        Wrap::PingPong if d > 0.0 => {
            let mut r = delta.abs();
            if d.is_finite() && r > 2.0 * d {
                r -= (r / (2.0 * d)).floor() * 2.0 * d;
            }
            let reversed = delta < 0.0;
            let mut dir = if reversed { -head.dir } else { head.dir };
            let mut t = t0;
            while out.count < MAX_LEGS && (r > 0.0 || out.count == 0) {
                let room = if dir > 0.0 { d - t } else { t };
                if r > room {
                    if room > 0.0 {
                        let to = if dir > 0.0 { d } else { 0.0 };
                        out.legs[out.count] = to - t;
                        out.count += 1;
                        r -= room;
                        t = to;
                    }
                    dir = -dir;
                    out.wraps += 1;
                } else {
                    let to = t + dir * r;
                    out.legs[out.count] = to - t;
                    out.count += 1;
                    t = to.clamp(0.0, d);
                    break;
                }
            }
            if out.count == 0 {
                out.legs[0] = 0.0;
                out.count = 1;
            }
            head.time = t;
            head.dir = if reversed { -dir } else { dir };
        }
        _ => {
            out.legs[0] = delta;
            out.count = 1;
            head.time = (t0 + delta).clamp(0.0, d);
            out.finished = (delta > 0.0 && head.time >= d) || (delta < 0.0 && head.time <= 0.0);
            if matches!(wrap, Wrap::Loop | Wrap::PingPong) {
                // A zero-length timeline can't wrap or turn and never finishes.
                out.finished = false;
            }
        }
    }
    out
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

// ------------------------------------------------------------------------------------------------
// The table

/// A member's value block, relative to its sequence's value offset.
#[derive(Clone, Copy)]
struct Block {
    offset: u32,
    words: u32,
    column: u32,
    host_id: u32,
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
    started: bool,
    finished: bool,
    /// A seek waiting for the next evaluation (the target), or NaN.
    seek: f32,
    /// Evaluate once at the playhead (created or stopped).
    dirty: bool,
    stop_pending: bool,
    duration: f32,
    value_off: u32,
    weight_off: u32,
    words: u32,
    blocks: Vec<Block>,
    members: Vec<Member>,
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
            members: Vec::new(),
            order: Vec::new(),
        }
    }
}

struct Slot {
    generation: u16,
    inst: Inst,
}

/// First-fit allocator over a growing array of words (the value and weight regions).
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
        if n == 0 || self.free.len() == self.free.capacity() {
            return; // a leak beats an allocation inside update; the capacity is sized to never fill
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

/// The sequence table: instances, their value and weight regions, the frame's change records and
/// the instances evaluated this frame.
#[derive(Default)]
pub struct Sequences {
    slots: Vec<Slot>,
    free: Vec<u16>,
    values: Vec<u32>,
    weights: Vec<f32>,
    value_regions: Regions,
    weight_regions: Regions,
    changes: Changes,
    active: Vec<u32>,
    active_count: usize,
}

impl Sequences {
    /// Bytes a table of `max` sequences takes (the members and values excluded: they grow with
    /// what is created).
    pub fn bytes_for(max: usize) -> u64 {
        let per = core::mem::size_of::<Slot>() + 4 + 4 * TimelineChange::STRIDE as usize + 16;
        (max as u64) * per as u64 + 16 * TimelineChange::STRIDE as u64
    }

    /// A table of `max` sequences (at most [`MAX_SEQUENCES`]).
    pub fn new(max: usize) -> Sequences {
        let max = max.min(MAX_SEQUENCES);
        let mut slots = Vec::with_capacity(max);
        for _ in 0..max {
            slots.push(Slot {
                generation: 1,
                inst: Inst::new(),
            });
        }
        Sequences {
            slots,
            free: (0..max as u16).rev().collect(),
            values: Vec::new(),
            weights: Vec::new(),
            value_regions: Regions::with_capacity(max + 2),
            weight_regions: Regions::with_capacity(max + 2),
            changes: Changes {
                buf: vec![0; (4 * max + 16) * TimelineChange::STRIDE as usize],
                ..Changes::default()
            },
            active: vec![0; max],
            active_count: 0,
        }
    }

    /// Clears the frame's change records and evaluated list.
    pub fn begin_frame(&mut self) {
        self.changes.count = 0;
        self.changes.dropped = 0;
        self.active_count = 0;
    }

    /// Creates a sequence from a [`SeqCreate`] record followed by its [`SeqMember`] records. `Err`
    /// is a `STATUS_*`.
    pub fn create(&mut self, record: &[u8]) -> Result<u32, u32> {
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
        let mut blocks = Vec::with_capacity(head.members as usize);
        let mut words = 0;
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
            blocks.push(Block {
                offset: words,
                words: spec.width as u32,
                column: m.column,
                host_id: m.host_id,
            });
            words += spec.width as u32;
            members.push(Member::new(spec, m.offset, m.host_id));
        }
        let duration = seq::duration(&members);
        let index = self.free.pop().ok_or(STATUS_FULL)? as usize;
        let generation = self.slots[index].generation;
        let (v, w) = self.allocate(words, blocks.len() as u32);
        let inst = &mut self.slots[index].inst;
        inst.live = true;
        inst.pending = Pending::None;
        inst.world = head.world;
        inst.host_id = head.host_id;
        inst.time_mode = head.time_mode;
        inst.wrap = Wrap::from_id(head.wrap);
        inst.speed = finite_or(head.speed, 1.0);
        inst.duration = if duration.is_finite() {
            (duration as f32).max(0.0)
        } else {
            f32::INFINITY
        };
        inst.head = Playhead::default();
        inst.playing = head.flags & FLAG_PLAY != 0;
        inst.started = false;
        inst.finished = false;
        inst.seek = f32::NAN;
        inst.stop_pending = false;
        inst.dirty = !inst.playing;
        inst.order = Vec::with_capacity(members.len());
        inst.members = members;
        inst.blocks = blocks;
        inst.value_off = v;
        inst.weight_off = w;
        inst.words = words;
        Ok(handle(index, generation))
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

    /// A sequence's [`TimelineInfo`], or `None` for a stale handle.
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

    /// Bytes of a sequence's block records (0 for a stale handle).
    pub fn block_bytes(&self, h: u32) -> usize {
        self.inst(h)
            .map_or(0, |i| i.blocks.len() * TimelineBlock::STRIDE as usize)
    }

    /// Writes a sequence's [`TimelineBlock`] records into `out`; the bytes written (0 for a stale
    /// handle or a short `out`).
    pub fn write_blocks(&self, h: u32, out: &mut [u8]) -> usize {
        let Some(inst) = self.inst(h) else {
            return 0;
        };
        let stride = TimelineBlock::STRIDE as usize;
        if out.len() < inst.blocks.len() * stride {
            return 0;
        }
        for (i, b) in inst.blocks.iter().enumerate() {
            let _ = TimelineBlock {
                index: i as u32,
                kind: BLOCK_MEMBER,
                offset: b.offset,
                words: b.words,
                track: i as u32,
                column: b.column,
                host_id: b.host_id,
            }
            .encode_into(&mut out[i * stride..]);
        }
        inst.blocks.len() * stride
    }

    fn inst(&self, h: u32) -> Option<&Inst> {
        let (index, generation) = split(h);
        self.slots
            .get(index)
            .filter(|s| s.generation == generation && s.inst.live)
            .map(|s| &s.inst)
    }

    /// Sequences evaluated this frame (handles; [`Sequences::active_count`] are valid).
    pub fn active(&self) -> &[u32] {
        &self.active
    }

    /// How many of [`Sequences::active`] are valid.
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

    /// Advances the sequences of `world` in `pass`. Never allocates.
    pub fn update<C: Curves + ?Sized>(
        &mut self,
        curves: &C,
        world: u32,
        pass: u32,
        dt_scaled: f32,
        dt_unscaled: f32,
    ) {
        for index in 0..self.slots.len() {
            let inst = &self.slots[index].inst;
            if !inst.live || inst.world != world {
                continue;
            }
            let h = handle(index, self.slots[index].generation);
            if inst.pending != Pending::None {
                let kind = if inst.pending == Pending::Kill {
                    CHANGE_KILLED
                } else {
                    CHANGE_DESTROYED
                };
                let change = TimelineChange {
                    instance: h,
                    host_id: inst.host_id,
                    kind,
                    member: NONE,
                    time: inst.head.time,
                };
                self.changes.push(change);
                self.retire(index);
                continue;
            }
            if (inst.time_mode == TIME_FIXED) != (pass == PASS_FIXED) {
                continue;
            }
            let base = if inst.time_mode == TIME_UNSCALED {
                dt_unscaled
            } else {
                dt_scaled
            };
            let delta = finite_or(base, 0.0) * inst.speed;
            self.frame(curves, index, h, delta);
        }
    }

    /// One sequence's frame: a pending stop and seek, then the playing move.
    fn frame<C: Curves + ?Sized>(&mut self, curves: &C, index: usize, h: u32, delta: f32) {
        let Sequences {
            slots,
            values,
            weights,
            changes,
            active,
            active_count,
            ..
        } = self;
        let inst = &mut slots[index].inst;
        let mut evaluated = false;
        let mut retire = false;
        if inst.stop_pending {
            inst.stop_pending = false;
            for m in inst.members.iter_mut() {
                m.done = false;
            }
            inst.head = Playhead::default();
            inst.started = false;
            inst.finished = false;
            inst.seek = f32::NAN;
            inst.dirty = true;
        }
        // A seek, or the first look at a created or stopped sequence: no completions.
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
            eval(curves, inst, values, weights, changes, h, t, false);
            inst.head.time = t;
            evaluated = true;
        }
        if inst.playing {
            let adv = advance(inst.wrap, inst.duration, &mut inst.head, delta);
            let (d, forward) = (inst.duration, delta >= 0.0);
            match inst.wrap {
                Wrap::Loop if adv.wraps > 0 => {
                    let edge = if forward { d } else { 0.0 };
                    eval(curves, inst, values, weights, changes, h, edge, true);
                }
                Wrap::PingPong => {
                    for i in 0..adv.count.saturating_sub(1) {
                        let edge = if adv.legs[i] >= 0.0 { d } else { 0.0 };
                        eval(curves, inst, values, weights, changes, h, edge, true);
                    }
                }
                _ => {}
            }
            let t = inst.head.time;
            eval(curves, inst, values, weights, changes, h, t, true);
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
        if evaluated && *active_count < active.len() {
            active[*active_count] = h;
            *active_count += 1;
        }
        if retire {
            self.retire(index);
        }
    }
}

/// Evaluates every member at time `t` (writes the blocks) and reports the members that completed
/// (`emit`), ordered by completion time.
#[allow(clippy::too_many_arguments)]
fn eval<C: Curves + ?Sized>(
    curves: &C,
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
        curves,
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
    for &i in &inst.order {
        let m = &inst.members[i as usize];
        changes.push(TimelineChange {
            instance: h,
            host_id: inst.host_id,
            kind: CHANGE_MEMBER_DONE,
            member: m.host_id,
            time: (m.end() as f32).min(t),
        });
    }
}
