/**
 * Internal (ADR 0337 §2, A1): the engine's built-in encoding defaults per platform, the limits of the encoding numbers
 * (declared once, here; the parse applies them, ADR 0306) and the source-type rule `codec: "auto"` follows.
 */
import type { ImportPlatform } from "../../scene/importSettings";
import type { ResolvedEncoding, ShippedCodec, EncodingCodec } from "./types";

/** The platforms encoding settings can differ on: `ImportPlatform`'s, listed here so this module imports no values. */
export const ENCODING_PLATFORMS = ["web", "desktop", "android"] as const satisfies readonly ImportPlatform[];
// Compile-time check: every ImportPlatform is listed.
const _everyPlatform: Exclude<ImportPlatform, (typeof ENCODING_PLATFORMS)[number]> extends never ? true : never = true;
void _everyPlatform;

/** The limits of the encoding numbers. */
export const ENCODING_LIMITS = Object.freeze({
  quality: [0, 1] as const,
  prefetchMs: [0, 2000] as const,
  /** Profiles in one project. */
  profiles: 64,
  /** Folder rules in one project. */
  rules: 256,
  /** Budget megabytes. */
  budgetMB: [0, 100_000] as const,
});

/** Quality by platform when nothing sets it: 0.6 desktop, 0.5 web, 0.4 Android. */
const QUALITY: Record<ImportPlatform, number> = { desktop: 0.6, web: 0.5, android: 0.4 };

/**
 * The built-in settings for `platform`: `codec: auto`, `load: decode`, `sampleRate: source`, `channels: source`,
 * `prefetchMs: 0`, and the platform's quality. So a project with no encoding settings ships its lossy files unchanged and
 * its WAV/FLAC/AIFF files as Vorbis.
 */
export function builtinEncoding(platform: ImportPlatform): ResolvedEncoding {
  return { codec: "auto", quality: QUALITY[platform], sampleRate: "source", channels: "source", load: "decode", prefetchMs: 0 };
}

/** Lossless source formats, by extension: `auto` converts them to Vorbis. */
const LOSSLESS = new Set(["wav", "wave", "flac", "aif", "aiff", "aifc"]);

/**
 * What a file with the resolved `codec` ships as: a shipped codec, or `"source"` (copied unchanged). `auto` converts
 * lossless sources (WAV, FLAC, AIFF, by extension) to Vorbis and ships anything else (MP3, Ogg, M4A…) as it is.
 */
export function shippedCodec(codec: EncodingCodec, path: string): ShippedCodec | "source" {
  if (codec !== "auto") return codec;
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return LOSSLESS.has(ext) ? "vorbis" : "source";
}
