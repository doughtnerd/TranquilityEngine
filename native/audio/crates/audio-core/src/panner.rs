//! Per-voice panner state (contract K11; architecture §2.4).
//!
//! Every voice pans through a [`PannerState`] here, as the last per-voice stage before the bus.
//! The panner takes the voice's listener-space unit direction (C5: forward is -Z, up is +Y, right
//! is +X, as Web Audio's default listener) and turns it into a 2×2 matrix from the voice's
//! (left, right) samples to the output's (left, right):
//!
//! ```text
//! outL += a·inL + b·inR        outR += c·inL + d·inR
//! ```
//!
//! For a mono clip the resampler copies channel 0 to `inR`, and `b = d = 0`.
//! - **Non-spatial** voices use no panner: the identity (`a = d = 1`, `b = c = 0`), so a mono clip
//!   plays at full level in both channels, as Web Audio up-mixes mono to stereo.
//! - **Equal-power** (kind 0): Blink's `EqualPowerPanner` gains (`audio_dsp::pan`) for the
//!   direction's azimuth. Mono: `a = gainL, c = gainR`. Stereo, azimuth ≤ 0: `a = 1, b = gainL,
//!   d = gainR`; azimuth > 0: `a = gainL, c = gainR, d = 1`, exactly Blink's `Pan`.
//! - **HRTF** (kind 1, H3): the port of Blink's `HRTFPanner` (`audio_dsp::hrtf`), see below.
//!
//! A direction change from SET_PARAMS ramps the four coefficients linearly over its `rampFrames`
//! (Blink's panner jumps per quantum; ramping the matrix is click-free and lands on Blink's values,
//! and it stays continuous when a stereo source crosses azimuth 0). PLAY sets the matrix at once.
//!
//! **HRTF (H3).** Main flags the top `voices.hrtf` spatial voices by audibility with kind 1
//! (SET_PARAMS `flags`). The HRTF state lives in an [`HrtfBank`] of [`HRTF_SLOTS`] panners that the
//! clip store allocates in the arena once the HRIR table (`format = 2`) is resident and parsed
//! (`clips.rs`); until then, and when every slot is taken, kind-1 voices pan equal-power.
//! - A spatial, mixed voice of kind 1 takes a free slot the first quantum it renders with the bank
//!   present ([`Hrtf::touch`]); the slot's `x` (its HRTF share) starts at 0 and ramps to 1 over
//!   [`HRTF_CROSSFADE_SECONDS`] (45 ms, as long as Chromium's kernel crossfade). Kind 0 ramps it
//!   back to 0, then the slot is freed. Both directions are linear crossfades of the two panners'
//!   outputs (same source, correlated), frame by frame, so a change never clicks.
//! - While a voice holds a slot, the equal-power matrix mixes at once with weight `1 - x` (exact
//!   sample timing), and the voice's samples are also copied into the slot's quantum buffer. After
//!   every voice rendered, [`flush`] runs each slot's HRTF panner on its whole quantum (the panner is
//!   k-rate and has no latency) and adds it to the voice's bus with weight `x`. The ramp of `x` is
//!   fixed at the voice's first render of the quantum, so both halves use the same weights.
//! - A slot whose voice didn't render this quantum (virtual, paused and held, ended, replaced, or
//!   a RESET) is freed at once: a voice promoted back starts equal-power and crossfades again.
//! - Stereo clips go left channel to the left-ear filter and right to the right-ear one; mono
//!   clips feed both. The direction is the one the voice holds at its last render in the quantum.
//!
//! All-zero is a valid `PannerState` (a silent matrix); PLAY always sets it. Nothing allocates.

use audio_dsp::hrtf::{partitions_for_sample_rate, HrirDatabase, HrtfPannerN, HrtfScratch};
use audio_dsp::pan::EqualPowerPanner;
use audio_dsp::ramp::Ramp;

use crate::core::Core;
use crate::QUANTUM;

/// Panner kinds (the PLAY / SET_PARAMS `flags` bits 5–6, api-and-models §4.2).
pub mod kind {
    pub const EQUAL_POWER: u8 = 0;
    pub const HRTF: u8 = 1;
}

/// One voice's panner.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PannerState {
    /// The kind asked for ([`kind`]).
    pub kind: u8,
    /// Non-zero for a spatial voice (PLAY flag bit4); otherwise the matrix is the identity.
    pub spatial: u8,
    /// The clip's channels, 1 or 2 (the matrix depends on it).
    pub channels: u8,
    /// The [`HrtfBank`] slot this voice holds, plus 1 (0: none). Valid only while that slot's
    /// owner is this voice (a freed slot may have been taken by another).
    pub hrtf_slot: u8,
    /// The listener-space direction last set.
    pub dir: [f32; 3],
    /// `a, b, c, d`, each ramping to its target.
    pub matrix: [Ramp; 4],
}

impl PannerState {
    /// Sets everything at once, with no ramp (PLAY: "a clip starts at its gain").
    pub fn start(&mut self, spatial: bool, kind: u8, dir: [f32; 3], channels: u32) {
        self.kind = kind;
        self.spatial = spatial as u8;
        self.channels = channels.clamp(1, 2) as u8;
        self.hrtf_slot = 0;
        self.dir = dir;
        let m = matrix(spatial, kind, dir, channels);
        for (ramp, value) in self.matrix.iter_mut().zip(m) {
            *ramp = Ramp::at(value);
        }
    }

    /// A new direction (SET_PARAMS mask bit2): the matrix ramps to it over `ramp_frames`.
    pub fn set_direction(&mut self, dir: [f32; 3], ramp_frames: u32) {
        self.dir = dir;
        let m = matrix(self.spatial != 0, self.kind, dir, self.channels as u32);
        for (ramp, value) in self.matrix.iter_mut().zip(m) {
            ramp.set_target(value, ramp_frames);
        }
    }

    /// A new kind (SET_PARAMS mask bit6). The equal-power matrix doesn't change (it is HRTF's
    /// crossfade partner); the HRTF share follows from the voice's next quantum.
    pub fn set_kind(&mut self, kind: u8) {
        self.kind = kind;
    }

    /// Accumulates `frames` frames of the voice's `(in_l, in_r)` into `(out_l, out_r)` through the
    /// ramping matrix (all four slices at least `in_l.len()` long).
    pub fn mix(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = in_l.len();
        let (in_r, out_l, out_r) = (&in_r[..n], &mut out_l[..n], &mut out_r[..n]);
        if self.matrix.iter().all(|r| r.is_settled()) {
            let [a, b, c, d] = [self.matrix[0].value, self.matrix[1].value, self.matrix[2].value, self.matrix[3].value];
            for i in 0..n {
                out_l[i] += a * in_l[i] + b * in_r[i];
                out_r[i] += c * in_l[i] + d * in_r[i];
            }
            return;
        }
        for i in 0..n {
            let a = self.matrix[0].next();
            let b = self.matrix[1].next();
            let c = self.matrix[2].next();
            let d = self.matrix[3].next();
            out_l[i] += a * in_l[i] + b * in_r[i];
            out_r[i] += c * in_l[i] + d * in_r[i];
        }
    }

    /// Pans one rendered range of voice `voice`: frames `from .. from + in_l.len()` of the quantum
    /// at context frame `frame`, into `out_l`/`out_r` (already offset to `from`). Without an HRTF
    /// slot this is [`mix`](Self::mix). With one, the equal-power matrix mixes with weight `1 - x`
    /// and the samples go to the slot's quantum buffer for [`flush`] (see the module comment).
    #[allow(clippy::too_many_arguments)]
    pub fn mix_range(&mut self, hrtf: Option<&mut Hrtf<'_>>, voice: u32, bus: u16, frame: u64, from: usize, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let slot = match hrtf {
            Some(h) if self.spatial != 0 => h.touch(self, voice, bus, frame),
            _ => None,
        };
        let Some(s) = slot else {
            self.mix(in_l, in_r, out_l, out_r);
            return;
        };
        let n = in_l.len();
        s.in_l[from..from + n].copy_from_slice(in_l);
        s.in_r[from..from + n].copy_from_slice(&in_r[..n]);
        let (x0, inc) = (s.x, s.inc);
        if x0 >= 1.0 && inc == 0.0 {
            // All HRTF: the matrix only keeps time.
            self.advance(n as u32);
            return;
        }
        let (in_r, out_l, out_r) = (&in_r[..n], &mut out_l[..n], &mut out_r[..n]);
        for i in 0..n {
            let w = 1.0 - share(x0, inc, from + i);
            let a = self.matrix[0].next() * w;
            let b = self.matrix[1].next() * w;
            let c = self.matrix[2].next() * w;
            let d = self.matrix[3].next() * w;
            out_l[i] += a * in_l[i] + b * in_r[i];
            out_r[i] += c * in_l[i] + d * in_r[i];
        }
    }

    /// Moves the matrix ramps on by `frames` without rendering (virtual voices).
    pub fn advance(&mut self, frames: u32) {
        for ramp in self.matrix.iter_mut() {
            ramp.advance(frames);
        }
    }
}

/// The azimuth in degrees (-180..180, 0 ahead, +90 right) of a listener-space direction, by the Web
/// Audio spec's azimuth algorithm for a listener at the origin facing -Z with +Y up (the same
/// arithmetic as Blink's `PannerHandler::CalculateAzimuthElevation`): project onto the horizontal
/// plane, take the angle from the right vector with `acos`, mirror it when the source is behind,
/// then make it relative to the front. A zero or vertical direction gives 0. Uses `libm`.
pub fn azimuth(dir: [f32; 3]) -> f64 {
    let (x, z) = (dir[0] as f64, dir[2] as f64);
    if !(x.is_finite() && z.is_finite()) {
        return 0.0;
    }
    // Removing the up component leaves (x, 0, z); normalise it.
    let len = libm::sqrt(x * x + z * z);
    if len == 0.0 {
        return 0.0;
    }
    let (px, pz) = (x / len, z / len);
    // Angle from the right vector (1, 0, 0).
    let mut az = libm::acos(px.clamp(-1.0, 1.0)).to_degrees();
    // Behind the listener: the projection on forward (0, 0, -1) is negative.
    if -pz < 0.0 {
        az = 360.0 - az;
    }
    // Relative to the front, not the right.
    if (0.0..=270.0).contains(&az) {
        90.0 - az
    } else {
        450.0 - az
    }
}

/// The elevation in degrees (-90..90, +90 straight up) of a listener-space direction, by the same
/// Blink function: 90° less the angle from the up vector. A zero or non-finite direction gives 0.
/// Uses `libm`.
pub fn elevation(dir: [f32; 3]) -> f64 {
    let (x, y, z) = (dir[0] as f64, dir[1] as f64, dir[2] as f64);
    if !(x.is_finite() && y.is_finite() && z.is_finite()) {
        return 0.0;
    }
    let len = libm::sqrt(x * x + y * y + z * z);
    if len == 0.0 {
        return 0.0;
    }
    90.0 - libm::acos((y / len).clamp(-1.0, 1.0)).to_degrees()
}

/// The matrix targets `[a, b, c, d]` for a voice (see the module comment). Equal-power for every
/// spatial kind: an HRTF voice's matrix is its crossfade partner and its fallback.
pub fn matrix(spatial: bool, kind: u8, dir: [f32; 3], channels: u32) -> [f32; 4] {
    let _ = kind;
    if !spatial {
        return [1.0, 0.0, 0.0, 1.0];
    }
    let mut panner = EqualPowerPanner::default();
    let stereo = channels >= 2;
    let az = panner.update_desired_gain(azimuth(dir), if stereo { 2 } else { 1 });
    let (gl, gr) = panner.desired_gains();
    let (gl, gr) = (gl as f32, gr as f32);
    if !stereo {
        [gl, 0.0, gr, 0.0]
    } else if az <= 0.0 {
        [1.0, gl, 0.0, gr]
    } else {
        [gl, 0.0, gr, 1.0]
    }
}

// --- HRTF (H3) ----------------------------------------------------------------------------------

/// HRTF panners in the bank: `voices.hrtf`'s maximum (api-and-models §2), so main's choice never
/// runs out of slots.
pub const HRTF_SLOTS: usize = 32;

/// The crossfade between the two panner kinds (architecture §2.4: "as long as Chromium's kernel
/// crossfade").
pub const HRTF_CROSSFADE_SECONDS: f32 = 0.045;

/// Kernel computations all HRTF voices may make in one quantum (architecture §2.4: "at most 4
/// kernel computations per quantum; further switches wait a quantum, masked by the crossfade").
/// A kernel costs far more than a quantum of convolution (an interpolated one blends 256 bins in
/// the log-magnitude and phase domain), so without this a crowd of voices changing direction in
/// the same quantum would spike the render. A voice whose switch waits keeps panning on its last
/// direction; a voice that would take a free slot waits on equal-power.
///
/// 2, not the architecture's 4: an interpolated kernel takes about 43 µs natively (and roughly
/// twice that in wasm), against about 5 µs for a voice's whole quantum of HRTF convolution, so 2
/// keeps the worst quantum near §6.1's 0.17 ms HRTF crossfade reserve. One kernel set (2
/// computations) a quantum still lets 16 moving voices each start a crossfade as often as one can
/// run (2,048 frames, 16 quanta); new slots start one a quantum.
pub const KERNEL_BUDGET: u32 = 2;

/// The HRTF share at frame `i` of a quantum whose share starts at `x0` and changes by `inc` a
/// frame (frame 0 already moves, as the ramps do).
#[inline]
fn share(x0: f32, inc: f32, i: usize) -> f32 {
    (x0 + inc * (i + 1) as f32).clamp(0.0, 1.0)
}

/// One slot's bookkeeping (its panner is in the bank's panner array, at the same index). All-zero
/// is a free slot.
#[repr(C)]
pub struct HrtfSlot {
    /// The voice id holding it; 0 when free.
    pub owner: u32,
    /// The voice's bus at its last render (the HRTF output goes there).
    pub bus: u16,
    /// The voice's clip channels (1 feeds both ears).
    pub channels: u8,
    reserved: u8,
    /// The context frame of the quantum the voice last rendered in.
    pub stamp: u64,
    /// The HRTF share at the start of the quantum, 0..=1.
    pub x: f32,
    /// Its change per frame during this quantum (±1/crossfade frames, or 0).
    pub inc: f32,
    /// Azimuth and elevation (degrees) at the voice's last render.
    pub azimuth: f64,
    pub elevation: f64,
    /// The direction the panner last ran with (a switch that waits for the kernel budget keeps it).
    pub used_azimuth: f64,
    pub used_elevation: f64,
    /// 1 from the slot's claim to its first pan: its first kernels were paid from the budget then.
    pub fresh: u32,
    /// The voice's samples this quantum (after its gains), zero where it didn't render.
    pub in_l: [f32; QUANTUM],
    pub in_r: [f32; QUANTUM],
}

/// The bank's fixed part. The panners follow it in the same block ([`HrtfBank::panners_offset`]),
/// as `[HrtfPannerN<P>; HRTF_SLOTS]` with `P` the rate's partition count (2 below 88.2 kHz, else 4).
#[repr(C)]
pub struct HrtfBank {
    /// `P`: 2 or 4.
    pub partitions: u32,
    /// [`HRTF_CROSSFADE_SECONDS`] in frames.
    pub fade_frames: u32,
    /// The quantum [`budget_left`](Self::budget_left) belongs to, and the kernel computations left in
    /// it ([`KERNEL_BUDGET`] at its start).
    budget_frame: u64,
    budget_left: u32,
    /// The slot [`flush`] starts at, moved on each quantum so waiting switches take turns.
    cursor: u32,
    pub scratch: HrtfScratch,
    pub slots: [HrtfSlot; HRTF_SLOTS],
    /// The output of one slot's panner (one quantum).
    out_l: [f32; QUANTUM],
    out_r: [f32; QUANTUM],
}

const fn align64(n: usize) -> usize {
    n.div_ceil(64) * 64
}

impl HrtfBank {
    /// Where the panner array starts in the block.
    pub const fn panners_offset() -> usize {
        align64(core::mem::size_of::<HrtfBank>())
    }

    /// The panner storage `P` for a context rate, or `None` when HRTF can't run at it (176.4 kHz
    /// and up, past the port's 4 partitions).
    pub fn partitions_for(sample_rate: f32) -> Option<u32> {
        match partitions_for_sample_rate(sample_rate)? {
            0..=2 => Some(2),
            3..=4 => Some(4),
            _ => None,
        }
    }

    /// Bytes a bank takes at `sample_rate` (`None`: HRTF can't run at it).
    pub fn bytes_for(sample_rate: f32) -> Option<usize> {
        let panner = match Self::partitions_for(sample_rate)? {
            2 => core::mem::size_of::<HrtfPannerN<2>>(),
            _ => core::mem::size_of::<HrtfPannerN<4>>(),
        };
        Some(Self::panners_offset() + HRTF_SLOTS * panner)
    }

    /// Builds a bank in place at `addr` (`onmessage` only); false when HRTF can't run at the rate.
    ///
    /// # Safety
    /// `addr` must be 64-byte aligned and point to [`bytes_for`](Self::bytes_for)`(sample_rate)`
    /// writable bytes that nothing else uses for as long as the bank is used.
    pub unsafe fn init(addr: usize, sample_rate: f32) -> bool {
        let Some(partitions) = Self::partitions_for(sample_rate) else { return false };
        let bank = addr as *mut HrtfBank;
        // SAFETY: (caller) the block is ours and large enough. The fixed part is zeroed first
        // (all-zero slots are free), then the scratch and scalars are written field by field, so no
        // large value sits on the stack.
        unsafe {
            core::ptr::write_bytes(addr as *mut u8, 0, core::mem::size_of::<HrtfBank>());
            core::ptr::addr_of_mut!((*bank).scratch).write(HrtfScratch::new());
            (*bank).partitions = partitions;
            (*bank).budget_frame = u64::MAX;
            (*bank).fade_frames = (libm::roundf(HRTF_CROSSFADE_SECONDS * sample_rate) as u32).max(1);
            let panners = addr + Self::panners_offset();
            match partitions {
                2 => init_panners::<2>(panners, sample_rate),
                _ => init_panners::<4>(panners, sample_rate),
            }
        }
    }
}

/// Writes `HRTF_SLOTS` panners at `addr`.
///
/// # Safety
/// As [`HrtfBank::init`], for the panner array.
unsafe fn init_panners<const P: usize>(addr: usize, sample_rate: f32) -> bool {
    let panners = addr as *mut HrtfPannerN<P>;
    for k in 0..HRTF_SLOTS {
        let Ok(p) = HrtfPannerN::<P>::new(sample_rate) else { return false };
        // SAFETY: (caller) the array is inside the block and aligned (its offset is a multiple of 64).
        unsafe { panners.add(k).write(p) };
    }
    true
}

/// The bank and the HRIR table for one render call: what [`PannerState::mix_range`] and [`flush`]
/// use.
pub struct Hrtf<'a> {
    bank: &'a mut HrtfBank,
    panners: usize,
    db: HrirDatabase<'a>,
}

impl<'a> Hrtf<'a> {
    /// # Safety
    /// `addr` must be a bank [`HrtfBank::init`] built, used by nothing else for `'a`.
    pub unsafe fn new(addr: usize, db: HrirDatabase<'a>) -> Hrtf<'a> {
        // SAFETY: (caller) a built bank, exclusively ours for 'a.
        Hrtf { bank: unsafe { &mut *(addr as *mut HrtfBank) }, panners: addr + HrtfBank::panners_offset(), db }
    }

    /// The voice's slot for this range, claiming one (or giving it back) as its kind asks; see the
    /// module comment. `None`: no slot, pan equal-power only.
    fn touch(&mut self, p: &mut PannerState, voice: u32, bus: u16, frame: u64) -> Option<&mut HrtfSlot> {
        let want = p.kind == kind::HRTF;
        let mut index = p.hrtf_slot as usize;
        if index != 0 && self.bank.slots.get(index - 1).is_none_or(|s| s.owner != voice) {
            index = 0;
        }
        if index == 0 {
            p.hrtf_slot = 0;
            if !want {
                return None;
            }
            let free = self.bank.slots.iter().position(|s| s.owner == 0)?;
            // A new panner computes its first kernels at its first pan: paid now, or wait on
            // equal-power for a quantum with budget left.
            if !self.take_budget(frame, 2) {
                return None;
            }
            self.restart(free);
            let s = &mut self.bank.slots[free];
            s.owner = voice;
            s.x = 0.0;
            s.inc = 0.0;
            s.stamp = u64::MAX;
            s.fresh = 1;
            index = free + 1;
            p.hrtf_slot = index as u8;
        }
        let step = 1.0 / self.bank.fade_frames as f32;
        let s = &mut self.bank.slots[index - 1];
        if s.stamp != frame {
            // The voice's first range this quantum: the share's ramp for the whole quantum.
            if !want && s.x <= 0.0 {
                s.owner = 0;
                p.hrtf_slot = 0;
                return None;
            }
            s.stamp = frame;
            s.in_l.fill(0.0);
            s.in_r.fill(0.0);
            s.inc = match (want, s.x) {
                (true, x) if x < 1.0 => step,
                (false, x) if x > 0.0 => -step,
                _ => 0.0,
            };
        }
        s.bus = bus;
        s.channels = p.channels;
        s.azimuth = azimuth(p.dir);
        s.elevation = elevation(p.dir);
        Some(s)
    }

    /// Takes `n` kernel computations from the quantum at `frame`'s budget, if that many are left.
    fn take_budget(&mut self, frame: u64, n: u32) -> bool {
        let bank = &mut *self.bank;
        if bank.budget_frame != frame {
            bank.budget_frame = frame;
            bank.budget_left = KERNEL_BUDGET;
        }
        if bank.budget_left < n {
            return false;
        }
        bank.budget_left -= n;
        true
    }

    /// Kernel computations slot `k`'s panner would make for this direction.
    fn kernels_needed(&self, k: usize, azimuth: f64, elevation: f64) -> u32 {
        debug_assert!(k < HRTF_SLOTS);
        // SAFETY: as `restart`.
        unsafe {
            match self.bank.partitions {
                2 => (*(self.panners as *const HrtfPannerN<2>).add(k)).kernels_needed(azimuth, elevation),
                _ => (*(self.panners as *const HrtfPannerN<4>).add(k)).kernels_needed(azimuth, elevation),
            }
        }
    }

    /// Makes slot `k`'s panner new (no history; it snaps to its first direction).
    fn restart(&mut self, k: usize) {
        debug_assert!(k < HRTF_SLOTS);
        // SAFETY: `k < HRTF_SLOTS`; `init` built the array for this partition count.
        unsafe {
            match self.bank.partitions {
                2 => (*(self.panners as *mut HrtfPannerN<2>).add(k)).restart(),
                _ => (*(self.panners as *mut HrtfPannerN<4>).add(k)).restart(),
            }
        }
    }

    /// Runs slot `k`'s panner over its quantum buffer into the bank's output buffer, on the voice's
    /// direction if the quantum's kernel budget allows the switch (or none is needed), else on the
    /// direction it last used.
    fn pan(&mut self, k: usize, frame: u64) {
        debug_assert!(k < HRTF_SLOTS);
        let (azimuth, elevation, fresh) = {
            let s = &self.bank.slots[k];
            (s.azimuth, s.elevation, s.fresh != 0)
        };
        let go = fresh || {
            let needed = self.kernels_needed(k, azimuth, elevation);
            needed == 0 || self.take_budget(frame, needed)
        };
        let bank = &mut *self.bank;
        let s = &mut bank.slots[k];
        s.fresh = 0;
        if go {
            s.used_azimuth = azimuth;
            s.used_elevation = elevation;
        }
        let (az, el) = (s.used_azimuth, s.used_elevation);
        let right = (s.channels >= 2).then_some(&s.in_r);
        // SAFETY: as `restart`.
        unsafe {
            match bank.partitions {
                2 => (*(self.panners as *mut HrtfPannerN<2>).add(k)).pan(&self.db, &mut bank.scratch, az, el, &s.in_l, right, &mut bank.out_l, &mut bank.out_r),
                _ => (*(self.panners as *mut HrtfPannerN<4>).add(k)).pan(&self.db, &mut bank.scratch, az, el, &s.in_l, right, &mut bank.out_l, &mut bank.out_r),
            }
        }
    }

    /// Slots held by a voice.
    pub fn slots_in_use(&self) -> usize {
        self.bank.slots.iter().filter(|s| s.owner != 0).count()
    }

    /// Slot `k` (tests and debugging).
    pub fn slot(&self, k: usize) -> &HrtfSlot {
        &self.bank.slots[k]
    }
}

/// Kernel computations the HRTF voices made in the quantum last rendered (at most
/// [`KERNEL_BUDGET`]; tests and debugging).
pub fn kernels_last_quantum(core: &Core) -> u32 {
    let Some((addr, _)) = core.clips().hrtf_bank() else { return 0 };
    // SAFETY: a built bank (`hrtf_bank`); read only, outside `process`.
    let bank = unsafe { &*(addr as *const HrtfBank) };
    if bank.budget_frame == core.frame() {
        KERNEL_BUDGET - bank.budget_left
    } else {
        0
    }
}

/// The HRTF view for a render call, when the bank exists (the HRIR table is resident and parsed).
pub(crate) fn view(clips: &crate::clips::ClipStore) -> Option<Hrtf<'_>> {
    let (addr, bytes) = clips.hrtf_bank()?;
    let db = HrirDatabase::parse(bytes).ok()?;
    // SAFETY: the store built the bank at `addr` (`HrtfBank::init`) and keeps it until `onmessage`
    // frees it; `process` is its only user meanwhile, and one view exists at a time (the render
    // makes one per range and drops it before the next).
    Some(unsafe { Hrtf::new(addr, db) })
}

/// After every voice rendered the quantum at `frame` (`voices::render`): pans each slot whose
/// voice rendered, adds it to that voice's bus with its share, moves the shares on, frees slots
/// whose voice didn't render or whose share reached 0, and sets STATUS `hrtfVoices` (the slots
/// panned this quantum, those crossfading included). Never allocates.
pub fn flush(core: &mut Core, frame: u64) {
    let panned = {
        let (regions, clips) = core.parts_mut();
        match view(clips) {
            None => 0,
            Some(mut h) => {
                let mut inputs = crate::bus::Inputs::of(regions);
                let mut panned = 0u16;
                let start = h.bank.cursor as usize % HRTF_SLOTS;
                h.bank.cursor = ((start + 1) % HRTF_SLOTS) as u32;
                for j in 0..HRTF_SLOTS {
                    let k = (start + j) % HRTF_SLOTS;
                    let s = &mut h.bank.slots[k];
                    if s.owner == 0 {
                        continue;
                    }
                    if s.stamp != frame {
                        s.owner = 0;
                        continue;
                    }
                    h.pan(k, frame);
                    let bank = &mut *h.bank;
                    let s = &mut bank.slots[k];
                    let (x0, inc) = (s.x, s.inc);
                    if let Some((out_l, out_r)) = inputs.get(s.bus) {
                        for i in 0..QUANTUM {
                            let w = share(x0, inc, i);
                            out_l[i] += w * bank.out_l[i];
                            out_r[i] += w * bank.out_r[i];
                        }
                    }
                    s.x = share(x0, inc, QUANTUM - 1);
                    if inc > 0.0 && s.x >= 1.0 {
                        s.inc = 0.0;
                    } else if inc < 0.0 && s.x <= 0.0 {
                        s.owner = 0;
                    }
                    panned += 1;
                }
                panned
            }
        }
    };
    crate::status::counters_mut(core).hrtf_voices = panned;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn azimuth_of_the_cardinal_directions() {
        assert!(close(azimuth([0.0, 0.0, -1.0]), 0.0));
        assert!(close(azimuth([1.0, 0.0, 0.0]), 90.0));
        assert!(close(azimuth([-1.0, 0.0, 0.0]), -90.0));
        assert!(close(azimuth([0.0, 0.0, 1.0]).abs(), 180.0));
        assert!(close(azimuth([1.0, 0.0, 1.0]), 135.0));
        assert!(close(azimuth([-1.0, 0.0, 1.0]), -135.0));
        assert!((azimuth([0.5, 0.0, -0.866_025_4]) - 30.0).abs() < 1e-4);
        assert_eq!(azimuth([0.0, 1.0, 0.0]), 0.0, "straight up");
        assert_eq!(azimuth([0.0, 0.0, 0.0]), 0.0, "zero");
        assert_eq!(azimuth([f32::NAN, 0.0, -1.0]), 0.0, "not finite");
    }

    #[test]
    fn non_spatial_voices_use_the_identity() {
        assert_eq!(matrix(false, kind::EQUAL_POWER, [1.0, 0.0, 0.0], 1), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(matrix(false, kind::HRTF, [1.0, 0.0, 0.0], 2), [1.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn spatial_mono_matches_blinks_gains() {
        let m = matrix(true, kind::EQUAL_POWER, [0.0, 0.0, -1.0], 1);
        assert!((m[0] - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-7 && (m[2] - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-7);
        assert_eq!((m[1], m[3]), (0.0, 0.0));
        let m = matrix(true, kind::EQUAL_POWER, [-1.0, 0.0, 0.0], 1);
        assert_eq!(m, [1.0, 0.0, 0.0, 0.0]);
        let m = matrix(true, kind::EQUAL_POWER, [0.5, 0.0, -0.866_025_4], 1);
        assert!((m[0] - 0.5).abs() < 1e-5 && (m[2] - 0.866_025_4).abs() < 1e-5);
        // Stereo: left of centre keeps L and pans R into both; right of centre the mirror.
        let m = matrix(true, kind::EQUAL_POWER, [-1.0, 0.0, -1.0], 2);
        assert_eq!((m[0], m[2]), (1.0, 0.0));
        assert!((m[1] - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
        let m = matrix(true, kind::EQUAL_POWER, [1.0, 0.0, -1.0], 2);
        assert_eq!((m[1], m[3]), (0.0, 1.0));
    }

    #[test]
    fn a_direction_change_ramps_the_matrix() {
        let mut p = PannerState::default();
        p.start(true, kind::EQUAL_POWER, [-1.0, 0.0, 0.0], 1);
        p.set_direction([1.0, 0.0, 0.0], 4);
        let input = [1.0f32; 4];
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        p.mix(&input, &input, &mut l, &mut r);
        assert!(l.windows(2).all(|w| w[1] <= w[0]) && r.windows(2).all(|w| w[1] >= w[0]));
        assert!(l[3].abs() < 1e-6 && (r[3] - 1.0).abs() < 1e-6, "lands on the target");
        assert!((r[0] - 0.25).abs() < 1e-6, "moves on the first frame");
    }
}
