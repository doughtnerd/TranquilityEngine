import { describe, expect, it } from "vitest";
import { tilemapsEditorPlugin } from "../plugins/tilemaps/editor";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { defaultImportSettings, formatImportSettings, sidecarPath } from "../engine/scene/importSettings";
import { assetKind } from "./assetBrowser";
import { blockStamp } from "../plugins/tilemaps/editor/palette";
import { joinPath, openFolderProject } from "./projects";
import { formatTileset, readTileset, splitSprite, tilesetFromSlices, tilesForSlices } from "./tilesetAssets";
import { MemoryFileSystem, ROOT, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

async function projectWithSlices(rects: [number, number, number, number][]) {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, "images/t.png"), new Uint8Array([137, 80, 78, 71]));
  const settings = defaultImportSettings();
  settings.sprites = rects.map((rect, i) => ({ name: `t_${i}`, rect, pivot: [0.5, 0.5] }));
  if (rects.length) fs.files.set(joinPath(ROOT, sidecarPath("images/t.png")), formatImportSettings(settings));
  return { fs, project: await openFolderProject(fs, ROOT), settings };
}

useEditorPlugins([tilemapsEditorPlugin]);

describe("tileset assets (ADR 0103)", () => {
  it("recognises tileset files before generic JSON", () => {
    expect(assetKind("tiles/ground.tileset.json")).toBe("tileset");
    expect(assetKind("Ground.TILESET.JSON")).toBe("tileset");
    expect(assetKind("tiles/data.json")).toBe("json");
  });

  it("makes one tile per slice, sized by the first slice", async () => {
    const { project } = await projectWithSlices([[0, 0, 8, 12], [8, 0, 8, 12], [16, 0, 8, 12]]);
    const ts = tilesetFromSlices("images/t.png", project);
    expect(ts.tileSize).toEqual([8, 12]);
    expect(ts.tiles.map((t) => [t.id, t.sprite, t.collision])).toEqual([
      [1, "asset:images/t.png#t_0", "none"],
      [2, "asset:images/t.png#t_1", "none"],
      [3, "asset:images/t.png#t_2", "none"],
    ]);
  });

  it("falls back to 16 × 16 and no tiles for an image without slices", async () => {
    const { project } = await projectWithSlices([]);
    const ts = tilesetFromSlices("images/t.png", project);
    expect(ts.tileSize).toEqual([16, 16]);
    expect(ts.tiles).toEqual([]);
  });

  it("adds only the slices no tile uses yet", async () => {
    const { settings } = await projectWithSlices([[0, 0, 8, 8], [8, 0, 8, 8]]);
    const added = tilesForSlices(settings, "images/t.png", 5, new Set(["asset:images/t.png#t_0"]));
    expect(added.map((t) => [t.id, t.sprite])).toEqual([[5, "asset:images/t.png#t_1"]]);
  });

  it("writes pretty JSON that reads back", async () => {
    const { fs, project } = await projectWithSlices([[0, 0, 8, 8]]);
    const data = tilesetFromSlices("images/t.png", project);
    await project.writeText("a.tileset.json", formatTileset(data));
    expect(fs.files.get(joinPath(ROOT, "a.tileset.json"))).toBe(formatTileset(data));
    expect(formatTileset(data)).toContain('\n  "tileSize"');
    expect(readTileset(project, "a.tileset.json").tileset.tiles).toHaveLength(1);
  });

  it("splits sprite references", () => {
    expect(splitSprite("asset:images/t.png#grass")).toEqual({ image: "images/t.png", slice: "grass" });
    expect(splitSprite("asset:images/t.png")).toBeNull();
  });

  it("lays a dragged block out with the bottom row first", () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    // 3 columns: rows [1 2 3] [4 5 6] [7]; the block from tile 2 to tile 7's row.
    expect(blockStamp(ids, 3, 1, 5)).toEqual({ width: 2, height: 2, values: [5, 6, 2, 3] });
    // Positions past the last tile are empty cells.
    expect(blockStamp(ids, 3, 6, 5)).toEqual({ width: 3, height: 2, values: [7, 0, 0, 4, 5, 6] });
    expect(blockStamp(ids, 3, 0, 0)).toEqual({ width: 1, height: 1, values: [1] });
  });
});
