// Asset browser logic (ADR 0022): the project's files as a folder tree, search, and the scene
// nodes that adding an asset creates. No UI here; `ui/Assets.tsx` renders it.
import { isSidecarPath } from "../engine/scene/importSettings";
import { assetKind, hasSlices, sceneNodesAt } from "./assetKindLookup";
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import type { OpenScene } from "./state";

// The kind of a file and what it can do are the asset kind module's (ADR 0143); re-exported for the
// many callers that have always imported them from here.
export { assetKind, canAddToScene, opensInCodePanel, type AssetKind, type CoreAssetKind } from "./assetKindLookup";

/** A slice of an image as an asset entry (ADR 0040): `images/sheet.png#walk_0`. */
export const sliceEntry = (image: string, slice: string) => `${image}#${slice}`;
/** True for a slice entry (an image path with `#name`). */
export const isSliceEntry = (entry: string) => entry.includes("#") && assetKind(entry) === "sprite";
/** The image a slice entry belongs to, and the slice's name. */
export function splitSliceEntry(entry: string): { image: string; slice: string } {
  const i = entry.indexOf("#");
  return { image: entry.slice(0, i), slice: entry.slice(i + 1) };
}
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

/** A node id from a file name: `pipe-pair.prefab.json` → `pipe-pair`, `flappyBird.png` → `flappy-bird`. */
export function idBase(path: string): string {
  const base = fileName(path).replace(/\.(scene|prefab)\.json$/i, "").replace(/\.[^.]+$/, "");
  const id = base
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "node";
}

/** `base`, or `base-2`, `base-3`… whichever isn't used in the document yet. */
export function uniqueId(doc: SceneDocument, base: string): string {
  if (!doc.has(base)) return base;
  for (let n = 2; ; n++) if (!doc.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Where an added node goes: under the selected node, or beside it when the selection is a prefab
 * instance (its contents come from the prefab file); top level when nothing is selected.
 */
export function parentForAdd(doc: SceneDocument, selected: string | null): string | null {
  // A selection inside a prefab instance is a path key ("pipe/top"): use its instance.
  const id = selected?.split("/")[0] ?? null;
  if (!id || !doc.has(id)) return null;
  return doc.isPrefabInstance(id) ? doc.parentOf(id) : id;
}

type Vec3 = readonly [number, number, number];

/**
 * The scene entry for an instance of a prefab or scene file. With `position`, the instance gets
 * a Transform override placing it there (a prefab's own position applies otherwise).
 */
export function prefabInstanceEntry(doc: SceneDocument, prefabPath: string, position?: Vec3): NodeEntry {
  const entry: NodeEntry = { id: uniqueId(doc, idBase(prefabPath)), prefab: prefabPath };
  if (position) entry.overrides = [{ component: "engine.Transform", field: "position", value: [...position] }];
  return entry;
}

/** An audio node: a Transform at `position` and an AudioSource playing the clip. */
export function audioNodeEntry(doc: SceneDocument, audioPath: string, position: Vec3 = [0, 0, 0]): NodeEntry {
  const name = fileName(audioPath).replace(/\.[^.]+$/, "");
  return {
    id: uniqueId(doc, idBase(audioPath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.AudioSource", data: { clip: `asset:${audioPath}` } },
    ],
  };
}

/**
 * A sprite node showing an image, or a slice of one (`images/sheet.png#walk_0`, named after the
 * slice): a Transform at `position` and a SpriteRenderer sized by pixels per unit.
 */
export function spriteNodeEntry(doc: SceneDocument, imagePath: string, position: readonly [number, number, number] = [0, 0, 0]): NodeEntry {
  const slice = imagePath.includes("#") ? splitSliceEntry(imagePath).slice : null;
  const name = slice ?? fileName(imagePath).replace(/\.[^.]+$/, "");
  return {
    id: uniqueId(doc, slice !== null ? idBase(`${slice}.x`) : idBase(imagePath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.SpriteRenderer", data: { sprite: `asset:${imagePath}` } },
    ],
  };
}

/** Load what adding these assets needs to know first (a registered kind's `addToScene.prepare`: models' meshes). Never rejects (a model that fails adds as one node). */
export async function prepareAssets(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => sceneNodesAt(p)?.prepare?.(p).catch(() => undefined)));
}

/**
 * Why `path` can't be added to the document, or null if it can: assets with no node type, and what
 * its kind refuses (`addToScene.whyNot`, ADR 0149: scenes or prefabs that would end up inside themselves).
 */
export function whyNotAddable(doc: SceneDocument, path: string): string | null {
  const add = sceneNodesAt(path);
  if (!add) return "no kind of scene node fits this file";
  return add.whyNot?.(doc, path) ?? null;
}

export interface AddOptions {
  /** Parent document node id; null or omitted for the top level. */
  parent?: string | null;
  /** Position among the parent's children; omitted: last. */
  index?: number;
  /** Where the node goes, in its parent's space. */
  position?: Vec3;
  /** Also place prefab and scene instances at `position` (viewport drops); otherwise they keep their own. */
  placeInstances?: boolean;
}

/** The scene entry an asset becomes: an instance (prefab, scene), a sprite (image), an audio source (audio), or what a plugin's kind makes. */
export function nodeForAsset(doc: SceneDocument, path: string, options: AddOptions = {}): NodeEntry | null {
  return sceneEntriesForAsset(doc, path, options)[0] ?? null;
}

/** Every entry adding `path` makes, from its kind's `addToScene` (ADR 0140, 0143): the root first (`nodeForAsset`), then any descendants (a model's node tree). */
function sceneEntriesForAsset(doc: SceneDocument, path: string, options: AddOptions): NodeEntry[] {
  const add = sceneNodesAt(path);
  if (!add) return [];
  return add.nodes(doc, path, add.keepsOwnPosition && !options.placeInstances ? undefined : options.position);
}

/**
 * Add one asset to the scene as one undoable command, with nothing around it: no preparing, no
 * checks of the scene or play mode, no note. Returns the entries added, the root first; throws if
 * it can't be added. Editor features add assets through `addAssets` (addAssets.ts, ADR 0149).
 */
export function addAssetEntries(scene: OpenScene, path: string, options: AddOptions = {}): NodeEntry[] {
  const reason = whyNotAddable(scene.doc, path);
  const entries = reason ? [] : sceneEntriesForAsset(scene.doc, path, options);
  if (!entries[0]) throw new Error(reason ?? `"${path}" can't be added to a scene.`);
  scene.stack.execute(new AddNode(entries, { parent: options.parent ?? null, index: options.index }));
  return entries;
}

/** `addAssetEntries`, returning the new root node's id. */
export const addAsset = (scene: OpenScene, path: string, options: AddOptions = {}): string => addAssetEntries(scene, path, options)[0]!.id;
