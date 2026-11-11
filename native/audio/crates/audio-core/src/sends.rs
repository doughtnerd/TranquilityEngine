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
use crate::zones::{self, sends_area};
use crate::QUANTUM;

/// Once per quantum, before any voice renders (`voices::render`, right after
/// `automation::begin_quantum`, so the buses' automation `gainMul` for this quantum is known): each
/// configured bus's chain gain to the root (`chain::fill`) into the sends area, when some mixed
/// voice's pool entry has a send that isn't settled at 0 or an aux bus (SET_VOICE_FX applies on
/// arrival, so no voice starts sending inside the render); otherwise the area says "none".
pub fn begin_quantum(core: &mut Core) {
    // A send that is moving or not at +0 (a superset of `FxEntry::sending`, cheaper), or an aux bus.
    let active = crate::fxpool::entries(&mut core.regions_mut().fx[..]).iter().any(|e| e.owner != 0 && (e.aux_bus != AUX_BUS_NONE as u16 || e.send.iter().any(|s| s.remaining | s.value.to_bits() != 0)));
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

/// `dst[i] += a[i] × b[i]` over the shortest of the three: every product the sends sum goes
/// through this one loop (code size).
#[inline(never)]
fn mac(dst: &mut [f32], a: &[f32], b: &[f32]) {
    for (d, (a, b)) in dst.iter_mut().zip(a.iter().zip(b)) {
        *d += *a * *b;
    }
}

/// `dst[i] += src[i]`, then `src[i] = 0`.
#[inline(never)]
fn drain_into(dst: &mut [f32], src: &mut [f32]) {
    for (d, s) in dst.iter_mut().zip(src) {
        *d += core::mem::take(s);
    }
}

/// The ramp's next `n` values (`n` at most a quantum) into `out`; the ramp moves.
#[inline(never)]
fn ramp_into(r: &mut Ramp, out: &mut [f32; QUANTUM], n: usize) {
    for x in out.iter_mut().take(n) {
        *x = r.next();
    }
}

/// The chain gains of `bus` (a bus past the configured ones is bus 0, as the voices route it) for
/// frames `from..from + n`, times `level` stepped per frame, into `out` (zeroed); `false` when this
/// quantum has no chain gains (then `level` still moves).
#[inline(never)]
fn scaled_gains(zones: &mut [u8], bus: u16, level: &mut Ramp, from: usize, n: usize, out: &mut [f32; QUANTUM]) -> bool {
    let mut steps = [0.0f32; QUANTUM];
    ramp_into(level, &mut steps, n);
    let table = match sends_area(zones) {
        Some(a) if a.head.buses != 0 => a.gains.get(if (bus as u32) < a.head.buses { bus as usize } else { 0 } * QUANTUM + from..),
        _ => None,
    };
    let Some(g) = table else {
        return false;
    };
    mac(&mut out[..n], &steps, g);
    true
}

/// `level × mono` into slot `k`'s inputs at `from` when it takes sends (and `ok`: the quantum has
/// chain gains); the ramp moves either way.
#[inline(never)]
fn send_one(s: &mut Ramp, zones: &mut [u8], ok: bool, k: usize, from: usize, n: usize, mono: &[f32]) {
    if s.is_settled() && (s.value == 0.0 || !ok) {
        return;
    }
    let mut level = [0.0f32; QUANTUM];
    ramp_into(s, &mut level, n);
    if let Some((il, ir)) = if ok { zones::slot_input(zones, k) } else { None } {
        for input in [il, ir] {
            if let Some(dst) = input.get_mut(from..) {
                mac(dst, &level[..n], mono);
            }
        }
    }
}

/// The zone send tap (step 4): `l`, `r` are frames `from..from + l.len()` of the quantum of a mixed
/// voice on `bus`, after its own filters and before its dry gain (a mono voice has the same samples
/// in both). `send` is the voice's four send ramps (SET_VOICE_FX `send[k]`, ramped over its
/// `rampFrames`), which the tap advances one step per frame. `zones` is the `Zones` region, where
/// the slot inputs and the chain gains live: `send[k] × ½(l + r) × chain gain` into both inputs of
/// slot `k`, when it takes sends.
pub fn tap(send: &mut [Ramp; 4], zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32]) {
    let from = from.min(QUANTUM);
    let n = l.len().min(r.len()).min(QUANTUM - from);
    let mut half = [0.0f32; QUANTUM];
    let ok = scaled_gains(zones, bus, &mut Ramp::at(0.5), from, n, &mut half);
    // ½g·l + ½g·r: a mono voice (l = r) sends exactly g·l.
    let mut mono = [0.0f32; QUANTUM];
    mac(&mut mono, &half, l);
    mac(&mut mono, &half, r);
    for (k, s) in send.iter_mut().enumerate() {
        send_one(s, zones, ok, k, from, n, &mono[..n]);
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
    let from = from.min(QUANTUM);
    let n = l.len().min(r.len()).min(QUANTUM - from);
    let b = aux_bus as usize;
    let mut g = [0.0f32; QUANTUM];
    if !scaled_gains(zones, bus, aux, from, n, &mut g) {
        return;
    }
    let Some(area) = sends_area(zones).filter(|a| b < a.head.buses as usize) else {
        return;
    };
    area.head.aux_dirty[b / 32 % 8] |= 1 << (b % 32);
    let Some(acc) = area.aux.get_mut(b * 2 * QUANTUM..(b + 1) * 2 * QUANTUM) else {
        return;
    };
    // The panner's equal-power matrix `[a, b, c, d]`, stepped as `PannerState::mix` will step it
    // (on a copy): L += g·(a·l + b·r), R += g·(c·l + d·r).
    let mut m = panner.matrix;
    let (acc_l, acc_r) = acc.split_at_mut(QUANTUM);
    let (ab, cd) = m.split_at_mut(2);
    pan_one(acc_l, ab, from, n, &g, l, r);
    pan_one(acc_r, cd, from, n, &g, l, r);
}

/// One channel of the aux tap: `acc[from + i] += g[i] · (w0[i]·l[i] + w1[i]·r[i])`, the two matrix
/// ramps `w` stepped per frame.
#[inline(never)]
fn pan_one(acc: &mut [f32], w: &mut [Ramp], from: usize, n: usize, g: &[f32; QUANTUM], l: &[f32], r: &[f32]) {
    let (mut w0, mut w1, mut x) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM], [0.0f32; QUANTUM]);
    if let [a, b] = w {
        ramp_into(a, &mut w0, n);
        ramp_into(b, &mut w1, n);
    }
    mac(&mut x[..n], &w0, l);
    mac(&mut x[..n], &w1, r);
    if let Some(dst) = acc.get_mut(from..) {
        mac(dst, &g[..n], &x);
    }
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
    if let Some(acc) = area.aux.get_mut(bus * 2 * QUANTUM..(bus + 1) * 2 * QUANTUM) {
        let (acc_l, acc_r) = acc.split_at_mut(QUANTUM);
        drain_into(l, acc_l);
        drain_into(r, acc_r);
    }
}
