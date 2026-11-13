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
//! quantum (a stamped bus gain record) reaches the sends a quantum later than the dry path.
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

// --- The bus reverb send (ADR 0172 §3.1, O1: post-fader; architecture §4.5 "Post-fader sends",
// R11; api-and-models §4.6). K1 routes it; Rv1 (W3) fills the scaling and the run-out. ---
//
// **Post-fader (O1, ARCH §4.5 "Post-fader sends").** `fx.process` writes the reverb slot's
// contribution (send × the signal at that slot, before the snapshot low-pass, which the send still
// bypasses) into the 1 KB scratch; once the bus's gain for the quantum exists (`lanes::apply`: all
// seven lanes, `authored`, `runtime`, `snapshot`, `monitor`, `dip`, `duck`, `automation`), [`feed`]
// multiplies the scratch by it and adds it to the convolver input. A muted, faded, ducked, dipped
// or monitor-muted bus stops feeding the reverb; a bus at a settled 1 (`Gain::Unity`) skips the
// multiply, bit-identical with the pre-fader send.
//
// **The run-out (R11, ARCH §3.3 and §4.7 "Last reverb send removed").** The shared convolver runs
// while a configured bus has a reverb send or a send fed it this quantum; after the last send goes
// it keeps running on silent input until that input has been silent for the IR's length plus
// `zones::IDLE_MARGIN_QUANTA` (every history is exact zeros by then, as for a zone slot), then it is
// reset ([`audio_dsp::convolver::reset`]: histories cleared, clock restarted), so the tail rings out
// and a later send starts from a clean convolver with nothing stale to replay. "Silent" is counted
// from the last quantum a send existed (a send at gain 0 counts as input: conservative, the
// run-out is never shorter than the tail).

/// The `Sends` region's header (64 B): Rv1's run-out state. All-zero valid (no tail to ring out).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct SendHead {
    /// Quanta since a send last existed (has_reverb or sent) while [`live`](Self::live): the
    /// run-out ends once this passes the IR length plus `IDLE_MARGIN_QUANTA` ([`run_out_quanta`]).
    pub silent_quanta: u32,
    /// Non-zero while the convolver may hold a tail: set on every quantum a send exists, cleared by
    /// the reset that ends the run-out. Zero: the convolver is idle and its state is clean.
    pub live: u32,
    pub _reserved: [u32; 14],
}

/// The `Sends` region (ARCH §6): the header and the shared bus send scratch, planar stereo
/// (2 × 128 f32 = 1 KB, one buffer for every bus, since buses mix one at a time): 1,088 B on every
/// preset. `#[repr(C)]`, all-zero valid (an empty scratch).
#[repr(C)]
pub struct SendArea {
    pub head: SendHead,
    /// The bus's reverb contribution, left: each reverb-send slot's `send × signal at that slot`
    /// (`FxChain::process`). Zero between buses ([`feed`] clears it).
    pub l: [f32; QUANTUM],
    /// The same, right.
    pub r: [f32; QUANTUM],
}

/// The `Sends` region's size.
pub const REGION_BYTES: usize = core::mem::size_of::<SendArea>();

const _: () = assert!(REGION_BYTES == 64 + 1024, "ARCH §6: the 1 KB send scratch plus Rv1's 64 B header");
const _: () = assert!(core::mem::align_of::<SendArea>() <= crate::layout::REGION_ALIGN);

/// The send area in the `Sends` region (`None` when the region is too short, never after
/// `Core::new`).
pub fn area(region: &mut [u8]) -> Option<&mut SendArea> {
    if region.len() < REGION_BYTES {
        return None;
    }
    // SAFETY: the region is 64-byte aligned (Layout), at least REGION_BYTES long (checked) and
    // zeroed at init; all-zero is a valid SendArea (integers and floats). Only `bus::mixdown`
    // (through this function) and this module view these bytes.
    Some(unsafe { &mut *(region.as_mut_ptr() as *mut SendArea) })
}

/// The bus reverb send into the shared convolver's input (`bus::mixdown`, after the bus's gain
/// stage): `area.l`, `area.r` hold this bus's reverb contribution for the quantum; they are added
/// into `rev_l`, `rev_r` (the convolver input) and cleared. `gain` is what `lanes::apply`
/// multiplied the bus by, and `curve` its per-frame gain when that is `Gain::Curve`.
///
/// Post-fader (O1, ARCH §4.5): `rev += scratch × gain`, frame by frame:
/// - `Gain::Unity`: no multiply, `rev + (0 + x)` is `rev + x` bit for bit, today's pre-fader send
///   (a bus with two or more send slots sums them in the scratch first, `rev + (a + b)`, which may
///   differ from `(rev + a) + b` in the last bit; build log D2);
/// - `Gain::Scalar(0.0)` (a settled mute, dip or monitor mute): nothing is added, the scratch is
///   cleared;
/// - `Gain::Scalar(g)`: `rev + x·g`; `Gain::Curve`: `rev[i] + x[i]·curve[i]`, the real per-frame
///   curve (a stamped mid-quantum lane record lands on its own frame, build log B1b).
///
/// Called only for a bus whose chain wrote the scratch this quantum.
#[inline(never)]
pub fn feed(area: &mut SendArea, gain: crate::lanes::Gain, curve: &[f32; QUANTUM], rev_l: &mut [f32], rev_r: &mut [f32]) {
    use crate::lanes::Gain;
    match gain {
        Gain::Unity => {
            drain_into(rev_l, &mut area.l);
            drain_into(rev_r, &mut area.r);
        }
        Gain::Scalar(g) if g == 0.0 => {
            area.l.fill(0.0);
            area.r.fill(0.0);
        }
        Gain::Scalar(g) => {
            drain_scaled(rev_l, &mut area.l, &[g; QUANTUM]);
            drain_scaled(rev_r, &mut area.r, &[g; QUANTUM]);
        }
        Gain::Curve => {
            drain_scaled(rev_l, &mut area.l, curve);
            drain_scaled(rev_r, &mut area.r, curve);
        }
    }
}

/// `dst[i] += src[i] · g[i]`, then `src[i] = 0`.
#[inline(never)]
fn drain_scaled(dst: &mut [f32], src: &mut [f32; QUANTUM], g: &[f32; QUANTUM]) {
    for (d, (s, g)) in dst.iter_mut().zip(src.iter_mut().zip(g)) {
        *d += core::mem::take(s) * *g;
    }
}

/// Quanta of silent input after which the shared convolver's state is exact zeros: its IR's
/// length in quanta plus `zones::IDLE_MARGIN_QUANTA` (the zone slots' rule, `zones.rs:116`). 0 when
/// `reverb` holds no prepared response (nothing to ring out).
pub fn run_out_quanta(reverb: &[u8]) -> u32 {
    audio_dsp::convolver::kernel::Kernel::parse(reverb).map_or(0, |k| k.frames().div_ceil(QUANTUM).min(u32::MAX as usize) as u32 + zones::IDLE_MARGIN_QUANTA)
}

/// Whether the shared convolver runs this quantum (`bus::mixdown`, after every bus fed it):
/// `has_reverb` (a configured bus has a reverb send) or `sent` (a send fed it this quantum), as
/// before M5; and the run-out (R11, ARCH §3.3): with no send left it keeps running on silent input
/// until that input has been silent for more than [`run_out_quanta`] quanta, then resets
/// `reverb` (the convolver's region) and stops, so removing the last send no longer cuts the tail
/// and a later send replays nothing stale. Allocates nothing; the reset is one clear of the
/// convolver's histories, once per run-out.
#[inline]
pub fn convolver_should_run(area: &mut SendArea, reverb: &mut [u8], has_reverb: bool, sent: bool) -> bool {
    let h = &mut area.head;
    if has_reverb || sent {
        h.live = 1;
        h.silent_quanta = 0;
        return true;
    }
    if h.live == 0 {
        return false;
    }
    h.silent_quanta = h.silent_quanta.saturating_add(1);
    if h.silent_quanta <= run_out_quanta(reverb) {
        return true;
    }
    audio_dsp::convolver::reset(reverb);
    h.live = 0;
    h.silent_quanta = 0;
    false
}
