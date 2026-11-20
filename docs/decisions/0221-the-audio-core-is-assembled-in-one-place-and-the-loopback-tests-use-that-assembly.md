# 0221. The audio core is assembled in one place, and the loopback tests use that assembly

- **Status:** Accepted, amended by 0223 (the loopback serves `streamPort`; link patches removed), 0234 (the recording host is the wire tier; the loopback serves the World service) and 0270 (the rigs run the production frame: `tick`, `audioFrameDriver`)
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0023, 0178, 0179, 0215, 0218

## Context

Production assembled the audio core in `runtime/core/service.ts`: `startAudioHost`, `connectHostToEngines`, `watchForTraps`, then `createCoreBackend` once the link was ready. Tests rebuilt that assembly: 72 files called `new CoreBackend(` or `createCoreBackend(`, 56 built a fake `CoreBackendHost` (always "running", no lifecycle), 23 built their own `AudioHost`, and 18 armed `watchForTraps` by hand. Every assembly change (ADR 0178's phases, 0179's capabilities) had to follow into each rig, a rig that assembled slightly differently from production was where bugs hid, and rigs patched production objects to observe or delay traffic (`link.post`, `link.handleMessage`, the private `link.port`).

## Decision

- **One assembly.** `runtime/core/assembly.ts` `assembleCore(host, deps?)` connects the host to its mixer (following `onAudioConfigured` for the page mixer), arms trap recovery once per host, and returns `{ host, ready, createBackend() }`. `service.ts` uses it with the AudioWorklet host and registers `createBackend` on `ready`. Production passes no deps, so behaviour is unchanged.
- **The loopback adapter.** `runtime/testing.ts` `loopbackAudio(opts)` is a real `AudioHost` over the loopback node, assembled by `assembleCore`, and makes the backend after the first ready STATUS, as the service does. It returns the public surface (`Audio`, the backend, mixer, host, link) with `render`/`step`/`settle`, the faults a real host sees (`trap`, `changeRate`, `rebuild`, `stallMain`, `delayBatches`), and `watch()` to read what the core receives at the shell, never by wrapping the link. `closeLoopbackAudio()` ends it in `afterEach`.
- **One lower tier.** `createLoopbackHost` stays for tests that read the wire itself (ADR 0215: tests read what the backend sends). Rigs that need their own host parts (counted contexts, dead respawns) keep them but call `assembleCore`.
- **No test-only members** in production modules; `LoopbackHost` (test support) dropped `core` and gained `watch`, `stallMain` and `delayBatches`, which replace the link patches.

## Alternatives considered

- **A shared rig in test support only, beside the service's own assembly.** Removes the copies in tests but keeps two assemblies, the drift this record removes.
- **Keep per-file rigs and document the assembly.** Every assembly change still edits dozens of files.

## Consequences

**Positive**
- An assembly change is made once. Rigs no longer start "running" with no lifecycle, so they exercise locking, World shares, reconfigure and recovery as production does.
- `new CoreBackend(`/`createCoreBackend(` call sites went from 72 files to 22 (the two `createCoreBackend` calls left are production); 58 files use `loopbackAudio` or `assembleCore`. The audio suite went from 4,335 to 4,338 passing tests.

**Negative / costs**
- Rigs start 6 quanta in (the first ready STATUS); tests that index output by core frame pad or offset.
- Loopback rigs carry the background controller's real-time health timer (inert there: its rebuilds target the page host).

## Deprecates

`connectHostToEngines` (moved into `assembleCore`), the per-file assemblies in the moved rigs, `LoopbackHost.core`, and the `link.post`/`link.handleMessage` patches they used.

## Open questions

- The stream rig (`testing/streamRig.ts`, `core/streamLoopback.test.ts`, `core/zoneIrPort.test.ts`) still reads the worklet driver; it moves once the loopback answers CoreLink's `streamPort` control as `worklet/processor.ts` does.
- `runtime/worldView.test.ts`, the capture soak and bench files, and the backend unit tests on a recording link (`audioApi`, `mixDebug`, `structuralDip`, …) are not on `loopbackAudio`.

## References

`src/plugins/audio/runtime/core/assembly.ts`, `core/service.ts`, `runtime/testing.ts` (`loopbackAudio`, `LoopbackWatch`), `runtime/testing.test.ts`, `mix/clickHarness.ts`, `mix/faderGateHarness.ts`, `music/testing/loopbackClock.ts`.
