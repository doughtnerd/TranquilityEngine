# Third-party notices

Code from these projects is compiled into Myco Engine's own modules. Libraries used as npm packages (three.js, Rapier, three.quarks, Preact, Monaco…) carry their licences in their packages.

## Navigation module (`native/nav`, compiled to `src/engine/nav/wasm/`; ADR 0065)

- **xxhash-rust** (xxHash3 hashing) — Boost Software License 1.0. https://github.com/DoumanAsh/xxhash-rust
- **wasm-bindgen** (the WebAssembly ↔ JavaScript glue) — MIT or Apache-2.0. https://github.com/rustwasm/wasm-bindgen
- **Foxfire.Navigation** — by Chris Carlson (Foxfire Studios), ported from the Skybreaker project.
- **Recast**, **recast4j** and **DotRecast** — `native/nav/crates/nav-recast` is a port of Foxfire's navmesh generation, itself a function-by-function port of DotRecast (C#), a port of recast4j (Java), a port of Recast (C++). All are under the zlib licence:

  > Copyright (c) 2009-2010 Mikko Mononen memon@inside.org
  > recast4j copyright (c) 2015-2019 Piotr Piastucki piotr@jtilia.org
  > DotRecast Copyright (c) 2023-2024 Choi Ikpil ikpil@naver.com
  >
  > This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.
  >
  > Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:
  >
  > 1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
  > 2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
  > 3. This notice may not be removed or altered from any source distribution.

  This port is an altered version: plainly marked as such here and in the crate's documentation.

## Fonts (`src/engine/ui/fonts/`; ADR 0076)

- **Inter** (variable, weights 100–900, the Latin subset as Google Fonts publishes it through `@fontsource-variable/inter` 5.3.0) — SIL Open Font License 1.1, copyright 2016 The Inter Project Authors. https://github.com/rsms/inter. The licence text is `src/engine/ui/fonts/Inter-OFL.txt`; in builds the font file carries its copyright and licence notice in its own name table, as the OFL allows. 230 characters, 48 KB as WOFF2.

## Audio core (`native/audio`; ADR 0157)

- **Chromium Blink audio** (`native/audio/third_party/blink/`, reference copies of the files the audio core ports, listed in `native/audio/PORTS.md`) — BSD-3-Clause and its two-clause form. The files come from three sources, and each port keeps the notice of the file it draws on: (1) most Blink audio files carry `Copyright (C) 2010 Google Inc.` (`dynamics_compressor.*`: 2011) and the three clauses as WebKit has them, clause 3 naming Apple Computer, Inc.; (2) `audio_utilities.*`, `delay.*`, `equal_power_panner.*` and `hrtf_panner.*` carry `Copyright (C) 2010, Google Inc.` and only clauses 1 and 2, with the disclaimer in Apple Inc.'s name; (3) `panner_handler.cc` (2022), `vector3d_f.*` (2012), `angle_conversions.h` (2024) and `media/base/sinc_resampler.*` (2012) carry `Copyright … The Chromium Authors` and refer to Chromium's own LICENSE below. `rustfft_ffi.rs` (2026, The Chromium Authors) is staged for reference only and not ported. Upstream: `third_party/blink/renderer/platform/audio/` (plus `renderer/modules/webaudio/`, `media/base/`, `ui/gfx/geometry/` and `base/numerics/` for the files named in PORTS.md) in https://chromium.googlesource.com/chromium/src at commit `cbba46fd94646232cfd2318ac962138c2a98c1f9`. The repository licence, from Chromium's LICENSE file at that commit:

  > Copyright 2015 The Chromium Authors
  >
  > Redistribution and use in source and binary forms, with or without
  > modification, are permitted provided that the following conditions are
  > met:
  >
  >    * Redistributions of source code must retain the above copyright
  > notice, this list of conditions and the following disclaimer.
  >    * Redistributions in binary form must reproduce the above
  > copyright notice, this list of conditions and the following disclaimer
  > in the documentation and/or other materials provided with the
  > distribution.
  >    * Neither the name of Google LLC nor the names of its
  > contributors may be used to endorse or promote products derived from
  > this software without specific prior written permission.
  >
  > THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
  > "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
  > LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
  > A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
  > OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
  > SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
  > LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
  > DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
  > THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  > (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
  > OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

- **microfft** (real and complex FFTs for the convolver and HRTF ports) — MIT, Copyright (c) 2020-2024 Jan Teske. Version 0.6.0. https://crates.io/crates/microfft
- **libm** (transcendental functions, so native and wasm builds give identical results) — MIT (its LICENSE.txt also carries the Apache-2.0 text and the copyrights of Jorge Aparicio and of musl libc, Rich Felker et al.). Version 0.2.16. https://crates.io/crates/libm
- **num-complex** 0.4.6 and **num-traits** 0.2.19 (Copyright (c) 2014 The Rust Project Developers), **cfg-if** 1.0.5 (Copyright (c) 2014 Alex Crichton) and **static_assertions** 1.1.0 (Copyright (c) 2017 Nikolai Vazquez) — each MIT or Apache-2.0. These are microfft's dependencies, so they are in `myco_audio.wasm` as well (num-complex and num-traits are also in the decoder, below). https://crates.io/crates/num-complex, https://crates.io/crates/num-traits, https://crates.io/crates/cfg-if, https://crates.io/crates/static_assertions
- The mixer's own crates (`audio-wire`, `audio-dsp`, `audio-core`, `audio-wasm`) are Myco code: Apache-2.0 OR MIT, except the Chromium ports in `audio-dsp` (BSD-3-Clause, above).

## Audio decoder (`native/audio/crates/audio-decode`, compiled to `src/plugins/audio/runtime/wasm/myco_audio_decode.wasm`; ADR 0157)

- **Symphonia** (audio container and codec decoding) — MPL-2.0. Version 0.6.1: crates `symphonia`, `symphonia-core`, `symphonia-common`, `symphonia-metadata`, `symphonia-bundle-flac`, `symphonia-bundle-mp3`, `symphonia-codec-pcm`, `symphonia-codec-vorbis`, `symphonia-format-ogg`, `symphonia-format-riff`; with the `aac` build also `symphonia-codec-aac` and `symphonia-format-isomp4` (these two ship only in `myco_audio_decode_aac.wasm`, which a game downloads only when it sets `audio.codecs.aac`; the default `myco_audio_decode.wasm` doesn't contain them). Copyright Philip Deljanov and the Symphonia contributors. Unmodified; the Source Code Form is available at https://github.com/pdeljanov/Symphonia and https://crates.io/crates/symphonia (MPL-2.0 §3.2). https://www.mozilla.org/MPL/2.0/
- **lazy_static** 1.5.1, **log** 0.4.35, **bitflags** 2.13.2, **num-complex** 0.4.6, **num-traits** 0.2.19, **smallvec** 1.16.5, **regex-lite** 0.1.9 — MIT or Apache-2.0.
- **bytemuck** 1.25.2 — Zlib or Apache-2.0 or MIT.
- **extended** 0.1.0 (80-bit float parsing for AIFF and WAV headers) — MIT, Copyright 2022 Dietrich Epp.

## HRIR data (`src/plugins/audio/runtime/wasm/myco_hrir.bin`; ADR 0157)

- **HRIR data (HRTF panner)** - the head-related impulse responses are the IRC_Composite_C set from the Listen HRTF database, Copyright 2002 IRCAM (Institut de Recherche et Coordination Acoustique/Musique), http://recherche.ircam.fr/equipes/salles/listen/. IRCAM states: "The Listen database is public and available for any use." The data is shipped as format 2 (blob `src/plugins/audio/runtime/wasm/myco_hrir.bin`), converted to 16-bit integers and resampled at load. It was taken from Chromium's copy of the set at commit `cbba46fd94646232cfd2318ac962138c2a98c1f9`; the licence is IRCAM's, not Chromium's. We acknowledge the database as IRCAM requests.
