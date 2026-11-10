//! Shared helpers for the objective quality tests (`quality_thdn.rs`, `quality_null_pan_limiter.rs`;
//! ADR 0157, api-and-models section 8 "Objective quality"): a radix-2 FFT in f64, a Hann window,
//! coherent test tones, and dB measurements on spectra.
#![allow(dead_code)]

/// In-place radix-2 FFT of `re`/`im` (length a power of two).
pub fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    assert!(n.is_power_of_two() && im.len() == n);
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                // Twiddles from sin/cos directly: no recurrence error at 32k points.
                let (wi, wr) = (ang * k as f64).sin_cos();
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * wr - im[b] * wi;
                let ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

/// Power per bin (0..=n/2) of the Hann-windowed `x` (only ratios of these are used).
pub fn power_spectrum(x: &[f32]) -> Vec<f64> {
    let n = x.len();
    let mut re: Vec<f64> = x.iter().enumerate().map(|(i, &v)| v as f64 * (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos())).collect();
    let mut im = vec![0.0; n];
    fft(&mut re, &mut im);
    (0..=n / 2).map(|k| re[k] * re[k] + im[k] * im[k]).collect()
}

/// A power ratio in dB.
pub fn db(ratio: f64) -> f64 {
    10.0 * ratio.max(1e-300).log10()
}

/// A coherent sine: `n` samples of `amp * sin(2 pi cycles * i / n)`.
pub fn coherent_sine(n: usize, cycles: f64, amp: f64) -> Vec<f32> {
    (0..n).map(|i| (amp * (2.0 * std::f64::consts::PI * cycles * i as f64 / n as f64).sin()) as f32).collect()
}

/// THD+N in dB relative to the fundamental at bin `k`: everything outside `k +- 2` bins (so
/// harmonics, images, aliases and noise; bins 0 and 1 excluded) over the energy within them.
pub fn thd_n_db(x: &[f32], k: usize) -> f64 {
    let p = power_spectrum(x);
    let (mut sig, mut rest) = (0.0, 0.0);
    for (i, &v) in p.iter().enumerate() {
        if i.abs_diff(k) <= 2 {
            sig += v;
        } else if i >= 2 {
            rest += v;
        }
    }
    db(rest / sig)
}

/// The strongest spurious component (bins from 2 up, further than 2 from `k`) in dB relative to
/// the fundamental at bin `k`, and its bin.
pub fn worst_spur_db(x: &[f32], k: usize) -> (f64, usize) {
    let p = power_spectrum(x);
    let sig: f64 = p.iter().enumerate().filter(|(i, _)| i.abs_diff(k) <= 2).map(|(_, v)| v).sum();
    let mut worst = (0.0f64, 0usize);
    for (i, &v) in p.iter().enumerate() {
        if i >= 2 && i.abs_diff(k) > 2 && v > worst.0 {
            worst = (v, i);
        }
    }
    (db(worst.0 / sig), worst.1)
}

/// Mean power of `x` in dB (a full-scale sine reads -3.01).
pub fn rms_dbfs(x: &[f32]) -> f64 {
    let m: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len().max(1) as f64;
    db(m)
}
