// The Tilemaps plugin's editor half (ADR 0103, 0134, 0138, 0146): the `tileset` asset kind (the Inspector view
// that edits tiles, terrains and collision, accepted by Tilemap's tileset field; New Tileset is its `create`) and
// its asset format, the Tile Palette panel, the scene-view paint tool, the Tilemap's Inspector section, the
// Hierarchy's Create Tilemap, the Assets panel's Create Tileset from Slices, and its layers' references to sorting layers.
// ADR 0438: the `tiledmap`, `tiledtileset` and `ldtkproject` asset kinds and Import as Myco assets… (the Assets panel's
// action and their Inspector), whose dialog and importer load on first use.
import { createTilesetFromSlices, hasSlices } from "./tilesetAssets";
import { tilemapsManifest } from "../manifest";
import { paintTool } from "./paintTool";
import { tilesetFormat } from "./tilesetFormat";
import { type EditorPlugin, type NameReferencesContribution, editor } from "../../../editor/sdk";

/** A Tilemap's layers each name a sorting layer (ADR 0262; the shell owns the sorting layer list). */
export const tilemapSortingLayers: NameReferencesContribution = {
  id: "myco.tilemaps.sorting-layers",
  list: "render.sortingLayers",
  fields: [{ component: "engine.Tilemap", field: "layers.*.sortingLayer" }],
};

/** Four tiles in a 2 × 2 grid, stroked in a 24×24 box (the icon tilesets have always had). */
const TILESET_ICON = "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z";
/** A folded map (Tiled maps). */
const TILED_MAP_ICON = "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14";
/** A grid of levels (LDtk projects). */
const LDTK_ICON = "M3 4h8v7H3zM13 4h8v4h-8zM13 10h8v10h-8zM3 13h8v7H3z";

/** ADR 0438: the source kinds Import as Myco assets… reads. */
const IMPORT_KINDS = new Set(["tiledmap", "tiledtileset", "ldtkproject"]);
const importSourceInspector = () => import("./import/ImportSourceInspector").then((m) => m.ImportSourceInspector);

export const tilemapsEditorPlugin: EditorPlugin = {
  manifest: tilemapsManifest,
  activate(context) {
    context.registerAssetKind({
      id: "tileset",
      extensions: [".tileset.json"],
      label: "Tileset",
      icon: TILESET_ICON,
      format: tilesetFormat,
      inspector: () => import("./TilesetInspector").then((m) => m.TilesetInspector),
      create: { label: "New Tileset", category: "2D", what: "tilesets" },
      referencedAs: ["tileset"],
    });
    // Same id as when it was built in, so saved layouts keep the tab; after Code, so the default tabs stay Assets, Code, Tile Palette.
    context.registerPanel({ id: "tilepalette", title: "Tile Palette", view: () => import("./TilePalettePanel").then((m) => m.TilePalettePanel), beside: "code" });
    context.registerViewportTool(paintTool);
    // A Tilemap's layers are painted in the Tile Palette.
    context.registerInspectorSection("engine.Tilemap", () => import("./TilemapInspector").then((m) => m.TilemapSection), { single: true });
    // Each Tilemap layer names a sorting layer: renaming the sorting layer renames it there too (ADR 0262).
    context.registerNameReferences(tilemapSortingLayers);
    // A Tilemap with one layer and its collider (ADR 0103, 0105), after Sprite as it has always been; the asset
    // is a tileset to paint with, or "".
    context.registerHierarchyCreateEntry({
      id: "tilemap",
      label: "Tilemap",
      name: "Tilemap",
      after: "sprite",
      category: "2D", // the Create menus' 2D submenu (ADR 0383)
      components: (position, tileset) => [
        { type: "engine.Transform", data: { position } },
        { type: "engine.Tilemap", data: tileset ? { tileset } : {} },
        { type: "engine.ShapeCollider2D", data: {} },
      ],
    });
    // ADR 0438: Tiled and LDtk files, imported once into native tilesets and prefabs. A `.tsx` reaches the Assets
    // panel only when it is a Tiled tileset (TypeScript `.tsx` files aren't project files, `projectFiles.ts`).
    context.registerAssetKind({ id: "tiledmap", extensions: [".tmx", ".tmj"], label: "Tiled Map", icon: TILED_MAP_ICON, inspector: importSourceInspector });
    context.registerAssetKind({ id: "tiledtileset", extensions: [".tsx", ".tsj"], label: "Tiled Tileset", icon: TILESET_ICON, inspector: importSourceInspector });
    context.registerAssetKind({ id: "ldtkproject", extensions: [".ldtk"], label: "LDtk Project", icon: LDTK_ICON, inspector: importSourceInspector });
    context.registerAssetAction({
      id: "myco.tilemaps.import-as-myco-assets",
      label: "Import as Myco assets…",
      writes: true,
      appliesTo: (_project, targets) => targets.length === 1 && targets[0].slice === undefined && IMPORT_KINDS.has(editor.assets.kindOf(targets[0].path)),
      run: async (_project, targets) => (await import("./import/ImportDialog")).openImportDialog(targets[0].path),
    });
    // Slices of an image (or an image with slices) become a tileset beside the image, named after it.
    context.registerAssetAction({
      id: "myco.tilemaps.tileset-from-slices",
      label: "Create Tileset from Slices",
      writes: true,
      appliesTo: (project, targets) =>
        targets.length > 0 && (targets.every((t) => t.slice !== undefined) || (targets.length === 1 && editor.assets.kindOf(targets[0].path) === "image" && hasSlices(project, targets[0].path))),
      run: async (_project, targets) => {
        const image = targets[0].path;
        const made = await createTilesetFromSlices(editor.assets.folderOf(image), image);
        return made ? [made] : [];
      },
    });
  },
};
