// ADR 0158 §4: reads loop points stored inside an audio file, for the Babylon fallback (which has no Rust decoder).
// A TypeScript port of native/audio/crates/audio-decode/src/loop_points.rs plus the Ogg comment-header reader that
// Rust got from symphonia. Pure functions over bytes, no dependencies, and none of them throws on any input.
// Every result is in sample frames with `end` exclusive (the first frame after the loop), or null when there is no
// usable loop. Not clamped to the clip length (the caller knows it; the Rust decoder clamps).
//
// E4.2 skeleton: bodies are filled by leaf L4.2a.

/** A loop region in sample frames; `end` is exclusive. Both are integers in 0..=0xFFFFFFFF. */
export interface LoopFrames {
  readonly start: number;
  readonly end: number;
}

/** A Vorbis/Opus comment, split at the first `=`: `[key, value]`. */
export type CommentPair = readonly [key: string, value: string];

const MAX_U32 = 0xffffffff;
const MAX_COMMENT_PACKET_BYTES = 4 * 1024 * 1024;
const VORBIS_IDENTIFICATION = [0x01, ...asciiCodes("vorbis")];
const VORBIS_COMMENT_HEADER = [0x03, ...asciiCodes("vorbis")];
const OPUS_HEAD = asciiCodes("OpusHead");
const OPUS_TAGS = asciiCodes("OpusTags");

/**
 * The loop points stored in a whole audio file: `RIFF` -> {@link wavLoopPoints}; `OggS` ->
 * {@link oggComments} then {@link commentLoopPoints}; anything else (MP3, MP4, empty, garbage) null.
 */
export function readLoopPoints(bytes: Uint8Array): LoopFrames | null {
  try {
    if (startsWithAscii(bytes, "RIFF")) return wavLoopPoints(bytes);
    if (startsWithAscii(bytes, "OggS")) return commentLoopPoints(oggComments(bytes));
    return null;
  } catch {
    return null;
  }
}

/**
 * Loop points of a whole RIFF/WAVE file. Rules (same as Rust `wav_loop_points`): starts `RIFF`, a 4-byte size
 * (ignored), `WAVE`; chunks follow as a 4-byte id, a little-endian u32 size and the body, padded to an even length.
 * Walk until the first `smpl` chunk and pass its body to {@link smplLoopPoints}. A chunk whose declared size runs
 * past the end of `bytes` ends the walk (a truncated `smpl` is malformed: null). Only `RIFF` (not `RIFX`/`RF64`).
 */
export function wavLoopPoints(bytes: Uint8Array): LoopFrames | null {
  if (bytes.length < 12 || !startsWithAscii(bytes, "RIFF") || !matchesAscii(bytes, 8, "WAVE")) return null;
  let pos = 12;
  for (;;) {
    if (pos + 8 > bytes.length) return null;
    const isSmpl = matchesAscii(bytes, pos, "smpl");
    const size = readU32(bytes, pos + 4);
    const bodyStart = pos + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.length) return null;
    if (isSmpl) return smplLoopPoints(bytes.subarray(bodyStart, bodyEnd));
    // Odd-sized bodies are followed by one pad byte.
    pos = bodyEnd + (size % 2);
  }
}

/**
 * Loop points from the body of one `smpl` chunk (bytes after its id and size). 36-byte header, numSampleLoops
 * (u32 LE) at offset 28, then 24-byte records (cuePointId, type, start, end, fraction, playCount). First record of
 * type 0 (forward) with end >= start wins, result `{start, end: end + 1}` (skip the record if end + 1 exceeds
 * 0xFFFFFFFF). Stop at the first record that would run past the body (earlier complete records still count), and
 * read at most numSampleLoops records. Body under 36 bytes or no qualifying record: null.
 */
export function smplLoopPoints(body: Uint8Array): LoopFrames | null {
  if (body.length < 36) return null;
  const count = readU32(body, 28);
  if (count === 0) return null;
  // Whole records only: a trailing partial record is never read.
  const available = Math.floor((body.length - 36) / 24);
  const records = Math.min(count, available);
  for (let i = 0; i < records; i++) {
    const at = 36 + i * 24;
    const type = readU32(body, at + 4);
    const start = readU32(body, at + 8);
    const end = readU32(body, at + 12);
    if (type !== 0 || end < start) continue;
    const exclusiveEnd = end + 1;
    if (exclusiveEnd > MAX_U32) continue;
    return { start, end: exclusiveEnd };
  }
  return null;
}

/**
 * Loop points from a comment list. Keys `LOOPSTART` and `LOOPLENGTH` match case-insensitively (ASCII); the first of
 * each wins even if its value does not parse; values are plain ASCII-decimal u32 (no sign, surrounding ASCII
 * whitespace trimmed). Result `{start, end: start + length}`. Null when either key is missing, a value is not a
 * decimal u32, the length is 0, or the sum exceeds 0xFFFFFFFF.
 */
export function commentLoopPoints(comments: readonly CommentPair[]): LoopFrames | null {
  let startText: string | undefined;
  let lengthText: string | undefined;
  for (const [key, value] of comments) {
    const upper = asciiUpper(key);
    if (upper === "LOOPSTART") startText ??= value;
    else if (upper === "LOOPLENGTH") lengthText ??= value;
  }
  if (startText === undefined || lengthText === undefined) return null;
  const start = parseFrames(startText);
  const length = parseFrames(lengthText);
  if (start === null || length === null || length === 0) return null;
  const end = start + length;
  if (end > MAX_U32) return null;
  return { start, end };
}

/**
 * The user comments of an Ogg Vorbis, Opus or Ogg FLAC file, split at the first `=` (a comment without `=` is
 * dropped). Empty array when `bytes` isn't Ogg, the comment header is missing, or it is malformed or truncated.
 *
 * Layout: pages start `OggS`, version 0, header type, 8-byte granule, 4-byte serial, 4-byte page sequence, 4-byte
 * CRC (ignore it), 1-byte segment count N, N lacing bytes, then the segment data. A packet is the concatenation of
 * segments until one with lacing value < 255; it may span pages (a continued page has header-type bit 0x01) and
 * pages of other logical streams (different serial) are ignored: follow the first stream's serial. The first
 * packet identifies the codec: Vorbis `0x01 "vorbis"`, Opus `"OpusHead"`. The second packet is the comment header:
 * Vorbis `0x03 "vorbis"`, Opus `"OpusTags"`, then a u32 LE vendor length and vendor string, a u32 LE comment count,
 * then per comment a u32 LE length and that many UTF-8 bytes (`KEY=value`). Vorbis has a trailing framing bit
 * (ignore). Cap the work: stop after the declared count, after 4 MiB of comment packet, or at the end of the
 * bytes, whichever is first.
 */
export function oggComments(bytes: Uint8Array): CommentPair[] {
  // Packets are read only up to the comment header, so the walk stops there. Any structural fault
  // (bad page, a truncated page, a lost continuation) makes the whole result empty.
  let serial: number | null = null;
  let codec: "vorbis" | "opus" | null = null;
  let packetIndex = 0;
  let inPacket = false;
  let pieces: Uint8Array[] = [];
  let pieceBytes = 0;
  let pos = 0;

  while (pos < bytes.length) {
    if (pos + 27 > bytes.length) return [];
    if (!matchesAscii(bytes, pos, "OggS") || bytes[pos + 4] !== 0) return [];
    const headerType = bytes[pos + 5];
    const pageSerial = readU32(bytes, pos + 14);
    const segmentCount = bytes[pos + 26];
    const lacingStart = pos + 27;
    const dataStart = lacingStart + segmentCount;
    if (dataStart > bytes.length) return [];
    let dataLength = 0;
    for (let i = 0; i < segmentCount; i++) dataLength += bytes[lacingStart + i];
    const pageEnd = dataStart + dataLength;
    if (pageEnd > bytes.length) return [];

    if (serial === null) serial = pageSerial;
    if (pageSerial !== serial) {
      pos = pageEnd;
      continue;
    }
    const continued = (headerType & 0x01) !== 0;
    if (continued !== inPacket) return [];

    let cursor = dataStart;
    for (let i = 0; i < segmentCount; i++) {
      const lacing = bytes[lacingStart + i];
      if (lacing > 0) {
        pieces.push(bytes.subarray(cursor, cursor + lacing));
        pieceBytes += lacing;
        if (pieceBytes > MAX_COMMENT_PACKET_BYTES) return [];
      }
      cursor += lacing;
      if (lacing < 255) {
        const packet = concatBytes(pieces, pieceBytes);
        pieces = [];
        pieceBytes = 0;
        inPacket = false;
        const done = handlePacket(packet);
        if (done !== undefined) return done;
      } else {
        inPacket = true;
      }
    }
    pos = pageEnd;
  }
  return [];

  // Returns the comments once the comment header is complete, `undefined` while more packets are needed, and
  // `[]` when the packet is not a supported header.
  function handlePacket(packet: Uint8Array): CommentPair[] | undefined {
    if (packetIndex === 0) {
      packetIndex = 1;
      if (startsWithBytes(packet, VORBIS_IDENTIFICATION)) codec = "vorbis";
      else if (startsWithBytes(packet, OPUS_HEAD)) codec = "opus";
      else return [];
      return undefined;
    }
    const prefix = codec === "vorbis" ? VORBIS_COMMENT_HEADER : OPUS_TAGS;
    if (!startsWithBytes(packet, prefix)) return [];
    return parseCommentHeader(packet, prefix.length);
  }
}

// ---- helpers ----

/** Reads a little-endian u32 at `at`; the caller has checked that four bytes are there. */
function readU32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000;
}

/** True when `bytes` holds the ASCII `text` at `at`. */
function matchesAscii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function startsWithAscii(bytes: Uint8Array, text: string): boolean {
  return matchesAscii(bytes, 0, text);
}

function asciiCodes(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[i] !== expected[i]) return false;
  }
  return true;
}

/** Upper-cases ASCII letters only, so comparing with an upper-case key is case-insensitive over ASCII. */
function asciiUpper(text: string): string {
  return text.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Parses a decimal sample-frame count: plain ASCII digits only (no sign), after trimming ASCII whitespace
 * (space, tab, LF, FF, CR), and within u32. Null when it is not one.
 */
function parseFrames(text: string): number | null {
  const trimmed = text.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "");
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_U32 ? value : null;
}

function concatBytes(pieces: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/**
 * Parses a comment header packet after its codec prefix: vendor length and string, comment count, then the
 * comments. Any field that runs past the packet makes the whole header malformed (`[]`).
 */
function parseCommentHeader(packet: Uint8Array, prefixLength: number): CommentPair[] {
  let pos = prefixLength;
  if (pos + 4 > packet.length) return [];
  const vendorLength = readU32(packet, pos);
  pos += 4 + vendorLength;
  if (pos + 4 > packet.length) return [];
  const declared = readU32(packet, pos);
  pos += 4;

  const decoder = new TextDecoder("utf-8");
  const comments: CommentPair[] = [];
  for (let i = 0; i < declared; i++) {
    if (pos + 4 > packet.length) return [];
    const length = readU32(packet, pos);
    pos += 4;
    if (pos + length > packet.length) return [];
    const text = decoder.decode(packet.subarray(pos, pos + length));
    pos += length;
    const equals = text.indexOf("=");
    if (equals >= 0) comments.push([text.slice(0, equals), text.slice(equals + 1)] as const);
  }
  return comments;
}
