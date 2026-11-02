// The editor session: one Editor World per open project (ADR 0016, 0026). Opening another
// project tears the World down and boots a new one with that project's settings and assets.
import { errorStatus } from "./messages";
import { Engine, GameObject } from "../engine";
import { overlayHandlesOnCanvas, screenBounds } from "../engine/editor";
import { pathKey } from "./document";
import { getFileSystem } from "../engine/platform/FileSystem";
import { effect, signal } from "@preact/signals";
import { confirmDiscard } from "./dialogs";
import { copySample, findSample, openSampleProject, type SampleInfo } from "./samples";
import { attachHistory, defaultHistoryPlatform, slotsFor, type AttachedHistory } from "./historyPersistence";
import { historyLocation, netConditionsSetting, netPlaySetup } from "./preferences";
import { confirmInEditor } from "./ui/ConfirmDialog";
import { installColliderGizmo } from "./colliderGizmo";
import { installGizmo } from "./gizmo";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay, type PlaySession } from "./playMode";
import { openSceneFile, saveOpenScene } from "./project";
import { editorSettings, joinPath, jsonFiles, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, docVersion, openScene, playState, sceneCamera, scriptProblems, scriptsVersion, selection, status, viewMode } from "./state";
import { closeAllScripts, preloadCodeEditor } from "./code/codeState";
import { resetAssetBrowser } from "./assetSelection";
import { isScriptPath, replaceScripts } from "./scriptLoader";
import { viewportElements } from "./ui/ScenePanel";
import { watchScripts, writeScriptingFiles } from "./scriptingSetup";
import { installViewportSelection } from "./viewportSelection";

let session: { engine: Engine; dispose(): void } | null = null;
let play: PlaySession | null = null;
/** The running play session, for the Network panel (ADR 0033 §9); null while editing. */
export const playing = signal<PlaySession | null>(null);
/** The open scene's edit history on disk (ADR 0027). */
let history: AttachedHistory | null = null;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Boot an Editor World for `project` in the viewport and open its main scene. */
/**
 * End-to-end test hook: open the Flappy sample's files as a project folder in memory, plus `extra`
 * files (project path → text, e.g. scripts), as if opened from disk. The folder is left on
 * `window.testFolder` (path → contents) so tests can see what the editor wrote.
 */
export async function openTestProject(extra: Record<string, string> = {}): Promise<void> {
  const [{ MemoryFileSystem }, sample] = await Promise.all([import("./memoryFs"), findSample("flappy")]);
  const ROOT = "C:\\Games\\flappy";
  const fs = new MemoryFileSystem();
  await copySample(sample, fs, ROOT);
  for (const [path, text] of Object.entries(extra)) fs.files.set(joinPath(ROOT, path), text);
  Object.assign(window, { testFolder: { read: (path: string) => fs.files.get(joinPath(ROOT, path)) } });
  await loadProject(await openFolderProject(fs, ROOT));
}

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
  // Project scripts register their types before any scene is built, replacing the previous
  // project's (ADR 0030).
  pendingReload = false;
  closeAllScripts();
  resetAssetBrowser();
  const scripts = await replaceScripts(project.scripts, jsonFiles(project));
  scriptProblems.value = scripts.problems;
  scriptsVersion.value++;
  void setUpScripting(project);
  const engine = await Engine.create({ kind: "editor", container: viewportElements().viewport, project: editorSettings(project) });
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
  preloadCodeEditor(project); // so the first file opens without the wait
  if (scripts.problems.length > 0) {
    const list = scripts.problems.map((p) => `${p.path}: ${p.message}`);
    const scene = status.value?.kind === "error" ? ` · ${status.value.text}` : "";
    status.value = {
      kind: "error",
      text: `${scripts.problems.length === 1 ? "A script" : `${scripts.problems.length} scripts`} didn't load: ${list.join("; ")}${scene}`,
      detail: list.join("\n"),
    };
  }
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
    status.value = errorStatus(`Couldn't open ${path}`, err);
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
    status.value = errorStatus(`Couldn't save the edit history for ${scene.path}`, err);
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
    status.value = errorStatus(null, err);
  }
}

/** Open a sample (ADR 0031) read-only, from the files served beside the editor. */
export async function openSample(sample: SampleInfo): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    status.value = { kind: "info", text: `Opening the ${sample.name} sample…` };
    await loadProject(await openSampleProject(sample));
    if (status.value?.kind !== "error") status.value = { kind: "info", text: `Opened the ${sample.name} sample (read-only). Make a copy to edit it.` };
  } catch (err) {
    status.value = errorStatus(`Couldn't open the ${sample.name} sample`, err);
  }
}

/** Copy a sample into a folder the user picks and open the copy, to edit it (desktop editor). */
export async function copySampleToFolder(sample: SampleInfo): Promise<void> {
  const fs = await getFileSystem();
  if (!fs.canWrite) {
    status.value = { kind: "info", text: "Copying a sample needs the desktop editor (npm run tauri:dev)." };
    return;
  }
  if (!(await confirmDiscard())) return;
  const root = await fs.pickFolder(`Choose an empty folder for your copy of ${sample.name}`);
  if (!root) return;
  try {
    status.value = { kind: "info", text: `Copying ${sample.name} to ${root}…` };
    await copySample(sample, fs, root);
    await loadProject(await openFolderProject(fs, root));
    if (status.value?.kind !== "error") status.value = { kind: "info", text: `Copied ${sample.name} to ${root}.` };
  } catch (err) {
    status.value = errorStatus(`Couldn't copy ${sample.name}`, err);
  }
}

/** Close the project and go back to the start screen. */
export async function closeProject(): Promise<void> {
  if (!currentProject.value || !(await confirmDiscard())) return;
  stopPlaying();
  await detachHistory();
  session?.dispose();
  session = null;
  openScene.value?.sync.dispose();
  openScene.value = null;
  selection.value = null;
  closeAllScripts();
  resetAssetBrowser();
  currentProject.value = null;
  const scripts = await replaceScripts(new Map(), new Map());
  scriptProblems.value = scripts.problems;
  scriptsVersion.value++;
  docVersion.value++;
  status.value = null;
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
    status.value = errorStatus(`Couldn't save ${scene.path}`, err);
  }
}

/** Play the open scene in an Engine built from the project's bootstrap, shown in the game view (ADR 0022, 0032). */
export async function startPlaying(): Promise<void> {
  const scene = openScene.value, project = currentProject.value;
  if (!session || !scene || !project || playState.value !== "edit") return;
  playState.value = "starting";
  const setup = netPlaySetup.value;
  try {
    play = await startPlay({
      editor: session.engine,
      scene,
      project,
      container: viewportElements().gameView,
      netPlay: setup.enabled ? { clients: setup.clients, thin: setup.thin, thinInput: setup.thinInput } : undefined,
      conditions: netConditionsSetting.value,
    });
    playing.value = play;
    playState.value = "playing";
    Object.assign(window, { playEngine: play.engine }); // debug and end-to-end test hook
    const net = play.netPlay;
    const how = net
      ? ` with ${net.clients.length} client${net.clients.length === 1 ? "" : "s"}${net.thin.length ? ` and ${net.thin.length} thin client${net.thin.length === 1 ? "" : "s"}` : ""}`
      : setup.enabled
        ? " as the project sets it up (multiplayer play needs a client World linked to a server World)"
        : "";
    status.value = { kind: "info", text: `Playing ${scene.path}${how}. Edits made now don't affect the running game. Stop (Ctrl+P) to return.` };
  } catch (err) {
    playState.value = "edit";
    status.value = errorStatus(`Couldn't play ${scene.path}`, err);
  }
}

/** Leave play mode: dispose the game's Engine and resume editing (and reload scripts saved meanwhile). */
export function stopPlaying(): void {
  if (!play) return;
  play.stop();
  play = null;
  playing.value = null;
  Object.assign(window, { playEngine: null });
  playState.value = "edit";
  status.value = null;
  if (pendingReload) void reloadScripts();
}

/** Stops watching the current project's scripts folder. */
let stopWatchingScripts: (() => void) | null = null;

/**
 * For a project folder (ADR 0030): write the `tsconfig.json` and engine declarations external
 * editors need, and watch `scripts/` to reload scripts edited outside the editor.
 */
async function setUpScripting(project: EditorProject): Promise<void> {
  stopWatchingScripts?.();
  stopWatchingScripts = null;
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root || !project.canSave) return;
  try {
    const { default: declarations } = await import("virtual:tranquility-types");
    await writeScriptingFiles(fs, root, declarations);
  } catch (err) {
    console.warn(`[editor] couldn't write the project's tsconfig.json and engine types: ${message(err)}`);
  }
  if (currentProject.value !== project) return;
  try {
    const stop = await watchScripts(fs, root, () => void reloadScripts({ outside: true }));
    if (currentProject.value === project) stopWatchingScripts = stop;
    else stop?.();
  } catch (err) {
    console.warn(`[editor] can't watch scripts/ for changes: ${message(err)}`);
  }
}

/** Open a project script with the system's default app for it (its code editor). */
export async function openScriptExternally(path: string): Promise<void> {
  const project = currentProject.value;
  if (!project?.fileSystem?.openExternally || !project.root) return;
  try {
    await project.fileSystem.openExternally(joinPath(project.root, path));
  } catch (err) {
    status.value = errorStatus(`Couldn't open ${path}`, err);
  }
}

/** Scripts changed during play mode: reload them on Stop (ADR 0030). */
let pendingReload = false;

/**
 * Reload the project's scripts from disk (ADR 0030): compile and load them again, unregister
 * types that are gone, and rebuild the open scene from its document, so field values typed in
 * the Inspector stay. During play mode the reload waits for Stop: the running game keeps the code
 * it started with.
 */
export async function reloadScripts(options: { outside?: boolean } = {}): Promise<void> {
  const project = currentProject.value;
  if (!project) return;
  if (options.outside) {
    // A change on disk: skip it when the files match what's loaded (e.g. the editor's own save).
    const before = project.scripts;
    try {
      await project.rereadScripts();
    } catch {
      return;
    }
    const after = project.scripts;
    if (after.size === before.size && [...after].every(([path, text]) => before.get(path) === text)) return;
  }
  if (playState.value !== "edit") {
    pendingReload = true;
    status.value = { kind: "info", text: "Scripts changed. They'll reload when you stop playing." };
    return;
  }
  pendingReload = false;
  try {
    await project.rereadScripts();
  } catch (err) {
    status.value = errorStatus(`Couldn't read the scripts`, err);
    return;
  }
  const result = await replaceScripts(project.scripts, jsonFiles(project));
  scriptProblems.value = result.problems;
  scriptsVersion.value++;
  const scene = openScene.value;
  if (scene) {
    scene.sync.build();
    docVersion.value++; // panels, outlines and the gizmo pick up the rebuilt nodes
  }
  status.value =
    result.problems.length > 0
      ? {
          kind: "error",
          text: `Reloaded scripts; ${result.problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`,
          detail: result.problems.map((p) => `${p.path}: ${p.message}`).join("\n"),
        }
      : options.outside
        ? { kind: "info", text: "Scripts changed on disk; reloaded them." }
        : result.loaded.length === 0
          ? { kind: "info", text: "Reloaded scripts: there are none under scripts/ now." }
          : { kind: "info", text: `Reloaded ${result.loaded.length} script${result.loaded.length === 1 ? "" : "s"}.` };
}

/**
 * Save a file from the Code panel: a script (then scripts reload), or a JSON (which must parse)
 * or JavaScript file. Scripts also reload after saving JSON one of them mentions, since scripts
 * can import JSON.
 */
export async function saveCodeFile(path: string, text: string): Promise<void> {
  const project = currentProject.value;
  if (!project) throw new Error("No project is open.");
  if (isScriptPath(path)) return saveScript(path, text);
  await project.writeFile(path, text);
  scriptsVersion.value++;
  docVersion.value++; // e.g. the Assets panel
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (path.endsWith(".json") && [...project.scripts.values()].some((s) => s.includes(name))) await reloadScripts();
  else status.value = { kind: "info", text: `Saved ${path}.` };
}

/** Save a script of the current project, then reload scripts (ADR 0030). */
export async function saveScript(path: string, text: string): Promise<void> {
  const project = currentProject.value;
  if (!project) throw new Error("No project is open.");
  await project.writeScript(path, text);
  await reloadScripts();
}

export function togglePlaying(): void {
  if (playState.value === "edit") void startPlaying();
  else if (playState.value === "playing") stopPlaying();
}
