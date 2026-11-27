# 0435. "Why it played" names the trigger and the game code that asked

- **Status:** Proposed (built: a small extension of 0348's captures within format 2; awaiting the owner's acceptance)
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0348 (takes and captures, the "Why it played" chain), 0171 and 0172 (the profile sink and the capture format), 0011 and 0032 (behaviour hooks and systems run by the World), 0343 (the playlist runtime)

## Context

The Studio Profiler's "Why it played" chain (0348) starts at a GAME step that said only "Game event *asset*, Game trigger": a capture's `eventStart` record held the instance and the playlist asked for, nothing about who asked. When a game event causes a sound, the owner wants that step to show the trigger's name and where it came from: the GameObject, behaviour, system or script that raised it.

The audio runtime can't see its caller. `Audio.play` is a plain function; the engine knows which behaviour hook it is calling (`World.invoke`, every lifecycle hook and message) and which defined system it is running (`Scheduler.runUser`), but kept no record of it.

## Decision

1. **The engine notes the running game code.** `src/engine/core/runningScript.ts` holds the behaviour and hook `World.invoke` is calling and the defined system `Scheduler.runUser` is running; both set them before the call and restore the outer values after (in `finally`, so a nested message hook or a throw unwinds). `runningScript()` (`@internal`, not exported from `myco`) answers `{ behaviour, hook, system }` or null. Writing costs two field stores and their restores per call and allocates nothing; the answer is built only when asked. Built-in systems aren't named (their behaviours are).
2. **A playlist instance records its cause.** `ProfileSink.eventStart(instance, asset, cause?)` takes a `ProfileCause`: `trigger` (the request: `Audio.play`, `AudioSource`, `AudioZone`, `Audio.line`, `Audio.say("Event")`), `node` (the GameObject's path of names from the World root), `behaviour` (`Type.hook`, the type its registered id such as `flappy.Bird`, which survives minification, else its class name) and `system`. The playlist runtime builds it (`playlists/cause.ts`) only while a recorder runs: components and lines pass their request name and node through two `@internal` `PlaylistOptions` fields (`trigger`, `triggerNode`); otherwise the node is the running behaviour's owner.
3. **The capture carries it within format 2.** An `eventStart` EVENT with a cause has six args: instance, asset, then trigger, node, behaviour and system as ids in the `parameters` names table (`NO_NAME` for null). It is appended as `audioPackage`'s third arg was: readers take the first two, so older builds read new captures and older captures (two args) read as before. The reader answers `cause` only when the record has it.
4. **The Studio shows it.** `instanceDecisions` reads the cause into `InstanceDecisions.cause`; the GAME step's name is the trigger, its line the source ("/Level/Player/Bike · BikeAudio.onCollisionEnter · system game.Waves", or "No script hook running"), and its tooltip (and screen-reader text) lists each fact with the asset asked for. A capture without a cause keeps the old step.

## Alternatives considered

- **A stack trace at each play** (`new Error().stack`, parsed for a script file) — costly, differs between browsers and minified builds, and names files the player doesn't ship; not chosen.
- **A new EVENT kind or names table for causes** — a new kind would make older builds refuse new captures (an unknown kind), and a new table changes META's keys; appending args to `eventStart` needs neither.
- **Public API (`Audio.play(path, { source })`)** — makes every caller say who it is; the engine already knows, so it shouldn't be asked.

## Consequences

**Positive**
- The GAME step answers "who asked" for plays from behaviour hooks, defined systems, `AudioSource`, `AudioZone`, `Audio.line` and `Audio.say`.
- No cost without a recorder beyond the per-hook field stores; old and new captures read in both directions.

**Negative / costs**
- Code that runs after an `await`, in a timer, a DOM or UI event outside a hook reads no behaviour ("No script hook running").
- The script *file* isn't named: a shipped build has no map from a class to its source file. The behaviour's registered id (or class name) stands in for it.
- The node path includes the scene node ("/level/Player/Bike"), as `nodeAtPath` reads it.

## Deprecates

Nothing.

## Open questions

- Naming the script file when a debug or editor build can map classes to files.
- Carrying the context across `await` (an async-context API, when browsers have one).

## References

- `src/engine/core/runningScript.ts`, `src/plugins/audio/runtime/playlists/cause.ts`, `src/plugins/audio/runtime/capture/events.ts`, `src/studio/screens/profiler/whyModel.ts`.
