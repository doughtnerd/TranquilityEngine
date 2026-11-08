// The Tilemaps plugin (ADR 0103, 0134, 0135): its runtime half claims the Tilemap Component and the tile
// render feature; its editor half registers the tileset kind and format, and tilesets edit through an asset document.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../../engine/core/registry";
import { byPhase } from "../../engine/render/renderFeatures";
import { TILEMAPS_SPEC } from "../../engine/render/babylon/features";
import { assetKind } from "../../editor/assetBrowser";
import { _reset, assetDocumentsDeleted, assetDocumentsMoved, openAssetDocument } from "../../editor/assetDocuments";
import { acceptsFile } from "../../editor/assetFieldKinds";
import { inspectableAsset } from "../../editor/assetImport";
import { kindIcon, kindLabel } from "../../editor/assetKindLookup";
import { joinPath, openFolderProject } from "../../editor/projects";
import { assetFormats, assetKinds } from "../../editor/sdk/contributions";
import { activatePlugins, deactivatePlugin, isPluginActive } from "../../editor/sdk/plugins";
import { currentProject } from "../../editor/state";
import { MemoryFileSystem, ROOT } from "../../editor/testing";
import { formatTileset } from "../../editor/tilesetAssets";
import { EDITOR_PLUGINS } from "../editor";
import { RUNTIME_PLUGINS, activateRuntimePlugins, deactivateRuntimePlugin, isRuntimePluginActive } from "../runtime";
import { MESHES_SPEC } from "../../engine/render/babylon/meshes";
import { SPRITES_SPEC } from "../../engine/render/babylon/sprites";
import { tilemapsEditorPlugin } from "./editor";
import { parsePolygon } from "./editor/TilesetInspector";
import { Tilemap, tilemapsRuntimePlugin } from "./runtime";
import { newTileset, type TilesetData } from "../../engine/tilemap/tileset";

const TILESET = "tiles/ground.tileset.json";

async function open(files: Record<string, string>) {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  for (const [p, text] of Object.entries(files)) fs.files.set(joinPath(ROOT, p), text);
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return { project, fs };
}

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

  it("claims the Tilemap Component; the tiles render feature stays in the renderer, ordered after sprites", () => {
    expect(isRuntimePluginActive("myco.tilemaps")).toBe(true);
    expect(getComponentClass("engine.Tilemap")).toBe(Tilemap);
    expect(TILEMAPS_SPEC).toMatchObject({ phase: "content", types: [Tilemap], lazy: false, after: ["sprites"] });
    // The order is kept: sprites, tilemaps, meshes (meshes name tilemaps in their own `after`).
    const specs = [SPRITES_SPEC, MESHES_SPEC, TILEMAPS_SPEC];
    expect(byPhase(specs).map((i) => specs[i]!.name)).toEqual(["sprites", "tilemaps", "meshes"]);
  });

  it("unregisters the Component when deactivated, and registers it again when activated", () => {
    deactivateRuntimePlugin("myco.tilemaps");
    try {
      expect(getComponentClass("engine.Tilemap")).toBeUndefined();
    } finally {
      activateRuntimePlugins([tilemapsRuntimePlugin]);
    }
    expect(getComponentClass("engine.Tilemap")).toBe(Tilemap);
  });
});

describe("the Tilemaps plugin's editor half (ADR 0134)", () => {
  beforeEach(() => activatePlugins([tilemapsEditorPlugin]));
  afterEach(() => {
    _reset();
    deactivatePlugin("myco.tilemaps");
    currentProject.value = null;
  });

  it("registers the tileset asset kind: matching, label, icon, inspector and tileset fields", () => {
    expect(assetKind(TILESET)).toBe("tileset");
    expect(assetKind("Ground.TILESET.JSON")).toBe("tileset");
    expect(assetKind("tiles/data.json")).toBe("json");
    expect(kindLabel("tileset")).toBe("Tileset");
    expect(kindIcon("tileset")).toMatch(/^M/);
    expect(inspectableAsset(TILESET)).toBe(TILESET);
    expect(acceptsFile("tileset", TILESET)).toBe(true);
    expect(acceptsFile("material", TILESET)).toBe(false);
    expect(assetKinds.get("tileset")?.referencedAs).toEqual(["tileset"]);
  });

  it("registers a format that round-trips a tileset and reports problems as messages", () => {
    const format = assetFormats.get("tileset")!;
    const ts = tileset(3, [8, 12]);
    const read = format.parse(JSON.parse(formatTileset(ts)), TILESET);
    expect(read.problems).toEqual([]);
    expect(read.value.tiles).toHaveLength(3);
    expect(format.format(read.value)).toBe(formatTileset(ts));
    expect(format.writeDelay).toBe(150);
    const bad = format.parse("nope", TILESET);
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
    deactivatePlugin("myco.tilemaps");
    expect(isPluginActive("myco.tilemaps")).toBe(false);
    expect(kindLabel("tileset")).toBeUndefined();
    expect(assetFormats.get("tileset")).toBeUndefined();
    expect(inspectableAsset(TILESET)).toBe(TILESET); // the built-in table still names it, until its entries go
  });
});
