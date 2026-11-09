// The `formation` asset format (ADR 0065, 0134): `*.formation.json` as a NavFormationAsset, for asset
// documents (assetDocuments.ts). Built from the engine's parse and format functions.
import { defaultFormation, formatFormation, parseFormation, type NavFormationAsset } from "../../../engine/nav/formation";
import type { AssetFormatContribution } from "../../../editor/sdk";

export const formationFormat: AssetFormatContribution<NavFormationAsset> = {
  id: "formation",
  parse(raw, path) {
    try {
      const { formation, problems } = parseFormation(raw, path);
      return { value: formation, problems: problems.map((message) => ({ message })) };
    } catch (err) {
      return { value: defaultFormation(), problems: [{ message: (err as Error).message }] };
    }
  },
  format: formatFormation,
  writeDelay: 150,
};
