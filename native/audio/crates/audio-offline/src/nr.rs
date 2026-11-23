//! Offline noise reduction (ADR 0345 `noiseReduction`, `amount` 0..100 %): a spectral gate over
//! the whole signal, one channel at a time.
//!
//! 1. **Noise print.** The signal's short-time spectrum (periodic Hann, [`size`] points, hop a
//!    quarter of it) is measured on its quietest tenth of frames (by energy, frames wholly inside
//!    the signal): their mean magnitude per bin is the noise floor.
//! 2. **Gate.** Each frame's bins get the gain `1 − K·noise/|X|` (spectral subtraction, `K`
//!    [`OVERSUBTRACT`]), never below the floor `amount × −`[`MAX_REDUCTION_DB`]; gains are
//!    smoothed across three neighbouring bins and released slowly over time ([`RELEASE_S`]) to
//!    keep "musical noise" down. `amount` 0 leaves the signal as it was.
//! 3. **Resynthesis** by overlap-add with the same window (the periodic Hann's square sums to
//!    1.5 at a quarter hop, divided out), the signal's length and alignment kept.
//!
//! A signal shorter than one frame can't be measured: it passes through and `process` says so.

/// Over-subtraction factor of the gate.
pub const OVERSUBTRACT: f32 = 2.0;
/// The most a bin is turned down, at amount 100 %, dB.
pub const MAX_REDUCTION_DB: f32 = 30.0;
/// The gain's release time constant, seconds.
pub const RELEASE_S: f32 = 0.05;
/// The share of frames (the quietest) the noise print is taken from.
pub const QUIET_SHARE: f32 = 0.1;

/// The transform size at `rate`: 1,024 points at 32 kHz and above, else 512.
pub fn size(rate: f32) -> usize {
    if rate >= 32_000.0 {
        1024
    } else {
        512
    }
}

/// In-place radix-2 complex FFT of `re`/`im` (a power-of-two length); `inverse` conjugates the
/// twiddles and scales by `1 / n`.
pub fn fft(re: &mut [f32], im: &mut [f32], inverse: bool) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    let bits = n.trailing_zeros();
    for i in 0..n {
        let j = i.reverse_bits() >> (usize::BITS - bits);
        if j > i {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2;
    while len <= n {
        let ang = sign * 2.0 * core::f64::consts::PI / len as f64;
        for k in 0..len / 2 {
            let (wr, wi) = (libm::cos(ang * k as f64) as f32, libm::sin(ang * k as f64) as f32);
            let mut i = k;
            while i < n {
                let j = i + len / 2;
                let (xr, xi) = (re[j] * wr - im[j] * wi, re[j] * wi + im[j] * wr);
                re[j] = re[i] - xr;
                im[j] = im[i] - xi;
                re[i] += xr;
                im[i] += xi;
                i += len;
            }
        }
        len *= 2;
    }
    if inverse {
        let s = 1.0 / n as f32;
        for (r, i) in re.iter_mut().zip(im.iter_mut()) {
            *r *= s;
            *i *= s;
        }
    }
}

/// Runs the gate on `x` (one channel) at `rate`; `amount(frame)` is the amount 0..1 at a frame of
/// `x`. Returns `false` (and leaves `x`) when `x` is shorter than one transform.
pub fn process(x: &mut [f32], rate: f32, amount: &mut dyn FnMut(usize) -> f32) -> bool {
    let n = size(rate);
    let hop = n / 4;
    let len = x.len();
    if len < n {
        return false;
    }
    let window: Vec<f32> = (0..n).map(|i| (0.5 - 0.5 * libm::cos(2.0 * core::f64::consts::PI * i as f64 / n as f64)) as f32).collect();
    // The signal with a transform of silence each side, so every sample is covered by 4 frames.
    let mut padded = vec![0.0f32; len + 2 * n];
    padded[n..n + len].copy_from_slice(x);
    let frames = (padded.len() - n) / hop + 1;
    let start = |j: usize| j * hop;
    let bins = n / 2 + 1;
    let (mut re, mut im) = (vec![0.0f32; n], vec![0.0f32; n]);
    let spectrum = |j: usize, re: &mut [f32], im: &mut [f32]| {
        let s = start(j);
        for i in 0..n {
            re[i] = padded.get(s + i).copied().unwrap_or(0.0) * window[i];
            im[i] = 0.0;
        }
        fft(re, im, false);
    };

    // 1. The noise print from the quietest frames inside the signal.
    let inside: Vec<usize> = (0..frames).filter(|&j| start(j) >= n && start(j) + n <= n + len).collect();
    let energy = |j: usize| -> f32 { (0..n).map(|i| (padded[start(j) + i] * window[i]).powi(2)).sum() };
    let mut energies: Vec<(f32, usize)> = inside.iter().map(|&j| (energy(j), j)).collect();
    energies.sort_by(|a, b| a.0.total_cmp(&b.0));
    let quiet = ((energies.len() as f32 * QUIET_SHARE).ceil() as usize).clamp(1, energies.len());
    let mut noise = vec![0.0f32; bins];
    for &(_, j) in &energies[..quiet] {
        spectrum(j, &mut re, &mut im);
        for b in 0..bins {
            noise[b] += libm::hypotf(re[b], im[b]);
        }
    }
    for v in noise.iter_mut() {
        *v /= quiet as f32;
    }

    // 2 and 3. Gate each frame and overlap-add.
    let release = libm::expf(-(hop as f32) / (rate * RELEASE_S));
    let mut held = vec![1.0f32; bins];
    let mut gains = vec![1.0f32; bins];
    let mut out = vec![0.0f32; padded.len()];
    for j in 0..frames {
        spectrum(j, &mut re, &mut im);
        let centre = (start(j) + n / 2).saturating_sub(n).min(len - 1);
        let a = amount(centre).clamp(0.0, 1.0);
        let floor = libm::powf(10.0, -a * MAX_REDUCTION_DB / 20.0);
        for b in 0..bins {
            let mag = libm::hypotf(re[b], im[b]);
            let g = if mag > 0.0 { 1.0 - OVERSUBTRACT * noise[b] / mag } else { 0.0 };
            gains[b] = g.clamp(floor, 1.0);
        }
        for b in 0..bins {
            let lo = gains[b.saturating_sub(1)];
            let hi = gains[(b + 1).min(bins - 1)];
            let g = (lo + 2.0 * gains[b] + hi) * 0.25;
            held[b] = if g >= held[b] { g } else { (held[b] * release).max(g) };
        }
        for b in 0..bins {
            let g = held[b];
            re[b] *= g;
            im[b] *= g;
            if b > 0 && b < n - b {
                re[n - b] *= g;
                im[n - b] *= g;
            }
        }
        fft(&mut re, &mut im, true);
        let s = start(j);
        for i in 0..n {
            if let Some(o) = out.get_mut(s + i) {
                *o += re[i] * window[i];
            }
        }
    }
    for (d, o) in x.iter_mut().zip(out[n..n + len].iter()) {
        *d = o / 1.5;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn the_fft_round_trips_and_finds_a_bin() {
        let n = 64;
        let mut re: Vec<f32> = (0..n).map(|i| libm::sinf(2.0 * core::f32::consts::PI * 5.0 * i as f32 / n as f32)).collect();
        let orig = re.clone();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im, false);
        assert!((libm::hypotf(re[5], im[5]) - n as f32 / 2.0).abs() < 1e-3);
        fft(&mut re, &mut im, true);
        for i in 0..n {
            assert!((re[i] - orig[i]).abs() < 1e-5);
        }
    }

    #[test]
    fn amount_zero_is_transparent_and_a_full_amount_quietens_the_noise_between_tones() {
        let rate = 48_000.0;
        let len = 48_000;
        // Seeded white noise at −40 dBFS, a 1 kHz tone in the middle half.
        let mut seed = 0x1234_5678u32;
        let mut noise = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed as f32 / u32::MAX as f32 - 0.5) * 0.02
        };
        let src: Vec<f32> = (0..len)
            .map(|i| {
                let tone = if (12_000..36_000).contains(&i) { 0.5 * libm::sinf(2.0 * core::f32::consts::PI * 1000.0 * i as f32 / rate) } else { 0.0 };
                tone + noise()
            })
            .collect();
        let mut same = src.clone();
        assert!(process(&mut same, rate, &mut |_| 0.0));
        for i in 0..len {
            assert!((same[i] - src[i]).abs() < 1e-4, "amount 0 at {i}: {} vs {}", same[i], src[i]);
        }
        let mut gated = src.clone();
        assert!(process(&mut gated, rate, &mut |_| 1.0));
        let quiet_before = rms(&src[2_000..10_000]);
        let quiet_after = rms(&gated[2_000..10_000]);
        assert!(20.0 * (quiet_after / quiet_before).log10() < -12.0, "noise only: {quiet_before} -> {quiet_after}");
        let tone_before = rms(&src[16_000..32_000]);
        let tone_after = rms(&gated[16_000..32_000]);
        assert!((20.0 * (tone_after / tone_before).log10()).abs() < 1.0, "tone kept: {tone_before} -> {tone_after}");
        let mut short = vec![0.1f32; 100];
        assert!(!process(&mut short, rate, &mut |_| 1.0));
    }
}
