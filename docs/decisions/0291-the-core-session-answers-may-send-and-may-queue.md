# 0291. The core session answers "may send" and "may queue"

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0178: the session owns the send rule as well as `recovering` and `disposed`)
- **Related:** 0157, 0158, 0166, 0171, 0176, 0178, 0221, 0234

## Context

Whether the core may be written to now was spelled out seven times in `core/coreBackend.ts`, in three variants, and handed to the parts as closures:

- live mix (`liveMix.ts`, and through it the structural dip) and the music group operations (`musicOps.ts`): `!disposed && !recovering && status === "running"`;
- automation (`coreAutomation.ts`): `!disposed && !recovering && status !== "failed"`, so it writes while the context is locked;
- a play, the locked queue's drain and the frame's commit: `running && !recovering`, `recovering || failed`, with the disposed check as an early return in each method.

`core/session.ts` (ADR 0178) owns `recovering` and `disposed`, two of the rule's three inputs, but not the rule, and nothing said whether automation writing while locked was meant.

It was meant, though never written down. Automation's rule is the frame commit's: the commit clears the writer only during a rebuild or after failure, so while locked the frame's BATCH still goes to the suspended context's port and the core applies it when the context resumes (a "locked" backend is a context interrupted after the core ran, ADR 0234; the service makes no backend before the first ready STATUS). Automation's state is not a voice: curves, parameter targets and bus bindings must be current when the voices the unlock starts read them, and a binding is only sent for a voice already on the core (`onCore` checks the voice's state). The other writers name voices or post outside the frame: a PLAY of a voice queued while locked, a music FADE or SET_PARAMS (or a group prime) for a member that waits unplayed in the locked queue, and the fader's preview post (`flushNow`), which would reach the core before the voices it addresses. The difference is real, so it gets a name instead of being folded into one rule.

## Decision

The core session answers the send rule. `CoreSession` takes the host's status (`new CoreSession(() => host.status)`) and implements `SendGate`:

- **`maySend`:** a core is listening now: not disposed, no rebuild running, and the context running. Starting a voice (`CoreVoices.start`, which now takes no `running` flag, and `unlock`, which drains the locked queue only when this holds), the fader's preview post and the structural dip's flushes (`LiveMix`, `StructuralDip`), and the music group operations (`CoreMusicOps.fadeShaped`, `paramsShaped`, the group prime) ask it.
- **`mayQueue`:** a core will keep what is written now: not disposed, no rebuild running, and the host not failed. True while locked. Automation (`CoreAutomation`: curves, parameters, bus bindings, the resync) and the frame's commit (flush, or clear when it doesn't hold) ask it.
- **Participants hold the session, not closures.** `LiveMixHost`, `StructuralDipHost`, `MusicOpsHost`, `CoreVoicesHost` and `CoreAutomationDeps` take `session: Pick<SendGate, …>` (the one question each asks) in place of `sending()`. Their unit tests pass `{ maySend: true }` or a getter.
- **Disposed.** Play, unlock and commit already honour it: `play`, `frameAttenuate` and `frameCommit` return early once disposed, and the session's rules are false once disposed, so a drain or flush can't run after dispose even through another path. Play's own refusal (`null` when disposed or failed; queued while locked or recovering) stays in `play`: it is whether the backend accepts a voice, not whether it may write.
- **Behaviour is unchanged.** Every writer asks the rule its expression spelled; no wire output moves.
- **Tests.** `coreBackend.test.ts` checks send behaviour once per lifecycle state (running, locked, recovering, failed, disposed) on the recording host (ADR 0234): whether a play starts, waits or is refused, whether a global parameter goes out with the frame, and whether the preview path posts. `session.contract.test.ts` checks the two answers per state on the session alone. `liveMix.test.ts`'s "posts nothing while the backend can't send" moved into the per-state table.

## Alternatives considered

- **One rule, `maySend`, for automation too.** Parameter changes made while the context is interrupted would wait for a resync instead of arriving with the resume; the queued voices would start against stale curves and parameters for a frame or more. Rejected: the difference is intended.
- **One rule, `mayQueue`, for everything.** A music fade or a preview post while locked would reach the core before the PLAY of the voice it names (or be stamped against a clock that isn't moving). Rejected.
- **A status enum on the session (`"running" | "locked" | …`) and let each part decide.** Seven expressions again, now over an enum; the rule would still live in the parts.

## Consequences

**Positive**
- The lifecycle rule sits with the lifecycle: one place says when the core may be written, and why there are two answers.
- The per-state table on the recording host covers every writer's rule in one test instead of one test per part.

**Negative / costs**
- `CoreSession` reads the host's status through a function given at construction (the backend's field initialisers run before its parameter properties are usable).

## Deprecates

The `sending()` closures in `LiveMixHost`, `StructuralDipHost`, `MusicOpsHost` and `CoreAutomationDeps`, `CoreVoices.start`'s `running` argument, and the backend's seven inline expressions. Removed.

## Open questions

- Whether music group operations should queue while locked (mirror and send after the member's PLAY) instead of being dropped. Today a fade asked for while the context is interrupted is lost; the music runtime (`runtime/music/`) would have to agree first.

## References

`src/plugins/audio/runtime/core/session.ts` (`SendGate`, `CoreSession.maySend`, `.mayQueue`), `coreBackend.ts`, `liveMix.ts`, `structuralDip.ts`, `musicOps.ts`, `coreAutomation.ts`, `voices.ts`; tests `coreBackend.test.ts`, `session.contract.test.ts`. Commit 165ae822 (E3.1) introduced automation's rule beside the commit's.
