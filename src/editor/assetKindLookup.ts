// Registered asset kinds (ADR 0133/0134) as the asset browser sees them: matching a path,
// and the label, icon and open behaviour a plugin's kind supplies. Built-in kinds not yet moved
// to a plugin keep their tables in the callers, which ask here first. Imports nothing from
// `assetBrowser.ts`, so both it and `thumbnails/keys.ts` can use it.
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";

/** The registered kind whose extension is the longest ending of `path` (case-insensitive), with that extension's length. Reads `assetKinds.version`, so callers in components re-render on (un)registration. */
export function matchRegisteredKind(path: string): { kind: AssetKindContribution; length: number } | null {
  void assetKinds.version.value;
  const p = path.toLowerCase();
  let best: { kind: AssetKindContribution; length: number } | null = null;
  for (const kind of assetKinds.list()) {
    for (const ext of kind.extensions) {
      const e = ext.toLowerCase();
      if (p.endsWith(e) && (!best || e.length > best.length)) best = { kind, length: e.length };
    }
  }
  return best;
}

/** The registered kind with this id, or undefined (also reads `assetKinds.version`). */
export function registeredKind(id: string): AssetKindContribution | undefined {
  void assetKinds.version.value;
  return assetKinds.get(id);
}

/** A registered kind's label, or undefined for built-in kinds. */
export const kindLabel = (kind: string): string | undefined => registeredKind(kind)?.label;
/** A registered kind's icon path, or undefined for built-in kinds. */
export const kindIcon = (kind: string): string | undefined => registeredKind(kind)?.icon;
/** True if `kind` is registered and has `open`. */
export const registeredKindOpens = (kind: string): boolean => registeredKind(kind)?.open !== undefined;
/** True if `path` is of a registered kind that has `open`. */
export const kindOpens = (path: string): boolean => matchRegisteredKind(path)?.kind.open !== undefined;
