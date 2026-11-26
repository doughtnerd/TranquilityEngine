// The live take feed, tool side (schema in `runtime/debugLink/schema.ts`, build side in `runtime/debugLink/takeLive.ts`):
// reassembles the `takeLive` subscription's records into the take as it stands, a `Take` (`engine/audio/take/reader.ts`).
// It keeps the link's concerns only (ADR 0417): which take the records belong to, the log pieces' offsets (a piece that
// doesn't follow the last one is a hole), and the bytes of a record not yet whole. The log is cut back into records by
// the capture format (`splitCaptureRecords`); request records, take keyframes and pictures are decoded with the take
// record codecs (plugin records skipped) and handed to the take assembler (`engine/audio/take/assembler.ts`), which
// builds the `Take` by the take file's META rules. A hole, a record that doesn't decode or META that doesn't read breaks
// the take: `error` says why and nothing more is read until the next take starts.
// Pure: no link, no timers, no audio; the audio link client's live take follow (`audioLinkClient.ts`) feeds it. It lives
// in the editor half because only tools read live takes (the build only writes the feed).
import { TakeAssembler } from "../../../../engine/audio/take/assembler";
import type { Take } from "../../../../engine/audio/take/reader";
import { decodeTakeRecord, isTakeRecordType } from "../../../../engine/audio/take/records";
import { splitCaptureRecords } from "../../runtime/capture/format";
import {
  AudioLinkRecord, decodeTakeLiveEmitters, decodeTakeLiveEnd, decodeTakeLiveLog, decodeTakeLiveStart, type TakeLiveEnd, type TakeLiveStart,
} from "../../runtime/debugLink/schema";

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
  private assembler: TakeAssembler | null = null;
  /** Log bytes received (the next piece's offset). */
  private received = 0;
  /** Bytes of a record not yet whole. */
  private pending: Uint8Array = new Uint8Array(0);
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

  /** Why the feed broke (a hole, a record that doesn't decode, META that doesn't read); null while it reads. */
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
        this.assembler = new TakeAssembler({
          project: s.project, engine: s.engine, device: s.device, startedMs: s.started, audioHash: s.audioHash, seed: s.seed, seeded: s.seeded,
        });
        this.received = 0;
        this.pending = new Uint8Array(0);
        this.broken = null;
        this.built = null;
        return this.touch();
      }
      case AudioLinkRecord.takeLiveEmitters: {
        if (!this.reading()) return false;
        const e = decodeTakeLiveEmitters(r.payload);
        if ("refused" in e) return this.fail(e.refused);
        if (e.take !== this.start!.take) return false;
        this.assembler!.name(e.emitters);
        return this.touch();
      }
      case AudioLinkRecord.takeLiveLog: {
        if (!this.reading()) return false;
        const p = decodeTakeLiveLog(r.payload);
        if ("refused" in p) return this.fail(p.refused);
        if (p.take !== this.start!.take) return false;
        if (p.offset !== this.received) return this.fail(`the live take skipped from byte ${this.received} to ${p.offset}`);
        this.received += p.bytes.byteLength;
        this.assembler!.tick(p.seconds);
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
    const a = this.assembler;
    if (!a) return null;
    if (this.built && !this.dirty) return this.built;
    this.dirty = false;
    const take = this.end ? a.finished(this.end.section, true) : a.running();
    if (typeof take === "string") {
      // META didn't read: the feed breaks there, and what was built last stays shown.
      if (this.broken === null) this.broken = `the live take's META doesn't read: ${take}`;
      return this.built;
    }
    this.built = take;
    return take;
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

  /** Cuts whole records off `pending` + `bytes` into the assembler; a message when one doesn't decode. */
  private read(bytes: Uint8Array): string | null {
    let buf = bytes;
    if (this.pending.byteLength > 0) {
      buf = new Uint8Array(this.pending.byteLength + bytes.byteLength);
      buf.set(this.pending, 0);
      buf.set(bytes, this.pending.byteLength);
    }
    const assembler = this.assembler!;
    let used: number;
    try {
      used = splitCaptureRecords(buf, (head, view, at) => {
        if (isTakeRecordType(head.type)) assembler.add(decodeTakeRecord(head.type, view, at, head.len));
      });
    } catch (e) {
      return `a live take record doesn't read: ${messageOf(e)}`;
    }
    // Keep the rest (a copy, so the link's buffer isn't held).
    this.pending = buf.slice(used);
    return null;
  }
}
