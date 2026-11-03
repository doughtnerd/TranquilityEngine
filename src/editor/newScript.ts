// New Script (ADR 0030): ask for a name, write `scripts/<Name>.ts` from a template, load it, open
// it in the Code panel, and (from Add Component) add the new component to the selected nodes.
import { errorStatus } from "./messages";
import type { GameObject } from "../engine";
import { openScript } from "./code/codeState";
import { addComponentTo } from "./componentEdits";
import type { NodePath } from "./document";
import { saveScript } from "./session";
import { currentProject, openScene, scriptProblems, status } from "./state";
import { scriptId, scriptTemplate, type ScriptKind } from "./scriptTemplates";
import { askNewScript } from "./ui/NewScriptDialog";

/** Where a new script goes: the folder showing in the Assets panel when it's under `scripts/`, else `scripts/`. */
export const scriptFolderFor = (assetFolder: string) => (assetFolder === "scripts" || assetFolder.startsWith("scripts/") ? assetFolder : "scripts");

/**
 * Write and load a new script, and open it in the Code panel. With `addTo`, add the component it
 * defines to those nodes (looked up again by path, since loading rebuilds the scene). Returns
 * the script's path.
 */
export async function createScript(kind: ScriptKind, name: string, folder: string, addTo: readonly NodePath[] = []): Promise<string> {
  const path = `${folder}/${name}.ts`;
  await saveScript(path, scriptTemplate(kind, name));
  openScript(path);
  const failed = scriptProblems.value.some((p) => p.path === path);
  const scene = openScene.value;
  if (!failed && scene && addTo.length > 0 && kind !== "system") {
    const targets = addTo.flatMap((p) => {
      const node = scene.sync.nodeFor(p);
      return node ? [{ path: p, node }] : [];
    });
    addComponentTo(scene, targets, scriptId(name));
  }
  if (!failed) status.value = { kind: "info", text: `Created ${path}${addTo.length > 0 && kind !== "system" ? ` and added ${name}` : ""}.` };
  return path;
}

/**
 * The New Script action: ask for a kind and name, then create it. `addTo` (from Add Component)
 * offers scripts and data components, which nodes can take, and adds the new one to them.
 */
export async function newScript(options: { assetFolder?: string; addTo?: readonly { path: NodePath; node: GameObject }[] } = {}): Promise<string | null> {
  const project = currentProject.value;
  if (!project?.canSave) {
    status.value = { kind: "info", text: "This project is read-only. Open a project folder to write scripts." };
    return null;
  }
  const folder = scriptFolderFor(options.assetFolder ?? "");
  const addTo = options.addTo?.map((t) => t.path) ?? [];
  const answer = await askNewScript({ kinds: options.addTo ? ["behavior", "data"] : ["behavior", "data", "system"], folder, scripts: project.scripts });
  if (!answer) return null;
  try {
    return await createScript(answer.kind, answer.name, folder, addTo);
  } catch (err) {
    status.value = errorStatus(`Couldn't create the script`, err);
    return null;
  }
}
