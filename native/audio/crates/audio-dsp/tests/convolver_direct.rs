//! The shared reverb against direct convolution (ADR 0157, api-and-models §9 row A2.2b: "matches
//! direct convolution to 1e-6"). The reference is the textbook sum `y[n] = Σ h[m] x[n - m]` in
//! `f64` over the generated, normalised response (`convolver::ir`); the error is the largest
//! absolute difference divided by the largest absolute reference sample, so 1e-6 means a
//! millionth of the signal's peak.

use audio_dsp::convolver::{self, ir, HEAD_FRAMES, QUANTUM, TAIL_BLOCK};

/// The bound the acceptance row sets.
const TOLERANCE: f64 = 1e-6;

/// A zeroed region for `sample_rate`, initialised (8-byte aligned through `u64`).
struct Region(Vec<u64>);

impl Region {
    fn new(sample_rate: f32) -> Self {
        let mut r = Region(vec![0u64; convolver::region_bytes(sample_rate).div_ceil(8)]);
        convolver::init(r.bytes(), sample_rate);
        r
    }
    fn bytes(&mut self) -> &mut [u8] {
        // SAFETY: a u64 buffer viewed as its bytes.
        unsafe { core::slice::from_raw_parts_mut(self.0.as_mut_ptr() as *mut u8, self.0.len() * 8) }
    }
}

fn noise(n: usize, mut s: u32) -> Vec<f32> {
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s as f32 / u32::MAX as f32) * 2.0 - 1.0
        })
        .collect()
}

/// The scaled response, per channel, in f64 (each sample `f32 * scale` as the convolver bakes it).
fn response(sample_rate: f32) -> [Vec<f64>; 2] {
    let n = ir::frames(sample_rate);
    let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
    ir::generate(sample_rate, &mut l, &mut r);
    let scale = ir::normalization_scale(sample_rate);
    [l.iter().map(|v| (v * scale) as f64).collect(), r.iter().map(|v| (v * scale) as f64).collect()]
}

/// Runs the convolver over `input` (per channel, a whole number of quanta); returns the wet output.
fn render(sample_rate: f32, input: &[Vec<f32>; 2]) -> [Vec<f32>; 2] {
    let mut region = Region::new(sample_rate);
    let n = input[0].len();
    let mut out = [vec![0.0f32; n], vec![0.0f32; n]];
    let (ol, or) = out.split_at_mut(1);
    for q in 0..n / QUANTUM {
        let span = q * QUANTUM..(q + 1) * QUANTUM;
        convolver::process(region.bytes(), &input[0][span.clone()], &input[1][span.clone()], &mut ol[0][span.clone()], &mut or[0][span]);
    }
    out
}

fn direct(h: &[f64], x: &[f32], n: usize) -> f64 {
    (0..h.len().min(n + 1)).map(|m| h[m] * x[n - m] as f64).sum()
}

/// Largest |got - want| over the peak |want| for the frames in `at`.
fn relative_error(h: &[f64], x: &[f32], got: &[f32], at: impl Iterator<Item = usize>) -> (f64, f64) {
    let (mut err, mut peak) = (0.0f64, 0.0f64);
    for n in at {
        let want = direct(h, x, n);
        err = err.max((got[n] as f64 - want).abs());
        peak = peak.max(want.abs());
    }
    (err / peak, peak)
}

#[test]
fn an_impulse_returns_the_response_at_its_frame() {
    // Deltas at frame 0 (left) and frame 1,000 (right, off the quantum and block grid) bring the
    // whole response back: head, every tail stage, the accumulation buffer's wrap.
    let sr = 48_000.0;
    let h = response(sr);
    let len = h[0].len();
    let n = (len + 1_000 + 2 * TAIL_BLOCK).div_ceil(QUANTUM) * QUANTUM;
    let mut input = [vec![0.0f32; n], vec![0.0f32; n]];
    input[0][0] = 1.0;
    input[1][1_000] = 1.0;
    let out = render(sr, &input);
    for (c, offset) in [(0, 0usize), (1, 1_000)] {
        let peak = h[c].iter().fold(0.0f64, |a, v| a.max(v.abs()));
        let mut err = 0.0f64;
        for t in 0..n {
            let want = if t >= offset && t - offset < len { h[c][t - offset] } else { 0.0 };
            err = err.max((out[c][t] as f64 - want).abs());
        }
        let rel = err / peak;
        println!("impulse channel {c}: relative error {rel:.3e} (peak {peak:.4})");
        assert!(rel <= TOLERANCE, "channel {c}: {rel:e}");
    }
}

#[test]
fn noise_matches_direct_convolution_at_48k() {
    // Noise through the full 1.8 s response; the reference is checked on a spread of frames
    // (every 61st, so every quantum position and stage boundary is crossed) to keep it fast.
    let sr = 48_000.0;
    let h = response(sr);
    let n = (h[0].len() + 3 * TAIL_BLOCK).div_ceil(QUANTUM) * QUANTUM;
    let input = [noise(n, 0x1234_5678), noise(n, 0x0BAD_F00D)];
    let out = render(sr, &input);
    for c in 0..2 {
        let (rel, peak) = relative_error(&h[c], &input[c], &out[c], (0..n).step_by(61));
        println!("noise 48 kHz channel {c}: relative error {rel:.3e} (peak {peak:.4})");
        assert!(rel <= TOLERANCE, "channel {c}: {rel:e}");
    }
}

#[test]
fn every_frame_matches_at_a_low_rate() {
    // At 8 kHz the response is 14,400 frames (the head and 6 tail stages): every output frame is
    // checked, with a signal that starts late and stops early, so the tail rings out.
    let sr = 8_000.0;
    let h = response(sr);
    assert_eq!(h[0].len(), 14_400);
    let n = (h[0].len() + HEAD_FRAMES + 4 * TAIL_BLOCK).div_ceil(QUANTUM) * QUANTUM;
    let mut input = [noise(n, 7), noise(n, 99)];
    for x in input.iter_mut() {
        x[..300].fill(0.0);
        x[6_000..].fill(0.0);
    }
    let out = render(sr, &input);
    for c in 0..2 {
        let (rel, peak) = relative_error(&h[c], &input[c], &out[c], 0..n);
        println!("noise 8 kHz channel {c}: relative error {rel:.3e} (peak {peak:.4})");
        assert!(rel <= TOLERANCE, "channel {c}: {rel:e}");
    }
}

#[test]
fn reset_clears_the_tail_and_keeps_the_response() {
    let sr = 16_000.0;
    let n = 40 * QUANTUM;
    let input = [noise(n, 3), noise(n, 4)];
    let silence = [0.0f32; QUANTUM];
    let mut region = Region::new(sr);
    let mut first = [vec![0.0f32; n], vec![0.0f32; n]];
    let mut again = [vec![0.0f32; n], vec![0.0f32; n]];
    for out in [&mut first, &mut again] {
        let (ol, or) = out.split_at_mut(1);
        for q in 0..n / QUANTUM {
            let s = q * QUANTUM..(q + 1) * QUANTUM;
            convolver::process(region.bytes(), &input[0][s.clone()], &input[1][s.clone()], &mut ol[0][s.clone()], &mut or[0][s]);
        }
        convolver::reset(region.bytes());
        // After RESET, silence in gives silence out: no tail left.
        let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
        for _ in 0..40 {
            convolver::process(region.bytes(), &silence, &silence, &mut l, &mut r);
        }
        assert!(l.iter().chain(&r).all(|v| *v == 0.0));
        convolver::reset(region.bytes());
    }
    assert_eq!(first, again, "the same input after RESET renders the same output");
    assert!(first[0].iter().any(|v| *v != 0.0));
}

#[test]
fn other_sample_rates_and_odd_lengths_initialise() {
    for sr in [3_000.0f32, 22_050.0, 44_100.0, 96_000.0] {
        let frames = ir::frames(sr);
        let mut region = Region::new(sr);
        let mut input = [0.0f32; QUANTUM];
        input[0] = 1.0;
        let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
        convolver::process(region.bytes(), &input, &input, &mut l, &mut r);
        let h = response(sr);
        for t in 0..QUANTUM.min(frames) {
            assert!((l[t] as f64 - h[0][t]).abs() < 1e-6 && (r[t] as f64 - h[1][t]).abs() < 1e-6, "{sr} Hz frame {t}");
        }
    }
    // Wrong lengths do nothing.
    let mut region = Region::new(48_000.0);
    let (mut l, mut r) = ([0.5f32; 64], [0.5f32; 64]);
    convolver::process(region.bytes(), &[1.0; 64], &[1.0; 64], &mut l, &mut r);
    assert_eq!((l, r), ([0.5; 64], [0.5; 64]));
}
