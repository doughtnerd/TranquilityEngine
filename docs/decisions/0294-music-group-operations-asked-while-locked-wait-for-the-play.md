# 0294. Music group operations asked while the context is locked wait and go out after the PLAY

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** — (answers 0291's open question)
- **Related:** 0157 D5 (the locked queue), 0166 Z4 (stamped ramps in REPLAY), 0234 (the recording host), 0248 (the one-way music seam), 0264 (stamped ramps), 0291 (the send rule)

## Context

ADR 0291 made `CoreMusicOps.fadeShaped`, `paramsShaped` and the group prime (`post`) ask the core session's `maySend`
and left open whether they should queue while locked. They returned before doing anything: the FADE or SET_PARAMS was
not sent, the stamped ramp was not logged, and the `fadeGain` mirror (and the stem level) did not move. Locked voices
are live `LOCKED` slots in the locked queue (`core/voices.ts` `start`); on unlock `refreshGain` read the stale mirror
and the PLAY went out as if nothing had been asked.

Every music stop is a stop-at-end fade (`transition.ts`, `segmentRun.ts`, `loopTail.ts`, `stingers.ts`, `reload.ts`),
and a group's first fade-in comes with its stamp. A test on the recording host (ADR 0234) through the backend interface
confirmed it: a member stamped while locked got its PLAY at the resume but neither its fade-in nor the stop asked
meanwhile, so a `fadeZero` member stayed silent and a stopped one played on; a member already on the core when the
context was interrupted never got its stop; a group primed while locked was never posted to the decoder.

## Decision

We will hold what music asks for while the session may not send, update the mirror and the log at once, and send the
held records once it may:

- **Mirror and log either way.** `fadeShaped` and `paramsShaped` compute the ramp, log it (`logStamped`, which a
  rebuild's REPLAY restores, Z4) and update `fadeGain` / the stem level when asked, whether or not the record can go out.
- **Held records.** When `maySend` is false the FADE or SET_PARAMS is held, in the order asked, per voice
  (`CoreMusicOps` `heldWrites`), for a voice waiting in the locked queue (its PLAY must come first), or for any voice while
  the context is only locked (`mayQueue` true). During a rebuild (`mayQueue` false) nothing is held for a voice on the
  core: its REPLAY restores the logged ramp. A rebuild drops what was held for voices on the core and the held primes
  (`rebuilding(true)`: REPLAY and `reopenGroups` cover them).
- **Held primes.** A group prime asked while the context is only locked is held and posted then (if the group still
  exists); during a rebuild it is dropped as before (`reopenGroups` primes again).
- **Sent after the PLAY.** `CoreMusicOps.sendHeld()` runs each frame right after the locked queue's drain
  (`coreBackend.ts`, after `voices.unlock()`), so a member's held records follow its PLAY in the same batch. A voice
  freed meanwhile sends nothing; one still in the locked queue keeps its records. The batch orders records by frame, so
  an asap stop sorts before a fade stamped later, as it would have unheld.
- **Every stamped ramp.** `fadeShaped` and `paramsShaped` serve every core voice (ADR 0264), so event voices' stamped
  ramps are held the same way.
- **Seam.** Everything stays inside `core/`; nothing calls into `runtime/music/` (ADR 0248).

## Alternatives considered

- **Keep dropping, have music re-issue on unlock.** Music would need to know about the lock and what it asked for;
  the backend already knows both. Against 0248's one-way seam.
- **Write the records at once under `mayQueue`, as automation does.** A FADE for a member still in the locked queue
  would reach the core before its PLAY and find no voice.
- **Hold the records inside the `UnlockQueue` entries.** The queue is a generic data structure of voice ids (one-shot
  expiry, caps); a voice on the core when the context is interrupted is not in it. Holding them with musicOps, sent right
  after the drain, gives the same order with one place for both cases.

## Consequences

**Positive**
- A stop asked during an interruption stops the voice when the context resumes; a group stamped while locked fades in.
- The mirror reads what was asked, so selection and `handle.stop(fade)` agree with what will be heard.
- The recording-host tests cover the locked path through the backend interface.

**Negative / costs**
- A held stamped ramp keeps the stamp computed when it was asked, against the clock frozen by the lock; a member whose
  PLAY goes out asap at the resume may meet a fade stamped a little later than its start.
- One closure per held record (only while locked).

## Deprecates

0291's open question (answered). Nothing removed.

## Open questions

None.

## References

`src/plugins/audio/runtime/core/musicOps.ts` (`sendOrHold`, `sendHeld`, `rebuilding`, `post`), `coreBackend.ts`
(`frameAttenuate` calls `sendHeld` after `voices.unlock()`); tests `core/musicOps.test.ts` ("music group operations
while the context is locked (ADR 0294)" on the recording host, and the unit rows over `{ maySend, mayQueue }`).
Architecture review 8, card 7.
