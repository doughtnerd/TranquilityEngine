// The scene nodes adding an asset makes (ADR 0149), beside `addAssets.ts`, which is how editor features add
// them: where an added node goes, the entries for an instance, a sprite and an audio source (kinds'
// `addToScene.nodes` use these), and the one undoable command that adds an asset's entries.
import { fileName } from "./assetBrowser";
import { splitSliceEntry } from "./assetEntry";
import { sceneNodesAt } from "./assetKindLookup";
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import type { OpenScene } from "./state";

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
