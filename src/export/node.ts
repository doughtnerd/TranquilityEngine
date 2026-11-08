// The exporter in Node (ADR 0041), for `npm run export`: reads a project folder with the dedicated
// server's reader (src/server/project.ts), plans the web build (webBuild.ts), and writes it with
// the prebuilt player from dist/player/ (built first if it's missing). The desktop target wraps
// that web build in a generated Tauri project (desktop.ts) and runs `tauri build` when Rust is
// installed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProject, ServerError } from "../server/project";
import { DEFAULT_ICON_SVG, ICON_FILES, desktopProjectFiles, desktopReadme, type BuildSettings } from "./desktop";
import { ENGINE_FILE, MANIFEST_FILE, PLAYER_FILE_LIST, PLAYER_PAGE } from "./format";
import { Assets } from "../engine/scene/Assets";
import { bakeModelFile } from "../engine/scene/models";
import { processImages } from "./images";
import { sharpTranscoder } from "./imagesNode";
import { ExportError, copiedPath, isOutputInsideProject, planWebBuild, withBakedModels, type WebBuildPlan } from "./webBuild";

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
  let plan = await planWebBuild({ name: basename(project.root), settings: project.settings, files: project.files, scripts: project.scripts, json: project.json }, { mainScene: options.mainScene });
  // Bake the models (ADR 0090), loading them through the project's files as the server does.
  Assets.addSource(project.assets);
  try {
    plan = await withBakedModels(plan, bakeModelFile, log);
    // Resize and re-encode images per their sidecars for this platform (ADR 0119).
    plan = await processImages(plan, {
      platform: target === "desktop" ? "desktop" : "web",
      readText: (path) => readFile(join(project.root, ...path.split("/")), "utf8").catch(() => undefined),
      readBytes: async (path) => new Uint8Array(await readFile(join(project.root, ...path.split("/")))),
      transcode: sharpTranscoder,
      log,
    });
  } finally {
    Assets.removeSource(project.assets);
  }
  const playerDir = options.playerDir ?? (await ensurePlayer(log));

  await prepareOutput(out, target);
  const web = target === "desktop" ? join(out, "web") : out;
  await writeWebBuild(plan, project.root, playerDir, web);
  log(`Wrote the web build of ${plan.manifest.name} to ${web} (${plan.copies.length} project files, ${plan.manifest.scripts.length} scripts).`);
  if (target === "web") return { out, web, plan };

  const settings = project.settings as typeof project.settings & { build?: BuildSettings };
  const files = desktopProjectFiles({ name: plan.manifest.name, settings });
  const tauriDir = join(out, "src-tauri");
  for (const [path, text] of files) await writeText(join(tauriDir, path), text);
  await makeIcons(project.root, settings.build?.icon, tauriDir, log);
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
  await writeText(join(out, "README.txt"), desktopReadme(plan.manifest.name, built ? "src-tauri/target/release/bundle/" : null));
  return { out, web, plan, built };
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "game";

/** The player folder: this checkout's dist/player/, built now if it isn't. */
async function ensurePlayer(log: (line: string) => void): Promise<string> {
  if (existsSync(join(DEFAULT_PLAYER, PLAYER_FILE_LIST))) return DEFAULT_PLAYER;
  log("The player isn't built yet: building it (npm run build:player)…");
  const vite = createRequire(join(REPO, "package.json")).resolve("vite/bin/vite.js");
  const code = await run(process.execPath, [vite, "build", "--config", "vite.player.config.ts", "--logLevel", "warn"], REPO);
  if (code !== 0 || !existsSync(join(DEFAULT_PLAYER, PLAYER_FILE_LIST))) throw new ExportError("Couldn't build the player (npm run build:player).");
  return DEFAULT_PLAYER;
}

/**
 * Make sure `out` can take a build: a new or empty folder, or a previous build of the same target
 * (which is replaced). Anything else is refused rather than overwritten.
 */
async function prepareOutput(out: string, target: ExportTarget): Promise<void> {
  if (!existsSync(out)) return void (await mkdir(out, { recursive: true }));
  const entries = await readdir(out);
  if (entries.length === 0) return;
  const previous = target === "desktop" ? existsSync(join(out, "web", MANIFEST_FILE)) : existsSync(join(out, MANIFEST_FILE));
  if (!previous) throw new ExportError(`"${out}" isn't empty and doesn't hold an earlier ${target} build. Choose an empty folder.`);
  // Keep the Rust build cache of a desktop package: rebuilding Tauri from scratch takes minutes.
  for (const entry of entries) {
    if (target === "desktop" && entry === "src-tauri") {
      for (const inner of await readdir(join(out, entry))) if (inner !== "target") await rm(join(out, entry, inner), { recursive: true, force: true });
    } else {
      await rm(join(out, entry), { recursive: true, force: true });
    }
  }
}

/** Write a planned web build into `web`: the player, the project's files, and the generated files. */
export async function writeWebBuild(plan: WebBuildPlan, projectRoot: string, playerDir: string, web: string): Promise<void> {
  const player = JSON.parse(await readFile(join(playerDir, PLAYER_FILE_LIST), "utf8")) as { files: string[] };
  if (!player.files.includes(PLAYER_PAGE) || !player.files.includes(ENGINE_FILE)) throw new ExportError(`${playerDir} isn't a built player (no ${PLAYER_PAGE} or ${ENGINE_FILE}). Run npm run build:player.`);
  for (const file of player.files) await copy(join(playerDir, ...file.split("/")), join(web, file === PLAYER_PAGE ? "index.html" : file));
  for (const path of plan.copies) await copy(join(projectRoot, ...path.split("/")), join(web, ...copiedPath(path).split("/")));
  for (const [path, text] of plan.generated) await writeText(join(web, ...path.split("/")), text);
  for (const [path, bytes] of plan.binaries ?? []) {
    const to = join(web, ...path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, bytes);
  }
}

async function copy(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** The app icons, from the project's `build.icon` or the default, through `tauri icon` (no Rust needed). */
async function makeIcons(projectRoot: string, icon: string | undefined, tauriDir: string, log: (line: string) => void): Promise<void> {
  let source: string;
  if (icon) {
    source = join(projectRoot, ...icon.replace(/^\.?\//, "").split("/"));
    if (!existsSync(source)) throw new ExportError(`project.json's build.icon "${icon}" isn't in the project.`);
  } else {
    source = join(tauriDir, "app-icon.svg");
    await writeText(source, DEFAULT_ICON_SVG);
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
