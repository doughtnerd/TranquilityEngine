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
//! (stepped as the panner will step it, without moving the panner's ramps) into `auxBus`'s
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
use crate::zones::{self, aux_accumulator, sends_area};
use crate::QUANTUM;

/// Once per quantum, before any voice renders (`voices::render`, right after
/// `automation::begin_quantum`, so the buses' automation `gainMul` for this quantum is known): each
/// configured bus's chain gain to the root (`chain::fill`) into the sends area, when some mixed
/// voice's pool entry has a send that isn't settled at 0 or an aux bus (SET_VOICE_FX applies on
/// arrival, so no voice starts sending inside the render); otherwise the area says "none".
pub fn begin_quantum(core: &mut Core) {
    let active = crate::fxpool::entries(&mut core.regions_mut().fx[..]).iter().any(|e| e.owner != 0 && (e.sending() || e.aux_bus != AUX_BUS_NONE as u16));
    let count = if active { crate::bus::count(core).clamp(1, core.params().max_buses as usize) } else { 0 };
    let mut gains = [0.0f32; QUANTUM];
    for b in 0..count {
        crate::chain::fill(core, b as u16, None, &mut gains);
        if let Some((_, table)) = sends_area(&mut core.regions_mut().zones[..]) {
            if let Some(dst) = table.get_mut(b * QUANTUM..(b + 1) * QUANTUM) {
                dst.copy_from_slice(&gains);
            }
        }
    }
    let zones = &mut core.regions_mut().zones[..];
    let mut stale = [0u32; 8];
    if let Some((h, _)) = sends_area(zones) {
        h.buses = count as u32;
        // An aux sent to a bus a BUS_CONFIG then removed inside the render was never added: drop it.
        stale = core::mem::take(&mut h.aux_dirty);
    }
    if stale != [0; 8] {
        for (b, chunk) in aux_accumulator(zones).chunks_exact_mut(2 * QUANTUM).enumerate().take(8 * 32) {
            if stale[b / 32] & 1 << (b % 32) != 0 {
                chunk.fill(0.0);
            }
        }
    }
}

/// The chain gains of `bus` (a bus past the configured ones is bus 0, as the voices route it) for
/// frames `from..from + n`, times `level` stepped per frame, into `out`; `false` when this quantum
/// has no chain gains (then `level` still moves).
#[inline(never)]
fn scaled_gains(zones: &mut [u8], bus: u16, level: &mut Ramp, from: usize, out: &mut [f32]) -> bool {
    let n = out.len();
    let table = match sends_area(zones) {
        Some((h, table)) if h.buses != 0 => {
            let b = if (bus as u32) < h.buses { bus as usize } else { 0 };
            table.get(b * QUANTUM + from..b * QUANTUM + from + n)
        }
        _ => None,
    };
    let Some(g) = table else {
        level.advance(n as u32);
        return false;
    };
    if level.is_settled() {
        let v = level.value;
        for (o, g) in out.iter_mut().zip(g) {
            *o = v * g;
        }
    } else {
        for (o, g) in out.iter_mut().zip(g) {
            *o = level.next() * g;
        }
    }
    true
}

/// The zone send tap (step 4): `l`, `r` are frames `from..from + l.len()` of the quantum of a mixed
/// voice on `bus`, after its own filters and before its dry gain (a mono voice has the same samples
/// in both). `send` is the voice's four send ramps (SET_VOICE_FX `send[k]`, ramped over its
/// `rampFrames`), which the tap advances one step per frame. `zones` is the `Zones` region, where
/// the slot inputs and the chain gains live: `send[k] × ½(l + r) × chain gain` into both inputs of
/// slot `k`, when it takes sends.
pub fn tap(send: &mut [Ramp; 4], zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32]) {
    let n = l.len().min(QUANTUM - from.min(QUANTUM));
    let mut mono = [0.0f32; QUANTUM];
    let mut unit = Ramp::at(0.5);
    let ok = scaled_gains(zones, bus, &mut unit, from, &mut mono[..n]);
    for i in 0..n {
        mono[i] *= l[i] + r[i];
    }
    for (k, s) in send.iter_mut().enumerate() {
        if s.is_settled() && s.value == 0.0 {
            continue;
        }
        let input = if ok { zones::slot_input(zones, k) } else { None };
        let Some((il, ir)) = input else {
            s.advance(n as u32);
            continue;
        };
        let mut level = [0.0f32; QUANTUM];
        s.fill(&mut level[..n]);
        for i in 0..n {
            let x = level[i] * mono[i];
            il[from + i] += x;
            ir[from + i] += x;
        }
    }
}

/// The aux tap (step 6): `l`, `r` as in [`tap`] but after the dry gain (post-fader) and before the
/// panner; `aux` is the aux level ramp and `aux_bus` its bus (never `AUX_BUS_NONE`: the caller skips
/// those); `panner` is the voice's panner state, whose equal-power matrix pans the send. Adds
/// `aux × chain gain × matrix (l, r)` into `aux_bus`'s accumulator for [`add_aux`].
#[allow(clippy::too_many_arguments)]
pub fn tap_aux(aux: &mut Ramp, aux_bus: u16, zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32], panner: &PannerState) {
    if aux.is_settled() && aux.value == 0.0 {
        return;
    }
    let n = l.len().min(QUANTUM - from.min(QUANTUM));
    let b = aux_bus as usize;
    let mut g = [0.0f32; QUANTUM];
    if !scaled_gains(zones, bus, aux, from, &mut g[..n]) {
        return;
    }
    match sends_area(zones) {
        Some((h, _)) if b < h.buses as usize => h.aux_dirty[b / 32] |= 1 << (b % 32),
        _ => return,
    }
    let acc = aux_accumulator(zones);
    let Some(acc) = acc.get_mut(b * 2 * QUANTUM..(b + 1) * 2 * QUANTUM) else {
        return;
    };
    let (acc_l, acc_r) = acc.split_at_mut(QUANTUM);
    let mut m = panner.matrix;
    for i in 0..n {
        let [a, bb, c, d] = [m[0].next(), m[1].next(), m[2].next(), m[3].next()];
        acc_l[from + i] += g[i] * (a * l[i] + bb * r[i]);
        acc_r[from + i] += g[i] * (c * l[i] + d * r[i]);
    }
}

/// The pre-effects input hook (`bus::mixdown`): adds this quantum's aux sends aimed at `bus` into
/// its input `l`, `r`, and clears them. `zones` is the `Zones` region, where the aux accumulator
/// lives. A bus no aux send aimed at this quantum is left as it is, bit for bit.
pub fn add_aux(zones: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let bit = 1u32 << (bus % 32);
    match sends_area(zones) {
        Some((h, _)) if bus < 256 && h.aux_dirty[bus / 32] & bit != 0 => h.aux_dirty[bus / 32] &= !bit,
        _ => return,
    }
    let acc = aux_accumulator(zones);
    let Some(acc) = acc.get_mut(bus * 2 * QUANTUM..(bus + 1) * 2 * QUANTUM) else {
        return;
    };
    let (acc_l, acc_r) = acc.split_at_mut(QUANTUM);
    for (d, s) in l.iter_mut().zip(acc_l.iter()).chain(r.iter_mut().zip(acc_r.iter())) {
        *d += *s;
    }
    acc.fill(0.0);
}
