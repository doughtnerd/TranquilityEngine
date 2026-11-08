/**
 * Asset field kinds in the editor (ADR 0131): which project files an `AssetRef` field offers,
 * from the `kind` its Component declares (`@field(AssetRef, { kind: "material" })`).
 *
 * The engine names what a field needs (`AssetFieldKind`); this table turns each need into a filter
 * over the asset browser's file kinds (`assetKind`). It is the only place the two meet.
 */
import { ASSET_FIELD_KINDS, AssetRef, isListType, type AssetFieldKind } from "../engine/core/registry";
import type { FieldValue } from "../engine/editor";
import { BUILTIN_MESHES } from "../engine/scene/models";
import { assetKind, type AssetKind } from "./assetBrowser";
import { matchRegisteredKind } from "./assetKindLookup";

const ofKind = (...kinds: AssetKind[]) => (f: string) => kinds.includes(assetKind(f));

/** Whether a project file suits each kind. */
const FILTERS: Record<AssetFieldKind, (file: string) => boolean> = {
  model: ofKind("model"),
  mesh: ofKind("model"),
  material: () => false, // materials and shader graphs: the Materials plugin's kinds, by `referencedAs`
  texture: ofKind("image"),
  sprite: ofKind("image", "sprite"),
  rendertexture: ofKind("rendertexture"),
  audio: ofKind("audio"),
  particles: ofKind("particles"),
  formation: ofKind("formation"),
  lut: ofKind("lut"),
  environment: (f) => ofKind("environment", "cubemap")(f) || /\.(png|jpe?g)$/i.test(f),
  envmap: (f) => /\.env$/i.test(f) && assetKind(f) === "environment",
  tileset: ofKind("tileset"),
  font: (f) => /\.(ttf|otf|woff2?)$/i.test(f),
  uidocument: ofKind("uidocument"),
  navbake: (f) => /\.nav\.bin$/i.test(f),
  scene: ofKind("scene"),
  prefab: ofKind("prefab"),
};

/** Values a kind offers that aren't project files: the built-in meshes for `mesh`. */
const BUILTINS: Partial<Record<AssetFieldKind, readonly string[]>> = {
  mesh: BUILTIN_MESHES.map((m) => `builtin:${m}`),
};

/** Whether a file suits field kind `k`: the built-in filter, or a registered kind that declares `referencedAs` it (ADR 0133). */
export function acceptsFile(k: AssetFieldKind, file: string): boolean {
  if (FILTERS[k](file)) return true;
  return matchRegisteredKind(file)?.kind.referencedAs?.includes(k) === true && assetKind(file) === matchRegisteredKind(file)!.kind.id;
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
