# 0215. The core backend keeps its tables private, and tests read what it sends

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0171, 0176, 0179)
- **Related:** 0157, 0162, 0166, 0171, 0175, 0176, 0177, 0178, 0179, 0188

## Context

The project rule is that tests go through the interface callers use, with no members kept public only for tests.
The audio core backend (`core/coreBackend.ts`, `CoreBackend`) had drifted from it. Its voice table (`table`), STATUS
mirror (`mirror`), command writer (`writer`), lane writer (`lanes`), structural dip (`dip`), deferred adds
(`deferredAdds`) and live-edit path (`liveMix`) were public because `debug.ts`, the capture's keyframe source, the
hard rebuild's replayer and presence ducking took the backend itself as their source, and about 250 reads in some 40
unit test files reached through the backend into them: STATUS header fields off the mirror, voice table columns,
spies on the writer's methods, `dip.last` and `dip.emitted` (fields nothing in production read), `liveMix.posts`,
`deferredAdds.pending`, a direct `lanes.replayLanes` call. One harness patched `LiveMix`'s protected host to inject a
clock, another test assigned `liveMix.refused`, and one model test overwrote `table.autoGain` to try a selection rule
that no test still asserted.

## Decision

We will keep the backend's parts private and have tests observe what the backend shows and sends.

- **One private view.** `CoreBackend` builds one object, `view` (getters over its fields, no allocation per read),
  typed as what its parts read: `DebugSource` (`debug.ts`), `KeyframeHost` (`keyframeSource.ts`), `ReplaySource`
  (`replay.ts`) and `PresenceHost` (`presence.ts`). `debug()`, `mixDebug()`, `keyframe()`, the replayer and presence
  take it. `table`, `mirror`, `writer`, `lanes`, `dip`, `deferredAdds`, `liveMix`, `owners` and `hrtf` are private;
  `mixOpTarget` is typed `MixOpTarget` (the seam `Mixer.apply` uses), not `LiveMix`. The unused `CoreBackendDeps.table`
  injection is removed.
- **Tests read what callers read.** State goes through `debug()` (`Audio.debug()`'s source: voice rows, counters, the
  `mix` section), the handle (`playing`, `alive`, `reason`, `panner`), `spatialVoices` (what the frame's passes read)
  and `voiceFx`; STATUS fields through the link the backend was built with (`CoreLink.lastStatus`, `statusCount`); and
  what the backend sends by decoding the batches posted on that link.
- **A batch walker in the wire codec.** `core/batchRecords.ts` (`batchRecords(message)`) lists a BATCH or REPLAY
  message's records with each one's opcode, voice, absolute frame (-1 asap) and offset, for the generated reader of
  its opcode. It is the one hand-written statement of the batch layout beside `wire.generated.ts`; the click and fader
  harnesses and the tests use it. `core/batchWatch.ts` is test support: it wraps a link's `post` and keeps decoded
  copies. The abrupt controls (a change sent with no dip) post their own batch on the link through a second
  `CommandWriter` (`clickHarness.ts` `sendRaw`), as a second sender would.
- **Checks of a part's own behaviour move to that part's unit test.** `StructuralDip` alone, over a real `BusIndex`
  and `CommandWriter` with the test's frames (`structuralDip.test.ts`): in flight until its planned end, R9 recycling,
  R12's `replayEndState`. `CoreMusicOps` alone over its own voice table (`musicOps.test.ts`): the stamped-ramp log and a
  stem's level. A backend-level replay is a real rebuild driven through the host's lifecycle listener.
- **No test-only members.** `StructuralDip.emitted`, `StructuralDip.last` (with `DipSequence`) and `LiveMix.posts` are
  removed. `LiveMixHost.nowMs` and `setTimer` are required, and the backend passes them (`performance.now`,
  `setTimeout`); the fader gate's harness drives the page's clock and timer with Vitest spies for its virtual main
  thread instead of patching the live path.

## Alternatives considered

- **Pass `this` with the fields made readonly-public "for parts".** Keeps the problem: the fields stay reachable from
  any caller and from tests.
- **A debug-only accessor (`backend._internals()`).** A renamed test hook; the rule forbids it.
- **A generic STATUS decoder for tests.** Not needed: the link already holds the decoded newest block, as production
  reads it.

## Consequences

**Positive**
- The backend's surface is what production calls; its tables can change without breaking tests.
- Tests assert the wire the core receives, so a writer refactor that sends the same records passes, and one that
  changes them fails for the right reason.

**Negative / costs**
- A few checks are coarser where `Audio.debug()` reports less than the table holds: a stem's audibility is clamped to 1
  (its fall is checked, not its size), the writer's own sample rate after a context swap is no longer asserted (the
  clock map's is), a stream PLAY's clip id is no longer matched to the table's slot (its stream-id range is).
- Records are observed once flushed, so some tests step a frame (or decode a REPLAY) where a spy saw the call at once.

## Deprecates

`CoreBackendDeps.table`; the public `table`, `mirror`, `writer`, `lanes`, `dip`, `deferredAdds`, `liveMix`, `owners`
and `hrtf` members of `CoreBackend`; `StructuralDip.emitted`, `StructuralDip.last`, `DipSequence`; `LiveMix.posts`;
the throttle-gap test's unused selection models. Removed.

## Open questions

None.

## References

- `src/plugins/audio/runtime/core/coreBackend.ts` (`view`, `createView`), `core/batchRecords.ts`, `core/batchWatch.ts`
- `src/plugins/audio/runtime/core/structuralDip.test.ts`, `core/musicOps.test.ts`, `core/batchRecords.test.ts`
