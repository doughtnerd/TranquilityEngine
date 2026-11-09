/**
 * Asset field kinds in the editor (ADR 0131): which project files an `AssetRef` field offers,
 * from the `kind` its Component declares (`@field(AssetRef, { kind: "material" })`).
 *
 * The engine names what a field needs (`AssetFieldKind`); each asset kind's `referencedAs` names the
 * field kinds that accept it, and the few file-name filters here cover files of no particular kind.
 */
import { ASSET_FIELD_KINDS, AssetRef, isListType, type AssetFieldKind } from "../engine/core/registry";
import type { FieldValue } from "../engine/editor";
import { BUILTIN_MESHES } from "../engine/scene/models";
import { assetKind, assetKindFor } from "./assetKinds";

/**
 * Files a field kind accepts that no asset kind's `referencedAs` names: panoramas, fonts and baked
 * navigation, which are only told apart by their file names. Everything else (images and sprites,
 * audio, scenes, prefabs, render textures: the core asset kinds; models, materials, effects…: plugins')
 * is accepted through its kind's `referencedAs` (ADR 0133).
 */
const FILTERS: Partial<Record<AssetFieldKind, (file: string) => boolean>> = {
  environment: (f) => /\.(png|jpe?g)$/i.test(f), // panoramas; environment maps and cubemaps (Environment plugin) and skies (Sky) by `referencedAs`
  envmap: (f) => /\.env$/i.test(f) && assetKind(f) === "environment", // a prefiltered map of the Environment plugin's kind
  font: (f) => /\.(ttf|otf|woff2?)$/i.test(f),
  navbake: (f) => /\.nav\.bin$/i.test(f),
};

/** Values a kind offers that aren't project files: the built-in meshes for `mesh`. */
const BUILTINS: Partial<Record<AssetFieldKind, readonly string[]>> = {
  mesh: BUILTIN_MESHES.map((m) => `builtin:${m}`),
};

/** Whether a file suits field kind `k`: its asset kind declares `referencedAs` it (ADR 0133), or a file-name filter above. */
export function acceptsFile(k: AssetFieldKind, file: string): boolean {
  return assetKindFor(file)?.referencedAs?.includes(k) === true || FILTERS[k]?.(file) === true;
}

/** What an asset field of these kinds offers from `files`: built-in values first, then matching files. Empty `kinds` offers every file. */
export function assetsForKinds(kinds: readonly AssetFieldKind[], files: readonly string[]): string[] {
  if (kinds.length === 0) return [...files];
  const builtins = [...new Set(kinds.flatMap((k) => BUILTINS[k] ?? []))];
  return [...builtins, ...files.filter((f) => kinds.some((k) => acceptsFile(k, f)))];
}

/** The asset kinds a field (or one item of a list field) declares; empty when it takes any asset or isn't an asset field. */
export function assetKindsOf(field: FieldValue): AssetFieldKind[] {
  const type = field.type as unknown;
  const item = isListType(type) ? type[0] : type;
  if (item !== AssetRef) return [];
  const kind = field.options?.kind;
  if (kind === undefined) return [];
  return (typeof kind === "string" ? [kind] : [...kind]).filter((k) => (ASSET_FIELD_KINDS as readonly string[]).includes(k));
}

/** The id of the `<datalist>` an asset field suggests from (`AssetLists` in the Inspector renders one per kind, plus `asset-list-all`). */
export function assetListId(kinds: readonly AssetFieldKind[]): string {
  return kinds.length === 0 ? "asset-list-all" : `asset-list-${kinds.join("+")}`;
}

/** Whether the field is hidden from the Inspector (another editor owns it). */
export const isHiddenField = (field: FieldValue) => field.options?.hidden === true;
