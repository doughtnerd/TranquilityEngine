# Provenance: libogg 1.3.5

Compiled into the audio encoder (`crates/audio-encode`, ADR 0351 A2 amended by 0359 §6) by its `build.rs`. BSD-3-Clause (`COPYING`); notice in the repository's `THIRD_PARTY_NOTICES.md` ("Audio encoder").

- **Source:** `https://github.com/xiph/ogg/releases/download/v1.3.5/libogg-1.3.5.tar.gz` (the release tarball; `downloads.xiph.org` is blocked by the build container's proxy), SHA-256 `0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664`, which is Xiph's published sum.
- **Copied unmodified:** `COPYING`, `AUTHORS`, `README.md`, `include/ogg/ogg.h`, `include/ogg/os_types.h`, `src/bitwise.c`, `src/framing.c`, `src/crctable.h`.
- **Not copied:** the build system, docs, tests and `config_types.h.in`; `build.rs` writes the `config_types.h` configure would generate (fixed-width types from `<stdint.h>`).
- To update: fetch the new release, check its sum against Xiph's, copy the same files, update this file, `THIRD_PARTY_NOTICES.md` and the vendor string in `crates/audio-encode/src/lib.rs`, then `node native/audio/build.mjs --encoder`.
