/**
 * Reading project paths at runtime (ADR 0466): a project path is POSIX and relative to the project folder
 * (`models/hero.gltf`), and this module is the one rule for taking one apart and for resolving a path a file names
 * relative to itself (a glTF's buffers, an OBJ's material libraries, a model's textures, a UI stylesheet's `url()`).
 * The editor's `src/editor/projectPath.ts` (ADR 0454) builds on it.
 *
 * Pure: no imports, so any module can use it.
 */

/** The file name of a project path: `images/bird.png` → `bird.png`. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The folder of a project path: `images/bird.png` → `images`, `project.json` → `""` (the root). */
export const folderOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** How `resolveRelative` reads a path. */
export interface ResolveOptions {
  /**
   * What a leading `/` means. `"projectRoot"`: the project folder (UI documents, where `/images/a.png` names
   * `images/a.png`). `"outside"` (the default): a path on the machine the file was made on, so it names nothing in the
   * project (model files exported from other tools).
   */
  readonly leadingSlash?: "projectRoot" | "outside";
}

/**
 * The project path `rel` names, written inside the file `fromFile`: relative to that file's folder, with backslashes
 * read as `/` and `.` and `..` folded (`models/a.gltf` + `../tex/b.png` → `tex/b.png`). Null when it climbs above the
 * project folder (`../../x.bin` from `models/a.gltf`), when it starts with a drive letter (`C:/t.png`, another
 * machine's path), or when it starts with `/` and `opts.leadingSlash` is `"outside"` (the default).
 */
export function resolveRelative(fromFile: string, rel: string, opts: ResolveOptions = {}): string | null {
  const path = rel.replace(/\\/g, "/");
  if (/^[a-z]:/i.test(path)) return null;
  let joined: string;
  if (path.startsWith("/")) {
    if (opts.leadingSlash !== "projectRoot") return null;
    joined = path;
  } else {
    const folder = folderOf(fromFile);
    joined = folder ? `${folder}/${path}` : path;
  }
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.pop() === undefined) return null;
  }
  return out.join("/");
}
