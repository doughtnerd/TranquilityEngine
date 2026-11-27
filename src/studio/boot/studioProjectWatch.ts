// The Studio's side of sharing a project folder with the editor and other apps (ADR 0341, "One app owns each file;
// both watch"), the counterpart of the editor's editorProjectWatch.ts: while a project folder is open the Studio holds
// `.myco/locks/studio.json` (`{app, pid, started}`; the pid from the desktop shell's `process_id`), and follows outside
// changes to the project's files (projectWatch.ts: live on the desktop; in the browser when the window gets the focus):
// changed files are read again into the project (`EditorProject.rereadFiles`, so `project.assets` and
// `Assets.onChanged` listeners, the Studio's audio runtime among them, see them), and open asset documents take what
// their file holds now through their amend path (ADR 0141): no undo step, the history kept. The pending moves file is
// the editor's to apply, never the Studio's (the Studio writes it: library/studioAssetMoves.ts).
import { isTauri } from "../../engine/platform/FileSystem";
import { assetDocumentsDeleted } from "../../editor/assetDocuments";
import { acquireLock, type HeldLock } from "../../editor/projectLocks";
import type { EditorProject, FileChanges } from "../../editor/projects";
import { watchProject, type ProjectChanges, type ProjectWatch } from "../../editor/projectWatch";
import { currentProject, docVersion } from "../../editor/state";
import { affectsAudioEffects, applyProjectAudioEffects } from "../../plugins/projectAudioEffects";

interface Watching {
  readonly project: EditorProject;
  watch: ProjectWatch | null;
  lock: HeldLock | null;
  stopped: boolean;
  readonly dispose: () => void;
}

let watching: Watching | null = null;

/** The desktop shell's process id, for the lock (null in the browser, or if the shell can't say). */
async function processId(): Promise<number | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<number>("process_id");
  } catch {
    return null;
  }
}

/**
 * Apply outside `changes` to `project`, the open project: the changed files read again, open documents of deleted
 * files dropped, and the rest taking the new contents when `docVersion` moves. Resolves to what changed.
 */
export async function applyStudioChanges(project: EditorProject, changes: Pick<ProjectChanges, "files">): Promise<FileChanges> {
  const none: FileChanges = { changed: [], added: [], removed: [] };
  if (currentProject.peek() !== project || changes.files.length === 0) return none;
  const result = await project.rereadFiles(changes.files);
  if (result.removed.length > 0) await assetDocumentsDeleted(result.removed);
  if (result.changed.length + result.added.length + result.removed.length > 0) docVersion.value++;
  // ADR 0352 §8: a plugin's manifest or module file changed (a rebuilt .wasm): its audio effects reload.
  if ([...result.changed, ...result.added, ...result.removed].some(affectsAudioEffects)) await applyProjectAudioEffects(project);
  return result;
}

/**
 * Start sharing `project` (just opened in the Studio) with other apps: hold the Studio's lock and follow outside
 * changes until `stopStudioProjectWatch` or another project opens. Does nothing for a project in memory or a read-only
 * one (a sample). `pid` is the lock's process id (default: the desktop shell's).
 */
export async function startStudioProjectWatch(project: EditorProject, pid: () => Promise<number | null> = processId): Promise<void> {
  await stopStudioProjectWatch();
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root || !project.canSave) return;
  const onFocus = () => void syncStudioProjectFiles();
  const onHide = () => void watching?.lock?.release();
  const w: Watching = {
    project,
    watch: null,
    lock: null,
    stopped: false,
    dispose: () => {
      if (typeof window === "undefined") return;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onHide);
    },
  };
  watching = w;
  try {
    w.lock = await acquireLock(fs, root, "studio", await pid());
  } catch (err) {
    console.warn(`[studio] couldn't write the project's lock file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (w.stopped) return void (await w.lock?.release());
  try {
    const watch = await watchProject(fs, root, (changes) => applyStudioChanges(project, changes).then(() => undefined));
    if (w.stopped) return watch.stop();
    w.watch = watch;
  } catch (err) {
    console.warn(`[studio] can't watch the project folder for changes: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof window !== "undefined") {
    if (w.watch?.mode === "on-demand") window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onHide); // best effort: a closing page may not finish the removal
  }
}

/** Stop following the open project's folder and release the Studio's lock (the project closed). */
export async function stopStudioProjectWatch(): Promise<void> {
  const w = watching;
  watching = null;
  if (!w) return;
  w.stopped = true;
  w.dispose();
  w.watch?.stop();
  await w.lock?.release().catch(() => undefined);
}

/** Look for outside changes now and apply them (on window focus in the browser); resolves once applied. */
export async function syncStudioProjectFiles(): Promise<void> {
  const w = watching;
  if (!w || w.stopped) return;
  await w.watch?.rescan().catch((err: unknown) => console.warn("[studio] couldn't look for changes to the project:", err));
}
