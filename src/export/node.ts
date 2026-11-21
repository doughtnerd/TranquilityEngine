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
import { DEFAULT_ICON_SVG, ICON_FILES, desktopProjectFiles, desktopReadme, type BuildSettings } from "./desktop";
import { PLAYER_FILE_LIST } from "./format";
import { Assets } from "../engine/scene/Assets";
import { bakeModelFile } from "../engine/scene/models";
import { writeWebBuild, type BuildFolder, type FileSource } from "./buildWriter";
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
  let plan = await planWebBuild({ name: basename(project.root), settings: project.settings, files: project.files, scripts: project.scripts, json: project.json, packages: nodePackageSource(project.root, "production") }, { mainScene: options.mainScene, audioCapture: options.audioCapture });
  const playerDir = options.playerDir ?? (await ensurePlayer(log));

  const folder = nodeFolder(out);
  const desktop = target === "desktop";
  // Models bake through the project's files as the server loads them (ADR 0090).
  Assets.addSource(project.assets);
  try {
    plan = await writeWebBuild(plan, {
      project: nodeFiles(project.root),
      player: nodeFiles(playerDir),
      playerWhere: playerDir,
      folder,
      // A desktop package's web build sits in web/; its Rust build cache survives: rebuilding Tauri from scratch takes minutes.
      web: desktop ? "web" : "",
      keep: desktop ? ["src-tauri/target"] : [],
      kind: target,
      platform: target,
      transcode: sharpTranscoder,
      bake: bakeModelFile,
      log,
    });
  } finally {
    Assets.removeSource(project.assets);
  }
  const web = desktop ? join(out, "web") : out;
  log(`Wrote the web build of ${plan.manifest.name} to ${web} (${plan.copies.length} project files, ${plan.manifest.scripts.length} scripts).`);
  if (!desktop) return { out, web, plan };

  const settings = project.settings as typeof project.settings & { build?: BuildSettings };
  const files = desktopProjectFiles({ name: plan.manifest.name, settings });
  const tauriDir = join(out, "src-tauri");
  for (const [path, text] of files) await folder.writeText(`src-tauri/${path}`, text);
  await makeIcons(project.root, settings.build?.icon, folder, tauriDir, log);
  log(`Wrote the Tauri project to ${tauriDir}.`);

  const wantBuild = options.tauriBuild ?? hasCargo();
  let built = false;
  if (wantBuild) {
    if (!hasCargo()) throw new ExportError("`tauri build` needs the Rust toolchain (cargo), which isn't installed: see https://rustup.rs. Leave out --build to write the Tauri project only.");
    log("Running tauri build (the first build compiles Tauri, which takes a few minutes)…");
    built = (await run(process.execPath, [tauriCli(), "build"], out)) === 0;
    if (!built) throw new ExportError(`tauri build failed (its output is above). The Tauri project is in ${tauriDir}; README.txt says how to build it.`);
  } else {
    log("Rust (cargo) isn't installed, so the app wasn't built. README.txt in the output folder says how to build it.");
  }
  await folder.writeText("README.txt", desktopReadme(plan.manifest.name, built ? "src-tauri/target/release/bundle/" : null));
  return { out, web, plan, built };
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "game";

/** The player folder: this checkout's dist/player/, built now if it isn't. The build writer checks it's a complete one. */
async function ensurePlayer(log: (line: string) => void): Promise<string> {
  if (existsSync(join(DEFAULT_PLAYER, PLAYER_FILE_LIST))) return DEFAULT_PLAYER;
  log("The player isn't built yet: building it (npm run build:player)…");
  const vite = createRequire(join(REPO, "package.json")).resolve("vite/bin/vite.js");
  const code = await run(process.execPath, [vite, "build", "--config", "vite.player.config.ts", "--logLevel", "warn"], REPO);
  if (code !== 0 || !existsSync(join(DEFAULT_PLAYER, PLAYER_FILE_LIST))) throw new ExportError("Couldn't build the player (npm run build:player).");
  return DEFAULT_PLAYER;
}

const under = (root: string, path: string) => (path ? join(root, ...path.split("/")) : root);

/** A folder's files read through Node's fs, as bytes. */
function nodeFiles(root: string): FileSource {
  return { read: async (path) => new Uint8Array(await readFile(under(root, path))) };
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

/** The app icons, from the project's `build.icon` or the default, through `tauri icon` (no Rust needed). */
async function makeIcons(projectRoot: string, icon: string | undefined, folder: BuildFolder, tauriDir: string, log: (line: string) => void): Promise<void> {
  let source: string;
  if (icon) {
    source = join(projectRoot, ...icon.replace(/^\.?\//, "").split("/"));
    if (!existsSync(source)) throw new ExportError(`project.json's build.icon "${icon}" isn't in the project.`);
  } else {
    source = join(tauriDir, "app-icon.svg");
    await folder.writeText("src-tauri/app-icon.svg", DEFAULT_ICON_SVG);
  }
  const code = await run(process.execPath, [tauriCli(), "icon", source, "--output", join(tauriDir, "icons")], tauriDir, true);
  if (code !== 0 || !ICON_FILES.every((f) => existsSync(join(tauriDir, f)))) {
    log(`Couldn't make the app icons from ${source} (it should be a square PNG or SVG). Run \`npx @tauri-apps/cli icon <image>\` in ${tauriDir}.`);
  }
}

function tauriCli(): string {
  return createRequire(join(REPO, "package.json")).resolve("@tauri-apps/cli/tauri.js");
}

let cargo: boolean | null = null;
/** True if the Rust toolchain is installed. */
export function hasCargo(): boolean {
  return (cargo ??= spawnSync("cargo", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0);
}

function run(command: string, args: string[], cwd: string, quiet = false): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: quiet ? "ignore" : "inherit" });
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
}

export { ExportError, ServerError };
