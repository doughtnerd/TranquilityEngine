//! Feature `tweens`: the tween table: Penner easings by name, loops, time scales, a destroyed
//! flag (wire family `tween`, whose docs define the commands, views and timing).
//!
//! # Shape
//!
//! [`Tweens`] is a table of slots (a handle is `generation << 16 | index`, never 0), sized once
//! (`tweens_configure`, default [`DEFAULT_MAX_TWEENS`]): creating, controlling and updating never
//! allocate. [`Spec`] is one tween's description and its value function, shared with timeline
//! sequences (`timeline.rs`): [`Spec::eval`] gives the value at an elapsed time.
//!
//! # Per frame
//!
//! [`Tweens::update`] advances the tweens of a World whose time mode belongs to the pass, in slot
//! order, and appends their rows to the value view (column id, four floats) and their state
//! records to the change buffer; [`Tweens::begin_frame`] clears both (`write_inputs` calls it).
//! A kill or destroy command takes effect at once (the tween leaves the output) and its record is
//! written by the next update of its World.
//!
//! Elapsed time is f64; values are f32 (`from·(1 − e) + to·e`, so the end values are exact;
//! quaternions use `anim-math`'s nlerp or slerp with the same endpoint rule).

use anim_math::ease::ease;
use anim_math::AosQuat;
use anim_wire::core::{
    Init, PASS_FIXED, STATUS_BAD_RECORD, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE,
};
use anim_wire::tween::{
    TweenChange, TweenControl, TweenCreate, CHANGE_COMPLETED, CHANGE_DESTROYED, CHANGE_KILLED,
    CHANGE_LOOP, DEFAULT_MAX_TWEENS, FLAG_RELATIVE, FLAG_YOYO, KIND_QUAT_NLERP, KIND_QUAT_SLERP,
    LOOPS_INFINITE, OP_DESTROYED, OP_KILL, OP_PAUSE, OP_RESUME, TIME_FIXED, TIME_UNSCALED,
};
use anim_wire::WireRecord;

use crate::assets::{handle, split};

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the default table, its value rows and its change records.
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    Tweens::bytes_for(DEFAULT_MAX_TWEENS as usize)
}

/// The most tweens a table can hold (handle indices are 16 bits).
pub const MAX_TWEENS: usize = 0xFFFF;

fn finite_or(x: f32, default: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        default
    }
}

/// One tween's description (see the `tween` wire docs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    /// `KIND_VALUE`, `KIND_QUAT_NLERP` or `KIND_QUAT_SLERP`.
    pub kind: u32,
    /// Floats of a value tween (4 for a quaternion).
    pub width: usize,
    /// An easing id.
    pub ease: u32,
    /// Odd cycles run backwards.
    pub yoyo: bool,
    /// Cycles (at least 1), or `LOOPS_INFINITE`.
    pub loops: u32,
    /// Seconds per cycle (≥ 0).
    pub duration: f32,
    /// Seconds before the first cycle (≥ 0).
    pub delay: f32,
    pub from: [f32; 4],
    /// The end value, with a relative tween already resolved.
    pub to: [f32; 4],
}

/// The state of a tween at an elapsed time (see [`Spec::eval`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Eval {
    /// Past its delay: the value was written.
    pub started: bool,
    /// The cycle reached (0 for the first); cycles played once done.
    pub cycle: u32,
    /// Ran to its end.
    pub done: bool,
}

fn quat(v: &[f32; 4]) -> AosQuat {
    AosQuat::new(v[0], v[1], v[2], v[3])
}

fn quat_array(q: AosQuat) -> [f32; 4] {
    [q.x, q.y, q.z, q.w]
}

impl Spec {
    /// The spec of a create command (or a sequence member's fields): sanitised (non-finite
    /// numbers read as 0, negative times as 0), a relative `to` resolved, quaternions
    /// normalised. `None` for a width outside 1..=4 or an unknown value kind.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        kind: u32,
        width: u32,
        ease: u32,
        flags: u32,
        loops: u32,
        duration: f32,
        delay: f32,
        from: [f32; 4],
        to: [f32; 4],
    ) -> Option<Spec> {
        let quat_kind = kind == KIND_QUAT_NLERP || kind == KIND_QUAT_SLERP;
        if kind > KIND_QUAT_SLERP || (!quat_kind && !(1..=4).contains(&width)) {
            return None;
        }
        let width = if quat_kind { 4 } else { width as usize };
        let clean = |v: [f32; 4]| v.map(|x| finite_or(x, 0.0));
        let (mut from, mut to) = (clean(from), clean(to));
        if quat_kind {
            from = quat_array(quat(&from).normalize_or_identity());
            let by = quat(&to).normalize_or_identity();
            to = if flags & FLAG_RELATIVE != 0 {
                quat_array((quat(&from) * by).normalize_or_identity())
            } else {
                quat_array(by)
            };
        } else if flags & FLAG_RELATIVE != 0 {
            for i in 0..4 {
                to[i] += from[i];
            }
        }
        for i in width..4 {
            from[i] = 0.0;
            to[i] = 0.0;
        }
        Some(Spec {
            kind,
            width,
            ease,
            yoyo: flags & FLAG_YOYO != 0,
            loops: if loops == 0 { 1 } else { loops },
            duration: finite_or(duration, 0.0).max(0.0),
            delay: finite_or(delay, 0.0).max(0.0),
            from,
            to,
        })
    }

    /// The spec of a [`TweenCreate`] record.
    pub fn from_create(c: &TweenCreate) -> Option<Spec> {
        Spec::new(
            c.value_kind,
            c.width,
            c.ease,
            c.flags,
            c.loops,
            c.duration,
            c.delay,
            [c.from0, c.from1, c.from2, c.from3],
            [c.to0, c.to1, c.to2, c.to3],
        )
    }

    /// Seconds from the start (the delay's start) to the end: infinite for endless loops.
    pub fn total(&self) -> f64 {
        if self.duration <= 0.0 {
            return self.delay as f64;
        }
        if self.loops == LOOPS_INFINITE {
            return f64::INFINITY;
        }
        self.delay as f64 + self.duration as f64 * self.loops as f64
    }

    /// The value at progress `p` of a cycle (before easing), with exact endpoints.
    fn value(&self, p: f32, out: &mut [f32; 4]) {
        let e = ease(self.ease, p);
        if e == 0.0 {
            *out = self.from;
        } else if e == 1.0 {
            *out = self.to;
        } else if self.kind == KIND_QUAT_NLERP {
            *out = quat_array(quat(&self.from).nlerp(quat(&self.to), e));
        } else if self.kind == KIND_QUAT_SLERP {
            *out = quat_array(quat(&self.from).slerp(quat(&self.to), e));
        } else {
            for ((o, a), b) in out.iter_mut().zip(self.from).zip(self.to) {
                *o = a * (1.0 - e) + b * e;
            }
        }
    }

    /// The tween at elapsed time `t` seconds since its start (the delay's start): writes the value
    /// into `out` once past the delay, and says which cycle it is in and whether it is done. A
    /// finished tween holds its end value (`to`, or `from` after an odd number of yoyo cycles).
    /// With `yoyo` an odd cycle runs backwards through the same easing (`ease(1 − p)`).
    pub fn eval(&self, t: f64, out: &mut [f32; 4]) -> Eval {
        let delay = self.delay as f64;
        if t.is_nan() || t < delay {
            return Eval {
                started: false,
                cycle: 0,
                done: false,
            };
        }
        let u = t - delay;
        let dur = self.duration as f64;
        let n = if dur <= 0.0 && self.loops == LOOPS_INFINITE {
            1
        } else {
            self.loops
        };
        let end_progress = |cycles: u32| {
            if self.yoyo && (cycles - 1) % 2 == 1 {
                0.0
            } else {
                1.0
            }
        };
        if dur <= 0.0 || (n != LOOPS_INFINITE && u >= dur * n as f64) {
            self.value(end_progress(n), out);
            return Eval {
                started: true,
                cycle: n,
                done: true,
            };
        }
        let cyc = (u / dur).floor().min(u32::MAX as f64 - 1.0);
        let frac = ((u - cyc * dur) / dur).clamp(0.0, 1.0) as f32;
        let cycle = cyc as u32;
        let p = if self.yoyo && cycle % 2 == 1 {
            1.0 - frac
        } else {
            frac
        };
        self.value(p, out);
        Eval {
            started: true,
            cycle,
            done: false,
        }
    }
}

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

    /// Advances the tweens of `world` in `pass` (see the module docs). Never allocates.
    pub fn update(&mut self, world: u32, pass: u32, dt_scaled: f32, dt_unscaled: f32) {
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
            let e = s.spec.eval(elapsed, &mut v);
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
