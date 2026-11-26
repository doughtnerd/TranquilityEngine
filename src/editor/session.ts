// The editor session: one Editor World per open project (ADR 0016, 0026). Opening another
// project tears the World down and boots a new one with that project's settings and assets.
// Play mode, script reloads and plugin changes, and the work they defer to Stop, are the play
// session's (playSession.ts, ADR 0237); this module creates the editor's one and forwards to it.
import { errorStatus } from "./messages";
import { Engine, GameObject } from "../engine";
import { viewport } from "../engine/editor";
import { pathKey } from "./document";
import type { OpenRequest } from "./launcher/handoff";
import { NO_FOLDERS_NOTE, projectFileSystem } from "./projectFs";
import { projectOpening, type LocationOutcome, type OpenIntent, type OpenOutcome, type OpenResult, type ProjectSource } from "./projectOpening";
import { recentProjects, rememberProject } from "./recentProjects";
import { confirmDiscard } from "./dialogs";
import { copySample, findSample, openSampleProject } from "./samples";
import { editorPlatform, projectStorage } from "./projectPlace";
import { historyLocation } from "./preferences";
import { confirmInEditor } from "./ui/ConfirmDialog";
import { migrationSummary, offerAudioEventMigration } from "./audioEventMigration";
import { installSceneView } from "./cameraPreview";
import { installThumbnails } from "./thumbnails";
import { installPlayGizmos } from "./playGizmos";
import { mountPlayTools } from "./ui/PlayStats";
import { installGizmo } from "./gizmo";
import { installViewportTheme } from "./viewportTheme";
import { OrbitCamera } from "./OrbitCamera";
import { createPlaySession } from "./playSession";
import { onUICodeWritten } from "./textFiles";
import { saveOpenScene } from "./project";
import { createSceneTabs } from "./sceneTabs";
import { applyProjectPlugins } from "../plugins/editorPlugins";
import { loadProjectCode, unloadThirdPartyPlugins } from "../plugins/thirdPartyEditor";
import { editorSettings, joinPath, openFolderProject, uiFiles, useProjectAssets, type EditorProject } from "./projects";
import { isUISourcePath } from "../projectCode/uiModules";

import { currentProject, docVersion, openScene, playing, sceneCamera, scriptProblems, scriptsVersion, status, viewMode, type OpenScene } from "./state";
import { closeAllScripts } from "./code/codeBuffers";
import { preloadCodeEditor } from "./code/codeState";
import { prefetchEngine } from "./prefetch";
import { resetAssetBrowser } from "./assetSelection";
import { isScriptPath, replaceScripts } from "./scriptLoader";
import { checkBeforePlay, syncPackageTypes } from "./scriptCheck";
import { viewportElements } from "./ui/ScenePanel";
import { watchScripts, writeScriptingFiles } from "./scriptingSetup";
import { startProjectWatch, stopProjectWatch, syncProjectFiles } from "./editorProjectWatch";
import { installViewportSelection } from "./viewportSelection";
import { installViewportTools } from "./viewportTools";
import { installUIElementOutline } from "./uiOutline";
import { installUIHandles } from "./uiHandles";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { reloadGraphics } from "./graphicsPreview";

let session: { engine: Engine; dispose(): void } | null = null;
/** The running play session (kept in `state.ts`, so plugins' scene-view tools can follow it); re-exported for the panels. */
export { playing };

// Play mode and the work deferred to Stop (ADR 0237), in this session's Editor World and the viewport's game view.
const play = createPlaySession({
  editor: () => session?.engine ?? null,
  // Outside changes first (in the browser the folder is looked at only now and on focus; ADR 0341), then the script check.
  checkBeforePlay: async (project) => (await syncProjectFiles(), checkBeforePlay(project)),
  gameView: () => ({ container: viewportElements().gameView, mountTools: mountPlayTools }),
});

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * End-to-end test hook: open the Flappy sample's files as a project folder in memory, plus `extra`
 * files (project path → text, e.g. scripts, or bytes, e.g. clips), as if opened from disk. The folder is left on
 * `window.testFolder` (path → contents) so tests can see what the editor wrote.
 */
export async function openTestProject(extra: Record<string, string | Uint8Array> = {}): Promise<void> {
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

/**
 * Boot an Editor World for `project` in the viewport and open its main scene. `problem`: a main scene or scripts
 * that didn't load, already reported in the status line (so a note that the project opened mustn't replace it).
 */
async function loadProject(project: EditorProject): Promise<{ problem: boolean }> {
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
  applyProjectPlugins(project.settings.plugins?.disabled); // the panel layout stays as the session left it
  const scripts = await loadProjectCode(project); // scripts and third-party plugins, then first- and third-party applied together (ADR 0139, 0144)
  scriptProblems.value = scripts.problems;
  scriptsVersion.value++;
  void setUpScripting(project);
  // UI documents' parsers load with the editor (ADR 0077), so documents build with the scene, not a moment after.
  const [engine] = await Promise.all([
    Engine.create({ kind: "editor", container: viewportElements().viewport, project: editorSettings(project), storage: await projectStorage(project) }),
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
  void startProjectWatch(project); // share the folder with the Audio Studio and other apps: the lock, outside changes, pending moves (ADR 0341)
  engine.start();
  // Debug and end-to-end test hooks.
  Object.assign(window, { engine, orbit, overlayHandles: () => viewport(engine.world).overlayHandles(), nodeRect });
  if (project.mainScene) await tabs.open(project.mainScene);
  const sceneFailed = project.mainScene !== null && openScene.peek()?.path !== project.mainScene; // the tab put why in the status line
  preloadCodeEditor(project); // so the first file opens without the wait
  syncPackageTypes(project);
  if (scripts.problems.length > 0) {
    const list = scripts.problems.map((p) => `${p.path}: ${p.message}`);
    const scene = sceneFailed && status.value?.kind === "error" ? ` · ${status.value.text}` : "";
    status.value = {
      kind: "error",
      text: `${scripts.problems.length === 1 ? "A script" : `${scripts.problems.length} scripts`} didn't load: ${list.join("; ")}${scene}`,
      detail: list.join("\n"),
    };
  }
  return { problem: sceneFailed || scripts.problems.length > 0 };
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
  history: { project: () => currentProject.peek(), location: historyLocation, platform: editorPlatform },
  confirm: confirmInEditor,
  beforeSwitch: () => void play.stop(),
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


/**
 * Open `source` in this window (a folder project is remembered in the recent projects). Throws if it can't be read. A
 * folder with old audio events is offered their migration first (ADR 0343, `audioEventMigration.ts`); declined, it
 * opens as it is (the editor no longer edits audio; the Audio Studio opens it read-only).
 */
async function openHere(source: ProjectSource): Promise<OpenResult> {
  const migration = source.kind === "folder" ? await offerAudioEventMigration(source.fs, source.root, (q) => confirmInEditor(q).then((r) => r.ok)) : null;
  const project = source.kind === "folder" ? await openFolderProject(source.fs, source.root) : await openSampleProject(source.sample);
  const { problem } = await loadProject(project);
  void rememberProject(project);
  // What the migration did stays in the status line (the opened note doesn't replace it) unless loading reported a problem.
  if (!problem && migration?.kind === "migrated") status.value = { kind: "info", text: migrationSummary(migration.report) };
  if (!problem && migration?.kind === "failed") status.value = errorStatus("Couldn't migrate the project's audio events", migration.error);
  const reported = migration?.kind === "migrated" || migration?.kind === "failed";
  return { kind: "opened", name: project.name, problem: problem || reported };
}

// The editor window's project opening (ADR 0318): what the start screen or the File menu asks for is resolved by the
// project-opening module, asking about unsaved changes first, and opens here.
const opening = projectOpening({
  folders: projectFileSystem,
  recent: { check: (entry, fs) => recentProjects().check(entry, fs), handle: (id) => recentProjects().handle(id) },
  confirm: confirmDiscard,
  progress: (text) => (status.value = { kind: "info", text }),
  async declarations() {
    try {
      return (await import("virtual:myco-types")).default;
    } catch (err) {
      console.warn(`[editor] the engine's declarations aren't available; the project's scripting files are written when it opens: ${message(err)}`);
      return undefined;
    }
  },
  open: openHere,
});

/** Show what came of opening a project in the status line, unless opening already reported a problem there. */
function show<T extends OpenOutcome | LocationOutcome>(outcome: T): T {
  if (outcome.kind === "refused") status.value = outcome.reason;
  else if (outcome.kind === "opened" && outcome.note) status.value = { kind: "info", text: outcome.note };
  return outcome;
}

/**
 * Open what the user asked for (a folder to pick, a recent project, a sample or a copy of one, a new project) in this
 * window; resolves to what came of it, already shown in the status line.
 */
export async function openProject(intent: OpenIntent): Promise<OpenOutcome> {
  return show(await opening.open(intent));
}

/** Pick the folder a new project goes in (the project gets its own folder inside it), or why not. */
export async function pickProjectLocation(): Promise<LocationOutcome> {
  return show(await opening.pickLocation());
}

/**
 * Open the project the desktop editor's Projects window picked (ADR 0059). A refusal's reason goes back to the
 * Projects window, which shows it.
 */
export async function openPickedProject(request: OpenRequest): Promise<OpenOutcome> {
  let source: ProjectSource;
  try {
    if (request.kind === "sample") {
      source = { kind: "sample", sample: await findSample(request.id) };
    } else {
      const fs = await projectFileSystem();
      if (!fs) return show({ kind: "refused", reason: { kind: "info", text: NO_FOLDERS_NOTE } });
      source = { kind: "folder", fs, root: request.root };
    }
  } catch (err) {
    return show({ kind: "refused", reason: errorStatus(null, err) });
  }
  return show(await opening.openResolved(source));
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
  void stopProjectWatch();
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

/** Play the open scene (ADR 0022, 0032) in edit, Stop while playing: the play bar's Play/Stop and Ctrl+P. */
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
export function reloadScripts(options: { outside?: boolean; quiet?: boolean } = {}): Promise<void> {
  return play.reloadScripts(options);
}

// ADR 0419 wave C: an edit of Svelte UI code from the Inspector, the Hierarchy or the scene view (and its undo and
// redo) compiles the project's code again, so mounted views hot-reload; a compile error still reports itself.
onUICodeWritten(() => reloadScripts({ quiet: true }));

/**
 * Save a file from the Code panel: a script (then scripts reload), or a JSON (which must parse)
 * or JavaScript file. Scripts also reload after saving JSON one of them mentions, since scripts
 * can import JSON, and after saving UI code (ADR 0419: a Svelte component or rune module, or a `.css`
 * file one of them mentions), which compiles with them: mounted `UIView`s show the new version.
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
  if (/^plugins\/[^/]+\/plugin\.json$/.test(path) || (path.endsWith(".json") && [...project.scripts.values()].some((s) => s.includes(name))) || isUISourcePath(path) || (path.endsWith(".css") && [...uiFiles(project)].some(([p, s]) => isUISourcePath(p) && s.includes(name)))) await reloadScripts();

  else status.value = { kind: "info", text: `Saved ${path}.` };
}

/** Save a script of the current project, then reload scripts (ADR 0030). */
export async function saveScript(path: string, text: string): Promise<void> {
  const project = currentProject.value;
  if (!project) throw new Error("No project is open.");
  await project.writeScript(path, text);
  await reloadScripts();
}
