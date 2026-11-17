// Material assets in the editor (ADR 0043, the Materials plugin since 0134): what the Material inspector needs
// beyond its asset document (the `material` kind's format, `materialFormat.ts`). Creating and reading materials is
// the asset kind host's (ADR 0233: `editor.assets.create("material")`, `editor.assets.read`).
import { formatMaterial, type MaterialSettings } from "../../../engine/scene/material";
import type { KeywordValue, ShaderKeyword } from "../../../engine/scene/shaderKeywords";

/** True if two settings would write the same file. */
export const sameMaterial = (a: MaterialSettings, b: MaterialSettings) => formatMaterial(a) === formatMaterial(b);

/**
 * A material's keyword values with `name` set to `value`; a value equal to the keyword's default
 * (off, or an enum's first value) is left out so the file stays minimal.
 */
export function withKeywordValue(keywords: Readonly<Record<string, KeywordValue>>, keyword: ShaderKeyword, value: KeywordValue): Record<string, KeywordValue> {
  const out = { ...keywords };
  const isDefault = keyword.values ? value === keyword.values[0] : value === false;
  if (isDefault) delete out[keyword.name];
  else out[keyword.name] = value;
  return out;
}
