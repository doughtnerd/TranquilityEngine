// The `formation` asset format (ADR 0065, 0134, 0233): `*.formation.json` as a NavFormationAsset, the kind's
// `format`. Built from the engine's parse and format functions; a file the engine can't read is Foxfire's default
// (the asset kind host's rule), which is also New Navigation Formation's.
import { defaultFormation, formatFormation, parseFormation, type NavFormationAsset } from "../../../engine/nav/formation";
import type { AssetFormat } from "../../../editor/sdk";

export const formationFormat: AssetFormat<NavFormationAsset> = {
  parse(raw, path) {
    const { formation, problems } = parseFormation(raw, path);
    return { value: formation, problems: problems.map((message) => ({ message })) };
  },
  format: formatFormation,
  empty: defaultFormation,
  writeDelay: 150,
};
