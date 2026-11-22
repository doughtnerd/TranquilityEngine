/**
 * Audio packages at runtime (ADR 0337 §7, §9; A5): `Audio.package(name)` handles, reference-counted loads and unloads, the
 * clips they hold (reference-counted across packages), the strict rule, preload packages and the `PKG` capture events.
 *
 * **Where packages come from.** In a build, the media table (`mediaTable.ts`): each package's `.mycopak` URL and size,
 * and which sounds each holds. Without one (editor Play, the dev server) `audio.json`'s `packages` over the project's
 * sources: a package holds the files its includes name (a path, or a glob matched against the sound's own path) and the
 * dependencies of its exact includes (`packageContents`, `audioDependencies`); loading it makes its sounds playable from
 * their project files, so a missing load shows before export (ADR 0337 §7 "The editor's Play ... enforce the same rule").
 *
 * **Loading** (W12). A build's package is fetched with progress and its TOC read (`readAudioPack`). On a backend with
 * packages (`AudioBackend.packs`: the core) the bytes go to its decoder worker (`loadPack`, with the package URL to fetch
 * again if the worker restarts), and the runtime answers which loaded package holds a path (`core/packMedia.ts`), so the
 * clip registry and the stream manager read entries from the worker, never fetching. Every `decode` entry and every
 * ADPCM `compressed` one is then committed to the clip arena (`holdClip`), and the package is `loaded` once all of them
 * are resident: `progress` follows the fetch, then the commits, and `memoryBytes` is the arena those clips take plus the
 * `compressed` Vorbis/Opus bytes the worker holds. A `stream` entry's media stays loose (its `url`); its prefetch head
 * (16-bit PCM in the package) is committed as a span clip, so a play starts on it at once and hands over to the stream
 * ring (the core's head hand-over). Over a backend without packages (the Babylon fallback) each entry's bytes become an
 * in-memory URL the backend loads the clip from, and `memoryBytes` is the TOC's estimate.
 *
 * **Ownership.** Every reference has an owner and a World: a script's `load()` is owned by the World it runs in (the
 * active one), an `AudioPackageLoader` by itself, a scene's preparation and the preload packages by its World. A World
 * torn down (Play stop, `destroyWorld`) drops the references it owned; the audio session's release (ADR 0218) drops all.
 *
 * **Unloading** the last reference stops the voices of every clip no other loaded package holds with a 50 ms fade
 * (`finish: true` lets them end first) and frees the clip (its arena hold, or its in-memory URL). The package leaves the
 * decoder worker (`releasePack`) once its finishing voices have ended (at once otherwise: a fading voice plays from the
 * arena or from its stream's own copy).
 */
import { World } from "../../../../engine/core/World";
import { isPlaylistPath, parsePlaylistBody } from "../../../../engine/audio/playlist/format";
import { referencedPaths } from "../../../../engine/audio/playlist/references";
import { defaultEncodingConfig } from "../../../../engine/audio/encoding/format";
import { resolveEncoding } from "../../../../engine/audio/encoding/resolve";
import type { EncodingConfig, LoadMode } from "../../../../engine/audio/encoding/types";
import { readAudioPack, type PackEntry } from "../../../../engine/audio/packaging/format";
import { audioDependencies, defaultPackagingOptions, shipsOn, type PackageDef, type PackagingOptions } from "../../../../engine/audio/packaging/definitions";
import { compileGlob, hasWildcard } from "../../../../engine/audio/encoding/pathGlob";
import { parseAudioProject } from "../../../../engine/audio/project/format";
import { AUDIO_PROJECT_FILE } from "../../../../engine/audio/project/types";
import { Assets, fetchAssetBytes } from "../../../../engine/scene/Assets";
import { audioBackend, hasAudioBackend, isPendingCoreBackend, onAudioBackendAttached, type AudioBackend, type AudioPacks, type AudioVoice, type PackClipHold, type PlayRequest } from "../backend";
import { setPackedSounds, streamsFromPack, type PackedSound } from "../core/packMedia";
import { warnOnce } from "../core/handle";
import { onAudioSessionReleased } from "../audioSession";
import { taps } from "../mix/profileTaps";
import { NULL_PROFILE_SINK, type ProfilePackageEvent } from "../mix/profileSink";
import { buildUrl, entryPackages, installedAudio, mediaEntry } from "./mediaTable";

/** ADR 0337 §9: a package of sounds a game loads and unloads (`Audio.package(name)`). */
export interface AudioPackage {
  readonly name: string;
  readonly state: "unloaded" | "loading" | "loaded" | "failed";
  /** 0..1 while loading (1 once loaded, 0 when unloaded). */
  readonly progress: number;
  /** Its download size for this platform, bytes (0 over the sources in the editor). */
  readonly bytes: number;
  /** What it holds in memory while loaded, bytes: decoded clips, compressed bytes, prefetch heads. */
  readonly memoryBytes: number;
  /** Reference-counted: resolves once it is loaded, rejects with the reason (an unknown name, a failed fetch). */
  load(): Promise<void>;
  /**
   * Drops one reference. The last one stops the voices of the sounds no other loaded package holds with a 50 ms fade
   * (`finish: true` lets them end first) and frees them.
   */
  unload(options?: { finish?: boolean }): void;
}

/** One row of `Audio.debug().packages`. */
export interface AudioPackageDebug {
  readonly name: string;
  readonly state: AudioPackage["state"];
  readonly refs: number;
  readonly bytes: number;
  readonly memoryBytes: number;
  readonly preload: boolean;
}

/** The fade a package unload stops its voices with, seconds (ADR 0337 §9). */
export const PACKAGE_UNLOAD_FADE = 0.05;

// --- definitions ------------------------------------------------------------------------------------------------------

interface Definition {
  readonly name: string;
  readonly preload: boolean;
  /** A build's package file URL; null over the sources. */
  readonly url: string | null;
  readonly bytes: number;
  /** Over the sources: whether the package holds the sound at `path`. A build answers from its media table. */
  holds(path: string): boolean;
}

interface Definitions {
  readonly list: readonly Definition[];
  readonly byName: ReadonlyMap<string, Definition>;
  readonly packaging: PackagingOptions;
  readonly config: EncodingConfig;
  /** From a build's media table (packaged bytes in `.mycopak` files), or over the sources. */
  readonly built: boolean;
}

/** `audio.json` as the runtime reads it (the same object until the file changes). */
let parsedFrom: { raw: unknown; platform: string; installed: unknown; defs: Definitions } | null = null;

function audioJson(): unknown {
  try {
    return Assets.has(AUDIO_PROJECT_FILE) ? Assets.get(AUDIO_PROJECT_FILE) : undefined;
  } catch {
    return undefined;
  }
}

/** Over the sources: what `def` holds, without a file list (see the header). */
function sourceHolds(def: PackageDef): (path: string) => boolean {
  const deps = audioDependencies((p) => {
    try {
      return Assets.has(p) ? Assets.get(p) : undefined;
    } catch {
      return undefined;
    }
  });
  const exact = def.include.filter((i) => !hasWildcard(i)).map((i) => i.replace(/^\/+/, ""));
  const globs = def.include.filter(hasWildcard).map(compileGlob);
  let closure: Set<string> | null = null;
  return (path) => {
    if (!closure) {
      // The exact includes and their dependencies, transitively (as `packageContents`, over what `Assets` has).
      const found = new Set(exact.filter((p) => Assets.has(p)));
      const queue = [...found];
      while (queue.length) for (const d of deps(queue.pop()!)) if (!found.has(d) && Assets.has(d)) (found.add(d), queue.push(d));
      closure = found;
    }
    return closure.has(path) || globs.some((g) => g.matches(path));
  };
}

function definitions(): Definitions {
  const raw = audioJson();
  const installed = installedAudio();
  const platform = Assets.platform;
  if (parsedFrom && parsedFrom.raw === raw && parsedFrom.platform === platform && parsedFrom.installed === installed) return parsedFrom.defs;
  const project = raw === undefined ? null : parseAudioProject(raw).project;
  const packaging = project?.packaging ?? defaultPackagingOptions();
  const config = project?.encoding ?? defaultEncodingConfig();
  let list: Definition[];
  if (installed) {
    const media = installed.audio.media;
    const holders = new Map<string, Set<string>>();
    for (const [path, entry] of Object.entries(media)) for (const name of entryPackages(entry)) (holders.get(name) ?? holders.set(name, new Set()).get(name)!).add(path);
    list = installed.audio.packages.map((p) => ({ name: p.name, preload: p.preload, url: p.url, bytes: p.bytes, holds: (path: string) => holders.get(p.name)?.has(path) ?? false }));
  } else {
    list = (project?.packages ?? []).filter((d) => shipsOn(d, platform)).map((d) => ({ name: d.name, preload: d.preload, url: null, bytes: 0, holds: sourceHolds(d) }));
  }
  const defs: Definitions = { list, byName: new Map(list.map((d) => [d.name, d])), packaging, config, built: installed !== null };
  parsedFrom = { raw, platform, installed, defs };
  return defs;
}

/** The packages holding the sound at project path `path` (a build's media table, or the definitions over the sources). */
function holdersOf(path: string): readonly string[] {
  const defs = definitions();
  if (defs.built) {
    const entry = mediaEntry(path);
    return entry ? entryPackages(entry) : [];
  }
  return defs.list.filter((d) => d.holds(path)).map((d) => d.name);
}

// --- state ------------------------------------------------------------------------------------------------------------

interface Ref {
  readonly owner: object;
  readonly world: World | null;
}

interface Clip {
  /** Loaded packages holding it. */
  readonly holders: Set<string>;
  /** Its bytes as an in-memory URL (a build's entry over a backend without packages), or null. */
  url: string | null;
  /** A `stream` entry: its loose media's URL. */
  streamUrl: string | null;
  load: LoadMode;
  /** W12: its TOC record, when a package in the backend's decoder holds it (null otherwise). */
  entry: PackEntry | null;
  /** W12: each holding package's decoder id (`AudioPacks.loadPack`). */
  readonly packs: Map<string, number>;
  /** W12: its arena hold (a `decode` or ADPCM `compressed` entry, a `stream` entry's head), or null. */
  hold: PackClipHold | null;
}

interface Pkg {
  readonly name: string;
  state: AudioPackage["state"];
  progress: number;
  /** Over a backend without packages: the TOC's estimate (a package in the decoder sums its clips, `memoryOf`). */
  memoryBytes: number;
  refs: Ref[];
  loading: Promise<void> | null;
  /** Bumped by every unload and failure, so a load that finishes afterwards is dropped. */
  generation: number;
  /** The sounds it holds while loaded. */
  paths: string[];
  /** W12: its id in the backend's decoder while it is held there, and that backend's packages. */
  packId: number | null;
  packHost: AudioPacks | null;
}

const pkgs = new Map<string, Pkg>();
const clips = new Map<string, Clip>();
/** Voices playing each packaged sound, for an unload's stop. */
const voices = new Map<string, Set<AudioVoice>>();
/** Clips whose last package went with `finish: true`: freed once their voices end. */
const finishing = new Set<string>();
let finishTimer: ReturnType<typeof setTimeout> | null = null;
/** W12: decoder packages released by an unload with `finish: true`, let go once none of `paths` is finishing. */
const packReleases: { readonly host: AudioPacks; readonly pack: number; readonly paths: readonly string[] }[] = [];
/** W12: the decoder ids handed out (one per load, never reused in a session). */
let nextPackId = 0;

function pkgOf(name: string): Pkg {
  let p = pkgs.get(name);
  if (!p) pkgs.set(name, (p = { name, state: "unloaded", progress: 0, memoryBytes: 0, refs: [], loading: null, generation: 0, paths: [], packId: null, packHost: null }));
  return p;
}

/** Whether a loaded entry lives in the clip arena: `decode`, ADPCM `compressed`, and a `stream` sound's prefetch head. */
function arenaResident(e: PackEntry): boolean {
  if (e.load === "stream") return (e.prefetch?.frames ?? 0) > 0;
  return e.load === "decode" || e.codec === "adpcm" || e.codec === "pcm";
}

/** The memory package `p` holds while loaded: its clips' arena bytes and the compressed bytes the decoder holds for it. */
function memoryOf(p: Pkg): number {
  if (p.state !== "loaded") return 0;
  if (p.packId === null) return p.memoryBytes;
  let total = 0;
  for (const path of p.paths) {
    const c = clips.get(path);
    if (!c?.entry) continue;
    if (c.hold) total += c.hold.bytes;
    else if (streamsFromPack({ load: c.entry.load, codec: c.entry.codec })) total += c.entry.bytes;
  }
  return total;
}

/** The packed sound at `path` for the core (`packMedia.ts`): the first holding package still in the decoder. */
function packedSoundOf(path: string): PackedSound | null {
  const c = clips.get(path);
  if (!c?.entry) return null;
  for (const [name, id] of c.packs) {
    if (pkgs.get(name)?.packId !== id) continue;
    const e = c.entry;
    return { pack: id, load: e.load, codec: e.codec, headFrames: e.prefetch?.frames ?? 0, url: c.streamUrl };
  }
  return null;
}
setPackedSounds(packedSoundOf);

/** W12: the installed backend's packages, once the core has loaded (null for a backend without them, or none). */
const attachWaiters: ((b: AudioBackend) => void)[] = [];
onAudioBackendAttached((b) => {
  for (const w of attachWaiters.splice(0)) w(b);
});
/** At once when a backend is installed (so a load's fetch starts in the same turn), else once the core has loaded. */
function packHostFor(): AudioPacks | null | Promise<AudioPacks | null> {
  let b: AudioBackend;
  try {
    b = audioBackend();
  } catch {
    return null;
  }
  if (isPendingCoreBackend(b)) return new Promise<AudioBackend>((resolve) => attachWaiters.push(resolve)).then((next) => next.packs ?? null);
  return b.packs ?? null;
}

function emit(name: string, event: ProfilePackageEvent, bytes: number): void {
  const sink = taps.sink;
  if (sink !== NULL_PROFILE_SINK) sink.audioPackage?.(name, event, bytes);
}

/** The runtime memory of a package entry (ADR 0337 §3; `load: "compressed"` counts its bytes, as A4 will hold them). */
function entryMemory(e: PackEntry): number {
  if (e.prefetch) return e.prefetch.frames * e.channels * 2;
  if (e.load === "compressed" && e.codec !== "pcm" && e.codec !== "source") return e.bytes;
  return e.frames * e.channels * 2;
}

/** Fetches a package file, reporting progress against its expected size. */
async function fetchPackage(url: string, expected: number, progress: (p: number) => void): Promise<Uint8Array> {
  if (typeof fetch !== "function" || url.startsWith("file:")) return fetchAssetBytes(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers?.get?.("content-length")) || expected;
  if (!res.body || total <= 0) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    progress(Math.min(0.99, got / total));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

function makeUrl(bytes: Uint8Array): string | null {
  try {
    return URL.createObjectURL(new Blob([bytes.slice()]));
  } catch {
    return null;
  }
}

function revoke(url: string | null): void {
  if (url) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // nothing held
    }
  }
}

/** Takes the clip at `path` into package `name` (with its decoder package id and TOC record when it is in the decoder). */
function holdClip(name: string, path: string, data: { url: string | null; streamUrl: string | null; load: LoadMode; entry?: PackEntry; packId?: number }): Clip {
  finishing.delete(path);
  const c = clips.get(path);
  if (c) {
    c.holders.add(name);
    if (!c.url && data.url) c.url = data.url;
    else revoke(data.url === c.url ? null : data.url);
    if (data.packId !== undefined) c.packs.set(name, data.packId);
    if (!c.entry && data.entry) c.entry = data.entry;
    if (!c.streamUrl && data.streamUrl) c.streamUrl = data.streamUrl;
    return c;
  }
  const made: Clip = { holders: new Set([name]), url: data.url, streamUrl: data.streamUrl, load: data.load, entry: data.entry ?? null, packs: new Map(data.packId !== undefined ? [[name, data.packId]] : []), hold: null };
  clips.set(path, made);
  return made;
}

/** The live voices of `path` (pruned). */
function liveVoices(path: string): AudioVoice[] {
  const set = voices.get(path);
  if (!set) return [];
  for (const v of set) {
    let alive = false;
    try {
      alive = v.alive ?? v.playing;
    } catch {
      alive = false;
    }
    if (!alive) set.delete(v);
  }
  if (set.size === 0) voices.delete(path);
  return set ? [...set] : [];
}

function freeClip(path: string): void {
  const c = clips.get(path);
  clips.delete(path);
  finishing.delete(path);
  voices.delete(path);
  revoke(c?.url ?? null);
  if (c?.hold) {
    // W12: the arena hold goes; the clip unloads one frame after its last voice let go too.
    c.hold.release();
    c.hold = null;
    return;
  }
  if (hasAudioBackend()) {
    try {
      audioBackend().clipCache?.invalidateClip(path);
    } catch {
      // a backend going away
    }
  }
}

/** W12: lets go of the decoder packages whose finishing sounds have all ended. */
function settlePackReleases(): void {
  for (let i = packReleases.length - 1; i >= 0; i--) {
    const r = packReleases[i]!;
    if (r.paths.some((p) => finishing.has(p))) continue;
    packReleases.splice(i, 1);
    releasePackSafely(r.host, r.pack);
  }
}

function releasePackSafely(host: AudioPacks, pack: number): void {
  try {
    host.releasePack(pack);
  } catch {
    // a decoder going away
  }
}

/** Frees the finishing clips whose voices have ended; polls while some remain. */
function sweepFinishing(): void {
  for (const path of [...finishing]) if (liveVoices(path).length === 0) freeClip(path);
  settlePackReleases();
  if (finishing.size > 0 && finishTimer === null) {
    finishTimer = setTimeout(() => {
      finishTimer = null;
      sweepFinishing();
    }, 250);
  }
}

/** Lets go of package `p`'s clips and state (its last reference went, or its load failed). */
function release(p: Pkg, finish: boolean): void {
  p.generation++;
  const was = p.state;
  const bytes = definitions().byName.get(p.name)?.bytes ?? 0;
  p.state = "unloaded";
  p.progress = 0;
  p.memoryBytes = 0;
  p.loading = null;
  p.refs = [];
  const packId = p.packId;
  const packHost = p.packHost;
  p.packId = null;
  p.packHost = null;
  for (const path of p.paths) {
    const c = clips.get(path);
    if (!c) continue;
    c.holders.delete(p.name);
    c.packs.delete(p.name);
    if (c.holders.size > 0) continue;
    const live = liveVoices(path);
    if (finish && live.length > 0) {
      finishing.add(path);
      continue;
    }
    for (const v of live) {
      try {
        v.stop(PACKAGE_UNLOAD_FADE);
      } catch {
        // a voice already gone
      }
    }
    freeClip(path);
  }
  // W12: the package leaves the decoder once its finishing voices have ended (at once without any).
  if (packHost && packId !== null) packReleases.push({ host: packHost, pack: packId, paths: p.paths.filter((path) => finishing.has(path)) });
  p.paths = [];
  if (was === "loaded" || was === "loading") emit(p.name, "unload", bytes);
  sweepFinishing();
}

/** The share of a package load's `progress` its fetch takes (the arena commits take the rest). */
const FETCH_SHARE = 0.8;

/** A package's bytes as an ArrayBuffer of their own (transferred to the decoder). */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
}

/**
 * W12: package `p`'s bytes into the backend's decoder (`host`), its entries registered for the core (`packMedia.ts`),
 * and its arena-resident entries committed to the clip arena; resolves once every commit is resident or failed (a
 * failed one was warned by the clip registry). `refetch` fetches the package again for a restarted decoder.
 */
async function loadIntoDecoder(p: Pkg, generation: number, host: AudioPacks, entries: readonly PackEntry[], bytes: Uint8Array, refetch: () => Promise<Uint8Array>): Promise<void> {
  const packId = ++nextPackId;
  p.packId = packId;
  p.packHost = host;
  await host.loadPack(packId, ownBuffer(bytes), () => refetch().then(ownBuffer));
  if (p.generation !== generation) return;
  const holds: PackClipHold[] = [];
  for (const e of entries) {
    const media = mediaEntry(e.path);
    const streamUrl = e.load === "stream" && media?.url ? buildUrl(media.url) : null;
    const c = holdClip(p.name, e.path, { url: null, streamUrl, load: e.load, entry: e, packId });
    if (!c.hold && arenaResident(e)) {
      try {
        c.hold = host.holdClip(e.path, e.load === "stream" ? e.prefetch!.frames : undefined);
      } catch {
        c.hold = null;
      }
    }
    if (c.hold) holds.push(c.hold);
  }
  p.paths = entries.map((e) => e.path);
  let settled = 0;
  await Promise.all(
    holds.map((h) =>
      h.settled().then(() => {
        settled++;
        if (p.generation === generation) p.progress = FETCH_SHARE + ((1 - FETCH_SHARE) * settled) / holds.length;
      }),
    ),
  );
}

/** Starts (or joins) the load of package `p`. */
function startLoad(p: Pkg, def: Definition): Promise<void> {
  if (p.state === "loaded") return Promise.resolve();
  if (p.loading) return p.loading;
  const generation = ++p.generation;
  p.state = "loading";
  p.progress = 0;
  emit(p.name, "loadStart", def.bytes);
  const run = async () => {
    const held: { path: string; url: string | null; streamUrl: string | null; load: LoadMode }[] = [];
    let memory = 0;
    if (def.url !== null) {
      const url = buildUrl(def.url);
      // The backend first (the core may still be loading): with packages, the arena commits take the end of `progress`.
      const found = packHostFor();
      const host = found instanceof Promise ? await found : found;
      if (p.generation !== generation) return;
      const share = host ? FETCH_SHARE : 1;
      const bytes = await fetchPackage(url, def.bytes, (x) => {
        if (p.generation === generation) p.progress = x * share;
      });
      const read = readAudioPack(bytes);
      if ("error" in read) throw new Error(`${def.url}: ${read.error}`);
      if (p.generation !== generation) return;
      if (host) {
        await loadIntoDecoder(p, generation, host, read.pack.toc.entries.slice(), bytes, () => fetchPackage(url, def.bytes, () => {}));
        if (p.generation !== generation) return;
        p.progress = 1;
        p.state = "loaded";
        p.loading = null;
        emit(p.name, "loaded", def.bytes);
        return;
      }
      for (const e of read.pack.toc.entries) {
        memory += entryMemory(e);
        const media = mediaEntry(e.path);
        const streamUrl = e.prefetch && media?.url ? buildUrl(media.url) : null;
        held.push({ path: e.path, url: e.prefetch ? null : makeUrl(read.pack.data(e.path)!), streamUrl, load: e.load });
      }
    }
    if (p.generation !== generation) {
      for (const h of held) revoke(h.url);
      return;
    }
    if (def.url === null) {
      // Over the sources: the sounds it holds that the runtime has seen are known lazily (`holds`); nothing to fetch.
      p.paths = [];
    } else {
      for (const h of held) holdClip(p.name, h.path, h);
      p.paths = held.map((h) => h.path);
    }
    p.memoryBytes = memory;
    p.progress = 1;
    p.state = "loaded";
    p.loading = null;
    emit(p.name, "loaded", def.bytes);
  };
  p.loading = run().catch((err: unknown) => {
    if (p.generation !== generation) return;
    const why = err instanceof Error ? err.message : String(err);
    warnOnce(`package:failed:${p.name}:${why}`, `Audio.package("${p.name}") failed to load (${why}).`);
    emit(p.name, "failed", def.bytes);
    p.generation++;
    p.state = "failed";
    p.progress = 0;
    p.loading = null;
    p.refs = [];
    // W12: a decoder load that failed holds nothing more (its entries were never registered).
    if (p.packHost && p.packId !== null) releasePackSafely(p.packHost, p.packId);
    p.packId = null;
    p.packHost = null;
    throw new Error(`Audio.package("${p.name}") failed to load: ${why}`);
  });
  return p.loading;
}

/** Adds a reference to package `name` for `owner` in `world` and loads it. Rejects for an unknown name. */
function acquire(name: string, owner: object, world: World | null): Promise<void> {
  const def = definitions().byName.get(name);
  if (!def) {
    warnOnce(`package:unknown:${name}`, `Audio.package("${name}"): there's no package by that name${definitions().list.length ? ` (packages: ${definitions().list.map((d) => d.name).join(", ")})` : " in this project"}.`);
    return Promise.reject(new Error(`Audio.package("${name}"): no package by that name`));
  }
  const p = pkgOf(name);
  p.refs.push({ owner, world });
  return startLoad(p, def);
}

/** Drops one reference `owner` holds on package `name` (any one when `owner` is null); the last one releases it. */
function drop(name: string, owner: object | null, finish: boolean): void {
  const p = pkgs.get(name);
  if (!p || p.refs.length === 0) return;
  let i = -1;
  if (owner) for (let k = p.refs.length - 1; k >= 0 && i < 0; k--) if (p.refs[k].owner === owner) i = k;
  if (i < 0 && owner === null) {
    const active = World.active;
    for (let k = p.refs.length - 1; k >= 0 && i < 0; k--) if (p.refs[k].world === active) i = k;
    if (i < 0) i = p.refs.length - 1;
  }
  if (i < 0) return;
  p.refs.splice(i, 1);
  if (p.refs.length === 0) release(p, finish);
}

// --- the handles ------------------------------------------------------------------------------------------------------

const handles = new Map<string, AudioPackage>();

/** `Audio.package(name)`: the package's handle (one per name; an unknown name's `load()` rejects, with one warning). */
export function audioPackage(name: string): AudioPackage {
  const n = String(name);
  let h = handles.get(n);
  if (!h) {
    h = {
      name: n,
      get state() { return pkgs.get(n)?.state ?? "unloaded"; },
      get progress() { return pkgs.get(n)?.progress ?? 0; },
      get bytes() { return definitions().byName.get(n)?.bytes ?? 0; },
      get memoryBytes() { const p = pkgs.get(n); return p ? memoryOf(p) : 0; },
      load() {
        const world = World.active;
        return acquire(n, world ?? PAGE, world);
      },
      unload(options) {
        drop(n, null, options?.finish === true);
      },
    };
    handles.set(n, h);
  }
  return h;
}

/** The page's own references (a script run with no World active). */
const PAGE = {};

/** `Audio.packages`: every package this build (or project) has for the platform, in `audio.json`'s order. */
export function audioPackages(): readonly AudioPackage[] {
  return definitions().list.map((d) => audioPackage(d.name));
}

/** `Audio.debug().packages`. */
export function packagesDebug(): AudioPackageDebug[] {
  return definitions().list.map((d) => {
    const p = pkgs.get(d.name);
    return { name: d.name, state: p?.state ?? "unloaded", refs: p?.refs.length ?? 0, bytes: d.bytes, memoryBytes: p ? memoryOf(p) : 0, preload: d.preload };
  });
}

// --- Worlds: preload, scene preparation, loaders ------------------------------------------------------------------------

/** The scene preparations' references, per World, until a loader adopts them. */
const prepared = new WeakMap<World, object>();
const preparedOf = (world: World) => prepared.get(world) ?? (prepared.set(world, {}), prepared.get(world)!);
/** Worlds whose preload packages are loaded (or loading). */
const preloadedWorlds = new WeakSet<World>();

/**
 * @internal Scene loading (the packages World service's `prepareScene`): the preload packages, the first time in `world`
 * (before its first scene starts), and the packages the scene's `AudioPackageLoader`s name; resolves once all are loaded.
 * A package that fails or doesn't exist doesn't stop the scene (it was warned).
 */
export async function preparePackages(world: World, names: readonly string[]): Promise<void> {
  const waits: Promise<void>[] = [];
  if (!preloadedWorlds.has(world)) {
    preloadedWorlds.add(world);
    for (const d of definitions().list) if (d.preload) waits.push(acquire(d.name, world, world));
  }
  for (const n of new Set(names)) waits.push(acquire(n, preparedOf(world), world));
  await Promise.all(waits.map((w) => w.catch(() => undefined)));
}

/**
 * @internal An `AudioPackageLoader` activating: takes a reference on each package for `owner`, adopting the one its scene's
 * preparation took when there is one.
 */
export function adoptPackages(owner: object, world: World | null, names: readonly string[]): void {
  const prep = world ? prepared.get(world) : undefined;
  for (const n of names) {
    const p = pkgs.get(n);
    const i = prep && p ? p.refs.findIndex((r) => r.owner === prep) : -1;
    if (p && i >= 0) p.refs[i] = { owner, world };
    else void acquire(n, owner, world).catch(() => undefined);
  }
}

/** @internal An `AudioPackageLoader` going: drops its references. */
export function releasePackages(owner: object, names: readonly string[]): void {
  for (const n of names) drop(n, owner, false);
}

/** @internal A World torn down: drops every reference it owned (its scripts', preparations', preload's, loaders'). */
export function releaseWorldPackages(world: World): void {
  preloadedWorlds.delete(world);
  for (const p of [...pkgs.values()]) {
    const before = p.refs.length;
    p.refs = p.refs.filter((r) => r.world !== world);
    if (before > 0 && p.refs.length === 0) release(p, false);
  }
}

// --- the strict rule, the media a play loads, voices -------------------------------------------------------------------

/** Whether some loaded package holds `path`. Over the sources a loaded package holds what its definition says. */
function loadedHolder(path: string, holders: readonly string[]): string | null {
  for (const h of holders) if (pkgs.get(h)?.state === "loaded") return h;
  return null;
}

/**
 * Why a play of the audio file `path` is refused, or null when it may play: `notLoaded` for a packaged sound whose
 * packages are all unloaded (strict; lenient warns, and in a build starts loading its first package), `failed` for media
 * the backend can't decode yet (ADPCM, Opus until A4/A7). Each warns once per sound.
 */
export function mediaRefusal(path: string): "notLoaded" | "failed" | null {
  if (!path) return null;
  const entry = mediaEntry(path);
  if (entry && (entry.codec === "adpcm" || entry.codec === "opus")) {
    const codecs = hasAudioBackend() ? audioBackend().codecs : undefined;
    if (!(entry.codec === "adpcm" ? codecs?.adpcmCompressed : codecs?.opus)) {
      warnOnce(`media:codec:${path}`, `audio: "${path}" was shipped as ${entry.codec === "adpcm" ? "ADPCM" : "Opus"}, which this audio backend can't play yet; it won't play.`);
      return "failed";
    }
  }
  const holders = holdersOf(path);
  if (holders.length === 0 || loadedHolder(path, holders)) return null;
  const defs = definitions();
  const names = holders.map((h) => `"${h}"`).join(" or ");
  if (defs.packaging.strict) {
    warnOnce(`media:notLoaded:${path}`, `audio: "${path}" is in package ${names}, which isn't loaded; it won't play. Load it first (Audio.package(${JSON.stringify(holders[0])}).load(), or an AudioPackageLoader).`);
    return "notLoaded";
  }
  warnOnce(`media:lenient:${path}`, `audio: "${path}" is in package ${names}, which isn't loaded${defs.built ? "; loading it now (this play is skipped)" : "; playing it from its file"} (packaging.strict is off).`);
  if (!defs.built) return null;
  // One on-demand load, owned by the World playing it; the plays meanwhile add no references.
  const first = pkgs.get(holders[0]);
  if (!first || first.state === "unloaded" || first.state === "failed") void acquire(holders[0], World.active ?? PAGE, World.active).catch(() => undefined);
  return "notLoaded";
}

/**
 * Why a play of playlist `path` is refused: over the sources, when the playlist itself is packaged and unloaded; in a
 * build, when every sound it names directly (through `fileOf`, a sample's audio file) is refused. Null otherwise.
 */
export function playlistRefusal(path: string, fileOf: (sample: string) => string): "notLoaded" | "failed" | null {
  if (!isPlaylistPath(path) || !Assets.has(path)) return null;
  if (!definitions().built) {
    const holders = holdersOf(path);
    if (holders.length > 0 && !loadedHolder(path, holders)) return mediaRefusal(path);
  }
  let named: string[];
  try {
    named = referencedPaths(parsePlaylistBody(Assets.json(path), path, []), "sample");
  } catch {
    return null;
  }
  let refusal: "notLoaded" | "failed" | null = null;
  for (const s of named) {
    const file = fileOf(s);
    const r = file ? mediaRefusal(file) : null;
    if (r === null) return null;
    refusal ??= r;
  }
  return refusal;
}

/** Per sidecar object: the load mode a source resolves to on a platform (editor Play's encoding settings). */
const loadModes = new WeakMap<object, { config: EncodingConfig; platform: string; load: LoadMode }>();

/**
 * @internal The clip resolver: the URL and stream rule a play of the audio file `path` loads (its import settings at
 * `settingsPath`); null to keep `Assets`' URL and the import setting. A build's packaged sound plays its in-memory bytes
 * (or its loose streamed media); a converted sound streams when its load mode says so. Over the sources a file whose
 * encoding settings resolve to `load: "stream"` streams.
 */
export function mediaSource(path: string, settingsPath: string): { url: string | null; stream: boolean } | null {
  const entry = mediaEntry(path);
  if (entry) {
    const c = clips.get(path);
    // W12: a `compressed` Vorbis or Opus sound in the decoder plays through a stream ring from the decoder's copy.
    const stream = entry.load === "stream" || (c?.entry != null && c.packs.size > 0 && streamsFromPack(c.entry));
    if (stream && entry.url) return { url: buildUrl(entry.url), stream };
    return { url: c?.url ?? null, stream };
  }
  if (installedAudio()) return null;
  const settings = Assets.importSettings(settingsPath);
  if (settings.encoding === null && definitions().config.default === null && definitions().config.rules.length === 0) return null;
  const config = definitions().config;
  const platform = Assets.platform;
  const hit = loadModes.get(settings);
  let load: LoadMode;
  if (hit && hit.config === config && hit.platform === platform) load = hit.load;
  else {
    load = resolveEncoding({ path: settingsPath, encoding: settings.encoding, legacyStream: settings.stream }, platform, config).settings.load;
    loadModes.set(settings, { config, platform, load });
  }
  return load === "stream" ? { url: null, stream: true } : null;
}

/**
 * @internal Every clip play (`playSampleVoice`, the playlist runtime): plays `req` unless its sound is refused
 * (`mediaRefusal`: null then), and keeps the voice of a packaged sound so an unload can stop it.
 */
export function mediaPlay(req: PlayRequest): AudioVoice | null {
  if (mediaRefusal(req.path) !== null) return null;
  const voice = audioBackend().play(req);
  if (voice && clips.has(req.path)) {
    let set = voices.get(req.path);
    if (!set) voices.set(req.path, (set = new Set()));
    set.add(voice);
  } else if (voice && !definitions().built && holdersOf(req.path).length > 0) {
    // Over the sources a loaded package's sounds are known as they play.
    const holders = holdersOf(req.path).filter((h) => pkgs.get(h)?.state === "loaded");
    for (const h of holders) {
      const p = pkgs.get(h)!;
      if (!p.paths.includes(req.path)) p.paths.push(req.path);
      holdClip(h, req.path, { url: null, streamUrl: null, load: "decode" });
    }
    let set = voices.get(req.path);
    if (!set) voices.set(req.path, (set = new Set()));
    set.add(voice);
  }
  return voice;
}

/** The audio session's release (ADR 0218): every package unloaded, every clip and reference dropped. */
function reset(): void {
  for (const c of clips.values()) {
    revoke(c.url);
    try {
      c.hold?.release();
    } catch {
      // its backend went with the session
    }
  }
  clips.clear();
  voices.clear();
  finishing.clear();
  if (finishTimer !== null) clearTimeout(finishTimer);
  finishTimer = null;
  // W12: the decoder worker is the page's and outlives the session: it lets go of every package.
  for (const r of packReleases.splice(0)) releasePackSafely(r.host, r.pack);
  for (const p of pkgs.values()) {
    p.generation++;
    if (p.packHost && p.packId !== null) releasePackSafely(p.packHost, p.packId);
  }
  pkgs.clear();
  parsedFrom = null;
}
onAudioSessionReleased(reset);
