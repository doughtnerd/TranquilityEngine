// ADR 0351 §7, A4: the `.mycopak` packages the decoder worker holds. Main loads a package once (`packLoad`, its bytes
// transferred); the worker reads it with the A1 reader (`engine/audio/packaging/format.ts`) and keeps it, so each entry is
// a view into it, never a copy, until it is used:
// - a `decode` entry, or any entry `decodeClip` names with `pack`, decodes to the core's int16 clip (`clips.ts`);
// - an `adpcm` entry with load `compressed` goes to the core as clip format 6, its blocks unchanged (`adpcmClip`): the
//   core decodes it per voice;
// - a `compressed` Vorbis or Opus entry stays here, compressed, and plays through a stream ring (`streamOpen` with
//   `pack`; `streams.ts` copies the entry into the wasm when the stream opens, as it does a streamed file's bytes).
// Pure apart from the store's map: no wasm, no posting.
import { readAudioPack, type AudioPack, type PackEntry } from "../../../../engine/audio/packaging/format";
import { hintFromName, type ClipInfo, type DecodeHint } from "./protocol";

/** An entry the store holds: its TOC record and its bytes (a view into the package). */
export interface HeldEntry {
  readonly entry: PackEntry;
  readonly data: Uint8Array;
}

/** The `ClipInfo.codec` code of the engine's own IMA ADPCM (beside the decoder's 0-6). */
export const CODEC_ADPCM = 7;

/** The packages one worker holds, by the id main gave each. */
export class PackStore {
  private readonly packs = new Map<number, { readonly pack: AudioPack; readonly bytes: number }>();

  /** Reads and holds `bytes` as package `id` (replacing one held under it): its entry count, or the reader's one-line error. */
  load(id: number, bytes: ArrayBuffer): { readonly entries: number; readonly bytes: number } | { readonly error: string } {
    const read = readAudioPack(new Uint8Array(bytes));
    if ("error" in read) return { error: `audio decoder: package ${id}: ${read.error}` };
    this.packs.set(id, { pack: read.pack, bytes: bytes.byteLength });
    return { entries: read.pack.toc.entries.length, bytes: bytes.byteLength };
  }

  /** Drops package `id`. Unknown ids are ignored. */
  release(id: number): void {
    this.packs.delete(id);
  }

  /** Entry `path` of package `id`, or null when either isn't held. */
  entry(id: number, path: string): HeldEntry | null {
    const held = this.packs.get(id);
    if (!held) return null;
    const entry = held.pack.toc.entries.find((e) => e.path === path);
    const data = held.pack.data(path);
    return entry && data ? { entry, data } : null;
  }

  /** Bytes held across packages. */
  get bytes(): number {
    let total = 0;
    for (const p of this.packs.values()) total += p.bytes;
    return total;
  }
}

/**
 * The decoder's container hint for an entry's bytes: `pcm` is 16-bit WAV, Vorbis and Opus are Ogg, `source` the project
 * file unchanged (hinted by its path's extension; the probe reads the content either way). Not for `adpcm`, which the
 * decoder's file path doesn't read (`adpcmClip`, `DecoderWasm.decodeAdpcm`).
 */
export function entryHint(entry: PackEntry): DecodeHint {
  switch (entry.codec) {
    case "pcm":
      return 1;
    case "vorbis":
    case "opus":
      return 4;
    default:
      return hintFromName(entry.path);
  }
}

/** The info a held ADPCM entry reports: its TOC's rate, channels and frames, exact; `clipFormat` 6 when it stays compressed. */
export function adpcmInfo(entry: PackEntry, compressed: boolean): ClipInfo {
  return { rate: entry.rate, channels: entry.channels, frames: entry.frames, framesEstimate: entry.frames, codec: CODEC_ADPCM, lengthKnown: true, ...(compressed ? { clipFormat: 6 as const } : {}) };
}

/**
 * ADR 0351 A4: an ADPCM entry cut into pieces of whole blocks for `clipChunk`s: each of at most `maxFrames` frames (a whole
 * number of blocks), the last ending at the entry's frames. Throws when the entry holds fewer blocks than its frames need or
 * has a channel count the core's format 6 refuses (only 1 or 2).
 */
export function adpcmPieces(entry: PackEntry, data: Uint8Array, blockFrames: number, channelBytes: number, maxFrames: number): Uint8Array[] {
  if (entry.channels < 1 || entry.channels > 2) throw new Error(`audio decoder: "${entry.path}" is ADPCM with ${entry.channels} channels; ADPCM is mono or stereo`);
  const blockBytes = channelBytes * entry.channels;
  const blocks = Math.ceil(entry.frames / blockFrames);
  if (entry.frames <= 0 || data.length < blocks * blockBytes) throw new Error(`audio decoder: "${entry.path}" holds ${data.length} bytes, fewer than ${blocks} ADPCM blocks of ${blockBytes}`);
  const perPiece = Math.max(1, Math.floor(maxFrames / blockFrames));
  const pieces: Uint8Array[] = [];
  for (let b = 0; b < blocks; b += perPiece) pieces.push(data.subarray(b * blockBytes, Math.min(blocks, b + perPiece) * blockBytes));
  return pieces;
}
