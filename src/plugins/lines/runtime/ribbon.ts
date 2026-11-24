/**
 * Ribbon geometry (ADR 0396), renderer-neutral and pure: a strip along points, with a half width and a colour per
 * point, mitred or rounded joins, square or rounded ends, and UVs by texture mode.
 *
 * The strip is a run of rings, two vertices each (one per side), joined to the next ring by two triangles. A point
 * gives one ring (a mitred join, or an end), or several at the same centre with turning directions (a rounded join);
 * a rounded end adds rings beyond the end point, narrowing to its tip. Each vertex is its ring's centre, its direction
 * (the tangent), its side (−1..1, the multiple of the half width across), and its along-offset (the multiple of the
 * half width along the tangent, for the cap rings).
 *
 * Two outputs:
 * - camera-facing (no `normal`): positions are the centres, with the tangents, sides, half widths and along-offsets as
 *   ribbon data, which the backend turns to each camera in the vertex shader (`DynamicGeometry.ribbon`);
 * - flat (`normal` given: a 3D ribbon facing its node's +Z, or a 2D one in the XY plane): final positions,
 *   `centre + across × halfWidth × side + tangent × halfWidth × along` with `across = normal × tangent`, and the normal
 *   per vertex.
 */
import type { RibbonData } from "../../../engine/render/dynamicMeshes";
import type { RibbonTextureMode } from "./RibbonRenderer";

/** What a ribbon is built from. */
export interface RibbonInput {
  /** xyz per point, in order. */
  readonly points: ArrayLike<number>;
  /** Joins the last point back to the first. */
  readonly closed?: boolean;
  /** The half width at each point. */
  readonly halfWidths: ArrayLike<number>;
  /** RGBA (0..1 sRGB and alpha) at each point, or null for white. */
  readonly colors: ArrayLike<number> | null;
  /** Extra rings rounding each join (0: mitred). */
  readonly cornerVertices?: number;
  /** Extra rings rounding each end (0: square). */
  readonly capVertices?: number;
  readonly textureMode?: RibbonTextureMode;
  /** x: repeats along (per world unit in `tile`); y: across. */
  readonly textureScale?: readonly [number, number];
  /** A flat ribbon's face normal; absent for a camera-facing ribbon. */
  readonly normal?: readonly [number, number, number] | null;
}

/** A built ribbon (see the file comment). */
export interface RibbonMesh {
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array | null;
  /** Shared between ribbons with the same ring count (so a backend can update buffers in place). */
  readonly indices: Uint32Array;
  /** A flat ribbon's normals; null for a camera-facing one. */
  readonly normals: Float32Array | null;
  /** A camera-facing ribbon's data; null for a flat one. */
  readonly ribbon: RibbonData | null;
  readonly vertexCount: number;
}

/** How far a mitred join may reach, in half widths, before it is cut back. */
const MITER_LIMIT = 4;
/** Joins and caps are capped at this many extra rings each. */
const MAX_ROUND = 16;

interface Ring {
  /** The point it belongs to (its centre, width and colour). */
  p: number;
  tx: number;
  ty: number;
  tz: number;
  side: number;
  along: number;
  /** The texture's u. */
  u: number;
}

const indexCache = new Map<number, Uint32Array>();

/** The strip's indices for `rings` rings: two triangles between each ring and the next. Cached by ring count. */
function stripIndices(rings: number): Uint32Array {
  let idx = indexCache.get(rings);
  if (idx) return idx;
  idx = new Uint32Array(Math.max(0, rings - 1) * 6);
  for (let r = 0; r < rings - 1; r++) {
    const a = r * 2;
    idx.set([a, a + 1, a + 3, a, a + 3, a + 2], r * 6);
  }
  if (indexCache.size > 512) indexCache.clear();
  indexCache.set(rings, idx);
  return idx;
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return l > 1e-12 ? [x / l, y / l, z / l] : [0, 0, 0];
}

/** `a` turned towards `b` by `t` (0..1), unit length (spherical, so a sharp turn rounds evenly). */
function turn(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  const dot = Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
  const angle = Math.acos(dot);
  if (angle < 1e-5) return [a[0]!, a[1]!, a[2]!];
  const s = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / s, wb = Math.sin(t * angle) / s;
  return normalize(a[0]! * wa + b[0]! * wb, a[1]! * wa + b[1]! * wb, a[2]! * wa + b[2]! * wb);
}

/** Build a ribbon, or null with fewer than two distinct points. */
export function buildRibbon(input: RibbonInput): RibbonMesh | null {
  // Distinct points only (a zero-length segment has no direction), keeping each kept point's width and colour.
  const src = input.points;
  const keep: number[] = [];
  for (let i = 0; i * 3 + 2 < src.length; i++) {
    const last = keep[keep.length - 1];
    if (last !== undefined && Math.hypot(src[i * 3]! - src[last * 3]!, src[i * 3 + 1]! - src[last * 3 + 1]!, src[i * 3 + 2]! - src[last * 3 + 2]!) < 1e-6) continue;
    keep.push(i);
  }
  let closed = !!input.closed;
  if (closed && keep.length > 2) {
    const a = keep[0]!, b = keep[keep.length - 1]!;
    if (Math.hypot(src[a * 3]! - src[b * 3]!, src[a * 3 + 1]! - src[b * 3 + 1]!, src[a * 3 + 2]! - src[b * 3 + 2]!) < 1e-6) keep.pop();
  }
  const n = keep.length;
  if (n < 2) return null;
  if (n < 3) closed = false;
  const px = (k: number, c: number): number => src[keep[k]! * 3 + c]!;

  // Segment directions and distances along the line.
  const segments = closed ? n : n - 1;
  const dirs: [number, number, number][] = [];
  const dist = new Float64Array(n + 1);
  for (let s = 0; s < segments; s++) {
    const a = s, b = (s + 1) % n;
    const dx = px(b, 0) - px(a, 0), dy = px(b, 1) - px(a, 1), dz = px(b, 2) - px(a, 2);
    dirs.push(normalize(dx, dy, dz));
    dist[s + 1] = dist[s]! + Math.hypot(dx, dy, dz);
  }
  const total = dist[segments]!;

  const mode = input.textureMode ?? "stretch";
  const [scaleU, scaleV] = input.textureScale ?? [1, 1];
  const texU = (k: number): number => {
    switch (mode) {
      case "tile":
        return dist[k]! * scaleU;
      case "distributePerSegment":
        return (k / segments) * scaleU;
      case "repeatPerSegment":
        return k * scaleU;
      default:
        return total > 0 ? (dist[k]! / total) * scaleU : 0;
    }
  };

  const corners = Math.max(0, Math.min(MAX_ROUND, Math.floor(input.cornerVertices ?? 0)));
  const caps = closed ? 0 : Math.max(0, Math.min(MAX_ROUND, Math.floor(input.capVertices ?? 0)));
  const rings: Ring[] = [];
  const ring = (p: number, t: readonly number[], side: number, along: number, u: number): void => {
    rings.push({ p, tx: t[0]!, ty: t[1]!, tz: t[2]!, side, along, u });
  };

  // `k` runs over the points in order; a closed line visits point 0 again at the end (k = n), so its texture wraps.
  const last = closed ? n : n - 1;
  for (let k = 0; k <= last; k++) {
    const p = k % n;
    const u = texU(k);
    if (!closed && k === 0) {
      const t = dirs[0]!;
      for (let j = 0; j < caps; j++) {
        const a = (j / caps) * (Math.PI / 2);
        ring(p, t, Math.sin(a), -Math.cos(a), u);
      }
      ring(p, t, 1, 0, u);
      continue;
    }
    if (!closed && k === last) {
      const t = dirs[segments - 1]!;
      ring(p, t, 1, 0, u);
      for (let j = caps - 1; j >= 0; j--) {
        const a = (j / caps) * (Math.PI / 2);
        ring(p, t, Math.sin(a), Math.cos(a), u);
      }
      continue;
    }
    const tin = dirs[(k - 1 + segments) % segments]!, tout = dirs[k % segments]!;
    if (corners > 0) {
      ring(p, tin, 1, 0, u);
      for (let j = 1; j <= corners; j++) ring(p, turn(tin, tout, j / (corners + 1)), 1, 0, u);
      ring(p, tout, 1, 0, u);
      continue;
    }
    // Mitred: across the bisector, widened so the edges meet (cut back past the limit).
    let t = normalize(tin[0] + tout[0], tin[1] + tout[1], tin[2] + tout[2]);
    if (t[0] === 0 && t[1] === 0 && t[2] === 0) t = tout; // it turns straight back
    const cos = t[0] * tin[0] + t[1] * tin[1] + t[2] * tin[2];
    ring(p, t, Math.min(MITER_LIMIT, 1 / Math.max(cos, 1 / MITER_LIMIT)), 0, u);
  }

  const count = rings.length * 2;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = input.colors ? new Float32Array(count * 4) : null;
  const flat = input.normal ?? null;
  const normals = flat ? new Float32Array(count * 3) : null;
  const tangents = flat ? null : new Float32Array(count * 4);
  const extents = flat ? null : new Float32Array(count * 2);
  for (let r = 0; r < rings.length; r++) {
    const g = rings[r]!;
    const cx = px(g.p, 0), cy = px(g.p, 1), cz = px(g.p, 2);
    const hw = input.halfWidths[keep[g.p]!] ?? 0;
    for (let s = 0; s < 2; s++) {
      const v = r * 2 + s;
      const side = s === 0 ? -g.side : g.side;
      uvs[v * 2] = g.u;
      uvs[v * 2 + 1] = s === 0 ? 0 : scaleV;
      if (colors) for (let c = 0; c < 4; c++) colors[v * 4 + c] = input.colors![keep[g.p]! * 4 + c] ?? 1;
      if (flat) {
        // across = normal × tangent
        const [ax, ay, az] = normalize(flat[1] * g.tz - flat[2] * g.ty, flat[2] * g.tx - flat[0] * g.tz, flat[0] * g.ty - flat[1] * g.tx);
        positions[v * 3] = cx + (ax * side + g.tx * g.along) * hw;
        positions[v * 3 + 1] = cy + (ay * side + g.ty * g.along) * hw;
        positions[v * 3 + 2] = cz + (az * side + g.tz * g.along) * hw;
        normals![v * 3] = flat[0];
        normals![v * 3 + 1] = flat[1];
        normals![v * 3 + 2] = flat[2];
      } else {
        positions[v * 3] = cx;
        positions[v * 3 + 1] = cy;
        positions[v * 3 + 2] = cz;
        tangents!.set([g.tx, g.ty, g.tz, side], v * 4);
        extents![v * 2] = hw;
        extents![v * 2 + 1] = g.along;
      }
    }
  }
  return { positions, uvs, colors, indices: stripIndices(rings.length), normals, ribbon: tangents && extents ? { tangents, extents } : null, vertexCount: count };
}
