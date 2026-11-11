// SPDX-License-Identifier: Apache-2.0 OR MIT
//! The generated zone impulse responses (ADR 0162 R10, api-and-models §2.3): `room`, `corridor`,
//! `hall`, `cave` and `open`, each `{ rt60 s, hfDamping, predelayMs }`. The decoder worker generates
//! them (`myco_ir_generate`, task C2a) at the context rate and prepares them like any zone IR (trim,
//! cut, the shared reverb's normalisation, partition), so main never holds a time-domain IR.
//!
//! **Sample `i` of channel `c`** at `sample_rate` (`frames` from [`frames`], `pre =
//! floor(sample_rate * predelay_ms / 1000)` frames of predelay; channel 0's samples are generated
//! first, then channel 1's, from one generator, as `ir.rs`): for `i < pre` the sample is exactly 0
//! and nothing is drawn. For `i >= pre`, with `t = (i - pre) / sample_rate` seconds, in `f64`:
//! - `noise = (u / 2^32) * 2 - 1`, `u` the next output of mulberry32 seeded with [`seed`]`(preset)`
//!   (the same arithmetic as `ir.rs`'s generator);
//! - a one-pole low-pass splits it at [`CROSSOVER_HZ`]: `lp += a * (noise - lp)` with
//!   `a = 1 - exp(-2π · CROSSOVER_HZ / sample_rate)`, `lp` starting at 0 for each channel;
//!   `hp = noise - lp`;
//! - each band decays by 60 dB over its own reverberation time: `env(t, T) = exp(-3 ln(10) t / T)`,
//!   the low band over `rt60`, the high band over `max(rt60 * (1 - hf_damping), MIN_HF_RT60)`;
//! - the sample is `(lp * env(t, rt60) + hp * env(t, rt60_hf)) as f32`.
//!
//! So at `t = 0` the sample is exactly the noise draw, the response is silent for its predelay, the
//! low band reaches -60 dB at `predelay + rt60` (the response's end), and the high band dies sooner
//! as `hf_damping` grows (air and soft surfaces absorb highs first, as every algorithmic reverb's
//! "HF damping" or "high cut" models). Transcendentals go through `libm`, so native and wasm agree.
//! Nothing allocates.

use super::ir::{MAX_SAMPLE_RATE, SEED};

/// One generated response's parameters (R10).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Preset {
    /// The name the zone's `ir` setting uses.
    pub name: &'static str,
    /// Seconds for the low band to fall 60 dB.
    pub rt60: f64,
    /// 0..1: how much shorter the high band's decay is (`rt60 * (1 - hf_damping)`).
    pub hf_damping: f64,
    /// Silence before the response, in milliseconds.
    pub predelay_ms: f64,
}

/// The presets in code order (`myco_ir_generate`'s `preset` is the index): api-and-models §2.3.
pub const PRESETS: [Preset; 5] = [
    Preset { name: "room", rt60: 0.45, hf_damping: 0.5, predelay_ms: 4.0 },
    Preset { name: "corridor", rt60: 1.1, hf_damping: 0.6, predelay_ms: 6.0 },
    Preset { name: "hall", rt60: 2.2, hf_damping: 0.4, predelay_ms: 18.0 },
    Preset { name: "cave", rt60: 3.6, hf_damping: 0.3, predelay_ms: 30.0 },
    Preset { name: "open", rt60: 0.9, hf_damping: 0.8, predelay_ms: 40.0 },
];

/// The band split's corner frequency.
pub const CROSSOVER_HZ: f64 = 2_000.0;
/// The shortest high-band decay, seconds (so `hf_damping` 1 still decays rather than vanishing).
pub const MIN_HF_RT60: f64 = 0.05;

/// The index of the preset named `name` (exact, lower case), or `None`.
pub fn index_of(name: &str) -> Option<u32> {
    let _ = name;
    todo!("L-C2aa")
}

/// mulberry32's seed for preset `preset`: `SEED.wrapping_add(1 + preset)` (`ir.rs`'s seed plus one
/// plus the index, so no preset repeats the shared reverb's noise).
pub const fn seed(preset: u32) -> u32 {
    SEED.wrapping_add(1).wrapping_add(preset)
}

/// Frames per channel of preset `preset` at `sample_rate`: `round(sample_rate * (predelay_ms /
/// 1000 + rt60))` (in `f64`; round half up as `(x + 0.5) as usize`). 0 for an unknown preset or a
/// rate that isn't finite, positive and at most `ir::MAX_SAMPLE_RATE`.
pub fn frames(preset: u32, sample_rate: f32) -> usize {
    let _ = (preset, sample_rate, MAX_SAMPLE_RATE);
    todo!("L-C2aa")
}

/// Writes preset `preset` at `sample_rate` into `left[..n]` and `right[..n]`, `n =`
/// [`frames`]`(preset, sample_rate)`, unscaled (the decoder normalises), and returns `n`. Returns 0,
/// writing nothing, when `n` is 0 or either slice is shorter than `n`; samples past `n` are left
/// alone. Deterministic: the same arguments give the same samples on every build.
pub fn generate(preset: u32, sample_rate: f32, left: &mut [f32], right: &mut [f32]) -> usize {
    let _ = (preset, sample_rate, left, right);
    todo!("L-C2aa")
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "L-C2aa"]
    fn frames_follow_the_table() {}

    #[test]
    #[ignore = "L-C2aa"]
    fn index_of_names_every_preset() {}

    #[test]
    #[ignore = "L-C2aa"]
    fn predelay_is_silent_and_the_first_sample_is_the_draw() {}

    #[test]
    #[ignore = "L-C2aa"]
    fn deterministic_and_the_channels_differ() {}

    #[test]
    #[ignore = "L-C2aa"]
    fn the_response_decays_and_highs_die_first() {}

    #[test]
    #[ignore = "L-C2aa"]
    fn refuses_bad_presets_rates_and_short_slices() {}
}
