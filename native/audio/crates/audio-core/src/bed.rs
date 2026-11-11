//! Ambisonic beds (ADR 0162, api-and-models §3.1, §4.2 BED_CONFIG, §4.3, §4.5 format 4;
//! architecture §2.1, §3.1, §4.2, §4.3, §7.3; rulings R1, R9; contract C2): bed slots and their
//! host buses, the encode of kind-2 voices into a slot, the decode before the host bus's effects
//! ([`decode_into`], called from `bus.rs`'s pre-effects input hook), the gain fold for buses that
//! share an ancestor's bed, the MagLS filters (format 4), RESET, the bed counters and the load
//! shedding ladder's bed-idle step. The voice side (panner kind 2 and the equal-power crossfade
//! law) is `panner.rs`; `voices.rs` hands each mixed voice the view [`Beds`].
//!
//! **Slots and hosts** (R1, C2). BED_CONFIG names, per bus, the slot its voices encode into
//! (`bedSlot`, 0xFF none) and, per slot, the bus it decodes into (`hostBus`, 0xFFFF unused). The
//! core validates it ([`configure`]): a slot's host must be a configured bus and the bus itself
//! or an ancestor of every bus that feeds it; a bus that fails (a non-ancestor host, a slot past
//! `max_beds` or unused) is treated as 0xFF and counted in `bedsRefused`. A slot whose host stays
//! keeps its decoder state; a slot that gets a new host starts from silence; a slot whose host was
//! removed **drains** (decodes its history into the old host, then is freed). A bus whose slot
//! changes encodes into both slots for [`crate::panner::HRTF_CROSSFADE_SECONDS`] (45 ms) with
//! complementary equal-power weights, then into the new one only (architecture §2.1 "Moving"); a
//! bus that lost its bed keeps feeding its old slot while its voices' bed share ramps to 0.
//! Without BED_CONFIG (and with `max_beds` 0, where the region is empty) no voice reaches a bed and
//! every kind-2 voice pans equal-power: the M2 output, bit for bit.
//!
//! **Encode** (architecture §4.2; [`Beds::encode`], from `panner.rs`): a voice's mono signal (its
//! mid `(L + R) / 2`; a mono clip's two channels are equal, so its own samples), already through its
//! gains, filters and the bed share, times its bus's **fold** gain, is added to the slot's 16
//! channel accumulator with the SN3D gains of its direction ramping linearly across the quantum
//! from the previous quantum's (kept in the mixed-voice pool entry) to this one's
//! (`ambisonic::encode_ramp_add`).
//!
//! **Fold** (architecture §4.3): a voice on bus B whose bed is hosted by ancestor A skips the
//! buffers of B and of every bus between B and A, so their gains (BUS_MIX gain, which carries
//! volume, mute, solo and ducking, times automation `gainMul`) multiply its encode. [`begin_quantum`]
//! computes them per frame with `chain::fill` (the per-frame product `bus::mixdown` itself applies,
//! so a duck's knee inside a quantum is followed exactly; `chain::ends`' straight line misses it by
//! up to 0.86 dB) for up to [`FOLD_CAP`] sharing buses, and as `chain::ends`' straight line for any
//! more. The sharing chain's snapshot low-pass is main's (`lpHz`, S3); its effects and meter don't
//! apply to distant voices (architecture §2.1 "Practice").
//!
//! **Decode** ([`decode_into`]): after every voice and before the host's effects, each slot hosted
//! by the bus that encoded within the last `idle` quanta decodes its accumulator into the bus's
//! input, through the MagLS filters (`BedDecoderN`, 2 partitions below 88.2 kHz, 4 above) once
//! they are resident, and through the baked 16 to 2 matrix (`bed_matrix`, R9) until then, when they
//! failed, or in `audio.spatial: "equalPower"` (main never sends them there). `idle` is the
//! decoder's partition count (its history: architecture §2.1's "2 quanta"), or 1 once the load
//! shedding ladder took its bed-idle step. An idle slot's decoder is reset and costs nothing.
//!
//! **MagLS filters** (format 4, id `MAGLS_CLIP_ID`, api-and-models §4.5): `clips.rs` holds the blob
//! (the 32-byte `MaglsHeader`, then f32 `[16][2][taps]` at the context rate) and calls
//! [`load_filters`] when its last range is committed; the transform (32·P real FFTs) runs there, in
//! `onmessage`, into this region, and sets STATUS flags bit 6 `bedDecoderReady`. Freeing the clip,
//! or a RESET that drops clips, clears them ([`clear_filters`]).
//!
//! **Load shedding** (architecture §7.3, OD3, api-and-models §10.1): the ladder runs only once the
//! adaptive cap sits at its floor and underruns go on for [`LADDER_SUSTAIN_SECONDS`]; each step
//! counts in `m3Shed` ([`m3_shed`]). This module's step is the **bed-idle** step: beds go idle after
//! 1 silent quantum instead of the decoder's partition count (the last partition of a source's
//! tail, at most 128 taps of the MagLS response, is cut). It never turns a bed off or moves a
//! source. C3 adds the zone steps after it.
//!
//! **Region** (C8): a header, the decoder's FFT scratch, the shared filters, then `max_beds` bed
//! slots and `max_wide` private decoders (B3) of [`slot_bytes`] each: the accumulator (8 KB) and a
//! decoder (40 KB at 48 kHz, 72 KB from 88.2 kHz). Zero bytes when `max_beds` and `max_wide` are 0.
//! The header is written lazily by the first call that has the core ([`begin_quantum`],
//! [`configure`], [`load_filters`]); [`decode_into`] does nothing until then.
//!
//! Nothing in the render path allocates; the FFT twiddles are computed once, in `onmessage`.

use audio_dsp::ambisonic::{self, CHANNELS};
use audio_dsp::bed_decoder::{BedDecoderN, MaglsFilters};
use audio_dsp::bed_matrix;
use audio_dsp::hrtf::HrtfScratch;
use audio_wire::generated as wire;

use crate::core::Core;
use crate::counters::{flag, BedStatus};
use crate::params::InitParams;
use crate::panner::HrtfBank;
use crate::QUANTUM;

/// Most bed slots (the wire's `MAX_BEDS`).
pub const MAX_SLOTS: usize = wire::MAX_BEDS as usize;
/// "No slot" in the bus table (the wire's `BED_SLOT_NONE`).
pub const NONE: u8 = wire::BED_SLOT_NONE as u8;
/// The bus table's size: `InitParams::MAX_BUSES`.
pub const MAX_BED_BUSES: usize = InitParams::MAX_BUSES as usize;
/// Sharing buses whose fold is kept per frame (`chain::fill`); more use `chain::ends`' line.
pub const FOLD_CAP: usize = 32;
/// The ladder's trigger: underruns go on this long with the cap at its floor (architecture §7.3).
pub const LADDER_SUSTAIN_SECONDS: f32 = 1.0;

/// Work units (1 WU ≈ 1 ns, `cap::wu`) the bed terms add to STATUS `workBed` and the `beds`
/// section (informational, architecture §7.3: the cap's model doesn't take them). Estimates from
/// the bed spike until A7's `mode=fit` sweeps measure them: a voice's encode (16 channels × 128
/// frames, two products each), a MagLS decode (architecture §4.2: ≈ 20 µs) and a matrix decode
/// (≈ 2 µs).
pub mod wu {
    pub const ENCODE: u32 = 900;
    pub const DECODE_MAGLS: u32 = 20_000;
    pub const DECODE_MATRIX: u32 = 2_000;
}

/// Ladder steps (bits of [`ladder_steps`]).
pub mod step {
    /// Beds go idle after 1 silent quantum.
    pub const BED_IDLE: u32 = 1 << 0;
}

/// Slot states.
mod slot_state {
    pub const FREE: u8 = 0;
    /// Hosted by `host`; decoding while something encoded within the idle window.
    pub const ACTIVE: u8 = 1;
    /// The host was removed: decodes its history into the old host, then is freed.
    pub const DRAINING: u8 = 2;
}

/// Fold kinds in the bus table.
mod fold {
    /// No fold: the bus hosts its own bed, or every gain on its chain is 1.
    pub const UNITY: u8 = 0xFF;
    /// The straight line between `ends` (past `FOLD_CAP` sharing buses).
    pub const ENDS: u8 = 0xFE;
}

/// One bed slot's bookkeeping. All-zero is a free slot.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct SlotState {
    host: u16,
    state: u8,
    /// 1 while the decoder holds MagLS history (it is reset when decoding falls back to the matrix).
    magls: u8,
    /// Quanta since something encoded into the slot (0: this quantum), saturating.
    since: u32,
    /// Voices encoded this quantum, and in the last decoded one.
    voices: u16,
    voices_last: u16,
    /// Something was added to the accumulator this quantum (cleared by the decode).
    dirty: u8,
    /// The slot decoded in the last quantum (reported by the next `begin_quantum`).
    decoded_last: u8,
    _pad: u16,
    work_last: u32,
}

/// One bus's bed routing. Set by [`configure`]; `fold`/`ends` by [`begin_quantum`].
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct BusBed {
    /// The slot the bus's voices encode into ([`NONE`]).
    cur: u8,
    /// The slot they are moving away from ([`NONE`]).
    prev: u8,
    /// [`fold`] kind, or the index into `Header::fold`.
    fold: u8,
    _pad: u8,
    /// Frames of the move crossfade left at the start of this quantum (0: no move).
    move_left: u32,
    /// The fold at the quantum's first and last frame ([`fold::ENDS`]).
    ends: [f32; 2],
}

const BUS_NONE: BusBed = BusBed { cur: NONE, prev: NONE, fold: fold::UNITY, _pad: 0, move_left: 0, ends: [1.0, 1.0] };

/// The ladder's state (architecture §7.3).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct Ladder {
    /// The shell's underrun total as last seen.
    underruns_seen: u32,
    /// [`step`] bits taken.
    steps: u32,
    /// `m3Shed`: steps taken, cumulative.
    m3_shed: u32,
    _pad: u32,
    /// The frame the current run of underrun-at-floor started ([`NO_STREAK`]: none).
    streak_start: u64,
    /// The frame the last underrun was seen.
    last_underrun: u64,
}

const NO_STREAK: u64 = u64::MAX;

/// The region's header.
#[repr(C)]
struct Header {
    /// 1 once written ([`ensure_init`]).
    ready: u32,
    /// The decoder's partitions at the context rate (2 or 4), 0 when MagLS can't run at it.
    partitions: u32,
    max_beds: u32,
    max_wide: u32,
    /// The move and kind crossfade, frames (45 ms).
    fade_frames: u32,
    /// 1 once the FFT scratch is built.
    scratch_ready: u32,
    /// Configured buses at the last BED_CONFIG or quantum (a bus past them routes as bus 0).
    bus_count: u32,
    /// Frames of [`LADDER_SUSTAIN_SECONDS`].
    sustain_frames: u32,
    ladder: Ladder,
    slots: [SlotState; MAX_SLOTS],
    buses: [BusBed; MAX_BED_BUSES],
    /// Per-frame folds of the sharing buses, this quantum.
    fold: [[f32; QUANTUM]; FOLD_CAP],
}

const fn align64(n: usize) -> usize {
    n.div_ceil(64) * 64
}

const HEADER_BYTES: usize = align64(core::mem::size_of::<Header>());
const SCRATCH_BYTES: usize = align64(core::mem::size_of::<HrtfScratch>());
/// The 16-channel accumulator, channel-major.
type Acc = [[f32; QUANTUM]; CHANNELS];
const ACC_BYTES: usize = core::mem::size_of::<Acc>();

/// The decoder's partitions at `sample_rate` (as the HRTF bank's: 2 below 88.2 kHz, 4 up to
/// 176.4 kHz), 0 above.
fn partitions_for(sample_rate: f32) -> usize {
    HrtfBank::partitions_for(sample_rate).unwrap_or(0) as usize
}

const fn filters_bytes(p: usize) -> usize {
    match p {
        2 => align64(core::mem::size_of::<MaglsFilters<2>>()),
        4 => align64(core::mem::size_of::<MaglsFilters<4>>()),
        _ => 0,
    }
}

/// One bed slot or private decoder (C8): its 16-channel accumulator and its decoder for `p`
/// partitions (8 KB + 40 KB at 48 kHz; 8 KB + 72 KB from 88.2 kHz; 8 KB where MagLS can't run).
pub const fn slot_bytes(p: usize) -> usize {
    let decoder = match p {
        2 => core::mem::size_of::<BedDecoderN<2>>(),
        4 => core::mem::size_of::<BedDecoderN<4>>(),
        _ => 0,
    };
    align64(ACC_BYTES + decoder)
}

/// Byte offsets inside the region for `p` partitions.
const fn offsets(p: usize) -> (usize, usize, usize) {
    let scratch = HEADER_BYTES;
    let filters = scratch + SCRATCH_BYTES;
    let slots = filters + filters_bytes(p);
    (scratch, filters, slots)
}

/// The `Beds` region's size: 0 without beds or private decoders, else the header, the FFT scratch,
/// the shared MagLS filters and `(max_beds + max_wide)` × [`slot_bytes`] (≈ 262 KB for 2 beds and
/// 1 private decoder at 48 kHz: a 20 KB header, the 33 KB FFT scratch, 64 KB of filters, 3 × 48 KB;
/// api-and-models §3.1's 208 KB counted neither the header nor the scratch).
pub fn region_bytes(p: &InitParams) -> usize {
    let n = p.max_beds as usize + p.max_wide as usize;
    if n == 0 {
        return 0;
    }
    let parts = partitions_for(p.sample_rate);
    offsets(parts).2 + n * slot_bytes(parts)
}

fn u32_at(msg: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([msg[off], msg[off + 1], msg[off + 2], msg[off + 3]])
}

fn u16_at(msg: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([msg[off], msg[off + 1]])
}

/// `true` when the BED_CONFIG record at `msg[off..off + len]` holds its `bedSlot[busCount]` and
/// `hostBus[slotCount]` arrays, each padded to 4 bytes, and `slotCount <= MAX_BEDS` (C2). The
/// scheduler refuses the whole batch otherwise.
pub fn config_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::BedConfig::FIXED_END || off + len > msg.len() {
        return false;
    }
    let buses = u32_at(msg, off + 12) as usize;
    let slots = u32_at(msg, off + 16) as usize;
    if slots > wire::MAX_BEDS as usize {
        return false;
    }
    let pad4 = |n: usize| n.checked_add(3).map(|n| n & !3);
    match (pad4(buses), pad4(2 * slots)) {
        (Some(a), Some(b)) => a.checked_add(b).is_some_and(|n| wire::BedConfig::FIXED_END + n <= len),
        _ => false,
    }
}

// --- The region view ---------------------------------------------------------------------------

/// The `Beds` region, viewed for one render range or one call. Holds a raw view of the region's
/// bytes: valid while the region is (always: the core's block is `'static`) and while nothing else
/// views it (`voices.rs` makes one per range, `bus::mixdown` one per bus, `onmessage` one per call).
pub struct Beds {
    base: *mut u8,
    partitions: usize,
}

/// A voice's route into the beds this quantum ([`Beds::route`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Route {
    /// The slot the bus encodes into ([`NONE`]).
    pub cur: u8,
    /// The slot it is moving away from ([`NONE`]).
    pub prev: u8,
    /// Move frames left at the quantum's start.
    pub move_left: u32,
    /// The bus index the table was read at (an unconfigured bus is bus 0).
    pub bus: u16,
}

impl Route {
    /// Whether the voice encodes anywhere.
    pub fn any(&self) -> bool {
        self.cur != NONE || self.prev != NONE
    }
}

/// The view of `region`, once its header is written; `None` for an empty region (no beds).
pub fn view(region: &mut [u8]) -> Option<Beds> {
    if region.len() < HEADER_BYTES {
        return None;
    }
    // SAFETY: the region is 64-byte aligned (Layout), at least a header long, and all-zero bytes
    // are a valid header (integers, floats and arrays of them).
    let h = unsafe { &*(region.as_ptr() as *const Header) };
    if h.ready == 0 {
        return None;
    }
    Some(Beds { base: region.as_mut_ptr(), partitions: h.partitions as usize })
}

impl Beds {
    fn header(&mut self) -> &mut Header {
        // SAFETY: see `view`; one view at a time.
        unsafe { &mut *(self.base as *mut Header) }
    }

    fn header_ref(&self) -> &Header {
        // SAFETY: as `header`.
        unsafe { &*(self.base as *const Header) }
    }

    fn scratch(&mut self) -> *mut HrtfScratch {
        // SAFETY: inside the region (`region_bytes` counts it), 64-byte aligned.
        unsafe { self.base.add(offsets(self.partitions).0) as *mut HrtfScratch }
    }

    fn filters_ptr(&self) -> *mut u8 {
        // SAFETY: as `scratch`.
        unsafe { self.base.add(offsets(self.partitions).1) }
    }

    fn slot_ptr(&self, s: usize) -> *mut u8 {
        // SAFETY: `s < max_beds + max_wide` (callers), inside the region.
        unsafe { self.base.add(offsets(self.partitions).2 + s * slot_bytes(self.partitions)) }
    }

    fn acc(&mut self, s: usize) -> &mut Acc {
        // SAFETY: the slot's first bytes are its accumulator, all-zero valid; one borrow at a time.
        unsafe { &mut *(self.slot_ptr(s) as *mut Acc) }
    }

    /// Whether the MagLS filters are resident (`bedDecoderReady`).
    pub fn filters_ready(&self) -> bool {
        // SAFETY: the filters for this view's partition count, all-zero valid (not ready).
        unsafe {
            match self.partitions {
                2 => (*(self.filters_ptr() as *const MaglsFilters<2>)).is_ready(),
                4 => (*(self.filters_ptr() as *const MaglsFilters<4>)).is_ready(),
                _ => false,
            }
        }
    }

    /// The crossfade length in frames (45 ms).
    pub fn fade_frames(&self) -> u32 {
        self.header_ref().fade_frames
    }

    /// Bus `bus`'s route (a bus past the configured ones is bus 0, as the voices route it).
    pub fn route(&self, bus: u16) -> Route {
        let h = self.header_ref();
        let b = if (bus as u32) < h.bus_count && (bus as usize) < MAX_BED_BUSES { bus } else { 0 };
        let e = &h.buses[b as usize];
        Route { cur: e.cur, prev: e.prev, move_left: e.move_left, bus: b }
    }

    /// Multiplies `x` (frames `from..from + x.len()` of the quantum) by the route's bus's fold.
    pub fn apply_fold(&self, route: &Route, from: usize, x: &mut [f32]) {
        let h = self.header_ref();
        let e = &h.buses[route.bus as usize];
        match e.fold {
            fold::UNITY => {}
            fold::ENDS => {
                let [g0, g1] = e.ends;
                for (i, v) in x.iter_mut().enumerate() {
                    *v *= crate::automation::ramp_at(g0, g1, from + i);
                }
            }
            k => {
                let g = &h.fold[k as usize][from..];
                for (v, g) in x.iter_mut().zip(g) {
                    *v *= g;
                }
            }
        }
    }

    /// Adds the mono block `x` (frames `from..from + x.len()`, already through the voice's gains,
    /// its bed share and its fold) into the route's slot(s) with the SN3D gains ramping from `c0`
    /// (just before frame 0) to `c1` (frame 127). During a move, the two slots take complementary
    /// equal-power weights; a bus that lost its bed feeds its old slot at full weight. `count`: the
    /// voice is counted in its slot's `voices` (once a quantum).
    pub fn encode(&mut self, route: &Route, from: usize, x: &[f32], c0: &[f32; CHANNELS], c1: &[f32; CHANNELS], count: bool) {
        let n = x.len().min(QUANTUM - from.min(QUANTUM));
        let mut full = [0.0f32; QUANTUM];
        full[from..from + n].copy_from_slice(&x[..n]);
        let fade = self.header_ref().fade_frames.max(1) as f32;
        let moving = route.cur != NONE && route.prev != NONE && route.move_left > 0;
        let targets = [(route.cur, true), (route.prev, false)];
        for (slot, is_cur) in targets {
            if slot == NONE {
                continue;
            }
            let s = slot as usize;
            if s >= self.header_ref().max_beds as usize {
                continue;
            }
            let mut block = full;
            if moving {
                // The move's progress at frame `i`: 0 just before it starts, 1 at its end.
                for (i, v) in block.iter_mut().enumerate().skip(from).take(n) {
                    let m = (1.0 - (route.move_left as f32 - (i + 1) as f32) / fade).clamp(0.0, 1.0);
                    let (c, sn) = equal_power(m);
                    *v *= if is_cur { sn } else { c };
                }
            }
            ambisonic::encode_ramp_add(self.acc(s), &block, c0, c1, CHANNELS);
            let st = &mut self.header().slots[s];
            st.dirty = 1;
            st.since = 0;
            if count {
                st.voices = st.voices.saturating_add(1);
            }
        }
    }
}

/// The equal-power pair `(cos, sin)` of `t · π/2` for `t` in 0..=1 (`libm`, so native and wasm
/// agree bit for bit): the crossfade law of architecture §3.1 (kind changes) and §2.1 (moves).
#[inline]
pub fn equal_power(t: f32) -> (f32, f32) {
    let t = t.clamp(0.0, 1.0);
    if t <= 0.0 {
        return (1.0, 0.0);
    }
    if t >= 1.0 {
        return (0.0, 1.0);
    }
    let a = t * core::f32::consts::FRAC_PI_2;
    (libm::cosf(a), libm::sinf(a))
}

// --- Lifecycle (core-level calls) --------------------------------------------------------------

/// Writes the header the first time a call with the core sees the region (the region is zeroed at
/// init). Returns whether the core has a `Beds` region.
fn ensure_init(core: &mut Core) -> bool {
    let p = *core.params();
    let region = &mut core.regions_mut().beds[..];
    if region.len() < HEADER_BYTES {
        return false;
    }
    // SAFETY: see `view`.
    let h = unsafe { &mut *(region.as_mut_ptr() as *mut Header) };
    if h.ready != 0 {
        return true;
    }
    h.partitions = partitions_for(p.sample_rate) as u32;
    h.max_beds = p.max_beds.min(MAX_SLOTS as u32);
    h.max_wide = p.max_wide;
    h.fade_frames = (libm::roundf(crate::panner::HRTF_CROSSFADE_SECONDS * p.sample_rate) as u32).max(1);
    h.sustain_frames = (libm::roundf(LADDER_SUSTAIN_SECONDS * p.sample_rate) as u32).max(1);
    h.ladder = Ladder { underruns_seen: 0, steps: 0, m3_shed: 0, _pad: 0, streak_start: NO_STREAK, last_underrun: 0 };
    clear_config(h);
    h.ready = 1;
    true
}

/// Every bus without a bed, every slot free (RESET and init).
fn clear_config(h: &mut Header) {
    h.slots = [SlotState::default(); MAX_SLOTS];
    h.buses = [BUS_NONE; MAX_BED_BUSES];
    h.bus_count = 1;
}

/// Whether bus `host` is `bus` or one of its ancestors in the configured tree.
fn hosts(core: &Core, host: u16, bus: u16) -> bool {
    let slots = crate::bus::slots(core);
    let count = crate::bus::count(core).min(slots.len());
    if (host as usize) >= count || (bus as usize) >= count {
        return false;
    }
    let mut b = bus;
    for _ in 0..count {
        if b == host {
            return true;
        }
        let parent = slots[b as usize].parent;
        if parent == crate::bus::ROOT || parent as usize >= count {
            return false;
        }
        b = parent;
    }
    false
}

/// BED_CONFIG (C2, applies on arrival) from the well-formed record at `msg[off..]`: validates the
/// hosts (counting `bedsRefused`), keeps the state of slots whose host stays, starts moves and
/// drains (see the module comment). Without a `Beds` region every bus is refused and counted.
pub fn configure(core: &mut Core, msg: &[u8], off: usize) {
    let bus_count = u32_at(msg, off + 12) as usize;
    let slot_count = u32_at(msg, off + 16) as usize;
    let hosts_at = off + wire::BedConfig::FIXED_END + ((bus_count + 3) & !3);
    let bed_slot = |b: usize| if b < bus_count { msg[off + wire::BedConfig::FIXED_END + b] } else { NONE };
    let configured = crate::bus::count(core).min(MAX_BED_BUSES);
    if !ensure_init(core) {
        let refused = (0..bus_count.min(configured)).filter(|&b| bed_slot(b) != NONE).count();
        crate::status::counters_mut(core).spatial.note_beds_refused(refused.min(u16::MAX as usize) as u16);
        return;
    }
    let max_beds = core.params().max_beds.min(MAX_SLOTS as u32) as usize;
    // The new hosts, validated against the tree.
    let mut host = [u16::MAX; MAX_SLOTS];
    for (s, h) in host.iter_mut().enumerate().take(slot_count.min(max_beds)) {
        let v = u16_at(msg, hosts_at + 2 * s);
        if v != wire::BED_HOST_NONE as u16 && (v as usize) < configured {
            *h = v;
        }
    }
    let mut cur = [NONE; MAX_BED_BUSES];
    let mut refused = 0usize;
    for (b, c) in cur.iter_mut().enumerate().take(configured) {
        let s = bed_slot(b);
        if s == NONE {
            continue;
        }
        let ok = (s as usize) < max_beds && host[s as usize] != u16::MAX && hosts(core, host[s as usize], b as u16);
        if ok {
            *c = s;
        } else {
            refused += 1;
        }
    }
    {
        let Some(mut beds) = view(&mut core.regions_mut().beds[..]) else { return };
        let mut kept = [false; MAX_SLOTS];
        for s in 0..max_beds {
            let old = beds.header_ref().slots[s];
            let new = host[s];
            if new == u16::MAX {
                if old.state == slot_state::ACTIVE {
                    beds.header().slots[s].state = slot_state::DRAINING;
                }
            } else if old.state == slot_state::ACTIVE && old.host == new {
                kept[s] = true;
            } else {
                beds.header().slots[s] = SlotState { host: new, state: slot_state::ACTIVE, since: u32::MAX, ..SlotState::default() };
                reset_slot(&mut beds, s);
            }
        }
        let h = beds.header();
        let fade = h.fade_frames;
        for (b, &c) in cur.iter().enumerate() {
            let e = &mut h.buses[b];
            if e.cur != c {
                // A move: the old slot, if it still decodes into the same host, keeps getting
                // this bus's voices for the crossfade (and while they leave the bed).
                let old = e.cur;
                if old != NONE && (old as usize) < MAX_SLOTS && kept[old as usize] {
                    e.prev = old;
                    e.move_left = if c == NONE { fade + QUANTUM as u32 } else { fade };
                } else {
                    e.prev = NONE;
                    e.move_left = 0;
                }
                e.cur = c;
            }
            if e.prev != NONE && ((e.prev as usize) >= MAX_SLOTS || !kept[e.prev as usize]) {
                e.prev = NONE;
                e.move_left = 0;
            }
        }
        h.bus_count = configured.max(1) as u32;
    }
    crate::status::counters_mut(core).spatial.note_beds_refused(refused.min(u16::MAX as usize) as u16);
}

/// Silences slot `s`: its accumulator and its decoder history.
fn reset_slot(beds: &mut Beds, s: usize) {
    let p = beds.partitions;
    let ptr = beds.slot_ptr(s);
    // SAFETY: the slot's bytes inside the region; all-zero is an empty accumulator and a silent
    // decoder (`BedDecoderN` is all-zero valid).
    unsafe { core::ptr::write_bytes(ptr, 0, slot_bytes(p)) };
}

/// Once per quantum, before any voice renders (`voices::render`): reports the last quantum's bed
/// counters, steps the load shedding ladder, moves the bus moves on, drops what a slot whose host
/// wasn't mixed accumulated, and computes the folds of the sharing buses (`chain::fill`, before
/// `bus::mixdown` starts the ramps). A core without a `Beds` region returns at once.
pub fn begin_quantum(core: &mut Core) {
    if !ensure_init(core) {
        return;
    }
    report(core);
    ladder(core);
    let configured = crate::bus::count(core).min(MAX_BED_BUSES).max(1);
    // The sharing buses and their hosts (the fold stops before the host).
    let mut sharing = [(0u16, 0u16); MAX_BED_BUSES];
    let mut n = 0usize;
    {
        let Some(mut beds) = view(&mut core.regions_mut().beds[..]) else { return };
        let max_beds = beds.header_ref().max_beds as usize;
        for s in 0..max_beds {
            if beds.header_ref().slots[s].dirty != 0 {
                // Encoded but not decoded (its host wasn't mixed): drop it.
                beds.acc(s).iter_mut().for_each(|c| c.fill(0.0));
                let st = &mut beds.header().slots[s];
                st.dirty = 0;
                st.voices = 0;
            }
        }
        let h = beds.header();
        h.bus_count = configured as u32;
        for b in 0..MAX_BED_BUSES {
            let e = &mut h.buses[b];
            if b >= configured {
                *e = BUS_NONE;
                continue;
            }
            if e.move_left > 0 {
                e.move_left = e.move_left.saturating_sub(QUANTUM as u32);
                if e.move_left == 0 {
                    e.prev = NONE;
                }
            }
            e.fold = fold::UNITY;
            let slot = if e.cur != NONE { e.cur } else { e.prev };
            if slot == NONE || (slot as usize) >= MAX_SLOTS {
                continue;
            }
            let host = h.slots[slot as usize].host;
            if host as usize != b {
                sharing[n] = (b as u16, host);
                n += 1;
            }
        }
    }
    let mut cached = 0usize;
    for &(b, host) in &sharing[..n] {
        if cached < FOLD_CAP {
            let mut g = [0.0f32; QUANTUM];
            crate::chain::fill(core, b, Some(host), &mut g);
            let unity = g.iter().all(|&v| v == 1.0);
            let Some(mut beds) = view(&mut core.regions_mut().beds[..]) else { return };
            let h = beds.header();
            if unity {
                h.buses[b as usize].fold = fold::UNITY;
            } else {
                h.fold[cached] = g;
                h.buses[b as usize].fold = cached as u8;
                cached += 1;
            }
        } else {
            let (g0, g1) = crate::chain::ends(core, b, Some(host));
            let Some(mut beds) = view(&mut core.regions_mut().beds[..]) else { return };
            let e = &mut beds.header().buses[b as usize];
            if g0 == 1.0 && g1 == 1.0 {
                e.fold = fold::UNITY;
            } else {
                e.fold = fold::ENDS;
                e.ends = [g0, g1];
            }
        }
    }
}

/// The last quantum's bed counters into STATUS (`bedVoices`, `bedsActive`, `beds`, `workBed`).
fn report(core: &mut Core) {
    let Some(mut beds) = view(&mut core.regions_mut().beds[..]) else { return };
    let h = beds.header();
    let mut items = [BedStatus::default(); MAX_SLOTS];
    let (mut active, mut voices, mut work) = (0usize, 0u32, 0u32);
    for st in h.slots.iter_mut().take(h.max_beds as usize) {
        if st.decoded_last == 0 {
            continue;
        }
        st.decoded_last = 0;
        voices += st.voices_last as u32;
        work = work.saturating_add(st.work_last);
        items[active] = BedStatus { bus: st.host, voices: st.voices_last, work: st.work_last };
        active += 1;
    }
    let c = &mut crate::status::counters_mut(core).spatial;
    c.bed_voices = voices.min(u16::MAX as u32) as u16;
    c.beds_active = active as u16;
    c.beds[..active].copy_from_slice(&items[..active]);
    // B3 adds its ambisonic voices' work to the same field.
    c.work_bed = work;
}

/// The load shedding ladder (see the module comment): watches the adaptive cap and the shell's
/// underrun total, and takes the next step once underruns went on for [`LADDER_SUSTAIN_SECONDS`]
/// with the cap at its floor. Steps are for the session (RESET keeps them).
fn ladder(core: &mut Core) {
    let (cap, floor, total) = {
        let c = core.cap();
        (c.cap(), c.config().floor, c.underruns_total())
    };
    let frame = core.frame();
    let Some(mut beds) = view(&mut core.regions_mut().beds[..]) else { return };
    let h = beds.header();
    let sustain = h.sustain_frames as u64;
    let max_beds = h.max_beds;
    let l = &mut h.ladder;
    let fresh = total != l.underruns_seen;
    l.underruns_seen = total;
    if cap > floor {
        l.streak_start = NO_STREAK;
        return;
    }
    if !fresh {
        return;
    }
    if l.streak_start == NO_STREAK || frame.saturating_sub(l.last_underrun) > sustain {
        l.streak_start = frame;
    }
    l.last_underrun = frame;
    if frame - l.streak_start < sustain {
        return;
    }
    l.streak_start = frame;
    // The steps, in order. C3 adds the zone steps after the bed-idle one.
    if l.steps & step::BED_IDLE == 0 && max_beds > 0 {
        l.steps |= step::BED_IDLE;
        l.m3_shed = l.m3_shed.saturating_add(1);
    }
}

/// `m3Shed`: the ladder steps taken (0 without a `Beds` region). Not on the wire yet (see the A4
/// report: STATUS has no field for it; main's debug view needs one).
pub fn m3_shed(core: &mut Core) -> u32 {
    view(&mut core.regions_mut().beds[..]).map_or(0, |mut b| b.header().ladder.m3_shed)
}

/// The ladder's [`step`] bits taken.
pub fn ladder_steps(core: &mut Core) -> u32 {
    view(&mut core.regions_mut().beds[..]).map_or(0, |mut b| b.header().ladder.steps)
}

/// The pre-effects input hook (`bus::mixdown`): decodes every bed slot hosted by `bus` that
/// encoded within its idle window into the bus's input `l`, `r`, before its effects (MagLS when
/// resident, else the matrix), then clears the accumulator; an idle slot's decoder is reset, a
/// drained slot freed. Does nothing before the header is written.
#[inline]
pub fn decode_into(beds: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let Some(mut b) = view(beds) else { return };
    let (Ok(l), Ok(r)) = (<&mut [f32; QUANTUM]>::try_from(l), <&mut [f32; QUANTUM]>::try_from(r)) else { return };
    let h = b.header_ref();
    let max_beds = h.max_beds as usize;
    let idle = if h.ladder.steps & step::BED_IDLE != 0 { 1 } else { (h.partitions as u32).max(2) };
    for s in 0..max_beds {
        let st = b.header_ref().slots[s];
        if st.state == slot_state::FREE || st.host as usize != bus {
            continue;
        }
        let since = if st.dirty != 0 { 0 } else { st.since.saturating_add(1) };
        if since > idle {
            // Idle (or drained): reset once, then nothing.
            if st.state == slot_state::DRAINING {
                reset_slot(&mut b, s);
                b.header().slots[s] = SlotState::default();
            } else if st.since <= idle {
                reset_slot(&mut b, s);
                let x = &mut b.header().slots[s];
                x.since = since;
                x.magls = 0;
            }
            continue;
        }
        let magls = b.filters_ready();
        if magls && st.magls == 0 {
            // From the matrix to MagLS: the decoder starts from silence.
            reset_decoder(&mut b, s);
        }
        let work = if magls {
            decode_magls(&mut b, s, l, r);
            wu::DECODE_MAGLS
        } else {
            bed_matrix::decode_add(b.acc(s).as_flattened(), QUANTUM, l, r);
            wu::DECODE_MATRIX
        };
        b.acc(s).iter_mut().for_each(|c| c.fill(0.0));
        let x = &mut b.header().slots[s];
        x.since = since;
        x.magls = magls as u8;
        x.dirty = 0;
        x.decoded_last = 1;
        x.voices_last = x.voices;
        x.work_last = work.saturating_add(wu::ENCODE.saturating_mul(x.voices as u32));
        x.voices = 0;
    }
}

/// Resets slot `s`'s decoder history, keeping its accumulator.
fn reset_decoder(b: &mut Beds, s: usize) {
    let ptr = b.slot_ptr(s);
    // SAFETY: the decoder follows the accumulator in the slot; all-zero is a silent decoder.
    unsafe {
        match b.partitions {
            2 => (*(ptr.add(ACC_BYTES) as *mut BedDecoderN<2>)).reset(),
            4 => (*(ptr.add(ACC_BYTES) as *mut BedDecoderN<4>)).reset(),
            _ => {}
        }
    }
}

/// Decodes slot `s` through the MagLS filters into `l`, `r` (added).
fn decode_magls(b: &mut Beds, s: usize, l: &mut [f32; QUANTUM], r: &mut [f32; QUANTUM]) {
    let ptr = b.slot_ptr(s);
    let filters = b.filters_ptr();
    let scratch = b.scratch();
    // SAFETY: the accumulator, the decoder, the filters and the scratch are disjoint parts of the
    // region; the scratch is built (the filters are ready only after `load_filters` built it).
    unsafe {
        let acc = &*(ptr as *const Acc);
        match b.partitions {
            2 => (*(ptr.add(ACC_BYTES) as *mut BedDecoderN<2>)).process(acc, CHANNELS, &*(filters as *const MaglsFilters<2>), &mut *scratch, l, r),
            4 => (*(ptr.add(ACC_BYTES) as *mut BedDecoderN<4>)).process(acc, CHANNELS, &*(filters as *const MaglsFilters<4>), &mut *scratch, l, r),
            _ => {}
        }
    }
}

/// Transforms the committed format 4 blob `data` (the `MaglsHeader` then f32 `[16][2][taps]`) into
/// the shared filters (`onmessage`, from `clips.rs`); sets `bedDecoderReady`. False (and the
/// filters not ready) for a core without beds, a rate MagLS can't run at, or a bad blob: wrong
/// magic, version or order, a rate other than the core's, a length that isn't the header and
/// `16 × 2 × taps` floats, taps past the decoder's partitions, or a sample that isn't finite.
pub fn load_filters(core: &mut Core, data: &[u8]) -> bool {
    clear_filters(core);
    if !ensure_init(core) || data.len() < wire::MaglsHeader::FIXED_END || (data.as_ptr() as usize) % 4 != 0 {
        return false;
    }
    let rate = core.params().sample_rate;
    let Ok((head, _)) = wire::MaglsHeader::read(data, 0) else { return false };
    let taps = head.taps as usize;
    let body = &data[wire::MaglsHeader::FIXED_END..];
    if head.magic != wire::MAGLS_MAGIC || head.version != wire::MAGLS_VERSION || head.order != wire::MAGLS_ORDER || (head.sample_rate - rate).abs() > 0.5 || body.len() != CHANNELS * 2 * taps * 4 {
        return false;
    }
    // SAFETY: the blob is 4-byte aligned (checked; arena blocks are), so is its body (32 bytes on),
    // and holds `body.len() / 4` little-endian f32s (wasm and the native hosts are little-endian).
    let time = unsafe { core::slice::from_raw_parts(body.as_ptr() as *const f32, body.len() / 4) };
    let ok = {
        let Some(mut b) = view(&mut core.regions_mut().beds[..]) else { return false };
        let scratch = b.scratch();
        if b.header_ref().scratch_ready == 0 {
            // SAFETY: the scratch's place in the region, aligned; written whole before any read.
            unsafe { scratch.write(HrtfScratch::new()) };
            b.header().scratch_ready = 1;
        }
        let filters = b.filters_ptr();
        // SAFETY: the filters' place for this partition count; the scratch is distinct and built.
        unsafe {
            match b.partitions {
                2 => (*(filters as *mut MaglsFilters<2>)).load(time, taps, &mut *scratch).is_ok(),
                4 => (*(filters as *mut MaglsFilters<4>)).load(time, taps, &mut *scratch).is_ok(),
                _ => false,
            }
        }
    };
    crate::status::counters_mut(core).set_flag(flag::BED_DECODER_READY, ok);
    ok
}

/// Marks the filters not ready (the format 4 clip was freed, or a RESET dropped the clips); beds
/// decode through the matrix until main sends them again. Clears `bedDecoderReady`.
pub fn clear_filters(core: &mut Core) {
    if let Some(b) = view(&mut core.regions_mut().beds[..]) {
        let filters = b.filters_ptr();
        // SAFETY: the filters' place for this partition count (all-zero valid).
        unsafe {
            match b.partitions {
                2 => (*(filters as *mut MaglsFilters<2>)).clear(),
                4 => (*(filters as *mut MaglsFilters<4>)).clear(),
                _ => {}
            }
        }
    }
    crate::status::counters_mut(core).set_flag(flag::BED_DECODER_READY, false);
}

/// Whether the core has a `Beds` region (`clips.rs` refuses format 4 without one).
pub fn has_region(core: &Core) -> bool {
    core.regions().beds.len() >= HEADER_BYTES
}

/// RESET (§4.2: "RESET clears beds"): every bus without a bed, every slot free and silent. The
/// filters stay while their clip does (`clips::reset` clears them with the clips); the ladder's
/// steps stay (they are the session's).
pub fn reset(core: &mut Core) {
    if !ensure_init(core) {
        return;
    }
    let Some(mut beds) = view(&mut core.regions_mut().beds[..]) else { return };
    let slots = beds.header_ref().max_beds as usize + beds.header_ref().max_wide as usize;
    for s in 0..slots {
        reset_slot(&mut beds, s);
    }
    clear_config(beds.header());
    let c = &mut crate::status::counters_mut(core).spatial;
    c.bed_voices = 0;
    c.beds_active = 0;
    c.work_bed = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        // api-and-models §3.1: 64 KB of shared spectra and 40 KB per decoder at 48 kHz.
        assert!(slot_bytes(2) <= 49_216, "slot at 48 kHz: {}", slot_bytes(2));
        assert!(filters_bytes(2) <= 65_600, "filters at 48 kHz: {}", filters_bytes(2));
        eprintln!("header {HEADER_BYTES} B, scratch {SCRATCH_BYTES} B, filters {} / {} B, slot {} / {} / {} B", filters_bytes(2), filters_bytes(4), slot_bytes(2), slot_bytes(4), slot_bytes(0));
        let p = InitParams { max_beds: 2, max_wide: 1, ..InitParams::default() };
        eprintln!("2 beds + 1 private at 48 kHz: {} B", region_bytes(&p));
        assert_eq!(region_bytes(&InitParams::default()), 0, "no beds: no region (M2)");
    }

    #[test]
    fn equal_power_keeps_the_power() {
        for k in 0..=64 {
            let (c, s) = equal_power(k as f32 / 64.0);
            assert!((c * c + s * s - 1.0).abs() < 1e-6);
        }
        assert_eq!(equal_power(0.0), (1.0, 0.0));
        assert_eq!(equal_power(1.0), (0.0, 1.0));
    }
}
