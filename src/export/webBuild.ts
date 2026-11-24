// Web builds (ADR 0041): turn a project into the files of a static web build: the project's files
// to copy, its scripts compiled to JavaScript, and the manifest the player reads (format.ts). No
// file access here: the Node exporter (node.ts) and the editor (src/editor/exportBuild.ts) read
// the project, and the build writer (buildWriter.ts, ADR 0296) writes the result through their
// build folders.
//
// The project's code links through the project code linker (ADR 0329) into its build target, so a
// build runs the same JavaScript as play mode: where the editor imports each module from a URL, a
// build writes it as a file under `code/` (`projectCode/buildTarget.ts`).
import type { ProjectSettingsInput } from "../engine";
import { pickMainScene } from "../editor/projects";
import type { PackageSource } from "../editor/packages";
import { isProjectFile, skipsFolder } from "../engine/scene/projectFiles";
import { LEGACY_AUDIO_MESSAGE, hasLegacyAudio } from "../engine/audio/project/load";
import { audioEventRefusal, isAudioEventPath } from "../engine/audio/retiredAudioEvent";
import { buildTarget } from "../projectCode/buildTarget";
import type { ScriptProblem } from "../projectCode/compile";
import { link } from "../projectCode/linker";
import { planPluginCode, type BuiltPlugin } from "../plugins/thirdParty";
import type { AudioReport } from "./audio";
import { planAnimationNodes, type PlannedAnimationNodeModule } from "./animationNodes";
import { planAudioEffects, type PlannedAudioEffect } from "./audioEffects";
import { MANIFEST_FILE, MANIFEST_FORMAT, PROJECT_DIR, modulePath, type GameManifest } from "./format";
import { planLocalisation, type BuildLanguages } from "./strings";
import { planLineIndex } from "./lines";
import { LINE_INDEX_PATH } from "../engine/audio/localisation/lines/lineIndex";
import { DEFAULT_DEBUG_LINK, debugLinkAddress } from "../engine/debugLink/config";
import { isGeneratorPath } from "../engine/audio/generators/format";
import { isPlaylistPath } from "../engine/audio/playlist/format";

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
  /**
   * ADR 0376: `--debug-link`: debugging on. `game.json` gets `debug: { link }` (this address, or the editor on the same
   * machine when it's `true`) and the build ships the debug link's code; without it the build holds none of it.
   */
  readonly debugLink?: string | true;
  /**
   * ADR 0403: `--debug-listen`, `--debug-lan`, `--debug-port`: written as `game.json`'s `debug.listen`, `debug.lan` and
   * `debug.port`, and each implies debugging on (the default link when `debugLink` is absent). A native build then listens
   * for tools (on `0.0.0.0` only with `lan`); a web build can't listen, so there the keys are harmless.
   */
  readonly debugListen?: boolean;
  readonly debugLan?: boolean;
  readonly debugPort?: number;
  /**
   * ADR 0403 "Rendezvous" 3: `--debug-rendezvous <url>`: written as `game.json`'s `debug.rendezvous`, the hosted rendezvous
   * (a `ws://` or `wss://` URL) a room code without a LAN rendezvous falls back to. Implies debugging on.
   */
  readonly debugRendezvous?: string;
  /**
   * The rendezvous bundle's text (`dist/rendezvous/rendezvous.mjs`, `npm run build:rendezvous`). A debug build that is
   * given it writes it as `rendezvous.mjs` beside `serve.mjs`, and `serve.mjs` mounts it on its own port at
   * `/myco-rendezvous`, so pages it serves pair by room code through it (ADR 0403 "Rendezvous" 2). Without it (or without
   * debugging) `serve.mjs` serves files only, and a debug build says so in the plan's warnings.
   */
  readonly rendezvousBundle?: string;
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
   * ADR 0370 (T45t): the enabled project plugins' animation node modules (`animationNodes.ts`), which the build writer
   * meters into the build. Absent: none.
   */
  readonly animationNodes?: readonly PlannedAnimationNodeModule[];
  /**
   * ADR 0356 §11, 0354 §6: the languages the build ships (`strings.ts`), which the audio step splits packages by and
   * writes the line index for. Absent: the audio step reads them from `project.json`.
   */
  readonly languages?: BuildLanguages;
  /** Build warnings found while planning (`--languages` codes ignored, string keys that fell back), for the log. */
  readonly warnings?: readonly string[];
  /**
   * ADR 0360 §8: the build ships the offline render module (`myco_audio_offline.wasm`), which the Babylon audio fallback
   * fetches to play a generator. `planWebBuild` sets it when the project may play generators (`projectMayUseGenerators`);
   * false leaves the module out of the player's files (`shipsPlayerFile`). Absent: the player ships whole.
   */
  readonly offlineRender?: boolean;
}

/**
 * ADR 0360 §8, the export rule: a build ships the offline render module only when its project may play a generator —
 * it holds a `*.generator.json`, or a playlist that embeds a generator (a `"generator"` key) — because only a generator
 * makes the Babylon fallback fetch it, and every web build may run on the fallback (a browser without the core). Other
 * games save its 167 KB. The test is by text, so it errs towards shipping (a playlist that merely mentions the word).
 */
export function projectMayUseGenerators(files: readonly string[], json: ReadonlyMap<string, string>): boolean {
  if (files.some(isGeneratorPath)) return true;
  for (const [path, text] of json) if (isPlaylistPath(path) && text.includes('"generator"')) return true;
  return false;
}

/** True for the offline render module among a built player's files (Vite names it `assets/myco_audio_offline-<hash>.wasm`). */
export const isOfflineRenderFile = (file: string): boolean => /(^|\/)myco_audio_offline([-.][^/]*)?\.wasm$/i.test(file);

/** Whether a built player's `file` goes into the build `plan` (the offline render module only when the plan ships it). */
export const shipsPlayerFile = (plan: Pick<WebBuildPlan, "offlineRender">, file: string): boolean => plan.offlineRender !== false || !isOfflineRenderFile(file);

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

/** Throw an `ExportError` listing `problems`, if there are any: a build runs no code that didn't link. */
function stopOn(problems: readonly ScriptProblem[], what: string): void {
  if (problems.length === 0) return;
  throw new ExportError(`${what}:\n${problems.map((p) => `  - ${p.path}: ${p.message}`).join("\n")}`, problems);
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
  stopOn(pluginPlan.problems.map((p) => ({ path: p.where, message: p.message })), "Some plugins can't be built");
  // ADR 0352 §8: the enabled plugins' audio modules ship (hashed into game.json by the build writer); a disabled one's don't.
  const audioEffects = planAudioEffects(pluginPlan.plugins, pluginPlan.enabled);
  if (audioEffects.leaveOut.size > 0) copies = copies.filter((p) => !audioEffects.leaveOut.has(p));
  // ADR 0370 (T45t): the enabled plugins' animation node modules ship metered (the build writer meters them); a disabled one's don't.
  const animationNodes = planAnimationNodes(pluginPlan.plugins, pluginPlan.enabled);
  if (animationNodes.leaveOut.size > 0) copies = copies.filter((p) => !animationNodes.leaveOut.has(p));
  // ADR 0356 §11, 0354 §6: the shipped languages' string files; string tables and other languages' variants stay out.
  const localisation = planLocalisation(source.json, copies, { languages: options.languages, pseudo: options.pseudo }, copiedPath("project.json"));
  if (localisation.error) throw new ExportError(localisation.error);
  copies = [...localisation.copies];
  // ADR 0354 §6: the line index the runtime finds line tables and dialogue files by, and the tables without their notes.
  const lineFiles = planLineIndex(source.json, copies);
  const shippedFiles = lineFiles.size > 0 && !copies.includes(LINE_INDEX_PATH) ? [...copies, LINE_INDEX_PATH].sort() : copies;
  // The selected code links into build files (ADR 0329); any problem, a plugin entry's included, stops the build.
  const shipped = copies;
  const linked = await link(
    { code: pluginPlan.code, json: source.json, packages: source.packages, extraEntries: pluginPlan.npmEntries, isAsset: (p) => shipped.includes(p) },
    buildTarget,
  );
  stopOn(linked.problems, "Some scripts can't be built");
  const files = linked.output;
  const plugins: BuiltPlugin[] = pluginPlan.runtime.map((p) => ({ manifest: p.manifest, module: p.source.kind === "project" ? modulePath(p.runtime!) : linked.entries.get(p.runtime!)! }));
  const name = typeof source.settings.name === "string" && source.settings.name ? source.settings.name : source.name;
  let debugLink: string | null = null;
  const listening = options.debugListen === true || options.debugLan === true || options.debugPort !== undefined || options.debugRendezvous !== undefined;
  if (options.debugLink !== undefined || listening) {
    debugLink = options.debugLink === undefined || options.debugLink === true ? DEFAULT_DEBUG_LINK : debugLinkAddress(options.debugLink);
    if (options.debugPort !== undefined && !(Number.isInteger(options.debugPort) && options.debugPort >= 1 && options.debugPort <= 65526)) throw new ExportError(`The debug port ${options.debugPort} isn't a whole number from 1 to 65526.`);
    if (!debugLink) throw new ExportError(`The debug link address "${options.debugLink}" isn't a WebSocket address (ws://host:port, host:port or a port).`);
    if (options.debugRendezvous !== undefined && !isRendezvousUrl(options.debugRendezvous)) throw new ExportError(`The rendezvous address "${options.debugRendezvous}" isn't a ws:// or wss:// URL.`);
  }
  const manifest: GameManifest = {
    format: MANIFEST_FORMAT,
    name,
    mainScene,
    files: shippedFiles,
    scripts: linked.loaded.map((path) => ({ source: path, module: modulePath(path) })),
    ...(plugins.length > 0 && { plugins }),
    ...(options.audioCapture === true && { audioCapture: true as const }),
    ...(options.audioTake === true && { audioTake: true as const }),
    ...(options.audioTake === true && options.audioTakeFrames === false && { audioTakeFrames: false as const }),
    ...(localisation.manifest && { localisation: localisation.manifest }),
    ...(linked.assetRefs.length > 0 && { assetRefs: linked.assetRefs }),
    ...(debugLink && {
      debug: {
        // A listen-only build (listening flags, no --debug-link) writes no link, so it doesn't also dial the default
        // address every few seconds (the player connects out only when a link, an override or a code is given).
        ...((options.debugLink !== undefined || !listening) && { link: debugLink }),
        ...(options.debugListen === true && { listen: true }),
        ...(options.debugLan === true && { lan: true }),
        ...(options.debugPort !== undefined && { port: options.debugPort }),
        ...(options.debugRendezvous !== undefined && { rendezvous: options.debugRendezvous.trim() }),
      },
    }),
  };
  const generated = new Map([...files, ...localisation.generated, ...[...lineFiles].map(([p, t]) => [copiedPath(p), t] as const)]);
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  const serveWarnings: string[] = [];
  if (!debugLink) generated.set("serve.mjs", SERVE_SCRIPT);
  else {
    // ADR 0403 "Rendezvous" 2: a debug build's serve.mjs answers the rendezvous (when given its bundle) and, with `debugLan`, serves the LAN.
    const rendezvous = options.rendezvousBundle !== undefined;
    generated.set("serve.mjs", debugServeScript({ lan: options.debugLan === true, rendezvous }));
    if (rendezvous) generated.set(RENDEZVOUS_FILE, options.rendezvousBundle!);
    else serveWarnings.push(`This debug build has no ${RENDEZVOUS_FILE}, so its serve.mjs can't host the rendezvous: pages it serves can't pair by room code through it (run npm run build:rendezvous, then export again).`);
  }
  generated.set("README.txt", webReadme(name, debugLink !== null && options.rendezvousBundle !== undefined, debugLink !== null && options.debugLan === true));
  return {
    manifest, copies, generated,
    ...(audioEffects.modules.length > 0 && { audioEffects: audioEffects.modules }),
    ...(animationNodes.modules.length > 0 && { animationNodes: animationNodes.modules }),
    languages: localisation.languages,
    ...(localisation.warnings.length + animationNodes.skipped.length + serveWarnings.length > 0 && { warnings: [...localisation.warnings, ...animationNodes.skipped, ...serveWarnings] }),
    offlineRender: projectMayUseGenerators(shipped, source.json),
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

/** The rendezvous bundle's file name in a debug web build, beside `serve.mjs`. */
export const RENDEZVOUS_FILE = "rendezvous.mjs";

/** A `ws://` or `wss://` URL (`debug.rendezvous`; `config.ts` reads it the same way). */
function isRendezvousUrl(value: string): boolean {
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

/** README.txt in a web build. `rendezvous`: a debug build's serve.mjs hosts the rendezvous; `lan`: it serves the local network. */
export function webReadme(name: string, rendezvous = false, lan = false): string {
  const debug =
    rendezvous || lan
      ? `
Debugging: ${rendezvous ? "serve.mjs also answers the pairing rendezvous at /myco-rendezvous on its port (rendezvous.mjs\nbeside it), so pages it serves pair with debugging tools by room code. " : ""}${lan ? "It listens on every network interface,\nnot only this computer, and prints the addresses other machines on your network open (anyone on the network can\nreach it). " : ""}
`
      : "";
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
${debug}`;
}

/** The static server's code up to where it listens, shared by the release and the debug `serve.mjs`. */
const SERVE_HEAD = `#!/usr/bin/env node
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
`;

/** serve.mjs in a web build: a dependency-free static server for trying the build locally. */
export const SERVE_SCRIPT = `${SERVE_HEAD}server.listen(port, "127.0.0.1", () => console.log(\`Serving the game at http://127.0.0.1:\${server.address().port}/ (Ctrl+C stops)\`));
`;

/**
 * serve.mjs in a debug web build (ADR 0403 "Rendezvous" 2): the same static server. With `lan` it listens on every
 * interface (`0.0.0.0`) and prints this machine's network addresses; with `rendezvous` it imports `./rendezvous.mjs` (the
 * bundle, `npm run build:rendezvous`) and mounts it on its own port at `/myco-rendezvous`, beside the pages (ADR 0067).
 * The rendezvous carries only the pairing handshake, never debug traffic.
 */
export function debugServeScript(options: { readonly lan: boolean; readonly rendezvous: boolean }): string {
  const head = SERVE_HEAD.replace("Only this computer can connect.", options.lan ? "Debugging is on, with the LAN:\n// other machines on this network can connect." : "Debugging is on; only this computer can connect.");
  const mount = options.rendezvous ? `await startRendezvous(server, "/myco-rendezvous");\n` : "";
  const imports = `import { networkInterfaces } from "node:os";\n${options.rendezvous ? `import { startRendezvous } from "./${RENDEZVOUS_FILE}";\n` : ""}`;
  const lan = options.lan
    ? `  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) console.log(\`On your network: http://\${a.address}:\${bound}/\`);\n`
    : "";
  const pairing = options.rendezvous ? `  console.log(\`Pairing rendezvous at ws://127.0.0.1:\${bound}/myco-rendezvous\`);\n` : "";
  return `${head}${imports}${mount}server.listen(port, "${options.lan ? "0.0.0.0" : "127.0.0.1"}", () => {
  const bound = server.address().port;
  console.log(\`Serving the game at http://127.0.0.1:\${bound}/ (Ctrl+C stops)\`);
${lan}${pairing}});
`;
}
