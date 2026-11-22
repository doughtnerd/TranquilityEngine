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
import { isProjectFile, loadProjectFiles, projectFileKind, skipsFolder } from "../engine/scene/projectFiles";
import { nodePackageSource } from "./packages";
import { LEGACY_AUDIO_MESSAGE, projectWithAudio } from "../engine/audio/project/load";
import { AUDIO_PROJECT_FILE } from "../engine/audio/project/types";
import { audioEventRefusal, isAudioEventPath } from "../engine/audio/retiredAudioEvent";
import { isScriptPath, loadScripts, loadedPluginModule, loadedScriptModule, type ScriptProblem } from "../editor/scriptLoader";
import type { RuntimePlugin } from "../plugins/runtimeContext";
import { planPluginCode, toRuntimePlugin } from "../plugins/thirdParty";

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
  /** `project.json`, parsed, with `audio` set to `audio.json`'s runtime view (ADR 0330). */
  readonly settings: ProjectSettingsInput;
  /**
   * Every project file by project-relative path, as its asset value (ADR 0254): parsed JSON, a
   * text file's text, a `file:` URL otherwise (images and audio aren't loaded headless, but
   * lookups of their paths succeed).
   */
  readonly assets: AssetSource;
  /** The JSON files' text, by path (scripts can import them). */
  readonly json: ReadonlyMap<string, string>;
  /** The scripts' source, by path. */
  readonly scripts: ReadonlyMap<string, string>;
  /** Every file read, project-relative and sorted (hidden files and dependency and build folders left out). For game builds (ADR 0041). */
  readonly files: readonly string[];
}


/** Read a project folder. Throws a `ServerError` if it isn't one or a JSON file doesn't parse. */
export async function readProject(dir: string): Promise<ServerProject> {
  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info) throw new ServerError(`There's no folder "${root}".`);
  if (!info.isDirectory()) throw new ServerError(`"${root}" is a file, not a project folder.`);

  const files = await listFiles(root);
  if (!files.includes("project.json")) throw new ServerError(`"${root}" isn't a project folder: it has no project.json.`);
  // ADR 0329: the retired audio event format isn't read; the project migrates its events to playlists first.
  const event = files.find(isAudioEventPath);
  if (event !== undefined) throw new ServerError(audioEventRefusal(join(root, ...event.split("/")), event));

  const fullPath = (path: string) => join(root, ...path.split("/"));
  const scripts = new Map<string, string>();
  for (const path of files) if (isScriptPath(path)) scripts.set(path, await readFile(fullPath(path), "utf8"));
  // Every project file as the same asset value as in the editor and the player (ADR 0254); images and
  // audio aren't loaded headless, but their paths resolve to `file:` URLs.
  const { values, texts, problems } = await loadProjectFiles(files.filter(isProjectFile), {
    readText: (path) => readFile(fullPath(path), "utf8"),
    url: (path) => pathToFileURL(fullPath(path)).href,
  });
  if (problems.length > 0) throw new ServerError(`Some JSON files in "${root}" don't parse:\n${problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n")}`);
  const json = new Map([...texts].filter(([path]) => projectFileKind(path) === "json"));
  const settings = values.get("project.json");
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new ServerError(`${join(root, "project.json")} must hold an object of project settings.`);
  // The mix lives in audio.json (ADR 0330); an old project.json audio section is refused, not read.
  const withAudio = projectWithAudio(settings, values.get(AUDIO_PROJECT_FILE));
  if (withAudio.legacyAudio) throw new ServerError(`${join(root, "project.json")}: ${LEGACY_AUDIO_MESSAGE}`);
  return {
    root,
    settings: withAudio.project, // a headless server plays no sound: audio.json's warnings aren't its to report
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
      if (!skipsFolder(entry.name)) out.push(...(await listFiles(root, full)));
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
  return (await loadProjectCode(project)).loaded;
}

/**
 * Load the project's scripts and its enabled third-party plugins' runtime halves (ADR 0139), minus
 * plugins marked `server: false`, and return those halves for the server to activate. A refused
 * plugin, or a script or plugin module that fails, is a `ServerError`.
 */
export async function loadProjectCode(project: ServerProject): Promise<{ loaded: readonly string[]; plugins: RuntimePlugin[] }> {
  const packages = nodePackageSource(project.root, "production");
  const plan = await planPluginCode({ json: project.json, code: project.scripts, packages: packages.files, disabled: project.settings.plugins?.disabled, assets: project.files }, { editor: false, server: true });
  if (plan.problems.length > 0) throw new ServerError(`Some plugins in "${project.root}" can't load:\n${plan.problems.map((p) => `  - ${p.where}: ${p.message}`).join("\n")}`);
  if (plan.code.size === 0 && plan.npmEntries.length === 0) return { loaded: [], plugins: [] };
  const result = await loadScripts(plan.code, project.json, packages, plan.npmEntries);
  if (result.problems.length > 0) throw new ServerError(`Some scripts in "${project.root}" didn't load:\n${describeProblems(result.problems)}`);
  const plugins: RuntimePlugin[] = [];
  for (const p of plan.runtime) {
    try {
      plugins.push(toRuntimePlugin(p.manifest, p.runtime!, (await loadedPluginModule(p, "runtime"))!));
    } catch (err) {
      throw new ServerError(`The plugin ${p.manifest.name} (${p.where}) didn't load: ${(err as Error).message}`);
    }
  }
  return { loaded: result.loaded, plugins };
}

/** A loaded script's exports (for a code bootstrap's `bootstrap` function). */
export function scriptExports(path: string): Promise<Record<string, unknown>> {
  return loadedScriptModule(path);
}

function describeProblems(problems: readonly ScriptProblem[]): string {
  return problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n");
}
