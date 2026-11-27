// The tile editor's next tier in the editor (ADR 0441, 0442): locked layers, stamps of several layers, the editor
// clipboard across tilesets, the selection tool's operations as undo steps, Replace with… and the prefab brush.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, type AssetSource } from "../../../engine";
import { FLIP_X, Tilemap } from "../runtime";
import { cellValue, newLayer } from "../runtime/format";
import { useEditorPlugins } from "../../testEditorPlugins";
import { tilemapsEditorPlugin } from ".";
import { openSceneFile } from "../../../editor/project";
import { editor, type OpenScene } from "../../../editor/sdk";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew, sceneViewTools } from "../../../editor/testing";
import { activeLayer, beginStroke, brushFlags, brushFrame, brushLayers, brushPrefabs, brushRandom, brushSource, brushStamp, brushTerrain, chooseBlock, choosePrefabs, commitTilemap, pickBrushTool, type BrushTool } from "./brush";
import { commitPrefabStroke } from "./prefabBrush";
import { replaceTileIn } from "./palette";
import { clearTileSelection, copyTiles, cutTiles, deleteTiles, moveTiles, selectAllLayers, selectAllUsed, selectCells, selectionOf, transformTiles } from "./tileSelection";
import type { Cell } from "../runtime/brushes";
import { parseTileset } from "../runtime/tileset";
import { copySelection } from "./selectionLogic";
import { decodeStamp, encodeStamp, withStamp } from "./stampLibrary";
import { tilesetFormat } from "./tilesetFormat";

const tiles = (uuids: string[]) => uuids.map((uuid, i) => ({ id: i + 1, uuid, sprite: "" }));
const TILESET = { format: "myco.tileset@1", tileSize: [16, 16], tiles: tiles(["u1", "u2", "u3", "u4"]) };
/** Another tileset with two of the same tiles under other ids. */
const OTHER = { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 9, uuid: "u2", sprite: "" }, { id: 8, uuid: "u1", sprite: "" }] };
const PIPE = "prefabs/pipe-pair.prefab.json"; // the sample's

describe("tile editing in the editor (ADR 0441, 0442)", () => {
  useEditorPlugins([tilemapsEditorPlugin]);
  let engine: Engine;
  let source: AssetSource;
  beforeEach(async () => {
    source = Assets.fromObject({ "t.tileset.json": TILESET, "o.tileset.json": OTHER });
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    Assets.addSource(source);
    openSceneFile(engine, DEMO_SCENE);
    brushStamp.value = { width: 1, height: 1, values: [1] };
    brushLayers.value = null;
    brushFrame.value = null;
    brushSource.value = null;
    brushPrefabs.value = [];
    brushRandom.value = false;
    brushTerrain.value = null;
    brushFlags.value = 0;
    activeLayer.value = 0;
    selectAllLayers.value = false;
    clearTileSelection();
  });
  afterEach(() => {
    pickBrushTool(null);
    editor.scene.selection.set([]);
    Assets.removeSource(source);
    engine.dispose();
  });

  function newMap(tileset = "t.tileset.json") {
    const scene = editor.scene.peekOpen()!;
    const id = insertNew(scene, "tilemap", { asset: `asset:${tileset}` });
    const live = () => scene.sync.nodeFor([id])!.getBehavior(Tilemap)!;
    live().layers = [newLayer("Ground"), newLayer("Top")];
    commitTilemap(scene, [id], live(), "Layers");
    editor.scene.selection.set([id]);
    return { scene, id, live };
  }
  const stroke = (map: Tilemap, tool: BrushTool, ...cells: Cell[]): boolean => {
    const s = beginStroke(map, tool, cells[0]!);
    for (const c of cells.slice(1)) s.moveTo(c);
    return s.finish();
  };
  const lock = (map: Tilemap, layer: number) => (map.layers = map.toLayerData().map((l, i) => (i === layer ? { ...l, locked: true } : l)));

  it("skips a locked layer with every brush and the eyedropper", () => {
    const { live } = newMap();
    live().setTile(5, 5, 2);
    lock(live(), 0);
    for (const tool of ["pencil", "rect", "fill", "erase"] as const) expect(stroke(live(), tool, [0, 0], [1, 0])).toBe(false);
    expect(live().getTile(0, 0)).toBe(0);
    expect(live().getTile(5, 5)).toBe(2);
    // The eyedropper's drag doesn't pick from it either.
    stroke(live(), "pick", [5, 5]);
    expect(brushStamp.value.values).toEqual([1]);
    // Another layer paints as usual.
    activeLayer.value = 1;
    stroke(live(), "pencil", [0, 0]);
    expect(live().getTile(0, 0, 1)).toBe(1);
  });

  it("pastes a stamp of several layers into the layers of the same names, skipping locked ones", () => {
    const { live } = newMap();
    const ts = live().tilesetAsset;
    chooseBlock({ width: 2, height: 1, layers: [{ name: "Top", values: [3, 0] }, { name: "Ground", values: [1, 2] }, { name: "Missing", values: [4, 4] }] }, ts);
    stroke(live(), "pencil", [0, 0]);
    expect([live().getTile(0, 0, "Ground"), live().getTile(1, 0, "Ground"), live().getTile(0, 0, "Top"), live().getTile(1, 0, "Top")]).toEqual([1, 2, 3, 0]);
    lock(live(), 1);
    stroke(live(), "pencil", [4, 0]);
    expect([live().getTile(4, 0, "Ground"), live().getTile(4, 0, "Top")]).toEqual([1, 0]);
  });

  it("pastes a stamp copied from a map with another tileset by tile uuid, skipping tiles it lacks", () => {
    const a = newMap();
    a.live().setTile(0, 0, 1);
    a.live().setTile(1, 0, 2, 0, FLIP_X);
    a.live().setTile(2, 0, 3);
    selectCells(a.live(), [0, 0], [2, 0], "replace");
    expect(copyTiles()).toBe(true);
    const b = newMap("o.tileset.json");
    stroke(b.live(), "pencil", [0, 0]);
    expect([b.live().getCell(0, 0), b.live().getCell(1, 0), b.live().getCell(2, 0)]).toEqual([8, cellValue(9, FLIP_X), 0]);
    expect(brushSource.value?.tileByUuid("u3")).toBeDefined(); // the brush still holds the first map's tiles
  });

  it("copies, cuts, deletes, moves and flips the selection, each as one undo step", () => {
    const { scene, id, live } = newMap();
    live().setTile(0, 0, 1);
    live().setTile(1, 0, 2);
    live().setTile(0, 0, 3, "Top");
    commitTilemap(scene, [id], live(), "Setup");
    const steps = () => scene.stack.allStates.length;
    const at = steps();

    selectAllUsed(live());
    expect(selectionOf(live()).size).toBe(2);
    transformTiles("x");
    expect([live().getCell(0, 0), live().getCell(1, 0)]).toEqual([cellValue(2, FLIP_X), cellValue(1, FLIP_X)]);
    expect(scene.stack.undoLabel).toBe("Flip tiles");
    expect(steps()).toBe(at + 1);

    moveTiles(0, 3, false);
    expect(scene.stack.undoLabel).toBe("Move tiles");
    expect(live().getTile(0, 3)).toBe(2);
    expect(live().getTile(0, 0)).toBe(0);
    expect(live().getTile(0, 0, "Top")).toBe(3); // the active layer only
    expect(steps()).toBe(at + 2);

    cutTiles();
    expect(scene.stack.undoLabel).toBe("Cut tiles");
    expect(live().cellBounds(0)).toBeNull();
    expect(brushStamp.value).toEqual({ width: 2, height: 1, values: [cellValue(2, FLIP_X), cellValue(1, FLIP_X)] });

    scene.stack.undo();
    expect(live().getTile(1, 3)).toBe(1);
    // All layers: delete empties both layers (an unlocked one), in one step.
    selectAllLayers.value = true;
    selectCells(live(), [0, 0], [1, 3], "replace");
    deleteTiles();
    expect(scene.stack.undoLabel).toBe("Delete tiles");
    expect(live().cellBounds()).toBeNull();
    scene.stack.undo();
    expect(live().getTile(0, 0, "Top")).toBe(3);
    // A locked layer is left alone with All layers.
    lock(live(), 1);
    selectCells(live(), [0, 0], [1, 3], "replace");
    deleteTiles();
    expect(live().getTile(0, 0, "Top")).toBe(3);
    expect(live().cellBounds(0)).toBeNull();
  });

  it("selects with the scene view's select tool, and deletes with the Delete key, as one undo step", () => {
    const { scene, id, live } = newMap();
    live().fillRect(0, 0, 4, 1, 1);
    commitTilemap(scene, [id], live(), "Setup");
    const view = sceneViewTools(engine);
    try {
      pickBrushTool("select");
      const pointer = (type: string, x: number) =>
        view.canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: 400 + 100 * x, clientY: 300 - 100 * 0.5, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 }));
      const steps = scene.stack.allStates.length;
      pointer("pointerdown", 1.5);
      pointer("pointermove", 2.5);
      pointer("pointerup", 2.5);
      expect([...selectionOf(live())].sort()).toEqual(["1,0", "2,0"]);
      expect(scene.stack.allStates.length).toBe(steps); // selecting isn't an edit
      view.window.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Delete" }));
      expect([0, 1, 2, 3].map((x) => live().getTile(x, 0))).toEqual([1, 0, 0, 1]);
      expect(scene.stack.allStates.length).toBe(steps + 1);
      // Escape selects nothing; the tool stays.
      view.window.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
      expect(selectionOf(live()).size).toBe(0);
    } finally {
      view.stop();
    }
  });

  it("replaces a tile in the active layer, every layer or every Tilemap of the scene with the tileset, in one undo step", () => {
    const a = newMap();
    a.live().setTile(0, 0, 1);
    a.live().setTile(0, 0, 1, "Top", FLIP_X);
    commitTilemap(a.scene, [a.id], a.live(), "Setup");
    const b = newMap();
    b.live().setTile(3, 3, 1);
    commitTilemap(b.scene, [b.id], b.live(), "Setup");
    const other = newMap("o.tileset.json");
    other.live().setTile(0, 0, 8);
    commitTilemap(other.scene, [other.id], other.live(), "Setup");
    editor.scene.selection.set([a.id]);

    expect(replaceTileIn(a.scene, [a.id], a.live(), 1, 2, "layer", 0)).toBe(1);
    expect(a.live().getTile(0, 0, "Top")).toBe(1);
    a.scene.stack.undo();
    const steps = a.scene.stack.allStates.length;
    expect(replaceTileIn(a.scene, [a.id], a.live(), 1, 2, "scene", 0)).toBe(3);
    expect(a.scene.stack.allStates.length).toBe(steps + 1);
    expect(a.scene.stack.undoLabel).toBe("Replace tile");
    expect(a.live().getCell(0, 0, "Top")).toBe(cellValue(2, FLIP_X));
    expect(b.live().getTile(3, 3)).toBe(2);
    expect(other.live().getTile(0, 0)).toBe(8);
    a.scene.stack.undo();
    expect(b.live().getTile(3, 3)).toBe(1);
    expect(a.live().getTile(0, 0)).toBe(1);
  });

  it("places and erases prefab instances under the Tilemap, one per cell, each stroke one undo step", () => {
    const { scene, id, live } = newMap();
    choosePrefabs([PIPE]);
    const instances = () => scene.doc.children(id).filter((c) => scene.doc.node(c).prefab === PIPE);
    const steps = scene.stack.allStates.length;
    expect(commitPrefabStroke(scene, [id], live(), "paint", [[0, 0], [1, 0], [1, 0]], "Paint prefabs")).toEqual({ added: 2, removed: 0 });
    expect(scene.stack.allStates.length).toBe(steps + 1);
    expect(instances()).toHaveLength(2);
    const cells = instances().map((c) => {
      const p = scene.sync.nodeFor([c])!.transform!.position;
      const cell = live().localToCell(p);
      return [cell.x, cell.y, p.x, p.y];
    });
    expect(cells).toEqual([
      [0, 0, 0.5, 0.5],
      [1, 0, 1.5, 0.5],
    ]);
    // Painting the same cells again changes nothing; erasing removes the instance in the cell.
    expect(commitPrefabStroke(scene, [id], live(), "paint", [[0, 0]], "Paint prefabs")).toEqual({ added: 0, removed: 0 });
    expect(commitPrefabStroke(scene, [id], live(), "erase", [[1, 0], [5, 5]], "Erase prefabs")).toEqual({ added: 0, removed: 1 });
    expect(instances()).toHaveLength(1);
    scene.stack.undo();
    expect(instances()).toHaveLength(2);
    scene.stack.undo();
    expect(instances()).toHaveLength(0);
  });

  /** Gives the map a staggered or hexagonal grid, written to the scene. */
  function setGrid(scene: OpenScene, id: string, shape: "staggered" | "hexagonal", axis: "x" | "y", index: "odd" | "even") {
    const place = { scene, path: [id], type: "engine.Tilemap" };
    editor.scene.edit("Grid", () => {
      editor.scene.writeField(place, "gridShape", shape);
      editor.scene.writeField(place, "staggerAxis", axis);
      editor.scene.writeField(place, "staggerIndex", index);
    }, scene);
  }
  /** The map's tiles as `id@dx,dy`: each tile's centre (Tilemap.cellToLocal) relative to tile 1's: equal for the same shape wherever it is. */
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
  const GRIDS = (["staggered", "hexagonal"] as const).flatMap((shape) => (["y", "x"] as const).flatMap((axis) => (["odd", "even"] as const).map((index) => ({ shape, axis, index }))));

  for (const { shape, axis, index } of GRIDS) {
    it(`keeps the shape of a copied stamp, and of a saved one read back, on a ${shape} map (axis ${axis}, ${index}) (ADR 0444)`, () => {
      const { scene, id, live } = newMap();
      setGrid(scene, id, shape, axis, index);
      expect(live().gridShape).toBe(shape);
      live().setTile(0, 0, 1);
      live().setTile(1, 0, 2);
      live().setTile(0, 1, 3);
      live().setTile(1, 1, 4);
      const copied = shapeOf(live());
      selectCells(live(), [0, 0], [1, 1], "replace");
      expect(copyTiles()).toBe(true);
      const saved = encodeStamp("Block", copySelection(live(), selectionOf(live()), [0])!, live().tilesetAsset!);
      live().clearAll();
      stroke(live(), "pencil", [3, 3]);
      expect(shapeOf(live())).toEqual(copied);

      // Saved in the tileset file and read back, it paints the same shape an odd number of rows and columns away.
      const data = withStamp(parseTileset({ format: "myco.tileset@1", tiles: [] }).tileset, saved);
      const read = tilesetFormat.parse(JSON.parse(tilesetFormat.format(data)), "t.tileset.json").value.stamps![0]!;
      chooseBlock(decodeStamp(read, live().tilesetAsset!).block, live().tilesetAsset);
      for (const at of [[5, 5], [4, 7]] as Cell[]) {
        live().clearAll();
        stroke(live(), "pencil", at);
        expect(shapeOf(live())).toEqual(copied);
      }

      // A stamp saved before ADR 0444 (no frame) still lands cell for cell, as it did.
      const { stagger: _, ...old } = read;
      chooseBlock(decodeStamp(old, live().tilesetAsset!).block, live().tilesetAsset);
      live().clearAll();
      stroke(live(), "pencil", [5, 5]);
      expect([live().getTile(5, 5), live().getTile(6, 5), live().getTile(5, 6), live().getTile(6, 6)]).toEqual([1, 2, 3, 4]);
    });
  }

  it("moves the selection an odd number of rows on a staggered map keeping its shape, as one undo step (ADR 0444)", () => {
    const { scene, id, live } = newMap();
    setGrid(scene, id, "staggered", "y", "odd");
    live().setTile(0, 0, 1);
    live().setTile(1, 0, 2);
    live().setTile(0, 1, 3);
    commitTilemap(scene, [id], live(), "Setup");
    const before = shapeOf(live());
    const steps = scene.stack.allStates.length;
    selectAllUsed(live());
    // Dragged by the cell holding tile 3 up three rows: it lands under the pointer and the rest keep their places around it.
    expect(moveTiles(0, 3, false, [0, 1])).toBe(true);
    expect(scene.stack.undoLabel).toBe("Move tiles");
    expect(scene.stack.allStates.length).toBe(steps + 1);
    expect(live().getTile(0, 4)).toBe(3);
    expect(shapeOf(live())).toEqual(before);
    expect(selectionOf(live())).toEqual(new Set([...live().tiles(0)].map((t) => `${t.x},${t.y}`)));
  });
});
