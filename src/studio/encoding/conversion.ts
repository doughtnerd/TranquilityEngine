// Converting one sound for one platform on demand in the Studio (ADR 0337 §6, 0345 §3): the Samples Inspector's exact
// sizes and Hear as. A planned sound (`studioPlan.ts`) is read, keyed by content hash (`audioCacheKey`: the encoder's
// version, the resolved settings and what they ship as, and the input bytes, the export's own key), looked up in memory,
// then in the project's `.myco/cache/audio/` in the export's layout (`<key>.json` facts beside `<key>.<ext>` bytes), and
// only then decoded and encoded on the injected pool (the browser pool, at most two at once). A conversion fills the same
// cache the export reads, so a later export of that sound is a hit (§5 step 3). Requests for one key share one run.
//
// The seams: the project's bytes, the source decoder (the game's decoder, `src/export/audioDecode.ts`), the encoder pool
// and the cache store. Tests give fakes; `studioEncoding.ts` gives the real ones.
import { AUDIO_CACHE_DIR, audioCacheKey, type AudioCacheStore, type DecodeAudio, type PlannedSound } from "../../export/audio";
import type { AudioEncoder } from "../../export/audioEncoder";
import type { ShippedCodec } from "../../engine/audio/encoding/types";
import type { PackCodec } from "../../engine/audio/packaging/format";

/** One sound converted for one platform. */
export interface ConvertedSound {
  /** The cache key (64 hex digits). */
  readonly key: string;
  readonly codec: PackCodec;
  /** What ships: the encoded bytes, or the source's own when it ships as its source. */
  readonly bytes: Uint8Array;
  readonly rate: number;
  readonly channels: number;
  readonly frames: number;
  readonly sourceBytes: number;
  /** Found in the cache (memory or disk) rather than encoded now. */
  readonly cached: boolean;
  /** Fallbacks the conversion took (Opus on more than two channels). */
  readonly notes: readonly string[];
}

export interface ConversionSeams {
  /** A project file's bytes (rejects when it can't be read). */
  read(path: string): Promise<Uint8Array>;
  decode: DecodeAudio;
  /** The pool (made on first use). */
  encoder(): AudioEncoder;
  cache: AudioCacheStore;
}

export interface Conversions {
  /** Convert `sound` (a plan's) as it ships; shares a run with any request for the same content and settings. */
  convert(sound: PlannedSound): Promise<ConvertedSound>;
}

/** The export's cache file endings (`src/export/audio.ts`). */
export const CACHE_EXT: Readonly<Record<ShippedCodec, string>> = { pcm: "wav", adpcm: "adpcm", vorbis: "ogg", opus: "opus" };

interface CachedFacts {
  codec: PackCodec;
  rate: number;
  channels: number;
  frames: number;
}

const text = new TextDecoder();
const encodeText = new TextEncoder();

/** The encode settings of a planned sound shipped as `codec` (null: shipped as its source). */
function requestOf(sound: PlannedSound, codec: ShippedCodec | "source") {
  if (codec === "source") return null;
  const s = sound.resolution.settings;
  return { codec, quality: s.quality, rateCeiling: s.sampleRate === "source" ? null : s.sampleRate, mono: s.channels === "mono" && !sound.ambisonic };
}

export function createConversions(seams: ConversionSeams): Conversions {
  const memory = new Map<string, ConvertedSound>();
  const running = new Map<string, Promise<ConvertedSound>>();

  const fromCache = async (key: string, input: Uint8Array): Promise<ConvertedSound | null> => {
    const raw = await seams.cache.read(`${AUDIO_CACHE_DIR}/${key}.json`).catch(() => null);
    if (!raw) return null;
    let facts: CachedFacts;
    try {
      facts = JSON.parse(text.decode(raw)) as CachedFacts;
    } catch {
      return null;
    }
    const bytes = facts.codec === "source" ? input : await seams.cache.read(`${AUDIO_CACHE_DIR}/${key}.${CACHE_EXT[facts.codec]}`).catch(() => null);
    if (!bytes) return null;
    return { key, codec: facts.codec, bytes, rate: facts.rate, channels: facts.channels, frames: facts.frames, sourceBytes: input.length, cached: true, notes: [] };
  };

  const run = async (sound: PlannedSound, input: Uint8Array, key: string): Promise<ConvertedSound> => {
    const hit = await fromCache(key, input);
    if (hit) return hit;
    const decoded = await seams.decode(input, sound.path);
    const notes: string[] = [];
    let codec = sound.codec;
    if (codec === "opus" && decoded.channels > 2) {
      notes.push(`Opus takes mono and stereo only; this ${decoded.channels}-channel file ships as Vorbis.`);
      codec = "vorbis";
    }
    const frames = Math.floor(decoded.pcm.length / Math.max(1, decoded.channels));
    let out: Omit<ConvertedSound, "key" | "sourceBytes" | "cached" | "notes"> = { codec: "source", bytes: input, rate: decoded.sampleRate, channels: decoded.channels, frames };
    const req = requestOf(sound, codec);
    if (req) {
      const enc = await seams.encoder().encode({ ...req, pcm: decoded.pcm, channels: decoded.channels, sampleRate: decoded.sampleRate });
      out = { codec: enc.codec, bytes: enc.bytes, rate: enc.sampleRate, channels: enc.channels, frames: enc.frames };
    }
    try {
      if (out.codec !== "source") await seams.cache.write(`${AUDIO_CACHE_DIR}/${key}.${CACHE_EXT[out.codec]}`, out.bytes);
      const facts: CachedFacts = { codec: out.codec, rate: out.rate, channels: out.channels, frames: out.frames };
      await seams.cache.write(`${AUDIO_CACHE_DIR}/${key}.json`, encodeText.encode(JSON.stringify(facts)));
    } catch {
      // a cache that can't be written (a read-only folder): the result still stands for this session
    }
    return { key, ...out, sourceBytes: input.length, cached: false, notes };
  };

  return {
    async convert(sound) {
      const input = await seams.read(sound.path);
      const req = requestOf(sound, sound.codec);
      const key = await audioCacheKey(input, sound.resolution.settings, sound.codec, req?.mono ?? false);
      const known = memory.get(key);
      if (known) return { ...known, cached: true };
      let p = running.get(key);
      if (!p) {
        p = run(sound, input, key).then(
          (r) => {
            memory.set(key, r);
            running.delete(key);
            return r;
          },
          (err: unknown) => {
            running.delete(key);
            throw err;
          },
        );
        running.set(key, p);
      }
      return p;
    },
  };
}
