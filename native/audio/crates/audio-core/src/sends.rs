//! Voice sends (ADR 0162, api-and-models §4.4 and §5.1 build-plan additions, contracts C1, C5 and
//! C17): the pre-distance zone send tap ([`tap`], called from `voices.rs`, K3) feeding the zone
//! inputs, the post-fader aux tap ([`tap_aux`], also from `voices.rs`) and the aux add into a bus
//! ([`add_aux`], from `bus.rs`'s pre-effects input hook), all scaled by the bus-chain gain of
//! `chain.rs`.
//!
//! Declared by K2 (`add_aux`) and K3 ([`begin_quantum`], [`tap`], [`tap_aux`] and their call sites
//! in `voices.rs`); filled by task C4.
//!
//! **The chain gain** (api-and-models §4.4): a send takes the bus-chain gain to the root of the
//! voice's own bus (volume, mute, solo, ducking and automation `gainMul` of the bus and its
//! ancestors; effects and MASTER excluded), frame by frame as `bus::mixdown` applies it
//! (`chain::fill`), so a send follows a ducked or muted bus as the dry path does. The taps see only
//! the `Zones` region, so [`begin_quantum`] writes every configured bus's gains into its sends area
//! (`zones::sends_area`), and only while some mixed voice has a send or an aux bus: a core without
//! sends pays a scan of the pool and nothing else. A record that moves a bus's gain inside the
//! quantum (a stamped BUS_MIX) reaches the sends a quantum later than the dry path.
//!
//! **Zone send** ([`tap`]): `send[k] × ½(l + r) × chain gain` into both inputs of slot `k` (a
//! mono voice has `l = r`, so it sends its sample as is). A slot that doesn't take sends (off,
//! ringing out, evicting, or past `max_zone_slots`) gets nothing; its ramp still moves.
//!
//! **Aux send** ([`tap_aux`]): post-fader, `aux × chain gain ×` the voice's equal-power matrix
//! (its value where the panner starts the rendered range: a pan ramp moves the aux per range, not
//! per frame, for code size) into `auxBus`'s
//! accumulator (`zones::aux_accumulator`); an `auxBus` past the configured buses is dropped (main
//! reports it). [`add_aux`] adds it into the bus's input before its effects and clears it, so the
//! aux bus's own effects, fader and chain apply on top. Aux sends work without zone slots.
//!
//! **Where the hooks run** (architecture §4, R11 as clarified, C17), for a mixed voice whose pool
//! entry (`fxpool.rs`) has a zone send that isn't settled at 0:
//! 1. resample; 2. fade and mix ramps, automation `gainMul`; 3. the voice's own filters (low-pass
//!    `min(lpHz, lpAuto)`, high-pass; mono-once); 4. **[`tap`]**; 5. the dry `gain` ramp;
//!    6. **[`tap_aux`]** (when the entry has an aux bus); 7. the panner; 8. into the bus.
//!
//! A voice with no zone send keeps M2's order (the dry `gain` with the fade and mix, then
//! `gainMul`, then the filters), so every M2 golden stays bit-identical; it still calls
//! [`tap_aux`] after its filters when it has an aux bus (post-fader either way). Voices without a
//! pool entry (virtual voices, or a mixed voice past a full pool) call neither hook.

use audio_dsp::ramp::Ramp;
use audio_wire::generated::AUX_BUS_NONE;

use crate::core::Core;
use crate::panner::PannerState;
use crate::zones::{self, sends_area};
use crate::QUANTUM;

/// Once per quantum, before any voice renders (`voices::render`, right after
/// `automation::begin_quantum`, so the buses' automation `gainMul` for this quantum is known): each
/// configured bus's chain gain to the root (`chain::fill`) into the sends area, when some mixed
/// voice's pool entry has a send that isn't settled at 0 or an aux bus (SET_VOICE_FX applies on
/// arrival, so no voice starts sending inside the render); otherwise the area says "none".
#[inline(never)]
pub fn begin_quantum(core: &mut Core) {
    // A send that is moving or not at +0 (a superset of `FxEntry::sending`, cheaper), or an aux bus.
    let active = crate::fxpool::entries(&mut core.regions_mut().fx[..]).iter().any(|e| e.owner != 0 && (e.aux_bus != AUX_BUS_NONE as u16 || e.send.iter().fold(0, |a, s| a | s.remaining | s.value.to_bits()) != 0));
    let count = if active { crate::bus::count(core).max(1).min(core.params().max_buses as usize) } else { 0 };
    let Some(area) = sends_area(&mut core.regions_mut().zones[..]) else {
        return;
    };
    // An aux sent to a bus a BUS_CONFIG then removed inside the render was never added: drop it.
    if core::mem::take(&mut area.head.aux_dirty) != [0; 8] {
        area.aux.fill(0.0);
    }
    area.head.buses = count as u32;
    let table: *mut [f32] = area.gains;
    // SAFETY: the sends area is in the `Zones` region; `chain::fill` reads the buses and the
    // automation region and never views `Zones`.
    for b in 0..count {
        if let Some(gains) = unsafe { &mut *table }.get_mut(b * QUANTUM..).and_then(|t| t.first_chunk_mut::<QUANTUM>()) {
            crate::chain::fill(core, b as u16, None, gains);
        }
    }
}

/// The one loop of every send: `dst[i] += g[i] · (a·l[i] + b·r[i])` over the shortest slice
/// (½ and ½ for a zone send's mono sum, a panner matrix row for an aux send).
#[inline(never)]
fn weigh_into(dst: &mut [f32], g: &[f32], a: f32, b: f32, l: &[f32], r: &[f32]) {
    for (d, ((g, l), r)) in dst.iter_mut().zip(g.iter().zip(l).zip(r)) {
        *d += *g * (a * *l + b * *r);
    }
}

/// The chain gains of `bus` (a bus past the configured ones is bus 0, as the voices route it) for
/// frames `from..from + n`, times `level` stepped per frame, into `out`; `false` when this
/// quantum has no chain gains (then `level` still moves).
#[inline(never)]
fn scaled_gains(zones: &mut [u8], bus: u16, level: &mut Ramp, from: usize, n: usize, out: &mut [f32; QUANTUM]) -> bool {
    let table = match sends_area(zones) {
        Some(a) if a.head.buses != 0 => a.gains.get(if (bus as u32) < a.head.buses { bus as usize } else { 0 } * QUANTUM + from..),
        _ => None,
    };
    let Some(g) = table else {
        level.advance(n as u32);
        return false;
    };
    for (o, g) in out.iter_mut().zip(g).take(n) {
        *o = level.next() * *g;
    }
    true
}

/// The zone send tap (step 4): `l`, `r` are frames `from..from + l.len()` of the quantum of a mixed
/// voice on `bus`, after its own filters and before its dry gain (a mono voice has the same samples
/// in both). `send` is the voice's four send ramps (SET_VOICE_FX `send[k]`, ramped over its
/// `rampFrames`), which the tap advances one step per frame. `zones` is the `Zones` region, where
/// the slot inputs and the chain gains live: `send[k] × chain gain × (½l + ½r)` into both inputs
/// of slot `k`, when it takes sends (a mono voice, `l = r`, sends exactly its sample).
#[inline(never)]
pub fn tap(send: &mut [Ramp; 4], zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32]) {
    for (k, s) in send.iter_mut().enumerate() {
        send_into(s, zones, bus, from, l, r, k, [0.5; 4]);
    }
}

/// The aux tap (step 6): `l`, `r` as in [`tap`] but after the dry gain (post-fader) and before the
/// panner; `aux` is the aux level ramp and `aux_bus` its bus (never `AUX_BUS_NONE`: the caller skips
/// those); `panner` is the voice's panner state, whose equal-power matrix `[a, b, c, d]` pans the
/// send, `aux × chain gain × (a·l + b·r, c·l + d·r)`, into `aux_bus`'s accumulator for
/// [`add_aux`]. The matrix is taken where the panner starts this range (a pan ramp moves the aux
/// send per rendered range, not per frame).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn tap_aux(aux: &mut Ramp, aux_bus: u16, zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32], panner: &PannerState) {
    let m = &panner.matrix;
    send_into(aux, zones, bus, from, l, r, SLOTS + aux_bus as usize, [m[0].value, m[1].value, m[2].value, m[3].value]);
}

/// Zone send slots (SET_VOICE_FX `send[4]`): [`send_into`]'s targets below this are slots, the rest
/// aux buses.
const SLOTS: usize = 4;

/// One send of a voice's block (frames `from..` of the quantum): `level × chain gain of bus ×
/// (w0·l + w1·r, w2·l + w3·r)` into target `to`'s stereo input (zone slot `to`, or aux bus
/// `to - SLOTS`'s accumulator), when it takes sends; `level` moves either way.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn send_into(level: &mut Ramp, zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32], to: usize, w: [f32; 4]) {
    if level.is_settled() && level.value == 0.0 {
        return;
    }
    let from = from.min(QUANTUM);
    let mut g = [0.0f32; QUANTUM];
    if !scaled_gains(zones, bus, level, from, l.len().min(QUANTUM - from), &mut g) {
        return;
    }
    let (dl, dr) = if to < SLOTS {
        let Some(input) = zones::slot_input(zones, to) else {
            return;
        };
        input
    } else {
        let b = to - SLOTS;
        let Some(area) = sends_area(zones).filter(|a| b < a.head.buses as usize) else {
            return;
        };
        area.head.aux_dirty[b / 32 % 8] |= 1 << (b % 32);
        let Some(acc) = area.aux.get_mut(b * 2 * QUANTUM..(b + 1) * 2 * QUANTUM) else {
            return;
        };
        acc.split_at_mut(QUANTUM)
    };
    weigh_into(&mut dl[from..], &g, w[0], w[1], l, r);
    weigh_into(&mut dr[from..], &g, w[2], w[3], l, r);
}

/// The pre-effects input hook (`bus::mixdown`): adds this quantum's aux sends aimed at `bus` into
/// its input `l`, `r`, and clears them. `zones` is the `Zones` region, where the aux accumulator
/// lives. A bus no aux send aimed at this quantum is left as it is, bit for bit.
pub fn add_aux(zones: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let bit = 1u32 << (bus % 32);
    let Some(area) = sends_area(zones).filter(|a| bus < 256 && a.head.aux_dirty[bus / 32] & bit != 0) else {
        return;
    };
    area.head.aux_dirty[bus / 32] &= !bit;
    for (dst, src) in [l, r].into_iter().zip(area.aux.chunks_exact_mut(QUANTUM).skip(2 * bus)) {
        drain_into(dst, src);
    }
}

/// `dst[i] += src[i]`, then `src[i] = 0`.
#[inline(never)]
fn drain_into(dst: &mut [f32], src: &mut [f32]) {
    for (d, s) in dst.iter_mut().zip(src) {
        *d += core::mem::take(s);
    }
}
