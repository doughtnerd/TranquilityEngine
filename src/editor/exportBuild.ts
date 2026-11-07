// Build / Export in the editor (ADR 0041): write a web build of the open project into a folder,
// through the platform FileSystem. The plan is the Node exporter's (src/export/webBuild.ts); the
// player's files are fetched from the copy served beside the editor at player/ (dist/player/,
// like the samples, ADR 0031), and the project's files come from what the editor already holds.
import type { FileSystem } from "../engine/platform/FileSystem";
import { ENGINE_FILE, MANIFEST_FILE, PLAYER_FILE_LIST, PLAYER_PAGE } from "../export/format";
import { processImages } from "../export/images";
import { browserTranscoder } from "../export/imagesBrowser";
import { bakeModelFile } from "../engine/scene/models";
import { ExportError, copiedPath, isOutputInsideProject, planWebBuild, withBakedModels, type WebBuildPlan } from "../export/webBuild";
import { joinPath, jsonFiles, type EditorProject } from "./projects";

/** The command-line export, for what the editor can't do (desktop packages need Rust and a shell). */
export const desktopExportCommand = (project: EditorProject) => `npm run export -- "${project.root ?? "<projectDir>"}" --target desktop`;

/** Plan a web build of the open project (compiles its scripts). Throws an `ExportError` if it can't be built. */
export async function planProjectBuild(project: EditorProject, bake = true): Promise<WebBuildPlan> {
  const files = [...new Set([...project.files, ...project.scripts.keys()])];
  const plan = await planWebBuild({ name: project.root?.split(/[\\/]/).filter(Boolean).pop() ?? project.name, settings: project.settings, files, scripts: project.scripts, json: jsonFiles(project) });
  // Models baked for the build (ADR 0090), through the project's assets the editor already serves.
  if (!bake) return plan;
  const log = (line: string) => console.warn(`[myco] ${line}`);
  const baked = await withBakedModels(plan, bakeModelFile, log);
  // Images resized and re-encoded per their sidecars (ADR 0119); the editor builds web games.
  return processImages(baked, {
    platform: "web",
    readText: (path) => project.textOf(path),
    readBytes: async (path) => {
      const url = project.assets.get(path);
      if (typeof url !== "string") throw new Error("not in the project");
      return new Uint8Array(await (await fetchOk(url)).arrayBuffer());
    },
    transcode: browserTranscoder,
    log,
  });
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't read ${url}: HTTP ${res.status}`);
  return res;
}

/** The player's files, from the copy beside the editor. Throws an `ExportError` if it isn't there. */
async function playerFiles(): Promise<string[]> {
  const res = await fetch(new URL(`player/${PLAYER_FILE_LIST}`, document.baseURI).href).catch(() => null);
  if (!res?.ok) throw new ExportError("This editor has no game player to export with (player/ beside the editor). Run `npm run build:player`, or export from the command line: npm run export -- <projectDir>.");
  const { files } = (await res.json()) as { files: string[] };
  if (!files.includes(PLAYER_PAGE) || !files.includes(ENGINE_FILE)) throw new ExportError("The game player beside the editor is incomplete. Run `npm run build:player` again.");
  return files;
}

/**
 * Write a web build of `project` into the folder `out`, which must be empty or hold an earlier
 * build (replaced). `progress` hears how many files are written out of how many.
 */
export async function exportProjectBuild(project: EditorProject, fs: FileSystem, out: string, progress?: (done: number, total: number) => void): Promise<WebBuildPlan> {
  if (project.root && isOutputInsideProject(project.root, out)) throw new ExportError("That folder is inside the project, where the next export would copy it in. Choose a folder outside it (or its dist/ folder).");
  const plan = await planProjectBuild(project);
  const player = await playerFiles();

  if (await fs.exists(out)) {
    const entries = await fs.list(out);
    if (entries.length > 0) {
      if (!(await fs.exists(joinPath(out, MANIFEST_FILE)))) throw new ExportError(`"${out}" isn't empty and doesn't hold an earlier build. Choose an empty folder.`);
      for (const entry of entries) await fs.remove(joinPath(out, entry.name), { recursive: entry.isDirectory });
    }
  }
  const total = player.length + plan.copies.length + plan.generated.size + (plan.binaries?.size ?? 0);
  let done = 0;
  const made = new Set<string>();
  const ensureDir = async (path: string) => {
    const dir = path.split("/").slice(0, -1).join("/");
    if (made.has(dir)) return;
    await fs.mkdir(dir ? joinPath(out, dir) : out);
    made.add(dir);
  };
  const step = () => progress?.(++done, total);

  for (const file of player) {
    const bytes = new Uint8Array(await (await fetchOk(new URL(`player/${file}`, document.baseURI).href)).arrayBuffer());
    const to = file === PLAYER_PAGE ? "index.html" : file;
    await ensureDir(to);
    await fs.writeBinary(joinPath(out, to), bytes);
    step();
  }
  for (const path of plan.copies) {
    const to = copiedPath(path);
    await ensureDir(to);
    const text = project.textOf(path);
    if (text !== undefined) await fs.writeText(joinPath(out, to), text);
    else {
      const url = project.assets.get(path);
      if (typeof url !== "string") throw new ExportError(`Couldn't read ${path} from the project.`);
      await fs.writeBinary(joinPath(out, to), new Uint8Array(await (await fetchOk(url)).arrayBuffer()));
    }
    step();
  }
  for (const [path, text] of plan.generated) {
    await ensureDir(path);
    await fs.writeText(joinPath(out, path), text);
    step();
  }
  for (const [path, bytes] of plan.binaries ?? []) {
    await ensureDir(path);
    await fs.writeBinary(joinPath(out, path), bytes);
    step();
  }
  return plan;
}
