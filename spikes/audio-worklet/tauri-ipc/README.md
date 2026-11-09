# Tauri IPC cost spike

Measures the real IPC cost between the webview (WebView2) and the Tauri process, to judge a native Rust audio engine driven by one command batch per frame. Standalone Tauri 2.12.5 app, no bundler, `withGlobalTauri`, own `[workspace]`.

Run: `cargo build --release && ./target/release/ipc-spike.exe` (needs `src/` assets embedded: rebuild after editing `ui/index.html`). It benchmarks on load, writes `results.json` (raw stats) and exits with `app.exit(0)`. `results-run1.json` is an earlier run that also contains a flood test.

Webview: `Chrome/157 Edg/157` (WebView2 evergreen runtime), Windows 11, release build.

## Method

2000 timed iterations after 300 warm-up, one call at a time (awaited). `invoke` JS-side: `rt` is call to promise resolved; `main` is the time `invoke()` takes to return its promise (the main-thread cost; serialization is included, the await is not). Rust side sums the floats. Caveat: `performance.now()` is clamped to 0.1 ms in the webview, so sub-0.1 ms values are quantized.

## Results (ms)

| Case | RT p50 | p95 | p99 | max | Main p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|
| empty | 1.30 | 1.70 | 2.30 | 10.0 | 0.20 | 0.30 | 0.40 | 4.5 |
| JSON 512 floats | 2.30 | 3.00 | 5.90 | 28.8 | 0.40 | 0.60 | 0.80 | 4.0 |
| JSON 2048 | 3.30 | 4.20 | 7.30 | 11.3 | 0.80 | 1.10 | 1.30 | 4.3 |
| JSON 8192 | 7.30 | 9.80 | 12.5 | 19.3 | 2.20 | 3.40 | 4.20 | 9.3 |
| raw 512 floats (2 KB) | 2.00 | 2.70 | 5.50 | 10.9 | 0.30 | 0.40 | 0.60 | 5.4 |
| raw 2048 (8 KB) | 2.20 | 2.90 | 6.10 | 12.7 | 0.30 | 0.50 | 0.60 | 4.9 |
| raw 8192 (32 KB) | 2.60 | 3.60 | 6.40 | 25.7 | 0.40 | 0.50 | 0.70 | 3.9 |
| raw response 8 KB | 2.00 | 2.70 | 4.50 | 10.8 | 0.30 | 0.40 | 0.50 | 3.9 |

The ~4-5 ms "max" main-thread values are isolated spikes (GC or scheduling), roughly 1 in 2000 or less.

### Rust to JS `Channel` (raw `InvokeResponseBody::Raw`)

- 60 msg/s x 5 s x 8 KB: all 300 arrived. Arrival interval p50 16.6, p95 18.4, p99 22.7, max 24.4 ms. Deviation from the 16.67 ms period: p50 0.27, p95 5.0, p99 7.2, max 13.0 ms (includes Rust sender jitter, which is spin-paced, so mostly webview delivery jitter).
- Paced 64 B messages for 2 s, no loss: 250, 500, 1000, 2000, 4000 msg/s all kept up (every message received, drain time equals send time). Lag behind schedule p50 2.6-3.7 ms, p99 4.9-8.6 ms, max 5.7-14.7 ms.
- Unpaced flood (run 1): Rust sends faster than JS consumes; JS received only about 600-740 msg/s sustained, regardless of 16 B, 256 B or 8 KB, and the Rust-side queue backed up (the end marker had not arrived 20 s after a 2 s flood). So the Rust sender must be paced or coalesced; delivery is bounded by per-message cost in the webview, not bytes.

## Transport (from the Tauri 2 docs and source)

Tauri 2 IPC uses a custom protocol (`ipc://` on macOS/Linux, `http://ipc.localhost` on Windows/Android) via `fetch`, with raw bodies sent as `application/octet-stream`; the postMessage path is only a fallback if the protocol fails. Raw `Request` bodies need `invoke(cmd, Uint8Array)`; responses use `tauri::ipc::Response`. Channel messages from Rust are delivered by evaluating JS (small payloads) or stored and fetched through the custom protocol (large raw payloads); we did not instrument which path a given size takes.

## Caveats

- Round trip includes awaiting a single outstanding call; batching for audio would not await.
- Windows only, idle app, single webview, release build; no concurrent rendering load (a real game's frame work would add main-thread contention and jitter).
- The JSON path cost scales with array length (serialization on the main thread); raw bytes are flat.
