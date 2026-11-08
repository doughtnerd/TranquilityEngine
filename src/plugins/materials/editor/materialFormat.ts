// The `material` asset format (ADR 0043, 0134): `*.material.json` as MaterialSettings, for
// asset documents (assetDocuments.ts). Built from the engine's parse and format functions.
import { defaultMaterialSettings, formatMaterial, parseMaterial, type MaterialSettings } from "../../../engine/scene/material";
import type { AssetFormatContribution } from "../../../editor/sdk/contributions";

export const materialFormat: AssetFormatContribution<MaterialSettings> = {
  id: "material",
  parse(raw, path) {
    try {
      const { settings, problems } = parseMaterial(raw, path);
      return { value: settings, problems: problems.map((message) => ({ message })) };
    } catch (err) {
      return { value: defaultMaterialSettings(), problems: [{ message: (err as Error).message }] };
    }
  },
  format: formatMaterial,
  writeDelay: 150,
};
