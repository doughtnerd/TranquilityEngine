// What a sound ships as and takes at runtime for one platform before it is converted (ADR 0337 §6: "exact once cached,
// else an estimate from bitrate × length, marked ≈"), and the runtime memory rule of its load mode (§3), which the
// export's report uses too. Pure.
//
// Bitrates are nominal: Vorbis by libvorbis's quality table (44.1 kHz stereo; mono ≈ 0.6 of it, lower rates in
// proportion), Opus 16 + 112 × quality kb/s per stereo pair (§2), PCM 16-bit, ADPCM the core's block layout (1,024 frames
// per channel in 516 bytes). A sound shipped as its source ships its own bytes.
import type { LoadMode, ResolvedEncoding, ShippedCodec } from "../../engine/audio/encoding/types";
import type { PackCodec } from "../../engine/audio/packaging/format";

/** What is known of a source: its size, and once read (peaks or a decode) its length and layout. */
export interface SourceFacts {
  readonly bytes: number;
  /** Frames per channel, rate and channels: null until read. */
  readonly frames: number | null;
  readonly rate: number | null;
  readonly channels: number | null;
}

/** A sound as it ships for one platform. */
export interface ShippedFigures {
  readonly codec: PackCodec;
  readonly rate: number;
  readonly channels: number;
  readonly frames: number;
  /** Download bytes. */
  readonly bytes: number;
  /** Runtime bytes by its load mode (`runtimeMemory`). */
  readonly memoryBytes: number;
  /** True once converted (or shipped as its source, whose size is known); false for an estimate. */
  readonly exact: boolean;
}

/** libvorbis's nominal bitrates at q −1…10 for 44.1 kHz stereo, kb/s; index = q + 1 (`quality × 10`). */
const VORBIS_KBPS = [48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500];
/** The core's ADPCM block: frames per channel and bytes per channel (`ADPCM_BLOCK_FRAMES`, `ADPCM_CHANNEL_BYTES`). */
const ADPCM_FRAMES = 1024;
const ADPCM_BYTES = 516;
/** Container and header bytes: Ogg headers and pages, a WAV header. */
const OGG_OVERHEAD = 4096;
const WAV_HEADER = 44;

/** Vorbis kb/s for `quality` (0..1), interpolated in libvorbis's table, for `channels` at `rate`. */
export function vorbisKbps(quality: number, channels: number, rate: number): number {
  const q = Math.min(10, Math.max(0, quality * 10)) + 1;
  const lo = Math.floor(q), hi = Math.min(VORBIS_KBPS.length - 1, lo + 1);
  const stereo = VORBIS_KBPS[lo]! + (VORBIS_KBPS[hi]! - VORBIS_KBPS[lo]!) * (q - lo);
  const layout = channels <= 1 ? 0.6 : channels / 2;
  return stereo * layout * Math.min(1.1, Math.max(0.35, rate / 44100));
}

/** Opus kb/s for `quality` (0..1): 16 + 112 × quality per stereo pair; mono ≈ 0.6 of a pair. */
export function opusKbps(quality: number, channels: number): number {
  const pair = 16 + 112 * Math.min(1, Math.max(0, quality));
  return pair * (channels <= 1 ? 0.6 : channels / 2);
}

/**
 * The runtime memory of a sound (ADR 0337 §3): `decode` holds int16 PCM in the clip arena; `compressed` holds its
 * shipped bytes (PCM: its samples); `stream` holds its prefetch head (`prefetchFrames` of int16).
 */
export function runtimeMemory(load: LoadMode, codec: PackCodec, frames: number, channels: number, bytes: number, prefetchFrames: number): number {
  if (load === "stream") return Math.min(frames, prefetchFrames) * channels * 2;
  if (load === "compressed" && codec !== "pcm" && codec !== "source") return bytes;
  return frames * channels * 2;
}

/**
 * What a sound with `facts` ships as with `codec` (what the plan placed: a shipped codec or `source`) under `settings`:
 * its rate (the ceiling, never upsampled; Opus 48 kHz), channels (mono unless `ambisonic`), frames at that rate, bytes and
 * memory. Null while the source's length isn't known, unless it ships as its source (its size is then its download).
 */
export function estimateShipped(facts: SourceFacts, codec: ShippedCodec | "source", settings: ResolvedEncoding, ambisonic: boolean): ShippedFigures | null {
  const known = facts.frames !== null && facts.rate !== null && facts.channels !== null && facts.rate > 0;
  if (!known) {
    if (codec !== "source") return null;
    return { codec, rate: 0, channels: 0, frames: 0, bytes: facts.bytes, memoryBytes: settings.load === "compressed" ? facts.bytes : 0, exact: false };
  }
  const srcRate = facts.rate!, srcChannels = facts.channels!, srcFrames = facts.frames!;
  let shipped: ShippedCodec | "source" = codec;
  if (shipped === "opus" && srcChannels > 2) shipped = "vorbis";
  const ceiling = settings.sampleRate === "source" ? srcRate : Math.min(srcRate, settings.sampleRate);
  const rate = shipped === "source" ? srcRate : shipped === "opus" ? 48000 : ceiling;
  const channels = shipped !== "source" && settings.channels === "mono" && !ambisonic ? 1 : srcChannels;
  const frames = Math.round((srcFrames * rate) / srcRate);
  const seconds = srcFrames / srcRate;
  let bytes: number;
  switch (shipped) {
    case "source": bytes = facts.bytes; break;
    case "pcm": bytes = frames * channels * 2 + WAV_HEADER; break;
    case "adpcm": bytes = Math.ceil(frames / ADPCM_FRAMES) * channels * ADPCM_BYTES; break;
    case "vorbis": bytes = Math.round((vorbisKbps(settings.quality, channels, rate) * 1000 * seconds) / 8) + OGG_OVERHEAD; break;
    case "opus": bytes = Math.round((opusKbps(settings.quality, channels) * 1000 * seconds) / 8) + OGG_OVERHEAD; break;
  }
  const prefetch = Math.round((settings.prefetchMs / 1000) * rate);
  return { codec: shipped, rate, channels, frames, bytes, memoryBytes: runtimeMemory(settings.load, shipped, frames, channels, bytes, prefetch), exact: shipped === "source" };
}

/** Bytes as "1.2 MB", "340 KB", "812 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** A figure for display: exact, or marked "≈". */
export const figureText = (bytes: number, exact: boolean): string => `${exact ? "" : "≈ "}${formatBytes(bytes)}`;
