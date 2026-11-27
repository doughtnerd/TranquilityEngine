// Project path helpers with no engine dependency, so the desktop editor's Projects window (ADR 0059)
// can use them without loading the engine (the project-file rules, `projectFiles.ts`, import nothing).
// projects.ts and scriptLoader.ts re-export them.
import { extensionOf, projectFileKind } from "../engine/scene/projectFiles";

/** The project's settings file, whose sections the Project Settings and Worlds panels edit (ADR 0038). */
export const PROJECT_FILE = "project.json";

/** Join a project-relative path onto a folder path, using the folder's separator. */
export function joinPath(root: string, path: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + path.split("/").join(sep);
}

/** Monaco's id for a language the Code panel edits in. */
export type CodeLanguage = "json" | "javascript" | "typescript" | "markdown" | "plaintext" | "xml" | "css" | "html";


/**
 * The language the Code panel edits a project's JSON and text files in (ADR 0254 says which files
 * those are), by extension; a text file not listed is plain text (shader code, `.txt`).
 */
const CODE_LANGUAGES: ReadonlyMap<string, CodeLanguage> = new Map([
  ["json", "json"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["md", "markdown"],
  ["xml", "xml"],
  ["css", "css"],
  // Svelte UI (ADR 0423): components edit as HTML (markup with <script> and <style>), rune modules (`*.svelte.ts`) as TypeScript.
  ["svelte", "html"],
  ["ts", "typescript"],
]);


/**
 * Files the project keeps as text (and the Code panel can edit): its JSON and text files (ADR 0254:
 * JavaScript and TypeScript modules, Markdown and plain text, Svelte components and stylesheets, shader
 * code). A `.ts` file is a script (`isScriptPath`), not one of these.
 */
export const isTextAsset = (path: string) => projectFileKind(path) !== "url";

/** The Code panel's language for a file it opens: a text asset's by extension, else TypeScript (a script). */
export const codeLanguageOf = (path: string): CodeLanguage => (isTextAsset(path) ? (CODE_LANGUAGES.get(extensionOf(path)) ?? "plaintext") : "typescript");

/**
 * Where scripts live in a project, and which files count: `.ts` files under `scripts/`, and under a
 * project plugin's folder, `plugins/<folder>/` (ADR 0139: plugin halves compile like scripts).
 */
export const isScriptPath = (path: string) => (path.startsWith("scripts/") || /^plugins\/[^/]+\/./.test(path)) && path.endsWith(".ts") && !path.endsWith(".d.ts");
