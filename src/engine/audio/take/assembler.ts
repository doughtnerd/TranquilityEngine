/**
 * ADR 0417: the take assembler. A `Take` built from what a take is made of, whichever reader brings it: the facts it
 * started with, its decoded records as they come, and, once it has stopped, META's `take` section. A take file's reader
 * (`plugins/audio/runtime/capture/takeFile.ts`) hands it everything at once; a live take's (the audio link client's
 * `TakeLiveStream`) hands it records as the link delivers them and asks for the take as it stands. Either way META is
 * read by `readTakeMeta`'s rules (`reader.ts`), so a rule added there reaches file and live takes alike.
 *
 * Pure: no framing (the readers cut the bytes into records), no link, no plugin.
 */
import { Take, readTakeMeta } from "./reader";
import type { TakeRecord } from "./records";
import type { TakeMeta } from "./types";

/** What is known of a take when it starts: the capture META's facts, and (a live take's) META's take section so far. */
export interface TakeStartFacts {
  readonly project: string;
  readonly engine: string;
  /** The device it records on (the capture META's user agent). */
  readonly device: string;
  /** When it started, ms since the epoch (the capture header's start date). */
  readonly startedMs: number;
  /** META.take's values as the take starts (a live take's start record); a take file's come with its section. */
  readonly audioHash?: string;
  readonly seed?: number;
  readonly seeded?: boolean;
}

/** A take's time of a decoded record (a request record: its last request's). */
function recordTime(r: TakeRecord): number {
  if (r.type === "frame") return r.frame.t;
  if (r.type === "keyframe") return r.keyframe.t;
  return r.requests.at(-1)?.t ?? 0;
}

/** Builds a take from its start facts, its records and (once it stopped) its META take section. */
export class TakeAssembler {
  private readonly records: TakeRecord[] = [];
  private readonly emitters: Record<string, string> = {};
  private lastT = 0;
  private clock = 0;
  private pictures = false;

  constructor(readonly start: TakeStartFacts) {}

  /** A decoded take record, in the order the take wrote it. */
  add(record: TakeRecord): void {
    this.records.push(record);
    const t = recordTime(record);
    if (t > this.lastT) this.lastT = t;
    if (record.type === "frame") this.pictures = true;
  }

  /** Emitters the take named meanwhile (names by id; a live take sends them apart from META). */
  name(emitters: Readonly<Record<string, string>>): void {
    Object.assign(this.emitters, emitters);
  }

  /** The take's own clock moved to `seconds` (a live take's time with nothing logged). */
  tick(seconds: number): void {
    if (seconds > this.clock) this.clock = seconds;
  }

  /**
   * The take once it stopped, or why its META doesn't read (`readTakeMeta`'s refusals): META is `section`, META's take
   * section (a file's, refused when missing; a live take's end, which has no emitters: with `named` the emitters named
   * so far go beside it).
   */
  finished(section: unknown, named = false): Take | string {
    const s = named && section !== null && typeof section === "object" ? { ...section, emitters: { ...this.emitters } } : section;
    return this.build(s);
  }

  /**
   * The take while it records, or why its META doesn't read: META is what the start facts say, the emitters named so
   * far, a duration of the later of its clock and its last record's time, and `frames` once a picture came.
   */
  running(): Take | string {
    const s = this.start;
    return this.build({
      audioHash: s.audioHash ?? "", seed: s.seed ?? 0, seeded: s.seeded ?? true, duration: Math.max(this.clock, this.lastT), frames: this.pictures,
      emitters: this.emitters,
    });
  }

  private build(section: unknown): Take | string {
    const s = this.start;
    const meta: TakeMeta | string = readTakeMeta({ project: { name: s.project }, engine: s.engine, device: { userAgent: s.device } }, s.startedMs, section);
    return typeof meta === "string" ? meta : new Take(meta, this.records);
  }
}
