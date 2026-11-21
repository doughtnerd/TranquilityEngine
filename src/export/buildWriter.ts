// The build writer (ADR 0296): writes a planned web build (webBuild.ts) into a build folder, for
// the Node exporter (node.ts) and the editor's Build / Export (src/editor/exportBuild.ts) alike.
// It owns the order: check the player and the folder before anything is touched, bake models
// (ADR 0090) and process images (ADR 0119) through the project's files, clear an earlier build,
// then write each file once (a processed image in place of its original) with progress.
//
// Files come in through `FileSource`s (the project, the player) and go out through a
// `BuildFolder`: Node's fs (node.ts) and the platform FileSystem (`fileSystemFolder` here) are the
// two adapters.
import type { DirEntry, FileSystem } from "../engine/platform/FileSystem";
import type { ImportPlatform } from "../engine/scene/importSettings";
import { joinPath } from "../editor/projectPaths";
import { ENGINE_FILE, MANIFEST_FILE, PLAYER_FILE_LIST, PLAYER_PAGE } from "./format";
import { processImages, type ImageTranscoder } from "./images";
import { ExportError, copiedPath, withBakedModels, type BakeModel, type WebBuildPlan } from "./webBuild";

/** Read access to a folder of files (a project, a built player), by "/"-separated relative path. */
export interface FileSource {
  /** The file's contents: text where the source holds it as text, else bytes. Rejects when it isn't there. */
  read(path: string): Promise<string | Uint8Array>;
}

/** The folder a build is written into, by "/"-separated path relative to it ("" is the folder itself). */
export interface BuildFolder {
  /** The folder's path, for messages. */
  readonly where: string;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<DirEntry[]>;
  /** Delete a file, or a folder and everything in it. */
  remove(path: string, isDirectory: boolean): Promise<void>;
  /** Write a file, making its folders. */
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
}

export interface WriteBuildOptions {
  /** The project's files: what the plan copies, its models and image sidecars. */
  readonly project: FileSource;
  /** A built player (dist/player/): `files.json` lists its files. */
  readonly player: FileSource;
  /** Where the player is, for messages ("dist/player", "player/ beside the editor"). */
  readonly playerWhere: string;
  readonly folder: BuildFolder;
  /** The web build's folder inside `folder` ("" by default; a desktop package's is "web"). */
  readonly web?: string;
  /** Paths in `folder` an earlier build keeps when it's cleared (a desktop package's Rust cache, `src-tauri/target`). */
  readonly keep?: readonly string[];
  /** What the folder holds, for messages ("web", "desktop"). */
  readonly kind?: string;
  /** The platform images are processed for (ADR 0119). */
  readonly platform: ImportPlatform;
  readonly transcode: ImageTranscoder;
  /** Baking one model (ADR 0090). */
  readonly bake: BakeModel;
  readonly log?: (line: string) => void;
  /** Hears how many files are written out of how many. */
  readonly progress?: (done: number, total: number) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (v: string | Uint8Array) => (typeof v === "string" ? encoder.encode(v) : v);
const textOf = (v: string | Uint8Array) => (typeof v === "string" ? v : decoder.decode(v));
const join = (dir: string, path: string) => (dir ? `${dir}/${path}` : path);

/**
 * Write the web build `plan` into `options.folder`, which must be empty, missing, or hold an
 * earlier build (replaced, but for `keep`). Throws an `ExportError`, before anything in the folder
 * is touched, when the player isn't a built one or the folder holds something else. Resolves with
 * the plan as written: models baked and images processed.
 */
export async function writeWebBuild(plan: WebBuildPlan, options: WriteBuildOptions): Promise<WebBuildPlan> {
  const { folder, project } = options;
  const web = options.web ?? "";
  const log = options.log ?? (() => {});
  const player = await playerFiles(options.player, options.playerWhere);
  const entries = (await folder.exists("")) ? await folder.list("") : [];
  if (entries.length > 0 && !(await folder.exists(join(web, MANIFEST_FILE)))) {
    throw new ExportError(`"${folder.where}" isn't empty and doesn't hold an earlier ${options.kind ? `${options.kind} ` : ""}build. Choose an empty folder.`);
  }

  plan = await withBakedModels(plan, options.bake, log);
  plan = await processImages(plan, {
    platform: options.platform,
    readText: (path) => project.read(path).then(textOf, () => undefined),
    readBytes: async (path) => bytesOf(await project.read(path)),
    transcode: options.transcode,
    log,
  });

  await clear(folder, "", entries, options.keep ?? []);
  const binaries = plan.binaries ?? new Map<string, Uint8Array>();
  // A processed image (or its sidecar) is written instead of its copy, never over it.
  const copies = plan.copies.filter((path) => !binaries.has(copiedPath(path)) && !plan.generated.has(copiedPath(path)));
  const total = player.length + copies.length + plan.generated.size + binaries.size;
  let done = 0;
  const step = () => options.progress?.(++done, total);
  const write = async (to: string, contents: string | Uint8Array) => {
    if (typeof contents === "string") await folder.writeText(join(web, to), contents);
    else await folder.writeBytes(join(web, to), contents);
    step();
  };

  for (const file of player) await write(file === PLAYER_PAGE ? "index.html" : file, bytesOf(await options.player.read(file)));
  for (const path of copies) {
    let contents: string | Uint8Array;
    try {
      contents = await project.read(path);
    } catch (err) {
      throw new ExportError(`Couldn't read ${path} from the project (${(err as Error)?.message ?? err}).`);
    }
    await write(copiedPath(path), contents);
  }
  for (const [path, text] of plan.generated) await write(path, text);
  for (const [path, bytes] of binaries) await write(path, bytes);
  return plan;
}

/** The player's files, from its `files.json`. Throws an `ExportError` if it isn't a built player. */
async function playerFiles(player: FileSource, where: string): Promise<string[]> {
  let files: unknown;
  try {
    files = (JSON.parse(textOf(await player.read(PLAYER_FILE_LIST))) as { files?: unknown }).files;
  } catch {
    throw new ExportError(`There's no game player in ${where} to export with (no ${PLAYER_FILE_LIST}). Run \`npm run build:player\`.`);
  }
  if (!Array.isArray(files) || !files.includes(PLAYER_PAGE) || !files.includes(ENGINE_FILE)) {
    throw new ExportError(`The game player in ${where} is incomplete (no ${PLAYER_PAGE} or ${ENGINE_FILE}). Run \`npm run build:player\` again.`);
  }
  return files as string[];
}

/** Remove everything in `dir` but the paths in `keep`, descending into folders that hold one. */
async function clear(folder: BuildFolder, dir: string, entries: readonly DirEntry[], keep: readonly string[]): Promise<void> {
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (keep.includes(path)) continue;
    if (entry.isDirectory && keep.some((k) => k.startsWith(`${path}/`))) await clear(folder, path, await folder.list(path), keep);
    else await folder.remove(path, entry.isDirectory);
  }
}

/** The build folder `out` through the platform FileSystem (the editor's adapter). */
export function fileSystemFolder(fs: FileSystem, out: string): BuildFolder {
  const at = (path: string) => (path ? joinPath(out, path) : out);
  const made = new Set<string>();
  const ensureDir = async (path: string) => {
    const dir = path.split("/").slice(0, -1).join("/");
    if (made.has(dir)) return;
    await fs.mkdir(at(dir));
    made.add(dir);
  };
  return {
    where: out,
    exists: (path) => fs.exists(at(path)),
    list: (path) => fs.list(at(path)),
    remove: (path, isDirectory) => fs.remove(at(path), { recursive: isDirectory }),
    writeText: async (path, text) => {
      await ensureDir(path);
      await fs.writeText(at(path), text);
    },
    writeBytes: async (path, bytes) => {
      await ensureDir(path);
      await fs.writeBinary(at(path), bytes);
    },
  };
}
