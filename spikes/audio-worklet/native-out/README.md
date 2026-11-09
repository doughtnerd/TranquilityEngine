# Native cpal output (spike)

Throwaway measurement: the `myco-audio-spike` mixer (read-only, `../core`) running inside a real cpal/WASAPI output callback on Windows 11. The mixer renders for real CPU load, but the device buffer gets zeros, so nothing is audible.

Run: `cargo run --release` here (about 35 s: Default, five Fixed sizes, two extras at 4 s each). Raw output of the run below is in `run1.txt`. cpal 0.18.2.

## Method

- One stream per configuration, 4 s each, default output device, default format (48 kHz, 2 ch, f32). First 4 callbacks dropped as warm-up.
- Callback interval: `Instant::now()` at callback entry, differenced between calls. Jitter is `|interval - mean|`.
- Latency: `info.timestamp().playback - callback` from cpal's `OutputCallbackInfo`. On WASAPI cpal computes it as (frames written minus frames the device has consumed) plus `GetStreamLatency()`. It is a prediction, not a measured loopback.
- FIFO: the mixer yields 128-frame planar quanta, the callback asks for N frames. Each callback renders quanta until the FIFO holds N frames, consumes N, and keeps the remainder (a pre-reserved `Vec`, `drain(..N)`). With N=480 that is 3 or 4 quanta per callback (480 = 3.75 x 128), 1130 quanta over 296 callbacks. This adds no latency beyond the leftover 0 to 127 frames, and no allocation in the callback.
- Stats are collected into pre-reserved vectors; a snapshot copy is published by `try_lock` every 100th callback, outside the timed region.

## Results

### 1 and 2. Device and Default buffer

Device: `Speakers (Realtek(R) Audio)`, WASAPI shared mode. Default config: 48000 Hz, 2 ch, F32. Supported buffer size range: **480..480 frames** (min = max = one device period of 10 ms; cpal reports the period, not a real range). Every supported rate lists the same single value (10 ms of frames).

### 3. Latency and jitter per buffer request (256 mixed voices)

| Request | Accepted | Callback frames | Interval p50 / p95 / p99 / max (ms) | Jitter p95 / p99 / max (ms) | Playback minus callback p50 / p95 (ms) | Errors |
|---|---|---|---|---|---|---|
| Default | yes | 480 (all) | 10.00 / 10.21 / 11.63 / 13.45 | 0.91 / 3.30 / 3.45 | 31.94 / 32.15 | 0 |
| Fixed(128) | yes | 480 | 10.00 / 10.24 / 11.73 / 15.84 | 0.30 / 2.56 / 5.84 | 32.02 / 32.31 | 0 |
| Fixed(256) | yes | 480 | 10.00 / 10.34 / 12.69 / 18.14 | 1.44 / 3.40 / 8.14 | 33.62 / 33.90 | 0 |
| Fixed(480) | yes | 480 | 10.01 / 10.39 / 12.25 / 14.83 | 0.70 / 4.15 / 4.83 | 31.65 / 31.96 | 0 |
| Fixed(512) | yes | 480 | 10.00 / 10.21 / 11.04 / 13.09 | 0.26 / 1.24 / 3.18 | 31.71 / 31.94 | 0 |
| Fixed(1024) | yes | 480 | 9.99 / 10.20 / 10.38 / 14.49 | 0.23 / 2.86 / 4.49 | 31.67 / 31.92 | 0 |

Findings: every size is accepted without error, but **none changes the callback size or the latency**. In shared mode WASAPI always calls at `GetDevicePeriod()` (10 ms here); cpal's own source comment says the requested size "only affects ring-buffer latency", and `Initialize` is given it as a buffer duration, which the shared-mode engine evidently does not shrink below its own minimum. The predicted playback latency is about 32 ms in every case, which is not a mixer cost (0 voices gives 31.6 ms). Callback intervals show occasional 11 to 18 ms gaps and 2 to 7 ms early calls (1 to 8 ms in the extremes), run to run, without an underrun being reported. Single 4 s runs: the max column is noisy, p50/p95 are stable.

### 4. Mixer cost in the real callback

| Voices (logical = mixed) | Callback body p50 / p95 / max (us) | Share of the 10 ms period (p50) | Per quantum (p50) |
|---|---|---|---|
| 0 | 92 / 121 / 254 | 0.9% | n/a (idle) |
| 256 (Default) | 1286 / 1699 / 2582 | 12.9% | about 0.34 ms |
| 256 (Fixed runs, range of p50) | 1247 to 1373 | 12.5 to 13.7% | about 0.33 ms |
| 1024 | 4821 / 5983 / 8835 | 48.2% | about 1.26 ms |

At 256 voices one callback (3.75 quanta) takes 1.29 ms against a 10 ms period, matching `core`'s native bench (0.31 ms per quantum). The FIFO costs nothing measurable. Worst case 4.8 ms at 256 voices (one outlier, 48% of the period). 1024 voices is worst-case 8.8 ms, so close to the limit.

### 5. Underruns

cpal reported **0 stream errors** in all 8 runs (the error callback counts them). cpal 0.18 WASAPI only raises errors for device loss and similar, so a missed deadline in shared mode would not necessarily be reported. The interval data (no gap beyond 18 ms, which is under 2 periods) is the only evidence, and nothing glitched audibly could be checked because output is silent.

### 6. Exclusive and low-latency modes in cpal's WASAPI backend

From `cpal-0.18.2/src/host/wasapi/device.rs`:

- Shared mode only: `share_mode = AUDCLNT_SHAREMODE_SHARED` is hard-coded in both stream builders; there is no API, feature or `StreamConfig` field for `AUDCLNT_SHAREMODE_EXCLUSIVE`. The only mention of exclusive is mapping the error codes `AUDCLNT_E_EXCLUSIVE_MODE_ONLY` and `_NOT_ALLOWED` to `UnsupportedConfig`.
- Already event-driven: `AUDCLNT_STREAMFLAGS_EVENTCALLBACK` is always set (an event handle per stream), so it is not polling. But the period is `GetDevicePeriod()`'s default (10 ms), not the minimum period, and the buffer-size request cannot change it.
- No `IAudioClient3` (`InitializeSharedAudioStream`, which can reach about 2.7 to 3 ms on drivers that allow it), no MMCSS (`AvSetMmThreadCharacteristics`) thread boost was found in the source.
- What exists: the `asio` feature (README: "bypassing the Windows audio stack"; needs an ASIO driver and LLVM/Clang, and this Realtek device has no vendor ASIO driver; ASIO4ALL or similar would be needed). Beyond cpal, the `wasapi` crate or direct `windows` crate calls to `IAudioClient3` could give about 3 ms shared-mode latency and exclusive mode gives about 3 to 10 ms, both unverified here.

Conclusion: with plain cpal on Windows the floor is a 10 ms callback and about 32 ms predicted output latency; getting lower means bypassing cpal for WASAPI (an `IAudioClient3` or exclusive backend written by us), or using ASIO.

### 7. Tauri webview and a cpal stream in one process

Yes, from documentation (not built): Tauri is a Rust process that hosts the webview (WebView2 on Windows) and runs your Rust code in the same process; the Rust `setup` hook or a plugin can start any thread or stream and keep it in managed state (`app.manage(...)`). cpal's stream owns its own audio thread, so nothing conflicts. The `Stream` type is `!Send` on some platforms, so hold it on a dedicated thread and talk to it by channel (the engine's mixer thread owns the stream and the command queue).

Commands from the game: the webview calls `invoke('cmd', args)`; per the IPC concept page, commands use "a JSON-RPC-like protocol" with JSON-serializable arguments, and events are fire-and-forget (https://v2.tauri.app/concept/inter-process-communication/). Rust pushes the command into a lock-free queue (e.g. `rtrb`) the audio callback drains. Per-call cost: I found **no published per-call number** (unverified). Tauri 2 added raw-byte payloads for `invoke` (`Request`/`InvokeBody::Raw`, https://v2.tauri.app/develop/calling-rust/, unverified here). Expect roughly tens to hundreds of microseconds per call on WebView2, so batch audio commands once per frame into one invoke rather than one per sound; measure before relying on it.

## Read on the latency advantage over the browser

Chromium reports `baseLatency` 10 ms at 48 kHz (interactive); the browser's worklet adds `outputLatency` on top on Windows (often 20+ ms, not measured here). Plain cpal on this machine predicts about 32 ms, so **cpal's default WASAPI path is no better than the browser**, which makes sense: both use shared mode with a 10 ms engine period. A native advantage needs either an `IAudioClient3` shared-mode backend (small buffers, about 3 ms periods when the driver supports them), exclusive mode, or ASIO; none is in cpal 0.18.2. The mixer cost is not the constraint: 256 voices use 13% of a 10 ms period, and about 4 to 5 ms of that period would still fit a 3 ms period only if mixing quanta in 128-frame steps (0.34 ms each) stays under the shorter period, which it does by roughly 9x.
