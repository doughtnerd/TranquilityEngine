// Under a Tilemap's fields in the Inspector (ADR 0103, 0131): its layer and tile counts, and the way
// to the Tile Palette, where its layers are painted (the `layers` field itself is hidden).
import { showPanel } from "../layout/store";
import { tilemapOf } from "../tilemap/brush";
import { docVersion } from "../state";
import type { InspectorSectionProps } from "./inspectorSections";

export function TilemapSection({ scene, paths }: InspectorSectionProps) {
  docVersion.value;
  const map = tilemapOf(scene.sync.nodeFor(paths[0]));
  if (!map) return null;
  let tiles = 0;
  for (let l = 0; l < map.layerCount; l++) for (const _ of map.tiles(l)) tiles++;
  return (
    <div class="tilemap-summary">
      <span>
        {map.layerCount} layer{map.layerCount === 1 ? "" : "s"} · {tiles} tile{tiles === 1 ? "" : "s"}
      </span>
      <button onClick={() => showPanel("tilepalette")}>Open Tile Palette</button>
    </div>
  );
}
