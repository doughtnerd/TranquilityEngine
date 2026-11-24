// Build / Export in the editor (ADR 0041): write a web build of the open project into a folder,
// through the platform FileSystem. The plan is the Node exporter's (src/export/webBuild.ts) and so
// is the build writer (src/export/buildWriter.ts, ADR 0296); here are the editor's file sources:
// the player's files fetched from the copy served beside the editor at player/ (dist/player/, like
// the samples, ADR 0031), and the project's files from what the editor already holds.
import type { FileSystem } from "../engine/platform/FileSystem";
import { fileSystemFolder, writeWebBuild, type FileSource } from "../export/buildWriter";
import { browserTranscoder } from "../export/imagesBrowser";
import { NO_AUDIO_CACHE, type AudioCacheStore } from "../export/audio";
import { DECODER_WASM_URL, createAudioDecoder } from "../export/audioDecode";
import { createBrowserAudioEncoder } from "../export/audioEncoderBrowser";
import { joinPath } from "./projectPaths";
import NOTICES from "../../THIRD_PARTY_NOTICES.md?raw";
import { bakeModelFile } from "../engine/scene/models";
import { packageSourceFor } from "./projectPackages";
import { ExportError, isOutputInsideProject, planWebBuild, type BuildOptions, type WebBuildPlan } from "../export/webBuild";
import { jsonFiles, type EditorProject } from "./projects";
import { DEFAULT_DEBUG_LINK_PORT } from "../engine/debugLink/config";
import { DEBUG_LISTENER_CRATES, DEBUG_MULTICAST_PLUGIN, DEFAULT_ICON_SVG, ICON_SOURCES, desktopProjectFiles, desktopReadme, type BuildSettings } from "../export/desktop";
// ADR 0335: exported games' gamepad module is the editor shell's, copied verbatim (as the command line's exporter does).
import GAMEPAD_MODULE from "../../src-tauri/src/gamepad.rs?raw";

/** The command-line export of a desktop package, for the browser editor, which can't run the host's toolchain (ADR 0406). */
export const desktopExportCommand = (project: EditorProject, audioCapture = false, audioTake = false, takePictures = true, debugLink = false, debugListen = false, debugLan = false, debugRendezvous = "") =>
  `npm run export -- "${project.root ?? "<projectDir>"}" --target desktop${audioCapture ? " --audio-capture" : ""}${audioTake ? " --audio-take" : ""}${audioTake && !takePictures ? " --no-take-pictures" : ""}${debugLink ? ` --debug-link ${DEFAULT_DEBUG_LINK_PORT}` : ""}${debugLink && debugListen ? " --debug-listen" : ""}${debugLink && debugListen && debugLan ? " --debug-lan" : ""}${debugLink && debugRendezvous.trim() ? ` --debug-rendezvous "${debugRendezvous.trim()}"` : ""}`;

/** Whether `value` is a `ws://` or `wss://` URL, as the Export dialog's Rendezvous URL field takes (an empty one is none). */
export function isRendezvousUrl(value: string): boolean {
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't read ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A text file's contents, or undefined when it can't be read (a missing optional file). */
async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/** The open project's files: text the editor holds, else the bytes behind its asset URL. */
function projectFiles(project: EditorProject): FileSource {
  return {
    read: async (path) => {
      const text = project.textOf(path);
      if (text !== undefined) return text;
      const url = project.assets.get(path);
      if (typeof url !== "string") throw new Error("not in the project");
      return fetchBytes(url);
    },
  };
}

/** The player served beside the editor. */
const playerFiles: FileSource = { read: (path) => fetchBytes(new URL(`player/${path}`, document.baseURI).href) };

/**
 * Write a web build of `project` into the folder `out`, which must be empty or hold an earlier
 * build (replaced). `progress` hears how many files are written out of how many. Throws an
 * `ExportError` if the project can't be built or the folder can't take it.
 */
export function exportProjectBuild(project: EditorProject, fs: FileSystem, out: string, progress?: (done: number, total: number) => void, options: BuildOptions = {}): Promise<WebBuildPlan> {
  return writeBuild(project, fs, out, "web", progress, options);
}

/**
 * ADR 0406: write a desktop package of `project` into `out` (ADR 0041's layout): the web build in
 * `web/`, the generated Tauri project in `src-tauri/` with its icon's source as
 * `src-tauri/app-icon.png` or `.svg` (`build.icon`, else the neutral default) for `tauri icon` to
 * make the icons from, and README.txt. `out` must be empty or hold an earlier desktop package
 * (replaced, keeping `src-tauri/target/`, the Rust build cache). Building it is the host's job
 * (`hostToolchain.ts`); `built` says where its installers are, for the README.
 */
export async function exportDesktopProject(project: EditorProject, fs: FileSystem, out: string, progress?: (done: number, total: number) => void, options: BuildOptions = {}): Promise<WebBuildPlan> {
  const settings = project.settings as typeof project.settings & { build?: BuildSettings };
  const icon = settings.build?.icon?.replace(/^\.?\//, "");
  if (icon && !/\.(png|svg)$/i.test(icon)) throw new ExportError(`project.json's build.icon "${icon}" must be a square PNG or SVG.`);
  const iconSource = icon ? await projectFiles(project).read(icon).catch(() => { throw new ExportError(`project.json's build.icon "${icon}" isn't in the project.`); }) : DEFAULT_ICON_SVG;
  const plan = await writeBuild(project, fs, out, "desktop", progress, options);
  const folder = fileSystemFolder(fs, out);
  const debug = plan.manifest.debug !== undefined;
  // ADR 0403: a debug package carries the listener crates' sources, compiled by its own `tauri build` (a release one carries none).
  const debugListener = debug ? await listenerCrates() : undefined;
  for (const [path, text] of desktopProjectFiles({ name: plan.manifest.name, settings, gamepadModule: GAMEPAD_MODULE, debug, ...(debugListener && { debugListener }) })) {
    await folder.writeText(`src-tauri/${path}`, text);
  }
  const iconFile = `src-tauri/app-icon.${icon?.toLowerCase().endsWith(".png") ? "png" : "svg"}`;
  for (const stale of ICON_SOURCES.map((name) => `src-tauri/${name}`)) if (stale !== iconFile && (await folder.exists(stale))) await folder.remove(stale, false);
  await (typeof iconSource === "string" ? folder.writeText(iconFile, iconSource) : folder.writeBytes(iconFile, iconSource));
  await writeDesktopReadme(fs, out, plan.manifest.name, false);
  return plan;
}

/**
 * ADR 0403: the debug link's listener crates and the Android multicast plugin, by path under `src-tauri/vendor/`, as the
 * command line's exporter reads them from native/ (`readListenerCrates` in src/export/node.ts): each crate's Cargo.toml
 * and src/*.rs, and the plugin's listed files. The editor bundles them, loaded only for a debug package.
 */
const NATIVE_SOURCES = import.meta.glob(
  [
    "../../native/{ws-listener,debug-discovery,debug-link-tauri}/Cargo.toml",
    "../../native/{ws-listener,debug-discovery,debug-link-tauri}/src/*.rs",
    "../../native/tauri-plugin-myco-multicast/{Cargo.toml,build.rs,src/lib.rs,permissions/default.toml}",
    "../../native/tauri-plugin-myco-multicast/android/{build.gradle.kts,settings.gradle,src/main/AndroidManifest.xml,src/main/java/com/myco/multicast/MulticastPlugin.kt}",
  ],
  { query: "?raw", import: "default" },
) as Record<string, () => Promise<string>>;

async function listenerCrates(): Promise<Map<string, string>> {
  const byPath = new Map(Object.entries(NATIVE_SOURCES).map(([key, load]) => [key.replace(/^(\.\.\/)+native\//, ""), load]));
  const wanted = [
    ...[...byPath.keys()].filter((path) => (DEBUG_LISTENER_CRATES as readonly string[]).some((crate) => path === `${crate}/Cargo.toml` || new RegExp(`^${crate}/src/[^/]+\\.rs$`).test(path))).sort(),
    ...DEBUG_MULTICAST_PLUGIN.files.map((file) => `${DEBUG_MULTICAST_PLUGIN.crate}/${file}`),
  ];
  const crates = new Map<string, string>();
  for (const path of wanted) {
    const load = byPath.get(path);
    if (!load) throw new ExportError(`The debug link's native source ${path} isn't bundled with this editor.`);
    crates.set(path, await load());
  }
  return crates;
}

/** README.txt of the desktop package in `out`; `built` once its installers are in src-tauri/target/release/bundle/. */
export async function writeDesktopReadme(fs: FileSystem, out: string, name: string, built: boolean): Promise<void> {
  const folder = fileSystemFolder(fs, out);
  // The README's icon step names the icon source the package holds.
  const icon = (await folder.exists("src-tauri/app-icon.png")) ? "app-icon.png" : "app-icon.svg";
  await folder.writeText("README.txt", desktopReadme(name, built ? "src-tauri/target/release/bundle/" : null, icon));
}

async function writeBuild(project: EditorProject, fs: FileSystem, out: string, target: "web" | "desktop", progress: ((done: number, total: number) => void) | undefined, options: BuildOptions): Promise<WebBuildPlan> {
  if (project.root && isOutputInsideProject(project.root, out)) throw new ExportError("That folder is inside the project, where the next export would copy it in. Choose a folder outside it (or its dist/ folder).");
  const name = project.root?.split(/[\\/]/).filter(Boolean).pop() ?? project.name;
  // ADR 0403 "Rendezvous" 2: a debug build's serve.mjs hosts the rendezvous from a bundle served beside the editor (rendezvous/rendezvous.mjs); without it the build says so.
  const debugOn = options.debugLink !== undefined || options.debugListen === true || options.debugLan === true || options.debugPort !== undefined || options.debugRendezvous !== undefined;
  const rendezvousBundle = debugOn && options.rendezvousBundle === undefined ? await fetchText(new URL("rendezvous/rendezvous.mjs", document.baseURI).href) : undefined;
  const plan = await planWebBuild({ name, settings: project.settings, files: project.files, scripts: project.scripts, json: jsonFiles(project), packages: packageSourceFor(project, "production") }, { ...options, ...(rendezvousBundle !== undefined && { rendezvousBundle }) });
  const encoder = createBrowserAudioEncoder();
  return writeWebBuild(plan, {
    project: projectFiles(project),
    player: playerFiles,
    playerWhere: "player/ beside the editor",
    folder: fileSystemFolder(fs, out),
    // A desktop package's web build sits in web/; its Rust build cache survives (rebuilding Tauri from scratch takes minutes).
    ...(target === "desktop" && { web: "web", keep: ["src-tauri/target"], kind: "desktop" }),
    // Models bake through the project's assets the editor already serves (ADR 0090).
    platform: target,
    transcode: browserTranscoder,
    bake: bakeModelFile,
    // ADR 0351: audio converted in Web Workers (at most two at once, ADR 0359 §3), cached in the project's .myco/cache/audio/ when it is a folder.
    audio: { encoder, decode: createAudioDecoder(() => fetchBytes(DECODER_WASM_URL.href)), cache: projectCache(project) },
    // ADR 0359 §6: every game ships the third-party notices.
    notices: NOTICES,
    log: (line) => console.warn(`[myco] ${line}`),
    progress,
  }).finally(() => encoder.close());
}

/** The audio cache in the project folder (paths relative to it); none for a project without a folder. */
function projectCache(project: EditorProject): AudioCacheStore {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) return NO_AUDIO_CACHE;
  return {
    read: (path) => fs.readBinary(joinPath(root, path)).catch(() => null),
    write: async (path, bytes) => {
      const dir = path.split("/").slice(0, -1);
      for (let i = 1; i <= dir.length; i++) {
        const at = joinPath(root, dir.slice(0, i).join("/"));
        if (!(await fs.exists(at))) await fs.mkdir(at);
      }
      await fs.writeBinary(joinPath(root, path), bytes);
    },
  };
}
