// The Tilemaps plugin's runtime half (ADR 0103, 0135): the `Tilemap` Component, claimed when the plugin
// activates. The tileset and layer formats, auto-tiling, brushes, the chunk mesh builder and the Babylon
// drawing stay in `src/engine/tilemap/` and `src/engine/render/babylon/tilemaps.ts` for now: the drawing is
// a Babylon adapter that must live in the backend (ADR 0075), the engine can't import plugins, and it needs
// the Tilemap's layers, the tileset and the mesh builder, so moving them (and the tiles render feature,
// which stays in `BabylonRenderer`'s list) needs a renderer-neutral tile-layer interface first. This module
// re-exports their public parts, so `myco` (`src/myco.ts`) exports them from here.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder.
import type { RuntimePlugin } from "../../runtimeContext";
import { tilemapsManifest } from "../manifest";
import { Tilemap } from "../../../engine/tilemap/Tilemap";

export { Tilemap, TilemapChanges, type TileChange } from "../../../engine/tilemap/Tilemap";
export { FLIP_DIAGONAL, FLIP_X, FLIP_Y, type TilemapLayerData } from "../../../engine/tilemap/format";
export type { TerrainDef, TileCollision, TileDef, TilePattern, TilePolygon, TilesetData } from "../../../engine/tilemap/tileset";
export type { TileCollisionMode } from "../../../engine/tilemap/collision";

export const tilemapsRuntimePlugin: RuntimePlugin = {
  manifest: tilemapsManifest,
  activate(context) {
    context.registerComponents([Tilemap]);
  },
};
