# 0268. One audition module drives the Event editor and the segment transport

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158 (§7 Audition), 0166 (Ed5 transport, Ed7 transition audition, F-15, F-33), 0147 (plugins reach play mode through the SDK), 0269

## Context

Two drivers auditioned the same events. The Event editor's `event/Audition.tsx` was a ref-based Preact component that
flushed the document, called `Audio.play`, polled `Audio.debug()` every 200 ms for the end of the instance and applied
slider changes to its handle. The segment view's `music/transport.ts` did the same flush → play → register → drop with
its own tick, an epoch, a loop and the music extras. They coordinated only through a global `activeAudition` signal in
`event/auditionHost.ts`, and their lifetime rules (`music/transportService.ts`) had drifted where users can see it:

- only the transport stopped when play mode started or its document closed;
- the Event editor's sliders reached the playing instance, the transport read them once at Play (`SegmentView.tsx`);
- the Event editor had no epoch, so a Play could start after its panel closed;
- a looping transport whose handle another audition stopped saw "finished" and restarted, killing that audition;
- the "Nothing played…" text was written twice; only the pure helpers had tests, while the bugs were in the stateful halves.

## Decision

We will have **one audition module per editor**, outside any panel, and make every audition UI a view over it.

- **Module** `src/plugins/audio/editor/audition/audition.ts`: `createAudition(host: AuditionHost): Audition`. It owns
  the playing handle; flush-then-play with an epoch (a newer Play, a Stop or a closed document during the flush cancels
  the play); stop, `stop(match)` (only the audition of that event and segment, `segmentId: null` meaning the Event
  editor's whole-event audition) and key-off; the end of the instance on one `tick()` (its debug row gone and its handle
  done, or the handle alone when the host has no rows); the instance's voices and staleness; live parameter overrides
  (`setParameter(event, name, value)` remembers the slider value and sets it on whatever plays that event);
  `requestParameter` for Ed7; stinger triggers (`stingerTarget(event)`); and one `notice` (backend failed or locked,
  nothing played, else the last seek/stinger/parameter message). The music-only extras are options of the same play
  (`request.music`: segment, grid, start target, start at segment) and of the same instance (seek retries, audible
  stems, loop, reload, playhead). Loop restarts only a music audition that ended by itself; another Play or a Stop drops
  the handle first, so a loop never restarts an audition something else stopped. The shared `activeAudition` signal is
  gone: there is only one current instance.
- **Host seam** `AuditionHost`: play, flush, reload, start at segment/position, stems, `inspect()` (status, backend,
  debug event and voice rows) and `asset(path)` (the raw object for staleness). `editorAudition.ts` builds the real one
  over `Audio`, the asset documents and P8's hooks, and exports the editor's instance `editorAudition`. Tests use the
  fake in `auditionFixtures.ts`.
- **Lifetime** `auditionService.ts` (from F-33), for every audition whoever started it: one display tick while live;
  stop when the editor's play mode starts, when its event leaves the project (a play still flushing counts), when the
  segment view moves off the segment it auditions; the segment panel's solo/mute sync. The Event editor's panel stops its
  own whole-event audition when it closes (`stop({ event, segmentId: null })`); a music audition of the same event
  goes on, as F-33 requires.
- **Views**: `event/Audition.tsx` (Play, Stop, Release, backend, voices, notice, stale hint) and `music/TransportBar.tsx`
  show the audition's state while it plays their event; `SegmentView`, `RulesTable` and `ruleAudition.ts` call the same
  instance. Pure view decisions (buttons, row limit, backend label, stinger names) are `audition/auditionView.ts`.

## Alternatives considered

- **Keep two drivers and share more helpers** — the drift is in the stateful halves (lifetime, epoch, finish, overrides);
  shared pure helpers already existed and did not stop it.
- **Make the transport the module and wrap it for the Event editor** — it would keep "music" in every name and leave
  the Event editor's rows, staleness and release as a second layer; one module with music options is smaller.
- **One audition per panel** — F-33 needs the audition to outlive a tab switch, and one-at-a-time needs one owner.

## Consequences

**Positive**
- Each lifetime rule lives once; the four drifts are fixed: play mode and a closed document stop every audition,
  sliders reach a transport audition, no Play after its panel or document closed, no loop restart over another audition.
- Driven through its interface with a fake host (`audition.test.ts`, `auditionService.test.ts`), stateful halves included.

**Negative / costs**
- The Event editor's voice list now refreshes on the shared 50 ms tick instead of a 200 ms poll (the voices signal only
  changes when a row does).
- A slider move reaches the playing instance only as a move (`setParameter`); a change to a parameter's default while an
  instance plays is heard at the next Play, as for the transport before.

## Deprecates

Removed: `event/auditionHost.ts` (`activeAudition`, `setActiveAudition`, `clearActiveAudition`, `stingerAuditionFor`,
`auditionOverrides`, `setAuditionValue`, `parameterChanges`; the rest moved into `audition.ts` privately or to
`auditionView.ts`), `music/transport.ts`, `music/transportHost.ts` (`musicTransport`), `music/transportService.ts`,
`music/transportServiceHost.ts`, the rules table's own 50 ms tick.

## Open questions

None.

## References

`src/plugins/audio/editor/audition/`; ADR 0158 §7, ADR 0166 Ed5/Ed7/F-33; `tests/e2e/audio-event-editor.spec.ts`,
`tests/e2e/audio-music-d.spec.ts`.
