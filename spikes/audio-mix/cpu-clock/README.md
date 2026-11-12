# S2: audio-thread CPU inside an AudioWorklet (`loadPermille`)

Question: AudioWorkletGlobalScope has no `performance`; what gives the profiler a CPU figure (`loadPermille`, and a per-section split)?

## Method
Real-time `AudioContext` (48 kHz, Chrome for Testing 153, headless, no audio device: Chromium runs a silent null sink at real time; `OfflineAudioContext` renders faster than real time, so its process() times are not a load figure for a real device and it is unusable here). `processor.js` runs a synthetic 3-section load (voices 50 %, buses 30 %, spatial 20 %; biquad-style kernels, work varying +-50 % per quantum) at 0, 10, 30, 60 % of a quantum and a 115 % overload. Level size is closed-loop tuned in the 200 warm quanta.
Truth = a spinning Worker publishing `performance.now()` into a SAB (5 us step, read cost ~90-240 ns). Truth itself is validated against `Date.now` level totals (see tables), which is independent and unbiased over thousands of quanta.
`run.mjs` compares, per window of W quanta (6 = one STATUS block), each estimator's absolute error in permille of a quantum.

## Availability (Chromium 153; `probe.mjs`)
| | plain page | COOP+COEP page |
|---|---|---|
| `performance` in worklet | no | no |
| `Date.now` | yes, integer ms (steps of 1 ms) | same |
| `SharedArrayBuffer` / `Atomics` | SAB absent; `Atomics` present | both present |
| `Atomics.wait` in worklet | n/a | throws (not allowed) |
| `currentTime`, `currentFrame`, `sampleRate` | yes | yes |
| `setTimeout`, `Worker`, `TextDecoder`, `navigator` | no | no |
| spinner worker clock | impossible | works (`performance.now` 5 us in the page) |
| `AudioContext.renderCapacity` | absent in 153 (also with experimental flags) | same |
| `AudioContext.playbackStats` (new name of playoutStats) | yes: underrunEvents, underrunDuration, latency; no load | same |
Firefox / WebKit: [U] not run (no binaries). Known from memory [U]: Firefox rounds `Date.now` to 1 ms (2 ms with resistFingerprinting); Safari/WebKit SAB needs COOP/COEP too; WebKit has no render capacity API.

Isolation in this repo: none of the servers send COOP/COEP: the export's `serve.mjs` (`src/export/webBuild.ts:286` writes only Content-Type and Cache-Control), the dev server (`vite.config.ts:17` server block has no headers; `vite.shared.ts:238-296` set only Content-Type), Tauri (`src-tauri/tauri.conf.json:38-39` `security.csp: null`, no headers), and `docs/design/0166-audio-music/listening-pass.md:194` says the same. So today a SAB clock is unavailable in the editor, exports and desktop shell; adding headers is a decision of its own (it also affects every cross-origin resource the game loads).

## Results
Smoke run only (RUNS=2 QUANTA=400, shared 4-vCPU VM, other agents compiling: trust p50, not tails). Numbers are abs error in permille of a quantum, median over runs, W=96 (256 ms) unless noted; the timed numbers come from `node run.mjs`.
| method | 10 % | 30 % | 60 % | 115 % | notes |
|---|---|---|---|---|---|
| a Date.now deltas | p50 4.7 | 15 | 2.2 | 5.6 | unbiased (bias -1..-6); W=6: p50 26-39, p99 ~100-125; W=384 ~1.5-6 |
| b1 tick counter, calibrated once | 10 (bias -40) | 2.6 (-91) | 15 (-278) | 96 (-351) | rate falls under load (SMT / contention): biased low, grows with load |
| b1r counter recalibrated vs Date.now over the level | 8.7 | 3.1 | 3.7 | 45 | bias ~0; p99 8-9 at <=60 %; needs a sliding Date.now calibration |
| b2 timestamp spinner (the truth) | by construction | | | | 5 us quantum (~2 permille per quantum); validated vs Date.now totals within +-6 permille |
| c work-unit model, cold constant | 36 (bias +35) | 105 | 181 | 499 | constructor-time fit is 2x off (JIT/tier, cache): never trust a single lab constant |
| c model fitted live (LS on 100 warm quanta) | 3.7 | 5.3 | 11 | 43 | tracks within ~1-2 %, but only if refitted; blind to contention/clock changes |
| d renderCapacity | not exposed | | | | |
| d playbackStats | underrun count only: +152 events during the 115 % level, +0 up to 60 % | | | | no load; main-thread poll |
| e getOutputTimestamp/currentTime | underruns only [note] | | | | what `UnderrunProbe` does with Date.now (`coreDriver.ts:423`) |

Per-clock cost per quantum (measured): `Date.now` ~90-110 ns/read, SAB read ~90-240 ns/read: 2 reads/quantum ~0.5 us (0.02 % of a quantum); 4 reads for 3 sections ~1 us. The spinner worker burns one full core (the whole Worker) [dominant cost, on battery devices too]; counter worker the same.
Resolution: Date.now needs ~96 quanta (256 ms) for ~5 permille, ~384 for ~2; at one STATUS block (6 quanta) it is +-30-40 permille p50. Counter/spinner: stable at W=6 for the recalibrated counter (p50 3-30; rises with load).

Sections (W=24, permille of a quantum, p50 / p99): counter-recal 1-6 / 5-24; model fitted 1.4-12 / 5-32; Date.now 9-29 / 35-93 (useless for sections: sections are 0.1-0.8 ms against a 1 ms clock).

## Findings
1. Only the SAB paths give sub-ms timing, and they need cross-origin isolation, which no host in the repo provides today.
2. `Date.now` summed over quanta is unbiased and needs no isolation: good enough for a profiler line at ~250 ms resolution (+-5 permille), not for per-STATUS values nor sections.
3. The tick counter is biased under load; only usable if recalibrated against Date.now continuously.
4. Chromium 153 offers no render-capacity API; `playbackStats` is underruns only.
5. The wasm work-unit model (`cap.rs:232`, `NS_PER_WU = 1` at `cap.rs:101`) is the only per-section figure available everywhere, but must be refit on the live device (cold constant was 2x off in this spike); it does not see contention.

## Unverified [U]
Firefox/WebKit/Android WebView behaviour; real-device (SMT, big.LITTLE) counter drift; Chromium behaviour with a real sink (callback sizes, burst timing); the real core's model error (this used a JS kernel proxy, not `audio-core`).

## Reproduce
`node probe.mjs` (availability); `node run.mjs` (timed, ~2.5 min on an idle machine; `RUNS=2 QUANTA=300` smoke); writes `results.json`.
