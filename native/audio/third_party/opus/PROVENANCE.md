# Provenance: Opus (libopus) 1.5.2

Compiled into the audio encoder (`crates/audio-encode`, ADR 0351 A2 amended by 0359 §6) by its `build.rs`, as the float build without DNN. The fixed-point sources (`silk/fixed/`) are here too, for the decoder's Opus support (ADR 0351 A7, 0359 §4), which doesn't use them yet. BSD-3-Clause with royalty-free patent licences (`COPYING`); notice in the repository's `THIRD_PARTY_NOTICES.md` ("Audio encoder").

- **Source:** `https://github.com/xiph/opus/releases/download/v1.5.2/opus-1.5.2.tar.gz` (the release tarball), SHA-256 `65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1`, which is Xiph's published sum.
- **Copied unmodified:** `COPYING`, `AUTHORS`, `README`, `package_version`, `celt_sources.mk`, `silk_sources.mk`, `opus_sources.mk` (`build.rs` reads its file lists from these), `include/*.h`, and the top-level `*.c`/`*.h` of `celt/`, `silk/`, `silk/float/`, `silk/fixed/` and `src/`.
- **Not copied:** `dnn/` (18 MB of models; the build has no DNN), the platform folders (`celt/{arm,x86,mips}`, `silk/{arm,x86,mips}`, `silk/fixed/{arm,x86,mips}`; nothing selects them for wasm), tests, docs, the build systems, and the demo programs `celt/opus_custom_demo.c`, `src/opus_demo.c`, `src/opus_compare.c`, `src/repacketizer_demo.c`.
- To update: as `../libogg/PROVENANCE.md` says.
