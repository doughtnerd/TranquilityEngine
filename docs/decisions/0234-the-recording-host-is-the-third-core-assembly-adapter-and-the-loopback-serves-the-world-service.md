# 0234. The recording host is the third core-assembly adapter, and the loopback serves the World service

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0221: the wire tier no longer stays on `createLoopbackHost`)
- **Related:** 0157, 0178, 0215, 0221, 0223

## Context

ADR 0221 put the loopback tests on the production assembly (`assembleCore`) and left two groups off it, named in its open questions:

- **The World-service and long-run rigs.** `runtime/worldView.test.ts`, `capture/soakSupport.ts`, `capture/realCore.bench.ts` and `capture/realScenes.soak.ts` each cast `createLoopbackHost()` to `& { link: CoreLink }` (stale: `LoopbackHost` has `link`), built a clip registry, a fake `CoreBackendHost` that was always "running", and a bare `new CoreBackend`. `loopbackAudio` offered one anonymous World share (`world?: boolean`), so `worldView` also spied on `AUDIO_SERVICE.load` and `runsIn` and faked a host with `attachWorld` and `forEachWorld`: the real World service never ran over the loopback. The bench and the real-scene soak read `LoopbackHost.statuses`, an array of the backend's one reused STATUS block, so their live and mixed voice averages averaged the last block.
- **The wire tier.** Twelve unit test files (`audioApi`, `audioApiM3`, `mixDebug`, `liveTuningSource`, `core/coreBackend`, `core/liveMix`, `core/structuralDip`, `core/loudnessWiring`, `core/session.contract`, `core/musicRecovery`, `core/liveTuningBeds`, `core/musicOps`) built a `CoreBackend` over a hand-rolled recording link, each restating the host, clock and clip stubs (often `as never`), and drove lifecycle events by calling the backend's listeners directly (`onBusRemap`, `onIdle`, `onRebuildStart`, `onRebuilt`, `onContextReplaced`, `onRecoveryFailed`) or by setting a `status` field. The glossary says to avoid exactly this.

## Decision

We will give `assembleCore` a third adapter for the wire tier, and let the loopback stand in as the World service's core.

- **The recording host.** `runtime/testing.ts` `recordingAudio(options)` builds a real `AudioHost` (`AudioHost._create`) over a node that runs no core, assembles it with `assembleCore` and makes the backend once the core answered, as the service does. Synchronous. Its port records every BATCH and REPLAY main posts (`posted`, and `watch()`, both `BatchWatch`es read as `loopbackAudio().watch()` is) and hands each BATCH buffer back to the link's pool as the shell does. The test plays the core: `status(fields)` delivers a STATUS block through the port, and the cores a rebuild makes answer as `newCore` says ("answers", "fails", "silent") once main listens. Lifecycle goes through the host as in a page: `rebuild(reason)` and `changeRate(rate)` run recovery's `rebuildHost`; `lock()` stops the context so that only `gesture()` (a pointerdown the host's unlock layer sees) resumes it; `host.context.close()` fails it; `host.attachWorld`/`releaseWorld` and `host.reconfigure` give World shares, idle and remaps. Options mirror `loopbackAudio`'s (`settings`, `mixer`, `register`, `preset`, `clock`, `backend`, `recovery`, `world`) plus `clips` and the context's `latency`. `closeRecordingAudio()` ends them in `afterEach`.
- **The fake clip registry.** `makeFakeClipRegistry({ state?, info? })` replaces the per-file `FakeRegistry` classes: ids by path, `states`, `refs`, `events`, `resident`, and `settle(id, state)` to finish a load.
- **The wire tier moves.** The twelve files use `recordingAudio`; no test builds a `CoreBackend` or `CoreBackendHost`. Unit tests of a part over its own command writer (`structuralDip`'s `dipRig`, `musicOps`'s `opsRig`) keep their recording link: they test that part, not the backend.
- **The loopback serves the World service.** `LoopbackAudio.startWorld(world)` starts the real `myco.audio` service in a World and resolves its share's key. The first call makes the rig's host the page's (`acquireAudioHost`) and registers the service again (the plugin set with audio off, then on), since a registration loads once. Any number of Worlds may start. `worldView` runs on it with nothing mocked; the soak (`s3Rig`), the bench and the real-scene soak use `loopbackAudio`, and read STATUS in a `link.onStatus` listener.
- **One production change.** `AUDIO_SERVICE.load` hands over the page's host when one is already running (its link ready) instead of probing and assembling again. Production reaches this only when the service is registered again on a page whose host runs; the first load's registration still serves it, so behaviour is unchanged. Nothing else in production moved, and no test-only member was added.
- `createLoopbackHost` takes `keepStatuses` (default true); `loopbackAudio` passes false, so a long soak holds no blocks.

## Alternatives considered

- **Keep `createLoopbackHost` for the wire tier (0221's line).** It runs the wasm, so the tests would be slower and could not hand-write a STATUS block or hold a rebuild's new core between `onRebuildStart` and `onRebuilt`.
- **A shared fake `CoreBackendHost` in test support.** Removes the copies but keeps a host with no lifecycle, the drift 0221 removed for the loopback.
- **A probe or load stub for `worldView`.** It would mock the service's own `load`; the page singleton is the seam production already has.

## Consequences

**Positive**
- Every core backend in a test is made by `assembleCore`, over a real `AudioHost`, so remaps, idle, World releases, locking, rebuilds and context changes reach it as in a page. The rigs lost about 830 lines; `testing.ts` gained about 400 (net about 430 fewer).
- `worldView` exercises the real World service, its shares and keys, over the loopback for two Worlds.
- The bench's and the real-scene soak's voice averages are read per block (they were averaging one reused block).

**Negative / costs**
- Recording rigs carry the background controller (its stall check targets the page host, which they never are). A "locked" backend is modelled as an interruption after the core ran (the service makes no backend before the first ready STATUS), not as autoplay from the start.
- `startWorld` makes the rig's host the page's for its life: the background controller's stall rebuild then targets it, so a test that idles for over a second between renders can see a rebuild.
- Two assertions read internals and were rewritten as behaviour: the old "dispose leaves no lifecycle listener" is now "after dispose, the last World leaving sends nothing"; the BATCH seq check reads the envelope from the watch's copy.

## Deprecates

The per-file `FakeRegistry`/`fakeClips`/`fakeClock`/`CoreBackendHost` rigs in the twelve wire-tier files, the hand-built backends in `worldView`, `soakSupport`, `realCore.bench` and `realScenes.soak`, their `& { link: CoreLink }` casts, `worldView`'s spies on `AUDIO_SERVICE.load` and `runsIn`, and `S3Rig.loop` (now `audio`). Removed.

## Open questions

- `CoreBackendHost` and the public `CoreBackend` constructor now have one caller, `createCoreBackend`; whether to fold them in is left open.
- `realScenes.soak.ts` still wraps `backend.setProfileSink` to time the sink.

## References

`src/plugins/audio/runtime/testing.ts` (`recordingAudio`, `makeFakeClipRegistry`, `LoopbackAudio.startWorld`), `runtime/core/service.ts`, `runtime/core/assembly.ts`, `runtime/worldView.test.ts`, `runtime/capture/soakSupport.ts`, `realCore.bench.ts`, `realScenes.soak.ts`, and the twelve test files above.
