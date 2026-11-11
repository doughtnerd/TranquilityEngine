# S3 beat-clock: beat/bar/cue callbacks to scripts (design A vs B), clock quality, rhythm-mode input

Status: **harness built and smoke-tested (one 10 s run, shared VM). The timed runs are the coordinator's** (command below). Numbers in the smoke column are from `results/smoke.md` and are not the headline. Only p50/p99 are trustworthy on a loaded VM; every number from a real output device is **[U]**.

## Question
Scripts must hear beats, bars and cues "within about 1-2 frames" (goal.md, Sync target). Two designs:
- **A**: main predicts beat times from the music's tempo map and the heard clock (`ClockMap.audioTime()`), and fires a callback in the frame whose window covers the beat.
- **B**: the core emits a beat/cue event when it renders it (in STATUS, or a new record) and main fires it on arrival.

## What the engine does today (read, cited)
- `Audio.time` is `clockMap.audioTime()` (`src/plugins/audio/runtime/core/coreBackend.ts:471-472`). It is `(prevP*sr/1000 + offset - outputLatencyFrames)/sr` (`core/clock.ts:248-265`): the rAF time of the **last `beginFrame()`** mapped to the heard frame, minus the limiter latency (66 frames at 44.1 kHz, `core/limiterLatency.ts:15-17`). It is a pure function of the frame's rAF time, so it is constant within a frame and moves only when `beginFrame()` runs.
- `beginFrame()` (`clock.ts:146-197`) takes `getOutputTimestamp()` once per frame: `heard = sr*(ts.contextTime + (p - ts.performanceTime)/1000)`, `offset = heard - p*sr/1000`. **What it already smooths:** EMA gain 0.1 on the offset (`clock.ts:21,192`); a sample more than 5 ms off the filtered offset is rejected (`clock.ts:23,181`); 10 rejections in a row re-anchor (`clock.ts:25,184-188`); a gap over 250 ms (`STALL_MS`, `clock.ts:35,152,171`) or a frame without a timestamp re-anchors to the raw sample; `rebase` carries `Audio.time` monotonic across context swaps (`clock.ts:124-140`). So a PLL is already there in effect (EMA offset with outlier gate); there is no separate rate (drift) term, because the offset tracks drift at gain 0.1 per frame.
- STATUS cadence: every `STATUS_EVERY_QUANTA = 6` quanta (`worklet/coreDriver.ts:900-904`; `audio-wire/src/schema.rs:72`) = 17.4 ms at 44.1 kHz; every 48 quanta (139 ms) when no batch arrived for 250 ms (`schema.rs:73-74`). The `ClockMap` uses STATUS only as the fallback clock (`clock.ts:215`, `noteStatus`).
- **Where the audio system runs in the frame:** `Engine.stepWorld` (`src/engine/core/Engine.ts:712-770`): begin frame, `start()`, fixed steps, `update`, `lateUpdate`, transform propagation, render sync, render. The audio system is `engine.Audio` in the **lateUpdate** phase, ordered after `engine.NetSend` (`src/plugins/audio/runtime/audioSystem.ts:125-129`); its first step is `frameAttenuate`, which calls `clockMap.beginFrame()` (`coreBackend.ts:794`). Consequence (read from the code, not measured): **a script's `update()` reads the `Audio.time` of the previous frame** (one frame, 16.7 ms stale); only code that runs after `engine.Audio` sees this frame's value. The frame-plan doc (`docs/plans/2026-11-frame-plan-and-editor-policy.md`) is about render views, not system order, and says nothing on this.

## Method
`run.mjs` serves a page to headless Chromium (`/opt/pw-browsers/chromium`, Playwright), 4 vCPUs shared. Flags: only `--no-sandbox --autoplay-policy=no-user-gesture-required` (override with `CHROMIUM_FLAGS`).
- **Audio:** a **real `AudioContext`** (44.1 kHz). A probe (before the harness) showed the context runs in real time with **no flags at all** on this container's null sink: `currentTime` advanced 2.011 s in 2.000 s wall, `getOutputTimestamp()` was valid, `baseLatency` 0.010 s, `outputLatency` 0.032 s (Chromium's nominal numbers for the sink; not a device). `--use-fake-device-for-media-stream` changed nothing (it concerns getUserMedia). rAF ran at 60.006 Hz.
- **Core:** `harness/processor.js`, a worklet that renders a beat grid and copies the engine's STATUS cadence (every 6 quanta, `Date.now()` stamp), not the engine's wasm core (a faithful copy of cadence, not of the core).
- **Main:** the engine's real `ClockMap`, transpiled unmodified from `src/plugins/audio/runtime/core/clock.ts` and `lookahead.ts` (`run.mjs` `transpiled()`), with `outputLatencyFrames = 66`. The HostClock is `browserHostClock`'s (`hostClock.ts:42-80`) with `rafTime()` = the rAF callback's own timestamp (see [U] 3).
- **Truth:** a spinning worker writes `timeOrigin + performance.now()` into a SharedArrayBuffer; the worklet stamps every quantum with it (frame, wall). A least-squares line over all ~20k quanta gives wall time as a function of audio frame (`fit` in the output: 7 ppm from nominal in the 10 s smoke, residual p99 5 ms because Chromium renders 3-4 quanta per callback; the fit averages that out). The heard time of frame f is `fit(f + 66) + K`, where **K is one constant per run**: the median of (wall - fit) over frames using `getOutputTimestamp` as the heard-frame source (about 35 ms here). K is **not independently verified**: this harness measures **jitter, drift, steps and frame assignment, not the absolute output latency** (that needs a loopback on a real device, [U]). Errors are reported with the constant removed.
- **Scenario per run** (fractions of the run length so the smoke covers it): 120 BPM start at a stamped frame; **tempo change** 120 -> 90 BPM at beat tempoBeat (in the tempo map, so A knows it); a **stamped transition** at a bar boundary main chose (`nextFirstFrame()+2048`, quantised to the bar, 100 BPM grid); **8 asap seeks** alternating 120/100 BPM where the **core** picks the frame (A learns it from the next STATUS); **hitches** (a busy loop at the end of a rAF callback) of 100, 200, 300 ms; synthetic `tap` events at random offsets plus trusted keydown events from CDP (`page.keyboard.press`) for Q5. Each window of 1 s after a hitch is a `hitch` bucket; within 1 s of a grid switch is `transition`; beats n in [tempoBeat-2, tempoBeat+3] are `tempo`; the rest `steady`.
- **Designs as built:**
  - **A**: per frame, fire every beat of the known epochs with frame < `(audioTime + Δ̄)*sr` (the window this display frame covers, Δ̄ = `ClockMap.frameIntervalMs`). **A0**: the reactive variant (fire when `audioTime` has passed the beat), shown to cost one frame.
  - **B raw**: fire in the first rAF frame after the event arrives. **B held**: also wait until the beat is heard (A's rule on the received frame). Each over two channels: `imm` = its own `postMessage` at render time, `status` = carried in the next STATUS (up to 6 quanta later).
  - "Ideal" frame = the rAF frame whose interval [p_i, p_i+1) contains the beat's true heard time. `lead` = heard time - callback frame start; ideal lead is in (0, Δ]. Error = distance of `lead` from (0, Δ]. Display/compositor latency after the frame is **[U]**.

## Findings (smoke, 1 x 10 s, interactive latency; replace with the timed runs)
**Clock (Q2).** Against the audio-clock fit, in the null-sink setup:

| estimator | const offset ms | abs dev p50 / p99 / max ms | frame-to-frame jitter std ms | notes |
|---|---|---|---|---|
| `ClockMap.audioTime()` | -0.01 | 0.021 / 0.086 / 0.131 | 0.006 | 0 backwards steps, 1 re-anchor (the first), 0 rejected |
| `getOutputTimestamp` raw | 0.00 | 0.026 / 0.198 / 1.13 | 0.086 | same value, no filter |
| `currentTime` raw | 36.3 | 2.6 / 5.0 / 8.1 | 4.86 | 3-4-quantum steps, and not latency-compensated (it is the render clock: ~output latency ahead of what is heard) |

Hitches of 100, 200 (and 300 in the timed run): ClockMap error in the first frame after the long frame was under 0.04 ms, settling in 0 frames, because it is a function of the rAF time and the filtered offset, not an integrator; `currentTime` was 1.4-4.9 ms off and did not settle within 14 frames. The 300 ms case crosses `STALL_MS` (250 ms) and re-anchors; with a smooth timestamp that costs nothing here, with a jittery device timestamp it would take that frame's raw jitter for one frame **[U]**.
**Honest limit:** headless Chromium's output timestamp is smooth because the sink is a software clock. On real devices (Windows WASAPI shared mode, Android) `getOutputTimestamp` is known to be quantised or noisy, so these figures are a lower bound on the error **[U]**. The filter's job (EMA 0.1, 5 ms gate) is exactly that case; the timed runs say nothing about it.
**Does A need extra smoothing?** On this evidence no: ClockMap already has the EMA offset, outlier gate, re-anchor and monotonic carry, and its f2f jitter (6 us) is 500x under a frame. What A needs is *not* a PLL but a stated contract for what happens over a re-anchor (a beat window can slip by the re-anchor step; A must not fire twice or skip: it should step a per-music cursor by beat index, which the harness does, 0 doubled/missed).

**Beats (Q1).** Smoke, per 10 s run (see `results/smoke.md` for all buckets):

| design | callback frame vs ideal | missed / doubled / phantom | note |
|---|---|---|---|
| A (predict, cover window) | 100% in ideal frame (steady, tempo, transition) | 0 / 0 / 0 | the asap seek's new grid is learned from STATUS and still lands in the ideal frame because the core renders ~32 ms ahead of what is heard |
| A0 (reactive) | 100% one frame late (+1), ~10 ms after heard | 0 / 0 / 0 | |
| B raw (imm or status) | 1-2 frames **early** (lead up to 25 ms: it arrives ~32 ms before the beat is heard) | 0 / 0 / 0 | fires before the sound |
| B held (imm or status) | identical to A | 0 / 0 / 0 | needs the same clock |

Arrival lead of B's messages (render to main, how far before heard): immediate 33 ms p50 (min 32), via STATUS 32 ms p50 (min 23) at the default `interactive` hint. So **B cannot fire on arrival: it must hold until the beat is heard, which is A's rule.** B's only advantages are knowledge, not timing: it reports beats the main thread cannot predict (core-decided loops, random playlists, cues reached by an asap seek), exactly, with no phantom beats. A's only exposure is the window between an unconfirmed asap change and its STATUS: it predicts beats of the old grid that the core cuts (phantoms) when the confirmation arrives later than the beat's heard time. It did not occur in smoke because the confirmation arrives 23-32 ms **before** the heard moment; it will occur when the render-ahead shrinks (rhythm mode: smaller buffer) or the main thread is busy [U]. The timed runs count it over 8 seeks x 5 runs.

**Rhythm mode input (Q5).** event.timeStamp mapped through ClockMap's offset (`(ts*sr/1000 + offset - 66)/sr`) has error p50 0.014 ms, p99 0.24 ms (smoke, 89 synthetic + 19 trusted CDP events) against the fit; reading `Audio.time` in the handler (as of the last frame) is 11 ms p50 / 17 ms max off, i.e. up to one full frame: **judge input with the timestamp mapping, never with `Audio.time`**. A trusted event's handler runs 0.27 ms p50 / 2.7 ms max after its `timeStamp` (CDP), which the mapping ignores (it uses the event's own time, so main-thread delay costs nothing). Not measurable here: the real input-device-to-`timeStamp` latency (OS, USB polling, Bluetooth) and the real output latency, **[U]**; the calibration helper ("tap to the beat") exists to absorb their constant sum.

**Audio-thread cost of B (Q3).** `cost/`: Rust, std only, same code native and in V8 wasm. Per quantum per instance: `if next_beat < q_end` and `if next_cue < q_end`; a crossing writes one 16-byte event to a fixed ring and advances the tempo map. Smoke (400k quanta x 5 reps, loaded VM, p50):

| instances | normal 120/90 BPM native | wasm32 in Node | worst case (a crossing every quantum) native | wasm32 |
|---|---|---|---|---|
| 1 | 2.8 ns | 4.7 ns | 11 ns | 12 ns |
| 4 | 6.2 ns | 14.5 ns | 42 ns | 49 ns |
| 16 | 15.5 ns | 50 ns | 149 ns | 188 ns |
| 64 | 71 ns | 135 ns | 639 ns | 871 ns |

A quantum is 2.9 ms; even 64 instances in the worst case is 0.03%. Tiny: not a budget item (the STATUS payload for events is the real cost: 16 bytes per event, ~2 events/s per instance at 120 BPM, against the 16 KB STATUS buffer, `schema.rs:71`). The check is not on a hot path that could justify moving the design.

**Delivery contract (Q4).** Recommendation:
1. **Hybrid, A as the engine and B as the truth feed.** Main keeps a music cursor per playing music instance (segment id, grid origin frame, tempo map) and predicts beats/bars with `ClockMap`, firing in the frame whose window `[audioTime, audioTime + Δ̄)` covers the beat (A). The core reports, in STATUS (no new record needed beyond a small event list), every **grid change it decided** (segment switch with exact frame, asap seek, loop wrap, playlist step, cue reached) and, as a cross-check, a position sample (instance, music frame, context frame) so main can re-anchor the cursor; main never fires a beat from an event on arrival, only through the same window rule. This gives exact frames (sample-accurate grid), zero missed/doubled across tempo changes, stamped transitions and seeks, and no per-beat traffic.
2. **Run the beat dispatch before `update`, not in `engine.Audio`'s slot.** Because `engine.Audio` runs in lateUpdate, scripts' `update()` otherwise see last frame's clock. Either call `clockMap.beginFrame()` and the music dispatch at frame start (before step 3 `start()`/fixed steps; `ClockMap.beginFrame` is idempotent per `rafTime`, `clock.ts:148`) so `onBeat` runs in frame F for a beat heard in F, and `Audio.time` is current for all scripts; or keep the system where it is and document `onBeat` as "delivered in lateUpdate of frame F". The first costs one reorder in `Engine.stepWorld`.
3. **Callbacks carry exact numbers:** `onBeat({ beat, bar, beatInBar, time, heardIn, segment })` where `time` is the beat's exact heard time on the `Audio.time` clock (seconds, from the beat frame) and `heardIn = time - Audio.time` (0 to Δ̄ for an on-time callback; negative if the frame was late, e.g. after a hitch: after a 300 ms hitch the beats heard during it fire together in the first frame back, each with its true `time`, none dropped or doubled). Scripts schedule ahead with `Audio.play({ at: time + k*beatLength })`.
4. **"Within 1-2 frames"** is met with margin by A: 0 frames from ideal in the smoke, error = clock error (< 0.2 ms here). The user-visible delay is then the renderer's, not audio's (display latency [U]).
5. **Rhythm mode** adds nothing to the beat path; it changes (a) the buffer/lookahead (more risk of phantom beats on unconfirmed asap changes: the cursor must treat an unconfirmed asap change as "uncertain" and suppress beat callbacks until STATUS confirms, or require stamped transitions in rhythm mode) and (b) input judging with `timeStamp` mapped via the ClockMap offset (`audioTimeAt(ts)`: add this accessor; `offsetFrames` is already public, `clock.ts:228`).

## Unverified [U] / limits
1. Real output latency, device clock quality, and `getOutputTimestamp` noise on Windows/Android/Safari: the harness uses a null sink with a smooth timestamp; errors here are a lower bound. K is a median, not a loopback.
2. `latencyHint: 0` (the rhythm-mode setting) was tried once in smoke (`--hint 0`) and gave unusable data on this loaded VM (render stalls broke the fit; also OOM-killer messages from other agents). Not reported; rerun on an idle machine (`--hint 0`), where it is the interesting case for phantom beats.
3. The engine's `browserHostClock` samples rAF with its own sampler (`hostClock.ts:42-65`); if the engine's frame callback runs before the sampler's within a frame, `rafTime()` returns `performance.now()` of the call, not the vsync time. The offset filter absorbs this (EMA, 5 ms gate) but I did not test it; the harness feeds the rAF timestamp directly.
4. The core is a copy of the STATUS cadence, not the real wasm core; stamped `S` is honoured exactly in the worklet by construction (late commands: 0).
5. Display/compositor latency after a frame's callbacks; touch/key hardware latency; Android WebView.
6. A script's `update()` reading a stale `Audio.time` is read from the code, not measured.
7. Smoke is one 10 s run; the tempo/transition buckets hold a handful of beats there. The timed run (5 x 60 s, ~600 beats/run, ~3500 frames/run) gives the percentiles.

## How to reproduce
```
cd spikes/audio-music/beat-clock
node run.mjs --runs 5 --seconds 60                 # expected ~6.5 min (each run: 1.5 s warm-up + 60 s + 2.5 s tail + ~4 s start/analysis)
node run.mjs --runs 5 --seconds 60 --hint 0        # rhythm-mode latency hint, idle machine only, ~6.5 min
node run.mjs --runs 1 --seconds 10                 # smoke, ~15 s
# microbench (seconds):
export CARGO_TARGET_DIR=...; cd cost && cargo run --release --offline --bin beatcost-native && cargo build --release --offline --target wasm32-unknown-unknown --lib && node run.mjs
```
Output: a markdown report to stdout and `results/run-60s-<time>.{json,md}` (per-run stats are in the JSON; the tables are medians over runs). Needs `/home/user/TranquilityEngine/node_modules` (playwright-core, typescript). Do not run it beside compiles: the spinner worker takes one core and Chromium another.
