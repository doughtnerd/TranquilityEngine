//! Parameters, curves and automation (ADR 0158 §3, §4, §6; api-and-models §4.2 CURVES, AUTOMATE,
//! PARAM, BUS_AUTOMATE, SET_LOOP).
//!
//! Main does the event-driven work (it picks clips, allocates instance `group` ids and curve ids,
//! uploads curves once, sends a voice's bindings right after its PLAY and a PARAM when a
//! parameter's target changes); the core does the continuous work here, once per quantum:
//!
//! 1. **Parameters** ([`begin_quantum`], before any voice renders): every parameter whose value
//!    hasn't reached its target moves toward it by `seekPerSecond × 128 / sampleRate`, never
//!    overshooting. 64 global slots, and 16 local slots for each instance `group` 1..=1024. PARAM
//!    with seek 0 jumps. Out-of-range groups and slots are ignored; main resets a reused group's
//!    locals itself (the core has no instance lifecycle).
//! 2. **Curves** (CURVES): 1,024 curves of at most 32 keys, evaluated exactly as
//!    `src/engine/core/curve.ts` (in f32): flat before the first key and after the last, NaN reads
//!    the first key, `step` holds until the next key, keys with the same x jump, and the shapes
//!    smooth `u²(3−2u)`, easeIn `u²`, easeOut `1−(1−u)²`. An empty or undefined curve is 0.
//! 3. **Voice bindings** (AUTOMATE, up to 8 per voice): each quantum the voice's volume curves
//!    multiply into `gainMul`, its pitch curves into `pitchMul`, and its lowpass curves give
//!    `lpAuto` (their minimum; 24,000 Hz when none), each curve evaluated once (control rate).
//!    The voices' render loop (`voices.rs`) multiplies the voice's gain by `gainMul` and its pitch
//!    by `pitchMul`, both ramped linearly from the last quantum's value to this one across the
//!    quantum (per frame), and filters a voice with a lowpass binding through its own biquad at
//!    `min(lpHz, lpAuto)` (Q as the bus snapshot low-pass), set once per quantum. The first quantum
//!    after an AUTOMATE starts at the evaluated values with no ramp. A local binding of a voice
//!    whose PLAY `group` is 0 or out of range reads 0. Voices with no bindings pay nothing and
//!    render bit for bit as before (the per-voice filter exists only for voices with a lowpass
//!    binding; `lpHz` alone still isn't applied, as in M1).
//! 4. **Bus bindings** (BUS_AUTOMATE, global parameters only, up to 8 per bus): `gainMul` on top of
//!    the bus's BUS_MIX gain, ramped the same way, and the snapshot low-pass at
//!    `min(BUS_MIX lpHz, lpAuto)`.
//! 5. **Loop regions** (SET_LOOP, clip voices): kept beside the bindings ([`VoiceAuto`]); the
//!    render loop reads them. See [`set_loop`].
//!
//! **Timing.** CURVES, PARAM, AUTOMATE and BUS_AUTOMATE apply when they arrive (between quanta),
//! whatever their `frameOffset`; a voice's AUTOMATE finds it because PLAY writes its slot at once.
//! SET_LOOP is stamped like every voice record (`scheduler.rs`).
//!
//! **Memory.** Everything lives in the `Automation` region (`layout.rs`), sized by
//! [`region_bytes`]: a header, the parameter table and its seeking list, the curve table, one
//! [`BusAuto`] per bus, and one [`VoiceAuto`] per voice slot with a dense list of the slots that
//! have bindings or a loop region, so a quantum touches only those. All-zero is valid (nothing
//! bound, every parameter 0, every curve empty). RESET zeroes the region. Nothing allocates.

use audio_dsp::biquad::Biquad;
use audio_wire::generated as wire;

use crate::core::{Core, Regions};
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;
use crate::QUANTUM;

/// Global parameter slots (PARAM `group` 0).
pub const GLOBAL_PARAMS: usize = 64;
/// Instance groups (PARAM `group` 1..=GROUPS, PLAY `group`).
pub const GROUPS: usize = 1_024;
/// Local parameter slots per group.
pub const LOCAL_PARAMS: usize = 16;
/// Every parameter: the globals, then each group's locals.
pub const PARAMS: usize = GLOBAL_PARAMS + GROUPS * LOCAL_PARAMS;
/// Curve ids 0..CURVES.
pub const CURVES: usize = 1_024;
/// Keys kept per curve (extra keys are ignored).
pub const CURVE_KEYS: usize = 32;
/// Bindings kept per voice and per bus (extra ones are ignored).
pub const BINDINGS: usize = 8;
/// `lpAuto` with no lowpass binding, and the cut-off that means "off" (the wire's `BUS_LP_OFF_HZ`).
pub const LP_OFF_HZ: f32 = wire::BUS_LP_OFF_HZ as f32;

/// Binding targets (AUTOMATE / BUS_AUTOMATE `target`).
pub mod target {
    pub const VOLUME: u32 = 0;
    pub const PITCH: u32 = 1;
    pub const LOWPASS: u32 = 2;
}

/// `VoiceAuto::targets` / `BusAuto::targets` bits: which kinds of binding are present.
pub mod has {
    pub const GAIN: u8 = 1 << 0;
    pub const PITCH: u8 = 1 << 1;
    pub const LOWPASS: u8 = 1 << 2;
}

/// One parameter. All-zero is a settled parameter at 0.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Param {
    pub value: f32,
    pub target: f32,
    /// The most the value moves per quantum while seeking (`seekPerSecond × 128 / sampleRate`).
    pub step: f32,
    /// Position in the seeking list plus 1; 0 when settled.
    pub seeking: u32,
}

/// One curve: `count` keys (at most [`CURVE_KEYS`]) as parallel arrays. All-zero is empty.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Curve {
    pub count: u32,
    pub x: [f32; CURVE_KEYS],
    pub y: [f32; CURVE_KEYS],
    /// The shape from each key to the next: 0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut
    /// (anything else is linear, as `curve.ts`'s default).
    pub interp: [u8; CURVE_KEYS],
}

/// One binding: AUTOMATE's and BUS_AUTOMATE's item, as on the wire.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Binding {
    /// Bit 15 set: global slot (low 15 bits); clear: local slot of the voice's group.
    pub param: u16,
    pub curve: u16,
    pub target: u32,
}

/// A voice slot's automation and loop state, at the slot's index. Valid for the voice whose id it
/// holds (PLAY writes `id` and `group` and clears the rest of the state that matters). All-zero is
/// nothing bound.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct VoiceAuto {
    /// The voice id this entry belongs to (PLAY's `voiceId`).
    pub id: u32,
    /// PLAY's `group` (0 none).
    pub group: u16,
    /// Bindings in use.
    pub count: u8,
    /// Non-zero right after an AUTOMATE: the next quantum starts at the evaluated values.
    pub fresh: u8,
    /// [`has`] bits of the bindings.
    pub targets: u8,
    /// Non-zero while a SET_LOOP region loops (clip voices).
    pub loop_on: u8,
    pub _pad: u16,
    /// Position in the active list plus 1; 0 when not in it.
    pub list: u32,
    /// SET_LOOP's region in clip frames (`loop_end` 0 is the clip's end).
    pub loop_start: u32,
    pub loop_end: u32,
    /// `gainMul` at the end of the last quantum and of this one (ramped between).
    pub g0: f32,
    pub g1: f32,
    /// `pitchMul`, as `g0`, `g1`.
    pub p0: f32,
    pub p1: f32,
    /// `lpAuto` for this quantum.
    pub lp: f32,
    pub bindings: [Binding; BINDINGS],
    /// The voice's low-pass, used only while it has a lowpass binding.
    pub filter: Biquad,
}

impl VoiceAuto {
    /// `true` when the entry has something for the voice `id`: bindings or a loop region.
    #[inline]
    pub fn active_for(&self, id: u32) -> bool {
        self.id == id && (self.count != 0 || self.loop_on != 0)
    }

    /// `gainMul` at frame `j` (0..128) of the quantum.
    #[inline]
    pub fn gain_at(&self, j: usize) -> f32 {
        ramp_at(self.g0, self.g1, j)
    }

    /// `pitchMul` at frame `j` of the quantum.
    #[inline]
    pub fn pitch_at(&self, j: usize) -> f32 {
        ramp_at(self.p0, self.p1, j)
    }
}

/// A bus's automation state. All-zero is nothing bound.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BusAuto {
    pub count: u8,
    pub fresh: u8,
    pub targets: u8,
    pub _pad: u8,
    pub g0: f32,
    pub g1: f32,
    pub lp: f32,
    pub bindings: [Binding; BINDINGS],
}

impl BusAuto {
    /// `gainMul` at frame `j` of the quantum.
    #[inline]
    pub fn gain_at(&self, j: usize) -> f32 {
        ramp_at(self.g0, self.g1, j)
    }
}

/// `a` at the start of the quantum to `b` at its last frame, linearly: frame `j` is
/// `a + (b - a)(j + 1)/128`, so the next quantum continues from exactly `b`.
#[inline]
pub fn ramp_at(a: f32, b: f32, j: usize) -> f32 {
    if a == b {
        b
    } else {
        a + (b - a) * ((j + 1) as f32 * (1.0 / QUANTUM as f32))
    }
}

/// The region's scalars, first in the region. All-zero is valid but [`init`] fills it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Header {
    /// Entries in the active voice list.
    pub active_len: u32,
    /// Parameters in the seeking list.
    pub seeking_len: u32,
    /// Buses with bindings.
    pub buses_bound: u32,
    pub sample_rate: f32,
    pub max_logical: u32,
    pub max_buses: u32,
}

/// Where each table sits in the region (bytes from its start).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sections {
    params: usize,
    seeking: usize,
    curves: usize,
    buses: usize,
    active: usize,
    voices: usize,
    total: usize,
}

const fn align(n: usize) -> usize {
    (n + REGION_ALIGN - 1) / REGION_ALIGN * REGION_ALIGN
}

const fn sections(max_logical: usize, max_buses: usize) -> Sections {
    let params = align(core::mem::size_of::<Header>());
    let seeking = align(params + PARAMS * core::mem::size_of::<Param>());
    let curves = align(seeking + PARAMS * core::mem::size_of::<u16>());
    let buses = align(curves + CURVES * core::mem::size_of::<Curve>());
    let active = align(buses + max_buses * core::mem::size_of::<BusAuto>());
    let voices = align(active + max_logical * core::mem::size_of::<u32>());
    let total = align(voices + max_logical * core::mem::size_of::<VoiceAuto>());
    Sections { params, seeking, curves, buses, active, voices, total }
}

const _: () = assert!(PARAMS <= u16::MAX as usize, "seeking list entries are u16");
const _: () = assert!(core::mem::align_of::<VoiceAuto>() <= REGION_ALIGN);

/// The `Automation` region's size for `p` (`layout.rs`).
pub fn region_bytes(p: &InitParams) -> usize {
    sections(p.max_logical as usize, p.max_buses as usize).total
}

/// The region's tables, viewed together.
pub(crate) struct View<'a> {
    pub header: &'a mut Header,
    pub params: &'a mut [Param],
    pub seeking: &'a mut [u16],
    pub curves: &'a mut [Curve],
    pub buses: &'a mut [BusAuto],
    pub active: &'a mut [u32],
    pub voices: &'a mut [VoiceAuto],
}

/// Views the region's tables. The header must have been filled by [`init`] (its `max_logical` and
/// `max_buses` place the tables); an empty region (a zero-size test layout) gives empty tables.
pub(crate) fn view(region: &mut [u8]) -> Option<View<'_>> {
    if region.len() < core::mem::size_of::<Header>() {
        return None;
    }
    let base = region.as_mut_ptr();
    // SAFETY: the region is 64-byte aligned and zeroed at init (Layout); all-zero bytes are a valid
    // Header, Param, u16, Curve, BusAuto, u32 and VoiceAuto (integers, floats, arrays of them, and a
    // Biquad that `audio-dsp` keeps all-zero valid). `sections` places each table at an aligned
    // offset inside `region_bytes`, which `init` checked the region holds for the header's sizes.
    // The slices don't overlap. Only this module (and the render loops, through it) views these bytes.
    unsafe {
        let header = &mut *(base as *mut Header);
        let s = sections(header.max_logical as usize, header.max_buses as usize);
        if s.total > region.len() {
            return None;
        }
        let (ml, mb) = (header.max_logical as usize, header.max_buses as usize);
        Some(View {
            header,
            params: core::slice::from_raw_parts_mut(base.add(s.params) as *mut Param, PARAMS),
            seeking: core::slice::from_raw_parts_mut(base.add(s.seeking) as *mut u16, PARAMS),
            curves: core::slice::from_raw_parts_mut(base.add(s.curves) as *mut Curve, CURVES),
            buses: core::slice::from_raw_parts_mut(base.add(s.buses) as *mut BusAuto, mb),
            active: core::slice::from_raw_parts_mut(base.add(s.active) as *mut u32, ml),
            voices: core::slice::from_raw_parts_mut(base.add(s.voices) as *mut VoiceAuto, ml),
        })
    }
}

/// Fills the header (called once by `Core::new`, and again after RESET zeroes the region).
pub fn init(core: &mut Core) {
    let p = *core.params();
    write_header(&mut core.regions_mut().automation[..], &p);
}

fn write_header(region: &mut [u8], p: &InitParams) {
    if region.len() < region_bytes(p) {
        return;
    }
    // SAFETY: as in `view`: the region starts with a Header and is large enough.
    let header = unsafe { &mut *(region.as_mut_ptr() as *mut Header) };
    *header = Header { sample_rate: p.sample_rate, max_logical: p.max_logical, max_buses: p.max_buses, ..Header::default() };
}

/// RESET: clears every table (curves, parameters, bindings, loop regions).
pub fn reset(core: &mut Core) {
    core.regions_mut().automation.fill(0);
    init(core);
}

// --- The parameter table ---

/// The flat index of PARAM `group`/`slot`, or `None` when out of range.
fn param_index(group: u16, slot: u16) -> Option<usize> {
    let (group, slot) = (group as usize, slot as usize);
    if group == 0 {
        (slot < GLOBAL_PARAMS).then_some(slot)
    } else if group <= GROUPS && slot < LOCAL_PARAMS {
        Some(GLOBAL_PARAMS + (group - 1) * LOCAL_PARAMS + slot)
    } else {
        None
    }
}

/// A binding's parameter value for a voice in `group` (0 for anything out of range).
#[inline]
fn binding_value(params: &[Param], param: u16, group: u16) -> f32 {
    let index = if param & 0x8000 != 0 { param_index(0, param & 0x7FFF) } else { param_index(group, param).filter(|_| group != 0) };
    index.map_or(0.0, |i| params[i].value)
}

/// PARAM: sets a parameter's target; `seek_per_second` 0 (or not a positive finite number) jumps.
/// A non-finite value is ignored.
pub fn param(core: &mut Core, p: &wire::Param) {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let Some(index) = param_index(p.group, p.slot) else { return };
    if !p.value.is_finite() {
        return;
    }
    let param = &mut v.params[index];
    param.target = p.value;
    if p.seek_per_second.is_finite() && p.seek_per_second > 0.0 {
        param.step = p.seek_per_second * QUANTUM as f32 / v.header.sample_rate;
        if param.value != param.target && param.seeking == 0 {
            let at = v.header.seeking_len as usize;
            v.seeking[at] = index as u16;
            param.seeking = at as u32 + 1;
            v.header.seeking_len += 1;
        }
    } else {
        param.value = p.value;
        param.step = 0.0;
        // Left in the seeking list if it was: the next quantum finds it settled and drops it.
    }
}

/// A parameter's current value (tests and a debugger).
pub fn param_value(core: &mut Core, group: u16, slot: u16) -> Option<f32> {
    let v = view(&mut core.regions_mut().automation[..])?;
    param_index(group, slot).map(|i| v.params[i].value)
}

/// Moves every seeking parameter one quantum toward its target and drops the settled ones.
fn advance_params(v: &mut View<'_>) {
    let mut i = 0usize;
    while i < v.header.seeking_len as usize {
        let index = v.seeking[i] as usize;
        let p = &mut v.params[index];
        if p.value < p.target {
            p.value = (p.value + p.step).min(p.target);
        } else if p.value > p.target {
            p.value = (p.value - p.step).max(p.target);
        }
        if p.value == p.target || !(p.step > 0.0) {
            p.value = p.target;
            p.seeking = 0;
            let last = v.header.seeking_len as usize - 1;
            if i != last {
                let moved = v.seeking[last];
                v.seeking[i] = moved;
                v.params[moved as usize].seeking = i as u32 + 1;
            }
            v.header.seeking_len -= 1;
        } else {
            i += 1;
        }
    }
}

// --- Curves ---

/// The shape of a segment at `u` (`curve.ts`'s `curveShape`).
#[inline]
pub fn shape(interp: u8, u: f32) -> f32 {
    match interp {
        1 => 0.0,
        2 => u * u * (3.0 - 2.0 * u),
        3 => u * u,
        4 => 1.0 - (1.0 - u) * (1.0 - u),
        _ => u,
    }
}

/// The curve's value at `x` (`curve.ts`'s `evalCurve`, in f32). An empty curve is 0.
pub fn eval(c: &Curve, x: f32) -> f32 {
    let n = (c.count as usize).min(CURVE_KEYS);
    if n == 0 {
        return 0.0;
    }
    if !(x > c.x[0]) {
        return c.y[0]; // also NaN
    }
    if x >= c.x[n - 1] {
        return c.y[n - 1];
    }
    let (mut lo, mut hi) = (0usize, n - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if c.x[mid] <= x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let span = c.x[hi] - c.x[lo];
    if span <= 0.0 {
        return c.y[hi];
    }
    c.y[lo] + (c.y[hi] - c.y[lo]) * shape(c.interp[lo], (x - c.x[lo]) / span)
}

#[inline]
fn curve_value(curves: &[Curve], curve: u16, x: f32) -> f32 {
    curves.get(curve as usize).map_or(0.0, |c| eval(c, x))
}

fn u16_at(msg: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([msg[off], msg[off + 1]])
}

fn u32_at(msg: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([msg[off], msg[off + 1], msg[off + 2], msg[off + 3]])
}

fn f32_at(msg: &[u8], off: usize) -> f32 {
    f32::from_bits(u32_at(msg, off))
}

/// `true` when the CURVES record at `msg[off..off + len]` holds its curves and their keys (pass 1
/// of `submit`; the generated reader would allocate).
pub fn curves_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    let end = off + len;
    if len < wire::Curves::FIXED_END || end > msg.len() {
        return false;
    }
    let count = u32_at(msg, off + 16) as usize;
    let mut cur = off + wire::Curves::FIXED_END;
    for _ in 0..count {
        if cur + wire::CurvesCurves::FIXED_END > end {
            return false;
        }
        let keys = u16_at(msg, cur) as usize;
        cur += wire::CurvesCurves::FIXED_END + keys * wire::CurvesCurvesKeys::FIXED_END;
        if cur > end {
            return false;
        }
    }
    true
}

/// `true` when an AUTOMATE or BUS_AUTOMATE record at `msg[off..off + len]` holds its bindings.
pub fn bindings_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::Automate::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 12) as usize;
    n.checked_mul(wire::AutomateBindings::FIXED_END).is_some_and(|bytes| wire::Automate::FIXED_END + bytes <= len)
}

/// CURVES: defines or overwrites curves `firstCurve..` from the (well-formed) record at `msg[off..]`.
/// Ids out of range and keys past [`CURVE_KEYS`] are ignored. Keys arrive sorted by x.
pub fn curves(core: &mut Core, msg: &[u8], off: usize) {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let first = u32_at(msg, off + 12) as usize;
    let count = u32_at(msg, off + 16) as usize;
    let mut cur = off + wire::Curves::FIXED_END;
    for i in 0..count {
        let keys = u16_at(msg, cur) as usize;
        cur += wire::CurvesCurves::FIXED_END;
        if let Some(c) = first.checked_add(i).and_then(|id| v.curves.get_mut(id)) {
            let n = keys.min(CURVE_KEYS);
            c.count = n as u32;
            for k in 0..n {
                let at = cur + k * wire::CurvesCurvesKeys::FIXED_END;
                c.x[k] = f32_at(msg, at);
                c.y[k] = f32_at(msg, at + 4);
                c.interp[k] = u32_at(msg, at + 8).min(255) as u8;
            }
        }
        cur += keys * wire::CurvesCurvesKeys::FIXED_END;
    }
}

/// Reads up to [`BINDINGS`] bindings of the (well-formed) record at `msg[off..]` into `out`;
/// returns how many, and their [`has`] bits. `bus` keeps only global volume and lowpass bindings.
fn read_bindings(msg: &[u8], off: usize, out: &mut [Binding; BINDINGS], bus: bool) -> (u8, u8) {
    let n = u32_at(msg, off + 12) as usize;
    let (mut count, mut targets) = (0usize, 0u8);
    for i in 0..n {
        if count == BINDINGS {
            break;
        }
        let at = off + wire::Automate::FIXED_END + i * wire::AutomateBindings::FIXED_END;
        let b = Binding { param: u16_at(msg, at), curve: u16_at(msg, at + 2), target: u32_at(msg, at + 4) };
        let bit = match b.target {
            target::VOLUME => has::GAIN,
            target::PITCH if !bus => has::PITCH,
            target::LOWPASS => has::LOWPASS,
            _ => continue,
        };
        if bus && b.param & 0x8000 == 0 {
            continue;
        }
        out[count] = b;
        count += 1;
        targets |= bit;
    }
    (count as u8, targets)
}

/// AUTOMATE: replaces voice `voiceId`'s bindings (count 0 clears them). A stale id is dropped.
pub fn automate(core: &mut Core, msg: &[u8], off: usize) {
    let voice_id = u32_at(msg, off + 4);
    let Some(index) = crate::voices::live_index(core, voice_id) else { return };
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let e = &mut v.voices[index];
    if e.id != voice_id {
        // Not seen at its PLAY (can't happen for a voice played since init); no group.
        *e = zeroed_voice();
        e.id = voice_id;
    }
    let had_lowpass = e.count != 0 && e.targets & has::LOWPASS != 0;
    let (count, targets) = read_bindings(msg, off, &mut e.bindings, false);
    e.count = count;
    e.targets = targets;
    e.fresh = 1;
    if targets & has::LOWPASS != 0 && !had_lowpass {
        e.filter = Biquad::default();
    }
    if count != 0 {
        enlist(v.header, v.active, e, index);
    }
}

/// BUS_AUTOMATE: replaces bus `voiceId`'s bindings (global volume and lowpass only).
pub fn bus_automate(core: &mut Core, msg: &[u8], off: usize) {
    let bus = u32_at(msg, off + 4) as usize;
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let Some(b) = v.buses.get_mut(bus) else { return };
    let was = b.count != 0;
    let (count, targets) = read_bindings(msg, off, &mut b.bindings, true);
    b.count = count;
    b.targets = targets;
    b.fresh = 1;
    match (was, count != 0) {
        (false, true) => v.header.buses_bound += 1,
        (true, false) => v.header.buses_bound -= 1,
        _ => {}
    }
}

/// SET_LOOP on voice `voice_id` (clip voices; see `voices::set_loop`, which clears the slot's
/// whole-clip loop flag): with `looping`, the voice loops `start..end` (`end` 0 is the clip's end);
/// without, the region ends (a release).
pub fn set_loop(core: &mut Core, index: usize, voice_id: u32, start: u32, end: u32, looping: bool) {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let Some(e) = v.voices.get_mut(index) else { return };
    if e.id != voice_id {
        *e = zeroed_voice();
        e.id = voice_id;
    }
    e.loop_on = looping as u8;
    e.loop_start = start;
    e.loop_end = end;
    if looping {
        enlist(v.header, v.active, e, index);
    }
}

/// PLAY on slot `index`: the entry now belongs to `voice_id` in `group`, with nothing bound and no
/// loop region. (A stale list entry is dropped by the next quantum.)
pub fn on_play(core: &mut Core, index: usize, voice_id: u32, group: u16) {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let Some(e) = v.voices.get_mut(index) else { return };
    e.id = voice_id;
    e.group = group;
    e.count = 0;
    e.targets = 0;
    e.loop_on = 0;
}

fn zeroed_voice() -> VoiceAuto {
    // SAFETY: all-zero is a valid VoiceAuto (see `view`).
    unsafe { core::mem::zeroed() }
}

fn enlist(header: &mut Header, active: &mut [u32], e: &mut VoiceAuto, index: usize) {
    if e.list == 0 {
        let at = header.active_len as usize;
        active[at] = index as u32;
        e.list = at as u32 + 1;
        header.active_len += 1;
    }
}

// --- Per quantum ---

/// Evaluates bindings: `(gainMul, pitchMul, lpAuto)`.
fn evaluate(params: &[Param], curves: &[Curve], bindings: &[Binding], group: u16) -> (f32, f32, f32) {
    let (mut g, mut p, mut lp) = (1.0f32, 1.0f32, LP_OFF_HZ);
    for b in bindings {
        let y = curve_value(curves, b.curve, binding_value(params, b.param, group));
        match b.target {
            target::VOLUME => g *= y,
            target::PITCH => p *= y,
            target::LOWPASS => lp = lp.min(y),
            _ => {}
        }
    }
    if !(g.is_finite() && g >= 0.0) {
        g = 0.0;
    }
    if !(p.is_finite() && p >= 0.0) {
        p = 1.0;
    }
    if !(lp >= 0.0) {
        lp = 0.0;
    }
    (g, p, lp.min(LP_OFF_HZ))
}

/// Step 1 of the quantum, before any voice renders (`voices::render`): advances the parameters,
/// drops list entries whose voice is gone, and evaluates every voice's and bus's bindings. Costs
/// three loads when nothing is seeking or bound.
pub fn begin_quantum(core: &mut Core) {
    let regions: &mut Regions = core.regions_mut();
    let voices = crate::voices::slots_of(&regions.voices[..]);
    let Some(mut v) = view(&mut regions.automation[..]) else { return };
    if v.header.seeking_len == 0 && v.header.active_len == 0 && v.header.buses_bound == 0 {
        return;
    }
    if v.header.seeking_len != 0 {
        advance_params(&mut v);
    }
    let mut i = 0usize;
    while i < v.header.active_len as usize {
        let index = v.active[i] as usize;
        let e = &mut v.voices[index];
        let live = voices.get(index).is_some_and(|s| s.id == e.id && crate::voices::is_live_state(s.state));
        if !live || (e.count == 0 && e.loop_on == 0) {
            e.list = 0;
            let last = v.header.active_len as usize - 1;
            if i != last {
                let moved = v.active[last];
                v.active[i] = moved;
                v.voices[moved as usize].list = i as u32 + 1;
            }
            v.header.active_len -= 1;
            continue;
        }
        if e.count != 0 {
            let (g, p, lp) = evaluate(v.params, v.curves, &e.bindings[..e.count as usize], e.group);
            if e.fresh != 0 {
                e.fresh = 0;
                e.g0 = g;
                e.p0 = p;
            } else {
                e.g0 = e.g1;
                e.p0 = e.p1;
            }
            e.g1 = g;
            e.p1 = p;
            e.lp = lp;
        }
        i += 1;
    }
    if v.header.buses_bound != 0 {
        for b in v.buses.iter_mut() {
            if b.count == 0 {
                continue;
            }
            let (g, _, lp) = evaluate(v.params, v.curves, &b.bindings[..b.count as usize], 0);
            b.g0 = if b.fresh != 0 { g } else { b.g1 };
            b.fresh = 0;
            b.g1 = g;
            b.lp = lp;
        }
    }
}

/// The voices' automation entries for the render loop: `None` when no voice has any (the render
/// loop then takes exactly its M1 path for every voice).
pub(crate) fn voice_entries(region: &mut [u8]) -> Option<&mut [VoiceAuto]> {
    let v = view(region)?;
    (v.header.active_len != 0).then_some(v.voices)
}

/// The buses' automation entries for `bus::mixdown`, or `None` when no bus has bindings.
pub(crate) fn bus_entries(region: &mut [u8]) -> Option<&mut [BusAuto]> {
    let v = view(region)?;
    (v.header.buses_bound != 0).then_some(v.buses)
}

/// Voices with bindings or a loop region (tests).
pub fn active_count(core: &mut Core) -> u32 {
    view(&mut core.regions_mut().automation[..]).map_or(0, |v| v.header.active_len)
}

/// A voice slot's entry (tests and a debugger).
pub fn voice_entry(core: &mut Core, index: usize) -> Option<VoiceAuto> {
    view(&mut core.regions_mut().automation[..]).and_then(|v| v.voices.get(index).copied())
}

/// A bus's entry (tests and a debugger).
pub fn bus_entry(core: &mut Core, bus: usize) -> Option<BusAuto> {
    view(&mut core.regions_mut().automation[..]).and_then(|v| v.buses.get(bus).copied())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A curve from `(x, y, interp)` keys.
    fn curve(keys: &[(f32, f32, u8)]) -> Curve {
        let mut c: Curve = unsafe { core::mem::zeroed() };
        c.count = keys.len() as u32;
        for (i, k) in keys.iter().enumerate() {
            c.x[i] = k.0;
            c.y[i] = k.1;
            c.interp[i] = k.2;
        }
        c
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    // The cases of `src/engine/tests/curve.test.ts`.

    #[test]
    fn is_0_when_empty_and_flat_beyond_the_ends() {
        assert_eq!(eval(&curve(&[]), 3.0), 0.0);
        let c = curve(&[(1.0, 2.0, 0), (3.0, 6.0, 0)]);
        assert_eq!(eval(&c, -5.0), 2.0);
        assert_eq!(eval(&c, 9.0), 6.0);
        assert_eq!(eval(&c, f32::NAN), 2.0);
    }

    #[test]
    fn interpolates_linearly_by_default() {
        assert!(close(eval(&curve(&[(0.0, 0.0, 0), (10.0, 1.0, 0)]), 2.5), 0.25));
        assert!(close(eval(&curve(&[(0.0, 0.0, 0), (1.0, 10.0, 0), (2.0, 0.0, 0)]), 1.5), 5.0));
        assert!(close(eval(&curve(&[(0.0, 0.0, 9), (10.0, 1.0, 0)]), 2.5), 0.25), "an unknown shape is linear");
    }

    #[test]
    fn holds_a_step_until_the_next_key() {
        let c = curve(&[(0.0, 1.0, 1), (1.0, 5.0, 0)]);
        assert_eq!(eval(&c, 0.999), 1.0);
        assert_eq!(eval(&c, 1.0), 5.0);
    }

    #[test]
    fn shapes_smooth_ease_in_and_ease_out_segments() {
        assert!(close(eval(&curve(&[(0.0, 0.0, 2), (1.0, 1.0, 0)]), 0.25), 0.15625));
        assert!(close(eval(&curve(&[(0.0, 0.0, 3), (1.0, 1.0, 0)]), 0.5), 0.25));
        assert!(close(eval(&curve(&[(0.0, 0.0, 4), (1.0, 1.0, 0)]), 0.5), 0.75));
        for s in [0u8, 2, 3, 4] {
            assert_eq!(shape(s, 0.0), 0.0);
            assert_eq!(shape(s, 1.0), 1.0);
        }
    }

    #[test]
    fn jumps_at_keys_with_the_same_x() {
        let c = curve(&[(0.0, 0.0, 0), (1.0, 1.0, 0), (1.0, 4.0, 0), (2.0, 4.0, 0)]);
        assert!(close(eval(&c, 0.5), 0.5));
        assert_eq!(eval(&c, 1.0), 4.0);
        assert_eq!(eval(&c, 1.5), 4.0);
    }

    #[test]
    fn finds_the_right_segment_in_a_long_curve() {
        let keys: Vec<(f32, f32, u8)> = (0..32).map(|i| (i as f32, i as f32 * 2.0, 0)).collect();
        let c = curve(&keys);
        for x in [0.5f32, 17.25, 23.9, 30.5] {
            assert!(close(eval(&c, x), x * 2.0), "{x}");
        }
    }

    #[test]
    fn param_indices_stay_in_range() {
        assert_eq!(param_index(0, 0), Some(0));
        assert_eq!(param_index(0, 63), Some(63));
        assert_eq!(param_index(0, 64), None);
        assert_eq!(param_index(1, 0), Some(64));
        assert_eq!(param_index(1024, 15), Some(PARAMS - 1));
        assert_eq!(param_index(1025, 0), None);
        assert_eq!(param_index(3, 16), None);
    }

    #[test]
    fn the_ramp_lands_on_its_end_at_the_last_frame() {
        assert_eq!(ramp_at(0.0, 1.0, QUANTUM - 1), 1.0);
        assert_eq!(ramp_at(0.5, 0.5, 7), 0.5);
        assert!(close(ramp_at(0.0, 1.0, 63), 0.5));
    }

    #[test]
    fn the_default_preset_region_size() {
        let p = InitParams { sample_rate: 48_000.0, max_logical: 4_096, max_mixed: 128, max_buses: 32, arena_initial_bytes: 16 << 20 };
        let n = region_bytes(&p);
        eprintln!("automation region: {n} B (VoiceAuto {} B, Curve {} B, BusAuto {} B)", core::mem::size_of::<VoiceAuto>(), core::mem::size_of::<Curve>(), core::mem::size_of::<BusAuto>());
        assert!(n < 2 << 20, "{n}");
    }
}
