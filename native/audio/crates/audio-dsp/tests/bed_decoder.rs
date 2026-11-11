//! The bed decoder against direct convolution (ADR 0162, api-and-models §9 unit row "partitioned
//! decode against direct convolution"; task A2, leaf L-A2b). The reference is the textbook sum
//! `y_e[n] = Σ_c Σ_m h[c][e][m] · x_c[n − m]` in `f64` (`c` over the decoded channels, `m` over the
//! taps, `x_c[k] = 0` for `k < 0`) on the same f32 filters and input; the error is the largest
//! absolute difference over both ears and every frame divided by the largest absolute reference
//! sample, so 1e-6 means a millionth of the signal's peak (the bound of M1's
//! `convolver_direct.rs`; measured ≈ 2.4e-7 here).

use audio_dsp::bed_decoder::{BedDecoderN, MaglsFilters, EARS, QUANTUM};
use audio_dsp::hrtf::HrtfScratch;

/// Relative error bound (largest absolute error / largest absolute reference sample).
const TOLERANCE: f64 = 1e-6;
/// Channels of a bed.
const CHANNELS: usize = 16;

/// `n` xorshift32 samples in [-1, 1) from `seed` (as `convolver_direct.rs`).
fn noise(n: usize, seed: u32) -> Vec<f32> {
    let mut s = seed;
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s as f32 / u32::MAX as f32) * 2.0 - 1.0
        })
        .collect()
}

/// Runs `quanta` quanta of `input` (`[CHANNELS][quanta * 128]`) through a fresh `BedDecoderN<P>`
/// with filters loaded from `time` (`[16][2][taps]`), decoding `channels` channels; returns the
/// two ears' outputs, each `quanta * 128` long.
fn decode<const P: usize>(time: &[f32], taps: usize, input: &[Vec<f32>], channels: usize, quanta: usize) -> [Vec<f32>; EARS] {
    let mut filters = Box::new(MaglsFilters::<P>::ZERO);
    filters.load(time, taps, &mut HrtfScratch::new()).unwrap();
    let mut decoder = Box::new(BedDecoderN::<P>::ZERO);
    let mut scratch = HrtfScratch::new();
    let mut out = [Vec::with_capacity(quanta * QUANTUM), Vec::with_capacity(quanta * QUANTUM)];
    for q in 0..quanta {
        let mut bed = [[0.0f32; QUANTUM]; CHANNELS];
        for (c, ch) in bed.iter_mut().enumerate() {
            ch.copy_from_slice(&input[c][q * QUANTUM..(q + 1) * QUANTUM]);
        }
        let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
        decoder.process(&bed, channels, &filters, &mut scratch, &mut l, &mut r);
        out[0].extend_from_slice(&l);
        out[1].extend_from_slice(&r);
    }
    out
}

/// The f64 direct convolution of the same data (see the module comment).
fn direct(time: &[f32], taps: usize, input: &[Vec<f32>], channels: usize, frames: usize) -> [Vec<f64>; EARS] {
    let mut out = [vec![0.0f64; frames], vec![0.0f64; frames]];
    for (e, ear) in out.iter_mut().enumerate() {
        for (n, y) in ear.iter_mut().enumerate() {
            let mut acc = 0.0f64;
            for c in 0..channels {
                for m in 0..taps.min(n + 1) {
                    acc += time[(c * EARS + e) * taps + m] as f64 * input[c][n - m] as f64;
                }
            }
            *y = acc;
        }
    }
    out
}

/// Largest absolute error over both ears divided by the largest absolute reference sample.
fn relative_error(got: &[Vec<f32>; EARS], want: &[Vec<f64>; EARS]) -> f64 {
    let (mut err, mut peak) = (0.0f64, 0.0f64);
    for e in 0..EARS {
        assert_eq!(got[e].len(), want[e].len());
        for (g, w) in got[e].iter().zip(&want[e]) {
            err = err.max((*g as f64 - w).abs());
            peak = peak.max(w.abs());
        }
    }
    err / peak
}

/// Filters `[16][2][taps]` of xorshift noise × 0.1.
fn filters(taps: usize, seed: u32) -> Vec<f32> {
    noise(CHANNELS * EARS * taps, seed).iter().map(|v| v * 0.1).collect()
}

/// Per-channel input of `quanta` quanta, distinct noise per channel.
fn bed_input(quanta: usize) -> Vec<Vec<f32>> {
    (0..CHANNELS).map(|c| noise(quanta * QUANTUM, 0x5EED_0000 + c as u32 + 1)).collect()
}

#[test]
fn matches_direct_convolution_with_256_taps() {
    let (taps, quanta) = (256, 32);
    let time = filters(taps, 0xF117_0001);
    let input = bed_input(quanta);
    let got = decode::<2>(&time, taps, &input, CHANNELS, quanta);
    let want = direct(&time, taps, &input, CHANNELS, quanta * QUANTUM);
    let err = relative_error(&got, &want);
    assert!(err <= TOLERANCE, "matches_direct_convolution_with_256_taps: relative error {err:e} > {TOLERANCE:e}");
}

#[test]
fn matches_direct_convolution_with_512_taps_at_high_rates() {
    let (taps, quanta) = (512, 32);
    let time = filters(taps, 0xF117_0002);
    let input = bed_input(quanta);
    let got = decode::<4>(&time, taps, &input, CHANNELS, quanta);
    let want = direct(&time, taps, &input, CHANNELS, quanta * QUANTUM);
    let err = relative_error(&got, &want);
    assert!(err <= TOLERANCE, "matches_direct_convolution_with_512_taps_at_high_rates: relative error {err:e} > {TOLERANCE:e}");
}

#[test]
fn short_responses_are_zero_padded() {
    let (taps, quanta) = (200, 32);
    let time = filters(taps, 0xF117_0003);
    let input = bed_input(quanta);
    let got = decode::<2>(&time, taps, &input, CHANNELS, quanta);
    let want = direct(&time, taps, &input, CHANNELS, quanta * QUANTUM);
    let err = relative_error(&got, &want);
    assert!(err <= TOLERANCE, "short_responses_are_zero_padded: relative error {err:e} > {TOLERANCE:e}");
}

#[test]
fn first_order_decodes_four_channels() {
    // Bed channels 4..16 hold nonzero noise; the decoder must read only channels 0..4.
    let (taps, quanta, channels) = (256, 32, 4);
    let time = filters(taps, 0xF117_0004);
    let input = bed_input(quanta);
    let got = decode::<2>(&time, taps, &input, channels, quanta);
    let want = direct(&time, taps, &input, channels, quanta * QUANTUM);
    let err = relative_error(&got, &want);
    assert!(err <= TOLERANCE, "first_order_decodes_four_channels: relative error {err:e} > {TOLERANCE:e}");
}

#[test]
fn input_starting_mid_run_matches() {
    // Every channel is silent for the first 5 quanta, then noise; the reference uses the same input.
    let (taps, quanta) = (256, 32);
    let time = filters(taps, 0xF117_0005);
    let mut input = bed_input(quanta);
    for ch in input.iter_mut() {
        ch[..5 * QUANTUM].fill(0.0);
    }
    let got = decode::<2>(&time, taps, &input, CHANNELS, quanta);
    let want = direct(&time, taps, &input, CHANNELS, quanta * QUANTUM);
    let err = relative_error(&got, &want);
    assert!(err <= TOLERANCE, "input_starting_mid_run_matches: relative error {err:e} > {TOLERANCE:e}");
}
