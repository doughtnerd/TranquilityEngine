# 0161. One play-session module owns play mode's states and the work deferred to Stop

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0030, 0124, 0125, 0133, 0139, 0145, 0155

## Context

`src/editor/session.ts` (671 lines, 25 exports) did unrelated jobs: project open/close/create/recent/samples,
booting the Editor World (`loadProject`), scene-tab delegation, plugin re-apply, starting and stopping play,
script watching and reload, and Code-panel saves. Play mode's lifecycle lived in five module-level variables
(`play`, `checkingScripts`, `pendingReload`, `pendingPlugins`, `unmountPlayTools`) written from five functions:

- `stopPlaying` replayed deferred work in a fixed order: take kept values (0022, 0124), end live inspection,
  `Material._resetShared` (0107), write the kept values, `reapplyPlugins` if `pendingPlugins` (0133),
  `reloadScripts` if `pendingReload` (0030, 0125).
- `reloadIntoGame` set `pendingReload` as a side channel so Stop would rebuild the Editor World.
- With third-party plugins, re-applying plugins on Stop started a script reload and so did `pendingReload`:
  two reloads.
- `loadProject` and `closeProject` called `stopPlaying()`, which started the old project's queued reload
  (unawaited) while the new project's scripts loaded.

None of it could be tested through an interface: `session.play` is set only by `startPlaying`, which needs the
viewport DOM. `playReload.test.ts` re-implemented the sequence "as the session does" with `startPlay` and
`swapScriptTypes`, and `scriptReload.test.ts` poked `playState.value = "playing"` and checked that a reload
waited, never that Stop performed it.

## Decision

**A play-session module, `src/editor/playSession.ts`.** `createPlaySession(ports)` returns the editor's
play controller. It owns the `edit → starting → playing → edit` state machine (published, as before, on
`playState` and `playing` in `state.ts`) and the queue of work deferred to Stop.

**Ports** are what varies between the editor page and a headless test:

- `editor(): Engine | null` — the Editor World's Engine (null: no project, Play does nothing);
- `checkBeforePlay(project): Promise<boolean>` — the pre-play type check (0125); false cancels Play;
- `gameView?(): { container, mountTools(play) }` — where the game shows and the play bar's tools; omitted, the
  game runs headless and the caller steps `playing.value.engine`.

Everything else it reads from the editor's state signals (`openScene`, `currentProject`, the multiplayer play
preferences), as the rest of the editor does.

**Interface:**

- `start()`: check scripts, then `startPlay` (0155's launch adapter); a failure returns to edit with the error in
  the status bar. Ignored unless in edit and not already checking.
- `stop({ discardQueued? })`: leave play and run the queue (below). `discardQueued` drops the queued reload and
  plugin re-apply, for a project switch or close.
- `toggle()`.
- `reloadScripts({ outside? })`: in edit, reload and rebuild the open scene (0030); while starting, queue a
  reload for Stop; while playing, reload into the running game (0125) and queue the Editor World's rebuild.
- `reapplyPlugins()`: in edit, apply `plugins.disabled` live (0133); otherwise queue it for Stop.

**Stop's order is the module's, in one place:** take kept values, end live inspection, unmount the play tools,
dispose the game, `Material._resetShared`, publish edit, write kept values (one undo step; the open scene is
rebuilt first if scripts were swapped during play), re-apply plugins, reload scripts. The queue is two flags inside the controller; re-applying plugins that needs a script reload
(third-party plugins, 0139) folds into the queued one, so Stop reloads at most once.

**Script watching stays in `session.ts`.** Writing `tsconfig.json` and watching `scripts/` is per-project setup,
started by `loadProject` and torn down by the next one; the watcher only calls `reloadScripts({ outside: true })`.
Moving it beside the play state would tie project lifecycle to play mode; a module of its own would be one
function with one caller. What a reload *does* depends on the play state, so reloading moves.

**`session.ts` keeps project lifecycle** (open/close/create/recent/samples, `loadProject`, scene tabs, save, Code
panel saves, script watching) and creates the one controller with the viewport's game view, `checkBeforePlay` and
`mountPlayTools`. Its exports `startPlaying`, `stopPlaying`, `togglePlaying`, `reloadScripts`, `reapplyPlugins`
forward to it, so callers don't change. `syncPackageTypes` moves to `scriptCheck.ts` beside
`refreshPackageTypes`, used by both.

**Fixed drift.** Switching or closing a project no longer starts the old project's queued reload alongside the
new project's script load; Stop no longer reloads twice when re-applied third-party plugins need a reload.
Found by the new tests: values kept on a script component whose script was saved during play were all skipped
("the node in the scene has no Wheel"), because the reload during play had replaced the type while the Editor
World's nodes still held the old class. Stop now rebuilds the open scene before writing kept values when a reload
is queued, so they land (the queued full reload still follows).

**Work queued for Stop never waits for a Stop that won't come** (found in review after the build): a game
that fails to start runs the work queued while it was starting (`runQueued`, as Stop does) before showing the
error; a Stop that lands while a reload into the game is still loading its code leaves that reload to finish
into the editor (a full edit-mode reload) instead of queuing it for a later Stop; and `stop({ discardQueued })`
drops queued work even when no game is running.

## Alternatives considered

- **Keep the state in `session.ts` and export a test hook to set `play`** — tests would still re-state Stop's
  order, and the side channel stays.
- **A generic "run when editing" job queue that callers push closures onto** — the order matters (kept values
  before the rebuild, plugins before scripts) and the reload must fold, so the queue would need priorities and
  dedupe; two named flags say it directly.
- **Script reload in its own module, play session asking it** — every branch of `reloadScripts` asks the play
  state; split, the two modules would call each other.
- **Ports for `openScene` and `currentProject`** — they're the editor's global state, set by tests already;
  ports would only re-plumb them.

## Consequences

**Positive**
- "Edit a script during play, Stop, it reloads", "plugin change during play applies on Stop", kept values before
  the queue, and a failed start returning to edit are tested headless through `createPlaySession`
  (`src/editor/playSession.test.ts`).
- `playReload.test.ts` reloads through the controller instead of re-implementing it; `scriptReload.test.ts` plays
  through it instead of poking `playState`.
- `session.ts` loses play and reload (671 to 505 lines; `playSession.ts` is 256).

**Negative / costs**
- Two controllers would fight over the shared `playState`/`playing` signals; the editor makes one, tests make their
  own and stop it after each test.
- Stop does its synchronous part at once and starts the queued reload without the caller waiting, as before; `stop()` returns
  a promise of the queued work that tests await and `stopPlaying()` ignores.

## Deprecates

`session.ts`'s `play`, `checkingScripts`, `pendingReload`, `pendingPlugins`, `unmountPlayTools`, `writeKeptValues`
and `reloadIntoGame`; the re-implemented reload sequence in `playReload.test.ts` and the `playState` poke in
`scriptReload.test.ts`.

## Open questions

- Should Keep values survive a project switch? Today they are written into the closing scene, as before.

## References

- `src/editor/playSession.ts`, `src/editor/playSession.test.ts`, `src/editor/session.ts`, `src/editor/playMode.ts`
- `src/editor/playReload.test.ts`, `src/editor/scriptReload.test.ts`
