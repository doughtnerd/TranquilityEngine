// The Move to… dialog's rules (ADR 0349): the project's folders as a tree (the project root at the top), a search
// that lists matching folders by path, and which folders can't take what is being moved: the folder each item is
// already in (nothing would move), and a moved folder itself and everything inside it. Paths are project-relative
// with `/`; the root is "".

import { fileName, folderOf } from "../projectPath";

/** What is being moved: a file or a folder, by its path. */
export interface MovingItem {
  readonly path: string;
  readonly folder: boolean;
}

export interface FolderNode {
  readonly path: string;
  readonly name: string;
  readonly children: readonly FolderNode[];
}


const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/** Why `items` can't move into `target`, or null when they can. */
export function whyNotMoveTo(target: string, items: readonly MovingItem[]): string | null {
  if (items.length === 0) return "Nothing to move";
  const self = items.find((i) => i.folder && inside(target, i.path));
  if (self) return target === self.path ? "A folder can't go into itself" : "A folder can't go into a folder inside it";
  if (items.every((i) => folderOf(i.path) === target)) return items.length === 1 ? "It's already in this folder" : "They're already in this folder";
  return null;
}

/** Every folder path in `folders` plus their ancestors, without duplicates, sorted, the root ("") first. */
export function allFolders(folders: Iterable<string>): string[] {
  const set = new Set<string>([""]);
  for (const f of folders) {
    const clean = f.replace(/^\/+|\/+$/g, "");
    for (let p = clean; p !== ""; p = folderOf(p)) set.add(p);
  }
  return [...set].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })));
}

/** The folders as a tree under the root node (`rootName`, path ""). */
export function folderTree(folders: Iterable<string>, rootName = "Project"): FolderNode {
  const all = allFolders(folders);
  const childrenOf = new Map<string, string[]>();
  for (const p of all) if (p !== "") (childrenOf.get(folderOf(p)) ?? childrenOf.set(folderOf(p), []).get(folderOf(p))!).push(p);
  const build = (path: string, name: string): FolderNode => ({ path, name, children: (childrenOf.get(path) ?? []).map((c) => build(c, fileName(c))) });
  return build("", rootName);
}

/** The folders whose path contains `query` (any case), in order, always after the top level (""), which can't be typed; every folder when the query is blank. */
export function searchFolders(folders: Iterable<string>, query: string): string[] {
  const q = query.trim().toLowerCase();
  const all = allFolders(folders);
  return q === "" ? all : all.filter((p) => p === "" || p.toLowerCase().includes(q));
}

/** Every item is already in `folder` (the dialog marks it "here now"). */
export const isCurrentFolder = (folder: string, items: readonly MovingItem[]): boolean => items.length > 0 && items.every((i) => folderOf(i.path) === folder);

/** The folder to start on: the first item's folder when it can take nothing (it's where they are), so the user picks another. */
export const startFolder = (items: readonly MovingItem[]): string => (items.length > 0 ? folderOf(items[0].path) : "");
