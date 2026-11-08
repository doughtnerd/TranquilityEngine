// The Tilemaps plugin's manifest (ADR 0103, 0133, 0135), shared by its runtime and editor halves: the
// Tilemap Component and tilesets, the Tile Palette and tile painting; the 2D physics TilemapCollider2D
// belongs to the Physics 2D plugin.
import type { PluginManifest } from "../manifest";

export const tilemapsManifest: PluginManifest = {
  name: "myco.tilemaps",
  title: "Tilemaps",
  description: "Tile maps, tilesets with auto-tiling terrains, and their drawing.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
