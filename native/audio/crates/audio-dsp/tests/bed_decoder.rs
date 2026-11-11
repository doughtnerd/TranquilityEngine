//! The bed decoder against direct convolution (ADR 0162, api-and-models §9 unit row "partitioned
//! decode against direct convolution"; task A2, leaf L-A2b). The reference is the textbook sum
//! `y_e[n] = Σ_c Σ_m h[c][e][m] · x_c[n − m]` in `f64` (`c` over the decoded channels, `m` over the
//! taps, `x_c[k] = 0` for `k < 0`) on the same f32 filters and input; the error is the largest
//! absolute difference over both ears and every frame divided by the largest absolute reference
//! sample, so 1e-6 means a millionth of the signal's peak (the bound of M1's
//! `convolver_direct.rs`; measured ≈ 2.4e-7 here).

// The skeleton's helpers are unused until L-A2b fills the tests; the leaf removes this line.
#![allow(dead_code)]

use audio_dsp::bed_decoder::{BedDecoderN, MaglsFilters, EARS, QUANTUM};
use audio_dsp::hrtf::HrtfScratch;

/// Relative error bound (largest absolute error / largest absolute reference sample).
const TOLERANCE: f64 = 1e-6;
/// Channels of a bed.
const CHANNELS: usize = 16;

/// `n` xorshift32 samples in [-1, 1) from `seed` (as `convolver_direct.rs`).
fn noise(n: usize, seed: u32) -> Vec<f32> {
    todo!("L-A2b: {n} {seed}")
}

/// Runs `quanta` quanta of `input` (`[CHANNELS][quanta * 128]`) through a fresh `BedDecoderN<P>`
/// with filters loaded from `time` (`[16][2][taps]`), decoding `channels` channels; returns the
/// two ears' outputs, each `quanta * 128` long.
fn decode<const P: usize>(time: &[f32], taps: usize, input: &[Vec<f32>], channels: usize, quanta: usize) -> [Vec<f32>; EARS] {
    let _ = (time, taps, input, channels, quanta, MaglsFilters::<P>::ZERO, BedDecoderN::<P>::ZERO, HrtfScratch::new, QUANTUM);
    todo!("L-A2b")
}

/// The f64 direct convolution of the same data (see the module comment).
fn direct(time: &[f32], taps: usize, input: &[Vec<f32>], channels: usize, frames: usize) -> [Vec<f64>; EARS] {
    let _ = (time, taps, input, channels, frames);
    todo!("L-A2b")
}

/// Largest absolute error over both ears divided by the largest absolute reference sample.
fn relative_error(got: &[Vec<f32>; EARS], want: &[Vec<f64>; EARS]) -> f64 {
    let _ = (got, want, CHANNELS);
    todo!("L-A2b")
}

#[test]
#[ignore = "L-A2b"]
fn matches_direct_convolution_with_256_taps() {
    todo!("L-A2b")
}

#[test]
#[ignore = "L-A2b"]
fn matches_direct_convolution_with_512_taps_at_high_rates() {
    todo!("L-A2b")
}

#[test]
#[ignore = "L-A2b"]
fn short_responses_are_zero_padded() {
    todo!("L-A2b")
}

#[test]
#[ignore = "L-A2b"]
fn first_order_decodes_four_channels() {
    todo!("L-A2b")
}

#[test]
#[ignore = "L-A2b"]
fn input_starting_mid_run_matches() {
    todo!("L-A2b")
}
