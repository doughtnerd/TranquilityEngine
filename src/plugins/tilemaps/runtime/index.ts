// The Tilemaps plugin's runtime half (ADR 0103, 0135, 0136): the `Tilemap` Component, tilesets, layer
// formats, auto-tiling, brushes, tile collision shapes, the chunk mesh builder and the tiles render
// feature. The feature draws through the renderer core's quad batches (`QuadBatchHost`), so no tile code
// is left in the backend: `BabylonQuadBatches` knows quads, not tiles. `Tilemap` offers its tile
// collision as a core 2D shape source; it names no physics plugin. `myco` (`src/myco.ts`) exports this
// module's public parts.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; never imports Babylon
// (the feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { tilemapsManifest } from "../manifest";
import { Tilemap } from "./Tilemap";

export { Tilemap, TilemapChanges, type TileChange } from "./Tilemap";
export { FLIP_DIAGONAL, FLIP_X, FLIP_Y, type TilemapLayerData } from "./format";
export type { TerrainDef, TileCollision, TileDef, TilePattern, TilePolygon, TilesetData } from "./tileset";
export type { TileCollisionMode } from "./collision";

/** @internal After sprites; `MESHES_SPEC` names it in its own `after`, so meshes sync after it (ADR 0135). */
export const TILEMAPS_SPEC: RenderFeatureSpec = { name: "tilemaps", phase: "content", types: [Tilemap], lazy: false, after: ["sprites"] };

export const tilemapsRuntimePlugin: RuntimePlugin = {
  manifest: tilemapsManifest,
  activate(context) {
    context.registerComponents([Tilemap]);
    context.registerRenderFeature({ spec: TILEMAPS_SPEC, load: () => import("./tilemapsFeature").then((m) => m.createTilemapsFeature) });
  },
};
