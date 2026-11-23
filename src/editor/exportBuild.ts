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
import { DEFAULT_ICON_SVG, desktopProjectFiles, desktopReadme, type BuildSettings } from "../export/desktop";
// ADR 0335: exported games' gamepad module is the editor shell's, copied verbatim (as the command line's exporter does).
import GAMEPAD_MODULE from "../../src-tauri/src/gamepad.rs?raw";

/** The command-line export of a desktop package, for the browser editor, which can't run the host's toolchain (ADR 0381). */
export const desktopExportCommand = (project: EditorProject, audioCapture = false, audioTake = false, takePictures = true, debugLink = false) =>
  `npm run export -- "${project.root ?? "<projectDir>"}" --target desktop${audioCapture ? " --audio-capture" : ""}${audioTake ? " --audio-take" : ""}${audioTake && !takePictures ? " --no-take-pictures" : ""}${debugLink ? ` --debug-link ${DEFAULT_DEBUG_LINK_PORT}` : ""}`;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't read ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
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
 * ADR 0381: write a desktop package of `project` into `out` (ADR 0041's layout): the web build in
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
  for (const [path, text] of desktopProjectFiles({ name: plan.manifest.name, settings, gamepadModule: GAMEPAD_MODULE, debug: plan.manifest.debug !== undefined })) {
    await folder.writeText(`src-tauri/${path}`, text);
  }
  const iconFile = `src-tauri/app-icon.${icon?.toLowerCase().endsWith(".png") ? "png" : "svg"}`;
  for (const stale of ["src-tauri/app-icon.png", "src-tauri/app-icon.svg"]) if (stale !== iconFile && (await folder.exists(stale))) await folder.remove(stale, false);
  await (typeof iconSource === "string" ? folder.writeText(iconFile, iconSource) : folder.writeBytes(iconFile, iconSource));
  await writeDesktopReadme(fs, out, plan.manifest.name, false);
  return plan;
}

/** README.txt of the desktop package in `out`; `built` once its installers are in src-tauri/target/release/bundle/. */
export function writeDesktopReadme(fs: FileSystem, out: string, name: string, built: boolean): Promise<void> {
  return fileSystemFolder(fs, out).writeText("README.txt", desktopReadme(name, built ? "src-tauri/target/release/bundle/" : null));
}

async function writeBuild(project: EditorProject, fs: FileSystem, out: string, target: "web" | "desktop", progress: ((done: number, total: number) => void) | undefined, options: BuildOptions): Promise<WebBuildPlan> {
  if (project.root && isOutputInsideProject(project.root, out)) throw new ExportError("That folder is inside the project, where the next export would copy it in. Choose a folder outside it (or its dist/ folder).");
  const name = project.root?.split(/[\\/]/).filter(Boolean).pop() ?? project.name;
  const plan = await planWebBuild({ name, settings: project.settings, files: project.files, scripts: project.scripts, json: jsonFiles(project), packages: packageSourceFor(project, "production") }, options);
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
