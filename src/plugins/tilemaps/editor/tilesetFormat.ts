// The `tileset` asset format (ADR 0103, 0134): `*.tileset.json` as TilesetData, for asset documents
// (assetDocuments.ts). Built from the runtime's parse function and the editor's pretty-JSON formatter.
import { formatTileset } from "../../../editor/tilesetAssets";
import type { AssetFormatContribution } from "../../../editor/sdk/contributions";
import { newTileset, parseTileset, type TilesetData } from "../../../engine/tilemap/tileset";

export const tilesetFormat: AssetFormatContribution<TilesetData> = {
  id: "tileset",
  parse(raw, path) {
    try {
      const { tileset, problems } = parseTileset(raw, path);
      return { value: tileset, problems: problems.map((message) => ({ message })) };
    } catch (err) {
      return { value: newTileset(), problems: [{ message: (err as Error).message }] };
    }
  },
  format: (value) => formatTileset(value), // late-bound: a cycle through the editor modules may not have evaluated it yet
  writeDelay: 150,
};
