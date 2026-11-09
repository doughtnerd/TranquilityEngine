import { editor, type NodeEntry, type SceneDocument } from "../../../editor/sdk";
// What adding a particle effect asset to a scene makes (ADR 0057; the `particles` kind's `addToScene`
// policy, ADR 0140): a node playing it, named after the file.

/** A node playing a particle effect asset at `position`, named after the file. */
export function particleNodeEntry(doc: SceneDocument, effectPath: string, position: readonly [number, number, number] = [0, 0, 0]): NodeEntry {
  const name = editor.assets.fileName(effectPath).replace(/\.particles\.json$/i, "");
  return {
    id: editor.scene.uniqueId(doc, editor.scene.idBase(effectPath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.ParticleSystem", data: { effect: `asset:${effectPath}` } },
    ],
  };
}
