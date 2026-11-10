# Audio events (M2, ADR 0158): handoff to start the build

Written 2026-11-10 at the end of the planning session. E1, E2 and the first part of E3 (E3a) were built in the session before; this session planned the rest as a milestone build. **Next session:** run the plan with run-milestone-build, starting at wave 0, then the pilot wave 1.

## Where things are

- **Branch:** everything M2 is on `claude/sweet-ritchie-miy6jm` (fast-forwarded from `origin/claude/vigilant-albattani-bm8i47`, `afd26f1`, plus this session's plan commits). **Nothing of M2 is on master.** `claude/vigilant-albattani-bm8i47` holds no work this branch lacks; the owner can delete it once this branch is pushed.
- **The plan, in three files plus the source:**

| File | What it holds |
|---|---|
| [2026-11-audio-events-m2.md](2026-11-audio-events-m2.md) | the source: milestones E1–E7, their content and exit checks (wins on content) |
| [2026-11-audio-events-m2-waves.md](2026-11-audio-events-m2-waves.md) | state at planning, what shippable means, task ids E3.1–E7.2 with day estimates and dependencies, the critical path, single-writer files, contracts C0–C6, waves W0–W4 with file lists, wave reviews, risks |
| [2026-11-audio-events-m2-tree.md](2026-11-audio-events-m2-tree.md) | the collision audit, the leaf protocol and brief, leads and 12 Haiku leaves per task, what the tree changes, the pilot's measures |
| this file | where things are, reading order, settled, open, how to start |

- **The plan was reviewed** by an agent that didn't write it; its findings are applied ("Independent review" in the waves plan).

- **The new files the plan creates** are listed in `docs/design/0157-audio-core/api-and-models.md` §6, "M2 additions".

## Read in this order

1. [ADR 0158](../decisions/0158-audio-events-and-parameters.md), all of it.
2. The waves plan, then the tree.
3. "E2: the contract" and "E3a: what's built" below (kept from the previous handoff).
4. The M2 entries at the end of `docs/design/0157-audio-core/build-log.md`; `native/audio/README.md`; the gotchas in [2026-11-audio-core-m1-handoff.md](2026-11-audio-core-m1-handoff.md).

## Settled (don't reopen)

- ADR 0158's owner decisions: main does only event-driven work; everything continuous runs in the core; voices stay in main's voice table and selection; sustain points are in M2; size gates are tripwires.
- E2's wire contract (below) is fixed. E2's deviations are logged and wait for the owner (O5), but no task changes them.
- The task ids, waves, file ownership and contracts in the waves plan. Changing a task's file list means re-running the collision audit for its wave.
- Plain looping clips start honouring file loop points only at E4.5, its own task (the one behaviour change for existing projects).
- The editor chain (E6.1 → E6.3 → E6.4 → E6.6) is the critical path, so E6.1 and E6.2 start in wave 1.
- The coordinator alone rebuilds and commits the wasm and `wasm/hash.json`, and alone edits the build log, `implementation-status.md`, `docs/README.md` and the records.

## Open

Owner-only:
- **O1, record number 0158 is taken twice.** `origin/claude/ecstatic-heisenberg-xg0fvc` (not merged) has `0158-one-field-row-edits-a-component-field-in-the-document-or-a-live-world.md`. Recommendation: whichever reaches master second renumbers; decide before M2's first merge to master.
- **O2, when M2 reaches master.** Recommendation: at each milestone end with the owner's approval (E3+E4 after W2, E5 after W3, E6 after W4).
- **O3, the native automation budget.** E2 measured 25–45 µs p99.9 on the shared container against 0158's 30 µs; it needs a lab-VM run (E5.5), and a decision if it misses.
- **O4, the listening pass** of the sample events (E7.1).
- **O5, E2's deviations** (below): accept, or ask for changes.
- From M1, still open: the three remaining C3 soaks, reference-machine budgets, the signed listening pass, Flappy's music licence, the public seek API proposal, band-limited resampling (#110); GitHub issues #50, #100, #104.

For the leads, with the plan's recommendation (the lead decides and reports; the coordinator logs it):
- **How a stream's loop is released** (E4.4, decided first). The ring holds up to ≈ 0.68 s the worker has already wrapped, so a worker-only release lands late. Recommendation: an epoch seek that flushes the ring at the release frame; a change to `audio-core`'s stream path if that isn't sample-accurate. If neither is, ask the owner whether 0158 §4's "exact frame" applies to streams.
- **Where a streamed WAV's trailing `smpl` chunk is read** (E4.1, before E4.4 starts). Recommendation: the worker reads the RIFF chunk list once at stream open (a ranged read of the tail when the `smpl` chunk follows `data`), so stream open already knows its region.
- **Curve ids are never freed** (1024 cap, warns). Recommendation (E3.6): keep, since curves are cached per event asset for the page; document the cap in the guide (E5.2).
- **Seeding per World** (0158 §6) rather than one generator per page (E3.6). Recommendation: one generator per World key, all seeded from `audio.seed` plus the World's key.
- **An editor field for sidecar `loopStart`/`loopEnd`** isn't in the source table. Recommendation: a follow-up after M2 unless the owner wants it in E6.

## Starting the build

1. Baseline: `npm ci`; `npm run typecheck`; `npm test` (known flake: `src/engine/tests/navSample.test.ts` fails under full-suite load and passes alone); `npm run build`; `cargo test` in `native/audio/`; `npm run check:audio-metered`.
2. Wave 0 (coordinator): commit contracts C1 (`runtime/loopPoints.ts` stub), C2 (`decoder/protocol.ts` fields) and C3 (`AudioDebugInfo.voices[].event`); log the STATUS-`group` deviation and E2's list in the build log; ask the owner about tickets (O2 can wait).
3. Wave 1, the pilot, in one message: leads for E3.1 (strongest), E3.2, E3.6, E4.1, E6.1, E6.2 (mid), each in its own worktree, each told to commit its skeleton first and return leaf briefs (E4.1, E6.1, E6.2 have leaves). Then the four leaves (L4.1a, L6.1a, L6.2a, L6.2b) on Haiku in one message.
4. The first wave review: the checklist in the waves plan, plus the pilot's measures (leaf first-pass success, lead time on skeletons and briefs, tokens by model) in the build log; adjust the tree for wave 2 if a leaf kind needed more than one re-run.

## E2 and E3a detail (from the previous handoff)

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

### E3a: what's built (in `src/plugins/audio/runtime/events/`)
- `automation.ts`: the `AutomationSink` interface a backend implements (`defineCurve`, `setParam`, `bindVoice`, `bindBus`, `setLoop`), the capacities (mirroring E2's), `evaluate`, `ParamState`, and `TsAutomation`, the fallback evaluator run once per frame on backends without a sink. It drives voices through `setVolume`/`setPitch`, buses through the new `mixer._setAutomation` (`engine/audio/mixer.ts`), and loops through the voice's optional `setLoop`.
- `eventRuntime.ts`: `EventSystem` (one per page, `events()`) and `EventInstance`. Loading and caching assets; group and curve id allocation; global parameters from the project; cooldown and instance limits (oldest/quietest/none); the seeded RNG (`audio.seed`, mulberry32); the tree walk for all seven node types (random with weights and avoid-repeat kept per node across plays, step sequences with reset, switches re-picked on parameter change with keep/restart/crossfade, blends as generated volume curves, layers, sustain containers with now/loopEnd release, continuous random/sequence chained with `at` from known clip lengths or polled when unknown); a timer heap checked once per frame; re-sending everything when the backend object changes.
- `backend.ts`: `PlayRequest.group`; optional `AudioVoice.setLoop`; optional `AudioBackend.automation`, `clipDuration(path)`, `horizon()`; `AudioEventHandle`; `AudioDebugInfo.events`.
- Public API: `Audio.play`, `Audio.setParameter`, `Audio.getParameter` (`Audio.ts`, with `EventHandle`), exported from `myco` with `AudioEventHandle` and `EventOptions`; `Audio.debug()` adds `events`. `AudioSource.clip` accepts `"audioEvent"` assets and plays them as instances (volume follows as the instance fade, spatial events follow the node), with `setParameter`/`getParameter`/`release`. `audioSystem.ts` calls `events().update(dt)`.
- The fake backend (`runtime/testing.ts`) gained `durations`, `horizonTime` and a recorded `setLoop`. Smoke tests: `events/events.test.ts` (8 cases).
