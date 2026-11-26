/**
 * 2D tangents for lit meshes that deform (ADR 0399): where a mesh's texture +U points, per vertex, in the mesh's XY.
 * A lit draw turns its normal map's XY by it (the quad-batch host works them out for `QuadBatch.setTriangles`), so a skinned sprite's normals follow its bones
 * and a 2D ribbon's follow the line. Each triangle's dP/du (from its positions and UVs) is added to its vertices, then
 * normalised; a vertex no triangle gives a direction keeps +X.
 */

/** Tangents (x, y per vertex) for `positions` (xyz per vertex), `uvs` (uv per vertex) and triangle `indices`. */
export function tangents2D(positions: ArrayLike<number>, uvs: ArrayLike<number>, indices: ArrayLike<number>, out?: Float32Array): Float32Array {
  const n = Math.floor(positions.length / 3);
  const t = out && out.length === n * 2 ? out.fill(0) : new Float32Array(n * 2);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    const x1 = positions[b * 3]! - positions[a * 3]!, y1 = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
    const x2 = positions[c * 3]! - positions[a * 3]!, y2 = positions[c * 3 + 1]! - positions[a * 3 + 1]!;
    const u1 = uvs[b * 2]! - uvs[a * 2]!, v1 = uvs[b * 2 + 1]! - uvs[a * 2 + 1]!;
    const u2 = uvs[c * 2]! - uvs[a * 2]!, v2 = uvs[c * 2 + 1]! - uvs[a * 2 + 1]!;
    const det = u1 * v2 - u2 * v1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    const tx = (x1 * v2 - x2 * v1) * r, ty = (y1 * v2 - y2 * v1) * r;
    for (const v of [a, b, c]) {
      t[v * 2] += tx;
      t[v * 2 + 1] += ty;
    }
  }
  for (let v = 0; v < n; v++) {
    const x = t[v * 2]!, y = t[v * 2 + 1]!;
    const l = Math.hypot(x, y);
    if (l < 1e-12) {
      t[v * 2] = 1;
      t[v * 2 + 1] = 0;
    } else {
      t[v * 2] = x / l;
      t[v * 2 + 1] = y / l;
    }
  }
  return t;
}
