/**
 * 2D shadow geometry (ADR 0413), renderer-neutral. A caster's outline becomes one static edge mesh: a quad per outline
 * edge whose two far vertices carry `extrude` 1, which the shadow shader pushes away from the light's position past
 * its reach. One mesh serves every light (the light is a uniform), so a moving light costs no CPU work. The caster's
 * filled outline (its loops triangulated) clears its own interior back to lit when `selfShadows` is off.
 *
 * `shadowFactor` is the same rule on the CPU (for `Light2D.sampleAt`): a point is shadowed by a caster when the segment
 * from the light to it crosses one of the caster's edges, unless the point is inside the caster and self shadows are off.
 */
import { triangulate, type Point2 } from "../../physics/polygon";
import { insidePolygon } from "./lightShapes";

/** The edge mesh: per vertex `positions` xy (the node's local XY) and `extrude` (0 near, 1 pushed away from the light); triangle `indices`. */
export interface ShadowEdgeMesh {
  positions: Float32Array;
  extrude: Float32Array;
  indices: Uint32Array;
  edges: number;
}

/** A caster's edges, from its closed `loops` and open `chains`, as segments `[ax, ay, bx, by]` in local XY. */
export function outlineSegments(loops: readonly (readonly Point2[])[], chains: readonly (readonly Point2[])[]): Float32Array {
  const out: number[] = [];
  for (const loop of loops) {
    if (loop.length < 2) continue;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      if (a[0] !== b[0] || a[1] !== b[1]) out.push(a[0], a[1], b[0], b[1]);
    }
  }
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1]!, b = chain[i]!;
      if (a[0] !== b[0] || a[1] !== b[1]) out.push(a[0], a[1], b[0], b[1]);
    }
  }
  return Float32Array.from(out);
}

/** The edge mesh for `segments` (`outlineSegments`): 4 vertices and 2 triangles per edge (a, b near; b, a far). */
export function shadowEdgeMesh(segments: Float32Array): ShadowEdgeMesh {
  const edges = segments.length / 4;
  const positions = new Float32Array(edges * 8);
  const extrude = new Float32Array(edges * 4);
  const indices = new Uint32Array(edges * 6);
  for (let e = 0; e < edges; e++) {
    const ax = segments[e * 4]!, ay = segments[e * 4 + 1]!, bx = segments[e * 4 + 2]!, by = segments[e * 4 + 3]!;
    positions.set([ax, ay, bx, by, bx, by, ax, ay], e * 8);
    extrude.set([0, 0, 1, 1], e * 4);
    const v = e * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], e * 6);
  }
  return { positions, extrude, indices, edges };
}

/** The caster's filled loops (for clearing its interior when `selfShadows` is off): xy `positions` and triangle `indices`, or null for none. */
export function casterFillMesh(loops: readonly (readonly Point2[])[]): { positions: Float32Array; indices: Uint32Array } | null {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const ccw = area(loop) >= 0 ? loop : [...loop].reverse();
    const tris = triangulate(ccw);
    if (!tris) continue;
    const base = positions.length / 2;
    for (const [x, y] of ccw) positions.push(x, y);
    for (const [a, b, c] of tris) indices.push(base + a, base + b, base + c);
  }
  return indices.length ? { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) } : null;
}

/** A caster on the CPU: its edges and loops in world XY, and whether it shadows its own interior. */
export interface WorldCaster {
  segments: Float32Array;
  loops: readonly (readonly Point2[])[];
  selfShadows: boolean;
  /** Its shadow layers (ADR 0415; empty: every light). */
  mask?: readonly string[];
}

/** 1 when nothing blocks the light at (lx, ly) from reaching (px, py), else 0 (hard shadows; the CPU sample ignores softness). */
export function shadowFactor(lx: number, ly: number, px: number, py: number, casters: readonly WorldCaster[]): number {
  for (const c of casters) {
    if (!c.selfShadows && c.loops.some((l) => insidePolygon(l, px, py))) continue;
    const s = c.segments;
    for (let i = 0; i < s.length; i += 4) if (segmentsCross(lx, ly, px, py, s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!)) return 0;
  }
  return 1;
}

/** Whether segment p1–p2 properly crosses segment q1–q2 (touching at an end doesn't count). */
function segmentsCross(p1x: number, p1y: number, p2x: number, p2y: number, q1x: number, q1y: number, q2x: number, q2y: number): boolean {
  const d1 = orient(q1x, q1y, q2x, q2y, p1x, p1y), d2 = orient(q1x, q1y, q2x, q2y, p2x, p2y);
  const d3 = orient(p1x, p1y, p2x, p2y, q1x, q1y), d4 = orient(p1x, p1y, p2x, p2y, q2x, q2y);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function area(p: readonly Point2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
  return a;
}

/**
 * Edges of a composite's loops (ADR 0415) as segments, without the edges inside another member's loop (`owner[i]` is
 * loop i's member): the merged outline casts, so shadows don't start inside the composite. An edge counts as inside when
 * its midpoint is (an edge crossing another member's outline is kept whole).
 */
export function unionSegments(loops: readonly (readonly Point2[])[], owner: readonly number[]): Float32Array {
  const out: number[] = [];
  loops.forEach((loop, li) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (loops.some((other, oi) => owner[oi] !== owner[li] && insidePolygon(other, mx, my))) continue;
      out.push(a[0], a[1], b[0], b[1]);
    }
  });
  return Float32Array.from(out);
}
