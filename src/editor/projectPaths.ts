// Project path helpers with no engine dependency, so the desktop editor's Projects window (ADR 0059)
// can use them without loading the engine. projects.ts and scriptLoader.ts re-export them.

/** Join a project-relative path onto a folder path, using the folder's separator. */
export function joinPath(root: string, path: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + path.split("/").join(sep);
}

/** Files the project keeps as text (and the Code panel can edit): JSON, and plain JavaScript (edit only). */
export const isTextAsset = (path: string) => /\.(json|js)$/i.test(path);

/** Where scripts live in a project, and which files count. */
export const isScriptPath = (path: string) => path.startsWith("scripts/") && path.endsWith(".ts") && !path.endsWith(".d.ts");
