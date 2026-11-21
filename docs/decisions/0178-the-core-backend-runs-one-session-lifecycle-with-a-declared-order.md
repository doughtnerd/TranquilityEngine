# 0178. The core backend runs one session lifecycle with a declared order

- **Status:** Accepted, amended by 0291 (the session also answers the send rule, `maySend` and `mayQueue`)
- **Date:** 2026-11-15
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0157, 0171, 0176

## Context

The audio core's backend (`core/coreBackend.ts`) has a set of rare lifecycle moments: a bus reconfigure, a hard rebuild (the old core is gone, maybe a new context, the new core answers and gets a replay), a recovery that gives up, the stream hand-off after a rebuild, and dispose. Each was a backend method that called five to ten sub-modules by hand (`configureBuses`, `beginRecovery`, `contextReplaced`, `endRecovery`, `recoveryFailed`, `dispose`, `reopenStreams`). The replay header in `core/replay.ts` called about fourteen hooks across modules (bus config, beds, the lane writer, which itself called presence and the loudness record, MASTER, listener, zones, the automation mirror), and each replayed PLAY was followed by more (automation, voice fx, the voice table's fade, stamped ramps and pause). ADR 0157's §7 replay order, as ADR 0162 (S10) and ADR 0171 (§4.2) extended it, was enforced only by comments.

The recent fixes in this area were all missed wiring, in sub-modules that already had unit tests:

- 6548b14: deferred live adds were not cleared at a reconfigure or on dispose.
- 9280f46: the loudness hub's `setMuted` / `setMasterNotUnity` were never called.
- 7f73d28 (FU2): streams were not reopened properly after a hard rebuild.
- 6b0c582 (G7c): the bus prune and the tombstones disagreed.
- a7b04c5 (FU3-6): Play stop didn't reach the capture on the Babylon fallback.

A sub-module's unit test can't see that the coordinator forgot to call it. ADR 0176 already shaped `CoreVoices`'s lifecycle methods so it could be registered as one participant.

## Decision

We will run the core backend's lifecycle through one module, `core/session.ts` (`CoreSession`):

- **Phases.** `reconfigure(mixer)`, `busesReset` (inside a reconfigure, as the slot table resets), `beginRecovery`, `contextReplaced(rate)`, `endRecovery`, `replayHeader(b)`, `replayVoice(b, voice)`, `reopenStreams(ids)`, `recoveryFailed`, `dispose`. A participant implements only the phases it cares about (`SessionParticipant`, every member optional).
- **The order is data.** `PHASE_ORDER` lists, per phase, the participant names in the order they run, whatever order they joined in. The header list is §7 as extended: `reset` (RESET 0), `buses` (BUS_CONFIG), `beds` (BED_CONFIG), `presence` (BUS_DUCK, BUS_PRESENCE), `loudness` (LOUD_CONFIG), `lanes` (BUS_RAMP), `master` (MASTER), `listener` (LISTENER), `zones` (ZONE_CONFIG), `automation`. After each replayed PLAY: `automation` (AUTOMATE, SET_LOOP), `voiceFx` (SET_VOICE_FX, mixed voices), `voiceState` (FADE, stamped ramps, SET_PAUSED). The other phases' orders keep what the hand-written methods did; the comment on each list says what depends on it (the replayer carries playheads with the old clock before it rebases; the worklet channel is dropped before the zones ask for kernels; the replayer's restore runs last).
- **Joining is checked.** `join(name, participant)` throws when the participant implements a phase whose order doesn't list its name, so no phase method runs in an undeclared place. `requireComplete()` refuses the other direction (a listed name that never joined, or joined without that phase); the core backend calls it once every part has joined.
- **State.** The session owns `recovering` and `disposed`; the recovery phases do nothing once disposed and `dispose` runs once. The flags change before the phase's participants run.
- **Who joins.** The backend joins its parts in one method (`joinSession`). The replayer joins itself (`replayer` for `begin`, `newContext`, `restore` and a new `drop`; `reset`; `voiceState`). The loudness wiring moves out of the backend into `core/coreLoudness.ts` (`CoreLoudness`), which implements its phases itself, as does `WorkletChannel` (the "context replaced in this recovery" flag moves with it). The lane writer no longer replays the ducking and loudness records itself.
- **Wire output is unchanged.** Every replay writes the same records in the same order; the loopback rebuild, replay and golden tests pass unchanged. Running a phase allocates nothing; the per-voice phase reuses one `ReplayVoice` object, and no frame path changed.
- **Two gaps closed by the contract.** The replayer now drops what waits for a replay when recovery fails or the backend is disposed. A failed recovery now also clears deferred live adds.
- **The Babylon fallback.** It has no rebuild, context or replay. Its lifecycle is `configureBuses` and `dispose`, with its own state (Babylon nodes). FU3-6's miss was in the audio World service, which signals Play stop and now runs on either backend. No backend lifecycle phase was involved, so a shared session piece wouldn't have prevented it. The fallback isn't a participant.

**What this changes in 0157.** Its §7 replay order (and architecture §3.6, §7; the M3 and M5 extensions) now lives in code as `PHASE_ORDER.replayHeader` and `.replayVoice`. The order itself is unchanged.

## Alternatives considered

- **Keep the hand-written methods and add a test per wiring.** Each new part would still need its call added in several methods and a test that knows about it. The misses above were exactly the calls nobody listed.
- **An event emitter (subscribe to "rebuildStart").** It gives no order. The replay header needs an exact order, and the other phases have order dependencies.
- **Numeric order keys on each participant.** These spread the order over many files. One list per phase can be read, and changed, in one place.
- **Join every module directly by duck typing (a method named `dispose` joins `dispose`).** Most modules' methods don't match the phase signatures (`replay(b)`, `reopenStreams(ids, at)`). A method that happened to share a name would join silently. Adapters in `joinSession` are explicit, and the two modules that implement phases themselves were written for it.

## Consequences

**Positive**
- A new part with lifecycle work declares its place in `PHASE_ORDER` and joins once. `join` refuses an undeclared phase, and the contract test fails on a declared one that isn't implemented.
- `session.contract.test.ts` holds the system-level checks no sub-module test could: nothing queued (deferred adds, locked plays, the replay's waiting voices, stale stems, staged records) survives dispose or a failed recovery, no queued add survives a reconfigure, a real rebuild's header comes out in §7 order, and every participant with per-context state follows a new context.
- `coreBackend.ts` goes from 1,560 to 1,456 lines. Its lifecycle is the join table plus one-line phase calls.

**Negative / costs**
- The order of a phase is now one hop from the code that runs in it (`session.ts`).
- Adapters in `joinSession` are a second place to look for what a participant does in a phase.
- The second `dispose` of a backend no longer clears deferred adds again (nothing can add after the first: the mixer's op target is released).

## Deprecates

`ReplaySource.lanes`, `.masterVolume`, `.muted`, `.hiddenMuted`, `.host`, `.busConfigWire`, `.reopenStreams`, `.spatial`; `ReplaySpatial`; `ReplayAutomation.replayHeader` / `.replayVoice`; `LaneWriterHost.replayDucking`; `CoreBackend.spatial` and its private `beginRecovery`, `contextReplaced`, `endRecovery`, `recoveryFailed` and Ld2 methods (`syncLoudness`, `sendLoudness`, `replayLoudness`, …). All removed. `CoreBackend.configureBuses`, `dispose` and `reopenStreams` remain as one-line phase calls.

## Open questions

- The next record narrows the backend interface (`runtime/backend.ts`) into capability objects. Whether `configureBuses` / `dispose` there become a session handle is left to it.

## References

- `src/plugins/audio/runtime/core/session.ts`, `session.contract.test.ts`, `coreLoudness.ts`, `workletChannel.ts`, `replay.ts`, `coreBackend.ts` (`joinSession`)
- ADR 0157 §7 (architecture §3.6, §7), ADR 0162 S10, ADR 0171 §4.2 (`docs/design/0171-audio-mix/api-and-models.md`), ADR 0176
