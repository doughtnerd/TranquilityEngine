// The Studio asset library (ADR 0433): the one module behind every Studio screen's file actions. A screen describes its
// files once (a `LibraryKind`: the noun, the extension a typed name keeps, the files that go with one, the file it has
// open and how that follows) and gets the actions back:
//
// - **rename** a file (its companions follow: a take's notes keep its name) or a folder ("/" becomes "-"), names checked
//   by the engine's rule (`whyNotValidName`);
// - **move** files and folders into a folder (a file takes its companions; a folder goes whole; what's inside another
//   moved folder goes with it), with a toast saying where;
// - **duplicate** beside themselves ("<name> copy"; companions are copied to the copy's name) and **new folder**;
// - **delete** a file into the project's trash (`trash.ts`; companions and sidecars too), Undo on the toast;
// - **delete a folder, contents up**: what's directly in it moves up a level (a name taken there gets " 2", " 3"…
//   before its extension; a sidecar travels with its file), then the empty folder goes; refused where the engine's
//   delete rule refuses it (read-only, play), Undo on the toast puts the folder back and moves them in again;
// - **import** chosen files into a folder (for kinds that import).
//
// Every move and rename goes through `moveStudioAssets` (ADR 0341): while the editor holds the project, the moves are
// left for it in `pending-moves.json` and the Studio rewrites only its own files. Copies, new folders and deletes rewrite
// no references, so they need no routing. Screens keep what is their own: questions before a delete, a sample's derived
// duplicate, a playlist's links.
import { splitExtension } from "../../editor/freePath";
import { duplicateAssets, newFolder, whyNotValidName } from "../../editor/assetOps";
import { whyNotDeletable } from "../../editor/assetDelete";
import { folderEntry } from "../../editor/assetEntry";
import { importFiles, whyNotImportable } from "../../editor/assetImportFiles";
import { errorStatus } from "../../editor/messages";
import type { EditorProject } from "../../editor/projects";
import { currentProject, docVersion, status } from "../../editor/state";
import { isSidecarPath, sidecarAsset } from "../../engine/scene/importSettings";
import { toasts } from "../shell/studioServices";
import { moveStudioAssets, type AssetMove } from "./studioAssetMoves";
import { restoreFiles, trashFiles, whyNotTrashable, withSidecars } from "./trash";

export type { AssetMove } from "./studioAssetMoves";

/** What one screen's files are, for the library. Everything but the noun is optional. */
export interface LibraryKind {
  /** "take", "capture", "playlist", "sample", "scene": the words of refusals. */
  readonly noun: string;
  /** The extension a typed file name keeps (".playlist.json"); default: the asset kinds' extension of the file. */
  extension?(path: string): string;
  /** The files that go with `path`, itself first (a take's notes): they move, copy and delete with it. Default: itself. */
  companions?(files: readonly string[], path: string): string[];
  /** The files the screen has open (a playlist path can name several). */
  openPaths?(): readonly string[];
  /** Open `path` on the screen (a duplicate, an import, a delete undone). */
  open?(path: string): void;
  /** An open file moved or was renamed: the screen follows it to `to`. */
  follow?(from: string, to: string): void;
  /** The open file `path` was deleted. */
  closed?(path: string): void;
  /** After each move the library makes (renames, moves, a folder delete's moves and their undo): what else follows. */
  afterMove?(moves: readonly AssetMove[]): Promise<void> | void;
  /** Before a file goes to the trash, once it may (a sample's pending edit written, its decoded audio dropped). */
  beforeDelete?(path: string): Promise<void> | void;
  /** After it went (a sample's session forgotten). */
  afterDelete?(path: string): void;
  /** The delete toast's text, worked out before the file goes; default "Deleted <name without extension>". */
  deletedText?(path: string): string;
  /** Imports: where they go with no folder chosen, and which chosen files are refused. */
  readonly imports?: { readonly defaultFolder: string; whyNotFile(name: string): string | null };
}

/** A file tree's actions, as the run-file tree (Takes, Captures) takes them. */
export interface FileTreeActions {
  /** Open a file…: the chosen files, and the selected folder (null: none). */
  onImport(files: readonly File[], folder: string | null): void;
  /** New folder in `parent`: resolves to the folder made, so its name can be typed. */
  onNewFolder(parent: string): Promise<string | null>;
  onRename(path: string, name: string): void;
  onRenameFolder(folder: string, name: string): void;
  onMove(items: readonly string[], folder: string): void;
  onDuplicate(path: string): void;
  onDelete(path: string): void;
  onDeleteFolder(folder: string): void;
}

/** One screen's file actions. Each resolves once done, to whether it happened (the status bar or a toast says why not). */
export interface StudioLibrary {
  readonly kind: LibraryKind;
  /** Move files and folders into `folder` ("" = the top level). */
  move(items: readonly string[], folder: string): Promise<boolean>;
  /** Rename a file in its folder; the typed name keeps the file's extension. */
  renameFile(path: string, name: string): Promise<boolean>;
  /** Rename a folder in its parent. */
  renameFolder(folder: string, name: string): Promise<boolean>;
  /** A "New Folder" in `parent`; resolves to its path. */
  newFolder(parent: string): Promise<string | null>;
  /** Duplicate files beside themselves; resolves to the copies. One copy opens. */
  duplicate(paths: readonly string[]): Promise<string[]>;
  /** Delete a file into the trash, Undo on the toast. */
  deleteFile(path: string): Promise<boolean>;
  /** What deleting `folder` does: how many items move up, and to which folder ("" = the top level). */
  folderDeletePlan(folder: string): { readonly items: number; readonly to: string };
  /** Delete a folder, its contents moving up a level, Undo on the toast. */
  deleteFolder(folder: string): Promise<boolean>;
  /** Copy chosen files into `folder` (null: the kind's import folder), then open the first; resolves to its path. */
  importFiles(files: readonly File[], folder: string | null): Promise<string | null>;
  /** The actions as a file tree's callbacks. */
  readonly treeActions: FileTreeActions;
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
const crumbs = (folder: string) => (folder ? folder.split("/").join(" › ") : "top level");
const fail = (text: string) => void (status.value = { kind: "info", text });

/** Where `path` is after `moves` (a file inside a moved folder moves with it); itself when it didn't move. */
function movedTo(path: string, moves: readonly AssetMove[]): string {
  for (const [from, to] of moves) if (within(path, from)) return to + path.slice(from.length);
  return path;
}

/** What deleting `folder` moves up: each file and folder directly in it, to its parent, a taken name numbered. */
function contentsUp(project: EditorProject, folder: string): AssetMove[] {
  const parent = folderOf(folder);
  const files = [...project.files, ...project.scripts.keys()];
  const all = new Set(files);
  const inside = [
    ...project.folders.filter((f) => f !== folder && folderOf(f) === folder),
    // A sidecar travels with its file, so only a stray one moves on its own.
    ...files.filter((f) => folderOf(f) === folder && !(isSidecarPath(f) && all.has(sidecarAsset(f)))),
  ];
  const claimed = new Set([...files, ...project.folders].filter((p) => folderOf(p) === parent));
  return inside.map((from): AssetMove => {
    const [base, ext] = project.folders.includes(from) ? [nameOf(from), ""] : splitExtension(nameOf(from));
    let to = join(parent, nameOf(from));
    for (let n = 2; claimed.has(to); n++) to = join(parent, `${base} ${n}${ext}`);
    claimed.add(to);
    return [from, to];
  });
}

/** The library for one kind of file. */
export function studioLibrary(kind: LibraryKind): StudioLibrary {
  const companions = (files: readonly string[], path: string) => kind.companions?.(files, path) ?? [path];
  const extension = (path: string) => (kind.extension ? kind.extension(path) : splitExtension(nameOf(path))[1]);
  const title = (path: string) => nameOf(path).slice(0, nameOf(path).length - extension(path).length) || nameOf(path);

  /** The one way a move happens: through the Studio's asset moves, then the kind's followers. */
  async function applyMoves(moves: readonly AssetMove[], verb = "Moved"): Promise<boolean> {
    if (moves.length === 0) return false;
    const open = kind.openPaths?.() ?? [];
    if (!(await moveStudioAssets(moves, verb))) return false;
    await kind.afterMove?.(moves);
    for (const path of open) {
      const to = movedTo(path, moves);
      if (to !== path) kind.follow?.(path, to);
    }
    return true;
  }

  async function move(items: readonly string[], folder: string): Promise<boolean> {
    const project = currentProject.peek();
    if (!project) return false;
    const top = items.filter((p) => !items.some((q) => q !== p && project.folders.includes(q) && within(p, q)));
    const moves: AssetMove[] = [];
    for (const item of top) {
      if (project.folders.includes(item)) {
        if (!within(folder, item) && folderOf(item) !== folder) moves.push([item, join(folder, nameOf(item))]);
      } else if (folderOf(item) !== folder) {
        for (const p of companions(project.files, item)) moves.push([p, join(folder, nameOf(p))]);
      }
    }
    const ok = await applyMoves(moves);
    if (ok) toasts.show({ text: `${top.length === 1 ? nameOf(top[0]!) : `${top.length} items`} → ${crumbs(folder)}` });
    return ok;
  }

  async function renameFile(path: string, typed: string): Promise<boolean> {
    const project = currentProject.peek();
    if (!project) return false;
    const ext = extension(path);
    let base = typed.trim();
    if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, base.length - ext.length);
    const name = `${base}${ext}`;
    if (!base || name === nameOf(path)) return false;
    const bad = whyNotValidName(name);
    if (bad) return (fail(`Can't rename ${nameOf(path)}: ${bad}.`), false);
    const to = join(folderOf(path), name);
    return applyMoves(companions(project.files, path).map((p): AssetMove => [p, to + p.slice(path.length)]), "Renamed");
  }

  async function renameFolder(folder: string, typed: string): Promise<boolean> {
    const clean = typed.trim().replace(/[/\\]/g, "-");
    if (!clean || clean === nameOf(folder)) return false;
    const bad = whyNotValidName(clean);
    if (bad) return (fail(`Can't rename ${nameOf(folder)}: ${bad}.`), false);
    return applyMoves([[folder, join(folderOf(folder), clean)]], "Renamed");
  }

  async function duplicate(paths: readonly string[]): Promise<string[]> {
    const project = currentProject.peek();
    if (!project) return [];
    const made: string[] = [];
    for (const path of paths) {
      const [copy] = await duplicateAssets([path]);
      if (!copy) continue;
      made.push(copy);
      // A companion (a take's notes) is copied to the copy's name, so the copy keeps it.
      for (const c of companions(project.files, path).slice(1)) {
        const target = copy + c.slice(path.length);
        if (!project.files.includes(target)) await project.copyFile(c, target).catch(() => undefined);
      }
    }
    docVersion.value++;
    if (paths.length === 1 && made[0]) kind.open?.(made[0]);
    return made;
  }

  async function deleteFile(path: string): Promise<boolean> {
    const project = currentProject.peek();
    if (!project) return false;
    const paths = withSidecars(project, companions(project.files, path));
    const why = whyNotTrashable(project, paths);
    if (why) return (fail(`Can't delete ${nameOf(path)}: ${why}.`), false);
    const text = kind.deletedText?.(path) ?? `Deleted ${title(path)}`;
    const wasOpen = (kind.openPaths?.() ?? []).includes(path);
    const r = await Promise.resolve(kind.beforeDelete?.(path))
      .then(() => trashFiles(project, paths))
      .catch((err: unknown) => ({ refused: err instanceof Error ? err.message : String(err) }));
    if ("refused" in r) return (fail(`Can't delete ${nameOf(path)}: ${r.refused}.`), false);
    kind.afterDelete?.(path);
    if (wasOpen) kind.closed?.(path);
    toasts.show({
      text,
      undo: () =>
        void restoreFiles(project, r.trashed).then((back) => {
          if ("refused" in back) fail(`Can't bring ${nameOf(path)} back: ${back.refused}.`);
          else if (wasOpen) kind.open?.(path);
        }),
    });
    return true;
  }

  function folderDeletePlan(folder: string): { items: number; to: string } {
    const project = currentProject.peek();
    return { items: project ? contentsUp(project, folder).length : 0, to: folderOf(folder) };
  }

  async function deleteFolder(folder: string): Promise<boolean> {
    const project = currentProject.peek();
    if (!project) return false;
    const refused = whyNotDeletable(project, [folderEntry(folder)]);
    if (refused) return (fail(`Can't delete ${folder}: ${refused}.`), false);
    const moves = contentsUp(project, folder);
    if (moves.length && !(await applyMoves(moves))) return false;
    try {
      await project.deleteFolder(folder);
    } catch (err) {
      status.value = errorStatus(moves.length ? `Moved what was in ${folder} up, but couldn't delete the folder` : `Couldn't delete ${folder}`, err);
      docVersion.value++;
      return false;
    }
    docVersion.value++;
    status.value = { kind: "info", text: `Deleted ${folder}.` };
    const where = folderOf(folder) ? crumbs(folderOf(folder)) : "the top level";
    toasts.show({
      text: `Deleted folder ${nameOf(folder)}${moves.length ? `; ${moves.length === 1 ? "1 item" : `${moves.length} items`} moved to ${where}` : ""}`,
      undo: () => void restoreFolder(project, folder, moves),
    });
    return true;
  }

  /** Undo a folder delete: the folder back, and what moved up moved into it again. */
  async function restoreFolder(project: EditorProject, folder: string, moves: readonly AssetMove[]): Promise<void> {
    try {
      await project.createFolder(folder);
    } catch (err) {
      status.value = errorStatus(`Couldn't bring ${folder} back`, err);
      return;
    }
    docVersion.value++;
    await applyMoves(moves.map(([from, to]): AssetMove => [to, from]), "Moved back");
  }

  async function importInto(files: readonly File[], folder: string | null): Promise<string | null> {
    const project = currentProject.peek();
    const refused = kind.imports ? whyNotImportable(project) : `${kind.noun}s aren't imported here`;
    if (refused || !project || !kind.imports) return (fail(`Can't import ${kind.noun}s: ${refused ?? "no project is open"}.`), null);
    const wrong = files.map((f) => kind.imports!.whyNotFile(f.name)).find((r) => r !== null);
    if (wrong) return (fail(wrong), null);
    const r = await importFiles(project, folder ?? kind.imports.defaultFolder, files.map((f) => ({ path: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) })));
    if (r.imported[0]) {
      kind.open?.(r.imported[0]);
      return r.imported[0];
    }
    if (r.failed[0]) fail(`Couldn't import ${r.failed[0].path}: ${r.failed[0].error}`);
    return null;
  }

  return {
    kind,
    move,
    renameFile,
    renameFolder,
    newFolder,
    duplicate,
    deleteFile,
    folderDeletePlan,
    deleteFolder,
    importFiles: importInto,
    treeActions: {
      onImport: (files, folder) => void importInto(files, folder),
      onNewFolder: newFolder,
      onRename: (path, name) => void renameFile(path, name),
      onRenameFolder: (folder, name) => void renameFolder(folder, name),
      onMove: (items, folder) => void move(items, folder),
      onDuplicate: (path) => void duplicate([path]),
      onDelete: (path) => void deleteFile(path),
      onDeleteFolder: (folder) => void deleteFolder(folder),
    },
  };
}
