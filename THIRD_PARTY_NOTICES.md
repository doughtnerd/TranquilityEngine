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

- **Chromium Blink audio** (`native/audio/third_party/blink/`, reference copies of the files the audio core ports, listed in `native/audio/PORTS.md`) — BSD-3-Clause. The files carry Google Inc. copyright notices (2010, 2011) and the BSD clauses as WebKit's Blink audio code has them, clause 3 naming Apple Computer, Inc. Upstream: `third_party/blink/renderer/platform/audio/` in https://chromium.googlesource.com/chromium/src at commit `cbba46fd94646232cfd2318ac962138c2a98c1f9`. The repository licence, from Chromium's LICENSE file at that commit:

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

- **microfft** (real and complex FFTs for the convolver and HRTF ports) — MIT. Version 0.6.0. https://crates.io/crates/microfft
- **libm** (transcendental functions, so native and wasm builds give identical results) — MIT. Version 0.2.16. https://crates.io/crates/libm

## HRIR data (`src/plugins/audio/runtime/wasm/myco_hrir.bin`; ADR 0157)

- **HRIR data (HRTF panner)** - the head-related impulse responses are the IRC_Composite_C set from the Listen HRTF database, Copyright 2002 IRCAM (Institut de Recherche et Coordination Acoustique/Musique), http://recherche.ircam.fr/equipes/salles/listen/. IRCAM states: "The Listen database is public and available for any use." The data is shipped as format 2 (blob `src/plugins/audio/runtime/wasm/myco_hrir.bin`), converted to 16-bit integers and resampled at load. It was taken from Chromium's copy of the set at commit `cbba46fd94646232cfd2318ac962138c2a98c1f9`; the licence is IRCAM's, not Chromium's. We acknowledge the database as IRCAM requests.
