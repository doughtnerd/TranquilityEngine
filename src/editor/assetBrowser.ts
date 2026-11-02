// Asset browser logic (ADR 0022): the project's files as a folder tree, search, and the scene
// nodes that adding an asset creates. No UI here; `ui/Assets.tsx` renders it.
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import { wouldNest } from "./prefabs";
import type { OpenScene } from "./state";

export type AssetKind = "scene" | "prefab" | "image" | "audio" | "json" | "script" | "javascript" | "other";

export function assetKind(path: string): AssetKind {
  const p = path.toLowerCase();
  if (p.endsWith(".scene.json")) return "scene";
  if (p.endsWith(".prefab.json")) return "prefab";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(p)) return "image";
  if (/\.(mp3|ogg|wav)$/.test(p)) return "audio";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".ts") && !p.endsWith(".d.ts")) return "script";
  if (p.endsWith(".js")) return "javascript";
  return "other";
}

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

/** A sprite node showing an image: a Transform at `position` and a SpriteRenderer sized by pixels per unit. */
export function spriteNodeEntry(doc: SceneDocument, imagePath: string, position: readonly [number, number, number] = [0, 0, 0]): NodeEntry {
  const name = fileName(imagePath).replace(/\.[^.]+$/, "");
  return {
    id: uniqueId(doc, idBase(imagePath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.SpriteRenderer", data: { sprite: `asset:${imagePath}` } },
    ],
  };
}

/** True for assets that have a scene node to become: prefabs and scenes, images, audio. */
export const canAddToScene = (path: string) => ["prefab", "scene", "image", "audio"].includes(assetKind(path));

/**
 * Why `path` can't be added to the document, or null if it can: assets with no node type, and
 * scenes or prefabs that would end up containing themselves.
 */
export function whyNotAddable(doc: SceneDocument, path: string): string | null {
  if (!canAddToScene(path)) return "no kind of scene node fits this file";
  const kind = assetKind(path);
  if ((kind === "scene" || kind === "prefab") && wouldNest(path, doc.path)) return "it would end up inside itself";
  return null;
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

/** The scene entry an asset becomes: an instance (prefab, scene), a sprite (image) or an audio source (audio). */
export function nodeForAsset(doc: SceneDocument, path: string, options: AddOptions = {}): NodeEntry | null {
  switch (assetKind(path)) {
    case "prefab":
    case "scene":
      return prefabInstanceEntry(doc, path, options.placeInstances ? options.position : undefined);
    case "image":
      return spriteNodeEntry(doc, path, options.position);
    case "audio":
      return audioNodeEntry(doc, path, options.position);
    default:
      return null;
  }
}

/** Add an asset to the open scene as one undoable command. Returns the new node's id; throws if it can't be added. */
export function addAsset(scene: OpenScene, path: string, options: AddOptions = {}): string {
  const reason = whyNotAddable(scene.doc, path);
  const entry = reason ? null : nodeForAsset(scene.doc, path, options);
  if (!entry) throw new Error(reason ?? `"${path}" can't be added to a scene.`);
  scene.stack.execute(new AddNode(entry, { parent: options.parent ?? null, index: options.index }));
  return entry.id;
}

/**
 * The asset browser's + button: add under the selection (see `parentForAdd`). Sprites and audio
 * go at `position` (e.g. the scene camera's focus point). Returns the new node's id.
 */
export function addAssetToScene(scene: OpenScene, path: string, selected: string | null, position: Vec3 = [0, 0, 0]): string {
  return addAsset(scene, path, { parent: parentForAdd(scene.doc, selected), position });
}
