// SPDX-License-Identifier: Apache-2.0 OR MIT
//! A stereo decorrelator (ADR 0333 per-voice spread): two cascades of second-order all-pass
//! sections, one per output channel, whose poles interleave across 120 Hz – 16 kHz, so the two
//! outputs of one input have the input's magnitude spectrum (an all-pass changes only phase) but
//! phases that drift apart by turns across the band: white noise through both reads an interaural
//! correlation near 0, where the input against itself reads 1.
//!
//! **Design.** RBJ all-pass biquads at Q 0.4 (broad, so the phase moves smoothly and transients
//! don't ring), poles at `120 · (16000/120)^(k/5)` Hz (k = 0..4) for the left cascade and at
//! `120 · (16000/120)^((k + 0.3)/6)` Hz (k = 0..5) for the right one (a searched layout: the 16 kHz
//! section both progressions would end on gives both channels the same phase and is left out; the
//! cross-correlation of white noise reads |r| < 0.03 and each output's correlation with the input
//! |r| < 0.03, `tests` below). Low frequencies stay correlated
//! below the lowest pole, as a real diffuse field's do (its interaural coherence is high below a few
//! hundred hertz).
//!
//! The coefficients are fixed (designed at 48 kHz, written out below and checked against the formula
//! in the tests): at other rates the poles move with the rate, which shifts the band by the rate's
//! ratio and keeps the decorrelation. Transposed direct form II: two states per section, nothing
//! allocates, an all-zero [`Decorrelator`] is a silent one.

/// Sections in the left cascade.
pub const LEFT_SECTIONS: usize = 5;
/// Sections in the right cascade.
pub const RIGHT_SECTIONS: usize = 6;
/// States a decorrelator holds (two a section).
pub const STATES: usize = 2 * (LEFT_SECTIONS + RIGHT_SECTIONS);

/// `(a1, a2)` of each left section (an all-pass biquad: `b0 = a2, b1 = a1, b2 = 1`).
const LEFT: [[f32; 2]; LEFT_SECTIONS] = [
    [-1.961_245_9, 0.961_487_9],
    [-1.899_071_7, 0.900_731_4],
    [-1.745_524_9, 0.756_372_33],
    [-1.402_106_2, 0.465_791_35],
    [-0.748_732_75, 0.060_753_65],
];
/// `(a1, a2)` of each right section.
const RIGHT: [[f32; 2]; RIGHT_SECTIONS] = [
    [-1.950_683_4, 0.951_076_03],
    [-1.890_809_1, 0.892_754_55],
    [-1.763_921, 0.773_226_03],
    [-1.512_512_7, 0.554_023_03],
    [-1.065_886_9, 0.230_775_15],
    [-0.350_177_14, -0.072_954_89],
];

/// One decorrelator's state: [`STATES`] floats, the left cascade's first.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Decorrelator {
    pub s: [f32; STATES],
}

#[inline(always)]
fn section(c: [f32; 2], s: &mut [f32], x: f32) -> f32 {
    let [a1, a2] = c;
    let y = a2 * x + s[0];
    s[0] = a1 * (x - y) + s[1];
    s[1] = x - a2 * y;
    y
}

impl Decorrelator {
    /// The left output for input `x` (one frame).
    #[inline]
    pub fn left(&mut self, x: f32) -> f32 {
        let mut v = x;
        for (k, c) in LEFT.iter().enumerate() {
            v = section(*c, &mut self.s[2 * k..2 * k + 2], v);
        }
        v
    }

    /// The right output for input `x` (one frame).
    #[inline]
    pub fn right(&mut self, x: f32) -> f32 {
        let mut v = x;
        for (k, c) in RIGHT.iter().enumerate() {
            let at = 2 * (LEFT_SECTIONS + k);
            v = section(*c, &mut self.s[at..at + 2], v);
        }
        v
    }

    /// Back to silence (all states 0).
    pub fn clear(&mut self) {
        self.s = [0.0; STATES];
    }

    /// True when every state is finite (a NaN fed in is flushed by the caller with [`clear`](Self::clear)).
    pub fn is_finite(&self) -> bool {
        self.s.iter().all(|v| v.is_finite())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rbj(f: f64) -> [f32; 2] {
        let w = core::f64::consts::TAU * f / 48_000.0;
        let a = libm::sin(w) / (2.0 * 0.4);
        let a0 = 1.0 + a;
        [(-2.0 * libm::cos(w) / a0) as f32, ((1.0 - a) / a0) as f32]
    }

    #[test]
    fn the_coefficients_are_the_design() {
        let f = |x: f64| 120.0 * libm::pow(16_000.0 / 120.0, x);
        let left = [0.0, 1.0, 2.0, 3.0, 4.0].map(|k: f64| rbj(f(k / 5.0)));
        let right = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0].map(|k: f64| rbj(f((k + 0.3) / 6.0)));
        for (a, b) in LEFT.iter().zip(left.iter()).chain(RIGHT.iter().zip(right.iter())) {
            assert!((a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6, "{a:?} vs {b:?}");
        }
    }

    fn noise(n: usize) -> Vec<f32> {
        let mut seed = 1u32;
        (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (seed as f64 / 4_294_967_296.0 * 2.0 - 1.0) as f32
            })
            .collect()
    }

    fn corr(a: &[f32], b: &[f32]) -> f64 {
        let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
        for (x, y) in a.iter().zip(b) {
            ab += (*x as f64) * (*y as f64);
            aa += (*x as f64) * (*x as f64);
            bb += (*y as f64) * (*y as f64);
        }
        ab / libm::sqrt(aa * bb)
    }

    #[test]
    fn white_noise_comes_out_uncorrelated_at_the_same_power() {
        let x = noise(96_000);
        let mut d = Decorrelator::default();
        let l: Vec<f32> = x.iter().map(|&v| d.left(v)).collect();
        let r: Vec<f32> = x.iter().map(|&v| d.right(v)).collect();
        let lr = corr(&l, &r);
        assert!(lr.abs() < 0.03, "L/R correlation {lr}");
        assert!(corr(&x, &l).abs() < 0.03 && corr(&x, &r).abs() < 0.03, "{} {}", corr(&x, &l), corr(&x, &r));
        // All-pass: the power is the input's (within the start-up transient).
        let p = |v: &[f32]| v[4_800..].iter().map(|s| (*s as f64).powi(2)).sum::<f64>();
        for out in [&l, &r] {
            let ratio = p(out) / p(&x);
            assert!((ratio - 1.0).abs() < 0.03, "power ratio {ratio}");
        }
        assert!(d.is_finite());
        d.clear();
        assert_eq!(d, Decorrelator::default());
    }

    #[test]
    fn silence_stays_silent_and_a_sine_keeps_its_level() {
        let mut d = Decorrelator::default();
        for _ in 0..1000 {
            assert_eq!(d.left(0.0), 0.0);
            assert_eq!(d.right(0.0), 0.0);
        }
        let (mut peak_l, mut peak_r) = (0.0f32, 0.0f32);
        for i in 0..48_000 {
            let x = libm::sinf(core::f32::consts::TAU * 1_000.0 * i as f32 / 48_000.0);
            let (l, r) = (d.left(x), d.right(x));
            if i > 4_800 {
                peak_l = peak_l.max(l.abs());
                peak_r = peak_r.max(r.abs());
            }
        }
        assert!((peak_l - 1.0).abs() < 3e-3 && (peak_r - 1.0).abs() < 3e-3, "{peak_l} {peak_r}");
    }
}
