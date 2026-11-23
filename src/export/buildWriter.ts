// The build writer (ADR 0296): writes a planned web build (webBuild.ts) into a build folder, for
// the Node exporter (node.ts) and the editor's Build / Export (src/editor/exportBuild.ts) alike.
// It owns the order: check the player and the folder before anything is touched, bake models
// (ADR 0090), compile animation clips (ADR 0371), render baked samples (ADR 0342, sampleRenders.ts), process images (ADR 0119) and
// convert and package audio (ADR 0351, audio.ts) through the project's files, clear an earlier
// build, then write each file once (a processed image or a converted sound in place of its
// original; a packaged sound not at all) with progress, the game's third-party notices (ADR 0359
// §6) and, beside the web build, the audio report.
//
// Files come in through `FileSource`s (the project, the player) and go out through a
// `BuildFolder`: Node's fs (node.ts) and the platform FileSystem (`fileSystemFolder` here) are the
// two adapters.
import type { DirEntry, FileSystem } from "../engine/platform/FileSystem";
import type { ImportPlatform } from "../engine/scene/importSettings";
import { joinPath } from "../editor/projectPaths";
import { ENGINE_FILE, MANIFEST_FILE, PLAYER_FILE_LIST, PLAYER_PAGE } from "./format";
import { AUDIO_REPORT_FILE, processAudio, type AudioCacheStore, type DecodeAudio } from "./audio";
import type { AudioEncoder } from "./audioEncoder";
import { withAudioEffects } from "./audioEffects";
import { processImages, type ImageTranscoder } from "./images";
import { withRenderedSamples } from "./sampleRenders";
import { ExportError, copiedPath, withBakedModels, type BakeModel, type WebBuildPlan } from "./webBuild";
import { withCompiledClips } from "./animationClips";
import { withMeteredAnimationNodes } from "./animationNodes";
import { loadAnimationCompiler } from "../plugins/animation/editor/compile/compiler";

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
  /**
   * ADR 0351: audio conversion and packages for `platform`. Absent: the build ships its audio as it is (no conversion,
   * no packages, no media table). `encoder: null` is `--no-audio-convert`: packages are built from the sources.
   */
  readonly audio?: { readonly encoder: AudioEncoder | null; readonly decode: DecodeAudio; readonly cache?: AudioCacheStore };
  /**
   * ADR 0359 §6: the third-party notices every game ships (the repository's `THIRD_PARTY_NOTICES.md`), written as
   * `THIRD_PARTY_NOTICES.md` at the web build's root. Absent: none written.
   */
  readonly notices?: string;
  readonly log?: (line: string) => void;
  /** Hears how many files are written out of how many. */
  readonly progress?: (done: number, total: number) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (v: string | Uint8Array) => (typeof v === "string" ? encoder.encode(v) : v);
const textOf = (v: string | Uint8Array) => (typeof v === "string" ? v : decoder.decode(v));
/** The third-party notices' file name in a build (ADR 0359 §6). */
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";
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
  const listed = await playerFiles(options.player, options.playerWhere);
  // ADR 0376: a release export (no `debug`) leaves out the player's debug link files, so it holds none of the link's code.
  const player = plan.manifest.debug ? listed.files : listed.files.filter((f) => !listed.debug.has(f));
  for (const w of plan.warnings ?? []) log(`warning: ${w}`);
  const entries = (await folder.exists("")) ? await folder.list("") : [];
  if (entries.length > 0 && !(await folder.exists(join(web, MANIFEST_FILE)))) {
    throw new ExportError(`"${folder.where}" isn't empty and doesn't hold an earlier ${options.kind ? `${options.kind} ` : ""}build. Choose an empty folder.`);
  }

  plan = await withBakedModels(plan, options.bake, log);
  // ADR 0371 (T19): every referenced clip compiled to *.anim.bin, and model skeletons to *.skel.bin, for the platform.
  plan = await withCompiledClips(plan, { platform: options.platform, read: (path) => project.read(path), compiler: loadAnimationCompiler, log });
  // ADR 0370 (T45t): the plugins' animation node modules metered, since games can't meter.
  plan = await withMeteredAnimationNodes(plan, { read: (path) => project.read(path), compiler: loadAnimationCompiler, log });
  // ADR 0352 §8: the plugins' audio modules hashed into game.json; their offline host renders baked plugin effects.
  const effects = await withAudioEffects(plan, (path) => project.read(path), log);
  plan = effects.plan;
  plan = await withRenderedSamples(plan, (path) => project.read(path), log, effects.renders);
  plan = await processImages(plan, {
    platform: options.platform,
    readText: (path) => project.read(path).then(textOf, () => undefined),
    readBytes: async (path) => bytesOf(await project.read(path)),
    transcode: options.transcode,
    log,
  });
  if (options.audio) {
    const audio = await processAudio(plan, { platform: options.platform, read: (path) => project.read(path), encoder: options.audio.encoder, decode: options.audio.decode, cache: options.audio.cache, languages: plan.languages, log });
    plan = audio.report ? { ...audio.plan, audioReport: audio.report } : audio.plan;
  }
  if (options.notices !== undefined) plan = { ...plan, generated: new Map([...plan.generated, [NOTICES_FILE, options.notices]]) };
  const generated = plan.generated;

  await clear(folder, "", entries, options.keep ?? []);
  const binaries = plan.binaries ?? new Map<string, Uint8Array>();
  const omit = plan.omit ?? new Set<string>();
  // A processed image (or its sidecar) or a converted sound is written instead of its copy, never over it; a packaged sound not at all.
  const copies = plan.copies.filter((path) => !omit.has(path) && !binaries.has(copiedPath(path)) && !generated.has(copiedPath(path)));
  const report = plan.audioReport ? `${JSON.stringify(plan.audioReport, null, 2)}\n` : null;
  const total = player.length + copies.length + generated.size + binaries.size + (report ? 1 : 0);
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
  for (const [path, text] of generated) await write(path, text);
  for (const [path, bytes] of binaries) await write(path, bytes);
  // Beside the web build (a desktop package's root), or at a web build's root, where nothing loads it.
  if (report) {
    await folder.writeText(AUDIO_REPORT_FILE, report);
    step();
  }
  return plan;
}

/** The player's files and its debug link files, from its `files.json`. Throws an `ExportError` if it isn't a built player. */
async function playerFiles(player: FileSource, where: string): Promise<{ files: string[]; debug: ReadonlySet<string> }> {
  let list: { files?: unknown; debug?: unknown };
  try {
    list = JSON.parse(textOf(await player.read(PLAYER_FILE_LIST))) as { files?: unknown; debug?: unknown };
  } catch {
    throw new ExportError(`There's no game player in ${where} to export with (no ${PLAYER_FILE_LIST}). Run \`npm run build:player\`.`);
  }
  const files = list.files;
  if (!Array.isArray(files) || !files.includes(PLAYER_PAGE) || !files.includes(ENGINE_FILE)) {
    throw new ExportError(`The game player in ${where} is incomplete (no ${PLAYER_PAGE} or ${ENGINE_FILE}). Run \`npm run build:player\` again.`);
  }
  const debug = Array.isArray(list.debug) ? list.debug.filter((f): f is string => typeof f === "string") : [];
  return { files: files as string[], debug: new Set(debug) };
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
