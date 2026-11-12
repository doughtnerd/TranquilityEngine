# RFC round for ADR 0171 (audio M5: profiler, loudness, live mix): shared brief

You are one reviewer in a persona panel. Each reviewer has a different job; review through your own lens only.

## Read (required; say in your reply which you read)
1. The record: `docs/decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md` (fully).
2. The owner-confirmed goal: `docs/design/0171-audio-mix/goal.md`.
3. The evidence: `spikes/audio-mix/README.md` (all), and the sub-spike READMEs your lens needs (`research/`, `loudness/`, `cpu-clock/`, `capture/`, `mix-core/`).
4. Related records by number in `docs/decisions/`: 0157 (audio core; "Decision" and "Roadmap"), 0097 (mixer buses), 0158 (events, parameters, automation), 0162 (spatial, M3: shedding ladder), 0166 and 0167 (M4: the in-voice stamped records, M4-0), 0170 (the ladder recovers), 0147 (plugins reach the editor only through the editor SDK).
5. The code the record changes, by path (cite `file:line` for every code claim): `src/engine/audio/{mixer,settings}.ts`, `src/engine/core/Engine.ts` (~184-187), `src/plugins/audio/runtime/{Audio,backend,audioSystem}.ts`, `src/plugins/audio/runtime/core/{coreBackend,lookahead,clock}.ts`, `src/plugins/audio/runtime/worklet/coreDriver.ts`, `src/plugins/audio/editor/{AudioDebugPanel,BusMeters,AudioSettingsSection}.tsx`, `native/audio/crates/audio-core/src/{bus,meters,counters,cap,status}.rs`.

## Rules
- Write only `docs/rfc/0171/<persona>.md`. Don't commit. Use only file, shell and search tools; no builds or benchmarks.
- The engine is unpublished (only samples use it): don't propose compatibility work or feature flags. The owner wants industry practice followed (Wwise, FMOD, Unity, Unreal) and differences justified.
- Settled by the owner (don't reopen, but you may point out costs): all four scope pieces are in M5; live edits are kept after Stop; the live editor↔game link is roadmap, not M5; loudness on master plus picked buses with targets that warn, never auto-adjust; M5 has its own budget; size gates are tripwires, not design limits.
- Accepted records outrank reviewers; if you disagree with one, say so explicitly as a separate point.

## Format
- First line: verdict (approve / approve with changes / rework) and your top 3 concerns.
- `## Issues`: numbered; each with severity (**blocking**, **major**, **minor**), evidence (file:line or spike README section) and the concrete change to the record.
- Your persona's own sections (named in your brief).
- `## Cheaper alternatives`
- `## Questions for the author`
- Word cap as your brief says. Reply with a 5-line summary.
