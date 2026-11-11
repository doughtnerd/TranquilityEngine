/**
 * Import hints (ADR 0166 §2.7, task Ed9): pure byte-layout readers for the tempo, cue and loop hints a music file
 * carries. The editor reads them when a clip is added to a segment and writes them into the event once as
 * suggestions (the event file stays authoritative); `import.ts` turns them into tempo markers and cues.
 *
 * WAV (RIFF/WAVE): `acid` (tempo, beats, metre), `cue ` (cue points) with `LIST`/`adtl` `labl` labels, `smpl` (loops).
 * Ogg (Vorbis, Opus, Ogg FLAC) comments: `BPM`, `LOOPSTART`, `LOOPLENGTH`. The Ogg container walk is
 * `oggComments` of `runtime/loopPointsReader.ts` (reused, not edited); the `smpl` reader here returns every loop,
 * where the runtime one returns only the first forward loop.
 *
 * Every function is pure, total and never throws on any input (garbage, truncation, huge counts): a field that runs
 * past its chunk drops that field, never the whole result. All positions are sample frames, `end` exclusive.
 *
 * Skeleton by the Ed9 lead; bodies tagged `L-Ed9` are filled by leaf L-Ed9 (tests: `importHints.test.ts`).
 */

import { oggComments, type CommentPair } from "../../runtime/loopPointsReader";

// --- types ------------------------------------------------------------------------------------------------------------

/** RIFF `acid` chunk, the ACID loop metadata (`readAcid`). */
export interface AcidHint {
  /** Tempo in beats per minute (a finite float > 0); the chunk's `tempo` field. */
  bpm: number;
  /** Length of the loop in beats (`numBeats`); 0 when the file doesn't say. */
  beats: number;
  /** Metre numerator (beats per bar); 0 when the file doesn't say. */
  meterNumerator: number;
  /** Metre denominator (the beat unit); 0 when the file doesn't say. */
  meterDenominator: number;
  /** The one-shot flag (bit 0 of `flags`): the file is not meant to loop. */
  oneShot: boolean;
}

/** One `cue ` point: its id and the frame it sits on (`sampleOffset`). */
export interface CuePoint {
  id: number;
  frame: number;
}

/** A cue point with its `LIST adtl` `labl` text, when there is one. */
export interface LabelledCue extends CuePoint {
  /** The label, or `""` when none. */
  label: string;
}

/** One `smpl` loop; `end` is exclusive (the file's inclusive end plus one). */
export interface SmplLoop {
  start: number;
  end: number;
  /** The file's loop type: 0 forward, 1 alternating (ping-pong), 2 backward; others as stored. */
  type: number;
  /** 0 = forever, else the stored play count. */
  playCount: number;
}

/** Everything one WAV file hints. Fields are absent or empty when the chunk is missing or malformed. */
export interface WavHints {
  /** From `fmt `: sample rate in Hz (absent when `fmt ` is missing or the rate is 0). */
  rate?: number;
  /** From `fmt ` and `data`: total frames, when both chunks are intact. */
  frames?: number;
  acid?: AcidHint;
  /** Cue points in file order, labelled from `LIST adtl`. */
  cues: LabelledCue[];
  /** Every well-formed loop of `smpl`, in file order. */
  loops: SmplLoop[];
}

/** What Ogg comments hint: `BPM` and the loop pair. */
export interface OggHints {
  /** `BPM` (plain decimal, a finite number > 0; a fraction is allowed, `"128.5"`). */
  bpm?: number;
  /** `LOOPSTART` and `LOOPLENGTH`, both present and valid: the loop in frames, `end` exclusive (start + length). */
  loop?: { start: number; end: number };
}

/** The union the editor consumes: what the file said, by container. */
export interface ImportHints {
  /** `"wav"` for RIFF/WAVE, `"ogg"` for OggS, `"none"` for anything else (MP3, FLAC, garbage, empty). */
  container: "wav" | "ogg" | "none";
  wav?: WavHints;
  ogg?: OggHints;
}

// --- readers ----------------------------------------------------------------------------------------------------------

/**
 * Read all hints of a whole file: `RIFF....WAVE` -> `readWavHints`, `OggS` -> `readOggHints`, else `container: "none"`.
 * Never throws.
 */
export function readImportHints(bytes: Uint8Array): ImportHints {
  // L-Ed9: dispatch on the first bytes as `readLoopPoints` does; wrap in try/catch and return `{ container: "none" }`.
  void bytes;
  return { container: "none" };
}

/**
 * Walk a whole RIFF/WAVE file's chunks once (4-byte id, u32 LE size, body, one pad byte after an odd size) and
 * collect `fmt `, `data`, `acid`, `cue `, `LIST adtl` and `smpl`. A chunk whose declared size runs past the end of
 * `bytes` ends the walk (its own body is not read, except that `data` still counts its available frames); the first
 * `acid`, `cue ` and `smpl` win. Returns empty `cues` and `loops` for a file that isn't RIFF/WAVE.
 */
export function readWavHints(bytes: Uint8Array): WavHints {
  // L-Ed9: the chunk walk; call readAcid, readCuePoints, readAdtlLabels, readSmplLoops on the bodies; join labels to cues by id.
  void bytes;
  return { cues: [], loops: [] };
}

/**
 * The body of an `acid` chunk (24 bytes, little-endian):
 *
 *   off  size  field
 *     0   u32  flags: 0x01 one-shot, 0x02 root note set, 0x04 stretch, 0x08 disk-based, 0x10 acidized
 *     4   u16  root note (MIDI)
 *     6   u16  unknown
 *     8   f32  unknown
 *    12   u32  numBeats (beats in the file)
 *    16   u16  meter denominator
 *    18   u16  meter numerator
 *    20   f32  tempo (bpm)
 *
 * Null when the body is under 24 bytes or the tempo is not a finite number > 0. `beats`, `meterNumerator` and
 * `meterDenominator` come through as stored (0 = not said; no clamping beyond that).
 */
export function readAcid(body: Uint8Array): AcidHint | null {
  // L-Ed9: DataView at the offsets above, little-endian; Math.fround-exact float read.
  void body;
  return null;
}

/**
 * The body of a `cue ` chunk: u32 count, then 24-byte records
 *
 *   off  size  field
 *     0   u32  id
 *     4   u32  position (play order, ignored)
 *     8   4cc  data chunk id (ignored)
 *    12   u32  chunk start (ignored)
 *    16   u32  block start (ignored)
 *    20   u32  sample offset: the frame
 *
 * Whole records only: read min(count, floor((len - 4) / 24)) of them, in file order. A body under 4 bytes is `[]`.
 */
export function readCuePoints(body: Uint8Array): CuePoint[] {
  // L-Ed9
  void body;
  return [];
}

/**
 * The body of a `LIST` chunk of form type `adtl` (bytes after the chunk's id and size): the 4 bytes `adtl`, then
 * sub-chunks (4cc, u32 LE size, body, pad to even). For each `labl` sub-chunk with a body of at least 4 bytes: u32
 * cue id, then the label text, UTF-8, ending at the first NUL or the end of the body. `note` sub-chunks are read the
 * same way and used only when the cue has no `labl`; `ltxt` and unknown sub-chunks are skipped. The first label of
 * an id wins. A body that isn't `adtl` (or a sub-chunk running past the body) gives what was read so far.
 */
export function readAdtlLabels(body: Uint8Array): Map<number, string> {
  // L-Ed9
  void body;
  return new Map();
}

/**
 * The body of a `smpl` chunk (little-endian):
 *
 *   off  size  field
 *     0   u32  manufacturer
 *     4   u32  product
 *     8   u32  sample period (ns)
 *    12   u32  MIDI unity note
 *    16   u32  MIDI pitch fraction
 *    20   u32  SMPTE format
 *    24   u32  SMPTE offset
 *    28   u32  numSampleLoops
 *    32   u32  sampler data size
 *    36 + 24*i  loop i: u32 cuePointId, u32 type, u32 start, u32 end (INCLUSIVE), u32 fraction, u32 playCount
 *
 * Every loop with `end >= start` and `end + 1 <= 0xFFFFFFFF`, as `{ start, end: end + 1, type, playCount }`, in file
 * order; read at most numSampleLoops records, whole records only; a body under 36 bytes is `[]`. Unlike the runtime
 * reader (`smplLoopPoints`), loops of any type are returned.
 */
export function readSmplLoops(body: Uint8Array): SmplLoop[] {
  // L-Ed9
  void body;
  return [];
}

/**
 * Hints of a whole Ogg file: `oggComments(bytes)` (imported from the runtime reader; do not re-implement the page
 * walk) passed to `commentHints`. `{}` when there are no comments.
 */
export function readOggHints(bytes: Uint8Array): OggHints {
  // L-Ed9: commentHints(oggComments(bytes)), wrapped in try/catch returning {}.
  void bytes;
  void oggComments;
  return {};
}

/**
 * Hints from a comment list. Keys match case-insensitively over ASCII; the first of each key wins even if its value
 * doesn't parse. `BPM`: ASCII whitespace trimmed, a plain decimal (`^[0-9]+(\.[0-9]+)?$`), finite and > 0, else no
 * `bpm`. `LOOPSTART` and `LOOPLENGTH`: plain ASCII-decimal u32 (trimmed, no sign), length > 0, start + length at most
 * 0xFFFFFFFF; both must be valid for `loop` (same rules as `commentLoopPoints`, whose result this equals).
 */
export function commentHints(comments: readonly CommentPair[]): OggHints {
  // L-Ed9
  void comments;
  return {};
}
