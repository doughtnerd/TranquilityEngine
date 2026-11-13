# Provenance: libebur128 (licence notices)

`audio-dsp/src/loudness.rs` (task Ld1, ADR 0171 amended by 0172, architecture §4.4) follows libebur128's formulas: the K-weighting coefficients (`ebur128_init_filter`: the high-shelf and high-pass prototypes, their `f0`, `G`, `Q` and the shelf's `Vb` exponent) and the true-peak interpolator (a 48-tap Hann-windowed sinc for 4× oversampling). The code is spike S1's independent rewrite (`spikes/audio-mix/loudness/src/loud.rs`) for the core's fixed-size, no-allocation setting; no upstream source file is copied or compiled, so none is staged here. The MIT licence asks that the copyright and permission notice go with substantial portions; they are kept here because the port reproduces the formulas and constants.

| File | What | Source | SHA-256 |
|---|---|---|---|
| `COPYING` | libebur128's MIT notice (Copyright (c) 2011 Jan Kokemüller) | `https://github.com/jiixyj/libebur128`, `COPYING` at commit `67b33abe1558160ed76ada1322329b0e9e058b02` (`HEAD` on 2026-11-13), fetched from `raw.githubusercontent.com`, unchanged | `d6b4754bb67bdd08b97d5d11b2d7434997a371585a78fe77007149df3af8d09c` |
| `EBUR128-CRATE-LICENSE` | the `ebur128` crate's MIT notice (libebur128's, plus Copyright (c) 2020 Sebastian Dröge): S1 checked the formulas against this Rust port, and the recorded readings in `audio-dsp/tests/loudness_s1.rs` are its output | crates.io `ebur128` 0.1.11, `LICENSE`, unchanged | `34b4ff1c457f0ac5a0289e8a817bbaa4ff4c6c77d9d4df48f99b077c26100f13` |

The `ebur128` crate isn't a dependency of `native/audio/`: Ld6's live cross-check owns that decision.
