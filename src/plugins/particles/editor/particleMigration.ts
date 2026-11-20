// Moving embedded particle effects (ADR 0057's `ParticleSystem.embeddedEffect`) into assets (ADR
// 0060: effects are always assets). Done when the editor opens a scene in a project it can save to: the
// Particles plugin's scene-open migration (ADR 0146).
import { parseParticleGraph } from "../../../engine/scene/particleGraphFormat";
import { editor, type SceneDocument, type OpenScene } from "../../../editor/sdk";

const TYPE = "engine.ParticleSystem";

interface EmbeddedEffect {
  /** The node holding the component. */
  node: string;
  name: string;
  /** Which ParticleSystem on the node (among those of its type). */
  index: number;
  embedded: unknown;
}

/** The ParticleSystems in `doc` that hold an embedded effect and have no effect asset. */
function findEmbeddedEffects(doc: SceneDocument): EmbeddedEffect[] {
  const out: EmbeddedEffect[] = [];
  for (const entry of doc.nodes) {
    let index = 0;
    for (const c of entry.components ?? []) {
      if (c.type !== TYPE) continue;
      const embedded = c.data?.embeddedEffect;
      const effect = c.data?.effect;
      if (embedded !== null && embedded !== undefined && (effect === undefined || effect === null || effect === "")) {
        out.push({ node: entry.id, name: entry.name ?? entry.id, index, embedded });
      }
      index++;
    }
  }
  return out;
}

/** Message shown after moving `count` effects. */
const migrationMessage = (count: number): string => `Moved ${count} embedded particle effect${count === 1 ? "" : "s"} into effects/; save the scene to keep the change.`;

/**
 * Write each embedded effect of `scene` as an asset in `effects/` and point its system at it, as
 * one undo step. Leaves the scene alone in a read-only project (the runtime still plays embedded
 * effects). Returns how many were moved.
 */
export async function migrateEmbeddedEffects(scene: OpenScene): Promise<number> {
  const project = editor.project.current;
  if (!project?.canSave) return 0;
  const found = findEmbeddedEffects(scene.doc);
  if (found.length === 0) return 0;
  const moves: { found: EmbeddedEffect; path: string }[] = [];
  for (const f of found) {
    let graph;
    try {
      graph = parseParticleGraph(f.embedded, `${f.name}'s embedded effect`).graph;
    } catch {
      continue; // unreadable: leave it for the runtime to report
    }
    const path = await editor.assets.create("particles", { folder: "effects", value: graph, name: f.name });
    if (path) moves.push({ found: f, path });
  }
  if (moves.length === 0) return 0;
  // The scene may have changed or closed while the files were written.
  const live = moves.filter((m) => scene.doc.has(m.found.node));
  editor.scene.edit(
    "Move embedded particle effects into assets",
    () => {
      for (const m of live) {
        const place = { scene, path: [m.found.node], type: TYPE, index: m.found.index };
        editor.scene.writeField(place, "effect", `asset:${m.path}`);
        editor.scene.writeField(place, "embeddedEffect", null);
      }
    },
    scene,
  );
  editor.messages.info(migrationMessage(live.length));
  return live.length;
}
