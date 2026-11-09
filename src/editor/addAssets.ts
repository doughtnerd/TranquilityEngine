// Adding assets to the open scene as one operation (ADR 0149): the Assets panel's + and a drop on the
// scene view or the Hierarchy all go through `addAssets`, which prepares the assets (a model's meshes,
// ADR 0044), checks the scene is still open and in edit mode, asks each asset's kind whether it can
// be added, adds them all as one undo step, logs what their kinds have to say about the add, and
// returns the new nodes' ids and the status message. Kinds supply their refusals (`addToScene.whyNot`)
// and notes (`addToScene.note`); nothing here knows a kind by name.
import { fileName } from "./assetBrowser";
import { isFolderEntry } from "./assetEntry";
import { addAssetEntries, parentForAdd, prepareAssets, whyNotAddable, type AddOptions } from "./assetNodes";
import { sceneNodesAt } from "./assetKindLookup";
import type { NodeEntry } from "./document";
import { errorStatus, logMessage } from "./messages";
import { openScene, playState, type OpenScene, type Status } from "./state";

type Vec3 = readonly [number, number, number];

/** Where added assets go. */
export type AssetAddTarget =
  /** A drop on the scene view: the scene's top level at `position`, prefab and scene instances placed there too. */
  | { readonly kind: "point"; readonly position: Vec3 }
  /** A drop on the Hierarchy: under `parent` (null: the top level), from `index` on (omitted: last). */
  | { readonly kind: "slot"; readonly parent: string | null; readonly index?: number }
  /** The Assets panel's +: under the selected node (`parentForAdd`) at `position`; instances keep their own. */
  | { readonly kind: "selection"; readonly selected: string | null; readonly position: Vec3 };

/** What `addAssets` did: the new root nodes' ids (empty when nothing was added) and the status message to show. */
export interface AddAssetsResult {
  readonly ids: readonly string[];
  readonly message: Status;
}

/** "bird.png", or "3 assets". */
const nameOf = (paths: readonly string[]) => (paths.length === 1 ? fileName(paths[0]!) : `${paths.length} assets`);

/**
 * Why `paths` can't be added to `scene` now, or null if they can: no scene open, play mode, folders,
 * or what an asset's kind refuses (`whyNotAddable`). Reads the signals, so a component calling it
 * re-renders when the scene or play mode changes. `scene` defaults to the open one.
 */
export function whyNotAddAssets(paths: readonly string[], scene: OpenScene | null = openScene.value): string | null {
  if (!scene) return "Open a scene first";
  if (playState.value !== "edit") return "Stop playing to add assets";
  if (paths.length === 0) return "nothing to add";
  if (paths.some(isFolderEntry)) return "folders can't be added to a scene";
  for (const path of paths) {
    const reason = whyNotAddable(scene.doc, path);
    if (reason) return paths.length === 1 ? reason : `${fileName(path)}: ${reason}`;
  }
  return null;
}

/** The add options for the `i`th asset at `target`. */
function optionsFor(scene: OpenScene, target: AssetAddTarget, i: number): AddOptions {
  switch (target.kind) {
    case "point":
      return { parent: null, position: target.position, placeInstances: true };
    case "slot":
      return { parent: target.parent, index: target.index === undefined ? undefined : target.index + i };
    case "selection":
      return { parent: parentForAdd(scene.doc, target.selected), position: target.position };
  }
}

/**
 * Add `paths` to the scene open now, at `target`, as one undo step. Prepares them first (a model's
 * meshes); if the open scene changed or play started meanwhile, adds nothing. Logs each kind's note
 * about what it added (a model's turned-off cameras). Never rejects: a failure is in the message.
 * The caller selects `ids` and shows `message`.
 */
export async function addAssets(paths: readonly string[], target: AssetAddTarget): Promise<AddAssetsResult> {
  const name = nameOf(paths);
  const scene = openScene.peek();
  const refuse = (reason: string): AddAssetsResult => ({ ids: [], message: { kind: "info", text: `Couldn't add ${name}: ${reason}` } });
  const before = whyNotAddAssets(paths, scene);
  if (before || !scene) return refuse(before ?? "Open a scene first");
  await prepareAssets(paths);
  // The scene the add was asked for, still open and editable: switching tabs while a model loads adds nothing.
  if (openScene.peek() !== scene) return refuse(`${fileName(scene.path)} is no longer the open scene`);
  const after = whyNotAddAssets(paths, scene);
  if (after) return refuse(after);
  const added: { path: string; entries: readonly NodeEntry[] }[] = [];
  scene.stack.beginGroup(`Add ${name}`);
  try {
    paths.forEach((path, i) => added.push({ path, entries: addAssetEntries(scene, path, optionsFor(scene, target, i)) }));
  } catch (err) {
    return { ids: added.map((a) => a.entries[0]!.id), message: errorStatus(`Couldn't add ${name}`, err) };
  } finally {
    scene.stack.endGroup();
  }
  for (const { path, entries } of added) {
    const note = sceneNodesAt(path)?.note?.(path, entries);
    if (note) logMessage("info", `${path}: ${note}`);
  }
  return { ids: added.map((a) => a.entries[0]!.id), message: { kind: "info", text: `Added ${name} to ${fileName(scene.path)}` } };
}
