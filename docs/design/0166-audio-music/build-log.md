# Interactive music M4: build log

The coordinator's log of each wave review ([waves plan, "Wave reviews"](../../plans/2026-11-audio-music-m4-waves.md#wave-reviews)): what landed, the numbers measured, deviations from the design, decisions taken while the owner was away, and reserve days used. Work merges into the M4 integration branch; each milestone goes to master only with the owner's approval (waves plan, "Branch and merge policy"; owner item O2: a merge commit, not a squash).

**Integration branch:** `claude/awesome-bell-c0nnx0` on origin (the build session's designated branch). It started at `origin/master` `c3f2e9b` ("M4 plan: owner decisions O1-O5 recorded"), which already holds the design and the plan.

**What's merged and what's open** lives in [implementation-status.md](../../architecture/implementation-status.md) (the 0166 row) once M4-0 lands; until then, in this log.

## For the owner (summary, newest first)

**Standing instruction (owner, 2026-11-11, at the start of the build):** "My instruction is to merge milestones to master upon completion." Each milestone merges to master (a merge commit, O2) as soon as its milestone-end checks and exit criteria pass, without asking first. The owner-only items of that milestone (its listening section, lab-VM and phone runs) don't hold the merge; they're listed here as open. This replaces the plan's "with the owner's approval" for milestone merges.

**Needs you:** nothing yet.

**Decisions taken (each with its revert):** see "Decisions" below.

## Decisions

Numbered; superseded entries are marked, not rewritten.

- **D1 (W0) The Q0 contract adds members the plan's Q0 row names in prose only.** `MusicBackend` (the operations C10 lists) is one optional `AudioBackend.music` object, not loose members on `AudioBackend`, so a backend without music leaves out one field. Also optional on `AudioBackend`: `beginFrame` (§6 step 0), `timeAt` and `latency` (§1.3). On `AudioVoice`: an optional `fadeShaped(ShapedFade)` (a stamped FADE or STOP with a law and start phase, §4.2). On `PlayRequest`: `fadeZero`. Why: C10 lists operations, not member names; grouping them follows the existing optional-feature style (`automation`). Revert: flatten the members into `AudioBackend` (types only; no task has used them yet).
- **D2 (W0) `MusicEvent.handle` is typed as `MusicEventHandle`**, a small interface in `engine/audio/musicTypes.ts` (`playing`, `music`, `onMusic`, `trigger`) that the plugin's `AudioEventHandle` extends. Why: §1.4 needs `Component.ts` to name `MusicEvent` without importing the plugin, and §1.1 types its `handle` as `AudioEventHandle`, which lives in the plugin. Revert: none needed; a script sees the same members through either name.
- **D3 (W0) The peaks message (Ed1) and the encoded-cache miss rule are Q0's.** `computePeaks { id, asset?, bytes, hint, binFrames }` answered by `peaks { id, rate, channels, frames, binFrames, bins, peaks }` with `peaks` as int16 `[min, max]` pairs per bin, channel-major (the base level; `peaksMip.ts` builds the mips). Miss rule: a `primeGroup` member without `bytes` whose path the worker doesn't hold is answered with `needBytes`; main resends only those members with `bytes`; the worker never fetches. Also added: `protectMusic` and `releaseMusic` (C8's protected paths and the instance release). Revert: change the message shapes before D1a and Ed1 merge.
- **D4 (W0) `music.rings` absent reads 12** (the default preset); the editor's low and high presets write 8 and 16 (`MUSIC_RINGS_PRESETS`). Why: §2.1 gives the presets but no value for an absent key on a project that set no preset; the default preset's value matches `voices`' defaults (the default preset's 128 mixed).

- **D5 (W1) Rolling starts for pure-TypeScript tasks.** A later-wave task starts as soon as its dependencies are merged and its files are disjoint from every running task's, instead of waiting for the wave's end. First: F1b, F3, G1 after F1a. Why: G1 is on the 47.5-day pure chain; M3 ran "rolling starts" the same way. The wave-end checks still run per wave. Revert: hold later-wave tasks to their wave.

## Wave 0 (2026-11-11, base `origin/master` `c3f2e9b`)

**State checked in the repository** (the plan's "State at planning" holds, with these corrections):
- `origin/master` is `c3f2e9b`: the plan was fast-forwarded into master at the end of planning (owner item O5), so the integration branch starts at the commit that holds the plan. The local clone was shallow with a stale `origin/master` ref; after `git fetch --unshallow` it matches.
- **The toolchain:** `native/audio/rust-toolchain.toml` pins 1.99.1, and rustup in this container installed it on first use (the plan expected 1.97 with metered counts +1–4% over `baseline.json`). Metered counts here are therefore comparable to the baselines exactly. `wasm32-unknown-unknown` was added.
- Disk: 30 GB free of the session allowance at the start; 4 cores, 15 GB RAM.

**Baseline** (clean `c3f2e9b`, before any task; one run each, sequential):

| Check | Result |
|---|---|
| `npm run typecheck` | pass (26 s) |
| `npm test` | 2 failures of 4,993 (467 of 469 files). `piratesSample.test.ts`: a known flake, passes alone. **`piratesNavigation.test.ts` "sails round an obstacle to a goal on its far side in rocky-maze" fails on master every time (3 of 3 alone)**: a known failure outside audio (navigation, ADR 0164's coordinate change), not M4's; wave ends treat it as known. *Q0's first edits were written while this run was in progress; none touch the pirates sample.* |
| `cargo test --workspace` (`native/audio/`) | pass, 707 tests (103 s) |
| `npm run check:audio-metered` | pass, all scenes +0.82% against the baselines with the pinned 1.99.1 (40 s) |
| `npm run build` | pass (59 s) |

**Q0 (contract: main-side types)**, committed on the integration branch:
- `src/engine/audio/musicTypes.ts` (new): `GridSpec`, `MusicKind`, `MusicSeekResult`, `GridPoint`, `MusicEventHandle`, `MusicEvent`, `MusicPositionAt`, `MusicHandle`, `CalibrationResult`, `CalibrationApi`, `AudioLatency` (§1.1, §1.2, §1.3, §1.5).
- `runtime/backend.ts`: `AudioDebugInfo.music` / `musicTotals` with `MusicDebugRow`, `MusicDebugPending`, `MusicDebugTotals` (§1.6, C11); `MusicBackendCaps`, `FadeLaw`, `ShapedFade`, `MusicGroupMember`, `MusicGroupRequest`, `MusicAdmitResult`, `MusicPrimedState`, `MusicGroupStamp`, `MusicGroupEvent`, `MusicBackend` (§4.6, C10); optional `AudioBackend.music`, `beginFrame`, `timeAt`, `latency`; `AudioVoice.fadeShaped`; `PlayRequest.fadeZero`; `AudioEventHandle` extends `MusicEventHandle` (D1, D2).
- `runtime/Audio.ts`: placeholder `music` (undefined), `onMusic` (no-op) and `trigger` (false) on the event handles, so the interface stays implemented; Q2 replaces them with delegations.
- `runtime/decoder/protocol.ts`: `primeGroup`, `cancelGroup`, `protectMusic`, `releaseMusic`, `computePeaks` (requests); `groupOpened`, `needBytes`, `peaks` (replies); the miss rule (D3).
- `src/engine/audio/settings.ts`: `music.rings` (0..16, default 12) and `rhythmMode` (boolean), both inert (D4), with `src/engine/tests/audioSettingsMusic.test.ts`.
- Checks: typecheck clean; the four settings test files pass (104 tests).

## Wave 1 (pilot; base `da2be07f`)

Started 2026-11-11 at about 22:00 UTC, all six leads in one message, each in its own worktree:

| Task | Lead model | Branch | Flow |
|---|---|---|---|
| Z1 → W1 (wire) | mid | `m4/wire` | merge 1 (Z1 and every §4.5 constant) → leaf L-Z1a; merge 2 (W1, ABI 3.0, TS init) → leaves L-W1a, L-W1b |
| Q1 (core skeleton) | strongest | `m4/q1` | stage A (modules, counters, `core.rs`) now; stage B (regions, 176-B header) on merge 1 |
| Q2 (main-side skeleton) | strongest | `m4/q2` | merges after the wire's merge 2 (the `testing.ts` overlap) |
| F1a (format head) | mid | `m4/f1a` | skeleton → leaves L-F1aa, L-F1ab |
| Ed1 (peaks) | mid | `m4/ed1` | skeleton → leaf L-Ed1a |
| S0 (smoke spec) | mid | `m4/s0` | unsplit; `E2E_PORT=4311` |

Merge order inside W1 (plan): wire merge 1, Q1, wire merge 2, Q2; F1a, Ed1 and S0 when ready.

**Master merged in (2026-11-11):** `79af3d85` (#169, the pirates rock nav footprints) fixed the baseline's `piratesNavigation` failure; merged into the integration branch as `0a024003`; the test passes (4 of 4). It is no longer a known failure.

**S0 merged** (`m4/s0` → `634ab666`): `tests/e2e/audio-music-smoke.spec.ts`, 3 of 3 green (12–14 s each). It drives the sound-lab's engine event with `handle.fade(0, 0.3)` (checked on the Engine bus meter: a faded voice reads `virtual`, and the voice row's `gain` doesn't follow fades), and a stamped spatial one-shot with `reverbSend`, `lowpass` and `highpass` (`at: Audio.time + 0.3`), and records `splitQuanta` as an annotation ("not reported yet" today). **Follow-up for Z3 (on its brief):** the fade case is unstamped, because no public call stamps a fade yet; when Z3 flips the expectation to `splitQuanta === 0`, it must also make that fade stamped (through `AudioVoice.fadeShaped` with `at`), or the case doesn't test the M4-0 exit check.

**Ed1 merged** (`m4/ed1`, leaf L-Ed1a first pass): the worker `computePeaks` case (chunked decode, bins straddling chunks, unknown-length MP3), `decoderClient.computePeaks`, `editor/music/peaks.ts` (cache per path and mtime, shared in-flight requests, a newer mtime cancels the older computation, failures not cached) and `peaksMip.ts`. **Acceptance measured** (8 three-minute stereo 44.1 kHz WAV stems, the real client and service, the handler on a worker thread, 3 runs): worker ≈ 300 ms per stem; **main thread 8–12 ms per stem, longest event-loop stall 6–10 ms**. The lead first kept the bytes for a crash repeat, which cost ≈ 80 ms of main thread per stem (a 30 MB copy) and stalls of 640–850 ms; it dropped that (a worker crash rejects, and the service asks again). Caveats: WAV, so the worker time is mostly reduction, not codec decode; no shipped-browser `Worker` run. The coordinator corrected one doc comment the leaf flagged (`pickLevel` gives one to two bins per pixel, not "about one").

**F1a merged** (`m4/f1a`, leaves L-F1ab and L-F1aa both first pass): `musicFormat.ts` (segment model, lenient parse, ids, limits, writer `musicNodeToJson`) and `musicPosition.ts`; 89 tests (39 limits, 42 positions, 8 writer round trip). Interpretations the spec leaves open: `bpm` 1..1000, `gridOffset` ≤ 3,600 s, bar ≤ 99,999 (a metre-change marker that would snap past it is dropped, "no bar after"); `start` allowed in `cues.at` and `regions.from`, `end` in `cues.at` and `regions.to`; segment-level `automation` is ignored with a problem; segment `plays` 1..64 parsed; error-level problems are prefixed `error: ` (`isMusicError`); a tempo field a marker omits keeps the previous marker's value; positions are stored as canonical strings. **For F1b's brief:** `formatAudioEvent` must route music nodes through `musicNodeToJson` (a plain `JSON.stringify` writes the ignored `pitch` and `fade` keys); F1b owns the placement rule and `NodeBase.id`; `musicFormat.ts` imports only types from `eventFormat.ts`, so no cycle.

**Rolling start (D5):** F1b, F3 and G1 (wave 2, pure TypeScript, each depending only on F1a) start now rather than at W1's end, because G1 is on the pure dependency chain and none of them touches a W1 file.

**Q1 stage A** (`m4/q1` `7ee07099`, not merged yet; stage B waits for the wire's merge 1): the eight skeleton files with entry structs and size asserts (48, 32, 160 B); `MusicCounters` in `counters.rs` (the ten STATUS fields, the two section lists, and core-only `parkedOverflow`, `groupTableFull`, `groupSizeRefused`, `musicRingRefused`); `Regions.{due,curves,groups}` empty until stage B. Granted: an ignored `music_rings` parameter on `StreamStore::over` in `stream.rs` (the plan gives Q1 that signature; `stream.rs` is otherwise C1's). Mixer 265,952 → 265,755 B (plain cargo build; the base build matches the committed size exactly). Q1's readings: the group entry's "held-since" is stored as frames held (`held_frames: u32`) so the entry fits 160 B; the due list's lengths live in a `DueArea` in core state after the zones' area; law values 4–7 read as linear; the quarter-sine table's point `i` is `sin(π/2·i/1023)` (both ends exact).

**For Z2a's brief (from Q1):** (1) `PendingRecord` (48 B) has no room for a shape word on a full SET_PARAMS (60 B with the word): Z2a must decide how a shaped SET_PARAMS is held, without growing the 48-B record past the design's `Due` region unless logged. (2) Class S records need a per-voice apply; today's `scheduler::apply` takes the whole core (Z2a and Z2c). (3) `due::rebase` must also shift records still in the scheduler's pending queue; Q1 put that in Z2a's contract.

**Wire merge 1 merged** (`m4/wire` `7e4dae14` → `093932e2`), then L-Z1a (first pass) directly (`864b7a98`). Z1: `schema/music.rs` with every §4.5 constant and `FadeLaw`; the `shape` word on FADE (28 B), SET_PARAMS (60 B), STOP (24 B); PLAY `fadeZero`; envelope 1.2; the 176-B STATUS header. **Generator change:** `Field::appended` (`model.rs`, `gen/{layout,rust,ts,codec}.rs`) so a shorter, older record reads the appended word as 0 (Rust gets `MIN_END`, the TS property is optional). Mechanical edits outside the lead's list, each needed to stay green: `audio-core/src/status.rs` (`HEADER_BYTES` 176, zero-fill 144..176), `shape: 0` in `scheduler.rs` and four `audio-core/tests` literals, the worst-case asserts (15,936 B until the sections land in merge 2), the wire vectors for envelope 1.2, and the 12 header fields in `statusReader.ts` and `mirror.ts`. **Coordinator rebuild** (`npm run build:audio`): the committed mixer and decoders matched the lead's byte for byte; the metered bench wasm and `metered.json` were regenerated (`c55dd208`). **Mixer 265,952 → 266,262 B** (+310). Checks on `c55dd208`: `cargo test --workspace` 709 pass; `check:audio-metered` pass (all +0.83%); vitest on the wire, wasm and `runtime/core` files: 83 of 86 files passed under a load average of ≈ 29 (many agents). `ambisonicLoopback` and `zoneIr` passed alone (31 of 31); `selectionBench` is a known timing flake, rerun at wave end on a quiet machine.

**Lesson (for later briefs and the wave end):** every worktree links the main checkout's `node_modules`, so concurrent vitest runs collide on `node_modules/.vitest-cache` more often than in M3; timing tests fail under the agents' load. Wave-end suites run only after the wave's agents stop.

**F3 merged** (`m4/f3`, leaf L-F3a first pass): `musicValidate.ts` with every §2.6 row as a `MusicLintCode` (stem length, rate, channels, `noGapless`, streamed FLAC/WAV on low, `neverFits` "needs N rings; this preset has M", decoded over 30 s, silent stem, tail longer than loop, unequal alternatives, cue past the audio) plus an `encodedOverBudget` row (48 / 96 / 160 MiB) and a `"stinger"` ring-need kind; 28 tests. Readings: only `stemLengthMismatch` (beyond 1,024 frames) is an error (the segment is refused); every other row warns, `neverFits` included (the planner refuses at play, R14/R15); a clip ≤ 30 s decodes, longer streams, `forceMode` overrides; alternatives must be exactly equal in length (no 1,024-frame slack); ring need: alone = streamed stems, a hand-over adds ≤ 2 per track with alternatives on a looping region, a tail on a looping region doubles the streamed stems, a seam A + B, a bridge max(A + bridge, bridge + B), a stinger adds its stems. **Follow-ups (on the tasks that do the work):** (1) F3 carries a local tempo walk: swap it for G1's `musicGrid.ts` (whoever first wires `validateMusic` into play, P1/P6; or F2). (2) The call sites (first play, warn once; the editor) and a flatten helper from F1b's containers to `segments`, `library`, `edges` (with F2's bridges) and `stingers`; until then absent `edges` means every ordered pair, which can only over-count. (3) Callers must supply `codec`, `bytes` and `silent` from the decoder, or the FLAC/WAV, budget and silent rows stay quiet.
