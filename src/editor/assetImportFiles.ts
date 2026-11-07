// Importing files from outside the editor into the project's assets (dragging them from the
// file manager onto the Assets panel, ADR 0085). The source is either the browser's drop
// (DataTransfer entries, folders walked recursively) or the desktop's drag-drop event, which
// gives absolute paths read through the file system. Names that are taken get " (1)", " (2)"…
// (a dropped folder is renamed as a whole, so its contents never merge into another folder); an
// import settings sidecar dropped beside its file follows the file's new name.
import type { FileSystem } from "../engine/platform/FileSystem";
import { isSidecarPath, sidecarAsset, sidecarPath } from "../engine/scene/importSettings";
import { splitExtension, whyNotValidName } from "./assetOps";
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

/** Why files can't be imported into this project right now, or null. */
export function whyNotImportable(project: EditorProject | null): string | null {
  if (!project) return "no project is open";
  if (!project.canSave) return `${project.name} is read-only; open a project folder to import files`;
  return null;
}

/** `name` with " (n)" before its extension (`a.png` → `a (1).png`; `x.scene.json` → `x (1).scene.json`); n 0 is the name itself. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name;
  const [base, ext] = splitExtension(name);
  return `${base} (${n})${ext}`;
}

/**
 * Where each incoming file goes in `folder`: a map from its incoming path to a project path.
 * `isTaken` says whether a project path is a file or folder already. Top-level names that are taken
 * are numbered; so is a file's sidecar when its file is, and files inside a dropped folder follow the folder.
 */
export function planImport(isTaken: (path: string) => boolean, folder: string, incoming: readonly string[]): Map<string, string> {
  const tops = new Set(incoming.map((p) => p.split("/")[0]));
  const renamed = new Map<string, string>();
  const claimed = new Set<string>();
  const free = (name: string) => {
    for (let n = 0; ; n++) {
      const candidate = numberedName(name, n);
      if (!isTaken(join(folder, candidate)) && !claimed.has(candidate)) return candidate;
    }
  };
  // Assets and folders first, so their sidecars can follow.
  for (const top of [...tops].sort()) {
    if (isSidecarPath(top) && tops.has(sidecarAsset(top))) continue;
    const name = free(top);
    claimed.add(name);
    renamed.set(top, name);
  }
  for (const top of tops) {
    if (renamed.has(top)) continue;
    const asset = renamed.get(sidecarAsset(top));
    renamed.set(top, asset !== undefined ? sidecarPath(asset) : top);
  }
  const out = new Map<string, string>();
  for (const p of incoming) {
    const slash = p.indexOf("/");
    const top = slash < 0 ? p : p.slice(0, slash);
    out.set(p, join(folder, renamed.get(top)! + (slash < 0 ? "" : p.slice(slash))));
  }
  return out;
}

export interface ImportResult {
  imported: string[];
  failed: { path: string; error: string }[];
}

/** Copy `incoming` into `folder` of the project and refresh the Assets panel. Never overwrites. */
export async function importFiles(project: EditorProject, folder: string, incoming: readonly IncomingFile[]): Promise<ImportResult> {
  const result: ImportResult = { imported: [], failed: [] };
  const refuse = whyNotImportable(project);
  if (refuse) {
    status.value = { kind: "error", text: `Can't import files: ${refuse}.` };
    return result;
  }
  const valid: IncomingFile[] = [];
  for (const f of incoming) {
    const bad = f.path.split("/").map(whyNotValidName).find((r) => r);
    if (bad) result.failed.push({ path: f.path, error: bad });
    else valid.push(f);
  }
  const taken = (p: string) => project.files.includes(p) || project.scripts.has(p) || project.folders.includes(p);
  const plan = planImport(taken, folder, valid.map((f) => f.path));
  let scripts = false;
  for (const f of valid) {
    const to = plan.get(f.path)!;
    try {
      await ensureFolders(project, to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "");
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
