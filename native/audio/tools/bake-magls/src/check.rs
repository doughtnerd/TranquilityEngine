//! The bake check of api-and-models §9: the order-3 decode of a source through the MagLS filters
//! against M1's per-voice HRTF at the same direction. The spike measured white noise through both
//! paths; for a still source both are linear filters, so this compares their transfer functions
//! exactly (no noise), on a fine frequency grid:
//!
//! - **Cues right at 12 of 12 azimuths** (elevation 0, every 30°): to the side (20° < |az| < 160°)
//!   the right ear is louder at 2-4 kHz and earlier (|ITD| > 150 µs) for a source on the right, and
//!   the mirror on the left; in front and behind |ILD| < 3 dB and |ITD| < 120 µs.
//! - **ILD within 1.7 dB below 2 kHz**: the interaural level difference (right minus left) of each
//!   octave band from 200 Hz to 2 kHz within 1.7 dB of M1's, over 48 directions (elevations 0, 30,
//!   -30 and 60 at the 12 azimuths).
//!
//! ITD is the group delay of the interaural cross spectrum from 200 to 1,200 Hz (as the spike).

use audio_dsp::hrtf::database::HrirDatabase;
use audio_dsp::hrtf::elevation_index::{calculate_desired_azimuth_index_and_blend, index_from_elevation_angle};
use audio_dsp::hrtf::kernel::{kernel_frame_delay, kernel_time_response};
use audio_dsp::hrtf::{Ear, HrtfScratch};

use crate::magls::{Filters, TAPS};
use crate::sh::{from_engine, sh16, CHANNELS};

pub const BANDS: [(f64, f64); 6] = [(200.0, 500.0), (500.0, 1000.0), (1000.0, 2000.0), (2000.0, 4000.0), (4000.0, 8000.0), (8000.0, 16000.0)];
/// Bands whose ILD the acceptance bounds (below 2 kHz).
const LOW_BANDS: usize = 3;
pub const ILD_LIMIT_DB: f64 = 1.7;
const AZIMUTHS: [f64; 12] = [0.0, 30.0, 60.0, 90.0, 120.0, 150.0, 180.0, -150.0, -120.0, -90.0, -60.0, -30.0];
const ELEVATIONS: [f64; 4] = [0.0, 30.0, -30.0, 60.0];
/// Frequency step of the analysis grid.
const DF: f64 = 5.0;

/// A transfer function on the analysis grid: `(re, im)` per frequency `k * DF`.
type Tf = Vec<(f64, f64)>;

fn dft(ir: &[f64], delay: f64, rate: f64) -> Tf {
    let n = (16_000.0 / DF) as usize;
    (0..=n)
        .map(|k| {
            let w = 2.0 * core::f64::consts::PI * k as f64 * DF / rate;
            let (mut re, mut im) = (0.0, 0.0);
            for (t, &x) in ir.iter().enumerate() {
                let a = -w * (t as f64 + delay);
                re += x * libm::cos(a);
                im += x * libm::sin(a);
            }
            (re, im)
        })
        .collect()
}

struct Cues {
    /// dB per ear per band.
    level: [[f64; 6]; 2],
    itd_us: f64,
}

fn cues(l: &Tf, r: &Tf) -> Cues {
    let mut level = [[0.0; 6]; 2];
    for (bi, &(lo, hi)) in BANDS.iter().enumerate() {
        let (mut sl, mut sr) = (0.0, 0.0);
        for k in 0..l.len() {
            let f = k as f64 * DF;
            if f >= lo && f < hi {
                sl += l[k].0 * l[k].0 + l[k].1 * l[k].1;
                sr += r[k].0 * r[k].0 + r[k].1 * r[k].1;
            }
        }
        level[0][bi] = 10.0 * libm::log10(sl.max(1e-30));
        level[1][bi] = 10.0 * libm::log10(sr.max(1e-30));
    }
    // Cross spectrum conj(L) R; its phase slope.
    let cross: Vec<(f64, f64)> = l.iter().zip(r).map(|(a, b)| (a.0 * b.0 + a.1 * b.1, a.0 * b.1 - a.1 * b.0)).collect();
    let (mut sr, mut si) = (0.0, 0.0);
    for k in 1..cross.len() {
        let f = k as f64 * DF;
        if f > 200.0 && f < 1200.0 {
            let (a, b) = cross[k];
            let (c, d) = cross[k - 1];
            sr += a * c + b * d;
            si += b * c - a * d;
        }
    }
    let itd_us = -libm::atan2(si, sr) / (2.0 * core::f64::consts::PI * DF) * 1e6;
    Cues { level, itd_us }
}

/// M1's HRTF at engine azimuth `az` (positive right) and elevation `el`, as the panner selects it.
fn m1(db: &HrirDatabase<'_>, scratch: &mut HrtfScratch, az: f64, el: f64) -> (Tf, Tf) {
    let rate = db.header().rate;
    let (ai, blend) = calculate_desired_azimuth_index_and_blend(-az);
    assert!(blend.abs() < 1e-9, "the check's directions are on the grid");
    let ei = index_from_elevation_angle(el);
    let mut out = Vec::new();
    for ear in [Ear::Left, Ear::Right] {
        let mut ir = [0.0f32; TAPS];
        kernel_time_response(db, rate, ai, ei, ear, scratch, &mut ir);
        let ir: Vec<f64> = ir.iter().map(|&x| x as f64).collect();
        out.push(dft(&ir, kernel_frame_delay(db, ai, ei, ear) as f64, rate as f64));
    }
    let r = out.pop().unwrap();
    (out.pop().unwrap(), r)
}

/// The bed decode of a source at engine (`az`, `el`) through `filters`.
fn bed(filters: &Filters, az: f64, el: f64, rate: f64) -> (Tf, Tf) {
    let (a, e) = (az.to_radians(), el.to_radians());
    let engine = [libm::cos(e) * libm::sin(a), libm::sin(e), -libm::cos(e) * libm::cos(a)];
    let d = from_engine(engine);
    let y = sh16(d[0], d[1], d[2]);
    let mut out = Vec::new();
    for ear in 0..2 {
        let mut ir = vec![0.0f64; TAPS];
        for c in 0..CHANNELS {
            for (t, s) in ir.iter_mut().enumerate() {
                *s += y[c] * filters[c][ear][t] as f64;
            }
        }
        out.push(dft(&ir, 0.0, rate));
    }
    let r = out.pop().unwrap();
    (out.pop().unwrap(), r)
}

pub struct Report {
    pub azimuths_right: usize,
    pub azimuths_total: usize,
    /// Max |dILD| per band over the 48 directions.
    pub ild_max: [f64; 6],
    pub ild_mean: [f64; 6],
    /// Max |ΔITD| at elevation 0 and over all directions, µs.
    pub itd_max0: f64,
    pub itd_max: f64,
    pub lines: Vec<String>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.azimuths_right == self.azimuths_total && self.ild_max[..LOW_BANDS].iter().all(|&d| d <= ILD_LIMIT_DB)
    }
}

pub fn run(db: &HrirDatabase<'_>, filters: &Filters) -> Report {
    let rate = db.header().rate as f64;
    let mut scratch = HrtfScratch::new();
    let mut rep = Report { azimuths_right: 0, azimuths_total: 0, ild_max: [0.0; 6], ild_mean: [0.0; 6], itd_max0: 0.0, itd_max: 0.0, lines: Vec::new() };
    let mut n = 0.0;
    for &el in &ELEVATIONS {
        for &az in &AZIMUTHS {
            let (bl, br) = bed(filters, az, el, rate);
            let (ml, mr) = m1(db, &mut scratch, az, el);
            let b = cues(&bl, &br);
            let m = cues(&ml, &mr);
            n += 1.0;
            for k in 0..6 {
                let d = ((b.level[1][k] - b.level[0][k]) - (m.level[1][k] - m.level[0][k])).abs();
                rep.ild_max[k] = rep.ild_max[k].max(d);
                rep.ild_mean[k] += d;
            }
            let di = (b.itd_us - m.itd_us).abs();
            rep.itd_max = rep.itd_max.max(di);
            if el == 0.0 {
                rep.itd_max0 = rep.itd_max0.max(di);
                rep.azimuths_total += 1;
                let ild = b.level[1][3] - b.level[0][3];
                let ok = if az.abs() > 20.0 && az.abs() < 160.0 {
                    let right = az > 0.0;
                    (ild > 0.0) == right && (b.itd_us < 0.0) == right && b.itd_us.abs() > 150.0
                } else {
                    ild.abs() < 3.0 && b.itd_us.abs() < 120.0
                };
                if ok {
                    rep.azimuths_right += 1;
                }
                rep.lines.push(format!(
                    "  az {az:>5}: ILD 2-4 kHz {:+5.1} dB (M1 {:+5.1}), ITD {:+5.0} us (M1 {:+5.0}) {}",
                    ild,
                    m.level[1][3] - m.level[0][3],
                    b.itd_us,
                    m.itd_us,
                    if ok { "ok" } else { "WRONG" }
                ));
            }
        }
    }
    for v in rep.ild_mean.iter_mut() {
        *v /= n;
    }
    rep
}
