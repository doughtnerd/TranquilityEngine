// ADR 0348: the take recorder. It is the `TakeRequestSink` the hooks call (`takeTap.ts`) and the `CaptureTee` the profile
// taps hand parameter changes to; it turns each request into a request record (`engine/audio/take/records.ts`) in its own
// log, never in the profile ring: the profile keeps the ring's bounded budget (its oldest data dropped behind GAP records),
// the requests are never dropped. Each record takes its seq from the ring's counter, its epoch and frame from the
// recorder's "now", so the saver merges the two streams by seq into one file (`save.ts` `mergeRequests`).
//
// Instance ids are the runtime's instance groups (the profile's `eventStart` ids, so a request and the profile name one
// instance alike); a one-shot's voice, which has no group, takes an id from 2^30 up, and so does a later instance given a
// group an earlier one of the take had (a recycled group must not name two instances). Emitter 0 is the listener; others are
// numbered from 1 in order of first play, one per entity (an `AudioSource`'s node) or script-placed instance.
//
// Part of the lazy chunk: `take.ts` loads it by `import()` on the first `Audio.take.start()`.
import {
  TAKE_MAX_KEYFRAME_INSTANCES, TakeRecordType, encodeTakeRecord, takeRecordBytes, type TakeMixOp, type TakePoses, type TakeRecordInit,
} from "../../../../engine/audio/take/records";
import { isTakeExtensionType } from "../../../../engine/audio/take/extensions";
import type { TakeMetaSection } from "../../../../engine/audio/take/reader";
import { LISTENER_EMITTER, type TakeKeyframe, type TakePlayOptions, type TakeRequest, type TakeSayPick } from "../../../../engine/audio/take/types";
import type { Vec3 } from "../../../../engine/audio/spatial/testSceneTypes";
import { CAPTURE_META_MAX_BYTES, CAPTURE_RECORD_HEAD_BYTES, CAPTURE_RECORD_MAX_BYTES, TAKE_MAX_UNCOMPRESSED_BYTES, writeRecordHead } from "./format";
import type { CaptureTee } from "./capture";
import { TakeFrameGrabber, type TakeFrameGrabberOptions, type TakePictureSource } from "./takeFrames";
import type { TakeEmitter, TakeListenerPose, TakeRequestSink, TakeSayInit } from "./takeTap";

/** What the recorder uses of the ring's hold (`CaptureTakeRing`). */
export interface TakeRecorderRing {
  stamp(): { seq: number; epoch: number; frame: number } | null;
  readonly ringBytes: number;
  marker(text: string): void;
}

export interface TakeRecorderOptions {
  /** `performance.now()` (ms); injectable for tests. */
  now?: () => number;
  /** The global parameters' values at the start (the first keyframe holds them). */
  globals?: () => Record<string, number>;
  /** Called once when the recorder stops itself (the cap reached, the ring gone), with the message to show. */
  onStop?: (message: string) => void;
  /** The take cap, bytes (tests); default `TAKE_MAX_UNCOMPRESSED_BYTES`. */
  capBytes?: number;
  /** The pick generator state of the World plays go to (`takeSeed.ts`), for each keyframe; null while unseeded. */
  randomState?: () => number | null;
  /** Take pictures of the game view (`FRAME`, about once a second, `frames.width` px wide; `takeFrames.ts`); absent or null: none. */
  frames?: TakeFrameGrabberOptions | null;
}

/** Poses are read at most this often (30 Hz). */
const POSE_INTERVAL = 1 / 30;
/** A take keyframe each second. */
const KEYFRAME_INTERVAL = 1;
/** A move smaller than this (metres, or a unit vector's component) is no change. */
const POSE_EPSILON = 1e-4;
/** The log's chunks (records never straddle one). */
const CHUNK_BYTES = 1 << 20;
/** The first id a voice without a group takes. */
const LOCAL_ID_BASE = 0x4000_0000;

interface Live {
  readonly obj: object;
  readonly path: string;
  readonly started: number;
  readonly emitter: number | null;
  readonly parameters: Record<string, number>;
}

interface Emitter {
  readonly id: number;
  readonly source: TakeEmitter;
  x: number; y: number; z: number;
  t: number;
  seen: boolean;
}

const playingOf = (o: object): boolean => (o as { playing?: unknown }).playing !== false;

export class TakeRecorder implements TakeRequestSink, CaptureTee {
  private readonly now: () => number;
  private readonly startMs: number;
  private readonly cap: number;
  private readonly chunks: Uint8Array[] = [];
  private chunk: Uint8Array = new Uint8Array(0);
  private chunkUsed = 0;
  private logBytes = 0;
  private records = 0;
  private stopped: string | null = null;
  private readonly ids = new WeakMap<object, number>();
  private nextLocal = LOCAL_ID_BASE;
  /** The groups an instance of this take already took as its id. */
  private readonly groups = new Set<number>();
  private readonly live = new Map<number, Live>();
  private readonly emitters = new Map<object, Emitter>();
  private readonly emitterById = new Map<number, Emitter>();
  private readonly emitterNames: Record<string, string> = { [LISTENER_EMITTER]: "Listener" };
  private nextEmitter = 1;
  private readonly globals: Record<string, number>;
  private lastPose = -Infinity;
  private lastKeyframe = -Infinity;
  private listener = { x: NaN, y: NaN, z: NaN, fx: NaN, fy: NaN, fz: NaN, t: 0 };
  private readonly onStop: ((message: string) => void) | undefined;
  private readonly randomState: (() => number | null) | undefined;
  private readonly pictures: TakeFrameGrabber | null;

  constructor(private readonly ring: TakeRecorderRing, opts: TakeRecorderOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.startMs = this.now();
    this.cap = opts.capBytes ?? TAKE_MAX_UNCOMPRESSED_BYTES;
    this.onStop = opts.onStop;
    this.randomState = opts.randomState;
    this.pictures = opts.frames ? new TakeFrameGrabber((frame) => this.write({ type: TakeRecordType.FRAME, payload: frame }), opts.frames) : null;
    this.globals = { ...(opts.globals?.() ?? {}) };
    this.keyframe(0);
  }

  /** Seconds since the take began (the take's clock). */
  get seconds(): number {
    return Math.max(0, (this.now() - this.startMs) / 1000);
  }

  /** Why the recorder stopped itself; null while it records. */
  get stopMessage(): string | null {
    return this.stopped;
  }

  /** Request bytes logged so far. */
  get bytes(): number {
    return this.logBytes;
  }

  /**
   * The log from byte `from` (0 = its first record), at most `max` bytes, as a view (not a copy): the records in the
   * capture framing, in seq order, as `finish` will hand them over. A read stops at the end of one of the log's chunks
   * and may end inside a record (read on from where it stopped); empty past what is logged. The live take feed reads it
   * as the take records (`debugLink/takeLive.ts`); it stays readable after `finish`.
   */
  readLog(from: number, max: number): Uint8Array {
    if (!(from >= 0 && from < this.logBytes && max > 0)) return EMPTY;
    let base = 0;
    for (const c of this.chunks) {
      if (from < base + c.byteLength) return c.subarray(from - base, Math.min(c.byteLength, from - base + max));
      base += c.byteLength;
    }
    return this.chunk.subarray(from - base, Math.min(this.chunkUsed, from - base + max));
  }

  /** Emitters named so far, the listener included (they are only ever added). */
  get emitterCount(): number {
    return this.nextEmitter;
  }

  /** The emitters' names by id so far (the listener is "0"): what META's `take.emitters` will say. A copy. */
  namedEmitters(): Record<string, string> {
    return { ...this.emitterNames };
  }

  // --- TakeRequestSink ------------------------------------------------------------------------------------------------

  play(instance: object, path: string, emitter: TakeEmitter | null, options: TakePlayOptions): void {
    const t = this.seconds;
    const id = this.idOf(instance);
    const e = emitter ? this.emitterOf(emitter) : null;
    this.live.set(id, { obj: instance, path, started: t, emitter: e, parameters: { ...(options.parameters ?? {}) } });
    this.write({ type: TakeRecordType.PLAY, payload: { kind: "play", t, instance: id, path, emitter: e, options } });
  }

  stop(instance: object, fade: number): void {
    const id = this.ids.get(instance);
    if (id === undefined) return; // a play from before the take: nothing to replay
    this.write({ type: TakeRecordType.STOP, payload: { kind: "stop", t: this.seconds, instance: id, fade: Number.isFinite(fade) ? Math.max(0, fade) : 0 } });
  }

  release(instance: object): void {
    const id = this.ids.get(instance);
    if (id === undefined) return;
    this.write({ type: TakeRecordType.RELEASE, payload: { kind: "release", t: this.seconds, instance: id } });
  }

  pause(instance: object): void {
    const id = this.ids.get(instance);
    if (id === undefined) return;
    this.write({ type: TakeRecordType.PAUSE, payload: { kind: "pause", t: this.seconds, instance: id } });
  }

  resume(instance: object): void {
    const id = this.ids.get(instance);
    if (id === undefined) return;
    this.write({ type: TakeRecordType.RESUME, payload: { kind: "resume", t: this.seconds, instance: id } });
  }

  fade(instance: object, to: number, seconds: number): void {
    const id = this.ids.get(instance);
    // A non-finite `to` is ignored by the handle (it warns), so it isn't played and isn't recorded; the handle clamps the
    // rest, and the replay's handle clamps the same way.
    if (id === undefined || !Number.isFinite(to)) return;
    this.write({ type: TakeRecordType.FADE, payload: { kind: "fade", t: this.seconds, instance: id, to: Math.max(0, to), seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 } });
  }

  trigger(instance: object, name: string): void {
    const id = this.ids.get(instance);
    if (id === undefined) return;
    this.write({ type: TakeRecordType.TRIGGER, payload: { kind: "trigger", t: this.seconds, instance: id, name } });
  }

  mix(op: TakeMixOp, target: string, value: number, seconds: number): void {
    if (!Number.isFinite(value)) return;
    this.write({ type: TakeRecordType.MIX, payload: { kind: "mix", t: this.seconds, op, target, value, seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 } });
  }

  line(instance: object, key: string, language: string | null, emitter: TakeEmitter | null, options: TakePlayOptions): void {
    const id = this.idOf(instance);
    if (emitter) this.emitterOf(emitter);
    this.write({ type: TakeRecordType.LINE, payload: { kind: "line", t: this.seconds, instance: id, key, language, options } });
  }

  language(audio: string, subtitles: string | null): void {
    this.write({ type: TakeRecordType.LANGUAGE, payload: { kind: "language", t: this.seconds, audio, subtitles } });
  }

  say(instance: object, say: TakeSayInit): void {
    const id = this.idOf(instance);
    if (say.emitter) this.emitterOf(say.emitter);
    const payload: Extract<TakeRequest, { kind: "say" }> = { kind: "say", t: this.seconds, instance: id, event: say.event, args: { ...say.args }, options: say.options, state: say.state, picked: say.picked };
    if (say.random !== null) payload.random = say.random >>> 0;
    this.write({ type: TakeRecordType.SAY, payload });
  }

  sayState(instance: object, state: "playing" | "dropped", picked: TakeSayPick | null, random: number | null): void {
    const id = this.ids.get(instance);
    if (id === undefined) return; // asked before the take began
    const payload: Extract<TakeRequest, { kind: "sayState" }> = { kind: "sayState", t: this.seconds, instance: id, state, picked };
    if (random !== null) payload.random = random >>> 0;
    this.write({ type: TakeRecordType.SAYSTATE, payload });
  }

  frame(listener: TakeListenerPose | null, picture: TakePictureSource | null = null): void {
    if (this.stopped) return;
    const t = this.seconds;
    if (t - this.lastPose >= POSE_INTERVAL) {
      this.lastPose = t;
      this.poses(t, listener);
    }
    if (t - this.lastKeyframe >= KEYFRAME_INTERVAL) this.keyframe(t);
    this.pictures?.offer(picture, t);
  }

  // --- CaptureTee -----------------------------------------------------------------------------------------------------

  parameter(name: string, value: number, instance: number | null): void {
    if (!Number.isFinite(value)) return;
    if (instance === null) this.globals[name] = value;
    else {
      const l = this.live.get(instance);
      if (!l) return; // an instance from before the take
      l.parameters[name] = value;
    }
    this.write({ type: TakeRecordType.PARAM, payload: { kind: "param", t: this.seconds, instance, name, value } });
  }

  // --- the take's own -------------------------------------------------------------------------------------------------

  /** `Audio.take.mark(text)`: a MARK request and a MARKER in the profile. */
  mark(text: string): void {
    this.write({ type: TakeRecordType.MARK, payload: { kind: "mark", t: this.seconds, text } });
    this.ring.marker(text);
  }

  /** The log as whole records in seq order, and META's take section. The recorder writes nothing after this. */
  finish(seed: { seed: number; seeded: boolean; audioHash: string }): { requests: { bytes: Uint8Array; recordCount: number }; section: TakeMetaSection } {
    const duration = this.seconds;
    if (!this.stopped) this.stopped = "finished";
    this.sealChunk();
    const bytes = new Uint8Array(this.logBytes);
    let at = 0;
    for (const c of this.chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return {
      requests: { bytes, recordCount: this.records },
      section: { audioHash: seed.audioHash, seed: seed.seed >>> 0, seeded: seed.seeded, duration, frames: (this.pictures?.count ?? 0) > 0, emitters: { ...this.emitterNames } },
    };
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  private idOf(o: object): number {
    let id = this.ids.get(o);
    if (id !== undefined) return id;
    const g = (o as { group?: unknown }).group;
    // A group the runtime recycled (its instance ended, a new one took the number) would name two instances: a late
    // request of the ended one would act on the new one on replay. The second holder takes a local id instead.
    const group = typeof g === "number" && Number.isInteger(g) && g > 0 && g < LOCAL_ID_BASE && !this.groups.has(g) ? g : null;
    if (group !== null) this.groups.add(group);
    id = group ?? this.nextLocal++;
    this.ids.set(o, id);
    return id;
  }

  private emitterOf(source: TakeEmitter): number {
    let e = this.emitters.get(source.key);
    if (!e) {
      e = { id: this.nextEmitter++, source, x: NaN, y: NaN, z: NaN, t: 0, seen: false };
      this.emitters.set(source.key, e);
      this.emitterById.set(e.id, e);
      this.emitterNames[String(e.id)] = source.name;
    }
    return e.id;
  }

  /** The live instances (ended ones dropped). */
  private prune(): void {
    for (const [id, l] of this.live) if (!playingOf(l.obj)) this.live.delete(id);
  }

  private poses(t: number, listener: TakeListenerPose | null): void {
    const out: TakePoses = { t, poses: [] };
    if (listener) {
      const L = this.listener;
      const moved = changed(L.x, listener.posX) || changed(L.y, listener.posY) || changed(L.z, listener.posZ)
        || changed(L.fx, listener.fwdX) || changed(L.fy, listener.fwdY) || changed(L.fz, listener.fwdZ);
      if (moved) {
        const dt = t - L.t;
        const vel = Number.isFinite(L.x) && dt > 0 ? { x: (listener.posX - L.x) / dt, y: (listener.posY - L.y) / dt, z: (listener.posZ - L.z) / dt } : ZERO;
        out.poses.push({ emitter: LISTENER_EMITTER, position: { x: listener.posX, y: listener.posY, z: listener.posZ }, velocity: vel, forward: { x: listener.fwdX, y: listener.fwdY, z: listener.fwdZ } });
        Object.assign(L, { x: listener.posX, y: listener.posY, z: listener.posZ, fx: listener.fwdX, fy: listener.fwdY, fz: listener.fwdZ, t });
      }
    }
    this.prune();
    for (const e of this.emitterById.values()) e.seen = false;
    for (const l of this.live.values()) if (l.emitter !== null) this.emitterById.get(l.emitter)!.seen = true;
    for (const e of this.emitterById.values()) {
      if (!e.seen) continue;
      let p: { x: number; y: number; z: number } | null = null;
      try {
        p = e.source.position();
      } catch {
        p = null;
      }
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      if (!changed(e.x, p.x) && !changed(e.y, p.y) && !changed(e.z, p.z)) continue;
      const dt = t - e.t;
      const vel = Number.isFinite(e.x) && dt > 0 ? { x: (p.x - e.x) / dt, y: (p.y - e.y) / dt, z: (p.z - e.z) / dt } : ZERO;
      out.poses.push({ emitter: e.id, position: { x: p.x, y: p.y, z: p.z }, velocity: vel });
      e.x = p.x; e.y = p.y; e.z = p.z; e.t = t;
    }
    if (out.poses.length > 0) this.write({ type: TakeRecordType.POSE, payload: out });
  }

  private keyframe(t: number): void {
    this.lastKeyframe = t;
    this.prune();
    const instances: TakeKeyframe["instances"] = [];
    for (const [id, l] of this.live) instances.push({ instance: id, path: l.path, started: l.started, emitter: l.emitter, parameters: { ...l.parameters } });
    const payload: TakeKeyframe = { t, instances: instances.slice(-TAKE_MAX_KEYFRAME_INSTANCES), globals: { ...this.globals } };
    const random = this.randomState?.() ?? null;
    if (random !== null && Number.isInteger(random)) payload.random = random >>> 0;
    this.write({ type: TakeRecordType.KEYFRAME, payload });
  }

  /**
   * A plugin's record (ADR 0348, `engine/audio/take/extensions.ts`): `payload` as a record of `type` (0x40..0x7e), framed
   * and kept in order with the requests, under the same cap. False when it isn't kept.
   */
  writeExtension(type: number, payload: Uint8Array): boolean {
    if (!isTakeExtensionType(type) || payload.byteLength > CAPTURE_RECORD_MAX_BYTES) return false;
    return this.append(type, payload.byteLength, (view, off) => new Uint8Array(view.buffer, view.byteOffset + off, payload.byteLength).set(payload));
  }

  private write(r: TakeRecordInit): void {
    const len = takeRecordBytes(r);
    if (len > CAPTURE_RECORD_MAX_BYTES) return; // never for a request; a keyframe is cut to fit by its instance cap
    this.append(r.type, len, (view, off) => void encodeTakeRecord(view, off, r));
  }

  /** Appends one record to the log, or stops the take (with its message) when the cap or the ring says so. */
  private append(type: number, len: number, encode: (view: DataView, off: number) => void): boolean {
    if (this.stopped) return false;
    const total = CAPTURE_RECORD_HEAD_BYTES + len;
    if (this.logBytes + total + this.ring.ringBytes + CAPTURE_META_MAX_BYTES > this.cap) {
      this.stopSelf(`the take reached its ${Math.round(this.cap / (1024 * 1024))} MiB limit and stopped recording; save it to keep what it holds`);
      return false;
    }
    const s = this.ring.stamp();
    if (!s) {
      this.stopSelf("the take stopped recording: the audio recorder was released");
      return false;
    }
    if (this.chunkUsed + total > this.chunk.byteLength) {
      this.sealChunk();
      this.chunk = new Uint8Array(Math.max(CHUNK_BYTES, total));
      this.chunkUsed = 0;
    }
    const view = new DataView(this.chunk.buffer, this.chunk.byteOffset, this.chunk.byteLength);
    writeRecordHead(view, this.chunkUsed, { type, flags: 0, epoch: s.epoch, len, seq: s.seq, frame: s.frame });
    encode(view, this.chunkUsed + CAPTURE_RECORD_HEAD_BYTES);
    this.chunkUsed += total;
    this.logBytes += total;
    this.records++;
    return true;
  }

  private sealChunk(): void {
    if (this.chunkUsed > 0) this.chunks.push(this.chunk.subarray(0, this.chunkUsed));
    this.chunk = new Uint8Array(0);
    this.chunkUsed = 0;
  }

  private stopSelf(message: string): void {
    if (this.stopped) return;
    this.stopped = message;
    this.onStop?.(message);
  }
}

const EMPTY = new Uint8Array(0);
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 }) as Vec3;
const changed = (a: number, b: number): boolean => !(Math.abs(a - b) <= POSE_EPSILON);

/** The chunk's factory (`take.ts` calls it once the module loads). */
export function createTakeRecorder(ring: TakeRecorderRing, opts: TakeRecorderOptions = {}): TakeRecorder {
  return new TakeRecorder(ring, opts);
}
