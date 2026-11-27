//! The tween table: Penner easings by id or an engine curve, loops, time scales, a destroyed flag
//! (wire family [`crate::wire`], whose docs define the commands, views and timing).
//!
//! # Shape
//!
//! [`Tweens`] is a table of slots (a handle is `generation << 16 | index`, never 0), sized once
//! (the host's `tweens_configure`, default [`DEFAULT_MAX_TWEENS`](crate::wire::DEFAULT_MAX_TWEENS)): creating, controlling and
//! updating never allocate. The host owns the memory budget: [`Tweens::bytes_for`] is what a table
//! of `max` tweens takes (the animation core sums it into `init`'s `bytes_needed`).
//!
//! # Per frame
//!
//! [`Tweens::update`] advances the tweens of a World whose time mode belongs to the pass, in slot
//! order, and appends their rows to the value view (column id, four floats) and their state
//! records to the change buffer; [`Tweens::begin_frame`] clears both (the host's `write_inputs`).
//! A kill or destroy command takes effect at once (the tween leaves the output) and its record is
//! written by the next update of its World.
//!
//! Moved from `anim-wasm/src/tweens.rs` (ADR 0424 spike); unchanged but for the curve lookup.

use alloc::vec;
use alloc::vec::Vec;
use myco_wire::WireRecord;

use crate::host::{
    handle, split, PASS_FIXED, STATUS_BAD_RECORD, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE,
};
use crate::spec::{finite_or, Curves, Spec};
use crate::wire::{
    TweenChange, TweenControl, TweenCreate, CHANGE_COMPLETED, CHANGE_DESTROYED, CHANGE_KILLED,
    CHANGE_LOOP, OP_DESTROYED, OP_KILL, OP_PAUSE, OP_RESUME, TIME_FIXED, TIME_UNSCALED,
};

/// The most tweens a table can hold (handle indices are 16 bits).
pub const MAX_TWEENS: usize = 0xFFFF;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Free,
    Running,
    Paused,
    Kill,
    Destroy,
}

#[derive(Clone, Copy)]
struct Slot {
    generation: u16,
    state: State,
    world: u32,
    host_id: u32,
    column: u32,
    time_mode: u32,
    speed: f32,
    elapsed: f64,
    cycle: u32,
    spec: Spec,
}

const EMPTY_SPEC: Spec = Spec {
    kind: 0,
    width: 1,
    ease: 0,
    yoyo: false,
    loops: 1,
    duration: 0.0,
    delay: 0.0,
    from: [0.0; 4],
    to: [0.0; 4],
};

const EMPTY: Slot = Slot {
    generation: 1,
    state: State::Free,
    world: 0,
    host_id: 0,
    column: 0,
    time_mode: 0,
    speed: 1.0,
    elapsed: 0.0,
    cycle: 0,
    spec: EMPTY_SPEC,
};

/// The tween table.
#[derive(Default)]
pub struct Tweens {
    slots: Vec<Slot>,
    free: Vec<u16>,
    /// Output rows: the column id of row `i`.
    columns: Vec<u32>,
    /// Output rows: four floats per row.
    values: Vec<f32>,
    rows: usize,
    changes: Vec<u8>,
    change_count: usize,
    dropped: u32,
}

impl Tweens {
    /// Bytes a table of `max` tweens uses.
    pub fn bytes_for(max: usize) -> u64 {
        let per = core::mem::size_of::<Slot>() + 2 + 4 + 16 + 2 * TweenChange::STRIDE as usize;
        (max as u64) * per as u64
    }

    /// A table of `max` tweens (at most [`MAX_TWEENS`]).
    pub fn new(max: usize) -> Tweens {
        let max = max.min(MAX_TWEENS);
        Tweens {
            slots: vec![EMPTY; max],
            free: (0..max as u16).rev().collect(),
            columns: vec![0; max],
            values: vec![0.0; max * 4],
            rows: 0,
            changes: vec![0; 2 * max * TweenChange::STRIDE as usize],
            change_count: 0,
            dropped: 0,
        }
    }

    /// Tweens alive.
    pub fn len(&self) -> usize {
        self.slots.len() - self.free.len()
    }

    /// Whether no tween is alive.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Clears the value rows and the change records (a frame's start).
    pub fn begin_frame(&mut self) {
        self.rows = 0;
        self.change_count = 0;
        self.dropped = 0;
    }

    /// Creates a tween from a [`TweenCreate`] record's bytes. `Err` is a `STATUS_*`.
    pub fn create(&mut self, record: &[u8]) -> Result<u32, u32> {
        let c = TweenCreate::decode(record).map_err(|_| STATUS_BAD_RECORD)?;
        let spec = Spec::from_create(&c).ok_or(STATUS_BAD_RECORD)?;
        let index = self.free.pop().ok_or(STATUS_FULL)? as usize;
        let slot = &mut self.slots[index];
        let generation = slot.generation;
        *slot = Slot {
            generation,
            state: State::Running,
            world: c.world,
            host_id: c.host_id,
            column: c.column,
            time_mode: c.time_mode,
            speed: finite_or(c.speed, 1.0).max(0.0),
            elapsed: 0.0,
            cycle: 0,
            spec,
        };
        Ok(handle(index, generation))
    }

    fn live(&mut self, h: u32) -> Option<&mut Slot> {
        let (index, generation) = split(h);
        match self.slots.get_mut(index) {
            Some(s)
                if s.generation == generation
                    && matches!(s.state, State::Running | State::Paused) =>
            {
                Some(s)
            }
            _ => None,
        }
    }

    /// Applies a [`TweenControl`] record's bytes; a `STATUS_*`.
    pub fn control(&mut self, record: &[u8]) -> u32 {
        let Ok(c) = TweenControl::decode(record) else {
            return STATUS_BAD_RECORD;
        };
        let Some(slot) = self.live(c.handle) else {
            return STATUS_STALE_HANDLE;
        };
        match c.op {
            OP_PAUSE => slot.state = State::Paused,
            OP_RESUME => slot.state = State::Running,
            OP_KILL => slot.state = State::Kill,
            OP_DESTROYED => slot.state = State::Destroy,
            _ => return STATUS_BAD_RECORD,
        }
        STATUS_OK
    }

    fn push_change(&mut self, change: TweenChange) {
        let stride = TweenChange::STRIDE as usize;
        let at = self.change_count * stride;
        match self.changes.get_mut(at..at + stride) {
            Some(out) => {
                let _ = change.encode_into(out);
                self.change_count += 1;
            }
            None => self.dropped = self.dropped.saturating_add(1),
        }
    }

    fn release(&mut self, index: usize) {
        let slot = &mut self.slots[index];
        slot.state = State::Free;
        slot.generation = slot.generation.wrapping_add(1).max(1);
        self.free.push(index as u16);
    }

    /// Advances the tweens of `world` in `pass` (see the module docs); curve easings are read
    /// from `curves` (a type parameter, see [`Curves`]). Never allocates.
    pub fn update<C: Curves + ?Sized>(
        &mut self,
        curves: &C,
        world: u32,
        pass: u32,
        dt_scaled: f32,
        dt_unscaled: f32,
    ) {
        for index in 0..self.slots.len() {
            let head = &self.slots[index];
            if head.state == State::Free || head.world != world {
                continue;
            }
            let s = *head;
            let h = handle(index, s.generation);
            match s.state {
                State::Kill | State::Destroy => {
                    let kind = if s.state == State::Kill {
                        CHANGE_KILLED
                    } else {
                        CHANGE_DESTROYED
                    };
                    self.push_change(TweenChange {
                        host_id: s.host_id,
                        handle: h,
                        kind,
                        cycle: s.cycle,
                    });
                    self.release(index);
                    continue;
                }
                State::Paused => continue,
                _ => {}
            }
            if (s.time_mode == TIME_FIXED) != (pass == PASS_FIXED) {
                continue;
            }
            let base = if s.time_mode == TIME_UNSCALED {
                dt_unscaled
            } else {
                dt_scaled
            };
            let dt = finite_or(base, 0.0).max(0.0) * s.speed;
            let elapsed = s.elapsed + dt as f64;
            let mut v = [0.0f32; 4];
            let e = s.spec.eval(elapsed, curves, &mut v);
            self.slots[index].elapsed = elapsed;
            if e.started {
                self.columns[self.rows] = s.column;
                self.values[self.rows * 4..self.rows * 4 + 4].copy_from_slice(&v);
                self.rows += 1;
                if e.cycle > s.cycle && !e.done {
                    self.push_change(TweenChange {
                        host_id: s.host_id,
                        handle: h,
                        kind: CHANGE_LOOP,
                        cycle: e.cycle,
                    });
                }
                self.slots[index].cycle = e.cycle;
            }
            if e.done {
                self.push_change(TweenChange {
                    host_id: s.host_id,
                    handle: h,
                    kind: CHANGE_COMPLETED,
                    cycle: e.cycle,
                });
                self.release(index);
            }
        }
    }

    /// Output rows this frame.
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// The output rows' column ids.
    pub fn columns(&self) -> &[u32] {
        &self.columns
    }

    /// The output rows' values (four floats per row).
    pub fn values(&self) -> &[f32] {
        &self.values
    }

    /// State-change records this frame.
    pub fn change_count(&self) -> usize {
        self.change_count
    }

    /// The change buffer.
    pub fn changes(&self) -> &[u8] {
        &self.changes
    }

    /// State changes dropped this frame because the buffer was full.
    pub fn dropped(&self) -> u32 {
        self.dropped
    }
}
