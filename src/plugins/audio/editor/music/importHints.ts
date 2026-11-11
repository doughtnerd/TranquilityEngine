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
  try {
    if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WAVE")) {
      return { container: "wav", wav: readWavHints(bytes) };
    }
    if (matchesAscii(bytes, 0, "OggS")) return { container: "ogg", ogg: readOggHints(bytes) };
  } catch {
    // fall through: a reader that throws on an input is treated as no hints
  }
  return { container: "none" };
}

/**
 * Walk a whole RIFF/WAVE file's chunks once (4-byte id, u32 LE size, body, one pad byte after an odd size) and
 * collect `fmt `, `data`, `acid`, `cue `, `LIST adtl` and `smpl`. A chunk whose declared size runs past the end of
 * `bytes` ends the walk (its own body is not read, except that `data` still counts its available frames); the first
 * `acid`, `cue ` and `smpl` win. Returns empty `cues` and `loops` for a file that isn't RIFF/WAVE.
 */
export function readWavHints(bytes: Uint8Array): WavHints {
  const out: WavHints = { cues: [], loops: [] };
  try {
    if (bytes.length < 12 || !matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WAVE")) return out;

    let fmt: Uint8Array | undefined;
    let dataBytes: number | undefined;
    let acidBodyBytes: Uint8Array | undefined;
    let cueBodyBytes: Uint8Array | undefined;
    let smplBodyBytes: Uint8Array | undefined;
    const adtlBodies: Uint8Array[] = [];

    let pos = 12;
    while (pos + 8 <= bytes.length) {
      const id = fourCC(bytes, pos);
      const size = u32At(bytes, pos + 4);
      const bodyStart = pos + 8;
      const available = bytes.length - bodyStart;
      if (size > available) {
        // A chunk that overruns the file ends the walk; only `data` keeps its available frames.
        if (id === "data") dataBytes ??= available;
        break;
      }
      const body = bytes.subarray(bodyStart, bodyStart + size);
      if (id === "fmt ") fmt ??= body;
      else if (id === "data") dataBytes ??= size;
      else if (id === "acid") acidBodyBytes ??= body;
      else if (id === "cue ") cueBodyBytes ??= body;
      else if (id === "smpl") smplBodyBytes ??= body;
      else if (id === "LIST" && body.length >= 4 && matchesAscii(body, 0, "adtl")) adtlBodies.push(body);
      pos = bodyStart + size + (size % 2);
    }

    if (fmt !== undefined) {
      if (fmt.length >= 8) {
        const rate = u32At(fmt, 4);
        if (rate > 0) out.rate = rate;
      }
      if (fmt.length >= 14 && dataBytes !== undefined) {
        const blockAlign = u16At(fmt, 12);
        if (blockAlign > 0) out.frames = Math.floor(dataBytes / blockAlign);
      }
    }
    if (acidBodyBytes !== undefined) {
      const acid = readAcid(acidBodyBytes);
      if (acid !== null) out.acid = acid;
    }
    if (cueBodyBytes !== undefined) {
      const labels = new Map<number, string>();
      for (const body of adtlBodies) {
        for (const [id, text] of readAdtlLabels(body)) if (!labels.has(id)) labels.set(id, text);
      }
      out.cues = readCuePoints(cueBodyBytes).map((p) => ({ id: p.id, frame: p.frame, label: labels.get(p.id) ?? "" }));
    }
    if (smplBodyBytes !== undefined) out.loops = readSmplLoops(smplBodyBytes);
  } catch {
    // keep what was read before the fault
  }
  return out;
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
  if (body.length < 24) return null;
  const tempo = f32At(body, 20);
  if (!Number.isFinite(tempo) || tempo <= 0) return null;
  return {
    bpm: tempo,
    beats: u32At(body, 12),
    meterNumerator: u16At(body, 18),
    meterDenominator: u16At(body, 16),
    oneShot: (u32At(body, 0) & 1) !== 0,
  };
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
  if (body.length < 4) return [];
  const count = u32At(body, 0);
  const records = Math.min(count, Math.floor((body.length - 4) / 24));
  const points: CuePoint[] = [];
  for (let i = 0; i < records; i++) {
    const at = 4 + i * 24;
    points.push({ id: u32At(body, at), frame: u32At(body, at + 20) });
  }
  return points;
}

/**
 * The body of a `LIST` chunk of form type `adtl` (bytes after the chunk's id and size): the 4 bytes `adtl`, then
 * sub-chunks (4cc, u32 LE size, body, pad to even). For each `labl` sub-chunk with a body of at least 4 bytes: u32
 * cue id, then the label text, UTF-8, ending at the first NUL or the end of the body. `note` sub-chunks are read the
 * same way and used only when the cue has no `labl`; `ltxt` and unknown sub-chunks are skipped. The first label of
 * an id wins. A body that isn't `adtl` (or a sub-chunk running past the body) gives what was read so far.
 */
export function readAdtlLabels(body: Uint8Array): Map<number, string> {
  const labels = new Map<number, string>();
  const notes = new Map<number, string>();
  try {
    if (body.length < 4 || !matchesAscii(body, 0, "adtl")) return labels;
    let pos = 4;
    while (pos + 8 <= body.length) {
      const id = fourCC(body, pos);
      const size = u32At(body, pos + 4);
      const start = pos + 8;
      if (size > body.length - start) break;
      const end = start + size;
      if ((id === "labl" || id === "note") && size >= 4) {
        const cueId = u32At(body, start);
        const target = id === "labl" ? labels : notes;
        if (!target.has(cueId)) target.set(cueId, cText(body, start + 4, end));
      }
      pos = end + (size % 2);
    }
  } catch {
    // keep the labels read so far
  }
  for (const [id, text] of notes) if (!labels.has(id)) labels.set(id, text);
  return labels;
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
  if (body.length < 36) return [];
  const count = u32At(body, 28);
  const records = Math.min(count, Math.floor((body.length - 36) / 24));
  const loops: SmplLoop[] = [];
  for (let i = 0; i < records; i++) {
    const at = 36 + i * 24;
    const type = u32At(body, at + 4);
    const start = u32At(body, at + 8);
    const end = u32At(body, at + 12);
    const playCount = u32At(body, at + 20);
    if (end < start || end + 1 > MAX_U32) continue;
    loops.push({ start, end: end + 1, type, playCount });
  }
  return loops;
}

/**
 * Hints of a whole Ogg file: `oggComments(bytes)` (imported from the runtime reader; do not re-implement the page
 * walk) passed to `commentHints`. `{}` when there are no comments.
 */
export function readOggHints(bytes: Uint8Array): OggHints {
  try {
    return commentHints(oggComments(bytes));
  } catch {
    return {};
  }
}

/**
 * Hints from a comment list. Keys match case-insensitively over ASCII; the first of each key wins even if its value
 * doesn't parse. `BPM`: ASCII whitespace trimmed, a plain decimal (`^[0-9]+(\.[0-9]+)?$`), finite and > 0, else no
 * `bpm`. `LOOPSTART` and `LOOPLENGTH`: plain ASCII-decimal u32 (trimmed, no sign), length > 0, start + length at most
 * 0xFFFFFFFF; both must be valid for `loop` (same rules as `commentLoopPoints`, whose result this equals).
 */
export function commentHints(comments: readonly CommentPair[]): OggHints {
  let bpmText: string | undefined;
  let startText: string | undefined;
  let lengthText: string | undefined;
  for (const [key, value] of comments) {
    const upper = asciiUpper(key);
    if (upper === "BPM") bpmText ??= value;
    else if (upper === "LOOPSTART") startText ??= value;
    else if (upper === "LOOPLENGTH") lengthText ??= value;
  }
  const out: OggHints = {};
  if (bpmText !== undefined) {
    const bpm = parseBpm(bpmText);
    if (bpm !== null) out.bpm = bpm;
  }
  if (startText !== undefined && lengthText !== undefined) {
    const start = parseU32Decimal(startText);
    const length = parseU32Decimal(lengthText);
    if (start !== null && length !== null && length > 0 && start + length <= MAX_U32) {
      out.loop = { start, end: start + length };
    }
  }
  return out;
}

// --- helpers ----------------------------------------------------------------------------------------------------------

const MAX_U32 = 0xffffffff;
const ASCII_SPACE = /^[ \t\n\f\r]+|[ \t\n\f\r]+$/g;

/** Little-endian u16; the caller has checked that two bytes are there. */
function u16At(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

/** Little-endian u32; the caller has checked that four bytes are there. */
function u32At(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000;
}

/** Little-endian f32; the caller has checked that four bytes are there. */
function f32At(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getFloat32(0, true);
}

/** The four characters at `at` (the caller has checked the bounds). */
function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/** True when `bytes` holds the ASCII `text` at `at`. */
function matchesAscii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Label text from `[from, to)`, UTF-8, up to the first NUL. */
function cText(bytes: Uint8Array, from: number, to: number): string {
  let stop = from;
  while (stop < to && bytes[stop] !== 0) stop++;
  return new TextDecoder("utf-8").decode(bytes.subarray(from, stop));
}

/** Upper-cases ASCII letters only. */
function asciiUpper(text: string): string {
  return text.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** A plain ASCII-decimal u32 after trimming ASCII whitespace (no sign), else null. */
function parseU32Decimal(text: string): number | null {
  const trimmed = text.replace(ASCII_SPACE, "");
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_U32 ? value : null;
}

/** A plain decimal BPM (`^[0-9]+(\.[0-9]+)?$` after trimming), finite and > 0, else null. */
function parseBpm(text: string): number | null {
  const trimmed = text.replace(ASCII_SPACE, "");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}
