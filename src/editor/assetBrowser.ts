// Asset browser logic (ADR 0022): the project's files, path helpers and search. No UI here; `ui/Assets.tsx`
// renders it. The scene nodes adding an asset makes come from its kind and the node insertion (nodeInsertion.ts, ADR 0246), entries' encoding in assetEntry.ts (ADR 0241).
import { fileName, folderOf } from "./projectPath";
import { isSidecarPath } from "../engine/scene/importSettings";
import { assetKind, hasSlices } from "./assetKindLookup";
import { isSliceEntry, sliceEntry, splitSliceEntry } from "./assetEntry";

// The kind of a file and what it can do are the asset kind module's (ADR 0143); re-exported for the
// many callers that have always imported them from here.
export { assetKind, canAddToScene, opensInCodePanel, type AssetKind, type CoreAssetKind } from "./assetKindLookup";

/** Files the Assets panel lists: everything but import settings sidecars, which travel with their files. */
export const listedFiles = (files: readonly string[]) => files.filter((f) => !isSidecarPath(f));

/** Files whose name contains every word of `query` (case-insensitive), across all folders. */
function searchFiles(files: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return files.filter((f) => words.every((w) => fileName(f).toLowerCase().includes(w))).sort((a, b) => fileName(a).localeCompare(fileName(b)));
}

/**
 * Search results including slices (ADR 0115): the files `searchFiles` finds, plus a slice entry
 * (`images/a.png#walk_0`) for each slice of a file (a kind with slices) whose name contains every word. `sliceNames`
 * gives an image's slice names. Sorted by name ("hero" sorts before "hero_walk", so slices named after their image list before it).
 */
export function searchEntries(files: readonly string[], query: string, sliceNames: (image: string) => readonly string[]): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out = [...searchFiles(files, query)];
  for (const f of files) {
    if (!hasSlices(assetKind(f))) continue;
    for (const name of sliceNames(f)) if (words.every((w) => name.toLowerCase().includes(w))) out.push(sliceEntry(f, name));
  }
  const key = (e: string) => (isSliceEntry(e) ? splitSliceEntry(e).slice : fileName(e));
  return out.sort((a, b) => key(a).localeCompare(key(b)) || (isSliceEntry(a) ? 1 : 0) - (isSliceEntry(b) ? 1 : 0));
}
