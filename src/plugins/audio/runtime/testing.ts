// @internal test helpers for the audio plugin (api-and-models §6, "Fakes"). Contract K4 (coordinator, MS2 wave 2):
// the loopback host's signature. A1.7 owns this file and fills it; A1.4's loopback check runs on it at the wave review.

import type { FakeHostClock } from "./core/hostClock";

/** The real wasm core run in Node with no AudioContext (architecture §4.6). */
export interface LoopbackHost {
  /** The injected clock; `renderQuanta` advances it by 128 frames per quantum. */
  readonly clock: FakeHostClock;
  /**
   * Renders `n` quanta through the real wasm and delivers the STATUS blocks synchronously at their 6-quantum points
   * (and every 48 when no batch arrived for 250 ms). Returns the rendered audio, planar: [L of all quanta, R of all quanta].
   */
  renderQuanta(n: number): { readonly left: Float32Array; readonly right: Float32Array };
}

/** Builds a loopback host on the committed wasm, with the given (or a new) fake clock. A1.7 fills the body. */
export function createLoopbackHost(options?: { clock?: FakeHostClock }): Promise<LoopbackHost> {
  void options;
  throw new Error("not implemented: A1.7 (createLoopbackHost)");
}
