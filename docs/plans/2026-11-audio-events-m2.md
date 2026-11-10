# Audio events and parameters (M2): milestones (ADR 0158)

Builds [ADR 0158](../decisions/0158-audio-events-and-parameters.md) (Accepted 2026-11-10), 0157's roadmap M2. The record is the spec; where this plan and the record differ, the record wins and the difference is a bug in this plan. Log progress, numbers and deviations in `docs/design/0157-audio-core/build-log.md` under "M2".

**The split to keep in mind:** main does only event-driven work (picks at play, parameter sets, scheduling the next clip of a continuous container); the core does everything continuous per quantum (smoothing, curves, blends, sustain loops). Voices stay in main's voice table. The Babylon fallback runs a TypeScript port of the core's evaluator once per frame.

## Milestones

| # | Milestone | Content | Exit check |
|---|---|---|---|
| E1 | Foundations | `src/engine/core/curve.ts` (`Curve`, `evalCurve`, interp shapes); `src/engine/audio/eventFormat.ts` (`myco.audioevent@1`, lenient parse, problems); `audio.parameters`, `audio.automation`, `audio.seed` in `engine/audio/settings.ts`; mixer size gate 150 → 256 KB (`native/audio/build.mjs`) | Vitest for each; `npm run build` green |
| E2 | Core: automation and sustain (Rust) | Wire: CURVES, AUTOMATE, PARAM, BUS_AUTOMATE, SET_LOOP (schema in `audio-wire`, regenerated TS); `audio-core`: parameter table (global + per-`group`), curve table, voice and bus bindings evaluated once per quantum and ramped, loop regions and release; ABI 1.4; `group` in STATUS voices | `cargo test`; wire round trip; new goldens (blend, automation, sustain-then-release); metered scenes added and baseline rewritten deliberately |
| E3 | Event runtime (TypeScript) | `plugins/audio/runtime/events/`: asset loading and cache, instances, random/sequence/switch/blend/layer/sustain picks, continuous scheduling with `at`, limits and cooldown, release; `Audio.play`, `Audio.setParameter/getParameter`, `AudioEventHandle`; `AudioSource` with event assets; core backend sends the new commands; the Babylon fallback evaluator; Rust–TS parity test; `Audio.debug().events` and the debug panel grouping | Vitest on a fake backend (seeded); loopback/golden tests on the core; parity test |
| E4 | Loop points from files | Decoder reads WAV `smpl` and Ogg/Opus `LOOPSTART`/`LOOPLENGTH`; sidecar `loopStart`/`loopEnd` (0040) override; streams loop a region through the worker; Babylon `loopStart`/`loopEnd` | `cargo test` in `audio-decode`; a stream region-loop test |
| E5 | M2a exit | `samples/sound-lab` events page (footsteps by surface, RPM-blended engine with sustain and tail, music intensity bus automation); "Sound events" guide page; M2 bench (main per play and per `setParameter`, core automation p99.9); a `@slow` spec playing the events | Budgets per 0158 §6; `npm test`, `npm run build`, Chromium e2e and `@slow` audio specs green |
| E6 | Editor (M2b) | Asset kind `audioEvent` and its format; the Event editor (tree, properties, parameters); `CurveEditor.tsx`/`curveEdit.ts` moved to `src/editor/ui/` with an x range and per-segment interpolation (particles keep using it); audition; Project Settings > Audio: Parameters and bus Automation; New Event and "Create event from clips" | Playwright specs for authoring and audition |
| E7 | M2 done | The owner's listening pass of the sample events; 0157/0158 rows updated | Owner sign-off |

E1 can start at once. E2 and E3 can run in parallel once E1's types exist (E3 against a fake backend first, then wired to E2's commands). E4 is independent of E3. E6 can start on the curve widget and asset kind during E3.

## Shippable at every merge

`npm run typecheck`, `npm test`, `npm run build`, Chromium e2e, `cargo test` in `native/audio/` green; committed wasm matches its source hash; the metered gate passes (a deliberate baseline change says why); M1 behaviour unchanged for projects without events.
