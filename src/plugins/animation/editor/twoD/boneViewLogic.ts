// The bone editor view's geometry (ADR 0373 "2D tools"; T56): where slice-frame points are on the stage, what a drag means,
// and the rows of the bone list. Pure, so the view only draws and forwards pointers. The slice frame is x right from the
// rect's left edge and y up from its bottom edge (`skinLogic.ts`); the stage is y down, one slice pixel `zoom` stage pixels.
import type { SliceSkin } from "../../../../engine/animation/sprites/sidecar";
import type { BrushMode, SliceRect } from "./skinLogic";

/** The tools of the bone editor's stage. */
export type BoneTool = "create" | "move" | "mesh" | "paint";

/** A stage point (pixels from its top-left) as a slice-frame point. */
export const stageToSlice = (rect: SliceRect, zoom: number, sx: number, sy: number): [number, number] => [sx / zoom, rect[3] - sy / zoom];
/** A slice-frame point as a stage point. */
export const sliceToStage = (rect: SliceRect, zoom: number, x: number, y: number): [number, number] => [x * zoom, (rect[3] - y) * zoom];

/** A whole zoom that shows the slice about `box` stage pixels across, between 1 and 32. */
export function defaultZoom(rect: SliceRect, box = 420): number {
  return Math.max(1, Math.min(32, Math.floor(box / Math.max(1, rect[2], rect[3]))));
}

/** One row of the bone list: a bone and how deep it sits (parents before children, children in declared order). */
export interface BoneRow {
  readonly name: string;
  readonly depth: number;
}

/** The bones as a tree list, roots first. A bone whose parent is missing is a root. */
export function boneRows(skin: SliceSkin): BoneRow[] {
  const names = new Set(skin.bones.map((b) => b.name));
  const out: BoneRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const b of skin.bones) {
      if ((b.parent !== null && !names.has(b.parent) ? null : b.parent) !== parent) continue;
      out.push({ name: b.name, depth });
      walk(b.name, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The weight vertex `vertex` gives bone index `bone` (0 when it has none). */
export function weightOnBone(weights: readonly (readonly number[])[] | null, vertex: number, bone: number): number {
  const w = weights?.[vertex];
  if (!w) return 0;
  for (let p = 0; p + 1 < w.length; p += 2) if (w[p] === bone) return w[p + 1]!;
  return 0;
}

/** The unique edges of a mesh's triangles as vertex index pairs (for drawing the wireframe once). */
export function meshEdges(triangles: readonly number[]): [number, number][] {
  const seen = new Set<number>();
  const out: [number, number][] = [];
  const n = Math.max(0, ...triangles) + 1;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    for (const [a, b] of [[triangles[t]!, triangles[t + 1]!], [triangles[t + 1]!, triangles[t + 2]!], [triangles[t + 2]!, triangles[t]!]] as const) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * n + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([lo, hi]);
    }
  }
  return out;
}

/** What a press on the stage starts, by tool and what's under the pointer. */
export type StageGesture =
  | { readonly kind: "create" }
  | { readonly kind: "move-bone"; readonly bone: string; readonly end: "head" | "tip" }
  | { readonly kind: "move-vertex"; readonly vertex: number }
  | { readonly kind: "paint" }
  | { readonly kind: "none" };

/** The gesture a press starts: `bone`/`end` and `vertex` are what the pointer is over (null for nothing). */
export function gestureFor(tool: BoneTool, over: { readonly bone: string | null; readonly end: "head" | "tip" | "body" | null; readonly vertex: number | null }): StageGesture {
  switch (tool) {
    case "create":
      return { kind: "create" };
    case "move":
      if (over.bone === null) return { kind: "none" };
      return over.end === "tip" ? { kind: "move-bone", bone: over.bone, end: "tip" } : { kind: "move-bone", bone: over.bone, end: "head" };
    case "mesh":
      return over.vertex === null ? { kind: "none" } : { kind: "move-vertex", vertex: over.vertex };
    case "paint":
      return { kind: "paint" };
  }
}

/** The brush modes, labelled. */
export const BRUSH_MODES: readonly { readonly value: BrushMode; readonly label: string }[] = [
  { value: "add", label: "Add" },
  { value: "subtract", label: "Subtract" },
  { value: "smooth", label: "Smooth" },
];
