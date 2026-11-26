// A connected build's audio, for replays without the project (ADR 0410). On connect (when the Connect dialog's option is
// on, the default) the Studio asks the build for its audio index (`build.audio`) and each file (`build.file`), and keeps
// them as a *build audio set* in the takes folder: `.build-audio/<project>-<audioHash>/project/<path>`, `build/<path>`
// and `set.json` (the index, written last: a set without it is incomplete). A take opened in a takes folder mounts the
// set its META matches (project name and `audioHash`) the way the player loads a build: the JSON files and sounds as an
// asset source, the build's media table over the set's build files, and the Studio's audio runtime opened on the set's
// `project.json` and `audio.json`. Closing the take, or opening another, releases it.
import { effect, signal } from "@preact/signals";
import type { ConnectedBuild } from "../../editor/debugLink/editorLink";
import { settingsWithAudio } from "../../editor/audioProjectFile";
import { persisted } from "../../editor/preferences";
import { editorSettings, isTakesFolder, joinPath, readOnlyProject, type EditorProject } from "../../editor/projects";
import { mountedAudioProject } from "../shell/audioProject";
import { currentProject, status } from "../../editor/state";
import type { AssetSource } from "../../engine/scene/Assets";
import { acquireProjectContext, type ProjectContext } from "../../engine/core/projectContext";
import { getFileSystem, isTauri, type FileSystem } from "../../engine/platform/FileSystem";
import { extensionOf } from "../../engine/scene/projectFiles";
import type { AudioManifest } from "../../export/format";
import { audioLinkClient } from "../../plugins/audio/editor/debugLink/audioLinkClient";
import { installAudioMedia } from "../../plugins/audio/runtime/media/mediaTable";
import type { BuildAudioFile, BuildAudioIndex } from "../../plugins/audio/runtime/debugLink/schema";
import { studioBuild } from "../debugLink/studioLink";
import { audioRuntime } from "../shell/studioServices";
import { defaultTakesFolder, takesFolderChoice } from "../takesFolder";

/** The Connect dialog's "Download the build's audio for replays" (on by default). */
export const downloadBuildAudio = persisted<boolean>("myco.studio.downloadBuildAudio", true);

/** The folder build audio sets live in, inside a takes folder. */
export const BUILD_AUDIO_FOLDER = ".build-audio";

/** The set a take or a build's audio belongs to: `<project>-<audioHash>`, the project's name made safe. */
export function buildAudioSetName(project: string, audioHash: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `${slug}-${audioHash.replace(/[^0-9a-f]/gi, "")}`;
}

/** Where a set's file is kept, relative to the set's folder. */
const fileIn = (f: Pick<BuildAudioFile, "kind" | "path">): string => `${f.kind}/${f.path}`;

/** A takes folder to keep sets in: its file system and root. */
export interface SetsPlace {
  readonly fs: FileSystem;
  readonly root: string;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function readJson<T>(fs: FileSystem, path: string): Promise<T | null> {
  try {
    if (!(await fs.exists(path))) return null;
    return JSON.parse(await fs.readText(path)) as T;
  } catch {
    return null;
  }
}

/** Writes a set's file: a JSON file as text (read back as text when the set mounts), anything else as bytes. */
async function writeFile(fs: FileSystem, path: string, bytes: Uint8Array): Promise<void> {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash > 0) await fs.mkdir(path.slice(0, slash));
  if (extensionOf(path) === "json") await fs.writeText(path, new TextDecoder().decode(bytes));
  else await fs.writeBinary(path, bytes);
}

/** Progress of a download, for the status line. */
export interface DownloadProgress {
  readonly done: number;
  readonly total: number;
}

/**
 * Download `build`'s audio into a set under `place`: the index, then each file it lists that the set lacks (or a JSON
 * file whose hash changed), then `set.json`. Resolves with the set's folder. `onProgress` follows the files.
 */
export async function downloadBuildAudioSet(build: Pick<ConnectedBuild, "peer">, place: SetsPlace, onProgress?: (p: DownloadProgress) => void): Promise<string> {
  return (await fetchBuildAudio(build, place, onProgress)).dir;
}

/** `downloadBuildAudioSet`, with the index it downloaded (the set's project and `audioHash`). */
export async function fetchBuildAudio(build: Pick<ConnectedBuild, "peer">, place: SetsPlace, onProgress?: (p: DownloadProgress) => void): Promise<{ dir: string; index: BuildAudioIndex }> {
  const client = audioLinkClient(build.peer);
  const index = await client.buildAudio();
  const dir = joinPath(joinPath(place.root, BUILD_AUDIO_FOLDER), buildAudioSetName(index.project, index.audioHash));
  const before = await readJson<BuildAudioIndex>(place.fs, joinPath(dir, "set.json"));
  const hashes = new Map((before?.files ?? []).map((f) => [fileIn(f), f.hash]));
  let done = 0;
  for (const f of index.files) {
    const at = joinPath(dir, fileIn(f));
    const fresh = (await place.fs.exists(at).catch(() => false)) && (f.hash === null || hashes.get(fileIn(f)) === f.hash);
    if (!fresh) {
      await writeFile(place.fs, at, await client.buildFile(f));
    }
    onProgress?.({ done: ++done, total: index.files.length });
  }
  await place.fs.writeText(joinPath(dir, "set.json"), JSON.stringify(index));
  return { dir, index };
}

/** Where sets go now: the open takes folder; else, with no project open, the desktop app's takes folder; null otherwise. */
async function setsPlace(): Promise<SetsPlace | null> {
  const project = currentProject.peek();
  if (isTakesFolder(project) && project?.fileSystem && project.root) return { fs: project.fileSystem, root: project.root };
  // A project is open: its takes replay against its own audio, so nothing needs downloading.
  if (project) return null;
  if (!isTauri()) return null;
  const root = takesFolderChoice.peek() ?? (await defaultTakesFolder());
  return root ? { fs: await getFileSystem(), root } : null;
}

/** The download running now (one at a time), for the status line and tests. */
export const buildAudioDownload = signal<{ readonly build: string; readonly progress: DownloadProgress | null } | null>(null);

/** Downloads each newly connected build's audio while the option is on. Returns the stop. */
export function installBuildAudioDownloads(): () => void {
  let last = studioBuild.peek()?.peer ?? null;
  return effect(() => {
    const build = studioBuild.value;
    const peer = build?.peer ?? null;
    if (peer === last) return;
    last = peer;
    if (!build || !downloadBuildAudio.peek()) return;
    void (async () => {
      // Connecting opens the live session's takes folder a moment later (in a browser, the only place a set can go):
      // wait for it, up to a few seconds.
      let place = await setsPlace();
      for (let i = 0; !place && i < 30 && studioBuild.peek()?.peer === peer; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        place = await setsPlace();
      }
      if (!place) return;
      buildAudioDownload.value = { build: build.name, progress: null };
      status.value = { kind: "info", text: `Downloading ${build.name}'s audio for replays…` };
      try {
        const { dir, index } = await fetchBuildAudio(build, place, (progress) => {
          buildAudioDownload.value = { build: build.name, progress };
          status.value = { kind: "info", text: `Downloading ${build.name}'s audio for replays · ${progress.done} of ${progress.total} files` };
        });
        status.value = { kind: "info", text: `${build.name}'s audio is ready for replays (${dir})` };
        // The live session's takes folder shows the connected build's audio on Playlists and the Mixer, read-only.
        if (isTakesFolder(currentProject.peek()) && studioBuild.peek()?.peer === peer) await mountBuildAudioFor(index);
      } catch (err) {
        status.value = { kind: "error", text: `Couldn't download ${build.name}'s audio: ${messageOf(err)}` };
      } finally {
        buildAudioDownload.value = null;
      }
    })();
  });
}

// --- mounting a set for a take --------------------------------------------------------------------------------------

interface Mounted {
  readonly set: string;
  readonly project: EditorProject;
  readonly context: ProjectContext;
  readonly urls: readonly string[];
}

let mounted: Mounted | null = null;
let mountRun = 0;

/** The set mounted for the open take (its folder name), or null. */
export const mountedBuildAudio = signal<string | null>(null);

const SOUND_TYPES: Readonly<Record<string, string>> = { wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", webm: "audio/webm" };

/**
 * Mount the build audio set for a take with `meta` in the open takes folder, if it has one; release any other. Resolves
 * with the set's name, or null when there is none (the replay is then silent).
 */
export async function mountBuildAudioFor(meta: { readonly project: string; readonly audioHash: string }): Promise<string | null> {
  const project = currentProject.peek();
  const run = ++mountRun;
  if (!project || !isTakesFolder(project) || !project.fileSystem || !project.root) {
    unmountBuildAudio();
    return null;
  }
  const name = buildAudioSetName(meta.project, meta.audioHash);
  if (mounted?.set === name && mounted.project === project) return name;
  const fs = project.fileSystem;
  const dir = joinPath(joinPath(project.root, BUILD_AUDIO_FOLDER), name);
  const index = await readJson<BuildAudioIndex>(fs, joinPath(dir, "set.json"));
  if (run !== mountRun) return null;
  if (!index) {
    unmountBuildAudio();
    return null;
  }
  const values = new Map<string, unknown>();
  const buildUrls = new Map<string, string>();
  const urls: string[] = [];
  try {
    for (const f of index.files) {
      const at = joinPath(dir, fileIn(f));
      if (f.kind === "project" && extensionOf(f.path) === "json") {
        values.set(f.path, JSON.parse(await fs.readText(at)));
        continue;
      }
      const bytes = await fs.readBinary(at);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: SOUND_TYPES[extensionOf(f.path)] ?? "application/octet-stream" }));
      urls.push(url);
      if (f.kind === "project") values.set(f.path, url);
      else buildUrls.set(f.path, url);
    }
  } catch (err) {
    for (const u of urls) URL.revokeObjectURL(u);
    status.value = { kind: "error", text: `Couldn't read the build audio for ${meta.project}: ${messageOf(err)}` };
    return null;
  }
  if (run !== mountRun || currentProject.peek() !== project) {
    for (const u of urls) URL.revokeObjectURL(u);
    return null;
  }
  unmountBuildAudio();
  const texts = new Map<string, string>();
  for (const [path, value] of values) if (extensionOf(path) === "json") texts.set(path, JSON.stringify(value, null, 2));
  // Playlists, the Mixer and the Take Inspector show the build's audio, read-only (`audioProject`).
  mountedAudioProject.value = readOnlyProject(`${meta.project || "Build"} (build audio)`, { values: new Map(values), texts });
  const source: AssetSource = { has: (p) => values.has(p), get: (p) => values.get(p), paths: () => values.keys() };
  const context = acquireProjectContext({ assets: source });
  installAudioMedia((index.manifest as AudioManifest | null) ?? null, (p) => buildUrls.get(p) ?? p);
  const runtime = audioRuntime();
  runtime.close();
  void runtime.open({ ...settingsWithAudio(values.get("project.json"), values.get("audio.json")), autoload: [] });
  mounted = { set: name, project, context, urls };
  mountedBuildAudio.value = name;
  return name;
}

/** Release the mounted set (if any): the takes folder's own settings and assets again. */
export function unmountBuildAudio(): void {
  const m = mounted;
  if (!m) return;
  mounted = null;
  mountedBuildAudio.value = null;
  mountedAudioProject.value = null;
  m.context.release();
  installAudioMedia(null);
  for (const u of m.urls) URL.revokeObjectURL(u);
  // Another project opening has started its own runtime already: leave it.
  if (currentProject.peek() !== m.project) return;
  const runtime = audioRuntime();
  runtime.close();
  void runtime.open(editorSettings(m.project));
}

/** Releases the mounted set when the takes folder it belongs to closes. Returns the stop. */
export function installBuildAudioMounts(): () => void {
  return effect(() => {
    const project = currentProject.value;
    if (mounted && mounted.project !== project) unmountBuildAudio();
  });
}
