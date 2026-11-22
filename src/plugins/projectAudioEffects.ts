// A project's plugin audio effects in the editor and the Studio (ADR 0338 §8): from the plan of the project's plugins
// (`planPluginCode`, the one plan every host runs, with the project's files so a missing module is a problem), each usable
// plugin with an `audio` section goes to the audio plugin's effect set (`effectPlugins/projectSet.ts`): its effects join
// the catalogue and its modules the core's chains and offline renders, or leave them when the plugin is turned off or
// removed. The editor applies it on every project code load and reload (`thirdPartyEditor.ts`), the Studio when it opens
// a project and when a plugin's files change (`studio/boot`). Editor code only.
import type { EditorProject } from "../editor/projects";
import { jsonFiles } from "../editor/projects";
import { joinPath } from "../editor/projectPaths";
import { packageSourceFor } from "../editor/projectPackages";
import { applyEffectPluginSet, effectPluginSetOf, type ReadProjectBytes } from "./audio/runtime/effectPlugins/projectSet";
import { effectPluginEnginesOf } from "./audio/runtime/effectPlugins/engineGate";
import { planPluginCode, type FoundPlugin } from "./thirdParty";

/**
 * A project file's bytes: from its folder when it has one (an npm plugin's module in `node_modules/` included), else
 * through the URL the project serves it at (a sample in memory). Null when it isn't there.
 */
export function projectBytes(project: EditorProject): ReadProjectBytes {
  return async (path) => {
    const fs = project.fileSystem, root = project.root;
    if (fs && root) {
      const abs = joinPath(root, path);
      try {
        if (await fs.exists(abs)) return await fs.readBinary(abs);
      } catch {
        // fall back to the served copy
      }
    }
    const url = project.assets.has(path) ? project.assets.get(path) : undefined;
    if (typeof url !== "string") return null;
    try {
      const res = await fetch(url);
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
}

/** The plan's part this needs: the usable plugins and which are enabled. */
export interface AudioEffectPlan {
  readonly plugins: readonly FoundPlugin[];
  readonly enabled: ReadonlySet<string>;
}

/**
 * Applies `project`'s plugin audio effects: from `plan` when the caller planned the project's code already (the
 * editor), else planned here. Resolves to the problems, each already warned once. Never throws.
 */
export async function applyProjectAudioEffects(project: EditorProject, plan?: AudioEffectPlan): Promise<string[]> {
  try {
    const used =
      plan ??
      (await planPluginCode(
        { json: jsonFiles(project), code: project.scripts, packages: packageSourceFor(project)?.files, disabled: project.settings.plugins?.disabled, assets: project.files },
        { editor: true },
      ));
    return await applyEffectPluginSet(effectPluginSetOf(used.plugins, used.enabled, projectBytes(project), effectPluginEnginesOf(project.settings.plugins)));
  } catch (err) {
    const line = `audio: the project's plugin effects couldn't be loaded (${err instanceof Error ? err.message : String(err)}).`;
    console.warn(`[myco] ${line}`);
    return [line];
  }
}

/** The project closed: every plugin effect leaves the catalogue, the backend and offline renders. */
export function clearProjectAudioEffects(): Promise<string[]> {
  return applyEffectPluginSet([]);
}

/** True when a changed file can change the project's plugin audio effects: a plugin manifest or a module file. */
export const affectsAudioEffects = (path: string): boolean => /^plugins\/[^/]+\/plugin\.json$/.test(path) || (/^plugins\//.test(path) && /\.wasm$/i.test(path)) || path === "project.json";
