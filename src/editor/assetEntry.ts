// An Assets panel entry (ADR 0157): what the panel lists, selects, copies and drags, as a string.
// - a file: its project path, `images/bird.png`;
// - a folder: its project path and "/", `images/`;
// - a slice of an image (ADR 0040): the image's path, "#" and the slice's name, `images/sheet.png#walk_0`.
// This module is the only one that knows the encoding.
import { assetKind, type AssetKind } from "./assetKindLookup";

/** An Assets panel entry. */
export type AssetEntry = string;

/** The entry for the folder `path` (project-relative): `images` → `images/`. */
export const folderEntry = (path: string): AssetEntry => `${path}/`;
/** The entry for a slice of an image: `images/sheet.png#walk_0`. */
export const sliceEntry = (image: string, slice: string): AssetEntry => `${image}#${slice}`;

/** True for a folder entry (`images/`). */
export const isFolderEntry = (entry: AssetEntry) => entry.endsWith("/");
/** True for a slice entry (an image path with `#name`). */
export const isSliceEntry = (entry: AssetEntry) => entry.includes("#") && assetKind(entry) === "sprite";

/** The image a slice entry belongs to, and the slice's name. */
export function splitSliceEntry(entry: AssetEntry): { image: string; slice: string } {
  const i = entry.indexOf("#");
  return { image: entry.slice(0, i), slice: entry.slice(i + 1) };
}

/** The project path of a file or folder entry: `images/` → `images`, `images/a.png` → `images/a.png`. */
export const entryPath = (entry: AssetEntry) => (isFolderEntry(entry) ? entry.slice(0, -1) : entry);

/** The name the panel shows: a slice's name, else the file or folder name. */
export function entryName(entry: AssetEntry): string {
  if (isSliceEntry(entry)) return splitSliceEntry(entry).slice;
  const path = entryPath(entry);
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The entry's kind: "folder", or its asset kind (a slice's is "sprite"). */
export const entryKind = (entry: AssetEntry): AssetKind | "folder" => (isFolderEntry(entry) ? "folder" : assetKind(entry));

/** The folder an entry is in: `images/a.png` → `images`, `images/` → `""`. */
export function entryFolder(entry: AssetEntry): string {
  const path = isSliceEntry(entry) ? splitSliceEntry(entry).image : entryPath(entry);
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** The entries that are files or folders: slices are listed, but they aren't files to rename, move, copy or delete. */
export const fileEntries = (entries: readonly AssetEntry[]): AssetEntry[] => entries.filter((e) => !isSliceEntry(e));
