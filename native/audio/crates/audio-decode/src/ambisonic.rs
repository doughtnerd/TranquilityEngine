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
        match code {
            0 => Some(Convention::AmbiX),
            1 => Some(Convention::FuMa),
            _ => None,
        }
    }
}

/// The ambisonic order of a channel count: 4 gives 1, 9 gives 2, 16 gives 3, anything else `None`.
pub fn order_of(channels: usize) -> Option<u32> {
    match channels {
        4 => Some(1),
        9 => Some(2),
        16 => Some(3),
        _ => None,
    }
}

/// For each AmbiX (ACN) channel `n` in `0..16`, the FuMa channel it reads: AmbiX channel `n` is
/// FuMa channel `FUMA_INDEX_OF_ACN[n]` times `FUMA_TO_SN3D[n]`. An order-`o` file uses the first
/// `(o + 1)^2` entries.
pub const FUMA_INDEX_OF_ACN: [usize; 16] = [0, 2, 3, 1, 8, 6, 4, 5, 7, 15, 13, 11, 9, 10, 12, 14];

/// For each AmbiX (ACN) channel `n` in `0..16`, the MaxN to SN3D weight of its FuMa channel (W √2,
/// first order 1, ...: the FuMa table). Stored as f64 decimals with full precision (`sqrt` isn't
/// `const`); converted to f32 where applied.
pub const FUMA_TO_SN3D: [f64; 16] = [
    1.4142135623730951,  // ACN 0  W: √2
    1.0,                 // ACN 1  Y
    1.0,                 // ACN 2  Z
    1.0,                 // ACN 3  X
    0.86602540378443860, // ACN 4  V: √3/2
    0.86602540378443860, // ACN 5  T: √3/2
    1.0,                 // ACN 6  R
    0.86602540378443860, // ACN 7  S: √3/2
    0.86602540378443860, // ACN 8  U: √3/2
    0.79056941504209488, // ACN 9  Q: √(5/8)
    0.74535599249992990, // ACN 10 O: √5/3
    0.84327404271156781, // ACN 11 M: √(32/45)
    1.0,                 // ACN 12 K
    0.84327404271156781, // ACN 13 L: √(32/45)
    0.74535599249992990, // ACN 14 N: √5/3
    0.79056941504209488, // ACN 15 P: √(5/8)
];

/// The largest of an order's [`FUMA_TO_SN3D`] weights (its first `(order + 1)^2`): the scale the
/// converted samples are divided by, and the import gain the decoder reports. √2 (W's) for orders
/// 1-3. `order` outside 1-3 gives 1.
pub fn headroom_factor(order: u32) -> f64 {
    match order {
        // Every order 1-3 has W's √2 as its largest weight; the others are all ≤ √2.
        1..=3 => std::f64::consts::SQRT_2,
        _ => 1.0,
    }
}

/// Whether an order's [`headroom_factor`] exceeds 4 (api-and-models §2.4: such a clip keeps f32,
/// since int16 would lose more than 2 bits). False for orders 1-3.
pub fn keeps_f32(order: u32) -> bool {
    headroom_factor(order) > 4.0
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
        let order = order_of(channels)?;
        let headroom = headroom_factor(order);
        let keep = keeps_f32(order);
        let mut index = [0usize; 16];
        let mut gain = [0.0f32; 16];
        for n in 0..channels {
            index[n] = FUMA_INDEX_OF_ACN[n];
            gain[n] = if keep {
                FUMA_TO_SN3D[n] as f32
            } else {
                (FUMA_TO_SN3D[n] / headroom) as f32
            };
        }
        Some(FumaToAmbix {
            channels,
            index,
            gain,
            import_gain: if keep { 1.0 } else { headroom as f32 },
        })
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
        keeps_f32(order_of(self.channels).unwrap_or(0))
    }

    /// Converts interleaved FuMa frames in place to AmbiX, scaled into headroom: for each frame,
    /// `out[n] = in[index[n]] * gain[n]` for every AmbiX channel `n` (read the whole frame first:
    /// the reorder overlaps). `samples.len()` is a multiple of `channels` (a trailing partial frame
    /// is left as is). Never allocates.
    pub fn apply(&self, samples: &mut [f32]) {
        let c = self.channels;
        for frame in samples.chunks_exact_mut(c) {
            // Read the whole frame first: the reorder overlaps the writes.
            let mut local = [0.0f32; 16];
            local[..c].copy_from_slice(frame);
            for n in 0..c {
                frame[n] = local[self.index[n]] * self.gain[n];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    /// FuMa channel names, in FuMa order.
    const FUMA_NAMES: [&str; 16] = [
        "W", "X", "Y", "Z", "R", "S", "T", "U", "V", "K", "L", "M", "N", "O", "P", "Q",
    ];
    /// AmbiX channel names, in ACN order.
    const ACN_NAMES: [&str; 16] = [
        "W", "Y", "Z", "X", "V", "T", "R", "S", "U", "Q", "O", "M", "K", "L", "N", "P",
    ];

    /// The textbook MaxN (FuMa) encoding of a plane wave at azimuth `a` (counter-clockwise from
    /// front) and elevation `e`, in FuMa channel order.
    fn fuma_gains(a: f64, e: f64) -> [f64; 16] {
        let (ca, sa) = (a.cos(), a.sin());
        let (c2a, s2a) = ((2.0 * a).cos(), (2.0 * a).sin());
        let (c3a, s3a) = ((3.0 * a).cos(), (3.0 * a).sin());
        let (ce, se) = (e.cos(), e.sin());
        let (s2e, ce2, ce3, se2) = ((2.0 * e).sin(), ce * ce, ce * ce * ce, se * se);
        let l135 = (135.0f64 / 256.0).sqrt();
        let l27 = (27.0f64 / 4.0).sqrt();
        [
            1.0 / 2f64.sqrt(),                  // W
            ca * ce,                            // X
            sa * ce,                            // Y
            se,                                 // Z
            (3.0 * se2 - 1.0) / 2.0,            // R
            ca * s2e,                           // S
            sa * s2e,                           // T
            c2a * ce2,                          // U
            s2a * ce2,                          // V
            se * (5.0 * se2 - 3.0) / 2.0,       // K
            l135 * ca * ce * (5.0 * se2 - 1.0), // L
            l135 * sa * ce * (5.0 * se2 - 1.0), // M
            l27 * c2a * se * ce2,               // N
            l27 * s2a * se * ce2,               // O
            c3a * ce3,                          // P
            s3a * ce3,                          // Q
        ]
    }

    /// The textbook SN3D (AmbiX) encoding of the same plane wave, in ACN channel order.
    fn ambix_gains(a: f64, e: f64) -> [f64; 16] {
        let (ca, sa) = (a.cos(), a.sin());
        let (c2a, s2a) = ((2.0 * a).cos(), (2.0 * a).sin());
        let (c3a, s3a) = ((3.0 * a).cos(), (3.0 * a).sin());
        let (ce, se) = (e.cos(), e.sin());
        let (s2e, ce2, ce3, se2) = ((2.0 * e).sin(), ce * ce, ce * ce * ce, se * se);
        let r3 = 3f64.sqrt() / 2.0;
        let r15 = 15f64.sqrt() / 2.0;
        let r38 = (3f64 / 8.0).sqrt();
        let r58 = (5f64 / 8.0).sqrt();
        [
            1.0,                                    // W
            sa * ce,                                // Y
            se,                                     // Z
            ca * ce,                                // X
            r3 * s2a * ce2,                         // V
            r3 * sa * s2e,                          // T
            (3.0 * se2 - 1.0) / 2.0,                // R
            r3 * ca * s2e,                          // S
            r3 * c2a * ce2,                         // U
            r58 * s3a * ce3,                        // Q
            r15 * s2a * se * ce2,                   // O
            r38 * sa * ce * (5.0 * se2 - 1.0),      // M
            se * (5.0 * se2 - 3.0) / 2.0,           // K
            r38 * ca * ce * (5.0 * se2 - 1.0),      // L
            r15 * c2a * se * ce2,                   // N
            r58 * c3a * ce3,                        // P
        ]
    }

    /// The acceptance (api-and-models §10, B1's FuMa row): a FuMa twin of an AmbiX signal, both
    /// encoded from the same plane-wave directions (azimuths and elevations covering the sphere,
    /// orders 1, 2 and 3) with the textbook FuMa and SN3D formulas, converted by `apply` and
    /// multiplied by `import_gain`, equals the AmbiX encoding within 1e-6 per sample.
    #[test]
    fn a_fuma_twin_equals_ambix_within_1e_6() {
        let amplitudes = [-1.0f64, -0.5, 0.25, 1.0];
        for order in 1..=3u32 {
            let channels = ((order + 1) * (order + 1)) as usize;
            let conv = FumaToAmbix::new(channels).expect("orders 1-3 convert");
            let gain = conv.import_gain() as f64;
            let mut worst = 0.0f64;
            for ai in 0..24 {
                let a = (ai as f64 * 15.0).to_radians();
                for &ed in &[-90.0f64, -60.0, -30.0, 0.0, 30.0, 60.0, 90.0] {
                    let e = ed.to_radians();
                    let fuma = fuma_gains(a, e);
                    let ambix = ambix_gains(a, e);
                    for &s in &amplitudes {
                        let mut frame = [0.0f32; 16];
                        for i in 0..channels {
                            frame[i] = (s * fuma[i]) as f32;
                        }
                        conv.apply(&mut frame[..channels]);
                        for n in 0..channels {
                            let got = frame[n] as f64 * gain;
                            let want = s * ambix[n];
                            worst = worst.max((got - want).abs());
                        }
                    }
                }
            }
            assert!(worst <= 1e-6, "order {order}: worst difference {worst}");
        }
    }

    /// Converted samples of a full-scale FuMa file (every channel at its MaxN extreme) stay within
    /// [-1, 1]: the headroom scale keeps int16 from clipping.
    #[test]
    fn full_scale_fuma_stays_inside_int16_range() {
        // Every sign pattern of the channels at ±1: 2^16 frames for order 3.
        for channels in [4usize, 9, 16] {
            let conv = FumaToAmbix::new(channels).expect("orders 1-3 convert");
            for pattern in 0usize..(1 << channels) {
                let mut frame = [0.0f32; 16];
                for i in 0..channels {
                    frame[i] = if (pattern >> i) & 1 == 1 { -1.0 } else { 1.0 };
                }
                conv.apply(&mut frame[..channels]);
                for (n, &x) in frame[..channels].iter().enumerate() {
                    assert!(
                        x.abs() <= 1.0,
                        "{channels} channels, pattern {pattern:#x}, ACN {n}: {x}"
                    );
                }
            }
        }
    }

    /// `order_of`, `headroom_factor` (√2 for orders 1-3), `keeps_f32` (false for 1-3),
    /// `Convention::from_code` (0, 1, else None) and `FumaToAmbix::new` (Some for 4, 9, 16; None for
    /// 1, 2, 3, 5, 8, 15, 17).
    #[test]
    fn orders_factors_and_codes() {
        assert_eq!(order_of(4), Some(1));
        assert_eq!(order_of(9), Some(2));
        assert_eq!(order_of(16), Some(3));
        for c in [0usize, 1, 2, 3, 5, 8, 15, 17] {
            assert_eq!(order_of(c), None, "channels {c}");
        }

        let sqrt2 = std::f64::consts::SQRT_2;
        for order in 1..=3 {
            assert!((headroom_factor(order) - sqrt2).abs() < 1e-15, "order {order}");
            assert!(!keeps_f32(order), "order {order}");
        }
        for order in [0u32, 4, 5] {
            assert_eq!(headroom_factor(order), 1.0, "order {order}");
            assert!(!keeps_f32(order), "order {order}");
        }

        assert_eq!(Convention::from_code(0), Some(Convention::AmbiX));
        assert_eq!(Convention::from_code(1), Some(Convention::FuMa));
        assert_eq!(Convention::from_code(2), None);
        assert_eq!(Convention::from_code(u32::MAX), None);

        for c in [4usize, 9, 16] {
            let conv = FumaToAmbix::new(c).expect("orders 1-3 convert");
            assert_eq!(conv.channels(), c);
            assert_eq!(conv.import_gain(), sqrt2 as f32);
            assert!(!conv.keeps_f32());
        }
        for c in [1usize, 2, 3, 5, 8, 15, 17] {
            assert!(FumaToAmbix::new(c).is_none(), "channels {c}");
        }
    }

    /// The tables: `FUMA_INDEX_OF_ACN` is a permutation of 0..16 whose first 4 and 9 entries are
    /// permutations of 0..4 and 0..9; each weight matches its closed form (√2, 1, √3/2, √(32/45),
    /// √5/3, √(5/8)) within 1e-15.
    #[test]
    fn the_tables_match_the_fuma_table() {
        let mut sorted = FUMA_INDEX_OF_ACN;
        sorted.sort_unstable();
        assert_eq!(sorted, core::array::from_fn(|i| i), "a permutation of 0..16");
        for (order_channels, name) in [(4usize, "first order"), (9, "second order")] {
            let mut head: Vec<usize> = FUMA_INDEX_OF_ACN[..order_channels].to_vec();
            head.sort_unstable();
            assert_eq!(head, (0..order_channels).collect::<Vec<_>>(), "{name}");
        }
        for n in 0..16 {
            assert_eq!(
                FUMA_NAMES[FUMA_INDEX_OF_ACN[n]],
                ACN_NAMES[n],
                "ACN {n} reads the wrong FuMa channel"
            );
        }

        let s = |x: f64| x.sqrt();
        let expected: [f64; 16] = [
            s(2.0),
            1.0,
            1.0,
            1.0,
            s(3.0) / 2.0,
            s(3.0) / 2.0,
            1.0,
            s(3.0) / 2.0,
            s(3.0) / 2.0,
            s(5.0 / 8.0),
            s(5.0) / 3.0,
            s(32.0 / 45.0),
            1.0,
            s(32.0 / 45.0),
            s(5.0) / 3.0,
            s(5.0 / 8.0),
        ];
        for n in 0..16 {
            assert!(
                (FUMA_TO_SN3D[n] - expected[n]).abs() <= 1e-15,
                "ACN {n}: {} vs {}",
                FUMA_TO_SN3D[n],
                expected[n]
            );
        }
    }
}
