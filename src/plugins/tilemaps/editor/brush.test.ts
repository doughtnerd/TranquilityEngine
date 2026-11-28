import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, type AssetSource } from "../../../engine";
import { FLIP_X, FLIP_Y, FLIP_DIAGONAL, Tilemap } from "../runtime";
import { cellValue } from "../runtime/format";
import { useEditorPlugins } from "../../testEditorPlugins";
import { tilemapsEditorPlugin } from ".";
import { openSceneFile } from "../../../editor/project";
import { editor } from "../../../editor/sdk";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew, sceneViewTools } from "../../../editor/testing";
import { activeLayer, beginStroke, brushFlags, brushFrame, brushLayers, brushRandom, brushStamp, brushTerrain, brushTool, commitTilemap, flipBrush, footprintAt, pickBrushTool, rerollVariants, type BrushTool } from "./brush";
import type { Cell } from "../runtime/brushes";
import { compose, TURN_CLOCKWISE as TURN } from "../runtime/tileFlips";

const TILESET = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  terrains: [{ name: "G" }, { name: "V" }],
  tiles: [
    { id: 1, sprite: "" },
    { id: 2, sprite: "" },
    { id: 3, sprite: "" },
    { id: 4, sprite: "" },
    { id: 10, sprite: "", terrain: "G", pattern: "0*0*0*0*" },
    { id: 11, sprite: "", terrain: "G", pattern: "0*1*0*0*" },
    { id: 12, sprite: "", terrain: "G", pattern: "0*1*0*1*" },
    { id: 13, sprite: "", terrain: "G", pattern: "0*0*0*1*" },
    { id: 30, sprite: "", terrain: "V" },
    { id: 31, sprite: "", terrain: "V" },
  ],
};

describe("tilemap brushes (ADR 0103)", () => {
  it("composes flips: two of the same cancel, four turns come back", () => {
    expect(compose(FLIP_X, FLIP_X)).toBe(0);
    expect(compose(FLIP_X, FLIP_Y)).toBe(FLIP_X | FLIP_Y);
    const turn = FLIP_DIAGONAL | FLIP_X;
    let f = 0;
    for (let i = 0; i < 4; i++) f = compose(f, turn);
    expect(f).toBe(0);
    expect(compose(0, turn)).toBe(turn);
  });
});

describe("painting a tilemap in the editor (ADR 0103)", () => {
  // Create Tilemap is the plugin's Hierarchy create entry (ADR 0146).
  useEditorPlugins([tilemapsEditorPlugin]);
  let engine: Engine;
  let tiles: AssetSource;
  beforeEach(async () => {
    tiles = Assets.fromObject({ "t.tileset.json": TILESET });
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    Assets.addSource(tiles);
    openSceneFile(engine, DEMO_SCENE);
    brushStamp.value = { width: 1, height: 1, values: [1] };
    brushLayers.value = null;
    brushFrame.value = null;
    brushRandom.value = false;
    brushTerrain.value = null;
    brushFlags.value = 0;
    activeLayer.value = 0;
  });
  afterEach(() => {
    Assets.removeSource(tiles);
    engine.dispose();
  });

  function newMap() {
    const scene = editor.scene.peekOpen()!;
    const id = insertNew(scene, "tilemap", { asset: "asset:t.tileset.json" });
    const map = scene.sync.nodeFor([id])!.getBehavior(Tilemap)!;
    return { scene, id, map };
  }

  /** A whole stroke with `tool`: pressed on the first cell, moved through the rest, released. */
  function stroke(map: Tilemap, tool: BrushTool, ...cells: Cell[]): boolean {
    const s = beginStroke(map, tool, cells[0]);
    for (const c of cells.slice(1)) s.moveTo(c);
    return s.finish();
  }
  /** The map's cell values (ids with flips) over a block, row by row from the top. */
  const block = (map: Tilemap, x0: number, y0: number, w: number, h: number) =>
    Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => map.getCell(x0 + c, y0 + h - 1 - r)));

  it("tiles a stamp over a rectangle from its corner, or picks each cell at random from it", () => {
    const { map } = newMap();
    brushStamp.value = { width: 2, height: 1, values: [1, 2] };
    expect(stroke(map, "rect", [3, 0], [0, 1])).toBe(true);
    expect(block(map, 0, 0, 4, 2)).toEqual([[1, 2, 1, 2], [1, 2, 1, 2]]);
    brushRandom.value = true;
    stroke(map, "pencil", [0, 3], [5, 3]);
    for (let x = 0; x <= 5; x++) expect([1, 2]).toContain(map.getTile(x, 3));
    expect(map.getTile(0, 4)).toBe(0); // a random brush paints one cell per cell
    expect(footprintAt("pencil", [0, 3])).toEqual({ x0: 0, y0: 3, x1: 1, y1: 4 });
  });

  it("mirrors a flipped multi-cell stamp's layout as well as its tiles (ADR 0289)", () => {
    const { map } = newMap();
    brushStamp.value = { width: 3, height: 1, values: [1, 2, 3] };
    flipBrush("x");
    stroke(map, "pencil", [0, 0]);
    expect(block(map, 0, 0, 3, 1)).toEqual([[cellValue(3, FLIP_X), cellValue(2, FLIP_X), cellValue(1, FLIP_X)]]);
    brushFlags.value = 0;
    brushStamp.value = { width: 1, height: 2, values: [1, 2] }; // 1 below 2
    flipBrush("y");
    stroke(map, "pencil", [5, 0]);
    expect(block(map, 5, 0, 1, 2)).toEqual([[cellValue(1, FLIP_Y)], [cellValue(2, FLIP_Y)]]);
    // A rectangle tiles the mirrored stamp too.
    brushFlags.value = FLIP_X;
    brushStamp.value = { width: 2, height: 1, values: [1, 2] };
    stroke(map, "rect", [0, 4], [3, 4]);
    expect(block(map, 0, 4, 4, 1)).toEqual([[2, 1, 2, 1].map((id) => cellValue(id, FLIP_X))]);
  });

  it("turns a multi-cell stamp a quarter turn, swapping its width and height, in painting and footprint (ADR 0289)", () => {
    const { map } = newMap();
    // 2 × 3, rows from the bottom: [1 2] [3 4] [0 1]; drawn from the top:
    //   0 1
    //   3 4
    //   1 2
    brushStamp.value = { width: 2, height: 3, values: [1, 2, 3, 4, 0, 1] };
    flipBrush("rotate");
    expect(footprintAt("pencil", [0, 0])).toEqual({ x0: 0, y0: 0, x1: 3, y1: 2 });
    stroke(map, "pencil", [0, 0]);
    // A quarter turn clockwise: the left column (top to bottom 0 3 1) becomes the top row (left to right 1 3 0).
    const t = (id: number) => cellValue(id, TURN);
    expect(block(map, 0, 0, 3, 2)).toEqual([[t(1), t(3), 0], [t(2), t(4), t(1)]]);
    expect(map.getCell(0, 2)).toBe(0);
    // Four turns come back to the stamp as it was.
    flipBrush("rotate");
    flipBrush("rotate");
    flipBrush("rotate");
    expect(footprintAt("pencil", [0, 0])).toEqual({ x0: 0, y0: 0, x1: 2, y1: 3 });
  });

  it("places a pencil stroke's stamps on the stamp grid from the press, and the footprint follows that grid", () => {
    const { map } = newMap();
    brushStamp.value = { width: 2, height: 1, values: [1, 2] };
    flipBrush("rotate"); // now 1 × 2
    const s = beginStroke(map, "pencil", [0, 0]);
    expect(s.moveTo([0, 0])).toBe(false);
    expect(s.moveTo([0, 3])).toBe(true);
    expect(s.footprint()).toEqual({ x0: 0, y0: 2, x1: 1, y1: 4 });
    // A stroke paints with the brush as it was pressed; turning it mid-stroke changes neither its cells nor its footprint.
    flipBrush("rotate");
    expect(s.footprint()).toEqual({ x0: 0, y0: 2, x1: 1, y1: 4 });
    s.finish();
    expect([0, 1, 2, 3].map((y) => map.getTile(0, y))).toEqual([2, 1, 2, 1]);
    expect(map.getTile(1, 0)).toBe(0);
    // A rectangle's footprint is the dragged block.
    const r = beginStroke(map, "rect", [5, 5]);
    r.moveTo([3, 6]);
    expect(r.footprint()).toEqual({ x0: 3, y0: 5, x1: 6, y1: 7 });
    expect(footprintAt("erase", [1, 1])).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 });
  });

  it("paints the same random-brush cells again from the same strokes, by the map's seed (ADR 0400)", () => {
    const { map } = newMap();
    brushStamp.value = { width: 2, height: 1, values: [1, 2] };
    brushRandom.value = true;
    stroke(map, "pencil", [0, 0], [39, 0]);
    const first = Array.from({ length: 40 }, (_, x) => map.getTile(x, 0));
    expect(new Set(first)).toEqual(new Set([1, 2]));
    stroke(map, "erase", [0, 0], [39, 0]);
    stroke(map, "pencil", [0, 0], [39, 0]);
    expect(Array.from({ length: 40 }, (_, x) => map.getTile(x, 0))).toEqual(first);
  });

  it("re-rolls a map's terrain variants as one undoable step (ADR 0400)", () => {
    const { scene, id, map } = newMap();
    brushTerrain.value = "V";
    stroke(map, "rect", [0, 0], [19, 0]);
    commitTilemap(scene, [id], map);
    const cells = (m: Tilemap) => Array.from({ length: 20 }, (_, x) => m.getTile(x, 0));
    const before = cells(map);
    const seed = map.variantSeed;
    rerollVariants(scene, [id], map);
    const live = () => scene.sync.nodeFor([id])!.getBehavior(Tilemap)!;
    expect(live().variantSeed).not.toBe(seed);
    expect(scene.doc.fieldValue(id, "engine.Tilemap", "variantSeed", 0)).toBe(live().variantSeed);
    const after = cells(live());
    expect(after).not.toEqual(before);
    expect(after.every((t) => t === 30 || t === 31)).toBe(true);
    expect(scene.stack.undoLabel).toBe("Re-roll tile variants");
    scene.stack.undo();
    expect(cells(live())).toEqual(before);
    expect(live().variantSeed).toBe(seed);
  });

  it("commits a stroke as one undoable step, and undo puts the World back", () => {
    const { scene, id, map } = newMap();
    stroke(map, "pencil", [0, 0], [4, 0]);
    expect(map.getTile(4, 0)).toBe(1);
    commitTilemap(scene, [id], map);
    const saved = scene.doc.fieldValue(id, "engine.Tilemap", "layers", 0) as { chunks: Record<string, string> }[];
    expect(saved[0].chunks["0,0"]).toMatch(/^1\*5,0\*251$/);
    expect(scene.stack.undoLabel).toBe("Paint tiles");
    scene.stack.undo();
    expect(scene.sync.nodeFor([id])!.getBehavior(Tilemap)!.getTile(0, 0)).toBe(0);
    scene.stack.redo();
    // Undo and redo may rebuild the node, so look the component up again.
    expect(scene.sync.nodeFor([id])!.getBehavior(Tilemap)!.getTile(2, 0)).toBe(1);
    // Committing again with nothing changed adds no step.
    commitTilemap(scene, [id], scene.sync.nodeFor([id])!.getBehavior(Tilemap)!, "Again");
    expect(scene.stack.undoLabel).toBe("Paint tiles");
  });

  it("paints a stroke in the scene view as one undo step, and Escape mid-stroke puts it back (ADR 0231)", () => {
    const { scene, id } = newMap();
    const view = sceneViewTools(engine);
    try {
      editor.scene.selection.set([id]);
      pickBrushTool("pencil");
      // The fake surface's camera looks along +z: the canvas point (400 + 100x, 300 - 100y) is the world point (x, y).
      const pointer = (type: string, x: number) =>
        view.canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: 400 + 100 * x, clientY: 300 - 100 * 0.5, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 }));
      const live = () => scene.sync.nodeFor([id])!.getBehavior(Tilemap)!;
      const steps = scene.stack.allStates.length;
      pointer("pointerdown", 0.5);
      pointer("pointermove", 1.5);
      pointer("pointermove", 2.5);
      pointer("pointerup", 2.5);
      expect([0, 1, 2].map((x) => live().getTile(x, 0))).toEqual([1, 1, 1]);
      expect(scene.stack.allStates.length).toBe(steps + 1);
      expect(scene.stack.undoLabel).toBe("Paint tiles");
      pointer("pointerdown", 4.5);
      pointer("pointermove", 6.5);
      expect(live().getTile(6, 0)).toBe(1); // shown while the stroke goes on
      view.window.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
      expect(live().getTile(6, 0)).toBe(0);
      expect(live().getTile(2, 0)).toBe(1);
      expect(scene.stack.allStates.length).toBe(steps + 1);
      expect(brushTool.value).toBe("pencil"); // Escape ended the stroke, not painting
    } finally {
      pickBrushTool(null);
      editor.scene.selection.set([]);
      view.stop();
    }
  });

  it("paints stamps, fills, erases, picks and paints terrains", () => {
    const { map } = newMap();
    brushStamp.value = { width: 2, height: 2, values: [1, 2, 2, 1] };
    stroke(map, "pencil", [0, 0], [2, 0]); // stamps at 0 and 2
    expect([map.getTile(0, 0), map.getTile(1, 0), map.getTile(0, 1), map.getTile(3, 1)]).toEqual([1, 2, 2, 1]);
    brushFlags.value = FLIP_X;
    expect(stroke(map, "pick", [0, 0], [1, 0])).toBe(false);
    expect(brushStamp.value).toEqual({ width: 2, height: 1, values: [1, 2] });
    expect(brushFlags.value).toBe(0);
    brushStamp.value = { width: 1, height: 1, values: [2] };
    stroke(map, "fill", [6, 3]); // empty space: bounded by the tiles and the click, plus a margin of one cell
    expect(map.getTile(6, 3)).toBe(2);
    expect(map.getTile(7, 4)).toBe(2);
    expect(map.getTile(8, 5)).toBe(0); // outside the bounds
    expect(map.getTile(0, 0)).toBe(1); // a different region
    stroke(map, "erase", [0, 0]);
    expect(map.getTile(0, 0)).toBe(0);
    brushTerrain.value = "G";
    map.clearAll();
    stroke(map, "pencil", [0, 5], [2, 5]);
    expect([map.getTile(0, 5), map.getTile(1, 5), map.getTile(2, 5)]).toEqual([11, 12, 13]);
  });

  it("on a hexagonal map, flips tiles but not a stamp's layout, doesn't turn, and fills across every side (ADR 0437)", () => {
    const { map } = newMap();
    map.gridShape = "hexagonal";
    brushStamp.value = { width: 2, height: 1, values: [1, 2] };
    flipBrush("rotate", map);
    expect(brushFlags.value).toBe(0);
    flipBrush("x", map);
    expect(footprintAt("pencil", [0, 0], map)).toEqual({ x0: 0, y0: 0, x1: 2, y1: 1 });
    stroke(map, "pencil", [0, 0]);
    expect(block(map, 0, 0, 2, 1)).toEqual([[cellValue(1, FLIP_X), cellValue(2, FLIP_X)]]);
    // A turn picked elsewhere (the palette) keeps only its flips on a hexagonal map: no tile is turned diagonally.
    brushFlags.value = TURN;
    stroke(map, "pencil", [0, 4]);
    expect(block(map, 0, 4, 2, 1)).toEqual([[cellValue(1, TURN & ~FLIP_DIAGONAL), cellValue(2, TURN & ~FLIP_DIAGONAL)]]);
    // (0, 10) and its north-west neighbour (-1, 11) share a side on the hexagonal grid, though not in offset coordinates.
    brushFlags.value = 0;
    map.setTile(0, 10, 3);
    map.setTile(-1, 11, 3);
    brushStamp.value = { width: 1, height: 1, values: [4] };
    stroke(map, "fill", [0, 10]);
    expect([map.getTile(0, 10), map.getTile(-1, 11)]).toEqual([4, 4]);
  });

  /**
   * The map's tiles as `id@dx,dy`: each tile's centre (Tilemap.cellToLocal) relative to tile 1's, so two sets of cells
   * compare equal when they have the same shape on screen wherever they are.
   */
  const shapeOf = (map: Tilemap): string[] => {
    const cells = [...map.tiles(0)];
    const one = cells.find((t) => t.id === 1)!;
    const o = map.cellToLocal(one.x, one.y);
    return cells
      .map((t) => {
        const p = map.cellToLocal(t.x, t.y);
        return `${t.id}@${(p.x - o.x).toFixed(4)},${(p.y - o.y).toFixed(4)}`;
      })
      .sort();
  };

  const LATTICE_GRIDS = (["staggered", "hexagonal"] as const).flatMap((shape) =>
    (["y", "x"] as const).flatMap((axis) => (["odd", "even"] as const).map((index) => ({ shape, axis, index }))),
  );
  for (const { shape, axis, index } of LATTICE_GRIDS) {
    it(`keeps a picked stamp's shape painted an odd number of rows or columns away on a ${shape} map (axis ${axis}, ${index}) (ADR 0444)`, () => {
      const { map } = newMap();
      map.gridShape = shape;
      map.staggerAxis = axis;
      map.staggerIndex = index;
      // A 2 × 2 block of four tiles, picked with its bottom-left on (2, 2).
      map.setTile(2, 2, 1);
      map.setTile(3, 2, 2);
      map.setTile(2, 3, 3);
      map.setTile(3, 3, 4);
      const picked = shapeOf(map);
      stroke(map, "pick", [2, 2], [3, 3]);
      expect(brushStamp.value).toEqual({ width: 2, height: 2, values: [1, 2, 3, 4] });
      for (const at of [[5, 5], [6, 6], [5, 6], [-3, 0]] as Cell[]) {
        map.clearAll();
        const footprint = footprintAt("pencil", at, map);
        stroke(map, "pencil", at);
        expect(shapeOf(map)).toEqual(picked);
        // The footprint is the cells painted.
        const painted = [...map.tiles(0)].map((t) => `${t.x},${t.y}`).sort();
        expect(footprint.cells?.map(([x, y]) => `${x},${y}`).sort()).toEqual(painted);
      }
      // Laid out cell for cell (a palette block, no frame), the same block an odd number of rows (columns) away has another shape.
      brushFrame.value = null;
      map.clearAll();
      stroke(map, "pencil", [5, 5]);
      expect(shapeOf(map)).not.toEqual(picked);
    });
  }

  it("tiles a picked stamp over a rectangle on a staggered map, every placement keeping its shape (ADR 0444)", () => {
    const { map } = newMap();
    map.gridShape = "staggered";
    // A 1 × 2 column, 1 below 2, picked from an unshifted row.
    map.setTile(0, 0, 1);
    map.setTile(0, 1, 2);
    const a = map.cellToLocal(0, 0), b = map.cellToLocal(0, 1);
    stroke(map, "pick", [0, 0], [0, 1]);
    map.clearAll();
    // From row 1 (a shifted row), four columns wide and two rows high: the stamp's pattern fills the rectangle, row 1
    // with 1s and row 2 with 2s, each 1's 2 where the picked stamp had it (the last column's lies outside the rectangle).
    stroke(map, "rect", [0, 1], [3, 2]);
    const twos = [...map.tiles(0)].filter((t) => t.id === 2).map((t) => map.cellToLocal(t.x, t.y));
    expect(twos).toHaveLength(4);
    for (let x = 0; x <= 3; x++) expect(map.getTile(x, 1)).toBe(1);
    for (let x = 0; x <= 2; x++) {
      const p = map.cellToLocal(x, 1);
      expect(twos.some((q) => Math.abs(q.x - p.x - (b.x - a.x)) < 1e-6 && Math.abs(q.y - p.y - (b.y - a.y)) < 1e-6)).toBe(true);
    }
  });

  it("paints square and isometric stamps cell for cell, with a rectangle footprint (ADR 0444)", () => {
    for (const shape of ["square", "isometric"] as const) {
      const { map } = newMap();
      map.gridShape = shape;
      map.setTile(2, 2, 1);
      map.setTile(3, 3, 4);
      stroke(map, "pick", [2, 2], [3, 3]);
      expect(brushFrame.value).toBeNull();
      map.clearAll();
      expect(footprintAt("pencil", [5, 6], map)).toEqual({ x0: 5, y0: 6, x1: 7, y1: 8 });
      stroke(map, "pencil", [5, 6]);
      expect([map.getTile(5, 6), map.getTile(6, 7)]).toEqual([1, 4]);
    }
  });
});
