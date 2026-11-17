# 0223. The test loopback serves the stream port, and tests observe link traffic only through its watch

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0221, and 0215's description of `core/batchWatch.ts`)
- **Related:** 0215, 0221

## Context

ADR 0221 put the loopback tests on the production assembly (`loopbackAudio`) but left two open questions.

- **The stream rig.** In a page the backend hands the worklet its end of the decoder worker's channel with `CoreLink.connectStreamPort`, a `{type: "streamPort"}` control that `worklet/processor.ts` answers by binding the port to its driver (`connectStreams`). The loopback's `flush` dropped every control but `debugTone`, so `testing/streamRig.ts` built its own always-"running" `CoreBackendHost` and a bare `new CoreBackend`, overrode `streams.connectWorklet` with a copy of the processor's wiring, and stalled main by patching the link's private `port.onmessage`. `core/streamRegionLoopback.test.ts`, `core/streamRebuild.test.ts` and `golden/audioGoldenGate.test.ts` had their own copies of that wiring (or called `driver.onStreamMessage` directly). The rig's tests read the driver's `openStreams`, `workerClips` and `stats`, the worker's `handler.streamStats` (from `StreamDecoder.stats`), and other members kept only for tests: `StreamDecoder.openCount`, `MusicGroups.groupCount`, `CoreAutomation.paramTarget`, and the public `MusicOps.samplePrime`.
- **Link traffic.** `core/batchWatch.ts` `watchBatches` wrapped a link's `post` (ADR 0215 described it so). Four test files used it, and `events/eventBench.test.ts` patched `link.post` and wrapped five `backend.automation` methods to count calls. 0221 had already given the loopback a `watch()` read where the core receives the batches.

## Decision

We will make the loopback answer what the processor answers, and observe what the core receives only where it receives it.

- **The loopback serves `streamPort`.** `createLoopbackHost`'s `flush` handles `{type: "streamPort", port}` as `connectStreams` does: the port's messages go to the current shell's `driver.onStreamMessage` at the current frame, and the driver's credits go back on it. The port is bound to the shell it reached; `respawn` and `recreate` retire the old shell's port (as `retire` does in the worklet), and the backend connects a new one after the rebuild, as in a page. `LoopbackStreamPort` types the port.
- **The stream rig is `loopbackAudio`.** `testing/streamRig.ts` calls `loopbackAudio({ mixer: "own", settings, preset, clipRegistry: { fetchBytes, decodeWorker }, backend: { streams: { decoder, channel, fetchBytes } }, eachQuantum })` with no `connectWorklet`, so `CoreLink.connectStreamPort` runs as in production. Its main stall is the loopback's `stallMain`; a trap is `audio.trap()` and the host's `health`. `LoopbackAudioOptions.eachQuantum` gives another thread a turn after each rendered quantum (the rig's in-process worker pumps its channel there). `loopbackAudio`'s clip registry passes `aac` from `settings.codecs`, as `createCoreBackend`'s does.
- **The rig reads the channel, not the driver.** The rig owns the channel the backend asks for, so it reads what the worklet receives on it (`worklet()`: streams opened and not closed on the current port, chunks, their frames, distinct chunk buffers, zone kernels and their bytes). Checks of the core itself use STATUS (`clipEvents`, `underruns`, `liveVoices`), the handle and `backend.streams`.
- **The rebuild tests use the rig**; the golden gate hands its stream records over a port connected with `link.connectStreamPort`.
- **No test-only members.** Removed: `CoreDriver.openStreams` and `workerClips`, `StreamDecoder.stats` and `openCount`, `DecoderHandler.streamStats`, `MusicGroups.groupCount`, `CoreAutomation.paramTarget`. `MusicOps.samplePrime` is gone; its calculation, an asymmetric moving average, is `core/asymmetricEma.ts` (`asymmetricEmaStep`), which `musicOps.ts` imports and which has its own test.
- **One way to observe link traffic.** On the loopback, `watch()`. `core/batchWatch.ts` no longer wraps anything: it keeps the `BatchWatch` shape and adds `batchRecorder()`, a watch that a unit test's own fake core port feeds from its `postMessage` (`liveTuningSource`, `musicOps`). `eventBench` counts batches and automation records (AUTOMATE, PARAM, CURVES, BUS_AUTOMATE, SET_LOOP) on the loopback's watch; it no longer counts bytes (the writer posts its staging buffer whole, so they said nothing).

## Alternatives considered

- **Keep `connectWorklet` overridable in the rig.** The rig would keep a copy of the processor's wiring, the drift 0221 removed elsewhere.
- **Expose the driver's counters through the loopback.** They are the shell's internals; the worker's channel and STATUS show what a caller can see.
- **Move `liveTuningSource` and `musicOps` onto `loopbackAudio`.** They are unit tests on a fake core port with hand-written STATUS blocks; a recorder on their own port reads the same wire without patching.

## Consequences

**Positive**
- The stream path in tests is the production one: `connectStreamPort`, the control, the binding, and its re-binding after a rebuild.
- Nothing patches a link, a port or a sink to watch traffic.
- The three files with hand-wired hosts and stream bindings shrank by about 140 lines net.

**Negative / costs**
- "Open streams" and kernel counts are read on the channel (what the worker sent), not in the shell's table; the shell closing a dead worker's rings when a new port connects is checked by the next stream playing, not by a count.
- `eventBench` counts automation records, not sink calls (they agree today: one PARAM per `setParameter`, one AUTOMATE per voice bound).

## Deprecates

`watchBatches` (removed); the rig's `connectWorklet` override, `loop` field, `handler` getter and `step`'s port patch; the hand-wired stream bindings in `streamRegionLoopback.test.ts`, `streamRebuild.test.ts` and `audioGoldenGate.test.ts`; the members listed above. Removed.

## Open questions

- `CoreDriver.stats` (`CoreDriverStats`, "for tests and the dev page") has no production reader; `worklet/coreDriver.test.ts` reads it. It is the driver's own unit test, but whether it should read STATUS instead is left open.
- `LoopbackAudio.workletPort` delivers a buffer through the shell's main inbox (`driver.onMessage`); `zonesWalk`, `passByLoopback` and `audioDebugMonitor.loopback` hand their in-process worker that port. They could connect a channel with `connectStreamPort` now and drop `workletPort`.
- `core/musicStreamRelease.test.ts` reads the backend's private `clockMap` by cast.

## References

`src/plugins/audio/runtime/testing.ts` (`createLoopbackHost` `connectStreams`, `LoopbackStreamPort`, `eachQuantum`), `testing/streamRig.ts`, `runtime/core/batchWatch.ts`, `runtime/core/asymmetricEma.ts`, `runtime/worklet/processor.ts`, `runtime/events/eventBench.test.ts`.
