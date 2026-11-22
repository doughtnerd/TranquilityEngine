// The Studio's real encoding services (ADR 0337 §6, 0345 §3): one browser encoder pool for the page (Web Workers, at
// most two encoding at once), the game's decoder for sources, the project's `.myco/cache/audio/` as the cache, the plan
// over the open project, the conversion service, Hear as over the page's `Assets`, and Convert now (the export's
// `processAudio` run for one platform into the cache, with progress, answering its report).
import { audioProjectText } from "../../editor/audioProjectFile";
import type { EditorProject } from "../../editor/projects";
import { joinPath } from "../../editor/projectPaths";
import { currentProject } from "../../editor/state";
import { audioSection } from "../../engine/audio/audioSection";
import { writeAudioPack } from "../../engine/audio/packaging/format";
import type { AudioProject } from "../../engine/audio/project/types";
import { AUDIO_PROJECT_FILE } from "../../engine/audio/project/types";
import { Assets } from "../../engine/scene/Assets";
import type { ImportPlatform, ImportSettings } from "../../engine/scene/importSettings";
import { NO_AUDIO_CACHE, processAudio, type AudioCacheStore, type AudioReport, type DecodeAudio } from "../../export/audio";
import { createAudioDecoder, DECODER_WASM_URL } from "../../export/audioDecode";
import type { AudioEncoder } from "../../export/audioEncoder";
import { createBrowserAudioEncoder } from "../../export/audioEncoderBrowser";
import { MANIFEST_FORMAT, type GameManifest } from "../../export/format";
import type { WebBuildPlan } from "../../export/webBuild";
import { sharedDecoderClient } from "../../plugins/audio/runtime/decoder/decoderClient";
import { encodeWavFloat32 } from "../../engine/audio/sample/wavEncode";
import { openMixDocument } from "../screens/mixer/mixerDocument";
import { createConversions, type ConvertedSound, type Conversions } from "./conversion";
import { createHearAs, type HearAsService } from "./hearAs";
import { convertProgress } from "./progress";
import { plannedSound, studioPlan, type StudioPlanSource } from "./studioPlan";

let encoder: AudioEncoder | null = null;
/** The page's encoder pool (made on first use, never closed while the page lives). */
export const studioEncoder = (): AudioEncoder => (encoder ??= createBrowserAudioEncoder());

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't read ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let decode: DecodeAudio | null = null;
/** Sources decoded as the export decodes them (WAV in TypeScript, the rest with the game's decoder). */
export const studioDecode: DecodeAudio = (bytes, path) => (decode ??= createAudioDecoder(() => fetchBytes(DECODER_WASM_URL.href)))(bytes, path);

/** The project's audio cache folder (paths relative to the project); none without a folder. */
export function projectAudioCache(project: EditorProject): AudioCacheStore {
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

/** A project file's bytes: text the Studio holds, else the bytes behind its asset URL. */
async function projectBytes(project: EditorProject, path: string): Promise<Uint8Array> {
  const t = project.textOf(path);
  if (t !== undefined) return new TextEncoder().encode(t);
  const url = project.assets.get(path);
  if (typeof url !== "string") throw new Error(`${path} isn't in the project`);
  return fetchBytes(url);
}

/** `audio.json` as its document holds it now (null without a project). */
export function audioProjectNow(project: EditorProject): AudioProject | null {
  return openMixDocument(project)?.value.value ?? null;
}

/** The plan's view of `project`: its files, `audio.json`'s document, its JSON files; `sidecar` overrides one sidecar. */
export function projectPlanSource(project: EditorProject, sidecar?: (path: string) => ImportSettings | null | undefined): StudioPlanSource {
  return {
    files: project.files,
    audio: audioProjectNow(project),
    json: (p) => (project.files.includes(p) ? project.assets.get(p) : undefined),
    ...(sidecar ? { sidecar } : {}),
  };
}

const conversionsByProject = new WeakMap<EditorProject, Conversions>();
/** The conversion service of `project` (one per project, so its memory cache lives with it). */
export function conversionsFor(project: EditorProject): Conversions {
  let c = conversionsByProject.get(project);
  if (!c) conversionsByProject.set(project, (c = createConversions({ read: (p) => projectBytes(project, p), decode: studioDecode, encoder: studioEncoder, cache: projectAudioCache(project) })));
  return c;
}

/** Packages loaded into the shared decoder for an ADPCM audition (ids far from the runtime's). */
let nextPack = 0x7fff_0000;

/** ADPCM blocks decoded to a 16-bit WAV through the game's decoder (one-entry package, `load: "decode"`). */
async function adpcmToWav(project: EditorProject, c: ConvertedSound, path: string): Promise<Uint8Array> {
  const aac = audioSection((project.settings as { audio?: unknown }).audio).settings.codecs.aac;
  const client = sharedDecoderClient(aac ? "aac" : "default");
  const pack = nextPack++;
  const bytes = writeAudioPack("hear-as", "web", [{ entry: { path, codec: "adpcm", rate: c.rate, channels: c.channels, frames: c.frames, load: "decode", hash: c.key, prefetch: null }, data: c.bytes }]);
  await client.loadPack(pack, bytes.slice().buffer);
  try {
    const clip = await client.decodeClip(new Uint8Array(0), undefined, { pack: { pack, path } });
    return encodeWavFloat32(Float32Array.from(clip.pcm, (s) => s / 32768), clip.channels, clip.rate);
  } finally {
    client.releasePack(pack);
  }
}

let hear: HearAsService | null = null;
/** The page's Hear as service, over the open project and the page's `Assets`. */
export function studioHearAs(): HearAsService {
  if (hear) return hear;
  const project = () => {
    const p = currentProject.peek();
    if (!p) throw new Error("no project is open");
    return p;
  };
  hear = createHearAs({
    planned: (path, platform) => plannedSound(studioPlan(projectPlanSource(project()), platform), path),
    convert: (sound) => conversionsFor(project()).convert(sound),
    toWav: (c, path) => adpcmToWav(project(), c, path),
    assets: Assets,
    urls: { make: (bytes) => URL.createObjectURL(new Blob([bytes.slice().buffer])), revoke: (url) => URL.revokeObjectURL(url) },
  });
  // A new project serves its own files.
  currentProject.subscribe(() => hear?.set("source"));
  return hear;
}

/** Convert now's progress. */
export interface ConvertNowProgress {
  readonly done: number;
  readonly total: number;
  readonly line: string;
}

/**
 * Convert now (ADR 0337 §6): the export's audio step for `platform` over the open project, encoding misses into
 * `.myco/cache/audio/` (so the next export is fast) and answering its report (`audio-report.json`'s view), without
 * writing a build. `audio.json` is read from its document; offline renders the export makes itself aren't (a sample
 * with unflattened baked effects converts its source).
 */
export async function convertProjectNow(project: EditorProject, platform: ImportPlatform, progress: (p: ConvertNowProgress) => void, signalAbort?: AbortSignal): Promise<AudioReport | null> {
  const files = [...project.files].sort();
  const manifest: GameManifest = { format: MANIFEST_FORMAT, name: project.name, mainScene: null, files, scripts: [] };
  const plan: WebBuildPlan = { manifest, copies: files, generated: new Map(), binaries: new Map() };
  const doc = openMixDocument(project);
  const read = async (path: string): Promise<string | Uint8Array> => {
    if (signalAbort?.aborted) throw new Error("cancelled");
    if (path === AUDIO_PROJECT_FILE && doc) return audioProjectText(doc.value.peek());
    const t = project.textOf(path);
    if (t !== undefined) return t;
    return projectBytes(project, path);
  };
  const { report } = await processAudio(plan, {
    platform,
    read,
    encoder: studioEncoder(),
    decode: studioDecode,
    cache: projectAudioCache(project),
    log: (line) => {
      const p = convertProgress(line);
      if (p) progress({ ...p, line });
    },
  });
  return report;
}
