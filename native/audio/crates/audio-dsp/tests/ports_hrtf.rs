// SPDX-License-Identifier: Apache-2.0 OR MIT
//! H1 acceptance (api-and-models §5, the `hrtf` port row; task H1-L3): the HRTF port matches
//! Chromium's formulas on fixed azimuth/elevation sweeps, to float rounding.
//!
//! The references here are independent of the port: kernels from Chromium's formulas in f64 with a
//! naive DFT, the delay line from `Delay::ProcessKRate`, and a direct (time-domain) convolution.
//! They read a synthetic `format = 2` table built in this file (the real Composite data is H2's).
//! Two documented differences from Chromium are part of the reference: no convolver latency, and
//! a kernel set that starts convolving filters the full input history.

#![allow(dead_code)]

/// Comparison tolerance, relative to the reference's peak magnitude (at least 1.0).
const TOL: f64 = 2e-5;

/// A synthetic table: the encoded bytes plus the values that went in.
struct SyntheticDb {
    bytes: Vec<u8>,
    rate: f32,
    ir_length: usize,
    /// `d * 2 + ear`, frames.
    delays: Vec<f32>,
    /// Direction-major, interleaved (left, right).
    irs: Vec<i16>,
}

/// Builds a deterministic synthetic table at `rate` with `ir_length`-frame responses.
fn synthetic_db(rate: f32, ir_length: usize, seed: u32) -> SyntheticDb {
    let _ = (rate, ir_length, seed);
    todo!("H1-L3")
}

#[test]
#[ignore = "H1-L3"]
fn reference_delay_line_matches_hand_values() {}

#[test]
#[ignore = "H1-L3"]
fn reference_kernel_of_a_raw_azimuth_is_the_faded_response() {}

#[test]
#[ignore = "H1-L3"]
fn reference_interpolated_kernel_at_identical_raw_responses_is_that_response() {}

#[test]
#[ignore = "H1-L3"]
fn kernel_responses_match_reference_at_raw_azimuths() {}

#[test]
#[ignore = "H1-L3"]
fn kernel_responses_match_reference_at_interpolated_azimuths() {}

#[test]
#[ignore = "H1-L3"]
fn kernel_frame_delays_match_reference() {}

#[test]
#[ignore = "H1-L3"]
fn fixed_azimuth_sweep_at_elevation_0_matches_reference() {}

#[test]
#[ignore = "H1-L3"]
fn fixed_elevation_sweep_matches_reference() {}

#[test]
#[ignore = "H1-L3"]
fn stereo_source_matches_reference() {}

#[test]
#[ignore = "H1-L3"]
fn short_responses_are_zero_padded() {}

#[test]
#[ignore = "H1-L3"]
fn rate_96k_uses_four_partitions_and_matches_reference() {}

#[test]
#[ignore = "H1-L3"]
fn crossfade_on_a_direction_change_matches_reference() {}

#[test]
#[ignore = "H1-L3"]
fn at_most_four_kernel_computations_per_quantum() {}
