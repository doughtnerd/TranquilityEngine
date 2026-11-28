// Importing files from outside the editor into the project's assets (dragging them from the
// file manager onto the Assets panel, ADR 0085). The source is either the browser's drop
// (DataTransfer entries, folders walked recursively) or the desktop's drag-drop event, which
// gives absolute paths read through the file system. Names that are taken (ignoring case, in the
// project or on disk) or dropped twice get " (1)", " (2)"… (a dropped folder is renamed as a whole,
// so its contents never merge into another folder); an import settings sidecar dropped beside its
// file follows the file's new name. An import never writes over a file.
import { folderOf } from "./projectPath";
import type { FileSystem } from "../engine/platform/FileSystem";
import { isSidecarPath, sidecarAsset, sidecarPath } from "../engine/scene/importSettings";
import { whyNotValidName } from "./assetOps";
import { numberedName } from "./freePath";
import { errorStatus } from "./messages";
import { isScriptPath, isTextAsset, joinPath } from "./projectPaths";
import type { EditorProject } from "./projects";
import { reloadScripts } from "./session";
import { docVersion, scriptsVersion, status } from "./state";

/** A file to import: its path relative to the drop (`sheet.png`, or `sprites/a.png` inside a dropped folder) and its bytes. */
export interface IncomingFile {
  path: string;
  read(): Promise<Uint8Array>;
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const decoder = new TextDecoder();

/** Why files can't be imported into this project right now, or null: importing writes the project's folder through its file system. */
export function whyNotImportable(project: EditorProject | null): string | null {
  if (!project) return "no project is open";
  if (!project.canSave || !project.fileSystem) return `${project.name} is read-only; open a project folder to import files`;
  return null;
}

/**
 * Where each incoming file goes in `folder`: one project path per incoming file, in order. `isTaken`
 * says whether a project path is a file or folder already, ignoring case (Windows and macOS folders
 * can't hold two names that differ only in case). Top-level names that are taken are numbered; so is
 * a file's sidecar when its file is, and files inside a dropped folder follow the folder. Dropped
 * items with the same name (files from different folders, folders holding the same file) get names of
 * their own, so no file of an import lands on another.
 */
async function planImport(isTaken: (path: string) => Promise<boolean>, folder: string, incoming: readonly string[]): Promise<string[]> {
  const fold = (s: string) => s.toLowerCase();
  // Each top-level name's instances, each with the paths it holds (case-folded): a path an instance
  // already holds goes to the next instance of that name, or starts one.
  const instances = new Map<string, Set<string>[]>();
  const placed = incoming.map((p) => {
    const slash = p.indexOf("/");
    const top = slash < 0 ? p : p.slice(0, slash);
    const list = instances.get(top) ?? [];
    instances.set(top, list);
    let index = list.findIndex((held) => !held.has(fold(p)));
    if (index < 0) index = list.push(new Set()) - 1;
    list[index]!.add(fold(p));
    return { top, index, rest: slash < 0 ? "" : p.slice(slash) };
  });
  const claimed = new Set<string>();
  const free = async (name: string) => !claimed.has(fold(name)) && !(await isTaken(join(folder, name)));
  const claim = async (name: string, alsoFree: (candidate: string) => string | null = () => null) => {
    for (let n = 0; ; n++) {
      const candidate = numberedName(name, n);
      const also = alsoFree(candidate);
      if ((await free(candidate)) && (also === null || (await free(also)))) {
        claimed.add(fold(candidate));
        return candidate;
      }
    }
  };
  const renamed = new Map<string, string[]>();
  // Assets and folders first (a name free for the asset and its dropped sidecar), so sidecars can follow.
  for (const top of [...instances.keys()].sort()) {
    if (isSidecarPath(top) && instances.has(sidecarAsset(top))) continue;
    const sidecars = instances.get(sidecarPath(top))?.length ?? 0;
    const names: string[] = [];
    for (let i = 0; i < instances.get(top)!.length; i++) names.push(await claim(top, (c) => (i < sidecars ? sidecarPath(c) : null)));
    renamed.set(top, names);
  }
  for (const [top, list] of instances) {
    if (renamed.has(top)) continue;
    const assets = renamed.get(sidecarAsset(top))!;
    const names: string[] = [];
    // The i-th sidecar follows the i-th file of its name; any beyond those are numbered on their own.
    for (let i = 0; i < list.length; i++) {
      const name = i < assets.length ? sidecarPath(assets[i]!) : await claim(top);
      claimed.add(fold(name));
      names.push(name);
    }
    renamed.set(top, names);
  }
  return placed.map(({ top, index, rest }) => join(folder, renamed.get(top)![index]! + rest));
}

export interface ImportResult {
  imported: string[];
  failed: { path: string; error: string }[];
}

/**
 * Copy `incoming` into `folder` of the project and refresh the Assets panel. Never overwrites. Ask
 * `whyNotImportable` first (the OS drop controller does, ADR 0324): in a read-only project every
 * file fails to write and is reported in `failed`.
 */
export async function importFiles(project: EditorProject, folder: string, incoming: readonly IncomingFile[]): Promise<ImportResult> {
  const result: ImportResult = { imported: [], failed: [] };
  const valid: IncomingFile[] = [];
  for (const f of incoming) {
    const bad = f.path.split("/").map(whyNotValidName).find((r) => r);
    if (bad) result.failed.push({ path: f.path, error: bad });
    else valid.push(f);
  }
  // Taken ignoring case, in the project and on disk (a file added outside since the project was read).
  const known = new Set([...project.files, ...project.scripts.keys(), ...project.folders].map((p) => p.toLowerCase()));
  const fs = project.fileSystem, root = project.root;
  const taken = async (p: string) => known.has(p.toLowerCase()) || (!!fs && !!root && (await fs.exists(joinPath(root, p)).catch(() => false)));
  const plan = await planImport(taken, folder, valid.map((f) => f.path));
  let scripts = false;
  for (const [i, f] of valid.entries()) {
    const to = plan[i]!;
    try {
      await ensureFolders(project, folderOf(to));
      const bytes = await f.read();
      if (isScriptPath(to)) {
        await project.writeScript(to, decoder.decode(bytes));
        scripts = true;
      } else if (isTextAsset(to)) {
        try {
          await project.writeFile(to, decoder.decode(bytes));
        } catch {
          await project.writeBinary(to, bytes); // e.g. JSON that doesn't parse: kept as it is, not parsed as an asset
        }
      } else await project.writeBinary(to, bytes);
      result.imported.push(to);
    } catch (err) {
      result.failed.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  docVersion.value++;
  scriptsVersion.value++;
  if (scripts) await reloadScripts();
  const n = result.imported.filter((p) => !isSidecarPath(p)).length;
  if (result.failed.length > 0) {
    const first = result.failed[0];
    status.value = errorStatus(`Couldn't import ${result.failed.length} file${result.failed.length === 1 ? "" : "s"} (${first.path})`, new Error(first.error));
  } else if (n > 0) status.value = { kind: "info", text: `Imported ${n} file${n === 1 ? "" : "s"} into ${folder || project.name}.` };
  return result;
}

/** Create `folder` and any missing parents in the project. */
async function ensureFolders(project: EditorProject, folder: string): Promise<void> {
  if (folder === "") return;
  const parts = folder.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    if (!project.folders.includes(path)) await project.createFolder(path);
  }
}

// --- Sources -----------------------------------------------------------------------------------

/**
 * The files in a browser drop. Call it synchronously in the drop handler (the items are gone after
 * the first await); folders are walked recursively.
 */
export async function filesOfDrop(dt: DataTransfer): Promise<IncomingFile[]> {
  const entries: FileSystemEntry[] = [];
  const plain: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) plain.push(file);
    }
  }
  const out: IncomingFile[] = plain.map(fileOf(""));
  for (const entry of entries) await walkEntry(entry, "", out);
  return out;
}

const fileOf = (prefix: string) => (file: File): IncomingFile => ({ path: prefix + file.name, read: async () => new Uint8Array(await file.arrayBuffer()) });

async function walkEntry(entry: FileSystemEntry, prefix: string, out: IncomingFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push(fileOf(prefix)(file));
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    children.push(...batch);
  }
  for (const child of children) await walkEntry(child, `${prefix}${entry.name}/`, out);
}

/** The base name of an absolute path, either separator. */
export const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

/** The files at absolute `paths` of a file system (the desktop's drag-drop event), folders walked recursively; a path that can't be read is skipped. */
export async function filesOfPaths(fs: FileSystem, paths: readonly string[]): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  const walk = async (path: string, prefix: string): Promise<void> => {
    let children: { name: string; isDirectory: boolean }[] | null = null;
    try {
      children = await fs.list(path);
    } catch {
      children = null; // a file, not a folder
    }
    const name = baseName(path);
    if (children === null) {
      out.push({ path: prefix + name, read: () => fs.readBinary(path) });
      return;
    }
    for (const c of children) await walk(joinPath(path, c.name), `${prefix}${name}/`);
  };
  for (const p of paths) await walk(p, "");
  return out;
}
