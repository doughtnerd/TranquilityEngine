//! Class G records and the curve pool (0166 M4-0; api-and-models §3.1 "Curve pool", "Fade laws",
//! §4.2 the `shape` word; architecture §4.4 "Class G", "Fade laws at control rate"; rulings R4, R5,
//! R6; ADR 0167 §1.1, §2).
//!
//! **Class G in the gain loop.** FADE, gain-only SET_PARAMS and STOP apply inside the voice's gain
//! loop by a start-sample compare: [`due_gain`] steps the `fade` (or `gain`) ramp as today, and at
//! the record's sample `k` retargets it first. With no due record the compare never matches
//! ([`DueGain::NONE`]), so unstamped work is bit-identical. A STOP with fade 0 at `k` truncates the
//! voice's frames to `k` (as `stopping` already shortens `n`, `voices.rs`); that is the caller's
//! (H1, Z2a), from [`DueGain::truncate_at`].
//!
//! **Laws at control rate (R6).** A shaped fade (law ≠ linear) takes a pool entry linked from the
//! slot's spare byte (`VoiceSlot::reserved` = entry + 1, R4). The voice's linear `Ramp` is
//! retargeted at `k` and at every quantum boundary to `curve_laws::value(law, from, to, u)` at the
//! next knot, so the law runs once per quantum ([`step`]), never per sample. Phase `u0` (the shape
//! word's bits 16–31, `/ 65,536`) starts the ramp at `law(u0)` and runs the remaining `1 − u0` over
//! the record's frames (REPLAY re-sends a running fade with its phase). With the pool full the fade
//! degrades to linear and counts `curvePoolFull`.
//!
//! **Memory.** The `Curves` region (Q1's layout, before `Arena`): [`CURVE_ENTRIES`] entries of 32 B
//! = 8,160 B on every preset. All-zero bytes are a free pool.
//!
//! Owner: **Z2b** (W3, on the flip branch). Q1 left the entry, constants, views and signatures;
//! bodies tagged `Z2b:` are inert stubs.

use audio_dsp::curve_laws::Law;
use audio_dsp::ramp::Ramp;

use crate::due::DueRecord;

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
    /// Non-zero: the voice ends when the fade settles (FADE `stopAtEnd`, STOP with a fade).
    pub stop_at_end: u8,
    /// [`ramp_of`]: the ramp the curve drives.
    pub ramp: u8,
    pub _pad: u8,
    /// The phase at the ramp's current knot.
    pub u: f32,
    /// Phase per frame: `(1 − u0) / frames`.
    pub du: f32,
    /// The fade's start and end values (the law maps `u` to `from..to`).
    pub from: f32,
    pub to: f32,
    /// Frames until `u` reaches 1 (the entry is freed then).
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
    /// [`ramp_of`]: which ramp retargets at `at`.
    pub ramp: u8,
    /// The ramp's target and length from `at` (to the law's next knot, or the linear end).
    pub target: f32,
    pub frames: u32,
    /// A STOP with fade 0 (or a FADE to stop over 0 frames): the voice's frames end at `at`.
    pub truncate_at: u32,
}

impl DueGain {
    /// No class G record in this range: the compare never matches.
    pub const NONE: DueGain = DueGain { at: u32::MAX, ramp: ramp_of::FADE, target: 0.0, frames: 0, truncate_at: u32::MAX };
}

/// The gain loop's compare (H1: `voices.rs` calls it for the ramp `due.ramp` names, inline): at
/// sample `i == due.at` the ramp retargets to `due.target` over `due.frames`; then it steps as
/// today (`Ramp::next`). One compare per sample, nothing else (architecture §4.4: ≈ 0.1 µs).
#[inline(always)]
pub fn due_gain(ramp: &mut Ramp, i: u32, due: &DueGain) -> f32 {
    // Z2b: `if i == due.at { ramp.set_target(due.target, due.frames) }`. Inert until then.
    let _ = (i, due);
    ramp.next()
}

/// Turns voice slot `index`'s class G `record` (due at absolute `frame_at`) into the gain loop's
/// [`DueGain`] for the range starting at absolute frame `range_start`, and starts its curve: a
/// shaped law takes (or reuses) a pool entry and writes its link to `link`; a full pool counts
/// `curvePoolFull` in `pool_full` and runs linear. `ramp_value` is the driven ramp's value at the
/// record's sample (the fade's `from`).
#[allow(clippy::too_many_arguments)]
pub fn prepare(pool: &mut [CurveEntry], index: usize, voice_id: u32, link: &mut u8, record: &DueRecord, shape: Shape, frame_at: u64, range_start: u64, ramp_value: f32, pool_full: &mut u16) -> DueGain {
    // Z2b.
    let _ = (pool, index, voice_id, link, record, shape, frame_at, range_start, ramp_value, pool_full);
    DueGain::NONE
}

/// The control-rate retarget at a quantum boundary (or the end of a voice-local piece): moves the
/// curve `link` names on by the frames just rendered, and points `ramp` at the law's value
/// `frames_to_knot` frames ahead. Returns `true` when the curve finished (entry freed, `link`
/// cleared; the ramp lands exactly on `to`). A voice without a link costs one compare.
pub fn step(pool: &mut [CurveEntry], index: usize, link: &mut u8, ramp: &mut Ramp, frames_to_knot: u32) -> bool {
    // Z2b.
    let _ = (pool, index, link, ramp, frames_to_knot);
    false
}
