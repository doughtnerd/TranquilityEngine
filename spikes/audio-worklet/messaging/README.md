# Main thread to worklet messaging, and PCM streaming (spike)

Measures the transport for the planned engine-owned audio core: per-frame voice commands main -> AudioWorklet, and streamed PCM from a decoder Worker -> AudioWorklet. No mixer: "apply" is a copy of 8 floats per voice.

Files: `index.html` + `page.js` (page, `window.probe`), `processor.js` (worklet), `worker.js` (fake decoder), `run.mjs` (Playwright runner, prints JSON), `gc-trace.mjs` (Chromium trace, GC count per thread). Raw output: `results-rtt-batch.json`, `results-stream.json`, `gc-trace.json`.

```bash
node spikes/audio-worklet/messaging/run.mjs [features] [rtt] [batch] [stream] [--seconds=20]   # no names = all (about 15 min); writes results.json
node spikes/audio-worklet/messaging/gc-trace.mjs
```

Setup: Playwright Chromium 156 (headless, Windows 11), `--autoplay-policy=no-user-gesture-required --enable-precise-memory-info`. `AudioContext({sampleRate: 48000, latencyHint: "interactive"})`, real time (baseLatency 10 ms; the context clock advances). Two static servers, with and without COOP `same-origin` + COEP `require-corp`. rAF ticks at 60 Hz headless (frame interval p50 16.7 ms, p99 18-28 ms). One quantum = 128 frames = 2.667 ms. One run per cell on a busy desktop, so treat sub-ms differences as noise.

## 1. What AudioWorkletGlobalScope offers

Identical with and without isolation except SharedArrayBuffer.

| API | Not isolated | Isolated |
|---|---|---|
| `performance` (so no `performance.now` / `.memory`) | undefined | undefined |
| `Date.now` | function (1 ms resolution) | function |
| `currentFrame`, `currentTime`, `sampleRate` | yes (48000) | yes |
| `SharedArrayBuffer` | **undefined** | function |
| `Atomics` (including `Atomics.wait`) | object, wait is a function | same |
| `WebAssembly` | object | object |
| `TextDecoder` / `TextEncoder` | **undefined** | undefined |
| `setTimeout`, `fetch`, `MessageChannel` | **undefined** | undefined |

A transferred `MessagePort` still works as a receive end inside the worklet (`m.port.onmessage` inside a `port.onmessage` handler). The worker -> worklet stream below uses it.

## 2. postMessage round trip (main -> worklet -> main), 400 samples 15 ms apart

| Reply from | Main thread | RTT ms p50 / p95 / p99 / max |
|---|---|---|
| onmessage | idle | 0.20 / 0.30 / 0.50 / 3.0 |
| onmessage | janky (30 ms busy every 100 ms) | 0.20 / 30.2 / 30.3 / 30.9 |
| next process() | idle | 4.3 / 4.9 / 6.2 / 62.8 |
| next process() | janky | 8.2 / 30.2 / 30.4 / 66.0 |

The isolated page gave the same within noise. A reply from onmessage is fast because the worklet's message handler runs between render callbacks. Waiting for process() adds the render callback period (about 10 ms, about 4 quanta processed back to back). Under main jank the p95 is the main thread's own stall (a blocked main can't send or read), not the worklet. One-way main -> worklet in worklet frames (isolated, frame counter in a SAB): p50 1 quantum, p99 4-5.

## 3 and 4. Per-frame command batches (600 rAF frames each)

Batch = N voices x 8 float32. "pm": one new `Float32Array(N*8)` transferred through postMessage each frame. "ring": SAB single-producer/single-consumer ring (Atomics head/tail), drained at the start of each process(). Main cost = build + send. Delay = worklet `currentFrame` at the process() that applied the batch minus the worklet `currentFrame` main read from a SAB just before sending, in quanta (about 1 quantum resolution; isolated only).

| N | Transport | Main cost ms p50 / p95 / p99 / max | postMessage part p50 / p99 | Apply delay quanta p50 / p95 / p99 / max |
|---|---|---|---|---|
| 64 | pm (isolated) | 0.055 / 0.105 / 0.15 / 1.66 | 0.04 / 0.10 | 1 / 1 / 3 / 5 |
| 64 | pm (not isolated) | 0.10 / 0.20 / 0.20 / 0.30 | 0.0 / 0.2 | n/a |
| 64 | ring | 0.005 / 0.035 / 0.055 / 0.115 | - | 1 / 1 / 1 / 1 |
| 256 | pm (isolated) | 0.10 / 0.14 / 0.245 / 0.575 | 0.065 / 0.14 | 1 / 1 / 5 / 5 |
| 256 | pm (not isolated) | 0.10 / 0.20 / 0.30 / 1.5 | 0.0 / 0.2 | n/a |
| 256 | ring | 0.010 / 0.025 / 0.13 / 0.35 | - | 1 / 1 / 1 / 1 |
| 1024 | pm (isolated) | 0.10 / 0.165 / 0.625 / 3.05 | 0.05 / 0.165 | 1 / 1 / 1 / 5 |
| 1024 | pm (not isolated) | 0.10 / 0.20 / 0.30 / 1.0 | 0.0 / 0.2 | n/a |
| 1024 | ring | 0.015 / 0.045 / 0.34 / 1.3 | - | 1 / 1 / 1 / 1 |

Not-isolated timings are rounded to 0.1 ms by Chromium's reduced timer precision. The pm echo round trip (main -> apply -> echo back) was p50 5-6 ms, p95 about 10, p99 11-13, max about 70 ms. All 600 pm batches were applied; the ring showed 592-595 of 600 only because the last few were still in flight when results were read (`dropped` is 0).

Reading: both transports are cheap. Even 1024 voices (32 KB) cost 0.1 ms on the main thread by postMessage, about 1% of a 16.7 ms frame. The ring is 5-10x cheaper (0.01 ms) and its apply delay is always at most 1 quantum. postMessage has p50 1 quantum and an occasional 3-5 quantum (8-13 ms) tail, the message landing just after a render callback started.

## 5. Streaming PCM (20 s each, 7500 quanta, stereo f32; the worklet starts consuming when buffered >= target)

The worker keeps the stream `target` frames ahead of the wall clock and bursts to catch up (like a decoder faster than real time). Underrun = process() found < 128 frames buffered. "Min level" is the lowest buffered frame count seen in process(). It is higher than `target` because the worklet's first process() calls start late while the worker has already produced ahead, so min level is the number to read, not the nominal target. "port" = a MessageChannel port handed to worker and worklet, main not in the path. "relay" = worker -> main -> worklet.

Idle (no jank): 0 underruns in all 12 runs. Min level:

| Route | Chunk (frames) | Target 2048 | Target 8192 | Target 32768 |
|---|---|---|---|---|
| port | 1024 | 8832 | 9728 | 34688 |
| port | 4096 | 4480 | 10368 | 34304 |
| port | 16384 | 3968 | 9856 | 34560 |
| SAB ring | 4096 | 3968 | 9984 | 34944 |

Jank (chunk 4096), underrun quanta (silent frames) per 20 s:

| Route | Jank | Target 2048 | Target 8192 | Target 32768 |
|---|---|---|---|---|
| port | main (50 ms/500 ms + one 300 ms stall) | 0 | 0 | 0 |
| SAB ring | main | 0 | 0 | 0 |
| relay via main | main | **83 (10624)** | **23 (2944)** | 0 |
| port | worker (same jank) | **68 (8704)** | **8 (1024)** | 0 |
| SAB ring | worker | **68 (8704)** | **4 (512)** | 0 |

Worker jank: the 300 ms stall is 14400 frames, which empties a buffer with min level 3.5-10k frames (targets 2048 and 8192). Target 32768 (683 ms) never underran, in any route.

Findings:

- Main-thread jank does not touch a stream routed worker -> worklet, by port or SAB ring: 0 underruns even at target 2048 through a 300 ms stall. Relaying through main loses audio at 2048 and 8192.
- Chunk size doesn't change underruns at these targets. Larger chunks only raise the peak level.
- port and SAB ring behave the same, so streaming needs no isolation.
- The buffer needed is set by the longest decoder-side stall to survive: frames = 48000 x stall seconds. About 20k frames (0.4 s) clears a 300 ms stall here (8192 survived 50 ms jank but not 300 ms).

## 6. GC pressure

- Main thread (`performance.memory`, precise): summed heap growth over 600 frames was 1.0-2.0 MB in every cell, pm and ring alike (1-2 drops each). It is dominated by rAF/promise/timer garbage, not the transport; the 32 KB transferred buffer's backing store is off-heap, only the typed-array wrapper and message envelope are on the heap. Not a useful discriminator.
- All threads, via Chromium trace (`gc-trace.mjs`, `v8.gc` categories, thread names resolved), 600 frames: pm N=1024: main 3 scavenges (max 0.95 ms), **worklet thread 1 scavenge (0.55-0.86 ms)**. Ring N=1024: main 2 (max 1.1 ms), **worklet 0**. pm N=64: main 2, worklet 0. So postMessage does allocate in the worklet (deserialising the Float32Array, plus the echo messages), and at 1024 voices one sub-millisecond scavenge appeared per 10 s of 60 Hz traffic, well inside the 2.67 ms quantum. The ring path allocated nothing there.
- Worklet process() duration via `Date.now()` (1 ms resolution): 7499 calls per stream run, none >= 2 ms, max 1 ms, in every run. No large pauses seen.

## Not measured / caveats

- No Safari/WebKit (Playwright's Windows WebKit has no Web Audio) and no Firefox. The output device here may be a null/fake sink (outputLatency reported 0), so real-hardware scheduling jitter can differ.
- The worklet has no high-resolution clock, so delays are in worklet frames at about 1 quantum resolution, and wall-clock one-way latency was not measured.
- One run per cell: p99/max tails (5-quantum and 60-70 ms events) could move between runs.
- The apply cost is trivial; a real mixer taking 1+ ms per quantum changes when the next process() starts, not the transport.
- Jank was busy-loops only (no layout, GC or disk stalls). The worker stall is simulated.
- Worklet GC counts are tiny (1 vs 0 events); not enough to quantify a rate.
