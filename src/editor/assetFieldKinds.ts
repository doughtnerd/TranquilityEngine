/**
 * Asset field kinds in the editor (ADR 0131, 0143): which project files an `AssetRef` field offers,
 * from the `kind` its Component declares (`@field(AssetRef, { kind: "material" })`).
 *
 * The engine names what a field needs (`AssetFieldKind`, any name); the asset kinds whose
 * `referencedAs` names it supply the files (`satisfiesFieldKind` in the asset kind module). Here:
 * the values that aren't files (the built-in meshes), and a warning for a name nothing satisfies.
 */
import { ASSET_FIELD_KINDS, AssetRef, isListType, type AssetFieldKind } from "../engine/core/registry";
import type { FieldValue } from "../engine/editor";
import { BUILTIN_MESHES } from "../engine/scene/models";
import { fieldKindKnown, satisfiesFieldKind } from "./assetKindLookup";
import { logMessage } from "./messages";

/** Values a kind offers that aren't project files: the built-in meshes for `mesh`. */
const BUILTINS: Partial<Record<AssetFieldKind, readonly string[]>> = {
  mesh: BUILTIN_MESHES.map((m) => `builtin:${m}`),
};

/** Whether a file suits field kind `k`: an asset kind that declares `referencedAs` it, or a core rule (ADR 0143). */
export const acceptsFile = (k: AssetFieldKind, file: string): boolean => satisfiesFieldKind(k, file);

/** Field kinds already warned about. */
const warned = new Set<string>();

/**
 * Warn once about a field kind no registered asset kind satisfies (ADR 0143: a typo is no type error
 * any more). Only names outside the engine's own: their kinds may belong to a disabled plugin.
 */
function warnUnknown(k: AssetFieldKind): void {
  if (warned.has(k) || (ASSET_FIELD_KINDS as readonly string[]).includes(k) || fieldKindKnown(k)) return;
  warned.add(k);
  logMessage("warning", `No asset kind is referenced as "${k}": fields of that kind offer no files. Is the plugin that adds it enabled, or is the name misspelled?`);
}

/** What an asset field of these kinds offers from `files`: built-in values first, then matching files. Empty `kinds` offers every file. */
export function assetsForKinds(kinds: readonly AssetFieldKind[], files: readonly string[]): string[] {
  if (kinds.length === 0) return [...files];
  kinds.forEach(warnUnknown);
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
  return typeof kind === "string" ? [kind] : [...kind];
}

/** The id of the `<datalist>` an asset field suggests from (`AssetLists` in the Inspector renders one per kind, plus `asset-list-all`). */
export function assetListId(kinds: readonly AssetFieldKind[]): string {
  return kinds.length === 0 ? "asset-list-all" : `asset-list-${kinds.join("+")}`;
}

/** Whether the field is hidden from the Inspector (another editor owns it). */
export const isHiddenField = (field: FieldValue) => field.options?.hidden === true;
