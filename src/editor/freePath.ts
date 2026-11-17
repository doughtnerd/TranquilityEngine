// Free file names in a project (ADR 0147): split out of assetOps.ts, which re-exports them, so the
// editor SDK reaches them without loading the Assets panel's file operations (and their imports of
// the session, which loads the plugins).
import type { EditorProject } from "./projects";
import { assetKinds } from "./sdk/contributions";

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
 * A free path in `folder` for `name`: the name itself, else "<base> 2", "<base> 3"… With `copy`,
 * a taken name becomes "<base> copy", "<base> copy 2"…
 */
export function freePath(project: EditorProject, folder: string, name: string, copy = false): string {
  if (!taken(project, join(folder, name))) return join(folder, name);
  const [base, ext] = splitExtension(name);
  const stem = copy ? `${base} copy` : base;
  for (let n = 1; ; n++) {
    const path = join(folder, `${stem}${n > 1 ? ` ${n}` : ""}${ext}`);
    if (!taken(project, path)) return path;
  }
}
