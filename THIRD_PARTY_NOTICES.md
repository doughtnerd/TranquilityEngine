# Third-party notices

Code from these projects is compiled into Myco Engine's own modules. Libraries used as npm packages (three.js, Rapier, Howler, three.quarks, Preact, Monaco…) carry their licences in their packages.

## Navigation module (`native/nav`, compiled to `src/engine/nav/wasm/`; ADR 0065)

- **xxhash-rust** (xxHash3 hashing) — Boost Software License 1.0. https://github.com/DoumanAsh/xxhash-rust
- **wasm-bindgen** (the WebAssembly ↔ JavaScript glue) — MIT or Apache-2.0. https://github.com/rustwasm/wasm-bindgen
- **Foxfire.Navigation** — by Chris Carlson (Foxfire Studios), ported from the Skybreaker project.
- **DotRecast** and **Recast/Detour** — zlib licence. Foxfire's navmesh generation is a function-by-function port of DotRecast, itself a port of Recast (Copyright (c) 2009-2010 Mikko Mononen). Their notices are added with the Recast port (wave W1).
