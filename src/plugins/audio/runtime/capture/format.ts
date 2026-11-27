// ADR 0171 amended by 0172 (M5a, task Rc1; contract H3; api-and-models §5, architecture §4.1, §3.7): the capture file's
// byte format. A capture is the profile stream saved: a plain 96 B header, then one deflate-raw stream (or the same bytes
// stored raw) of the META chunk (JSON), the records and the INDEX record.
//
// Pure TypeScript, no DOM and no plugin-runtime imports beyond `wire.generated.ts`: it runs in the capture Worker.
// Every field here is **untrusted input** on decode (record change 4). The caps below are security bounds, never
// tripwires: they are not raised (M5 ground rules). A declared length or count past its cap is a `CaptureError`, never
// an allocation.
//
// Owners: Rc1 (header, framing, every record codec but KEYFRAME, META, INDEX, the Worker protocol); Rc1b fills the
// KEYFRAME codec stubs tagged `Rc1b` (§5.5) without changing their signatures; Rc2 writes keyframes into the ring
// against them.
import {
  KEYFRAME_AUDIBILITY_ONE, KEYFRAME_BUS_FLAGS_KNOWN, KEYFRAME_BUS_LANES, KEYFRAME_MAX_BUSES, KEYFRAME_MAX_EVENTS, KEYFRAME_MAX_METERED,
  KEYFRAME_MAX_MUSIC, KEYFRAME_MAX_VOICES, KEYFRAME_METERED_FLAGS_KNOWN, KEYFRAME_MUSIC_STATES, KEYFRAME_PITCH_ONE, KEYFRAME_VOICE_STATES,
  KEYFRAME_VOICE_STATE_MAX, KeyframeBusFlag, KeyframeMeteredFlag, NO_NAME, type CaptureMusicState, type CaptureVoiceState,
} from "./keyframeLayout";
import { voiceRowReason, type CaptureVoiceReason } from "./reasons";
import { isTakeRecordType, TAKE_FORMAT_MINOR, TakeRecordError, TakeRecordType, decodeTakeRecord, type TakeRecord } from "../../../../engine/audio/take/records";
import type { TakeMetaSection } from "../../../../engine/audio/take/reader";
import { CORE_ABI_VERSION, Kind, MAGIC, QUANTUM_FRAMES, SCHEMA_HASH, STATUS_BUFFER_BYTES, STATUS_EVERY_QUANTA, STATUS_HEADER_BYTES, STATUS_HEADER_COLUMNS, VERSION_MAJOR, VERSION_MINOR } from "../wire.generated";
export {
  KEYFRAME_AUDIBILITY_ONE, KEYFRAME_BUS_LANES, KEYFRAME_MAX_BUSES, KEYFRAME_MAX_EVENTS, KEYFRAME_MAX_METERED,
  KEYFRAME_MAX_MUSIC, KEYFRAME_MAX_VOICES, KEYFRAME_MUSIC_STATES, KEYFRAME_PITCH_ONE, KEYFRAME_VOICE_STATES,
  KEYFRAME_VOICE_STATE_MAX, KeyframeBusFlag, KeyframeMeteredFlag, NO_NAME, type CaptureMusicState, type CaptureVoiceState,
} from "./keyframeLayout";

// --- constants (§5.1, §5.7) -------------------------------------------------------------------------------------------

/** `"MYCAP\0"`, `0x01`, `0x1A` (§5.1). */
export const CAPTURE_MAGIC: readonly number[] = [0x4d, 0x59, 0x43, 0x41, 0x50, 0x00, 0x01, 0x1a];
/** The plain header's size. */
export const CAPTURE_HEADER_BYTES = 96;
/**
 * `format` this build writes and reads. 2 (ADR 0348): EVENT kinds `pick` and `loudnessWarning`, MIXOP written, the
 * `take` header flag, META's `take` section and the request records; format 1 files are refused (not migrated).
 */
export const CAPTURE_FORMAT = 2;
/**
 * ADR 0386: the format's minor this build writes and reads up to (header bytes 84..86, which files before it wrote as 0):
 * the take format's minor (`TAKE_FORMAT_MINOR`), as a minor only adds take request records. A file of a newer minor is
 * refused up front (`newerFormat`): an older reader would pass over the records it doesn't know and replay something else.
 */
export const CAPTURE_FORMAT_MINOR = TAKE_FORMAT_MINOR;
/** The core ABI this build reads captures of: the generated `CORE_ABI_VERSION`, beside the schema hash (ADR 0328). */
export const CAPTURE_ABI_VERSION = CORE_ABI_VERSION;
/** R16: the uncompressed payload's cap, from the header before inflate and while inflating (64 MiB). */
export const CAPTURE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/**
 * ADR 0348: a take's uncompressed payload cap (256 MiB): the profile ring (at most 32 MiB) plus the requests, which are never
 * dropped (the recorder stops with a message before a take would pass it). Applies to files whose header sets `take`.
 */
export const TAKE_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** The META chunk's cap (1 MiB). */
export const CAPTURE_META_MAX_BYTES = 1024 * 1024;
/** Every record but STATUS (whose cap is the header's `statusBytesMax`): 256 KB. */
export const CAPTURE_RECORD_MAX_BYTES = 262_144;
/** Every record's head. */
export const CAPTURE_RECORD_HEAD_BYTES = 20;
/** A name (META or NAMES), UTF-8 bytes. META names are cut to it; a NAMES record past it is refused. */
export const CAPTURE_NAME_MAX_BYTES = 256;
/** ADR 0348: META `replayOf.path`, UTF-8 bytes (cut to it). */
export const CAPTURE_PATH_MAX_BYTES = 1024;
/** Names in all tables together, META and NAMES records. */
export const CAPTURE_MAX_NAMES = 65_536;
/** MARKER text, UTF-8 bytes (also `CAPTURE_MARK_BYTES` in `capture.ts`). */
export const CAPTURE_MARKER_MAX_BYTES = 120;
/** META `device.userAgent` is cut to this many UTF-8 bytes. */
export const CAPTURE_USER_AGENT_MAX_BYTES = 120;
/** `keyframeIntervalMs` (R13: in rendered frames at the epoch's rate). */
export const CAPTURE_KEYFRAME_INTERVAL_MS = 1000;
/** The disorder bound within one epoch: no record's frame is more than this before an earlier-written record's (§5.3). */
export const CAPTURE_DISORDER_SECONDS = 1;
/** `CAPTURE_TRIGGER_MAX_FILES` (§5.7; Rc4's rotation). */
export const CAPTURE_TRIGGER_MAX_FILES = 16;
/** A sample rate the header or an EPOCH may name. */
export const CAPTURE_MIN_SAMPLE_RATE = 8_000;
export const CAPTURE_MAX_SAMPLE_RATE = 384_000;
/** The highest `u8 op` code of a MIXOP (`MIX_OP_NAMES.length` in `src/engine/audio/mixOps.ts`; a test keeps them equal). */
export const CAPTURE_MIXOP_CODES = 25; // 25: setOcclusionCurves (ADR 0362 item 6), appended
/** `u8 class` codes of a MIXOP (`OP_CLASSES.length`). */
export const CAPTURE_MIXOP_CLASSES = 5;

/** Header `flags` (§5.1). */
export const CAPTURE_FLAG_TRUNCATED = 1 << 0;
/** Babylon: no STATUS records. */
export const CAPTURE_FLAG_MAIN_SIDE_ONLY = 1 << 1;
export const CAPTURE_FLAG_HAS_INDEX = 1 << 2;
export const CAPTURE_FLAG_COMPRESSED = 1 << 3;
/** ADR 0348: a take (`*.sporesample`): request records may follow, META carries a `take` section, the cap is the take's. */
export const CAPTURE_FLAG_TAKE = 1 << 4;
const CAPTURE_FLAGS_KNOWN = 0x1f;

/** Record head `flags` bit 0 (§5.3): the frame is F_now and the real stamp (f64) leads the payload. */
export const RECORD_FLAG_DEFERRED = 1 << 0;
const RECORD_FLAGS_KNOWN = 0x1;

/** Record `type` codes (§5.3). Unknown types below 0x80 are skipped by `len`; at or above 0x80 refused. */
export const RecordType = {
  EPOCH: 0x01,
  GAP: 0x02,
  STATUS: 0x03,
  KEYFRAME: 0x04,
  EVENT: 0x05,
  MARKER: 0x06,
  NAMES: 0x07,
  MIXOP: 0x08,
  /** Ring only; the saver strips it, so a file holding one is refused. */
  WRAP: 0x09,
  INDEX: 0x7f,
} as const;
/** ADR 0348: a take's request record codes (0x10..0x20 since ADR 0386, `engine/audio/take/records.ts`): only in a file with the `take` flag. */
export { TakeRecordType, isTakeRecordType };
export type RecordTypeCode = (typeof RecordType)[keyof typeof RecordType];
/** The first required (never skipped) unknown type. */
export const RECORD_TYPE_REQUIRED_FIRST = 0x80;

/** EPOCH `reason` (one per `RebuildReason`, `recovery.ts:32-38`; resume is not an epoch). */
export const EpochReason = { start: 0, trap: 1, stall: 2, device: 3, rate: 4, latency: 5, mode: 6 } as const;
export const EPOCH_REASON_MAX = 6;
/** GAP `reason`. `paused` means only `audio.background: "pause"`. */
export const GapReason = { paused: 1, rebuild: 2, held: 3, dropped: 4, recordTooLarge: 5 } as const;
export const GAP_REASON_MAX = 5;
/** NAMES `table`, and the META `names` keys in the same order. The `buses` table is keyed by bus **slot** (`busRef & 0xff`), written into META by the saver; the event sink never interns into it. */
export const NAME_TABLES = ["clips", "buses", "events", "parameters", "snapshots", "targets"] as const;
export type NameTable = (typeof NAME_TABLES)[number];
/** MIXOP `origin`. */
export const MixOpOrigin = { editor: 0, script: 1, undo: 2, redo: 3, compare: 4, debugLink: 5 } as const;
export const MIXOP_ORIGIN_MAX = 5;

/**
 * EVENT `kind` (§5.6). ADR 0435: an `eventStart` may carry four more args (its cause: trigger, node, behaviour, system),
 * appended within format 2 as `audioPackage`'s third: a reader takes the first two and older captures read as before.
 */
export const EventKind = {
  voiceStart: 1, voiceStop: 2, voiceSteal: 3, voiceVirtual: 4, voiceReal: 5, voiceRefused: 6, voiceQueued: 7,
  eventStart: 8, eventStop: 9, parameter: 10, snapshot: 11, stateChange: 12, musicTransition: 13, busRamp: 14,
  monitor: 15, loudnessControl: 16, ladder: 17, masterChange: 18, hiddenTab: 19,
  /** ADR 0348: one playlist decision of an instance (the "Why it played" chain), written after its `eventStart`. */
  pick: 20,
  /** ADR 0348: a metered bus's loudness against its target changed state (reason 1 high, 2 low, 3 ok). */
  loudnessWarning: 21,
  /**
   * ADR 0351 §9 (`PKG`): a package started loading (reason 1), loaded (2), failed (3) or was unloaded (4). Added within
   * format 2: older captures read as before; an older build refuses a capture holding one (an unknown kind).
   */
  audioPackage: 22,
  /** ADR 0352 §6: a plugin effect faulted and passed its block dry (reason 1 trap, 2 budget, 3 grow, 4 nonFinite, 5 range). */
  pluginFault: 23,
} as const;
export const EVENT_KIND_MAX = 23;
/** Kinds whose payload ends in one `f32` (§5.6: voiceStart gain, snapshot seconds, busRamp target, masterChange volume). */
export const EVENT_KINDS_WITH_F32: ReadonlySet<number> = new Set([1, 11, 14, 18]);
/**
 * The highest `reason` per kind for the kinds §5.6 gives reasons (1-based; 0 is refused for these). Kinds absent here
 * accept any `reason` byte. loudnessControl (1 reset, 2 pause, 3 resume, 4 target) and ladder (1 step, 2 shed,
 * 3 restored) are Rc1's reading of §5.6's parentheses.
 */
export const EVENT_REASON_MAX: ReadonlyMap<number, number> = new Map([
  [2, 5], [3, 3], [4, 4], [5, 2], [6, 5], [7, 2], [16, 4], [17, 3], [21, 3], [22, 4], [23, 5],
]);

// The KEYFRAME section caps and `KEYFRAME_BUS_LANES` are `keyframeLayout.ts`'s (ADR 0230), re-exported at the top.
export const KEYFRAME_VOICE_BYTES = 24;
export const KEYFRAME_BUS_BYTES = 56;
export const KEYFRAME_METERED_BYTES = 36;
export const KEYFRAME_EVENT_BYTES = 16;
export const KEYFRAME_MUSIC_BYTES = 40;
/** The mix section's one item (§5.5: `u32, u8, u8, u8, u8 pad, u32, f32, u8`), after its `u16 count` of 1. */
export const KEYFRAME_MIX_BYTES = 17;
/** The six sections' `u16 count`s. */
export const KEYFRAME_COUNT_BYTES = 2;

// --- errors -----------------------------------------------------------------------------------------------------------

/**
 * Every refusal's code. The first six are §5.1's header steps, in their order; the rest are Rc1's. Pf8 has a message
 * test per code.
 */
export const CAPTURE_ERROR_CODES = [
  /** Shorter than the header, or the magic differs. */
  "badMagic",
  /**
   * ADR 0386: a version above what this build reads: `format` or its minor, the core ABI's major (or its minor under another
   * wire hash), the status envelope's. The message reads "incompatible version: file is x.y, this build reads a.b–c.d".
   */
  "newerFormat",
  /** ADR 0386: a version below what this build reads: `format` (old captures are not migrated), the core ABI's major, the envelope's. Worded as `newerFormat`. */
  "olderFormat",
  /** This build's very core ABI under another wire `SCHEMA_HASH` (a schema edit nobody versioned); the message names both and says "re-record with this build". */
  "wireMismatch",
  /** `uncompressedBytes` past `CAPTURE_MAX_UNCOMPRESSED_BYTES`, or a live view past it. */
  "tooLarge",
  /** The inflated payload ran past `uncompressedBytes` (a deflate bomb or a lying header): stopped at +1 byte. */
  "inflateOverrun",
  /** Any other header field outside its domain: flags, rates, sizes that disagree, reserved non-zero. */
  "badHeader",
  /** The deflate stream is corrupt, or no inflater exists. */
  "inflateFailed",
  /** The payload (inflated or stored) is shorter or, stored, longer than the header says. */
  "sizeMismatch",
  /** META's `metaBytes` past `CAPTURE_META_MAX_BYTES`. */
  "metaTooLarge",
  /** META isn't a JSON object of the §5.2 shape. */
  "badMeta",
  /** Text (META, MARKER, NAMES) that isn't valid UTF-8. */
  "badUtf8",
  /** A NAMES record past `CAPTURE_NAME_MAX_BYTES`, or a MARKER past `CAPTURE_MARKER_MAX_BYTES`. */
  "textTooLong",
  /** More than `CAPTURE_MAX_NAMES` names. */
  "tooManyNames",
  /** A record head or payload runs past the records' end. */
  "truncatedRecord",
  /** A record's `len` past its cap (`statusBytesMax` for STATUS, `CAPTURE_RECORD_MAX_BYTES` otherwise). */
  "recordTooLarge",
  /** More records than `recordCount`, or than `uncompressedBytes / 20`. */
  "tooManyRecords",
  /** Fewer records than `recordCount`. */
  "countMismatch",
  /** A `type` at or above 0x80. */
  "unknownRequired",
  /** `len` disagrees with what the type's own fields say. */
  "badLength",
  /** An enum, count or float outside its domain (a reason, kind, table, origin, NaN, a negative time). */
  "badValue",
  /** Anything else in a record: unknown head flags, a WRAP in a file, STATUS in a main-side-only file, a STATUS block whose envelope disagrees with its head. */
  "badRecord",
  /** `seq` not strictly increasing. */
  "badSeq",
  /** `epoch` going backwards. */
  "badEpoch",
  /** `frame` not finite or negative. */
  "badFrame",
  /** A frame more than 1 s before an earlier-written record's in the same epoch. */
  "disorder",
  /** The INDEX record misplaced or its framing disagreeing with the header (its content failing bounds only warns). */
  "badIndex",
  /** The open was cancelled (Worker `cancel`). */
  "cancelled",
] as const;
export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

/** Thrown by every decode step; never a raw `RangeError` from a `DataView` (§5.7). */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  /** Byte offset of the offending field: in the file for header fields, in the uncompressed payload otherwise; -1 when none. */
  readonly offset: number;
  constructor(code: CaptureErrorCode, offset: number, message: string) {
    super(`${code} at ${offset}: ${message}`);
    this.name = "CaptureError";
    this.code = code;
    this.offset = offset;
  }
}

/** The structured-clone form a Worker posts. */
export interface CaptureErrorInfo {
  code: CaptureErrorCode;
  offset: number;
  message: string;
}

// --- the header (§5.1) ------------------------------------------------------------------------------------------------

/** The plain header's fields, decoded. */
export interface CaptureHeader {
  format: number;
  /** ADR 0386: the format's minor (0 in files written before it). */
  formatMinor: number;
  flags: number;
  /** 32 lower-case hex characters. */
  schemaHash: string;
  abiVersion: number;
  envelopeMajor: number;
  envelopeMinor: number;
  statusBytesMax: number;
  sampleRate: number;
  quantumFrames: number;
  statusEveryQuanta: number;
  /** 0 low, 1 default, 2 high. */
  preset: number;
  startDateMs: number;
  keyframeIntervalMs: number;
  metaBytes: number;
  recordBytes: number;
  uncompressedBytes: number;
  recordCount: number;
  indexBytes: number;
  ringBytes: number;
  firstFrame: number;
}

/** What a writer supplies; the sizes and constants are derived by `assembleCapture`. */
export type CaptureHeaderInit = Pick<CaptureHeader, "sampleRate" | "preset" | "startDateMs" | "ringBytes" | "firstFrame"> & {
  truncated?: boolean;
  mainSideOnly?: boolean;
  /** ADR 0348: the file is a take (sets `CAPTURE_FLAG_TAKE`). */
  take?: boolean;
  /** The running core's ABI, from its first STATUS (`Audio.debug().core.abiVersion`); absent (Babylon, or before it): `CAPTURE_ABI_VERSION`. */
  abiVersion?: number;
};

/** Writes the 96 B header at `view[0..96)`. No validation: the writer's values are trusted. */
export function writeCaptureHeader(view: DataView, h: CaptureHeader): void {
  for (let i = 0; i < 8; i++) view.setUint8(i, CAPTURE_MAGIC[i]!);
  view.setUint16(8, h.format, true);
  view.setUint16(10, h.flags, true);
  for (let i = 0; i < 16; i++) view.setUint8(12 + i, parseInt(h.schemaHash.slice(i * 2, i * 2 + 2), 16));
  view.setUint32(28, h.abiVersion, true);
  view.setUint16(32, h.envelopeMajor, true);
  view.setUint16(34, h.envelopeMinor, true);
  view.setUint32(36, h.statusBytesMax, true);
  view.setUint32(40, h.sampleRate, true);
  view.setUint16(44, h.quantumFrames, true);
  view.setUint8(46, h.statusEveryQuanta);
  view.setUint8(47, h.preset);
  view.setFloat64(48, h.startDateMs, true);
  view.setUint32(56, h.keyframeIntervalMs, true);
  view.setUint32(60, h.metaBytes, true);
  view.setUint32(64, h.recordBytes, true);
  view.setUint32(68, h.uncompressedBytes, true);
  view.setUint32(72, h.recordCount, true);
  view.setUint32(76, h.indexBytes, true);
  view.setUint32(80, h.ringBytes, true);
  view.setUint16(84, h.formatMinor, true);
  view.setUint16(86, 0, true);
  view.setFloat64(88, h.firstFrame, true);
}

function hex16(bytes: Uint8Array, off: number): string {
  let s = "";
  for (let i = 0; i < 16; i++) s += bytes[off + i]!.toString(16).padStart(2, "0");
  return s;
}

/**
 * Reads and checks the header, refusing in §5.1's order: length and magic (`badMagic`), the versions (ADR 0386: `format`
 * and its minor, then the core ABI, as `newerFormat` or `olderFormat` naming the file's version and the ones this build
 * reads), `SCHEMA_HASH` (`wireMismatch` for this build's very ABI under another hash; an older minor of its major reads:
 * minors are backward compatible), `uncompressedBytes` (`tooLarge`), then every other field (`newerFormat`/`olderFormat`
 * for the status envelope, `badHeader`, `metaTooLarge`, `tooManyRecords`). Nothing is allocated from a header value.
 */
export function readCaptureHeader(bytes: Uint8Array): CaptureHeader {
  if (bytes.byteLength < CAPTURE_HEADER_BYTES) throw new CaptureError("badMagic", 0, `${bytes.byteLength} B is shorter than the ${CAPTURE_HEADER_BYTES} B capture header`);
  for (let i = 0; i < 8; i++) if (bytes[i] !== CAPTURE_MAGIC[i]) throw new CaptureError("badMagic", i, "not a Myco capture file (bad magic)");
  const v = new DataView(bytes.buffer, bytes.byteOffset, CAPTURE_HEADER_BYTES);
  const format = v.getUint16(8, true);
  const formatMinor = v.getUint16(84, true);
  // ADR 0386: a version this build can't read is refused here, naming the file's version and the ones this build reads,
  // never later as a damaged record.
  const formats = `${CAPTURE_FORMAT}.0\u2013${CAPTURE_FORMAT}.${CAPTURE_FORMAT_MINOR}`;
  if (format > CAPTURE_FORMAT || (format === CAPTURE_FORMAT && formatMinor > CAPTURE_FORMAT_MINOR)) {
    throw new CaptureError("newerFormat", format > CAPTURE_FORMAT ? 8 : 84, incompatible(`capture format ${format}.${formatMinor}`, formats));
  }
  if (format < CAPTURE_FORMAT) throw new CaptureError("olderFormat", 8, `${incompatible(`capture format ${format}.${formatMinor}`, formats)}; old captures are not migrated`);
  const schemaHash = hex16(bytes, 12);
  const abiVersion = v.getUint32(28, true);
  const abis = `${CAPTURE_ABI_VERSION >>> 8}.0\u2013${abiText(CAPTURE_ABI_VERSION)}`;
  const abiMajor = abiVersion >>> 8, myMajor = CAPTURE_ABI_VERSION >>> 8;
  // A newer core minor under this very wire hash wrote the same records (nothing it added reaches the file): it reads.
  if (abiMajor > myMajor || (abiMajor === myMajor && (abiVersion & 0xff) > (CAPTURE_ABI_VERSION & 0xff) && schemaHash !== SCHEMA_HASH)) {
    throw new CaptureError("newerFormat", 28, incompatible(`audio core ABI ${abiText(abiVersion)}`, abis));
  }
  if (abiMajor < myMajor) throw new CaptureError("olderFormat", 28, `${incompatible(`audio core ABI ${abiText(abiVersion)}`, abis)}; re-record with this build`);
  if (schemaHash !== SCHEMA_HASH && !abiReadable(abiVersion)) {
    throw new CaptureError("wireMismatch", 12, `recorded with audio ABI ${abiText(abiVersion)} (wire ${schemaHash}); this build is ABI ${abiText(CAPTURE_ABI_VERSION)} (wire ${SCHEMA_HASH}): re-record with this build`);
  }
  const uncompressedBytes = v.getUint32(68, true);
  const cap = (v.getUint16(10, true) & CAPTURE_FLAG_TAKE) !== 0 ? TAKE_MAX_UNCOMPRESSED_BYTES : CAPTURE_MAX_UNCOMPRESSED_BYTES;
  if (uncompressedBytes > cap) throw new CaptureError("tooLarge", 68, `${uncompressedBytes} B uncompressed is past the ${cap} B cap`);
  const h: CaptureHeader = {
    format, formatMinor, flags: v.getUint16(10, true), schemaHash, abiVersion,
    envelopeMajor: v.getUint16(32, true), envelopeMinor: v.getUint16(34, true), statusBytesMax: v.getUint32(36, true),
    sampleRate: v.getUint32(40, true), quantumFrames: v.getUint16(44, true), statusEveryQuanta: v.getUint8(46), preset: v.getUint8(47),
    startDateMs: v.getFloat64(48, true), keyframeIntervalMs: v.getUint32(56, true), metaBytes: v.getUint32(60, true),
    recordBytes: v.getUint32(64, true), uncompressedBytes, recordCount: v.getUint32(72, true), indexBytes: v.getUint32(76, true),
    ringBytes: v.getUint32(80, true), firstFrame: v.getFloat64(88, true),
  };
  const bad = (off: number, what: string): never => { throw new CaptureError("badHeader", off, what); };
  if (h.flags & ~CAPTURE_FLAGS_KNOWN) bad(10, `unknown flag bits 0x${h.flags.toString(16)}`);
  if (h.envelopeMajor !== VERSION_MAJOR || h.envelopeMinor > VERSION_MINOR) {
    const code = h.envelopeMajor > VERSION_MAJOR || (h.envelopeMajor === VERSION_MAJOR && h.envelopeMinor > VERSION_MINOR) ? "newerFormat" : "olderFormat";
    throw new CaptureError(code, 32, incompatible(`status envelope ${h.envelopeMajor}.${h.envelopeMinor}`, `${VERSION_MAJOR}.0\u2013${VERSION_MAJOR}.${VERSION_MINOR}`));
  }
  if (h.statusBytesMax !== STATUS_BUFFER_BYTES) bad(36, `statusBytesMax ${h.statusBytesMax}, expected ${STATUS_BUFFER_BYTES}`);
  if (h.sampleRate < CAPTURE_MIN_SAMPLE_RATE || h.sampleRate > CAPTURE_MAX_SAMPLE_RATE) bad(40, `sample rate ${h.sampleRate}`);
  if (h.quantumFrames !== QUANTUM_FRAMES) bad(44, `quantumFrames ${h.quantumFrames}`);
  if (h.statusEveryQuanta !== STATUS_EVERY_QUANTA) bad(46, `statusEveryQuanta ${h.statusEveryQuanta}`);
  if (h.preset > 2) bad(47, `preset ${h.preset}`);
  if (!(Number.isFinite(h.startDateMs) && h.startDateMs >= 0)) bad(48, `startDateMs ${h.startDateMs}`);
  if (h.keyframeIntervalMs !== CAPTURE_KEYFRAME_INTERVAL_MS) bad(56, `keyframeIntervalMs ${h.keyframeIntervalMs}`);
  if (h.metaBytes > CAPTURE_META_MAX_BYTES) throw new CaptureError("metaTooLarge", 60, `META ${h.metaBytes} B is past the ${CAPTURE_META_MAX_BYTES} B cap`);
  if (h.metaBytes + h.recordBytes !== h.uncompressedBytes) bad(68, `metaBytes ${h.metaBytes} + recordBytes ${h.recordBytes} != uncompressedBytes ${h.uncompressedBytes}`);
  if (h.recordCount > Math.floor(h.uncompressedBytes / CAPTURE_RECORD_HEAD_BYTES)) throw new CaptureError("tooManyRecords", 72, `recordCount ${h.recordCount} past uncompressedBytes / ${CAPTURE_RECORD_HEAD_BYTES}`);
  if (h.recordBytes < h.recordCount * CAPTURE_RECORD_HEAD_BYTES) bad(64, `recordBytes ${h.recordBytes} can't hold ${h.recordCount} records`);
  const hasIndex = (h.flags & CAPTURE_FLAG_HAS_INDEX) !== 0;
  if (!hasIndex && h.indexBytes !== 0) bad(76, `indexBytes ${h.indexBytes} without hasIndex`);
  if (hasIndex && (h.indexBytes < CAPTURE_RECORD_HEAD_BYTES + INDEX_MIN_BYTES || h.indexBytes > h.recordBytes || h.indexBytes > CAPTURE_RECORD_HEAD_BYTES + CAPTURE_RECORD_MAX_BYTES || h.recordCount === 0)) bad(76, `indexBytes ${h.indexBytes}`);
  if (v.getUint16(86, true) !== 0) bad(86, "reserved is not 0");
  if (!(Number.isFinite(h.firstFrame) && h.firstFrame >= 0)) bad(88, `firstFrame ${h.firstFrame}`);
  return h;
}

/**
 * Whether a file stamped with another wire hash can still be read: its core ABI has this build's major and an older
 * minor (a newer minor is refused first as `newerFormat`, ADR 0386: it may use what this build lacks). A minor only adds (an opcode, a flag bit, an appended word; "no record changes layout", ADR 0328), so a take
 * or capture recorded under an older minor opens. A different major, or this very version under another hash (a schema
 * edit nobody versioned), is `wireMismatch`.
 */
function abiReadable(abi: number): boolean {
  return abi >>> 8 === CAPTURE_ABI_VERSION >>> 8 && (abi & 0xff) < (CAPTURE_ABI_VERSION & 0xff);
}

/** ADR 0386: the words of every version refusal: the file's version and the ones this build reads. */
function incompatible(file: string, reads: string): string {
  return `incompatible version: file is ${file}, this build reads ${reads}`;
}

function abiText(abi: number): string {
  return `${abi >>> 8}.${abi & 0xff}`;
}

// --- META (§5.2) ------------------------------------------------------------------------------------------------------

/** META as decoded: data only. Every name is a string cut to 256 bytes, in a `Map` keyed by id; nothing is evaluated. */
export interface CaptureMeta {
  project: { name: string; version: string };
  engine: string;
  device: { preset: number; sampleRate: number; deviceMemory?: number; userAgent: string };
  /**
   * The mix the runtime played at the take's start, as parsed JSON (data; the profiler names tombstoned buses from it):
   * the runtime's settings shape, which since ADR 0344 is `audio.json`'s runtime view (`toRuntimeSettings`).
   */
  audio: unknown;
  /** The `loudnessTarget` in force, as parsed JSON. */
  target: unknown;
  names: Record<NameTable, Map<number, string>>;
  /** ADR 0348: a take's section (seed, audio hash, emitter names), as parsed JSON; null in a capture. The take reader checks it. */
  take: unknown;
  /** ADR 0348: the take a replay capture recorded the Studio playing (its project path and `audio.json` hash); null otherwise. */
  replayOf: CaptureReplayOf | null;
}

/** ADR 0348: the take a capture of the Studio's replay names in META (`replayOf`). */
export interface CaptureReplayOf {
  /** The take file's project path. */
  path: string;
  /** META `take.audioHash` of that take: which `audio.json` it was recorded against. */
  audioHash: string;
}

/** What a writer supplies: names as `{ [id]: name }` objects or `Map`s. */
export interface CaptureMetaInit {
  project: { name: string; version: string };
  engine: string;
  device: { preset: number; sampleRate: number; deviceMemory?: number; userAgent: string };
  audio: unknown;
  target: unknown;
  names: Partial<Record<NameTable, ReadonlyMap<number, string> | Readonly<Record<number, string>>>>;
  /** ADR 0348: a take's META section; absent in a capture. */
  take?: TakeMetaSection;
  /** ADR 0348: the take a capture of the Studio's replay recorded; absent otherwise. */
  replayOf?: CaptureReplayOf;
}

const utf8Encoder = new TextEncoder();
const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 of `s` cut to at most `max` bytes on a code-point boundary. */
export function cutUtf8(s: string, max: number): string {
  const b = utf8Encoder.encode(s);
  if (b.byteLength <= max) return s;
  let end = max;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return utf8Fatal.decode(b.subarray(0, end));
}

/** Decodes `n` bytes of UTF-8 at `off` in `bytes`, refusing invalid sequences (`badUtf8`). The caller checked bounds. */
export function decodeUtf8(bytes: Uint8Array, off: number, n: number, errorOffset: number): string {
  try {
    return utf8Fatal.decode(bytes.subarray(off, off + n));
  } catch {
    throw new CaptureError("badUtf8", errorOffset, "text is not valid UTF-8");
  }
}

/** META's UTF-8 JSON bytes. Names are cut to 256 bytes and the user agent to 120, as the reader would. */
export function encodeCaptureMeta(meta: CaptureMetaInit): Uint8Array {
  const names: Record<string, Record<string, string>> = {};
  for (const t of NAME_TABLES) {
    const src = meta.names[t];
    const out: Record<string, string> = {};
    if (src) {
      const entries: Iterable<[number | string, string]> = src instanceof Map ? src.entries() : Object.entries(src);
      for (const [id, name] of entries) out[String(id)] = cutUtf8(String(name), CAPTURE_NAME_MAX_BYTES);
    }
    names[t] = out;
  }
  const device = { ...meta.device, userAgent: cutUtf8(meta.device.userAgent, CAPTURE_USER_AGENT_MAX_BYTES) };
  return utf8Encoder.encode(JSON.stringify({ project: meta.project, engine: meta.engine, device, audio: meta.audio, target: meta.target, names, ...(meta.take ? { take: meta.take } : {}), ...(meta.replayOf ? { replayOf: replayOfJson(meta.replayOf) } : {}) }));
}

/** A replay capture's `replayOf`, its strings cut as the reader would. */
function replayOfJson(r: CaptureReplayOf): CaptureReplayOf {
  return { path: cutUtf8(String(r.path), CAPTURE_PATH_MAX_BYTES), audioHash: cutUtf8(String(r.audioHash), CAPTURE_NAME_MAX_BYTES) };
}

/** META `replayOf` as read: both strings, cut; anything else (absent, malformed) is null, never a refusal. */
function readReplayOf(v: unknown): CaptureReplayOf | null {
  if (!isObject(v) || typeof v.path !== "string" || typeof v.audioHash !== "string" || v.path === "") return null;
  return replayOfJson({ path: v.path, audioHash: v.audioHash });
}

/**
 * META from its bytes (`bytes.byteLength` is the header's `metaBytes`, already checked against the 1 MiB cap): fatal
 * UTF-8 (`badUtf8`), `JSON.parse` (`badMeta`), the §5.2 shape with every name coerced to a string and cut to 256 bytes
 * (`badMeta`), at most 65,536 names (`tooManyNames`). `offset` is the META's offset in the payload (0).
 */
export function decodeCaptureMeta(bytes: Uint8Array, offset = 0): CaptureMeta {
  if (bytes.byteLength > CAPTURE_META_MAX_BYTES) throw new CaptureError("metaTooLarge", offset, `META ${bytes.byteLength} B is past the ${CAPTURE_META_MAX_BYTES} B cap`);
  const text = decodeUtf8(bytes, 0, bytes.byteLength, offset);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new CaptureError("badMeta", offset, `META is not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const bad = (what: string): never => { throw new CaptureError("badMeta", offset, what); };
  if (!isObject(json)) bad("META is not a JSON object");
  const m = json as Record<string, unknown>;
  const project = isObject(m.project) ? m.project : bad("META.project is not an object");
  const device = isObject(m.device) ? m.device : bad("META.device is not an object");
  const namesIn = isObject(m.names) ? m.names : bad("META.names is not an object");
  const num = (x: unknown, what: string): number => (typeof x === "number" && Number.isFinite(x) ? x : bad(`${what} is not a finite number`));
  let count = 0;
  const names = {} as Record<NameTable, Map<number, string>>;
  for (const t of NAME_TABLES) {
    const table = new Map<number, string>();
    const src = namesIn[t];
    if (src !== undefined) {
      if (!isObject(src) && !Array.isArray(src)) bad(`META.names.${t} is not an object`);
      for (const key in src as object) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        if (!/^(0|[1-9][0-9]{0,9})$/.test(key) || Number(key) > 0xffffffff) bad(`META.names.${t} has a key that is not a u32 id`);
        if (++count > CAPTURE_MAX_NAMES) throw new CaptureError("tooManyNames", offset, `more than ${CAPTURE_MAX_NAMES} names`);
        table.set(Number(key), cutUtf8(String((src as Record<string, unknown>)[key]), CAPTURE_NAME_MAX_BYTES));
      }
    }
    names[t] = table;
  }
  const out: CaptureMeta = {
    project: { name: cutUtf8(String(project.name ?? ""), CAPTURE_NAME_MAX_BYTES), version: cutUtf8(String(project.version ?? ""), CAPTURE_NAME_MAX_BYTES) },
    engine: cutUtf8(String(m.engine ?? ""), CAPTURE_NAME_MAX_BYTES),
    device: {
      preset: num(device.preset, "META.device.preset"),
      sampleRate: num(device.sampleRate, "META.device.sampleRate"),
      userAgent: cutUtf8(String(device.userAgent ?? ""), CAPTURE_USER_AGENT_MAX_BYTES),
    },
    audio: m.audio ?? null,
    target: m.target ?? null,
    names,
    take: m.take ?? null,
    replayOf: readReplayOf(m.replayOf),
  };
  if (device.deviceMemory !== undefined) out.device.deviceMemory = num(device.deviceMemory, "META.device.deviceMemory");
  return out;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// --- record framing (§5.3) --------------------------------------------------------------------------------------------

/** A record's 20 B head. */
export interface RecordHead {
  type: number;
  flags: number;
  epoch: number;
  /** Payload bytes after the head (the deferred stamp included). */
  len: number;
  seq: number;
  frame: number;
}

/** Writes a record head at `off`; returns 20. */
export function writeRecordHead(view: DataView, off: number, h: RecordHead): number {
  view.setUint8(off, h.type);
  view.setUint8(off + 1, h.flags);
  view.setUint16(off + 2, h.epoch, true);
  view.setUint32(off + 4, h.len, true);
  view.setUint32(off + 8, h.seq, true);
  view.setFloat64(off + 12, h.frame, true);
  return CAPTURE_RECORD_HEAD_BYTES;
}

/**
 * Reads the head at `off`, refusing in this order: fewer than 20 bytes before `end` (`truncatedRecord`); `type` at or
 * above 0x80 (`unknownRequired`); `len` past its cap (`recordTooLarge`, before anything sized by it); the payload past
 * `end` (`truncatedRecord`); unknown head flags (`badRecord`); a frame that isn't finite and non-negative (`badFrame`).
 * `base` is added to offsets in errors (the records' offset in the payload).
 */
export function readRecordHead(view: DataView, off: number, end: number, statusBytesMax: number, base = 0): RecordHead {
  if (off + CAPTURE_RECORD_HEAD_BYTES > end) throw new CaptureError("truncatedRecord", base + off, `record head needs ${CAPTURE_RECORD_HEAD_BYTES} B, ${end - off} left`);
  const type = view.getUint8(off);
  if (type >= RECORD_TYPE_REQUIRED_FIRST) throw new CaptureError("unknownRequired", base + off, `unknown required record type 0x${type.toString(16)}`);
  const len = view.getUint32(off + 4, true);
  const cap = type === RecordType.STATUS ? statusBytesMax : CAPTURE_RECORD_MAX_BYTES;
  if (len > cap) throw new CaptureError("recordTooLarge", base + off + 4, `record type 0x${type.toString(16)} len ${len} past its ${cap} B cap`);
  if (off + CAPTURE_RECORD_HEAD_BYTES + len > end) throw new CaptureError("truncatedRecord", base + off + 4, `record len ${len} runs past the records' end`);
  const flags = view.getUint8(off + 1);
  if (flags & ~RECORD_FLAGS_KNOWN) throw new CaptureError("badRecord", base + off + 1, `unknown record flags 0x${flags.toString(16)}`);
  const frame = view.getFloat64(off + 12, true);
  if (!(Number.isFinite(frame) && frame >= 0)) throw new CaptureError("badFrame", base + off + 12, `frame ${frame}`);
  return { type, flags, epoch: view.getUint16(off + 2, true), len, seq: view.getUint32(off + 8, true), frame };
}

/**
 * ADR 0417: cuts the whole records off the front of `bytes`, a stream of records in this framing that may stop at any
 * byte (a live take's log as the debug link delivers it), calling `each` with every record's head and where its payload
 * starts in `view` (a view of `bytes`). Answers how many bytes the whole records took: the rest is the start of a record
 * still to come. A record whose head `readRecordHead` refuses throws its `CaptureError` (a STATUS record is capped at
 * `CAPTURE_RECORD_MAX_BYTES` here).
 */
export function splitCaptureRecords(bytes: Uint8Array, each: (head: RecordHead, view: DataView, payloadAt: number) => void): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  let off = 0;
  while (end - off >= CAPTURE_RECORD_HEAD_BYTES) {
    const len = view.getUint32(off + 4, true);
    // A record still arriving (one past its cap is refused below, before waiting for bytes that never come).
    if (len <= CAPTURE_RECORD_MAX_BYTES && end - off < CAPTURE_RECORD_HEAD_BYTES + len) break;
    const head = readRecordHead(view, off, end, CAPTURE_RECORD_MAX_BYTES);
    each(head, view, off + CAPTURE_RECORD_HEAD_BYTES);
    off += CAPTURE_RECORD_HEAD_BYTES + head.len;
  }
  return off;
}

/** Bytes the `deferred` stamp takes at the payload's start. */
export const DEFERRED_STAMP_BYTES = 8;

// --- record payloads (§5.3, §5.4, §5.6) -------------------------------------------------------------------------------
//
// Each codec: `encodeX(view, off, p)` writes the payload at `off` and returns its bytes (`xBytes(p)` ahead of time);
// `decodeX(view, off, len, base)` reads a payload of exactly `len` bytes at `off` (the caller has bounds-checked
// `off + len` against the records' end and stripped the deferred stamp), refusing with `badLength` or `badValue`.
// Nothing is allocated before the type's own fields agree with `len`.

export interface EpochPayload {
  reason: number;
  sampleRate: number;
  limiterLatencyFrames: number;
  outputLatencyFrames: number;
  /** Seconds. */
  timeOffset: number;
  perfMs: number;
}
export const EPOCH_BYTES = 32;

export interface GapPayload {
  reason: number;
  perfFrom: number;
  perfTo: number;
  firstSeq: number;
  lastSeq: number;
}
export const GAP_BYTES = 28;

export interface EventPayload {
  perfMs: number;
  kind: number;
  reason: number;
  args: readonly number[];
  /** Present exactly for `EVENT_KINDS_WITH_F32`. */
  f32?: number;
}

export interface MarkerPayload {
  perfMs: number;
  text: string;
}

export interface NamesPayload {
  /** Index into `NAME_TABLES`. */
  table: number;
  id: number;
  name: string;
}

/** A MIXOP: one `MixOp` in §6.2's byte form (`MixOpBytes` of `src/engine/audio/mixOpCodec.ts`), then `perfMs` and `origin`. */
export interface MixOpPayload {
  op: number;
  class: number;
  words: Uint32Array;
  perfMs: number;
  origin: number;
}

/** One INDEX entry (§5.4). `byteOffset` is the KEYFRAME record's head offset from the start of the records (after META). */
export interface IndexEntry {
  epoch: number;
  frame: number;
  byteOffset: number;
  seq: number;
}
export interface IndexPayload {
  entries: readonly IndexEntry[];
  truncatedFromSeq: number;
}
export const INDEX_MIN_BYTES = 8;
export const INDEX_ENTRY_BYTES = 20;

function badLength(base: number, off: number, type: string, len: number, want: number): never {
  throw new CaptureError("badLength", base + off, `${type} payload is ${len} B, its fields say ${want} B`);
}
function badValue(at: number, what: string): never {
  throw new CaptureError("badValue", at, what);
}
function finite(x: number, at: number, what: string): number {
  return Number.isFinite(x) ? x : badValue(at, `${what} ${x}`);
}

export function encodeEpoch(view: DataView, off: number, p: EpochPayload): number {
  view.setUint8(off, p.reason);
  view.setUint8(off + 1, 0); view.setUint8(off + 2, 0); view.setUint8(off + 3, 0);
  view.setUint32(off + 4, p.sampleRate, true);
  view.setUint32(off + 8, p.limiterLatencyFrames, true);
  view.setUint32(off + 12, p.outputLatencyFrames, true);
  view.setFloat64(off + 16, p.timeOffset, true);
  view.setFloat64(off + 24, p.perfMs, true);
  return EPOCH_BYTES;
}
export function decodeEpoch(view: DataView, off: number, len: number, base = 0): EpochPayload {
  if (len !== EPOCH_BYTES) badLength(base, off, "EPOCH", len, EPOCH_BYTES);
  const reason = view.getUint8(off);
  if (reason > EPOCH_REASON_MAX) badValue(base + off, `EPOCH reason ${reason}`);
  const sampleRate = view.getUint32(off + 4, true);
  if (sampleRate < CAPTURE_MIN_SAMPLE_RATE || sampleRate > CAPTURE_MAX_SAMPLE_RATE) badValue(base + off + 4, `EPOCH sample rate ${sampleRate}`);
  return {
    reason, sampleRate,
    limiterLatencyFrames: view.getUint32(off + 8, true),
    outputLatencyFrames: view.getUint32(off + 12, true),
    timeOffset: finite(view.getFloat64(off + 16, true), base + off + 16, "EPOCH timeOffset"),
    perfMs: finite(view.getFloat64(off + 24, true), base + off + 24, "EPOCH perfMs"),
  };
}

export function encodeGap(view: DataView, off: number, p: GapPayload): number {
  view.setUint8(off, p.reason);
  view.setUint8(off + 1, 0); view.setUint8(off + 2, 0); view.setUint8(off + 3, 0);
  view.setFloat64(off + 4, p.perfFrom, true);
  view.setFloat64(off + 12, p.perfTo, true);
  view.setUint32(off + 20, p.firstSeq, true);
  view.setUint32(off + 24, p.lastSeq, true);
  return GAP_BYTES;
}
export function decodeGap(view: DataView, off: number, len: number, base = 0): GapPayload {
  if (len !== GAP_BYTES) badLength(base, off, "GAP", len, GAP_BYTES);
  const reason = view.getUint8(off);
  if (reason < 1 || reason > GAP_REASON_MAX) badValue(base + off, `GAP reason ${reason}`);
  const perfFrom = finite(view.getFloat64(off + 4, true), base + off + 4, "GAP perfFrom");
  const perfTo = finite(view.getFloat64(off + 12, true), base + off + 12, "GAP perfTo");
  if (perfTo < perfFrom) badValue(base + off + 12, `GAP perfTo ${perfTo} before perfFrom ${perfFrom}`);
  const firstSeq = view.getUint32(off + 20, true);
  const lastSeq = view.getUint32(off + 24, true);
  if (lastSeq < firstSeq) badValue(base + off + 24, `GAP lastSeq ${lastSeq} before firstSeq ${firstSeq}`);
  return { reason, perfFrom, perfTo, firstSeq, lastSeq };
}

/** The STATUS block's checks against its record head, without allocating: the wire envelope (magic, major, kind STATUS), `16 + bodyBytes == len`, `currentFrame == frame` (§5.3: a STATUS's frame is its `currentFrame`). Parsing the block is `readStatus` (`wire.generated.ts`), the Worker's (Rc5). */
export function checkStatusPayload(view: DataView, off: number, len: number, frame: number, base = 0): void {
  if (len < STATUS_HEADER_BYTES) badLength(base, off, "STATUS", len, STATUS_HEADER_BYTES);
  if (view.getUint32(off, true) !== MAGIC) throw new CaptureError("badRecord", base + off, "STATUS block has no wire magic");
  if (view.getUint16(off + 4, true) >> 8 !== VERSION_MAJOR) throw new CaptureError("badRecord", base + off + 4, "STATUS block of another wire major");
  if (view.getUint16(off + 6, true) !== Kind.STATUS) throw new CaptureError("badRecord", base + off + 6, "STATUS record holds another message kind");
  const body = view.getUint32(off + 12, true);
  if (16 + body !== len) badLength(base, off + 12, "STATUS", len, 16 + body);
  const frameAt = STATUS_HEADER_COLUMNS.currentFrame[0];
  if (view.getFloat64(off + frameAt, true) !== frame) throw new CaptureError("badRecord", base + off + frameAt, "STATUS currentFrame differs from its record's frame");
}

export function eventBytes(p: Pick<EventPayload, "kind" | "args">): number {
  return 12 + 4 * p.args.length + (EVENT_KINDS_WITH_F32.has(p.kind) ? 4 : 0);
}
export function encodeEvent(view: DataView, off: number, p: EventPayload): number {
  view.setFloat64(off, p.perfMs, true);
  view.setUint8(off + 8, p.kind);
  view.setUint8(off + 9, p.reason);
  view.setUint16(off + 10, p.args.length, true);
  let at = off + 12;
  for (const a of p.args) { view.setUint32(at, a, true); at += 4; }
  if (EVENT_KINDS_WITH_F32.has(p.kind)) { view.setFloat32(at, p.f32 ?? 0, true); at += 4; }
  return at - off;
}
export function decodeEvent(view: DataView, off: number, len: number, base = 0): EventPayload {
  if (len < 12) badLength(base, off, "EVENT", len, 12);
  const kind = view.getUint8(off + 8);
  if (kind < 1 || kind > EVENT_KIND_MAX) badValue(base + off + 8, `EVENT kind ${kind}`);
  const reason = view.getUint8(off + 9);
  const rmax = EVENT_REASON_MAX.get(kind);
  if (rmax !== undefined && (reason < 1 || reason > rmax)) badValue(base + off + 9, `EVENT kind ${kind} reason ${reason}`);
  const argc = view.getUint16(off + 10, true);
  const hasF32 = EVENT_KINDS_WITH_F32.has(kind);
  const want = 12 + 4 * argc + (hasF32 ? 4 : 0);
  if (len !== want) badLength(base, off + 10, "EVENT", len, want);
  const perfMs = finite(view.getFloat64(off, true), base + off, "EVENT perfMs");
  const args = new Array<number>(argc);
  for (let i = 0; i < argc; i++) args[i] = view.getUint32(off + 12 + 4 * i, true);
  const p: EventPayload = { perfMs, kind, reason, args };
  if (hasF32) p.f32 = view.getFloat32(off + 12 + 4 * argc, true);
  return p;
}

export function markerBytes(p: Pick<MarkerPayload, "text">): number {
  return 10 + utf8Encoder.encode(p.text).byteLength;
}
export function encodeMarker(view: DataView, off: number, p: MarkerPayload): number {
  const b = utf8Encoder.encode(p.text);
  view.setFloat64(off, p.perfMs, true);
  view.setUint16(off + 8, b.byteLength, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 10, b.byteLength).set(b);
  return 10 + b.byteLength;
}
export function decodeMarker(view: DataView, off: number, len: number, base = 0): MarkerPayload {
  if (len < 10) badLength(base, off, "MARKER", len, 10);
  const n = view.getUint16(off + 8, true);
  if (n > CAPTURE_MARKER_MAX_BYTES) throw new CaptureError("textTooLong", base + off + 8, `MARKER text ${n} B past ${CAPTURE_MARKER_MAX_BYTES}`);
  if (len !== 10 + n) badLength(base, off + 8, "MARKER", len, 10 + n);
  const perfMs = finite(view.getFloat64(off, true), base + off, "MARKER perfMs");
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return { perfMs, text: decodeUtf8(bytes, off + 10, n, base + off + 10) };
}

export function namesBytes(p: Pick<NamesPayload, "name">): number {
  return 10 + utf8Encoder.encode(p.name).byteLength;
}
/** H3: the NAMES codec (a name first used after the META chunk). Rc1 filled it with the reader's names table. */
export function encodeNames(view: DataView, off: number, p: NamesPayload): number {
  const b = utf8Encoder.encode(p.name);
  view.setUint8(off, p.table);
  view.setUint8(off + 1, 0); view.setUint8(off + 2, 0); view.setUint8(off + 3, 0);
  view.setUint32(off + 4, p.id, true);
  view.setUint16(off + 8, b.byteLength, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 10, b.byteLength).set(b);
  return 10 + b.byteLength;
}
/** H3: NAMES from its payload; a name past 256 B is refused (`textTooLong`), invalid UTF-8 `badUtf8`. */
export function decodeNames(view: DataView, off: number, len: number, base = 0): NamesPayload {
  if (len < 10) badLength(base, off, "NAMES", len, 10);
  const table = view.getUint8(off);
  if (table >= NAME_TABLES.length) badValue(base + off, `NAMES table ${table}`);
  const n = view.getUint16(off + 8, true);
  if (n > CAPTURE_NAME_MAX_BYTES) throw new CaptureError("textTooLong", base + off + 8, `NAMES name ${n} B past ${CAPTURE_NAME_MAX_BYTES}`);
  if (len !== 10 + n) badLength(base, off + 8, "NAMES", len, 10 + n);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return { table, id: view.getUint32(off + 4, true), name: decodeUtf8(bytes, off + 10, n, base + off + 10) };
}

export function mixOpBytes(p: Pick<MixOpPayload, "words">): number {
  return 4 + 4 * p.words.length + 9;
}
export function encodeMixOpRecord(view: DataView, off: number, p: MixOpPayload): number {
  view.setUint8(off, p.op);
  view.setUint8(off + 1, p.class);
  view.setUint16(off + 2, p.words.length, true);
  let at = off + 4;
  for (let i = 0; i < p.words.length; i++) { view.setUint32(at, p.words[i]!, true); at += 4; }
  view.setFloat64(at, p.perfMs, true);
  view.setUint8(at + 8, p.origin);
  return at + 9 - off;
}
export function decodeMixOpRecord(view: DataView, off: number, len: number, base = 0): MixOpPayload {
  if (len < 13) badLength(base, off, "MIXOP", len, 13);
  const op = view.getUint8(off);
  if (op >= CAPTURE_MIXOP_CODES) badValue(base + off, `MIXOP op ${op}`);
  const cls = view.getUint8(off + 1);
  if (cls >= CAPTURE_MIXOP_CLASSES) badValue(base + off + 1, `MIXOP class ${cls}`);
  const argc = view.getUint16(off + 2, true);
  const want = 13 + 4 * argc;
  if (len !== want) badLength(base, off + 2, "MIXOP", len, want);
  const at = off + 4 + 4 * argc;
  const perfMs = finite(view.getFloat64(at, true), base + at, "MIXOP perfMs");
  const origin = view.getUint8(at + 8);
  if (origin > MIXOP_ORIGIN_MAX) badValue(base + at + 8, `MIXOP origin ${origin}`);
  const words = new Uint32Array(argc);
  for (let i = 0; i < argc; i++) words[i] = view.getUint32(off + 4 + 4 * i, true);
  return { op, class: cls, words, perfMs, origin };
}

/**
 * ADR 0348: a take's request record (PLAY .. take KEYFRAME, `engine/audio/take/records.ts`) from its payload, its
 * refusals as `CaptureError`s of the same code. The capture reader checks every request record this way and passes over
 * it; the take reader keeps what it answers.
 */
export function decodeRequestRecord(type: number, view: DataView, off: number, len: number, base = 0): TakeRecord {
  try {
    return decodeTakeRecord(type, view, off, len, base);
  } catch (e) {
    if (e instanceof TakeRecordError) throw new CaptureError(e.code, e.offset, e.message.replace(/^\w+ at \d+: /, ""));
    throw e;
  }
}

export function indexBytes(p: Pick<IndexPayload, "entries">): number {
  return INDEX_MIN_BYTES + INDEX_ENTRY_BYTES * p.entries.length;
}
export function encodeIndex(view: DataView, off: number, p: IndexPayload): number {
  view.setUint32(off, p.entries.length, true);
  let at = off + 4;
  for (const e of p.entries) {
    view.setUint16(at, e.epoch, true);
    view.setUint16(at + 2, 0, true);
    view.setFloat64(at + 4, e.frame, true);
    view.setUint32(at + 12, e.byteOffset, true);
    view.setUint32(at + 16, e.seq, true);
    at += INDEX_ENTRY_BYTES;
  }
  view.setUint32(at, p.truncatedFromSeq, true);
  return at + 4 - off;
}
/** INDEX's framing (`badLength` when `keyframeCount` disagrees with `len`). Whether its entries point at real keyframes is the reader's check, which only warns. */
export function decodeIndex(view: DataView, off: number, len: number, base = 0): IndexPayload {
  if (len < INDEX_MIN_BYTES) badLength(base, off, "INDEX", len, INDEX_MIN_BYTES);
  const n = view.getUint32(off, true);
  if (n > Math.floor((len - INDEX_MIN_BYTES) / INDEX_ENTRY_BYTES)) badLength(base, off, "INDEX", len, INDEX_MIN_BYTES + INDEX_ENTRY_BYTES * Math.min(n, 0xffffff));
  const want = INDEX_MIN_BYTES + INDEX_ENTRY_BYTES * n;
  if (len !== want) badLength(base, off, "INDEX", len, want);
  const entries = new Array<IndexEntry>(n);
  let at = off + 4;
  for (let i = 0; i < n; i++) {
    entries[i] = { epoch: view.getUint16(at, true), frame: view.getFloat64(at + 4, true), byteOffset: view.getUint32(at + 12, true), seq: view.getUint32(at + 16, true) };
    at += INDEX_ENTRY_BYTES;
  }
  return { entries, truncatedFromSeq: view.getUint32(at, true) };
}

// --- KEYFRAME (§5.5): H3 declarations, Rc1b fills ------------------------------------------------------------------

/** One voice row, 24 B. */
export interface KeyframeVoice {
  id: number;
  clip: number;
  slot: number;
  /** 0 playing, 1 virtual, 2 stolen, 3 waitingForData, 4 busMuted, 5 locked. */
  state: number;
  priority: number;
  /** §5.6. */
  reason: number;
  gain: number;
  /** u4.12 raw. */
  pitch: number;
  /** u0.16 raw. */
  audibility: number;
  playheadFrames: number;
}

/** One bus, 56 B: each main-written lane's value and target (`authored`, `runtime`, `snapshot`, `monitor`, `dip`) and the last reported `duck` and `automation`. */
export interface KeyframeBus {
  slot: number;
  gen: number;
  /** bit 0 authored mute, 1 runtime mute, 2 monitor mute, 3 monitor solo, 4 tombstone, 5 metered. */
  flags: number;
  /** [value, target] x authored, runtime, snapshot, monitor, dip: 10 floats in that order. */
  lanes: readonly number[];
  duck: number;
  automation: number;
}

/** One metered bus, 36 B. */
export interface KeyframeMetered {
  slot: number;
  /** bit 0 paused, 1 incomplete, 2 tainted, 3 lower bound. */
  flags: number;
  momentary: number;
  shortTerm: number;
  integrated: number;
  lra: number;
  maxTruePeak: number;
  maxMomentary: number;
  elapsed: number;
}

/** One event instance, 16 B. */
export interface KeyframeEvent {
  id: number;
  asset: number;
  voices: number;
  state: number;
  paramsHash: number;
}

/** One music instance, 40 B (12 reserved). */
export interface KeyframeMusic {
  id: number;
  segment: number;
  state: number;
  pass: number;
  bar: number;
  beat: number;
  tick: number;
  tempo: number;
  pendingTo: number;
  pendingTimeSec: number;
}

/** The mix section (one). */
export interface KeyframeMix {
  slotTableVersion: number;
  monitorActive: number;
  loudnessPausedMask: number;
  targetIndex: number;
  snapshotName: number;
  masterVolume: number;
  hiddenMute: number;
}

/** A KEYFRAME's sections in order, each `u16 count` then items on the wire. */
export interface KeyframePayload {
  voices: readonly KeyframeVoice[];
  buses: readonly KeyframeBus[];
  metered: readonly KeyframeMetered[];
  events: readonly KeyframeEvent[];
  music: readonly KeyframeMusic[];
  mix: KeyframeMix;
}

// Wire layout (§5.5), little-endian, no alignment: six sections in order, each a `u16 count` then `count` items.
//   voices   24 B: u32 id, u32 clip, u8 slot, u8 state, u8 priority, u8 reason, f32 gain, u16 pitch, u16 audibility, u32 playheadFrames
//   buses    56 B: u8 slot, u8 pad, u16 gen, u16 flags, u16 pad, 10 x f32 lanes, f32 duck, f32 automation
//   metered  36 B: u16 slot, u16 flags, f32 momentary, shortTerm, integrated, lra, maxTruePeak, maxMomentary, elapsed, u32 pad
//   events   16 B: u32 id, u32 asset, u16 voices, u8 state, u8 pad, u32 paramsHash
//   music    40 B: u32 id, u32 segment, u8 state, u8 pass, u16 bar, u8 beat, u8 tick, u16 tempo, u32 pendingTo,
//                  f32 pendingTimeSec, 16 reserved (§5.5's fields are 24 B; `KEYFRAME_MUSIC_BYTES` fixes the row at 40)
//   mix      count 1, 17 B: u32 slotTableVersion, u8 monitorActive, u8 loudnessPausedMask, u8 targetIndex, u8 pad,
//                  u32 snapshotName, f32 masterVolume, u8 hiddenMute
// Pads and reserved bytes are written 0 and ignored on read. At every cap the payload is 215,777 B (< 256 KB).

// What the row encodings mean (caps, state codes, flag bits, NO_NAME, the quantising steps) is `keyframeLayout.ts` (ADR 0230):
// its writers (`core/keyframeSource.ts`, `mix/keyframeBus.ts`, the Babylon fallback) are in every game, so they import it,
// not this lazy chunk. `readCaptureKeyframe` below turns a decoded payload back into named values; it is the only decoder.

/** Each section's cap and row size, in wire order (mix last, exactly one). */
const KEYFRAME_SECTIONS: readonly { name: string; cap: number; row: number }[] = [
  { name: "voices", cap: KEYFRAME_MAX_VOICES, row: KEYFRAME_VOICE_BYTES },
  { name: "buses", cap: KEYFRAME_MAX_BUSES, row: KEYFRAME_BUS_BYTES },
  { name: "metered", cap: KEYFRAME_MAX_METERED, row: KEYFRAME_METERED_BYTES },
  { name: "events", cap: KEYFRAME_MAX_EVENTS, row: KEYFRAME_EVENT_BYTES },
  { name: "music", cap: KEYFRAME_MAX_MUSIC, row: KEYFRAME_MUSIC_BYTES },
  { name: "mix", cap: 1, row: KEYFRAME_MIX_BYTES },
];

/** The payload size of `p`: counts as given, so a source past a cap yields its true size (the recorder's GAP `recordTooLarge` path); `encodeKeyframe` refuses it. */
export function keyframeBytes(p: KeyframePayload): number {
  return 6 * KEYFRAME_COUNT_BYTES
    + p.voices.length * KEYFRAME_VOICE_BYTES
    + p.buses.length * KEYFRAME_BUS_BYTES
    + p.metered.length * KEYFRAME_METERED_BYTES
    + p.events.length * KEYFRAME_EVENT_BYTES
    + p.music.length * KEYFRAME_MUSIC_BYTES
    + KEYFRAME_MIX_BYTES;
}

function keyframeCapCheck(n: number, cap: number, what: string): void {
  if (n > cap) throw new RangeError(`encodeKeyframe: ${n} ${what} past the cap of ${cap}`);
}

/** Writes `p` at `off` with no allocation (R13: Rc2 writes straight into the ring); returns the bytes written. Counts past the §5.5 caps throw (`RangeError`, before any byte is written). */
export function encodeKeyframe(view: DataView, off: number, p: KeyframePayload): number {
  const { voices, buses, metered, events, music, mix } = p;
  keyframeCapCheck(voices.length, KEYFRAME_MAX_VOICES, "voices");
  keyframeCapCheck(buses.length, KEYFRAME_MAX_BUSES, "buses");
  keyframeCapCheck(metered.length, KEYFRAME_MAX_METERED, "metered buses");
  keyframeCapCheck(events.length, KEYFRAME_MAX_EVENTS, "events");
  keyframeCapCheck(music.length, KEYFRAME_MAX_MUSIC, "music instances");
  for (let i = 0; i < buses.length; i++) {
    if (buses[i]!.lanes.length !== KEYFRAME_BUS_LANES) throw new RangeError(`encodeKeyframe: bus ${i} has ${buses[i]!.lanes.length} lane floats, not ${KEYFRAME_BUS_LANES}`);
  }
  let at = off;
  view.setUint16(at, voices.length, true); at += 2;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i]!;
    view.setUint32(at, v.id, true);
    view.setUint32(at + 4, v.clip, true);
    view.setUint8(at + 8, v.slot);
    view.setUint8(at + 9, v.state);
    view.setUint8(at + 10, v.priority);
    view.setUint8(at + 11, v.reason);
    view.setFloat32(at + 12, v.gain, true);
    view.setUint16(at + 16, v.pitch, true);
    view.setUint16(at + 18, v.audibility, true);
    view.setUint32(at + 20, v.playheadFrames, true);
    at += KEYFRAME_VOICE_BYTES;
  }
  view.setUint16(at, buses.length, true); at += 2;
  for (let i = 0; i < buses.length; i++) {
    const b = buses[i]!;
    view.setUint8(at, b.slot);
    view.setUint8(at + 1, 0);
    view.setUint16(at + 2, b.gen, true);
    view.setUint16(at + 4, b.flags, true);
    view.setUint16(at + 6, 0, true);
    for (let k = 0; k < KEYFRAME_BUS_LANES; k++) view.setFloat32(at + 8 + 4 * k, b.lanes[k]!, true);
    view.setFloat32(at + 48, b.duck, true);
    view.setFloat32(at + 52, b.automation, true);
    at += KEYFRAME_BUS_BYTES;
  }
  view.setUint16(at, metered.length, true); at += 2;
  for (let i = 0; i < metered.length; i++) {
    const m = metered[i]!;
    view.setUint16(at, m.slot, true);
    view.setUint16(at + 2, m.flags, true);
    view.setFloat32(at + 4, m.momentary, true);
    view.setFloat32(at + 8, m.shortTerm, true);
    view.setFloat32(at + 12, m.integrated, true);
    view.setFloat32(at + 16, m.lra, true);
    view.setFloat32(at + 20, m.maxTruePeak, true);
    view.setFloat32(at + 24, m.maxMomentary, true);
    view.setFloat32(at + 28, m.elapsed, true);
    view.setUint32(at + 32, 0, true);
    at += KEYFRAME_METERED_BYTES;
  }
  view.setUint16(at, events.length, true); at += 2;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    view.setUint32(at, e.id, true);
    view.setUint32(at + 4, e.asset, true);
    view.setUint16(at + 8, e.voices, true);
    view.setUint8(at + 10, e.state);
    view.setUint8(at + 11, 0);
    view.setUint32(at + 12, e.paramsHash, true);
    at += KEYFRAME_EVENT_BYTES;
  }
  view.setUint16(at, music.length, true); at += 2;
  for (let i = 0; i < music.length; i++) {
    const m = music[i]!;
    view.setUint32(at, m.id, true);
    view.setUint32(at + 4, m.segment, true);
    view.setUint8(at + 8, m.state);
    view.setUint8(at + 9, m.pass);
    view.setUint16(at + 10, m.bar, true);
    view.setUint8(at + 12, m.beat);
    view.setUint8(at + 13, m.tick);
    view.setUint16(at + 14, m.tempo, true);
    view.setUint32(at + 16, m.pendingTo, true);
    view.setFloat32(at + 20, m.pendingTimeSec, true);
    for (let k = 24; k < KEYFRAME_MUSIC_BYTES; k += 4) view.setUint32(at + k, 0, true);
    at += KEYFRAME_MUSIC_BYTES;
  }
  view.setUint16(at, 1, true); at += 2;
  view.setUint32(at, mix.slotTableVersion, true);
  view.setUint8(at + 4, mix.monitorActive);
  view.setUint8(at + 5, mix.loudnessPausedMask);
  view.setUint8(at + 6, mix.targetIndex);
  view.setUint8(at + 7, 0);
  view.setUint32(at + 8, mix.snapshotName, true);
  view.setFloat32(at + 12, mix.masterVolume, true);
  view.setUint8(at + 16, mix.hiddenMute);
  at += KEYFRAME_MIX_BYTES;
  return at - off;
}

/**
 * Walks the six sections' counts against their caps and `len`, reading only the counts: a count past its cap is
 * `badValue` (the mix's must be exactly 1), a section running past `len` or bytes left over is `badLength`. Writes the
 * offset of each section's count into `out` when given (the decoder's); allocates nothing.
 */
function walkKeyframe(view: DataView, off: number, len: number, base: number, out?: Int32Array): void {
  const end = off + len;
  let at = off;
  for (let s = 0; s < KEYFRAME_SECTIONS.length; s++) {
    const sec = KEYFRAME_SECTIONS[s]!;
    if (at + KEYFRAME_COUNT_BYTES > end) badLength(base, at, "KEYFRAME", len, at + KEYFRAME_COUNT_BYTES - off);
    const n = view.getUint16(at, true);
    if (n > sec.cap) badValue(base + at, `KEYFRAME ${sec.name} count ${n} past the cap of ${sec.cap}`);
    if (s === KEYFRAME_SECTIONS.length - 1 && n !== 1) badValue(base + at, `KEYFRAME mix count ${n}, expected 1`);
    if (out) out[s] = at;
    const next = at + KEYFRAME_COUNT_BYTES + n * sec.row;
    if (next > end) badLength(base, at, "KEYFRAME", len, next - off);
    at = next;
  }
  if (at !== end) badLength(base, off, "KEYFRAME", len, at - off);
}

/** The bounds check alone, no allocation: the reader's open calls it on every KEYFRAME. */
export function checkKeyframe(view: DataView, off: number, len: number, base = 0): void {
  walkKeyframe(view, off, len, base);
}

/** A float that may be ±Infinity (silent loudness readings are -Infinity) but never NaN. */
function notNaN(x: number, at: number, what: string): number {
  return x === x ? x : badValue(at, `${what} is NaN`);
}

const keyframeSectionAt = new Int32Array(KEYFRAME_SECTIONS.length);

/**
 * Reads a payload of exactly `len` bytes. Framing first (`checkKeyframe`: counts past their caps `badValue`, counts
 * disagreeing with `len` `badLength`), before any allocation; then each row, refusing an unknown voice state or flag
 * bit and a NaN float (`badValue`). Allocates its output only: one array per section, sized by the checked count, and
 * one object per row.
 */
export function decodeKeyframe(view: DataView, off: number, len: number, base = 0): KeyframePayload {
  const sec = keyframeSectionAt;
  walkKeyframe(view, off, len, base, sec);
  let at = sec[0]!;
  const voices = new Array<KeyframeVoice>(view.getUint16(at, true));
  at += 2;
  for (let i = 0; i < voices.length; i++) {
    const state = view.getUint8(at + 9);
    if (state > KEYFRAME_VOICE_STATE_MAX) badValue(base + at + 9, `KEYFRAME voice ${i} state ${state}`);
    voices[i] = {
      id: view.getUint32(at, true), clip: view.getUint32(at + 4, true), slot: view.getUint8(at + 8), state,
      priority: view.getUint8(at + 10), reason: view.getUint8(at + 11),
      gain: notNaN(view.getFloat32(at + 12, true), base + at + 12, `KEYFRAME voice ${i} gain`),
      pitch: view.getUint16(at + 16, true), audibility: view.getUint16(at + 18, true), playheadFrames: view.getUint32(at + 20, true),
    };
    at += KEYFRAME_VOICE_BYTES;
  }
  at = sec[1]!;
  const buses = new Array<KeyframeBus>(view.getUint16(at, true));
  at += 2;
  for (let i = 0; i < buses.length; i++) {
    const flags = view.getUint16(at + 4, true);
    if (flags & ~KEYFRAME_BUS_FLAGS_KNOWN) badValue(base + at + 4, `KEYFRAME bus ${i} flags 0x${flags.toString(16)}`);
    const lanes = new Array<number>(KEYFRAME_BUS_LANES);
    for (let k = 0; k < KEYFRAME_BUS_LANES; k++) lanes[k] = notNaN(view.getFloat32(at + 8 + 4 * k, true), base + at + 8 + 4 * k, `KEYFRAME bus ${i} lane ${k}`);
    buses[i] = {
      slot: view.getUint8(at), gen: view.getUint16(at + 2, true), flags, lanes,
      duck: notNaN(view.getFloat32(at + 48, true), base + at + 48, `KEYFRAME bus ${i} duck`),
      automation: notNaN(view.getFloat32(at + 52, true), base + at + 52, `KEYFRAME bus ${i} automation`),
    };
    at += KEYFRAME_BUS_BYTES;
  }
  at = sec[2]!;
  const metered = new Array<KeyframeMetered>(view.getUint16(at, true));
  at += 2;
  for (let i = 0; i < metered.length; i++) {
    const flags = view.getUint16(at + 2, true);
    if (flags & ~KEYFRAME_METERED_FLAGS_KNOWN) badValue(base + at + 2, `KEYFRAME metered ${i} flags 0x${flags.toString(16)}`);
    for (let k = 4; k < 32; k += 4) notNaN(view.getFloat32(at + k, true), base + at + k, `KEYFRAME metered ${i} reading ${(k - 4) / 4}`);
    metered[i] = {
      slot: view.getUint16(at, true), flags,
      momentary: view.getFloat32(at + 4, true), shortTerm: view.getFloat32(at + 8, true), integrated: view.getFloat32(at + 12, true),
      lra: view.getFloat32(at + 16, true), maxTruePeak: view.getFloat32(at + 20, true), maxMomentary: view.getFloat32(at + 24, true),
      elapsed: view.getFloat32(at + 28, true),
    };
    at += KEYFRAME_METERED_BYTES;
  }
  at = sec[3]!;
  const events = new Array<KeyframeEvent>(view.getUint16(at, true));
  at += 2;
  for (let i = 0; i < events.length; i++) {
    events[i] = { id: view.getUint32(at, true), asset: view.getUint32(at + 4, true), voices: view.getUint16(at + 8, true), state: view.getUint8(at + 10), paramsHash: view.getUint32(at + 12, true) };
    at += KEYFRAME_EVENT_BYTES;
  }
  at = sec[4]!;
  const music = new Array<KeyframeMusic>(view.getUint16(at, true));
  at += 2;
  for (let i = 0; i < music.length; i++) {
    music[i] = {
      id: view.getUint32(at, true), segment: view.getUint32(at + 4, true), state: view.getUint8(at + 8), pass: view.getUint8(at + 9),
      bar: view.getUint16(at + 10, true), beat: view.getUint8(at + 12), tick: view.getUint8(at + 13), tempo: view.getUint16(at + 14, true),
      pendingTo: view.getUint32(at + 16, true),
      pendingTimeSec: notNaN(view.getFloat32(at + 20, true), base + at + 20, `KEYFRAME music ${i} pendingTimeSec`),
    };
    at += KEYFRAME_MUSIC_BYTES;
  }
  at = sec[5]! + 2;
  const mix: KeyframeMix = {
    slotTableVersion: view.getUint32(at, true), monitorActive: view.getUint8(at + 4), loudnessPausedMask: view.getUint8(at + 5),
    targetIndex: view.getUint8(at + 6), snapshotName: view.getUint32(at + 8, true),
    masterVolume: notNaN(view.getFloat32(at + 12, true), base + at + 12, "KEYFRAME mix masterVolume"), hiddenMute: view.getUint8(at + 16),
  };
  return { voices, buses, metered, events, music, mix };
}

// --- KEYFRAME read back by name (ADR 0227's follow-up) -------------------------------------------------------------------

/** A lane's value now and where it is heading. */
export interface CaptureLane {
  value: number;
  target: number;
}

/** A voice row by name: the state as its name, pitch as a playback rate, audibility 0..1. */
export interface CaptureKeyframeVoice {
  id: number;
  clip: number;
  slot: number;
  state: CaptureVoiceState;
  priority: number;
  /** Why the voice is in its state, as the sink's word (`reasons.ts`, ADR 0260); null for none. */
  reason: CaptureVoiceReason | null;
  gain: number;
  /** Playback rate (1 is the clip's own). */
  pitch: number;
  /** 0..1. */
  audibility: number;
  playheadFrames: number;
}

/** A bus row by name: the five main-written lanes, the core-reported `duck` and `automation` values, and each flag as a boolean. */
export interface CaptureKeyframeBus {
  slot: number;
  gen: number;
  lanes: { authored: CaptureLane; runtime: CaptureLane; snapshot: CaptureLane; monitor: CaptureLane; dip: CaptureLane };
  duck: number;
  automation: number;
  authoredMute: boolean;
  runtimeMute: boolean;
  monitorMute: boolean;
  monitorSolo: boolean;
  /** A removed bus kept silent in its slot. */
  tombstone: boolean;
  metered: boolean;
}

/** A metered bus's readings, with its flags as booleans. */
export interface CaptureKeyframeMetered {
  slot: number;
  paused: boolean;
  incomplete: boolean;
  tainted: boolean;
  /** `maxTruePeak` is a lower bound. */
  lowerBound: boolean;
  momentary: number;
  shortTerm: number;
  integrated: number;
  lra: number;
  maxTruePeak: number;
  maxMomentary: number;
  elapsed: number;
}

/** An event instance (the wire's `state` byte is reserved and always 0, so it is not read). */
export interface CaptureKeyframeEvent {
  id: number;
  asset: number;
  voices: number;
  paramsHash: number;
}

/** A music instance: names as ids or null, the state by name (null for a code this build doesn't know), a pending transition or null. */
export interface CaptureKeyframeMusic {
  id: number;
  segment: number | null;
  state: CaptureMusicState | null;
  pass: number;
  bar: number;
  beat: number;
  tick: number;
  tempo: number;
  pending: { to: number; seconds: number } | null;
}

/** The mix section. (The wire's `loudnessPausedMask` repeats the metered rows' `paused`, so it is not read.) */
export interface CaptureKeyframeMix {
  slotTableVersion: number;
  monitorActive: boolean;
  targetIndex: number;
  /** The snapshot in force, by its `snapshots` id; null for none. */
  snapshot: number | null;
  masterVolume: number;
  hiddenMute: boolean;
}

/** A KEYFRAME by name: what the reader answers for the Profiler (`CaptureSeekState.keyframe`). */
export interface CaptureKeyframe {
  voices: readonly CaptureKeyframeVoice[];
  buses: readonly CaptureKeyframeBus[];
  metered: readonly CaptureKeyframeMetered[];
  events: readonly CaptureKeyframeEvent[];
  music: readonly CaptureKeyframeMusic[];
  mix: CaptureKeyframeMix;
}

const named = (id: number): number | null => (id === NO_NAME ? null : id);
const lane = (l: readonly number[], k: number): CaptureLane => ({ value: l[2 * k]!, target: l[2 * k + 1]! });

/**
 * One metered row by name: `readCaptureKeyframe`'s, for a reader that wants only the metered section (the Worker's loudness
 * lane reads one per KEYFRAME and would otherwise name every voice row).
 */
export function readKeyframeMetered(m: KeyframeMetered): CaptureKeyframeMetered {
  return {
    slot: m.slot,
    paused: (m.flags & KeyframeMeteredFlag.paused) !== 0, incomplete: (m.flags & KeyframeMeteredFlag.incomplete) !== 0,
    tainted: (m.flags & KeyframeMeteredFlag.tainted) !== 0, lowerBound: (m.flags & KeyframeMeteredFlag.lowerBound) !== 0,
    momentary: m.momentary, shortTerm: m.shortTerm, integrated: m.integrated, lra: m.lra, maxTruePeak: m.maxTruePeak,
    maxMomentary: m.maxMomentary, elapsed: m.elapsed,
  };
}

/** The inverse of the row encodings (`keyframeLayout.ts`), over a payload `decodeKeyframe` already checked. */
export function readCaptureKeyframe(p: KeyframePayload): CaptureKeyframe {
  return {
    voices: p.voices.map((v) => ({
      id: v.id, clip: v.clip, slot: v.slot, state: KEYFRAME_VOICE_STATES[v.state]!, priority: v.priority,
      reason: voiceRowReason(KEYFRAME_VOICE_STATES[v.state]!, v.reason), gain: v.gain,
      pitch: v.pitch / KEYFRAME_PITCH_ONE, audibility: v.audibility / KEYFRAME_AUDIBILITY_ONE, playheadFrames: v.playheadFrames,
    })),
    buses: p.buses.map((b) => ({
      slot: b.slot, gen: b.gen,
      lanes: { authored: lane(b.lanes, 0), runtime: lane(b.lanes, 1), snapshot: lane(b.lanes, 2), monitor: lane(b.lanes, 3), dip: lane(b.lanes, 4) },
      duck: b.duck, automation: b.automation,
      authoredMute: (b.flags & KeyframeBusFlag.authoredMute) !== 0, runtimeMute: (b.flags & KeyframeBusFlag.runtimeMute) !== 0,
      monitorMute: (b.flags & KeyframeBusFlag.monitorMute) !== 0, monitorSolo: (b.flags & KeyframeBusFlag.monitorSolo) !== 0,
      tombstone: (b.flags & KeyframeBusFlag.tombstone) !== 0, metered: (b.flags & KeyframeBusFlag.metered) !== 0,
    })),
    metered: p.metered.map(readKeyframeMetered),
    events: p.events.map((e) => ({ id: e.id, asset: e.asset, voices: e.voices, paramsHash: e.paramsHash })),
    music: p.music.map((m) => ({
      id: m.id, segment: named(m.segment), state: KEYFRAME_MUSIC_STATES[m.state] ?? null, pass: m.pass, bar: m.bar, beat: m.beat,
      tick: m.tick, tempo: m.tempo, pending: m.pendingTo === NO_NAME ? null : { to: m.pendingTo, seconds: m.pendingTimeSec },
    })),
    mix: {
      slotTableVersion: p.mix.slotTableVersion, monitorActive: p.mix.monitorActive !== 0, targetIndex: p.mix.targetIndex,
      snapshot: named(p.mix.snapshotName), masterVolume: p.mix.masterVolume, hiddenMute: p.mix.hiddenMute !== 0,
    },
  };
}

// --- a whole record, and a whole file (writers and tests) -------------------------------------------------------------

/** A record of any type, for writers and tests. `stamp` is the deferred stamp (sets the `deferred` flag). */
export type CaptureRecordInit = { epoch: number; seq: number; frame: number; stamp?: number } & (
  | { type: typeof RecordType.EPOCH; payload: EpochPayload }
  | { type: typeof RecordType.GAP; payload: GapPayload }
  | { type: typeof RecordType.STATUS; payload: Uint8Array }
  | { type: typeof RecordType.KEYFRAME; payload: KeyframePayload | Uint8Array }
  | { type: typeof RecordType.EVENT; payload: EventPayload }
  | { type: typeof RecordType.MARKER; payload: MarkerPayload }
  | { type: typeof RecordType.NAMES; payload: NamesPayload }
  | { type: typeof RecordType.MIXOP; payload: MixOpPayload }
  | { type: typeof RecordType.INDEX; payload: IndexPayload }
  /** Any other type (WRAP, unknown, tests' raw bodies): the payload bytes as given. */
  | { type: number; payload: Uint8Array }
);

/** Payload bytes of `r` (the deferred stamp included). */
export function recordPayloadBytes(r: CaptureRecordInit): number {
  const stamp = r.stamp !== undefined ? DEFERRED_STAMP_BYTES : 0;
  const p = r.payload;
  if (p instanceof Uint8Array) return stamp + p.byteLength;
  switch (r.type) {
    case RecordType.EPOCH: return stamp + EPOCH_BYTES;
    case RecordType.GAP: return stamp + GAP_BYTES;
    case RecordType.KEYFRAME: return stamp + keyframeBytes(p as KeyframePayload);
    case RecordType.EVENT: return stamp + eventBytes(p as EventPayload);
    case RecordType.MARKER: return stamp + markerBytes(p as MarkerPayload);
    case RecordType.NAMES: return stamp + namesBytes(p as NamesPayload);
    case RecordType.MIXOP: return stamp + mixOpBytes(p as MixOpPayload);
    case RecordType.INDEX: return stamp + indexBytes(p as IndexPayload);
    default: throw new Error(`recordPayloadBytes: type 0x${r.type.toString(16)} needs raw payload bytes`);
  }
}

/** Writes head and payload of `r` at `off`; returns the bytes written (20 + len). */
export function encodeRecord(view: DataView, off: number, r: CaptureRecordInit): number {
  const len = recordPayloadBytes(r);
  writeRecordHead(view, off, { type: r.type, flags: r.stamp !== undefined ? RECORD_FLAG_DEFERRED : 0, epoch: r.epoch, len, seq: r.seq, frame: r.frame });
  let at = off + CAPTURE_RECORD_HEAD_BYTES;
  if (r.stamp !== undefined) { view.setFloat64(at, r.stamp, true); at += DEFERRED_STAMP_BYTES; }
  const p = r.payload;
  if (p instanceof Uint8Array) {
    new Uint8Array(view.buffer, view.byteOffset + at, p.byteLength).set(p);
  } else {
    switch (r.type) {
      case RecordType.EPOCH: encodeEpoch(view, at, p as EpochPayload); break;
      case RecordType.GAP: encodeGap(view, at, p as GapPayload); break;
      case RecordType.KEYFRAME: encodeKeyframe(view, at, p as KeyframePayload); break;
      case RecordType.EVENT: encodeEvent(view, at, p as EventPayload); break;
      case RecordType.MARKER: encodeMarker(view, at, p as MarkerPayload); break;
      case RecordType.NAMES: encodeNames(view, at, p as NamesPayload); break;
      case RecordType.MIXOP: encodeMixOpRecord(view, at, p as MixOpPayload); break;
      case RecordType.INDEX: encodeIndex(view, at, p as IndexPayload); break;
    }
  }
  return CAPTURE_RECORD_HEAD_BYTES + len;
}

/** Concatenated records (no header, no META): a records region or a live segment. */
export function encodeRecords(records: readonly CaptureRecordInit[]): Uint8Array {
  let total = 0;
  for (const r of records) total += CAPTURE_RECORD_HEAD_BYTES + recordPayloadBytes(r);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const r of records) off += encodeRecord(view, off, r);
  return out;
}

/**
 * A whole uncompressed file: the header (sizes, constants and flags derived; `compressed` clear), META and the
 * records. With `index`, an INDEX record listing every KEYFRAME is appended (seq one past the last record's, epoch and
 * frame the last record's) and `hasIndex` set. The saver (Rc4) compresses the part after the header and sets the flag.
 */
export function assembleCapture(init: CaptureHeaderInit, meta: CaptureMetaInit | Uint8Array, records: readonly CaptureRecordInit[], opts: { index?: boolean; truncatedFromSeq?: number } = {}): Uint8Array {
  const metaBytes = meta instanceof Uint8Array ? meta : encodeCaptureMeta(meta);
  const all = [...records];
  let indexLen = 0;
  if (opts.index) {
    const entries: IndexEntry[] = [];
    let off = 0;
    for (const r of records) {
      if (r.type === RecordType.KEYFRAME) entries.push({ epoch: r.epoch, frame: r.frame, byteOffset: off, seq: r.seq });
      off += CAPTURE_RECORD_HEAD_BYTES + recordPayloadBytes(r);
    }
    const last = records[records.length - 1];
    const rec: CaptureRecordInit = { type: RecordType.INDEX, epoch: last?.epoch ?? 0, seq: (last?.seq ?? 0) + 1, frame: last?.frame ?? 0, payload: { entries, truncatedFromSeq: opts.truncatedFromSeq ?? 0 } };
    all.push(rec);
    indexLen = CAPTURE_RECORD_HEAD_BYTES + recordPayloadBytes(rec);
  }
  const body = encodeRecords(all);
  const flags = (init.truncated ? CAPTURE_FLAG_TRUNCATED : 0) | (init.mainSideOnly ? CAPTURE_FLAG_MAIN_SIDE_ONLY : 0) | (opts.index ? CAPTURE_FLAG_HAS_INDEX : 0) | (init.take ? CAPTURE_FLAG_TAKE : 0);
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + metaBytes.byteLength + body.byteLength);
  writeCaptureHeader(new DataView(out.buffer), {
    format: CAPTURE_FORMAT, formatMinor: CAPTURE_FORMAT_MINOR, flags, schemaHash: SCHEMA_HASH, abiVersion: init.abiVersion ?? CAPTURE_ABI_VERSION,
    envelopeMajor: VERSION_MAJOR, envelopeMinor: VERSION_MINOR, statusBytesMax: STATUS_BUFFER_BYTES,
    sampleRate: init.sampleRate, quantumFrames: QUANTUM_FRAMES, statusEveryQuanta: STATUS_EVERY_QUANTA, preset: init.preset,
    startDateMs: init.startDateMs, keyframeIntervalMs: CAPTURE_KEYFRAME_INTERVAL_MS, metaBytes: metaBytes.byteLength,
    recordBytes: body.byteLength, uncompressedBytes: metaBytes.byteLength + body.byteLength, recordCount: all.length,
    indexBytes: indexLen, ringBytes: init.ringBytes, firstFrame: init.firstFrame,
  });
  out.set(metaBytes, CAPTURE_HEADER_BYTES);
  out.set(body, CAPTURE_HEADER_BYTES + metaBytes.byteLength);
  return out;
}

// --- the Worker protocol (H3; Rc5 implements `capture/worker.ts`, Rc6 `appendSegment`) -------------------------------

/** A column `range` can return (Rc5 and Pf1 own the vocabulary; a string so H3 needn't guess it). */
export type CaptureColumn = string;

/** What `open` answers: enough for the overview before any `seek`. */
export interface CaptureSummary {
  header: CaptureHeader;
  meta: CaptureMeta;
  recordCount: number;
  keyframeCount: number;
  epochCount: number;
  /** Seconds on the profiler's continuous axis (each EPOCH's `timeOffset`). */
  startSeconds: number;
  endSeconds: number;
  truncated: boolean;
  /** Non-fatal findings: an INDEX that failed its bounds (scanned instead), a differing `audio` section (Rc5). */
  warnings: readonly string[];
}

/** The table at one instant (Rc5 fills the fields beyond the cursor; Rc1b's keyframe types are its parts). */
export interface CaptureSnapshot {
  seconds: number;
  epoch: number;
  frame: number;
  seq: number;
  /** The keyframe it was rebuilt from. */
  keyframeSeq: number;
}

// Pf6 (M5b, W7): the loudness protocol. Structural twins of `runtime/mix/loudnessTrackModel.ts`'s types (this module imports
// nothing from the editor); times are seconds on the Worker's continuous axis.

/** The values at a time on one bus (`LoudnessValues`); LUFS or dBTP, `-Infinity` where undefined. */
export interface CaptureLoudnessValues {
  time: number;
  momentary: number;
  shortTerm: number;
  integrated: number;
  lra: number;
  truePeak: number;
  peak: number;
  incomplete: boolean;
}
/** A span the series has no audio for (`LoudnessGap`). */
export interface CaptureLoudnessGap { kind: "lost" | "epoch"; from: number; to: number; lost: number }
/** A span outside the target (`LoudnessMark`); warn only. */
export interface CaptureLoudnessMark {
  bus: number;
  kind: "over" | "under";
  metric: "integrated" | "shortTerm" | "momentary" | "truePeak";
  from: number;
  to: number;
}
/** A target as `audio.loudnessTargets` has it; the Worker reads it and changes nothing. */
export interface CaptureLoudnessTarget { name?: string; integrated: number; tolerance: number; truePeak: number }
/** One bus's series, as parallel columns (transferred): sample i is at `time[i]`. `incomplete` is 0 or 1. */
export interface CaptureLoudnessColumns {
  time: Float64Array;
  momentary: Float64Array;
  shortTerm: Float64Array;
  integrated: Float64Array;
  lra: Float64Array;
  truePeak: Float64Array;
  peak: Float64Array;
  incomplete: Uint8Array;
}

/** Editor -> Worker. `id` names the request; `cancel` names the request to cancel. */
export type CaptureWorkerRequest =
  /** Pf6: the buses the capture's STATUS records meter (slot, sample count) and how the series was built. */
  | { type: "loudnessInfo"; id: number }
  /** Pf6: one bus's series over [t0, t1] (the whole capture by default). */
  | { type: "loudnessSeries"; id: number; slot: number; t0?: number; t1?: number }
  /** Pf6: the values at `t` for one bus (every bus when `slot` is omitted): the newest sample at or before `t`. */
  | { type: "loudnessAt"; id: number; t: number; slot?: number }
  /** Pf6: the spans outside `target` for every bus. */
  | { type: "loudnessMarks"; id: number; target: CaptureLoudnessTarget; metrics?: readonly ("integrated" | "shortTerm" | "momentary")[]; truePeak?: boolean }
  /** A file's bytes (transferred), or for a live view the 96 B header plus raw META with no records (`recordCount` 0). */
  | { type: "open"; id: number; source: "file" | "live"; bytes: ArrayBuffer }
  /** Live (R17, Rc6): one sealed segment of raw records (starting at a KEYFRAME, no header), continuing the open view's seq and epoch. */
  | { type: "appendSegment"; id: number; bytes: ArrayBuffer }
  | { type: "seek"; id: number; seconds: number }
  | { type: "range"; id: number; t0: number; t1: number; columns: readonly CaptureColumn[] }
  | { type: "cancel"; id: number }
  | { type: "close"; id: number };

/** Worker -> editor. Typed arrays in `range` and `loudnessSeries` are transferred. */
export type CaptureWorkerResponse =
  | { type: "loudnessInfo"; id: number; mode: "replay" | "seek"; buses: { slot: number; samples: number }[] }
  | { type: "loudnessSeries"; id: number; slot: number; columns: CaptureLoudnessColumns; gaps: CaptureLoudnessGap[] }
  | { type: "loudnessAt"; id: number; t: number; buses: { slot: number; values: CaptureLoudnessValues | null }[] }
  | { type: "loudnessMarks"; id: number; marks: CaptureLoudnessMark[] }
  | { type: "progress"; id: number; phase: "inflate" | "records"; done: number; total: number }
  | { type: "opened"; id: number; summary: CaptureSummary }
  | { type: "appended"; id: number; summary: CaptureSummary }
  | { type: "snapshot"; id: number; snapshot: CaptureSnapshot }
  | { type: "range"; id: number; t0: number; t1: number; columns: Record<CaptureColumn, Float64Array | Float32Array | Uint32Array> }
  | { type: "cancelled"; id: number }
  | { type: "closed"; id: number }
  | { type: "error"; id: number; error: CaptureErrorInfo };
