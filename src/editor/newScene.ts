// New Scene (ADR 0022): write a `myco.scene@1` file with a default camera into the project and open
// it in a tab of its own.
import { freePath } from "./assetOps";
import type { SceneFile } from "./document";
import { errorStatus } from "./messages";
import { writeSceneFile } from "./project";
import { switchScene } from "./session";
import { currentProject, docVersion, status } from "./state";

/** A new scene's contents: an orthographic camera looking at the origin, like the samples'. */
export function newSceneFile(): SceneFile {
  return {
    format: "myco.scene@1",
    nodes: [
      {
        id: "camera",
        name: "Camera",
        components: [
          { type: "engine.Transform", data: { position: [0, 0, 10] } },
          { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 5 } },
        ],
      },
    ],
  };
}

/** Where File > New Scene goes: `scenes/` if the project has it, else the project root. */
export function defaultSceneFolder(): string {
  return currentProject.value?.folders.includes("scenes") ? "scenes" : "";
}

/**
 * Create `New Scene.scene.json` (or `New Scene 2`…) in `folder` and open it. Returns its path, or
 * null if the project is read-only or writing failed (the status bar says why).
 */
export async function createScene(folder: string = defaultSceneFolder()): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add scenes.` };
    return null;
  }
  const path = freePath(project, folder, "New Scene.scene.json");
  try {
    await writeSceneFile(project, path, newSceneFile());
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++; // the Assets panel lists it
  await switchScene(path);
  if (status.value?.kind !== "error") status.value = { kind: "info", text: `Created ${path}.` };
  return path;
}
