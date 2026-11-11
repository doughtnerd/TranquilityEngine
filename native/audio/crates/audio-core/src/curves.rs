//! Class G records and the curve pool (0166 M4-0; api-and-models §3.1 "Curve pool", "Fade laws",
//! §4.2 the `shape` word; architecture §4.4 "Class G", "Fade laws at control rate"; rulings R4, R5,
//! R6; ADR 0167 §1.1, §2).
//!
//! **Class G in the gain loop.** FADE, gain-only SET_PARAMS and STOP apply inside the voice's gain
//! loop by a start-sample compare: [`due_gain`] steps the `fade` (or `gain`) ramp as today, and at
//! the record's sample `k` fires it first ([`fire`], out of line). With no due record the compare
//! never matches ([`DueGain::NONE`]), so unstamped work is bit-identical; a linear record fires as
//! exactly the `set_target` the old split applied at `k`. A STOP with fade 0 (or a stopping FADE
//! over 0 frames) at `k` truncates the voice's frames to `k` ([`DueGain::truncate_at`], `voices.rs`).
//!
//! **Laws at control rate (R6).** The knots of a shaped fade are its start sample `k`, every quantum
//! boundary after it, and its end. Between two knots the voice's linear `Ramp` runs; at each knot
//! it is retargeted ([`Ramp::retarget`]) to `curve_laws::value(law, from, to, u)` at the next knot,
//! so the law is evaluated once per quantum, never per sample. While a shaped fade runs the ramp's
//! `target` is the fade's end value and its `remaining` the frames to the fade's end (only `step`
//! aims at the next knot), so a stopping fade's `remaining` and `is_settled` mean what they always
//! did. A fade that ends before the next quantum boundary is one linear segment (no pool entry).
//!
//! The exact law (Z3's offline reference evaluates it in f64): a record at absolute frame `F` (its
//! sample, or where it applied) with `frames = N`, law `L`, phase `u0`, from `a` (the ramp's value
//! there) to `b`. Knots `F = t0 < t1 < … < tm = F + N`, where `t1..tm−1` are the quantum boundaries
//! in between. At knot `t` the phase is `u(t) = 1 − (1 − u0)·(F + N − t)/N` and the value
//! `L(a, b, u(t))` ([`curve_laws::value`]); at `t0` the value is `L(a, b, u0)` (a jump when
//! `u0 > 0`), at `tm` exactly `b`. The output at frame `t` in `(t_i, t_i+1]` is the linear
//! interpolation between the two knots (the first frame after a knot already moves; frame `F` is
//! the first frame after `t0`'s value, so the output at frame `F + j` is the value at `F + j + 1`).
//!
//! **The pool.** A shaped fade takes an entry linked from the slot's spare byte (`VoiceSlot::reserved`
//! = entry + 1, R4); a voice holds at most one. A new class G record on the same ramp replaces the
//! running curve; a shaped record that finds no entry (the pool full, or the voice's link held by a
//! curve on its other ramp) runs linear and counts `curvePoolFull`. Phase `u0` (the shape word's bits
//! 16–31, `/ 65,536`) starts the ramp at `law(u0)` and runs the remaining `1 − u0` over the record's
//! frames (REPLAY re-sends a running fade with its phase), linear laws included.
//!
//! **Two entry points.** A record the gain loop takes: [`prepare`] (before the piece; the entry is
//! *armed* until the piece has rendered, [`disarm`]). A record applied between pieces, asap, or by a
//! quantum split (`scheduler::apply`, then [`applied`] on the slot): the entry starts at the
//! application point, and the first [`step`] (the voice's next render) aims at the first knot. Each
//! render of a voice with a link starts with [`step`] (one byte compare for every other voice).
//!
//! **Memory.** The `Curves` region (Q1's layout, before `Arena`): [`CURVE_ENTRIES`] entries of 32 B
//! = 8,160 B on every preset. All-zero bytes are a free pool.
//!
//! Owner: **Z2b** (W3, on the flip branch).

use audio_dsp::curve_laws::{self, Law};
use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;

use crate::due::DueRecord;
use crate::QUANTUM;

/// Curve-pool entries (api-and-models §4.5 `CURVE_ENTRIES`; R4: a link byte holds entry + 1).
pub const CURVE_ENTRIES: usize = audio_wire::generated::CURVE_ENTRIES as usize;
/// Bytes per entry.
pub const CURVE_ENTRY_BYTES: usize = 32;
/// The `Curves` region: `CURVE_ENTRIES × 32` = 8,160 B.
pub const REGION_BYTES: usize = CURVE_ENTRIES * CURVE_ENTRY_BYTES;

const _: () = assert!(REGION_BYTES == 8_160, "api-and-models §3.1");
const _: () = assert!(CURVE_ENTRIES <= u8::MAX as usize, "the slot's link byte holds entry + 1");

/// The `shape` word (api-and-models §4.2): bits 0–2 the law, bits 16–31 the start phase.
pub const SHAPE_LAW_MASK: u32 = audio_wire::generated::SHAPE_LAW_MASK;
pub const SHAPE_PHASE_SHIFT: u32 = audio_wire::generated::SHAPE_PHASE_SHIFT;

const _: () = assert!(
    audio_dsp::equal_power::FADE_CURVE_TABLE_POINTS == audio_wire::generated::FADE_CURVE_TABLE_POINTS as usize,
    "the equal-power table has the wire's point count"
);
const _: () = assert!(audio_wire::generated::SHAPE_PHASE_SCALE == 65_536);
// `audio_dsp::curve_laws::Law` carries the wire's `fade_law` values (audio-dsp doesn't depend on the wire).
const _: () = {
    use audio_wire::generated::fade_law;
    assert!(Law::Linear as u32 == fade_law::LINEAR && Law::SCurve as u32 == fade_law::S_CURVE);
    assert!(Law::EqualPowerIn as u32 == fade_law::EQUAL_POWER_IN && Law::EqualPowerOut as u32 == fade_law::EQUAL_POWER_OUT);
};

/// Which of the voice's ramps a curve drives.
pub mod ramp_of {
    /// FADE, STOP with a fade: the `fade` ramp (crossfades, R5).
    pub const FADE: u8 = 0;
    /// SET_PARAMS gain (stem automation, a quantised ramp): the `gain` ramp.
    pub const GAIN: u8 = 1;
}

/// A decoded `shape` word.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Shape {
    pub law: Law,
    /// Start phase `u0` in `[0, 1)`: the word's bits 16–31 / 65,536.
    pub u0: f32,
}

impl Shape {
    /// Decodes a `shape` word (0, an older record's missing word: linear from phase 0).
    pub fn from_word(word: u32) -> Shape {
        Shape { law: Law::from_bits(word & SHAPE_LAW_MASK), u0: (word >> SHAPE_PHASE_SHIFT) as f32 / 65_536.0 }
    }
}

/// One running shaped fade: 32 bytes, all-zero is a free entry (api-and-models §3.1: law,
/// stop-at-end, `u`, `du`, from, to, frames left).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CurveEntry {
    /// The owning voice slot's index + 1; 0 free (checked against the slot's link, as `fxpool`).
    pub owner: u32,
    /// The owning voice's id, so a recycled slot never inherits a curve.
    pub voice_id: u32,
    /// [`Law`] as its wire value.
    pub law: u8,
    /// Non-zero: the voice ends when the fade settles (FADE `stopAtEnd`, STOP with a fade). The
    /// slot's `STOP_ON_FADE_END` flag does the ending; this records it for inspection.
    pub stop_at_end: u8,
    /// [`ramp_of`]: the ramp the curve drives.
    pub ramp: u8,
    /// Non-zero while [`prepare`]'s record hasn't fired yet (the piece it is due in is rendering):
    /// [`step`] leaves the entry alone until [`disarm`].
    pub armed: u8,
    /// The phase at the knot the ramp is aimed at (or, before the first [`step`], the start phase).
    pub u: f32,
    /// Phase per frame: `(1 − u0) / frames`.
    pub du: f32,
    /// The fade's start and end values (the law maps `u` to `from..to`).
    pub from: f32,
    pub to: f32,
    /// Frames from the knot the ramp is aimed at to the fade's end. At a knot the driven ramp's
    /// `remaining` equals it; between knots it is larger by at most a quantum.
    pub frames_left: u32,
}

const _: () = assert!(core::mem::size_of::<CurveEntry>() == CURVE_ENTRY_BYTES, "a curve entry is 32 B");

/// The pool viewed over the `Curves` region's bytes (`CURVE_ENTRIES` entries; empty for an empty
/// region, so every acquire fails and fades stay linear).
pub fn entries(region: &mut [u8]) -> &mut [CurveEntry] {
    let count = (region.len() / CURVE_ENTRY_BYTES).min(CURVE_ENTRIES);
    if count == 0 {
        return &mut [];
    }
    // SAFETY: the `Curves` region is 64-byte aligned (Layout) and zeroed at init; all-zero bytes
    // are a valid CurveEntry; `count` entries fit. Only this module views these bytes.
    unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut CurveEntry, count) }
}

/// Takes a free entry for voice slot `index` (id `voice_id`); returns the link (entry + 1) for
/// `VoiceSlot::reserved`, or `None` with the pool full (the caller counts `curvePoolFull` and runs
/// the fade linear).
pub fn acquire(pool: &mut [CurveEntry], index: usize, voice_id: u32) -> Option<u8> {
    let at = pool.iter().position(|e| e.owner == 0)?;
    pool[at] = CurveEntry { owner: index as u32 + 1, voice_id, ..CurveEntry::default() };
    Some(at as u8 + 1)
}

/// The entry `link` names if slot `index` owns it (`None` for 0, a stale or a foreign link).
pub fn owned(pool: &mut [CurveEntry], link: u8, index: usize) -> Option<&mut CurveEntry> {
    let e = pool.get_mut((link as usize).checked_sub(1)?)?;
    (e.owner as usize == index + 1).then_some(e)
}

/// Frees `link` if slot `index` owns it (the fade finished, was replaced linear, or the voice ended).
pub fn release(pool: &mut [CurveEntry], link: u8, index: usize) {
    if let Some(e) = owned(pool, link, index) {
        *e = CurveEntry::default();
    }
}

/// A class G record due in the sub-range being rendered, reduced to what the gain loop needs.
/// Built once per voice per range ([`prepare`]), outside the per-sample loop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DueGain {
    /// The record's sample, relative to the range's first frame; `u32::MAX` for none.
    pub at: u32,
    /// [`ramp_of`]: which ramp fires at `at`.
    pub ramp: u8,
    /// Where the fade ends and over how many frames from `at` (`set_target(target, frames)`).
    pub target: f32,
    pub frames: u32,
    /// A STOP with fade 0 (or a FADE to stop over 0 frames): the voice's frames end at `at`.
    pub truncate_at: u32,
    /// Start phase: the ramp's value jumps to `start` at `at` before it fires (`u0 > 0`).
    pub jump: bool,
    pub start: f32,
    /// A shaped fade: the first segment aims at `knot` over `knot_frames` (0: linear to the end).
    pub knot: f32,
    pub knot_frames: u32,
}

impl DueGain {
    /// No class G record in this range: the compare never matches.
    pub const NONE: DueGain = DueGain { at: u32::MAX, ramp: ramp_of::FADE, target: 0.0, frames: 0, truncate_at: u32::MAX, jump: false, start: 0.0, knot: 0.0, knot_frames: 0 };
}

/// The gain loop's compare (H1: `voices.rs` calls it for the ramp `due.ramp` names, inline): at
/// sample `i == due.at` the record fires ([`fire`], out of line); then the ramp steps as today
/// (`Ramp::next`). One compare per sample, nothing else (architecture §4.4).
#[inline(always)]
pub fn due_gain(ramp: &mut Ramp, i: u32, due: &DueGain) -> f32 {
    if i == due.at {
        fire(ramp, due);
    }
    ramp.next()
}

/// The record `due` takes effect on `ramp` (at its sample): the start-phase jump, the ramp to the
/// fade's end, and for a shaped fade the aim at its first knot. A linear record without a phase is
/// exactly `set_target(target, frames)`, the old split's apply.
#[cold]
#[inline(never)]
pub fn fire(ramp: &mut Ramp, due: &DueGain) {
    if due.jump {
        ramp.value = due.start;
    }
    ramp.set_target(due.target, due.frames);
    if due.knot_frames != 0 {
        ramp.retarget(due.knot, due.knot_frames);
    }
}

/// `true` when `ramp` shows `due` fired in a piece that ran `len` frames from the range's start:
/// it ends at `due.target` with between `frames − (len − at)` and `frames − 1` frames left (`0` for a
/// jump). A voice that stopped rendering before `at` (a stream waiting for data, a pause or seek
/// fade-out that settled) never fired: the caller applies the record after the piece, where the old
/// split would have applied it to a voice that wasn't moving. (A ramp already heading to the same
/// target with a matching `remaining` reads as fired; it is then the same linear ramp.)
pub fn fired(ramp: &Ramp, due: &DueGain, len: u32) -> bool {
    let after = len.saturating_sub(due.at);
    ramp.target.to_bits() == due.target.to_bits() && ramp.remaining >= due.frames.saturating_sub(after) && (due.frames == 0 || ramp.remaining < due.frames)
}

/// Clears the armed mark of the entry `link` names (its record fired: the piece rendered).
pub fn disarm(pool: &mut [CurveEntry], link: u8, index: usize) {
    if let Some(e) = owned(pool, link, index) {
        e.armed = 0;
    }
}

/// A class G record's `(target, frames, truncate)`: FADE `values[0]` over `frames` (truncating with
/// "stop at end" over 0 frames), STOP to 0 over its fade (truncating over 0), SET_PARAMS gain.
fn decode(record: &DueRecord) -> (f32, u32, bool) {
    match record.op as u16 {
        wire::op::STOP => (0.0, record.frames, record.frames == 0),
        wire::op::FADE => (record.values[0], record.frames, record.flags & 1 != 0 && record.frames == 0),
        _ => (record.values[0], record.frames, false),
    }
}

/// The phase `frames_left` frames before the end of a fade with phase step `du`.
#[inline]
fn phase(du: f32, frames_left: u32) -> f32 {
    (1.0 - du as f64 * frames_left as f64) as f32
}

/// A new record on ramp `which` replaces slot `index`'s curve on it.
fn release_on(pool: &mut [CurveEntry], link: &mut u8, index: usize, which: u8) {
    match owned(pool, *link, index) {
        Some(e) if e.ramp == which => {
            *e = CurveEntry::default();
            *link = 0;
        }
        Some(_) => {}
        None => *link = 0,
    }
}

/// An entry for slot `index`'s new curve: a fresh one (the link is free or stale), or `None` when
/// the link holds a curve on the other ramp or the pool is full.
fn claim<'p>(pool: &'p mut [CurveEntry], link: &mut u8, index: usize, voice_id: u32) -> Option<&'p mut CurveEntry> {
    if owned(pool, *link, index).is_some() {
        return None;
    }
    *link = acquire(pool, index, voice_id)?;
    owned(pool, *link, index)
}

/// Turns voice slot `index`'s class G `record` (due at absolute `frame_at`) into the gain loop's
/// [`DueGain`] for the range starting at absolute frame `range_start`, and starts its curve: a
/// shaped law that runs past `knot_at` (the next quantum boundary) takes a pool entry, armed, and
/// writes its link to `link`; a shaped record without one counts `curvePoolFull` in `pool_full`
/// and runs linear. `ramp_value` is the driven ramp's value at the record's sample (the fade's
/// `from`). A running curve on the same ramp is replaced.
#[allow(clippy::too_many_arguments)]
pub fn prepare(pool: &mut [CurveEntry], index: usize, voice_id: u32, link: &mut u8, record: &DueRecord, shape: Shape, frame_at: u64, range_start: u64, knot_at: u64, ramp_value: f32, pool_full: &mut u16) -> DueGain {
    let which = crate::due::ramp_of(record);
    let at = frame_at.saturating_sub(range_start).min(u32::MAX as u64 - 1) as u32;
    let (to, frames, truncate) = decode(record);
    release_on(pool, link, index, which);
    if truncate {
        return DueGain { at, ramp: which, target: ramp_value, truncate_at: at, ..DueGain::NONE };
    }
    let jump = shape.u0 > 0.0 && frames > 0;
    let start = if jump { curve_laws::value(shape.law, ramp_value, to, shape.u0) } else { ramp_value };
    let mut due = DueGain { at, ramp: which, target: to, frames, jump, start, ..DueGain::NONE };
    if !shape.law.is_shaped() || frames == 0 {
        return due;
    }
    let first = knot_at.saturating_sub(frame_at).min(frames as u64) as u32;
    if first == 0 || first >= frames {
        // Ends before the next quantum boundary: one segment.
        return due;
    }
    let Some(e) = claim(pool, link, index, voice_id) else {
        *pool_full = pool_full.saturating_add(1);
        return due;
    };
    let du = (1.0 - shape.u0) / frames as f32;
    let frames_left = frames - first;
    let u = phase(du, frames_left);
    *e = CurveEntry { law: shape.law as u8, stop_at_end: crate::due::stops_at_end(record) as u8, ramp: which, armed: 1, u, du, from: ramp_value, to, frames_left, ..*e };
    due.knot = curve_laws::value(shape.law, ramp_value, to, u);
    due.knot_frames = first;
    due
}

/// After `scheduler::apply` applied voice slot `index`'s class G `record` (the linear
/// `set_target(to, frames)` is done on `ramp`, from `ramp.value`): a running curve on that ramp is
/// replaced; a start phase jumps the ramp to `law(u0)`; a shaped law takes an entry that starts here
/// (the voice's next [`step`] aims at its first knot) or, without one, counts `curvePoolFull` in
/// `pool_full` and runs linear. Shape 0 changes nothing but the release.
#[allow(clippy::too_many_arguments)]
pub fn applied(pool: &mut [CurveEntry], index: usize, voice_id: u32, link: &mut u8, ramp: &mut Ramp, record: &DueRecord, shape: Shape, pool_full: &mut u16) {
    let which = crate::due::ramp_of(record);
    release_on(pool, link, index, which);
    let (to, frames, truncate) = decode(record);
    if truncate || frames == 0 || (shape.u0 == 0.0 && !shape.law.is_shaped()) {
        return;
    }
    let from = ramp.value;
    if shape.law.is_shaped() {
        if let Some(e) = claim(pool, link, index, voice_id) {
            let du = (1.0 - shape.u0) / frames as f32;
            *e = CurveEntry { law: shape.law as u8, stop_at_end: crate::due::stops_at_end(record) as u8, ramp: which, armed: 0, u: shape.u0, du, from, to, frames_left: frames, ..*e };
            // At a knot (`remaining == frames_left`) until the next step aims it.
            *ramp = Ramp { value: curve_laws::value(shape.law, from, to, shape.u0), target: to, step: 0.0, remaining: frames };
            return;
        }
        *pool_full = pool_full.saturating_add(1);
    }
    ramp.value = curve_laws::value(shape.law, from, to, shape.u0);
    ramp.set_target(to, frames);
}

/// The control-rate retarget at the start of each render of slot `index` (the caller checks
/// `*link != 0` first): `knot_frames` is the frames from the render's first sample to the next
/// quantum boundary. At a knot (the driven ramp's `remaining == frames_left`) the ramp is aimed at
/// the law's value at the next knot, `min(knot_frames, frames_left)` ahead; the last segment aims at
/// the fade's end and frees the entry. Between knots nothing changes. A ramp something else has
/// retargeted (its target isn't the curve's end, or its `remaining` doesn't fit) frees the entry and
/// is left alone. An armed entry waits for [`disarm`]. Returns `true` when the curve finished.
pub fn step(pool: &mut [CurveEntry], index: usize, link: &mut u8, fade: &mut Ramp, gain: &mut Ramp, knot_frames: u32) -> bool {
    let Some(e) = owned(pool, *link, index) else {
        *link = 0;
        return false;
    };
    if e.armed != 0 {
        return false;
    }
    let ramp = if e.ramp == ramp_of::GAIN { gain } else { fade };
    let foreign = ramp.target.to_bits() != e.to.to_bits() || ramp.remaining < e.frames_left || ramp.remaining - e.frames_left > QUANTUM as u32;
    if foreign || e.frames_left == 0 {
        *e = CurveEntry::default();
        *link = 0;
        return !foreign;
    }
    if ramp.remaining > e.frames_left {
        return false;
    }
    let n = knot_frames.clamp(1, e.frames_left);
    e.frames_left -= n;
    if e.frames_left == 0 {
        ramp.retarget(e.to, n);
        *e = CurveEntry::default();
        *link = 0;
        return true;
    }
    e.u = phase(e.du, e.frames_left);
    ramp.retarget(curve_laws::value(Law::from_bits(e.law as u32), e.from, e.to, e.u), n);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fade_record(to: f32, frames: u32, stop: bool) -> DueRecord {
        DueRecord { voice_id: 1, op: wire::op::FADE as u8, flags: stop as u8, values: [to, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], frames, ..Default::default() }
    }

    fn pool() -> Vec<CurveEntry> {
        vec![CurveEntry::default(); 4]
    }

    /// Renders `ramp` for `n` frames through the compare, collecting the outputs.
    fn run(ramp: &mut Ramp, due: &DueGain, from: u32, n: u32, out: &mut Vec<f32>) {
        for i in from..from + n {
            out.push(due_gain(ramp, i, due));
        }
    }

    #[test]
    fn acquire_takes_free_entries_until_full() {
        let mut p = pool();
        let links: Vec<_> = (0..4).map(|i| acquire(&mut p, i, 100 + i as u32).unwrap()).collect();
        assert_eq!(links, [1, 2, 3, 4]);
        assert_eq!(acquire(&mut p, 9, 9), None);
        release(&mut p, 2, 1);
        assert_eq!(acquire(&mut p, 7, 7), Some(2));
        release(&mut p, 3, 0);
        assert_eq!(p[2].owner, 3, "a foreign release changes nothing");
    }

    #[test]
    fn with_no_record_the_compare_steps_as_before() {
        let mut a = Ramp::at(0.0);
        a.set_target(1.0, 7);
        let mut b = a;
        for i in 0..10 {
            assert_eq!(due_gain(&mut a, i, &DueGain::NONE).to_bits(), b.next().to_bits());
        }
    }

    #[test]
    fn a_linear_record_fires_as_set_target_at_its_sample() {
        let mut p = pool();
        let mut link = 0u8;
        let mut full = 0u16;
        let r = fade_record(0.25, 40, false);
        let due = prepare(&mut p, 0, 1, &mut link, &r, Shape::default(), 1_000 + 30, 1_000, 1_024, 1.0, &mut full);
        assert_eq!((due.at, due.knot_frames, due.jump, link), (30, 0, false, 0));
        let mut ramp = Ramp::at(1.0);
        let mut want = ramp;
        let mut out = Vec::new();
        run(&mut ramp, &due, 0, 128, &mut out);
        for (i, got) in out.iter().enumerate() {
            if i == 30 {
                want.set_target(0.25, 40);
            }
            assert_eq!(got.to_bits(), want.next().to_bits(), "frame {i}");
        }
        assert!(fired(&ramp, &due, 128));
    }

    #[test]
    fn a_stop_with_no_fade_truncates() {
        let mut p = pool();
        let (mut link, mut full) = (0u8, 0u16);
        let r = DueRecord { op: wire::op::STOP as u8, frames: 0, ..Default::default() };
        let due = prepare(&mut p, 0, 1, &mut link, &r, Shape::default(), 50, 0, 128, 1.0, &mut full);
        assert_eq!((due.at, due.truncate_at), (50, 50));
    }

    /// A shaped fade over 3 quanta from sample 32: knots at 32, 128, 256, 384 and 416; the ramp is
    /// linear between them and passes through the law's value at each.
    #[test]
    fn a_shaped_fade_runs_linear_between_knots_at_each_quantum_boundary() {
        let law = Law::EqualPowerIn;
        let (frames, k) = (384u32, 32u32);
        let mut p = pool();
        let (mut link, mut full) = (0u8, 0u16);
        let r = fade_record(1.0, frames, false);
        let shape = Shape { law, u0: 0.0 };
        let due = prepare(&mut p, 3, 7, &mut link, &r, shape, k as u64, 0, 128, 0.0, &mut full);
        assert_eq!((link, full, due.knot_frames), (1, 0, 96));
        assert_eq!(p[0].armed, 1);
        let mut fade = Ramp::at(0.0);
        let mut gain = Ramp::at(1.0);
        // The arming render: step leaves an armed entry alone.
        assert!(!step(&mut p, 3, &mut link, &mut fade, &mut gain, 128));
        let mut out = Vec::new();
        run(&mut fade, &due, 0, 128, &mut out);
        disarm(&mut p, link, 3);
        let mut q = 1u32;
        while link != 0 || !fade.is_settled() {
            let start = out.len();
            if link != 0 {
                step(&mut p, 3, &mut link, &mut fade, &mut gain, 128);
            }
            run(&mut fade, &DueGain::NONE, 0, 128, &mut out);
            assert!(out.len() == start + 128);
            q += 1;
            assert!(q < 10);
        }
        assert_eq!(full, 0);
        // out[t] is the value at frame t + 1 (the first frame already moves).
        let exact = |t: u32| -> f64 {
            // Same-knot reference in f64: knots 32, 128, 256, 384, 416.
            let knots = [32u32, 128, 256, 384, 416];
            let val = |t: u32| libm::sin(core::f64::consts::FRAC_PI_2 * (t - k) as f64 / frames as f64);
            let i = knots.windows(2).position(|w| t >= w[0] && t <= w[1]).unwrap();
            let (a, b) = (knots[i], knots[i + 1]);
            val(a) + (val(b) - val(a)) * (t - a) as f64 / (b - a) as f64
        };
        assert!(out[..k as usize].iter().all(|&x| x == 0.0), "nothing moves before the record's sample");
        let mut max = 0.0f64;
        for t in k..416 {
            max = max.max((out[t as usize] as f64 - exact(t + 1)).abs());
        }
        assert!(max < 1e-5, "same-knot seam error {max:e}");
        assert_eq!(out[415], 1.0, "lands on the target");
        assert_eq!(p[0], CurveEntry::default(), "the entry is freed");
        assert!(gain.is_settled() && gain.value == 1.0, "the other ramp is untouched");
    }

    #[test]
    fn a_start_phase_starts_at_the_laws_value() {
        let mut p = pool();
        let (mut link, mut full) = (0u8, 0u16);
        let r = fade_record(0.0, 1_000, true);
        let shape = Shape { law: Law::EqualPowerOut, u0: 0.5 };
        let due = prepare(&mut p, 0, 1, &mut link, &r, shape, 10, 0, 128, 1.0, &mut full);
        assert!(due.jump);
        assert!((due.start - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6, "cos(π/4)");
        assert_eq!(p[0].stop_at_end, 1);
        // 118 frames to the boundary, 882 after: the knot's phase is 1 − 0.5·882/1000.
        assert!((p[0].u - (1.0 - 0.5 * 0.882)).abs() < 1e-6);
    }

    #[test]
    fn a_full_pool_runs_linear_and_counts() {
        let mut p: Vec<CurveEntry> = Vec::new();
        let (mut link, mut full) = (0u8, 0u16);
        let r = fade_record(1.0, 1_000, false);
        let due = prepare(&mut p, 0, 1, &mut link, &r, Shape { law: Law::SCurve, u0: 0.0 }, 0, 0, 128, 0.0, &mut full);
        assert_eq!((due.knot_frames, full, link), (0, 1, 0));
        // A fade inside the quantum needs no entry, so it doesn't count.
        let r = fade_record(1.0, 64, false);
        prepare(&mut p, 0, 1, &mut link, &r, Shape { law: Law::SCurve, u0: 0.0 }, 0, 0, 128, 0.0, &mut full);
        assert_eq!(full, 1);
    }

    #[test]
    fn an_applied_record_starts_at_the_next_render() {
        let mut p = pool();
        let (mut link, mut full) = (0u8, 0u16);
        let mut fade = Ramp::at(1.0);
        let mut gain = Ramp::at(1.0);
        let r = fade_record(0.0, 300, false);
        fade.set_target(0.0, 300); // scheduler::apply's voices::fade
        applied(&mut p, 0, 1, &mut link, &mut fade, &r, Shape { law: Law::EqualPowerOut, u0: 0.0 }, &mut full);
        assert_eq!((link, fade.remaining, fade.value), (1, 300, 1.0));
        // The voice renders from sample 100: 28 frames to the boundary.
        step(&mut p, 0, &mut link, &mut fade, &mut gain, 28);
        assert_eq!(p[0].frames_left, 272);
        // A linear record on the same ramp replaces the curve.
        fade.set_target(0.5, 10);
        applied(&mut p, 0, 1, &mut link, &mut fade, &fade_record(0.5, 10, false), Shape::default(), &mut full);
        assert_eq!((link, p[0]), (0, CurveEntry::default()));
    }

    #[test]
    fn a_foreign_retarget_frees_the_curve() {
        let mut p = pool();
        let (mut link, mut full) = (0u8, 0u16);
        let mut fade = Ramp::at(1.0);
        let mut gain = Ramp::at(1.0);
        fade.set_target(0.0, 300);
        applied(&mut p, 0, 1, &mut link, &mut fade, &fade_record(0.0, 300, false), Shape { law: Law::SCurve, u0: 0.0 }, &mut full);
        step(&mut p, 0, &mut link, &mut fade, &mut gain, 128);
        fade.set_target(0.0, 5); // a steal's stop fade
        assert!(!step(&mut p, 0, &mut link, &mut fade, &mut gain, 128));
        assert_eq!(link, 0);
        assert_eq!(fade.remaining, 5, "left alone");
    }

    #[test]
    fn shape_words_decode() {
        assert_eq!(Shape::from_word(0), Shape::default());
        let s = Shape::from_word(2 | (32_768 << 16));
        assert_eq!((s.law, s.u0), (Law::EqualPowerIn, 0.5));
    }
}
