// An avatar mask (`myco.mask@1`, ADR 0371; `engine/animation/mask.ts`) resolved to one weight per bone of a skeleton,
// the form the core's `load_mask` takes (ADR 0372: layered blend by mask). Bone entries match bone names; role entries
// match the bone a profile role maps to (the caller's `roleBone`). A bone takes its own entry's weight; otherwise the
// nearest ancestor entry that is `recursive` (a deeper entry overrides what a recursive ancestor gave, Unreal's
// per-branch blend masks); bones no entry reaches weigh 0. A pure library.
import type { MaskEntry } from "../../../../../engine/animation/mask";

/** @internal What the resolution needs of a skeleton: bone names and parents (-1 for a root; parents first). */
export interface MaskSkeleton {
  readonly names: readonly string[];
  readonly parents: ArrayLike<number>;
}

/**
 * @internal One weight per bone of `skeleton` for `entries`. `roleBone(role)` gives the bone a role maps to, or -1.
 * Entries naming no bone of the skeleton are skipped and listed in `missing`.
 */
export function resolveMaskWeights(entries: readonly MaskEntry[], skeleton: MaskSkeleton, roleBone: (role: string) => number): { weights: Float32Array; missing: string[] } {
  const n = skeleton.names.length;
  const own = new Array<MaskEntry | undefined>(n);
  const missing: string[] = [];
  const byName = new Map<string, number>();
  skeleton.names.forEach((name, i) => {
    if (!byName.has(name)) byName.set(name, i);
  });
  for (const e of entries) {
    const b = e.bone !== undefined ? (byName.get(e.bone) ?? -1) : roleBone(e.role);
    if (b < 0 || b >= n) missing.push(e.bone ?? `role ${e.role}`);
    else own[b] = e;
  }
  const weights = new Float32Array(n);
  // What a bone's children inherit: its own entry's weight when recursive, else what it inherited.
  const inherited = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    const p = skeleton.parents[b]!;
    const fromAbove = p >= 0 && p < b ? inherited[p]! : 0;
    const e = own[b];
    weights[b] = e ? e.weight : fromAbove;
    inherited[b] = e && e.recursive ? e.weight : fromAbove;
  }
  return { weights, missing };
}
