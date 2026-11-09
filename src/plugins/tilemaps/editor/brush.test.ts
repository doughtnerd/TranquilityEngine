import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, type AssetSource } from "../../../engine";
import { FLIP_X, FLIP_Y, FLIP_DIAGONAL, Tilemap } from "../runtime";
import { cellValue } from "../runtime/format";
import { createNode } from "../../../editor/nodeCreate";
import { useEditorPlugins } from "../../testEditorPlugins";
import { tilemapsEditorPlugin } from ".";
import { openSceneFile } from "../../../editor/project";
import { openScene } from "../../../editor/state";
import { DEMO_SCENE, demoAssets, demoSettings } from "../../../editor/testing";
import { activeLayer, brushFlags, brushRandom, brushStamp, brushTerrain, brushValueAt, combineFlags, commitTilemap, fillAt, paintCells, pickFromMap, strokeCells } from "./brush";

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
    expect(combineFlags(FLIP_X, FLIP_X)).toBe(0);
    expect(combineFlags(FLIP_X, FLIP_Y)).toBe(FLIP_X | FLIP_Y);
    const turn = FLIP_DIAGONAL | FLIP_X;
    let f = 0;
    for (let i = 0; i < 4; i++) f = combineFlags(f, turn);
    expect(f).toBe(0);
    expect(combineFlags(0, turn)).toBe(turn);
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
  // Create Tilemap is the plugin's Hierarchy create entry (ADR 0144).
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
    const scene = openScene.value!;
    const id = createNode(scene, "tilemap", { effect: "asset:t.tileset.json" });
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
