import { describe, expect, it } from "vitest";
import type { TileDef, TilePolygon } from "../runtime/tileset";
import {
  addDraftPoint,
  addShape,
  cellOutline,
  collisionPresetPatch,
  copyClip,
  editableShapes,
  finishDraft,
  hitShapes,
  isClip,
  movePoint,
  pastePatch,
  patchTiles,
  presetOf,
  pressShape,
  rectangle,
  removeShape,
  setOneWay,
  shadowPresetPatch,
  shapeAt,
  shapesPatch,
  snapPoint,
  spriteFrame,
  tracedShapes,
  viewExtent,
  writeCollision,
  writeOccluder,
  type V2,
} from "./tileShapeEditorLogic";

const tile = (patch: Partial<TileDef> = {}): TileDef => ({ id: 1, uuid: "u1", sprite: "asset:t.png#a", collision: "none", ...patch });
const square: V2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const tri: V2[] = [[0, 0], [1, 0], [0.5, 1]];

describe("the shapes a tile shows", () => {
  it("expands presets to the preview grid's cell outline", () => {
    expect(editableShapes(tile(), "collision", undefined)).toEqual([]);
    expect(editableShapes(tile({ collision: "full" }), "collision", undefined)).toEqual([{ polygon: square }]);
    expect(editableShapes(tile({ collision: "oneWay" }), "collision", "isometric")).toEqual([{ polygon: cellOutline("isometric"), oneWay: true }]);
    expect(cellOutline("hexagonal")).toHaveLength(6);
    expect(editableShapes(tile({ collision: { shapes: [{ polygon: tri }, { polygon: square, oneWay: true }] } }), "collision", undefined)).toHaveLength(2);
  });

  it("shows the collision (never one-way) as the shadow until the tile has its own", () => {
    const t = tile({ collision: { polygon: tri, oneWay: true } });
    expect(editableShapes(t, "shadow", undefined)).toEqual([{ polygon: tri }]);
    expect(editableShapes({ ...t, occluder: "none" }, "shadow", undefined)).toEqual([]);
    expect(editableShapes({ ...t, occluder: "full" }, "shadow", undefined)).toEqual([{ polygon: square }]);
    expect(editableShapes({ ...t, occluder: { shapes: [{ polygon: square }] } }, "shadow", undefined)).toEqual([{ polygon: square }]);
    expect(presetOf(t, "shadow")).toBe("collision");
    expect(presetOf(t, "collision")).toBe("custom");
  });

  it("doesn't hand out the tile's own arrays", () => {
    const t = tile({ collision: { polygon: [[0, 0], [1, 0], [1, 1]] } });
    editableShapes(t, "collision", undefined)[0]!.polygon[0]![0] = 5;
    expect(t.collision).toEqual({ polygon: [[0, 0], [1, 0], [1, 1]] });
  });
});

describe("what the file stores", () => {
  it("writes none, the single-polygon form, or several shapes", () => {
    expect(writeCollision([])).toBe("none");
    expect(writeCollision([{ polygon: tri }])).toEqual({ polygon: tri });
    expect(writeCollision([{ polygon: tri, oneWay: true }])).toEqual({ polygon: tri, oneWay: true });
    expect(writeCollision([{ polygon: tri }, { polygon: square, oneWay: true }])).toEqual({ shapes: [{ polygon: tri }, { polygon: square, oneWay: true }] });
    // Degenerate shapes are dropped, and points are tidied.
    expect(writeCollision([{ polygon: [[0, 0], [1, 0]] }, { polygon: [[0.123456, 0], [1, 0], [1, 1]] }])).toEqual({ polygon: [[0.1235, 0], [1, 0], [1, 1]] });
  });

  it("writes occluders as shapes (never one-way) or none; Same as collision leaves the field out", () => {
    expect(writeOccluder([])).toBe("none");
    expect(writeOccluder([{ polygon: tri, oneWay: true }])).toEqual({ shapes: [{ polygon: tri }] });
    expect(shapesPatch("shadow", [{ polygon: tri }])).toEqual({ occluder: { shapes: [{ polygon: tri }] } });
    expect(shapesPatch("collision", [])).toEqual({ collision: "none" });
    expect(shadowPresetPatch("collision")).toEqual({ occluder: undefined });
    expect(shadowPresetPatch("full")).toEqual({ occluder: "full" });
    expect(collisionPresetPatch("oneWay")).toEqual({ collision: "oneWay" });
    // Applied to a tile, undefined removes the field.
    const [t] = patchTiles([tile({ occluder: "none" })], new Set([1]), shadowPresetPatch("collision"));
    expect("occluder" in t!).toBe(false);
  });
});

describe("editing shapes", () => {
  it("adds, removes, moves points of and marks shapes one-way", () => {
    let shapes: TilePolygon[] = addShape([], square);
    shapes = addShape(shapes, tri, true);
    expect(shapes).toEqual([{ polygon: square }, { polygon: tri, oneWay: true }]);
    expect(setOneWay(shapes, 0, true)[0]).toEqual({ polygon: square, oneWay: true });
    expect(setOneWay(shapes, 1, false)[1]).toEqual({ polygon: tri });
    expect(movePoint(shapes, 0, 2, [0.5, 0.5])[0]!.polygon[2]).toEqual([0.5, 0.5]);
    expect(removeShape(shapes, 0)).toEqual([{ polygon: tri, oneWay: true }]);
    expect(shapes[0]!.polygon[2]).toEqual([1, 1]); // unchanged
  });

  it("presses handles with the shared gestures: drag, insert mid-edge, Ctrl removes, not below three", () => {
    const shapes: TilePolygon[] = [{ polygon: tri }, { polygon: square, oneWay: true }];
    expect(pressShape(shapes, 1, "p:2", false)).toEqual({ drag: { shape: 1, point: 2 }, shapes });
    const inserted = pressShape(shapes, 1, "insert:0", false) as { drag: { shape: number; point: number }; shapes: TilePolygon[] };
    expect(inserted.drag).toEqual({ shape: 1, point: 1 });
    expect(inserted.shapes[1]).toEqual({ polygon: [[0, 0], [0.5, 0], [1, 0], [1, 1], [0, 1]], oneWay: true });
    expect(pressShape(shapes, 1, "p:0", true)).toEqual({ removed: [{ polygon: tri }, { polygon: [[1, 0], [1, 1], [0, 1]], oneWay: true }] });
    expect(pressShape(shapes, 0, "p:0", true)).toMatchObject({ refused: expect.stringContaining("3 points") });
    expect(pressShape(shapes, 5, "p:0", false)).toBeNull();
  });

  it("hits handles in screen pixels, the selected shape first, and finds the shape under a point", () => {
    const shapes: TilePolygon[] = [{ polygon: square }, { polygon: [[0, 0], [0.5, 0], [0.5, 0.5]] }];
    const scale: V2 = [100, 100];
    // Both shapes have a point at the origin: the topmost wins, unless another is selected.
    expect(hitShapes(shapes, [0.02, 0.02], 7, null, scale)).toEqual({ shape: 1, handle: "p:0" });
    expect(hitShapes(shapes, [0.02, 0.02], 7, 0, scale)).toEqual({ shape: 0, handle: "p:0" });
    expect(hitShapes(shapes, [0.5, 1], 7, null, scale)).toEqual({ shape: 0, handle: "insert:2" });
    expect(hitShapes(shapes, [0.8, 0.5], 7, null, scale)).toBeNull();
    // Reach is in screen pixels: 0.1 units is 10 px at this scale, out of reach, but in reach at a tenth of it.
    expect(hitShapes(shapes, [1.1, 1], 7, null, scale)).toBeNull();
    expect(hitShapes(shapes, [1.1, 1], 7, null, [10, 10])).toEqual({ shape: 0, handle: "p:2" });
    expect(shapeAt(shapes, [0.4, 0.1])).toBe(1);
    expect(shapeAt(shapes, [0.8, 0.8])).toBe(0);
    expect(shapeAt(shapes, [2, 2])).toBeNull();
  });

  it("draws rectangles from two corners", () => {
    expect(rectangle([1, 1], [0, 0.5])).toEqual([[0, 0.5], [1, 0.5], [1, 1], [0, 1]]);
    expect(rectangle([0, 0], [0, 1])).toBeNull();
  });

  it("draws polygons point by point, closing on the first point or Enter", () => {
    let d: V2[] = [];
    for (const p of [[0, 0], [1, 0], [1, 1]] as V2[]) d = (addDraftPoint(d, p, 7, [100, 100]) as { draft: V2[] }).draft;
    expect(d).toHaveLength(3);
    expect(addDraftPoint(d, [1, 1], 7, [100, 100])).toEqual({ draft: d }); // the same point again
    expect(addDraftPoint(d, [0.03, 0.03], 7, [100, 100])).toEqual({ closed: d });
    expect(addDraftPoint(d.slice(0, 2), [0.01, 0], 7, [100, 100])).toEqual({ draft: [[0, 0], [1, 0], [0.01, 0]] }); // too few to close
    expect(finishDraft(d)).toEqual(d);
    expect(finishDraft(d.slice(0, 2))).toBeNull();
  });
});

describe("snapping and the sprite's frame", () => {
  it("places the sprite by its anchor and snaps to its pixels unless free", () => {
    const f = spriteFrame([16, 16], [16, 16], [0, 0]);
    expect(snapPoint([0.51, 0.24], f, false)).toEqual([0.5, 0.25]);
    expect(snapPoint([0.51234567, 0.24], f, true)).toEqual([0.5123, 0.24]);
    // A 15-pixel-wide sprite centred in a 16-pixel cell: its pixels sit half a pixel off the cell's.
    const centred = spriteFrame([16, 16], [15, 16], [0.5, 0]);
    expect(centred.origin).toEqual([0.5, 0]);
    expect(snapPoint([0.5, 0], centred, false)).toEqual([0.5313, 0]); // 8.5 / 16
    expect(spriteFrame([16, 16], null, [0.5, 0.5])).toEqual({ cell: [16, 16], origin: [0, 0], size: [16, 16] });
    expect(viewExtent(spriteFrame([16, 16], [16, 32], [0, 0]))).toEqual([-2, -2, 18, 34]);
  });

  it("turns traced sprite outlines into shapes in box units, one per island", () => {
    const f = spriteFrame([16, 16], [16, 32], [0, 0]);
    const loops: V2[][] = [
      [[0, 0], [8, 0], [8, 8], [0, 8]],
      [[8, 16], [16, 16], [16, 32]],
      [[0, 0], [1, 1]],
    ];
    expect(tracedShapes(loops, f)).toEqual([{ polygon: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] }, { polygon: [[0.5, 1], [1, 1], [1, 2]] }]);
  });
});

describe("copy, paste and apply to selected tiles", () => {
  const source = tile({ collision: { shapes: [{ polygon: tri }, { polygon: square, oneWay: true }] }, occluder: "none" });

  it("copies a tile's collision and occluder and pastes the edited set", () => {
    const clip = copyClip(source);
    expect(isClip(JSON.parse(JSON.stringify(clip)))).toBe(true);
    expect(isClip({ format: "something.else", collision: "full" })).toBe(false);
    expect(pastePatch(clip, "collision")).toEqual({ collision: source.collision });
    expect(pastePatch(clip, "shadow")).toEqual({ occluder: "none" });
    expect(pastePatch(copyClip(tile({ collision: "full" })), "shadow")).toEqual({ occluder: undefined });
    // The clip is a copy: editing the tile afterwards doesn't change it.
    (source.collision as { shapes: TilePolygon[] }).shapes[0]!.polygon[0]![0] = 0;
    expect(pastePatch(clip, "collision").collision).not.toBe(source.collision);
  });

  it("applies a patch to the selected tiles only", () => {
    const tiles = [tile(), tile({ id: 2, uuid: "u2", occluder: "full" }), tile({ id: 3, uuid: "u3" })];
    const out = patchTiles(tiles, new Set([2, 3]), pastePatch(copyClip(source), "collision"));
    expect(out[0]).toBe(tiles[0]);
    expect(out[1]!.collision).toEqual(source.collision);
    expect(out[2]!.collision).toEqual(source.collision);
    expect(out[1]!.collision).not.toBe(out[2]!.collision); // each tile gets its own copy
    expect(out[1]!.occluder).toBe("full");
    const shadows = patchTiles(tiles, new Set([2]), pastePatch(copyClip(tile()), "shadow"));
    expect("occluder" in shadows[1]!).toBe(false);
  });
});
