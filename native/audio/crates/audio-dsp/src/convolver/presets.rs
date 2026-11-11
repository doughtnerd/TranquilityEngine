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
    PRESETS.iter().position(|p| p.name == name).map(|i| i as u32)
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
    if preset as usize >= PRESETS.len() || !(sample_rate > 0.0 && sample_rate <= MAX_SAMPLE_RATE) {
        return 0;
    }
    let p = &PRESETS[preset as usize];
    (sample_rate as f64 * (p.predelay_ms / 1000.0 + p.rt60) + 0.5) as usize
}

/// Writes preset `preset` at `sample_rate` into `left[..n]` and `right[..n]`, `n =`
/// [`frames`]`(preset, sample_rate)`, unscaled (the decoder normalises), and returns `n`. Returns 0,
/// writing nothing, when `n` is 0 or either slice is shorter than `n`; samples past `n` are left
/// alone. Deterministic: the same arguments give the same samples on every build.
pub fn generate(preset: u32, sample_rate: f32, left: &mut [f32], right: &mut [f32]) -> usize {
    let n = frames(preset, sample_rate);
    if n == 0 || left.len() < n || right.len() < n {
        return 0;
    }
    // mulberry32, as `ir.rs` (its generator is private there); one state across both channels.
    fn next_u32(state: &mut u32) -> u32 {
        *state = state.wrapping_add(0x6D2B_79F5);
        let s = *state;
        let mut t = (s ^ (s >> 15)).wrapping_mul(s | 1);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61)) ^ t;
        t ^ (t >> 14)
    }
    let p = PRESETS[preset as usize];
    let sr = sample_rate as f64;
    let pre = (sr * p.predelay_ms / 1000.0) as usize;
    let a = 1.0 - libm::exp(-core::f64::consts::TAU * CROSSOVER_HZ / sr);
    let rt60_hf = (p.rt60 * (1.0 - p.hf_damping)).max(MIN_HF_RT60);
    let decay = |t: f64, rt60: f64| libm::exp(-3.0 * core::f64::consts::LN_10 * t / rt60);
    let mut state = seed(preset);
    for ch in [&mut left[..n], &mut right[..n]] {
        let mut lp = 0.0f64;
        for (i, x) in ch.iter_mut().enumerate() {
            if i < pre {
                *x = 0.0;
                continue;
            }
            let noise = (next_u32(&mut state) as f64 / 4_294_967_296.0) * 2.0 - 1.0;
            lp += a * (noise - lp);
            let hp = noise - lp;
            let t = (i - pre) as f64 / sr;
            *x = (lp * decay(t, p.rt60) + hp * decay(t, rt60_hf)) as f32;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    /// mulberry32 written the way the JavaScript form reads (signed 32-bit, `Math.imul`): the
    /// `draws`-th output.
    fn mulberry32_reference(seed: u32, draws: usize) -> u32 {
        let imul = |a: i32, b: i32| a.wrapping_mul(b);
        let mut s = seed as i32;
        let mut u = 0;
        for _ in 0..draws {
            s = s.wrapping_add(0x6D2B79F5);
            let mut t = imul(s ^ ((s as u32) >> 15) as i32, s | 1);
            t = t.wrapping_add(imul(t ^ ((t as u32) >> 7) as i32, t | 61)) ^ t;
            u = (t ^ ((t as u32) >> 14) as i32) as u32;
        }
        u
    }

    /// A draw as the noise formula reads it, rounded to `f32`.
    fn draw_as_sample(u: u32) -> f32 {
        ((u as f64 / 4_294_967_296.0) * 2.0 - 1.0) as f32
    }

    fn render(preset: u32, rate: f32) -> (Vec<f32>, Vec<f32>) {
        let n = frames(preset, rate);
        let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
        assert_eq!(generate(preset, rate, &mut l, &mut r), n);
        (l, r)
    }

    fn energy(x: &[f32]) -> f64 {
        x.iter().map(|v| (*v as f64).powi(2)).sum()
    }

    fn diff_energy(x: &[f32]) -> f64 {
        x.windows(2).map(|w| ((w[1] - w[0]) as f64).powi(2)).sum()
    }

    #[test]
    fn frames_follow_the_table() {
        let at_48k = [21_792, 53_088, 106_464, 174_240, 45_120];
        for (k, want) in at_48k.iter().enumerate() {
            assert_eq!(frames(k as u32, 48_000.0), *want, "preset {k}");
        }
        assert_eq!(frames(0, 44_100.0), 20_021);
    }

    #[test]
    fn index_of_names_every_preset() {
        for (i, p) in PRESETS.iter().enumerate() {
            assert_eq!(index_of(p.name), Some(i as u32));
        }
        for bad in ["Room", "", "plate"] {
            assert_eq!(index_of(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn predelay_is_silent_and_the_first_sample_is_the_draw() {
        for (k, p) in PRESETS.iter().enumerate() {
            let k = k as u32;
            let n = frames(k, 48_000.0);
            let pre = (48_000.0f64 * p.predelay_ms / 1000.0) as usize;
            let (l, r) = render(k, 48_000.0);
            assert!(l[..pre].iter().all(|&x| x == 0.0), "{}: left predelay", p.name);
            assert!(r[..pre].iter().all(|&x| x == 0.0), "{}: right predelay", p.name);
            assert_eq!(l[pre], draw_as_sample(mulberry32_reference(seed(k), 1)), "{}", p.name);
            assert_eq!(
                r[pre],
                draw_as_sample(mulberry32_reference(seed(k), n - pre + 1)),
                "{}",
                p.name
            );
        }
    }

    #[test]
    fn deterministic_and_the_channels_differ() {
        for (k, p) in PRESETS.iter().enumerate() {
            let a = render(k as u32, 48_000.0);
            let b = render(k as u32, 48_000.0);
            assert!(a == b, "{}: runs differ", p.name);
            assert!(a.0 != a.1, "{}: channels match", p.name);
        }
    }

    #[test]
    fn the_response_decays_and_highs_die_first() {
        for (k, p) in PRESETS.iter().enumerate() {
            let pre = (48_000.0f64 * p.predelay_ms / 1000.0) as usize;
            let (l, _) = render(k as u32, 48_000.0);
            let body = &l[pre..];
            let m = body.len();
            let (early, late) = (&body[..m / 10], &body[m * 9 / 10..]);
            assert!(energy(early) > 1000.0 * energy(late), "{}", p.name);
        }

        // "open" has hf_damping 0.8: its high band dies well before its low band.
        let open = index_of("open").unwrap();
        let pre = (48_000.0f64 * PRESETS[open as usize].predelay_ms / 1000.0) as usize;
        let (l, _) = render(open, 48_000.0);
        let body = &l[pre..];
        let m = body.len();
        let (early, late) = (&body[..m / 10], &body[m * 9 / 10..]);
        let plain = energy(late) / energy(early);
        let diff = diff_energy(late) / diff_energy(early);
        assert!(diff < plain, "diff ratio {diff} vs plain ratio {plain}");
    }

    #[test]
    fn refuses_bad_presets_rates_and_short_slices() {
        assert_eq!(frames(5, 48_000.0), 0);
        assert_eq!(frames(0, 0.0), 0);
        assert_eq!(frames(0, f32::NAN), 0);
        assert_eq!(frames(0, 1e9), 0);

        let n = frames(0, 48_000.0);
        let mut l = vec![7.0f32; n];
        let mut r = vec![7.0f32; n];
        assert_eq!(generate(5, 48_000.0, &mut l, &mut r), 0);
        assert_eq!(generate(0, 1e9, &mut l, &mut r), 0);

        let mut short = vec![7.0f32; n - 1];
        assert_eq!(generate(0, 48_000.0, &mut short, &mut r), 0);
        assert_eq!(generate(0, 48_000.0, &mut l, &mut short), 0);
        assert!(short.iter().all(|&x| x == 7.0));
        assert!(l.iter().chain(&r).all(|&x| x == 7.0));
    }
}
