/**
 * ADR 0348 (D22): who sent a live mix op, for the capture's MIXOP record (`origin`). `Mixer.apply` takes only the op and
 * sends it synchronously (`MixOpTarget.sendOp`, then the capture's `onMixOpSent` hook), so the caller names the origin
 * around the call: `withMixOpOrigin("undo", () => mixer.apply(op))`. Ops applied outside one are the editor's (the
 * default): every `mixer.apply` caller is an editor tool; scripts change the mix through the bus setters, not ops.
 *
 * The editor's op log names undo and redo, Compare names `compare`. No DOM; no import beyond the record's enum type.
 */
import type { MixOpOrigin } from "./format";

/** A MIXOP origin by name. */
export type MixOpOriginName = keyof typeof MixOpOrigin;

let current: MixOpOriginName = "editor";

/** Runs `apply` with `origin` as the origin of every op it sends; the previous origin comes back after (nesting works). */
export function withMixOpOrigin<T>(origin: MixOpOriginName, apply: () => T): T {
  const previous = current;
  current = origin;
  try {
    return apply();
  } finally {
    current = previous;
  }
}

/** The origin of an op being sent now. */
export function currentMixOpOrigin(): MixOpOriginName {
  return current;
}
