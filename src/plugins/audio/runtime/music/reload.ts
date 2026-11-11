/**
 * Hot reload of a playing segment (ADR 0166 api-and-models §10 P8; architecture §3.10).
 *
 * Owner: **P8** (W5). Q2 wrote the skeleton.
 *
 * An edited stem or segment of a playing instance is re-primed and swapped at the next bar without a gap (an immediate
 * transition into the same position, `transition.planImmediate`); the worker's encoded cache entry for the edited file
 * is invalidated.
 */
import type { MusicFrame, MusicPlayer } from "./musicSystem";

/** P8: an asset changed on disk (the editor's reload event): marks the players that use `path` for a swap. */
export function noteAssetChanged(path: string): void {
  void path;
  // STUB(P8)
}

/** P8, step 9 (first in the tick): plan the swap at the next bar for a marked player. */
export function applyReloads(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(P8)
}
