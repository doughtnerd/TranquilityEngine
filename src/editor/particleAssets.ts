// Creating particle effect assets (ADR 0057, 0060). Core, because the Hierarchy's Create menu
// (`hierarchyActions.ts`) and the embedded-effect migration (`particleMigration.ts`) make effects.
// Opening, reading and editing them is the Particles plugin's (`src/plugins/particles/editor/`,
// ADR 0134), which core never imports: the two deprecated helpers below reach it through its
// registered asset kinds, for the built-in Assets tables until they go.
import type { ParticleGraph } from "../engine/scene/particleGraph";
import { defaultParticleGraph, formatParticleGraph } from "../engine/scene/particleGraphFormat";
import { fileName } from "./assetBrowser";
import { matchRegisteredKind } from "./assetKindLookup";
import { freePath } from "./assetOps";
import { errorStatus } from "./messages";
import { assetKinds } from "./sdk/contributions";
import { currentProject, docVersion, status } from "./state";

/** Where New Particle Effect goes by default: `effects/` if the project has it, else the folder given. */
export function effectFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("effects") ? "effects" : folder;
}

/**
 * Create `New Particle Effect.particles.json` (or `… 2`) in `folder`, holding `graph` (the Simple
 * Loop template when omitted). Returns its path, or null if the project is read-only or writing failed.
 */
export async function createParticleEffect(folder: string, graph: ParticleGraph = defaultParticleGraph(), name = "New Particle Effect"): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add particle effects.` };
    return null;
  }
  const path = freePath(project, effectFolder(folder), `${name}.particles.json`);
  try {
    await project.writeText(path, formatParticleGraph(graph));
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}

/** @deprecated The Particles plugin's asset kind opens these (ADR 0134); kept for the built-in Assets table until it goes. */
export function openParticleGraphAsset(path: string): void {
  matchRegisteredKind(path)?.kind.open?.(path);
}

/** @deprecated The Particles plugin's New… entry (ADR 0134); kept for the built-in Assets menu until it goes. */
export const createParticleSubgraph = (folder: string): Promise<string | null> => assetKinds.get("particlesubgraph")?.create?.create(folder) ?? Promise.resolve(null);

/** @deprecated The Particles plugin's New… entry (ADR 0134); kept for the built-in Assets menu until it goes. */
export const createParticleBlock = (folder: string): Promise<string | null> => assetKinds.get("particleblock")?.create?.create(folder) ?? Promise.resolve(null);
