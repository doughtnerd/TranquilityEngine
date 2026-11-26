/**
 * Project files (ADR 0254): which files in a project folder are project files, and the value each
 * one loads as, the same on every host (the editor, a sample, the game player, the dedicated server,
 * `npm run export`). A host keeps only its I/O: it walks its folder with `skipsFolder`/`isProjectFile`
 * and hands `loadProjectFiles` a reader for text and a URL maker; the asset values that come back
 * are what `Assets.json`, `Assets.text` and `Assets.url` read.
 *
 * - **json**: `.json` files load parsed (scenes, prefabs, materials, sidecars, data).
 * - **text**: code and text files load as their contents: UI documents and stylesheets (ADR 0077),
 *   shader code (ADR 0106), JavaScript and TypeScript tool modules, Markdown and plain text.
 * - **url**: everything else (images, audio, models, fonts, LUTs, baked data) loads as a URL the
 *   host serves its bytes from (a blob URL in the editor, a build URL in the player, a `file:` URL
 *   on the dedicated server).
 *
 * TypeScript sources (`.ts`, `.tsx`) aren't project files: scripts are read and compiled apart (ADR 0030).
 * Svelte UI sources (ADR 0419: `.svelte` components and `.svelte.ts` rune modules) are text files, which
 * the project code linker compiles; a host serves the compiled module as the asset value once it has.

 * No imports, so the desktop editor's Projects window (ADR 0059) can use it without the engine.
 */

/** How a project file loads. */
export type ProjectFileKind = "json" | "text" | "url";

/** Folders never read as part of a project, besides hidden ones (the editor's `.myco/`): dependencies and build output. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "dist", "target", "test-results", "playwright-report"]);

/** Extensions (lower case) of the files that load as text. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["js", "mjs", "cjs", "mts", "cts", "md", "txt", "xml", "css", "wgsl", "glsl", "svelte"]);


/** A path's extension, lower case, without the dot ("" if none; a leading dot, as in `.env`, isn't one). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** How the file at `path` loads: parsed JSON, its text, or a URL. */
export function projectFileKind(path: string): ProjectFileKind {
  if (/\.svelte\.ts$/i.test(path)) return "text"; // a rune module (ADR 0419), wherever it is: the linker compiles it from its text
  const ext = extensionOf(path);

  return ext === "json" ? "json" : TEXT_EXTENSIONS.has(ext) ? "text" : "url";
}

/** True if a folder named `name` is left out of a project: a hidden folder, dependencies or build output. */
export function skipsFolder(name: string): boolean {
  return name.startsWith(".") || SKIPPED_FOLDERS.has(name);
}

/**
 * True if the project-relative ("/"-separated) `path` is a project file: no part of it hidden or a
 * skipped folder, and not TypeScript source (scripts are read apart) other than a Svelte rune module
 * (`*.svelte.ts`, ADR 0419), which is UI code beside its components.
 */
export function isProjectFile(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p, i) => p === "" || p.startsWith(".") || (i < parts.length - 1 && SKIPPED_FOLDERS.has(p)))) return false;
  return /\.svelte\.ts$/i.test(path) || !/\.tsx?$/i.test(path);
}


/** A host's I/O for `loadProjectFiles`. */
export interface ProjectFileReader {
  /** A file's text (for JSON and text files). */
  readText(path: string): Promise<string>;
  /** A URL serving a file's bytes (for every other file). */
  url(path: string): string | Promise<string>;
}

/** Project files loaded as asset values. */
export interface LoadedProjectFiles {
  /** Each file's asset value by path: parsed JSON, text, or a URL. */
  readonly values: Map<string, unknown>;
  /** The text of the JSON and text files, by path (what an editor edits, what scripts import). */
  readonly texts: Map<string, string>;
  /** JSON files that don't parse (left out of `values` and `texts`), with the parser's message. */
  readonly problems: { path: string; message: string }[];
}

/** The asset value of one file from its text: parsed for JSON (throws if it doesn't parse), the text itself otherwise. */
export function textFileValue(path: string, text: string): unknown {
  return projectFileKind(path) === "json" ? JSON.parse(text) : text;
}

/** Load `paths` (project files) as asset values through a host's reader. Reads run concurrently. */
export async function loadProjectFiles(paths: Iterable<string>, reader: ProjectFileReader): Promise<LoadedProjectFiles> {
  const values = new Map<string, unknown>();
  const texts = new Map<string, string>();
  const problems: { path: string; message: string }[] = [];
  const list = [...paths];
  const loaded = await Promise.all(
    list.map(async (path) => {
      if (projectFileKind(path) === "url") return { url: await reader.url(path) };
      const text = await reader.readText(path);
      try {
        return { text, value: textFileValue(path, text) };
      } catch (err) {
        return { problem: (err as Error).message };
      }
    }),
  );
  // Insert in the order given, so iteration doesn't depend on which read finished first.
  list.forEach((path, i) => {
    const r = loaded[i];
    if ("url" in r) values.set(path, r.url);
    else if ("problem" in r) problems.push({ path, message: r.problem! });
    else {
      values.set(path, r.value);
      texts.set(path, r.text);
    }
  });
  return { values, texts, problems };
}
