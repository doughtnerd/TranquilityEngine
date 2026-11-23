// Web builds (ADR 0041): turn a project into the files of a static web build: the project's files
// to copy, its scripts compiled to JavaScript, and the manifest the player reads (format.ts). No
// file access here: the Node exporter (node.ts) and the editor (src/editor/exportBuild.ts) read
// the project, and the build writer (buildWriter.ts, ADR 0296) writes the result through their
// build folders.
//
// Scripts compile with the editor's script compiler (scriptLoader.ts), so a build runs the same
// JavaScript as play mode. Where the editor loads each module from a blob or data: URL, a build
// writes it as a file and points its imports at files: `"myco"` (and `"tranquility"`) at the
// engine module beside the player, other scripts at their compiled files, JSON files at modules
// exporting their contents.
import type { ProjectSettingsInput } from "../engine";
import { pickMainScene } from "../editor/projects";
import { compileScript, ENGINE_MODULE, LEGACY_ENGINE_MODULE, isScriptPath, loadOrder, packageSpecifiers, resolveScript, rewriteImports, type ScriptProblem } from "../editor/scriptLoader";
import { bundlePackages, isPackageSpecifier, type PackageSource } from "../editor/packages";
import { isProjectFile, skipsFolder } from "../engine/scene/projectFiles";
import { LEGACY_AUDIO_MESSAGE, hasLegacyAudio } from "../engine/audio/project/load";
import { audioEventRefusal, isAudioEventPath } from "../engine/audio/retiredAudioEvent";
import { projectScriptAssetRefs } from "../engine/scene/scriptAssetRefs";
import { planPluginCode, type BuiltPlugin } from "../plugins/thirdParty";
import type { AudioReport } from "./audio";
import { planAudioEffects, type PlannedAudioEffect } from "./audioEffects";
import { ENGINE_FILE, MANIFEST_FILE, MANIFEST_FORMAT, PROJECT_DIR, modulePath, relativeSpecifier, type GameManifest } from "./format";
import { planLocalisation, type BuildLanguages } from "./strings";
import { planLineIndex } from "./lines";
import { LINE_INDEX_PATH } from "../engine/audio/localisation/lines/lineIndex";

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
  /** The project's node_modules, for npm package imports (ADR 0125); without it, scripts importing packages can't be built. */
  readonly packages?: PackageSource;
}

export interface BuildOptions {
  /** The scene start-up Worlds without scenes of their own load; default `scenes/main.scene.json`, else the first scene. */
  readonly mainScene?: string;
  /** Write `audioCapture: true` into the manifest, so the player installs the capture trigger (default off). */
  readonly audioCapture?: boolean;
  /** ADR 0348: write `audioTake: true` into the manifest, so the player installs the take trigger (F10; default off). */
  readonly audioTake?: boolean;
  /** ADR 0348: with `audioTake`, false writes `audioTakeFrames: false`: takes record no pictures of the game view (default: they do). */
  readonly audioTakeFrames?: boolean;
  /** ADR 0354 §6, 0356 §11: `--languages`: ship only these of the project's shipped languages. Absent: every one. */
  readonly languages?: readonly string[];
  /** ADR 0356 §9: `--pseudo`: add the pseudo-languages, for QA builds. */
  readonly pseudo?: boolean;
}

/** What a web build is made of, before anything is written. */
export interface WebBuildPlan {
  readonly manifest: GameManifest;
  /** Project files copied as they are, by project path; each goes to `project/<path>`. */
  readonly copies: readonly string[];
  /** Files written from text, by build path: compiled scripts, JSON modules, the manifest, serve.mjs and README.txt. */
  readonly generated: ReadonlyMap<string, string>;
  /** Binary files written, by build path: models baked for the build (ADR 0090). */
  readonly binaries?: ReadonlyMap<string, Uint8Array>;
  /**
   * ADR 0351 §5 step 7: project files in `copies` that aren't written (packaged sounds: their bytes are in a package),
   * by project path. They stay in the manifest's `files`, so the game still knows them by path.
   */
  readonly omit?: ReadonlySet<string>;
  /** ADR 0351 §5 step 6: what the audio step converted and packaged (`audio-report.json`); absent before it ran. */
  readonly audioReport?: AudioReport;
  /**
   * ADR 0352 §8: the enabled plugins' audio modules the build ships (`audioEffects.ts`); the build writer hashes them
   * and writes `game.json`'s `audioEffects`. Absent: none.
   */
  readonly audioEffects?: readonly PlannedAudioEffect[];
  /**
   * ADR 0356 §11, 0354 §6: the languages the build ships (`strings.ts`), which the audio step splits packages by and
   * writes the line index for. Absent: the audio step reads them from `project.json`.
   */
  readonly languages?: BuildLanguages;
  /** Build warnings found while planning (`--languages` codes ignored, string keys that fell back), for the log. */
  readonly warnings?: readonly string[];
}

/** A project that can't be built: scripts that don't compile, a missing bootstrap script or scene. */
export class ExportError extends Error {
  constructor(message: string, readonly problems: readonly ScriptProblem[] = []) {
    super(message);
    this.name = "ExportError";
  }
}

/** Editor-only files at the project root: the editor's tsconfig.json (ADR 0030), a sample's listing (ADR 0031). */
const EDITOR_FILES = new Set(["tsconfig.json", "jsconfig.json", "sample.json"]);

/**
 * True if a file goes into builds as it is: every project file (ADR 0254: not hidden, not in a
 * dependency or build folder, not a script, which ships compiled) but the editor-only ones and
 * TypeScript tool modules (`.mts`, `.cts`), which nothing in a build can run.
 * Asset sidecars (`<asset>.meta.json`) are ordinary files and go in.
 */
const isExportedFile = (path: string) => isProjectFile(path) && !EDITOR_FILES.has(path) && !/\.(mts|cts)$/i.test(path);

const isEngineModule = (specifier: string) => specifier === ENGINE_MODULE || specifier === LEGACY_ENGINE_MODULE;

/** Where the bundled npm packages go in a build (ADR 0125): `code/deps/<chunk>.js`. */
export const DEPS_DIR = "code/deps";

/**
 * Compile every script and point its imports at build files; npm packages they import are bundled
 * into `code/deps/` (ADR 0125). Throws an `ExportError` listing every script that fails.
 */
async function compileForBuild(
  scripts: ReadonlyMap<string, string>,
  json: ReadonlyMap<string, string>,
  packages?: PackageSource,
  extraPackages: readonly string[] = [],
): Promise<{ order: string[]; files: Map<string, string>; packageEntries: Map<string, string> }> {
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
  // npm plugins' runtime entries (ADR 0139) bundle with the packages the scripts import.
  const specifiers = [...new Set([...packageSpecifiers(compiled.values()), ...extraPackages])].sort();
  const files = new Map<string, string>();
  const entryFiles = new Map<string, string>();
  const packageProblems = new Map<string, string | undefined>();
  if (specifiers.length > 0 && !packages) for (const s of specifiers) packageProblems.set(s, "npm packages need the project folder's node_modules");
  else if (specifiers.length > 0 && packages) {
    const bundle = await bundlePackages(specifiers, packages);
    for (const [name, chunk] of bundle.chunks) {
      const out = `${DEPS_DIR}/${name}`;
      files.set(out, rewriteImports(chunk.code, chunk.imports, (spec) => (isEngineModule(spec) ? relativeSpecifier(out, ENGINE_FILE) : spec)));
    }
    for (const [spec, entry] of bundle.entries) entryFiles.set(spec, `${DEPS_DIR}/${entry}`);
    for (const s of specifiers) packageProblems.set(s, entryFiles.has(s) ? undefined : (bundle.problems.get(s) ?? "it wasn't bundled"));
  }
  const plan = loadOrder(compiled, new Map([...json.keys()].map((p) => [p, parsed.has(p)])), packageProblems);
  problems.push(...plan.problems);
  for (const spec of extraPackages) if (packageProblems.get(spec) !== undefined) problems.push({ path: spec, message: `the plugin entry can't be bundled: ${packageProblems.get(spec)}` });
  if (problems.length > 0) {
    const list = problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n");
    throw new ExportError(`Some scripts can't be built:\n${list}`, problems);
  }
  const known = new Set([...compiled.keys(), ...json.keys()]);
  for (const path of plan.order) {
    const s = compiled.get(path)!;
    const out = modulePath(path);
    files.set(
      out,
      rewriteImports(s.code, s.imports, (spec) => {
        if (isEngineModule(spec)) return relativeSpecifier(out, ENGINE_FILE);
        if (isPackageSpecifier(spec)) return relativeSpecifier(out, entryFiles.get(spec)!);
        const target = resolveScript(path, spec, known)!;
        if (parsed.has(target)) files.set(modulePath(target), `export default ${JSON.stringify(parsed.get(target))};\n`);
        return relativeSpecifier(out, modulePath(target));
      }),
    );
  }
  return { order: plan.order, files, packageEntries: entryFiles };
}

/** A JSON file's value, or undefined when it has none or doesn't parse. */
function parsedJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Plan a web build of `source`. Throws an `ExportError` if it can't be built. */
export async function planWebBuild(source: BuildSource, options: BuildOptions = {}): Promise<WebBuildPlan> {
  if (!source.files.includes("project.json")) throw new ExportError("The project has no project.json.");
  // ADR 0344: the mix ships in audio.json, copied with the other files; an unmigrated project.json audio section is refused.
  if (hasLegacyAudio(parsedJson(source.json.get("project.json")))) throw new ExportError(LEGACY_AUDIO_MESSAGE);
  // ADR 0343: the retired audio event format doesn't ship; the project migrates its events to playlists first.
  const events = source.files.filter((f) => isAudioEventPath(f) && isExportedFile(f));
  if (events.length > 0) {
    throw new ExportError(`${audioEventRefusal("Export", events[0]!)}${events.length > 1 ? ` (${events.length} audio event files in all)` : ""}`, events.map((path) => ({ path, message: audioEventRefusal("Export", path) })));
  }
  let copies = source.files.filter(isExportedFile).sort();
  const bootstrap = source.settings.bootstrap;
  if (typeof bootstrap === "string" && !source.scripts.has(bootstrap.replace(/^\.?\//, ""))) {
    throw new ExportError(`project.json's bootstrap is the script "${bootstrap}", which the project doesn't have.`);
  }
  const mainScene = options.mainScene ?? pickMainScene(copies);
  if (options.mainScene !== undefined && !copies.includes(options.mainScene)) throw new ExportError(`There's no scene "${options.mainScene}" in the project.`);

  // Third-party plugins (ADR 0139): the enabled ones' runtime halves build with the scripts; a refused plugin stops the build.
  const pluginPlan = await planPluginCode(
    { json: source.json, code: source.scripts, packages: source.packages?.files, disabled: source.settings.plugins?.disabled, assets: source.files },
    { editor: false },
  );
  if (pluginPlan.problems.length > 0) {
    const list = pluginPlan.problems.map((p) => `  - ${p.where}: ${p.message}`).join("\n");
    throw new ExportError(`Some plugins can't be built:\n${list}`, pluginPlan.problems.map((p) => ({ path: p.where, message: p.message })));
  }
  // ADR 0352 §8: the enabled plugins' audio modules ship (hashed into game.json by the build writer); a disabled one's don't.
  const audioEffects = planAudioEffects(pluginPlan.plugins, pluginPlan.enabled);
  if (audioEffects.leaveOut.size > 0) copies = copies.filter((p) => !audioEffects.leaveOut.has(p));
  // ADR 0356 §11, 0354 §6: the shipped languages' string files; string tables and other languages' variants stay out.
  const localisation = planLocalisation(source.json, copies, { languages: options.languages, pseudo: options.pseudo }, copiedPath("project.json"));
  if (localisation.error) throw new ExportError(localisation.error);
  copies = [...localisation.copies];
  // ADR 0354 §6: the line index the runtime finds line tables and dialogue files by, and the tables without their notes.
  const lineFiles = planLineIndex(source.json, copies);
  const shippedFiles = lineFiles.size > 0 && !copies.includes(LINE_INDEX_PATH) ? [...copies, LINE_INDEX_PATH].sort() : copies;
  const { order, files, packageEntries } = await compileForBuild(pluginPlan.code, source.json, source.packages, pluginPlan.npmEntries);
  const plugins: BuiltPlugin[] = pluginPlan.runtime.map((p) => ({ manifest: p.manifest, module: p.source.kind === "project" ? modulePath(p.runtime!) : packageEntries.get(p.runtime!)! }));
  const name = typeof source.settings.name === "string" && source.settings.name ? source.settings.name : source.name;
  const manifest: GameManifest = {
    format: MANIFEST_FORMAT,
    name,
    mainScene,
    files: shippedFiles,
    scripts: order.map((path) => ({ source: path, module: modulePath(path) })),
    ...(plugins.length > 0 && { plugins }),
    ...(options.audioCapture === true && { audioCapture: true as const }),
    ...(options.audioTake === true && { audioTake: true as const }),
    ...(options.audioTake === true && options.audioTakeFrames === false && { audioTakeFrames: false as const }),
    ...(localisation.manifest && { localisation: localisation.manifest }),
  };
  const assetRefs = projectScriptAssetRefs(source.scripts.values(), (p) => copies.includes(p));
  if (assetRefs.length) (manifest as { assetRefs?: readonly string[] }).assetRefs = assetRefs;
  const generated = new Map([...files, ...localisation.generated, ...[...lineFiles].map(([p, t]) => [copiedPath(p), t] as const)]);
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  generated.set("serve.mjs", SERVE_SCRIPT);
  generated.set("README.txt", webReadme(name));
  return {
    manifest, copies, generated,
    ...(audioEffects.modules.length > 0 && { audioEffects: audioEffects.modules }),
    languages: localisation.languages,
    ...(localisation.warnings.length > 0 && { warnings: localisation.warnings }),
  };
}

/** Model files the build bakes (ADR 0090; the same extensions as `scene/models.ts`, which isn't imported here). */
const MODEL_FILE = /\.(obj|fbx|gltf|glb)$/i;
/** The suffix of a baked model beside its model file (`scene/bakedModel.ts`). */
const BAKED_SUFFIX = ".mycomesh";

/** Baking one model: its baked file, and textures that couldn't be kept. */
export type BakeModel = (path: string) => Promise<{ bytes: Uint8Array; dropped: readonly string[] }>;

/**
 * Add baked copies of the plan's models (ADR 0090): `<model>.mycomesh` beside each model in
 * `project/`, listed in the manifest, which the player loads instead of parsing the model. A model
 * that fails to bake is left to load from its file (said through `log`).
 */
export async function withBakedModels(plan: WebBuildPlan, bake: BakeModel, log: (line: string) => void = () => {}): Promise<WebBuildPlan> {
  const binaries = new Map(plan.binaries ?? []);
  const baked: string[] = [];
  for (const path of plan.copies) {
    if (!MODEL_FILE.test(path) || plan.copies.includes(path + BAKED_SUFFIX)) continue;
    try {
      const { bytes, dropped } = await bake(path);
      binaries.set(copiedPath(path + BAKED_SUFFIX), bytes);
      baked.push(path + BAKED_SUFFIX);
      if (dropped.length) log(`${path}: baked without ${dropped.join(", ")} (not project files).`);
    } catch (err) {
      log(`${path} couldn't be baked (${(err as Error)?.message ?? err}); the game loads it from the file.`);
    }
  }
  if (!baked.length) return plan;
  const manifest: GameManifest = { ...plan.manifest, files: [...plan.manifest.files, ...baked].sort() };
  const generated = new Map(plan.generated);
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...plan, manifest, generated, binaries };
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
  return !skipsFolder(first);
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
  ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".ktx2": "image/ktx2",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4",
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
