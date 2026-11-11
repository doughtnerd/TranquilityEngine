# S5: rhythm mode, latency limits, platform APIs and calibration

Question: what can "rhythm mode" (goal.md: lower output latency, input timestamps judged against the audio clock, a "tap to the beat" helper) really deliver per platform, what in the engine adds latency, and what should the engine provide versus games. Beat-callback timing and input-to-audio-clock mapping error are S3's (`../beat-clock/`); not repeated here.

Legend: **[V]** verified here (code read, or measured in this container, or measured by the M1 spikes), **[U]** unverified (needs a real device or a source I could not open), **(est.)** estimate. Web access note: only WebSearch snippets worked; `developer.mozilla.org`, `lists.webkit.org` and `bugzilla.mozilla.org` did not resolve from WebFetch (not in the session's allowed hosts), so every web-sourced cell is a search-snippet claim and marked accordingly.

## 1. What the engine does today (code, all [V])

- Context: `new AudioContext({ latencyHint: "interactive" })`, no `sampleRate` (`src/plugins/audio/runtime/core/context.ts:881`); Babylon fallback the same (`src/plugins/audio/runtime/babylonBackend.ts:1050`).
- The engine **never reads `outputLatency` or `baseLatency`** (grep over `src/plugins/audio`, `native/audio`: no hits). Device latency enters only through `getOutputTimestamp()` (`core/hostClock.ts:62-70`, pair (T, P)); the clock map's heard frame is H(p) = sr·(T + (p−P)/1000) (`docs/design/0157-audio-core/architecture.md` §4.3 table, ~line 470). So the unreliable-`outputLatency` bugs matter less than a wrong `getOutputTimestamp`, which is the same platform value in Chromium **[U]**.
- `ClockMap.outputLatencyFrames` is **only the limiter's look-ahead**, passed from `limiterLatencyFrames(rate, preset.limiterLookaheadMs)` (`core/clock.ts:83-86, 262`; `core/contextRebuild.test.ts:213`), not the device. Default 1.5 ms = 72 frames at 48 kHz, range 0..5 ms, delay line 480 frames (`native/audio/crates/audio-dsp/src/limiter.rs:87-93`; `audio.limiterLookaheadMs` setting, `coreDriver.ts:207, 352`).
- Lookahead L = clamp(2Δ̄, 1024 frames, 100 ms) (`core/lookahead.ts:11-31`), **stamped records only**; asap records never use it (`lookahead.ts:3-4`). Floor reason: Chromium renders 3-4 quanta per ~10 ms callback plus a 3-5 quantum postMessage tail (`architecture.md` ~line 484; `lookahead.ts:11`).
- asap sounds: "Expected latency is Λ + 1-5 quanta ≈ 53-63 ms" (`architecture.md` §4.3), Λ = render lead ≈ the device's pipeline.
- STATUS every 6 quanta (16 ms at 48 kHz), 48 when idle (`architecture.md` §4.5; `backgroundLoopback.test.ts:208`). It feeds the clock fallback and end-of-voice handling, not the input-to-sound path.

## 2. Platform output latency table

Hints: "interactive" (today), numeric 0.005 / 0, "balanced", "playback". The browser treats the hint as a request; `baseLatency` is the answer.

| Platform | Hint effect | baseLatency / outputLatency / getOutputTimestamp | Source |
|---|---|---|---|
| Chromium 153 Linux headless (this container, **fake sink, no device**) | interactive and balanced 10 ms, numeric 0.005 clamped to 10 ms, 0 gives 2.9 ms (128 frames at 44.1 kHz), 0.02 gives 20.3 ms, playback 23.2 ms. outputLatency 32 / 32 / 72 / 8 ms; getOutputTimestamp lag behind currentTime 42 / 42 / 93 / 11.6 ms | present, non-zero, scales with hint. Describes the null sink only | **[V]** `latency-probe.out` |
| Chromium Windows (WebView2 and Chrome), Realtek, shared mode | interactive = base 10 ms | base 10 ms + outputLatency 40 ms, getOutputTimestamp lag 51 ms, total about 50 ms. IAudioClient3 gave nothing under the 10 ms shared period on this driver, so a smaller numeric hint likely changes nothing here (other drivers **[U]**) | **[V]** M1 `spikes/audio-worklet/README.md:47-51`, wasapi section |
| Chromium Linux/macOS real device | numeric hints below the device minimum are clamped | **[U]** | none |
| Chromium Android (Chrome, system WebView) | hint maps to the HAL buffer; one forum report of baseLatency 3200 frames (about 300 ms lag) on a phone, 256 frames on another; a Chrome developer suggested `latencyHint: 0.003` and reading `baseLatency` back. Intent-to-ship note: outputLatency is the platform-provided value of the device and does not work properly without a real device | **[U]** (forum anecdote, Construct thread; Chromium intent-to-ship, via search snippets) |
| Firefox desktop | `outputLatency` and `getOutputTimestamp` implemented (`probe.ts:68` cites Firefox 70; bug 1324545 "Implement AudioContext getOutputTimestamp"). With resistFingerprinting both are altered (bug 1564422). Whether non-"interactive" hints change the buffer: **[U]** | **[U]** values per device | search snippets |
| Firefox Android (Fenix) | bug 1612093 "outputLatency on Fenix is wrong"; a new Android audio backend fixes it but is enabled only on some Android versions | **[U]** | search snippet |
| WebKit / Safari / WKWebView (macOS, iOS) | `baseLatency` (WebKit bug 215277) and `getOutputTimestamp` (215591) were fixed in 2020; `outputLatency`: webkit-dev asked for a position in Dec 2021 over fingerprinting (jitter, quantisation suggested); shipped state not confirmed. Fingerprinting mitigation may quantise values | **[U]**; whether it returns 0 is not confirmed either way |
| WebKitGTK (Tauri Linux) | AudioWorklet support and latency | **[U]** (the engine core needs AudioWorklet, `probe.ts:22`; otherwise Babylon fallback) |
| Desktop native (cpal WASAPI shared) | locked to the 10 ms period | about 32 ms predicted **[V]** M1 native-out; custom shared about 20 ms (est.); exclusive 5 ms period 5-10 ms (est.) | M1 `wasapi/`, `native-out/` |

Reading: a platform's floor is the OS/driver shared-mode period, not the engine. What rhythm mode can do in a browser is ask for the smallest hint and read back what it got. Practical range: about 20-50 ms on Windows/Chromium, device-dependent elsewhere. It can neither promise a number nor beat the OS shared mode.

## 3. Engine-added latency (asap path unless noted)

| Item | Added heard latency | Applies to | Could rhythm mode lower it? Risk | Source |
|---|---|---|---|---|
| Lookahead floor, 1024 frames | **0 for asap**; 21.3 ms at 48 kHz is the earliest an `at`/synced start can be (stamped) | stamped records, music grid starts | Floor to 512 frames (10.7 ms, est.): the postMessage tail alone is 3-5 quanta (8-13 ms) and Chromium callbacks batch 3-4, so late stamped records (applied at offset 0, `lateCommands`, `architecture.md` §4.4) become likely. With the SAB ring (apply at most 1 quantum, M1 messaging §4, needs COOP/COEP) about 5 quanta (13 ms, est.) would be safe. Gains only reactive stingers; planned music is scheduled beats ahead. Not recommended | [V] code + M1 |
| Command apply delay, postMessage | p50 1 quantum (2.7 ms), p99 4-5 quanta (11-13 ms) | every asap record | SAB ring always at most 1 quantum, 5-10x cheaper main cost, but cross-origin isolation required (itch/web hosts, Tauri headers **[U]**) | [V] M1 `messaging/README.md:44-60` |
| Limiter look-ahead | 1.5 ms (72 frames), compensated in `Audio.time` | all output | Set to 0 (zero-latency limiter exists, `bus.rs:43`) saves 1.5 ms at the cost of clipping protection on peaks. Marginal; leave default | [V] |
| Render lead Λ / device pipeline | about 40-50 ms Windows Chromium | all output | Only via latencyHint, clamped by OS | [V] M1 |
| STATUS cadence, 6 quanta | 0 on the sound path; up to 16 ms jitter on ended/fallback clock | clock fallback, end notifications | Could go to 2 quanta (est.) for more postMessage traffic; unnecessary because `getOutputTimestamp` drives the clock | [V] code |
| Frame granularity of script input | up to 1 frame (16.7 ms at 60 Hz) between input event and the sound command | hit sounds from `Update` | Judge from `event.timeStamp`, not frame time; play the sound from an input handler or next frame | [V] design |

Typical engine-added for a hit sound: about 1.5 + 2.7 = 4.2 ms, tail about 15 ms, plus up to a frame if triggered from `Update`. The platform dominates (20-50 ms), so the engine's share is under 10-20%.

## 4. Input timestamps and the audio clock

| Source | Base and resolution | Notes | Status |
|---|---|---|---|
| `event.timeStamp` (pointer, key, touch) | DOMHighResTimeStamp on the `performance.now()` timeline. `performance.now()` coarsened to 100 µs (Chrome 91+, non-isolated), 5 µs when cross-origin isolated; Firefox 20 µs isolated; Firefox and Safari 1 ms otherwise (Chrome's 2021 intent text, possibly stale) | measured here: 100 µs, not isolated | **[V]** Chromium here; others **[U]** |
| Event time vs delivery | the timestamp is the platform event time where the OS gives one (hardware events), not dispatch time | Android WebView MotionEvent base and any coalescing of touch events: **[U]** | **[U]** |
| Gamepad `timestamp` | DOMHighResTimeStamp of last state change; the page only sees it when polling `navigator.getGamepads()` (per frame). A 2016 W3C post claims Chrome polls at 16 ms and Firefox 50 ms (old) | quantisation and polling lag up to a frame or more; Edge's event-driven gamepad explainer cites rhythm games as the motivation | **[U]** |
| Mapping to the music clock | engine already has (T, P) and offset o (`clock.ts`): music position at input time e is (e·sr/1000 + o − limiterFrames)/sr, i.e. `rawTime()` (`clock.ts:260-264`) with p replaced by e | extrapolation over at most one frame; error is S3's measurement. Add `Audio.timeAt(performanceTime)` and `Music.positionAt(performanceTime)` | design |

What the mapping cannot see: speaker, Bluetooth, TV and display latency, input hardware latency. That is what calibration absorbs.

## 5. Calibration

How shipped games do it (search snippets; osu! wiki, Rhythm Quest devlog 10, OutFox, Clone Hero wiki, beatmania, Rhythm Doctor): a steady click or beat with the player tapping along; the offset is expected minus actual tap; **audio offset** (shifts judgement against the music) and **visual offset** (shifts note display) are separate numbers; a tap to audio measures audio+input latency, a tap to visuals measures video+input, and their difference is the A/V offset. Rhythm Doctor splits calibration into an A/V pass and an input pass. The sources gave no outlier method, so I simulated one (`calibrate-sim.mjs`, `calibrate-sim.out`, 5000 trials per cell, true offset 40 ms).

Absolute error ms p50/p95; tap noise sd 15 ms assumed (human sd 15-25 ms is **(est.)**), 4 settling taps dropped:

| taps N | mean, clean | median, clean | mean, 10% outliers | median, 10% outliers | MAD-trimmed median, 10% |
|---|---|---|---|---|---|
| 8 | 3.6 / 10.6 | 4.1 / 12.0 | 16.7 / 67.9 | 4.7 / 14.1 | 4.7 / 13.7 |
| 16 | 2.6 / 7.5 | 3.1 / 8.9 | 14.7 / 45.1 | 3.3 / 9.7 | 3.2 / 9.5 |
| 32 | 1.8 / 5.2 | 2.2 / 6.4 | 10.5 / 31.5 | 2.4 / 7.2 | 2.3 / 7.0 |
| 64 | 1.3 / 3.7 | 1.6 / 4.6 | 7.7 / 22.3 | 1.7 / 5.1 | 1.7 / 5.0 |

Findings: a plain **median** is enough; MAD trimming adds nothing measurable. 16-32 taps after dropping the first 4 gives p95 error about 7-10 ms at human noise. Mean is unusable with misses. (This is a model: real human taps have a bias toward anticipating, drift and non-Gaussian tails **[U]**.) Report spread (MAD) and a "calibration looks unsteady, retry" flag when MAD exceeds about 40 ms (est.).

Recommended UX: play a click track at a fixed 100-120 BPM with a visible pulse; "tap to the beat" with any key, button or pad; discard the first 4 taps and any tap further than half a beat from a click; show the running median; finish at 24 usable taps; present a "test" step playing the song with the offset applied. Two passes (audio, then visual) only if the game has scrolling notes.

Persistence: per device profile, keyed by `AudioContext.sinkId`/output device label where exposed, else by a user-named profile; Bluetooth outputs change the offset by 100+ ms (est.), so re-prompt on `devicechange` or when the sink changes. Store in project/user settings, not the project file.

## 6. Native option (summary only)

Rhythm mode does not change ADR 0157's note. Exclusive-mode WASAPI at a 5 ms period measured 5-10 ms estimated output latency but takes the device from other apps, offers int16/int24 only, and 256 voices used 50-75% of a 5 ms period in the worst wake (M1 `wasapi/`). It would be a different backend behind the same `Audio.timeAt` contract. Keep it out of M4 and keep rhythm mode's API backend-agnostic.

## 7. Recommendations

**Rhythm mode contains (engine):**
1. `AudioContext` with the smallest `latencyHint` the engine can take (numeric 0, read back `baseLatency`), on the existing context-rebuild path (A3.4c) so the setting can toggle at runtime. Document that the browser clamps; no promised figure.
2. Public clock hooks: `Audio.latency` (read-only: reported base + output + limiter, with a "reliable?" bit set from sanity checks), `Audio.timeAt(performanceTime)`, `Music.positionAt(performanceTime)`. Everything else is already there.
3. A `Calibration` API: scripted click track, tap collection against it, 4-tap warm-up, median, MAD, confidence; returns audio offset. Plus a ready-made scene in `samples/`, not engine UI (games style it).
4. Leave the lookahead floor, limiter and STATUS cadence alone. Gains are 1.5 ms or less on typical paths and each costs late-command or headroom risk. Revisit the floor only if the SAB ring ships.
5. Hit sounds go asap, triggered from the input handler, judged by `event.timeStamp`.

**Promises:** (a) music stays sample-accurate; (b) heard-position error stays within S3's measured bound; (c) calibration removes constant error, not jitter; (d) no absolute latency figure; the table in section 2 is the expectation. Action games pay nothing.

## 8. Unverified list: owner's real-device run

On each target (Windows Chrome and Tauri WebView2, macOS Safari and Tauri WKWebView, Linux WebKitGTK if the core loads, Firefox on one desktop, Android Chrome, Android WebView in the Tauri/Capacitor shell, lowest-Android low-end phone):
1. For hints interactive, 0.005, 0, balanced, playback: `sampleRate`, `baseLatency`, `outputLatency`, `currentTime − getOutputTimestamp().contextTime`, over 10 s (stability), with `latency-probe.mjs` logic pasted in the page. Note whether `outputLatency` is 0/undefined/constant.
2. True click-to-ear latency per hint: an AudioWorklet click at a known context time recorded on an external recorder or loopback cable (desktop) or a 240 fps phone video of screen flash plus audio (phone); compare with the reported (T, P) prediction. That is the number that says if `getOutputTimestamp` is honest.
3. `event.timeStamp` vs `performance.now()` in the handler: delivery lag and its p99, for mouse, keyboard, touch (Android WebView), gamepad polled per rAF; coalescing of touch events.
4. Same on a cross-origin-isolated page, to see the resolution gain.
5. Hit-sound round trip: input event to click heard, asap path with postMessage (and SAB ring if COOP/COEP is available in the shell).
6. Bluetooth headphones on phone and desktop: calibration offset and the `devicechange` / `sinkId` behaviour.
7. WebKit: does `outputLatency` return 0? Is `getOutputTimestamp` monotonic?
8. Android: the baseLatency report on at least two phones (the 3200-frame anecdote).
9. Real human tap spread for the calibration model (10 people, 32 taps) to replace the sd 15-25 ms assumption.

## Reproduce
`node latency-probe.mjs` (about 5 s; set `CHROME=` to override the browser path; Playwright's current build is `/opt/pw-browsers/chromium-1243`). `node calibrate-sim.mjs` (about 2 s). No cargo, no timed run needed; nothing here depends on machine load except the numbers in the Chromium row, which are fake-sink values.
