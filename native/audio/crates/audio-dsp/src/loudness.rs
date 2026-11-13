//! Loudness kernels (ADR 0171 §§ loudness, amended by 0172; architecture §4.4; spike S1): K-weighting
//! in f64 (two biquads, coefficients from the core's rate), the L + R mean-square accumulator per
//! sub-block of round(0.1 × rate) frames, and 4× true peak (48 taps, simd128 on wasm), after
//! libebur128's formulas (MIT notice kept with the port).
//!
//! **Who fills it.** Ld1 (M5b): the kernels and spike S1's 189 checks as cargo tests (native and
//! wasm, 48 and 44.1 kHz). The per-meter state (1,512 B, ARCH §5.3) is a type of this module, so
//! `audio-core`'s `loudness.rs` (Ld2) holds it in the core's loudness region. Empty until Ld1
//! (K1 declares it).
//!
//! Rules as for every module of this crate: transcendentals through `libm`; nothing allocates.
