# ADR 0351 spike A0: encoder, Opus decoder size, ADPCM voice cost

The results and recommendations are in [docs/design/audio-studio/spikes/0351-a0.md](../../docs/design/audio-studio/spikes/0351-a0.md). This folder holds the code and the raw results (`results/*.jsonl`). Nothing here is part of a shipped build, and it sits outside `native/audio/` so the audio core's source hash (every `*.rs` and `Cargo.toml` under `native/audio/`) is unchanged.

| Folder | What |
|---|---|
| `encode/` | `audio-encode` spike crate: libogg 1.3.5 + libvorbis 1.3.7, libopus 1.5.2 (float), rubato 5.1.0, our IMA ADPCM encoder. A wasm32-wasip1 reactor (`spike_*` exports) plus a native command. |
| `browser/` | The browser host: `wasi-shim.js` (52 lines, the six WASI imports), `worker.js`, `run-browser.mjs` (headless Chromium through Playwright). |
| `decode-size/` | The shipped `audio-decode` crate linked unchanged, plus libopus (fixed point, `wasm32-unknown-unknown`, stub libc headers), opus-rs, or symphonia's `adpcm`, to measure what each adds. |
| `adpcm-bench/` | N voices reading IMA ADPCM vs int16 through `audio_dsp::resample::lagrange`, metered by `tools/audio-bench/meter.mjs`. |

## Reproduce (from the repository root)

```sh
bash spikes/audio-encode/fetch.sh                      # wasi-sdk 25 + Xiph sources into .toolchain/ (gitignored)
rustup +1.99.1 target add wasm32-wasip1
W=$PWD/spikes/audio-encode/.toolchain/wasi-sdk-25.0-x86_64-linux/bin
CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C target-feature=+simd128" CFLAGS_wasm32_wasip1=-msimd128 \
  CC_wasm32_wasip1=$W/clang AR_wasm32_wasip1=$W/llvm-ar \
  cargo +1.99.1 build --release --lib --target wasm32-wasip1 --manifest-path spikes/audio-encode/encode/Cargo.toml
E=spikes/audio-encode/encode/target/wasm32-wasip1/release/audio_encode_spike.wasm
ffmpeg -i samples/flappy/music/town.mp3 -ar 44100 -ac 2 -c:a pcm_s16le spikes/audio-encode/out/town44.wav
node --no-warnings spikes/audio-encode/run-node.mjs $E spikes/audio-encode/out/town44.wav - adpcm vorbis:0.4 opus-fft:0.3 --repeat=3
node spikes/audio-encode/browser/run-browser.mjs $E spikes/audio-encode/out/town44.wav vorbis:0.4 --exec=/usr/bin/google-chrome
node spikes/audio-encode/summarize.mjs spikes/audio-encode/results/node-simd-town.jsonl

# Decoder size: baseline vs libopus (same flags as build.mjs's decoder build)
F=$(printf -- "-C\x1ftarget-feature=+simd128\x1f--remap-path-prefix=$HOME/.cargo=/cargo")
CARGO_ENCODED_RUSTFLAGS=$F cargo +1.99.1 build --release --target wasm32-unknown-unknown --features libopus \
  --manifest-path spikes/audio-encode/decode-size/Cargo.toml
node spikes/audio-encode/decode-size/run.mjs spikes/audio-encode/decode-size/target/wasm32-unknown-unknown/release/myco_audio_decode_spike.wasm spikes/audio-encode/out/<file>.opus

# ADPCM voice cost
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="-C target-feature=+simd128" cargo +1.99.1 build --release \
  --target wasm32-unknown-unknown --manifest-path spikes/audio-encode/adpcm-bench/Cargo.toml
node spikes/audio-encode/adpcm-bench/run.mjs spikes/audio-encode/adpcm-bench/target/wasm32-unknown-unknown/release/adpcm_bench.wasm
```

`run-browser.mjs` needs `--exec` here because Playwright's pinned headless shell isn't installed in this container. Delete `target/`, `out/` and `.toolchain/` when done.
