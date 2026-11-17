// The `material` and `shader` asset formats (ADR 0043, 0106, 0134, 0233): `*.material.json` as MaterialSettings
// and `*.shader.json` as a ShaderAsset, the kinds' `format`. Built from the engine's parse and format functions; a
// file the engine can't read is the kind's `empty()` (the asset kind host's rule).
import { defaultMaterialSettings, formatMaterial, parseMaterial, type MaterialSettings } from "../../../engine/scene/material";
import { defaultShaderAsset, formatShaderAsset, parseShaderAsset, type ShaderAsset } from "../../../engine/scene/shaderAsset";
import type { AssetFormat } from "../../../editor/sdk";

export const materialFormat: AssetFormat<MaterialSettings> = {
  parse(raw, path) {
    const { settings, problems } = parseMaterial(raw, path);
    return { value: settings, problems: problems.map((message) => ({ message })) };
  },
  format: formatMaterial,
  empty: defaultMaterialSettings,
  writeDelay: 150,
};

export const shaderAssetFormat: AssetFormat<ShaderAsset> = {
  parse(raw, path) {
    const { shader, problems } = parseShaderAsset(raw, path);
    return { value: shader, problems: problems.map((message) => ({ message })) };
  },
  format: formatShaderAsset,
  empty: defaultShaderAsset,
};
