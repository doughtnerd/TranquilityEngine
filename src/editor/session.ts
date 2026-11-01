// The editor session: one Editor World per open project (ADR 0016, 0026). Opening another
// project tears the World down and boots a new one with that project's settings and assets.
import { Engine, GameObject } from "../engine";
import { overlayHandlesOnCanvas, screenBounds } from "../engine/editor";
import { pathKey } from "./document";
import { getFileSystem } from "../engine/platform/FileSystem";
import { effect } from "@preact/signals";
import { confirmDiscard } from "./dialogs";
import { attachHistory, defaultHistoryPlatform, slotsFor, type AttachedHistory } from "./historyPersistence";
import { historyLocation } from "./preferences";
import { confirmInEditor } from "./ui/ConfirmDialog";
import { installColliderGizmo } from "./colliderGizmo";
import { installGizmo } from "./gizmo";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay, type PlaySession } from "./playMode";
import { openSceneFile, saveOpenScene } from "./project";
import { editorSettings, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, docVersion, openScene, playState, sceneCamera, selection, status, viewMode } from "./state";
import { installViewportSelection } from "./viewportSelection";

let session: { engine: Engine; dispose(): void } | null = null;
let play: PlaySession | null = null;
/** The open scene's edit history on disk (ADR 0027). */
let history: AttachedHistory | null = null;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Boot an Editor World for `project` in the viewport and open its main scene. */
/** Debug and end-to-end test hook: where a document node (by path key) is on the viewport canvas, or null. */
function nodeRect(key: string): { left: number; top: number; right: number; bottom: number } | null {
  const scene = openScene.peek(), root = scene?.sync.sceneNode;
  if (!scene || !root) return null;
  const rects = screenBounds(scene.sync.world, root)
    .filter((b) => {
      const path = scene.sync.pathOf(b.node);
      return path !== null && pathKey(path) === key;
    })
    .map((b) => b.rect);
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

export async function loadProject(project: EditorProject): Promise<void> {
  stopPlaying();
  await detachHistory();
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
  const disposers = [installViewportSelection(engine, orbit), installGizmo(engine), installColliderGizmo(engine)];
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
  // Debug and end-to-end test hooks.
  Object.assign(window, { engine, orbit, overlayHandles: () => overlayHandlesOnCanvas(engine.world), nodeRect });
  if (project.mainScene) openScene_(project.mainScene);
}

/** Open a scene or prefab of the current project, asking first if there are unsaved changes. */
export async function switchScene(path: string): Promise<void> {
  if (openScene.value?.path === path || !(await confirmDiscard())) return;
  stopPlaying();
  openScene_(path);
}

function openScene_(path: string): void {
  if (!session) return;
  void detachHistory();
  try {
    openSceneFile(session.engine, path);
    status.value = null;
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't open ${path}: ${message(err)}` };
    return;
  }
  void attachToOpenScene();
}

async function detachHistory(): Promise<void> {
  const h = history;
  history = null;
  await h?.detach();
}

/**
 * Load the open scene's saved history and keep saving it. If the editor closed with unsaved
 * changes, offer them back; declining keeps them in the history (redo, History panel).
 */
async function attachToOpenScene(): Promise<void> {
  const scene = openScene.value, project = currentProject.value;
  if (!scene || !project) return;
  const slots = slotsFor(project, scene.path, historyLocation.value, await defaultHistoryPlatform());
  const attached = await attachHistory(scene.stack, scene.path, slots, (err) => {
    status.value = { kind: "error", text: `Couldn't save the edit history for ${scene.path}: ${message(err)}` };
  });
  if (openScene.value !== scene) {
    await attached.detach(); // another scene opened meanwhile
    return;
  }
  history = attached;
  if (attached.mismatched) {
    status.value = { kind: "info", text: `${scene.path} changed outside the editor, so its saved edit history no longer applies; starting a new one.` };
  }
  if (attached.restorable) {
    const r = attached.restorable;
    const when = new Date(r.time).toLocaleString();
    const answer = await confirmInEditor({
      title: "Restore unsaved changes?",
      message: `${scene.path} had unsaved changes when the editor last closed (the last was "${r.label}", ${when}).`,
      confirmLabel: "Restore",
      cancelLabel: "Keep saved version",
      danger: false,
    });
    if (openScene.value !== scene) return;
    if (answer.ok) {
      scene.stack.jumpTo(r.seq);
      status.value = { kind: "info", text: `Restored the unsaved changes to ${scene.path}.` };
    } else {
      status.value = { kind: "info", text: "Kept the saved version. The unsaved changes are still in the edit history (redo, or the History panel)." };
    }
  }
}

// Switching where history is kept moves writing there right away (the tree is written in full).
effect(() => {
  const location = historyLocation.value;
  const scene = openScene.peek(), project = currentProject.peek(), h = history;
  if (!scene || !project || !h) return;
  void defaultHistoryPlatform().then((p) => h.relocate(slotsFor(project, scene.path, location, p)));
});

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

/** Play the open scene in a Runtime World shown in the game view (ADR 0022). */
export async function startPlaying(): Promise<void> {
  const scene = openScene.value, project = currentProject.value;
  if (!session || !scene || !project || playState.value !== "edit") return;
  playState.value = "starting";
  try {
    play = await startPlay({ editor: session.engine, scene, project, container: document.getElementById("game-view") ?? undefined });
    playState.value = "playing";
    status.value = { kind: "info", text: `Playing ${scene.path}. Edits made now don't affect the running game. Stop (Ctrl+P) to return.` };
  } catch (err) {
    playState.value = "edit";
    status.value = { kind: "error", text: `Couldn't play ${scene.path}: ${message(err)}` };
  }
}

/** Leave play mode: dispose the Runtime World and resume editing. */
export function stopPlaying(): void {
  if (!play) return;
  play.stop();
  play = null;
  playState.value = "edit";
  status.value = null;
}

export function togglePlaying(): void {
  if (playState.value === "edit") void startPlaying();
  else if (playState.value === "playing") stopPlaying();
}
