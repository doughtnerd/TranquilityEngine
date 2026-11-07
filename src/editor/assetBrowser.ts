// Asset browser logic (ADR 0022): the project's files as a folder tree, search, and the scene
// nodes that adding an asset creates. No UI here; `ui/Assets.tsx` renders it.
import { isSidecarPath } from "../engine/scene/importSettings";
import { loadModel, meshNamesIfLoaded } from "../engine/scene/models";
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import { wouldNest } from "./prefabs";
import type { OpenScene } from "./state";

export type AssetKind = "scene" | "prefab" | "image" | "sprite" | "audio" | "model" | "material" | "shadergraph" | "shadersubgraph" | "particles" | "formation" | "environment" | "sky" | "cubemap" | "json" | "script" | "javascript" | "typescript" | "text" | "other";

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

export function assetKind(path: string): AssetKind {
  const hash = path.indexOf("#");
  if (hash >= 0) return assetKind(path.slice(0, hash)) === "image" ? "sprite" : "other";
  const p = path.toLowerCase();
  if (p.endsWith(".scene.json")) return "scene";
  if (p.endsWith(".prefab.json")) return "prefab";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(p)) return "image";
  if (/\.(hdr|exr|env|dds)$/.test(p)) return "environment";
  if (/\.(mp3|ogg|wav)$/.test(p)) return "audio";
  if (/\.(obj|fbx)$/.test(p)) return "model";
  if (p.endsWith(".material.json")) return "material";
  if (p.endsWith(".shadergraph.json")) return "shadergraph";
  if (p.endsWith(".shadersubgraph.json")) return "shadersubgraph";
  if (p.endsWith(".particles.json")) return "particles";
  if (p.endsWith(".formation.json")) return "formation";
  if (p.endsWith(".sky.json")) return "sky";
  if (p.endsWith(".cubemap.json")) return "cubemap";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".ts") && !p.endsWith(".d.ts")) return "script";
  if (/\.(js|mjs|cjs)$/.test(p)) return "javascript";
  if (/\.(mts|cts)$/.test(p)) return "typescript";
  if (/\.(md|txt)$/.test(p)) return "text";
  return "other";
}

/** Kinds that open in the Code panel: scripts, plain JSON, JavaScript and TypeScript modules, and text (scenes, prefabs and graphs open in their own views). */
const CODE_KINDS: ReadonlySet<AssetKind> = new Set(["script", "json", "javascript", "typescript", "text"]);
/** True if an asset kind opens in the Code panel. */
export const opensInCodePanel = (kind: AssetKind | "folder") => CODE_KINDS.has(kind as AssetKind);

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

/** A node playing a particle effect asset (ADR 0057), named after the file. */
export function particleNodeEntry(doc: SceneDocument, effectPath: string, position: Vec3 = [0, 0, 0]): NodeEntry {
  const name = fileName(effectPath).replace(/\.particles\.json$/i, "");
  return {
    id: uniqueId(doc, idBase(effectPath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.ParticleSystem", data: { effect: `asset:${effectPath}` } },
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

/**
 * A model's node (ADR 0044): a Transform at `position` and a MeshRenderer drawing the whole
 * model; for a model of several meshes, an empty node with one child per mesh instead (each child
 * at the parent's origin draws `#mesh`, which is in model space), so parts can be hidden, given
 * their own material or a collider. The root comes first. Until the model has loaded (see
 * `prepareAssets`), it's one node drawing the whole model.
 */
export function modelNodeEntries(doc: SceneDocument, modelPath: string, position: Vec3 = [0, 0, 0]): NodeEntry[] {
  const name = fileName(modelPath).replace(/\.[^.]+$/, "");
  const id = uniqueId(doc, idBase(modelPath));
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  const meshes = meshNamesIfLoaded(modelPath) ?? [];
  if (meshes.length <= 1) {
    return [{ id, name: title, components: [{ type: "engine.Transform", data: { position: [...position] } }, { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}` } }] }];
  }
  const taken = new Set([id]);
  const children: NodeEntry[] = meshes.map((mesh) => {
    let child = uniqueId(doc, `${id}-${idBase(`${mesh}.x`)}`);
    for (let n = 2; taken.has(child); n++) child = uniqueId(doc, `${id}-${idBase(`${mesh}.x`)}-${n}`);
    taken.add(child);
    return { id: child, name: mesh, parent: id, components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}#${mesh}` } }] };
  });
  return [{ id, name: title, components: [{ type: "engine.Transform", data: { position: [...position] } }] }, ...children];
}

/** Load what adding these assets needs to know first: models' meshes. Never rejects (a model that fails adds as one node). */
export async function prepareAssets(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.filter((p) => assetKind(p) === "model").map((p) => loadModel(p).catch(() => undefined)));
}

/** True for assets that have a scene node to become: prefabs and scenes, images, audio, models. */
export const canAddToScene = (path: string) => ["prefab", "scene", "image", "sprite", "audio", "model", "particles"].includes(assetKind(path));

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
    case "sprite":
      return spriteNodeEntry(doc, path, options.position);
    case "audio":
      return audioNodeEntry(doc, path, options.position);
    case "model":
      return modelNodeEntries(doc, path, options.position)[0];
    case "particles":
      return particleNodeEntry(doc, path, options.position);
    default:
      return null;
  }
}

/** Add an asset to the open scene as one undoable command. Returns the new node's id; throws if it can't be added. */
export function addAsset(scene: OpenScene, path: string, options: AddOptions = {}): string {
  const reason = whyNotAddable(scene.doc, path);
  const entry = reason ? null : nodeForAsset(scene.doc, path, options);
  if (!entry) throw new Error(reason ?? `"${path}" can't be added to a scene.`);
  const entries = assetKind(path) === "model" ? modelNodeEntries(scene.doc, path, options.position) : [entry];
  scene.stack.execute(new AddNode(entries, { parent: options.parent ?? null, index: options.index }));
  return entry.id;
}

/**
 * The asset browser's + button: add under the selection (see `parentForAdd`). Sprites and audio
 * go at `position` (e.g. the scene camera's focus point). Returns the new node's id.
 */
export function addAssetToScene(scene: OpenScene, path: string, selected: string | null, position: Vec3 = [0, 0, 0]): string {
  return addAsset(scene, path, { parent: parentForAdd(scene.doc, selected), position });
}
