// SPDX-License-Identifier: Apache-2.0 OR MIT
//! The bed decoder (ADR 0162, api-and-models §3.1 and §5.1, architecture §2.1 and §4.2): decodes a
//! 16-channel order-3 ambisonic bed (ACN/SN3D, `ambisonic.rs`) to binaural stereo through the
//! MagLS filters (R9): 16 filter pairs, one per channel and ear, convolved with the bed's channels
//! and summed per ear. Ported from the bed spike's SH-domain decoder
//! (`spikes/audio-spatial/bed/src/decoder.rs`, `Decoder::process` with `ShMagLs`); Myco's own code.
//! The baked 16 to 2 matrix used while the filters aren't resident, or with
//! `audio.spatial: "equalPower"`, is `bed_matrix.rs` (A3).
//!
//! **Convolution.** Uniform partitioned, overlap-save, as the HRTF panner (`hrtf::convolver`): the
//! filters are cut into `P` partitions of 128 taps, each stored as the 256-point real FFT of the
//! partition zero-padded ([`MaglsFilters`], shared by every decoder of a core). Each decoder keeps,
//! per channel, the spectra of `[previous quantum, this quantum]` for the newest `P` quanta in a
//! ring ([`BedDecoderN`]). Per quantum: 16 forward FFTs, `16 × 2 × P` complex multiply-adds over
//! 128 bins (both ears in one pass over each input spectrum), 2 inverse FFTs. Output frame `n` is
//! the exact linear convolution at `n`: no latency. Packed bins as `hrtf::fft` (bin 0: DC in `re`,
//! Nyquist in `im`). The FFTs are the HRTF code's (`hrtf::fft` on the reverb's transform), so
//! decoding links no new FFT size; the scratch is the core's [`HrtfScratch`].
//!
//! **Partitions and rates.** `P` is the HRTF panner's partition count for the context rate
//! ([`crate::hrtf::partitions_for_sample_rate`]: 2 below 88.2 kHz, 4 from there), so the format 4
//! responses (256 taps at up to 48 kHz, 512 above 88.2 kHz, api-and-models §4.5) fit: taps
//! `≤ 128 P`, shorter responses are zero-padded. Sizes at `P = 2`: [`MaglsFilters`] 65,544 B,
//! [`BedDecoderN`] 40,964 B (api-and-models §3.1: 64 KB shared, 40 KB per decoder).
//!
//! **Idle.** Output is the convolution of the last `128 P` frames of input, so once a bed has been
//! silent for `P` quanta the decoder's output is silent (to rounding); the core then calls
//! [`BedDecoderN::reset`] and stops calling [`BedDecoderN::process`] until something encodes again
//! (architecture §2.1: "a bed decodes only while something encoded into it in the last 2 quanta").
//!
//! Both types are `#[repr(C)]` and all-zero valid (an empty, not-ready filter set; a silent
//! decoder), so the core can place them in its zeroed `Beds` region. The process path is one
//! function over slices for every `P` (as the HRTF panner's H3 rule), so the wasm carries it once.
//! Nothing allocates; no transcendentals.

use microfft::Complex32;

use crate::ambisonic::CHANNELS;
use crate::hrtf::fft::{irfft, rfft};
use crate::hrtf::HrtfScratch;
use crate::hrtf::{MAX_PARTITIONS, PARTITION_BINS, PARTITION_FFT_SIZE, QUANTUM_FRAMES};

/// Frames per quantum, and taps per partition.
pub const QUANTUM: usize = QUANTUM_FRAMES;
/// Complex bins per partition spectrum (packed, 256-point real FFT).
pub const BINS: usize = PARTITION_BINS;
/// Ears (outputs): 0 left, 1 right.
pub const EARS: usize = 2;

const ZERO_BIN: Complex32 = Complex32 { re: 0.0, im: 0.0 };

/// Why [`MaglsFilters::load`] refused a filter set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterError {
    /// `taps` is 0 or more than `128 P`.
    Taps,
    /// `time.len()` isn't `16 × 2 × taps`.
    Length,
    /// A sample is NaN or infinite.
    NotFinite,
}

/// The partitions `taps` need (`ceil(taps / 128)`), `None` for 0 or above [`MAX_PARTITIONS`] × 128.
pub const fn partitions_for_taps(taps: usize) -> Option<usize> {
    if taps == 0 || taps > MAX_PARTITIONS * QUANTUM {
        None
    } else {
        Some(taps.div_ceil(QUANTUM))
    }
}

/// The MagLS filters in the frequency domain, shared by every decoder of a core: `h[channel][ear]
/// [partition]`, each the packed spectrum of 128 taps zero-padded to 256. All-zero is "not ready".
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MaglsFilters<const P: usize> {
    h: [[[[Complex32; BINS]; P]; EARS]; CHANNELS],
    /// Partitions in use (`ceil(taps / 128)`, at most `P`); 0 while not ready.
    parts: u32,
    ready: u32,
}

impl<const P: usize> MaglsFilters<P> {
    /// Not ready (every decoder outputs nothing until [`MaglsFilters::load`] succeeds).
    pub const ZERO: Self = Self { h: [[[[ZERO_BIN; BINS]; P]; EARS]; CHANNELS], parts: 0, ready: 0 };

    /// Transforms the format 4 time responses: `time` is `[16 channels][2 ears][taps]` f32
    /// (api-and-models §4.5, after the 32-byte header, at the context rate), `taps ≤ 128 P`.
    /// Called once when the filters are committed (`bedDecoderReady`), not per quantum: 32 P
    /// forward FFTs. On an error the set is left not ready.
    pub fn load(&mut self, time: &[f32], taps: usize, scratch: &mut HrtfScratch) -> Result<(), FilterError> {
        self.ready = 0;
        self.parts = 0;
        let parts = match partitions_for_taps(taps) {
            Some(p) if p <= P => p,
            _ => return Err(FilterError::Taps),
        };
        if time.len() != CHANNELS * EARS * taps {
            return Err(FilterError::Length);
        }
        if time.iter().any(|v| !v.is_finite()) {
            return Err(FilterError::NotFinite);
        }
        let HrtfScratch { block, work, twiddles, .. } = scratch;
        for (c, ears) in self.h.iter_mut().enumerate() {
            for (e, partitions) in ears.iter_mut().enumerate() {
                let response = &time[(c * EARS + e) * taps..][..taps];
                for (k, spectrum) in partitions.iter_mut().enumerate() {
                    block.fill(0.0);
                    if k < parts {
                        let seg = &response[k * QUANTUM..response.len().min((k + 1) * QUANTUM)];
                        block[..seg.len()].copy_from_slice(seg);
                        spectrum.copy_from_slice(rfft(&mut block[..], &mut work[..BINS], twiddles));
                    } else {
                        spectrum.fill(ZERO_BIN);
                    }
                }
            }
        }
        self.parts = parts as u32;
        self.ready = 1;
        Ok(())
    }

    /// Whether a filter set is loaded.
    pub fn is_ready(&self) -> bool {
        self.ready == 1 && self.parts as usize <= P && self.parts > 0
    }

    /// Partitions in use (0 while not ready).
    pub fn partitions(&self) -> usize {
        if self.is_ready() {
            self.parts as usize
        } else {
            0
        }
    }

    /// Marks the set not ready (a rebuild, or the filters were evicted); the spectra stay.
    pub fn clear(&mut self) {
        self.ready = 0;
        self.parts = 0;
    }
}

impl<const P: usize> Default for MaglsFilters<P> {
    fn default() -> Self {
        Self::ZERO
    }
}

/// One bed's (or one private clip decoder's) convolution state: per channel, the input spectra of
/// the newest `P` quanta in a ring and the previous quantum (overlap-save). All-zero is silent.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BedDecoderN<const P: usize> {
    spectra: [[[Complex32; BINS]; P]; CHANNELS],
    previous: [[f32; QUANTUM]; CHANNELS],
    /// The ring slot holding the newest spectra (`< P`).
    newest: u32,
}

/// The decoder at 44.1 and 48 kHz (and every rate below 88.2 kHz).
pub type BedDecoder = BedDecoderN<2>;

impl<const P: usize> BedDecoderN<P> {
    /// A silent decoder.
    pub const ZERO: Self = Self { spectra: [[[ZERO_BIN; BINS]; P]; CHANNELS], previous: [[0.0; QUANTUM]; CHANNELS], newest: 0 };

    /// Clears the history (silence before now): a new host, a freed slot, RESET, or idle.
    pub fn reset(&mut self) {
        *self = Self::ZERO;
    }

    /// Decodes one quantum of `bed` (channel-major, ACN/SN3D) and **adds** the binaural result into
    /// `out_l` and `out_r` (the host bus's buffer). Only channels `0..channels` are read (clamped
    /// to 16; 4 for a first-order private decoder, 9 for second order); the others are treated as
    /// silent and their history isn't updated, so a decoder whose `channels` changes is reset by
    /// the caller. Does nothing while `filters` isn't ready (the core decodes through `bed_matrix`).
    pub fn process(&mut self, bed: &[[f32; QUANTUM]; CHANNELS], channels: usize, filters: &MaglsFilters<P>, scratch: &mut HrtfScratch, out_l: &mut [f32; QUANTUM], out_r: &mut [f32; QUANTUM]) {
        if !filters.is_ready() || P == 0 {
            return;
        }
        decode(
            self.spectra.as_flattened_mut(),
            P,
            &mut self.previous,
            &mut self.newest,
            filters.h.as_flattened().as_flattened(),
            filters.parts as usize,
            bed,
            channels.min(CHANNELS),
            scratch,
            out_l,
            out_r,
        );
    }
}

impl<const P: usize> Default for BedDecoderN<P> {
    fn default() -> Self {
        Self::ZERO
    }
}

/// [`BedDecoderN::process`] over slices, one copy for every `P`. `spectra[ch * p + slot]`,
/// `h[(ch * 2 + ear) * p + k]`.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn decode(
    spectra: &mut [[Complex32; BINS]],
    p: usize,
    previous: &mut [[f32; QUANTUM]; CHANNELS],
    newest: &mut u32,
    h: &[[Complex32; BINS]],
    parts: usize,
    bed: &[[f32; QUANTUM]; CHANNELS],
    channels: usize,
    scratch: &mut HrtfScratch,
    out_l: &mut [f32; QUANTUM],
    out_r: &mut [f32; QUANTUM],
) {
    let HrtfScratch { block, work, twiddles, spectrum, time_a, .. } = scratch;
    let slot = (*newest as usize + 1) % p;
    *newest = slot as u32;
    // Forward: the spectrum of [previous, current] per channel into the ring's newest slot.
    for ch in 0..channels {
        block[..QUANTUM].copy_from_slice(&previous[ch]);
        block[QUANTUM..].copy_from_slice(&bed[ch]);
        previous[ch] = bed[ch];
        spectra[ch * p + slot].copy_from_slice(rfft(&mut block[..], &mut work[..BINS], twiddles));
    }
    // Multiply-add: both ears per input spectrum.
    let (acc_l, rest) = spectrum.split_at_mut(BINS);
    let acc_r = &mut rest[..BINS];
    acc_l.fill(ZERO_BIN);
    acc_r.fill(ZERO_BIN);
    let parts = parts.min(p);
    for ch in 0..channels {
        for k in 0..parts {
            let x = &spectra[ch * p + (slot + p - k) % p];
            let hl = &h[(ch * EARS) * p + k];
            let hr = &h[(ch * EARS + 1) * p + k];
            // Bin 0 packs two real values: DC in re, Nyquist in im.
            acc_l[0].re += x[0].re * hl[0].re;
            acc_l[0].im += x[0].im * hl[0].im;
            acc_r[0].re += x[0].re * hr[0].re;
            acc_r[0].im += x[0].im * hr[0].im;
            for b in 1..BINS {
                let (xr, xi) = (x[b].re, x[b].im);
                acc_l[b].re += xr * hl[b].re - xi * hl[b].im;
                acc_l[b].im += xr * hl[b].im + xi * hl[b].re;
                acc_r[b].re += xr * hr[b].re - xi * hr[b].im;
                acc_r[b].im += xr * hr[b].im + xi * hr[b].re;
            }
        }
    }
    // Inverse: the last 128 frames of each ear's circular convolution are the linear one.
    let t = &mut time_a[..PARTITION_FFT_SIZE];
    irfft(acc_l, t, &mut work[..BINS], twiddles);
    for (o, v) in out_l.iter_mut().zip(&t[QUANTUM..]) {
        *o += v;
    }
    irfft(acc_r, t, &mut work[..BINS], twiddles);
    for (o, v) in out_r.iter_mut().zip(&t[QUANTUM..]) {
        *o += v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters_with(taps: usize, f: impl Fn(usize, usize, usize) -> f32) -> Box<MaglsFilters<2>> {
        let mut time = vec![0.0f32; CHANNELS * EARS * taps];
        for c in 0..CHANNELS {
            for e in 0..EARS {
                for t in 0..taps {
                    time[(c * EARS + e) * taps + t] = f(c, e, t);
                }
            }
        }
        let mut m = Box::new(MaglsFilters::<2>::ZERO);
        m.load(&time, taps, &mut HrtfScratch::new()).unwrap();
        m
    }

    #[test]
    fn sizes_match_the_design() {
        assert_eq!(core::mem::size_of::<MaglsFilters<2>>(), 65_544);
        assert_eq!(core::mem::size_of::<BedDecoder>(), 40_964);
    }

    #[test]
    fn load_refuses_bad_sets() {
        let mut s = HrtfScratch::new();
        let mut m = Box::new(MaglsFilters::<2>::ZERO);
        assert!(!m.is_ready());
        assert_eq!(m.load(&vec![0.0; 32 * 512], 512, &mut s), Err(FilterError::Taps));
        assert_eq!(m.load(&[], 0, &mut s), Err(FilterError::Taps));
        assert_eq!(m.load(&vec![0.0; 32 * 256 - 1], 256, &mut s), Err(FilterError::Length));
        let mut bad = vec![0.0; 32 * 256];
        bad[77] = f32::NAN;
        assert_eq!(m.load(&bad, 256, &mut s), Err(FilterError::NotFinite));
        assert!(!m.is_ready());
        assert_eq!(m.load(&vec![0.0; 32 * 200], 200, &mut s), Ok(()));
        assert_eq!(m.partitions(), 2);
        m.clear();
        assert_eq!(m.partitions(), 0);
    }

    #[test]
    fn unit_impulse_filters_pass_w_through_one_ear_each() {
        // W to the left ear as a unit impulse delayed by 130 frames (crosses a partition), W to the
        // right ear undelayed; every other channel's filters zero.
        let f = filters_with(256, |c, e, t| if c == 0 && ((e == 0 && t == 130) || (e == 1 && t == 0)) { 1.0 } else { 0.0 });
        let mut d = Box::new(BedDecoder::ZERO);
        let mut s = HrtfScratch::new();
        let mut input = Vec::new();
        let (mut ol, mut or) = (Vec::new(), Vec::new());
        for q in 0..4 {
            let mut bed = [[0.0f32; QUANTUM]; CHANNELS];
            for i in 0..QUANTUM {
                bed[0][i] = ((q * QUANTUM + i) as f32 * 0.37).sin();
                bed[5][i] = 9.0; // ignored: its filters are zero
            }
            input.extend_from_slice(&bed[0]);
            let (mut l, mut r) = ([0.0; QUANTUM], [0.0; QUANTUM]);
            d.process(&bed, 16, &f, &mut s, &mut l, &mut r);
            ol.extend_from_slice(&l);
            or.extend_from_slice(&r);
        }
        for n in 0..input.len() {
            let want_l = if n >= 130 { input[n - 130] } else { 0.0 };
            assert!((ol[n] - want_l).abs() < 1e-5, "left {n}");
            assert!((or[n] - input[n]).abs() < 1e-5, "right {n}");
        }
    }

    #[test]
    fn adds_into_the_output_and_waits_for_filters() {
        let mut d = Box::new(BedDecoder::ZERO);
        let mut s = HrtfScratch::new();
        let bed = [[1.0f32; QUANTUM]; CHANNELS];
        let (mut l, mut r) = ([0.5; QUANTUM], [0.5; QUANTUM]);
        d.process(&bed, 16, &MaglsFilters::<2>::ZERO, &mut s, &mut l, &mut r);
        assert!(l.iter().chain(&r).all(|&v| v == 0.5), "not ready: untouched");
        let f = filters_with(128, |c, e, t| if c == 0 && t == 0 { if e == 0 { 1.0 } else { 2.0 } } else { 0.0 });
        d.process(&bed, 16, &f, &mut s, &mut l, &mut r);
        for i in 0..QUANTUM {
            assert!((l[i] - 1.5).abs() < 1e-5 && (r[i] - 2.5).abs() < 1e-5);
        }
    }

    #[test]
    fn silent_after_p_quanta_and_reset_clears() {
        let f = filters_with(256, |c, e, t| ((c * 31 + e * 7 + t) % 13) as f32 * 0.01 - 0.06);
        let mut d = Box::new(BedDecoder::ZERO);
        let mut s = HrtfScratch::new();
        let loud = [[0.7f32; QUANTUM]; CHANNELS];
        let silent = [[0.0f32; QUANTUM]; CHANNELS];
        let (mut l, mut r) = ([0.0; QUANTUM], [0.0; QUANTUM]);
        d.process(&loud, 16, &f, &mut s, &mut l, &mut r);
        for q in 0..3 {
            let (mut l, mut r) = ([0.0; QUANTUM], [0.0; QUANTUM]);
            d.process(&silent, 16, &f, &mut s, &mut l, &mut r);
            let peak = l.iter().chain(&r).fold(0.0f32, |a, v| a.max(v.abs()));
            if q >= 2 {
                assert!(peak < 1e-5, "quantum {q} after silence: {peak}");
            } else if q == 0 {
                assert!(peak > 1e-3);
            }
        }
        d.reset();
        let (mut l, mut r) = ([0.0; QUANTUM], [0.0; QUANTUM]);
        d.process(&silent, 16, &f, &mut s, &mut l, &mut r);
        assert!(l.iter().chain(&r).all(|&v| v == 0.0));
    }

    #[test]
    fn first_order_reads_four_channels() {
        let f = filters_with(256, |c, e, t| ((c * 5 + e * 3 + t * 11) % 17) as f32 * 0.01 - 0.08);
        let mut bed = [[0.0f32; QUANTUM]; CHANNELS];
        for (c, ch) in bed.iter_mut().enumerate() {
            for (i, v) in ch.iter_mut().enumerate() {
                *v = ((c * 131 + i * 7) % 23) as f32 * 0.05 - 0.5;
            }
        }
        let mut only4 = bed;
        for ch in only4.iter_mut().skip(4) {
            ch.fill(0.0);
        }
        let mut s = HrtfScratch::new();
        let (mut a, mut b) = (Box::new(BedDecoder::ZERO), Box::new(BedDecoder::ZERO));
        let (mut l1, mut r1, mut l2, mut r2) = ([0.0; QUANTUM], [0.0; QUANTUM], [0.0; QUANTUM], [0.0; QUANTUM]);
        a.process(&bed, 4, &f, &mut s, &mut l1, &mut r1);
        b.process(&only4, 16, &f, &mut s, &mut l2, &mut r2);
        for i in 0..QUANTUM {
            assert!((l1[i] - l2[i]).abs() < 1e-5 && (r1[i] - r2[i]).abs() < 1e-5);
        }
    }

    #[test]
    fn partition_counts() {
        assert_eq!(partitions_for_taps(256), Some(2));
        assert_eq!(partitions_for_taps(257), Some(3));
        assert_eq!(partitions_for_taps(512), Some(4));
        assert_eq!(partitions_for_taps(513), None);
        assert_eq!(partitions_for_taps(0), None);
    }
}
