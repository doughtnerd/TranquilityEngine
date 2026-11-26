//! Engine curves for curve easing (T70): the key parser (moved from `anim-sample`'s `curve`, which
//! re-exports it, ADR 0420 spike) and [`CurveStore`], the small handle table a host without an asset
//! arena (the standalone tween module) keeps its curves in.
//!
//! # Keys
//!
//! [`KEY_FLOATS`] f32 per key, sorted by x: `x, y, interp, inDx, inDy, outDx, outDy`. `interp`
//! is `curve.ts`'s code (0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut, 5 Bézier); any other
//! value reads as linear, as `curve.ts`'s default. The handles are a Bézier key's offsets (`in`,
//! `out`), ignored for other keys. At most [`MAX_KEYS`] keys (`TRACK_LIMITS.keys`).

use alloc::vec;
use alloc::vec::Vec;
use myco_curve::{bake, Key, SourceKey, INTERP_BEZIER};

use crate::host::{
    handle, split, STATUS_BAD_ASSET, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE, STATUS_TOO_LARGE,
};
use crate::spec::Curves;

/// Floats per key.
pub const KEY_FLOATS: usize = 7;

/// The most keys a curve holds (`src/engine/animation/tracks.ts` `TRACK_LIMITS.keys`).
pub const MAX_KEYS: usize = 65_536;

/// Why keys were refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveError {
    /// Not a whole number of keys, a number that isn't finite, or keys out of x order.
    Malformed,
    /// More than [`MAX_KEYS`] keys.
    TooLarge,
}

/// Reads and bakes keys ([`KEY_FLOATS`] floats each) for `myco_curve::eval`.
pub fn parse_keys(floats: &[f32]) -> Result<Vec<Key<f32>>, CurveError> {
    if !floats.len().is_multiple_of(KEY_FLOATS) {
        return Err(CurveError::Malformed);
    }
    let n = floats.len() / KEY_FLOATS;
    if n > MAX_KEYS {
        return Err(CurveError::TooLarge);
    }
    let mut src: Vec<SourceKey<f32>> = Vec::with_capacity(n);
    for k in floats.as_chunks::<KEY_FLOATS>().0 {
        if !k.iter().all(|v| v.is_finite()) {
            return Err(CurveError::Malformed);
        }
        if src.last().is_some_and(|p| p.0 > k[0]) {
            return Err(CurveError::Malformed);
        }
        let code = k[2];
        let interp = if code >= 0.0 && code <= INTERP_BEZIER as f32 && code == (code as u8) as f32 {
            code as u8
        } else {
            0
        };
        src.push((k[0], k[1], interp, [k[3], k[4], k[5], k[6]]));
    }
    let mut keys = vec![Key::default(); n];
    bake(&src, &mut keys);
    Ok(keys)
}

/// The most curves a [`CurveStore`] holds (handle indices are 16 bits).
pub const MAX_CURVES: usize = 0xFFFF;

struct Slot {
    generation: u16,
    keys: Option<Vec<Key<f32>>>,
}

/// A handle table of baked curves, for a host with no asset arena. Handles have the tween table's
/// layout (`generation << 16 | index`, never below `1 << 16`), so a curve handle in a tween's `ease`
/// is told from an easing id by value, as in the animation core. Loading and releasing allocate
/// (setup calls); [`Curves::curve`] never does.
#[derive(Default)]
pub struct CurveStore {
    slots: Vec<Slot>,
    free: Vec<u16>,
}

impl CurveStore {
    /// Loads keys ([`KEY_FLOATS`] floats each); the handle, or a `STATUS_*` (`STATUS_BAD_ASSET`,
    /// `STATUS_TOO_LARGE`, `STATUS_FULL`).
    pub fn load(&mut self, floats: &[f32]) -> Result<u32, u32> {
        let keys = parse_keys(floats).map_err(|e| match e {
            CurveError::Malformed => STATUS_BAD_ASSET,
            CurveError::TooLarge => STATUS_TOO_LARGE,
        })?;
        let index = match self.free.pop() {
            Some(i) => i as usize,
            None if self.slots.len() < MAX_CURVES => {
                self.slots.push(Slot {
                    generation: 1,
                    keys: None,
                });
                self.slots.len() - 1
            }
            None => return Err(STATUS_FULL),
        };
        let slot = &mut self.slots[index];
        slot.keys = Some(keys);
        Ok(handle(index, slot.generation))
    }

    /// Frees curve `h`; a `STATUS_*`. Tweens still easing through it ease linearly from then on.
    pub fn release(&mut self, h: u32) -> u32 {
        let (index, generation) = split(h);
        match self.slots.get_mut(index) {
            Some(s) if s.generation == generation && s.keys.is_some() => {
                s.keys = None;
                s.generation = s.generation.wrapping_add(1).max(1);
                self.free.push(index as u16);
                STATUS_OK
            }
            _ => STATUS_STALE_HANDLE,
        }
    }
}

impl Curves for CurveStore {
    #[inline]
    fn curve(&self, h: u32) -> Option<&[Key<f32>]> {
        let (index, generation) = split(h);
        match self.slots.get(index) {
            Some(s) if s.generation == generation => s.keys.as_deref(),
            _ => None,
        }
    }
}
