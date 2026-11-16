/**
 * Change detection for per-frame syncs: work that Babylon does on every change (rebuilding shader
 * defines, recomputing bounds) is done only when something did change. Pure.
 */

/**
 * Refill `list` with `items` only when they differ, in one splice (never emptied, then filled).
 * Babylon watches a shadow map's render list, and when it goes from empty to filled it marks every
 * mesh in the scene as needing its shader defines rebuilt: clearing and refilling it each frame did
 * that every frame. True when it changed.
 */
export function refillIfChanged<T>(list: T[], items: readonly T[]): boolean {
  if (list.length === items.length && list.every((m, i) => m === items[i])) return false;
  list.splice(0, list.length, ...items);
  return true;
}

/**
 * Whether a world matrix (16 floats of `source` from `offset`) differs from the one an
 * entry last kept; if so, it becomes the entry's. (A mesh re-freezes only when its node moved.)
 */
export function matrixChanged(entry: { matrix: Float32Array | null }, source: ArrayLike<number>, offset: number): boolean {
  let m = entry.matrix;
  if (m) {
    let i = 0;
    while (i < 16 && m[i] === source[offset + i]) i++;
    if (i === 16) return false;
  } else {
    m = entry.matrix = new Float32Array(16);
  }
  for (let i = 0; i < 16; i++) m[i] = source[offset + i];
  return true;
}
