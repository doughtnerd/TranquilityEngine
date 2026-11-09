// Free file names in a project (ADR 0147): split out of assetOps.ts, which re-exports them, so the
// editor SDK reaches them without loading the Assets panel's file operations (and their imports of
// the session, which loads the plugins).
import type { EditorProject } from "./projects";

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Split a file name at its extension; `.scene.json` and `.prefab.json` count as one. */
export function splitExtension(name: string): [string, string] {
  const m = /^(.+?)((?:\.(?:scene|prefab|material|sky|cubemap|particles|particlesubgraph|particleblock|formation|shadergraph|shadersubgraph))?\.[^.]+)$/i.exec(name);
  return m ? [m[1], m[2]] : [name, ""];
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
