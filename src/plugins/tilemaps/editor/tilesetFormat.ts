// The `tileset` asset format (ADR 0103, 0134, 0233): `*.tileset.json` as TilesetData, the kind's `format`. Built
// from the runtime's parse function; written as pretty JSON. A file the runtime can't read is an empty tileset (the
// asset kind host's rule), which is also New Tileset's.
import type { AssetFormat } from "../../../editor/sdk";
import { patternProblems } from "../runtime/autotile";
import { newTileset, parseTileset, type TilesetData } from "../runtime/tileset";

export const tilesetFormat: AssetFormat<TilesetData> = {
  parse(raw, path) {
    const { tileset, problems } = parseTileset(raw, path);
    // Terrain tiles whose pattern doesn't fit the tileset's grid (ADR 0421) show as problems naming them.
    return { value: tileset, problems: [...problems, ...patternProblems(tileset)].map((message) => ({ message })) };
  },
  format: (data) => `${JSON.stringify(data, null, 2)}\n`,
  empty: newTileset,
  writeDelay: 150,
};
