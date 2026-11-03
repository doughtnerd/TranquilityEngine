// Particle effect assets in the editor (ADR 0057): creating `*.particles.json` files, and reading and
// writing them for the Inspector's effect editor (an asset's, or a ParticleSystem's referenced one).
import { defaultParticleEffect, formatParticleEffect, parseParticleEffect, type ParticleEffect } from "../engine/scene/particles";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";

export interface ReadEffect {
  effect: ParticleEffect;
  /** What's wrong with the file (bad values read as the defaults). */
  problems: string[];
}

/** A particle effect asset as the file holds it now. */
export function readEffect(project: EditorProject, path: string): ReadEffect {
  try {
    return parseParticleEffect(project.assets.get(path), path);
  } catch (err) {
    return { effect: defaultParticleEffect(), problems: [(err as Error).message] };
  }
}

/** Each effect's writes in progress, so quick edits apply one after another. */
const writing = new Map<string, Promise<unknown>>();

/** Write a particle effect asset after the writes before it. Throws for a read-only project. */
export function writeEffect(project: EditorProject, path: string, effect: ParticleEffect): Promise<void> {
  const run = () => project.writeText(path, formatParticleEffect(effect));
  const result = (writing.get(path) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => writing.get(path) === settled && writing.delete(path));
  return result;
}

/** Where New Particle Effect goes by default: `effects/` if the project has it, else the folder given. */
export function effectFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("effects") ? "effects" : folder;
}

/**
 * Create `New Particle Effect.particles.json` (or `… 2`) in `folder`, holding `effect` (the default
 * fountain when omitted). Returns its path, or null if the project is read-only or writing failed.
 */
export async function createParticleEffect(folder: string, effect: ParticleEffect = defaultParticleEffect(), name = "New Particle Effect"): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add particle effects.` };
    return null;
  }
  const path = freePath(project, effectFolder(folder), `${name}.particles.json`);
  try {
    await writeEffect(project, path, effect);
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}
