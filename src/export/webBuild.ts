// Web builds (ADR 0041): turn a project into the files of a static web build: the project's files
// to copy, its scripts compiled to JavaScript, and the manifest the player reads (format.ts). No
// file access here: the Node exporter (node.ts) and the editor (src/editor/exportBuild.ts) read
// the project and write the result through their own file APIs.
//
// Scripts compile with the editor's script compiler (scriptLoader.ts), so a build runs the same
// JavaScript as play mode. Where the editor loads each module from a blob or data: URL, a build
// writes it as a file and points its imports at files: `"myco"` (and `"tranquility"`) at the
// engine module beside the player, other scripts at their compiled files, JSON files at modules
// exporting their contents.
import type { ProjectSettingsInput } from "../engine";
import { pickMainScene } from "../editor/projects";
import { compileScript, ENGINE_MODULE, LEGACY_ENGINE_MODULE, isScriptPath, loadOrder, resolveScript, rewriteImports, type ScriptProblem } from "../editor/scriptLoader";
import { projectScriptAssetRefs } from "../engine/scene/scriptAssetRefs";
import { ENGINE_FILE, MANIFEST_FILE, MANIFEST_FORMAT, PROJECT_DIR, modulePath, relativeSpecifier, type GameManifest } from "./format";

/** A project to build, however it was read. */
export interface BuildSource {
  /** The game's name, if `project.json` has none. */
  readonly name: string;
  /** `project.json`, parsed. */
  readonly settings: ProjectSettingsInput;
  /** Every file in the project folder, project-relative ("/"-separated). Scripts may be listed too. */
  readonly files: readonly string[];
  /** The scripts' source by path (`scripts/**\/*.ts`). */
  readonly scripts: ReadonlyMap<string, string>;
  /** The JSON files' text by path (scripts can import them). */
  readonly json: ReadonlyMap<string, string>;
}

export interface BuildOptions {
  /** The scene start-up Worlds without scenes of their own load; default `scenes/main.scene.json`, else the first scene. */
  readonly mainScene?: string;
}

/** What a web build is made of, before anything is written. */
export interface WebBuildPlan {
  readonly manifest: GameManifest;
  /** Project files copied as they are, by project path; each goes to `project/<path>`. */
  readonly copies: readonly string[];
  /** Files written from text, by build path: compiled scripts, JSON modules, the manifest, serve.mjs and README.txt. */
  readonly generated: ReadonlyMap<string, string>;
}

/** A project that can't be built: scripts that don't compile, a missing bootstrap script or scene. */
export class ExportError extends Error {
  constructor(message: string, readonly problems: readonly ScriptProblem[] = []) {
    super(message);
    this.name = "ExportError";
  }
}

/** Folders never exported: dependencies and build output (hidden folders, like the editor's `.myco/`, are skipped too). */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "test-results", "playwright-report"]);
/** Editor-only files at the project root: the editor's tsconfig.json (ADR 0030), a sample's listing (ADR 0031). */
const EDITOR_FILES = new Set(["tsconfig.json", "jsconfig.json", "sample.json"]);

/**
 * True if a project file goes into builds as it is: everything but hidden files and folders,
 * dependency and build folders, editor-only files, and TypeScript (scripts ship compiled).
 * Asset sidecars (`<asset>.meta.json`) are ordinary files and go in.
 */
export function isExportedFile(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => p.startsWith(".") || SKIP_DIRS.has(p))) return false;
  if (parts.length === 1 && EDITOR_FILES.has(path)) return false;
  return !/\.(ts|tsx|mts|cts)$/i.test(path);
}

const isEngineModule = (specifier: string) => specifier === ENGINE_MODULE || specifier === LEGACY_ENGINE_MODULE;

/** Compile every script and point its imports at build files. Throws an `ExportError` listing every script that fails. */
export async function compileForBuild(scripts: ReadonlyMap<string, string>, json: ReadonlyMap<string, string>): Promise<{ order: string[]; files: Map<string, string> }> {
  const problems: ScriptProblem[] = [];
  const compiled = new Map<string, Exclude<Awaited<ReturnType<typeof compileScript>>, ScriptProblem>>();
  for (const [path, source] of [...scripts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isScriptPath(path)) continue;
    const result = await compileScript(path, source, { sourceMap: false });
    if ("code" in result) compiled.set(path, result);
    else problems.push(result);
  }
  const parsed = new Map<string, unknown>();
  for (const [path, text] of json) {
    try {
      parsed.set(path, JSON.parse(text));
    } catch {
      // reported against the scripts that import it
    }
  }
  const plan = loadOrder(compiled, new Map([...json.keys()].map((p) => [p, parsed.has(p)])));
  problems.push(...plan.problems);
  if (problems.length > 0) {
    const list = problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n");
    throw new ExportError(`Some scripts can't be built:\n${list}`, problems);
  }
  const known = new Set([...compiled.keys(), ...json.keys()]);
  const files = new Map<string, string>();
  for (const path of plan.order) {
    const s = compiled.get(path)!;
    const out = modulePath(path);
    files.set(
      out,
      rewriteImports(s.code, s.imports, (spec) => {
        if (isEngineModule(spec)) return relativeSpecifier(out, ENGINE_FILE);
        const target = resolveScript(path, spec, known)!;
        if (parsed.has(target)) files.set(modulePath(target), `export default ${JSON.stringify(parsed.get(target))};\n`);
        return relativeSpecifier(out, modulePath(target));
      }),
    );
  }
  return { order: plan.order, files };
}

/** Plan a web build of `source`. Throws an `ExportError` if it can't be built. */
export async function planWebBuild(source: BuildSource, options: BuildOptions = {}): Promise<WebBuildPlan> {
  if (!source.files.includes("project.json")) throw new ExportError("The project has no project.json.");
  const copies = source.files.filter(isExportedFile).sort();
  const bootstrap = source.settings.bootstrap;
  if (typeof bootstrap === "string" && !source.scripts.has(bootstrap.replace(/^\.?\//, ""))) {
    throw new ExportError(`project.json's bootstrap is the script "${bootstrap}", which the project doesn't have.`);
  }
  const mainScene = options.mainScene ?? pickMainScene(copies);
  if (options.mainScene !== undefined && !copies.includes(options.mainScene)) throw new ExportError(`There's no scene "${options.mainScene}" in the project.`);

  const { order, files } = await compileForBuild(source.scripts, source.json);
  const name = typeof source.settings.name === "string" && source.settings.name ? source.settings.name : source.name;
  const manifest: GameManifest = {
    format: MANIFEST_FORMAT,
    name,
    mainScene,
    files: copies,
    scripts: order.map((path) => ({ source: path, module: modulePath(path) })),
  };
  const assetRefs = projectScriptAssetRefs(source.scripts.values(), (p) => copies.includes(p));
  if (assetRefs.length) (manifest as { assetRefs?: readonly string[] }).assetRefs = assetRefs;
  const generated = new Map(files);
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  generated.set("serve.mjs", SERVE_SCRIPT);
  generated.set("README.txt", webReadme(name));
  return { manifest, copies, generated };
}

/** A project file's path in the build. */
export const copiedPath = (projectPath: string) => `${PROJECT_DIR}/${projectPath}`;

/** True if `out` is inside the project folder `root` somewhere a later export would pick it up (outside hidden and build folders). Paths use either separator. */
export function isOutputInsideProject(root: string, out: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const caseless = /^[a-z]:\//i.test(norm(root)); // Windows drive paths compare without case
  const r = caseless ? norm(root).toLowerCase() : norm(root);
  const o = caseless ? norm(out).toLowerCase() : norm(out);
  if (o === r) return true;
  if (!o.startsWith(`${r}/`)) return false;
  const first = o.slice(r.length + 1).split("/")[0];
  return !(first.startsWith(".") || SKIP_DIRS.has(first));
}

/** README.txt in a web build. */
export function webReadme(name: string): string {
  return `${name}: a web build made with Myco Engine.

This folder is a complete static website. Put it on any web host (itch.io, GitHub Pages, a
static file server) and open index.html.

Running it locally: browsers don't load JavaScript modules from file:// pages, so opening
index.html straight from disk shows a message instead of the game. Serve the folder over HTTP:

  node serve.mjs            (Node.js 18 or later; then open the address it prints)
  npx serve .               (or any other static server)
  python -m http.server     (Python 3)

Saves are kept in the browser's IndexedDB, per site address.

What's here: index.html and assets/ (the player), myco.js (the engine), game.json (the
manifest), project/ (the project's files), code/ (its scripts, compiled).
`;
}

/** serve.mjs in a web build: a dependency-free static server for trying the build locally. */
export const SERVE_SCRIPT = `#!/usr/bin/env node
// Serve this folder over HTTP, to play the game locally: \`node serve.mjs [port]\` (default 8080,
// 0 picks a free port), then open the address it prints. Only this computer can connect.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
};
const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("outside");
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});
server.listen(port, "127.0.0.1", () => console.log(\`Serving the game at http://127.0.0.1:\${server.address().port}/ (Ctrl+C stops)\`));
`;
