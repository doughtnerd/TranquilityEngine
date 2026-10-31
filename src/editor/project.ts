// Opening and saving scenes in the Editor World (ADR 0026).
import { Assets, Camera, DEG2RAD, GameObject, type AssetSource, type Engine, type ProjectSettingsInput } from "../engine";
import { CommandStack, SceneDocument, WorldSync, type SceneFile } from "./document";
import { formatSceneJSON, originalLayout } from "./document/format";
import { bundledDemoProject, editorSettings, type EditorProject } from "./projects";
import { currentProject, docVersion, openScene, sceneCamera, selection, setViewMode } from "./state";

let demo: EditorProject | null = null;
const bundledDemo = () => (demo ??= bundledDemoProject());

/** The bundled demo's assets (tests and the browser editor). */
export function demoAssets(): AssetSource {
  return bundledDemo().assets;
}

/** The bundled demo's settings for an Editor World. */
export function demoSettings(): ProjectSettingsInput {
  return editorSettings(bundledDemo());
}

export const DEMO_SCENE = "scenes/main.scene.json";

/** Open a scene file into the Editor World and frame it in the scene view. Throws if it can't load. */
export function openSceneFile(engine: Engine, path: string): void {
  const file = Assets.json<SceneFile>(path);
  const doc = new SceneDocument(file, path);
  const sync = new WorldSync(engine.world, doc);
  try {
    openScene.value?.sync.dispose();
    sync.build();
  } catch (err) {
    sync.dispose();
    openScene.value = null;
    docVersion.value++;
    throw err;
  }
  const stack = new CommandStack(doc);
  sync.attach(stack);
  stack.subscribe(() => docVersion.value++);
  openScene.value = { path, doc, stack, sync };
  selection.value = null;
  docVersion.value++;
  frameSceneCamera(engine);
}

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

/** Match the scene view to the scene's own camera: 2D for orthographic scenes, centred on it. */
function frameSceneCamera(engine: Engine): void {
  const orbit = sceneCamera.value;
  if (!orbit) return;
  const camera = GameObject.findObjectsOfType(Camera).find((c) => engine.world.inEditMode(c.node.entity));
  if (!camera) return;
  const p = camera.transform!.worldPosition;
  if (camera.projection === "orthographic") {
    setViewMode("2d");
    orbit.focus([p.x, p.y, 0], (camera.orthographicSize * 1.15) / Math.tan((orbit.fieldOfView * DEG2RAD) / 2));
  } else {
    orbit.focus([p.x, p.y, p.z]);
  }
}
