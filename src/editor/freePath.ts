// Free file names in a project (ADR 0147, 0465): split out of assetOps.ts, which re-exports them, so the
// editor SDK reaches them without loading the Assets panel's file operations (and their imports of
// the session, which loads the plugins).
import type { EditorProject } from "./projects";
import { assetKinds } from "./sdk/contributions";
import { SPACED, uniqueName, type Numbering } from "../engine/core/uniqueName";

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/**
 * Split a file name at its extension. The extension is the longest one a registered asset kind
 * declares (`.scene.json`, `.tileset.json`, `.audioevent.json` count as one), else the last `.ext`.
 */
export function splitExtension(name: string): [string, string] {
  const lower = name.toLowerCase();
  let best = 0;
  for (const kind of assetKinds.list()) {
    for (const ext of kind.extensions) {
      if (ext.length > best && ext.length < name.length && lower.endsWith(ext.toLowerCase())) best = ext.length;
    }
  }
  if (best) return [name.slice(0, -best), name.slice(-best)];
  const m = /^(.+?)(\.[^.]+)$/.exec(name);
  return m ? [m[1], m[2]] : [name, ""];
}

/** `name` with " (n)" before its extension (`a.png` → `a (1).png`; `x.scene.json` → `x (1).scene.json`); n 0 is the name itself. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name;
  const [base, ext] = splitExtension(name);
  return `${base} (${n})${ext}`;
}

/** True if a file or folder is at `path`. */
export const taken = (project: EditorProject, path: string) => project.files.includes(path) || project.scripts.has(path) || project.folders.includes(path);

/**
 * True if a file or folder is at `path` in any letter case (ADR 0465): where a new file may go, as
 * Windows and macOS see it (`Enemy.png` there means `enemy.png` can't be written beside it).
 */
function takenInAnyCase(project: EditorProject, path: string): boolean {
  const lower = path.toLowerCase();
  const same = (p: string) => p.toLowerCase() === lower;
  return taken(project, path) || project.files.some(same) || project.folders.some(same) || [...project.scripts.keys()].some(same);
}

/** "<base> copy", "<base> copy 2"…: Duplicate's numbering. */
const COPIED: Numbering = { format: (stem, n) => (n === 1 ? `${stem} copy` : `${stem} copy ${n}`), first: 1 };

/**
 * A free path in `folder` for a file `<stem><ext>`: that, else `stem` numbered by `numbering`
 * (default "<stem> 2", "<stem> 3"…) before `ext`. A path is taken when a file or folder is there in
 * any letter case (ADR 0465).
 */
export function freeFilePath(project: EditorProject, folder: string, stem: string, ext: string, numbering: Numbering = SPACED): string {
  return join(folder, uniqueName(stem, (s) => takenInAnyCase(project, join(folder, `${s}${ext}`)), numbering) + ext);
}

/**
 * A free path in `folder` for `name`: the name itself, else "<base> 2", "<base> 3"… With `copy`,
 * a taken name becomes "<base> copy", "<base> copy 2"… Taken in any letter case, as {@link freeFilePath}.
 */
export function freePath(project: EditorProject, folder: string, name: string, copy = false): string {
  const [base, ext] = splitExtension(name);
  return freeFilePath(project, folder, base, ext, copy ? COPIED : SPACED);
}
