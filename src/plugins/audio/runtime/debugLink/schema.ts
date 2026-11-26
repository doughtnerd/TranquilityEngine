// The audio debug-link topic's schema (ADR 0376's "audio topics" gap, 0348's open question, ADR 0403 plan contract C4):
// what the Audio Studio and the editor ask a running build's audio for, and in what form. Both ends import this module:
// the build's topic (`topic.ts`, A1; `upload.ts`, A2; `mixCommands.ts`, A3) and the tools' one audio link client
// (`editor/debugLink/audioLinkClient.ts`, ADR 0417), which the Studio's Profiler, Take and Mixer use.
// The topic is registered by A1 (`audio/runtime/index.ts`), not here.
//
// Topic `audio`, channel `reliable` (`DebugTopic.channel`): a capture segment or an upload chunk lost would leave a hole
// a live follow can't skip (plan §12 finding 6).
//
// **Subscriptions** (`AudioSubscriptionParams`):
// - `{ kind: "capture" }`: the build joins the capture ring as an owner (`LiveHost.join`, as the Profiler's live follow
//   does) and sends the live feed: first the ring's head (`LiveRecording.head()`) as `AUDIO_CAPTURE_HEAD` pieces, then
//   each sealed segment, in order, as `AUDIO_CAPTURE_SEGMENT` pieces; if the ring evicts a segment before it was sent
//   (`liveLost`), one `AUDIO_CAPTURE_LOST` record and nothing after it. Unsubscribing ends the build's hold.
// - `{ kind: "upload", upload }`: the bytes of an upload prepared by `take.upload` as `AUDIO_TAKE_CHUNK` records, in
//   order, one chunk per sample. The tool unsubscribes once complete (below); closing early abandons it.
// - `{ kind: "take" }` (ADR 0408): the take's state, one `AUDIO_TAKE_STATE` record (`TakeStateReply` as JSON) now and
//   each time it changes, however it changed (F10, the game's script, a request). While a tool holds it the tool owns
//   the build's takes: the build's F10 trigger only starts and stops them and saves nothing itself; the tool uploads a
//   stopped take and decides where it's saved.
// - `{ kind: "takeLive" }`: the live take feed, a picture of what the game asks while a take records (however it was
//   started). For the running take, else the last one kept (nothing while there is none): first one `AUDIO_TAKE_LIVE_START`
//   record (`TakeLiveStart` as JSON: the facts META gets when the take starts), then, in order, the emitters it names as
//   `AUDIO_TAKE_LIVE_EMITTERS` records (only the new ones each time) and its log as `AUDIO_TAKE_LIVE_LOG` pieces: the take
//   recorder's log bytes, the request records, take keyframes and pictures (`FRAME`) in the capture framing (20 B heads,
//   payloads as `engine/audio/take/records.ts` encodes them; plugin records 0x40..0x7e too), cut at any byte into pieces
//   of at most `TAKE_LIVE_LOG_BYTES`, each saying its byte offset and the take's seconds (an empty piece just moves the
//   clock, a few times a second); once the take stops, one `AUDIO_TAKE_LIVE_END` record (`TakeLiveEnd`: META's take
//   section less the emitters, and why it stopped by itself). A new take starts over with a new start record (its `take`
//   id differs). Reading it neither claims the build's takes nor plays anything.
//
// **Requests** (`{ method, params }`, answered by a JSON reply or an error with the message):
// - `take.start` (no params) → `TakeStateReply` once recording (`Audio.take.start()`); an error if the core can't record.
// - `take.stop` (no params) → `TakeStateReply` (`Audio.take.stop()`; the take is kept for an upload).
// - `take.mark` `TakeMarkParams` → `TakeStateReply` (`Audio.take.mark(text)`; a no-op while no take records).
// - `take.frames` `TakeFramesParams` → `TakeFramesReply`: the width, pixels, of the pictures takes started from now on
//   record (`TAKE_PICTURE_MIN_WIDTH`..`TAKE_PICTURE_MAX_WIDTH`; a running take keeps its own); an error with the message
//   for a width outside that.
// - `take.upload` `TakeUploadParams` → `TakeUploadReply`: stops a running take, makes the take's file bytes (what
//   `Audio.take.save()` writes) and keeps them as upload `upload` until the next `take.upload` or the link closes; an
//   error "nothing recorded: call Audio.take.start() first" when there is no take.
//
// - `build.audio` (no params) → `TakeUploadReply` (ADR 0410): an upload of the build's audio index (`BuildAudioIndex` as
//   UTF-8 JSON). `build.file` `BuildFileParams` → `TakeUploadReply`: an upload of that file's bytes. Their uploads are
//   sent by the same `upload` subscription, with ids from `BUILD_FILE_UPLOAD_FIRST_ID`.
//
// **Command** `mix.op` `MixOpCommand`: one live mix op in the capture's MIXOP byte form (`mixOpCodec.ts`, §6.2) with the
// names and buses it interns carried beside it, applied at the build's next frame start through `mixer.apply`; a
// refused op (or one this build can't decode) answers an error with the message.
//
// **Size** (plan §7a, O5): every sample message stays within `AUDIO_MESSAGE_BYTES` (64 KiB) on every transport: a sample
// holds whole records totalling at most `AUDIO_SAMPLE_BYTES`, so capture pieces carry at most `CAPTURE_PIECE_BYTES`
// and upload chunks `TAKE_CHUNK_BYTES` (a take of 256 MiB is about 4,100 chunks).
//
// **When an upload is complete:** the reply says `bytes` and `chunks`; chunks arrive in order with `index` 0, 1, … and
// each says `total` (= `chunks`). The tool has the whole take when it holds `chunks` chunks whose bytes add up to
// `bytes`; an index out of order, a `total` that differs from the reply or more bytes than `bytes` means the upload
// failed (unsubscribe and say so).
import { decodeMixOp, encodeMixOp } from "../../../../engine/audio/mixOpCodec";
import type { MixOp } from "../../../../engine/audio/mixOps";
import type { TakeMetaSection } from "../../../../engine/audio/take/reader";
import { RECORD_HEAD_BYTES } from "../../../../engine/debugLink/records";
import type { AudioTakeState, TakeLiveFacts } from "../capture/take";

/** The topic's name. */
export const AUDIO_TOPIC = "audio";
/** The topic's channel (`DebugTopic.channel`). */
export const AUDIO_TOPIC_CHANNEL = "reliable";

/** The largest sample message on the audio topic, envelope included (64 KiB). */
export const AUDIO_MESSAGE_BYTES = 65_536;
/** The records of one sample together, heads included: the message less room for the envelope's head and topic. */
export const AUDIO_SAMPLE_BYTES = AUDIO_MESSAGE_BYTES - 64;
/** A capture piece's head: u32 part, u16 index, u16 count. */
export const CAPTURE_PIECE_HEAD_BYTES = 8;
/** The most bytes of a head or segment one capture piece carries. */
export const CAPTURE_PIECE_BYTES = AUDIO_SAMPLE_BYTES - RECORD_HEAD_BYTES - CAPTURE_PIECE_HEAD_BYTES;
/** An upload chunk's head: u32 upload, u32 index, u32 total. */
export const TAKE_CHUNK_HEAD_BYTES = 12;
/** The most take bytes one upload chunk carries (every chunk but the last carries exactly this many). */
export const TAKE_CHUNK_BYTES = AUDIO_SAMPLE_BYTES - RECORD_HEAD_BYTES - TAKE_CHUNK_HEAD_BYTES;

/** Record types on the audio topic (below 0x80, `records.ts`; the animation topic uses 0x40). */
export const AudioLinkRecord = {
  /** A piece of the capture ring's head (`LiveRecording.head()`); part 0. Payload: `CapturePiece`. */
  captureHead: 0x50,
  /** A piece of one sealed segment of raw capture records (what `appendSegment` takes); part = the segment's id. Payload: `CapturePiece`. */
  captureSegment: 0x51,
  /** The ring evicted a segment before it was sent: the live feed ended. No payload. */
  captureLost: 0x52,
  /** One chunk of an upload. Payload: `TakeChunk`. */
  takeChunk: 0x53,
  /** ADR 0408: the take's state now. Payload: `TakeStateReply` as UTF-8 JSON. */
  takeState: 0x54,
  /** The live take feed: a take began (or is the one followed). Payload: `TakeLiveStart` as UTF-8 JSON. */
  takeLiveStart: 0x55,
  /** The live take feed: a piece of the take's log. Payload: `TakeLiveLogPiece`. */
  takeLiveLog: 0x56,
  /** The live take feed: emitters the take named since the last such record. Payload: `TakeLiveEmitters` as UTF-8 JSON. */
  takeLiveEmitters: 0x57,
  /** The live take feed: the take stopped. Payload: `TakeLiveEnd` as UTF-8 JSON. */
  takeLiveEnd: 0x58,
} as const;

/** A live take log piece's head: u32 take, u32 byte offset, f64 seconds. */
export const TAKE_LIVE_LOG_HEAD_BYTES = 16;
/** The most log bytes one live take log piece carries. */
export const TAKE_LIVE_LOG_BYTES = AUDIO_SAMPLE_BYTES - RECORD_HEAD_BYTES - TAKE_LIVE_LOG_HEAD_BYTES;

/** A subscription's parameters. */
export type AudioSubscriptionParams =
  /** The live capture feed. */
  | { readonly kind: "capture" }
  /** Upload `upload`'s chunks (`TakeUploadReply.upload`). */
  | { readonly kind: "upload"; readonly upload: number }
  /** ADR 0408: the take's state as it changes (the tool owns the build's takes while it holds this). */
  | { readonly kind: "take" }
  /** The live take feed: the running (else last) take's facts, emitters and log as it grows. */
  | { readonly kind: "takeLive" };

/** The requests' method names. */
export const AudioRequest = { start: "take.start", stop: "take.stop", mark: "take.mark", frames: "take.frames", upload: "take.upload", buildAudio: "build.audio", buildFile: "build.file" } as const;

/** ADR 0410: build file uploads' ids start here, apart from take uploads' (both use the `upload` subscription). */
export const BUILD_FILE_UPLOAD_FIRST_ID = 0x4000_0000;

/** ADR 0410: a file of the build's audio: a project path (`project`) or a build path such as a package (`build`). */
export interface BuildAudioFile {
  readonly kind: "project" | "build";
  readonly path: string;
  /** A JSON file's text hash (`fnv1a`), so a changed file downloads again; null for a sound or a build file. */
  readonly hash: string | null;
}

/** ADR 0410: `build.audio`'s index (the upload's bytes, as UTF-8 JSON): the build's audio, file by file. */
export interface BuildAudioIndex {
  /** The project's name, as a take's META names it. */
  readonly project: string;
  /** The mix settings' hash, as a take records it (`take.audioHash`). */
  readonly audioHash: string;
  /** The build's media table (`game.json`'s `audio`), or null where it has none. */
  readonly manifest: unknown;
  readonly files: readonly BuildAudioFile[];
}

/** ADR 0410: `build.file`'s params: which file to upload. */
export interface BuildFileParams {
  readonly kind: "project" | "build";
  readonly path: string;
}
/** The command's name. */
export const MIX_OP_COMMAND = "mix.op";

/** `take.start`, `take.stop` and `take.mark`'s reply: the take after the request. */
export interface TakeStateReply {
  readonly state: AudioTakeState;
  /** Seconds recorded (the running take's, else the last take's). */
  readonly seconds: number;
}

/** `take.mark`'s params. */
export interface TakeMarkParams {
  /** The marker's text (cut to the capture's 120 UTF-8 bytes by the take). */
  readonly text: string;
}

/** `take.frames`'s params. */
export interface TakeFramesParams {
  /** The pictures' width, pixels (their height keeps the view's aspect; a smaller view isn't scaled up). */
  readonly width: number;
}

/** `take.frames`'s reply: the width in force for the next take. */
export interface TakeFramesReply {
  readonly width: number;
}

/** The live take feed's first record for a take: its id and the facts META gets when it starts. */
export interface TakeLiveStart extends TakeLiveFacts {
  /** The take's id on this build: a new take, a new id. */
  readonly take: number;
}

/** A piece of a live take's log: `bytes` from byte `offset` of take `take`'s log, sent when the take had run `seconds`. */
export interface TakeLiveLogPiece {
  readonly take: number;
  readonly offset: number;
  readonly seconds: number;
  readonly bytes: Uint8Array;
}

/** Emitters a live take named since the last such record: names by id ("0" is the listener). */
export interface TakeLiveEmitters {
  readonly take: number;
  readonly emitters: Readonly<Record<string, string>>;
}

/** A live take stopped: META's take section (its emitters were sent as `TakeLiveEmitters`) and why it stopped by itself. */
export interface TakeLiveEnd {
  readonly take: number;
  readonly section: Omit<TakeMetaSection, "emitters">;
  /** Why it stopped by itself (the cap, the recorder released); null when it was stopped. */
  readonly message: string | null;
}

/** `take.upload`'s params (none yet: the build's one take). */
export type TakeUploadParams = Readonly<Record<string, never>>;

/** `take.upload`'s reply. */
export interface TakeUploadReply {
  /** The upload's id, for the `upload` subscription; a new one each `take.upload`. */
  readonly upload: number;
  /** The take file's size. */
  readonly bytes: number;
  /** Chunks it arrives in: `ceil(bytes / chunkBytes)`, at least 1. */
  readonly chunks: number;
  /** Bytes per chunk but the last (`TAKE_CHUNK_BYTES`). */
  readonly chunkBytes: number;
  /** The take's length, seconds. */
  readonly seconds: number;
}

/** A capture piece: part `part` (0 for the head, else the segment's id), piece `index` of `count`, its bytes. */
export interface CapturePiece {
  readonly part: number;
  readonly index: number;
  readonly count: number;
  readonly bytes: Uint8Array;
}

/** An upload chunk: chunk `index` of `total` of upload `upload`, its bytes. */
export interface TakeChunk {
  readonly upload: number;
  readonly index: number;
  readonly total: number;
  readonly bytes: Uint8Array;
}

/**
 * `mix.op`'s params: `MixOpBytes` (`op`, `class`, `words` as u32 numbers) whose name ids index `names` and whose bus refs
 * index `buses`, so the op reads the same on a build whose interned ids differ. `class` is the sender's guess
 * (`none`); the build's `mixer.apply` classifies the op itself.
 */
export interface MixOpCommand {
  readonly op: number;
  readonly class: number;
  readonly words: readonly number[];
  readonly names: readonly string[];
  readonly buses: readonly string[];
}

/** A subscription's parameters read, or why they aren't any. */
export function readAudioSubscription(params: unknown): AudioSubscriptionParams | { refused: string } {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  if (p.kind === "capture") return { kind: "capture" };
  if (p.kind === "take") return { kind: "take" };
  if (p.kind === "takeLive") return { kind: "takeLive" };
  if (p.kind === "upload") {
    if (typeof p.upload === "number" && Number.isInteger(p.upload) && p.upload >= 0) return { kind: "upload", upload: p.upload };
    return { refused: "an upload subscription needs the upload's id (take.upload's reply)" };
  }
  return { refused: `the audio topic has no "${String(p.kind)}" subscription (capture, upload, take or takeLive)` };
}

/** A capture piece's record payload. */
export function encodeCapturePiece(piece: CapturePiece): Uint8Array {
  if (piece.bytes.byteLength > CAPTURE_PIECE_BYTES) throw new RangeError(`a capture piece carries at most ${CAPTURE_PIECE_BYTES} bytes`);
  const out = new Uint8Array(CAPTURE_PIECE_HEAD_BYTES + piece.bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, piece.part >>> 0, true);
  view.setUint16(4, piece.index, true);
  view.setUint16(6, piece.count, true);
  out.set(piece.bytes, CAPTURE_PIECE_HEAD_BYTES);
  return out;
}

/** A capture piece from its record payload, or why it isn't one. `bytes` is a view of `payload`. */
export function decodeCapturePiece(payload: Uint8Array): CapturePiece | { refused: string } {
  if (payload.byteLength < CAPTURE_PIECE_HEAD_BYTES) return { refused: "a capture piece is shorter than its head" };
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const piece = { part: view.getUint32(0, true), index: view.getUint16(4, true), count: view.getUint16(6, true), bytes: payload.subarray(CAPTURE_PIECE_HEAD_BYTES) };
  if (piece.count === 0 || piece.index >= piece.count) return { refused: `capture piece ${piece.index} of ${piece.count} doesn't exist` };
  return piece;
}

/** A take state record's payload. */
export function encodeTakeState(state: TakeStateReply): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ state: state.state, seconds: state.seconds }));
}

const TAKE_STATES: readonly AudioTakeState[] = ["idle", "loading", "recording", "stopped"];

/** A take state from its record payload, or why it isn't one. */
export function decodeTakeState(payload: Uint8Array): TakeStateReply | { refused: string } {
  try {
    const v = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    if (TAKE_STATES.includes(v.state as AudioTakeState) && typeof v.seconds === "number") return { state: v.state as AudioTakeState, seconds: v.seconds };
  } catch {
    // below
  }
  return { refused: "a take state record isn't a take's state" };
}

const json = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const parsed = (payload: Uint8Array): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(payload));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A live take start record's payload. */
export function encodeTakeLiveStart(start: TakeLiveStart): Uint8Array {
  const { take, project, engine, device, started, audioHash, seed, seeded, pictures, pictureWidth } = start;
  return json({ take, project, engine, device, started, audioHash, seed, seeded, pictures, pictureWidth });
}

/** A live take start from its record payload, or why it isn't one. */
export function decodeTakeLiveStart(payload: Uint8Array): TakeLiveStart | { refused: string } {
  const v = parsed(payload);
  if (
    v && isId(v.take) && typeof v.project === "string" && typeof v.engine === "string" && typeof v.device === "string" && isNum(v.started)
    && typeof v.audioHash === "string" && isId(v.seed) && typeof v.seeded === "boolean" && typeof v.pictures === "boolean" && isNum(v.pictureWidth)
  ) {
    return {
      take: v.take, project: v.project, engine: v.engine, device: v.device, started: v.started, audioHash: v.audioHash, seed: v.seed, seeded: v.seeded,
      pictures: v.pictures, pictureWidth: v.pictureWidth,
    };
  }
  return { refused: "a live take start record isn't a take's facts" };
}

/** A live take log piece's record payload. */
export function encodeTakeLiveLog(piece: TakeLiveLogPiece): Uint8Array {
  if (piece.bytes.byteLength > TAKE_LIVE_LOG_BYTES) throw new RangeError(`a live take log piece carries at most ${TAKE_LIVE_LOG_BYTES} bytes`);
  const out = new Uint8Array(TAKE_LIVE_LOG_HEAD_BYTES + piece.bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, piece.take >>> 0, true);
  view.setUint32(4, piece.offset >>> 0, true);
  view.setFloat64(8, piece.seconds, true);
  out.set(piece.bytes, TAKE_LIVE_LOG_HEAD_BYTES);
  return out;
}

/** A live take log piece from its record payload, or why it isn't one. `bytes` is a view of `payload`. */
export function decodeTakeLiveLog(payload: Uint8Array): TakeLiveLogPiece | { refused: string } {
  if (payload.byteLength < TAKE_LIVE_LOG_HEAD_BYTES) return { refused: "a live take log piece is shorter than its head" };
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const seconds = view.getFloat64(8, true);
  if (!(Number.isFinite(seconds) && seconds >= 0)) return { refused: `a live take log piece's seconds ${seconds} aren't a time` };
  return { take: view.getUint32(0, true), offset: view.getUint32(4, true), seconds, bytes: payload.subarray(TAKE_LIVE_LOG_HEAD_BYTES) };
}

/** A live take emitters record's payload. */
export function encodeTakeLiveEmitters(e: TakeLiveEmitters): Uint8Array {
  return json({ take: e.take, emitters: e.emitters });
}

/** Live take emitters from their record payload, or why they aren't. */
export function decodeTakeLiveEmitters(payload: Uint8Array): TakeLiveEmitters | { refused: string } {
  const v = parsed(payload);
  const e = v?.emitters;
  if (v && isId(v.take) && e && typeof e === "object" && !Array.isArray(e)) {
    const emitters: Record<string, string> = {};
    for (const [k, name] of Object.entries(e as Record<string, unknown>)) {
      if (!/^(0|[1-9][0-9]{0,9})$/.test(k) || typeof name !== "string") return { refused: "a live take emitters record names an emitter oddly" };
      emitters[k] = name;
    }
    return { take: v.take, emitters };
  }
  return { refused: "a live take emitters record isn't a take's emitters" };
}

/** A live take end record's payload. */
export function encodeTakeLiveEnd(end: TakeLiveEnd): Uint8Array {
  const { audioHash, seed, seeded, duration, frames } = end.section;
  return json({ take: end.take, section: { audioHash, seed, seeded, duration, frames }, message: end.message });
}

/** A live take end from its record payload, or why it isn't one. */
export function decodeTakeLiveEnd(payload: Uint8Array): TakeLiveEnd | { refused: string } {
  const v = parsed(payload);
  const s = v?.section as Record<string, unknown> | undefined;
  if (
    v && isId(v.take) && s && typeof s === "object" && typeof s.audioHash === "string" && isId(s.seed) && typeof s.seeded === "boolean"
    && isNum(s.duration) && s.duration >= 0 && typeof s.frames === "boolean" && (v.message === null || typeof v.message === "string")
  ) {
    return { take: v.take, section: { audioHash: s.audioHash, seed: s.seed, seeded: s.seeded, duration: s.duration, frames: s.frames }, message: v.message };
  }
  return { refused: "a live take end record isn't a take's end" };
}

/** An upload chunk's record payload. */
export function encodeTakeChunk(chunk: TakeChunk): Uint8Array {
  if (chunk.bytes.byteLength > TAKE_CHUNK_BYTES) throw new RangeError(`an upload chunk carries at most ${TAKE_CHUNK_BYTES} bytes`);
  const out = new Uint8Array(TAKE_CHUNK_HEAD_BYTES + chunk.bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, chunk.upload >>> 0, true);
  view.setUint32(4, chunk.index >>> 0, true);
  view.setUint32(8, chunk.total >>> 0, true);
  out.set(chunk.bytes, TAKE_CHUNK_HEAD_BYTES);
  return out;
}

/** An upload chunk from its record payload, or why it isn't one. `bytes` is a view of `payload`. */
export function decodeTakeChunk(payload: Uint8Array): TakeChunk | { refused: string } {
  if (payload.byteLength < TAKE_CHUNK_HEAD_BYTES) return { refused: "an upload chunk is shorter than its head" };
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const chunk = { upload: view.getUint32(0, true), index: view.getUint32(4, true), total: view.getUint32(8, true), bytes: payload.subarray(TAKE_CHUNK_HEAD_BYTES) };
  if (chunk.total === 0 || chunk.index >= chunk.total) return { refused: `upload chunk ${chunk.index} of ${chunk.total} doesn't exist` };
  return chunk;
}

/** `op` as `mix.op`'s params. Throws as `encodeMixOp` does for an op it can't encode. */
export function mixOpCommand(op: MixOp): MixOpCommand {
  const names: string[] = [];
  const buses: string[] = [];
  const intern = (list: string[], s: string) => {
    const at = list.indexOf(s);
    return at >= 0 ? at : list.push(s) - 1;
  };
  const bytes = encodeMixOp(op, "none", { nameId: (s) => intern(names, s), busRef: (b) => intern(buses, b) });
  return { op: bytes.op, class: bytes.class, words: Array.from(bytes.words), names, buses };
}

/** `mix.op`'s params read back into the op, or why they can't be. Never throws. */
export function readMixOpCommand(params: unknown): { op: MixOp } | { refused: string } {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const isU32 = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  if (!isU32(p.op) || !isU32(p.class) || !Array.isArray(p.words) || !p.words.every(isU32) || !strings(p.names) || !strings(p.buses)) {
    return { refused: "mix.op needs op, class, words, names and buses" };
  }
  const names = p.names;
  const buses = p.buses;
  const at = (list: string[], i: number, what: string) => {
    const s = list[i];
    if (s === undefined) throw new Error(`mix.op names ${what} ${i}, which it doesn't carry`);
    return s;
  };
  try {
    const { op } = decodeMixOp({ op: p.op as number, class: p.class as number, words: Uint32Array.from(p.words as number[]) }, { name: (id) => at(names, id, "name"), bus: (ref) => at(buses, ref, "bus") });
    return { op };
  } catch (err) {
    return { refused: (err as Error)?.message ?? String(err) };
  }
}
