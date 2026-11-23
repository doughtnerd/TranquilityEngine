// The error a declared but unbuilt part of the animation API throws (T01's contract). Each feature module calls it with
// the API name and the build task that implements it, so a caller sees what is missing and who builds it. Internal: it
// disappears from a feature once its task lands.

/** @internal Throws "Animation: `what` is not built yet (`task`)." */
export function notBuilt(what: string, task: string): never {
  throw new Error(`Animation: ${what} is not built yet (${task}).`);
}
