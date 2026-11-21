// Relative references between project files (ADR 0314): a model format names its material libraries, textures
// and buffers by paths relative to its own folder. Resolving one gives a project path; writing one back gives the
// path from a (perhaps new) folder to a (perhaps moved) file. Pure; paths are "/"-separated and project-relative.

const folderParts = (file: string) => file.split("/").slice(0, -1);

/** True if `ref` is a path relative to the file holding it: not empty, no scheme (`data:`, `http:`, a drive `C:`), not rooted at `/` or `\`. */
export const isRelativeReference = (ref: string): boolean => ref !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[/\\]/.test(ref);

/** The project path `ref` names, read relative to the folder of `file`: `\` read as `/`, `.` and `..` resolved (a `..` above the root is dropped). */
export function resolveRelative(file: string, ref: string): string {
  const out = folderParts(file);
  for (const part of ref.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** The relative path from the folder of `file` to the project path `target` (`../` where it climbs, no leading `./`). */
export function relativePath(file: string, target: string): string {
  const from = folderParts(file);
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return "../".repeat(from.length - common) + to.slice(common).join("/");
}
