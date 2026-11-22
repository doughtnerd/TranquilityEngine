#!/usr/bin/env bash
# Fetches wasi-sdk 25 and the Xiph C sources into spikes/audio-encode/.toolchain/ (gitignored).
# Run from the repository root: bash spikes/audio-encode/fetch.sh
# downloads.xiph.org is blocked by this container's proxy, so the sources come from the GitHub releases
# (same tarballs; the SHA-256 sums below are Xiph's published ones).
set -euo pipefail
T=spikes/audio-encode/.toolchain
mkdir -p "$T/src"
fetch() { [ -f "$2" ] || curl -sSfL -o "$2" "$1"; }
fetch https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz "$T/wasi-sdk.tar.gz"
fetch https://github.com/xiph/ogg/releases/download/v1.3.5/libogg-1.3.5.tar.gz "$T/src/libogg.tar.gz"
fetch https://github.com/xiph/vorbis/releases/download/v1.3.7/libvorbis-1.3.7.tar.gz "$T/src/libvorbis.tar.gz"
fetch https://github.com/xiph/opus/releases/download/v1.5.2/opus-1.5.2.tar.gz "$T/src/opus.tar.gz"
sha256sum -c - <<EOF
0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664  $T/src/libogg.tar.gz
0e982409a9c3fc82ee06e08205b1355e5c6aa4c36bca58146ef399621b0ce5ab  $T/src/libvorbis.tar.gz
65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1  $T/src/opus.tar.gz
EOF
tar -xzf "$T/wasi-sdk.tar.gz" -C "$T"
for f in libogg libvorbis opus; do tar -xzf "$T/src/$f.tar.gz" -C "$T/src"; done
