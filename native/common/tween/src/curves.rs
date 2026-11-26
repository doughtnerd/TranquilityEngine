//! [`CurveStore`], the small handle table of baked engine curves (T70) that a host without an asset
//! arena (the standalone tween module) keeps its curve eases in. The keys are `myco-curve`'s
//! ([`myco_curve::parse_keys`], feature `alloc`: [`myco_curve::KEY_FLOATS`] floats per key).

use alloc::vec::Vec;
use myco_curve::{parse_keys, CurveError, Key};

use crate::host::{
    handle, split, STATUS_BAD_ASSET, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE, STATUS_TOO_LARGE,
};
use crate::spec::Curves;

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
    /// Loads keys ([`myco_curve::KEY_FLOATS`] floats each); the handle, or a `STATUS_*` (`STATUS_BAD_ASSET`,
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
