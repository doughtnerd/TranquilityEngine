# RFC round for ADR 0166 (interactive music, audio M4): shared brief

You are one reviewer in a persona panel. Each reviewer has a different job; review through your own lens only.

## Read (required; say in your reply which you read)
1. The record: `docs/decisions/0166-interactive-music-segments-transition-rules-and-a-heard-beat-clock.md` (fully).
2. The owner-confirmed goal: `docs/design/0166-audio-music/goal.md`.
3. The evidence: `spikes/audio-music/README.md` (all), and the sub-spike READMEs your lens needs (`research/`, `streams-align/`, `stream-throughput/`, `beat-clock/`, `cost/`, `rhythm/`).
4. Related records by number in `docs/decisions/`: 0157 (audio core; roadmap; "Decision" and "Roadmap"), 0158 (events and parameters), 0162 (spatial audio, M3: its shape and its "RFC round" section).
5. The code the record changes, by path (cite `file:line` for every code claim): `src/engine/audio/eventFormat.ts`, `src/plugins/audio/runtime/events/eventRuntime.ts`, `src/plugins/audio/runtime/core/{lookahead,clock,streams}.ts`, `src/plugins/audio/runtime/audioSystem.ts`, `src/plugins/audio/runtime/Audio.ts`, `native/audio/crates/audio-core/src/{voices,stream,scheduler}.rs`.

## Rules
- Write only `docs/rfc/0166/<persona>.md`. Don't commit. Use only file, shell and search tools; no builds or benchmarks.
- The engine is unpublished (only samples use it): don't propose compatibility work or feature flags. The owner wants industry practice followed (Wwise, FMOD, Unity, Unreal) and differences justified.
- Accepted records (0157, 0158, 0162) outrank reviewers; if you disagree with one, say so explicitly as a separate point.

## Format
- First line: verdict (approve / approve with changes / rework) and your top 3 concerns.
- `## Issues`: numbered; each with severity (**blocking**, **major**, **minor**), evidence (file:line or spike README section) and the concrete change to the record.
- Your persona's own sections (named in your brief).
- `## Cheaper alternatives`
- `## Questions for the author`
- Word cap as your brief says. Reply with a 5-line summary.
