// The live take feed, tool side (schema in `schema.ts`, build side in `takeLive.ts`): reassembles the `takeLive`
// subscription's records into the take as it stands, a `Take` (`engine/audio/take/reader.ts`) rebuilt from the start
// record's facts and the log's records whenever asked after something new arrived. The log pieces are concatenated by
// offset and cut back into whole records (the capture framing's 20 B heads); request records, take keyframes and pictures
// are decoded with the take record codecs, plugin records skipped. A piece that doesn't follow the last one (a hole) or a
// record that doesn't decode breaks the take: `error` says why and nothing more is read until the next take starts.
// Pure: no link, no timers, no audio; the Studio's live take (`studio/runtime/liveTake.ts`) feeds it.
import { Take } from "../../../../engine/audio/take/reader";
import { decodeTakeRecord, isTakeRecordType, type TakeRecord } from "../../../../engine/audio/take/records";
import type { TakeMeta } from "../../../../engine/audio/take/types";
import { CAPTURE_RECORD_HEAD_BYTES, CAPTURE_RECORD_MAX_BYTES } from "../capture/format";
import {
  AudioLinkRecord, decodeTakeLiveEmitters, decodeTakeLiveEnd, decodeTakeLiveLog, decodeTakeLiveStart, type TakeLiveEnd, type TakeLiveStart,
} from "./schema";

/** Where a live take stands: none seen yet, recording, or stopped (its end record arrived). */
export type TakeLiveStreamState = "idle" | "recording" | "stopped";

/** One `takeLive` record as the link delivers it. */
export interface TakeLiveRecordIn {
  readonly type: number;
  readonly payload: Uint8Array;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A live take's records reassembled. */
export class TakeLiveStream {
  private start: TakeLiveStart | null = null;
  private end: TakeLiveEnd | null = null;
  private records: TakeRecord[] = [];
  private emitters: Record<number, string> = {};
  /** Log bytes received (the next piece's offset). */
  private received = 0;
  /** Bytes of a record not yet whole. */
  private pending: Uint8Array = new Uint8Array(0);
  private seconds = 0;
  private lastT = 0;
  private broken: string | null = null;
  private built: Take | null = null;
  private dirty = false;

  /** The take's state. */
  get state(): TakeLiveStreamState {
    return this.start === null ? "idle" : this.end ? "stopped" : "recording";
  }

  /** The take's facts as it started; null before a start record. */
  get facts(): TakeLiveStart | null {
    return this.start;
  }

  /** Why it stopped by itself (the build's message); null otherwise or while it records. */
  get stopMessage(): string | null {
    return this.end?.message ?? null;
  }

  /** Why the feed broke (a hole, a record that doesn't decode); null while it reads. */
  get error(): string | null {
    return this.broken;
  }

  /** True when something arrived since `take()` last built. */
  get changed(): boolean {
    return this.dirty;
  }

  /** Reads one record. Answers true when it changed the take (its state, emitters or records). */
  push(r: TakeLiveRecordIn): boolean {
    switch (r.type) {
      case AudioLinkRecord.takeLiveStart: {
        const s = decodeTakeLiveStart(r.payload);
        if ("refused" in s) return this.fail(s.refused);
        this.start = s;
        this.end = null;
        this.records = [];
        this.emitters = {};
        this.received = 0;
        this.pending = new Uint8Array(0);
        this.seconds = 0;
        this.lastT = 0;
        this.broken = null;
        return this.touch();
      }
      case AudioLinkRecord.takeLiveEmitters: {
        if (!this.reading()) return false;
        const e = decodeTakeLiveEmitters(r.payload);
        if ("refused" in e) return this.fail(e.refused);
        if (e.take !== this.start!.take) return false;
        for (const [id, name] of Object.entries(e.emitters)) this.emitters[Number(id)] = name;
        return this.touch();
      }
      case AudioLinkRecord.takeLiveLog: {
        if (!this.reading()) return false;
        const p = decodeTakeLiveLog(r.payload);
        if ("refused" in p) return this.fail(p.refused);
        if (p.take !== this.start!.take) return false;
        if (p.offset !== this.received) return this.fail(`the live take skipped from byte ${this.received} to ${p.offset}`);
        this.received += p.bytes.byteLength;
        this.seconds = Math.max(this.seconds, p.seconds);
        if (p.bytes.byteLength > 0) {
          const error = this.read(p.bytes);
          if (error) return this.fail(error);
        }
        return this.touch();
      }
      case AudioLinkRecord.takeLiveEnd: {
        if (!this.reading()) return false;
        const e = decodeTakeLiveEnd(r.payload);
        if ("refused" in e) return this.fail(e.refused);
        if (e.take !== this.start!.take) return false;
        this.end = e;
        return this.touch();
      }
      default:
        return false;
    }
  }

  /** The take as it stands (null before a start record), rebuilt when something arrived since the last call. */
  take(): Take | null {
    const s = this.start;
    if (!s) return null;
    if (this.built && !this.dirty) return this.built;
    const end = this.end?.section;
    const meta: TakeMeta = {
      project: s.project, engine: s.engine, audioHash: end?.audioHash ?? s.audioHash, seed: end?.seed ?? s.seed, device: s.device,
      started: new Date(s.started).toISOString(), duration: end ? end.duration : Math.max(this.seconds, this.lastT), emitters: { ...this.emitters },
      frames: end ? end.frames : this.records.some((r) => r.type === "frame"),
    };
    if (!(end?.seeded ?? s.seeded)) meta.seeded = false;
    this.built = new Take(meta, this.records);
    this.dirty = false;
    return this.built;
  }

  private reading(): boolean {
    return this.start !== null && this.broken === null && this.end === null;
  }

  private touch(): true {
    this.dirty = true;
    return true;
  }

  private fail(why: string): true {
    this.broken = why;
    return this.touch();
  }

  /** Cuts whole records off `pending` + `bytes`; a message when one doesn't decode. */
  private read(bytes: Uint8Array): string | null {
    let buf = bytes;
    if (this.pending.byteLength > 0) {
      buf = new Uint8Array(this.pending.byteLength + bytes.byteLength);
      buf.set(this.pending, 0);
      buf.set(bytes, this.pending.byteLength);
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0;
    while (buf.byteLength - off >= CAPTURE_RECORD_HEAD_BYTES) {
      const type = view.getUint8(off);
      const len = view.getUint32(off + 4, true);
      if (len > CAPTURE_RECORD_MAX_BYTES) return `a live take record of ${len} B is past the ${CAPTURE_RECORD_MAX_BYTES} B cap`;
      if (buf.byteLength - off < CAPTURE_RECORD_HEAD_BYTES + len) break;
      if (isTakeRecordType(type)) {
        try {
          const r = decodeTakeRecord(type, view, off + CAPTURE_RECORD_HEAD_BYTES, len);
          this.records.push(r);
          const t = r.type === "frame" ? r.frame.t : r.type === "keyframe" ? r.keyframe.t : (r.requests.at(-1)?.t ?? 0);
          if (t > this.lastT) this.lastT = t;
        } catch (e) {
          return `a live take record doesn't read: ${messageOf(e)}`;
        }
      }
      off += CAPTURE_RECORD_HEAD_BYTES + len;
    }
    // Keep the rest (a copy, so the link's buffer isn't held).
    this.pending = buf.slice(off);
    return null;
  }
}
