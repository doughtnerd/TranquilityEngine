// Adding assets to the open scene as one operation (ADR 0149): the Assets panel's + and a drop on the
// scene view or the Hierarchy all go through `addAssets`, which prepares the assets (a model's meshes,
// ADR 0044), checks the scene is still open and in edit mode, inserts them all as one undo step through the
// node insertion (ADR 0246, which asks each asset's kind whether it can be added and mints ids and names), logs
// what their kinds have to say about the add, and returns the new nodes' keys and the status message. Kinds
// supply their refusals (`addToScene.whyNot`) and notes (`addToScene.note`); nothing here knows a kind by name.
import { fileName } from "./projectPath";
import { sceneNodesAt } from "./assetKindLookup";
import { logMessage } from "./messages";
import { insertNodes, whyNotInsert, type InsertPlace, type InsertSource } from "./nodeInsertion";
import { openScene, type OpenScene, type Status } from "./state";

type Vec3 = readonly [number, number, number];

/** Where added assets go. */
export type AssetAddTarget =
  /** A drop on the scene view: the scene's top level at `position`, prefab and scene instances placed there too. */
  | { readonly kind: "point"; readonly position: Vec3 }
  /** A drop on the Hierarchy: where the drop puts new nodes (ADR 0258; inside a prefab instance, an override). */
  | { readonly kind: "hierarchy"; readonly place: InsertPlace }
  /** The Assets panel's +: into the selected node, beside it when it's a prefab instance (the insertion's `near`), at `position`; instances keep their own. */
  | { readonly kind: "selection"; readonly selected: string | null; readonly position: Vec3 };

/** What `addAssets` did: the new root nodes' keys (empty when nothing was added) and the status message to show. */
export interface AddAssetsResult {
  readonly ids: readonly string[];
  readonly message: Status;
}

/** "bird.png", or "3 assets". */
const nameOf = (paths: readonly string[]) => (paths.length === 1 ? fileName(paths[0]!) : `${paths.length} assets`);

/** The insertion's source and place for adding `paths` at `target`. */
function insertionFor(paths: readonly string[], target: AssetAddTarget): { source: InsertSource; place: InsertPlace } {
  switch (target.kind) {
    case "point":
      return { source: { kind: "assets", paths, position: target.position, placeInstances: true }, place: { kind: "into", key: null } };
    case "hierarchy":
      return { source: { kind: "assets", paths }, place: target.place };
    case "selection":
      return { source: { kind: "assets", paths, position: target.position }, place: { kind: "near", key: target.selected } };
  }
}

/**
 * Why `paths` can't be added to `scene` now, or null if they can: no scene open, play mode, folders,
 * or what an asset's kind refuses (the insertion's `whyNotInsert`). Reads the signals, so a component calling it
 * re-renders when the scene or play mode changes. `scene` defaults to the open one.
 */
export function whyNotAddAssets(paths: readonly string[], scene: OpenScene | null = openScene.value): string | null {
  return whyNotInsert(scene, { kind: "assets", paths }, { kind: "into", key: null });
}

/** Load what adding these assets needs to know first (a registered kind's `addToScene.prepare`: models' meshes). Never rejects (a model that fails adds as one node). */
async function prepareAssets(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => sceneNodesAt(p)?.prepare?.(p).catch(() => undefined)));
}

/**
 * Add `paths` to the scene open now, at `target`, as one undo step. Prepares them first (a model's
 * meshes); if the open scene changed or play started meanwhile, adds nothing. Logs each kind's note
 * about what it added (a model's turned-off cameras). Never rejects: a refusal is in the message.
 * The caller selects `ids` and shows `message`.
 */
export async function addAssets(paths: readonly string[], target: AssetAddTarget): Promise<AddAssetsResult> {
  const name = nameOf(paths);
  const scene = openScene.peek();
  const refuse = (reason: string): AddAssetsResult => ({ ids: [], message: { kind: "info", text: `Couldn't add ${name}: ${reason}` } });
  const before = whyNotAddAssets(paths, scene);
  if (before || !scene) return refuse(before ?? "open a scene first");
  await prepareAssets(paths);
  // The scene the add was asked for, still open and editable: switching tabs while a model loads adds nothing.
  if (openScene.peek() !== scene) return refuse(`${fileName(scene.path)} is no longer the open scene`);
  const { source, place } = insertionFor(paths, target);
  const made = insertNodes(scene, source, place);
  if (!made.ok) return refuse(made.reason);
  made.entries.forEach((entries, i) => {
    const note = sceneNodesAt(paths[i]!)?.note?.(paths[i]!, entries);
    if (note) logMessage("info", `${paths[i]}: ${note}`);
  });
  return { ids: made.keys, message: { kind: "info", text: `Added ${name} to ${fileName(scene.path)}` } };
}
