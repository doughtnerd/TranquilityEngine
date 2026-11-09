// The editor session: one Editor World per open project (ADR 0016, 0026). Opening another
// project tears the World down and boots a new one with that project's settings and assets.
// Play mode, script reloads and plugin changes, and the work they defer to Stop, are the play
// session's (playSession.ts, ADR 0161); this module creates the editor's one and forwards to it.
import { errorStatus } from "./messages";
import { Engine, GameObject } from "../engine";
import { viewport } from "../engine/editor";
import { pathKey } from "./document";
import type { FileSystem } from "../engine/platform/FileSystem";
import { effect } from "@preact/signals";
import { FsaFileSystem, ensureWritable } from "./fsaFileSystem";
import { scaffoldProject, type ProjectTemplate } from "./newProject";
import type { OpenRequest } from "./launcher/handoff";
import { NO_FOLDERS_NOTE, projectFileSystem } from "./projectFs";
import { recentProjects, recentVersion, type RecentProject } from "./recentProjects";
import { confirmDiscard } from "./dialogs";
import { copySample, findSample, openSampleProject, type SampleInfo } from "./samples";
import { defaultHistoryPlatform } from "./historyPersistence";
import { historyLocation } from "./preferences";
import { confirmInEditor } from "./ui/ConfirmDialog";
import { installSceneView } from "./cameraPreview";
import { installThumbnails } from "./thumbnails";
import { installPlayGizmos } from "./playGizmos";
import { mountPlayTools } from "./ui/PlayStats";
import { installGizmo } from "./gizmo";
import { installViewportTheme } from "./viewportTheme";
import { OrbitCamera } from "./OrbitCamera";
import { createPlaySession } from "./playSession";
import { saveOpenScene } from "./project";
import { createSceneTabs } from "./sceneTabs";
import { applyEditorPlugins } from "../plugins/editorPlugins";
import { loadProjectCode, unloadThirdPartyPlugins } from "../plugins/thirdPartyEditor";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, docVersion, openScene, playing, sceneCamera, scriptProblems, scriptsVersion, status, viewMode, type OpenScene } from "./state";
import { closeAllScripts, preloadCodeEditor } from "./code/codeState";
import { prefetchEngine } from "./prefetch";
import { resetAssetBrowser } from "./assetSelection";
import { isScriptPath, replaceScripts } from "./scriptLoader";
import { checkBeforePlay, syncPackageTypes } from "./scriptCheck";
import { viewportElements } from "./ui/ScenePanel";
import { watchScripts, writeScriptingFiles } from "./scriptingSetup";
import { installViewportSelection } from "./viewportSelection";
import { installViewportTools } from "./viewportTools";
import { installUIElementOutline } from "./uiOutline";
import { installUIHandles } from "./uiHandles";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { reloadGraphics } from "./graphicsPreview";

let session: { engine: Engine; dispose(): void } | null = null;
/** The running play session (kept in `state.ts`, so plugins' scene-view tools can follow it); re-exported for the panels. */
export { playing };

// Play mode and the work deferred to Stop (ADR 0161), in this session's Editor World and the viewport's game view.
const play = createPlaySession({
  editor: () => session?.engine ?? null,
  checkBeforePlay,
  gameView: () => ({ container: viewportElements().gameView, mountTools: mountPlayTools }),
});

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
  const rects = viewport(scene.sync.world).screenBounds(root)
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
  void play.stop({ discardQueued: true }); // the old project's queued reload and plugin changes don't apply to the new one
  await tabs.closeAll();
  session?.dispose();
  session = null;
  docVersion.value++;

  useProjectAssets(project);
  void prefetchEngine(); // the renderer's chunks load while the scripts compile (ADR 0082)
  // Project scripts register their types before any scene is built, replacing the previous
  // project's (ADR 0030).
  closeAllScripts();
  resetAssetBrowser();
  // The first-party plugins before the scripts and scenes: a disabled plugin's Components are gone (ADR 0133),
  // and the previous project's third-party plugins go. Problems are reported with the script problems below.
  applyEditorPlugins(project.settings.plugins?.disabled, { thirdParty: [], layout: "reload" });
  const scripts = await loadProjectCode(project); // scripts and third-party plugins, then first- and third-party applied together (ADR 0139, 0144)
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
  const disposers = [installViewportSelection(engine, orbit), installGizmo(engine), installPlayGizmos(playing), installSceneView(engine), installViewportTheme(engine), installUIElementOutline(engine), installUIHandles(engine), installViewportTools(engine)]; // plugins' scene-view tools (ADR 0138)
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
  Object.assign(window, { engine, orbit, overlayHandles: () => viewport(engine.world).overlayHandles(), nodeRect });
  if (project.mainScene) void tabs.open(project.mainScene);
  preloadCodeEditor(project); // so the first file opens without the wait
  syncPackageTypes(project);
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
 * Resolves once the open project's scene view has its renderer (loaded, GPU device made), or after
 * `timeout` ms at the latest (ADR 0082): the desktop editor shows its window then, so the scene view
 * draws on its first frame rather than staying blank while the renderer loads. (A hidden window
 * gets no animation frames, so this doesn't wait for one.)
 */
export async function sceneViewStarted(timeout = 4000): Promise<void> {
  const started = session?.engine.world.render?.started;
  if (!started) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([started, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout)))]);
  clearTimeout(timer);
}

// The scene tabs (sceneTabs.ts) build into this session's Editor World, keep their histories where
// the preferences say, and stop play mode before the active tab changes.
const tabs = createSceneTabs({
  world: () => session?.engine.world ?? null,
  history: { project: () => currentProject.peek(), location: () => historyLocation.peek(), platform: defaultHistoryPlatform },
  confirm: confirmInEditor,
  beforeSwitch: () => stopPlaying(),
});

/**
 * Open a scene or prefab of the current project in a tab of its own (ADR 0026), or switch to its
 * tab if it's open already. Other tabs keep their unsaved changes.
 */
export function switchScene(path: string): Promise<void> {
  return tabs.open(path);
}

/** Switch to the open scene tab `scene` (unsaved changes in the others stay). Play mode stops first. */
export function activateScene(scene: OpenScene): void {
  tabs.activate(scene);
}

/**
 * Close a scene tab, asking first if it has unsaved changes (they stay in its edit history and
 * are offered back when it's opened again). Closing the active tab switches to its neighbour.
 * Returns true if it closed.
 */
export async function closeScene(scene: OpenScene): Promise<boolean> {
  return (await tabs.close([scene])) > 0;
}

/**
 * Close several scene tabs, asking once about all of the ones with unsaved changes (listed in one
 * dialog; cancelling closes none). Returns how many it closed.
 */
export function closeScenes(scenes: readonly OpenScene[]): Promise<number> {
  return tabs.close(scenes);
}

// Switching where history is kept moves writing there right away (the tree is written in full).
effect(() => {
  const location = historyLocation.value;
  void tabs.relocateHistories(location);
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
  void play.stop({ discardQueued: true });
  await tabs.closeAll();
  session?.dispose();
  session = null;
  closeAllScripts();
  resetAssetBrowser();
  currentProject.value = null;
  unloadThirdPartyPlugins();
  const scripts = await replaceScripts(new Map(), new Map());
  scriptProblems.value = scripts.problems;
  scriptsVersion.value++;
  docVersion.value++;
  status.value = null;
}

/**
 * The open project's `plugins.disabled` changed (the Project settings' Plugins category, ADR 0133):
 * activate or deactivate the plugins' halves live and rebuild the open scene, so disabled Components
 * show as missing and re-enabled ones come back. Other open scene tabs rebuild when shown. During play
 * the running game keeps the plugins it started with; the Editor World is rebuilt on Stop.
 */
export function reapplyPlugins(): void {
  play.reapplyPlugins();
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
export function startPlaying(): Promise<void> {
  return play.start();
}

/** Leave play mode: dispose the game's Engine and resume editing (writing kept values, and applying plugin settings and scripts changed meanwhile). */
export function stopPlaying(): void {
  void play.stop();
}

export function togglePlaying(): void {
  play.toggle();
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

/**
 * Reload the project's scripts from disk (ADR 0030): compile and load them again, unregister
 * types that are gone, and rebuild the open scene from its document, so field values typed in
 * the Inspector stay. During play they swap into the running game (ADR 0125), and the Editor
 * World rebuilds on Stop.
 */
export function reloadScripts(options: { outside?: boolean } = {}): Promise<void> {
  return play.reloadScripts(options);
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
  // A plugin's manifest (ADR 0139) decides what loads, so saving one reloads the project's code too.
  if (/^plugins\/[^/]+\/plugin\.json$/.test(path) || (path.endsWith(".json") && [...project.scripts.values()].some((s) => s.includes(name)))) await reloadScripts();
  else status.value = { kind: "info", text: `Saved ${path}.` };
}

/** Save a script of the current project, then reload scripts (ADR 0030). */
export async function saveScript(path: string, text: string): Promise<void> {
  const project = currentProject.value;
  if (!project) throw new Error("No project is open.");
  await project.writeScript(path, text);
  await reloadScripts();
}
