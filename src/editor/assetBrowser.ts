// Asset browser logic (ADR 0022): the project's files as a folder tree, search, and the scene
// nodes that adding an asset creates. No UI here; `ui/Assets.tsx` renders it.
import { isSidecarPath } from "../engine/scene/importSettings";
import { composeMatrix, localPoseFromMatrix } from "../engine/render/gizmoMath";
import { MODEL_EXTENSIONS, loadModel, modelTreeIfLoaded, type NodePose } from "../engine/scene/models";
import { matchRegisteredKind } from "./assetKindLookup";
import { logMessage } from "./messages";
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import { wouldNest } from "./prefabs";
import type { OpenScene } from "./state";

/** The kinds the editor itself knows; plugins add more (ADR 0133). */
export type BuiltinAssetKind = "scene" | "prefab" | "image" | "sprite" | "audio" | "model" | "material" | "rendertexture" | "shadergraph" | "shadersubgraph" | "particles" | "particlesubgraph" | "particleblock" | "formation" | "tileset" | "environment" | "sky" | "cubemap" | "lut" | "json" | "script" | "javascript" | "typescript" | "text" | "uidocument" | "stylesheet" | "xml" | "other";
/** A built-in kind or a registered one's id. */
export type AssetKind = BuiltinAssetKind | (string & {});

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
  // A registered kind wins when its extension is at least as long as the built-in rule's (ADR 0133).
  const registered = matchRegisteredKind(p);
  if (registered) {
    const builtin = builtinKind(p);
    if (builtin === "other" || registered.length >= builtinExtensionLength(p)) return registered.kind.id;
    return builtin;
  }
  return builtinKind(p);
}

/** The length of the ending a built-in rule matched: a compound one (`.scene.json`) or the last extension. Used so a registered kind with a longer extension wins. */
function builtinExtensionLength(p: string): number {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const compound = /\.(scene|prefab|material|rendertexture|shadergraph|shadersubgraph|particles|particlesubgraph|particleblock|formation|tileset|sky|cubemap|ui)\.(json|xml)$/.exec(name);
  return compound ? compound[0].length : name.length - Math.max(name.lastIndexOf("."), 0);
}

function builtinKind(p: string): BuiltinAssetKind {
  if (p.endsWith(".scene.json")) return "scene";
  if (p.endsWith(".prefab.json")) return "prefab";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(p)) return "image";
  if (/\.(hdr|exr|dds)$/.test(p) || /[^/]\.env$/.test(p)) return "environment";
  if (p.endsWith(".cube")) return "lut";
  if (/\.(mp3|ogg|wav)$/.test(p)) return "audio";
  if (MODEL_EXTENSIONS.test(p)) return "model";
  if (p.endsWith(".material.json")) return "material";
  if (p.endsWith(".rendertexture.json")) return "rendertexture";
  if (p.endsWith(".shadergraph.json")) return "shadergraph";
  if (p.endsWith(".shadersubgraph.json")) return "shadersubgraph";
  if (p.endsWith(".particles.json")) return "particles";
  if (p.endsWith(".particlesubgraph.json")) return "particlesubgraph";
  if (p.endsWith(".particleblock.json")) return "particleblock";
  if (p.endsWith(".formation.json")) return "formation";
  if (p.endsWith(".tileset.json")) return "tileset";
  if (p.endsWith(".sky.json")) return "sky";
  if (p.endsWith(".cubemap.json")) return "cubemap";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".ui.xml")) return "uidocument";
  if (p.endsWith(".css")) return "stylesheet";
  if (p.endsWith(".xml")) return "xml";
  if (p.endsWith(".ts") && !p.endsWith(".d.ts")) return "script";
  if (/\.(js|mjs|cjs)$/.test(p)) return "javascript";
  if (/\.(mts|cts)$/.test(p)) return "typescript";
  if (/\.(md|txt)$/.test(p)) return "text";
  return "other";
}

/** Kinds that open in the Code panel: scripts, plain JSON, JavaScript and TypeScript modules, and text (scenes, prefabs and graphs open in their own views). */
const CODE_KINDS: ReadonlySet<AssetKind> = new Set(["script", "json", "javascript", "typescript", "text", "uidocument", "stylesheet", "xml"]);
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
