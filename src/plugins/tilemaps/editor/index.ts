// The Tilemaps plugin's editor half (ADR 0103, 0134): the `tileset` asset kind (the Inspector view that edits
// tiles, terrains and collision, accepted by Tilemap's tileset field) and its asset format. The Tile Palette
// panel and the tile painting tools still live in `src/editor/` (`ui/TilePalettePanel.tsx`, `tilemap/`), and
// so does the Assets panel's Create Tileset from Slices entry; New Tileset is this kind's `create`
// (`createTileset` in `src/editor/tilesetAssets.ts`).
import type { EditorPlugin } from "../../../editor/sdk";
import { createTileset } from "../../../editor/tilesetAssets";
import { tilemapsManifest } from "../manifest";
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
  },
};
