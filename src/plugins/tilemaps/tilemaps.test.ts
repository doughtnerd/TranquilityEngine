// The Tilemaps plugin (ADR 0103, 0134, 0135, 0136): its runtime half claims the Tilemap Component and the tile
// render feature; its editor half registers the tileset kind and format, and tilesets edit through an asset document.
import { afterEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../../engine/core/registry";
import { byPhase } from "../../engine/render/renderFeatures";
import { assetKind } from "../../editor/assetBrowser";
import { assetDocumentsDeleted, assetDocumentsMoved, openAssetDocument } from "../../editor/assetDocuments";
import { inspectedAsset } from "../../editor/assetImport";
import { select as selectAssets } from "../../editor/assetSelection";
import { kindIcon, kindLabel, registeredKind, satisfiesFieldKind } from "../../editor/assetKindLookup";
import { joinPath, openFolderProject } from "../../editor/projects";
import { assetKinds, panels, viewportTools } from "../../editor/sdk/contributions";
import type { Engine } from "../../engine";
import { brushTool, pickBrushTool } from "./editor/brush";
import { isPluginActive } from "../../editor/sdk/plugins";
import { useEditorPlugins } from "../testEditorPlugins";
import { currentProject, pickTool } from "../../editor/state";
import { editor } from "../../editor/sdk";
import { inspectorSectionsFor, MemoryFileSystem, ROOT, sceneViewTools, useCoreAssetKinds } from "../../editor/testing";
import { EDITOR_PLUGINS } from "../editor";
import { RUNTIME_PLUGINS, isRuntimePluginActive } from "../runtime";
import { applyTestPlugins } from "../testPlugins";
import { MESHES_SPEC } from "../meshes/runtime";
import { tilemapsEditorPlugin } from "./editor";
import { parsePolygon } from "./editor/polygonText";
import { Tilemap, tilemapsRuntimePlugin } from "./runtime";
import { _registeredRenderFeatures } from "../../engine/render/renderFeatures";
import { newTileset, type TilesetData } from "./runtime/tileset";

/** A plugin's render feature spec, as its activation registered it. */
const registeredSpec = (name: string) => _registeredRenderFeatures().find((f) => f.spec.name === name)!.spec;
const SPRITES_SPEC = registeredSpec("sprites");
const TILEMAPS_SPEC = registeredSpec("tilemaps");

/** The paint tool's id: also its active-tool id. */
const PAINT_TOOL_ID = "myco.tilemaps.paint";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const TILESET = "tiles/ground.tileset.json";

async function open(files: Record<string, string>) {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  for (const [p, text] of Object.entries(files)) fs.files.set(joinPath(ROOT, p), text);
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return { project, fs };
}

/** A tileset's file text, written by the kind's format. */
const formatTileset = (data: TilesetData): string => assetKinds.get("tileset")!.format!.format(data);
const tileset = (tiles: number, tileSize: [number, number] = [16, 16]): TilesetData => ({
  ...newTileset(),
  tileSize,
  tiles: Array.from({ length: tiles }, (_, i) => ({ id: i + 1, sprite: `asset:images/t.png#t_${i}`, collision: "none" as const })),
});

describe("the Tilemaps plugin's runtime half (ADR 0135)", () => {
  it("is listed with its editor half, sharing one manifest", () => {
    expect(RUNTIME_PLUGINS).toContain(tilemapsRuntimePlugin);
    expect(EDITOR_PLUGINS).toContain(tilemapsEditorPlugin);
    expect(tilemapsRuntimePlugin.manifest).toBe(tilemapsEditorPlugin.manifest);
    expect(tilemapsRuntimePlugin.manifest.name).toBe("myco.tilemaps");
  });

  it("claims the Tilemap Component and registers the tiles render feature, ordered after sprites (ADR 0136)", () => {
    expect(isRuntimePluginActive("myco.tilemaps")).toBe(true);
    expect(getComponentClass("engine.Tilemap")).toBe(Tilemap);
    expect(TILEMAPS_SPEC).toMatchObject({ phase: "content", types: [Tilemap], lazy: false, after: ["sprites"] });
    // The order is kept: sprites, tilemaps, meshes (meshes name tilemaps in their own `after`).
    const specs = [SPRITES_SPEC, MESHES_SPEC, TILEMAPS_SPEC];
    expect(byPhase(specs).map((i) => specs[i]!.name)).toEqual(["sprites", "tilemaps", "meshes"]);
  });

  it("unregisters the Component when deactivated, and registers it again when activated", () => {
    applyTestPlugins(["myco.tilemaps"]);
    try {
      expect(getComponentClass("engine.Tilemap")).toBeUndefined();
      expect(_registeredRenderFeatures().some((r) => r.spec.name === "tilemaps")).toBe(false);
    } finally {
      applyTestPlugins();
    }
    expect(getComponentClass("engine.Tilemap")).toBe(Tilemap);
  });
});

describe("the Tilemaps plugin's editor half (ADR 0134)", () => {
  const editorHalf = useEditorPlugins([tilemapsEditorPlugin], "each");
  afterEach(() => {
    currentProject.value = null;
  });

  it("registers the Tile Palette panel, the paint tool and the Tilemap's Inspector section, and removes them (ADR 0138)", () => {
    expect(panels.get("tilepalette")).toMatchObject({ title: "Tile Palette", beside: "code" });
    expect(viewportTools.get(PAINT_TOOL_ID)).toBeDefined();
    expect(inspectorSectionsFor("engine.Tilemap", [["root"]])).toHaveLength(1);
    editorHalf.off();
    expect(panels.get("tilepalette")).toBeUndefined();
    expect(viewportTools.get(PAINT_TOOL_ID)).toBeUndefined();
    expect(inspectorSectionsFor("engine.Tilemap", [["root"]])).toHaveLength(0);
  });

  it("makes the brush the paint tool's mode (ADR 0231): picking one activates the tool, which another tool ends", () => {
    const view = sceneViewTools({ world: {} } as unknown as Engine);
    const canvas = view.canvas;
    const dispose = view.stop;
    try {
      pickBrushTool("pencil");
      expect(editor.viewport.activeTool).toBe(PAINT_TOOL_ID);
      expect(editor.viewport.mode(PAINT_TOOL_ID).value).toBe("pencil");
      expect(canvas.style.cursor).toBe("crosshair");
      pickTool("move"); // Q/W/E/R or the toolbar
      expect(brushTool.value).toBeNull();
      pickBrushTool("rect");
      pickBrushTool(null);
      expect(editor.viewport.activeTool).toBeNull();
      pickBrushTool("fill");
    } finally {
      dispose();
    }
    expect(editor.viewport.activeTool).toBeNull(); // uninstalled with the scene view, which ends the brush
    expect(brushTool.value).toBeNull();
  });

  it("registers the tileset asset kind: matching, label, icon, inspector and tileset fields", () => {
    expect(assetKind(TILESET)).toBe("tileset");
    expect(assetKind("Ground.TILESET.JSON")).toBe("tileset");
    expect(assetKind("tiles/data.json")).toBe("json");
    expect(kindLabel("tileset")).toBe("Tileset");
    expect(kindIcon("tileset")).toMatch(/^M/);
    expect(inspectedFor(TILESET)).toBe(TILESET);
    expect(satisfiesFieldKind("tileset", TILESET)).toBe(true);
    expect(satisfiesFieldKind("material", TILESET)).toBe(false);
    expect(assetKinds.get("tileset")?.referencedAs).toEqual(["tileset"]);
  });

  it("declares a format that round-trips a tileset and reports problems as messages", async () => {
    const { project } = await open({ [TILESET]: '"nope"' });
    const format = assetKinds.get("tileset")!.format!;
    const ts = tileset(3, [8, 12]);
    const read = format.parse(JSON.parse(formatTileset(ts)), TILESET);
    expect(read.problems).toEqual([]);
    expect(read.value.tiles).toHaveLength(3);
    expect(format.format(read.value)).toBe(formatTileset(ts));
    expect(format.writeDelay).toBe(150);
    const bad = editor.assets.read(project, TILESET);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(Object.keys(bad.problems[0]!)).toEqual(["message"]);
  });

  it("makes one write per edit, and an undo step each", async () => {
    const { project, fs } = await open({ [TILESET]: formatTileset(tileset(1)) });
    const doc = openAssetDocument<TilesetData>(project, TILESET, "tileset");
    const writes: string[] = [];
    const writeText = project.writeText.bind(project);
    project.writeText = (path, text) => (writes.push(path), writeText(path, text));
    doc.edit({ ...doc.value.value, tileSize: [32, 32] });
    await doc.flush();
    expect(writes).toEqual([TILESET]);
    expect(JSON.parse(fs.files.get(joinPath(ROOT, TILESET)) as string).tileSize).toEqual([32, 32]);
    doc.edit({ ...doc.value.value, anchor: [0.5, 0] });
    await doc.flush();
    expect(doc.canUndo.value).toBe(true);
    doc.undo();
    await doc.flush();
    expect(JSON.parse(fs.files.get(joinPath(ROOT, TILESET)) as string).anchor).toBeUndefined();
    expect(JSON.parse(fs.files.get(joinPath(ROOT, TILESET)) as string).tileSize).toEqual([32, 32]);
    doc.redo();
    await doc.flush();
    expect(JSON.parse(fs.files.get(joinPath(ROOT, TILESET)) as string).anchor).toEqual([0.5, 0]);
  });

  it("merges a coalesced run of edits into one undo step and one write", async () => {
    const { project, fs } = await open({ [TILESET]: formatTileset(tileset(1)) });
    const doc = openAssetDocument<TilesetData>(project, TILESET, "tileset");
    let writes = 0;
    const writeText = project.writeText.bind(project);
    project.writeText = (path, text) => (writes++, writeText(path, text));
    for (const w of [20, 24, 28]) doc.edit({ ...doc.value.peek(), tileSize: [w, w] }, { coalesce: true });
    await doc.flush();
    expect(writes).toBe(1);
    expect(JSON.parse(fs.files.get(joinPath(ROOT, TILESET)) as string).tileSize).toEqual([28, 28]);
    doc.undo();
    await doc.flush();
    expect(JSON.parse(fs.files.get(joinPath(ROOT, TILESET)) as string).tileSize).toEqual([16, 16]);
    expect(doc.canUndo.value).toBe(false);
  });

  it("keeps its history across a rename and drops it on delete", async () => {
    const { project } = await open({ [TILESET]: formatTileset(tileset(1)) });
    const doc = openAssetDocument<TilesetData>(project, TILESET, "tileset");
    doc.edit({ ...doc.value.value, tileSize: [32, 32] });
    await doc.flush();
    assetDocumentsMoved([[TILESET, "tiles/renamed.tileset.json"]]);
    expect(doc.path).toBe("tiles/renamed.tileset.json");
    expect(openAssetDocument<TilesetData>(project, "tiles/renamed.tileset.json", "tileset")).toBe(doc);
    expect(doc.canUndo.value).toBe(true);
    assetDocumentsDeleted(["tiles/renamed.tileset.json"]);
    // A file at the same path afterwards starts with no history.
    expect(openAssetDocument<TilesetData>(project, "tiles/renamed.tileset.json", "tileset").canUndo.value).toBe(false);
  });

  it("says a read-only project can't be edited, and writes nothing", async () => {
    const { project, fs } = await open({ [TILESET]: formatTileset(tileset(1)) });
    Object.defineProperty(project, "canSave", { value: false });
    const doc = openAssetDocument<TilesetData>(project, TILESET, "tileset");
    doc.edit({ ...doc.value.value, tileSize: [32, 32] });
    await doc.flush();
    expect(doc.readOnly).toBe(true);
    expect(fs.files.get(joinPath(ROOT, TILESET))).toBe(formatTileset(tileset(1)));
  });

  it("parses polygon points", () => {
    expect(parsePolygon("0,0 1,0 1,1")).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(parsePolygon("0,0 1,0")).toBeNull();
    expect(parsePolygon("0,0 a,b 1,1")).toBeNull();
  });

  it("removes everything when deactivated", () => {
    editorHalf.off();
    expect(isPluginActive("myco.tilemaps")).toBe(false);
    expect(registeredKind("tileset")).toBeUndefined();
    expect(inspectedFor(TILESET)).toBeNull(); // a disabled plugin's files show as generic files
  });
});

/** The file the Inspector shows with `entry` alone selected in the Assets panel (null: none). */
function inspectedFor(entry: string): string | null {
  selectAssets([entry]);
  const shown = inspectedAsset.peek();
  selectAssets([]);
  return shown;
}
