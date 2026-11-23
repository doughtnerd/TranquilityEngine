//! Waveshapers and the bit-crusher (ADR 0345's `saturation`, `distortion`, `bitcrush`, and the
//! `drive` of the catalogue's filters).
//!
//! - **Saturation** (`amount` 0..100 %): `tanh(g·x) / g` with `g = 1 + 4·amount`: unity gain for
//!   quiet signals, a soft ceiling at `1 / g` for loud ones (a warm, level-safe curve: a bus
//!   insert never gets louder). 0 % is the identity.
//! - **Drive** (filters' `drive` 0..100 %, before the filter) and **distortion** (`drive` 0..1):
//!   `tanh(g·x) / √g`, `g = 1 + 9·drive%` for the filters and `1 + 49·drive` for distortion, so
//!   small signals rise by `√g` while peaks fold down to `1 / √g`: the level stays near where it
//!   was around −10 dBFS and the harmonics grow with the drive.
//! - **Bit-crush**: the signal quantised to `bits` (a step of `2 / 2^bits`, rounding to nearest),
//!   then held for `downsample` frames (a sample-and-hold whose phase carries across blocks).
//!
//! `tanh` goes through `libm` (native and wasm agree bit for bit). Nothing allocates.

/// Saturation's gain at `amount` percent (0..100, clamped).
pub fn saturation_gain(amount_pct: f32) -> f32 {
    1.0 + 4.0 * clamp(amount_pct, 0.0, 100.0) / 100.0
}

/// A filter's drive gain at `drive` percent (0..100, clamped).
pub fn drive_gain(drive_pct: f32) -> f32 {
    1.0 + 9.0 * clamp(drive_pct, 0.0, 100.0) / 100.0
}

/// Distortion's gain at `drive` (0..1, clamped).
pub fn distortion_gain(drive: f32) -> f32 {
    1.0 + 49.0 * clamp(drive, 0.0, 1.0)
}

/// `v` clamped to `lo..=hi`, NaN read as `lo`.
#[inline]
pub fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    if v >= hi {
        hi
    } else if v > lo {
        v
    } else {
        lo
    }
}

/// Saturation in place: `tanh(g·x) / g`. `g <= 1` leaves the block untouched.
pub fn saturate(block: &mut [f32], g: f32) {
    if g <= 1.0 {
        return;
    }
    let inv = 1.0 / g;
    for x in block.iter_mut() {
        *x = libm::tanhf(g * *x) * inv;
    }
}

/// Drive in place: `tanh(g·x) / √g`. `g <= 1` leaves the block untouched.
pub fn drive(block: &mut [f32], g: f32) {
    if g <= 1.0 {
        return;
    }
    let inv = 1.0 / libm::sqrtf(g);
    for x in block.iter_mut() {
        *x = libm::tanhf(g * *x) * inv;
    }
}

/// Distortion in place: the driven signal (`drive`) blended with the dry by `mix` (0..1).
pub fn distort(block: &mut [f32], g: f32, mix: f32) {
    if mix <= 0.0 || g <= 1.0 {
        return;
    }
    let inv = 1.0 / libm::sqrtf(g);
    let dry = 1.0 - mix;
    for x in block.iter_mut() {
        let wet = libm::tanhf(g * *x) * inv;
        *x = dry * *x + mix * wet;
    }
}

/// The bit-crusher's carried state: the frames left before the next sample is taken and the held
/// values. All-zero is valid (the next frame is taken).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CrushState {
    pub left: u32,
    pub held: [f32; 2],
}

/// Bit-crush in place: quantise to `bits` (4..24), hold each taken frame for `downsample` (1..32)
/// frames, blend with the dry by `mix` (0..1).
pub fn crush(state: &mut CrushState, l: &mut [f32], r: &mut [f32], bits: f32, downsample: f32, mix: f32) {
    if mix <= 0.0 {
        return;
    }
    let bits = clamp(bits, 4.0, 24.0);
    let n = (libm::roundf(clamp(downsample, 1.0, 32.0)) as u32).max(1);
    // A step of 2 / 2^bits over -1..1; fractional bits (a glide) give a continuous step.
    let q = libm::exp2f(bits - 1.0);
    let inv = 1.0 / q;
    let dry = 1.0 - mix;
    for (a, b) in l.iter_mut().zip(r.iter_mut()) {
        if state.left == 0 {
            state.held = [libm::floorf(*a * q + 0.5) * inv, libm::floorf(*b * q + 0.5) * inv];
            state.left = n;
        }
        state.left -= 1;
        *a = dry * *a + mix * state.held[0];
        *b = dry * *b + mix * state.held[1];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturation_is_unity_for_quiet_signals_and_bounded_for_loud_ones() {
        let g = saturation_gain(100.0);
        assert_eq!(g, 5.0);
        let mut b = [0.001f32, -0.001, 10.0, -10.0];
        saturate(&mut b, g);
        assert!((b[0] - 0.001).abs() < 1e-6 && (b[1] + 0.001).abs() < 1e-6);
        assert!((b[2] - 0.2).abs() < 1e-4 && (b[3] + 0.2).abs() < 1e-4);
        let mut same = [0.3f32; 4];
        saturate(&mut same, saturation_gain(0.0));
        assert_eq!(same, [0.3; 4], "0 % is the identity");
    }

    #[test]
    fn distortion_blends_and_adds_harmonics() {
        let n = 480;
        let mut x: Vec<f32> = (0..n).map(|i| 0.5 * libm::sinf(i as f32 * core::f32::consts::TAU / 48.0)).collect();
        let dry = x.clone();
        distort(&mut x, distortion_gain(1.0), 1.0);
        // The third harmonic shows up: correlate with sin(3ωt).
        let h3: f32 = x.iter().enumerate().map(|(i, v)| v * libm::sinf(3.0 * i as f32 * core::f32::consts::TAU / 48.0)).sum::<f32>() / n as f32;
        assert!(h3.abs() > 0.01, "{h3}");
        let mut half = dry.clone();
        distort(&mut half, distortion_gain(1.0), 0.0);
        assert_eq!(half, dry, "mix 0 is dry");
    }

    #[test]
    fn bitcrush_quantises_and_holds() {
        let mut s = CrushState::default();
        let mut l = [0.1f32, 0.2, 0.3, 0.4, 0.5, 0.6];
        let mut r = l;
        crush(&mut s, &mut l, &mut r, 4.0, 2.0, 1.0);
        // 4 bits: a step of 1/8. Held pairs.
        assert_eq!(l, [0.125, 0.125, 0.25, 0.25, 0.5, 0.5]);
        assert_eq!(l, r);
        let mut l2 = [0.7f32];
        let mut r2 = [0.7f32];
        crush(&mut s, &mut l2, &mut r2, 24.0, 1.0, 0.0);
        assert_eq!(l2, [0.7], "mix 0 is dry");
    }
}
