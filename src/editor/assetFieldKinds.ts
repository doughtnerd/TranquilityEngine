/**
 * Asset field kinds in the editor (ADR 0131, 0143): which project files an `AssetRef` field offers,
 * from the `kind` its Component declares (`@field(AssetRef, { kind: "material" })`).
 *
 * The engine names what a field needs (`AssetFieldKind`, any name); the asset kinds whose
 * `referencedAs` names it supply the files (`satisfiesFieldKind` in the asset kind module). Here:
 * the values that aren't files (the built-in meshes), a warning for a name nothing satisfies, and what an asset slot
 * offers and shows (`assetChoices`, ADR 0282), which the SDK's `AssetPicker` renders.
 */
import { ASSET_FIELD_KINDS, AssetRef, isListType, type AssetFieldKind } from "../engine/core/registry";
import type { FieldValue } from "../engine/editor";
import { isSidecarPath } from "../engine/scene/importSettings";
import { BUILTIN_MESHES } from "../engine/scene/models";
import { fieldKindKnown, satisfiesFieldKind } from "./assetKindLookup";
import { parseAssetRef } from "./assetRefValues";
import { logMessage } from "./messages";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Values a kind offers that aren't project files: the built-in meshes for `mesh`. */
const BUILTINS: Partial<Record<AssetFieldKind, readonly string[]>> = {
  mesh: BUILTIN_MESHES.map((m) => `builtin:${m}`),
};

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
  return [...builtins, ...files.filter((f) => kinds.some((k) => satisfiesFieldKind(k, f)))];
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

/** How a slot stores the file picked: `asset:<path>` (most plugin files) or the bare project path. */
export type AssetStoredForm = "asset" | "path";

/** One entry of an asset slot: the value it stores and how it is shown. */
export interface AssetChoice {
  readonly value: string;
  readonly label: string;
}

/** What an asset slot offers and which entry its value is (`assetChoices`). */
export interface AssetChoices {
  /** Built-in entries, then the files that fit, each labelled. */
  readonly entries: readonly AssetChoice[];
  /** The value in the stored form ("" for none): the entry shown as picked. */
  readonly selected: string;
  /**
   * The value when no entry is it: a file that exists but isn't offered (a sub-mesh, a slice, a file of another
   * kind), or one the project doesn't have, labelled "(missing)". Null when the value is empty or offered.
   */
  readonly other: AssetChoice | null;
}

/** A built-in value's name in words: `builtin:cube` → "Cube". */
function builtinLabel(ref: string): string {
  const name = ref.slice(ref.indexOf(":") + 1);
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();
}

/**
 * The entries of an asset slot of field kinds `kinds` (ADR 0131, 0143; empty: any file) over the project's `files`
 * (sidecars left out), narrowed by `accepts`, and where its current `value` (any reference form, ADR 0148) sits.
 * Files are labelled by name, by project path where two offered files share a name; built-ins by their name in words.
 */
export function assetChoices(
  kinds: readonly AssetFieldKind[],
  files: readonly string[],
  value: string,
  options: { stored?: AssetStoredForm; accepts?: (path: string) => boolean } = {},
): AssetChoices {
  const stored = options.stored ?? "asset";
  const listed = files.filter((f) => !isSidecarPath(f));
  const isBuiltin = (ref: string) => ref.startsWith("builtin:");
  const offered = assetsForKinds(kinds, listed).filter((ref) => isBuiltin(ref) || !options.accepts || options.accepts(ref));
  const names = new Map<string, number>();
  for (const ref of offered) if (!isBuiltin(ref)) names.set(fileName(ref), (names.get(fileName(ref)) ?? 0) + 1);
  const store = (target: string) => (stored === "asset" ? `asset:${target}` : target);
  const entries = offered.map((ref): AssetChoice => (isBuiltin(ref) ? { value: ref, label: builtinLabel(ref) } : { value: store(ref), label: names.get(fileName(ref))! > 1 ? ref : fileName(ref) }));
  if (value === "") return { entries, selected: "", other: null };
  if (isBuiltin(value)) {
    const known = entries.some((e) => e.value === value);
    return { entries, selected: value, other: known ? null : { value, label: `${builtinLabel(value)} (missing)` } };
  }
  const ref = parseAssetRef(value);
  const selected = store(ref.slice === null ? ref.path : `${ref.path}#${ref.slice}`);
  if (entries.some((e) => e.value === selected)) return { entries, selected, other: null };
  const label = ref.slice === null ? fileName(ref.path) : `${fileName(ref.path)}#${ref.slice}`;
  return { entries, selected, other: { value: selected, label: listed.includes(ref.path) ? label : `${label} (missing)` } };
}

/** Whether the field is hidden from the Inspector (another editor owns it). */
export const isHiddenField = (field: FieldValue) => field.options?.hidden === true;
