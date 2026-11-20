import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, type AssetSource } from "../../../engine";
import { FLIP_X, FLIP_Y, FLIP_DIAGONAL, Tilemap } from "../runtime";
import { cellValue } from "../runtime/format";
import { useEditorPlugins } from "../../testEditorPlugins";
import { tilemapsEditorPlugin } from ".";
import { openSceneFile } from "../../../editor/project";
import { editor } from "../../../editor/sdk";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew, sceneViewTools } from "../../../editor/testing";
import { activeLayer, brushFlags, brushRandom, brushStamp, brushTerrain, brushTool, commitTilemap, fillAt, paintCells, pickBrushTool, pickFromMap, strokeCells } from "./brush";
import { brushValueAt } from "./brushCells";
import { compose } from "../runtime/tileFlips";

const TILESET = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  terrains: [{ name: "G" }],
  tiles: [
    { id: 1, sprite: "" },
    { id: 2, sprite: "" },
    { id: 10, sprite: "", terrain: "G", pattern: "0*0*0*0*" },
    { id: 11, sprite: "", terrain: "G", pattern: "0*1*0*0*" },
    { id: 12, sprite: "", terrain: "G", pattern: "0*1*0*1*" },
    { id: 13, sprite: "", terrain: "G", pattern: "0*0*0*1*" },
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

  it("tiles a stamp from its origin, or picks at random from it", () => {
    const stamp = { width: 2, height: 1, values: [1, 2] };
    expect([0, 1, 2, 3].map((x) => brushValueAt(stamp, x, 0, [0, 0], false, 0))).toEqual([1, 2, 1, 2]);
    expect(brushValueAt(stamp, -1, 5, [0, 0], false, 0)).toBe(2);
    expect([1, 2]).toContain(brushValueAt(stamp, 0, 0, [0, 0], true, 0));
    expect(brushValueAt({ width: 1, height: 1, values: [1] }, 0, 0, [0, 0], false, FLIP_X)).toBe(cellValue(1, FLIP_X));
    expect(strokeCells("rect", [0, 0], [2, 1])).toHaveLength(6);
    expect(strokeCells("pencil", [0, 0], [3, 0])).toHaveLength(4);
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

  it("commits a stroke as one undoable step, and undo puts the World back", () => {
    const { scene, id, map } = newMap();
    paintCells(map, "pencil", strokeCells("pencil", [0, 0], [4, 0]), [0, 0]);
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
    paintCells(map, "pencil", [[0, 0], [1, 0], [2, 0]], [0, 0]); // stamps at 0 and 2
    expect([map.getTile(0, 0), map.getTile(1, 0), map.getTile(0, 1), map.getTile(3, 1)]).toEqual([1, 2, 2, 1]);
    pickFromMap(map, [0, 0], [1, 0]);
    expect(brushStamp.value).toEqual({ width: 2, height: 1, values: [1, 2] });
    brushStamp.value = { width: 1, height: 1, values: [2] };
    fillAt(map, 6, 3); // empty space: bounded by the tiles and the click, plus a margin of one cell
    expect(map.getTile(6, 3)).toBe(2);
    expect(map.getTile(7, 4)).toBe(2);
    expect(map.getTile(8, 5)).toBe(0); // outside the bounds
    expect(map.getTile(0, 0)).toBe(1); // a different region
    paintCells(map, "erase", [[0, 0]], [0, 0]);
    expect(map.getTile(0, 0)).toBe(0);
    brushTerrain.value = "G";
    map.clearAll();
    paintCells(map, "pencil", strokeCells("pencil", [0, 5], [2, 5]), [0, 5]);
    expect([map.getTile(0, 5), map.getTile(1, 5), map.getTile(2, 5)]).toEqual([11, 12, 13]);
  });
});
