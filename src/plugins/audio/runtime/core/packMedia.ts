// ADR 0337 §7 (W12 package integration): where the core finds a sound that a loaded package holds. The package registry
// (`media/packages.ts`) installs the resolver when it loads; the clip registry and the stream manager read it through
// `clipPackRef` and `streamPackRef` (their default `packRef`), and the stream manager through `packedMediaUrl` (a
// packaged `stream` sound's loose media). Without a resolver (editor Play over sources, a build with no packages, tests
// that never load one) every lookup answers null and sounds load from their project files as before.
import type { LoadMode } from "../../../../engine/audio/encoding/types";
import type { PackCodec } from "../../../../engine/audio/packaging/format";
import type { PackRef } from "../decoder/protocol";

/** A sound a loaded package holds, as the package registry knows it. */
export interface PackedSound {
  /** The decoder's id of a loaded package holding it (`DecoderClient.loadPack`). */
  readonly pack: number;
  /** Its entry's load mode: `decode` and `compressed` ADPCM live in the clip arena, `compressed` Vorbis/Opus in the decoder, `stream` loose. */
  readonly load: LoadMode;
  readonly codec: PackCodec;
  /** A `stream` sound: the frames of the prefetch head its package entry holds (16-bit PCM), else 0. */
  readonly headFrames: number;
  /** A `stream` sound: its loose media's URL, else null. */
  readonly url: string | null;
}

let resolver: ((path: string) => PackedSound | null) | null = null;

/** @internal The package registry: answers which loaded package holds a path (null removes the resolver). */
export function setPackedSounds(next: ((path: string) => PackedSound | null) | null): void {
  resolver = next;
}

/** The loaded package entry holding the sound at project path `path`, or null. */
export function packedSound(path: string): PackedSound | null {
  return resolver ? resolver(path) : null;
}

/**
 * The clip registry's `packRef`: every packaged entry decodes from its package (a `decode` entry to int16, an ADPCM
 * `compressed` one as clip format 6 blocks, a `stream` entry's prefetch head to int16).
 */
export function clipPackRef(path: string): PackRef | null {
  const s = packedSound(path);
  return s ? { pack: s.pack, path } : null;
}

/** Whether a packaged sound plays from the decoder's copy through a stream ring: `compressed` Vorbis or Opus. */
export const streamsFromPack = (s: Pick<PackedSound, "load" | "codec">): boolean => s.load === "compressed" && (s.codec === "vorbis" || s.codec === "opus" || s.codec === "source");

/** The stream manager's `packRef`: a `compressed` Vorbis or Opus entry streams from the decoder's copy; a `stream` entry is fetched. */
export function streamPackRef(path: string): PackRef | null {
  const s = packedSound(path);
  return s && streamsFromPack(s) ? { pack: s.pack, path } : null;
}

/** A packaged `stream` sound's loose media URL (fetched instead of its project path), or null. */
export function packedMediaUrl(path: string): string | null {
  const s = packedSound(path);
  return s && s.load === "stream" ? s.url : null;
}
