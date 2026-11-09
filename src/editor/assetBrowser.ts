// Asset browser logic (ADR 0022): the project's files as a folder tree, search, and the scene
// nodes that adding an asset creates (its kind's `addToScene` policy). No UI here; `ui/Assets.tsx`
// renders it. Which kind a file is: `assetKinds.ts`, re-exported here.
import { isSidecarPath } from "../engine/scene/importSettings";
import { composeMatrix, localPoseFromMatrix } from "../engine/render/gizmoMath";
import { modelTreeIfLoaded, type NodePose } from "../engine/scene/models";
import { assetKind, assetKindFor } from "./assetKinds";
import { fileName, idBase, uniqueId } from "./assetNodeEntries";
import { logMessage } from "./messages";
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import { wouldNest } from "./prefabs";
import type { OpenScene } from "./state";

export { assetKind, assetKindFor, assetKindInfo, opensInCodePanel, type AssetKind, type CoreAssetKind } from "./assetKinds";
export { audioNodeEntry, fileName, idBase, prefabInstanceEntry, spriteNodeEntry, uniqueId } from "./assetNodeEntries";

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
 * (`images/a.png#walk_0`) for each slice of an image whose name contains every word. `sliceNames`
 * gives an image's slice names. Sorted by name ("hero" sorts before "hero_walk", so slices named after their image list before it).
 */
export function searchEntries(files: readonly string[], query: string, sliceNames: (image: string) => readonly string[]): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out = [...searchFiles(files, query)];
  for (const f of files) {
    if (assetKind(f) !== "image") continue;
    for (const name of sliceNames(f)) if (words.every((w) => name.toLowerCase().includes(w))) out.push(sliceEntry(f, name));
  }
  const key = (e: string) => (isSliceEntry(e) ? splitSliceEntry(e).slice : fileName(e));
  return out.sort((a, b) => key(a).localeCompare(key(b)) || (isSliceEntry(a) ? 1 : 0) - (isSliceEntry(b) ? 1 : 0));
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
 * A model's node (ADR 0044): a Transform at `position` and a MeshRenderer drawing the whole
 * model; for a model of several meshes (or with lights or cameras, ADR 0118), an empty node with
 * the file's node tree under it instead (each mesh's node draws `#mesh`), so parts can be hidden,
 * given their own material or a collider. The root comes first. Until the model has loaded (see
 * `prepareAssets`), it's one node drawing the whole model.
 *
 * Poses (ADR 0118): with the model's `pivots` import setting at "model", meshes and group nodes sit
 * at their parent's origin (meshes are in model space); at "node", every node gets its own pose from
 * the file (and `#mesh` is in its node's space). Lights and cameras always get their pose. A
 * camera's Camera component arrives turned off, so a dropped model never takes over the view.
 */
export function modelNodeEntries(doc: SceneDocument, modelPath: string, position: Vec3 = [0, 0, 0]): NodeEntry[] {
  const name = fileName(modelPath).replace(/\.[^.]+$/, "");
  const id = uniqueId(doc, idBase(modelPath));
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  const tree = modelTreeIfLoaded(modelPath);
  const meshes = tree?.meshes ?? [];
  const extras = (tree?.nodes ?? []).filter((n) => n.light || n.camera);
  if (meshes.length <= 1 && !extras.length) {
    return [{ id, name: title, components: [{ type: "engine.Transform", data: { position: [...position] } }, { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}` } }] }];
  }
  const nodePivots = tree!.pivots === "node";
  // The file's node tree (ADR 0088), less the levels every node shares. A mesh's node is the parent of the nodes under it.
  const allPaths = [...meshes.map((m) => m.path), ...extras.map((n) => n.path)];
  let shared = allPaths[0].length;
  for (const path of allPaths) {
    let i = 0;
    while (i < shared && i < path.length && path[i] === allPaths[0][i]) i++;
    shared = i;
  }
  const groupPoses = new Map((tree?.nodes ?? []).filter((n) => !n.light && !n.camera).map((n) => [[...n.path, n.name].join("/"), n.pose]));
  const taken = new Set([id]);
  const childId = (label: string) => {
    let child = uniqueId(doc, `${id}-${idBase(`${label}.x`)}`);
    for (let n = 2; taken.has(child); n++) child = uniqueId(doc, `${id}-${idBase(`${label}.x`)}-${n}`);
    taken.add(child);
    return child;
  };
  const entries: NodeEntry[] = [{ id, name: title, components: [{ type: "engine.Transform", data: { position: [...position] } }] }];
  /** Each kept node's model-space matrix (null: the model's origin), to give children their local pose. */
  const matrices = new Map<string, Float64Array | null>([[id, null]]);
  const byKey = new Map<string, NodeEntry>();
  const keyOf = (segments: readonly string[]) => segments.join("/");
  const transformData = (parent: string, pose: NodePose | undefined, own: string): Record<string, unknown> => {
    const matrix = pose ? composeMatrix(vec(pose.position), quat(pose.rotation), vec(pose.scale)) : null;
    matrices.set(own, matrix);
    if (!matrix) return {};
    const local = localPoseFromMatrix(matrices.get(parent) ?? null, matrix);
    const data: Record<string, unknown> = {};
    if (local.position.some((v) => v !== 0)) data.position = local.position;
    if (local.rotation.some((v) => v !== 0)) data.rotation = local.rotation;
    if (local.scale.some((v) => v !== 1)) data.scale = local.scale;
    return data;
  };
  const group = (segments: readonly string[], fullPath: readonly string[]): string => {
    if (!segments.length) return id;
    const key = keyOf(segments);
    const have = byKey.get(key);
    if (have) return have.id;
    const parent = group(segments.slice(0, -1), fullPath.slice(0, -1));
    const label = segments[segments.length - 1];
    const own = childId(label);
    // A mesh's own node may be made here, before its mesh comes (it's the parent of the nodes under it); the mesh fills it in.
    const pose = nodePivots ? groupPoses.get(keyOf(fullPath)) : undefined;
    const entry: NodeEntry = { id: own, name: label, parent, components: [{ type: "engine.Transform", data: transformData(parent, pose, own) }] };
    byKey.set(key, entry);
    entries.push(entry);
    return entry.id;
  };
  for (const mesh of meshes) {
    const full = [...mesh.path, mesh.name];
    const segments = full.slice(shared);
    const renderer = { type: "engine.MeshRenderer", data: { mesh: `asset:${modelPath}#${mesh.name}` } };
    const existing = byKey.get(keyOf(segments));
    if (existing && !existing.components!.some((c) => c.type === "engine.MeshRenderer")) {
      existing.components!.push(renderer);
      continue;
    }
    const parent = group(segments.slice(0, -1), full.slice(0, -1));
    const own = childId(mesh.name);
    const entry: NodeEntry = { id: own, name: mesh.name, parent, components: [{ type: "engine.Transform", data: transformData(parent, nodePivots ? mesh.pose : undefined, own) }, renderer] };
    if (!existing) byKey.set(keyOf(segments), entry);
    entries.push(entry);
  }
  for (const node of extras) {
    const full = [...node.path, node.name];
    const parent = group(full.slice(shared, -1), full.slice(0, -1));
    const own = childId(node.name);
    const components: NonNullable<NodeEntry["components"]> = [{ type: "engine.Transform", data: transformData(parent, node.pose, own) }];
    if (node.light) {
      const l = node.light;
      const hex = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
      const data: Record<string, unknown> = { type: l.type, color: `#${hex(l.color[0])}${hex(l.color[1])}${hex(l.color[2])}`, intensity: l.intensity };
      if (l.type !== "directional") data.range = l.range;
      if (l.type === "spot") {
        data.spotAngle = Math.round(l.spotAngle * 1e4) / 1e4;
        data.spotSoftness = Math.round(l.spotSoftness * 1e4) / 1e4;
      }
      components.push({ type: "engine.Light", data });
    }
    if (node.camera) {
      const c = node.camera;
      const data: Record<string, unknown> = { projection: c.projection, near: c.near, far: c.far };
      if (c.projection === "perspective") data.fieldOfView = Math.round(c.fieldOfView * 1e4) / 1e4;
      else data.orthographicSize = c.orthographicSize;
      components.push({ type: "engine.Camera", enabled: false, data });
    }
    entries.push({ id: own, name: node.name, parent, components });
  }
  return entries;
}

const vec = (v: readonly number[]) => ({ x: v[0], y: v[1], z: v[2] });
const quat = (q: readonly number[]) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

/** The cameras a model's drop adds turned off (ADR 0118), for the message saying so. */
export function disabledModelCameras(entries: readonly NodeEntry[]): number {
  return entries.filter((e) => e.components?.some((c) => c.type === "engine.Camera" && c.enabled === false)).length;
}

/** What adding a file of `path`'s kind to a scene makes: its kind's `addToScene` policy (ADR 0140), or undefined. */
const sceneNodesOf = (path: string) => assetKindFor(path)?.addToScene;

/** Load what adding these assets needs to know first (a kind's `addToScene.prepare`: models' meshes). Never rejects (a model that fails adds as one node). */
export async function prepareAssets(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => sceneNodesOf(p)?.prepare?.(p).catch(() => undefined)));
}

/** True for assets that have a scene node to become: kinds with an `addToScene` policy (prefabs and scenes, images, audio, models, particle effects). */
export const canAddToScene = (path: string) => sceneNodesOf(path) !== undefined;

/**
 * Why `path` can't be added to the document, or null if it can: assets with no node type, and
 * scenes or prefabs that would end up containing themselves.
 */
export function whyNotAddable(doc: SceneDocument, path: string): string | null {
  if (!canAddToScene(path)) return "no kind of scene node fits this file";
  if (sceneNodesOf(path)?.instance && wouldNest(path, doc.path)) return "it would end up inside itself";
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
  return sceneEntriesForAsset(doc, path, options)[0] ?? null;
}

/** Every entry adding `path` makes: the root first (`nodeForAsset`), then any descendants (a model's node tree). */
function sceneEntriesForAsset(doc: SceneDocument, path: string, options: AddOptions): NodeEntry[] {
  const nodes = sceneNodesOf(path);
  if (!nodes) return [];
  // Instances keep their own position unless placed (viewport drops).
  return nodes.nodes(doc, path, nodes.instance && !options.placeInstances ? undefined : options.position);
}

/** Add an asset to the open scene as one undoable command. Returns the new node's id; throws if it can't be added. */
export function addAsset(scene: OpenScene, path: string, options: AddOptions = {}): string {
  const reason = whyNotAddable(scene.doc, path);
  const entries = reason ? [] : sceneEntriesForAsset(scene.doc, path, options);
  const entry = entries[0];
  if (!entry) throw new Error(reason ?? `"${path}" can't be added to a scene.`);
  scene.stack.execute(new AddNode(entries, { parent: options.parent ?? null, index: options.index }));
  const cameras = disabledModelCameras(entries);
  if (cameras) logMessage("info", `${path}: its ${cameras === 1 ? "camera was" : `${cameras} cameras were`} added with the Camera component turned off, so it doesn't take over the view; enable it to look through it.`);
  return entry.id;
}

/**
 * The asset browser's + button: add under the selection (see `parentForAdd`). Sprites and audio
 * go at `position` (e.g. the scene camera's focus point). Returns the new node's id.
 */
export function addAssetToScene(scene: OpenScene, path: string, selected: string | null, position: Vec3 = [0, 0, 0]): string {
  return addAsset(scene, path, { parent: parentForAdd(scene.doc, selected), position });
}
