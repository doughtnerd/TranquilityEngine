//! The bed decoder (ADR 0162, api-and-models §5.1, architecture §3.1): decodes a 16-channel
//! order-3 ambisonic bed to binaural stereo (the MagLS virtual-speaker path, R9) or, with
//! `audio.spatial: "equalPower"`, through the baked 16 to 2 matrix of `bed_matrix.rs`.
//!
//! Skeleton declared by K2 (task A1); task A2 fills it. Nothing allocates while processing.
