/**
 * ADR 0348: a take's requests, keyframes and pictures, read for replay. Pure: the file's framing (header, inflate, record
 * heads) is the capture reader's (`plugins/audio/runtime/capture/takeFile.ts` walks the records and hands the request
 * records here); this module orders what they hold by time and answers the replay's questions: the requests in a span,
 * the keyframe in force at a time, and what a seek must re-issue.
 *
 * The requests keep their file order among equal times (a stop and a play at one instant replay in the order the game
 * made them).
 */
import { firstAfter, firstAtOrAfter, lastAtOrBefore } from "../../core/sortedSearch";
import type { TakeRecord } from "./records";
import type { TakeFrame, TakeKeyframe, TakeMeta, TakeRequest } from "./types";

/** What a seek to `t` hands the replay: the keyframe in force (null before the first) and the requests after it up to `t`. */
export interface TakeSeek {
  keyframe: TakeKeyframe | null;
  /** Requests in `[keyframe.t, t)` (from 0 without a keyframe), in order: re-issue them to bring the keyframe's state to `t`. */
  requests: TakeRequest[];
}

/** A take opened for replay. */
export class Take {
  readonly requests: readonly TakeRequest[];
  readonly keyframes: readonly TakeKeyframe[];
  readonly frames: readonly TakeFrame[];
  private readonly requestTimes: Float64Array;
  private readonly keyframeTimes: Float64Array;
  private readonly frameTimes: Float64Array;

  constructor(readonly meta: TakeMeta, records: Iterable<TakeRecord>) {
    const requests: TakeRequest[] = [];
    const keyframes: TakeKeyframe[] = [];
    const frames: TakeFrame[] = [];
    for (const r of records) {
      if (r.type === "request") for (const q of r.requests) requests.push(q);
      else if (r.type === "keyframe") keyframes.push(r.keyframe);
      else frames.push(r.frame);
    }
    // A stable sort: `Array.prototype.sort` is stable, and records within one epoch are written in time order already.
    requests.sort((a, b) => a.t - b.t);
    keyframes.sort((a, b) => a.t - b.t);
    frames.sort((a, b) => a.t - b.t);
    this.requests = requests;
    this.keyframes = keyframes;
    this.frames = frames;
    this.requestTimes = Float64Array.from(requests, (q) => q.t);
    this.keyframeTimes = Float64Array.from(keyframes, (k) => k.t);
    this.frameTimes = Float64Array.from(frames, (f) => f.t);
  }

  /** Seconds the take spans: META's duration, or the last request's time when that is later. */
  get duration(): number {
    const last = this.requestTimes.length > 0 ? this.requestTimes[this.requestTimes.length - 1]! : 0;
    return Math.max(this.meta.duration, last);
  }

  /** The requests in `[from, to)`, in order. */
  requestsBetween(from: number, to: number): TakeRequest[] {
    return this.requests.slice(firstAtOrAfter(this.requestTimes, from), firstAtOrAfter(this.requestTimes, to));
  }

  /** The requests from `t` on (inclusive), in order, lazily. */
  *requestsFrom(t: number): IterableIterator<TakeRequest> {
    for (let i = firstAtOrAfter(this.requestTimes, t); i < this.requests.length; i++) yield this.requests[i]!;
  }

  /** The keyframe in force at `t` (the last at or before it); null before the first. */
  keyframeAt(t: number): TakeKeyframe | null {
    const i = lastAtOrBefore(this.keyframeTimes, t);
    return i < 0 ? null : this.keyframes[i]!;
  }

  /** The picture shown at `t` (the last at or before it); null before the first or in a take without pictures. */
  frameAt(t: number): TakeFrame | null {
    const i = lastAtOrBefore(this.frameTimes, t);
    return i < 0 ? null : this.frames[i]!;
  }

  /** Seek to `t`: the keyframe in force and the requests after it up to (not including) `t`. */
  seek(t: number): TakeSeek {
    const keyframe = this.keyframeAt(t);
    const from = keyframe ? firstAtOrAfter(this.requestTimes, keyframe.t) : 0;
    const to = firstAtOrAfter(this.requestTimes, t);
    return { keyframe, requests: this.requests.slice(from, Math.max(from, to)) };
  }

  /** The marks (`Audio.take.mark`), in order. */
  marks(): Extract<TakeRequest, { kind: "mark" }>[] {
    return this.requests.filter((q): q is Extract<TakeRequest, { kind: "mark" }> => q.kind === "mark");
  }

  /** Every distinct playlist, sample or event path the take plays, in first-play order. */
  paths(): string[] {
    const seen = new Set<string>();
    for (const q of this.requests) if (q.kind === "play") seen.add(q.path);
    return [...seen];
  }

  /** The requests at exactly `t` (one instant's batch), in order. */
  requestsAt(t: number): TakeRequest[] {
    return this.requests.slice(firstAtOrAfter(this.requestTimes, t), firstAfter(this.requestTimes, t));
  }
}

/** The META `take` section a take file carries (ADR 0348), as written; the reader checks it (`readTakeMeta`). */
export interface TakeMetaSection {
  audioHash: string;
  seed: number;
  seeded: boolean;
  duration: number;
  frames: boolean;
  emitters: Record<string, string>;
}

/** Most emitters a META names. */
export const TAKE_MAX_EMITTERS = 65_536;
/** An emitter's name, characters (cut, not refused). */
const EMITTER_NAME_MAX = 256;

/**
 * The take's META from the capture META's facts and its `take` section. Refuses (returns a message) when the section is
 * missing or not the shape `TakeMetaSection` describes: a take file without it is not a take.
 */
export function readTakeMeta(capture: { project: { name: string }; engine: string; device: { userAgent: string } }, startedMs: number, section: unknown): TakeMeta | string {
  if (typeof section !== "object" || section === null || Array.isArray(section)) return "META has no take section";
  const s = section as Record<string, unknown>;
  const num = (k: string): number | null => (typeof s[k] === "number" && Number.isFinite(s[k]) ? (s[k] as number) : null);
  const seed = num("seed");
  const duration = num("duration");
  if (seed === null || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) return "META.take.seed is not a u32";
  if (duration === null || duration < 0) return "META.take.duration is not a non-negative number";
  if (typeof s.audioHash !== "string" || s.audioHash.length > 64) return "META.take.audioHash is not a short string";
  if (typeof s.frames !== "boolean") return "META.take.frames is not a boolean";
  if (s.seeded !== undefined && typeof s.seeded !== "boolean") return "META.take.seeded is not a boolean";
  const emittersIn = s.emitters;
  if (typeof emittersIn !== "object" || emittersIn === null || Array.isArray(emittersIn)) return "META.take.emitters is not an object";
  const emitters: Record<number, string> = {};
  let n = 0;
  for (const key of Object.keys(emittersIn)) {
    if (!/^(0|[1-9][0-9]{0,9})$/.test(key) || Number(key) > 0xffff_ffff) return "META.take.emitters has a key that is not a u32 id";
    if (++n > TAKE_MAX_EMITTERS) return `META.take.emitters names more than ${TAKE_MAX_EMITTERS} emitters`;
    emitters[Number(key)] = String((emittersIn as Record<string, unknown>)[key]).slice(0, EMITTER_NAME_MAX);
  }
  const meta: TakeMeta = {
    project: capture.project.name, engine: capture.engine, audioHash: s.audioHash, seed, device: capture.device.userAgent,
    started: new Date(Number.isFinite(startedMs) ? startedMs : 0).toISOString(), duration, emitters, frames: s.frames,
  };
  if (s.seeded === false) meta.seeded = false;
  return meta;
}
