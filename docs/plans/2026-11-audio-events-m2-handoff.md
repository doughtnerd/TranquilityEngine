# Audio events (M2, ADR 0158): handoff after E1, E2 and part of E3

**Goal.** Build [ADR 0158](../decisions/0158-audio-events-and-parameters.md) (Accepted 2026-11-10), 0157's roadmap M2: audio event assets, parameters, automation, sustain, editor authoring. The milestone table is [2026-11-audio-events-m2.md](2026-11-audio-events-m2.md) (E1–E7). This file says where the build stands and what the next session should do. It's written for a session that plans and runs the rest as a milestone build.

## Read first
- ADR 0158, all of it. Owner decisions in it: **main does only event-driven work; everything continuous (parameter smoothing, curves, blends, sustain loops) runs in the core**; voices stay in main's voice table and selection; sustain points are in M2; size gates are tripwires (mixer 256 KB), not design constraints.
- The plan above, and the M2 entries at the end of `docs/design/0157-audio-core/build-log.md`.
- `native/audio/README.md` (core build, wire, goldens, metered gate) and the 0157 handoff's gotchas in `docs/plans/2026-11-audio-core-m1-handoff.md`.

## State

| Milestone | State |
|---|---|
| E1 foundations | **Done**, committed (`src/engine/core/curve.ts`, `src/engine/audio/eventFormat.ts`, `audio.parameters`/`automation`/`seed` in `engine/audio/settings.ts`, the 256 KB tripwire). Tests in `src/engine/tests/{curve,audioEventFormat,audioSettings}.test.ts` |
| E2 core automation and sustain (Rust) | **Done**, merged (`782bb8f`): `audio-core/src/automation.rs`, `tests/automation.rs`, ABI 1.4, the five opcodes, command-writer methods, three goldens, five metered scenes. See "E2" below for deviations |
| E3 event runtime (TypeScript) | **Partly done**, committed as work in progress; see "E3" below |
| E4–E7 | Not started |

### E2: the contract (fixed)
The wire contract the TypeScript side is written against. ABI 1.3 → 1.4, no wire major bump:
- **0x08 SET_LOOP** (voice): `u32 loopStartFrame; u32 loopEndFrame (0 = clip end); u32 flags (bit0 looping)`. Clear `looping` = release: finish the pass, play on to the clip's end. Clip voices only in E2 (streams are E4).
- **0x09 AUTOMATE** (voice): `u32 bindingCount`, then `u16 param (bit15 global, else local slot of the voice's group); u16 curve; u32 target (0 volume, 1 pitch, 2 lowpass)`. Replaces the list; ≤ 8.
- **0x13 CURVES**: `u32 firstCurve; u32 curveCount`, per curve `u16 keyCount; u16 reserved`, keys `f32 x; f32 y; u32 interp (0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut)`. 1024 curves × ≤ 32 keys.
- **0x14 PARAM**: `u16 group (0 global); u16 slot; f32 value; f32 seekPerSecond`. 64 global slots; groups 1..1024 × 16 local slots.
- **0x15 BUS_AUTOMATE** (voiceId = bus): same binding items, global params only, volume/lowpass.
- Per quantum: smooth params, evaluate each bound curve once, ramp gain across the quantum; lowpass = min with the slot's/BUS_MIX's. Voices without bindings must render bit-identically (existing goldens unchanged). The subagent was also asked to add command-writer methods (`setLoop`, `automate`, `param`, `curves`, `busAutomate`) in `src/plugins/audio/runtime/core/commandWriter.ts`, goldens for the three new behaviours, metered-bench scenes, and the five rows in `api-and-models.md` §4.2.

**E2 results.** `cargo test` 478 passed; existing goldens and parity digests unchanged; mixer wasm 147,384 → 178,265 B (256 KB tripwire); new `Automation` region 1,564,352 B at the default preset (232 B per voice, 120 B of it the voice's low-pass filter), layout total 25,362,432 B. Metered: old scenes −1.59%..+0.01% (baseline untouched); new scenes automation 13.46 M, automation-base 9.65 M, automation-virtual 1.38 M, bus-automation 2.10 M, sustain 5.26 M instructions per quantum. Native cost of the update and curve evaluation at 256 voices × 3 bindings on the shared container: p99.9 25–45 µs against the 30 µs budget, **needs a lab-VM run**; the per-voice low-pass filtering adds ≈195 µs on top of a 380 µs base in the full scene.

**E2 deviations (accept or revisit):**
- M1's core never applied per-voice `lpHz`. Now only voices with a low-pass binding are filtered, at min(lpHz, lpAuto); unbound voices stay bit-identical to M1 (still unfiltered).
- AUTOMATE, PARAM and CURVES apply on arrival, not stamped (a pending record can't hold 8 bindings); the writer orders AUTOMATE after its PLAY.
- Pitch automation ramps per frame; virtual voices advance at the block's mean pitch multiplier.
- A voice already past `loopEnd` when SET_LOOP arrives plays on to the end. Stream voices ignore SET_LOOP (E4).
- `commandWriter.curves()` splits uploads into 32 KB records; past the 256 KB staging area (≈660 full curves) a batch drops the rest, so upload per asset.
- No `group` in STATUS (STATUS has no voice section); main knows each voice's group. ADR 0158 §6's line about STATUS should be noted as a deviation.

### E3: what's built (in `src/plugins/audio/runtime/events/`)
- `automation.ts`: the `AutomationSink` interface a backend implements (`defineCurve`, `setParam`, `bindVoice`, `bindBus`, `setLoop`), the capacities (mirroring E2's), `evaluate`, `ParamState`, and `TsAutomation`, the fallback evaluator run once per frame on backends without a sink. It drives voices through `setVolume`/`setPitch`, buses through the new `mixer._setAutomation` (`engine/audio/mixer.ts`), and loops through the voice's optional `setLoop`.
- `eventRuntime.ts`: `EventSystem` (one per page, `events()`) and `EventInstance`. Loading and caching assets; group and curve id allocation; global parameters from the project; cooldown and instance limits (oldest/quietest/none); the seeded RNG (`audio.seed`, mulberry32); the tree walk for all seven node types (random with weights and avoid-repeat kept per node across plays, step sequences with reset, switches re-picked on parameter change with keep/restart/crossfade, blends as generated volume curves, layers, sustain containers with now/loopEnd release, continuous random/sequence chained with `at` from known clip lengths or polled when unknown); a timer heap checked once per frame; re-sending everything when the backend object changes.
- `backend.ts`: `PlayRequest.group`; optional `AudioVoice.setLoop`; optional `AudioBackend.automation`, `clipDuration(path)`, `horizon()`; `AudioEventHandle`; `AudioDebugInfo.events`.
- Public API: `Audio.play`, `Audio.setParameter`, `Audio.getParameter` (`Audio.ts`, with `EventHandle`), exported from `myco` with `AudioEventHandle` and `EventOptions`; `Audio.debug()` adds `events`. `AudioSource.clip` accepts `"audioEvent"` assets and plays them as instances (volume follows as the instance fade, spatial events follow the node), with `setParameter`/`getParameter`/`release`. `audioSystem.ts` calls `events().update(dt)`.
- The fake backend (`runtime/testing.ts`) gained `durations`, `horizonTime` and a recorded `setLoop`. Smoke tests: `events/events.test.ts` (8 cases).

### E3: what's left
1. **Wire the core backend** (`core/coreBackend.ts`) to E2's command-writer methods (`setLoop`, `automate`, `param`, `curves`, `busAutomate` in `core/commandWriter.ts`): implement `automation` over the command-writer methods; `clipDuration` from the clip registry (frames / rate); `horizon()` from the clock map (the audio-clock time of `framesNow + lookahead`); carry `group` in PLAY; keep a mirror of curves, params, bindings and loops and **replay them in a rebuild's REPLAY** (`core/replay.ts`, `recovery.ts`); update main's audibility for bound voices when a parameter changes (evaluate the curves at the target with `curve.ts`), so selection sees automation.
2. **The Babylon fallback**: `setLoop` on its voices (`AudioBufferSourceNode.loopStart`/`loopEnd`; release clears `loop`); `clipDuration` from the buffer.
3. **The `PendingCoreBackend`**: the runtime already re-sends on backend change; check a voice played while the core loads keeps its loop and bindings after the hand-over.
4. **The Rust–TypeScript parity test**: the same parameter/curve scenes through `TsAutomation` and the core (loopback host), within a tolerance.
5. **More tests** (the plan's E3 list): continuous containers with known and unknown lengths, crossfade switch, blend edges, sustain container now/loopEnd, steal oldest/quietest, cooldown, group exhaustion and reuse, backend switch re-send, `AudioSource` with an event, debug rows; wasm goldens for a layered, a blend, a continuous and a sustained-then-released event.
6. **Known rough edges to review:** `EventInstance.playing` retires the instance from inside a getter (works, but surprising); curve ids are never freed (1024 cap, warns); seeding is one generator per page, not per World as ADR 0158 §6 says (log the deviation or fix); `voices[].event` in `Audio.debug()` isn't filled yet; `AudioSource` pitch changes on an event apply only at the next play; STATUS doesn't carry `group` (main knows it; the record's line about STATUS can be dropped as a deviation).

### E4–E7
As in the plan. E4 (loop points from WAV `smpl` / Ogg `LOOPSTART`/`LOOPLENGTH`, sidecar `loopStart`/`loopEnd`, stream region loops in the decoder worker) is independent of E3. E6 (editor) can start on the shared `CurveEditor` move and the `audioEvent` asset kind at any time.

## Checks at handoff
- `npm run typecheck` green; `npx vitest run src/plugins/audio src/engine/tests/audio* src/engine/tests/curve.test.ts` green (one existing assertion updated: `Audio.debug()` now includes `events`).
- Full `npm test`: 379 files, 3,958 passed (one existing expectation updated: `AudioSource.clip` offers `["audio", "audioEvent"]`). `npm run build` green.
- After merging E2: `cargo test` 478 passed; `npx vitest run src/plugins/audio src/engine/tests` 2,588 passed; `npm run check:audio-metered` pass (−0.23% overall); `npm run typecheck`, `npm run build` and `npm run check:links` green.

## Owner items still open from M1
The three remaining C3 soaks, reference-machine budgets, the signed listening pass, Flappy's music licence, the public seek API proposal, band-limited resampling (#110). GitHub issues #50, #100, #104 are still open.
