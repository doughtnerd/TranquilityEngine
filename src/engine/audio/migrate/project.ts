/**
 * The project migration driver (ADR 0343 §"Migration"): over a project folder, every `*.audioevent.json` becomes a
 * `*.playlist.json` beside it (`migrateProjectAudioEvents`, with each sample's length read from its audio file's
 * headers), every JSON file that names a migrated event is rewritten to name its playlist (scenes' and prefabs'
 * `AudioSource.clip`, playlists, sample sidecars, project.json: any reference string, `rewriteJsonReferences`), and the
 * old files move to `.myco/migrated/` under their project paths. A looping clip's loop goes into its audio file's sidecar
 * (`sample.loops`, ADR 0342) or, when that sidecar already has a different loop, a derived sample beside it
 * (`sampleLoops.ts`); a WAV's own `smpl` loops are read for clips that looped the file's loop points. `npm run audio:migrate` runs it over the disk; the
 * editor and the Studio run it over their own file system when they open a project with old files, after asking
 * (`src/editor/audioEventMigration.ts`).
 *
 * The order keeps a stopped run recoverable: new playlists first, then references, then the old files move. Scripts
 * that quote a migrated path are reported, not rewritten. Folders whose names start with a dot (`.myco`, `.git`),
 * `node_modules`, `dist` and `target` are not searched.
 *
 * Internal: tooling, not the engine's public API.
 */
import { eventClips, isAudioEventPath, parseAudioEvent } from "./legacy/eventFormat";
import { audioFileSeconds, TIMED_AUDIO_EXTENSIONS } from "./audioDuration";
import { migrateProjectAudioEvents } from "./index";
import { rewriteJsonReferences } from "./jsonReferences";
import { readWavMetadata } from "../sample/wavChunks";
import { sampleEditsFromWav } from "../sample/wavSample";
import type { SampleLoop } from "../sample/types";
import { normalizeAssetPath } from "../../scene/assetPath";

/** The file access the driver needs; the editor's `FileSystem` (`engine/platform/FileSystem.ts`) has it all. */
export interface MigrationFileSystem {
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  /** Writes the file, creating missing folders or failing as the file system does; the driver `mkdir`s first. */
  writeText(path: string, text: string): Promise<void>;
  list(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  exists(path: string): Promise<boolean>;
  /** Create the folder and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Move a file; fails if `to` exists. */
  rename(from: string, to: string): Promise<void>;
}

export interface AudioMigrationOptions {
  /** Work everything out and report it, but change no file. */
  dryRun?: boolean;
}

export interface AudioMigrationReport {
  /** New files (project paths): the playlists, and the sidecars and derived samples (`*.sample.json`) made for loops. */
  written: string[];
  /** Existing files whose references to migrated events were rewritten, and sidecars whose `sample` block now holds a loop. */
  rewritten: string[];
  /** Old event files and where they went (under `.myco/migrated/`). */
  moved: { from: string; to: string }[];
  /** Lint lines, each starting with a path: the migration's approximations, files it skipped, scripts to fix by hand. */
  notes: string[];
}

/** Where the migration keeps the old files (the same folder as `audio.json`'s migration, ADR 0344). */
export const MIGRATED_FOLDER = ".myco/migrated";

const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "target"]);
const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

const join = (root: string, path: string): string => (root === "" ? path : `${root.replace(/[\\/]+$/, "")}/${path}`);
const endsWithAny = (path: string, endings: readonly string[]): boolean => endings.some((e) => path.toLowerCase().endsWith(e));
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Every file under `root` (project paths, forward slashes), skipping dot folders, `node_modules`, `dist` and `target`. */
export async function listProjectFiles(fs: MigrationFileSystem, root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.list(dir === "" ? root : join(root, dir))) {
    const path = dir === "" ? e.name : `${dir}/${e.name}`;
    if (!e.isDirectory) out.push(path);
    else if (!e.name.startsWith(".") && !SKIPPED_FOLDERS.has(e.name)) out.push(...(await listProjectFiles(fs, root, path)));
  }
  return out.sort();
}

/** The project's audio event files (what a host checks before offering the migration). */
export async function findAudioEvents(fs: MigrationFileSystem, root: string): Promise<string[]> {
  return (await listProjectFiles(fs, root)).filter(isAudioEventPath);
}

/** A free path under `.myco/migrated/` for `path`: its own project path, else with `.2`, `.3`… before the ending. */
async function migratedPathFor(fs: MigrationFileSystem, root: string, path: string, taken: Set<string>): Promise<string> {
  const base = `${MIGRATED_FOLDER}/${path}`;
  const dot = base.toLowerCase().lastIndexOf(".audioevent.json");
  const free = async (p: string) => !taken.has(p) && !(await fs.exists(join(root, p)));
  let candidate = base;
  for (let n = 2; !(await free(candidate)); n++) candidate = `${base.slice(0, dot)}.${n}${base.slice(dot)}`;
  taken.add(candidate);
  return candidate;
}

/** Migrate the project at `root` (see the module comment). Never throws for a bad file; file system errors propagate. */
export async function migrateProjectAudio(fs: MigrationFileSystem, root: string, options: AudioMigrationOptions = {}): Promise<AudioMigrationReport> {
  const report: AudioMigrationReport = { written: [], rewritten: [], moved: [], notes: [] };
  const files = await listProjectFiles(fs, root);
  const events = files.filter(isAudioEventPath);
  if (events.length === 0) return report;

  const json = new Map<string, string>();
  for (const path of files.filter((p) => p.toLowerCase().endsWith(".json"))) json.set(path, await fs.readText(join(root, path)));

  // The lengths of the samples the events name, from their files' headers.
  const fileSet = new Set(files);
  const seconds = new Map<string, number | undefined>();
  const wavLoops = new Map<string, SampleLoop[]>();
  for (const path of events) {
    let raw: unknown;
    try {
      raw = JSON.parse(json.get(path)!);
    } catch {
      continue; // migrateProjectAudioEvents notes it
    }
    for (const clip of eventClips(parseAudioEvent(raw).value).map(normalizeAssetPath)) {
      if (seconds.has(clip)) continue;
      if (!fileSet.has(clip)) {
        seconds.set(clip, undefined);
        report.notes.push(`${path}: "${clip}" isn't in the project; its length is unknown.`);
      } else if (!endsWithAny(clip, TIMED_AUDIO_EXTENSIONS)) {
        seconds.set(clip, undefined);
        report.notes.push(`${clip}: the migration can't read this format's length.`);
      } else {
        const bytes = await fs.readBinary(join(root, clip));
        const s = audioFileSeconds(bytes);
        seconds.set(clip, s);
        if (s === undefined) report.notes.push(`${clip}: its headers give no length.`);
        // The old runtime looped a WAV's own `smpl` loop for a clip with no loop region; the migration keeps it.
        if (clip.toLowerCase().endsWith(".wav")) {
          const loops = sampleEditsFromWav(readWavMetadata(bytes)).loops;
          if (loops.length > 0) wavLoops.set(clip, loops);
        }
      }
    }
  }

  const migration = migrateProjectAudioEvents(json, {
    sampleSeconds: (p) => seconds.get(normalizeAssetPath(p)),
    fileLoops: (p) => wavLoops.get(p),
  });
  report.notes.push(...migration.notes);
  const moves = new Map(migration.references.map((r) => [r.from, r.to]));
  const write = async (path: string, text: string) => {
    if (options.dryRun) return;
    if (folderOf(path) !== "") await fs.mkdir(join(root, folderOf(path)));
    await fs.writeText(join(root, path), text);
  };

  // New files (playlists, new sidecars, derived samples) are reported as written, changed sidecars as rewritten; the
  // notes say which loop each sample file holds and for which events.
  const changedSidecars = new Set(migration.samples.changedSidecars);
  for (const [path, text] of migration.writes) {
    await write(path, rewriteJsonReferences(text, moves) ?? text);
    (changedSidecars.has(path) ? report.rewritten : report.written).push(path);
  }

  const gone = new Set(migration.deletes);
  for (const [path, text] of json) {
    if (gone.has(path) || migration.writes.has(path)) continue;
    const next = rewriteJsonReferences(text, moves);
    if (next === null) continue;
    await write(path, next);
    report.rewritten.push(path);
  }

  for (const path of files.filter((p) => endsWithAny(p, SCRIPT_EXTENSIONS))) {
    const text = await fs.readText(join(root, path));
    for (const [from, to] of moves) if (text.includes(from)) report.notes.push(`${path}: names ${from}; change it to ${to} by hand.`);
  }

  const taken = new Set<string>();
  for (const from of migration.deletes) {
    const to = await migratedPathFor(fs, root, from, taken);
    if (!options.dryRun) {
      await fs.mkdir(join(root, folderOf(to)));
      await fs.rename(join(root, from), join(root, to));
    }
    report.moved.push({ from, to });
  }
  return report;
}
