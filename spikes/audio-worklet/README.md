# Rust mixer in an AudioWorklet (spike)

A throwaway test, not engine code. It checks whether an engine-owned audio core, written in Rust and compiled to WebAssembly, can run a game-sized mix inside an AudioWorklet (the browser's audio thread) on stable Rust, with no threads, no `SharedArrayBuffer` and no COOP/COEP headers. This is the direction that replaces FMOD (ADR 0156 on hold) for an open-source engine.

- `core/`: the mixer crate (`src/lib.rs`), plain `extern "C"` exports, no wasm-bindgen; `examples/native_bench.rs` is the native baseline.
- `wasm/mixer.wasm`, `wasm/mixer-simd.wasm`: built output (55 KB each).
- `processor.js`: the AudioWorkletProcessor. It instantiates the wasm synchronously from bytes passed in `processorOptions`.
- `bench.js`, `main.js`, `index.html`: the page. "Run benchmarks" times the wasm on the main thread, then renders 10 s offline through the worklet. "Play / stop live" plays it in real time.
- `run.mjs`: runs everything headlessly in Node, Playwright Chromium and Playwright WebKit.

## Run

```bash
cd spikes/audio-worklet/core && cargo run --release --example native_bench
cargo build --release --target wasm32-unknown-unknown --lib   # then copy to ../wasm/mixer.wasm
node spikes/audio-worklet/run.mjs                              # from the repo root
```

To hear it, run `npx vite --port 3011` (the `babylon-spike` launch config) and open `/spikes/audio-worklet/`.

## What one quantum does

A quantum is 128 frames, 2.667 ms at 48 kHz.

- **Virtual voices:** L logical voices, of which the R most audible are mixed. They are re-ranked every 8 quanta with an O(L) partial sort. The others only advance their play position.
- **Per mixed voice:** linear-interpolated resampling at its own pitch, a biquad low-pass (distance filter), a gain ramp across the quantum (smoothing), and an equal-power pan into one of 8 buses.
- **Per bus:** a gain ramp, a biquad EQ, and a send into the reverb.
- **Master:** Freeverb-style reverb (8 combs and 4 all-passes per channel), then a peak limiter.

## Results (2026-11-09, Windows 11, one core of this machine)

Time per quantum, with the share of the 2.667 ms budget in brackets:

| Logical / mixed voices | Native | Node wasm | Chromium wasm (main thread) | Chromium **in the worklet** (offline render) | WebKit wasm (main thread) |
|---|---|---|---|---|---|
| 64 / 64 | 0.088 ms (3.3%) | 0.088 (3.3%) | 0.089 (3.3%) | 0.095 (3.6%) | 0.087 (3.2%) |
| 256 / 256 | 0.310 (11.6%) | 0.302 (11.3%) | 0.301 (11.3%) | 0.313 (11.7%) | 0.303 (11.4%) |
| 1024 / 1024 | 1.205 (45.2%) | 1.182 (44.3%) | 1.162 (43.6%) | 1.174 (44.0%) | 1.175 (44.0%) |
| 4096 / 256 | 0.330 (12.4%) | 0.342 (12.8%) | 0.336 (12.6%) | — | 0.362 (13.6%) |
| 4096 / 512 | 0.624 (23.4%) | 0.630 (23.6%) | 0.626 (23.5%) | 0.638 (23.9%) | 0.651 (24.4%) |

Findings:

- **Wasm runs as fast as native.** It's within ±3% of native in V8 and JavaScriptCore alike. A mixed voice costs about 1.15 µs per quantum, so **~2,300 fully processed voices fit the budget** on one core. A game typically mixes 64–256.
- **Virtual voices are nearly free.** 4,096 logical voices with 256 mixed cost 0.02–0.03 ms more than 256 alone.
- **The worklet adds almost nothing.** The offline render through the AudioWorkletNode is within 1–7% of the bare wasm loop. The output isn't silent (RMS 0.21–0.31), which proves the mixer ran inside `AudioWorkletGlobalScope`.
- **Live real-time playback works in Chromium:** 48 kHz, base latency 10 ms. Started from a click in the browser pane, as browsers require.
- **The `simd128` build gained nothing.** These loops carry state from one sample to the next (filters, ramps), so the compiler can't vectorize them. Real SIMD gains need hand-written SIMD, or processing several voices side by side. Not needed at these numbers.
- **The worklet scope has no `performance` clock** (`hasPerformance: false` in Chromium). A profiler needs the core to time itself, for example by counting work units or by the main thread timing offline renders.
- **WebKit's AudioWorklet works (Linux).** Playwright's Windows WebKit has no Web Audio at all, so the spike was run in Linux Chromium and WebKit (WebKitGTK) inside `mcr.microsoft.com/playwright:v1.64.1-noble`. WebKit instantiated the wasm from bytes inside `AudioWorkletGlobalScope` and rendered at the same speed as Chromium: 0.343 ms for 256 voices in the worklet, against Chromium's 0.336. The output RMS was identical in both engines. macOS WKWebView and Safari were not run; they share JavaScriptCore and WebCore's audio code, but real-time playback there is still untested.
- **Total output latency in the browser is about 50 ms on this machine.** Live in Chromium (the browser pane, Realtek speakers): `baseLatency` 10 ms plus `outputLatency` 40 ms, and `getOutputTimestamp` lags `currentTime` by 51 ms.

## Follow-up spikes

Each has its own README with method and tables.

| Spike | Question | Answer |
|---|---|---|
| [spatial/](spatial/README.md) | Cost of HRTF and convolution reverb in wasm | FFT HRTF costs ~5 µs per voice per quantum (32 voices = 5–7%). Third-order ambisonics handles 256 voices in 7–13% (a fixed ~0.1 ms decode). A 4 s stereo convolution reverb costs 33–42% with uniform partitions, so it needs non-uniform partitioning. Wasm FFT is 2–4× slower than native. |
| [decode/](decode/README.md) | Decoding off the audio thread; fundsp | symphonia 0.5.5 builds for wasm unchanged and decodes MP3 at ~400× realtime (≈500× with `simd128`), faster than `decodeAudioData`. It costs 0.5 MB (mp3+wav) to 0.95 MB (all codecs). fundsp 0.23 builds with `std` only; its reverb costs 1.7% and it adds ~180 KB, but its reverb runs 2.2× slower in wasm, unexplained. |
| [messaging/](messaging/README.md) | Main thread → worklet commands, and streaming | Worklet scope has `Date.now`, `currentFrame`, `Atomics`, `WebAssembly`; it lacks `performance`, `TextDecoder`, `setTimeout`, `fetch`. One transferred `Float32Array` per frame costs ~0.1 ms on the main thread, even for 1024 voices, and applies within 1 quantum typically (rare 3–5). A SAB ring is 5–10× cheaper and always applies within 1 quantum, but needs COOP/COEP. Streams routed worker → worklet through a `MessagePort` had **zero underruns under main-thread jank**; relayed through the main thread they lost 23–83 quanta. Buffer 32k frames (~0.7 s) to survive a 300 ms decoder stall. postMessage at 1024 voices caused one 0.55–0.86 ms GC scavenge in the worklet; the ring caused none. |
| [native-out/](native-out/README.md) | Native desktop output through cpal (WASAPI) | Same crate runs natively. 256 voices take 13% of the callback, zero stream errors. cpal is shared mode only, locked to the device's 10 ms period whatever buffer is requested, with ~32 ms predicted latency. That beats the browser's ~50 ms, but going lower needs our own `IAudioClient3` or exclusive WASAPI backend (or ASIO), which wasn't tested. |

## Round 2 spikes

| Spike | Question | Answer |
|---|---|---|
| Firefox (Linux, Docker) | Does the worklet path work in Gecko? | Yes. Firefox 157 runs the mixer inside its AudioWorklet at the same speed as Chromium and WebKit: 0.341 ms for 256 voices, against 0.334 and 0.349. The output RMS is identical. Raw data: `linux.json`. |
| [spatial/](spatial/README.md) non-uniform convolution | Can long convolution reverb be afforded? | Yes. A head of 128-sample partitions plus a tail of 2048-sample partitions, with the tail's work spread over 16 quanta, matches the uniform convolver to 1e-6 relative. In wasm it's **~10× cheaper**: a 4 s stereo reverb costs **0.09–0.12 ms average** in Chromium, WebKit and Firefox, against 1.0–1.2 ms uniform; 8 s costs 0.17 ms. Re-timed on an idle machine: native max 0.19 ms (4 s) and 0.26 ms (8 s); Node wasm p99 0.17–0.26 ms, p99.9 0.23–0.42 ms, rare maxima 0.34–1.67 ms, all under the 2.67 ms budget. |
| Start-up (`main.js`, `windows.json`, `linux.json`) | How long until the mixer can play? | Compiling the wasm on the main thread takes 0.5–4 ms (55 KB–1.1 MB) in Chromium, up to 15 ms in Firefox and WebKit. `addModule` takes 6–28 ms. The processor is ready (sync compile and instantiate in the worklet) 2–23 ms after the node is created. **Creating the first `AudioContext` on Windows Chromium took 250–490 ms**, because it opens the device; later ones took 73 ms. So create the context early, behind the first user gesture, never at first sound. |
| [decode/](decode/README.md) sections 5–9 | Codecs, streaming, seeking | symphonia **0.6.1** decodes MP3, Vorbis, FLAC, WAV and AAC in wasm at 440–830× realtime, 1.5–3× faster than every engine's `decodeAudioData`, with the same PCM everywhere. Opus works only through the new pure-Rust `symphonia-adapter-opus-rs` 0.1.1 (251×). Streaming 4096-frame chunks costs p50 0.12–0.23 ms and p99 ≤0.37 ms (Opus 0.32 / 0.55), against a 92.9 ms chunk budget. In-memory seeks cost ≤0.28 ms and land up to 103 ms early, so leading frames are discarded. Size without wasm-opt: MP3+Vorbis+FLAC+WAV 840 KB, +AAC 1.2 MB, +Opus 1.6 MB. All browsers tested (Chromium; WebKit and Firefox on Linux) decode all six formats with `decodeAudioData`. |
| [occlusion/](occlusion/README.md) | Cost of occlusion raycasts through Rapier (main thread) | `castRay` costs 1.5–4.3 µs per ray in Node and Chromium alike. 256 sources × 1 ray take 0.5–1.0 ms. `intersectionsWithRay` costs 3–12 µs per ray; 256 sources × 5 rays on a mixed level take the whole 16.7 ms frame. Rapier 0.21 refreshes its BVH only in `world.step()`, so queries can be one step stale. Recommended budget: ~1 ms per frame (~150–250 rays), round-robin so each source is re-tested at 10–15 Hz, smoothed gain, spread rays for the 8–16 nearest sources only. |
| [tauri-ipc/](tauri-ipc/README.md) | Cost of Tauri 2 IPC (WebView2 157) for a native desktop audio engine | One raw-bytes `invoke` per frame costs 0.3–0.4 ms on the main thread, flat up to 32 KB. JSON costs 2.2 ms at 8192 floats, so never use JSON. Round trip is 1.3 ms empty, 2.6 ms for 32 KB, p99 ~6 ms, rare 10–30 ms outliers. A Rust → JS `Channel` at 60 Hz has p99 jitter of 7 ms and tops out at ~600–740 messages per second. This is workable only with Rust owning the clock, commands timestamped 20–50 ms ahead, and no waiting on replies. That is 3–4× the worklet path's main-thread cost, with no sample-accurate sync to game frames. |
| [wasapi/](wasapi/README.md) | What a custom low-latency Windows backend gets (Realtek driver 6.0.9888.1) | `IAudioClient3` offers nothing below the 10 ms shared period on this driver. A tight shared stream gets ~20 ms. **Exclusive mode** (int16 or int24 only, no float32) realigned to a 5 ms period, measuring 5.00 / 5.05 / 5.09 ms p50/p95/p99 wakes, zero clock underruns, and **~5–10 ms estimated output latency**. But the device is taken from every other app, and 256 voices' worst wake used 50–75% of a 5 ms period. Other drivers (inbox HD Audio, USB) may allow low-latency shared mode; not tested. |

## Output latency by path (this machine)

| Path | Output latency | Notes |
|---|---|---|
| Browser AudioWorklet (Chromium, Windows) | ~50 ms | measured: `baseLatency` 10 + `outputLatency` 40 |
| cpal (WASAPI shared) | ~32 ms | predicted by cpal timestamps |
| Custom WASAPI shared, one period queued | ~20 ms | estimated |
| Custom WASAPI exclusive, 10 ms | ~10–15 ms | estimated |
| Custom WASAPI exclusive, 5 ms | ~5–10 ms | estimated; takes the device |

## Performance targets these numbers support

Budgets per 128-frame quantum (2.667 ms) on the audio thread, leaving ≥50% headroom for slower CPUs and browser jitter:

| Item | Target | Measured cost (wasm, this machine) |
|---|---|---|
| Mixed voices (resample, filter, ramp, pan, bus) | 128 default, 256 high | 0.16 / 0.31 ms |
| Logical voices (virtualized) | 4,096 | +0.03 ms |
| Per-voice HRTF (FFT) | 16–32 nearest voices | 0.07–0.15 ms |
| Ambisonic bed (3rd order, `simd128`) | all other spatial voices, up to 256 | 0.18 ms |
| Convolution reverbs (non-uniform, 4 s stereo) | 2 | 0.2 ms |
| Algorithmic reverbs, filters, dynamics per bus | 8 buses | <0.1 ms |
| **Total at the "high" preset** | ≤ 1.3 ms (≈50%) | ≈ 1.0 ms |

Main thread per 60 Hz frame (16.7 ms):

| Item | Target |
|---|---|
| Command batch to the worklet (postMessage, transferable) | ≤ 0.1 ms |
| Occlusion rays | ≤ 1 ms (~150–250 rays, round-robin) |
| Audio system bookkeeping (attenuation, priority, top-R selection, packing) | ≤ 0.25 ms. Measured 0.08 ms p50 / 0.22 ms p99 for 4,096 logical voices with typed arrays, against 0.9 / 1.7 ms with objects ([bookkeeping/](bookkeeping/README.md)) |

Other targets:
- **Streaming:** decoder worker → worklet over a `MessagePort`, 4096-frame chunks, ~32k frames (0.7 s) buffered.
- **Start-up:** create the `AudioContext` on the first user gesture, since opening the device took up to 490 ms on Windows. The audio module is ready within 50 ms after that.
- **Latency:** ~50 ms in the browser; desktop's opt-in exclusive mode 5–10 ms.

## What the spikes mean for the design

- **Architecture holds:** Rust core in wasm in an AudioWorklet, on stable Rust, with no threads and no required COOP/COEP. It runs at native speed for mixing in both browser engines.
- **Transport:**
  - commands go over postMessage in one transferable batch per frame, in a format that can also run over a SAB ring when the page is cross-origin isolated;
  - streams go from a decoder worker straight to the worklet through a `MessagePort`, never through the main thread.
- **Spatial:** direct FFT HRTF for the nearest few voices, an ambisonic bed for the rest. Convolution reverb needs non-uniform partitioning, and algorithmic reverbs cover most sends.
- **Decoding:** symphonia 0.6.1 on a decoder worker, with MP3, Vorbis, FLAC and WAV (~840 KB). AAC is opt-in (+370 KB). Opus waits until its adapter matures. Stream music in 4096-frame chunks; fully decode short effects at load. `decodeAudioData` is the fallback when wasm size matters, with no streaming or seeking.
- **Profiling:** the worklet has no high-resolution clock, so the core counts its own work and reports it, and the editor's profiler times offline renders.
- **Desktop:** keep the AudioWorklet path in WebView2 by default. It's the same code and has the best game-frame sync. A native backend only pays off as an **opt-in exclusive-mode** output: ~5–10 ms against ~50 ms. It would need Rust owning the clock, timestamped raw-byte IPC batches, and int16/int24 output. On this machine, shared mode can't beat ~20 ms. That's a later phase.
- **Spatial and occlusion:** occlusion raycasts stay on the main thread with a per-frame ray budget, and results are sent as per-voice filter and gain parameters.
- **Still unverified:** macOS real-time playback (WKWebView, Safari); low-latency shared mode on other drivers; real-hardware jitter in Firefox and WebKit (containers had no audio device); worst-case per-quantum timing on an idle machine.
