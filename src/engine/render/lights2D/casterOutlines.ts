/**
 * Where a ShadowCaster2D's outline comes from (ADR 0413), renderer-neutral: the node's 2D collision shapes (a shape
 * source such as a Tilemap, merged as outlines; or any 2D collider, through the backend-neutral `_shapeFields()` every
 * 2D collider class gives, ADR 0305), its SpriteRenderer's slice outline (ADR 0414) or rectangle, or a custom path.
 * Outlines are in the node's local XY; the light pass places them with the node's world matrix.
 */
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import { findShapeSource2D } from "../../physics/shapeSource2D";
import type { ShapeFields2D } from "../../physics/shape2d";
import type { Point2 } from "../../physics/polygon";
import type { ShadowCaster2D } from "../components";
import { SpriteRenderer } from "../components";
import { spriteOutline, type TextureSizeOf } from "../sprites/spriteOutline";

/** A caster's outline in its node's local XY: closed `loops` and open `chains`. */
export interface CasterOutline {
  loops: Point2[][];
  chains: Point2[][];
  /** Changes whenever the outline does. */
  signature: string;
  /** Where it came from (`"rect"` when nothing better than a sprite's rectangle was found). */
  from: "collider" | "source" | "sprite" | "rect" | "custom" | "none";
}

const NONE: CasterOutline = { loops: [], chains: [], signature: "none", from: "none" };

/** A 2D collider as far as outlines go: a Component with backend-neutral shape fields and a `center` (ADR 0305). */
interface ShapedCollider {
  center?: { x: number; y: number };
  _shapeFields(): ShapeFields2D;
}
const isShaped = (c: unknown): c is Component & ShapedCollider => typeof (c as Partial<ShapedCollider> | null)?._shapeFields === "function";

const CIRCLE_SIDES = 16;

export type { TextureSizeOf };

/** The outline `caster` casts from now; `textureSize` gives sprite textures' sizes (a sprite outline needs its frame). */
export function casterOutline(world: World, caster: ShadowCaster2D, textureSize: TextureSizeOf): CasterOutline {
  const mode = caster.shape;
  if (mode === "custom") {
    const loop = caster.path.map((p): Point2 => [p.x, p.y]);
    return loop.length >= 2 ? { loops: loop.length >= 3 ? [loop] : [], chains: loop.length === 2 ? [loop] : [], signature: `custom:${JSON.stringify(loop)}`, from: "custom" } : NONE;
  }
  if (mode === "collider" || mode === "auto") {
    const c = colliderOutline(world, caster);
    if (c) return c;
    if (mode === "collider") return NONE;
  }
  return casterSpriteOutline(world, caster, textureSize) ?? NONE;
}

function colliderOutline(world: World, caster: ShadowCaster2D): CasterOutline | null {
  const node = caster.node;
  const source = findShapeSource2D(node);
  if (source) {
    const shapes = source.collisionShapes("outline");
    if (!shapes) return { ...NONE, signature: `source:pending:${source.collisionSignature()}`, from: "source" };
    const ux = shapes.unit.x, uy = shapes.unit.y;
    const loops: Point2[][] = [];
    for (const loop of shapes.loops) loops.push(loop.map(([x, y]): Point2 => [x * ux, y * uy]));
    for (const p of shapes.polygons) loops.push(p.map(([x, y]): Point2 => [x * ux, y * uy]));
    for (const b of shapes.boxes) loops.push(rect(b.x * ux, b.y * uy, (b.x + b.w) * ux, (b.y + b.h) * uy));
    return { loops, chains: [], signature: `source:${source.collisionSignature()}`, from: "source" };
  }
  const loops: Point2[][] = [];
  const chains: Point2[][] = [];
  const sig: unknown[] = [];
  for (const c of world._componentsOf(node.entity)) {
    if (!isShaped(c) || !c.enabled) continue;
    const f = c._shapeFields();
    const cx = c.center?.x ?? 0, cy = c.center?.y ?? 0;
    sig.push(f, cx, cy);
    if (f.kind === "box") loops.push(rect(cx - f.size[0]! / 2, cy - f.size[1]! / 2, cx + f.size[0]! / 2, cy + f.size[1]! / 2));
    else if (f.kind === "circle") loops.push(circle(cx, cy, f.radius));
    else if (f.kind === "capsule") loops.push(capsule(cx, cy, f.radius, f.height));
    else if (f.kind === "polygon" || f.kind === "edge") {
      const pts = (f.points as unknown[]).filter((p): p is number[] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p): Point2 => [p[0]! + cx, p[1]! + cy]);
      if (f.kind === "polygon" && pts.length >= 3) loops.push(pts);
      else if (f.kind === "edge" && pts.length >= 2) chains.push(pts);
    }
  }
  if (sig.length === 0) return null;
  return { loops, chains, signature: `collider:${JSON.stringify(sig)}`, from: "collider" };
}

function casterSpriteOutline(world: World, caster: ShadowCaster2D, textureSize: TextureSizeOf): CasterOutline | null {
  const r = world._componentsOf(caster.node.entity).find((c): c is SpriteRenderer => c instanceof SpriteRenderer);
  if (!r) return null;
  const o = spriteOutline(world, r, textureSize, { deformed: true }); // a deforming sprite's shadow follows it (ADR 0415)
  return { loops: o.loops, chains: [], signature: o.signature, from: o.from === "rect" ? "rect" : "sprite" };
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

function circle(cx: number, cy: number, r: number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < CIRCLE_SIDES; i++) {
    const a = (i / CIRCLE_SIDES) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

function capsule(cx: number, cy: number, r: number, height: number): Point2[] {
  const half = Math.max(height / 2 - r, 0);
  const out: Point2[] = [];
  const n = CIRCLE_SIDES / 2;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI;
    out.push([cx + Math.cos(a) * r, cy + half + Math.sin(a) * r]);
  }
  for (let i = 0; i <= n; i++) {
    const a = Math.PI + (i / n) * Math.PI;
    out.push([cx + Math.cos(a) * r, cy - half + Math.sin(a) * r]);
  }
  return out;
}

/** A group of casters that cast as one (ADR 0415): one caster, or a CompositeShadowCaster2D's casters below it. */
export interface CasterGroup {
  /** Where the group's settings come from: the caster, or the composite. */
  readonly settings: { readonly castShadows: boolean; readonly selfShadows: boolean; readonly targetSortingLayers: readonly string[]; readonly shadowMask: readonly string[] };
  readonly members: readonly ShadowCaster2D[];
  /** The composite's Component, or null for a lone caster. */
  readonly composite: Component | null;
}

/**
 * The World's enabled ShadowCaster2Ds grouped by their nearest enabled CompositeShadowCaster2D ancestor (on the node
 * itself or above it): a composite's members cast as one outline with its settings, edges inside another member dropped.
 */
export function casterGroups(world: World, casters: readonly ShadowCaster2D[], isComposite: (c: Component) => boolean): CasterGroup[] {
  const byComposite = new Map<Component, ShadowCaster2D[]>();
  const out: CasterGroup[] = [];
  for (const c of casters) {
    let composite: Component | null = null;
    for (let n: typeof c.node | null = c.node; n && !composite; n = n.parent) {
      composite = world._componentsOf(n.entity).find((x) => isComposite(x) && x.isActiveAndEnabled) ?? null;
    }
    if (!composite) out.push({ settings: c, members: [c], composite: null });
    else {
      const list = byComposite.get(composite);
      if (list) list.push(c);
      else byComposite.set(composite, [c]);
    }
  }
  for (const [composite, members] of byComposite) out.push({ settings: composite as unknown as CasterGroup["settings"], members, composite });
  return out;
}
