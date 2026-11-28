/**
 * Edge neighbours of a triangle list (ADR 0460 §3): for each triangle, the triangle across each of its edges a→b, b→c
 * and c→a, or `NO_NEIGHBOR` at a boundary (and where more than two triangles share the edge). The occlusion core shrinks
 * coverage only at silhouette edges, which it finds from these. Positions are compared by index, so a mesh must be
 * welded (LOD output and built-in meshes are). Pure; the TypeScript twin of `vis-trim`'s table, for meshes that occlude
 * with themselves at runtime (at most 512 triangles), which have no table from import.
 */

/** A boundary edge. */
export const NO_NEIGHBOR = 0xffffffff;

/** The neighbour table of `indices` (three per triangle): three entries per triangle. */
export function edgeNeighbors(indices: ArrayLike<number>): Uint32Array {
  const n = Math.floor(indices.length / 3);
  const out = new Uint32Array(n * 3).fill(NO_NEIGHBOR);
  // Undirected edge → the triangle edges on it (t * 3 + e).
  const edges = new Map<string, number[]>();
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edges.get(key);
      if (list) list.push(t * 3 + e);
      else edges.set(key, [t * 3 + e]);
    }
  }
  // Only an edge exactly two triangles share joins them; more is non-manifold, which stays a boundary (it shrinks).
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [p, q] = list;
    const tp = Math.floor(p / 3), tq = Math.floor(q / 3);
    if (tp === tq) continue;
    out[p] = tq;
    out[q] = tp;
  }
  return out;
}
