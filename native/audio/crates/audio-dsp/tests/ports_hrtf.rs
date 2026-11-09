// SPDX-License-Identifier: Apache-2.0 OR MIT
//! H1 acceptance (api-and-models §5, the `hrtf` port row; task H1-L3): the HRTF port matches
//! Chromium's formulas on fixed azimuth/elevation sweeps, to float rounding.
//!
//! The references here are independent of the port: kernels from Chromium's formulas in f64 with a
//! naive DFT, the delay line from `Delay::ProcessKRate`, and a direct (time-domain) convolution.
//! They read a synthetic `format = 2` table built in this file (the real Composite data is H2's).
//! Two documented differences from Chromium are part of the reference: no convolver latency, and
//! a kernel set that starts convolving filters the full input history.
//!
//! The reference re-derives its own indices, FFT size and kernels. It uses the port only for the
//! `lerp` helpers and for the table layout's constants written out here. The comparison tests
//! call the port and are ignored until the H1 core lands.

#![allow(dead_code)]

use std::f64::consts::PI;

use audio_dsp::hrtf::database::{encode, HrirDatabase, HrirHeader};
use audio_dsp::hrtf::kernel::{kernel_frame_delay, kernel_time_response, HrtfScratch};
use audio_dsp::hrtf::panner::HrtfPanner;
use audio_dsp::hrtf::{lerp_f32, lerp_f64, Ear};

/// Comparison tolerance, relative to the reference's peak magnitude (at least 1.0).
const TOL: f64 = 2e-5;

/// Frames per render quantum (and per partition).
const QUANTUM: usize = 128;
/// Raw azimuths, 15 degrees apart.
const RAW_AZIMUTHS: usize = 24;
/// Elevations, -45 to +90 degrees in 15-degree steps.
const ELEVATIONS: usize = 10;
const DIRECTIONS: usize = RAW_AZIMUTHS * ELEVATIONS;
/// Interpolated azimuths: 24 raw x 8.
const TOTAL_AZIMUTHS: usize = 192;

/// Upstream `kMaxElevations` (hrtf_kernel.cc), by raw azimuth index.
const MAX_ELEVATION: [i32; RAW_AZIMUTHS] = [
    90, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45, 75, 45, 60, 45,
];

/// Deterministic xorshift32 PRNG.
struct XorShift32(u32);

impl XorShift32 {
    fn new(seed: u32) -> Self {
        XorShift32(if seed == 0 { 0x9E37_79B9 } else { seed })
    }
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    fn unit(&mut self) -> f64 {
        self.next_u32() as f64 / 4_294_967_296.0
    }
    /// Uniform in [-1, 1).
    fn bipolar(&mut self) -> f64 {
        2.0 * self.unit() - 1.0
    }
}

/// A synthetic table: the encoded bytes plus the values that went in.
struct SyntheticDb {
    bytes: Vec<u8>,
    rate: f32,
    ir_length: usize,
    /// `d * 2 + ear`, frames.
    delays: Vec<f32>,
    /// Direction-major, interleaved (left, right): index `(d * ir_length + frame) * 2 + ear`.
    irs: Vec<i16>,
}

impl SyntheticDb {
    /// Ear delay of the table entry (raw azimuth, elevation index, ear).
    fn delay(&self, raw: usize, e: usize, ear: usize) -> f32 {
        self.delays[(raw * ELEVATIONS + e) * 2 + ear]
    }

    /// Response sample `s / 32768` as f32.
    fn sample(&self, raw: usize, e: usize, ear: usize, frame: usize) -> f32 {
        let s = self.irs[((raw * ELEVATIONS + e) * self.ir_length + frame) * 2 + ear];
        s as f32 / 32768.0
    }
}

/// Writes a `format = 2` blob from the layout in `database.rs`'s module doc, independently of
/// `database::encode`.
fn own_encode(rate: f32, ir_length: usize, delays: &[f32], irs: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 4 * delays.len() + 2 * irs.len());
    out.extend_from_slice(&(ELEVATIONS as u32).to_le_bytes());
    out.extend_from_slice(&(RAW_AZIMUTHS as u32).to_le_bytes());
    out.extend_from_slice(&(ir_length as u32).to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    for d in delays {
        out.extend_from_slice(&d.to_le_bytes());
    }
    for s in irs {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Builds a deterministic synthetic table at `rate` with `ir_length`-frame responses:
/// noise x exp(-n/40) x 0.4 quantised to i16, and delays uniform in 0..30 frames.
fn synthetic_db(rate: f32, ir_length: usize, seed: u32) -> SyntheticDb {
    let mut rng = XorShift32::new(seed);
    let delays: Vec<f32> = (0..DIRECTIONS * 2).map(|_| (30.0 * rng.unit()) as f32).collect();
    let mut irs = vec![0i16; DIRECTIONS * ir_length * 2];
    for (i, slot) in irs.iter_mut().enumerate() {
        let frame = (i / 2) % ir_length;
        let v = rng.bipolar() * (-(frame as f64) / 40.0).exp() * 0.4;
        *slot = (v * 32767.0).round() as i16;
    }
    let bytes = own_encode(rate, ir_length, &delays, &irs);
    SyntheticDb { bytes, rate, ir_length, delays, irs }
}

fn noise(quanta: usize, seed: u32) -> Vec<f32> {
    let mut rng = XorShift32::new(seed);
    (0..quanta * QUANTUM).map(|_| (0.5 * rng.bipolar()) as f32).collect()
}

// ---------------------------------------------------------------------------------------------
// Reference model. Everything below is written from Chromium's formulas (cbba46fd); none of it
// calls the port's kernel, panner, delay or database code.
// ---------------------------------------------------------------------------------------------

/// `HRTFPanner::FftSizeForSampleRate`: twice the power of two at or below 256 x rate / 44100.
fn ref_fft_size(rate: f32) -> usize {
    let resampled = 256.0 * (rate as f64 / 44100.0);
    let analysis = (1usize << (resampled.log2() as u32)).max(2);
    2 * analysis
}

/// `HRTFPanner::CalculateDesiredAzimuthIndexAndBlend`: the reference negates the desired azimuth
/// (IRCAM runs the other way), wraps negatives into 0..360 and splits at 192 steps of 1.875 degrees.
fn ref_azimuth_index_and_blend(desired: f64) -> (usize, f64) {
    let mut az = -desired;
    if az < 0.0 {
        az += 360.0;
    }
    let f = az / (360.0 / TOTAL_AZIMUTHS as f64);
    let i = f as usize;
    (i.min(TOTAL_AZIMUTHS - 1), f - i as f64)
}

/// `HRTFDatabase::IndexFromElevationAngle`: clamp to -45..90, then 15-degree bins.
fn ref_elevation_index(el: f64) -> usize {
    let c = el.clamp(-45.0, 90.0);
    ((c + 45.0) / 15.0) as usize
}

/// The elevation index a raw azimuth is read at: the requested elevation, capped at that
/// azimuth's `kMaxElevations` entry.
fn cap_elevation(raw: usize, e: usize) -> usize {
    let elevation = -45 + 15 * e as i32;
    let capped = elevation.min(MAX_ELEVATION[raw]);
    ((capped + 45) / 15) as usize
}

/// The faded, truncated response of one raw direction, as `HRTFKernel`'s constructor leaves it:
/// `min(irLength, fft / 2)` frames zero-padded to `fft / 2`, then the last `(unsigned)(rate / 4410)`
/// of those `fft / 2` frames windowed linearly to zero. A shorter response is padded before the
/// fade (`CalculateKernelsForAzimuthElevation` pads when `2 * length < fft_size`, so
/// `truncated_response_length` is always `fft / 2`), which puts the fade on the padding. f32 throughout.
fn ref_raw_response(db: &SyntheticDb, raw: usize, e: usize, ear: usize) -> Vec<f32> {
    let taps = ref_fft_size(db.rate) / 2;
    let keep = db.ir_length.min(taps);
    let mut t = vec![0f32; taps];
    for (i, slot) in t.iter_mut().enumerate().take(keep) {
        *slot = db.sample(raw, e, ear, i);
    }
    let nf = (db.rate / 4410.0f32) as usize;
    let start = taps - nf;
    for i in start..taps {
        let x = 1.0f32 - (i - start) as f32 / nf as f32;
        t[i] *= x;
    }
    t
}

/// The delay of the kernel at azimuth index `a` (0..192): the raw table delay, or the f32 lerp
/// between the two raw azimuths' delays (each at its own capped elevation).
fn ref_kernel_delay(db: &SyntheticDb, a: usize, e: usize, ear: usize) -> f32 {
    let raw1 = a / 8;
    let jj = a % 8;
    let d1 = db.delay(raw1, cap_elevation(raw1, e), ear);
    if jj == 0 {
        return d1;
    }
    let raw2 = (raw1 + 1) % RAW_AZIMUTHS;
    let d2 = db.delay(raw2, cap_elevation(raw2, e), ear);
    lerp_f32(d1, d2, jj as f32 / 8.0)
}

/// Cosine and sine of `2 pi m / fft`, for m in 0..fft.
fn cos_sin_table(fft: usize) -> (Vec<f64>, Vec<f64>) {
    (0..fft)
        .map(|m| {
            let t = 2.0 * PI * m as f64 / fft as f64;
            (t.cos(), t.sin())
        })
        .unzip()
}

/// Naive forward DFT of a real sequence `x` (zero-padded to `fft`), in the packed layout of
/// `fft_frame.h`: bin 0 holds DC in `re` and Nyquist in `im`; bins 1..fft/2 hold the complex value.
/// Only the nonzero input is summed, which is the same sum.
fn ref_packed_spectrum(x: &[f64], fft: usize) -> Vec<[f64; 2]> {
    let half = fft / 2;
    let (cos, sin) = cos_sin_table(fft);
    let mut bins = vec![[0f64; 2]; half + 1];
    for (k, bin) in bins.iter_mut().enumerate() {
        let (mut re, mut im) = (0.0, 0.0);
        for (n, &v) in x.iter().enumerate() {
            let m = (k * n) % fft;
            re += v * cos[m];
            im -= v * sin[m];
        }
        *bin = [re, im];
    }
    let mut packed = vec![[0f64; 2]; half];
    packed[0] = [bins[0][0], bins[half][0]];
    packed[1..].copy_from_slice(&bins[1..half]);
    packed
}

/// `FFTFrame::InterpolateFrequencyComponents`: the bins blended in dB magnitude and unwrapped
/// group delay, with the 0.75-power tweak where one response has a deep notch.
fn ref_interpolate_packed(p1: &[[f64; 2]], p2: &[[f64; 2]], interp: f64) -> Vec<[f64; 2]> {
    let n = p1.len();
    let s1base = 1.0 - interp;
    let s2base = interp;
    let two_pi = 2.0 * PI;
    let mut out = vec![[0f64; 2]; n];
    out[0] = [
        s1base * p1[0][0] + s2base * p2[0][0],
        s1base * p1[0][1] + s2base * p2[0][1],
    ];
    let (mut phase_accum, mut last1, mut last2) = (0.0f64, 0.0f64, 0.0f64);
    for i in 1..n {
        let (re1, im1) = (p1[i][0], p1[i][1]);
        let (re2, im2) = (p2[i][0], p2[i][1]);
        let mag1 = re1.hypot(im1);
        let mag2 = re2.hypot(im2);
        let db1 = 20.0 * mag1.log10();
        let db2 = 20.0 * mag2.log10();

        let mut s1 = s1base;
        let mut s2 = s2base;
        let diff = db1 - db2;
        let threshold = if i > 16 { 5.0 } else { 2.0 };
        if diff < -threshold && db1 < 0.0 {
            s1 = s1.powf(0.75);
            s2 = 1.0 - s1;
        } else if diff > threshold && db2 < 0.0 {
            s2 = s2.powf(0.75);
            s1 = 1.0 - s2;
        }

        let db = s1 * db1 + s2 * db2;
        let mag = 10f64.powf(0.05 * db);

        let phase1 = im1.atan2(re1);
        let phase2 = im2.atan2(re2);
        let mut d1 = phase1 - last1;
        let mut d2 = phase2 - last2;
        last1 = phase1;
        last2 = phase2;
        if d1 > PI {
            d1 -= two_pi;
        }
        if d1 < -PI {
            d1 += two_pi;
        }
        if d2 > PI {
            d2 -= two_pi;
        }
        if d2 < -PI {
            d2 += two_pi;
        }

        let blend = if d1 - d2 > PI {
            s1 * d1 + s2 * (two_pi + d2)
        } else if d2 - d1 > PI {
            s1 * (two_pi + d1) + s2 * d2
        } else {
            s1 * d1 + s2 * d2
        };
        phase_accum += blend;
        if phase_accum > PI {
            phase_accum -= two_pi;
        }
        if phase_accum < -PI {
            phase_accum += two_pi;
        }
        out[i] = [mag * phase_accum.cos(), mag * phase_accum.sin()];
    }
    out
}

/// Naive inverse DFT (scaled by 1/fft) of a packed spectrum, real part, first `taps` samples.
fn ref_inverse_packed(packed: &[[f64; 2]], fft: usize, taps: usize) -> Vec<f64> {
    let half = fft / 2;
    let (cos, sin) = cos_sin_table(fft);
    let mut bins = vec![[0f64; 2]; half + 1];
    bins[0] = [packed[0][0], 0.0];
    bins[half] = [packed[0][1], 0.0];
    bins[1..half].copy_from_slice(&packed[1..]);
    let mut out = vec![0f64; taps];
    for (n, o) in out.iter_mut().enumerate() {
        let mut acc = 0.0;
        for k in 0..fft {
            let [re, im] = if k <= half {
                bins[k]
            } else {
                let b = bins[fft - k];
                [b[0], -b[1]]
            };
            let m = (k * n) % fft;
            acc += re * cos[m] - im * sin[m];
        }
        *o = acc / fft as f64;
    }
    out
}

fn store(v: f64, f32_storage: bool) -> f64 {
    if f32_storage {
        v as f32 as f64
    } else {
        v
    }
}

/// `CreateInterpolatedFrame` in the time domain: both responses to packed spectra, blended, back to
/// `taps` samples. With `f32_storage` the spectra and the output are rounded to f32 as Chromium
/// stores them; without it the arithmetic is exact f64 (used by the self-test).
fn ref_interpolate_time(h1: &[f64], h2: &[f64], x: f64, fft: usize, taps: usize, f32_storage: bool) -> Vec<f64> {
    let spectrum = |h: &[f64]| -> Vec<[f64; 2]> {
        ref_packed_spectrum(h, fft)
            .into_iter()
            .map(|c| [store(c[0], f32_storage), store(c[1], f32_storage)])
            .collect()
    };
    let p1 = spectrum(h1);
    let p2 = spectrum(h2);
    let q: Vec<[f64; 2]> = ref_interpolate_packed(&p1, &p2, x)
        .into_iter()
        .map(|c| [store(c[0], f32_storage), store(c[1], f32_storage)])
        .collect();
    ref_inverse_packed(&q, fft, taps)
        .into_iter()
        .map(|v| store(v, f32_storage))
        .collect()
}

fn widen(v: &[f32]) -> Vec<f64> {
    v.iter().map(|&x| x as f64).collect()
}

/// The reference kernel for azimuth index `a` (0..192), elevation index `e` (0..10) and `ear`:
/// its time response (`fft / 2` taps, f32) and its frame delay.
fn ref_kernel(db: &SyntheticDb, a: usize, e: usize, ear: usize) -> (Vec<f32>, f32) {
    let fft = ref_fft_size(db.rate);
    let taps = fft / 2;
    let raw1 = a / 8;
    let jj = a % 8;
    let raw2 = (raw1 + 1) % RAW_AZIMUTHS;
    let h1 = ref_raw_response(db, raw1, cap_elevation(raw1, e), ear);
    let delay = ref_kernel_delay(db, a, e, ear);
    if jj == 0 {
        return (h1, delay);
    }
    let h2 = ref_raw_response(db, raw2, cap_elevation(raw2, e), ear);
    let x = jj as f32 / 8.0;
    let t = ref_interpolate_time(&widen(&h1), &widen(&h2), x as f64, fft, taps, true);
    (t.iter().map(|&v| v as f32).collect(), delay)
}

/// `Delay::ProcessKRate` with its circular buffer of `128 + TimeToSampleFrame(0.002, rate, up)`.
struct RefDelay {
    buf: Vec<f64>,
    w: usize,
}

/// `TimeToSampleFrame` with `kRoundUp`: round at 1024 x rate, then ceil.
fn time_to_frame_up(time: f64, rate: f64) -> usize {
    let frame = (time * rate * 1024.0).round() / 1024.0;
    frame.ceil() as usize
}

impl RefDelay {
    fn new(rate: f32) -> Self {
        let len = QUANTUM + time_to_frame_up(0.002, rate as f64);
        RefDelay { buf: vec![0.0; len], w: 0 }
    }

    /// Writes `src` into the ring, then reads `dst` at `delay_frames` (clamped to 0..2 ms),
    /// linearly interpolating a fractional delay.
    fn process(&mut self, rate: f32, delay_frames: f64, src: &[f64], dst: &mut [f64]) {
        let len = self.buf.len();
        let n = src.len();
        let r = rate as f64;
        let d = (delay_frames / r).clamp(0.0, 0.002) * r;
        let mut read = self.w as f64 + len as f64 - d;
        if read >= len as f64 {
            read -= len as f64;
        }
        let r1 = read as usize;
        let frac = read - r1 as f64;
        for (k, &v) in src.iter().enumerate() {
            self.buf[(self.w + k) % len] = v;
        }
        self.w = (self.w + n) % len;
        for (k, out) in dst.iter_mut().enumerate().take(n) {
            let i1 = (r1 + k) % len;
            let i2 = (i1 + 1) % len;
            *out = self.buf[i1] + frac * (self.buf[i2] - self.buf[i1]);
        }
    }
}

/// The reference panner: `HRTFPanner::Pan` for one quantum at a time, with each set's kernel
/// computed directly and convolved over the whole delayed history.
struct RefPanner {
    rate: f32,
    selection2: bool,
    az: [Option<usize>; 2],
    el: [f64; 2],
    x: f32,
    incr: f32,
    /// Per set: the (azimuth index, elevation index) its kernels were built for, and the
    /// time responses for the left and right ears.
    kernels: [Option<((usize, usize), [Vec<f64>; 2])>; 2],
    delay_l: RefDelay,
    delay_r: RefDelay,
    /// Every delayed input sample so far, per ear.
    hist: [Vec<f64>; 2],
}

impl RefPanner {
    fn new(rate: f32) -> Self {
        RefPanner {
            rate,
            selection2: false,
            az: [None, None],
            el: [0.0, 0.0],
            x: 0.0,
            incr: 0.0,
            kernels: [None, None],
            delay_l: RefDelay::new(rate),
            delay_r: RefDelay::new(rate),
            hist: [Vec::new(), Vec::new()],
        }
    }

    /// Direct convolution of set `s`'s kernel (`a`, `e`) with the delayed history, for the
    /// quantum that has just been appended to `hist`.
    fn convolve(&mut self, db: &SyntheticDb, s: usize, a: usize, e: usize) -> [Vec<f64>; 2] {
        let key = (a, e);
        let fresh = matches!(&self.kernels[s], Some((k, _)) if *k == key);
        if !fresh {
            let l = widen(&ref_kernel(db, a, e, 0).0);
            let r = widen(&ref_kernel(db, a, e, 1).0);
            self.kernels[s] = Some((key, [l, r]));
        }
        let (_, h) = self.kernels[s].as_ref().unwrap();
        let mut out = [vec![0f64; QUANTUM], vec![0f64; QUANTUM]];
        for ear in 0..2 {
            let hist = &self.hist[ear];
            let end = hist.len();
            let taps = h[ear].len();
            for k in 0..QUANTUM {
                let n = end - QUANTUM + k;
                let mut acc = 0.0;
                for m in 0..taps.min(n + 1) {
                    acc += h[ear][m] * hist[n - m];
                }
                out[ear][k] = acc;
            }
        }
        out
    }

    /// One quantum. `desired` in -180..180 degrees, `src_r = None` for a mono source.
    fn pan(&mut self, db: &SyntheticDb, desired: f64, elevation: f64, src_l: &[f32], src_r: Option<&[f32]>) -> (Vec<f64>, Vec<f64>) {
        let rate = self.rate;
        let (idx, blend) = ref_azimuth_index_and_blend(desired);
        for s in 0..2 {
            if self.az[s].is_none() {
                self.az[s] = Some(idx);
                self.el[s] = elevation;
            }
        }
        let fade = if rate <= 48000.0 { 2048.0 } else { 4096.0 };
        if self.x == 0.0 && !self.selection2 && (self.az[0] != Some(idx) || self.el[0] != elevation) {
            self.incr = (1.0 / fade) as f32;
            self.az[1] = Some(idx);
            self.el[1] = elevation;
        }
        if self.x == 1.0 && self.selection2 && (self.az[1] != Some(idx) || self.el[1] != elevation) {
            self.incr = (-1.0 / fade) as f32;
            self.az[0] = Some(idx);
            self.el[0] = elevation;
        }

        let az = [self.az[0].unwrap(), self.az[1].unwrap()];
        let e = [ref_elevation_index(self.el[0]), ref_elevation_index(self.el[1])];

        // Interaural delays: per set and ear, the azimuth blend, then the crossfade.
        let mut fd = [[0f64; 2]; 2];
        for s in 0..2 {
            for ear in 0..2 {
                let a = ref_kernel_delay(db, az[s], e[s], ear) as f64;
                let b = ref_kernel_delay(db, (az[s] + 1) % TOTAL_AZIMUTHS, e[s], ear) as f64;
                fd[s][ear] = lerp_f64(a, b, blend);
            }
        }
        let x64 = self.x as f64;
        let delay_l = lerp_f64(fd[0][0], fd[1][0], x64);
        let delay_r = lerp_f64(fd[0][1], fd[1][1], x64);

        let sl: Vec<f64> = widen(src_l);
        let sr: Vec<f64> = match src_r {
            Some(r) => widen(r),
            None => sl.clone(),
        };
        let mut dd_l = vec![0f64; QUANTUM];
        let mut dd_r = vec![0f64; QUANTUM];
        self.delay_l.process(rate, delay_l, &sl, &mut dd_l);
        self.delay_r.process(rate, delay_r, &sr, &mut dd_r);
        self.hist[0].extend_from_slice(&dd_l);
        self.hist[1].extend_from_slice(&dd_r);

        let needs = self.incr != 0.0;
        let y1 = if !self.selection2 || needs { Some(self.convolve(db, 0, az[0], e[0])) } else { None };
        let y2 = if self.selection2 || needs { Some(self.convolve(db, 1, az[1], e[1])) } else { None };

        let out: [Vec<f64>; 2] = if needs {
            let (a, b) = (y1.unwrap(), y2.unwrap());
            let mut out = [vec![0f64; QUANTUM], vec![0f64; QUANTUM]];
            let mut x = self.x;
            let incr = self.incr;
            for k in 0..QUANTUM {
                let xd = x as f64;
                out[0][k] = (1.0 - xd) * a[0][k] + xd * b[0][k];
                out[1][k] = (1.0 - xd) * a[1][k] + xd * b[1][k];
                x += incr;
            }
            self.x = x;
            if self.incr > 0.0 && (self.x - 1.0).abs() < self.incr {
                self.selection2 = true;
                self.x = 1.0;
                self.incr = 0.0;
            } else if self.incr < 0.0 && self.x.abs() < -self.incr {
                self.selection2 = false;
                self.x = 0.0;
                self.incr = 0.0;
            }
            out
        } else if self.selection2 {
            y2.unwrap()
        } else {
            y1.unwrap()
        };
        let [l, r] = out;
        (l, r)
    }
}

// ---------------------------------------------------------------------------------------------
// Comparison helpers.
// ---------------------------------------------------------------------------------------------

fn assert_close(what: &str, port: &[f32], reference: &[f64]) {
    assert_eq!(port.len(), reference.len(), "{what}: length");
    let peak = reference.iter().fold(1.0f64, |m, v| m.max(v.abs()));
    let limit = TOL * peak;
    let mut worst = (0usize, 0.0f64);
    for (i, (&p, &r)) in port.iter().zip(reference).enumerate() {
        let err = (p as f64 - r).abs();
        if err > worst.1 {
            worst = (i, err);
        }
    }
    assert!(
        worst.1 <= limit,
        "{what}: worst error {:e} at sample {} exceeds {:e} (peak {})",
        worst.1,
        worst.0,
        limit,
        peak
    );
}

fn ear_of(ear: usize) -> Ear {
    if ear == 0 {
        Ear::Left
    } else {
        Ear::Right
    }
}

/// Runs the port and the reference over the same noise input, one quantum per step, and compares
/// both outputs. Each step is (desired azimuth, elevation).
fn compare_run(db: &SyntheticDb, steps: &[(f64, f64)], stereo: bool, seed: u32, label: &str) {
    let quanta = steps.len();
    let src_l = noise(quanta, seed);
    let src_r = noise(quanta, seed ^ 0x5151_7EAD);
    let hdb = HrirDatabase::parse(&db.bytes).expect("valid table");
    let mut scratch = HrtfScratch::new();
    let mut panner = HrtfPanner::new(db.rate).expect("supported rate");
    let mut reference = RefPanner::new(db.rate);
    let mut port: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
    let mut want: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    for (q, &(az, el)) in steps.iter().enumerate() {
        let range = q * QUANTUM..(q + 1) * QUANTUM;
        let mut l = [0f32; QUANTUM];
        l.copy_from_slice(&src_l[range.clone()]);
        let mut r = [0f32; QUANTUM];
        r.copy_from_slice(&src_r[range.clone()]);
        let mut dl = [0f32; QUANTUM];
        let mut dr = [0f32; QUANTUM];
        let right = if stereo { Some(&r) } else { None };
        panner.pan(&hdb, &mut scratch, az, el, &l, right, &mut dl, &mut dr);
        let (rl, rr) = reference.pan(db, az, el, &src_l[range.clone()], if stereo { Some(&src_r[range]) } else { None });
        port[0].extend_from_slice(&dl);
        port[1].extend_from_slice(&dr);
        want[0].extend_from_slice(&rl);
        want[1].extend_from_slice(&rr);
    }
    assert_close(&format!("{label}: left"), &port[0], &want[0]);
    assert_close(&format!("{label}: right"), &port[1], &want[1]);
}

/// Compares one kernel's time response and frame delay against the reference.
fn check_kernel(db: &SyntheticDb, hdb: &HrirDatabase<'_>, a: usize, e: usize, ear: usize) {
    let mut scratch = HrtfScratch::new();
    let mut out = vec![0f32; 512];
    let n = kernel_time_response(hdb, db.rate, a, e, ear_of(ear), &mut scratch, &mut out);
    let (want, want_delay) = ref_kernel(db, a, e, ear);
    assert_eq!(n, want.len(), "kernel length a={a} e={e} ear={ear}");
    let label = format!("kernel a={a} e={e} ear={ear} rate={}", db.rate);
    assert_close(&label, &out[..n], &widen(&want));
    let got_delay = kernel_frame_delay(hdb, a, e, ear_of(ear));
    let limit = TOL * (want_delay as f64).abs().max(1.0);
    assert!(
        ((got_delay - want_delay) as f64).abs() <= limit,
        "{label}: frame delay {got_delay} vs {want_delay}"
    );
}

// ---------------------------------------------------------------------------------------------
// Reference self-tests (run now; they do not touch the port).
// ---------------------------------------------------------------------------------------------

#[test]
fn reference_delay_line_matches_hand_values() {
    let mut d = RefDelay::new(48000.0);
    // Buffer length is 128 + 96 frames (2 ms at 48 kHz).
    assert_eq!(d.buf.len(), 224);
    let ramp: Vec<f64> = (0..256).map(|n| n as f64).collect();
    let mut out = Vec::new();
    for block in 0..2 {
        let mut dst = vec![0f64; QUANTUM];
        d.process(48000.0, 2.5, &ramp[block * QUANTUM..(block + 1) * QUANTUM], &mut dst);
        out.extend(dst);
    }
    // Hand values: the ramp read 2.5 frames late, with zeros before frame 0.
    let hand = [0.0, 0.0, 0.0, 0.5, 1.5, 2.5];
    for (n, &want) in hand.iter().enumerate() {
        assert!((out[n] - want).abs() < 1e-12, "frame {n}: {} vs {want}", out[n]);
    }
    // Both blocks, including the wrap of the circular buffer in the second one.
    for (n, &v) in out.iter().enumerate() {
        let want = (n as f64 - 2.5).max(0.0);
        assert!((v - want).abs() < 1e-12, "frame {n}: {v} vs {want}");
    }
}

#[test]
fn reference_kernel_of_a_raw_azimuth_is_the_faded_response() {
    for &(rate, ir_len) in &[(48000.0f32, 256usize), (48000.0, 200), (96000.0, 512)] {
        let db = synthetic_db(rate, ir_len, 21);
        let taps = ref_fft_size(rate) / 2;
        let keep = ir_len.min(taps);
        let nf = (rate as f64 / 4410.0).floor() as usize;
        for &(raw, e) in &[(0usize, 3usize), (5, 9), (23, 0)] {
            let ear = 1;
            let e1 = cap_elevation(raw, e);
            let (h, delay) = ref_kernel(&db, raw * 8, e, ear);
            assert_eq!(h.len(), taps);
            for i in 0..taps {
                let want = if i < keep {
                    let v = db.sample(raw, e1, ear, i) as f64;
                    // The fade covers the last nf of the fft / 2 (padded) frames.
                    if i + nf >= taps {
                        v * (1.0 - (i + nf - taps) as f64 / nf as f64)
                    } else {
                        v
                    }
                } else {
                    0.0
                };
                assert!(
                    (h[i] as f64 - want).abs() <= 1e-6,
                    "rate {rate} ir {ir_len} raw {raw} frame {i}: {} vs {want}",
                    h[i]
                );
            }
            assert_eq!(delay, db.delay(raw, e1, ear));
        }
    }
}

#[test]
fn reference_interpolated_kernel_at_identical_raw_responses_is_that_response() {
    let db = synthetic_db(48000.0, 256, 4);
    let fft = ref_fft_size(db.rate);
    let taps = fft / 2;
    let h = widen(&ref_raw_response(&db, 6, cap_elevation(6, 4), 0));
    for &x in &[0.125, 0.375, 0.5, 0.875] {
        let t = ref_interpolate_time(&h, &h, x, fft, taps, false);
        for i in 0..taps {
            assert!((t[i] - h[i]).abs() < 1e-9, "x {x} frame {i}: {} vs {}", t[i], h[i]);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Port comparisons (call the port; ignored until the H1 core lands).
// ---------------------------------------------------------------------------------------------

#[test]
fn synthetic_bytes_equal_database_encode() {
    let db = synthetic_db(48000.0, 200, 17);
    let header = HrirHeader { elevations: 10, azimuths: 24, ir_length: 200, rate: 48000.0 };
    let mut out = vec![0u8; db.bytes.len()];
    let n = encode(&header, &db.delays, &db.irs, &mut out).expect("encode");
    assert_eq!(n, db.bytes.len());
    assert_eq!(&out[..n], &db.bytes[..]);
}

#[test]
fn kernel_responses_match_reference_at_raw_azimuths() {
    for &(rate, ir_len) in &[(48000.0f32, 256usize), (96000.0, 512)] {
        let db = synthetic_db(rate, ir_len, 3);
        let hdb = HrirDatabase::parse(&db.bytes).expect("valid table");
        for raw in 0..RAW_AZIMUTHS {
            for &e in &[0usize, 4, 6, 9] {
                for ear in 0..2 {
                    check_kernel(&db, &hdb, raw * 8, e, ear);
                }
            }
        }
    }
}

#[test]
fn kernel_responses_match_reference_at_interpolated_azimuths() {
    let azimuths = [1usize, 3, 4, 7, 10, 17, 42, 100, 189, 191];
    for &(rate, ir_len, a_set) in &[(48000.0f32, 256usize, &azimuths[..]), (96000.0, 512, &azimuths[..4])] {
        let db = synthetic_db(rate, ir_len, 5);
        let hdb = HrirDatabase::parse(&db.bytes).expect("valid table");
        for &a in a_set {
            for &e in &[0usize, 2, 9] {
                for ear in 0..2 {
                    check_kernel(&db, &hdb, a, e, ear);
                }
            }
        }
    }
}

#[test]
fn kernel_frame_delays_match_reference() {
    let db = synthetic_db(48000.0, 256, 9);
    let hdb = HrirDatabase::parse(&db.bytes).expect("valid table");
    for a in 0..TOTAL_AZIMUTHS {
        for e in 0..ELEVATIONS {
            for ear in 0..2 {
                let want = ref_kernel_delay(&db, a, e, ear);
                let got = kernel_frame_delay(&hdb, a, e, ear_of(ear));
                let limit = TOL * (want as f64).abs().max(1.0);
                assert!(
                    ((got - want) as f64).abs() <= limit,
                    "a={a} e={e} ear={ear}: {got} vs {want}"
                );
            }
        }
    }
}

#[test]
fn fixed_azimuth_sweep_at_elevation_0_matches_reference() {
    let db = synthetic_db(48000.0, 256, 1);
    let mut azimuths: Vec<f64> = (0..=96).map(|k| -180.0 + 3.75 * k as f64).collect();
    azimuths.extend_from_slice(&[1.0, -7.3, 179.9]);
    for (i, &az) in azimuths.iter().enumerate() {
        let steps = vec![(az, 0.0); 6];
        compare_run(&db, &steps, false, 100 + i as u32, &format!("azimuth {az}"));
    }
}

#[test]
fn fixed_elevation_sweep_matches_reference() {
    let db = synthetic_db(48000.0, 256, 2);
    let elevations = [-90.0, -45.0, -30.0, -7.5, 0.0, 14.99, 15.0, 37.0, 45.0, 60.0, 75.0, 89.0, 90.0, 120.0];
    let azimuths = [0.0, 15.0, 30.0, 60.0, 97.5, -135.0, 180.0];
    for (i, &el) in elevations.iter().enumerate() {
        for (j, &az) in azimuths.iter().enumerate() {
            let steps = vec![(az, el); 4];
            compare_run(&db, &steps, false, 200 + (i * 7 + j) as u32, &format!("azimuth {az} elevation {el}"));
        }
    }
}

#[test]
fn stereo_source_matches_reference() {
    let db = synthetic_db(48000.0, 256, 6);
    let mut steps = Vec::new();
    for &az in &[30.0, -110.0, 179.9, 0.0] {
        steps.extend(std::iter::repeat((az, 20.0)).take(5));
    }
    compare_run(&db, &steps, true, 300, "stereo");
}

#[test]
fn short_responses_are_zero_padded() {
    let db = synthetic_db(48000.0, 200, 5);
    let hdb = HrirDatabase::parse(&db.bytes).expect("valid table");
    for &(a, e) in &[(0usize, 0usize), (9, 3), (100, 9), (191, 5)] {
        for ear in 0..2 {
            check_kernel(&db, &hdb, a, e, ear);
        }
    }
    for (i, &az) in [0.0, 33.3, -90.0, 150.0].iter().enumerate() {
        for &el in &[0.0, 45.0] {
            let steps = vec![(az, el); 6];
            compare_run(&db, &steps, false, 400 + i as u32, &format!("200-frame azimuth {az} elevation {el}"));
        }
    }
}

#[test]
fn rate_96k_uses_four_partitions_and_matches_reference() {
    let db = synthetic_db(96000.0, 512, 8);
    let hdb = HrirDatabase::parse(&db.bytes).expect("valid table");
    let panner = HrtfPanner::new(96000.0).expect("96 kHz is supported");
    assert_eq!(panner.fft_size(), 1024);
    assert_eq!(panner.partitions(), 4);
    for &a in &[0usize, 13, 96, 191] {
        check_kernel(&db, &hdb, a, 4, 0);
    }
    for (i, &(az, el)) in [(0.0, 0.0), (45.0, 30.0), (-100.0, -45.0), (170.0, 89.0)].iter().enumerate() {
        let steps = vec![(az, el); 4];
        compare_run(&db, &steps, false, 500 + i as u32, &format!("96 kHz azimuth {az} elevation {el}"));
    }
}

#[test]
fn crossfade_on_a_direction_change_matches_reference() {
    let db = synthetic_db(48000.0, 256, 10);
    // 30 degrees for 4 quanta, then -60 degrees for 24 quanta. The request for 90 degrees at
    // quantum 10 falls mid-fade (2048 frames = 16 quanta), so it must be ignored.
    let steps: Vec<(f64, f64)> = (0..28)
        .map(|q| {
            let az = if q < 4 {
                30.0
            } else if q == 10 {
                90.0
            } else {
                -60.0
            };
            (az, 0.0)
        })
        .collect();
    compare_run(&db, &steps, false, 600, "crossfade");
}

#[test]
fn at_most_four_kernel_computations_per_quantum() {
    let db = synthetic_db(48000.0, 256, 13);
    let hdb = HrirDatabase::parse(&db.bytes).expect("valid table");
    let mut scratch = HrtfScratch::new();
    let mut panner = HrtfPanner::new(48000.0).expect("48 kHz is supported");
    let src = [0.1f32; QUANTUM];
    let mut dl = [0f32; QUANTUM];
    let mut dr = [0f32; QUANTUM];

    panner.pan(&hdb, &mut scratch, 30.0, 0.0, &src, None, &mut dl, &mut dr);
    assert_eq!(panner.kernels_computed_last(), 2, "first call snaps one set");
    panner.pan(&hdb, &mut scratch, 30.0, 0.0, &src, None, &mut dl, &mut dr);
    assert_eq!(panner.kernels_computed_last(), 0, "steady direction");
    panner.pan(&hdb, &mut scratch, -60.0, 0.0, &src, None, &mut dl, &mut dr);
    assert_eq!(panner.kernels_computed_last(), 2, "direction change builds the second set");

    let mut rng = XorShift32::new(77);
    for _ in 0..200 {
        let az = 180.0 * rng.bipolar();
        let el = -45.0 + 135.0 * rng.unit();
        panner.pan(&hdb, &mut scratch, az, el, &src, None, &mut dl, &mut dr);
        assert!(panner.kernels_computed_last() <= 4, "{} kernels in one quantum", panner.kernels_computed_last());
    }
}
