// The Takes and Captures trees' file actions (spec §2.16 and §4.5.2; the prototype's takes and captures file systems,
// S6): import into the selected folder, duplicate, move (files and folders, by Move to…, Move to top level or a drag),
// rename a folder, a new folder, delete a file through the project's trash with Undo on the toast (`runFileTrash.ts`),
// and delete a folder, whose contents move up a level (nothing is removed, so no question is asked). Each screen says
// what is special about its files (`RunFileKind`: a take's notes go with it; the open file follows a move and closes on a
// delete). Moves and renames are the Studio's asset moves (references follow, ADR 0341); copies are the engine's.
import { duplicateAssets, newFolder, whyNotValidName } from "../../../editor/assetOps";
import { importFiles, whyNotImportable } from "../../../editor/assetImportFiles";
import { currentProject, docVersion, status } from "../../../editor/state";
import { moveStudioAssets, renameStudioAsset } from "../../boot/studioAssetMoves";
import { toasts } from "../../shell/studioServices";
import { moveUpPlan } from "../samples/sampleLibrary";
import { restoreFiles, trashFiles } from "./runFileTrash";

/** What one screen's files need beyond the common actions. */
export interface RunFileKind {
  /** "take", "capture". */
  readonly noun: string;
  /** Where an import goes when no folder is selected. */
  readonly defaultFolder: string;
  /** Why a chosen file can't be imported here, or null. */
  whyNotFile(name: string): string | null;
  /** The files that go with `path` (itself first): a take's notes. */
  companions(files: readonly string[], path: string): string[];
  /** The file open on the screen, or null. */
  openPath(): string | null;
  /** Open `path` on the screen. */
  open(path: string): void;
  /** A file moved (or was renamed): the screen's open file follows. */
  moved(from: string, to: string): void;
  /** The open file was deleted. */
  closed(): void;
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const fail = (text: string) => void (status.value = { kind: "info", text });

/** Where a moved path is now, given the moves (a file inside a moved folder moves with it); itself when it didn't. */
export function movedTo(path: string, moves: readonly (readonly [string, string])[]): string {
  for (const [from, to] of moves) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  }
  return path;
}

/** The moves that move `items` (files and folders) into `folder`; each file takes its companions with it. */
export function moveIntoPlan(kind: Pick<RunFileKind, "companions">, files: readonly string[], folders: readonly string[], items: readonly string[], folder: string): [string, string][] {
  const out: [string, string][] = [];
  for (const item of items) {
    if (folders.includes(item)) {
      if (folder === item || folder.startsWith(`${item}/`) || folderOf(item) === folder) continue;
      out.push([item, join(folder, nameOf(item))]);
      continue;
    }
    if (folderOf(item) === folder) continue;
    for (const p of kind.companions(files, item)) out.push([p, join(folder, nameOf(p))]);
  }
  return out;
}

async function applyMoves(kind: RunFileKind, moves: readonly [string, string][], verb = "Moved"): Promise<boolean> {
  if (moves.length === 0) return false;
  const open = kind.openPath();
  if (!(await moveStudioAssets(moves, verb))) return false;
  if (open) {
    const to = movedTo(open, moves);
    if (to !== open) kind.moved(open, to);
  }
  return true;
}

/** Move files and folders into `folder` ("" = the top level). */
export async function moveItems(kind: RunFileKind, items: readonly string[], folder: string): Promise<boolean> {
  const project = currentProject.peek();
  if (!project) return false;
  const ok = await applyMoves(kind, moveIntoPlan(kind, project.files, project.folders, items, folder));
  if (ok) toasts.show({ text: `${items.length === 1 ? nameOf(items[0]!) : `${items.length} items`} → ${folder ? folder.split("/").join(" › ") : "top level"}` });
  return ok;
}

/** Rename a file in its folder (its companions follow: a take's notes keep its name). */
export async function renameFile(kind: RunFileKind, path: string, name: string): Promise<boolean> {
  const project = currentProject.peek();
  if (!project) return false;
  const bad = whyNotValidName(name);
  if (bad) return (fail(`Can't rename: ${bad}.`), false);
  const to = join(folderOf(path), name);
  if (to === path) return false;
  const moves: [string, string][] = kind.companions(project.files, path).map((p) => [p, to + p.slice(path.length)]);
  return applyMoves(kind, moves, "Renamed");
}

/** Rename a folder ("/" in the name becomes "-", as the prototype does). */
export async function renameFolder(kind: RunFileKind, folder: string, name: string): Promise<boolean> {
  const clean = name.trim().replace(/[/\\]/g, "-");
  if (!clean || clean === nameOf(folder)) return false;
  const bad = whyNotValidName(clean);
  if (bad) return (fail(`Can't rename: ${bad}.`), false);
  const open = kind.openPath();
  const to = join(folderOf(folder), clean);
  if (!(await renameStudioAsset(folder, clean))) return false;
  if (open) {
    const now = movedTo(open, [[folder, to]]);
    if (now !== open) kind.moved(open, now);
  }
  return true;
}

/** New folder inside `parent` ("" = the top level); resolves to its path. */
export const newRunFolder = (parent: string): Promise<string | null> => newFolder(parent);

/** Copy chosen files into `folder` (or the kind's own folder), then open the first. */
export async function importInto(kind: RunFileKind, files: readonly File[], folder: string | null): Promise<string | null> {
  const project = currentProject.peek();
  const refused = whyNotImportable(project);
  if (refused || !project) return (fail(`Can't import ${kind.noun}s: ${refused ?? "no project is open"}.`), null);
  const wrong = files.map((f) => kind.whyNotFile(f.name)).find((r) => r !== null);
  if (wrong) return (fail(wrong), null);
  const into = folder ?? kind.defaultFolder;
  const r = await importFiles(project, into, files.map((f) => ({ path: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) })));
  if (r.imported[0]) {
    kind.open(r.imported[0]);
    return r.imported[0];
  }
  if (r.failed[0]) fail(`Couldn't import ${r.failed[0].path}: ${r.failed[0].error}`);
  return null;
}

/** Duplicate a file beside itself ("<name> copy"); a take's notes come too. Opens the copy. */
export async function duplicateFile(kind: RunFileKind, path: string): Promise<string | null> {
  const project = currentProject.peek();
  if (!project) return null;
  const [made] = await duplicateAssets([path]);
  if (!made) return null;
  // A companion (a take's notes) is copied to the copy's name, so the copy keeps its notes.
  for (const c of kind.companions(project.files, path).slice(1)) {
    const target = made + c.slice(path.length);
    if (!project.files.includes(target)) {
      try {
        await project.copyFile(c, target);
      } catch {
        // the copy keeps no notes
      }
    }
  }
  docVersion.value++;
  kind.open(made);
  return made;
}

/** Delete a file (and its companions) into the trash; the toast's Undo brings them back. */
export async function deleteFile(kind: RunFileKind, path: string): Promise<boolean> {
  const project = currentProject.peek();
  if (!project) return false;
  const wasOpen = kind.openPath() === path;
  const r = await trashFiles(project, kind.companions(project.files, path)).catch((err: unknown) => ({ refused: err instanceof Error ? err.message : String(err) }));
  if ("refused" in r) return (fail(`Can't delete ${nameOf(path)}: ${r.refused}.`), false);
  if (wasOpen) kind.closed();
  toasts.show({
    text: `Deleted ${nameOf(path)}`,
    undo: () =>
      void restoreFiles(project, r.trashed).then((back) => {
        if ("refused" in back) fail(`Can't bring ${nameOf(path)} back: ${back.refused}.`);
        else if (wasOpen) kind.open(path);
      }),
  });
  return true;
}

/** Delete a folder: what is in it moves up a level first, so nothing is lost and nothing is asked. */
export async function deleteFolder(kind: RunFileKind, folder: string): Promise<boolean> {
  const project = currentProject.peek();
  if (!project) return false;
  const plan = moveUpPlan(folder, project.files, project.folders);
  if (plan.length && !(await applyMoves(kind, plan))) return false;
  try {
    await project.deleteFolder(folder);
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't delete ${folder}: ${err instanceof Error ? err.message : String(err)}` };
    return false;
  }
  docVersion.value++;
  toasts.show({ text: plan.length ? `Deleted folder ${nameOf(folder)} · what was in it moved up a level` : `Deleted folder ${nameOf(folder)}` });
  return true;
}
