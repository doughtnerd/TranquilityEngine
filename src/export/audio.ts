// Audio conversion and packages in game builds (ADR 0337 §5, §7, §8, amended by 0345). Beside `processImages` (ADR
// 0119): the build writer (buildWriter.ts) runs `processAudio` after rendering baked samples and processing images.
//
// Two halves:
//
// - `planAudio` is pure: given the build's files, `audio.json`'s encoding settings and packages, and each sound's sidecar,
//   it decides per sound what it ships as for the build's platform (codec, rate ceiling, mono, load mode), where the
//   settings came from, which packages hold it and where its bytes go. No bytes are read here.
// - `processAudio` runs a plan through the injected pieces: the project's files, a decoder (`DecodeAudio`, sources to
//   PCM), the encoder pool (`AudioEncoder`, audioEncoder.ts) and a content-hash cache (`AudioCacheStore`,
//   `.myco/cache/audio/`). It returns the build plan with the converted bytes placed, the packages written, the media
//   table in `game.json` and the report (`audio-report.json`).
//
// **Placement.** A sound in no package ships loose at its own project path, converted (`step.wav` may hold Ogg Vorbis
// bytes, as `hero.png` may hold WebP: the decoder sniffs content). A packaged sound's bytes go into each package that
// holds it (`audio/packages/<name>.mycopak`) and its project file isn't written (it stays listed in `game.json`'s
// `files`, so sidecars, playlists and the sample resolver still find it; the media table says where its bytes are). A
// packaged `stream` sound's media ships loose as `audio/stream/<hash>.<ext>` and each package holds only its prefetch
// head (16-bit PCM). A sample with an offline render (`sample.source`, a Studio flatten or the export's own render,
// ADR 0328) is converted from the render, at the render's path, with the sample's settings: the runtime plays the render.
//
// **Codec rules** beyond the settings: Opus takes mono and stereo only, so an ambisonic or multichannel file set to Opus
// ships as Vorbis (D56); ADPCM has no loose container (D56, this module's choice): a loose sound set to ADPCM, or a
// packaged `stream` one, ships as Vorbis with a note; inside a package ADPCM entries carry their facts in the TOC.
import { shippedCodec } from "../engine/audio/encoding/defaults";
import { defaultEncodingConfig, parseSidecarEncoding } from "../engine/audio/encoding/format";
import { originLabel, resolveEncoding, type EncodingFile, type EncodingSubject } from "../engine/audio/encoding/resolve";
import { ENCODING_KEYS, type EncodingConfig, type EncodingKey, type EncodingResolution, type LoadMode, type ResolvedEncoding, type ShippedCodec } from "../engine/audio/encoding/types";
import { PACK_EXTENSION, writeAudioPack, type PackCodec, type PackInput } from "../engine/audio/packaging/format";
import { audioDependencies, packageContents, shipsOn, type PackageDef } from "../engine/audio/packaging/definitions";
import { parseAudioProject } from "../engine/audio/project/format";
import { AUDIO_PROJECT_FILE } from "../engine/audio/project/types";
import { isDerivedSamplePath } from "../engine/audio/sample/format";
import { parseImportSettings, sidecarPath, type ImportPlatform } from "../engine/scene/importSettings";
import { ENCODER_VERSION, type AudioEncoder, type EncodeRequest, type EncodedAudio } from "./audioEncoder";
import { MANIFEST_FILE, type AudioManifest, type AudioMediaEntry, type GameManifest } from "./format";
import { copiedPath, type WebBuildPlan } from "./webBuild";

/** Audio files a build converts, by extension (the decoder's formats). */
export const AUDIO_FILE = /\.(wav|wave|flac|aif|aiff|aifc|mp3|ogg|oga|opus|m4a|aac)$/i;
/** Where converted sounds are cached, relative to the project folder (ADR 0337 §5). */
export const AUDIO_CACHE_DIR = ".myco/cache/audio";
/** Where packages go in the build. */
export const PACKAGES_DIR = "audio/packages";
/** Where a packaged `stream` sound's media goes in the build. */
export const STREAM_DIR = "audio/stream";
/** The report's file name and format. */
export const AUDIO_REPORT_FILE = "audio-report.json";
export const AUDIO_REPORT_FORMAT = "myco.audioreport@1";

const MB = 1024 * 1024;

// --- the plan (pure) ------------------------------------------------------------------------------------------------

/** What the planner knows of one sound's sidecar (or the subject of a render). */
export interface AudioSidecarFacts {
  encoding: EncodingFile["encoding"];
  legacyStream: boolean;
  ambisonic: boolean;
}

/** What `planAudio` needs. */
export interface AudioPlanInput {
  platform: ImportPlatform;
  /** Every project path the build ships (copies and generated project files such as export renders). */
  files: readonly string[];
  /** `audio.json`'s encoding section (`defaultEncodingConfig()` when it has none). */
  config: EncodingConfig;
  /** `audio.json`'s packages (every platform's; the planner keeps the ones shipping on `platform`). */
  packages: readonly PackageDef[];
  /** The sidecar facts of an audio file (null: no sidecar). */
  sidecar(path: string): AudioSidecarFacts | null;
  /**
   * The sample a render belongs to (the file whose `sample.source` names it): its subject, so the render resolves as its
   * sample does; null when `path` isn't a render.
   */
  renderOwner(path: string): (EncodingSubject & { ambisonic: boolean }) | null;
  /** An asset's dependencies (`audioDependencies`): what a package that includes it also holds. */
  dependencies(path: string): readonly string[];
  /** False: `--no-audio-convert`, every sound ships as its source. */
  convert: boolean;
}

/** One sound the build ships, as planned. */
export interface PlannedSound {
  /** The project path shipped (a render's own path for a rendered sample). */
  path: string;
  /** The sample whose settings it uses when it is a render; null otherwise. */
  renderOf: string | null;
  resolution: EncodingResolution;
  /** What it ships as before the decoded facts are known (Opus on > 2 channels still falls back to Vorbis then). */
  codec: ShippedCodec | "source";
  load: LoadMode;
  ambisonic: boolean;
  /** Packages holding it, in `audio.json`'s order. */
  packages: string[];
  /** Notes for the report: fallbacks and refused settings. */
  notes: string[];
}

export interface PlannedPackage {
  def: PackageDef;
  /** The audio files it holds (sorted). */
  sounds: string[];
  /** Include entries that matched nothing, and dependencies missing from the project, as report lines. */
  problems: string[];
}

export interface AudioPlan {
  platform: ImportPlatform;
  convert: boolean;
  sounds: PlannedSound[];
  packages: PlannedPackage[];
  config: EncodingConfig;
  problems: string[];
}

/** What `codec` ships as given where the sound goes (ADR 0337 §4, D56): ADPCM only inside a package, never streamed. */
function placeCodec(codec: ShippedCodec | "source", load: LoadMode, packaged: boolean, notes: string[]): ShippedCodec | "source" {
  if (codec !== "adpcm") return codec;
  if (!packaged) {
    notes.push("ADPCM lives only in packages (it has no loose container); shipped as Vorbis.");
    return "vorbis";
  }
  if (load === "stream") {
    notes.push("a streamed sound's media ships loose, where ADPCM has no container; shipped as Vorbis.");
    return "vorbis";
  }
  return codec;
}

/** Plans the audio of a build (see the file header). Pure. */
export function planAudio(input: AudioPlanInput): AudioPlan {
  const problems: string[] = [];
  const audioFiles = input.files.filter((p) => AUDIO_FILE.test(p)).sort();
  const packages: PlannedPackage[] = [];
  for (const def of input.packages) {
    if (!shipsOn(def, input.platform)) continue;
    const c = packageContents(def, input.files, input.dependencies);
    const lines = [
      ...c.unmatched.map((u) => `package "${def.name}": "${u}" matches no file.`),
      ...c.missing.map((m) => `package "${def.name}": ${m.from} names ${m.path}, which isn't in the project.`),
    ];
    problems.push(...lines);
    packages.push({ def, sounds: c.paths.filter((p) => AUDIO_FILE.test(p)), problems: lines });
  }
  const sounds: PlannedSound[] = [];
  for (const path of audioFiles) {
    const owner = input.renderOwner(path);
    const facts = input.sidecar(path);
    const subject: EncodingSubject = owner ?? { path, encoding: facts?.encoding ?? null, legacyStream: facts?.legacyStream ?? false };
    const resolution = resolveEncoding(subject, input.platform, input.config);
    problems.push(...resolution.problems);
    const ambisonic = owner ? owner.ambisonic : facts?.ambisonic === true;
    const notes: string[] = [];
    const inPackages = packages.filter((p) => p.sounds.includes(path)).map((p) => p.def.name);
    let codec: ShippedCodec | "source" = input.convert ? shippedCodec(resolution.settings.codec, path) : "source";
    if (codec === "opus" && ambisonic) {
      notes.push("Opus takes mono and stereo only; this ambisonic file ships as Vorbis.");
      codec = "vorbis";
    }
    codec = placeCodec(codec, resolution.settings.load, inPackages.length > 0, notes);
    if (resolution.settings.channels === "mono" && ambisonic) {
      const line = `${path}: channels "mono" is refused for an ambisonic file; it keeps its channels.`;
      notes.push(line);
      problems.push(line);
    }
    sounds.push({ path, renderOf: owner ? owner.path : null, resolution, codec, load: resolution.settings.load, ambisonic, packages: inPackages, notes });
  }
  return { platform: input.platform, convert: input.convert, sounds, packages, config: input.config, problems };
}

/** The encode request's settings for a planned sound (null: shipped as its source). */
function requestSettings(sound: PlannedSound, codec: ShippedCodec | "source"): Omit<EncodeRequest, "pcm" | "channels" | "sampleRate"> | null {
  if (codec === "source") return null;
  const s = sound.resolution.settings;
  return { codec, quality: s.quality, rateCeiling: s.sampleRate === "source" ? null : s.sampleRate, mono: s.channels === "mono" && !sound.ambisonic };
}

// --- the cache --------------------------------------------------------------------------------------------------------

/** Read and write access to the cache folder, by path relative to the project folder. */
export interface AudioCacheStore {
  /** The cached bytes, or null when there are none (or they can't be read). */
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** A store that keeps nothing (every lookup misses). */
export const NO_AUDIO_CACHE: AudioCacheStore = { read: async () => null, write: async () => undefined };

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The cache key of converting `input` (the source's or the render's bytes) with `settings` (the resolved settings and
 * what they ship as): SHA-256 of the encoder's version, the settings as canonical JSON and the bytes, 64 hex digits.
 */
export async function audioCacheKey(input: Uint8Array, settings: ResolvedEncoding, codec: ShippedCodec | "source", mono: boolean): Promise<string> {
  const canonical = JSON.stringify({ e: ENCODER_VERSION, codec, mono, ...Object.fromEntries(ENCODING_KEYS.map((k) => [k, settings[k]])) });
  const head = new TextEncoder().encode(`${canonical}\n`);
  const all = new Uint8Array(head.length + input.length);
  all.set(head, 0);
  all.set(input, head.length);
  return hex(await crypto.subtle.digest("SHA-256", all));
}

/** A converted sound's facts, cached beside its bytes as `<key>.json`. */
interface CachedFacts {
  codec: ShippedCodec | "source";
  rate: number;
  channels: number;
  frames: number;
  /** A packaged `stream` sound's prefetch head (16-bit PCM WAV) is cached as `<key>.head.wav`; its frames. */
  headFrames?: number;
}

const EXT: Record<ShippedCodec, string> = { pcm: "wav", adpcm: "adpcm", vorbis: "ogg", opus: "opus" };
const extOf = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "bin";

// --- the step -------------------------------------------------------------------------------------------------------

/** A source decoded to interleaved PCM (−1..1). */
export interface DecodedAudio {
  pcm: Float32Array;
  channels: number;
  sampleRate: number;
}

/** Decodes an audio file's bytes (`path` is a hint for the format); rejects when it can't. */
export type DecodeAudio = (bytes: Uint8Array, path: string) => Promise<DecodedAudio>;

/** How the build reads the project: any project path, `.myco/` included (rejects when it isn't there). */
export type ReadAudioProjectFile = (path: string) => Promise<string | Uint8Array>;

export interface ProcessAudioOptions {
  platform: ImportPlatform;
  read: ReadAudioProjectFile;
  /** Null: `--no-audio-convert` (every sound ships as its source; packages still built). */
  encoder: AudioEncoder | null;
  decode: DecodeAudio;
  cache?: AudioCacheStore;
  /** Sounds converted at once (decode and encode; the encoder's own pool decides how many encode in parallel). Default 4. */
  concurrency?: number;
  log?: (line: string) => void;
}

/** One sound in the report. */
export interface AudioReportSound {
  path: string;
  /** The sample whose settings it uses, when it is a render. */
  renderOf: string | null;
  sourceBytes: number;
  shippedBytes: number;
  codec: PackCodec;
  rate: number;
  channels: number;
  frames: number;
  load: LoadMode;
  /** Runtime memory by its load mode (decode: int16 PCM; compressed: its bytes; stream: its prefetch head). */
  memoryBytes: number;
  packages: string[];
  cached: boolean;
  settings: ResolvedEncoding;
  /** Where each setting came from ("Music profile (rule audio/music/**)", "this file · Android", "built-in (Web)"). */
  from: Record<EncodingKey, string>;
  notes: string[];
}

export interface AudioReportPackage {
  name: string;
  preload: boolean;
  bytes: number;
  memoryBytes: number;
  sounds: string[];
  problems: string[];
}

/** `audio-report.json` (ADR 0337 §5 step 6, §8). */
export interface AudioReport {
  format: typeof AUDIO_REPORT_FORMAT;
  platform: ImportPlatform;
  /** False for `--no-audio-convert`. */
  converted: boolean;
  sounds: AudioReportSound[];
  packages: AudioReportPackage[];
  totals: {
    files: number;
    sourceBytes: number;
    shippedBytes: number;
    /** The static memory bound (ADR 0337 §8): the preload packages plus the largest other package. */
    memoryBytes: number;
  };
  /** The platform's budgets and the warnings for those passed (tripwires: never a failure). */
  budgets: { downloadMB?: number; memoryMB?: number; warnings: string[] };
  problems: string[];
}

/** One sound's conversion result. */
interface Converted {
  sound: PlannedSound;
  codec: PackCodec;
  bytes: Uint8Array;
  sourceBytes: number;
  rate: number;
  channels: number;
  frames: number;
  key: string;
  head: { bytes: Uint8Array; frames: number } | null;
  cached: boolean;
}

/** Runs `tasks` with at most `limit` at once, in order of start. */
async function inParallel<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (v: string | Uint8Array) => (typeof v === "string" ? encoder.encode(v) : v);
const textOf = (v: string | Uint8Array) => (typeof v === "string" ? v : decoder.decode(v));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Interleaved PCM's first `frames` frames. */
const headOf = (d: DecodedAudio, frames: number): DecodedAudio => ({ ...d, pcm: d.pcm.slice(0, frames * d.channels) });

/** The runtime memory of a sound (ADR 0337 §3). */
function memoryOf(load: LoadMode, codec: PackCodec, frames: number, channels: number, bytes: number, headFrames: number): number {
  if (load === "stream") return headFrames * channels * 2;
  if (load === "compressed" && codec !== "pcm" && codec !== "source") return bytes;
  return frames * channels * 2;
}

/**
 * The build's audio, converted and placed (see the file header). Returns the plan unchanged (and no report) when the build
 * ships no audio file and `audio.json` defines no packages.
 */
export async function processAudio(build: WebBuildPlan, options: ProcessAudioOptions): Promise<{ plan: WebBuildPlan; report: AudioReport | null }> {
  const log = options.log ?? (() => {});
  const cache = options.cache ?? NO_AUDIO_CACHE;
  const binaries = new Map(build.binaries ?? []);
  const generated = new Map(build.generated);
  const files = [...build.manifest.files];
  const fileSet = new Set(files);

  // Text of a project file as the build ships it: a generated copy (a sidecar the render step rewrote) wins.
  const json = new Map<string, unknown>();
  const readJson = async (path: string): Promise<unknown> => {
    if (json.has(path)) return json.get(path);
    let value: unknown;
    try {
      const gen = generated.get(copiedPath(path));
      value = JSON.parse(gen ?? textOf(await options.read(path)));
    } catch {
      value = undefined;
    }
    json.set(path, value);
    return value;
  };
  const audioJson = fileSet.has(AUDIO_PROJECT_FILE) ? await readJson(AUDIO_PROJECT_FILE) : undefined;
  const parsed = audioJson === undefined ? null : parseAudioProject(audioJson);
  const config = parsed?.project.encoding ?? defaultEncodingConfig();
  const packageDefs = parsed?.project.packages ?? [];
  const audioFiles = files.filter((p) => AUDIO_FILE.test(p));
  if (audioFiles.length === 0 && packageDefs.length === 0) return { plan: build, report: null };

  // Every JSON a sidecar, playlist or derived sample might need, read up front so the planner stays synchronous: the
  // project's, and sidecars the render step wrote for sounds that had none.
  for (const p of files) if (p.endsWith(".json")) await readJson(p);
  for (const p of audioFiles) if (!fileSet.has(sidecarPath(p)) && generated.has(copiedPath(sidecarPath(p)))) await readJson(sidecarPath(p));
  const sidecarFacts = new Map<string, AudioSidecarFacts | null>();
  const facts = (path: string): AudioSidecarFacts | null => {
    if (sidecarFacts.has(path)) return sidecarFacts.get(path)!;
    const raw = json.get(sidecarPath(path));
    let out: AudioSidecarFacts | null = null;
    if (isRecord(raw)) {
      const s = parseImportSettings(raw, sidecarPath(path)).settings;
      out = { encoding: s.encoding, legacyStream: s.stream, ambisonic: s.ambisonic !== null };
    }
    sidecarFacts.set(path, out);
    return out;
  };
  // Renders: what names each one (a sidecar's or a derived sample's `sample.source`).
  const owners = new Map<string, EncodingSubject & { ambisonic: boolean }>();
  const renderPath = (source: string, name: string) => (name.includes("/") ? name : `${source.slice(0, source.lastIndexOf("/") + 1)}${name}`);
  for (const p of files) {
    if (AUDIO_FILE.test(p)) {
      const raw = json.get(sidecarPath(p));
      const name = isRecord(raw) && isRecord(raw.sample) && typeof raw.sample.source === "string" ? raw.sample.source : "";
      const f = facts(p);
      if (name) owners.set(renderPath(p, name), { path: p, encoding: f?.encoding ?? null, legacyStream: f?.legacyStream ?? false, ambisonic: f?.ambisonic ?? false });
    } else if (isDerivedSamplePath(p)) {
      const raw = json.get(p);
      if (!isRecord(raw)) continue;
      const source = typeof raw.source === "string" ? raw.source : "";
      const name = isRecord(raw.sample) && typeof raw.sample.source === "string" ? raw.sample.source : "";
      if (!name) continue;
      const own = parseSidecarEncoding(raw.encoding, `${p}: encoding`, []);
      const sf = AUDIO_FILE.test(source) ? facts(source) : null;
      owners.set(renderPath(source || p, name), {
        path: p, encoding: own,
        source: AUDIO_FILE.test(source) ? { path: source, encoding: sf?.encoding ?? null, legacyStream: sf?.legacyStream ?? false } : null,
        ambisonic: sf?.ambisonic ?? false,
      });
    }
  }

  const plan = planAudio({
    platform: options.platform,
    files,
    config,
    packages: packageDefs,
    sidecar: facts,
    renderOwner: (p) => owners.get(p) ?? null,
    dependencies: audioDependencies((p) => json.get(p)),
    convert: options.encoder !== null,
  });
  for (const line of plan.problems) log(`audio: ${line}`);

  // A sound's input bytes: a generated file (an export render) or the project's.
  const inputOf = async (path: string): Promise<Uint8Array> => binaries.get(copiedPath(path)) ?? bytesOf(await options.read(path));
  let done = 0;
  const convertOne = async (sound: PlannedSound): Promise<Converted | null> => {
    let input: Uint8Array;
    try {
      input = await inputOf(sound.path);
    } catch (err) {
      log(`audio: ${sound.path} couldn't be read (${(err as Error)?.message ?? err}); it's left out of the conversion.`);
      return null;
    }
    const packaged = sound.packages.length > 0;
    const needsFacts = sound.codec !== "source" || packaged || sound.load !== "decode";
    // Shipped as it is, loose, decoded on load: nothing to convert or to know (the report gives no rate, channels or frames).
    if (!needsFacts) return { sound, codec: "source", bytes: input, sourceBytes: input.length, rate: 0, channels: 0, frames: 0, key: "", head: null, cached: false };
    const wantsHead = packaged && sound.load === "stream";
    const s = sound.resolution.settings;
    let codec = sound.codec;
    const settings = requestSettings(sound, codec);
    const key = await audioCacheKey(input, s, codec, settings?.mono ?? false);
    const factsPath = `${AUDIO_CACHE_DIR}/${key}.json`;
    // A hit: the facts, and the bytes unless the sound ships as its source.
    const hit = await cache.read(factsPath).then((b) => (b ? (JSON.parse(decoder.decode(b)) as CachedFacts) : null), () => null);
    if (hit) {
      const bytes = hit.codec === "source" ? input : await cache.read(`${AUDIO_CACHE_DIR}/${key}.${EXT[hit.codec]}`);
      const head = wantsHead ? await cache.read(`${AUDIO_CACHE_DIR}/${key}.head.wav`) : null;
      if (bytes && (!wantsHead || head)) {
        log(`audio: ${sound.path} (cached) [${++done}/${plan.sounds.length}]`);
        return { sound, codec: hit.codec, bytes, sourceBytes: input.length, rate: hit.rate, channels: hit.channels, frames: hit.frames, key, head: head ? { bytes: head, frames: hit.headFrames ?? 0 } : null, cached: true };
      }
    }
    let decoded: DecodedAudio;
    try {
      decoded = await options.decode(input, sound.path);
    } catch (err) {
      log(`audio: ${sound.path} couldn't be decoded (${(err as Error)?.message ?? err}); it ships as it is${packaged ? ", outside its packages" : ""}.`);
      return null;
    }
    // The key stays the planned codec's: the facts it caches say what the sound really shipped as.
    if (codec === "opus" && decoded.channels > 2) {
      sound.notes.push(`Opus takes mono and stereo only; this ${decoded.channels}-channel file ships as Vorbis.`);
      codec = "vorbis";
    }
    const frames = Math.floor(decoded.pcm.length / Math.max(1, decoded.channels));
    let out: { codec: PackCodec; bytes: Uint8Array; rate: number; channels: number; frames: number } = { codec: "source", bytes: input, rate: decoded.sampleRate, channels: decoded.channels, frames };
    if (codec !== "source" && options.encoder) {
      try {
        const enc: EncodedAudio = await options.encoder.encode({ ...requestSettings(sound, codec)!, pcm: decoded.pcm, channels: decoded.channels, sampleRate: decoded.sampleRate });
        out = { codec: enc.codec, bytes: enc.bytes, rate: enc.sampleRate, channels: enc.channels, frames: enc.frames };
      } catch (err) {
        log(`audio: ${sound.path} couldn't be encoded as ${codec} (${(err as Error)?.message ?? err}); it ships as it is.`);
      }
    }
    let head: Converted["head"] = null;
    if (wantsHead) {
      const headFrames = Math.min(frames, Math.round((s.prefetchMs / 1000) * decoded.sampleRate));
      const req: EncodeRequest = { pcm: headOf(decoded, headFrames).pcm, channels: decoded.channels, sampleRate: decoded.sampleRate, codec: "pcm", quality: 0, rateCeiling: out.codec === "source" ? null : out.rate, mono: out.channels < decoded.channels };
      if (options.encoder && headFrames > 0) {
        try {
          const h = await options.encoder.encode(req);
          head = { bytes: h.bytes, frames: h.frames };
        } catch {
          head = { bytes: new Uint8Array(0), frames: 0 };
        }
      } else head = { bytes: new Uint8Array(0), frames: 0 };
    }
    // Into the cache: the facts, the bytes (unless shipped as the source), the head.
    try {
      if (out.codec !== "source") await cache.write(`${AUDIO_CACHE_DIR}/${key}.${EXT[out.codec]}`, out.bytes);
      if (head) await cache.write(`${AUDIO_CACHE_DIR}/${key}.head.wav`, head.bytes);
      const f: CachedFacts = { codec: out.codec, rate: out.rate, channels: out.channels, frames: out.frames, ...(head ? { headFrames: head.frames } : {}) };
      await cache.write(`${AUDIO_CACHE_DIR}/${key}.json`, encoder.encode(JSON.stringify(f)));
    } catch (err) {
      log(`audio: couldn't write the cache for ${sound.path} (${(err as Error)?.message ?? err}).`);
    }
    log(`audio: ${sound.path} → ${out.codec} [${++done}/${plan.sounds.length}]`);
    return { sound, ...out, sourceBytes: input.length, key, head, cached: false };
  };
  const results = (await inParallel(plan.sounds, options.concurrency ?? 4, convertOne)).filter((r): r is Converted => r !== null);

  // --- placement ---
  const omit = new Set(build.omit ?? []);
  const media: Record<string, AudioMediaEntry> = {};
  const packInputs = new Map<string, PackInput[]>(plan.packages.map((p) => [p.def.name, []]));
  const reportSounds: AudioReportSound[] = [];
  for (const r of results) {
    const { sound } = r;
    const s = sound.resolution.settings;
    const packaged = sound.packages.length > 0;
    const shippedAs = r.codec;
    let shippedBytes = r.bytes.length;
    if (!packaged) {
      if (shippedAs !== "source") binaries.set(copiedPath(sound.path), r.bytes);
      if (shippedAs !== "source" || sound.load !== "decode") media[sound.path] = { codec: shippedAs, load: sound.load, rate: r.rate, channels: r.channels, frames: r.frames };
    } else {
      const entry = { codec: shippedAs, load: sound.load, rate: r.rate, channels: r.channels, frames: r.frames };
      let url: string | undefined;
      if (sound.load === "stream") {
        url = `${STREAM_DIR}/${r.key.slice(0, 16)}.${shippedAs === "source" ? extOf(sound.path) : EXT[shippedAs]}`;
        binaries.set(url, r.bytes);
        for (const name of sound.packages) {
          packInputs.get(name)!.push({ entry: { path: sound.path, codec: "pcm", rate: r.rate, channels: r.channels, frames: r.frames, load: "stream", hash: r.key, prefetch: { frames: r.head?.frames ?? 0 } }, data: r.head?.bytes ?? new Uint8Array(0) });
        }
        shippedBytes = r.bytes.length + (r.head?.bytes.length ?? 0) * sound.packages.length;
      } else {
        for (const name of sound.packages) packInputs.get(name)!.push({ entry: { path: sound.path, codec: shippedAs, rate: r.rate, channels: r.channels, frames: r.frames, load: sound.load, hash: r.key, prefetch: null }, data: r.bytes });
        shippedBytes = r.bytes.length * sound.packages.length;
      }
      media[sound.path] = { package: sound.packages[0], ...(sound.packages.length > 1 ? { packages: [...sound.packages] } : {}), ...(url ? { url } : {}), ...entry };
      // Its bytes are in the packages (or under audio/stream/): the project file isn't written.
      omit.add(sound.path);
      binaries.delete(copiedPath(sound.path));
    }
    const from = Object.fromEntries(ENCODING_KEYS.map((k) => [k, originLabel(sound.resolution.origins[k], sound.renderOf ?? sound.path)])) as Record<EncodingKey, string>;
    reportSounds.push({
      path: sound.path, renderOf: sound.renderOf, sourceBytes: r.sourceBytes, shippedBytes, codec: shippedAs,
      rate: r.rate, channels: r.channels, frames: r.frames, load: sound.load,
      memoryBytes: memoryOf(sound.load, shippedAs, r.frames, r.channels, r.bytes.length, r.head?.frames ?? 0),
      packages: [...sound.packages], cached: r.cached, settings: { ...s }, from, notes: [...sound.notes],
    });
  }

  // --- packages ---
  const manifestPackages: AudioManifest["packages"][number][] = [];
  const reportPackages: AudioReportPackage[] = [];
  for (const p of plan.packages) {
    const inputs = packInputs.get(p.def.name)!;
    const bytes = writeAudioPack(p.def.name, options.platform, inputs);
    const url = `${PACKAGES_DIR}/${p.def.name}${PACK_EXTENSION}`;
    binaries.set(url, bytes);
    manifestPackages.push({ name: p.def.name, url, bytes: bytes.length, preload: p.def.preload });
    const memoryBytes = inputs.reduce((sum, i) => sum + memoryOf(i.entry.load, i.entry.codec, i.entry.frames, i.entry.channels, i.data.length, i.entry.prefetch?.frames ?? 0), 0);
    reportPackages.push({ name: p.def.name, preload: p.def.preload, bytes: bytes.length, memoryBytes, sounds: inputs.map((i) => i.entry.path), problems: p.problems });
  }

  // --- the report, budgets, the manifest ---
  const shippedLoose = reportSounds.filter((s) => s.packages.length === 0).reduce((n, s) => n + s.shippedBytes, 0);
  const streamed = results.filter((r) => r.sound.packages.length > 0 && r.sound.load === "stream").reduce((n, r) => n + r.bytes.length, 0);
  const shippedBytes = shippedLoose + streamed + manifestPackages.reduce((n, p) => n + p.bytes, 0);
  const sourceBytes = reportSounds.reduce((n, s) => n + s.sourceBytes, 0);
  const preloadMemory = reportPackages.filter((p) => p.preload).reduce((n, p) => n + p.memoryBytes, 0);
  const largestOther = reportPackages.filter((p) => !p.preload).reduce((m, p) => Math.max(m, p.memoryBytes), 0);
  const memoryBytes = preloadMemory + largestOther;
  const budget = config.budgets[options.platform] ?? {};
  const warnings: string[] = [];
  if (budget.downloadMB !== undefined && shippedBytes > budget.downloadMB * MB) warnings.push(`audio download ${(shippedBytes / MB).toFixed(1)} MB is over the ${options.platform} budget of ${budget.downloadMB} MB.`);
  if (budget.memoryMB !== undefined && memoryBytes > budget.memoryMB * MB) warnings.push(`audio memory ${(memoryBytes / MB).toFixed(1)} MB (preload packages plus the largest other package) is over the ${options.platform} budget of ${budget.memoryMB} MB.`);
  const report: AudioReport = {
    format: AUDIO_REPORT_FORMAT,
    platform: options.platform,
    converted: options.encoder !== null,
    sounds: reportSounds,
    packages: reportPackages,
    totals: { files: reportSounds.length, sourceBytes, shippedBytes, memoryBytes },
    budgets: { ...(budget.downloadMB !== undefined ? { downloadMB: budget.downloadMB } : {}), ...(budget.memoryMB !== undefined ? { memoryMB: budget.memoryMB } : {}), warnings },
    problems: plan.problems,
  };
  log(`audio: ${reportSounds.length} file${reportSounds.length === 1 ? "" : "s"}, ${(sourceBytes / MB).toFixed(1)} MB → ${(shippedBytes / MB).toFixed(1)} MB for ${options.platform}; ${manifestPackages.length} package${manifestPackages.length === 1 ? "" : "s"}${options.encoder ? "" : " (--no-audio-convert: sources shipped unchanged)"}`);
  for (const w of warnings) log(`warning: ${w}`);

  const hasAudio = manifestPackages.length > 0 || Object.keys(media).length > 0;
  const manifest: GameManifest = hasAudio ? { ...build.manifest, audio: { platform: options.platform, packages: manifestPackages, media } } : build.manifest;
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return { plan: { ...build, manifest, generated, binaries, omit }, report };
}
