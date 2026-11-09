# Ported Chromium files (`native/audio`)

ADR 0157, api-and-models §5 ("Ports and dependencies"), task A0.10.

**Pinned upstream:** Chromium `cbba46fd94646232cfd2318ac962138c2a98c1f9` (tip of `main` on 2026-11-09, 19:14 UTC), path `third_party/blink/renderer/platform/audio/`. Reference copies are staged unchanged in `native/audio/third_party/blink/` with `PROVENANCE.md` (paths, commit, fetch date 2026-11-09, SHA-256). Nothing compiles them. Use them as the source to port from, and only from the pinned commit; a later Chromium commit needs a new row and a new pin.

## Ports

| Upstream file(s) | Rust module (or TypeScript) | Task | Notes |
|---|---|---|---|
| `biquad.cc`, `biquad.h` | `native/audio/crates/audio-dsp/src/biquad.rs` | A2.2a | Q in dB, as upstream |
| `dynamics_compressor.cc`, `dynamics_compressor.h` | `native/audio/crates/audio-dsp/src/compressor.rs` | A2.2a | makeup gain, knee, adaptive release, pre-delay |
| `reverb_convolver.cc`, `.h`; `reverb_convolver_stage.cc`, `.h`; `reverb_accumulation_buffer.cc`, `.h`; `fft_convolver.cc`, `.h` | `native/audio/crates/audio-dsp/src/convolver.rs` | A2.2b | staged non-uniform convolver; FFT from `microfft`, not Chromium's FFT code |
| `equal_power_panner.cc`, `.h` | `native/audio/crates/audio-dsp/src/pan.rs` | A1.2 | |
| `distance_effect.cc`, `.h`; `cone_effect.cc`, `.h` | `src/plugins/audio/runtime/core/spatial.ts` (TypeScript, main thread, not Rust) | A1.5 | the cone is ported but unused until `AudioSource` gains cone fields |
| `hrtf_panner.cc`, `.h`; `hrtf_kernel.cc`, `.h`; `hrtf_elevation.cc`, `.h`; `hrtf_database.cc`, `.h` | `native/audio/crates/audio-dsp/src/hrtf/` (every ported file under it carries the header) | H1 (data: H2) | the convolution is redone in uniform 128-frame partitions on a 256-point `microfft` FFT; the HRIR resources are not staged (H2, see `native/audio/third_party/blink/` notes in PROVENANCE.md) |

Crate dependencies (not ports, but in the same licence picture): `microfft` 0.6.0 (MIT) and `libm` 0.2.16 (MIT, per its Cargo.toml).

**Licence expression of `audio-dsp`:** `(Apache-2.0 OR MIT) AND BSD-3-Clause`. The Apache-2.0 OR MIT part is the crate's own code; the BSD-3-Clause part is every ported module.

## Header rule

Every ported file keeps Chromium's BSD-3-Clause notice. For a Rust module (`.rs`), the header is the first lines of the file, in this order:

```rust
// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/<file> @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) <year> Google Inc. All rights reserved.
//
// <the BSD-3-Clause conditions as the upstream file states them, clauses 1 to 3, each line prefixed with "//">
```

Rules for the header:

- The `SPDX-License-Identifier` line names `BSD-3-Clause` (a module that also has crate code keeps the crate's own SPDX line as a separate, second line; the Chromium line stays first).
- One `Ported from chromium/src/…` line for each upstream file the module draws on, each ending `@` followed by the pinned commit. The test in `src/plugins/audio/portsNotices.test.ts` requires the commit to match the pin above.
- The Chromium copyright lines are copied from the upstream file, not paraphrased (the files carry `Copyright (C) 2010 Google Inc.` or `2011`).
- Clause 3 of the upstream licence names **Apple Computer, Inc.** (the Blink audio files come from WebKit). Keep that wording; it is part of the licence text.
- A TypeScript file (`spatial.ts`) uses the same lines with `//` comments.

The licence text for Chromium's files is in `native/audio/third_party/blink/CHROMIUM-LICENSE` (Chromium's own LICENSE) and in `THIRD_PARTY_NOTICES.md`.

## Check

`src/plugins/audio/portsNotices.test.ts` (Vitest, `node:fs`) checks, when `native/audio/` exists: every `.rs` under `native/audio/crates/` with a `// Ported from chromium` line carries the header; every module named in the table above that exists as a file carries it; every staged file in `native/audio/third_party/blink/` is listed in `PROVENANCE.md` with its SHA-256.
