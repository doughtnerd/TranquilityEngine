# 0322. Automatic quality is one module: the Engine hands it frame times, Graphics keeps the active tier

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0055 (a guess of "the default" means the platform's default; a saved tier that names no tier is no choice)
- **Related:** 0050, 0055, 0111, 0319

## Context

Automatic quality (ADR 0055, with 0111's per-platform defaults) was spread over four modules:

- `render/qualityDetect.ts`: the pure guess (`guessTier`, `tierForGuess`) and the `FrameMonitor`, tested.
- `render/Graphics.ts`: reading the device, mapping the guess onto tiers (`detectQuality`) and saving the detected
  tier (`_applyDetected` wrote `graphics.autoQuality`).
- `core/projectBoot.ts`: whether to detect (`saved === undefined || Graphics.autoDetected`) and the first pick.
- `core/Engine.ts`: a private `watchQuality` with the 30-frame warm-up and the step-down policy, untested.

The bugs sat in the calls between them:

- **Platform default ignored.** `detectQuality` mapped a guess of "the default" (any GPU it didn't recognise) to
  `defaultTier`, though `Graphics` had already worked out the platform's default. On mobile with an unrecognised GPU,
  detection picked the desktop default.
- **A stale saved tier stopped detection forever.** A saved tier that was renamed or removed isn't a pick (`Graphics`
  ignores it), but `saved !== undefined` kept detection off on every run.

## Decision

We will make automatic quality one module, `render/autoQuality.ts`:

- **Interface:** `startAutoQuality(settings, saved): AutoQuality | null`, called by project boot once the project
  context (ADR 0319) has configured `Graphics`, for a runtime that draws with the player's tier. It detects when
  `autoDetect` is on and `saved` names none of the project's tiers. A tier detected on an earlier run (restored by
  `Graphics._configure`) stays; otherwise the machine's guess is applied and saved. `AutoQuality.frame(dt)` takes
  each frame's time step and returns false once it has stopped watching: after its 30-frame warm-up, the
  `FrameMonitor`'s verdicts step the tier down one at a time (saved each time), and it stops when the watching time
  runs out or the player picks a tier.
- **Owned here:** reading the device (memoized), the guess-to-tier mapping (`detectedTier()`: "the default" is
  `Graphics.defaultQuality`, the platform's default), whether to detect, the first pick, the warm-up, step-down and
  the `AUTO_QUALITY_KEY` save.
- **Graphics keeps the active tier:** `_configure` (saved choice, then a detected tier, then the platform default),
  `quality`, `autoDetected`, and `_applyDetected(name)`, which only marks the tier as detected.
  `Graphics.detectQuality()` stays public and answers with `detectedTier()`.
- **Callers:** project boot keeps its acquire/release structure (ADR 0319) and only asks `startAutoQuality`; the
  Engine holds the returned `AutoQuality` and hands it each step's `dt`. `qualityDetect.ts` stays the pure rules.

## Alternatives considered

- **Fix the two calls in place.** Two one-line fixes, but the policy would stay split across four files and the
  step-down untested behind a private Engine method.
- **Let `Graphics` own detection too.** One fewer file, but it mixes the player's active tier (public, every host)
  with a start-up policy only the runtime player uses.
- **Pass the device in.** A `device` parameter would let tests choose a GPU, but production never passes one; tests
  stub `navigator` instead (Node has no WebGL, so the GPU reads as unknown).

## Consequences

**Positive**
- The quality decision lives in one file with tests through its interface: the first pick, the stale-tier and
  platform-default cases, the warm-up, step-down with fake frame times, and the player's pick stopping it.
- The Engine's frame loop has one line for it.

**Negative / costs**
- `Graphics.ts` and `autoQuality.ts` import each other (`detectQuality` answers through the module, which applies
  tiers through `Graphics`); neither uses the other at load time, so the cycle is safe.

## Deprecates

`Engine.watchQuality` and `qualityMonitor`/`monitorFrames`, `BootedProject.monitor` (now `autoQuality`), the device
reading in `Graphics.ts`, `AUTO_QUALITY_KEY` in `Graphics.ts` (moved to `autoQuality.ts`), `_applyDetected`'s save,
and `engine/tests/graphicsDetect.test.ts` (its cases moved to `autoQuality.test.ts`). Removed.

## Open questions

None.

## References

- `src/engine/render/autoQuality.ts`, `src/engine/render/Graphics.ts`, `src/engine/core/projectBoot.ts`,
  `src/engine/core/Engine.ts`; tests `src/engine/tests/autoQuality.test.ts`.
