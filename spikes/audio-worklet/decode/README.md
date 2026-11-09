# symphonia and fundsp in wasm (spike)

Throwaway measurements for the planned engine-owned audio core (see `../README.md`). One standalone crate (`Cargo.toml` has its own `[workspace]`), plain `extern "C"` exports, no wasm-bindgen, wasm loaded with `WebAssembly.instantiate(bytes, {})` (no imports needed). Date 2026-11-09, Windows 11, one core of this machine, Rust 1.99, Node, Playwright Chromium.

- `src/lib.rs`: `dec::decode_all` (symphonia, format auto-detected from the bytes, whole file to interleaved f32), `fx::Bench` (fundsp, 128-frame stereo block = two 64-frame `AudioUnit::process` calls; fundsp's `MAX_BUFFER_SIZE` is 64). Exports: `alloc`, `dealloc`, `decode`, `out_ptr/out_channels/out_rate/out_free`, `fx_init`, `fx_run`.
- `examples/native.rs`: native release baseline. `bench.js` is shared by Node and the page; `index.html` + `run.mjs` run Node, then Chromium (main thread, plus `decodeAudioData`).
- Versions: symphonia 0.5.5 (sections 1-4; `src/`) and 0.6.1 (follow-up from section 5 on; `v06/`), fundsp 0.23.0.

## Reproduce

```bash
cd spikes/audio-worklet/decode
cargo run --release --example native                      # native baseline
cargo build --release --target wasm32-unknown-unknown --lib
mkdir -p wasm && cp target/wasm32-unknown-unknown/release/decode_spike.wasm wasm/all-o3.wasm
cd ../../.. && node spikes/audio-worklet/decode/run.mjs   # Node + Chromium, JSON out (WASM=name picks another wasm/*.wasm)
```
Other builds: `CARGO_PROFILE_RELEASE_OPT_LEVEL=s`, `--no-default-features --features decode|decode-min|fx-std|fx`, `RUSTFLAGS="-C target-feature=+simd128"`. Profile: LTO, codegen-units 1, panic abort. No `wasm-opt` was available, so sizes are plain rustc output.

Method: each number is the median of 9 runs after a warm-up run (decode) or 2,000 warm-up blocks (fx: 9 x 5,000 blocks). Decode time includes copying the file bytes into wasm memory and `alloc`. Test files: `town.mp3` (3.3 MB, 44.1 kHz stereo, 82.3 s), `foo.mp3` (16.1 s), `ocean_loop.wav` (22.05 kHz mono, 8 s). There are no .ogg or .flac files under `samples/`, so the follow-up (section 5 on) converts `town.mp3` into other formats.

## 1. Build and size (wasm32-unknown-unknown, LTO)

symphonia builds with no problems (no patches, no special flags). fundsp builds with `std`; **its `no_std` mode fails to compile** in 0.23.0 (`src/resample.rs`: `vec!` and `Vec` not found, a missing `alloc` import), so no no_std wasm was produced.

| Build | opt-level 3 | opt-level "s" |
|---|---|---|
| empty (alloc + decode ABI only) | 20 KB | not built |
| symphonia: mp3 + flac + vorbis + ogg + wav + pcm + adpcm + mkv | 952 KB | 991 KB |
| symphonia: mp3 + wav + pcm only | 507 KB | 526 KB |
| fundsp (std, reverb + moog + svf + limiter, no fft/files) | 201 KB | 219 KB |
| both (symphonia full + fundsp) | 1,121 KB | 1,178 KB |

The "s" builds are not smaller than the "3" builds here. fundsp adds about 180 KB over the empty module. For reference the hand-written mixer spike is 55 KB.

## 2. Decode throughput (whole file to interleaved f32; "x realtime" = audio seconds / decode seconds)

| File | Audio | Native | Node wasm | Chromium wasm (main thread) | Node wasm +simd128 |
|---|---|---|---|---|---|
| town.mp3 | 82.3 s | 132.7 ms, 621x | 216.7 ms, 380x | 207.8 ms, 396x | 171.7 ms, 480x |
| foo.mp3 | 16.1 s | 21.2 ms, 757x | 35.7 ms, 451x | 31.3 ms, 513x | 27.1 ms, 594x |
| ocean_loop.wav | 8.0 s | 1.4 ms, 5,655x | 2.2 ms, 3,610x | 1.6 ms, 5,000x | 1.7 ms, 4,671x |

Wasm mp3 decode runs at about 60-65% of native speed (1.6x slower), without SIMD. Building with `+simd128` gained 20-25% (needs a SIMD-capable browser, which all current ones are; not tested in WebKit). The run-to-run spread is about 5-10% (min is 5-8% below median).

## 3. `decodeAudioData` in Chromium (same bytes, timing the promise; output resampled to the context's 48 kHz)

| File | Audio | Median | x realtime | vs wasm in Chromium |
|---|---|---|---|---|
| town.mp3 | 82.3 s | 331 ms | 249x | wasm is 1.6x faster |
| foo.mp3 | 16.1 s | 64 ms | 251x | wasm is 2.0x faster |
| ocean_loop.wav | 8.0 s | 8.9 ms | 899x | wasm is 5.6x faster |

`decodeAudioData` includes resampling 44.1 -> 48 kHz and a copy into an AudioBuffer, and runs off the main thread; the wasm figures decode at the native rate with no resampling, on the main thread. Not an equal-work comparison, which favours wasm.

## 4. fundsp per 128-frame stereo block at 48 kHz (budget 2.667 ms)

Parameters: `reverb_stereo(20.0, 2.5, 0.5)`; `moog_hz(1200, 0.6)` per channel; `lowpass_hz(1200, 0.7)` per channel; chain = lowpass 8 kHz per channel, then dry + 0.3 x `reverb_stereo`, then `limiter_stereo(0.002, 0.05)`. Boxed as `Box<dyn AudioUnit>`, `allocate()` called before timing.

| Unit | Native | Node wasm | Chromium wasm | Node wasm +simd128 | Share of budget (wasm) |
|---|---|---|---|---|---|
| `reverb_stereo` | 0.0212 ms | 0.0458 ms | 0.0452 ms | 0.0431 ms | 1.7% |
| moog x2 | 0.0111 | 0.0111 | 0.0114 | 0.0112 | 0.42% |
| lowpass x2 (SVF) | 0.0013 | 0.0013 | 0.0013 | 0.0013 | 0.05% |
| small chain | 0.0297 | 0.0525 | 0.0504 | 0.0455 | 1.9% |

fundsp's reverb in wasm is **2.2x slower than native**, unlike the hand-written mixer, which matched native. SIMD helps little. The cause was not investigated (not verified). Compared with the existing spike's Freeverb + 8 buses + limiter at zero voices (0.02-0.03 ms, measured in that spike, not re-run here), fundsp's `reverb_stereo` alone is about 0.045 ms, roughly 1.5-2x as costly. Both are small next to the budget.

Real-time safety, from fundsp's README/doc comments (not tested here by instrumenting the allocator): nodes are stack-allocated "for the most part"; some nodes use the heap for audio buffers (reverb delay lines are marked "Allocates"); `allocate()` preallocates everything and "should be called last before sending something into a real-time context" (called automatically by `Net` and `Sequencer`). `BufferArray` blocks are heap-free. `process` itself should be allocation-free after `allocate()`; changing a `Net` (adding/removing nodes) uses a `Slot`/`Net` commit mechanism that is meant to be driven from another thread. Block size is capped at 64 frames per call.

## Follow-up 2026-11-09: other codecs, streaming, seeking, browsers

Same machine and method (median of 9 whole-file runs after warm-up; streaming = 3 passes pooled after a warm-up pass; seeks = 30 per mode). Everything below decodes the same audio, `town.mp3` (82.3 s, 44.1 kHz stereo), re-encoded with ffmpeg in the Playwright docker image.

### Fixtures (git-ignored, `decode/fixtures/`)

| File | Encoder / settings | Size |
|---|---|---|
| town.mp3 | the original (copied) | 3.29 MB |
| town.ogg | Ogg Vorbis, libvorbis `-q:a 5` | 1.19 MB |
| town.flac | FLAC, default level | 10.82 MB |
| town.opus.ogg | Opus 128 kb/s in Ogg (libopus; the encoder resamples to 48 kHz) | 1.52 MB |
| town.opus.webm | the same Opus in WebM (browser `decodeAudioData` only) | 1.54 MB |
| town.m4a | AAC-LC 128 kb/s in MP4 | 1.33 MB |

Regenerate: `node run.mjs --make-fixtures` (needs ffmpeg on PATH with libvorbis and libopus), or in docker:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/path/to/repo:/work" -w /work mcr.microsoft.com/playwright:v1.64.1-noble bash -c "apt-get update -qq && apt-get install -y -qq ffmpeg && cd spikes/audio-worklet/decode && mkdir -p fixtures && cd fixtures && S=/work/samples/flappy/music/town.mp3 && cp \$S . && ffmpeg -i \$S -c:a libvorbis -q:a 5 town.ogg && ffmpeg -i \$S -c:a flac town.flac && ffmpeg -i \$S -c:a libopus -b:a 128k town.opus.ogg && ffmpeg -i \$S -c:a libopus -b:a 128k town.opus.webm && ffmpeg -i \$S -c:a aac -b:a 128k town.m4a"
```

Builds: `./build-sizes.sh` (0.5.5, `wasm/sym-*.wasm`) and `./build-sizes-06.sh` (0.6.1, `wasm/v06-*.wasm`, from the separate crate in `v06/`). Runs, from the repo root: `SKIP_OLD=1 WASM_FMT=sym-5 node spikes/audio-worklet/decode/run.mjs` (Node + Windows Chromium; `WASM_FMT=v06-sym-6` for 0.6.1 with Opus), and the same inside the docker image with `-e SKIP_NODE=1 -e BROWSERS=chromium,webkit,firefox` (repo mounted at /work). Raw JSON is in `results/` (`node results/show.cjs <file>` prints it compactly). Native numbers: `cargo run --release --example native --features sym-5 --no-default-features` (0.5.5), and in `v06/` `cargo run --release --example native --features sym-6`. The page is served with COOP/COEP so `performance.now()` has 5 us resolution in Chromium.

### 5. Format support (verified by decoding the fixtures above)

| Format | symphonia 0.5.5 | symphonia 0.6.1 | Chromium 156 `decodeAudioData` | Playwright WebKit (Linux) | Firefox 157 (Linux) |
|---|---|---|---|---|---|
| MP3 | yes | yes | yes | yes | yes |
| Ogg Vorbis | yes (`vorbis` + `ogg`) | yes | yes | yes | yes |
| FLAC | yes | yes | yes | yes | yes |
| WAV (PCM) | yes (first spike) | yes (builds; not run on a WAV) | yes (first spike) | not tried | not tried |
| AAC-LC in .m4a | yes (`aac` + `isomp4`) | yes | yes | yes | yes |
| Opus (Ogg) | **no** (probe or codec lookup fails) | **not in `symphonia` itself**; works through the pure-Rust adapter crate `symphonia-adapter-opus-rs` 0.1.1 (ruopus 0.1.2) registered in a custom `CodecRegistry`. The other adapter, `symphonia-adapter-libopus`, wraps C libopus (not tried; no clang here) | yes | yes | yes |
| Opus (WebM) | no | not tried (needs the `mkv` feature) | yes | yes | yes |

The browser columns come from Playwright's builds: Chromium on Windows, and Chromium, WebKit (a Safari 27.2 user-agent string, Linux build) and Firefox inside the docker image. **Real Safari on macOS or iOS was not tested.** Playwright's Linux WebKit decoding Opus and Vorbis says little about shipping Safari or iOS WKWebView (not verified). Tauri on Windows uses WebView2 (Chromium), so only Chromium matters for the desktop editor. Windows Playwright WebKit has no Web Audio, as expected.

Opus through the adapter: the decoded audio matches the source (RMS 0.0274 and peak 0.184, the same as the MP3 decode; 3,952,223 frames at 48 kHz = 82.34 s). Sample-level accuracy against libopus was not checked. The crates are new (0.1.x), so treat them as unproven.

symphonia 0.6.1 changes the API (new module paths, `AudioDecoder`, `next_packet` returns `Option`); it builds for wasm32 with no patches, and `v06/src/lib.rs` is the 0.5 code ported. One limitation found: with the `isomp4` reader (m4a), `format.seek` after the reader has hit EOF succeeds but the next `next_packet` fails with "isomp4: no atom pending read". Seeking from mid-file works (the bench re-opens the stream before the seek runs, so the seek numbers below are mid-file seeks). The 0.5.5 reader did not show this.

### 6. Decode speed (whole file to interleaved f32, x realtime of 82.3 s; Windows; wasm = all codecs, O3, no SIMD)

| Format | Native 0.5.5 | Native 0.6.1 | Node wasm 0.5.5 | Chromium wasm 0.5.5 | Node wasm 0.6.1 | Chromium wasm 0.6.1 |
|---|---|---|---|---|---|---|
| MP3 | 609x (135 ms) | 633x (130 ms) | 424x | 426x (193 ms) | 417x | 441x (187 ms) |
| Ogg Vorbis | 608x | 773x | 586x | 585x (141 ms) | 636x | 624x (132 ms) |
| FLAC | 698x | 799x | 748x | 803x (103 ms) | 794x | 832x (99 ms) |
| AAC (m4a) | 705x | 875x | 637x | 733x (112 ms) | 780x | 753x (109 ms) |
| Opus (adapter) | n/a | 301x (273 ms) | n/a | n/a | 245x | 251x (329 ms) |

Run-to-run spread is 5-10% (the MP3 wasm line was 396x in the first spike and 426x here). 0.6.1 is 0-25% faster than 0.5.5 natively. Wasm FLAC and Ogg figures sit at or above the native 0.5.5 ones, which is noise or a native-build difference (not investigated). The Opus adapter is 2-3x slower than the other codecs but still about 250x realtime.

### 7. `decodeAudioData` per format (median ms for 82.3 s, x realtime; output resampled to 48 kHz)

| Format | Chromium Windows | Chromium docker | WebKit docker | Firefox docker |
|---|---|---|---|---|
| MP3 | 301 ms, 274x | 414 ms, 199x | 379 ms, 217x (500 ms in another run) | 1,064 ms, 77x |
| Ogg Vorbis | 271 ms, 304x | 374 ms, 220x | 760 ms, 108x | 1,298 ms, 63x |
| FLAC | 240 ms, 343x | 307 ms, 269x | 290 ms, 284x | 519 ms, 159x |
| Opus (Ogg) | 262 ms, 314x | 365 ms, 225x | 774 ms, 106x | 1,203 ms, 68x |
| Opus (WebM) | 262 ms, 315x | 377 ms, 218x | 777 ms, 106x | 1,220 ms, 67x |
| AAC (m4a) | 282 ms, 292x | 408 ms, 202x | 638 ms, 129x | 996 ms, 83x |

The docker columns run in a Linux VM on the same machine and are not comparable with the Windows column (Chromium alone is about 1.4x slower there); compare browsers only against the Chromium docker column. Wasm (0.5.5, all codecs) in the same containers, x realtime for mp3/ogg/flac/m4a: Chromium 411/552/782/705, WebKit 356/499/858/605, Firefox 364/525/722/660. So wasm decodes at nearly the same speed in all three engines and is 1.5-3x faster than each engine's `decodeAudioData` on the same bytes (the browser also resamples; the wasm does not, and `decodeAudioData` runs off-thread while the wasm ran on the main thread).

### 8. Incremental decode in 4096-frame chunks (a read decodes the packets needed to fill 4096 frames; one chunk is 92.9 ms of audio, 85.3 ms for 48 kHz Opus)

Chromium on Windows, per chunk (887 chunks x 3 passes): p50 / p99 (max). Seeks are on the in-memory file, starting from mid-file; "first chunk" is the 4096-frame read right after the seek.

| Format | 0.5.5 chunk p50 / p99 (max) | 0.6.1 chunk p50 / p99 (max) | seek 0.5.5 / 0.6.1 | first chunk after seek 0.5.5 / 0.6.1 | landed minus requested, median (worst) | packets |
|---|---|---|---|---|---|---|
| MP3 | 0.230 / 0.370 (3.5) ms | 0.225 / 0.330 (1.7) ms | 0.005 / 0.005 ms | 0.225 / 0.215 ms | -37 ms (-52), both | 3,152 (1152 frames) |
| Ogg Vorbis | 0.150 / 0.265 (1.8) ms | 0.140 / 0.225 (2.5) ms | 0.165 / 0.165 ms | 0.19 / 0.18 ms | 0.5.5 -10 ms (-23); 0.6.1 -35 ms (-43) | 4,341 |
| FLAC | 0.125 / 0.195 (1.7) ms | 0.120 / 0.195 (1.7) ms | 0.115 / 0.105 ms | 0.13 / 0.125 ms | -51 ms (-103), both | 788 (4608 frames) |
| AAC (m4a) | 0.120 / 0.185 (1.5) ms | 0.120 / 0.200 (1.8) ms | 0 / 0 ms | 0.12 / 0.115 ms | -10 ms (-23), both | 3,547 |
| Opus (0.6.1 adapter) | n/a | 0.320 / 0.545 (2.3) ms | n/a / 0.275 ms | n/a / 0.395 ms | -9 ms (-19) | 965 (20 ms) |

A chunk costs 0.1-0.3% of its real-time budget at p50 and under 1% at p99 for every codec (Opus 0.4% and 0.6%). The max column (1.5-3.5 ms, under 4% of the budget) is rare outliers (cause not investigated). Seeks are in-memory, so they include no I/O; with a streamed file source they would be I/O-dominated (not measured). Seeks cost 0.1-0.4 ms for Ogg, FLAC and Opus (bisection or frame search) and are effectively free for MP3 and MP4 (a byte-offset or sample-table lookup). `Coarse` and `Accurate` returned the same landing position in every case: symphonia lands on the packet at or before the target, so sample-accurate seeking needs the caller to discard the leading frames (the error is at most one packet, up to 103 ms for FLAC). MP3 seeking here is a byte-offset estimate on a constant-bitrate file; VBR MP3s without a Xing header were not tried. The Node and docker WebKit/Firefox streaming numbers (in `results/`) are within 0.1-0.2 ms of these, except Firefox docker MP3 p99 at 0.7 ms.

### 9. Wasm size (bytes; wasm32-unknown-unknown, opt-level 3, LTO, panic=abort, no wasm-opt, names not stripped; includes the 20 KB alloc/ABI shell plus the decode and stream code)

| Feature set | 0.5.5 | 0.6.1 |
|---|---|---|
| MP3 only | 441 KB | 246 KB |
| Vorbis only (+ogg) | 578 KB | 513 KB |
| FLAC only | 432 KB | 367 KB |
| WAV + PCM only | 397 KB | 224 KB |
| AAC only (+isomp4) | 621 KB | 547 KB |
| Opus adapter (the feature also enables vorbis + ogg, so this includes them) | n/a | 947 KB |
| mp3 + vorbis + flac + wav | 833 KB | 840 KB |
| mp3 + vorbis + flac + wav + aac | 1,090 KB | 1,209 KB |
| the five + opus | n/a | 1,642 KB |

Opus costs about 434 KB over the five-codec build (the adapter plus ruopus, which pulls in rustfft and a spectrogram crate). `strip = "symbols"` cut the WAV-only 0.5.5 build by 10% (397 -> 355 KB); `opt-level = "z"` made it larger (432 KB). `wasm-opt` and gzip/brotli were not tried.

## Not measured

Decode inside a Worker or AudioWorklet, memory use during decode (the 82 s stereo track is 29 MB of f32; the streaming path holds one packet plus pending samples), the libopus adapter, Opus in WebM/MKV through symphonia, VBR MP3 seek accuracy, seeking over a streamed (non-memory) source, real Safari or iOS, SIMD builds for the new codecs, `wasm-opt`, Opus accuracy against libopus.
