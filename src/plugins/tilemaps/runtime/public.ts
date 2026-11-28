// The Tilemaps plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { Tilemap, TilemapChanges, type TileChange, type TileGridShape } from "./Tilemap";
export { MapObject } from "./MapObject";
export { FLIP_DIAGONAL, FLIP_X, FLIP_Y, type TilemapLayerData } from "./format";
export type { TerrainDef, TileCollision, TileDef, TilePattern, TilePolygon, TilesetData, TileAnimation, TileFrameDef, TileOccluder, TileShapes, TileStamp, TileStampLayer, TilesetPreviewGrid } from "./tileset";
export type { TileCollisionMode } from "./collision";
