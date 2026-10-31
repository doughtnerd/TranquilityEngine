# 0011. Frame loop and system order

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0005, 0007, 0010

## Context

The legacy `Engine.js` drives the game with two independent `setInterval`s: one for update/render at a nominal 200 fps, one for physics every 20 ms. Timing uses `Date.now()`, and `deltaTime` is computed as the *intended* interval plus how long the frame took, not the real time between frames. Consequences:

- Rendering isn't synced to the display (tearing, wasted frames, no throttling when hidden).
- Physics and update run in arbitrary interleaving, so scripts can see a half-updated world.
- Timing is coarse and wrong under load.

## Decision

- The loop runs on **`requestAnimationFrame`** and uses `performance.now()` for timing.
- Physics and `fixedUpdate` use a **fixed-step accumulator**:
  - `Time.fixedDeltaTime` default `1/60` s (configurable).
  - Each frame adds real elapsed time (clamped to `maxFrameTime`, default 0.25 s) to the accumulator, then runs whole fixed steps while `accumulator >= fixedDeltaTime`, up to `maxSubSteps` (default 5) to avoid a death spiral.
  - The remainder becomes `Time.fixedAlpha` (0..1) for render interpolation (0010).
- **Order within one frame:**

  1. **Begin frame**: compute `Time.deltaTime` (scaled by `Time.timeScale`) and `Time.unscaledDeltaTime`.
  2. **Input**: snapshot keyboard/mouse/gamepad state so `getKeyDown` is stable for the whole frame.
  3. **Start pending**: call `start()` on behaviors enabled since the last frame.
  4. **Fixed steps** (0..N times):
     1. `fixedUpdate()` scripts
     2. push kinematic/static/teleported bodies → physics backend
     3. physics step
     4. write dynamic body poses → `Transform`
     5. dispatch collision/trigger hooks to behaviors and fill the collision/trigger buffers (0017)
  5. **`update()`** scripts
  6. **`lateUpdate()`** scripts
  7. **Transform propagation** (world matrices)
  8. **Render sync**: copy world matrices / interpolated poses to three.js objects; update audio listener/sources
  9. **Render**: one `renderer.render()` per active camera (by camera depth order)
  10. **End of frame**: apply deferred destroys (`onDisable` → `onDestroy`), deferred component adds/removes, then pending scene loads/unloads
- Structural changes requested at any step are queued and applied at step 10, except `instantiate`, which creates the node immediately (so the caller can use it) but runs its first `start()` at step 3 of the next frame, like Unity.
- **Pausing**: `Time.timeScale = 0` stops fixed steps and scaled time; `update` still runs with `deltaTime = 0`, so menus work. Hidden window: when the webview stops sending frames, the clamp on `maxFrameTime` stops a catch-up burst when it resumes.
- The loop is owned by an `Engine` instance (not static globals) so tests can step it by hand: `engine.step(dt)`.

## Alternatives considered

- **Variable timestep physics.** Simpler, but physics becomes frame-rate dependent and unstable on hitches.
- **Physics in a Web Worker.** Frees the main thread, but adds a frame of latency and serialization costs, and makes synchronous `Physics.raycast` from scripts awkward. Could be revisited for very heavy 3D scenes.
- **Keep `setInterval`.** See context.

## Consequences

**Positive**
- Rendering synced to display refresh; deterministic order scripts can rely on.
- Physics is stable and independent of frame rate.
- Testable loop.

**Negative / costs**
- Fixed steps can run 0 times in a frame on high-refresh displays, so `fixedUpdate` isn't "once per frame". This must be documented, as in Unity.
- Interpolation adds a small, constant visual latency (up to one fixed step).

## Deprecates

- `src/engine/Engine.js` (static class, both `setInterval`s, `Date.now()` timing, `targetFrameRate`, `timestep`).
- `src/engine/Time.js` fields computed by the old loop; replaced by `Time` with `deltaTime`, `unscaledDeltaTime`, `fixedDeltaTime`, `fixedAlpha`, `timeScale`, `frameCount`, `time`, `realtimeSinceStartup`.
- `Input.processKeyboardInput` / `processMouseInput` called from the loop; replaced by the input snapshot step.

## Open questions

- ~~Default `fixedDeltaTime`.~~ Resolved: 1/60 s.
- Whether to expose a `targetFrameRate` cap (rAF already follows the display; a cap only matters for battery saving).

## References

- Glenn Fiedler, "Fix Your Timestep!"
- Unity execution order: https://docs.unity3d.com/Manual/ExecutionOrder.html
