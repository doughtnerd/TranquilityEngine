**Verdict: approve with changes.** Top 3 concerns: (1) the bus-gain composition is undefined: stamped ramps, authored and runtime values, presence and level ducking, and 0158 automation have no stated owner or combining rule, and the master loudness tap is in the wrong place; (2) the profile stream's clock, epochs and CPU fields are not safe across cadence changes and rebuilds; (3) index-stable BUS_CONFIG is a much larger change than "a difference": today a bus's index is its position in `project.json`.

Read: the record, goal.md, the spike README and all five sub-spike READMEs, `timed-runs.log`, 0097, 0158, 0162 (ladder), 0170, and the code cited below.

## Issues

1. **major: the master meter is in the wrong place.** Bus meters sit at each bus's output (`audio-core/src/bus.rs:575`). The shared reverb's wet signal is added *after* the tree, then MASTER, then the limiter (`bus.rs:586-600`, `:29-33`). Metering the root bus therefore misses the reverb return and the limiter, and a true-peak ceiling is about the limiter's output. **Change:** meter master on the post-limiter output, record MASTER volume and the hidden-tab mute (`background.ts:5-7`) in the stream, and suspend the target check while MASTER ≠ 1.
2. **major: the bus-gain composition is unspecified.** One linear stamped ramp can't carry a fade that is linear in volume (`mixer.ts:183-188`) times a snapshot transition (`:189-196`) times an exponential duck (`:197-209`). 0158's automation already multiplies inside the core (`bus.rs:556-571`). Today ducking takes the **lowest** multiplier any rule asks for (`mixer.ts:198-202`). If presence ducking is folded into BUS_MIX on main and level ducking runs in the core, the two multiply, and one target is ducked twice. **Change:** the core holds a separate stamped lane per factor (authored, runtime fade, snapshot, duck) and multiplies them per sample. Both ducking modes are combined in the core by `min`, with presence fed by a flag per bus. STATUS reports each bus's duck gain, so main's audibility estimate for selection (`coreBackend.ts:690-692`) sees it.
3. **major: index-stable routing touches every bus consumer.** Indices are positions in `settings.buses` (`coreBackend.ts:765-770`). Other code depends on that: the remap path (`context.ts:875-891`), the bed plan (`coreBackend.ts:741-751`), automation (`:777`) and the hard rebuild's replay (`:794-799`). A bus's identity is its name, so a rename counts as a removal plus an addition. `mixer.configure` resets script volumes, fades and the snapshot (`mixer.ts:80-91`), so it can't be the path for live edits. **Change:** a session slot table (name → slot, with tombstones) owned by `coreBackend`, plus an explicit rename operation. Replay that table on a rebuild, compact it at Stop, and report when an appended bus hits the preset's `max_buses` (`bus.rs:5`).
4. **major: the stream has no defined clock or ordering.** STATUS carries the context's `currentFrame` plus the worklet's `Date.now` (`coreDriver.ts:1040`). Main events have no stated clock. Frames restart at 0 on a context rebuild (`clock.ts:119-122`), and a rate rebuild changes the sample rate (`deviceChange.ts` rules 2 and 6), but the header holds a single rate. **Change:** every record carries (epoch, frame, seq). A main event carries the frame of the command it causes (or `framesNow`) plus `performance.now`. An EPOCH record (reason, new rate) and a keyframe are written at every rebuild. Records are ordered by (epoch, frame, seq), and the record should state that the heard clock trails the rendered frames by the limiter's latency (`clock.ts:7-9`).
5. **major: make the CPU and work-unit fields cumulative.** `workUnits` is a sample of the last quantum (`counters.rs:392-395`), so refitting it against a 256 ms sum is biased. The cadence switches between 6 and 48 quanta without resetting `sinceStatus` (`coreDriver.ts:976-979`), and posts are skipped when the pool is empty (`:1020-1024`). **Change:** STATUS carries monotonic `busyMsTotal`, `quantaTotal` and a work-unit total per section. Main sets the windows by quantum count, not by STATUS block. Deltas are clamped (`Date.now` is a wall clock that can step; the probe already re-anchors, `coreDriver.ts:412-415`).
6. **major: STATUS has no headroom left.** The worst case is 16,192 of 16,384 B (`audio-wire/src/schema.rs:73-74`). Nine metered buses at 28 B each (252 B) overflow it before the section units are even added. `status.rs:565` will fail, and in a running game `coreDriver.ts:1032` drops the block. **Change:** §10 raises `STATUS_BUFFER_BYTES` (20 KB, which costs 32 KB more for the pool) and says so.
7. **major: loudness loses data when main stalls.** The core's ring covers 400 ms (loudness README). The pool has 8 buffers (`bufferPool.ts:71-73`). Main stalls longer than that at Play start. **Change:** a 32-entry ring in the core, and STATUS sends only the sub-blocks since the last *successful* take (a take happens only when a pooled buffer is available, `coreDriver.ts:1019-1028`). Surface `Feed.lost` (`loud.rs:285-288`) as "integrated incomplete".
8. **major: shedding priority is inverted.** The ladder cuts audible zones (0170 Context) while inaudible metering keeps running. **Change:** add a first step that pauses non-master loudness (flagged as a gap) and true peak; sidechain is never shed. The live refit stays on main and never feeds the cap (`cap.rs:99-108`).
9. **minor: gated true peak.** A fixed -6 dBFS gate misses crafted signals (loudness README, Unverified). **Change:** report max(TP, sample peak) so a reading never falls below the sample peak; put the gate relative to the ceiling (ceiling − 6 dB); count gated quanta so a reading is marked as a lower bound.
10. **minor:** §6's "parameter-driven bus automation become ramps" is already true on the core path (`bus.rs:47-49`, 0158 E2). Say it applies only to Babylon.
11. **minor:** the recorder must copy each STATUS within the callback, because the reader reuses one block (`statusReader.ts:54`). Holding pooled buffers starves the pool, and after 1 s without STATUS the host rebuilds for a stall (`deviceChange.ts` `STALL_MS`). Keyframes should key on the STATUS count, because rAF stops in a hidden tab (`background.ts:9-10`).
12. **minor (security):** a capture is untrusted input to the desktop editor. Cap the decompressed size (a deflate bomb), decode in a bounds-checked Worker, and parse the name table only as data. The release trigger should cap the number of saved files.

## Failure modes

| Event | What breaks | Required behaviour |
|---|---|---|
| Trap, device or stall rebuild | The core's loudness `seq` restarts, so `Feed`'s `wrapping_sub` (`loud.rs:283`) counts ~4e9 lost; frames restart at 0 | An EPOCH record; reset `Feed`; integrated continues on main |
| Rate rebuild mid-capture | One rate in the header | EPOCH carries the rate; the K-weighting coefficients are rebuilt with the new core |
| Capture across a rebuild | The delta chain breaks | A keyframe right after EPOCH; a gap record for the dead time (a trapped driver posts nothing, `coreDriver.ts:571-575`) |
| Ring full | Eviction is by keyframe segment (capture README); fine | Capture and editor recording run in the same ring: refuse a second writer |
| Live edit during a rebuild | Replay must use the slot table, not project order | Replay the end state of an in-flight crossfade, never half of it |
| Live edit while shedding | An appended bus past `max_buses` is dropped silently (`bus.rs:5`) | The editor shows it as refused |
| Backgrounding (`pause`) | The context suspends; `Date.now` gaps | No quanta means no busy time; a hidden page gives an EPOCH-less gap record |
| Coarse clock (Firefox resistFingerprinting, WebKit [U]) | A 256 ms window is meaningless | Detect the step (the smallest non-zero delta), widen the window or hide the line. Tauri on macOS and Linux is WebKit, so the desktop editor's CPU line is unverified there |

## Performance

- **Budget unit.** State the audio-thread budget in metered instructions as well (deterministic, README "How the numbers were taken") and convert it with 0169's floor factor. Container µs plus 50% headroom says nothing about the Pixel 8. High is already over 1.3 ms p99.9.
- **Methodology.** S3's main-thread timings ran at load ≈ 2.0 straight after S2's spinner (`timed-runs.log` lines 7-8), not on an idle machine. The capture README's tables are smoke runs (raw copy 6 µs vs 3.2 µs in the summary). S2 validates its truth against `Date.now`, then judges `Date.now` against that truth (partly circular), using a JS kernel rather than `audio-core`. Gated loudness depends on content: a hot mix costs 13.8 / 36.3 µs, not 10.3 / 24.7. No run measured the real core with M5 added end to end.
- **Main.** The ≤ 1 ms/s figure is p50 × rate. Allocating 370 B per block is ≈ 23 KB/s of garbage, and a keyframe's p99 at 1,024 voices on a phone (≈ 5×, est.) is ≈ 0.5 ms. Add an editor UI budget: drawing the profiler timeline in Play shares main with the game; set ≤ 2 ms a frame, canvas only, no Preact render per STATUS.
- **Memory.** Size the capture ring from `navigator.deviceMemory` and the preset, not the preset alone. Compress at save with a streaming `CompressionStream`, off the frame.

## Cheaper alternatives

- Cumulative counters (issue 5) instead of a windowed `loadPermille` in the core: less core code, independent of cadence.
- Send only new loudness sub-blocks (≈ 8 + 4n B) instead of a fixed 28 B ring.
- For structural live edits, a 20 ms dip of the affected subtree (fade out, apply, fade in) instead of running old and new routing side by side; one code path, at the cost of a brief dip.
- A session slot table instead of stable bus ids in `project.json`.

## Questions for the author

1. Where exactly is master metered, and does MASTER volume count?
2. Is "at most 8" in addition to master or including it?
3. Who combines presence and level ducking, and is presence still counting virtual voices (`coreBackend.ts:778-780`)?
4. Is the sidechain tap pre-fader? A post-fader tap means soloing Music silences Voice and releases the duck.
5. After a rebuild, does integrated loudness continue or restart?
