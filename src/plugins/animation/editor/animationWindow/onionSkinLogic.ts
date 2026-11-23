// Onion skin (ADR 0373, "onion skin for sprites and bones"): ghosts of the frames before and after the playhead. This
// module works out which frames those are (every `step` frames at the clip's rate, `before` of them back and `after`
// forward; a looping clip wraps, another stops at its ends), and what a sprite track shows at each, which the window
// draws as its overlay (ghost marks on the ruler and rows, the sprite frames beside the playhead).
//
// Ghost poses of bones and sprites drawn in the viewport need the renderer to draw a node more than once in one frame
// with another pose, which it can't yet; until then the overlay is the window's (see the report of T50).
//
// Pure; no DOM.
import type { AnimSource } from "../../../../engine/animation/animSource";
import type { DiscreteValue } from "../../../../engine/animation/tracks";

/** How many ghosts, and how far apart. */
export interface OnionSettings {
  /** Ghosts before the playhead (0..8). */
  readonly before: number;
  /** Ghosts after it (0..8). */
  readonly after: number;
  /** Frames between ghosts (≥ 1). */
  readonly step: number;
}

export const DEFAULT_ONION: OnionSettings = { before: 2, after: 2, step: 1 };
const MAX_GHOSTS = 8;

/** One ghost: how many steps from the playhead (negative: before) and the time it shows. */
export interface OnionFrame {
  readonly offset: number;
  readonly t: number;
}

/** The ghost frames around `t` (nearest first on each side, before then after). */
export function onionFrames(t: number, clip: Pick<AnimSource, "rate" | "duration" | "loop">, settings: OnionSettings = DEFAULT_ONION): OnionFrame[] {
  const d = clip.duration;
  if (!(d > 0) || !(clip.rate > 0)) return [];
  const dt = Math.max(1, Math.floor(settings.step)) / clip.rate;
  const out: OnionFrame[] = [];
  const side = (count: number, sign: -1 | 1) => {
    for (let i = 1; i <= Math.min(MAX_GHOSTS, Math.max(0, Math.floor(count))); i++) {
      let at = t + sign * i * dt;
      if (clip.loop) at = ((at % d) + d) % d;
      else if (at < -1e-9 || at > d + 1e-9) break;
      out.push({ offset: sign * i, t: Math.min(d, Math.max(0, at)) });
    }
  };
  side(settings.before, -1);
  side(settings.after, 1);
  return out;
}

/** What a discrete track's keys hold at `t`: the last key at or before it (the first key before any), or null with none. */
export function discreteAt(keys: readonly (readonly [number, DiscreteValue])[], t: number): DiscreteValue | null {
  if (!keys.length) return null;
  let v = keys[0]![1];
  for (const k of keys) if (k[0] <= t + 1e-9) v = k[1];
  return v;
}

/** A sprite track's frames at the playhead and the ghosts. */
export interface OnionSprites {
  readonly nodePath: string;
  readonly field: string;
  /** The playhead's frame (offset 0) and each ghost's, in `frames` order with the playhead first. */
  readonly frames: readonly { readonly offset: number; readonly t: number; readonly sprite: string }[];
}

/** The sprite (asset-valued discrete) tracks of `clip` with what each shows at `t` and at each ghost frame. */
export function onionSprites(clip: AnimSource, t: number, frames: readonly OnionFrame[]): OnionSprites[] {
  const out: OnionSprites[] = [];
  for (const track of clip.tracks) {
    if (track.kind !== "discrete" || track.valueType !== "asset" || !track.keys.length) continue;
    const at = (time: number) => String(discreteAt(track.keys, time) ?? "");
    out.push({ nodePath: track.target.nodePath, field: track.target.field, frames: [{ offset: 0, t, sprite: at(t) }, ...frames.map((f) => ({ ...f, sprite: at(f.t) }))] });
  }
  return out;
}
