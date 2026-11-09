// Saving scenes (ADR 0026). Opening them is the scene tabs' (sceneTabs.ts); `openSceneFile` is
// re-exported here for the headless tests and tools that open one scene.
import type { SceneFile } from "./document";
import { formatSceneJSON, originalLayout } from "./document/format";
import type { EditorProject } from "./projects";
import { currentProject, openScene } from "./state";

export { openSceneFile } from "./sceneTabs";

/**
 * Write a scene or prefab file in `project`, keeping an existing file's layout (unchanged nodes
 * keep their text) and line endings (Windows checkouts often have CRLF).
 */
export async function writeSceneFile(project: EditorProject, path: string, file: SceneFile): Promise<void> {
  const original = project.textOf(path);
  const text = formatSceneJSON(file, original ? originalLayout(original.replace(/\r\n/g, "\n")) : {});
  await project.writeText(path, original?.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
}

/** Write the open scene to its file in the current project. */
export async function saveOpenScene(): Promise<void> {
  const scene = openScene.value, project = currentProject.value;
  if (!scene || !project) return;
  await writeSceneFile(project, scene.path, scene.doc.toJSON());
  scene.stack.markSaved();
}
