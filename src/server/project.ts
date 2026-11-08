/**
 * A project folder read in Node, for the dedicated server (T14): `project.json`, every JSON asset
 * (scenes, prefabs, data) as an asset source, and the project's scripts (`scripts/**\/*.ts`, ADR
 * 0030), compiled and loaded so they register their components, systems, RPCs and inputs before
 * the Engine starts.
 *
 * Scripts load through the editor's script loader (`src/editor/scriptLoader.ts`), which only
 * depends on the engine: in Node it imports each compiled script from a `data:` URL, with
 * `"myco"` pointing at this process's engine. So the server and the editor compile scripts
 * the same way. Reading the folder is separate from the editor's `projects.ts`, which reads
 * through the platform FileSystem and serves binary assets as blob URLs.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssetSource, ProjectSettingsInput } from "../engine";
import { nodePackageSource } from "./packages";
import { isScriptPath, loadScripts, loadedScriptModule, type ScriptProblem } from "../editor/scriptLoader";

/** A bad project folder, bootstrap or listen address: the message says what's wrong, for the command line. */
export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}

export interface ServerProject {
  /** The folder, absolute. */
  readonly root: string;
  /** `project.json`, parsed. */
  readonly settings: ProjectSettingsInput;
  /**
   * Every file by project-relative path: parsed JSON for `.json`, text for `.xml` and `.css` (UI
   * documents and stylesheets), a `file:` URL otherwise (images
   * and audio aren't loaded headless, but lookups of their paths succeed).
   */
  readonly assets: AssetSource;
  /** The JSON files' text, by path (scripts can import them). */
  readonly json: ReadonlyMap<string, string>;
  /** The scripts' source, by path. */
  readonly scripts: ReadonlyMap<string, string>;
  /** Every file read, project-relative and sorted (hidden files and dependency and build folders left out). For game builds (ADR 0041). */
  readonly files: readonly string[];
}

/** Folders never read: dependencies, build output, and hidden folders (the editor's `.myco/`). */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "test-results", "playwright-report"]);

/** Read a project folder. Throws a `ServerError` if it isn't one or a JSON file doesn't parse. */
export async function readProject(dir: string): Promise<ServerProject> {
  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info) throw new ServerError(`There's no folder "${root}".`);
  if (!info.isDirectory()) throw new ServerError(`"${root}" is a file, not a project folder.`);

  const files = await listFiles(root);
  if (!files.includes("project.json")) throw new ServerError(`"${root}" isn't a project folder: it has no project.json.`);

  const values = new Map<string, unknown>();
  const json = new Map<string, string>();
  const scripts = new Map<string, string>();
  const bad: string[] = [];
  for (const path of files) {
    const full = join(root, ...path.split("/"));
    if (isScriptPath(path)) {
      scripts.set(path, await readFile(full, "utf8"));
    } else if (path.toLowerCase().endsWith(".json")) {
      const text = await readFile(full, "utf8");
      try {
        values.set(path, JSON.parse(text));
        json.set(path, text);
      } catch (err) {
        bad.push(`  - ${path}: ${(err as Error).message}`);
      }
    } else if (/\.(xml|css)$/i.test(path)) {
      values.set(path, await readFile(full, "utf8")); // UI documents and stylesheets (ADR 0077) load as text, as in the editor and the player
    } else if (!path.endsWith(".ts")) {
      values.set(path, pathToFileURL(full).href);
    }
  }
  if (bad.length > 0) throw new ServerError(`Some JSON files in "${root}" don't parse:\n${bad.join("\n")}`);
  const settings = values.get("project.json");
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new ServerError(`${join(root, "project.json")} must hold an object of project settings.`);
  return {
    root,
    settings: settings as ProjectSettingsInput,
    assets: { has: (p) => values.has(p), get: (p) => values.get(p) },
    json,
    scripts,
    files,
  };
}

/** Project-relative paths ("/"-separated) of every file under `root`, sorted. */
async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await listFiles(root, full)));
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

/**
 * Compile and load the project's scripts (registrations replace any with the same id, so loading
 * again, in tests, is fine). Throws a `ServerError` listing every script that failed: a server
 * missing a system or RPC would run the wrong game, or reject every client in the handshake.
 */
export async function loadProjectScripts(project: ServerProject): Promise<readonly string[]> {
  if (project.scripts.size === 0) return [];
  const result = await loadScripts(project.scripts, project.json, nodePackageSource(project.root, "production"));
  if (result.problems.length > 0) throw new ServerError(`Some scripts in "${project.root}" didn't load:\n${describeProblems(result.problems)}`);
  return result.loaded;
}

/** A loaded script's exports (for a code bootstrap's `bootstrap` function). */
export function scriptExports(path: string): Promise<Record<string, unknown>> {
  return loadedScriptModule(path);
}

function describeProblems(problems: readonly ScriptProblem[]): string {
  return problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n");
}
