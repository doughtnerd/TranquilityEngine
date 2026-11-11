//! The mixed-voice effect pool (ADR 0162, api-and-models §5.1, architecture §4.1 "mixed-voice
//! pool", contract C3 SET_VOICE_FX): one entry per mixed voice (≈ 448 B each, the `Fx` region,
//! sized from `max_mixed`), handed to a voice when it becomes mixed and reset when it leaves.
//!
//! Skeleton declared by K2 (task A1): the region's size, a SET_VOICE_FX handler that takes the
//! parsed record and drops it, and `reset` (a no-op). Task D1 fills it.

use audio_dsp::fxfilter::FxFilter;
use audio_dsp::ramp::Ramp;
use audio_wire::generated::SetVoiceFx;

use crate::core::Core;
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;

/// One pool entry (architecture §4.1's table: two biquads with their ramps, 16 bed gains, five
/// send ramps, yaw and the bed share ramp, ≈ 448 B). D1 sizes its entry type to fit, as
/// `VOICE_SLOT_BYTES` does for the voices.
pub const FX_ENTRY_BYTES: usize = 448;

/// A pool entry (architecture §4.1's table, api-and-models §3.1): exactly [`FX_ENTRY_BYTES`].
/// `owner == 0` is a free entry, so the zeroed region is an empty pool.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct FxEntry {
    /// The voice's low-pass (`min(lpHz, lpAuto)`) and high-pass (`hpHz`) with their log-Hz ramps.
    pub filter: FxFilter,
    /// The last quantum's 16 bed encode gains (A4).
    pub bed_gains: [f32; 16],
    /// Zone send levels into slots 0..3 (SET_VOICE_FX `send[k]`), ramped (C4's tap reads them).
    pub send: [Ramp; 4],
    /// The aux send level, ramped (C4).
    pub aux: Ramp,
    /// The bed share during a panner kind change (A4).
    pub bed_share: Ramp,
    /// The voice slot holding the entry, plus 1; 0 when free.
    pub owner: u16,
    /// The aux send's bus (`AUX_BUS_NONE` none).
    pub aux_bus: u16,
    /// SET_VOICE_FX `yaw`, radians (ambisonic voices, B3).
    pub yaw: f32,
    pub reserved: u32,
}

const _: () = assert!(core::mem::size_of::<FxEntry>() == FX_ENTRY_BYTES, "an entry is FX_ENTRY_BYTES");
const _: () = assert!(core::mem::align_of::<FxEntry>() <= REGION_ALIGN);

impl FxEntry {
    /// A fresh entry for voice slot `index` (promotion resets the voice's effect state): filters
    /// off, sends and aux at 0 with no bus, yaw 0.
    pub fn fresh(index: usize) -> FxEntry {
        let _ = index;
        todo!("D1 glue")
    }

    /// `true` while a zone send isn't settled at 0: the voice then runs filter, tap, dry gain
    /// (R11 as clarified); otherwise M2's order.
    #[inline]
    pub fn sending(&self) -> bool {
        self.send.iter().any(|s| !(s.is_settled() && s.value == 0.0))
    }
}

/// The `Fx` region's size: `max_mixed × FX_ENTRY_BYTES`, rounded to a region alignment (28 / 56 /
/// 112 KB at 64 / 128 / 256 mixed).
pub const fn region_bytes(p: &InitParams) -> usize {
    (p.max_mixed as usize * FX_ENTRY_BYTES).div_ceil(REGION_ALIGN) * REGION_ALIGN
}

/// SET_VOICE_FX (C3) for `fx.voice_id`, at the absolute frame `at` or asap (`None`): stamped like
/// SET_PARAMS. K2: dropped; D1 applies it to the voice's pool entry (a virtual voice keeps none).
pub fn set_voice_fx(core: &mut Core, fx: &SetVoiceFx, at: Option<u64>) {
    let _ = (core, fx, at);
}

/// RESET (§4.2: "RESET clears … the pool"). K2: a no-op.
pub fn reset(core: &mut Core) {
    let _ = core;
}
