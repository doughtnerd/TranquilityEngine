/**
 * ADR 0348: the byte form of a take's request records (`*.sporesample`). A take is a capture file (ADR 0171/0172 framing: a
 * plain header, a JSON META block, typed records with a 20 B head, an INDEX, deflate) whose stream carries, beside the
 * profile records, the requests the game made of audio. This module is the request records' payload codecs, pure and
 * shared by the writer (the runtime's take recorder) and the readers (the capture reader passes over them, the take reader
 * decodes them). The framing (heads, seq, epochs, the header) stays the capture format's (`plugins/audio/runtime/capture/
 * format.ts`), which calls in here.
 *
 * **Untrusted input.** Every decode checks its length against the record's own fields before allocating, caps every string
 * and count, and refuses rather than misreads: a `TakeRecordError` (the capture reader turns it into its `CaptureError` with
 * the same code). Every payload starts with `t`, an f64 of seconds on the take's clock (0 = recording start, never negative).
 */
import type { Vec3 } from "../spatial/testSceneTypes";
import type { TakeFrame, TakeKeyframe, TakePlayOptions, TakeRequest, TakeSayOptions, TakeSayPick } from "./types";

/** Request record `type` codes in the capture framing (all below 0x80: §5.3's skippable range). */
export const TakeRecordType = {
  PLAY: 0x10,
  STOP: 0x11,
  RELEASE: 0x12,
  PARAM: 0x13,
  POSE: 0x14,
  MIX: 0x15,
  TRIGGER: 0x16,
  MARK: 0x17,
  FRAME: 0x18,
  /** A take KEYFRAME (what is alive, for seeking); the profile's KEYFRAME is the capture's 0x04. */
  KEYFRAME: 0x19,
  /** ADR 0354 §10: a line played by key. */
  LINE: 0x1a,
  /** ADR 0354 §10: the audio and subtitle languages changed. */
  LANGUAGE: 0x1b,
  /** ADR 0355 §6: an `Audio.say` as asked, with its resolved arguments and pick. */
  SAY: 0x1c,
  /** ADR 0355 §6: a queued say started or was dropped. */
  SAYSTATE: 0x1d,
  /** ADR 0386: a handle paused its instance (`pause()`). */
  PAUSE: 0x1e,
  /** ADR 0386: a handle resumed its instance (`resume()`). */
  RESUME: 0x1f,
  /** ADR 0386: a handle faded its instance (`fade(to, seconds)`). */
  FADE: 0x20,
} as const;
export type TakeRecordTypeCode = (typeof TakeRecordType)[keyof typeof TakeRecordType];

const FIRST = TakeRecordType.PLAY;
const LAST = TakeRecordType.FADE;
/** True for a request record type. */
export function isTakeRecordType(type: number): boolean {
  return type >= FIRST && type <= LAST;
}

/** The id an absent instance (a global parameter) or emitter (a flat play) carries. */
export const TAKE_NONE = 0xffff_ffff;
/** A path (PLAY, KEYFRAME), UTF-8 bytes. */
export const TAKE_PATH_MAX_BYTES = 1024;
/** A parameter, bus, trigger or snapshot name, UTF-8 bytes. */
export const TAKE_NAME_MAX_BYTES = 256;
/** MARK text, UTF-8 bytes. */
export const TAKE_MARK_MAX_BYTES = 1024;
/** Parameters on one PLAY or one keyframe instance, globals in one keyframe. */
export const TAKE_MAX_PARAMETERS = 256;
/** Emitters in one POSE record. */
export const TAKE_MAX_POSES = 1024;
/** Instances in one take KEYFRAME (the writer keeps the newest when more are alive). */
export const TAKE_MAX_KEYFRAME_INSTANCES = 2048;
/** A FRAME's picture, bytes (fits a capture record's 256 KB cap with its head). */
export const TAKE_FRAME_MAX_BYTES = 240 * 1024;
/** A FRAME's width and height, pixels. */
export const TAKE_FRAME_MAX_SIDE = 4096;
/** Arguments on one SAY (a dialogue event has at most 8; the cap leaves room). */
export const TAKE_MAX_SAY_ARGS = 64;
/** SAY `state` codes, in `TakeSayState` order. */
export const TAKE_SAY_STATES = ["playing", "queued", "refused"] as const;
/** SAY `whenBusy` codes. */
export const TAKE_SAY_WHEN_BUSY = ["queue", "interrupt", "drop"] as const;
/** SAYSTATE `state` codes. */
export const TAKE_SAY_STATE_CHANGES = ["playing", "dropped"] as const;
/**
 * The take format's minor version: 1 adds LINE, LANGUAGE, SAY and SAYSTATE (ADR 0354 §10, 0355 §6); 2 adds PAUSE, RESUME
 * and FADE (ADR 0386). They sit in the skippable range, so a reader of an older minor would pass over them by length and
 * replay something else: since ADR 0386 the capture header carries this minor (`CAPTURE_FORMAT_MINOR`) and a reader
 * refuses a newer one up front.
 */
export const TAKE_FORMAT_MINOR = 2;

/** MIX `op` codes, in `TakeRequest` "mix" order. */
export const TAKE_MIX_OPS = ["busVolume", "busFade", "snapshotStart", "snapshotStop", "masterVolume"] as const;
export type TakeMixOp = (typeof TAKE_MIX_OPS)[number];

/** Why a request record was refused; the codes are the capture format's of the same meaning. */
export type TakeRecordErrorCode = "badLength" | "badValue" | "textTooLong" | "badUtf8";

/** Thrown by every decode; `offset` is the offending field's offset in the view (plus the caller's `base`). */
export class TakeRecordError extends Error {
  constructor(readonly code: TakeRecordErrorCode, readonly offset: number, message: string) {
    super(`${code} at ${offset}: ${message}`);
    this.name = "TakeRecordError";
  }
}

const enc = new TextEncoder();
const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 of `s` cut to at most `max` bytes on a code-point boundary. */
export function cutTakeText(s: string, max: number): Uint8Array {
  const b = enc.encode(s);
  if (b.byteLength <= max) return b;
  let end = max;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return b.subarray(0, end);
}

// --- a cursor over one payload ------------------------------------------------------------------------------------------

/** The largest finite f32. */
const F32_MAX = 3.4028234663852886e38;

/** Writes a payload at `off` of `view`, little-endian. `bytes` is the count written so far. */
class Out {
  at: number;
  constructor(private readonly view: DataView, private readonly off: number) { this.at = off; }
  get bytes(): number { return this.at - this.off; }
  u8(n: number): void { this.view.setUint8(this.at, n); this.at += 1; }
  u16(n: number): void { this.view.setUint16(this.at, n, true); this.at += 2; }
  u32(n: number): void { this.view.setUint32(this.at, n >>> 0, true); this.at += 4; }
  /** A finite value past the f32 range is written at its edge (rounding it would give an infinity, which the reader refuses). */
  f32(x: number): void { this.view.setFloat32(this.at, x > F32_MAX ? F32_MAX : x < -F32_MAX ? -F32_MAX : x, true); this.at += 4; }
  f64(x: number): void { this.view.setFloat64(this.at, x, true); this.at += 8; }
  raw(b: Uint8Array): void { new Uint8Array(this.view.buffer, this.view.byteOffset + this.at, b.byteLength).set(b); this.at += b.byteLength; }
  /** `u16 n` then `n` bytes. */
  text(b: Uint8Array): void { this.u16(b.byteLength); this.raw(b); }
  vec(v: Vec3): void { this.f32(v.x); this.f32(v.y); this.f32(v.z); }
}

/** Reads a payload of exactly `len` bytes at `off`; every read is bounds-checked first. */
class In {
  at: number;
  private readonly end: number;
  constructor(private readonly view: DataView, private readonly off: number, len: number, private readonly base: number, private readonly what: string) {
    this.at = off;
    this.end = off + len;
  }
  private need(n: number): void {
    if (this.at + n > this.end) throw new TakeRecordError("badLength", this.base + this.at, `${this.what} payload ends before its fields (${this.end - this.off} B)`);
  }
  u8(): number { this.need(1); return this.view.getUint8(this.at++); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  /** A finite f32. */
  f32(name: string): number { this.need(4); const at = this.at; const v = this.view.getFloat32(at, true); this.at += 4; return this.finite(v, at, name); }
  /** A finite f64. */
  f64(name: string): number { this.need(8); const at = this.at; const v = this.view.getFloat64(at, true); this.at += 8; return this.finite(v, at, name); }
  /** `t`: finite and not negative. */
  time(): number {
    const at = this.at;
    const t = this.f64("t");
    if (t < 0) throw new TakeRecordError("badValue", this.base + at, `${this.what} t ${t} is negative`);
    return t;
  }
  vec(name: string): Vec3 { return { x: this.f32(name), y: this.f32(name), z: this.f32(name) }; }
  /** `u16 n` then `n` UTF-8 bytes, `n` at most `max`. */
  text(max: number, name: string): string {
    const at = this.at;
    const n = this.u16();
    if (n > max) throw new TakeRecordError("textTooLong", this.base + at, `${this.what} ${name} ${n} B past ${max}`);
    this.need(n);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.at, n);
    this.at += n;
    try {
      return fatal.decode(bytes);
    } catch {
      throw new TakeRecordError("badUtf8", this.base + at + 2, `${this.what} ${name} is not valid UTF-8`);
    }
  }
  /** A count at most `max` whose rows of at least `minRow` bytes fit the rest (checked before anything is allocated). */
  count(max: number, minRow: number, name: string): number {
    const at = this.at;
    const n = this.u16();
    if (n > max) throw new TakeRecordError("badValue", this.base + at, `${this.what} ${name} count ${n} past ${max}`);
    if (n * minRow > this.end - this.at) throw new TakeRecordError("badLength", this.base + at, `${this.what} ${name} count ${n} can't fit ${this.end - this.at} B`);
    return n;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = new Uint8Array(this.view.buffer, this.view.byteOffset + this.at, n).slice();
    this.at += n;
    return b;
  }
  /** Bytes left in the payload. */
  get left(): number {
    return this.end - this.at;
  }
  done(): void {
    if (this.at !== this.end) throw new TakeRecordError("badLength", this.base + this.off, `${this.what} payload is ${this.end - this.off} B, its fields say ${this.at - this.off} B`);
  }
  bad(at: number, what: string): never {
    throw new TakeRecordError("badValue", this.base + at, `${this.what} ${what}`);
  }
  private finite(v: number, at: number, name: string): number {
    if (!Number.isFinite(v)) throw new TakeRecordError("badValue", this.base + at, `${this.what} ${name} ${v}`);
    return v;
  }
}

// --- the encodable form ---------------------------------------------------------------------------------------------------

/** One request record as a writer gives it: a decoded request (POSE batched), a FRAME or a take KEYFRAME. */
export type TakeRecordInit =
  | { type: typeof TakeRecordType.PLAY; payload: Extract<TakeRequest, { kind: "play" }> }
  | { type: typeof TakeRecordType.STOP; payload: Extract<TakeRequest, { kind: "stop" }> }
  | { type: typeof TakeRecordType.RELEASE; payload: Extract<TakeRequest, { kind: "release" }> }
  | { type: typeof TakeRecordType.PARAM; payload: Extract<TakeRequest, { kind: "param" }> }
  | { type: typeof TakeRecordType.POSE; payload: TakePoses }
  | { type: typeof TakeRecordType.MIX; payload: Extract<TakeRequest, { kind: "mix" }> }
  | { type: typeof TakeRecordType.TRIGGER; payload: Extract<TakeRequest, { kind: "trigger" }> }
  | { type: typeof TakeRecordType.MARK; payload: Extract<TakeRequest, { kind: "mark" }> }
  | { type: typeof TakeRecordType.FRAME; payload: TakeFrame }
  | { type: typeof TakeRecordType.KEYFRAME; payload: TakeKeyframe }
  | { type: typeof TakeRecordType.LINE; payload: Extract<TakeRequest, { kind: "line" }> }
  | { type: typeof TakeRecordType.LANGUAGE; payload: Extract<TakeRequest, { kind: "language" }> }
  | { type: typeof TakeRecordType.SAY; payload: Extract<TakeRequest, { kind: "say" }> }
  | { type: typeof TakeRecordType.SAYSTATE; payload: Extract<TakeRequest, { kind: "sayState" }> }
  | { type: typeof TakeRecordType.PAUSE; payload: Extract<TakeRequest, { kind: "pause" }> }
  | { type: typeof TakeRecordType.RESUME; payload: Extract<TakeRequest, { kind: "resume" }> }
  | { type: typeof TakeRecordType.FADE; payload: Extract<TakeRequest, { kind: "fade" }> };

/** One POSE record: every emitter that moved at one read (the listener is emitter 0). */
export interface TakePoses {
  t: number;
  poses: { emitter: number; position: Vec3; velocity: Vec3; forward?: Vec3 }[];
}

/** A decoded request record: what `decodeTakeRecord` answers. */
export type TakeRecord =
  | { type: "request"; requests: TakeRequest[] }
  | { type: "frame"; frame: TakeFrame }
  | { type: "keyframe"; keyframe: TakeKeyframe };

const PLAY_VOLUME = 1, PLAY_PITCH = 2, PLAY_BUS = 4, PLAY_PRIORITY = 8;
const PLAY_FLAGS_KNOWN = 0xf;
const POSE_FORWARD = 1;

const params = (p: Record<string, number> | undefined): [Uint8Array, number][] => {
  const out: [Uint8Array, number][] = [];
  if (!p) return out;
  for (const k of Object.keys(p)) {
    if (out.length >= TAKE_MAX_PARAMETERS) break;
    const v = p[k]!;
    if (Number.isFinite(v)) out.push([cutTakeText(k, TAKE_NAME_MAX_BYTES), v]);
  }
  return out;
};
const paramsBytes = (ps: [Uint8Array, number][]): number => 2 + ps.reduce((n, [k]) => n + 2 + k.byteLength + 8, 0);
const id = (x: number | null): number => (x === null ? TAKE_NONE : x >>> 0);
const vecBytes = 12;

/** Encodes `r`'s payload at `off` of `view` (`view` must hold `takeRecordBytes(r)` bytes there); returns the bytes written. */
export function encodeTakeRecord(view: DataView, off: number, r: TakeRecordInit): number {
  const o = new Out(view, off);
  switch (r.type) {
    case TakeRecordType.PLAY: {
      const p = r.payload;
      const opt = p.options;
      const flags = (opt.volume !== undefined ? PLAY_VOLUME : 0) | (opt.pitch !== undefined ? PLAY_PITCH : 0) | (opt.bus !== undefined ? PLAY_BUS : 0) | (opt.priority !== undefined ? PLAY_PRIORITY : 0);
      o.f64(p.t); o.u32(p.instance); o.u32(id(p.emitter)); o.u8(flags);
      o.f32(opt.volume ?? 0); o.f32(opt.pitch ?? 0); o.u16(Math.max(0, Math.min(0xffff, Math.round(opt.priority ?? 0))));
      o.text(cutTakeText(p.path, TAKE_PATH_MAX_BYTES)); o.text(cutTakeText(opt.bus ?? "", TAKE_NAME_MAX_BYTES));
      writeParams(o, params(opt.parameters));
      break;
    }
    case TakeRecordType.STOP: o.f64(r.payload.t); o.u32(r.payload.instance); o.f32(r.payload.fade); break;
    case TakeRecordType.RELEASE:
    case TakeRecordType.PAUSE:
    case TakeRecordType.RESUME: o.f64(r.payload.t); o.u32(r.payload.instance); break;
    case TakeRecordType.FADE: o.f64(r.payload.t); o.u32(r.payload.instance); o.f32(r.payload.to); o.f32(r.payload.seconds); break;
    case TakeRecordType.PARAM: o.f64(r.payload.t); o.u32(id(r.payload.instance)); o.f64(r.payload.value); o.text(cutTakeText(r.payload.name, TAKE_NAME_MAX_BYTES)); break;
    case TakeRecordType.POSE: {
      const poses = r.payload.poses.slice(0, TAKE_MAX_POSES);
      o.f64(r.payload.t); o.u16(poses.length);
      for (const p of poses) { o.u32(p.emitter); o.u8(p.forward ? POSE_FORWARD : 0); o.vec(p.position); o.vec(p.velocity); if (p.forward) o.vec(p.forward); }
      break;
    }
    case TakeRecordType.MIX: {
      const p = r.payload;
      o.f64(p.t); o.u8(TAKE_MIX_OPS.indexOf(p.op)); o.f64(p.value); o.f32(p.seconds); o.text(cutTakeText(p.target, TAKE_NAME_MAX_BYTES));
      break;
    }
    case TakeRecordType.TRIGGER: o.f64(r.payload.t); o.u32(r.payload.instance); o.text(cutTakeText(r.payload.name, TAKE_NAME_MAX_BYTES)); break;
    case TakeRecordType.MARK: o.f64(r.payload.t); o.text(cutTakeText(r.payload.text, TAKE_MARK_MAX_BYTES)); break;
    case TakeRecordType.FRAME: {
      const p = r.payload;
      o.f64(p.t); o.u16(p.width); o.u16(p.height); o.u32(p.jpeg.byteLength); o.raw(p.jpeg);
      break;
    }
    case TakeRecordType.KEYFRAME: {
      const k = r.payload;
      o.f64(k.t);
      writeParams(o, params(k.globals));
      const instances = k.instances.slice(-TAKE_MAX_KEYFRAME_INSTANCES);
      o.u16(instances.length);
      for (const i of instances) {
        o.u32(i.instance); o.u32(id(i.emitter)); o.f64(i.started); o.text(cutTakeText(i.path, TAKE_PATH_MAX_BYTES));
        writeParams(o, params(i.parameters));
      }
      // The World's pick generator state, when it has one: a trailing u32 (a keyframe without it ends at its instances).
      if (k.random !== undefined) o.u32(k.random);
      break;
    }
    case TakeRecordType.LINE: {
      const p = r.payload;
      o.f64(p.t); o.u32(p.instance);
      writePlayOptions(o, p.options, p.language !== null ? LINE_LANGUAGE : 0);
      o.text(cutTakeText(p.key, TAKE_NAME_MAX_BYTES)); o.text(cutTakeText(p.language ?? "", TAKE_NAME_MAX_BYTES));
      writeParams(o, params(p.options.parameters));
      break;
    }
    case TakeRecordType.LANGUAGE: {
      const p = r.payload;
      o.f64(p.t); o.u8(p.subtitles !== null ? 1 : 0); o.text(cutTakeText(p.audio, TAKE_NAME_MAX_BYTES)); o.text(cutTakeText(p.subtitles ?? "", TAKE_NAME_MAX_BYTES));
      break;
    }
    case TakeRecordType.SAY: {
      const p = r.payload;
      const extra = (p.options.channel !== undefined ? SAY_CHANNEL : 0) | (p.options.whenBusy !== undefined ? SAY_WHEN_BUSY : 0) | (p.random !== undefined ? SAY_RANDOM : 0);
      o.f64(p.t); o.u32(p.instance);
      writePlayOptions(o, p.options, extra);
      o.u8(TAKE_SAY_STATES.indexOf(p.state)); o.u8(p.options.whenBusy !== undefined ? TAKE_SAY_WHEN_BUSY.indexOf(p.options.whenBusy) : 0); o.u32(p.random ?? 0);
      o.text(cutTakeText(p.event, TAKE_NAME_MAX_BYTES)); o.text(cutTakeText(p.options.channel ?? "", TAKE_NAME_MAX_BYTES));
      const args = sayArgs(p.args);
      o.u16(args.length);
      for (const [k, v] of args) { o.text(k); o.text(v); }
      writeParams(o, params(p.options.parameters));
      writePick(o, p.picked);
      break;
    }
    case TakeRecordType.SAYSTATE: {
      const p = r.payload;
      o.f64(p.t); o.u32(p.instance); o.u8(TAKE_SAY_STATE_CHANGES.indexOf(p.state)); o.u8(p.random !== undefined ? 1 : 0); o.u32(p.random ?? 0);
      writePick(o, p.picked);
      break;
    }
  }
  return o.bytes;
}

// --- LINE, LANGUAGE, SAY, SAYSTATE (ADR 0354 §10, 0355 §6) ----------------------------------------------------------------

/** LINE flags past the play options': the language is set (else nothing was heard). */
const LINE_LANGUAGE = 0x10;
/** SAY flags past the play options'. */
const SAY_CHANNEL = 0x10, SAY_WHEN_BUSY = 0x20, SAY_RANDOM = 0x40;
const PICK_NULL = 0, PICK_KEY = 1, PICK_NONE = 2;

/** The play options' flags, values and bus: `u8 flags, f32 volume, f32 pitch, u16 priority, text bus`. */
function writePlayOptions(o: Out, opt: TakePlayOptions, extraFlags: number): void {
  const flags = (opt.volume !== undefined ? PLAY_VOLUME : 0) | (opt.pitch !== undefined ? PLAY_PITCH : 0) | (opt.bus !== undefined ? PLAY_BUS : 0) | (opt.priority !== undefined ? PLAY_PRIORITY : 0) | extraFlags;
  o.u8(flags); o.f32(opt.volume ?? 0); o.f32(opt.pitch ?? 0); o.u16(Math.max(0, Math.min(0xffff, Math.round(opt.priority ?? 0))));
  o.text(cutTakeText(opt.bus ?? "", TAKE_NAME_MAX_BYTES));
}
const playOptionsBytes = (opt: TakePlayOptions): number => 1 + 4 + 4 + 2 + 2 + cutTakeText(opt.bus ?? "", TAKE_NAME_MAX_BYTES).byteLength;

const sayArgs = (args: Record<string, string>): [Uint8Array, Uint8Array][] =>
  Object.keys(args).slice(0, TAKE_MAX_SAY_ARGS).map((k) => [cutTakeText(k, TAKE_NAME_MAX_BYTES), cutTakeText(String(args[k]), TAKE_NAME_MAX_BYTES)]);

function writePick(o: Out, pick: TakeSayPick | null): void {
  if (pick === null) o.u8(PICK_NULL);
  else if ("key" in pick) { o.u8(PICK_KEY); o.text(cutTakeText(pick.key, TAKE_NAME_MAX_BYTES)); o.u32(pick.pathIndex); }
  else { o.u8(PICK_NONE); o.text(cutTakeText(pick.none, TAKE_NAME_MAX_BYTES)); }
}
const pickBytes = (pick: TakeSayPick | null): number =>
  pick === null ? 1 : "key" in pick ? 1 + 2 + cutTakeText(pick.key, TAKE_NAME_MAX_BYTES).byteLength + 4 : 1 + 2 + cutTakeText(pick.none, TAKE_NAME_MAX_BYTES).byteLength;

function readPlayOptions(i: In, knownExtra: number): { options: TakePlayOptions; flags: number } {
  const at = i.at;
  const flags = i.u8();
  if (flags & ~(PLAY_FLAGS_KNOWN | knownExtra)) i.bad(at, `flags 0x${flags.toString(16)}`);
  const volume = i.f32("volume");
  const pitch = i.f32("pitch");
  const priority = i.u16();
  const bus = i.text(TAKE_NAME_MAX_BYTES, "bus");
  const options: TakePlayOptions = {};
  if (flags & PLAY_VOLUME) options.volume = volume;
  if (flags & PLAY_PITCH) options.pitch = pitch;
  if (flags & PLAY_BUS) options.bus = bus;
  if (flags & PLAY_PRIORITY) options.priority = priority;
  return { options, flags };
}

function readPick(i: In): TakeSayPick | null {
  const at = i.at;
  const kind = i.u8();
  if (kind === PICK_NULL) return null;
  if (kind === PICK_KEY) {
    const key = i.text(TAKE_NAME_MAX_BYTES, "picked key");
    return { key, pathIndex: i.u32() };
  }
  if (kind === PICK_NONE) return { none: i.text(TAKE_NAME_MAX_BYTES, "picked reason") };
  return i.bad(at, `pick kind ${kind}`);
}

function code<T>(i: In, list: readonly T[], what: string): T {
  const at = i.at;
  const c = i.u8();
  const v = list[c];
  if (v === undefined) i.bad(at, `${what} ${c}`);
  return v!;
}

function writeParams(o: Out, ps: [Uint8Array, number][]): void {
  o.u16(ps.length);
  for (const [k, v] of ps) { o.text(k); o.f64(v); }
}

/** The payload bytes `encodeTakeRecord` writes for `r`. */
export function takeRecordBytes(r: TakeRecordInit): number {
  switch (r.type) {
    case TakeRecordType.PLAY: {
      const p = r.payload;
      return 8 + 4 + 4 + 1 + 4 + 4 + 2 + 2 + cutTakeText(p.path, TAKE_PATH_MAX_BYTES).byteLength + 2 + cutTakeText(p.options.bus ?? "", TAKE_NAME_MAX_BYTES).byteLength + paramsBytes(params(p.options.parameters));
    }
    case TakeRecordType.STOP: return 16;
    case TakeRecordType.RELEASE:
    case TakeRecordType.PAUSE:
    case TakeRecordType.RESUME: return 12;
    case TakeRecordType.FADE: return 20;
    case TakeRecordType.PARAM: return 8 + 4 + 8 + 2 + cutTakeText(r.payload.name, TAKE_NAME_MAX_BYTES).byteLength;
    case TakeRecordType.POSE: return 10 + r.payload.poses.slice(0, TAKE_MAX_POSES).reduce((n, p) => n + 5 + 2 * vecBytes + (p.forward ? vecBytes : 0), 0);
    case TakeRecordType.MIX: return 8 + 1 + 8 + 4 + 2 + cutTakeText(r.payload.target, TAKE_NAME_MAX_BYTES).byteLength;
    case TakeRecordType.TRIGGER: return 8 + 4 + 2 + cutTakeText(r.payload.name, TAKE_NAME_MAX_BYTES).byteLength;
    case TakeRecordType.MARK: return 8 + 2 + cutTakeText(r.payload.text, TAKE_MARK_MAX_BYTES).byteLength;
    case TakeRecordType.FRAME: return 8 + 2 + 2 + 4 + r.payload.jpeg.byteLength;
    case TakeRecordType.KEYFRAME: {
      const k = r.payload;
      let n = 8 + paramsBytes(params(k.globals)) + 2;
      for (const i of k.instances.slice(-TAKE_MAX_KEYFRAME_INSTANCES)) n += 4 + 4 + 8 + 2 + cutTakeText(i.path, TAKE_PATH_MAX_BYTES).byteLength + paramsBytes(params(i.parameters));
      return k.random !== undefined ? n + 4 : n;
    }
    case TakeRecordType.LINE: {
      const p = r.payload;
      return 8 + 4 + playOptionsBytes(p.options) + 2 + cutTakeText(p.key, TAKE_NAME_MAX_BYTES).byteLength + 2 + cutTakeText(p.language ?? "", TAKE_NAME_MAX_BYTES).byteLength + paramsBytes(params(p.options.parameters));
    }
    case TakeRecordType.LANGUAGE:
      return 8 + 1 + 2 + cutTakeText(r.payload.audio, TAKE_NAME_MAX_BYTES).byteLength + 2 + cutTakeText(r.payload.subtitles ?? "", TAKE_NAME_MAX_BYTES).byteLength;
    case TakeRecordType.SAY: {
      const p = r.payload;
      const args = sayArgs(p.args).reduce((n, [k, v]) => n + 2 + k.byteLength + 2 + v.byteLength, 2);
      return 8 + 4 + playOptionsBytes(p.options) + 1 + 1 + 4 + 2 + cutTakeText(p.event, TAKE_NAME_MAX_BYTES).byteLength + 2 + cutTakeText(p.options.channel ?? "", TAKE_NAME_MAX_BYTES).byteLength
        + args + paramsBytes(params(p.options.parameters)) + pickBytes(p.picked);
    }
    case TakeRecordType.SAYSTATE: return 8 + 4 + 1 + 1 + 4 + pickBytes(r.payload.picked);
  }
}

/** A whole request record's payload as bytes (tests, small writers). */
export function encodeTakeRecordBytes(r: TakeRecordInit): Uint8Array {
  const out = new Uint8Array(takeRecordBytes(r));
  encodeTakeRecord(new DataView(out.buffer), 0, r);
  return out;
}

// --- decode -----------------------------------------------------------------------------------------------------------

const NAMES: Record<number, string> = {
  [TakeRecordType.PLAY]: "PLAY", [TakeRecordType.STOP]: "STOP", [TakeRecordType.RELEASE]: "RELEASE", [TakeRecordType.PARAM]: "PARAM",
  [TakeRecordType.POSE]: "POSE", [TakeRecordType.MIX]: "MIX", [TakeRecordType.TRIGGER]: "TRIGGER", [TakeRecordType.MARK]: "MARK",
  [TakeRecordType.FRAME]: "FRAME", [TakeRecordType.KEYFRAME]: "take KEYFRAME",
  [TakeRecordType.LINE]: "LINE", [TakeRecordType.LANGUAGE]: "LANGUAGE", [TakeRecordType.SAY]: "SAY", [TakeRecordType.SAYSTATE]: "SAYSTATE",
  [TakeRecordType.PAUSE]: "PAUSE", [TakeRecordType.RESUME]: "RESUME", [TakeRecordType.FADE]: "FADE",
};

function readParams(i: In, name: string): Record<string, number> {
  const n = i.count(TAKE_MAX_PARAMETERS, 2 + 8, name);
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (let k = 0; k < n; k++) {
    const key = i.text(TAKE_NAME_MAX_BYTES, `${name} name`);
    out[key] = i.f64(`${name} value`);
  }
  return { ...out };
}

const orNull = (x: number): number | null => (x === TAKE_NONE ? null : x);

/**
 * Decodes the payload of a request record of `type` (exactly `len` bytes at `off`), refusing with `TakeRecordError` when a
 * length, count, string or value disagrees with its fields. `base` is added to error offsets. Throws a plain `Error` for a
 * `type` that isn't a request record (the caller dispatches by `isTakeRecordType`).
 */
export function decodeTakeRecord(type: number, view: DataView, off: number, len: number, base = 0): TakeRecord {
  const what = NAMES[type];
  if (what === undefined) throw new Error(`decodeTakeRecord: 0x${type.toString(16)} is not a request record`);
  const i = new In(view, off, len, base, what);
  const t = i.time();
  let out: TakeRecord;
  switch (type) {
    case TakeRecordType.PLAY: {
      const instance = i.u32();
      const emitter = orNull(i.u32());
      const flagsAt = i.at;
      const flags = i.u8();
      if (flags & ~PLAY_FLAGS_KNOWN) i.bad(flagsAt, `flags 0x${flags.toString(16)}`);
      const volume = i.f32("volume");
      const pitch = i.f32("pitch");
      const priority = i.u16();
      const path = i.text(TAKE_PATH_MAX_BYTES, "path");
      const bus = i.text(TAKE_NAME_MAX_BYTES, "bus");
      const parameters = readParams(i, "parameter");
      const options: TakePlayOptions = {};
      if (flags & PLAY_VOLUME) options.volume = volume;
      if (flags & PLAY_PITCH) options.pitch = pitch;
      if (flags & PLAY_BUS) options.bus = bus;
      if (flags & PLAY_PRIORITY) options.priority = priority;
      if (Object.keys(parameters).length > 0) options.parameters = parameters;
      out = { type: "request", requests: [{ kind: "play", t, instance, path, emitter, options }] };
      break;
    }
    case TakeRecordType.STOP: {
      const instance = i.u32();
      const at = i.at;
      const fade = i.f32("fade");
      if (fade < 0) i.bad(at, `fade ${fade}`);
      out = { type: "request", requests: [{ kind: "stop", t, instance, fade }] };
      break;
    }
    case TakeRecordType.RELEASE: out = { type: "request", requests: [{ kind: "release", t, instance: i.u32() }] }; break;
    case TakeRecordType.PAUSE: out = { type: "request", requests: [{ kind: "pause", t, instance: i.u32() }] }; break;
    case TakeRecordType.RESUME: out = { type: "request", requests: [{ kind: "resume", t, instance: i.u32() }] }; break;
    case TakeRecordType.FADE: {
      const instance = i.u32();
      const toAt = i.at;
      const to = i.f32("to");
      if (to < 0) i.bad(toAt, `to ${to}`);
      const sAt = i.at;
      const seconds = i.f32("seconds");
      if (seconds < 0) i.bad(sAt, `seconds ${seconds}`);
      out = { type: "request", requests: [{ kind: "fade", t, instance, to, seconds }] };
      break;
    }
    case TakeRecordType.PARAM: {
      const instance = orNull(i.u32());
      const value = i.f64("value");
      out = { type: "request", requests: [{ kind: "param", t, instance, name: i.text(TAKE_NAME_MAX_BYTES, "name"), value }] };
      break;
    }
    case TakeRecordType.POSE: {
      const n = i.count(TAKE_MAX_POSES, 5 + 2 * vecBytes, "pose");
      const requests: TakeRequest[] = [];
      for (let k = 0; k < n; k++) {
        const emitter = i.u32();
        const at = i.at;
        const flags = i.u8();
        if (flags & ~POSE_FORWARD) i.bad(at, `pose flags 0x${flags.toString(16)}`);
        const position = i.vec("position");
        const velocity = i.vec("velocity");
        const r: Extract<TakeRequest, { kind: "pose" }> = { kind: "pose", t, emitter, position, velocity };
        if (flags & POSE_FORWARD) r.forward = i.vec("forward");
        requests.push(r);
      }
      out = { type: "request", requests };
      break;
    }
    case TakeRecordType.MIX: {
      const at = i.at;
      const code = i.u8();
      const op = TAKE_MIX_OPS[code];
      if (op === undefined) i.bad(at, `op ${code}`);
      const value = i.f64("value");
      const sAt = i.at;
      const seconds = i.f32("seconds");
      if (seconds < 0) i.bad(sAt, `seconds ${seconds}`);
      out = { type: "request", requests: [{ kind: "mix", t, op: op!, target: i.text(TAKE_NAME_MAX_BYTES, "target"), value, seconds }] };
      break;
    }
    case TakeRecordType.TRIGGER: {
      const instance = i.u32();
      out = { type: "request", requests: [{ kind: "trigger", t, instance, name: i.text(TAKE_NAME_MAX_BYTES, "name") }] };
      break;
    }
    case TakeRecordType.MARK: out = { type: "request", requests: [{ kind: "mark", t, text: i.text(TAKE_MARK_MAX_BYTES, "text") }] }; break;
    case TakeRecordType.FRAME: {
      const at = i.at;
      const width = i.u16();
      const height = i.u16();
      if (width === 0 || height === 0 || width > TAKE_FRAME_MAX_SIDE || height > TAKE_FRAME_MAX_SIDE) i.bad(at, `size ${width}x${height}`);
      const nAt = i.at;
      const n = i.u32();
      if (n > TAKE_FRAME_MAX_BYTES) throw new TakeRecordError("badValue", base + nAt, `FRAME picture ${n} B past ${TAKE_FRAME_MAX_BYTES}`);
      out = { type: "frame", frame: { t, width, height, jpeg: i.bytes(n) } };
      break;
    }
    case TakeRecordType.LINE: {
      const instance = i.u32();
      const { options, flags } = readPlayOptions(i, LINE_LANGUAGE);
      const key = i.text(TAKE_NAME_MAX_BYTES, "key");
      const language = i.text(TAKE_NAME_MAX_BYTES, "language");
      const parameters = readParams(i, "parameter");
      if (Object.keys(parameters).length > 0) options.parameters = parameters;
      out = { type: "request", requests: [{ kind: "line", t, instance, key, language: flags & LINE_LANGUAGE ? language : null, options }] };
      break;
    }
    case TakeRecordType.LANGUAGE: {
      const at = i.at;
      const flags = i.u8();
      if (flags & ~1) i.bad(at, `flags 0x${flags.toString(16)}`);
      const audio = i.text(TAKE_NAME_MAX_BYTES, "audio");
      const subtitles = i.text(TAKE_NAME_MAX_BYTES, "subtitles");
      out = { type: "request", requests: [{ kind: "language", t, audio, subtitles: flags & 1 ? subtitles : null }] };
      break;
    }
    case TakeRecordType.SAY: {
      const instance = i.u32();
      const { options, flags } = readPlayOptions(i, SAY_CHANNEL | SAY_WHEN_BUSY | SAY_RANDOM);
      const state = code(i, TAKE_SAY_STATES, "state");
      const whenBusy = code(i, TAKE_SAY_WHEN_BUSY, "whenBusy");
      const random = i.u32();
      const event = i.text(TAKE_NAME_MAX_BYTES, "event");
      const channel = i.text(TAKE_NAME_MAX_BYTES, "channel");
      const n = i.count(TAKE_MAX_SAY_ARGS, 4, "argument");
      const args: Record<string, string> = {};
      for (let k = 0; k < n; k++) {
        const name = i.text(TAKE_NAME_MAX_BYTES, "argument name");
        args[name] = i.text(TAKE_NAME_MAX_BYTES, "argument value");
      }
      const parameters = readParams(i, "parameter");
      const sayOptions: TakeSayOptions = { ...options };
      if (Object.keys(parameters).length > 0) sayOptions.parameters = parameters;
      if (flags & SAY_CHANNEL) sayOptions.channel = channel;
      if (flags & SAY_WHEN_BUSY) sayOptions.whenBusy = whenBusy;
      const picked = readPick(i);
      const say: Extract<TakeRequest, { kind: "say" }> = { kind: "say", t, instance, event, args: { ...args }, options: sayOptions, state, picked };
      if (flags & SAY_RANDOM) say.random = random;
      out = { type: "request", requests: [say] };
      break;
    }
    case TakeRecordType.SAYSTATE: {
      const instance = i.u32();
      const state = code(i, TAKE_SAY_STATE_CHANGES, "state");
      const at = i.at;
      const flags = i.u8();
      if (flags & ~1) i.bad(at, `flags 0x${flags.toString(16)}`);
      const random = i.u32();
      const picked = readPick(i);
      const change: Extract<TakeRequest, { kind: "sayState" }> = { kind: "sayState", t, instance, state, picked };
      if (flags & 1) change.random = random;
      out = { type: "request", requests: [change] };
      break;
    }
    default: {
      const globals = readParams(i, "global");
      const n = i.count(TAKE_MAX_KEYFRAME_INSTANCES, 4 + 4 + 8 + 2 + 2, "instance");
      const instances: TakeKeyframe["instances"] = [];
      for (let k = 0; k < n; k++) {
        const instance = i.u32();
        const emitter = orNull(i.u32());
        const started = i.f64("started"); // negative: alive before the take began
        const path = i.text(TAKE_PATH_MAX_BYTES, "path");
        instances.push({ instance, path, started, emitter, parameters: readParams(i, "parameter") });
      }
      const keyframe: TakeKeyframe = { t, instances, globals };
      if (i.left === 4) keyframe.random = i.u32();
      out = { type: "keyframe", keyframe };
    }
  }
  i.done();
  return out;
}
