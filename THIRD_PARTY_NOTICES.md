# Third-party notices

Code from these projects is compiled into Myco Engine's own modules. Libraries used as npm packages (three.js, Rapier, Howler, three.quarks, Preact, Monaco…) carry their licences in their packages.

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
