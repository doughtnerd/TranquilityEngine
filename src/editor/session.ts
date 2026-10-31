// The editor session: one Editor World per open project (ADR 0016, 0026). Opening another
// project tears the World down and boots a new one with that project's settings and assets.
import { Engine, GameObject } from "../engine";
import { getFileSystem } from "../engine/platform/FileSystem";
import { confirmDiscard } from "./dialogs";
import { installGizmo } from "./gizmo";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile, saveOpenScene } from "./project";
import { editorSettings, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, docVersion, openScene, sceneCamera, selection, status, viewMode } from "./state";
import { installViewportSelection } from "./viewportSelection";

let session: { engine: Engine; dispose(): void } | null = null;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Boot an Editor World for `project` in the viewport and open its main scene. */
export async function loadProject(project: EditorProject): Promise<void> {
  session?.dispose();
  session = null;
  openScene.value?.sync.dispose();
  openScene.value = null;
  selection.value = null;
  docVersion.value++;

  useProjectAssets(project);
  const engine = await Engine.create({ kind: "editor", container: document.getElementById("viewport")!, project: editorSettings(project) });
  // Editor tools live under the World root, outside the edited scene, so they keep running (ADR 0026).
  const orbit = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  orbit.mode = viewMode.value;
  sceneCamera.value = orbit;
  const disposers = [installViewportSelection(engine, orbit), installGizmo(engine)];
  session = {
    engine,
    dispose() {
      for (const d of disposers) d();
      engine.dispose();
      sceneCamera.value = null;
    },
  };
  currentProject.value = project;
  engine.start();
  Object.assign(window, { engine, orbit });
  if (project.mainScene) openScene_(project.mainScene);
}

/** Open a scene or prefab of the current project, asking first if there are unsaved changes. */
export async function switchScene(path: string): Promise<void> {
  if (openScene.value?.path === path || !(await confirmDiscard())) return;
  openScene_(path);
}

function openScene_(path: string): void {
  if (!session) return;
  try {
    openSceneFile(session.engine, path);
    status.value = null;
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't open ${path}: ${message(err)}` };
  }
}

/** Pick a project folder and open it (Tauri only). */
export async function openProjectFolder(): Promise<void> {
  const fs = await getFileSystem();
  if (!fs.canWrite) {
    status.value = { kind: "info", text: "Opening project folders needs the desktop editor (npm run tauri:editor:dev)." };
    return;
  }
  if (!(await confirmDiscard())) return;
  const root = await fs.pickFolder("Open project folder");
  if (!root) return;
  try {
    status.value = { kind: "info", text: `Opening ${root}…` };
    await loadProject(await openFolderProject(fs, root));
    if (!openScene.value || status.value?.kind !== "error") status.value = { kind: "info", text: `Opened ${currentProject.value?.name}` };
  } catch (err) {
    status.value = { kind: "error", text: message(err) };
  }
}

/** Save the open scene to disk. */
export async function save(): Promise<void> {
  const scene = openScene.value, project = currentProject.value;
  if (!scene || !project) return;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} can't be saved. Open a project folder in the desktop editor to save.` };
    return;
  }
  try {
    await saveOpenScene();
    status.value = { kind: "info", text: `Saved ${scene.path}` };
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't save ${scene.path}: ${message(err)}` };
  }
}
