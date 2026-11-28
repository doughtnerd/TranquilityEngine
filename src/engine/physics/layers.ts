import { MAX_PHYSICS_LAYERS, type ProjectSettings } from "../core/settings";

/**
 * @internal The project's physics layers as collision groups (ADR 0005, 0464): the one place that maps a layer name
 * to its bit, builds each layer's filter from the collision matrix, and packs a query's groups. Groups are 32 bits,
 * membership in the high 16 and filter in the low 16 (Rapier's interaction groups; the backends take them as is).
 * Shared by 2D and 3D physics and the engine's ray query (audio occlusion).
 */
export interface LayerTable {
  /** The layer names, in order (a name can repeat: settings keep it and report it). */
  readonly names: readonly string[];
  /** The layer's bit index: the first layer with that name; -1 when the project has none. */
  indexOf(layer: string): number;
  /**
   * A collider's groups on `layer`. An unknown layer warns once (through the table's `warn`) and uses the first
   * layer's groups, so the collider still exists.
   */
  groupsOf(layer: string): number;
  /**
   * A query's groups: colliders on any of `layers`; undefined when there are none (every layer). An unknown layer
   * warns once and matches nothing, so a query naming only unknown layers hits no collider.
   */
  queryGroups(layers: readonly string[] | null | undefined): number | undefined;
}

/** What `layerTable` reads: the project's `physics.layers` and `physics.collisionMatrix`. */
export type LayerSettings = Pick<ProjectSettings["physics"], "layers" | "collisionMatrix">;

/** @internal The filter bits of packed groups (the layers a collider collides with, or a query hits). */
export function filterOf(groups: number): number {
  return groups & 0xffff;
}

/** Packs membership and filter bits into groups. */
function packGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/**
 * @internal The layer table of a project's physics settings. Throws on more than `MAX_PHYSICS_LAYERS` layers or a
 * collision matrix that names an unknown layer (the settings parse reports both). `warn(key, message)` gets unknown
 * layers, once per `key` if the caller dedupes (PhysicsCore's `warnOnce`); without it they are silent.
 */
export function layerTable(physics: LayerSettings, warn?: (key: string, message: string) => void): LayerTable {
  const { layers, collisionMatrix } = physics;
  if (layers.length > MAX_PHYSICS_LAYERS) throw new Error(`At most ${MAX_PHYSICS_LAYERS} physics layers are supported.`);
  const index = new Map<string, number>();
  layers.forEach((name, i) => {
    if (!index.has(name)) index.set(name, i); // a repeated name is the first layer of that name
  });
  const indexOf = (name: string): number => index.get(name) ?? -1;
  const filters = layers.map(() => (collisionMatrix ? 0 : 0xffff));
  if (collisionMatrix) {
    for (const [a, list] of Object.entries(collisionMatrix)) {
      const ia = indexOf(a);
      if (ia < 0) throw new Error(`collisionMatrix: unknown layer "${a}".`);
      for (const b of list) {
        const ib = indexOf(b);
        if (ib < 0) throw new Error(`collisionMatrix: unknown layer "${b}".`);
        filters[ia] |= 1 << ib;
        filters[ib] |= 1 << ia;
      }
    }
  }
  const groups = layers.map((_, i) => packGroups(1 << i, filters[i]));
  return {
    names: layers,
    indexOf,
    groupsOf(layer) {
      const i = indexOf(layer);
      if (i >= 0) return groups[i];
      warn?.(`layer:${layer}`, `unknown physics layer "${layer}"; using "${layers[0]}".`);
      return groups[0];
    },
    queryGroups(query) {
      if (!query?.length) return undefined;
      let bits = 0;
      for (const l of query) {
        const i = indexOf(l);
        if (i >= 0) bits |= 1 << i;
        else warn?.(`query-layer:${l}`, `unknown physics layer "${l}" in a query; it matches no collider.`);
      }
      return packGroups(0xffff, bits);
    },
  };
}
