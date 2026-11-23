# Provenance: libvorbis 1.3.7

Compiled into the audio encoder (`crates/audio-encode`, ADR 0351 A2 amended by 0359 §6) by its `build.rs`. BSD-3-Clause (`COPYING`); notice in the repository's `THIRD_PARTY_NOTICES.md` ("Audio encoder").

- **Source:** `https://github.com/xiph/vorbis/releases/download/v1.3.7/libvorbis-1.3.7.tar.gz` (the release tarball; `downloads.xiph.org` is blocked by the build container's proxy), SHA-256 `0e982409a9c3fc82ee06e08205b1355e5c6aa4c36bca58146ef399621b0ce5ab`, which is Xiph's published sum.
- **Copied unmodified:** `COPYING`, `AUTHORS`, `include/vorbis/codec.h`, `include/vorbis/vorbisenc.h`, every `lib/*.h`, `lib/books/**/*.h`, `lib/modes/*.h`, and the 21 sources `build.rs` compiles: `lib/{analysis,bitrate,block,codebook,envelope,floor0,floor1,info,lookup,lpc,lsp,mapping0,mdct,psy,registry,res0,sharedbook,smallft,synthesis,vorbisenc,window}.c`.
- **Not copied:** `vorbisfile` (decoding is symphonia's), the tools (`barkmel.c`, `psytune.c`, `tone.c`), the build system, docs, examples and tests.
- To update: as `../libogg/PROVENANCE.md` says.
