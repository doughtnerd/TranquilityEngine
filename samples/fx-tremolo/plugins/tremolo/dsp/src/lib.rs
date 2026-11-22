//! A tremolo (ADR 0338 §10): the reference audio effect plugin, on the `myco-fx` SDK.
//!
//! Parameters, in `plugin.json`'s order: `rate` (Hz, glided), `depth` (%, glided), `shape` (0 sine, 1 triangle,
//! 2 square; a stepped choice). The gain is `1 - depth × (1 - lfo) / 2`, so depth 0 is unity (the input's exact bits)
//! and depth 100% swings from silence to unity.
#![cfg_attr(target_arch = "wasm32", no_std)]

use myco_fx::{math, Effect, Flags, Status, PARAMS};

pub struct Tremolo {
    sample_rate: f32,
    /// The LFO's phase in cycles, [0, 1).
    phase: f32,
}

/// The LFO at `phase` (cycles) for `shape`, in [-1, 1].
fn lfo(shape: f32, phase: f32) -> f32 {
    match shape as u32 {
        1 => 1.0 - 4.0 * (phase - 0.5).abs(),
        2 => {
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        _ => math::sin(core::f32::consts::TAU * phase),
    }
}

impl Effect for Tremolo {
    fn new(sample_rate: f32, _max_frames: usize) -> Self {
        Tremolo { sample_rate, phase: 0.0 }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], p0: &[f32; PARAMS], p1: &[f32; PARAMS], flags: Flags) -> Status {
        let n = l.len();
        let inv = 1.0 / n.max(1) as f32;
        let (rate0, drate) = (p0[0], (p1[0] - p0[0]) * inv);
        let (depth0, ddepth) = (p0[1] * 0.01, (p1[1] - p0[1]) * 0.01 * inv);
        let shape = p1[2];
        let step = 1.0 / self.sample_rate;
        let mut phase = self.phase;
        for i in 0..n {
            let k = i as f32;
            let depth = (depth0 + ddepth * k).clamp(0.0, 1.0);
            let g = 1.0 - depth * 0.5 * (1.0 - lfo(shape, phase));
            l[i] *= g;
            r[i] *= g;
            phase += (rate0 + drate * k) * step;
            if phase >= 1.0 {
                phase -= 1.0;
            }
        }
        self.phase = phase;
        if flags.input_silent() {
            Status::Silent
        } else {
            Status::Ok
        }
    }
}

myco_fx::export_effects!(Tremolo);

#[cfg(test)]
mod tests {
    use super::*;

    fn params(rate: f32, depth: f32, shape: f32) -> [f32; PARAMS] {
        let mut p = [0.0; PARAMS];
        p[..3].copy_from_slice(&[rate, depth, shape]);
        p
    }

    #[test]
    fn depth_zero_returns_the_input_bit_for_bit() {
        let mut t = Tremolo::new(48_000.0, 128);
        let input: Vec<f32> = (0..128).map(|i| (i as f32 * 0.37).sin() * 0.8).collect();
        let (mut l, mut r) = (input.clone(), input.clone());
        let p = params(5.0, 0.0, 0.0);
        t.process(&mut l, &mut r, &p, &p, Flags(0));
        assert_eq!(l, input);
        assert_eq!(r, input);
    }

    #[test]
    fn full_depth_swings_from_silence_to_unity_at_the_rate() {
        let sr = 48_000.0;
        let mut t = Tremolo::new(sr, 128);
        let p = params(10.0, 100.0, 0.0);
        let mut gains = Vec::new();
        for _ in 0..(sr as usize / 128) {
            let (mut l, mut r) = ([1.0f32; 128], [1.0f32; 128]);
            t.process(&mut l, &mut r, &p, &p, Flags(0));
            gains.extend_from_slice(&l);
        }
        let (lo, hi) = gains.iter().fold((f32::MAX, f32::MIN), |(a, b), &g| (a.min(g), b.max(g)));
        assert!(lo < 1e-4 && hi > 0.9999, "{lo} {hi}");
        // 10 Hz: ten minima a second.
        let minima = gains.windows(3).filter(|w| w[1] < w[0] && w[1] <= w[2] && w[1] < 0.01).count();
        assert_eq!(minima, 10);
    }

    #[test]
    fn square_and_triangle_shapes() {
        assert_eq!(lfo(2.0, 0.25), 1.0);
        assert_eq!(lfo(2.0, 0.75), -1.0);
        assert_eq!(lfo(1.0, 0.5), 1.0);
        assert_eq!(lfo(1.0, 0.0), -1.0);
    }

    #[test]
    fn runs_through_the_abi_dispatch() {
        let kind = &MYCO_FX_KINDS[0];
        let h = kind.create(48_000.0, 128);
        unsafe {
            let io = std::slice::from_raw_parts_mut(kind.io(h) as *mut f32, 288);
            io[..256].fill(0.5);
            io[256..259].copy_from_slice(&[5.0, 0.0, 0.0]);
            io[272..275].copy_from_slice(&[5.0, 0.0, 0.0]);
            assert_eq!(kind.process(h, 128, 2), 1, "a silent input reports a silent output");
            assert!(io[..256].iter().all(|&x| x == 0.5));
            kind.destroy(h);
        }
    }
}
