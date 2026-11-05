// Project path helpers with no engine dependency, so the desktop editor's Projects window (ADR 0059)
// can use them without loading the engine. projects.ts and scriptLoader.ts re-export them.

/** Join a project-relative path onto a folder path, using the folder's separator. */
export function joinPath(root: string, path: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + path.split("/").join(sep);
}

/** Monaco's id for a language the Code panel edits in. */
export type CodeLanguage = "json" | "javascript" | "typescript" | "markdown" | "plaintext";

/**
 * Code and text files a project keeps as text besides its scripts, by extension, with the
 * language the Code panel edits them in. Only JSON is read by the game (scripts can import it);
 * the rest are edited only, never compiled or loaded: JavaScript and TypeScript modules such as
 * the Node tools that generate a project's assets (`tools/*.mjs`), and notes. A `.ts` file is a
 * script (`isScriptPath`), not one of these.
 */
const TEXT_LANGUAGES: ReadonlyMap<string, CodeLanguage> = new Map([
  ["json", "json"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["md", "markdown"],
  ["txt", "plaintext"],
]);

/** A path's extension, lower case, without the dot ("" if none; a leading dot, as in `.env`, isn't one). */
const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** Files the project keeps as text (and the Code panel can edit): JSON, JavaScript and TypeScript modules, Markdown and plain text. */
export const isTextAsset = (path: string) => TEXT_LANGUAGES.has(extensionOf(path));

/** The Code panel's language for a file it opens: a text asset's by extension, else TypeScript (a script). */
export const codeLanguageOf = (path: string): CodeLanguage => TEXT_LANGUAGES.get(extensionOf(path)) ?? "typescript";

/** Where scripts live in a project, and which files count. */
export const isScriptPath = (path: string) => path.startsWith("scripts/") && path.endsWith(".ts") && !path.endsWith(".d.ts");
