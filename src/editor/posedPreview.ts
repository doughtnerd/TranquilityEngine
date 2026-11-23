// What a plugin needs to pose a live preview (ADR 0373, T18b): the nodes an asset adds to a scene, as the plugin's own
// preview content builds on them, and the type of the content a `LargePreview` takes (`posed`). The preview's World is the
// thumbnail renderer's (`thumbnails/index.ts` `previewPosed`): it holds only the nodes the plugin describes, steps while
// the preview is open, and is torn down with it. A Component that needs a World service (an Animator needs the animation
// core) starts it there as it does in any World, so a plugin names no "systems to turn on": it puts the Component in.
import type { NodeTemplate } from "./sdk/contributions";
import { sceneNodesAt } from "./assetKindLookup";

export type { PosedPreviewSpec as PosedPreview } from "../engine/editor";

/**
 * The node templates adding the asset at `path` to a scene would make (its kind's `addToScene`, with other plugins'
 * augments: a skinned model comes with its `Skeleton`, `SkinnedMeshRenderer`s and an `Animator`), the first the root,
 * at `position`; null when the asset adds nothing. Loads what they need first. Never rejects.
 */
export async function assetNodesFor(path: string, position?: readonly [number, number, number]): Promise<NodeTemplate[] | null> {
  const add = sceneNodesAt(path);
  if (!add) return null;
  try {
    await add.prepare?.(path);
    return add.nodes(path, position);
  } catch {
    return null;
  }
}
