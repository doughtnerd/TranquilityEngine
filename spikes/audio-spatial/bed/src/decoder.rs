//! Binaural decode of the 16-channel bed through M1's HRIR set and the same 256-point real FFT
//! (`audio_dsp::hrtf::fft`, microfft underneath), uniform 128-frame partitions like the HRTF panner.
//!
//! Three filter sets, one convolver:
//! * `Speakers`: Lebedev-26 virtual loudspeakers. A 16x26 gain matrix gives 26 feeds; each feed is
//!   convolved with the HRIR pair (ITD re-inserted) of its direction (26 FFTs, 26x2 filters).
//! * `ShQuad`: the same decode folded into 16 filter pairs (16 FFTs): H_c = (2l+1) sum_k w_k Y_c(d_k) H_k.
//! * `ShMagLs`: `ShLs` below 1.5 kHz; above it the phase of each bin is iterated so the fit matches
//!   the measured magnitudes (Schoerkhuber et al., MagLS), which restores the high-frequency level.
//! * `ShLs`: 16 filter pairs fitted by weighted, ridge-regularised least squares over the whole
//!   measured grid (plus filled rows below the data, see README).
use audio_dsp::hrtf::database::HrirDatabase;
use audio_dsp::hrtf::elevation_index::{calculate_desired_azimuth_index_and_blend, index_from_elevation_angle, MAX_ELEVATIONS};
use audio_dsp::hrtf::fft::{irfft, rfft, Twiddles};
use audio_dsp::hrtf::kernel::{kernel_frame_delay, kernel_time_response};
use audio_dsp::hrtf::{lerp_f64, Ear, HrtfScratch};
use microfft::Complex32;

use crate::sh::*;

pub const BINS: usize = 128;
pub const TAPS: usize = 256;
pub const PARTS: usize = TAPS / Q;
const ZERO: Complex32 = Complex32 { re: 0.0, im: 0.0 };

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Speakers,
    ShQuad,
    ShLs,
    /// LS below 1.5 kHz, magnitude-LS (phase iterated) above, on the same data as `ShLs`.
    ShMagLs,
}

/// Fixed filters: `h[ear][(input * PARTS + part) * BINS + bin]`.
#[derive(Clone)]
pub struct Filters {
    pub n_in: usize,
    pub h: [Vec<Complex32>; 2],
    /// Speaker mode only: the 16 -> K gain matrix, `gains[k][c]`.
    pub gains: Vec<[f32; 16]>,
    /// Fraction of filter energy beyond 256 taps before truncation (worst filter).
    pub truncated_energy: f64,
}

impl Filters {
    /// From the flat f32 dump `dumpfilters` writes (h[0] then h[1], re/im interleaved).
    pub fn from_raw(n_in: usize, raw: &[f32]) -> Filters {
        let n = n_in * PARTS * BINS;
        let conv = |s: &[f32]| s.chunks_exact(2).map(|c| Complex32 { re: c[0], im: c[1] }).collect::<Vec<_>>();
        Filters { n_in, h: [conv(&raw[..2 * n]), conv(&raw[2 * n..4 * n])], gains: vec![], truncated_energy: 0.0 }
    }
    pub fn bytes(&self) -> usize {
        (self.h[0].len() + self.h[1].len()) * 8 + self.gains.len() * 64
    }
}

/// A 512-point spectrum (256 packed bins) of one direction/ear with the ITD re-inserted.
type Spec = Vec<Complex32>;

fn delayed_spectrum(ir: &[f32], delay: f64, tw: &Twiddles, work: &mut [Complex32]) -> Spec {
    let mut buf = [0.0f32; 512];
    buf[..ir.len()].copy_from_slice(ir);
    let mut s = rfft(&mut buf, work, tw).to_vec();
    for b in 1..256 {
        let a = -2.0 * std::f64::consts::PI * b as f64 * delay / 512.0;
        let (c, sn) = (a.cos() as f32, a.sin() as f32);
        let x = s[b];
        s[b] = Complex32 { re: x.re * c - x.im * sn, im: x.re * sn + x.im * c };
    }
    s[0].im *= (std::f64::consts::PI * delay).cos() as f32;
    s
}

/// Speaker (or any) direction, AmbiX, to the HRTF spectrum exactly as M1's panner selects it
/// (azimuth index from -azimuth, elevation index, azimuth blend on the delay).
fn spectrum_at(db: &HrirDatabase, sc: &mut HrtfScratch, tw: &Twiddles, work: &mut [Complex32], dir_ambix: [f32; 3], ear: Ear) -> Spec {
    let (az, el) = audio_dsp::hrtf::angles::azimuth_elevation(to_engine(dir_ambix));
    let (ai, blend) = calculate_desired_azimuth_index_and_blend(-az);
    let ei = index_from_elevation_angle(el);
    let mut ir = [0.0f32; 256];
    kernel_time_response(db, hrir_rate(db), ai, ei, ear, sc, &mut ir);
    let d0 = kernel_frame_delay(db, ai, ei, ear) as f64;
    let d1 = kernel_frame_delay(db, (ai + 1) % 192, ei, ear) as f64;
    delayed_spectrum(&ir, lerp_f64(d0, d1, blend), tw, work)
}

fn hrir_rate(db: &HrirDatabase) -> f32 {
    db.header().rate
}

/// Spectrum of a raw database direction (azimuth index `a` 0..24, elevation row `e` 0..10).
fn raw_spectrum(db: &HrirDatabase, sc: &mut HrtfScratch, tw: &Twiddles, work: &mut [Complex32], a: usize, e: usize, ear: Ear) -> Spec {
    let mut ir = [0.0f32; 256];
    kernel_time_response(db, hrir_rate(db), a * 8, e, ear, sc, &mut ir);
    let d = kernel_frame_delay(db, a * 8, e, ear) as f64;
    delayed_spectrum(&ir, d, tw, work)
}

/// Time-domain filter from a 512-point packed spectrum, truncated to 256 taps with a 16-tap
/// half-Hann fade; returns (partition spectra, truncated energy fraction).
fn to_partitions(spec: &[Complex32], tw: &Twiddles, work: &mut [Complex32]) -> ([[Complex32; BINS]; PARTS], f64) {
    let mut t = [0.0f32; 512];
    irfft(spec, &mut t, work, tw);
    let total: f64 = t.iter().map(|v| (*v as f64).powi(2)).sum();
    let tail: f64 = t[TAPS..].iter().map(|v| (*v as f64).powi(2)).sum();
    for i in 0..16 {
        let w = 0.5 + 0.5 * (std::f32::consts::PI * (i as f32 + 0.5) / 16.0).cos();
        t[TAPS - 16 + i] *= w;
    }
    let mut out = [[ZERO; BINS]; PARTS];
    for p in 0..PARTS {
        let mut blk = [0.0f32; 256];
        blk[..Q].copy_from_slice(&t[p * Q..(p + 1) * Q]);
        out[p].copy_from_slice(rfft(&mut blk, work, tw));
    }
    (out, if total > 0.0 { tail / total } else { 0.0 })
}

pub fn build_filters(db: &HrirDatabase, kind: Kind) -> Filters {
    let tw = Twiddles::new();
    let mut work = vec![ZERO; 512];
    let mut sc = HrtfScratch::new();
    let leb = lebedev26();
    let ears = [Ear::Left, Ear::Right];
    // Per-ear combination weights into inputs: coef[input] = list of (spectrum index, weight).
    let mut ys: Vec<[f64; 16]> = vec![];
    let (n_in, specs, coefs, gains): (usize, [Vec<Spec>; 2], Vec<Vec<f64>>, Vec<[f32; 16]>) = match kind {
        Kind::Speakers | Kind::ShQuad => {
            let mut specs: [Vec<Spec>; 2] = [vec![], vec![]];
            for (k, _) in leb.iter().enumerate() {
                let d = [leb[k].0[0] as f32, leb[k].0[1] as f32, leb[k].0[2] as f32];
                for e in 0..2 {
                    specs[e].push(spectrum_at(db, &mut sc, &tw, &mut work, d, ears[e]));
                }
            }
            if kind == Kind::Speakers {
                let mut coefs = vec![vec![0.0; leb.len()]; leb.len()];
                let mut gains = vec![[0.0f32; 16]; leb.len()];
                for k in 0..leb.len() {
                    coefs[k][k] = leb[k].1;
                    let y = sh16_f64(leb[k].0[0], leb[k].0[1], leb[k].0[2]);
                    for c in 0..16 {
                        gains[k][c] = ((2 * order_of(c) + 1) as f64 * y[c]) as f32;
                    }
                }
                (leb.len(), specs, coefs, gains)
            } else {
                let mut coefs = vec![vec![0.0; leb.len()]; 16];
                for c in 0..16 {
                    for k in 0..leb.len() {
                        let y = sh16_f64(leb[k].0[0], leb[k].0[1], leb[k].0[2]);
                        coefs[c][k] = (2 * order_of(c) + 1) as f64 * leb[k].1 * y[c];
                    }
                }
                (16, specs, coefs, vec![])
            }
        }
        Kind::ShLs | Kind::ShMagLs => {
            // Measured directions: every unique (azimuth, elevation) row, then filled rows below.
            let mut dirs: Vec<[f64; 3]> = vec![];
            let mut specs: [Vec<Spec>; 2] = [vec![], vec![]];
            let add = |a: usize, e: usize, el_deg: f64, dirs: &mut Vec<[f64; 3]>, specs: &mut [Vec<Spec>; 2], sc: &mut HrtfScratch, work: &mut Vec<Complex32>| {
                let th = (a as f64 * 15.0).to_radians(); // database azimuth == AmbiX azimuth (left positive)
                let el = el_deg.to_radians();
                dirs.push([el.cos() * th.cos(), el.cos() * th.sin(), el.sin()]);
                for ei in 0..2 {
                    specs[ei].push(raw_spectrum(db, sc, &tw, work, a, e, ears[ei]));
                }
            };
            for a in 0..24 {
                for e in 0..10 {
                    let el = -45 + 15 * e as i32;
                    if el <= MAX_ELEVATIONS[a] {
                        add(a, e, el as f64, &mut dirs, &mut specs, &mut sc, &mut work);
                    }
                }
                // No data below -45 degrees: the -45 response stands in at -60 and -75.
                for el in [-60.0, -75.0] {
                    add(a, 0, el, &mut dirs, &mut specs, &mut sc, &mut work);
                }
            }
            add(0, 0, -90.0, &mut dirs, &mut specs, &mut sc, &mut work);
            let j = dirs.len();
            // Weighted ridge LS: P = (Y^T V Y + lambda I)^-1 Y^T V, V ~ cos(el) (floored at the poles).
            let mut y = vec![[0.0f64; 16]; j];
            let mut v = vec![0.0f64; j];
            for (i, d) in dirs.iter().enumerate() {
                y[i] = sh16_f64(d[0], d[1], d[2]);
                v[i] = (1.0 - d[2] * d[2]).sqrt().max(0.1);
            }
            let vs: f64 = v.iter().sum();
            for x in v.iter_mut() {
                *x /= vs;
            }
            let mut g = [[0.0f64; 16]; 16];
            for a in 0..16 { for b in 0..16 { for i in 0..j { g[a][b] += y[i][a] * v[i] * y[i][b]; } } }
            let lam = 0.01 * (0..16).map(|i| g[i][i]).sum::<f64>() / 16.0;
            for i in 0..16 { g[i][i] += lam; }
            let mut inv = [[0.0f64; 16]; 16];
            for i in 0..16 { inv[i][i] = 1.0; }
            for c in 0..16 {
                let mut piv = c;
                for r in c..16 { if g[r][c].abs() > g[piv][c].abs() { piv = r; } }
                g.swap(c, piv);
                inv.swap(c, piv);
                let d = g[c][c];
                for q in 0..16 { g[c][q] /= d; inv[c][q] /= d; }
                for r in 0..16 { if r != c { let f = g[r][c]; for q in 0..16 { g[r][q] -= f * g[c][q]; inv[r][q] -= f * inv[c][q]; } } }
            }
            let mut coefs = vec![vec![0.0f64; j]; 16];
            for c in 0..16 { for i in 0..j { for b in 0..16 { coefs[c][i] += inv[c][b] * y[i][b] * v[i]; } } }
            ys = y;
            (16, specs, coefs, vec![])
        }
    };
    let mut h = [vec![ZERO; n_in * PARTS * BINS], vec![ZERO; n_in * PARTS * BINS]];
    let mut worst = 0.0f64;
    for e in 0..2 {
        for inp in 0..n_in {
            let mut acc = vec![ZERO; 256];
            for (k, w) in coefs[inp].iter().enumerate() {
                if *w == 0.0 { continue; }
                let w = *w as f32;
                for (a, s) in acc.iter_mut().zip(&specs[e][k]) {
                    a.re += w * s.re;
                    a.im += w * s.im;
                }
            }
            if kind == Kind::ShMagLs {
                acc = magls_input(&specs[e], &coefs, &ys, inp);
            }
            let (parts, lost) = to_partitions(&acc, &tw, &mut work);
            worst = worst.max(lost);
            for p in 0..PARTS {
                h[e][(inp * PARTS + p) * BINS..(inp * PARTS + p + 1) * BINS].copy_from_slice(&parts[p]);
            }
        }
    }
    Filters { n_in, h, gains, truncated_energy: worst }
}

const MAGLS_CUT_BIN: usize = 16; // 1.5 kHz of a 512-point spectrum at 48 kHz
const MAGLS_ITERS: usize = 10;

/// MagLS fit of one SH input (`inp`) over all bins; recomputes all 16 per bin (cheap, init only).
fn magls_input(specs: &[Spec], coefs: &[Vec<f64>], ys: &[[f64; 16]], inp: usize) -> Spec {
    let j = specs.len();
    let mut out = vec![ZERO; 256];
    // Below the cutoff and the packed DC/Nyquist bin: plain LS.
    for b in 0..256 {
        let ls = |c: usize, re: bool| -> f64 { (0..j).map(|i| coefs[c][i] * if re { specs[i][b].re as f64 } else { specs[i][b].im as f64 }).sum() };
        if b < MAGLS_CUT_BIN {
            out[b] = Complex32 { re: ls(inp, true) as f32, im: ls(inp, false) as f32 };
            continue;
        }
        let mag: Vec<f64> = (0..j).map(|i| ((specs[i][b].re as f64).powi(2) + (specs[i][b].im as f64).powi(2)).sqrt()).collect();
        let mut hr: Vec<f64> = (0..16).map(|c| ls(c, true)).collect();
        let mut hi: Vec<f64> = (0..16).map(|c| ls(c, false)).collect();
        for _ in 0..MAGLS_ITERS {
            let mut tr = vec![0.0f64; j];
            let mut ti = vec![0.0f64; j];
            for i in 0..j {
                let (mut fr, mut fi) = (0.0, 0.0);
                for c in 0..16 { fr += ys[i][c] * hr[c]; fi += ys[i][c] * hi[c]; }
                let m = (fr * fr + fi * fi).sqrt();
                let (pr, pi) = if m > 1e-12 { (fr / m, fi / m) } else { (1.0, 0.0) };
                tr[i] = mag[i] * pr;
                ti[i] = mag[i] * pi;
            }
            for c in 0..16 {
                hr[c] = (0..j).map(|i| coefs[c][i] * tr[i]).sum();
                hi[c] = (0..j).map(|i| coefs[c][i] * ti[i]).sum();
            }
        }
        out[b] = Complex32 { re: hr[inp] as f32, im: hi[inp] as f32 };
    }
    out
}

/// The convolver state over a filter set.
pub struct Decoder {
    pub f: Filters,
    hist: Vec<Complex32>, // [input][ring part][bin]
    prev: Vec<f32>,       // [input][Q]
    newest: usize,
    tw: Twiddles,
    work: Vec<Complex32>,
    feeds: Vec<[f32; Q]>,
}

impl Decoder {
    pub fn new(f: Filters) -> Self {
        let n = f.n_in;
        Decoder { f, hist: vec![ZERO; n * PARTS * BINS], prev: vec![0.0; n * Q], newest: 0, tw: Twiddles::new(), work: vec![ZERO; 256], feeds: vec![[0.0; Q]; n] }
    }
    pub fn reset(&mut self) {
        self.hist.fill(ZERO);
        self.prev.fill(0.0);
        self.newest = 0;
    }
    pub fn is_speakers(&self) -> bool {
        !self.f.gains.is_empty()
    }

    /// Decodes the first `n_active` bed channels (the rest are silent) to `out_l`, `out_r`.
    pub fn process(&mut self, bed: &crate::encoder::Bed, n_active: usize, out_l: &mut [f32; Q], out_r: &mut [f32; Q]) {
        let n_in;
        if self.is_speakers() {
            n_in = self.f.n_in;
            for k in 0..n_in {
                let g = &self.f.gains[k];
                let o = &mut self.feeds[k];
                o.fill(0.0);
                for c in 0..n_active {
                    let gc = g[c];
                    let b = &bed.ch[c];
                    for i in 0..Q {
                        o[i] += gc * b[i];
                    }
                }
            }
        } else {
            n_in = n_active.min(self.f.n_in);
        }
        self.newest = (self.newest + 1) % PARTS;
        let newest = self.newest;
        for ch in 0..n_in {
            let cur: &[f32; Q] = if self.is_speakers() { &self.feeds[ch] } else { &bed.ch[ch] };
            let mut buf = [0.0f32; 256];
            buf[..Q].copy_from_slice(&self.prev[ch * Q..(ch + 1) * Q]);
            buf[Q..].copy_from_slice(cur);
            self.prev[ch * Q..(ch + 1) * Q].copy_from_slice(cur);
            let spec = rfft(&mut buf, &mut self.work, &self.tw);
            let at = (ch * PARTS + newest) * BINS;
            self.hist[at..at + BINS].copy_from_slice(spec);
        }
        let mut acc_l = [ZERO; BINS];
        let mut acc_r = [ZERO; BINS];
        for ch in 0..n_in {
            for p in 0..PARTS {
                let x = &self.hist[(ch * PARTS + (newest + PARTS - p) % PARTS) * BINS..][..BINS];
                let hl = &self.f.h[0][(ch * PARTS + p) * BINS..][..BINS];
                let hr = &self.f.h[1][(ch * PARTS + p) * BINS..][..BINS];
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
        let mut t = [0.0f32; 256];
        irfft(&acc_l, &mut t, &mut self.work, &self.tw);
        out_l.copy_from_slice(&t[Q..]);
        irfft(&acc_r, &mut t, &mut self.work, &self.tw);
        out_r.copy_from_slice(&t[Q..]);
    }
}
