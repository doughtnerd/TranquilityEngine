# 0018. Promise-based waits for scripts

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0011

## Context

Scripts often need to wait: spawn every two seconds, flash for half a second, wait until a door opens. Unity uses generator coroutines (`StartCoroutine`, `yield return new WaitForSeconds`). JavaScript has `async`/`await` built in. The legacy demo does timing by hand in `update()` (e.g. `PipeSpawner`).

Naively using `setTimeout` or real-time promises breaks pausing and time scale, and keeps running after an object is destroyed.

## Decision

- Lifecycle hooks may be `async`. The engine doesn't wait for them: `update` starts on schedule even if an `async start()` is still awaiting (as in Unity).
- Each behavior gets a `wait` helper whose promises are resolved **by the engine scheduler** at a fixed point in the frame (start of the `update` phase, or the fixed step for `wait.fixedStep()`), never by `setTimeout`:

  | Helper | Resolves |
  | --- | --- |
  | `wait.seconds(n)` | after `n` seconds of scaled game time (respects pause and `timeScale`) |
  | `wait.realtime(n)` | after `n` real seconds |
  | `wait.nextFrame()` | at the next frame |
  | `wait.fixedStep()` | at the next fixed step |
  | `wait.until(() => cond)` | the first frame `cond` is true |

- **Automatic cancellation**: pending waits are dropped when the behavior is disabled or destroyed (or its node becomes inactive). The awaiting function simply never continues, and nothing throws into user code.
- Each behavior exposes `this.abortSignal` (an `AbortSignal` aborted on disable/destroy) for non-engine async work such as `fetch`.

```ts
async start() {
  while (true) {
    this.spawnPipes();
    await this.wait.seconds(2);
  }
}
```

## Alternatives considered

- **Generator coroutines (Unity-style).** Explicit start/stop handles, but less idiomatic in modern JavaScript, and error stacks are worse.
- **Both.** Two ways to do the same thing.
- **No helpers.** Every script reimplements timers in `update()`.

## Consequences

**Positive**
- Idiomatic `async`/`await`; respects pause, time scale and object lifetime.

**Negative / costs**
- Dropped promises mean `finally` blocks in cancelled async functions don't run. This must be documented; use `onDisable`/`onDestroy` for cleanup.
- Re-enabling a behavior doesn't resume cancelled waits (same as Unity coroutines on deactivate).

## Deprecates

- Hand-written timers in demo scripts (e.g. `PipeSpawner`), when ported.

## Open questions

- Whether to offer an explicit handle (`const task = this.run(async () => …); task.cancel()`) for cancelling one flow without disabling the behavior.

## References

- Unity coroutines: https://docs.unity3d.com/Manual/Coroutines.html
