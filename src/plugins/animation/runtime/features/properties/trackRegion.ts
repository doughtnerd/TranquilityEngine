// An Animator's track region in the core's memory (`wire/core.ts`'s `TRACK_*` layout, the `tracks` family's records):
// word views over every row for the column scatter, and the clip whose columns fill a row's block (D36: the
// highest-weight clip). Views are rebuilt only when the core's memory moves.
import type { AnimationCore } from "../../core/AnimationCore";
import { HANDLE_INDEX_MASK, TRACK_COLUMN_CLIP, TRACK_STRIDE } from "../../wasm/wire/core";

/** @internal Word views over the whole track view (row `r` starts at word `r * TRACK_STRIDE / 4`). */
export interface TrackWords {
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
}

const cache = new WeakMap<AnimationCore, { buffer: ArrayBuffer; words: TrackWords }>();

/** @internal The word views of `core`'s track view (valid until the next call into the core). */
export function trackWords(core: AnimationCore): TrackWords {
  const tracks = core.views().tracks;
  const known = cache.get(core);
  if (known?.buffer === tracks.buffer) return known.words;
  const n = tracks.byteLength / 4;
  const words = { f32: new Float32Array(tracks.buffer, tracks.byteOffset, n), u32: new Uint32Array(tracks.buffer, tracks.byteOffset, n) };
  cache.set(core, { buffer: tracks.buffer as ArrayBuffer, words });
  return words;
}

/** @internal Byte offset of instance `handle`'s row in the track view. */
export const trackRow = (handle: number): number => (handle & HANDLE_INDEX_MASK) * TRACK_STRIDE;

/** @internal The clip handle whose columns fill the row's column block this frame (0: none). */
export const columnClip = (words: TrackWords, row: number): number => words.u32[(row + TRACK_COLUMN_CLIP) / 4]!;
