// The tile collision and shadow shape editor's model (ADR 0439): what the tileset inspector's canvas edits, as pure
// functions over a tile's shapes in its cell box's units (`[0, 0]` bottom-left, `[1, 1]` top-right, ADR 0437).
// - A tile's collision (or occluder) as a list of editable shapes: presets expand to the preview grid's cell outline,
//   so a full cell can be reshaped by dragging its points; and back to what the file stores: no shape is `"none"`, one
//   is the single-polygon form, several are `{ shapes }`; an occluder of "Same as collision" is the field left out.
// - The pointer gestures over the shapes (the editor SDK's shared point editing), drawing a rectangle or a polygon,
//   snapping to the sprite's pixel grid, shapes traced from the sprite, and copy, paste and apply to other tiles.
// `TileShapeEditor.tsx` draws it and turns pointer events into these calls; each finished gesture is one tileset edit.
import { hitHandle, insidePolygon, pointHandles, pressPoints, type V2 } from "../../../editor/sdk";
import { tilePolygons, type TileCollision, type TileDef, type TileOccluder, type TilePolygon, type TilesetPreviewGrid } from "../runtime/tileset";

export type { V2 };

/** Which of a tile's shape sets the editor shows: what bodies collide with, or what casts 2D shadows. */
export type ShapeMode = "collision" | "shadow";
export type CollisionPreset = "none" | "full" | "oneWay";
export type ShadowPreset = "collision" | "none" | "full";

const TIDY = 1e4;
/** Box units rounded to 1/10000, so files don't fill with float noise. */
export const tidy = (n: number) => Math.round(n * TIDY) / TIDY || 0;
const tidyPoint = (p: V2): V2 => [tidy(p[0]), tidy(p[1])];
const copyShape = (s: TilePolygon): TilePolygon => (s.oneWay ? { polygon: s.polygon.map((p): V2 => [p[0], p[1]]), oneWay: true } : { polygon: s.polygon.map((p): V2 => [p[0], p[1]]) });

/** The cell's outline in its box's units for the tileset's preview grid: the box, a diamond, or a pointy-top hexagon. */
export function cellOutline(grid: TilesetPreviewGrid | undefined): V2[] {
  if (grid === "isometric") return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  if (grid === "hexagonal") return [[0.5, 0], [1, 0.25], [1, 0.75], [0.5, 1], [0, 0.75], [0, 0.25]];
  return [[0, 0], [1, 0], [1, 1], [0, 1]];
}

/** Where a tile's sprite sits in its cell box, in pixels with y up: the box's size, and the sprite's bottom-left and size. */
export interface SpriteFrame {
  cell: [number, number];
  origin: [number, number];
  size: [number, number];
}

/** The sprite placed by its anchor (ADR 0119): the anchor's point of the sprite lands on the same point of the box. A missing sprite is the box. */
export function spriteFrame(tileSize: [number, number], spriteSize: [number, number] | null, anchor: [number, number]): SpriteFrame {
  const size = spriteSize ?? tileSize;
  return { cell: tileSize, origin: [anchor[0] * (tileSize[0] - size[0]), anchor[1] * (tileSize[1] - size[1])], size };
}

/** A point in box units snapped to the sprite's pixel grid, or left free (Shift) to 1/10000. */
export function snapPoint(p: V2, frame: SpriteFrame, free: boolean): V2 {
  if (free) return tidyPoint(p);
  const axis = (v: number, i: 0 | 1) => (Math.round(v * frame.cell[i] - frame.origin[i]) + frame.origin[i]) / frame.cell[i];
  return tidyPoint([axis(p[0], 0), axis(p[1], 1)]);
}

/** The pixels' extent the canvas shows (box and sprite, with a margin), `[x0, y0, x1, y1]` in box pixels, y up. */
export function viewExtent(frame: SpriteFrame, margin = 2): [number, number, number, number] {
  return [Math.min(0, frame.origin[0]) - margin, Math.min(0, frame.origin[1]) - margin, Math.max(frame.cell[0], frame.origin[0] + frame.size[0]) + margin, Math.max(frame.cell[1], frame.origin[1] + frame.size[1]) + margin];
}

/** The shapes the editor shows and edits for a collision value: presets as the cell's outline. */
export function collisionShapes(c: TileCollision, grid: TilesetPreviewGrid | undefined): TilePolygon[] {
  if (c === "none") return [];
  if (c === "full") return [{ polygon: cellOutline(grid) }];
  if (c === "oneWay") return [{ polygon: cellOutline(grid), oneWay: true }];
  return tilePolygons(c).map(copyShape);
}

/** The shapes a tile's collision or shadow set shows. "Same as collision" shows the collision's shapes, never one-way. */
export function editableShapes(tile: TileDef, mode: ShapeMode, grid: TilesetPreviewGrid | undefined): TilePolygon[] {
  if (mode === "collision") return collisionShapes(tile.collision, grid);
  const o = tile.occluder ?? "collision";
  if (o === "collision") return collisionShapes(tile.collision, grid).map((s) => ({ polygon: s.polygon }));
  if (o === "none") return [];
  if (o === "full") return [{ polygon: cellOutline(grid) }];
  return o.shapes.map((s) => ({ polygon: s.polygon.map((p): V2 => [p[0], p[1]]) }));
}

/** The preset a tile's set is, or `"custom"` for drawn shapes. */
export function presetOf(tile: TileDef, mode: ShapeMode): CollisionPreset | ShadowPreset | "custom" {
  const v = mode === "collision" ? tile.collision : (tile.occluder ?? "collision");
  return typeof v === "string" ? v : "custom";
}

/** What a collision with these shapes stores: none, the single-polygon form for one, `{ shapes }` for several. */
export function writeCollision(shapes: readonly TilePolygon[]): TileCollision {
  const tidied = shapes.filter((s) => s.polygon.length >= 3).map((s) => copyShape({ ...s, polygon: s.polygon.map(tidyPoint) }));
  if (tidied.length === 0) return "none";
  return tidied.length === 1 ? tidied[0]! : { shapes: tidied };
}

/** What an occluder with these shapes stores: `"none"` for none, else `{ shapes }` (an occluder has no one-way). */
export function writeOccluder(shapes: readonly TilePolygon[]): TileOccluder {
  const tidied = shapes.filter((s) => s.polygon.length >= 3).map((s) => ({ polygon: s.polygon.map(tidyPoint) }));
  return tidied.length ? { shapes: tidied } : "none";
}

/** The tile patch that stores `shapes` as the mode's set. */
export function shapesPatch(mode: ShapeMode, shapes: readonly TilePolygon[]): Partial<TileDef> {
  return mode === "collision" ? { collision: writeCollision(shapes) } : { occluder: writeOccluder(shapes) };
}

/** The tile patch for a collision preset. */
export const collisionPresetPatch = (preset: CollisionPreset): Partial<TileDef> => ({ collision: preset });

/** The tile patch for a shadow preset. "Same as collision" leaves `occluder` out (undefined: the field is removed). */
export const shadowPresetPatch = (preset: ShadowPreset): Partial<TileDef> => ({ occluder: preset === "collision" ? undefined : preset });

/** The shapes with one added. */
export const addShape = (shapes: readonly TilePolygon[], polygon: readonly V2[], oneWay = false): TilePolygon[] => [...shapes.map(copyShape), oneWay ? { polygon: polygon.map(tidyPoint), oneWay: true } : { polygon: polygon.map(tidyPoint) }];

/** The shapes without shape `i`. */
export const removeShape = (shapes: readonly TilePolygon[], i: number): TilePolygon[] => shapes.filter((_, k) => k !== i).map(copyShape);

/** The shapes with shape `i` one-way or not. */
export const setOneWay = (shapes: readonly TilePolygon[], i: number, on: boolean): TilePolygon[] => shapes.map((s, k) => copyShape(k === i ? { polygon: s.polygon, oneWay: on } : s));

/** The shapes with point `point` of shape `shape` at `p`. */
export const movePoint = (shapes: readonly TilePolygon[], shape: number, point: number, p: V2): TilePolygon[] =>
  shapes.map((s, k) => (k === shape ? copyShape({ ...s, polygon: s.polygon.map((q, j): V2 => (j === point ? [p[0], p[1]] : q)) }) : copyShape(s)));

/** The rectangle with corners `a` and `b`, counter-clockwise from the bottom-left; null when it has no area. */
export function rectangle(a: V2, b: V2): V2[] | null {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return null;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/**
 * A click while drawing a polygon: closes it when it lands within `closeRadius` of the first point and there are three
 * or more (`closed` holds the polygon), else adds the point (`draft`). A click on the last point again is ignored.
 * Distances are measured after scaling x and y by `scale` (box units to screen pixels, say).
 */
export function addDraftPoint(draft: readonly V2[], p: V2, closeRadius: number, scale: V2 = [1, 1]): { draft: V2[] } | { closed: V2[] } {
  const first = draft[0], last = draft[draft.length - 1];
  const dist = (q: V2) => Math.hypot((p[0] - q[0]) * scale[0], (p[1] - q[1]) * scale[1]);
  if (first && draft.length >= 3 && dist(first) <= closeRadius) return { closed: draft.map((q): V2 => [q[0], q[1]]) };
  if (last && dist(last) < 1e-9) return { draft: [...draft] };
  return { draft: [...draft, [p[0], p[1]]] };
}

/** Enter while drawing: the polygon, or null below three points. */
export const finishDraft = (draft: readonly V2[]): V2[] | null => (draft.length >= 3 ? draft.map((q): V2 => [q[0], q[1]]) : null);

/**
 * The handle under `p` (within `radius`): the selected shape's first, then the others from the top. Distances are
 * measured after scaling x and y by `scale` (box units to screen pixels, so the reach is the same on a wide tile).
 */
export function hitShapes(shapes: readonly TilePolygon[], p: V2, radius: number, selected: number | null = null, scale: V2 = [1, 1]): { shape: number; handle: string } | null {
  const order = shapes.map((_, i) => i).reverse();
  if (selected !== null && shapes[selected]) order.unshift(selected);
  const scaled = (q: V2): V2 => [q[0] * scale[0], q[1] * scale[1]];
  for (const i of order) {
    const handle = hitHandle(pointHandles(shapes[i]!.polygon.map(scaled), true), scaled(p), radius);
    if (handle) return { shape: i, handle };
  }
  return null;
}

/** The topmost shape `p` is inside, or null. */
export function shapeAt(shapes: readonly TilePolygon[], p: V2): number | null {
  for (let i = shapes.length - 1; i >= 0; i--) if (insidePolygon(shapes[i]!.polygon, p)) return i;
  return null;
}

/**
 * A press on a shape's handle (the shared gestures): drag a point (`drag` names it in `shapes`, which holds the shapes
 * with any point inserted mid-edge), remove one with Ctrl/⌘ (`removed`: the shapes after), refuse to go below three
 * points, or nothing (null).
 */
export function pressShape(shapes: readonly TilePolygon[], shape: number, handle: string, ctrl: boolean): { drag: { shape: number; point: number }; shapes: TilePolygon[] } | { removed: TilePolygon[] } | { refused: string } | null {
  const s = shapes[shape];
  if (!s) return null;
  const action = pressPoints(s.polygon, handle, ctrl);
  if (!action) return null;
  if ("refused" in action) return { refused: "A shape needs at least 3 points: delete the shape instead." };
  const replaced = (polygon: V2[]) => shapes.map((q, k) => copyShape(k === shape ? { ...q, polygon } : q));
  if ("removed" in action) return { removed: replaced(action.removed) };
  return { drag: { shape, point: action.drag }, shapes: replaced(action.points) };
}

/** Outlines traced from the sprite (`traceOutline`: sprite pixels from its bottom-left, y up) as shapes in box units, one per loop. */
export function tracedShapes(loops: readonly (readonly V2[])[], frame: SpriteFrame): TilePolygon[] {
  return loops.filter((l) => l.length >= 3).map((l) => ({ polygon: l.map((p): V2 => tidyPoint([(p[0] + frame.origin[0]) / frame.cell[0], (p[1] + frame.origin[1]) / frame.cell[1]])) }));
}

/** Copied collision on the clipboard: a tile's collision and occluder. */
export interface CollisionClip {
  format: typeof CLIP_FORMAT;
  collision: TileCollision;
  occluder?: TileOccluder;
}

export const CLIP_FORMAT = "myco.tileCollision@1";

/** What Copy puts on the clipboard for a tile. */
export function copyClip(tile: TileDef): CollisionClip {
  const clip: CollisionClip = { format: CLIP_FORMAT, collision: structuredClone(tile.collision) };
  if (tile.occluder !== undefined) clip.occluder = structuredClone(tile.occluder);
  return clip;
}

/** True for a clipboard value that is a copied collision. */
export function isClip(v: unknown): v is CollisionClip {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return c.format === CLIP_FORMAT && (typeof c.collision === "string" || (typeof c.collision === "object" && c.collision !== null));
}

/** The patch Paste writes in a mode: the copied tile's collision, or (Shadow) its occluder. */
export function pastePatch(clip: CollisionClip, mode: ShapeMode): Partial<TileDef> {
  return mode === "collision" ? { collision: structuredClone(clip.collision) } : { occluder: clip.occluder === undefined ? undefined : structuredClone(clip.occluder) };
}

/** `tiles` with `patch` applied to each tile whose id is in `ids`; a patch value of undefined removes that field. */
export function patchTiles(tiles: readonly TileDef[], ids: ReadonlySet<number>, patch: Partial<TileDef>): TileDef[] {
  return tiles.map((t) => {
    if (!ids.has(t.id)) return t;
    const next: TileDef = { ...t, ...structuredClone(patch) };
    for (const k of Object.keys(patch) as (keyof TileDef)[]) if (next[k] === undefined) delete next[k];
    return next;
  });
}
