// New Scene (ADR 0022): write a `myco.scene@1` file with a default camera into the project and open
// it in a tab of its own.
import { freePath } from "./assetOps";
import type { SceneFile } from "./document";
import { errorStatus } from "./messages";
import { writeSceneFile } from "./project";
import { switchScene } from "./session";
import { currentProject, docVersion, status } from "./state";
import { readOnlyMessage } from "./readOnly";

/** A new scene's contents: an orthographic camera looking at the origin, like the samples'. */
function newSceneFile(): SceneFile {
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

/**
 * Create `New Scene.scene.json` (or `New Scene 2`…) in `folder` and open it: the `scene` kind's `create`, so File >
 * New Scene and the New… menu put it in the kind's folder (`scenes/`) by the asset kind host's rule (ADR 0233).
 * Returns its path, or null if the project is read-only or writing failed (the status bar says why).
 */
export async function createScene(folder: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: readOnlyMessage(project, "add scenes") };
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
