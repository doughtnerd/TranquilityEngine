// Rig-stack entries (ADR 0373 "rig-stack entries as a list with gizmos in the viewport (IK targets, pole vectors,
// spring-bone colliders, look-at limits)"): the graph's `rig` family nodes as a list, and what each draws in the scene
// view over the selected character's skeleton — limb chains with their IK target and pole markers, spring chains with
// their colliders (spheres and capsules in their bones' space), look-at and aim joints with their limit cones, position
// limits as boxes or spheres, grounder rays. Pure: the bones' world matrices come from the caller (`rigGizmo.ts` reads
// them from the open scene).
import type { AnimGraph, GraphNode } from "../../../../engine/animation/animGraph";
import { kindLabel, nodeTitle } from "./graphEditLogic";

/** A world matrix, column-major 4×4. */
export type Mat4 = ArrayLike<number>;
type V3 = [number, number, number];

/** A polyline the scene view draws. */
export interface GizmoLine {
  readonly points: V3[];
  readonly closed: boolean;
  readonly color: number;
}

/** One rig entry of the list. */
export interface RigEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  /** What it acts on, in short ("LeftUpperArm → LeftHand", "3 bones, 2 colliders"). */
  readonly summary: string;
  /** Its weight (a number, or the float parameter driving it). */
  readonly weight: number | string;
}

const COLORS = { chain: 0x3e63dd, target: 0xe5484d, pole: 0xf5a524, collider: 0x46a758, limit: 0xa855f7, ray: 0x14b8a6 } as const;

const list = (n: GraphNode, name: string): unknown[] => (Array.isArray(n.params[name]) ? (n.params[name] as unknown[]) : []);
const str = (n: GraphNode, name: string): string | null => (typeof n.params[name] === "string" ? (n.params[name] as string) : null);
const num = (n: GraphNode, name: string, d: number): number => (typeof n.params[name] === "number" ? (n.params[name] as number) : d);

/** The bones a rig node names, in chain order. */
export function rigBones(n: GraphNode): string[] {
  switch (n.kind) {
    case "twoBoneIk": return ["root", "mid", "tip"].map((k) => str(n, k)).filter((x): x is string => !!x);
    case "copy": return ["source", "target"].map((k) => str(n, k)).filter((x): x is string => !!x);
    case "limitPosition": case "damp": return [str(n, "bone")].filter((x): x is string => !!x);
    case "grounder": return list(n, "legs").filter((x): x is string => typeof x === "string");
    default: return list(n, "bones").filter((x): x is string => typeof x === "string");
  }
}

/** The graph's rig entries, in the graph's order. */
export function rigEntries(graph: AnimGraph): RigEntry[] {
  return graph.nodes.filter((n) => n.family === "rig").map((n) => {
    const bones = rigBones(n);
    const colliders = list(n, "colliderBones").length;
    const parts = [bones.length > 3 ? `${bones.length} bones` : bones.join(" → ") || (str(n, "chain") ?? "no bones yet")];
    if (colliders) parts.push(`${colliders} collider${colliders === 1 ? "" : "s"}`);
    const w = n.params.weight;
    return { id: n.id, title: nodeTitle(n), kind: kindLabel(n.kind), summary: parts.join(", "), weight: typeof w === "number" || typeof w === "string" ? w : 1 };
  });
}

const origin = (m: Mat4): V3 => [m[12]!, m[13]!, m[14]!];
/** A point in a bone's space to world. */
const apply = (m: Mat4, p: readonly number[]): V3 => [0, 1, 2].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!) as V3;
const axis = (m: Mat4, a: number): V3 => {
  const v: V3 = [m[a * 4]!, m[a * 4 + 1]!, m[a * 4 + 2]!];
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** A circle of `r` around `c` in the plane of unit vectors `u`, `v`. */
function circle(c: V3, u: V3, v: V3, r: number, color: number, n = 16): GizmoLine {
  const points: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push(add(add(c, u, Math.cos(a) * r), v, Math.sin(a) * r));
  }
  return { points, closed: true, color };
}
/** Three great circles: a wire sphere. */
const sphere = (c: V3, r: number, color: number): GizmoLine[] => [circle(c, [1, 0, 0], [0, 1, 0], r, color), circle(c, [0, 1, 0], [0, 0, 1], r, color), circle(c, [1, 0, 0], [0, 0, 1], r, color)];
/** A cross marker of half-size `s`. */
const cross = (c: V3, s: number, color: number): GizmoLine[] => [0, 1, 2].map((a) => {
  const d: V3 = [0, 0, 0];
  d[a] = s;
  return { points: [add(c, d, -1), add(c, d)], closed: false, color };
});

/**
 * What rig node `n` draws, with `bone(name)` giving a bone's world matrix (null: not in the skeleton) and `size` the rig's
 * size (its rest radius) for marker sizes. Bones it can't find are skipped.
 */
export function rigGizmoLines(n: GraphNode, bone: (name: string) => Mat4 | null, size: number): GizmoLine[] {
  const s = Math.max(0.02, size * 0.04);
  const out: GizmoLine[] = [];
  const mats = rigBones(n).map(bone);
  const chain = mats.filter((m): m is Mat4 => !!m).map(origin);
  if (chain.length > 1 && n.kind !== "grounder") out.push({ points: chain, closed: false, color: COLORS.chain });
  const last = chain.at(-1);
  switch (n.kind) {
    case "twoBoneIk": case "ccd": case "fabrik": {
      if (last) out.push(...cross(last, s, COLORS.target)); // the IK target goes where the tip is posed
      if (n.kind === "twoBoneIk" && chain.length === 3) {
        // The pole: out from the mid joint, away from the root–tip line.
        const [a, b, c] = chain as [V3, V3, V3];
        const mid: V3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
        let d: V3 = [b[0] - mid[0], b[1] - mid[1], b[2] - mid[2]];
        const l = Math.hypot(...d);
        d = l > 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 1];
        const pole = add(b, d, s * 6);
        out.push({ points: [b, pole], closed: false, color: COLORS.pole }, ...cross(pole, s, COLORS.pole));
      }
      break;
    }
    case "lookAt": case "aim": {
      // Each joint's limit as a cone about its forward (+Z) axis.
      const limits = list(n, "limits");
      mats.forEach((m, j) => {
        if (!m) return;
        const lim = typeof limits[j] === "number" ? (limits[j] as number) : 0;
        if (lim <= 0) return;
        const o = origin(m), f = axis(m, 2), u = axis(m, 1), v = axis(m, 0);
        const len = s * 8;
        const c = add(o, f, len * Math.cos(lim));
        const r = len * Math.sin(lim);
        out.push(circle(c, u, v, r, COLORS.limit), ...[0, 1, 2, 3].map((k) => ({ points: [o, add(add(c, u, Math.cos((k * Math.PI) / 2) * r), v, Math.sin((k * Math.PI) / 2) * r)], closed: false, color: COLORS.limit })));
      });
      break;
    }
    case "springChain": {
      const cb = list(n, "colliderBones"), shapes = list(n, "colliderShapes"), a = list(n, "colliderA"), b = list(n, "colliderB"), r = list(n, "colliderRadius");
      cb.forEach((name, c) => {
        const m = typeof name === "string" ? bone(name) : null;
        if (!m) return;
        const at = (l: unknown[]) => [0, 1, 2].map((k) => (typeof l[3 * c + k] === "number" ? (l[3 * c + k] as number) : 0));
        const radius = typeof r[c] === "number" ? (r[c] as number) : 0;
        const pa = apply(m, at(a));
        out.push(...sphere(pa, Math.max(radius, s * 0.5), COLORS.collider));
        if (shapes[c] === "capsule") {
          const pb = apply(m, at(b));
          out.push(...sphere(pb, Math.max(radius, s * 0.5), COLORS.collider), { points: [pa, pb], closed: false, color: COLORS.collider });
        }
      });
      break;
    }
    case "limitPosition": {
      const m = mats[0];
      if (!m) break;
      const lo = list(n, "a").map(Number), hi = list(n, "b").map(Number);
      const radius = num(n, "radius", 0);
      const centre = origin(m);
      const A: V3 = [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0];
      if (radius > 0) out.push(...sphere(add(centre, A), radius, COLORS.limit));
      else {
        const B: V3 = [hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0];
        const c = (x: number, y: number, z: number): V3 => add(centre, [x ? B[0] : A[0], y ? B[1] : A[1], z ? B[2] : A[2]]);
        out.push({ points: [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)], closed: true, color: COLORS.limit }, { points: [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)], closed: true, color: COLORS.limit });
      }
      break;
    }
    case "grounder": {
      const up = num(n, "rayHeight", 0.5), down = num(n, "rayDepth", 0.5);
      // Per leg (thigh, shin, foot): the leg, and the foot's ray.
      for (let k = 0; k + 2 < mats.length; k += 3) {
        const leg = mats.slice(k, k + 3).filter((m): m is Mat4 => !!m).map(origin);
        if (leg.length > 1) out.push({ points: leg, closed: false, color: COLORS.chain });
        const foot = mats[k + 2];
        if (!foot) continue;
        const o = origin(foot);
        out.push({ points: [add(o, [0, 1, 0], up), add(o, [0, 1, 0], -down)], closed: false, color: COLORS.ray });
      }
      break;
    }
  }
  return out;
}
