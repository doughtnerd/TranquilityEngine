// The decisions behind clicking and box-selecting in the viewport (ADR 0022, 0026), on plain data:
// a click or a drag, which of the hits a click selects, what lies inside a selection box or near an
// Alt+click, and which collider outlines contain the pointer. viewportSelection.ts feeds them the
// viewport's picks and applies the result.
import type { GameObject } from "../engine";
import type { ScreenRect } from "../engine/editor";
import { pathKey, type NodePath } from "./document";
import { pointInPolygon, polygonArea } from "./polygonMath";

/** Pointer travel (CSS pixels) under which a press and release count as a click, not a drag. */
const CLICK_SLOP = 4;

export interface PointerSample {
  readonly x: number;
  readonly y: number;
  readonly button: number;
  /** Alt + left drag orbits the camera, so it never selects. */
  readonly alt?: boolean;
}

/** True if `down`…`up` is a plain left click: left button, no Alt, little movement. */
export function isPlainClick(down: PointerSample, up: PointerSample): boolean {
  return down.button === 0 && up.button === 0 && !down.alt && Math.hypot(up.x - down.x, up.y - down.y) < CLICK_SLOP;
}

/** Document ids for picked nodes, topmost first, without duplicates or unmapped nodes. */
export function hitIds(nodes: readonly GameObject[], idOf: (node: GameObject) => string | null): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const id = idOf(n);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * What a click selects: nothing on empty space, the topmost hit, or (clicking the same spot
 * again while one of the hits is selected) the next hit down, wrapping around.
 */
export function chooseSelection(hits: readonly string[], current: string | null, sameSpot: boolean): string | null {
  if (hits.length === 0) return null;
  const index = sameSpot && current !== null ? hits.indexOf(current) : -1;
  return index < 0 ? hits[0] : hits[(index + 1) % hits.length];
}

/** The rectangle between two canvas points. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): ScreenRect {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

const union = (a: ScreenRect, b: ScreenRect): ScreenRect => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});
const inside = (r: ScreenRect, box: ScreenRect) => r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;

/**
 * Document ids lying inside `box`: a node counts when everything it draws (its own renderers and
 * those of the nodes inside it, for a prefab instance), or its origin if it draws nothing, is
 * within the box. In the order the nodes were listed.
 */
export function idsInBox(bounds: readonly { node: GameObject; rect: ScreenRect }[], box: ScreenRect, idOf: (node: GameObject) => string | null): string[] {
  const extent = new Map<string, ScreenRect>();
  for (const { node, rect } of bounds) {
    const id = idOf(node);
    if (id === null) continue;
    const e = extent.get(id);
    extent.set(id, e ? union(e, rect) : rect);
  }
  return [...extent].filter(([, r]) => inside(r, box)).map(([id]) => id);
}

/**
 * Path keys of the nodes within `radius` of a canvas point, however deep: each node near it, and
 * for a node inside a prefab instance, the instance too. In the order the nodes were listed.
 */
export function keysNear(bounds: readonly { node: GameObject; rect: ScreenRect }[], x: number, y: number, radius: number, pathOf: (node: GameObject) => NodePath | null): string[] {
  const out = new Set<string>();
  for (const { node, rect } of bounds) {
    const dx = Math.max(rect.left - x, 0, x - rect.right), dy = Math.max(rect.top - y, 0, y - rect.bottom);
    if (Math.hypot(dx, dy) > radius) continue;
    const path = pathOf(node);
    if (!path) continue;
    out.add(path[0]);
    out.add(pathKey(path));
  }
  return [...out];
}

/** A collider outline: its node and its points in world space. */
export type Shape = { node: GameObject; points: readonly (readonly number[])[] };

/**
 * Nodes whose collider outline contains the pointer, smallest collider first. `pointAt(z)` is
 * the world point under the pointer on the plane at depth z (each collider lies in its node's plane).
 */
export function colliderHits(shapes: readonly Shape[], pointAt: (z: number) => readonly number[] | null): GameObject[] {
  return shapes
    .filter((s) => {
      const p = s.points.length > 0 ? pointAt(s.points[0][2] ?? 0) : null;
      return p !== null && pointInPolygon(p as [number, number], s.points);
    })
    .sort((a, b) => polygonArea(a.points) - polygonArea(b.points))
    .map((s) => s.node);
}

/** Each collider's rectangle on the canvas, for the box and the Alt+click list; colliders partly behind the camera are left out. */
export function colliderBounds(shapes: readonly Shape[], project: (p: readonly number[]) => [number, number] | null): { node: GameObject; rect: ScreenRect }[] {
  const out: { node: GameObject; rect: ScreenRect }[] = [];
  for (const { node, points } of shapes) {
    const projected = points.map(project);
    if (projected.length === 0 || projected.some((p) => p === null)) continue;
    const xs = projected.map((p) => p![0]), ys = projected.map((p) => p![1]);
    out.push({ node, rect: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } });
  }
  return out;
}
