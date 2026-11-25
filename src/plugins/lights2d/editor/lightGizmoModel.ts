// What the Lights 2D plugin's scene-view tool draws and how its handles edit (ADR 0399, 0413), in a light's or caster's
// local XY: a point light's two radius circles and cone edges with radius and angle handles, a freeform light's polygon
// and falloff outline with a handle per point (and one mid-edge to add a point), a sprite light's quad, a global
// light's sun mark, and a caster's outline (its custom path with point handles). Pure: `lights2dTool.ts` places the
// lines with the node's 2D frame and writes the patches through the component field write.

export type V2 = [number, number];

/** A light's fields the gizmo reads (as stored: vectors as `[x, y]`). */
export interface LightGizmoFields {
  type: "global" | "point" | "freeform" | "sprite";
  innerRadius: number;
  outerRadius: number;
  innerAngle: number;
  outerAngle: number;
  shape: V2[];
  falloffSize: number;
  /** A sprite light's quad in local units, when its sprite has loaded. */
  spriteBox?: [number, number, number, number] | null;
}

export interface GizmoLine {
  points: V2[];
  closed: boolean;
  /** Drawn dim (the inner circle, the falloff band). */
  dim?: boolean;
}

const SEGMENTS = 48;
const DEG = Math.PI / 180;

/** A direction `deg` degrees clockwise from +Y (the cone's axis). */
const dir = (deg: number): V2 => [Math.sin(deg * DEG), Math.cos(deg * DEG)];
const scale = (v: V2, s: number): V2 => [v[0] * s, v[1] * s];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function arc(r: number, from: number, to: number): V2[] {
  const n = Math.max(2, Math.ceil((SEGMENTS * Math.abs(to - from)) / 360));
  return Array.from({ length: n + 1 }, (_, i) => scale(dir(from + ((to - from) * i) / n), r));
}

/** The light's lines in its local XY. */
export function lightLines(f: LightGizmoFields): GizmoLine[] {
  if (f.type === "global") {
    const rays = [0, 45, 90, 135, 180, 225, 270, 315].map((a): GizmoLine => ({ points: [scale(dir(a), 0.3), scale(dir(a), 0.45)], closed: false }));
    return [{ points: arc(0.2, 0, 360).slice(0, -1), closed: true }, ...rays];
  }
  if (f.type === "point") {
    const outer = Math.max(f.outerRadius, 0), inner = clamp(f.innerRadius, 0, outer);
    const outerA = clamp(f.outerAngle, 0, 360), innerA = clamp(f.innerAngle, 0, outerA);
    if (outerA >= 360) {
      const out: GizmoLine[] = [{ points: arc(outer, 0, 360).slice(0, -1), closed: true }];
      if (inner > 0) out.push({ points: arc(inner, 0, 360).slice(0, -1), closed: true, dim: true });
      return out;
    }
    const h = outerA / 2, hi = innerA / 2;
    const out: GizmoLine[] = [{ points: [[0, 0], ...arc(outer, -h, h)], closed: true }];
    if (inner > 0) out.push({ points: arc(inner, -h, h), closed: false, dim: true });
    if (hi < h) {
      out.push({ points: [[0, 0], scale(dir(-hi), outer)], closed: false, dim: true });
      out.push({ points: [[0, 0], scale(dir(hi), outer)], closed: false, dim: true });
    }
    return out;
  }
  if (f.type === "freeform") {
    if (f.shape.length < 2) return [];
    const out: GizmoLine[] = [{ points: f.shape.map((p): V2 => [p[0], p[1]]), closed: true }];
    if (f.falloffSize > 0 && f.shape.length >= 3) out.push({ points: grown(f.shape, f.falloffSize), closed: true, dim: true });
    return out;
  }
  const b = f.spriteBox ?? [-0.5, -0.5, 0.5, 0.5];
  return [{ points: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], closed: true }];
}

/** The light's handles in its local XY, by id. */
export function lightHandles(f: LightGizmoFields): Record<string, V2> {
  if (f.type === "point") {
    const outer = Math.max(f.outerRadius, 0), inner = clamp(f.innerRadius, 0, outer);
    const outerA = clamp(f.outerAngle, 0, 360), innerA = clamp(f.innerAngle, 0, outerA);
    return {
      outerRadius: [0, outer],
      innerRadius: [inner, 0],
      outerAngle: scale(dir(outerA / 2), outer * 0.85),
      innerAngle: scale(dir(innerA / 2), outer * 0.6),
    };
  }
  if (f.type === "freeform") return pointHandles(f.shape, true);
  return {};
}

/** The field patch a handle drag to local point `p` makes, or null for a handle it doesn't know. */
export function dragLight(f: LightGizmoFields, handle: string, p: V2): Record<string, unknown> | null {
  const d = Math.hypot(p[0], p[1]);
  // The angle from +Y, either side, as a full cone angle (0–360); within 5° of all round snaps to 360.
  const cone = () => {
    const full = (Math.acos(clamp(d > 1e-9 ? p[1] / d : 1, -1, 1)) / DEG) * 2;
    return full > 355 ? 360 : Math.round(full * 10) / 10;
  };
  switch (handle) {
    case "outerRadius":
      return { outerRadius: Math.max(d, f.innerRadius, 0.01) };
    case "innerRadius":
      return { innerRadius: Math.min(d, f.outerRadius) };
    case "outerAngle": {
      // Narrowing the cone past the inner one narrows the inner one with it.
      const a = cone();
      return a < f.innerAngle ? { outerAngle: a, innerAngle: a } : { outerAngle: a };
    }
    case "innerAngle":
      return { innerAngle: Math.min(cone(), f.outerAngle) };
  }
  const i = pointIndex(handle);
  if (f.type === "freeform" && i !== null && f.shape[i]) return { shape: f.shape.map((q, k): V2 => (k === i ? [p[0], p[1]] : [q[0], q[1]])) };
  return null;
}

/** Handles for an editable outline: `p:i` at each point, and `insert:i` mid-way along the edge after it (closed: back to the first). */
export function pointHandles(points: readonly V2[], closed: boolean): Record<string, V2> {
  const out: Record<string, V2> = {};
  points.forEach((p, i) => (out[`p:${i}`] = [p[0], p[1]]));
  const edges = closed ? points.length : points.length - 1;
  for (let i = 0; i < edges && points.length >= 2; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    out[`insert:${i}`] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return out;
}

const pointIndex = (handle: string): number | null => {
  const m = /^p:(\d+)$/.exec(handle);
  return m ? Number(m[1]) : null;
};

/**
 * What a press on an outline's handle does: drag a point (`index`), insert one mid-edge and drag it (`points` holds the
 * new outline), remove one with Ctrl (never below `min` points), or nothing for an unknown handle.
 */
export function pressPoints(points: readonly V2[], handle: string, ctrl: boolean, min = 3): { drag: number; points: V2[] } | { removed: V2[] } | { refused: string } | null {
  const copy = points.map((p): V2 => [p[0], p[1]]);
  const i = pointIndex(handle);
  if (i !== null && copy[i]) {
    if (!ctrl) return { drag: i, points: copy };
    if (copy.length <= min) return { refused: `An outline needs at least ${min} points.` };
    return { removed: copy.filter((_, k) => k !== i) };
  }
  const m = /^insert:(\d+)$/.exec(handle);
  if (m) {
    const at = Number(m[1]);
    const a = copy[at], b = copy[(at + 1) % copy.length];
    if (!a || !b) return null;
    copy.splice(at + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    return { drag: at + 1, points: copy };
  }
  return null;
}

/** The polygon grown by `by` at each corner along its mitre (as the freeform light's falloff band, capped at 4×). */
function grown(shape: readonly V2[], by: number): V2[] {
  let area = 0;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) area += shape[j]![0] * shape[i]![1] - shape[i]![0] * shape[j]![1];
  const ccw = area >= 0 ? shape : [...shape].reverse();
  const out = ccw.map((c, i): V2 => {
    const p = ccw[(i + ccw.length - 1) % ccw.length]!, q = ccw[(i + 1) % ccw.length]!;
    const n1 = outward(p, c), n2 = outward(c, q);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const l = Math.hypot(mx, my) || 1;
    mx /= l;
    my /= l;
    const cos = mx * n1[0] + my * n1[1];
    const s = Math.min(cos > 1e-3 ? 1 / cos : 4, 4) * by;
    return [c[0] + mx * s, c[1] + my * s];
  });
  return area >= 0 ? out : out.reverse();
}

function outward(a: V2, b: V2): V2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l];
}
