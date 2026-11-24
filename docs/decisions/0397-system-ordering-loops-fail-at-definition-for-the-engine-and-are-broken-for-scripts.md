# 0397. System ordering loops fail at definition for the engine and are broken for scripts; a fixed timestep may be longer than the max frame time

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0017 and 0032 on system ordering; amends the `time` checks of 0272)
- **Related:** 0011, 0017, 0032, 0272

## Context

Two owner decisions from the round-3 review (open questions Q9 and Q11).

**Q9.** A system's `after`/`before` (0017, 0032) can close a loop (A after B, B after A). The scheduler only noticed when it sorted a World's systems, and that sort threw, inside `World.step`, on every frame: one bad constraint stopped the game. Systems come from two places: engine built-ins (`defineBuiltinSystem`, at engine module level, and first-party plugins' `registerEngineSystems`, 0135), and defined systems (the public `defineSystem`, called by project scripts in the editor and in exported games, and by plugins' `registerSystems`). No engine module calls `defineSystem`; scripts never call `defineBuiltinSystem`.

**Q11.** `project.json` refused `time.fixedDeltaTime > time.maxFrameTime` with "no fixed step would ever run". That's false: the fixed-step accumulator carries the remainder between frames, so a fixed step runs every few frames. The same step length through a World's `tickRate` was allowed. Unity accepts any Fixed Timestep, with Maximum Allowed Timestep only capping a frame's time.

## Decision

**System ordering loops.**
- We will check for loops when the catalog changes, not when a World sorts its systems. `World.step` never throws for a loop.
- An engine built-in whose constraints close a loop among the built-ins is refused when it's defined: `defineBuiltinSystem` throws, adding nothing, with an error naming the loop in run order, e.g. `engine.A → engine.B → engine.A`. That's a bug in engine code and should fail its first test run.
- A loop that involves a defined system's constraint (a script's or a plugin's `defineSystem`) is logged once (`console.error`, naming the loop and the constraint dropped) and broken at its most recently added constraint: the one declared by the most recently defined (or redefined) system on the loop. Built-in constraints are never dropped. Each World's order then honours every other constraint, so the game keeps running. The log isn't repeated while the loop stands; it's logged again if the loop goes away and comes back. Redefining or removing a system re-checks, so fixing the script restores the full order.
- "Engine" means `defineBuiltinSystem`; "script" means `defineSystem`. The distinction is the function called, so it holds in the editor (`withScriptRegistrations`) and in exported games, where scripts are imported without any marker.

**Fixed timestep.** We will accept a `time.fixedDeltaTime` longer than `time.maxFrameTime`, as Unity does: no problem and no warning. Fixed steps then run less than once a frame, exactly as with a World `tickRate` below the frame rate, which is likewise accepted without a hint.

## Alternatives considered

- **Throw from `defineSystem` too** — the script that closes the loop fails to load, which in an exported game stops the game. The owner chose to keep scripts running.
- **Log every frame and fall back to registration order** — noisy, and drops every constraint in the phase rather than one.
- **Break the loop at an arbitrary edge (where the sort meets it)** — unpredictable; the most recent constraint is the likeliest mistake and the easiest to find.
- **Refuse both the long fixed timestep and the slow `tickRate`** — refuses valid, Unity-compatible settings.
- **A hint for both** — the owner allowed at most an informational hint; none is given, since a slow fixed rate is a normal choice (Unity gives none either).

## Consequences

**Positive**
- A bad script constraint no longer stops the game; engine loops are caught at once.
- The fixed-timestep check tells the truth and matches `tickRate`.

**Negative / costs**
- The catalog's loops are recomputed on each catalog change (small: a DFS per phase over tens of systems).
- A broken script loop runs in an order the author didn't fully ask for; the log is the only signal.

## Deprecates

The scheduler's per-frame "System ordering cycle involving …" throw, and the "no fixed step would ever run" settings problem. Both removed.

## Open questions

None.

## References

- `src/engine/core/systems.ts` (`defineBuiltinSystem`, `catalogChanged`, `topoSort`), `src/engine/core/settings.ts` (`parseTime`).
- Tests: `src/engine/tests/systemCycles.test.ts`, `src/engine/tests/runtimeSettings.test.ts`, `src/editor/projectSettingsModel.test.ts`.
