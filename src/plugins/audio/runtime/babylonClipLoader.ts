/**
 * The clip loader of the Babylon fallback (ADR 0157 BB1, ADR 0162 §8, ADR 0360 §8): a play request in, a buffer a
 * `StaticSound` can play out, each kind cached so repeated plays don't fetch or render again.
 *
 * - A plain clip is decoded by Babylon (`createSoundBufferAsync`), once per URL.
 * - An ambisonic clip (ADR 0162 §8) is decoded with `decodeAudioData` and its channel 0 (W) handed over as a mono
 *   `AudioBuffer`, once per URL (a streamed one decodes too: HTML5 audio downmixes 4 or 16 channels unpredictably). A clip
 *   that decodes to more than `AMBISONIC_DECODE_LIMIT_BYTES` is refused (null) with one warning.
 * - A generator (ADR 0360 §8) is rendered by the offline module at the context's rate (a finite generator to its end, an
 *   endless one 2 s looped with a 50 ms crossfade) as a mono `AudioBuffer`, cached by patch and seed, at most
 *   `GENERATOR_CACHE_RENDERS` renders (the least recently used goes).
 *
 * A failed load is forgotten, so the next play tries again. Every loaded clip's length is kept by asset path: the
 * backend's `clipCache.clipDuration` answers from it (ADR 0179: the fallback's clip cache is durations only).
 */
import type { AudioEngineV2 } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import type { StaticSoundBuffer } from "@babylonjs/core/AudioV2/abstractAudio/staticSoundBuffer";
import type { GeneratorSource } from "./backend";
import { AMBISONIC_DECODE_LIMIT_BYTES, decodedBytes } from "./babylonMapping";

/** What the loader is asked for: a `PlayRequest`'s clip fields. */
export interface ClipLoadRequest {
  /** The asset path (durations are kept by it; warnings name it). */
  readonly path: string;
  readonly url: string;
  readonly ambisonic?: boolean;
  readonly generator?: GeneratorSource;
}

/** What the loader uses of the context: decoding and making buffers at its rate. */
export type ClipLoaderContext = Pick<BaseAudioContext, "decodeAudioData" | "createBuffer" | "sampleRate">;

/** ADR 0360 §8: the generator renders kept (a render is ≈ 0.2 MB a second at 48 kHz). */
const GENERATOR_CACHE_RENDERS = 64;

/** A generator render's cache key: the kind, the resolved values (the patch) and the seed. */
const generatorKey = (g: GeneratorSource): string => `${g.kind}|${g.seed >>> 0}|${g.values.join(",")}`;

export class BabylonClipLoader {
  /** Decoded clips by URL. */
  private readonly decoded = new Map<string, Promise<StaticSoundBuffer>>();
  /** Ambisonic clips' channel 0 as a mono buffer, by URL (null: refused, already warned). */
  private readonly wChannels = new Map<string, Promise<AudioBuffer | null>>();
  /** Generator renders by `generatorKey`, least recently used first. */
  private readonly renders = new Map<string, Promise<AudioBuffer>>();
  /** Loaded clip lengths in seconds by asset path. */
  private readonly durations = new Map<string, number>();

  constructor(
    private readonly engine: Pick<AudioEngineV2, "createSoundBufferAsync">,
    private readonly context: ClipLoaderContext,
  ) {}

  /**
   * The buffer that plays `req`: a generator's render, an ambisonic clip's W channel, or the decoded clip. Null for an
   * ambisonic clip over the decode limit (warned once). Rejects when the load fails.
   */
  async load(req: ClipLoadRequest): Promise<StaticSoundBuffer | AudioBuffer | null> {
    const buffer = req.generator ? await this.render(req.generator) : req.ambisonic === true ? await this.wChannel(req.url, req.path) : await this.decode(req.url);
    if (buffer !== null && Number.isFinite(buffer.duration)) this.durations.set(req.path, buffer.duration);
    return buffer;
  }

  /** Decode a plain clip ahead of its play (music warms a group's stems at admit); a failure is left to the play. */
  warm(url: string): void {
    this.decode(url).catch(() => {});
  }

  /** A loaded clip's length in seconds, null before it loaded. */
  duration(path: string): number | null {
    return this.durations.get(path) ?? null;
  }

  /** How many plain clips are decoded or decoding (`debug().core.buffers`). */
  get decodedClips(): number {
    return this.decoded.size;
  }

  /** Forget every clip (the engine is going). */
  clear(): void {
    this.decoded.clear();
    this.wChannels.clear();
    this.renders.clear();
    this.durations.clear();
  }

  private decode(url: string): Promise<StaticSoundBuffer> {
    return cached(this.decoded, url, () => this.engine.createSoundBufferAsync(url));
  }

  private wChannel(url: string, path: string): Promise<AudioBuffer | null> {
    return cached(this.wChannels, url, () => this.decodeW(url, path));
  }

  private async decodeW(url: string, path: string): Promise<AudioBuffer | null> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const decoded = await this.context.decodeAudioData(await response.arrayBuffer());
    const bytes = decodedBytes(decoded.length, decoded.numberOfChannels);
    if (bytes > AMBISONIC_DECODE_LIMIT_BYTES) {
      console.warn(`[myco] audio: "${path}" is an ambisonic clip that decodes to ${(bytes / 1e6).toFixed(0)} MB, over the Babylon audio fallback's ${AMBISONIC_DECODE_LIMIT_BYTES / 1e6} MB limit; not played (ADR 0162).`);
      return null;
    }
    const mono = this.context.createBuffer(1, decoded.length, decoded.sampleRate);
    mono.copyToChannel(decoded.getChannelData(0), 0);
    return mono;
  }

  private render(g: GeneratorSource): Promise<AudioBuffer> {
    const key = generatorKey(g);
    const hit = this.renders.get(key);
    if (hit) {
      // Most recently used last.
      this.renders.delete(key);
      this.renders.set(key, hit);
      return hit;
    }
    const buffer = cached(this.renders, key, () => this.renderGenerator(g));
    while (this.renders.size > GENERATOR_CACHE_RENDERS) this.renders.delete(this.renders.keys().next().value!);
    return buffer;
  }

  private async renderGenerator(g: GeneratorSource): Promise<AudioBuffer> {
    const { renderResolvedGenerator } = await import("../../../engine/audio/generators/generatorRender");
    const r = await renderResolvedGenerator({ kind: g.kind, values: [...g.values], seed: g.seed }, { rate: this.context.sampleRate, loop: "buffer" });
    const buffer = this.context.createBuffer(1, Math.max(1, r.frames), r.rate);
    buffer.copyToChannel(r.pcm as Float32Array<ArrayBuffer>, 0);
    return buffer;
  }
}

/** The promise `cache` holds for `key`, made by `make` the first time; a rejected one is dropped so the next call retries. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
    const made = p;
    made.catch(() => {
      if (cache.get(key) === made) cache.delete(key);
    });
  }
  return p;
}
