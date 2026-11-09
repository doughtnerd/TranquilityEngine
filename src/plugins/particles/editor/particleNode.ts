// What adding a particle effect asset to a scene makes (ADR 0057; the `particles` kind's `addToScene`
// policy, ADR 0140): a node playing it, named after the file.
import { fileName, idBase, uniqueId } from "../../../editor/assetNodeEntries";
import type { NodeEntry, SceneDocument } from "../../../editor/document";

/** A node playing a particle effect asset at `position`, named after the file. */
export function particleNodeEntry(doc: SceneDocument, effectPath: string, position: readonly [number, number, number] = [0, 0, 0]): NodeEntry {
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
