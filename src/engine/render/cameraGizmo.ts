/**
 * Editor camera gizmo geometry (ADR 0022). Internal: the wireframe of what a scene camera sees,
 * in the camera's local space (looking along +Z), as line-segment vertex pairs. Kept free of the
 * renderer so it can be tested headless.
 */

/** @internal */
export interface FrustumShape {
  projection: "orthographic" | "perspective";
  /** Half the view height in world units (orthographic). */
  orthographicSize: number;
  /** Vertical field of view in degrees (perspective). */
  fieldOfView: number;
  /** Width / height of the game's view. */
  aspect: number;
  near: number;
  far: number;
}

/**
 * How deep the wireframe is drawn. Cameras often have far = 1000; drawing all of it would put
 * the far end out of sight, so it stops at `maxDepth` beyond the near plane.
 */
export const GIZMO_MAX_DEPTH = 30;

/** @internal The 8 corners: near plane then far plane, each [bottom-left, bottom-right, top-right, top-left]. */
export function frustumCorners(shape: FrustumShape, maxDepth = GIZMO_MAX_DEPTH): [number, number, number][] {
  const near = Math.max(shape.near, 0);
  const far = Math.max(near, Math.min(shape.far, near + maxDepth));
  const halfAt = (d: number): [number, number] => {
    const h = shape.projection === "orthographic" ? shape.orthographicSize : d * Math.tan((shape.fieldOfView * Math.PI) / 360);
    return [h * shape.aspect, h];
  };
  const rect = (d: number): [number, number, number][] => {
    const [w, h] = halfAt(d);
    return [[-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d]];
  };
  return [...rect(near), ...rect(far)];
}

/** @internal Line segments (pairs of corners) for the near rectangle, far rectangle and the 4 edges joining them: 24 points. */
export function frustumSegments(shape: FrustumShape, maxDepth = GIZMO_MAX_DEPTH): Float32Array {
  const c = frustumCorners(shape, maxDepth);
  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 0], // near
    [4, 5], [5, 6], [6, 7], [7, 4], // far
    [0, 4], [1, 5], [2, 6], [3, 7], // edges
  ];
  const out = new Float32Array(pairs.length * 6);
  pairs.forEach(([a, b], i) => out.set([...c[a], ...c[b]], i * 6));
  return out;
}
