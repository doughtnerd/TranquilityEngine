//! The order-3 MagLS binaural decoder (Schörkhuber, Zaunschirm and Höldrich, "Binaural rendering of
//! Ambisonic signals via magnitude least squares", 2018), designed from M1's HRTF kernels as the bed
//! spike did (`spikes/audio-spatial/bed/src/decoder.rs`, `ShMagLs`): the filters the core convolves
//! the 16 bed channels with, one pair per channel.
//!
//! - Data: every measured direction of the HRIR grid (24 azimuths, -45° up to each azimuth's top),
//!   each ear's kernel as the HRTF panner builds it (`kernel_time_response`, 256 taps at 44.1 kHz)
//!   with its leading delay put back as a linear phase, as 512-point spectra. The grid has nothing
//!   below -45°, so -60° and -75° at every azimuth and the nadir read the -45° responses (a clamp).
//! - Fit: weighted ridge least squares (weights `max(cos el, 0.1)`, ridge 1% of the mean diagonal).
//!   Below 1.5 kHz the complex least-squares solution; above, per bin, [`MAGLS_ITERATIONS`] rounds
//!   of "keep the measured magnitude, take the fit's phase, refit" from the least-squares start, so
//!   the high-frequency level an order-3 fit loses comes back (the spike: 5 to 12 dB at the near ear
//!   without it).
//! - Filters: inverse transform, cut to 256 taps with a 16-tap half-Hann fade.
//!
//! Every step is `f64` (the transforms are `audio_dsp::hrtf::fft`, microfft underneath, in `f32`),
//! fixed grids and counts, so the bake is deterministic.

use audio_dsp::hrtf::database::HrirDatabase;
use audio_dsp::hrtf::elevation_index::{fft_size_for_sample_rate, MAX_ELEVATIONS, NUMBER_OF_RAW_AZIMUTHS, NUMBER_OF_RAW_ELEVATIONS};
use audio_dsp::hrtf::fft::{irfft, rfft, Twiddles};
use audio_dsp::hrtf::kernel::{kernel_frame_delay, kernel_time_response};
use audio_dsp::hrtf::{Ear, HrtfScratch};
use microfft::Complex32;

use crate::linalg::projector;
use crate::sh::{sh16_at, CHANNELS};

/// Taps per filter at the asset's rate (C6: `MAGLS_TAPS`).
pub const TAPS: usize = 256;
/// The transform size the design works in.
pub const FFT: usize = 2 * TAPS;
/// Packed bins of a [`FFT`]-point spectrum (bin 0: DC in `re`, Nyquist in `im`).
pub const BINS: usize = FFT / 2;
/// Below this the fit is plain least squares.
pub const MAGLS_CUTOFF_HZ: f64 = 1500.0;
pub const MAGLS_ITERATIONS: usize = 10;
const RIDGE: f64 = 0.01;
const FADE: usize = 16;

const ZERO: Complex32 = Complex32 { re: 0.0, im: 0.0 };

/// `[channel][ear][tap]`.
pub type Filters = Vec<[[f32; TAPS]; 2]>;

/// The measured (and filled) directions: AmbiX azimuth and elevation in degrees, and the grid entry
/// (raw azimuth, elevation index) whose responses stand for it.
pub fn design_directions() -> Vec<(f64, f64, usize, usize)> {
    let mut v = Vec::new();
    for a in 0..NUMBER_OF_RAW_AZIMUTHS {
        for e in 0..NUMBER_OF_RAW_ELEVATIONS {
            let el = -45 + 15 * e as i32;
            if el <= MAX_ELEVATIONS[a] {
                // The database's azimuth is AmbiX's (positive to the left): the panner looks it up
                // with the engine azimuth negated.
                v.push((a as f64 * 15.0, el as f64, a, e));
            }
        }
        for el in [-60.0, -75.0] {
            v.push((a as f64 * 15.0, el, a, 0));
        }
    }
    v.push((0.0, -90.0, 0, 0));
    v
}

/// The packed `FFT`-point spectrum of `ir` (≤ `TAPS` taps) delayed by `delay` frames.
pub fn delayed_spectrum(ir: &[f32], delay: f64, tw: &Twiddles) -> Vec<Complex32> {
    let mut buf = [0.0f32; FFT];
    buf[..ir.len()].copy_from_slice(ir);
    let mut work = [ZERO; BINS];
    let mut s = rfft(&mut buf, &mut work, tw).to_vec();
    for (b, x) in s.iter_mut().enumerate().skip(1) {
        let a = -2.0 * core::f64::consts::PI * b as f64 * delay / FFT as f64;
        let (c, sn) = (libm::cos(a), libm::sin(a));
        let (re, im) = (x.re as f64, x.im as f64);
        *x = Complex32 { re: (re * c - im * sn) as f32, im: (re * sn + im * c) as f32 };
    }
    // Nyquist (packed in bin 0's `im`) turns by π·delay; DC doesn't.
    s[0].im = (s[0].im as f64 * libm::cos(core::f64::consts::PI * delay)) as f32;
    s
}

/// The HRTF panner's response at grid entry (`raw_azimuth`, `elevation`) for `ear`, with its delay.
pub fn grid_spectrum(db: &HrirDatabase<'_>, scratch: &mut HrtfScratch, tw: &Twiddles, raw_azimuth: usize, elevation: usize, ear: Ear) -> Vec<Complex32> {
    let rate = db.header().rate;
    let mut ir = [0.0f32; TAPS];
    let n = kernel_time_response(db, rate, raw_azimuth * 8, elevation, ear, scratch, &mut ir);
    assert_eq!(n, TAPS, "the HRIR asset's rate gives {n} taps, the design wants {TAPS}");
    let delay = kernel_frame_delay(db, raw_azimuth * 8, elevation, ear) as f64;
    delayed_spectrum(&ir, delay, tw)
}

/// Designs the 16 filter pairs from the `format = 2` table `db` (at the asset's rate).
pub fn design(db: &HrirDatabase<'_>) -> Filters {
    let rate = db.header().rate;
    assert_eq!(fft_size_for_sample_rate(rate), FFT, "the design runs at 44.1 or 48 kHz");
    let tw = Twiddles::new();
    let mut scratch = HrtfScratch::new();
    let dirs = design_directions();
    let ys: Vec<[f64; CHANNELS]> = dirs.iter().map(|&(az, el, _, _)| sh16_at(az.to_radians(), el.to_radians())).collect();
    let mut v: Vec<f64> = dirs.iter().map(|&(_, el, _, _)| libm::cos(el.to_radians()).max(0.1)).collect();
    let sum: f64 = v.iter().sum();
    for w in v.iter_mut() {
        *w /= sum;
    }
    let p = projector(&ys, &v, RIDGE);
    let cut = libm::round(MAGLS_CUTOFF_HZ / (rate as f64 / FFT as f64)) as usize;
    let mut filters: Filters = vec![[[0.0; TAPS]; 2]; CHANNELS];
    for (ear_i, ear) in [Ear::Left, Ear::Right].into_iter().enumerate() {
        let specs: Vec<Vec<Complex32>> = dirs.iter().map(|&(_, _, a, e)| grid_spectrum(db, &mut scratch, &tw, a, e, ear)).collect();
        // h[c][b] as (re, im) in f64.
        let mut h = vec![[(0.0f64, 0.0f64); BINS]; CHANNELS];
        let fit = |t: &dyn Fn(usize) -> (f64, f64)| -> [(f64, f64); CHANNELS] {
            let mut out = [(0.0, 0.0); CHANNELS];
            for (i, pi) in p.iter().enumerate() {
                let (tr, ti) = t(i);
                for c in 0..CHANNELS {
                    out[c].0 += pi[c] * tr;
                    out[c].1 += pi[c] * ti;
                }
            }
            out
        };
        for b in 0..BINS {
            let ls = fit(&|i| (specs[i][b].re as f64, specs[i][b].im as f64));
            // Bin 0 packs two real values (DC, Nyquist): plain least squares for both.
            let solved = if b == 0 || b < cut {
                ls
            } else {
                let mag: Vec<f64> = specs.iter().map(|s| libm::hypot(s[b].re as f64, s[b].im as f64)).collect();
                let mut cur = ls;
                let mut target = vec![(0.0f64, 0.0f64); dirs.len()];
                for _ in 0..MAGLS_ITERATIONS {
                    for (i, y) in ys.iter().enumerate() {
                        let (mut fr, mut fi) = (0.0, 0.0);
                        for c in 0..CHANNELS {
                            fr += y[c] * cur[c].0;
                            fi += y[c] * cur[c].1;
                        }
                        let m = libm::hypot(fr, fi);
                        target[i] = if m > 1e-12 { (mag[i] * fr / m, mag[i] * fi / m) } else { (mag[i], 0.0) };
                    }
                    cur = fit(&|i| target[i]);
                }
                cur
            };
            for c in 0..CHANNELS {
                h[c][b] = solved[c];
            }
        }
        for c in 0..CHANNELS {
            let spec: Vec<Complex32> = h[c].iter().map(|&(re, im)| Complex32 { re: re as f32, im: im as f32 }).collect();
            let mut t = [0.0f32; FFT];
            let mut work = [ZERO; BINS];
            irfft(&spec, &mut t, &mut work, &tw);
            for i in 0..FADE {
                let w = 0.5 + 0.5 * libm::cos(core::f64::consts::PI * (i as f64 + 0.5) / FADE as f64);
                t[TAPS - FADE + i] = (t[TAPS - FADE + i] as f64 * w) as f32;
            }
            filters[c][ear_i].copy_from_slice(&t[..TAPS]);
        }
    }
    filters
}

/// The asset bytes: the 32-byte `MaglsHeader` then f32 `[16][2][TAPS]`, little-endian.
pub fn asset_bytes(filters: &Filters, rate: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + CHANNELS * 2 * TAPS * 4);
    for word in [0x4442_594Du32, 1, 3, TAPS as u32, rate.to_bits(), 0, 0, 0] {
        out.extend_from_slice(&word.to_le_bytes());
    }
    for pair in filters {
        for ear in pair {
            for s in ear {
                out.extend_from_slice(&s.to_le_bytes());
            }
        }
    }
    out
}
