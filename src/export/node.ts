// The exporter in Node (ADR 0041), for `npm run export`: reads a project folder with the dedicated
// server's reader (src/server/project.ts), plans the web build (webBuild.ts), and writes it with
// the build writer (buildWriter.ts, ADR 0296) through Node's fs, with the prebuilt player from
// dist/player/ (built first if it's missing). The desktop target wraps that web build in a
// generated Tauri project (desktop.ts) and runs `tauri build` when Rust is installed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProject, ServerError } from "../server/project";
import { nodePackageSource } from "../server/packages";
import { DEBUG_LISTENER_CRATES, DEBUG_MULTICAST_PLUGIN, DEFAULT_ICON_SVG, ICON_FILES, ICON_SOURCES, desktopProjectFiles, desktopReadme, type BuildSettings } from "./desktop";
import { PLAYER_FILE_LIST } from "./format";
import { acquireProjectContext } from "../engine/core/projectContext";
import { bakeModelFile } from "../engine/scene/models";
import { NOTICES_FILE, writeWebBuild, type BuildFolder, type FileSource } from "./buildWriter";
import type { AudioCacheStore } from "./audio";
import { DECODER_WASM_URL, createAudioDecoder } from "./audioDecode";
import { createNodeAudioEncoder } from "./audioEncoderNode";
import type { ImportPlatform } from "../engine/scene/importSettings";
import { sharpTranscoder } from "./imagesNode";
import { ExportError, isOutputInsideProject, planWebBuild, type WebBuildPlan } from "./webBuild";

export type ExportTarget = "web" | "desktop";

export interface ExportOptions {
  projectDir: string;
  /** Output folder; default `<projectDir>/dist/<target>`. */
  out?: string;
  target?: ExportTarget;
  /** The scene start-up Worlds without scenes load (default: `scenes/main.scene.json`, else the first scene). */
  mainScene?: string;
  /** The prebuilt player; default this checkout's dist/player/, built if it's missing. */
  playerDir?: string;
  /** Desktop: run `tauri build` (default: when cargo is installed). */
  tauriBuild?: boolean;
  /** Ship the built-in audio capture trigger (F9, a three-finger hold): the game can record its audio mix for the Profiler (default off). */
  audioCapture?: boolean;
  /** ADR 0348: ship the take trigger (F10): the game can record takes for the Studio (default off). */
  audioTake?: boolean;
  /** ADR 0348: with `audioTake`, false keeps pictures of the game view out of takes (default: takes record them). */
  audioTakeFrames?: boolean;
  /**
   * ADR 0351 §1: the platform images and audio are converted for (default: the target's; `android` converts a web build
   * for Android until its exporter lands, ADR 0155).
   */
  platform?: ImportPlatform;
  /** ADR 0351 §5: `--no-audio-convert`: audio ships as its sources (packages are still built), and the report says so. */
  audioConvert?: boolean;
  /** ADR 0354 §6, 0356 §11: `--languages`: ship only these of the project's shipped languages (default: every one). */
  languages?: string[];
  /** ADR 0356 §9: `--pseudo`: add the pseudo-languages, for QA builds. */
  pseudo?: boolean;
  /** Audio encoder threads (default: cores − 1). */
  audioWorkers?: number;
  /**
   * ADR 0376: `--debug-link <address>`: debugging on. `game.json` gets `debug.link` (the editor's WebSocket address) and
   * the build ships the debug link; a desktop app also takes `--debug-link` at launch. Absent: a release build, with none
   * of the link's code.
   */
  debugLink?: string;
  /** ADR 0403: `--debug-listen`: the build listens for tools (`debug.listen`); a desktop one gets the native listener crates. Implies debugging on. */
  debugListen?: boolean;
  /** ADR 0403: `--debug-lan`: with listening, bind `0.0.0.0`, paired by code (`debug.lan`). Implies debugging on. */
  debugLan?: boolean;
  /** ADR 0403: `--debug-port N`: the first port a listening build tries (`debug.port`). Implies debugging on. */
  debugPort?: number;
  /** ADR 0403 "Rendezvous" 3: `--debug-rendezvous <url>`: the hosted rendezvous, written as `debug.rendezvous`. Implies debugging on. */
  debugRendezvous?: string;
  /**
   * The rendezvous bundle a debug web build ships beside `serve.mjs`; default this checkout's `dist/rendezvous/rendezvous.mjs`,
   * built now (`npm run build:rendezvous`) if it's missing, as the player is.
   */
  rendezvousFile?: string;
  log?: (line: string) => void;
}

export interface ExportResult {
  /** The output folder, absolute. */
  out: string;
  /** The web build's folder (`out`, or `out/web` for desktop). */
  web: string;
  plan: WebBuildPlan;
  /** Desktop: whether `tauri build` ran and succeeded. */
  built?: boolean;
}

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_PLAYER = join(REPO, "dist", "player");

/** Export a project folder. Throws an `ExportError` (or `ServerError`, for a bad folder) with a message for the command line. */
export async function exportProject(options: ExportOptions): Promise<ExportResult> {
  const log = options.log ?? (() => {});
  const target = options.target ?? "web";
  const project = await readProject(options.projectDir);
  const out = resolve(options.out ?? join(project.root, "dist", target));
  if (isOutputInsideProject(project.root, out)) {
    throw new ExportError(`The output folder "${out}" is inside the project, where the next export would copy it in. Use a folder outside it, or under its dist/ folder.`);
  }
  // ADR 0403 "Rendezvous" 2: a debug web build's serve.mjs hosts the rendezvous, so the build carries its bundle.
  const debugOn = options.debugLink !== undefined || options.debugListen || options.debugLan || options.debugPort !== undefined || options.debugRendezvous !== undefined;
  const rendezvousBundle = debugOn && target === "web" ? await readFile(options.rendezvousFile ?? (await ensureRendezvous(log)), "utf8") : undefined;
  let plan = await planWebBuild({ name: basename(project.root), settings: project.settings, files: project.files, scripts: project.scripts, json: project.json, ui: project.ui, packages:
 nodePackageSource(project.root, "production") }, { mainScene: options.mainScene, audioCapture: options.audioCapture, audioTake: options.audioTake, audioTakeFrames: options.audioTakeFrames, languages: options.languages, pseudo: options.pseudo, ...(options.debugLink !== undefined && { debugLink: options.debugLink }), ...(options.debugListen && { debugListen: true }), ...(options.debugLan && { debugLan: true }), ...(options.debugPort !== undefined && { debugPort: options.debugPort }), ...(options.debugRendezvous !== undefined && { debugRendezvous: options.debugRendezvous }), ...(rendezvousBundle !== undefined && { rendezvousBundle }) });
  const playerDir = options.playerDir ?? (await ensurePlayer(log));

  const folder = nodeFolder(out);
  const desktop = target === "desktop";
  // Models bake through the project's files as the server loads them (ADR 0090).
  const context = acquireProjectContext({ assets: project.assets });
  const platform = options.platform ?? target;
  const encoder = options.audioConvert === false ? null : createNodeAudioEncoder({ workers: options.audioWorkers });
  try {
    plan = await writeWebBuild(plan, {
      project: nodeFiles(project.root),
      audio: { encoder, decode: createAudioDecoder(() => readFile(DECODER_WASM_URL)), cache: nodeCache(project.root) },
      notices: await readFile(join(REPO, NOTICES_FILE), "utf8").catch(() => undefined),
      player: nodeFiles(playerDir),
      playerWhere: playerDir,
      folder,
      // A desktop package's web build sits in web/; its Rust build cache survives: rebuilding Tauri from scratch takes minutes.
      web: desktop ? "web" : "",
      keep: desktop ? ["src-tauri/target"] : [],
      kind: target,
      platform,
      transcode: sharpTranscoder,
      bake: bakeModelFile,
      log,
    });
  } finally {
    encoder?.close();
    context.release();
  }
  const web = desktop ? join(out, "web") : out;
  log(`Wrote the web build of ${plan.manifest.name} to ${web} (${plan.copies.length} project files, ${plan.manifest.scripts.length} scripts).`);
  if (!desktop) return { out, web, plan };

  const settings = project.settings as typeof project.settings & { build?: BuildSettings };
  const gamepadModule = await readFile(join(REPO, "src-tauri", "src", "gamepad.rs"), "utf8");
  const debug = plan.manifest.debug !== undefined;
  // ADR 0403: a debug package carries the listener crates' sources, compiled by its own `tauri build` (a release one carries none).
  const debugListener = debug ? await readListenerCrates() : undefined;
  const files = desktopProjectFiles({ name: plan.manifest.name, settings, gamepadModule, debug, ...(debugListener && { debugListener }) });
  const tauriDir = join(out, "src-tauri");
  for (const [path, text] of files) await folder.writeText(`src-tauri/${path}`, text);
  const wantBuild = options.tauriBuild ?? hasCargo();
  const icon = await makeIcons(project.root, settings.build?.icon, folder, tauriDir, wantBuild, log);
  log(`Wrote the Tauri project to ${tauriDir}.`);

  let built = false;
  if (wantBuild) {
    if (!hasCargo()) throw new ExportError("`tauri build` needs the Rust toolchain (cargo), which isn't installed: see https://rustup.rs. Leave out --build to write the Tauri project only.");
    log("Running tauri build (the first build compiles Tauri, which takes a few minutes)…");
    built = (await run(process.execPath, [tauriCli(), "build"], out)) === 0;
    if (!built) throw new ExportError(`tauri build failed (its output is above). The Tauri project is in ${tauriDir}; README.txt says how to build it.`);
  } else if (options.tauriBuild === false) {
    log("The app wasn't built (--no-build). README.txt in the output folder says how to build it.");
  } else {
    log("Rust (cargo) isn't installed, so the app wasn't built. README.txt in the output folder says how to build it.");
  }
  await folder.writeText("README.txt", desktopReadme(plan.manifest.name, built ? "src-tauri/target/release/bundle/" : null, icon));
  return { out, web, plan, built };
}

/** native/ws-listener and native/debug-link-tauri's Cargo.toml and src/*.rs, by path under `vendor/` (their relative path dependency keeps working there). */
async function readListenerCrates(): Promise<Map<string, string>> {
  const crates = new Map<string, string>();
  for (const crate of DEBUG_LISTENER_CRATES) {
    const root = join(REPO, "native", crate);
    crates.set(`${crate}/Cargo.toml`, await readFile(join(root, "Cargo.toml"), "utf8"));
    for (const file of (await readdir(join(root, "src"))).filter((f) => f.endsWith(".rs")).sort()) crates.set(`${crate}/src/${file}`, await readFile(join(root, "src", file), "utf8"));
  }
  const plugin = join(REPO, "native", DEBUG_MULTICAST_PLUGIN.crate);
  for (const file of DEBUG_MULTICAST_PLUGIN.files) crates.set(`${DEBUG_MULTICAST_PLUGIN.crate}/${file}`, await readFile(join(plugin, ...file.split("/")), "utf8"));
  return crates;
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "game";

/** The player folder: this checkout's dist/player/, built now if it isn't. The build writer checks it's a complete one. */
async function ensurePlayer(log: (line: string) => void): Promise<string> {
  if (existsSync(join(DEFAULT_PLAYER, PLAYER_FILE_LIST))) return DEFAULT_PLAYER;
  log("The player isn't built yet: building it (npm run build:player)…");
  // Vite's package exports don't include its bin script; find it through its package.json's `bin`.
  const vitePackage = createRequire(join(REPO, "package.json")).resolve("vite/package.json");
  const { bin } = JSON.parse(await readFile(vitePackage, "utf8")) as { bin: string | Record<string, string> };
  const vite = join(dirname(vitePackage), typeof bin === "string" ? bin : bin.vite);
  const code = await run(process.execPath, [vite, "build", "--config", "vite.player.config.ts", "--logLevel", "warn"], REPO);
  if (code !== 0 || !existsSync(join(DEFAULT_PLAYER, PLAYER_FILE_LIST))) throw new ExportError("Couldn't build the player (npm run build:player).");
  return DEFAULT_PLAYER;
}

const DEFAULT_RENDEZVOUS = join(REPO, "dist", "rendezvous", "rendezvous.mjs");

/** The rendezvous bundle (`npm run build:rendezvous`): this checkout's dist/rendezvous/rendezvous.mjs, built now if it isn't. */
async function ensureRendezvous(log: (line: string) => void): Promise<string> {
  if (existsSync(DEFAULT_RENDEZVOUS)) return DEFAULT_RENDEZVOUS;
  log("The rendezvous isn't built yet: building it (npm run build:rendezvous)…");
  const vitePackage = createRequire(join(REPO, "package.json")).resolve("vite/package.json");
  const { bin } = JSON.parse(await readFile(vitePackage, "utf8")) as { bin: string | Record<string, string> };
  const vite = join(dirname(vitePackage), typeof bin === "string" ? bin : bin.vite);
  const code = await run(process.execPath, [vite, "build", "--config", "tools/rendezvous/vite.config.ts", "--logLevel", "warn"], REPO);
  if (code !== 0 || !existsSync(DEFAULT_RENDEZVOUS)) throw new ExportError("Couldn't build the rendezvous for the debug build's serve.mjs. Run: npm run build:rendezvous");
  return DEFAULT_RENDEZVOUS;
}

const under = (root: string, path: string) => (path ? join(root, ...path.split("/")) : root);

/** A folder's files read through Node's fs, as bytes. */
function nodeFiles(root: string): FileSource {
  return { read: async (path) => new Uint8Array(await readFile(under(root, path))) };
}

/** The audio cache (ADR 0351 §5) in the project folder's `.myco/cache/audio/` (paths relative to the project). */
function nodeCache(root: string): AudioCacheStore {
  return {
    read: (path) => readFile(under(root, path)).then((b) => new Uint8Array(b), () => null),
    write: async (path, bytes) => {
      const to = under(root, path);
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, bytes);
    },
  };
}

/** The build folder `root` through Node's fs (the command line's adapter). */
function nodeFolder(root: string): BuildFolder {
  const write = async (path: string, data: string | Uint8Array) => {
    const to = under(root, path);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, data);
  };
  return {
    where: root,
    exists: async (path) => existsSync(under(root, path)),
    list: async (path) => (await readdir(under(root, path), { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
    remove: (path) => rm(under(root, path), { recursive: true, force: true }),
    writeText: write,
    writeBytes: write,
  };
}

/**
 * The app icons, from the project's `build.icon` or the default, through `tauri icon` (no Rust needed). The source is
 * kept as `src-tauri/app-icon.png` or `.svg`, as the editor's package keeps it, for README.txt's icon step. Without
 * icons `tauri build` fails (on Windows: "icons/icon.ico not found"), so when the app is to be built a failure stops
 * the export here, with `tauri icon`'s own message; otherwise it's a warning. Resolves to the source's name.
 */
async function makeIcons(projectRoot: string, icon: string | undefined, folder: BuildFolder, tauriDir: string, building: boolean, log: (line: string) => void): Promise<(typeof ICON_SOURCES)[number]> {
  const path = icon?.replace(/^\.?\//, "");
  if (path && !/\.(png|svg)$/i.test(path)) throw new ExportError(`project.json's build.icon "${icon}" must be a square PNG or SVG.`);
  const name = path?.toLowerCase().endsWith(".png") ? "app-icon.png" : "app-icon.svg";
  if (path) {
    const from = join(projectRoot, ...path.split("/"));
    if (!existsSync(from)) throw new ExportError(`project.json's build.icon "${icon}" isn't in the project.`);
    await folder.writeBytes(`src-tauri/${name}`, new Uint8Array(await readFile(from)));
  } else {
    await folder.writeText(`src-tauri/${name}`, DEFAULT_ICON_SVG);
  }
  for (const stale of ICON_SOURCES) if (stale !== name) await rm(join(tauriDir, stale), { force: true });
  const source = join(tauriDir, name);
  const { code, output } = await runCaptured(process.execPath, [tauriCli(), "icon", source, "--output", join(tauriDir, "icons")], tauriDir);
  if (code !== 0 || !ICON_FILES.every((f) => existsSync(join(tauriDir, f)))) {
    const message = `Couldn't make the app icons from ${path ?? "the default icon"} (it should be a square PNG or SVG)${output.trim() ? `: ${output.trim()}` : "."}`;
    if (building) throw new ExportError(`${message}\nWithout them tauri build can't make the app.`);
    log(`${message} README.txt in the output folder says how to make them.`);
  }
  return name;
}

function tauriCli(): string {
  return createRequire(join(REPO, "package.json")).resolve("@tauri-apps/cli/tauri.js");
}

let cargo: boolean | null = null;
/** True if the Rust toolchain is installed. */
export function hasCargo(): boolean {
  return (cargo ??= spawnSync("cargo", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0);
}

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
}

/** Run a command quietly, keeping what it printed for an error message. */
function runCaptured(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (err) => done({ code: 1, output: `${output}${err.message}` }));
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

export { ExportError, ServerError };
