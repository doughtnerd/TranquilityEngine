// Under a Tilemap's fields in the Inspector (ADR 0103, 0131): its layer and tile counts, the way to the Tile Palette,
// where its layers are painted (the `layers` field itself is hidden), and Re-roll, which draws its terrain variants
// again with a new seed (ADR 0400; the `variantSeed` field is hidden too).
import { rerollVariants, tilemapOf } from "./brush";
import { editor, type InspectorSectionProps } from "../../../editor/sdk";

export function TilemapSection({ scene, paths }: InspectorSectionProps) {
  editor.project.version;
  const map = tilemapOf(scene.sync.nodeFor(paths[0]));
  if (!map) return null;
  let tiles = 0;
  for (let l = 0; l < map.layerCount; l++) for (const _ of map.tiles(l)) tiles++;
  return (
    <div class="tilemap-summary">
      <span>
        {map.layerCount} layer{map.layerCount === 1 ? "" : "s"} · {tiles} tile{tiles === 1 ? "" : "s"}
      </span>
      <span class="tilemap-summary-actions">
        <button
          title={`Choose the terrain tiles' variants and the random brush's picks with a new seed (now ${map.variantSeed}). Every terrain cell keeps its shape; its variant is drawn again.`}
          onClick={() => rerollVariants(scene, paths[0], map)}
        >
          Re-roll variants
        </button>
        <button onClick={() => editor.showPanel("tilepalette")}>Open Tile Palette</button>
      </span>
    </div>
  );
}
