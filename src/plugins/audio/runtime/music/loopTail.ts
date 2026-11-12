/**
 * Loop tails (ADR 0166 api-and-models §2.3 regions, §11 point 5; architecture §3.5; ADR 0167 §2: loop tails are decoded
 * clips).
 *
 * Owner: **R4a** (W7), on R4c's span clips (`core/clipRegistry.ts`: decode `[start, end)` of an asset as its own clip).
 * Q2 wrote the skeleton.
 *
 * At each wrap of a loop region, the audio after the loop end (the tail) is played as a decoded span voice stamped at the
 * wrap, so it rings over the wrap and frees its ring with its voice. A tail longer than allowed is refused with
 * `tailRefused`.
 */
import type { AudioVoice } from "../backend";
import type { MusicFrame, MusicPlayer } from "./musicSystem";

/** The player's ringing tails. R4a may add fields here. */
export interface LoopTailState {
  /** Tail voices still ringing, with the heard time (seconds) each was stamped at. */
  readonly ringing: { voice: AudioVoice; at: number }[];
  /** Heard time (seconds) of the next wrap a tail is stamped for; NaN: none. */
  nextWrap: number;
}

/** R4a: an empty tail state. */
export function createLoopTailState(): LoopTailState {
  return { ringing: [], nextWrap: Number.NaN };
}

/** R4a, step 9: stamp the tail span voice for the next wrap when it is within the lead; forget ended tails. */
export function tickLoopTails(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(R4a)
}
