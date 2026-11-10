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

/**
 * The loop points stored in a whole audio file: `RIFF` -> {@link wavLoopPoints}; `OggS` ->
 * {@link oggComments} then {@link commentLoopPoints}; anything else (MP3, MP4, empty, garbage) null.
 */
export function readLoopPoints(bytes: Uint8Array): LoopFrames | null {
  void bytes; // L4.2a
  throw new Error("L4.2a");
}

/**
 * Loop points of a whole RIFF/WAVE file. Rules (same as Rust `wav_loop_points`): starts `RIFF`, a 4-byte size
 * (ignored), `WAVE`; chunks follow as a 4-byte id, a little-endian u32 size and the body, padded to an even length.
 * Walk until the first `smpl` chunk and pass its body to {@link smplLoopPoints}. A chunk whose declared size runs
 * past the end of `bytes` ends the walk (a truncated `smpl` is malformed: null). Only `RIFF` (not `RIFX`/`RF64`).
 */
export function wavLoopPoints(bytes: Uint8Array): LoopFrames | null {
  void bytes; // L4.2a
  throw new Error("L4.2a");
}

/**
 * Loop points from the body of one `smpl` chunk (bytes after its id and size). 36-byte header, numSampleLoops
 * (u32 LE) at offset 28, then 24-byte records (cuePointId, type, start, end, fraction, playCount). First record of
 * type 0 (forward) with end >= start wins, result `{start, end: end + 1}` (skip the record if end + 1 exceeds
 * 0xFFFFFFFF). Stop at the first record that would run past the body (earlier complete records still count), and
 * read at most numSampleLoops records. Body under 36 bytes or no qualifying record: null.
 */
export function smplLoopPoints(body: Uint8Array): LoopFrames | null {
  void body; // L4.2a
  throw new Error("L4.2a");
}

/**
 * Loop points from a comment list. Keys `LOOPSTART` and `LOOPLENGTH` match case-insensitively (ASCII); the first of
 * each wins even if its value does not parse; values are plain ASCII-decimal u32 (no sign, surrounding ASCII
 * whitespace trimmed). Result `{start, end: start + length}`. Null when either key is missing, a value is not a
 * decimal u32, the length is 0, or the sum exceeds 0xFFFFFFFF.
 */
export function commentLoopPoints(comments: readonly CommentPair[]): LoopFrames | null {
  void comments; // L4.2a
  throw new Error("L4.2a");
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
  void bytes; // L4.2a
  throw new Error("L4.2a");
}
