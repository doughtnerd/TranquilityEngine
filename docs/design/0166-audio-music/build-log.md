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

Started 2026-11-11 at about 22:10 UTC, all six leads in one message, each in its own worktree:

| Task | Lead model | Branch | Flow |
|---|---|---|---|
| Z1 → W1 (wire) | mid | `m4/wire` | merge 1 (Z1 and every §4.5 constant) → leaf L-Z1a; merge 2 (W1, ABI 3.0, TS init) → leaves L-W1a, L-W1b |
| Q1 (core skeleton) | strongest | `m4/q1` | stage A (modules, counters, `core.rs`) now; stage B (regions, 176-B header) on merge 1 |
| Q2 (main-side skeleton) | strongest | `m4/q2` | merges after the wire's merge 2 (the `testing.ts` overlap) |
| F1a (format head) | mid | `m4/f1a` | skeleton → leaves L-F1aa, L-F1ab |
| Ed1 (peaks) | mid | `m4/ed1` | skeleton → leaf L-Ed1a |
| S0 (smoke spec) | mid | `m4/s0` | unsplit; `E2E_PORT=4311` |

Merge order inside W1 (plan): wire merge 1, Q1, wire merge 2, Q2; F1a, Ed1 and S0 when ready.
