// The Tilemaps plugin's editor half (ADR 0103, 0134, 0138): the `tileset` asset kind (the Inspector view that
// edits tiles, terrains and collision, accepted by Tilemap's tileset field) and its asset format, the Tile
// Palette panel, the scene-view paint tool and the Tilemap's Inspector section. The Assets panel's Create
// Tileset from Slices entry still lives in core (`src/editor/tilesetAssets.ts`, no asset-menu contribution
// point yet); New Tileset is this kind's `create`.
import type { EditorPlugin } from "../../../editor/sdk";
import { createTileset } from "../../../editor/tilesetAssets";
import { tilemapsManifest } from "../manifest";
import { paintTool } from "./paintTool";
import { tilesetFormat } from "./tilesetFormat";

/** Four tiles in a 2 × 2 grid, stroked in a 24×24 box (the icon tilesets have always had). */
const TILESET_ICON = "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z";

export const tilemapsEditorPlugin: EditorPlugin = {
  manifest: tilemapsManifest,
  activate(context) {
    context.registerAssetKind({
      id: "tileset",
      extensions: [".tileset.json"],
      label: "Tileset",
      icon: TILESET_ICON,
      inspector: () => import("./TilesetInspector").then((m) => m.TilesetInspector),
      create: { label: "New Tileset", create: (folder) => createTileset(folder) },
      referencedAs: ["tileset"],
    });
    context.registerAssetFormat(tilesetFormat);
    // Same id as when it was built in, so saved layouts keep the tab; after Code, so the default tabs stay Assets, Code, Tile Palette.
    context.registerPanel({ id: "tilepalette", title: "Tile Palette", view: () => import("./TilePalettePanel").then((m) => m.TilePalettePanel), beside: "code" });
    context.registerViewportTool(paintTool);
    // A Tilemap's layers are painted in the Tile Palette.
    context.registerInspectorSection("engine.Tilemap", () => import("./TilemapInspector").then((m) => m.TilemapSection), { single: true });
  },
};
