# 0229. The music player owns its state transitions

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0166, 0167, 0224

## Context

ADR 0166's music runtime keeps one record per playing music instance, `MusicPlayer` (`music/musicSystem.ts`). It was a plain mutable record, and seven modules wrote its fields:

- `state`: the planner, the transition code, the recovery code (`background.ts`), `musicSystem.ts`, and `events/eventRuntime.ts`'s `stopMusic` (`p.state = "stopping"`);
- `run`, `next`, `anchor`: the planner, the transition code, the recovery code, the playlist and the reload code;
- `regions`: the playlist, the transition code and `regions.ts`;
- one module each: `planned`, `transition`, `tails`, `stingers`, `beats`.

The promotion rule ("`run = X`; if `next === X` then `next = null`; `anchor = anchorRun(X, at)`; maybe `regions = null`") was copied out five times (planner, transition, recovery, playlist, reload). Clearing a cancelled `next` was copied out five more times. Only the transition and the playlist cleared `regions`.

That difference was drift, not a choice. `regions.ts` and the design (0166 api-and-models §1.2 seek, `regions.ts`'s header) say a new run starts with fresh region state, whatever started it: a transition, a playlist step, a seek, a reload or a recovery. `tickRegions` already makes a fresh state whenever its stored `run` isn't the playing run. But the anchors' pass walk (`readRelease`) reads `player.regions` without that check. So a promotion that kept the old state (the planner's first start, a recovery's re-entry, a reload) left the old run's released region visible to `tickLoopTails`, `tickStingers` and `tickStems` for the rest of the tick in which it happened. A recovery that re-enters the segment whose `while` region had been released could skip a loop tail at its first wrap.

Fourteen test files and the two test rigs (`music/testing/beatRig.ts`, `jitterTrace.ts`) assigned player fields directly. The debug row and the keyframe source read the record, and the event runtime decided "is this instance still on its way to sounding" by reading `planned` and the runs' states.

## Decision

We will make the player a module, `music/musicPlayer.ts`, that is the only code that writes a player.

- **A read-only view.** `MusicPlayer` is an interface of `readonly` fields. The debug row, the keyframe source, `handle.music` and every music module read it through that view. `musicSystem.ts` re-exports the type and keeps the registry (`createMusicPlayer`, `disposeMusicPlayer`, `playerOf`, `musicPlayers`).
- **Named transitions.** These are the only writes:
  - the playing run and its successor: `promote(player, run, at)`, `adoptSuccessor`, `cancelSuccessor`;
  - the plan: `adoptPlan`, `clearPlan`;
  - the first start: `primeStart`, `waitForRoom`, `refuseStart`, `commitStart(player, run, at)` (a promotion, then `committed`), `noteStartHeard`;
  - recovery: `beginRecovery`, `restartFirst`;
  - the transition: `beginTransition`, `markPending`, `finishTransition`, `abandonTransition`, `clearTransition`, `syncOverlap`;
  - the end: `stopPlayer`, `endPlayer`.
  Each one keeps the guards its callers wrote out before (for example, `stopPlayer` leaves a refused or stopped player as it is).
- **One promotion rule.** `promote` sets the run, clears a `next` that was that run, anchors the grid on `at`, and always clears `regions`. All five promotions use it.
- **Owned sub-states.** Loop regions, loop tails, stingers, beat cursors, and a playlist adopted through a switch are attached by their owner with `attachState(player, key, state)`. Only that owner writes their contents.
- **The event runtime asks.** `stopMusic` calls `stopPlayer`. `musicPlaying` asks `musicPending(player)`, which says whether the instance is still on its way to sounding: before its first group, while a change is pending, while recovering, or while a plan or run primes. The event runtime then checks the voices itself.
- **Dispatch subscriptions are private.** The beat-callback listeners and masks (`listeners`, `subscribed`, `hooks`, `predicted`, `eventHandle`) leave the record. They live in a `WeakMap` in `musicSystem.ts`, which is the only module that read or wrote them.
- **The pass walk's input is narrow.** `predictWrap` and `advanceAnchor` take `PlayingPosition` (`anchor`, `run`, `regions`), so the beat clock walks its scratch anchor without casting a fake player.
- **No per-frame allocation.** The transitions only assign fields. Only `newMusicPlayer` allocates, once per instance.
- **Tests use the same interface.** Tests and rigs call the transitions, or play through `Audio.play` on the fake backend. Examples: `beatRig.playingRun` uses `commitStart` and `noteStartHeard`, `jitterTrace` uses `promote` and `adoptSuccessor`, and a slip goes through `applySlip`. The playlist tests seed their order through the instance's group instead of replacing `player.playlist`. The dispatch tests subscribe through `onMusicOf` instead of writing listener fields.

`_setMusicHandleFactory` stays. `Audio.ts` registers through it at load: it owns the handle class, and `musicSystem.ts` must not import `Audio.ts`. It is real registration, not a test hook.

## Alternatives considered

- **A class with private fields and getters.** It enforces the same rule at run time. But it needs the beat clock's scratch position to be a real player (or a cast), and getters on the hot path add nothing over `readonly` here.
- **Keep the record and add a `promote` helper.** It removes the five copies, but it leaves `state` and `next` writable by everyone, so the next copy is one assignment away.
- **Move every sub-state into its owner's `WeakMap`.** That would also make the sub-states private. But the event runtime reads `stingers` and `tails` to decide whether the instance still sounds, and a `WeakMap` lookup per owner per frame buys nothing over a `readonly` reference.

## Consequences

**Positive**
- The promotion rule and the successor rule are written once, and a promotion always starts fresh region state.
- Each lifecycle state has one named entry point, so a reader finds every way a player becomes `pending` or `stopping` in one file.
- Tests express situations as lifecycle steps (commit, adopt a successor, recover), not field writes.

**Negative / costs**
- `readonly` is a compile-time rule. A cast can still write a field. Review catches that.
- `attachState` is a narrow setter. Its rule (only the owner attaches its own slot) is a convention, not a type.
- The event runtime's end scan changes slightly for one case. A stopping player with a run still priming used to count as over at once. Now its voices, stingers and tails decide, the same as any stopping player.

## Deprecates

- The `MusicPlayer` record's writable fields. Direct writes from `planner.ts`, `transition.ts`, `background.ts`, `playlist.ts`, `reload.ts`, `regions.ts`, `loopTail.ts`, `stingers.ts`, `beatClock.ts`, `musicSystem.ts` and `eventRuntime.ts` are replaced by the transitions.
- `MusicPlayer.listeners`, `subscribed`, `hooks`, `predicted` and `eventHandle`. They move into `musicSystem.ts`'s private subscriptions.
- The exports `MusicListeners` and `MusicSubscription`. Both are now private to `musicSystem.ts`.

## Open questions

None.

## References

- ADR 0166 (the music runtime; api-and-models §3.2 `MusicPlayer`, architecture §2.1's state diagram), ADR 0167, ADR 0224 (the music runtime's reads of the core's frame map).
- `src/plugins/audio/runtime/music/musicPlayer.ts`, `musicSystem.ts`, `anchors.ts` (`PlayingPosition`), `events/eventRuntime.ts`.
