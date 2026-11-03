import type { ProjectSettings } from "../core/settings";

/**
 * @internal Physics layer name → Rapier interaction groups (membership in the high 16 bits, filter
 * in the low 16), from the project's layers and collision matrix (ADR 0005). Shared by 2D and 3D.
 */
export function layerGroups(physics: ProjectSettings["physics"]): Map<string, number> {
  const { layers, collisionMatrix } = physics;
  if (layers.length > 16) throw new Error("At most 16 physics layers are supported.");
  const filters = layers.map(() => (collisionMatrix ? 0 : 0xffff));
  if (collisionMatrix) {
    for (const [a, list] of Object.entries(collisionMatrix)) {
      const ia = layers.indexOf(a);
      if (ia < 0) throw new Error(`collisionMatrix: unknown layer "${a}".`);
      for (const b of list) {
        const ib = layers.indexOf(b);
        if (ib < 0) throw new Error(`collisionMatrix: unknown layer "${b}".`);
        filters[ia] |= 1 << ib;
        filters[ib] |= 1 << ia;
      }
    }
  }
  return new Map(layers.map((name, i) => [name, ((1 << i) << 16) | filters[i]]));
}

