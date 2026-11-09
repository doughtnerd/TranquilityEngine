// Asset browser logic (ADR 0022): the project's files as a folder tree, search, and path helpers.
// No UI here; `ui/Assets.tsx` renders it. An entry's encoding is `assetEntry.ts`'s (ADR 0157); the
// scene nodes adding an asset makes are `assetNodes.ts`'s.
import { isSidecarPath } from "../engine/scene/importSettings";
import { isSliceEntry, sliceEntry, splitSliceEntry } from "./assetEntry";
import { assetKind, hasSlices } from "./assetKindLookup";

// The kind of a file and what it can do are the asset kind module's (ADR 0143); re-exported for the
// many callers that have always imported them from here.
export { assetKind, canAddToScene, opensInCodePanel, type AssetKind, type CoreAssetKind } from "./assetKindLookup";

/** Files the Assets panel lists: everything but import settings sidecars, which travel with their files. */
export const listedFiles = (files: readonly string[]) => files.filter((f) => !isSidecarPath(f));

/** The file name of a project path: `images/bird.png` → `bird.png`. */
export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The folder of a project path: `images/bird.png` → `images`, `project.json` → `""` (the root). */
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export interface Folder {
  /** Folder name; `""` for the project root. */
  readonly name: string;
  /** Project-relative folder path; `""` for the root. */
  readonly path: string;
  readonly folders: Folder[];
  /** Files directly in this folder, sorted. */
  readonly files: string[];
}

/** Build the folder tree for a list of project-relative file paths. Folders and files are sorted. */
export function buildFolderTree(files: readonly string[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    let folder = root;
    const parts = file.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = folder.folders.find((f) => f.path === path);
      if (!next) {
        next = { name: parts[i], path, folders: [], files: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.files.sort((a, b) => fileName(a).localeCompare(fileName(b)));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** The folder at `path`, or null if it doesn't exist (e.g. after a project switch). */
export function findFolder(root: Folder, path: string): Folder | null {
  if (path === "") return root;
  for (const f of root.folders) {
    if (f.path === path) return f;
    if (path.startsWith(f.path + "/")) return findFolder(f, path);
  }
  return null;
}

/** Files whose name contains every word of `query` (case-insensitive), across all folders. */
export function searchFiles(files: readonly string[], query: string): string[] {
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
