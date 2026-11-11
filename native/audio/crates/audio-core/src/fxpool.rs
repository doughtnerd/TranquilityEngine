//! The mixed-voice effect pool (ADR 0162, api-and-models §3.1, §4.2 SET_VOICE_FX, architecture
//! §4.1, contract C17): one entry per mixed voice (448 B each, the `Fx` region, sized from
//! `max_mixed`), holding the voice's low-pass and high-pass with their log-Hz ramps
//! (`audio_dsp::fxfilter`), its zone send and aux ramps, yaw, bed gains and bed share ramp.
//!
//! **Who holds an entry** (`voices.rs` drives it; R12, "virtual voices hold nothing"):
//! - a voice takes an entry when it becomes mixed: PLAY with the mixed flag, a promote (SET_MIXED),
//!   or, if the pool was full then, the first quantum it renders mixed with one free. The entry is
//!   [`FxEntry::fresh`] (promotion resets the effect state, as M1 resets filter state) and takes the
//!   voice's `lpHz` at once (the voice is silent there) or, taken late on an audible voice, over
//!   `MIN_RAMP_FRAMES`;
//! - a mixed voice keeps it through a demote that turns round; it gives it back when it stops being
//!   mixed (a demote or pause fade settled, a scheduled voice demoted) and when its slot is freed or
//!   taken over. RESET clears the pool.
//! - Main keeps mixed voices at or under `max_mixed`, but voices fading out still hold theirs for
//!   5 ms, so a promote can find the pool full: it then takes the entry of a voice that is fading
//!   out (it loses its filter and sends for the rest of that fade), else it goes without (renders
//!   unfiltered with no sends, M2's path) and retries each quantum. There is no pool-full counter
//!   (api-and-models §4.3).
//!
//! `slot.fx` is the entry index plus 1 and `entry.owner` the slot index plus 1; both must agree.
//!
//! **SET_VOICE_FX** ([`set_voice_fx`]) applies when it arrives (coordinator ruling, D1): the
//! scheduler can't queue it (its fields don't fit a pending record), so a stamped record on a voice
//! already playing starts its ramps up to one lookahead early; on a voice not started yet it lands
//! as stamped. A virtual voice's record is dropped (main re-sends with the promote). Values on a
//! silent voice (not started, or its mix at 0: a promote just begun) jump; on an audible one they
//! ramp over `rampFrames` (cut-offs over at least `MIN_RAMP_FRAMES`). Ambisonic voices take no
//! high-pass ("clips are never filtered", C17).
//!
//! STATUS `fxVoices` ([`report`]): entries whose low-pass or high-pass ran in the last quantum.

use audio_dsp::fxfilter::{FxFilter, MIN_RAMP_FRAMES};
use audio_dsp::ramp::Ramp;
use audio_wire::generated::{self as wire, SetVoiceFx};

use crate::core::Core;
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;

/// One pool entry (architecture §4.1's table: two biquads with their ramps, 16 bed gains, five
/// send ramps, yaw and the bed share ramp), as `VOICE_SLOT_BYTES` is for the voices.
pub const FX_ENTRY_BYTES: usize = 448;

// S20: the filter's thresholds are the wire's constants.
const _: () = assert!(audio_dsp::fxfilter::LP_TOP as u32 == wire::LP_TOP && audio_dsp::fxfilter::HP_BOTTOM as u32 == wire::HP_BOTTOM);
const _: () = assert!(audio_dsp::fxfilter::LP_OFF_HZ as u32 == wire::BUS_LP_OFF_HZ);
const _: () = assert!(audio_dsp::fxfilter::Q_DB == crate::fx::SNAPSHOT_Q_DB, "automation's low-pass keeps M2's Q");

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
    /// The yaw an ambisonic voice's rotation ended the last quantum on (B3: the next quantum ramps
    /// from it); NaN in a fresh entry (the first quantum starts at `yaw`).
    pub yaw_last: f32,
}

const _: () = assert!(core::mem::size_of::<FxEntry>() == FX_ENTRY_BYTES, "an entry is FX_ENTRY_BYTES");
const _: () = assert!(core::mem::align_of::<FxEntry>() <= REGION_ALIGN);

impl FxEntry {
    /// A fresh entry for voice slot `index` (promotion resets the voice's effect state): filters
    /// off, sends and aux at 0 with no bus, yaw 0, bed gains 0.
    pub fn fresh(index: usize) -> FxEntry {
        FxEntry {
            filter: FxFilter::off(),
            bed_gains: [0.0; 16],
            send: [Ramp::at(0.0); 4],
            aux: Ramp::at(0.0),
            bed_share: Ramp::at(0.0),
            owner: index as u16 + 1,
            aux_bus: wire::AUX_BUS_NONE as u16,
            yaw: 0.0,
            yaw_last: f32::NAN,
        }
    }

    /// `true` while a zone send isn't settled at 0: the voice then runs filter, tap, dry gain
    /// (R11 as clarified); otherwise M2's order.
    #[inline]
    pub fn sending(&self) -> bool {
        self.send.iter().any(|s| !(s.is_settled() && s.value == 0.0))
    }

    /// SET_VOICE_FX's masked fields. `silent`: jump instead of ramping. `ambisonic`: no high-pass.
    pub fn apply(&mut self, fx: &SetVoiceFx, silent: bool, ambisonic: bool) {
        let frames = if silent { 0 } else { fx.ramp_frames };
        if fx.mask & wire::SET_VOICE_FX_MASK_HP_HZ != 0 && !ambisonic {
            self.filter.set_highpass(fx.hp_hz, cutoff_frames(silent, fx.ramp_frames));
        }
        if fx.mask & wire::SET_VOICE_FX_MASK_SENDS != 0 {
            for (ramp, &level) in self.send.iter_mut().zip(fx.send.iter()) {
                ramp.set_target(finite_or_zero(level), frames);
            }
        }
        if fx.mask & wire::SET_VOICE_FX_MASK_YAW != 0 {
            self.yaw = finite_or_zero(fx.yaw);
        }
        if fx.mask & wire::SET_VOICE_FX_MASK_AUX != 0 {
            self.aux.set_target(finite_or_zero(fx.aux_level), frames);
            self.aux_bus = fx.aux_bus;
        }
    }
}

/// The frames a cut-off change takes: 0 on a silent voice, else `ramp_frames` raised to
/// `MIN_RAMP_FRAMES` (click-free, `fxfilter`).
#[inline]
pub fn cutoff_frames(silent: bool, ramp_frames: u32) -> u32 {
    if silent {
        0
    } else {
        ramp_frames.max(MIN_RAMP_FRAMES)
    }
}

fn finite_or_zero(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

/// The `Fx` region's size: `max_mixed × FX_ENTRY_BYTES`, rounded to a region alignment (28 / 56 /
/// 112 KB at 64 / 128 / 256 mixed).
pub const fn region_bytes(p: &InitParams) -> usize {
    (p.max_mixed as usize * FX_ENTRY_BYTES).div_ceil(REGION_ALIGN) * REGION_ALIGN
}

/// The entries, viewed over the `Fx` region (at least `max_mixed` of them).
pub fn entries(region: &mut [u8]) -> &mut [FxEntry] {
    // SAFETY: the region is REGION_ALIGN-aligned (Layout) and zeroed at init; only this module and
    // `voices.rs` (through this view) touch it. An entry is read only once `owner` is set, after
    // `FxEntry::fresh` wrote it whole; a free entry's other bytes are never read, so every bit
    // pattern there is fine (all fields are plain numbers anyway).
    unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut FxEntry, region.len() / FX_ENTRY_BYTES) }
}

/// Takes a free entry for voice slot `index`, fresh; returns its index plus 1, or `None` when the
/// pool is full.
pub fn acquire(pool: &mut [FxEntry], index: usize) -> Option<u16> {
    let at = pool.iter().position(|e| e.owner == 0)?;
    pool[at] = FxEntry::fresh(index);
    Some(at as u16 + 1)
}

/// The entry `fx` (index plus 1) of voice slot `index`, if it really holds it.
#[inline]
pub fn owned(pool: &mut [FxEntry], fx: u16, index: usize) -> Option<&mut FxEntry> {
    if fx == 0 {
        return None;
    }
    pool.get_mut(fx as usize - 1).filter(|e| e.owner as usize == index + 1)
}

/// Gives back entry `fx` (index plus 1) if voice slot `index` holds it.
#[inline]
pub fn release(pool: &mut [FxEntry], fx: u16, index: usize) {
    if let Some(e) = owned(pool, fx, index) {
        e.owner = 0;
    }
}

/// SET_VOICE_FX (C3) for `fx.voice_id`, applied on arrival whatever `at` (see the module notes).
pub fn set_voice_fx(core: &mut Core, fx: &SetVoiceFx, at: Option<u64>) {
    let _ = at;
    if let Some((entry, silent, ambisonic)) = crate::voices::fx_entry(core, fx.voice_id) {
        entry.apply(fx, silent, ambisonic);
    }
}

/// RESET (§4.2: "RESET clears … the pool"): every entry free.
pub fn reset(core: &mut Core) {
    core.regions_mut().fx.fill(0);
}

/// After the render: STATUS `fxVoices`, the entries whose filters ran.
pub fn report(core: &mut Core) {
    let n = entries(&mut core.regions_mut().fx[..]).iter().filter(|e| e.owner != 0 && e.filter.running()).count();
    crate::status::counters_mut(core).spatial.fx_voices = n.min(u16::MAX as usize) as u16;
}
