/**
 * How long an audio file plays, in seconds, read from its headers without decoding: WAV (`fmt ` and `data`, through
 * `readWavMetadata`), FLAC (STREAMINFO), Ogg Vorbis and Ogg Opus (the last page's granule position) and MP3 (a Xing,
 * Info or VBRI frame count, else the constant bitrate over the audio bytes). Undefined when the file isn't one of those
 * or its headers don't say; never throws. The migration uses it for the samples' lengths (ADR 0343 §"Migration").
 *
 * Pure; no plugin, no DOM.
 */
import { readWavMetadata } from "../sample/wavChunks";

const ascii = (b: Uint8Array, at: number, n: number): string => (at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : "");
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u32le = (b: Uint8Array, at: number): number => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0);
const u16le = (b: Uint8Array, at: number): number => b[at] + (b[at + 1] << 8);

const positive = (s: number): number | undefined => (Number.isFinite(s) && s > 0 ? s : undefined);

/** The length of an ID3v2 tag at `at` (header included), or 0. FLAC and MP3 files may start with one. */
function id3Length(b: Uint8Array, at = 0): number {
  if (ascii(b, at, 3) !== "ID3" || b.length < at + 10) return 0;
  const size = ((b[at + 6] & 0x7f) << 21) | ((b[at + 7] & 0x7f) << 14) | ((b[at + 8] & 0x7f) << 7) | (b[at + 9] & 0x7f);
  const footer = b[at + 5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

function wavSeconds(b: Uint8Array): number | undefined {
  const m = readWavMetadata(b);
  return m.frames !== null && m.sampleRate !== null ? positive(m.frames / m.sampleRate) : undefined;
}

function flacSeconds(b: Uint8Array): number | undefined {
  const start = id3Length(b);
  if (ascii(b, start, 4) !== "fLaC") return undefined;
  const d = start + 8; // STREAMINFO is always the first metadata block; its body follows a 4-byte block header
  if ((b[start + 4] & 0x7f) !== 0 || b.length < d + 18) return undefined;
  const rate = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
  const total = (b[d + 13] & 0x0f) * 2 ** 32 + u32be(b, d + 14);
  return rate > 0 && total > 0 ? positive(total / rate) : undefined;
}

/** The granule position of the last Ogg page whose capture pattern and version check out. */
function lastGranule(b: Uint8Array): number | undefined {
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] !== 0x4f || ascii(b, i, 4) !== "OggS" || b[i + 4] !== 0) continue;
    const lo = u32le(b, i + 6), hi = u32le(b, i + 10);
    if (hi === 0xffffffff && lo === 0xffffffff) continue; // -1: no packet ends on this page
    return hi * 2 ** 32 + lo;
  }
  return undefined;
}

function oggSeconds(b: Uint8Array): number | undefined {
  if (ascii(b, 0, 4) !== "OggS" || b.length < 28) return undefined;
  const body = 27 + b[26]; // the first page's header and segment table
  const granule = lastGranule(b);
  if (granule === undefined) return undefined;
  if (b[body] === 1 && ascii(b, body + 1, 6) === "vorbis") {
    const rate = u32le(b, body + 12);
    return rate > 0 ? positive(granule / rate) : undefined;
  }
  if (ascii(b, body, 8) === "OpusHead") return positive((granule - u16le(b, body + 10)) / 48000); // Opus granules are 48 kHz, after the pre-skip
  return undefined;
}

// MPEG audio: bitrates (kbit/s) by [version is MPEG-1][layer index], sample rates by version.
const BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface MpegFrame { at: number; mpeg1: boolean; layer: number; bitrate: number; rate: number; mono: boolean; samples: number }

function mpegFrame(b: Uint8Array, at: number): MpegFrame | undefined {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return undefined;
  const version = (b[at + 1] >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
  const layer = 4 - ((b[at + 1] >> 1) & 3);
  const bitIndex = b[at + 2] >> 4, rateIndex = (b[at + 2] >> 2) & 3;
  if (version === 1 || layer === 4 || bitIndex === 15 || rateIndex === 3) return undefined;
  const mpeg1 = version === 3;
  const bitrate = BITRATES[`${mpeg1 ? 1 : 2}-${layer}`][bitIndex] * 1000;
  const rate = RATES[version][rateIndex];
  const samples = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152;
  return { at, mpeg1, layer, bitrate, rate, mono: (b[at + 3] >> 6) === 3, samples };
}

function mp3Seconds(b: Uint8Array): number | undefined {
  let at = id3Length(b);
  // The first frame: a sync whose next frame (by its length) also syncs, within the first 64 KiB.
  let frame: MpegFrame | undefined;
  for (const end = Math.min(b.length, at + 65536); at < end; at++) {
    const f = mpegFrame(b, at);
    if (!f || f.bitrate === 0) continue;
    const pad = (b[at + 2] >> 1) & 1;
    const length = f.layer === 1 ? (Math.floor((12 * f.bitrate) / f.rate) + pad) * 4 : Math.floor(((f.samples / 8) * f.bitrate) / f.rate) + pad;
    if (at + length + 4 <= b.length && !mpegFrame(b, at + length)) continue;
    frame = f;
    break;
  }
  if (!frame) return undefined;
  // Xing/Info sits after the side information; VBRI 32 bytes after the header.
  const side = frame.mpeg1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xing = frame.at + 4 + side;
  const tag = ascii(b, xing, 4);
  if ((tag === "Xing" || tag === "Info") && b[xing + 7] & 1) return positive((u32be(b, xing + 8) * frame.samples) / frame.rate);
  if (ascii(b, frame.at + 36, 4) === "VBRI") return positive((u32be(b, frame.at + 36 + 14) * frame.samples) / frame.rate);
  const end = b.length >= 128 && ascii(b, b.length - 128, 3) === "TAG" ? b.length - 128 : b.length;
  return positive(((end - frame.at) * 8) / frame.bitrate);
}

/** Seconds of audio in `bytes`, by the file's own headers (the extension is not trusted); undefined when unknown. */
export function audioFileSeconds(bytes: Uint8Array): number | undefined {
  try {
    if (ascii(bytes, 0, 4) === "RIFF") return wavSeconds(bytes);
    if (ascii(bytes, 0, 4) === "OggS") return oggSeconds(bytes);
    if (ascii(bytes, id3Length(bytes), 4) === "fLaC") return flacSeconds(bytes);
    return mp3Seconds(bytes);
  } catch {
    return undefined;
  }
}

/** File endings `audioFileSeconds` can read. */
export const TIMED_AUDIO_EXTENSIONS: readonly string[] = [".wav", ".wave", ".flac", ".ogg", ".oga", ".opus", ".mp3"];
