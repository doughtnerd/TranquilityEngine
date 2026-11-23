/**
 * Lip-sync at runtime (ADR 0354 §7): the viseme a line's file shows at a heard time, from its sidecar's `lipsync` keys
 * (`[seconds, viseme]`, imported from Rhubarb Lip Sync or written by hand). `blend` rises 0..1 toward `next` over the
 * last 60 ms before it, so an animation can cross-fade mouth shapes.
 */
import type { SampleLipsync } from "../../../../engine/audio/sample/types";

/** `AudioLineHandle.viseme()`: the mouth shape now, the next one, and how far toward it (0..1). */
export interface AudioViseme {
  readonly viseme: string;
  readonly next: string | null;
  readonly blend: number;
}

/** Seconds before the next key over which `blend` rises to 1. */
export const VISEME_BLEND_SECONDS = 0.06;

/** The viseme at `t` seconds into the file; null without keys or before the first one. */
export function visemeAt(lipsync: SampleLipsync | null | undefined, t: number): AudioViseme | null {
  const keys = lipsync?.keys;
  if (!keys || keys.length === 0 || !Number.isFinite(t)) return null;
  // The last key at or before t (keys are in time order; binary search).
  let lo = 0, hi = keys.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]![0] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (at < 0) return null;
  const next = keys[at + 1];
  if (!next) return { viseme: keys[at]![1], next: null, blend: 0 };
  const left = next[0] - t;
  const blend = left >= VISEME_BLEND_SECONDS ? 0 : Math.min(1, Math.max(0, 1 - left / VISEME_BLEND_SECONDS));
  return { viseme: keys[at]![1], next: next[1], blend };
}
