//! FuMa to AmbiX conversion in the decoder (ADR 0162, api-and-models §2.4 and §5.1; owner O1):
//! the channel reorder and the SN3D scaling into int16 headroom, applied in the decode loop before
//! the int16 rounding of `read_i16`, per chunk in the worker (`STREAM_OPEN.convention`, C6).
//!
//! **FuMa** (Furse-Malham, B-format) orders its channels `W X Y Z R S T U V K L M N O P Q` and
//! normalises them MaxN, with `W` at 1/√2. **AmbiX** orders them by ACN (`W Y Z X V T R S U Q O M
//! K L N P`) and normalises them SN3D. Converting is a reorder and one weight per channel
//! ([`FUMA_INDEX_OF_ACN`], [`FUMA_TO_SN3D`]). `W`'s weight √2 lifts it above full scale for a loud
//! file, so the converted samples are scaled **down by the order's largest weight**
//! ([`headroom_factor`]) and the decoder reports that factor as the clip's import gain: main
//! multiplies the clip's import volume by it, and the clip stays int16 at no loss of range. An
//! order whose factor exceeded 4 would keep f32 instead ([`keeps_f32`]); for orders 1-3 the
//! factor is √2 (W's), so none does.
//!
//! Nothing here allocates; [`FumaToAmbix::apply`] runs on every decoded packet.

/// The ambisonic channel convention of a file (the sidecar's `ambisonic.convention`; ABI code 0
/// AmbiX, 1 FuMa).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Convention {
    /// ACN order, SN3D: what the engine plays; nothing to convert.
    AmbiX,
    /// Furse-Malham order, MaxN: converted to AmbiX while decoding.
    FuMa,
}

impl Convention {
    /// The ABI's code: 0 AmbiX, 1 FuMa; anything else `None`.
    pub fn from_code(code: u32) -> Option<Convention> {
        let _ = code;
        todo!("L-B2b")
    }
}

/// The ambisonic order of a channel count: 4 gives 1, 9 gives 2, 16 gives 3, anything else `None`.
pub fn order_of(channels: usize) -> Option<u32> {
    let _ = channels;
    todo!("L-B2b")
}

/// For each AmbiX (ACN) channel `n` in `0..16`, the FuMa channel it reads: AmbiX channel `n` is
/// FuMa channel `FUMA_INDEX_OF_ACN[n]` times `FUMA_TO_SN3D[n]`. An order-`o` file uses the first
/// `(o + 1)^2` entries.
pub const FUMA_INDEX_OF_ACN: [usize; 16] = [0; 16]; // L-B2b: fill from the FuMa table

/// For each AmbiX (ACN) channel `n` in `0..16`, the MaxN to SN3D weight of its FuMa channel (W √2,
/// first order 1, ...: the FuMa table). Stored as f64 decimals with full precision (`sqrt` isn't
/// `const`); converted to f32 where applied.
pub const FUMA_TO_SN3D: [f64; 16] = [0.0; 16]; // L-B2b: fill from the FuMa table

/// The largest of an order's [`FUMA_TO_SN3D`] weights (its first `(order + 1)^2`): the scale the
/// converted samples are divided by, and the import gain the decoder reports. √2 (W's) for orders
/// 1-3. `order` outside 1-3 gives 1.
pub fn headroom_factor(order: u32) -> f64 {
    let _ = order;
    todo!("L-B2b")
}

/// Whether an order's [`headroom_factor`] exceeds 4 (api-and-models §2.4: such a clip keeps f32,
/// since int16 would lose more than 2 bits). False for orders 1-3.
pub fn keeps_f32(order: u32) -> bool {
    let _ = order;
    todo!("L-B2b")
}

/// A FuMa to AmbiX conversion for one channel count, built once per decoder.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct FumaToAmbix {
    /// 4, 9 or 16.
    channels: usize,
    /// The FuMa channel each AmbiX channel reads (the first `channels` of [`FUMA_INDEX_OF_ACN`]).
    index: [usize; 16],
    /// Each AmbiX channel's weight, already divided by the headroom factor (unless [`keeps_f32`]),
    /// as f32.
    gain: [f32; 16],
    /// What main multiplies the clip's import volume by: [`headroom_factor`], or 1 when the
    /// order [`keeps_f32`].
    import_gain: f32,
}

impl FumaToAmbix {
    /// The conversion for a file of `channels` channels: `Some` for 4, 9 or 16 (orders 1-3), else
    /// `None` (a clip of another channel count isn't ambisonic: the caller leaves it as decoded).
    pub fn new(channels: usize) -> Option<FumaToAmbix> {
        let _ = channels;
        todo!("L-B2b")
    }

    /// Channels per frame (4, 9 or 16).
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// The factor the converted samples were scaled down by, which main folds into the clip's
    /// import volume (√2 for orders 1-3; 1 for an order that [`keeps_f32`]).
    pub fn import_gain(&self) -> f32 {
        self.import_gain
    }

    /// Whether the clip keeps f32 ([`keeps_f32`] of its order; false for orders 1-3).
    pub fn keeps_f32(&self) -> bool {
        let _ = self;
        todo!("L-B2b")
    }

    /// Converts interleaved FuMa frames in place to AmbiX, scaled into headroom: for each frame,
    /// `out[n] = in[index[n]] * gain[n]` for every AmbiX channel `n` (read the whole frame first:
    /// the reorder overlaps). `samples.len()` is a multiple of `channels` (a trailing partial frame
    /// is left as is). Never allocates.
    pub fn apply(&self, samples: &mut [f32]) {
        let _ = samples;
        todo!("L-B2b")
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    /// The acceptance (api-and-models §10, B1's FuMa row): a FuMa twin of an AmbiX signal, both
    /// encoded from the same plane-wave directions (azimuths and elevations covering the sphere,
    /// orders 1, 2 and 3) with the textbook FuMa and SN3D formulas, converted by `apply` and
    /// multiplied by `import_gain`, equals the AmbiX encoding within 1e-6 per sample.
    #[test]
    #[ignore = "L-B2b"]
    fn a_fuma_twin_equals_ambix_within_1e_6() {
        todo!("L-B2b")
    }

    /// Converted samples of a full-scale FuMa file (every channel at its MaxN extreme) stay within
    /// [-1, 1]: the headroom scale keeps int16 from clipping.
    #[test]
    #[ignore = "L-B2b"]
    fn full_scale_fuma_stays_inside_int16_range() {
        todo!("L-B2b")
    }

    /// `order_of`, `headroom_factor` (√2 for orders 1-3), `keeps_f32` (false for 1-3),
    /// `Convention::from_code` (0, 1, else None) and `FumaToAmbix::new` (Some for 4, 9, 16; None for
    /// 1, 2, 3, 5, 8, 15, 17).
    #[test]
    #[ignore = "L-B2b"]
    fn orders_factors_and_codes() {
        todo!("L-B2b")
    }

    /// The tables: `FUMA_INDEX_OF_ACN` is a permutation of 0..16 whose first 4 and 9 entries are
    /// permutations of 0..4 and 0..9; each weight matches its closed form (√2, 1, √3/2, √(32/45),
    /// √5/3, √(5/8)) within 1e-15.
    #[test]
    #[ignore = "L-B2b"]
    fn the_tables_match_the_fuma_table() {
        todo!("L-B2b")
    }
}
