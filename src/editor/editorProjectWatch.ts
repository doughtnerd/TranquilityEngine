// The editor's side of sharing a project folder with the Audio Studio and other apps (ADR 0341): while a project
// folder is open the editor holds `.myco/locks/editor.json`, follows outside changes to the project's files
// (projectWatch.ts: live on the desktop; in the browser on window focus and before Play), and applies the moves the
// Studio leaves in `.myco/locks/pending-moves.json`. Changed files are read again into the project
// (`EditorProject.rereadFiles`, so `project.assets` and `Assets.onChanged` listeners see them), and open asset
// documents take what their file holds now through their amend path (ADR 0141): no undo step, the history kept.
// Scripts keep their own watch (scriptingSetup.ts), which reloads them.
import { isTauri } from "../engine/platform/FileSystem";
import { assetDocumentsDeleted } from "./assetDocuments";
import { followMovedAssets } from "./assetOps";
import { isUISourcePath } from "../projectCode/uiModules";
import { reloadScripts } from "./session";

import { logMessage } from "./messages";
import { acquireLock, takePendingMoves, type HeldLock } from "./projectLocks";
import type { EditorProject, FileChanges } from "./projects";
import { watchProject, type ProjectChanges, type ProjectWatch } from "./projectWatch";
import { currentProject, docVersion } from "./state";

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
 * Apply outside `changes` to `project`, the open project: the Studio's pending moves first (so a file it moved is
 * followed, not read as deleted and added), then the changed files read again; open documents of deleted files are
 * dropped, and the rest take the new contents when `docVersion` moves. Resolves to what changed.
 */
export async function applyProjectChanges(project: EditorProject, changes: Pick<ProjectChanges, "files" | "pendingMoves">): Promise<FileChanges> {
  const none: FileChanges = { changed: [], added: [], removed: [] };
  if (currentProject.peek() !== project) return none;
  await applyPendingMoves(project);
  if (changes.files.length === 0 || currentProject.peek() !== project) return none;
  const result = await project.rereadFiles(changes.files);
  if (result.removed.length > 0) await assetDocumentsDeleted(result.removed);
  if (result.changed.length + result.added.length + result.removed.length > 0) docVersion.value++;
  // UI code (ADR 0419) compiles with the scripts: an outside edit to it reloads them, as the Code panel's save does.
  if ([...result.changed, ...result.added, ...result.removed].some((p) => isUISourcePath(p) || p.endsWith(".css"))) await reloadScripts();
  return result;

}

/** Take the moves waiting in `pending-moves.json` (the Studio's, ADR 0341) and follow them. Resolves to whether any moved. */
export async function applyPendingMoves(project: EditorProject): Promise<boolean> {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root || !project.canSave || currentProject.peek() !== project) return false;
  const { moves, problems } = await takePendingMoves(fs, root);
  for (const p of problems) logMessage("warning", `Skipped a move the Audio Studio left: ${p}`);
  if (moves.length === 0) return false;
  return followMovedAssets(
    moves.map((m) => [m.from, m.to] as const),
    "The Audio Studio",
  );
}

/**
 * Start sharing `project` (just opened in the editor) with other apps: hold the editor's lock, apply pending moves,
 * and follow outside changes until `stopProjectWatch` or another project opens. Does nothing for a project in memory
 * or a read-only one.
 */
export async function startProjectWatch(project: EditorProject): Promise<void> {
  await stopProjectWatch();
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root || !project.canSave) return;
  const onFocus = () => void syncProjectFiles();
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
    w.lock = await acquireLock(fs, root, "editor", await processId());
  } catch (err) {
    console.warn(`[editor] couldn't write the project's lock file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (w.stopped) return void (await w.lock?.release());
  await applyPendingMoves(project).catch((err: unknown) => console.warn("[editor] couldn't apply the Audio Studio's pending moves:", err));
  try {
    const watch = await watchProject(fs, root, (changes) => applyProjectChanges(project, changes).then(() => undefined));
    if (w.stopped) return watch.stop();
    w.watch = watch;
  } catch (err) {
    console.warn(`[editor] can't watch the project folder for changes: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof window !== "undefined") {
    if (w.watch?.mode === "on-demand") window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onHide); // best effort: a closing page may not finish the removal
  }
}

/** Stop following the open project's folder and release the editor's lock (the project closed). */
export async function stopProjectWatch(): Promise<void> {
  const w = watching;
  watching = null;
  if (!w) return;
  w.stopped = true;
  w.dispose();
  w.watch?.stop();
  await w.lock?.release().catch(() => undefined);
}

/** Look for outside changes now and apply them (before Play, on window focus in the browser); resolves once applied. */
export async function syncProjectFiles(): Promise<void> {
  const w = watching;
  if (!w || w.stopped) return;
  await w.watch?.rescan().catch((err: unknown) => console.warn("[editor] couldn't look for changes to the project:", err));
}
