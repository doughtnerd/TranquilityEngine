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
//! 2. **Curves** (CURVES): 1,024 curves of at most 64 keys, evaluated exactly as
//!    `src/engine/core/curve.ts` (in f32): flat before the first key and after the last, NaN reads
//!    the first key, `step` holds until the next key, keys with the same x jump, and the shapes
//!    smooth `u²(3−2u)`, easeIn `u²`, easeOut `1−(1−u)²`. An empty or undefined curve is 0.
//!    A Bézier segment (interp 5, ADR 0346) is the cubic through the key's out handle and the next
//!    key's in handle (a flat handle a third of the segment long when the next key isn't Bézier),
//!    control x clamped into the segment; its control points are worked out once, at CURVES, and
//!    the parameter at `x` is found by [`BEZIER_STEPS`] halvings. The evaluator is the shared
//!    `myco-curve` crate (`native/common/curve/`, ADR 0370), which the animation core links too;
//!    its parity test holds it to `curve.ts`.
//! 3. **Voice bindings** (AUTOMATE, up to 8 per voice): each quantum the voice's volume curves
//!    multiply into `gainMul`, its pitch curves into `pitchMul`, and its lowpass curves give
//!    `lpAuto` (their minimum; 24,000 Hz when none), each curve evaluated once (control rate).
//!    The voices' render loop (`voices.rs`) multiplies the voice's gain by `gainMul` and its pitch
//!    by `pitchMul`, both ramped linearly from the last quantum's value to this one across the
//!    quantum (per frame), and passes `lpAuto` of a voice with a lowpass binding to the voice's
//!    low-pass as a cap: it runs at `min(lpHz, lpAuto)` (Q as the bus snapshot low-pass), its
//!    coefficients set once per quantum. ADR 0162 D1 moved that filter into the voice's
//!    mixed-voice pool entry (`fxpool.rs`, `audio_dsp::fxfilter`), shared with `lpHz` for every
//!    voice, bit for bit as before. The first quantum after an AUTOMATE starts at the evaluated
//!    values with no ramp. A local binding of a voice whose PLAY `group` is 0 or out of range reads
//!    0. Voices with no bindings pay nothing here.
//!    ABI 4.4 (ADR 0345 voice level, 0343 entry curves) adds two voice targets: **highpass** (3)
//!    gives `hpAuto`, the highest of its curves (0 when none), passed to the voice's high-pass as a
//!    floor (`audio_dsp::fxfilter`: it runs at `max(hpHz, hpAuto)`); **pan** (4) gives `panAuto`,
//!    the sum of its curves clamped to −1..1, ramped across the quantum like `gainMul` and applied
//!    by the voice chain before the panner (equal-power on a mono voice, normalised so 0 is the
//!    identity; balance on a stereo one). Buses ignore both.
//! 4. **Bus bindings** (BUS_AUTOMATE, global parameters only, up to [`BUS_BINDINGS`] per bus):
//!    `gainMul` on top of the bus's main-written gain lanes (`lanes.rs`), ramped the same way, and
//!    the snapshot low-pass at `min(snapshot lane lpHz, lpAuto)`. ABI 4.8 (ADR 0344 automation)
//!    adds two kinds, their arguments in the target's upper bits (the wire's `AUTO_TARGET_*`):
//!    **fx** (5): a catalogue parameter of an effect in the bus's chain takes the curve's value
//!    (2^value with `AUTO_TARGET_LOG`, so frequencies interpolate in log scale), handed to the
//!    effect once a quantum before the chain runs (`bus::mixdown`, `fx::FxChain::automate`: the
//!    effect reaches it across the quantum); **send** (6): the curves' dB, summed per receiving
//!    bus, multiply that send's level as a gain ramped across the quantum (`bus_sends::feed`).
//!    Instance submixes take fx bindings too (SUBMIX_AUTOMATE, [`submix_bindings`], evaluated in
//!    `submix::render` from the submix's group).
//! 5. **Loop regions** (SET_LOOP, clip voices): kept beside the bindings ([`VoiceAuto`]); the
//!    render loop reads them. See [`set_loop`].
//! 7. **Loop programs** (LOOPS, ADR 0342, ABI 4.3; clip voices): up to `VOICE_LOOPS_MAX` loops with
//!    directions, counts, crossfades, hold points, activations, exits and re-entry, kept in a pool of
//!    [`PROGRAMS`] entries linked from the voice's entry ([`VoiceAuto::prog`], `loop_on`
//!    [`LOOP_PROGRAM`]; per voice slot they would cost ≈ 1.2 MB of the Memory's 16 MiB fixed-region
//!    headroom on the largest preset). With the pool full, a LOOPS program falls back to its first
//!    region as a SET_LOOP loop. `voice_loops.rs` runs them in the render loop. Here, once a quantum, every program's activations are worked out
//!    (`Program::want`: always, held until the key-off, or a parameter against its threshold).
//! 6. **Time parameters** (ADR 0346, ABI 4.2): a voice binding whose `param` has bit 14 set (bit 15
//!    clear) reads a time in seconds instead of a parameter slot, at the quantum's first frame:
//!    `voiceTime` (`TIME_VOICE`: the quantum's frame less the voice's start frame, 0 before it
//!    starts; paused time counts, as main's clock does), `clipTime` (`TIME_CLIP`: the voice's
//!    playhead over its clip's rate) or `sequenceTime` (`TIME_SEQUENCE`: the clock of the voice's
//!    group, [`GroupClock`]). TIME re-anchors a group's clock (stamped, like a voice record: it is
//!    applied at its frame when its quantum comes, `scheduler.rs` and `due.rs`); a clock reads
//!    `value + rate × (frame − anchor) / sampleRate`, so a running clock costs nothing until a
//!    binding reads it. A voice's start frame is taken while it is scheduled (its PLAY's stamp, or
//!    the first quantum after an asap PLAY) by [`begin_quantum`].
//! 8. **Generator parameters** (ADR 0360, ABI 5.1): a voice binding of target kind 5 (`AUTO_TARGET_GEN`, the
//!    parameter's index in bits 8-15, `AUTO_TARGET_LOG` for 2^value) hands its curve's value to the voice's generator
//!    (`generator::automate`) once a quantum in [`begin_quantum`]; the parameter glides to it over the quantum (at once
//!    for a binding just made or a voice not sounding yet). Buses read kind 5 as an effect parameter.
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

use audio_wire::generated as wire;

use crate::core::{Core, Regions};
use crate::voice_loops::{self, LoopDef, Program};
use crate::layout::REGION_ALIGN;
use crate::params::InitParams;
use crate::QUANTUM;
use crate::wire_read::{u16_at, u32_at};

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
/// Keys kept per curve (extra keys are ignored; ADR 0346 raised it from 32), the Bézier interp code
/// (CURVES `interp`) and the halvings of the Bézier parameter search (`curve.ts` `BEZIER_STEPS`):
/// the shared evaluator's (`myco-curve`, ADR 0370).
pub use myco_curve::{BEZIER_STEPS, CURVE_KEYS, INTERP_BEZIER};
/// Bindings kept per voice (extra ones are ignored).
pub const BINDINGS: usize = 8;
/// Bindings kept per bus and per submix (ABI 4.8: 8 before; extra ones are ignored).
pub const BUS_BINDINGS: usize = wire::BUS_AUTOMATE_MAX_BINDINGS as usize;
/// Sends a bus keeps (`bus_sends.rs`): the most send bindings resolve to.
pub const SEND_AUTOS: usize = wire::MAX_BUS_SENDS as usize;
/// Group clocks: the global one (group 0) and one per instance group.
pub const CLOCKS: usize = GROUPS + 1;
/// Loop programs in use at once (ADR 0342): voices playing a sample's own loops; more fall back to
/// a plain region.
pub const PROGRAMS: usize = 256;

/// One pool entry: the slot that owns it (index + 1, 0 free) and the program. All-zero is free.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct ProgramEntry {
    pub owner: u32,
    pub _pad: u32,
    pub prog: Program,
}

/// `VoiceAuto::loop_on`: a SET_LOOP region loops.
pub const LOOP_REGION: u8 = 1;
/// `VoiceAuto::loop_on`: a LOOPS program runs (ADR 0342).
pub const LOOP_PROGRAM: u8 = 2;
/// A clock or start frame not known yet (an asap TIME, a voice not seen scheduled).
pub const UNANCHORED: u64 = u64::MAX;
/// `lpAuto` with no lowpass binding, and the cut-off that means "off" (the wire's `BUS_LP_OFF_HZ`).
pub const LP_OFF_HZ: f32 = wire::BUS_LP_OFF_HZ as f32;

/// Binding targets (AUTOMATE / BUS_AUTOMATE `target`).
pub mod target {
    pub const VOLUME: u32 = 0;
    pub const PITCH: u32 = 1;
    pub const LOWPASS: u32 = 2;
    /// ABI 4.4: a high-pass cut-off floor (Hz), highest wins. Voices only.
    pub const HIGHPASS: u32 = 3;
    /// ABI 4.4: pan −1..1, summed. Voices only.
    pub const PAN: u32 = 4;
    /// ABI 4.8: an effect parameter (buses and submixes): slot, parameter and log flag above.
    pub const FX: u32 = audio_wire::generated::AUTO_TARGET_FX;
    /// ABI 5.1 (ADR 0360): a generator voice's parameter (voices; buses read kind 5 as `FX`): its index in bits 8-15,
    /// the log flag above.
    pub const GEN: u32 = audio_wire::generated::AUTO_TARGET_GEN;
    /// ABI 4.8: a send's dB (buses): the receiving slot above.
    pub const SEND: u32 = audio_wire::generated::AUTO_TARGET_SEND;
    /// Bits 0-7 of a target: its kind.
    pub const KIND: u32 = audio_wire::generated::AUTO_TARGET_KIND_MASK;

    /// The kind of target `t`.
    #[inline]
    pub const fn kind(t: u32) -> u32 {
        t & KIND
    }

    /// The slot argument of an fx or send target (bits 8-15).
    #[inline]
    pub const fn slot(t: u32) -> usize {
        ((t >> audio_wire::generated::AUTO_TARGET_SLOT_SHIFT) & 0xFF) as usize
    }

    /// The parameter argument of an fx target (bits 16-23).
    #[inline]
    pub const fn param(t: u32) -> usize {
        ((t >> audio_wire::generated::AUTO_TARGET_PARAM_SHIFT) & 0xFF) as usize
    }

    /// `true` when an fx target's curve is in log2 of the parameter.
    #[inline]
    pub const fn log(t: u32) -> bool {
        t & audio_wire::generated::AUTO_TARGET_LOG != 0
    }
}

/// `VoiceAuto::targets` / `BusAuto::targets` bits: which kinds of binding are present.
pub mod has {
    pub const GAIN: u8 = 1 << 0;
    pub const PITCH: u8 = 1 << 1;
    pub const LOWPASS: u8 = 1 << 2;
    pub const HIGHPASS: u8 = 1 << 3;
    pub const PAN: u8 = 1 << 4;
    /// ABI 4.8: effect-parameter bindings (buses).
    pub const FX: u8 = 1 << 5;
    /// ABI 4.8: send bindings (buses).
    pub const SEND: u8 = 1 << 6;
    /// ABI 5.1: generator-parameter bindings (voices).
    pub const GEN: u8 = 1 << 7;
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

/// One curve: `count` keys (at most [`CURVE_KEYS`]) as parallel arrays. All-zero is empty. The
/// shared evaluator's fixed layout (`myco_curve::Curve`).
pub use myco_curve::Curve;

/// A group's clock (`sequenceTime`, ADR 0346): `value` seconds at context frame `anchor`, moving at
/// `rate` seconds per second. All-zero is a parked clock at 0. `anchor` [`UNANCHORED`]: an asap
/// TIME, anchored at the next quantum's first frame.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GroupClock {
    pub value: f32,
    pub rate: f32,
    pub anchor: u64,
}

impl GroupClock {
    /// The clock at context frame `frame` (`sample_rate` frames per second).
    #[inline]
    pub fn at(&self, frame: u64, sample_rate: f32) -> f32 {
        if self.rate == 0.0 || self.anchor == UNANCHORED {
            return self.value;
        }
        let dt = (frame as f64 - self.anchor as f64) / sample_rate as f64;
        (self.value as f64 + self.rate as f64 * dt) as f32
    }
}

/// One binding: AUTOMATE's and BUS_AUTOMATE's item, as on the wire.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Binding {
    /// Bit 15 set: global slot (low 15 bits); bit 14 set (bit 15 clear): a time parameter
    /// (`TIME_*` in bits 0-1); both clear: local slot of the voice's group.
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
    /// [`LOOP_REGION`] while a SET_LOOP region loops, [`LOOP_PROGRAM`] while a LOOPS program runs
    /// (clip voices); 0 none.
    pub loop_on: u8,
    /// Non-zero when a binding reads a time parameter (ADR 0346).
    pub time: u8,
    pub _pad: u8,
    /// ADR 0342: its loop program's pool entry ([`ProgramEntry`]) plus 1; 0 none.
    pub prog: u16,
    /// ABI 4.9 (ROUTE): the submix slot the voice mixes into, plus 1 (its playlist level's); 0 its
    /// group's route. PLAY clears it.
    pub submix: u16,
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
    /// ABI 4.4: `hpAuto` for this quantum (0 with no highpass binding).
    pub hp: f32,
    /// ABI 4.4: `panAuto`, as `g0`, `g1`.
    pub pan0: f32,
    pub pan1: f32,
    pub bindings: [Binding; BINDINGS],
    /// ABI 4.9: each binding's time origin, seconds added to its time parameter (AUTOMATE `offset`).
    pub offsets: [f32; BINDINGS],
    /// The context frame the voice started (or starts) at, or [`UNANCHORED`] (`voiceTime`).
    pub vstart: u64,
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

    /// `panAuto` at frame `j` of the quantum.
    #[inline]
    pub fn pan_at(&self, j: usize) -> f32 {
        ramp_at(self.pan0, self.pan1, j)
    }
}

/// A bus's automation state. All-zero is nothing bound.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BusAuto {
    pub count: u8,
    pub fresh: u8,
    pub targets: u8,
    /// ABI 4.8: receiving slots in `send_to` (send bindings resolved this quantum).
    pub sends: u8,
    pub g0: f32,
    pub g1: f32,
    pub lp: f32,
    pub bindings: [Binding; BUS_BINDINGS],
    /// ABI 4.8: each fx binding's value this quantum (by binding index; unused for other kinds).
    pub vals: [f32; BUS_BINDINGS],
    /// ABI 4.8: the receiving bus slot of each send multiplier.
    pub send_to: [u16; SEND_AUTOS],
    /// ABI 4.8: each send's gain multiplier at the end of the last quantum and of this one (ramped
    /// between).
    pub s0: [f32; SEND_AUTOS],
    pub s1: [f32; SEND_AUTOS],
}

impl BusAuto {
    /// `gainMul` at frame `j` of the quantum.
    #[inline]
    pub fn gain_at(&self, j: usize) -> f32 {
        ramp_at(self.g0, self.g1, j)
    }

    /// ABI 4.8: the send into slot `to`'s automation multiplier for this quantum, as `(start, end)`
    /// (ramped across it), or `None` when no binding drives that send.
    #[inline]
    pub fn send_gain(&self, to: u16) -> Option<(f32, f32)> {
        if self.targets & has::SEND == 0 {
            return None;
        }
        let n = (self.sends as usize).min(SEND_AUTOS);
        self.send_to[..n].iter().position(|&t| t == to).map(|k| (self.s0[k], self.s1[k]))
    }

    /// ABI 4.8: calls `f(slot, param, value)` for each fx binding's value this quantum, in binding
    /// order (a later binding of the same parameter wins).
    #[inline]
    pub fn for_each_fx(&self, mut f: impl FnMut(usize, usize, f32)) {
        if self.targets & has::FX == 0 {
            return;
        }
        for (b, &v) in self.bindings[..(self.count as usize).min(BUS_BINDINGS)].iter().zip(self.vals.iter()) {
            if target::kind(b.target) == target::FX {
                f(target::slot(b.target), target::param(b.target), v);
            }
        }
    }
}

/// A gain of `db` decibels (`10^(db/20)`); `-inf` and NaN are silence.
#[inline]
fn db_gain(db: f32) -> f32 {
    let g = libm::powf(10.0, db * 0.05);
    if g.is_finite() {
        g
    } else if db > 0.0 {
        crate::bus_sends::MAX_LEVEL
    } else {
        0.0
    }
}

/// An fx binding's value from its curve's `y` (2^y for a log2 curve).
#[inline]
fn fx_value(t: u32, y: f32) -> f32 {
    if target::log(t) {
        libm::exp2f(y)
    } else {
        y
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
    /// Clocks re-anchored asap since the last quantum (anchored at the next one's first frame).
    pub clocks_asap: u32,
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
    clocks: usize,
    programs: usize,
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
    let clocks = align(buses + max_buses * core::mem::size_of::<BusAuto>());
    let programs = align(clocks + CLOCKS * core::mem::size_of::<GroupClock>());
    let active = align(programs + PROGRAMS * core::mem::size_of::<ProgramEntry>());
    let voices = align(active + max_logical * core::mem::size_of::<u32>());
    let total = align(voices + max_logical * core::mem::size_of::<VoiceAuto>());
    Sections { params, seeking, curves, buses, clocks, programs, active, voices, total }
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
    pub clocks: &'a mut [GroupClock],
    pub programs: &'a mut [ProgramEntry],
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
    // Header, Param, u16, Curve, BusAuto, GroupClock, ProgramEntry, u32 and VoiceAuto (integers, floats, arrays of them, and a
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
            clocks: core::slice::from_raw_parts_mut(base.add(s.clocks) as *mut GroupClock, CLOCKS),
            programs: core::slice::from_raw_parts_mut(base.add(s.programs) as *mut ProgramEntry, PROGRAMS),
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

/// A binding's parameter value for a voice in `group` (0 for anything out of range); `times` holds
/// its `voiceTime`, `clipTime` and `sequenceTime` (ADR 0346; zeros for a bus or a voice without
/// time bindings).
#[inline]
fn binding_value(params: &[Param], param: u16, group: u16, times: &[f32; 3]) -> f32 {
    if param & 0xC000 == wire::PARAM_TIME as u16 {
        return times.get((param & wire::PARAM_TIME_MASK as u16) as usize).copied().unwrap_or(0.0);
    }
    let index = if param & 0x8000 != 0 { param_index(0, param & 0x7FFF) } else { param_index(group, param).filter(|_| group != 0) };
    index.map_or(0.0, |i| params[i].value)
}

/// TIME (ADR 0346): re-anchors `group`'s clock `which` at context frame `frame` (`None`: asap, at
/// the next quantum's first frame). Only `TIME_SEQUENCE` is a clock; a non-finite value or rate,
/// another `which` or a group out of range is ignored.
pub fn time(core: &mut Core, group: u16, which: u16, value: f32, rate: f32, frame: Option<u64>) {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    if which as u32 != wire::TIME_SEQUENCE || !value.is_finite() || !rate.is_finite() {
        return;
    }
    let Some(c) = v.clocks.get_mut(group as usize) else { return };
    let was_asap = c.anchor == UNANCHORED;
    *c = GroupClock { value, rate, anchor: frame.unwrap_or(UNANCHORED) };
    if frame.is_none() && !was_asap {
        v.header.clocks_asap += 1;
    }
}

/// A group's clock (tests and a debugger).
pub fn clock(core: &mut Core, group: u16) -> Option<GroupClock> {
    view(&mut core.regions_mut().automation[..]).and_then(|v| v.clocks.get(group as usize).copied())
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

/// The shape of a segment at `u` (`curve.ts`'s `curveShape`; `myco_curve::shape`).
#[inline]
pub fn shape(interp: u8, u: f32) -> f32 {
    myco_curve::shape(interp, u)
}

/// The curve's value at `x` (`curve.ts`'s `evalCurve`, in f32; `myco_curve::eval`). An empty curve
/// is 0. [`Curve::from_keys`] builds one as CURVES does, for callers outside the mixer, such as the
/// offline sample render (ADR 0342), so they evaluate curves exactly as the core does.
#[inline]
pub fn eval(c: &Curve, x: f32) -> f32 {
    myco_curve::eval(c, x)
}

#[inline]
fn curve_value(curves: &[Curve], curve: u16, x: f32) -> f32 {
    curves.get(curve as usize).map_or(0.0, |c| eval(c, x))
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
    n.checked_mul(binding_stride(msg, off)).is_some_and(|bytes| wire::Automate::FIXED_END + bytes <= len)
}

/// A binding's size in the record at `msg[off..]`: AUTOMATE's carries a time offset (ABI 4.9),
/// BUS_AUTOMATE's doesn't.
fn binding_stride(msg: &[u8], off: usize) -> usize {
    if u16_at(msg, off) == wire::op::AUTOMATE {
        wire::AutomateBindings::FIXED_END
    } else {
        wire::BusAutomateBindings::FIXED_END
    }
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
            let key = |k: usize| cur + k * wire::CurvesCurvesKeys::FIXED_END;
            for k in 0..n {
                let at = key(k);
                c.x[k] = f32_at(msg, at);
                c.y[k] = f32_at(msg, at + 4);
                c.interp[k] = u32_at(msg, at + 8).min(255) as u8;
            }
            c.set_controls(|k| {
                let at = key(k);
                [f32_at(msg, at + 12), f32_at(msg, at + 16), f32_at(msg, at + 20), f32_at(msg, at + 24)]
            });
        }
        cur += keys * wire::CurvesCurvesKeys::FIXED_END;
    }
}

/// Reads up to `out.len()` bindings of the (well-formed) record at `msg[off..]` into `out`;
/// returns how many, and their [`has`] bits. `bus` keeps only global volume, lowpass, fx and send
/// bindings (ABI 4.10; a voice ignores fx and send targets). `offsets` (AUTOMATE) takes each kept
/// binding's time offset (ABI 4.9; non-finite reads 0).
fn read_bindings(msg: &[u8], off: usize, out: &mut [Binding], bus: bool, mut offsets: Option<&mut [f32; BINDINGS]>) -> (u8, u8, bool) {
    let n = u32_at(msg, off + 12) as usize;
    let stride = binding_stride(msg, off);
    let (mut count, mut targets, mut time) = (0usize, 0u8, false);
    for i in 0..n {
        if count == out.len() {
            break;
        }
        let at = off + wire::Automate::FIXED_END + i * stride;
        let b = Binding { param: u16_at(msg, at), curve: u16_at(msg, at + 2), target: u32_at(msg, at + 4) };
        let bit = match b.target {
            target::VOLUME => has::GAIN,
            target::PITCH if !bus => has::PITCH,
            target::LOWPASS => has::LOWPASS,
            target::HIGHPASS if !bus => has::HIGHPASS,
            target::PAN if !bus => has::PAN,
            t if bus && target::kind(t) == target::FX => has::FX,
            t if bus && target::kind(t) == target::SEND => has::SEND,
            t if !bus && target::kind(t) == target::GEN => has::GEN,
            _ => continue,
        };
        if bus && b.param & 0x8000 == 0 {
            continue;
        }
        time |= b.param & 0xC000 == wire::PARAM_TIME as u16;
        out[count] = b;
        if let Some(o) = offsets.as_deref_mut() {
            let x = if stride >= 12 { f32_at(msg, at + 8) } else { 0.0 };
            o[count] = if x.is_finite() { x } else { 0.0 };
        }
        count += 1;
        targets |= bit;
    }
    (count as u8, targets, time)
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
        e.vstart = UNANCHORED;
    }
    let had_lowpass = e.count != 0 && e.targets & has::LOWPASS != 0;
    let (count, targets, time) = read_bindings(msg, off, &mut e.bindings, false, Some(&mut e.offsets));
    e.count = count;
    e.targets = targets;
    e.time = time as u8;
    e.fresh = 1;
    if count != 0 {
        enlist(v.header, v.active, e, index);
    }
    if targets & has::LOWPASS != 0 && !had_lowpass {
        // The voice's low-pass starts from zeroed history (unless it is running for `lpHz`).
        crate::voices::lowpass_bound(core, index);
    }
}

/// BUS_AUTOMATE: replaces bus `voiceId`'s bindings (global volume, lowpass, fx and send).
pub fn bus_automate(core: &mut Core, msg: &[u8], off: usize) {
    let bus = u32_at(msg, off + 4) as usize;
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let Some(b) = v.buses.get_mut(bus) else { return };
    let was = b.count != 0;
    let (count, targets, _) = read_bindings(msg, off, &mut b.bindings, true, None);
    b.count = count;
    b.targets = targets;
    b.sends = 0;
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
    if !looping && e.loop_on == LOOP_PROGRAM {
        return; // the program's key-off (`voices::set_loop` lets its held loops go)
    }
    free_program(v.programs, e);
    e.loop_on = if looping { LOOP_REGION } else { 0 };
    e.loop_start = start;
    e.loop_end = end;
    if looping {
        enlist(v.header, v.active, e, index);
    }
}

/// `true` when the (well-formed-length) LOOPS record at `msg[off..off + len]` holds its loops.
pub fn loops_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::Loops::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = u32_at(msg, off + 12) as usize;
    n.checked_mul(wire::LoopsLoops::FIXED_END).is_some_and(|bytes| wire::Loops::FIXED_END + bytes <= len)
}

/// LOOPS (ADR 0342) on slot `index` (voice `voice_id`, its playhead at `pos`): replaces its loop
/// program with the (well-formed) record's loops, at most `VOICE_LOOPS_MAX`; none clears it.
pub fn loops(core: &mut Core, index: usize, voice_id: u32, msg: &[u8], off: usize, pos: f64) {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let Some(e) = v.voices.get_mut(index) else { return };
    if e.id != voice_id {
        *e = zeroed_voice();
        e.id = voice_id;
        e.vstart = UNANCHORED;
    }
    let n = (u32_at(msg, off + 12) as usize).min(voice_loops::MAX_LOOPS);
    let mut defs = [LoopDef::default(); voice_loops::MAX_LOOPS];
    for (i, d) in defs[..n].iter_mut().enumerate() {
        let at = off + wire::Loops::FIXED_END + i * wire::LoopsLoops::FIXED_END;
        let (start, end) = (u32_at(msg, at), u32_at(msg, at + 4));
        *d = LoopDef {
            start: start.min(end),
            end: end.max(start),
            xfade: u32_at(msg, at + 8),
            exit_fade: u32_at(msg, at + 12),
            count: u16_at(msg, at + 16),
            flags: u16_at(msg, at + 18),
            param: u16_at(msg, at + 20),
            shapes: u16_at(msg, at + 22),
            threshold: f32_at(msg, at + 24),
        };
    }
    if n == 0 {
        free_program(v.programs, e);
        if e.loop_on == LOOP_PROGRAM {
            e.loop_on = 0;
        }
        return;
    }
    let mut probe = Program::default();
    probe.defs[..n].copy_from_slice(&defs[..n]);
    probe.n = n as u8;
    let want = activations(&probe, v.params, e.group);
    let slot = if e.prog != 0 { Some(e.prog as usize - 1) } else { v.programs.iter().position(|p| p.owner == 0) };
    let Some(slot) = slot else {
        // The pool is full: the first region loops as SET_LOOP would (held loops still end at the key-off).
        let first = defs[..n].iter().find(|d| !d.hold()).copied();
        e.loop_on = if first.is_some() { LOOP_REGION } else { 0 };
        if let Some(d) = first {
            e.loop_start = d.start;
            e.loop_end = d.end;
            enlist(v.header, v.active, e, index);
        }
        return;
    };
    v.programs[slot].owner = index as u32 + 1;
    e.prog = slot as u16 + 1;
    voice_loops::load(&mut v.programs[slot].prog, &defs[..n], want, pos);
    e.loop_on = LOOP_PROGRAM;
    enlist(v.header, v.active, e, index);
}

/// Gives `e`'s program entry back to the pool.
fn free_program(programs: &mut [ProgramEntry], e: &mut VoiceAuto) {
    if e.prog != 0 {
        if let Some(p) = programs.get_mut(e.prog as usize - 1) {
            *p = ProgramEntry::default();
        }
        e.prog = 0;
    }
}

/// Programs in use (tests and a debugger).
pub fn programs_in_use(core: &mut Core) -> usize {
    view(&mut core.regions_mut().automation[..]).map_or(0, |v| v.programs.iter().filter(|p| p.owner != 0).count())
}

/// Slot `index`'s loop program (tests and a debugger).
pub fn program(core: &mut Core, index: usize) -> Option<Program> {
    let v = view(&mut core.regions_mut().automation[..])?;
    let e = v.voices.get(index)?;
    (e.loop_on == LOOP_PROGRAM && e.prog != 0).then(|| v.programs[e.prog as usize - 1].prog)
}

/// The programs' pool for the render loop (`voices.rs`), indexed by `VoiceAuto::prog - 1`.
pub(crate) fn program_entries(region: &mut [u8]) -> Option<&mut [ProgramEntry]> {
    view(region).map(|v| v.programs)
}

/// A program's activation bits now: always loops on, held ones until the key-off, parameter ones by
/// their test of the parameter (read as a binding of a voice in `group` reads it).
fn activations(p: &Program, params: &[Param], group: u16) -> u8 {
    let mut m = 0u8;
    for i in 0..p.n as usize {
        let d = &p.defs[i];
        let on = match d.activation() {
            voice_loops::active::HELD => p.released == 0,
            voice_loops::active::PARAMETER => d.passes_threshold(binding_value(params, d.param, group, &[0.0; 3])),
            _ => true,
        };
        if on {
            m |= 1 << i;
        }
    }
    m
}

/// The key-off of slot `index`'s program (voice `voice_id`) at its playhead `*pos`: `false` when it
/// has none (the SET_LOOP is a region's release).
pub fn release_program(core: &mut Core, index: usize, voice_id: u32, pos: &mut f64) -> bool {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return false };
    let Some(e) = v.voices.get_mut(index) else { return false };
    if e.id != voice_id || e.loop_on != LOOP_PROGRAM || e.prog == 0 {
        return false;
    }
    voice_loops::release(&mut v.programs[e.prog as usize - 1].prog, pos);
    true
}

/// PLAY on slot `index`: the entry now belongs to `voice_id` in `group`, with nothing bound and no
/// loop region, starting at `start_frame` (`voices::ASAP` is [`UNANCHORED`]: taken by the next
/// quantum). (A stale list entry is dropped by the next quantum.)
pub fn on_play(core: &mut Core, index: usize, voice_id: u32, group: u16, start_frame: u64) {
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let Some(e) = v.voices.get_mut(index) else { return };
    e.id = voice_id;
    e.group = group;
    e.count = 0;
    e.targets = 0;
    e.time = 0;
    e.loop_on = 0;
    e.submix = 0;
    free_program(v.programs, e);
    e.vstart = start_frame;
}

/// ROUTE (ABI 4.9): voice `voiceId` mixes into submix slot `submix - 1` (0: its group's route). A
/// stale id is dropped.
pub fn route(core: &mut Core, msg: &[u8], off: usize) {
    let voice_id = u32_at(msg, off + 4);
    let submix = u16_at(msg, off + 12);
    let Some(index) = crate::voices::live_index(core, voice_id) else { return };
    let Some(v) = view(&mut core.regions_mut().automation[..]) else { return };
    let e = &mut v.voices[index];
    if e.id != voice_id {
        *e = zeroed_voice();
        e.id = voice_id;
        e.vstart = UNANCHORED;
    }
    e.submix = if submix as usize > crate::submix::SUBMIXES { 0 } else { submix };
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

/// What [`evaluate`] gives: `gainMul`, `pitchMul`, `lpAuto`, `hpAuto` and `panAuto`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Evaluated {
    g: f32,
    p: f32,
    lp: f32,
    hp: f32,
    pan: f32,
}

/// Evaluates bindings: `(gainMul, pitchMul, lpAuto, hpAuto, panAuto)`. Each binding is clamped before it combines, as
/// `events/automation.ts` `evaluate` does (the parity test holds them together): a volume curve
/// below 0 is silence for its binding (two negative curves don't multiply to a positive gain), and
/// a pitch curve at or below 0 leaves the rate alone (a factor of 1; no binding stalls a voice).
/// High-pass curves take the highest (0 none), pan curves sum, clamped to −1..1 (NaN is 0).
/// `offsets[i]` (ABI 4.9, absent: 0) is added to binding `i`'s time parameter: its time origin.
fn evaluate(params: &[Param], curves: &[Curve], bindings: &[Binding], offsets: &[f32], group: u16, times: &[f32; 3]) -> Evaluated {
    let (mut g, mut p, mut lp, mut hp, mut pan) = (1.0f32, 1.0f32, LP_OFF_HZ, 0.0f32, 0.0f32);
    for (i, b) in bindings.iter().enumerate() {
        let mut x = binding_value(params, b.param, group, times);
        if b.param & 0xC000 == wire::PARAM_TIME as u16 {
            x += offsets.get(i).copied().unwrap_or(0.0);
        }
        let y = curve_value(curves, b.curve, x);
        match b.target {
            target::VOLUME => g *= y.max(0.0),
            target::PITCH => {
                if y > 0.0 {
                    p *= y;
                }
            }
            target::LOWPASS => lp = lp.min(y),
            target::HIGHPASS => hp = hp.max(y),
            target::PAN => pan += y,
            _ => {}
        }
    }
    if !(hp >= 0.0) {
        hp = 0.0;
    }
    pan = if pan.is_nan() { 0.0 } else { pan.clamp(-1.0, 1.0) };
    if !(g.is_finite() && g >= 0.0) {
        g = 0.0;
    }
    if !(p.is_finite() && p > 0.0) {
        p = 1.0;
    }
    if !(lp >= 0.0) {
        lp = 0.0;
    }
    Evaluated { g, p, lp: lp.min(LP_OFF_HZ), hp: hp.min(LP_OFF_HZ), pan }
}

/// Step 1 of the quantum at context frame `frame`, before any voice renders (`voices::render`):
/// anchors asap clocks, advances the parameters, drops list entries whose voice is gone, and
/// evaluates every voice's and bus's bindings. Costs four loads when nothing is seeking or bound.
pub fn begin_quantum(core: &mut Core, frame: u64) {
    let regions: &mut Regions = core.regions_mut();
    let voices = crate::voices::slots_of(&regions.voices[..]);
    // ADR 0360: generator-parameter bindings hand their values to the generator region.
    let gen_region: &mut [u8] = &mut regions.gen[..];
    let Some(mut v) = view(&mut regions.automation[..]) else { return };
    if v.header.seeking_len == 0 && v.header.active_len == 0 && v.header.buses_bound == 0 && v.header.clocks_asap == 0 {
        return;
    }
    if v.header.clocks_asap != 0 {
        // Rare (main stamps its TIMEs): one pass over the clocks.
        for c in v.clocks.iter_mut() {
            if c.anchor == UNANCHORED {
                c.anchor = frame;
            }
        }
        v.header.clocks_asap = 0;
    }
    let sample_rate = v.header.sample_rate;
    if v.header.seeking_len != 0 {
        advance_params(&mut v);
    }
    let mut i = 0usize;
    while i < v.header.active_len as usize {
        let index = v.active[i] as usize;
        let e = &mut v.voices[index];
        let slot = voices.get(index).filter(|s| s.id == e.id && crate::voices::is_live_state(s.state));
        let live = slot.is_some();
        if !live || (e.count == 0 && e.loop_on == 0) {
            e.list = 0;
            free_program(v.programs, e);
            let last = v.header.active_len as usize - 1;
            if i != last {
                let moved = v.active[last];
                v.active[i] = moved;
                v.voices[moved as usize].list = i as u32 + 1;
            }
            v.header.active_len -= 1;
            continue;
        }
        if e.loop_on == LOOP_PROGRAM && e.prog != 0 {
            let p = &mut v.programs[e.prog as usize - 1].prog;
            p.want = activations(p, v.params, e.group);
        }
        if e.count != 0 {
            let mut times = [0.0f32; 3];
            if e.time != 0 {
                if let Some(s) = slot {
                    times = voice_times(e, s, v.clocks, frame, sample_rate);
                }
            }
            let Evaluated { g, p, lp, hp, pan } = evaluate(v.params, v.curves, &e.bindings[..e.count as usize], &e.offsets, e.group, &times);
            if e.targets & has::GEN != 0 {
                // ADR 0360 (ABI 5.1): each generator binding's value replaces its parameter, glided over the
                // quantum (at once on a binding just made or a voice not sounding yet).
                let jump = e.fresh != 0 || slot.is_some_and(|s| s.state == crate::voices::state::SCHEDULED || s.mix.value == 0.0);
                for (i, b) in e.bindings[..e.count as usize].iter().enumerate() {
                    if target::kind(b.target) != target::GEN {
                        continue;
                    }
                    let mut x = binding_value(v.params, b.param, e.group, &times);
                    if b.param & 0xC000 == wire::PARAM_TIME as u16 {
                        x += e.offsets[i];
                    }
                    let y = fx_value(b.target, curve_value(v.curves, b.curve, x));
                    crate::generator::automate(gen_region, index, e.id, target::slot(b.target), y, jump);
                }
            }
            if e.fresh != 0 {
                e.fresh = 0;
                e.g0 = g;
                e.p0 = p;
                e.pan0 = pan;
            } else {
                e.g0 = e.g1;
                e.p0 = e.p1;
                e.pan0 = e.pan1;
            }
            e.g1 = g;
            e.p1 = p;
            e.lp = lp;
            e.hp = hp;
            e.pan1 = pan;
        }
        i += 1;
    }
    if v.header.buses_bound != 0 {
        for b in v.buses.iter_mut() {
            if b.count == 0 {
                continue;
            }
            let n = (b.count as usize).min(BUS_BINDINGS);
            let Evaluated { g, lp, .. } = evaluate(v.params, v.curves, &b.bindings[..n], &[], 0, &[0.0; 3]);
            let fresh = b.fresh != 0;
            b.g0 = if fresh { g } else { b.g1 };
            b.g1 = g;
            b.lp = lp;
            if b.targets & (has::FX | has::SEND) != 0 {
                evaluate_bus_extras(v.params, v.curves, b, fresh);
            }
            b.fresh = 0;
        }
    }
}

/// ABI 4.8: a bus's fx values and send multipliers this quantum (see the module comment, step 4).
/// Send dB sum per receiving slot (in binding order, at most [`SEND_AUTOS`] slots), then become
/// gains; a fresh entry (just bound) starts at them with no ramp, as `gainMul` does.
fn evaluate_bus_extras(params: &[Param], curves: &[Curve], b: &mut BusAuto, fresh: bool) {
    let n = (b.count as usize).min(BUS_BINDINGS);
    let mut db = [0.0f32; SEND_AUTOS];
    let mut to = [0u16; SEND_AUTOS];
    let mut sends = 0usize;
    for i in 0..n {
        let bind = b.bindings[i];
        let kind = target::kind(bind.target);
        if kind != target::FX && kind != target::SEND {
            continue;
        }
        let y = curve_value(curves, bind.curve, binding_value(params, bind.param, 0, &[0.0; 3]));
        if kind == target::FX {
            b.vals[i] = fx_value(bind.target, y);
            continue;
        }
        let slot = target::slot(bind.target) as u16;
        let k = match to[..sends].iter().position(|&t| t == slot) {
            Some(k) => k,
            None if sends < SEND_AUTOS => {
                to[sends] = slot;
                sends += 1;
                sends - 1
            }
            None => continue,
        };
        db[k] += if y.is_nan() { 0.0 } else { y };
    }
    // The same slots in the same order as last quantum (the bindings didn't change: a rebinding is
    // fresh), so each multiplier ramps from its own previous value.
    let keep = !fresh && b.sends as usize == sends && b.send_to[..sends] == to[..sends];
    for k in 0..sends {
        let g = db_gain(db[k]).min(crate::bus_sends::MAX_LEVEL);
        b.s0[k] = if keep { b.s1[k] } else { g };
        b.s1[k] = g;
    }
    b.send_to = to;
    b.sends = sends as u8;
}

/// ABI 4.8 (SUBMIX_AUTOMATE): reads up to `out.len()` fx bindings of the (well-formed) record at
/// `msg[off..]` into `out`; returns how many. Other kinds are skipped.
pub(crate) fn read_submix_bindings(msg: &[u8], off: usize, out: &mut [Binding]) -> usize {
    let n = u32_at(msg, off + 12) as usize;
    let mut count = 0usize;
    for i in 0..n {
        if count == out.len() {
            break;
        }
        let at = off + wire::Automate::FIXED_END + i * wire::SubmixAutomateBindings::FIXED_END;
        let b = Binding { param: u16_at(msg, at), curve: u16_at(msg, at + 2), target: u32_at(msg, at + 4) };
        if target::kind(b.target) != target::FX {
            continue;
        }
        out[count] = b;
        count += 1;
    }
    count
}

/// ABI 4.8: what `submix::render` reads to evaluate a submix's fx bindings: the parameter table,
/// the curves and the group clocks, and the context frame and rate for `sequenceTime`.
pub(crate) struct SubmixEval<'a> {
    params: &'a [Param],
    curves: &'a [Curve],
    clocks: &'a [GroupClock],
    frame: u64,
    sample_rate: f32,
}

/// The tables [`submix_bindings`] reads (`None` without the region: never after `Core::new`).
pub(crate) fn submix_eval(region: &mut [u8], frame: u64) -> Option<SubmixEval<'_>> {
    let v = view(region)?;
    let sample_rate = v.header.sample_rate;
    Some(SubmixEval { params: v.params, curves: v.curves, clocks: v.clocks, frame, sample_rate })
}

/// ABI 4.8: calls `f(slot, param, value)` for each of a submix's fx `bindings` at this quantum,
/// reading locals of `group` and its `sequenceTime` (the group's clock at the quantum's first
/// frame); `voiceTime` and `clipTime` read 0 (a submix has no voice).
pub(crate) fn submix_bindings(e: &SubmixEval<'_>, bindings: &[Binding], group: u16, mut f: impl FnMut(usize, usize, f32)) {
    let seq = e.clocks.get(group as usize).map_or(0.0, |c| c.at(e.frame, e.sample_rate));
    let times = [0.0, 0.0, seq];
    for b in bindings {
        let y = curve_value(e.curves, b.curve, binding_value(e.params, b.param, group, &times));
        f(target::slot(b.target), target::param(b.target), fx_value(b.target, y));
    }
}

/// A voice's `voiceTime`, `clipTime` and `sequenceTime` at the quantum at `frame` (ADR 0346). While
/// the voice is scheduled its start frame is taken from its slot (its PLAY's stamp, or this quantum
/// for an asap PLAY); a voice first seen started counts from this quantum.
fn voice_times(e: &mut VoiceAuto, s: &crate::voices::VoiceSlot, clocks: &[GroupClock], frame: u64, sample_rate: f32) -> [f32; 3] {
    let scheduled = s.state == crate::voices::state::SCHEDULED;
    if scheduled {
        e.vstart = if s.start_frame == crate::voices::ASAP { frame } else { s.start_frame };
    } else if e.vstart == UNANCHORED {
        e.vstart = frame;
    }
    let voice = if frame <= e.vstart { 0.0 } else { ((frame - e.vstart) as f64 / sample_rate as f64) as f32 };
    let rate = s.rate_ratio as f64 * sample_rate as f64;
    let clip = if rate > 0.0 && s.position > 0.0 { (s.position / rate) as f32 } else { 0.0 };
    let seq = clocks.get(e.group as usize).map_or(0.0, |c| c.at(frame, sample_rate));
    [voice, clip, seq]
}

/// The voices' automation entries for the render loop: `None` when no voice has any (the render
/// loop then takes exactly its M1 path for every voice).
pub(crate) fn voice_entries(region: &mut [u8]) -> Option<&mut [VoiceAuto]> {
    let v = view(region)?;
    (v.header.active_len != 0).then_some(v.voices)
}

/// Every voice slot's entry, whatever is bound (ADR 0345: the render loop reads a voice's PLAY
/// `group` for its submix route).
pub(crate) fn all_entries(region: &mut [u8]) -> Option<&mut [VoiceAuto]> {
    view(region).map(|v| v.voices)
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

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    // The curve evaluator's cases moved to `myco-curve` with it (native/common/curve).

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
        let p = InitParams { sample_rate: 48_000.0, max_logical: 4_096, max_mixed: 128, max_buses: 32, arena_initial_bytes: 16 << 20, ..InitParams::default() };
        let n = region_bytes(&p);
        eprintln!("automation region: {n} B (VoiceAuto {} B, Curve {} B, BusAuto {} B)", core::mem::size_of::<VoiceAuto>(), core::mem::size_of::<Curve>(), core::mem::size_of::<BusAuto>());
        // ≈ 2.4 MB since ADR 0346: 64 keys with Bézier control points make the curve table ≈ 1.6 MB;
        assert!(n < 3 << 20, "{n}");
    }
}
