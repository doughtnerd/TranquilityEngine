/**
 * Internal (ADR 0351 §7, A1): the `.mycopak` package file, written by the export and read by the decoder worker.
 *
 * ```
 * audio/packages/<name>.mycopak
 *   "MYCOPAK1"  u32 tocBytes (little-endian)  TOC (UTF-8 JSON, tocBytes long)  zero padding  entries
 * ```
 *
 * Every entry starts on a 16-byte boundary (so a worker can view it in place or transfer it as a slice); `offset` is from
 * the start of the file. The TOC:
 *
 * ```jsonc
 * { "format": "myco.audiopack@1", "name": "Forest", "platform": "web",
 *   "entries": [{ "path": "audio/amb/birds.wav", "offset": 4096, "bytes": 18211, "codec": "vorbis", "rate": 32000,
 *                 "channels": 2, "frames": 961000, "load": "decode", "hash": "…", "prefetch": null }] }
 * ```
 *
 * A `stream` sound's media ships loose (`audio/stream/<hash>.<ext>`); its entry holds only the prefetch head, with
 * `prefetch: { frames }`. Pure: bytes in, bytes out.
 */
import type { ImportPlatform } from "../../scene/importSettings";
import { ENCODING_PLATFORMS } from "../encoding/defaults";
import { LOAD_MODES, type LoadMode, type ShippedCodec } from "../encoding/types";

export const PACK_MAGIC = "MYCOPAK1";
export const PACK_FORMAT = "myco.audiopack@1";
export const PACK_EXTENSION = ".mycopak";
/** Entry alignment, bytes. */
export const PACK_ALIGN = 16;
const HEADER_BYTES = PACK_MAGIC.length + 4;

/** What an entry's bytes are: a shipped codec, or `source` (the project file's bytes unchanged; the decoder sniffs them). */
export type PackCodec = ShippedCodec | "source";
const PACK_CODECS: readonly PackCodec[] = ["pcm", "adpcm", "vorbis", "opus", "source"];

/** One entry's TOC record. */
export interface PackEntry {
  /** The project path the sound is known by. */
  path: string;
  offset: number;
  bytes: number;
  codec: PackCodec;
  rate: number;
  channels: number;
  /** Frames per channel the sound decodes to (Opus: pre-skip excluded). */
  frames: number;
  load: LoadMode;
  /** The conversion's cache key (hex). */
  hash: string;
  /** A `stream` sound's head: the frames held here; null for a whole sound. */
  prefetch: { frames: number } | null;
}

/** The TOC. */
export interface PackToc {
  format: typeof PACK_FORMAT;
  name: string;
  platform: ImportPlatform;
  entries: PackEntry[];
}

/** One entry to write: its record (without `offset` and `bytes`) and its bytes. */
export interface PackInput {
  entry: Omit<PackEntry, "offset" | "bytes">;
  data: Uint8Array;
}

const align = (n: number) => Math.ceil(n / PACK_ALIGN) * PACK_ALIGN;

/** Writes a package. Entries keep the given order; a path given twice is refused (throws: a caller bug, not data). */
export function writeAudioPack(name: string, platform: ImportPlatform, inputs: readonly PackInput[]): Uint8Array {
  const seen = new Set<string>();
  for (const i of inputs) {
    if (seen.has(i.entry.path)) throw new Error(`writeAudioPack: "${i.entry.path}" is in package "${name}" twice`);
    seen.add(i.entry.path);
  }
  const encoder = new TextEncoder();
  // The TOC's length depends on the offsets it records, which depend on its length: settle it (a few rounds at most).
  let tocBytes = 0;
  let toc: Uint8Array = new Uint8Array(0);
  let entries: PackEntry[] = [];
  for (let round = 0; round < 8; round++) {
    let at = align(HEADER_BYTES + tocBytes);
    entries = inputs.map((i) => {
      const e: PackEntry = { path: i.entry.path, offset: at, bytes: i.data.length, codec: i.entry.codec, rate: i.entry.rate, channels: i.entry.channels, frames: i.entry.frames, load: i.entry.load, hash: i.entry.hash, prefetch: i.entry.prefetch ? { frames: i.entry.prefetch.frames } : null };
      at = align(at + i.data.length);
      return e;
    });
    toc = encoder.encode(JSON.stringify({ format: PACK_FORMAT, name, platform, entries } satisfies PackToc));
    if (toc.length === tocBytes) break;
    tocBytes = toc.length;
  }
  const last = entries[entries.length - 1];
  const total = last ? last.offset + last.bytes : HEADER_BYTES + toc.length;
  const out = new Uint8Array(total);
  out.set(encoder.encode(PACK_MAGIC), 0);
  new DataView(out.buffer).setUint32(PACK_MAGIC.length, toc.length, true);
  out.set(toc, HEADER_BYTES);
  inputs.forEach((i, k) => out.set(i.data, entries[k].offset));
  return out;
}

/** A read package: its TOC and each entry's bytes (views into the given bytes, no copies). */
export interface AudioPack {
  toc: PackToc;
  /** The bytes of the entry at `path`, or null. */
  data(path: string): Uint8Array | null;
}

/** `PACK_FORMAT`'s version number. */
const PACK_FORMAT_VERSION = 1;

/** ADR 0386: a package from a newer build is refused as newer, naming both versions, never as damaged. */
const newerPack = (theirs: string, mine: string): string => `incompatible version: file is ${theirs}, this build reads ${mine}: update Myco to open it`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isWhole = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;

/** Reads a package: `{ pack }`, or `{ error }` (one line) when it isn't a readable `.mycopak`. Never throws. */
export function readAudioPack(bytes: Uint8Array): { pack: AudioPack } | { error: string } {
  const magic = bytes.length < HEADER_BYTES ? "" : new TextDecoder().decode(bytes.subarray(0, PACK_MAGIC.length));
  const magicVersion = /^MYCOPAK([2-9])$/.exec(magic);
  if (magicVersion) return { error: newerPack(`MYCOPAK${magicVersion[1]}`, PACK_MAGIC) };
  if (magic !== PACK_MAGIC) return { error: "not a .mycopak file (no MYCOPAK1 header)" };
  const tocBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(PACK_MAGIC.length, true);
  if (HEADER_BYTES + tocBytes > bytes.length) return { error: `the table of contents runs past the end (${tocBytes} bytes)` };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + tocBytes)));
  } catch {
    return { error: "the table of contents isn't UTF-8 JSON" };
  }
  const formatVersion = isRecord(raw) && typeof raw.format === "string" ? /^myco\.audiopack@([1-9][0-9]*)$/.exec(raw.format) : null;
  if (formatVersion && Number(formatVersion[1]) > PACK_FORMAT_VERSION) return { error: newerPack(formatVersion[0], PACK_FORMAT) };
  if (!isRecord(raw) || raw.format !== PACK_FORMAT) return { error: `the table of contents isn't ${PACK_FORMAT}` };
  if (typeof raw.name !== "string" || !(ENCODING_PLATFORMS as readonly unknown[]).includes(raw.platform) || !Array.isArray(raw.entries)) return { error: "the table of contents lacks a name, a platform or entries" };
  const entries: PackEntry[] = [];
  const byPath = new Map<string, PackEntry>();
  const dataStart = HEADER_BYTES + tocBytes;
  for (const [i, e] of raw.entries.entries()) {
    const bad = (why: string) => ({ error: `entry ${i}: ${why}` });
    if (!isRecord(e) || typeof e.path !== "string" || e.path === "") return bad("needs a path");
    if (!isWhole(e.offset) || !isWhole(e.bytes) || e.offset % PACK_ALIGN !== 0 || e.offset < dataStart || e.offset + e.bytes > bytes.length) return bad(`"${e.path}" lies outside the file or off the ${PACK_ALIGN}-byte grid`);
    if (!(PACK_CODECS as readonly unknown[]).includes(e.codec) || !(LOAD_MODES as readonly unknown[]).includes(e.load)) return bad(`"${e.path}" has an unknown codec or load mode`);
    if (!isWhole(e.rate, 1) || !isWhole(e.channels, 1) || !isWhole(e.frames) || typeof e.hash !== "string") return bad(`"${e.path}" lacks its rate, channels, frames or hash`);
    let prefetch: PackEntry["prefetch"] = null;
    if (e.prefetch !== null && e.prefetch !== undefined) {
      if (!isRecord(e.prefetch) || !isWhole(e.prefetch.frames)) return bad(`"${e.path}" has a malformed prefetch`);
      prefetch = { frames: e.prefetch.frames };
    }
    if (byPath.has(e.path)) return bad(`"${e.path}" is listed twice`);
    const entry: PackEntry = { path: e.path, offset: e.offset, bytes: e.bytes, codec: e.codec as PackCodec, rate: e.rate, channels: e.channels, frames: e.frames, load: e.load as LoadMode, hash: e.hash, prefetch };
    entries.push(entry);
    byPath.set(e.path, entry);
  }
  const toc: PackToc = { format: PACK_FORMAT, name: raw.name, platform: raw.platform as ImportPlatform, entries };
  return { pack: { toc, data: (path) => { const e = byPath.get(path); return e ? bytes.subarray(e.offset, e.offset + e.bytes) : null; } } };
}
