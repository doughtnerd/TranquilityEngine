// The build's audio for a tool (ADR 0410, schema in `schema.ts`): the index of what a replay needs (every JSON project
// file, every sound the build serves loose, and the packages and streamed media its media table names) and each file's
// bytes, as the build has them. A replay in the Studio then plays what the game plays, with no project.
//
// Loaded only through the audio topic (`topic.ts`), so release exports hold none of it.
import { Assets, fetchAssetBytes } from "../../../../engine/scene/Assets";
import { extensionOf } from "../../../../engine/scene/projectFiles";
import { captureProject } from "../capture/capture";
import { currentAudioHash, fnv1a } from "../capture/take";
import { buildUrl, installedAudio, mediaEntry } from "../media/mediaTable";
import type { BuildAudioFile, BuildAudioIndex, BuildFileParams } from "./schema";

/** The extensions of sound files a build may serve loose (converted sounds keep their project path). */
const SOUND_EXTENSIONS: ReadonlySet<string> = new Set(["wav", "ogg", "oga", "opus", "mp3", "flac", "m4a", "aac", "webm", "caf"]);

/** What a build reads its audio through; the real one is the engine's `Assets`, media table and `fetch`. */
export interface BuildAudioHost {
  /** Every project path the build lists. */
  paths(): readonly string[];
  /** A JSON project file's parsed value (undefined: none). */
  json(path: string): unknown;
  /** A project file's bytes as the build serves it. */
  projectBytes(path: string): Promise<Uint8Array>;
  /** A build file's bytes (`audio/packages/Core.mycopak`). */
  buildBytes(path: string): Promise<Uint8Array>;
  /** The build's media table (`game.json`'s `audio`), or null. */
  manifest(): { readonly packages?: readonly { readonly url: string }[]; readonly media?: Readonly<Record<string, { readonly url?: string; readonly package?: string; readonly packages?: readonly string[] }>> } | null;
  project(): string;
  audioHash(): string;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't read ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The running build's own audio. */
export const runningBuildAudio: BuildAudioHost = {
  paths: () => Assets.paths(),
  json: (path) => Assets.get(path),
  projectBytes: (path) => fetchAssetBytes(Assets.url(path)),
  buildBytes: (path) => fetchBytes(buildUrl(path)),
  manifest: () => (installedAudio()?.audio as ReturnType<BuildAudioHost["manifest"]>) ?? null,
  project: () => captureProject().name,
  audioHash: currentAudioHash,
};

const jsonText = (value: unknown): string => JSON.stringify(value ?? null);

/** The build's audio index. */
export function buildAudioIndex(host: BuildAudioHost = runningBuildAudio): BuildAudioIndex {
  const manifest = host.manifest();
  const files: BuildAudioFile[] = [];
  const builds = new Set<string>();
  for (const path of host.paths()) {
    const ext = extensionOf(path);
    if (ext === "json") {
      const value = host.json(path);
      if (value !== undefined) files.push({ kind: "project", path, hash: fnv1a(jsonText(value)) });
    } else if (SOUND_EXTENSIONS.has(ext)) {
      const entry = manifest?.media?.[path] ?? mediaEntry(path);
      if (entry?.url) builds.add(entry.url); // a packaged stream sound: its media ships loose at a build path
      else if (!(entry?.package || entry?.packages?.length)) files.push({ kind: "project", path, hash: null }); // loose at its own path
      // else its bytes are in a package, sent below
    }
  }
  for (const p of manifest?.packages ?? []) builds.add(p.url);
  for (const path of [...builds].sort()) files.push({ kind: "build", path, hash: null });
  return { project: host.project(), audioHash: host.audioHash(), manifest, files };
}

/** The index as an upload's bytes (UTF-8 JSON). */
export async function buildAudioIndexBytes(host: BuildAudioHost = runningBuildAudio): Promise<Uint8Array> {
  return new TextEncoder().encode(JSON.stringify(buildAudioIndex(host)));
}

/** One file's bytes, for `build.file`. A path the index doesn't list is refused. */
export async function buildFileBytes(params: unknown, host: BuildAudioHost = runningBuildAudio): Promise<Uint8Array> {
  const p = (params && typeof params === "object" ? params : {}) as Partial<BuildFileParams>;
  if ((p.kind !== "project" && p.kind !== "build") || typeof p.path !== "string") throw new Error("build.file needs a kind (project or build) and a path");
  const listed = buildAudioIndex(host).files.some((f) => f.kind === p.kind && f.path === p.path);
  if (!listed) throw new Error(`${p.path} isn't part of the build's audio`);
  if (p.kind === "build") return host.buildBytes(p.path);
  if (extensionOf(p.path) === "json") return new TextEncoder().encode(jsonText(host.json(p.path)));
  return host.projectBytes(p.path);
}
