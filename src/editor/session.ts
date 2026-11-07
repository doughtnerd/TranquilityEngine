// The editor session: one Editor World per open project (ADR 0016, 0026). Opening another
// project tears the World down and boots a new one with that project's settings and assets.
import { installTilemapPainting } from "./tilemap/paintTool";
import { errorStatus } from "./messages";
import { Engine, GameObject } from "../engine";
import { overlayHandlesOnCanvas, screenBounds } from "../engine/editor";
import { pathKey } from "./document";
import type { FileSystem } from "../engine/platform/FileSystem";
import { effect, signal } from "@preact/signals";
import { FsaFileSystem, ensureWritable } from "./fsaFileSystem";
import { scaffoldProject, type ProjectTemplate } from "./newProject";
import type { OpenRequest } from "./launcher/handoff";
import { NO_FOLDERS_NOTE, projectFileSystem } from "./projectFs";
import { recentProjects, recentVersion, type RecentProject } from "./recentProjects";
import { confirmDiscard } from "./dialogs";
import { copySample, findSample, openSampleProject, type SampleInfo } from "./samples";
import { attachHistory, defaultHistoryPlatform, slotsFor, type AttachedHistory } from "./historyPersistence";
import { historyLocation, netConditionsSetting, netPlaySetup } from "./preferences";
import { confirmInEditor } from "./ui/ConfirmDialog";
import { installSceneView } from "./cameraPreview";
import { installThumbnails } from "./thumbnails";
import { installColliderGizmo } from "./colliderGizmo";
import { installNavGizmo } from "./navGizmo";
import { installNavPreviews } from "./navPreviews";
import { installPlayGizmos } from "./playGizmos";
import { mountPlayTools } from "./ui/PlayStats";
import { installGizmo } from "./gizmo";
import { installViewportTheme } from "./viewportTheme";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay, type PlaySession } from "./playMode";
import { applyKept, endLiveInspection, takeKept, type KeptValues } from "./runtimeInspect";
import { openSceneFile, saveOpenScene } from "./project";
import { editorSettings, joinPath, jsonFiles, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, docVersion, editingCollider, openScene, openScenes, playState, sceneCamera, scriptProblems, scriptsVersion, select, selectedKeys, selection, setViewMode, status, viewMode, type OpenScene } from "./state";
import type { ViewMode } from "./OrbitCamera";
import { closeAllScripts, preloadCodeEditor } from "./code/codeState";
import { resetAssetBrowser } from "./assetSelection";
import { isScriptPath, replaceScripts } from "./scriptLoader";
import { viewportElements } from "./ui/ScenePanel";
import { watchScripts, writeScriptingFiles } from "./scriptingSetup";
import { installViewportSelection } from "./viewportSelection";
import { installUIElementOutline } from "./uiOutline";
import { installUIHandles } from "./uiHandles";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { reloadGraphics } from "./graphicsPreview";
import { migrateEmbeddedEffects } from "./particleMigration";

let session: { engine: Engine; dispose(): void } | null = null;
let play: PlaySession | null = null;
/** The running play session, for the Network panel (ADR 0033 §9); null while editing. */
export const playing = signal<PlaySession | null>(null);
/** Removes the play bar's tools from the game view (set while playing). */
let unmountPlayTools: () => void = () => {};
/** Each open scene's edit history on disk (ADR 0027), kept saving while its tab is open. */
const histories = new Map<OpenScene, AttachedHistory>();

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

/** Asset thumbnails follow the open project (ADR 0061); installed with the first one. */
let thumbnailsInstalled = false;

export async function loadProject(project: EditorProject): Promise<void> {
  if (!thumbnailsInstalled) {
    thumbnailsInstalled = true;
    installThumbnails();
  }
  stopPlaying();
  await closeAllScenes();
  session?.dispose();
  session = null;
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
  // UI documents' parsers load with the editor (ADR 0077), so documents build with the scene, not a moment after.
  const [engine] = await Promise.all([
    Engine.create({ kind: "editor", container: viewportElements().viewport, project: editorSettings(project) }),
    loadUIDocumentSupport().catch((err: unknown) => console.warn("[editor] the UI document parsers didn't load; documents build once they do:", err)),
  ]);
  reloadGraphics(engine.settings.graphics); // the Quality menu lists the project's tiers
  // Editor tools live under the World root, outside the edited scene, so they keep running (ADR 0026).
  const orbit = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  orbit.mode = viewMode.value;
  sceneCamera.value = orbit;
  const disposers = [installViewportSelection(engine, orbit), installGizmo(engine), installColliderGizmo(engine), installNavGizmo(engine, playing), installNavPreviews(engine.world), installPlayGizmos(playing), installSceneView(engine), installViewportTheme(engine), installUIElementOutline(engine), installUIHandles(engine), installTilemapPainting(engine)];
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

/**
 * Open a scene or prefab of the current project in a tab of its own (ADR 0026), or switch to its
 * tab if it's open already. Other tabs keep their unsaved changes.
 */
export async function switchScene(path: string): Promise<void> {
  if (openScene.value?.path === path) return;
  const open = openScenes.value.find((s) => s.path === path);
  if (open) return activateScene(open);
  stopPlaying();
  openScene_(path);
}

function openScene_(path: string): void {
  if (!session) return;
  const previous = openScene.peek();
  if (previous) deactivate(previous);
  try {
    openSceneFile(session.engine, path);
    status.value = null;
  } catch (err) {
    status.value = errorStatus(`Couldn't open ${path}`, err);
    if (previous) activate(previous);
    return;
  }
  const scene = openScene.peek()!;
  openScenes.value = [...openScenes.peek().filter((s) => s !== scene), scene];
  void attachToOpenScene(scene)
    .then(() => (openScenes.peek().includes(scene) ? migrateEmbeddedEffects(scene) : 0))
    .catch((err) => {
      status.value = errorStatus(`Couldn't move the embedded particle effects out of ${path}`, err);
    });
}

/** What a tab remembers while another is active: its selection and the scene view's camera. */
interface TabView {
  selection: readonly string[];
  camera: { mode: ViewMode; focus: number[]; distance: number; yaw: number; pitch: number } | null;
}
const tabViews = new WeakMap<OpenScene, TabView>();

/** Put the active tab aside: remember its view, and take its nodes out of the Editor World. */
function deactivate(scene: OpenScene): void {
  const orbit = sceneCamera.peek();
  tabViews.set(scene, {
    selection: selectedKeys.peek(),
    camera: orbit ? { mode: viewMode.peek(), focus: orbit.focusPoint.toArray(), distance: orbit.distance, yaw: orbit.yaw, pitch: orbit.pitch } : null,
  });
  scene.sync.dispose();
  editingCollider.value = null;
}

/** Make `scene` the active tab (the previous one already put aside): rebuild its nodes and view. */
function activate(scene: OpenScene): void {
  try {
    scene.sync.build();
  } catch (err) {
    status.value = errorStatus(`Couldn't show ${scene.path}`, err);
  }
  openScene.value = scene;
  const view = tabViews.get(scene);
  select((view?.selection ?? []).filter((k) => scene.doc.has(k.split("/")[0])));
  const orbit = sceneCamera.peek();
  if (view?.camera && orbit) {
    setViewMode(view.camera.mode);
    orbit.yaw = view.camera.yaw;
    orbit.pitch = view.camera.pitch;
    orbit.focus(view.camera.focus, view.camera.distance);
  }
  docVersion.value++;
}

/** Switch to the open scene tab `scene` (unsaved changes in the others stay). Play mode stops first. */
export function activateScene(scene: OpenScene): void {
  const current = openScene.peek();
  if (current === scene || !openScenes.peek().includes(scene)) return;
  stopPlaying();
  if (current) deactivate(current);
  activate(scene);
}

/**
 * Close a scene tab, asking first if it has unsaved changes (they stay in its edit history and
 * are offered back when it's opened again). Closing the active tab switches to its neighbour.
 * Returns true if it closed.
 */
export async function closeScene(scene: OpenScene): Promise<boolean> {
  if (!openScenes.peek().includes(scene)) return false;
  if (scene.stack.dirty) {
    const answer = await confirmInEditor({
      title: `Close ${scene.path.split("/").pop()}?`,
      message: `${scene.path} has unsaved changes. Closing it without saving discards them; they stay in its edit history and are offered back when you open it again.`,
      confirmLabel: "Close without saving",
      cancelLabel: "Cancel",
    });
    if (!answer.ok || !openScenes.peek().includes(scene)) return false;
  }
  const list = openScenes.peek();
  const at = list.indexOf(scene);
  const rest = list.filter((s) => s !== scene);
  openScenes.value = rest;
  tabViews.delete(scene);
  const h = histories.get(scene);
  histories.delete(scene);
  void h?.detach();
  scene.sync.dispose();
  if (openScene.peek() === scene) {
    stopPlaying();
    editingCollider.value = null;
    const next = rest[Math.min(at, rest.length - 1)];
    if (next) activate(next);
    else {
      openScene.value = null;
      select([]);
      docVersion.value++;
    }
  }
  return true;
}

/** Close every scene tab without asking (the project is closing) and stop saving their histories. */
async function closeAllScenes(): Promise<void> {
  const all = new Set(openScenes.peek());
  const active = openScene.peek();
  if (active) all.add(active);
  for (const s of all) s.sync.dispose();
  openScenes.value = [];
  openScene.value = null;
  selection.value = null;
  const detaching = [...histories.values()].map((h) => h.detach());
  histories.clear();
  await Promise.all(detaching);
}

/**
 * Load the open scene's saved history and keep saving it. If the editor closed with unsaved
 * changes, offer them back; declining keeps them in the history (redo, History panel).
 */
async function attachToOpenScene(scene: OpenScene): Promise<void> {
  const project = currentProject.value;
  if (!project) return;
  const slots = slotsFor(project, scene.path, historyLocation.value, await defaultHistoryPlatform());
  const attached = await attachHistory(scene.stack, scene.path, slots, (err) => {
    status.value = errorStatus(`Couldn't save the edit history for ${scene.path}`, err);
  });
  if (!openScenes.peek().includes(scene) || histories.has(scene)) {
    await attached.detach(); // its tab closed meanwhile
    return;
  }
  histories.set(scene, attached);
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
    if (!openScenes.peek().includes(scene)) return;
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
  const project = currentProject.peek();
  if (!project) return;
  for (const [scene, h] of histories) void defaultHistoryPlatform().then((p) => h.relocate(slotsFor(project, scene.path, location, p)));
});

/** The folder file system (desktop, or a Chromium browser), or null with a note in the status bar. */
async function folders(): Promise<FileSystem | null> {
  const fs = await projectFileSystem();
  if (!fs) status.value = { kind: "info", text: NO_FOLDERS_NOTE };
  return fs;
}

/** Add an opened folder project to the recent projects list (a browser folder by its handle). */
async function rememberProject(project: EditorProject): Promise<void> {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) return;
  try {
    if (fs instanceof FsaFileSystem) {
      const handle = await fs.directoryHandle(root);
      await recentProjects().add({ name: project.name, path: handle.name, handle });
    } else {
      await recentProjects().add({ name: project.name, path: root });
    }
    recentVersion.value++;
  } catch (err) {
    console.warn(`[editor] couldn't add ${root} to the recent projects: ${message(err)}`);
  }
}

/** Open the project in folder `root` and remember it. */
async function openFolder(fs: FileSystem, root: string, opening = `Opening ${root}…`): Promise<void> {
  status.value = { kind: "info", text: opening };
  await loadProject(await openFolderProject(fs, root));
  if (!openScene.value || status.value?.kind !== "error") status.value = { kind: "info", text: `Opened ${currentProject.value?.name}` };
  void rememberProject(currentProject.value!);
}

/** Pick a project folder and open it (the desktop editor, or a Chromium browser). */
export async function openProjectFolder(): Promise<void> {
  const fs = await folders();
  if (!fs || !(await confirmDiscard())) return;
  try {
    const root = await fs.pickFolder("Open project folder");
    if (!root) return;
    await openFolder(fs, root);
  } catch (err) {
    status.value = errorStatus(null, err);
  }
}

/**
 * Reopen a recent project. A browser folder asks for access again first (it lapses when the tab
 * closes); a desktop folder the editor can no longer reach (folder access lasts a session) is
 * picked again in the folder dialog, starting there.
 */
export async function openRecentProject(entry: RecentProject): Promise<void> {
  const fs = await folders();
  if (!fs || !(await confirmDiscard())) return;
  try {
    if (entry.kind === "handle") {
      const handle = await recentProjects().handle(entry.id);
      if (!handle || !(fs instanceof FsaFileSystem)) throw new Error(`The editor no longer has access to ${entry.name}. Open its folder again with Open Project….`);
      if (!(await ensureWritable(handle))) {
        status.value = { kind: "info", text: `${entry.name} wasn't opened: the browser wasn't given access to its folder.` };
        return;
      }
      await openFolder(fs, await fs.mount(handle), `Opening ${entry.name}…`);
      return;
    }
    let root: string | null = entry.path;
    let reachable = false;
    try {
      reachable = await fs.exists(joinPath(root, "project.json"));
    } catch {
      // out of the file system's scope since a restart: pick it again below
    }
    if (!reachable) {
      root = await fs.pickFolder(`Open ${entry.name} (confirm its folder)`, entry.path);
      if (!root) return;
    }
    await openFolder(fs, root);
  } catch (err) {
    status.value = errorStatus(`Couldn't open ${entry.name}`, err);
  }
}

/** Pick the folder a new project goes in (the project gets its own folder inside it). Null if cancelled or unavailable. */
export async function pickProjectLocation(): Promise<{ fs: FileSystem; path: string } | null> {
  const fs = await folders();
  if (!fs) return null;
  try {
    const path = await fs.pickFolder("Choose where the new project's folder goes");
    return path ? { fs, path } : null;
  } catch (err) {
    status.value = errorStatus("Couldn't choose a folder", err);
    return null;
  }
}

/** Create a project in a new folder `name` inside `parent`, then open it (ADR 0038). Throws if it can't be created. */
export async function createProject(fs: FileSystem, parent: string, name: string, template: ProjectTemplate): Promise<void> {
  if (!(await confirmDiscard())) return;
  const root = joinPath(parent, name.trim());
  status.value = { kind: "info", text: `Creating ${name.trim()}…` };
  let declarations: Readonly<Record<string, string>> | undefined;
  try {
    declarations = (await import("virtual:myco-types")).default;
  } catch (err) {
    console.warn(`[editor] the engine's declarations aren't available; the project's scripting files are written when it opens: ${message(err)}`);
  }
  await scaffoldProject(fs, root, { name, template, declarations });
  await openFolder(fs, root, `Opening ${name.trim()}…`);
  if (status.value?.kind !== "error") status.value = { kind: "info", text: `Created ${name.trim()} in ${root}.` };
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

/** Copy a sample into a folder the user picks and open the copy, to edit it (desktop editor, or a Chromium browser). */
export async function copySampleToFolder(sample: SampleInfo): Promise<void> {
  const fs = await folders();
  if (!fs || !(await confirmDiscard())) return;
  try {
    const root = await fs.pickFolder(`Choose an empty folder for your copy of ${sample.name}`);
    if (!root) return;
    status.value = { kind: "info", text: `Copying ${sample.name} to ${root}…` };
    await copySample(sample, fs, root);
    await openFolder(fs, root, `Opening ${root}…`);
    if (status.value?.kind !== "error") status.value = { kind: "info", text: `Copied ${sample.name} to ${root}.` };
  } catch (err) {
    status.value = errorStatus(`Couldn't copy ${sample.name}`, err);
  }
}

/**
 * Open the project the desktop editor's Projects window picked (ADR 0059). Throws if it didn't
 * open, so the Projects window can say why.
 */
export async function openPickedProject(request: OpenRequest): Promise<void> {
  if (request.kind === "sample") {
    const sample = await findSample(request.id);
    await loadProject(await openSampleProject(sample));
    if (status.value?.kind !== "error") status.value = { kind: "info", text: `Opened the ${sample.name} sample (read-only). Make a copy to edit it.` };
    return;
  }
  const fs = await projectFileSystem();
  if (!fs) throw new Error(NO_FOLDERS_NOTE);
  await openFolder(fs, request.root);
}

/** Close the project and go back to the start screen. */
export async function closeProject(): Promise<void> {
  if (!currentProject.value || !(await confirmDiscard())) return;
  stopPlaying();
  await closeAllScenes();
  session?.dispose();
  session = null;
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
      netPlay: setup.enabled ? { clients: setup.clients, thin: setup.thin, thinInput: setup.thinInput, clientScenes: setup.clientScenes ?? "server" } : undefined,
      conditions: netConditionsSetting.value,
    });
    playing.value = play;
    playState.value = "playing";
    unmountPlayTools = mountPlayTools(play); // the play bar's Gizmos and Stats
    Object.assign(window, { playEngine: play.engine }); // debug and end-to-end test hook
    const net = play.netPlay;
    const how = net
      ? ` with ${net.clients.length} client${net.clients.length === 1 ? "" : "s"}${net.thin.length ? ` and ${net.thin.length} thin client${net.thin.length === 1 ? "" : "s"}` : ""}${net.server ? ` on the ${net.server} World` : ""}`
      : setup.enabled
        ? " as the project sets it up (multiplayer play needs a client World linked to a server World, or a server template)"
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
  const keptValues = takeKept(); // "Keep values" from the live Inspector (runtimeInspect.ts)
  endLiveInspection();
  unmountPlayTools();
  unmountPlayTools = () => {};
  play.stop();
  play = null;
  playing.value = null;
  Object.assign(window, { playEngine: null });
  playState.value = "edit";
  status.value = null;
  if (keptValues.length > 0) writeKeptValues(keptValues);
  if (pendingReload) void reloadScripts();
}

/** Write values kept during play into the open scene as one undo step, and say what happened. */
function writeKeptValues(list: KeptValues[]): void {
  const scene = openScene.value;
  if (!scene) return;
  try {
    const { written, skipped } = applyKept(scene, list);
    const text = `Kept play-mode changes: ${written} field${written === 1 ? "" : "s"} written to ${scene.path} (Undo reverts them)${skipped.length ? `; ${skipped.length} skipped: ${skipped.join(" ")}` : "."}`;
    status.value = { kind: skipped.length && !written ? "error" : "info", text, detail: skipped.length ? skipped.join("\n") : undefined };
  } catch (err) {
    status.value = errorStatus("Couldn't keep the play-mode changes", err);
  }
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
    const { default: declarations } = await import("virtual:myco-types");
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
