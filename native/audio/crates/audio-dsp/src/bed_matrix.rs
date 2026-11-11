//! The baked 16 to 2 ambisonic decode matrix (ADR 0162 R9, api-and-models §5.1 and its build-plan
//! additions, architecture §4.2): decodes an order-3 bed (AmbiX: ACN order, SN3D) to equal-power
//! stereo while the MagLS filters (`src/engine/audio/magls-o3.bin`, format 4) aren't resident or
//! failed to load, and always in `audio.spatial: "equalPower"`. Split from `ambisonic.rs` so A2 and
//! A3 never share a file.
//!
//! The numbers are baked offline by `native/audio/tools/bake-magls/` (`--print-matrix`; its
//! `--check` fails if this table drifts from the design): the least-squares fit of
//! `EqualPowerPanner`'s mono gains over a sphere and the horizontal circle, the right row the left
//! one mirrored. An order-3 projection can't follow the panner's fold at ±90°, so the decode is
//! within 2 dB of the panner everywhere on the horizontal plane except within 10° of the fold
//! (§9; `tests/bed_matrix.rs`). Only ACN channels 0, 1, 6, 8, 9 and 11 are non-zero: the panner's
//! law is even front to back and up to down.
//!
//! Nothing allocates; plain `f32` products in a fixed order, so native and wasm agree bit for bit.

/// Bed channels (order 3).
pub const BED_CHANNELS: usize = 16;

/// `BED_MATRIX[ear][channel]`: ear 0 left, 1 right; channels in ACN order, SN3D.
#[rustfmt::skip]
pub const BED_MATRIX: [[f32; 16]; 2] = [
    // left
    [
        0.63653404,
        0.51330256,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.00022494364,
        0.0,
        0.10653808,
        -0.050181344,
        0.0,
        0.15963186,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
    // right
    [
        0.63653404,
        -0.51330256,
        0.0,
        0.0,
        0.0,
        0.0,
        -0.00022494364,
        0.0,
        0.10653808,
        0.050181344,
        0.0,
        -0.15963186,
        0.0,
        0.0,
        0.0,
        0.0,
    ],
];

/// The `(left, right)` gains the matrix gives a source encoded with the 16 SN3D gains `encoded`
/// (`Σ_c BED_MATRIX[ear][c] · encoded[c]`, summed in channel order).
#[inline]
pub fn gains(encoded: &[f32; BED_CHANNELS]) -> (f32, f32) {
    let (mut l, mut r) = (0.0f32, 0.0f32);
    for (c, &e) in encoded.iter().enumerate() {
        l += BED_MATRIX[0][c] * e;
        r += BED_MATRIX[1][c] * e;
    }
    (l, r)
}

/// Decodes `frames` frames of the planar bed `bed` (channel `c` at `bed[c * frames..][..frames]`)
/// and **adds** them into `l[..frames]` and `r[..frames]`. Channels whose gains are zero are
/// skipped. Does nothing if `bed` is shorter than `16 * frames` or an output shorter than `frames`.
pub fn decode_add(bed: &[f32], frames: usize, l: &mut [f32], r: &mut [f32]) {
    if bed.len() < BED_CHANNELS * frames || l.len() < frames || r.len() < frames {
        return;
    }
    let (l, r) = (&mut l[..frames], &mut r[..frames]);
    for c in 0..BED_CHANNELS {
        let (gl, gr) = (BED_MATRIX[0][c], BED_MATRIX[1][c]);
        if gl == 0.0 && gr == 0.0 {
            continue;
        }
        let x = &bed[c * frames..(c + 1) * frames];
        for i in 0..frames {
            l[i] += gl * x[i];
            r[i] += gr * x[i];
        }
    }
}
