// The K-weighting and true-peak formulas follow libebur128, Copyright (c) 2011 Jan Kokemüller, and
// the ebur128 crate, Copyright (c) 2020 Sebastian Dröge, both under the MIT licence; the notices
// are in native/audio/third_party/libebur128/ (COPYING, EBUR128-CRATE-LICENSE).

//! Loudness kernels (ADR 0171 §§ loudness, amended by 0172; architecture §4.4; spike S1): K-weighting
//! in f64 (two biquads, coefficients from the core's rate), the L + R mean-square accumulator per
//! sub-block of round(0.1 × rate) frames, and 4× true peak (48 taps, simd128 on wasm), after
//! libebur128's formulas (MIT notice kept with the port).
//!
//! **Who fills it.** Ld1 (M5b): the kernels and spike S1's 189 checks as cargo tests (native and
//! wasm, 48 and 44.1 kHz; `tests/loudness_s1.rs`). The per-meter state (1,512 B budget, ARCH §5.3)
//! is [`Meter`], a plain fixed-size struct, so `audio-core`'s `loudness.rs` (Ld2) holds it in the
//! core's loudness region ([`Meter::in_place`], [`ring_in_place`]) beside its 128-B ring.
//!
//! **What runs per quantum** (the audio-thread half; gating, momentary, short-term, integrated and
//! LRA are main's, ARCH §4.4):
//! 1. **K-weighting** (ITU-R BS.1770-4 stage 1 high shelf, stage 2 high-pass): two transposed
//!    direct-form-II biquads per channel, coefficients and state in f64 ([`KCoef`]).
//! 2. **Sub-blocks:** the sum over frames of `l_k² + r_k²` (channel weights 1.0), split exactly at
//!    each sub-block edge; a finished sub-block's mean square goes to `ring[seq % RING]` as f32 and
//!    `seq` advances. Sub-block energies don't depend on the rate (ARCH §4.4 "Rebuilds").
//! 3. **True peak:** 4× polyphase oversampling, 48 taps (12 per phase), f32. The 11-sample FIR
//!    history is kept every quantum; the FIR runs when the quantum's sample peak (either channel)
//!    reaches the gate ([`Meter::set_true_peak_gate`]; 0 runs it every quantum, as on master), so a
//!    quantum that runs is exact. The reported peak is max(true peak, sample peak), as libebur128's
//!    `ebur128_true_peak`. On wasm with `simd128` the FIR is explicit `f32x4` (one lane per phase,
//!    25.8 k against 41.3 k instructions per quantum in S1); natively it is the scalar form, with
//!    the same operation order, so both give the same bits.
//!
//! **Provenance.** The K-weighting coefficient formulas (the shelf and high-pass prototypes with
//! their `f0`, `G`, `Q`, and the shelf's `Vb = Vh^0.4996667741545416`) and the true-peak
//! interpolator (a 48-tap Hann-windowed sinc for factor 4, tap `4t + p` in phase `p`) follow
//! libebur128 (Copyright (c) 2011 Jan Kokemüller, MIT) and its Rust port, the `ebur128` crate
//! (Copyright (c) 2020 Sebastian Dröge, MIT); the code is S1's independent rewrite for the core's
//! fixed-size, no-allocation setting. Notice: `native/audio/third_party/libebur128/`. One
//! deliberate difference (FU1): away from 48 kHz the high-pass's numerator is scaled so its gain
//! matches the 48 kHz stage's, as BS.1770-5 Annex 1 asks; libebur128 (and so the `ebur128` crate)
//! leaves it at `[1, −2, 1]`, which reads +0.0038 LU at 44.1 kHz and −0.0216 LU at 96 kHz against
//! 48 kHz. At 48 kHz the coefficients are libebur128's bit for bit.
//!
//! Rules as for every module of this crate: transcendentals through `libm`; nothing allocates.

use core::f64::consts::PI;

/// The core's quantum (frames). [`Meter::process`] takes any length; the true-peak stage works in
/// pieces of at most this many frames.
pub const QUANTUM: usize = 128;
/// Sub-block energies kept in a meter's ring (the wire's `LOUD_RING_SUBBLOCKS`: 32 = 3.2 s).
pub const RING: usize = 32;
/// The ring's bytes (`RING` f32): 128 B.
pub const RING_BYTES: usize = RING * 4;
/// The per-meter state budget (ARCH §5.3, `audio-core`'s `loudness::METER_STATE_BYTES`).
pub const STATE_BUDGET_BYTES: usize = 1_512;
/// True-peak oversampling factor (phases).
pub const TP_FACTOR: usize = 4;
/// True-peak taps per phase (48 in all).
pub const TP_TAPS_PER_PHASE: usize = 12;
/// FIR history carried from one quantum to the next.
const TAIL: usize = TP_TAPS_PER_PHASE - 1;
/// A true-peak FIR input block: 11 samples of history, then up to [`QUANTUM`] new ones.
pub const TP_BLOCK: usize = TAIL + QUANTUM;
const HIST: usize = TP_BLOCK;
/// Filter states below this are flushed to 0 after every call (wasm has no flush-to-zero, and a
/// decaying IIR would otherwise run into denormals in digital silence).
const DENORMAL_FLOOR: f64 = 1e-200;
/// Rates outside this range get 48 kHz's coefficients (the shelf's `f0` must stay below Nyquist).
const MIN_RATE: f64 = 8_000.0;
const MAX_RATE: f64 = 768_000.0;

/// The ring a meter writes its finished sub-blocks into: sub-block `e` at `e % RING`.
pub type Ring = [f32; RING];

/// `rate` if it's a usable sample rate, else 48 kHz.
fn sane_rate(rate: f64) -> f64 {
    if rate.is_finite() && (MIN_RATE..=MAX_RATE).contains(&rate) {
        rate
    } else {
        48_000.0
    }
}

/// Frames per sub-block at `rate`: round(0.1 × rate) (4,800 at 48 kHz, 4,410 at 44.1 kHz).
pub fn subblock_frames(rate: f64) -> u32 {
    (sane_rate(rate) / 10.0 + 0.5) as u32
}

/// LUFS of a K-weighted L + R mean square (BS.1770: −0.691 + 10 log10), `-inf` for 0.
pub fn lufs(mean_square: f64) -> f64 {
    if mean_square > 0.0 {
        -0.691 + 10.0 * libm::log10(mean_square)
    } else {
        f64::NEG_INFINITY
    }
}

/// K-weighting biquad coefficients at a rate, `a0` normalised to 1: `b[stage]`, `a[stage]` =
/// `[a1, a2]`; stage 0 is the high shelf, stage 1 the high-pass (`b` = `[1, −2, 1]·g`, `g` = 1 at
/// 48 kHz; FU1, see [`KCoef::new`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KCoef {
    pub b: [[f64; 3]; 2],
    pub a: [[f64; 2]; 2],
}

impl KCoef {
    /// libebur128's formulas (`ebur128_init_filter`) at `rate` (48 kHz if it isn't a usable rate),
    /// except the high-pass's numerator, which is scaled so every rate has 48 kHz's passband gain
    /// (BS.1770-5 Annex 1; FU1). At 48 kHz all ten coefficients are libebur128's, bit for bit.
    ///
    /// The shelf needs no such correction: its gain is exactly 1 at DC and `Vh` at Nyquist at every
    /// rate; it differs from the 48 kHz response only by the bilinear warp (a biquad at another rate
    /// can't follow 48 kHz's tan-warped axis), at most 0.0016 dB at 44.1 kHz and 0.0064 dB at
    /// 96 kHz, around its 1.7 kHz corner (`tests/loudness_annex2.rs`).
    #[allow(non_snake_case)]
    pub fn new(rate: f64) -> KCoef {
        let rate = sane_rate(rate);
        let (f0, G, Q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
        let K = libm::tan(PI * f0 / rate);
        let Vh = libm::pow(10.0, G / 20.0);
        let Vb = libm::pow(Vh, 0.4996667741545416);
        let a0 = 1.0 + K / Q + K * K;
        let shelf_b = [(Vh + Vb * K / Q + K * K) / a0, 2.0 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
        let shelf_a = [2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0];
        let (K, a0) = hp_k_a0(rate);
        let Q = HP_Q;
        let hp_a = [2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0];
        // BS.1770-5 Annex 1 Table 2's 48 kHz set leaves the numerator at [1, -2, 1], so it is the
        // normalised bilinear high-pass times a flat gain a0(48 kHz) (+0.043 dB). libebur128 keeps
        // [1, -2, 1] at every rate, so the gain becomes a0(rate) (+0.0038 dB at 44.1 kHz against
        // 48 kHz's, -0.0216 dB at 96 kHz). Annex 1 asks other rates for "the same frequency
        // response that the specified filter provides at 48 kHz": scaling by a0(48 kHz) / a0(rate)
        // keeps 48 kHz's gain (FU1). At 48 kHz the ratio is x / x = 1.0 exactly, so Table 2's
        // coefficients are unchanged bit for bit.
        let g = hp_k_a0(48_000.0).1 / a0;
        KCoef { b: [shelf_b, [g, -2.0 * g, g]], a: [shelf_a, hp_a] }
    }
}

/// The high-pass (stage 2) prototype's corner (Hz) and Q, libebur128's.
const HP_F0: f64 = 38.13547087602444;
const HP_Q: f64 = 0.5003270373238773;

/// The high-pass's bilinear `K = tan(π f0 / rate)` and its unnormalised `a0 = 1 + K/Q + K²` at
/// `rate`.
#[allow(non_snake_case)]
fn hp_k_a0(rate: f64) -> (f64, f64) {
    let K = libm::tan(PI * HP_F0 / rate);
    (K, 1.0 + K / HP_Q + K * K)
}

/// libebur128's true-peak interpolator: a Hann window over 48 taps times sinc(m / 4), `m = j − 24`;
/// tap `j = 4t + p` is `[t][p]` (phase `p`). Rate-independent.
pub fn true_peak_taps() -> [[f32; TP_FACTOR]; TP_TAPS_PER_PHASE] {
    let mut f = [[0.0f32; TP_FACTOR]; TP_TAPS_PER_PHASE];
    let n = (TP_FACTOR * TP_TAPS_PER_PHASE) as f64;
    for j in 0..TP_FACTOR * TP_TAPS_PER_PHASE {
        let jf = j as f64;
        let w = 0.5 * (1.0 - libm::cos(2.0 * PI * jf / n));
        let m = jf - n / 2.0;
        let x = m * PI / TP_FACTOR as f64;
        let c = if m.abs() > 1e-6 { w * libm::sin(x) / x } else { w };
        f[j / TP_FACTOR][j % TP_FACTOR] = c as f32;
    }
    f
}

/// The larger |sample| of `l[..n]` and `r[..n]` (NaN ignored).
#[inline]
fn sample_peaks(l: &[f32], r: &[f32]) -> [f32; 2] {
    [sample_peak(l), sample_peak(r)]
}

/// The largest |sample| of `x` (NaN ignored; 0 for an empty slice). On wasm with `simd128`, four
/// lanes at a time with `pmax` (`acc < x ? x : acc`, so a NaN `x` keeps `acc`, as `f32::max`
/// does); the maximum is exact either way, so both forms give the same value.
#[inline]
pub fn sample_peak(x: &[f32]) -> f32 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;
        let mut acc = f32x4_splat(0.0);
        let mut chunks = x.chunks_exact(4);
        for c in &mut chunks {
            acc = f32x4_pmax(acc, f32x4_abs(f32x4(c[0], c[1], c[2], c[3])));
        }
        let m = [f32x4_extract_lane::<0>(acc), f32x4_extract_lane::<1>(acc), f32x4_extract_lane::<2>(acc), f32x4_extract_lane::<3>(acc)];
        let m = m[0].max(m[1]).max(m[2].max(m[3]));
        chunks.remainder().iter().fold(m, |m, s| m.max(s.abs()))
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        x.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }
}

/// The oversampling FIR over `h[..TAIL + n]` (`h[TAIL + i]` = input sample `i`, the 11 before it
/// in front): per phase, the largest |output| over the `n` samples. The scalar form (every target
/// without `simd128`); [`true_peak_block`] picks the simd128 one where it's built.
#[inline]
pub fn true_peak_block_scalar(taps: &[[f32; TP_FACTOR]; TP_TAPS_PER_PHASE], h: &[f32; HIST], n: usize) -> [f32; TP_FACTOR] {
    let n = n.min(QUANTUM);
    let mut m = [0.0f32; TP_FACTOR];
    for i in 0..n {
        let w: &[f32; TP_TAPS_PER_PHASE] = h[i..i + TP_TAPS_PER_PHASE].try_into().unwrap(); // w[11 − t] = x[i − t]
        let mut acc = [0.0f32; TP_FACTOR];
        for t in 0..TP_TAPS_PER_PHASE {
            let s = w[TAIL - t];
            for p in 0..TP_FACTOR {
                acc[p] += s * taps[t][p];
            }
        }
        for p in 0..TP_FACTOR {
            m[p] = m[p].max(acc[p].abs());
        }
    }
    m
}

/// [`true_peak_block_scalar`] with explicit `f32x4` (one lane per phase; each input sample splatted
/// and multiplied by its tap's four phase coefficients, added in the scalar form's order, so the
/// two give the same bits).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
pub fn true_peak_block_simd128(taps: &[[f32; TP_FACTOR]; TP_TAPS_PER_PHASE], h: &[f32; HIST], n: usize) -> [f32; TP_FACTOR] {
    use core::arch::wasm32::*;
    let n = n.min(QUANTUM);
    let mut c = [f32x4_splat(0.0); TP_TAPS_PER_PHASE];
    for t in 0..TP_TAPS_PER_PHASE {
        c[t] = f32x4(taps[t][0], taps[t][1], taps[t][2], taps[t][3]);
    }
    let mut mx = f32x4_splat(0.0);
    for i in 0..n {
        let w: &[f32; TP_TAPS_PER_PHASE] = h[i..i + TP_TAPS_PER_PHASE].try_into().unwrap();
        let mut acc = f32x4_splat(0.0);
        for t in 0..TP_TAPS_PER_PHASE {
            acc = f32x4_add(acc, f32x4_mul(f32x4_splat(w[TAIL - t]), c[t]));
        }
        mx = f32x4_max(mx, f32x4_abs(acc));
    }
    [f32x4_extract_lane::<0>(mx), f32x4_extract_lane::<1>(mx), f32x4_extract_lane::<2>(mx), f32x4_extract_lane::<3>(mx)]
}

/// The true-peak FIR this build runs: simd128 on wasm built with `+simd128` (as `build.mjs`
/// builds the core), else scalar.
#[inline]
pub fn true_peak_block(taps: &[[f32; TP_FACTOR]; TP_TAPS_PER_PHASE], h: &[f32; HIST], n: usize) -> [f32; TP_FACTOR] {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        true_peak_block_simd128(taps, h, n)
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        true_peak_block_scalar(taps, h, n)
    }
}

/// `true` when this build's [`true_peak_block`] is the simd128 form.
pub const TRUE_PEAK_SIMD128: bool = cfg!(all(target_arch = "wasm32", target_feature = "simd128"));

/// One loudness meter's audio-thread state (one stereo bus): K-weighting, the sub-block
/// accumulator and the true-peak stage. Plain numbers only, so any bit pattern is a valid value
/// and the core can hold it in its region ([`Meter::in_place`]); all-zero is an inert meter
/// ([`Meter::process`] does nothing until [`Meter::init`]). 1,496 B (the budget is 1,512 B).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Meter {
    /// K-weighting numerators `[stage][b0, b1, b2]` (stage 0 shelf, 1 high-pass).
    kb: [[f64; 3]; 2],
    /// K-weighting denominators `[stage][a1, a2]`.
    ka: [[f64; 2]; 2],
    /// Biquad state `[channel][stage][z1, z2]`.
    z: [[[f64; 2]; 2]; 2],
    /// The running sum of `l_k² + r_k²` over the open sub-block.
    sub_acc: f64,
    /// True-peak FIR input per channel: 11 samples of history, then the piece being processed.
    hist: [[f32; HIST]; 2],
    /// [`true_peak_taps`].
    taps: [[f32; TP_FACTOR]; TP_TAPS_PER_PHASE],
    /// True-peak (FIR output) maximum per channel since the last take, linear.
    tp: [f32; 2],
    /// Sample-peak maximum per channel since the last take, linear.
    sample_peak: [f32; 2],
    /// The FIR runs for a piece whose sample peak (either channel) is at least this, linear.
    tp_gate: f32,
    /// Frames per sub-block (0: not initialised).
    sub_len: u32,
    /// Frames in the open sub-block.
    sub_n: u32,
    /// Sub-blocks finished since the last reset (wraps).
    seq: u32,
    /// Pieces (quanta) in which the FIR ran / was gated off, since the last reset (wrap).
    tp_ran: u32,
    tp_skipped: u32,
}

const _: () = assert!(core::mem::size_of::<Meter>() <= STATE_BUDGET_BYTES, "ARCH §5.3: 1,512 B per meter");
const _: () = assert!(core::mem::align_of::<Meter>() == 8);

impl Meter {
    /// The state's size (1,496 B).
    pub const BYTES: usize = core::mem::size_of::<Meter>();

    /// An inert meter (all zero; [`Meter::init`] it before use).
    pub const fn zeroed() -> Meter {
        Meter {
            kb: [[0.0; 3]; 2],
            ka: [[0.0; 2]; 2],
            z: [[[0.0; 2]; 2]; 2],
            sub_acc: 0.0,
            hist: [[0.0; HIST]; 2],
            taps: [[0.0; TP_FACTOR]; TP_TAPS_PER_PHASE],
            tp: [0.0; 2],
            sample_peak: [0.0; 2],
            tp_gate: 0.0,
            sub_len: 0,
            sub_n: 0,
            seq: 0,
            tp_ran: 0,
            tp_skipped: 0,
        }
    }

    /// A meter for `rate`, true peak every quantum.
    pub fn new(rate: f64) -> Meter {
        let mut m = Meter::zeroed();
        m.init(rate);
        m
    }

    /// The meter in `bytes` (the core's region), in place: `None` if `bytes` is shorter than
    /// [`Meter::BYTES`] or not 8-byte aligned. The bytes are read as they are (zero: inert).
    pub fn in_place(bytes: &mut [u8]) -> Option<&mut Meter> {
        if bytes.len() < Meter::BYTES || bytes.as_ptr() as usize % core::mem::align_of::<Meter>() != 0 {
            return None;
        }
        // SAFETY: length and alignment checked; every field is an f64, f32 or u32 (or an array of
        // them), so any bit pattern is a valid `Meter`; the borrow of `bytes` is exclusive.
        Some(unsafe { &mut *(bytes.as_mut_ptr() as *mut Meter) })
    }

    /// Sets the meter up for `rate` in place (coefficients, taps, sub-block length; true peak
    /// every quantum) and clears it ([`Meter::reset`]). A rate outside 8–768 kHz gets 48 kHz's.
    pub fn init(&mut self, rate: f64) {
        let k = KCoef::new(rate);
        self.kb = k.b;
        self.ka = k.a;
        self.taps = true_peak_taps();
        self.sub_len = subblock_frames(rate);
        self.tp_gate = 0.0;
        self.reset();
    }

    /// Clears the filters, the open sub-block, the sequence, the FIR history, the peaks and the
    /// counters; keeps the coefficients and the gate (RESET, ARCH §4.4 "Rebuilds").
    pub fn reset(&mut self) {
        self.z = [[[0.0; 2]; 2]; 2];
        self.sub_acc = 0.0;
        self.sub_n = 0;
        self.seq = 0;
        self.hist = [[0.0; HIST]; 2];
        self.tp = [0.0; 2];
        self.sample_peak = [0.0; 2];
        self.tp_ran = 0;
        self.tp_skipped = 0;
    }

    /// The K-weighting coefficients in use.
    pub fn coefficients(&self) -> KCoef {
        KCoef { b: self.kb, a: self.ka }
    }

    /// Frames per sub-block (0 before [`Meter::init`]).
    pub fn subblock_frames(&self) -> u32 {
        self.sub_len
    }

    /// Sub-blocks finished since the last reset (wraps); sub-block `e` is at `ring[e % RING]`.
    pub fn seq(&self) -> u32 {
        self.seq
    }

    /// The true-peak gate, linear: the FIR runs for a quantum whose sample peak (either channel)
    /// is at least this. 0 (the default) runs it every quantum (master); the core passes the
    /// active target's ceiling − 6 dB for other buses (`tpGateDbfs`). NaN reads as 0.
    pub fn set_true_peak_gate(&mut self, linear: f32) {
        self.tp_gate = if linear.is_nan() { 0.0 } else { linear };
    }

    /// The gate in use, linear.
    pub fn true_peak_gate(&self) -> f32 {
        self.tp_gate
    }

    /// Quanta in which the FIR ran, and quanta it was gated off, since the last reset (wrap).
    pub fn true_peak_counts(&self) -> (u32, u32) {
        (self.tp_ran, self.tp_skipped)
    }

    /// One quantum (or any length) of the bus's left and right output: K-weighting and the
    /// sub-blocks ([`Meter::process_energy`]), then the true peak ([`Meter::process_true_peak`]).
    /// Returns the sub-blocks finished (written to `ring`).
    pub fn process(&mut self, l: &[f32], r: &[f32], ring: &mut Ring) -> u32 {
        let done = self.process_energy(l, r, ring);
        self.process_true_peak(l, r);
        done
    }

    /// K-weights `l`, `r` (the shorter length) into the open sub-block; each finished sub-block's
    /// mean square goes to `ring[seq % RING]` and `seq` advances. Returns the sub-blocks finished.
    /// A piece holding NaN or ±inf adds nothing and resets the filter state, so one bad sample
    /// can't poison the meter. Does nothing on an inert meter.
    pub fn process_energy(&mut self, l: &[f32], r: &[f32], ring: &mut Ring) -> u32 {
        if self.sub_len == 0 {
            return 0;
        }
        let n = l.len().min(r.len());
        let mut done = 0;
        let mut i = 0;
        while i < n {
            let take = (n - i).min((self.sub_len - self.sub_n.min(self.sub_len)) as usize).max(1);
            let e = self.kweight(&l[i..i + take], &r[i..i + take]);
            if e.is_finite() {
                self.sub_acc += e;
            } else {
                self.z = [[[0.0; 2]; 2]; 2];
            }
            self.sub_n += take as u32;
            i += take;
            if self.sub_n >= self.sub_len {
                ring[self.seq as usize % RING] = (self.sub_acc / self.sub_len as f64) as f32;
                self.seq = self.seq.wrapping_add(1);
                self.sub_acc = 0.0;
                self.sub_n = 0;
                done += 1;
            }
        }
        for ch in self.z.iter_mut() {
            for st in ch.iter_mut() {
                for v in st.iter_mut() {
                    if v.abs() < DENORMAL_FLOOR {
                        *v = 0.0;
                    }
                }
            }
        }
        done
    }

    /// The K-weighting of `l`, `r` (equal lengths): the sum over frames of `l_k² + r_k²`.
    #[inline]
    fn kweight(&mut self, l: &[f32], r: &[f32]) -> f64 {
        let (kb, ka) = (self.kb, self.ka);
        let [mut zl, mut zr] = self.z;
        let mut acc = 0.0f64;
        for (&xl, &xr) in l.iter().zip(r) {
            let mut x = [xl as f64, xr as f64];
            for s in 0..2 {
                let (b, a) = (&kb[s], &ka[s]);
                let y0 = b[0] * x[0] + zl[s][0];
                zl[s][0] = b[1] * x[0] - a[0] * y0 + zl[s][1];
                zl[s][1] = b[2] * x[0] - a[1] * y0;
                let y1 = b[0] * x[1] + zr[s][0];
                zr[s][0] = b[1] * x[1] - a[0] * y1 + zr[s][1];
                zr[s][1] = b[2] * x[1] - a[1] * y1;
                x = [y0, y1];
            }
            acc += x[0] * x[0] + x[1] * x[1];
        }
        self.z = [zl, zr];
        acc
    }

    /// The true-peak stage over `l`, `r` (the shorter length), in pieces of at most [`QUANTUM`]
    /// frames: the sample peak always, the FIR history always, the FIR for a piece whose sample
    /// peak reaches the gate. Does nothing on an inert meter.
    pub fn process_true_peak(&mut self, l: &[f32], r: &[f32]) {
        if self.sub_len == 0 {
            return;
        }
        let n = l.len().min(r.len());
        let mut o = 0;
        while o < n {
            let e = (o + QUANTUM).min(n);
            self.true_peak_piece(&l[o..e], &r[o..e]);
            o = e;
        }
    }

    fn true_peak_piece(&mut self, l: &[f32], r: &[f32]) {
        let n = l.len();
        let sp = sample_peaks(l, r);
        self.sample_peak = [self.sample_peak[0].max(sp[0]), self.sample_peak[1].max(sp[1])];
        let run = sp[0].max(sp[1]) >= self.tp_gate;
        if run {
            self.tp_ran = self.tp_ran.wrapping_add(1);
        } else {
            self.tp_skipped = self.tp_skipped.wrapping_add(1);
        }
        for (ch, x) in [l, r].into_iter().enumerate() {
            let h = &mut self.hist[ch];
            h[TAIL..TAIL + n].copy_from_slice(x);
            if run {
                let m = true_peak_block(&self.taps, h, n);
                let mx = m[0].max(m[1]).max(m[2].max(m[3]));
                self.tp[ch] = self.tp[ch].max(mx);
            }
            h.copy_within(n..n + TAIL, 0);
        }
    }

    /// The peak per channel since the last take, linear: max(true peak, sample peak).
    pub fn peak(&self) -> [f32; 2] {
        [self.tp[0].max(self.sample_peak[0]), self.tp[1].max(self.sample_peak[1])]
    }

    /// The STATUS take: [`Meter::peak`], then the peaks clear.
    pub fn take_peak(&mut self) -> [f32; 2] {
        let p = self.peak();
        self.tp = [0.0; 2];
        self.sample_peak = [0.0; 2];
        p
    }
}

/// The ring in `bytes` (the core's region), in place: `None` if `bytes` is shorter than
/// [`RING_BYTES`] or not 4-byte aligned.
pub fn ring_in_place(bytes: &mut [u8]) -> Option<&mut Ring> {
    if bytes.len() < RING_BYTES || bytes.as_ptr() as usize % core::mem::align_of::<Ring>() != 0 {
        return None;
    }
    // SAFETY: length and alignment checked; any bit pattern is a valid `[f32; RING]`; the borrow
    // of `bytes` is exclusive.
    Some(unsafe { &mut *(bytes.as_mut_ptr() as *mut Ring) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_fits_the_budget_and_the_region_slices() {
        assert_eq!(Meter::BYTES, 1_496);
        assert!(Meter::BYTES <= STATE_BUDGET_BYTES);
        assert_eq!(RING_BYTES, 128);
        let mut region = [0u64; (STATE_BUDGET_BYTES + RING_BYTES) / 8];
        // SAFETY: a u64 array viewed as bytes.
        let bytes = unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut u8, STATE_BUDGET_BYTES + RING_BYTES) };
        let (state, ring) = bytes.split_at_mut(STATE_BUDGET_BYTES);
        let m = Meter::in_place(state).expect("aligned, long enough");
        let ring = ring_in_place(ring).expect("aligned, long enough");
        let z = [0.25f32; 4_800];
        assert_eq!(m.process(&z, &z, ring), 0, "an all-zero meter is inert");
        m.init(48_000.0);
        assert_eq!(m.process(&z, &z, ring), 1);
        assert!(ring[0] > 0.0);
        assert!(Meter::in_place(&mut state[1..]).is_none(), "misaligned");
        assert!(Meter::in_place(&mut state[..100]).is_none(), "short");
    }

    #[test]
    fn subblock_frames_rounds_a_tenth_of_the_rate() {
        assert_eq!(subblock_frames(48_000.0), 4_800);
        assert_eq!(subblock_frames(44_100.0), 4_410);
        assert_eq!(subblock_frames(22_050.0), 2_205);
        assert_eq!(subblock_frames(f64::NAN), 4_800);
        assert_eq!(subblock_frames(0.0), 4_800);
    }

    #[test]
    fn gate_skips_quiet_quanta_and_keeps_history() {
        let mut m = Meter::new(48_000.0);
        let mut ring = [0.0; RING];
        m.set_true_peak_gate(0.5);
        let quiet = [0.1f32; QUANTUM];
        let loud = [0.9f32; QUANTUM];
        m.process(&quiet, &quiet, &mut ring);
        m.process(&loud, &loud, &mut ring);
        assert_eq!(m.true_peak_counts(), (1, 1));
        let p = m.take_peak();
        assert!(p[0] >= 0.9 && p[1] >= 0.9);
        assert_eq!(m.peak(), [0.0, 0.0], "the take clears");
    }
}
