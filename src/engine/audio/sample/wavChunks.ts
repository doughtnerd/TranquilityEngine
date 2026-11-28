/**
 * WAV (RIFF/WAVE) metadata chunks, read and written (ADR 0342 "Import" and "Writing to the WAV is explicit"):
 *
 * - `cue ` cue points, with `LIST`/`adtl` `labl` (label), `note` (comment) and `ltxt` (a region: the cue plus a length);
 * - `smpl` sampler loops and the root note (MIDI unity note and pitch fraction);
 * - `acid` tempo, beats and meter;
 * - `bext` (EBU Tech 3285 Broadcast Wave): description, originator, the timecode origin (`timeReference`, frames since
 *   midnight) and the loudness fields of version 2.
 *
 * `readWavMetadata` reads them all; `writeWavMetadata` replaces the chunks of the groups it is given and keeps every
 * other chunk (the audio data, `fmt `, `LIST INFO`, unknown chunks) byte for byte, in order.
 *
 * Positions are sample frames; region and loop ends are exclusive (`smpl` stores an inclusive end, read here plus one).
 * Every function is total: garbage, truncation and huge counts never throw; a field that runs past its chunk drops that
 * field, never the whole result. The Audio Studio's sample import (`src/studio/screens/samples/`) reads a file's loops,
 * markers and tempo through this module.
 *
 * Pure; no plugin, no DOM.
 */

// --- types -----------------------------------------------------------------------------------------------------------

/** One chunk of a RIFF/WAVE file. */
export interface RiffChunk {
  id: string;
  /** Byte offset of the chunk's 8-byte header. */
  offset: number;
  /** The declared body size. */
  size: number;
  body: Uint8Array;
}

/** A walk of a RIFF/WAVE file's chunks. */
export interface RiffWalk {
  chunks: RiffChunk[];
  /** A chunk whose declared size runs past the end of the file; it ends the walk. */
  overrun: { id: string; offset: number; size: number; available: number } | null;
}

/** A cue point that isn't a region. */
export interface WavCue {
  id: number;
  frame: number;
  /** `labl` text, or `""`. */
  label: string;
  /** `note` text, or `""`. */
  note: string;
}

/** A cue point with an `ltxt` length: a region `[frame, frame + length)`. */
export interface WavRegion {
  id: number;
  frame: number;
  length: number;
  label: string;
  note: string;
  /** The `ltxt` purpose id, four characters (`"rgn "` by convention). */
  purpose: string;
  /** The `ltxt` text, or `""`. */
  text: string;
}

/** One `smpl` loop; `end` exclusive. */
export interface WavLoop {
  cueId: number;
  /** 0 forward, 1 alternating (ping-pong), 2 backward; others as stored. */
  type: number;
  start: number;
  end: number;
  /** The fractional start/end offset, as stored. */
  fraction: number;
  /** 0 = forever. */
  playCount: number;
}

/** The `smpl` root: MIDI unity note (0..127) and a fine tune in cents, normalised to -50..50. */
export interface WavRoot {
  midiNote: number;
  cents: number;
}

/** The `acid` chunk. */
export interface WavTempo {
  bpm: number;
  /** Beats in the file; 0 = not said. */
  beats: number;
  /** 0 = not said. */
  meterNumerator: number;
  meterDenominator: number;
  oneShot: boolean;
  /** The chunk's root note (MIDI) when its "root note set" flag is on. */
  rootNote: number | null;
}

/** The `bext` chunk. Loudness fields are null when absent (version < 2) or marked unused (0x7FFF). */
export interface WavBext {
  description: string;
  originator: string;
  originatorReference: string;
  /** `yyyy-mm-dd`. */
  originationDate: string;
  /** `hh:mm:ss`. */
  originationTime: string;
  /** The timecode origin: sample frames since midnight. */
  timeReference: number;
  version: number;
  /** The SMPTE UMID as hex (128 digits), or `""` when all zero. */
  umid: string;
  /** Integrated loudness, LUFS. */
  loudnessValue: number | null;
  /** Loudness range, LU. */
  loudnessRange: number | null;
  /** dBTP. */
  maxTruePeakLevel: number | null;
  /** LUFS. */
  maxMomentaryLoudness: number | null;
  /** LUFS. */
  maxShortTermLoudness: number | null;
  codingHistory: string;
}

/** Everything `readWavMetadata` reads. */
export interface WavMetadata {
  sampleRate: number | null;
  frames: number | null;
  channels: number | null;
  cues: WavCue[];
  regions: WavRegion[];
  loops: WavLoop[];
  root: WavRoot | null;
  tempo: WavTempo | null;
  bext: WavBext | null;
}

/**
 * What `writeWavMetadata` changes. A group left out keeps its chunks as they are; `null` (or an empty list for both
 * members of a group) removes them. Groups: cues and regions (`cue ` and `LIST adtl`), loops and root (`smpl`), tempo
 * (`acid`), bext (`bext`). Giving one member of a group keeps the other's current value.
 */
export type WavMetadataEdit = Partial<{
  cues: readonly WavCue[];
  regions: readonly WavRegion[];
  loops: readonly WavLoop[];
  root: WavRoot | null;
  tempo: WavTempo | null;
  bext: WavBext | null;
}>;

// --- byte helpers ----------------------------------------------------------------------------------------------------

const MAX_U32 = 0xffffffff;
const LOUDNESS_UNUSED = 0x7fff;
const BEXT_FIXED = 602;
const utf8 = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

export function u16At(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}
export function u32At(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000;
}
const i16At = (bytes: Uint8Array, at: number): number => (u16At(bytes, at) << 16) >> 16;
export function f32At(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getFloat32(0, true);
}
export function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}
export function matchesAscii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}
/** UTF-8 text from `[from, to)`, up to the first NUL. */
export function cText(bytes: Uint8Array, from: number, to: number): string {
  let stop = from;
  while (stop < to && bytes[stop] !== 0) stop++;
  return utf8.decode(bytes.subarray(from, stop));
}
/** A fixed ASCII field, NULs and trailing spaces trimmed. */
const fixedText = (bytes: Uint8Array, from: number, length: number): string => cText(bytes, from, Math.min(bytes.length, from + length)).replace(/\s+$/, "");

/** A growable little-endian byte writer. */
class ByteWriter {
  private parts: number[] = [];
  u8(n: number): this { this.parts.push(n & 0xff); return this; }
  u16(n: number): this { return this.u8(n).u8(n >>> 8); }
  u32(n: number): this { return this.u8(n).u8(n >>> 8).u8(n >>> 16).u8(n >>> 24); }
  f32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, n, true);
    for (const x of b) this.parts.push(x);
    return this;
  }
  ascii(text: string, length?: number): this {
    const n = length ?? text.length;
    for (let i = 0; i < n; i++) this.parts.push(i < text.length ? text.charCodeAt(i) & 0x7f : 0);
    return this;
  }
  bytes(b: ArrayLike<number>): this { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  get length(): number { return this.parts.length; }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}

/** A chunk's bytes: id, size, body, a pad byte after an odd size. */
function chunkBytes(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length % 2));
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

// --- walking ---------------------------------------------------------------------------------------------------------

/**
 * Walk a RIFF/WAVE file's chunks (4-byte id, u32 LE size, body, one pad byte after an odd size). A chunk whose size runs
 * past the end of the file ends the walk and is reported as `overrun`. Null for a file that isn't RIFF/WAVE.
 */
export function walkWavChunks(bytes: Uint8Array): RiffWalk | null {
  if (bytes.length < 12 || !matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WAVE")) return null;
  const chunks: RiffChunk[] = [];
  let overrun: RiffWalk["overrun"] = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = fourCC(bytes, pos);
    const size = u32At(bytes, pos + 4);
    const available = bytes.length - (pos + 8);
    if (size > available) {
      overrun = { id, offset: pos, size, available };
      break;
    }
    chunks.push({ id, offset: pos, size, body: bytes.subarray(pos + 8, pos + 8 + size) });
    pos += 8 + size + (size % 2);
  }
  return { chunks, overrun };
}

/**
 * ADR 0463: the sample rate a walked WAV file states: the first `fmt ` chunk's rate (u32 LE at body offset 4), when that
 * chunk is whole and at least 14 bytes (format, channels, rate, byte rate, block align) and the rate is above 0; else
 * null. A `fmt ` chunk that runs past the end of the file is not read.
 */
export function wavSampleRate(walk: RiffWalk): number | null {
  const fmt = walk.chunks.find((c) => c.id === "fmt ");
  if (!fmt || fmt.body.length < 14) return null;
  const rate = u32At(fmt.body, 4);
  return rate > 0 ? rate : null;
}

/**
 * ADR 0463: the loop a plain clip plays from its file's `smpl` loops: the first forward (type 0) loop in record order,
 * or null. The same rule as the native decoder (`audio-decode` `smpl_loop_points`) and the Babylon fallback
 * (`loopPointsReader.ts`). The Studio's sample import keeps every loop (a sample block plays several); this is the one
 * loop a clip without a sample block loops.
 */
export function firstForwardLoop(loops: readonly WavLoop[]): WavLoop | null {
  return loops.find((l) => l.type === 0) ?? null;
}

const isAdtl = (c: RiffChunk): boolean => c.id === "LIST" && c.body.length >= 4 && matchesAscii(c.body, 0, "adtl");

// --- chunk bodies ----------------------------------------------------------------------------------------------------

/**
 * An `acid` body (24 bytes): u32 flags (0x01 one-shot, 0x02 root note set, 0x04 stretch, 0x08 disk-based, 0x10
 * acidized), u16 root note, u16 unknown, f32 unknown, u32 beats, u16 meter denominator, u16 meter numerator, f32 tempo.
 * Null when shorter or the tempo isn't a finite number > 0.
 */
export function readAcidChunk(body: Uint8Array): WavTempo | null {
  if (body.length < 24) return null;
  const bpm = f32At(body, 20);
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const flags = u32At(body, 0);
  return {
    bpm,
    beats: u32At(body, 12),
    meterNumerator: u16At(body, 18),
    meterDenominator: u16At(body, 16),
    oneShot: (flags & 1) !== 0,
    rootNote: (flags & 2) !== 0 ? u16At(body, 4) : null,
  };
}

/** A `cue ` body: u32 count, then 24-byte records (id, position, data chunk id, chunk start, block start, frame). */
export function readCueChunk(body: Uint8Array): { id: number; frame: number }[] {
  if (body.length < 4) return [];
  const records = Math.min(u32At(body, 0), Math.floor((body.length - 4) / 24));
  const out: { id: number; frame: number }[] = [];
  for (let i = 0; i < records; i++) {
    const at = 4 + i * 24;
    out.push({ id: u32At(body, at), frame: u32At(body, at + 20) });
  }
  return out;
}

/** An `ltxt` sub-chunk: the region a cue starts. */
export interface AdtlText { cueId: number; length: number; purpose: string; text: string }

/**
 * A `LIST` body of form `adtl`: its `labl` and `note` texts by cue id (the first of each id wins) and its `ltxt`
 * records (u32 cue id, u32 sample length, 4cc purpose, u16 country, language, dialect, code page, then text). Other
 * sub-chunks are skipped; a sub-chunk running past the body ends the read.
 */
export function readAdtlChunk(body: Uint8Array): { labels: Map<number, string>; notes: Map<number, string>; texts: AdtlText[] } {
  const labels = new Map<number, string>();
  const notes = new Map<number, string>();
  const texts: AdtlText[] = [];
  if (body.length < 4 || !matchesAscii(body, 0, "adtl")) return { labels, notes, texts };
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
    } else if (id === "ltxt" && size >= 20) {
      texts.push({ cueId: u32At(body, start), length: u32At(body, start + 4), purpose: fourCC(body, start + 8), text: cText(body, start + 20, end) });
    }
    pos = end + (size % 2);
  }
  return { labels, notes, texts };
}

/**
 * A `smpl` body: nine u32 header fields (manufacturer, product, sample period, MIDI unity note, MIDI pitch fraction,
 * SMPTE format, SMPTE offset, loop count, sampler data size), then 24-byte loops (cue id, type, start, end inclusive,
 * fraction, play count). Loops with `end < start` or an end at the u32 limit are skipped. Null when shorter than 36.
 */
export function readSmplChunk(body: Uint8Array): { root: WavRoot; loops: WavLoop[] } | null {
  if (body.length < 36) return null;
  const records = Math.min(u32At(body, 28), Math.floor((body.length - 36) / 24));
  const loops: WavLoop[] = [];
  for (let i = 0; i < records; i++) {
    const at = 36 + i * 24;
    const start = u32At(body, at + 8);
    const end = u32At(body, at + 12);
    if (end < start || end + 1 > MAX_U32) continue;
    loops.push({ cueId: u32At(body, at), type: u32At(body, at + 4), start, end: end + 1, fraction: u32At(body, at + 16), playCount: u32At(body, at + 20) });
  }
  let midiNote = Math.min(127, u32At(body, 12));
  let cents = Math.round((u32At(body, 16) / 2 ** 32) * 100 * 100) / 100;
  if (cents > 50 && midiNote < 127) {
    midiNote += 1;
    cents = Math.round((cents - 100) * 100) / 100;
  }
  return { root: { midiNote, cents }, loops };
}

/** A `bext` body (EBU Tech 3285); null when shorter than the 602-byte fixed part. */
export function readBextChunk(body: Uint8Array): WavBext | null {
  if (body.length < BEXT_FIXED) return null;
  const version = u16At(body, 346);
  const loud = (at: number): number | null => {
    if (version < 2) return null;
    const raw = i16At(body, at);
    return raw === LOUDNESS_UNUSED ? null : raw / 100;
  };
  let umid = "";
  for (let i = 348; i < 412; i++) umid += body[i].toString(16).padStart(2, "0");
  if (/^0+$/.test(umid)) umid = "";
  return {
    description: fixedText(body, 0, 256),
    originator: fixedText(body, 256, 32),
    originatorReference: fixedText(body, 288, 32),
    originationDate: fixedText(body, 320, 10),
    originationTime: fixedText(body, 330, 8),
    timeReference: u32At(body, 338) + u32At(body, 342) * 2 ** 32,
    version,
    umid,
    loudnessValue: loud(412),
    loudnessRange: loud(414),
    maxTruePeakLevel: loud(416),
    maxMomentaryLoudness: loud(418),
    maxShortTermLoudness: loud(420),
    codingHistory: cText(body, BEXT_FIXED, body.length).replace(/\s+$/, ""),
  };
}

// --- reading ---------------------------------------------------------------------------------------------------------

const emptyMetadata = (): WavMetadata => ({ sampleRate: null, frames: null, channels: null, cues: [], regions: [], loops: [], root: null, tempo: null, bext: null });

/**
 * Every metadata chunk of a WAV file. The first `fmt `, `data`, `cue `, `smpl`, `acid` and `bext` win; every `LIST
 * adtl` is read. A `data` chunk that runs past the end of the file counts the frames that are there. Empty metadata for
 * a file that isn't RIFF/WAVE.
 */
export function readWavMetadata(bytes: Uint8Array): WavMetadata {
  const out = emptyMetadata();
  try {
    const walk = walkWavChunks(bytes);
    if (!walk) return out;
    const first = (id: string): RiffChunk | undefined => walk.chunks.find((c) => c.id === id);
    const fmt = first("fmt ");
    const data = first("data");
    const dataBytes = data ? data.size : walk.overrun?.id === "data" ? walk.overrun.available : undefined;
    out.sampleRate = wavSampleRate(walk);
    if (fmt && fmt.body.length >= 14) {
      const channels = u16At(fmt.body, 2);
      const blockAlign = u16At(fmt.body, 12);
      if (channels > 0) out.channels = channels;
      if (blockAlign > 0 && dataBytes !== undefined) out.frames = Math.floor(dataBytes / blockAlign);
    }
    const cue = first("cue ");
    if (cue) {
      const labels = new Map<number, string>();
      const notes = new Map<number, string>();
      const texts = new Map<number, AdtlText>();
      for (const c of walk.chunks.filter(isAdtl)) {
        const a = readAdtlChunk(c.body);
        for (const [id, t] of a.labels) if (!labels.has(id)) labels.set(id, t);
        for (const [id, t] of a.notes) if (!notes.has(id)) notes.set(id, t);
        for (const t of a.texts) if (!texts.has(t.cueId)) texts.set(t.cueId, t);
      }
      for (const p of readCueChunk(cue.body)) {
        const label = labels.get(p.id) ?? "";
        const note = notes.get(p.id) ?? "";
        const t = texts.get(p.id);
        if (t && t.length > 0) out.regions.push({ id: p.id, frame: p.frame, length: t.length, label, note, purpose: t.purpose, text: t.text });
        else out.cues.push({ id: p.id, frame: p.frame, label, note });
      }
    }
    const smpl = first("smpl");
    const s = smpl ? readSmplChunk(smpl.body) : null;
    if (s) {
      out.root = s.root;
      out.loops = s.loops;
    }
    const acid = first("acid");
    if (acid) out.tempo = readAcidChunk(acid.body);
    const bext = first("bext");
    if (bext) out.bext = readBextChunk(bext.body);
  } catch {
    // keep what was read before the fault
  }
  return out;
}

// --- writing ---------------------------------------------------------------------------------------------------------

/** Cue ids for cues then regions: a positive, unused id is kept; others get the next free id. */
function assignCueIds(cues: readonly WavCue[], regions: readonly WavRegion[]): number[] {
  const used = new Set<number>();
  const wanted = [...cues.map((c) => c.id), ...regions.map((r) => r.id)];
  const ids = wanted.map((id) => {
    if (Number.isInteger(id) && id > 0 && id <= MAX_U32 && !used.has(id)) {
      used.add(id);
      return id;
    }
    return 0;
  });
  let next = 1;
  return ids.map((id) => {
    if (id) return id;
    while (used.has(next)) next++;
    used.add(next);
    return next;
  });
}

const clampU32 = (n: number): number => (Number.isFinite(n) ? Math.min(MAX_U32, Math.max(0, Math.round(n))) : 0);

/** A text sub-chunk body: u32 cue id, then UTF-8 text with a NUL. */
function textSub(id: string, cueId: number, text: string): Uint8Array {
  return chunkBytes(id, new ByteWriter().u32(cueId).bytes(utf8Encoder.encode(text)).u8(0).done());
}

function cueChunks(cues: readonly WavCue[], regions: readonly WavRegion[]): Uint8Array[] {
  if (cues.length === 0 && regions.length === 0) return [];
  const ids = assignCueIds(cues, regions);
  const points = [...cues.map((c) => c.frame), ...regions.map((r) => r.frame)];
  const cue = new ByteWriter().u32(points.length);
  points.forEach((frame, i) => cue.u32(ids[i]).u32(i).ascii("data").u32(0).u32(0).u32(clampU32(frame)));
  const adtl = new ByteWriter().ascii("adtl");
  cues.forEach((c, i) => {
    if (c.label) adtl.bytes(textSub("labl", ids[i], c.label));
    if (c.note) adtl.bytes(textSub("note", ids[i], c.note));
  });
  regions.forEach((r, j) => {
    const id = ids[cues.length + j];
    if (r.label) adtl.bytes(textSub("labl", id, r.label));
    if (r.note) adtl.bytes(textSub("note", id, r.note));
    const purpose = (r.purpose || "rgn ").padEnd(4, " ").slice(0, 4);
    const ltxt = new ByteWriter().u32(id).u32(clampU32(r.length)).ascii(purpose).u16(0).u16(0).u16(0).u16(0);
    if (r.text) ltxt.bytes(utf8Encoder.encode(r.text)).u8(0);
    adtl.bytes(chunkBytes("ltxt", ltxt.done()));
  });
  const out = [chunkBytes("cue ", cue.done())];
  if (adtl.length > 4) out.push(chunkBytes("LIST", adtl.done()));
  return out;
}

function smplChunk(loops: readonly WavLoop[], root: WavRoot | null, existing: Uint8Array | undefined, sampleRate: number | null): Uint8Array[] {
  if (loops.length === 0 && root === null) return [];
  const keep = existing && existing.length >= 36 ? existing : undefined;
  const w = new ByteWriter();
  w.u32(keep ? u32At(keep, 0) : 0).u32(keep ? u32At(keep, 4) : 0);
  w.u32(keep ? u32At(keep, 8) : sampleRate ? Math.round(1e9 / sampleRate) : 0);
  let note = root ? Math.min(127, Math.max(0, Math.round(root.midiNote))) : 60;
  let cents = root ? Math.min(50, Math.max(-50, root.cents)) : 0;
  if (cents < 0 && note > 0) {
    note -= 1;
    cents += 100;
  }
  w.u32(note).u32(clampU32((Math.max(0, cents) / 100) * 2 ** 32));
  w.u32(keep ? u32At(keep, 20) : 0).u32(keep ? u32At(keep, 24) : 0);
  // Sampler-specific data after the loops is kept as it was.
  const oldLoops = keep ? Math.min(u32At(keep, 28), Math.floor((keep.length - 36) / 24)) : 0;
  const samplerData = keep ? keep.subarray(36 + oldLoops * 24, 36 + oldLoops * 24 + Math.min(u32At(keep, 32), keep.length - 36 - oldLoops * 24)) : new Uint8Array(0);
  w.u32(loops.length).u32(samplerData.length);
  for (const l of loops) {
    const start = clampU32(l.start);
    const end = Math.max(start, clampU32(l.end) - 1);
    w.u32(clampU32(l.cueId)).u32(clampU32(l.type)).u32(start).u32(end).u32(clampU32(l.fraction)).u32(clampU32(l.playCount));
  }
  w.bytes(samplerData);
  return [chunkBytes("smpl", w.done())];
}

function acidChunk(tempo: WavTempo | null, existing: Uint8Array | undefined): Uint8Array[] {
  if (!tempo) return [];
  const keep = existing && existing.length >= 24 ? existing : undefined;
  let flags = keep ? u32At(keep, 0) & ~0x3 : 0;
  if (tempo.oneShot) flags |= 1;
  if (tempo.rootNote !== null) flags |= 2;
  const w = new ByteWriter().u32(flags).u16(tempo.rootNote ?? (keep ? u16At(keep, 4) : 60));
  if (keep) w.bytes(keep.subarray(6, 12));
  else w.u16(0x8000).f32(0);
  w.u32(clampU32(tempo.beats)).u16(tempo.meterDenominator & 0xffff).u16(tempo.meterNumerator & 0xffff).f32(tempo.bpm);
  if (keep && keep.length > 24) w.bytes(keep.subarray(24));
  return [chunkBytes("acid", w.done())];
}

function bextChunk(bext: WavBext | null, existing: Uint8Array | undefined): Uint8Array[] {
  if (!bext) return [];
  const body = new Uint8Array(BEXT_FIXED);
  if (existing && existing.length >= BEXT_FIXED) body.set(existing.subarray(0, BEXT_FIXED));
  const put = (at: number, length: number, text: string) => {
    const field = new ByteWriter().ascii(text.slice(0, length), length).done();
    body.set(field, at);
  };
  put(0, 256, bext.description);
  put(256, 32, bext.originator);
  put(288, 32, bext.originatorReference);
  put(320, 10, bext.originationDate);
  put(330, 8, bext.originationTime);
  const view = new DataView(body.buffer);
  const tr = Math.max(0, Math.floor(Number.isFinite(bext.timeReference) ? bext.timeReference : 0));
  view.setUint32(338, tr % 2 ** 32, true);
  view.setUint32(342, Math.floor(tr / 2 ** 32), true);
  const loud = [bext.loudnessValue, bext.loudnessRange, bext.maxTruePeakLevel, bext.maxMomentaryLoudness, bext.maxShortTermLoudness];
  const version = loud.some((v) => v !== null) ? Math.max(2, bext.version) : bext.version;
  view.setUint16(346, version & 0xffff, true);
  if (/^[0-9a-fA-F]{128}$/.test(bext.umid)) for (let i = 0; i < 64; i++) body[348 + i] = parseInt(bext.umid.slice(i * 2, i * 2 + 2), 16);
  else if (bext.umid === "") body.fill(0, 348, 412);
  loud.forEach((v, i) => {
    if (version >= 2) view.setInt16(412 + i * 2, v === null ? LOUDNESS_UNUSED : Math.max(-32768, Math.min(32766, Math.round(v * 100))), true);
  });
  const history = new ByteWriter().ascii(bext.codingHistory).done();
  const out = new Uint8Array(BEXT_FIXED + history.length);
  out.set(body);
  out.set(history, BEXT_FIXED);
  return [chunkBytes("bext", out)];
}

type Group = "cue" | "smpl" | "acid" | "bext";

const groupOf = (c: RiffChunk): Group | null =>
  c.id === "cue " || isAdtl(c) ? "cue" : c.id === "smpl" ? "smpl" : c.id === "acid" ? "acid" : c.id === "bext" ? "bext" : null;

/**
 * `bytes` with the metadata chunks of the groups `edit` names replaced (see `WavMetadataEdit`). A replaced group's new
 * chunks take the place of its first old chunk; a new `bext` goes before `fmt ` (where broadcast tools look first) and
 * other new groups go after the last chunk. Every other chunk is copied byte for byte, in order; a chunk that runs past
 * the end of the file stays last. Kept from the old chunks: `smpl`'s manufacturer, product, SMPTE fields and sampler
 * data; `acid`'s unknown fields and other flags; `bext`'s reserved bytes. Returns a copy of `bytes` when it isn't
 * RIFF/WAVE or `edit` names no group.
 */
export function writeWavMetadata(bytes: Uint8Array, edit: WavMetadataEdit): Uint8Array {
  const walk = walkWavChunks(bytes);
  if (!walk) return bytes.slice();
  const current = readWavMetadata(bytes);
  const first = (id: string) => walk.chunks.find((c) => c.id === id)?.body;
  const replace = new Map<Group, Uint8Array[]>();
  if (edit.cues !== undefined || edit.regions !== undefined) replace.set("cue", cueChunks(edit.cues ?? current.cues, edit.regions ?? current.regions));
  if (edit.loops !== undefined || edit.root !== undefined) {
    replace.set("smpl", smplChunk(edit.loops ?? current.loops, edit.root === undefined ? current.root : edit.root, first("smpl"), current.sampleRate));
  }
  if (edit.tempo !== undefined) replace.set("acid", acidChunk(edit.tempo, first("acid")));
  if (edit.bext !== undefined) replace.set("bext", bextChunk(edit.bext, first("bext")));
  if (replace.size === 0) return bytes.slice();

  const parts: Uint8Array[] = [];
  const placed = new Set<Group>();
  const place = (g: Group) => {
    if (placed.has(g) || !replace.has(g)) return;
    placed.add(g);
    parts.push(...replace.get(g)!);
  };
  for (const c of walk.chunks) {
    const g = groupOf(c);
    if (g && replace.has(g)) {
      place(g);
      continue;
    }
    if (c.id === "fmt ") place("bext");
    const end = c.offset + 8 + c.size;
    parts.push(bytes.subarray(c.offset, end));
    if (c.size % 2 === 1) parts.push(Uint8Array.of(end < bytes.length ? bytes[end] : 0));
  }
  for (const g of ["bext", "cue", "smpl", "acid"] as const) place(g);
  // What follows the last whole chunk (a chunk that runs past the end, or stray bytes) stays at the end.
  const lastEnd = walk.chunks.length ? (() => { const c = walk.chunks[walk.chunks.length - 1]; return c.offset + 8 + c.size + (c.size % 2); })() : 12;
  const tailFrom = walk.overrun ? walk.overrun.offset : lastEnd;
  if (tailFrom < bytes.length) parts.push(bytes.subarray(tailFrom));

  const total = 12 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  out.set(bytes.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, total - 8, true);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
