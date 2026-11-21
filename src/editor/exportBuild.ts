// Build / Export in the editor (ADR 0041): write a web build of the open project into a folder,
// through the platform FileSystem. The plan is the Node exporter's (src/export/webBuild.ts) and so
// is the build writer (src/export/buildWriter.ts, ADR 0296); here are the editor's file sources:
// the player's files fetched from the copy served beside the editor at player/ (dist/player/, like
// the samples, ADR 0031), and the project's files from what the editor already holds.
import type { FileSystem } from "../engine/platform/FileSystem";
import { fileSystemFolder, writeWebBuild, type FileSource } from "../export/buildWriter";
import { browserTranscoder } from "../export/imagesBrowser";
import { bakeModelFile } from "../engine/scene/models";
import { packageSourceFor } from "./projectPackages";
import { ExportError, isOutputInsideProject, planWebBuild, type BuildOptions, type WebBuildPlan } from "../export/webBuild";
import { jsonFiles, type EditorProject } from "./projects";

/** The command-line export, for what the editor can't do (desktop packages need Rust and a shell). */
export const desktopExportCommand = (project: EditorProject, audioCapture = false) => `npm run export -- "${project.root ?? "<projectDir>"}" --target desktop${audioCapture ? " --audio-capture" : ""}`;

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
export async function exportProjectBuild(project: EditorProject, fs: FileSystem, out: string, progress?: (done: number, total: number) => void, options: BuildOptions = {}): Promise<WebBuildPlan> {
  if (project.root && isOutputInsideProject(project.root, out)) throw new ExportError("That folder is inside the project, where the next export would copy it in. Choose a folder outside it (or its dist/ folder).");
  const name = project.root?.split(/[\\/]/).filter(Boolean).pop() ?? project.name;
  const plan = await planWebBuild({ name, settings: project.settings, files: project.files, scripts: project.scripts, json: jsonFiles(project), packages: packageSourceFor(project, "production") }, options);
  return writeWebBuild(plan, {
    project: projectFiles(project),
    player: playerFiles,
    playerWhere: "player/ beside the editor",
    folder: fileSystemFolder(fs, out),
    // The editor builds web games; models bake through the project's assets the editor already serves (ADR 0090).
    platform: "web",
    transcode: browserTranscoder,
    bake: bakeModelFile,
    log: (line) => console.warn(`[myco] ${line}`),
    progress,
  });
}
