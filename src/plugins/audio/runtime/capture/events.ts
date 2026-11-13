// ADR 0171 amended by 0172 (M5b, task Rc3, leaf L-Rc3a; api-and-models §5.3, §5.6): the real `ProfileSink`. Each tap of
// `mix/profileSink.ts` becomes one EVENT record (every §5.6 kind and reason code), `epoch`, `gap` and `marker` become the
// recorder's EPOCH, GAP and MARKER, and every string argument is interned once into a NAMES record.
//
// **Ids.** A clip, bus, event asset, parameter, snapshot, state label or music segment is named by a `u32` id from its
// NAMES table (`NAME_TABLES`): the first use writes a NAMES record (the one allocation, once per name) and a later use is
// a `Map` lookup. `seed` loads the ids the META chunk already holds so the sink continues after them. A name the ring
// couldn't take (no segment open, dropped) is not marked interned, so the next use retries; its event carries `NO_NAME`.
// A bus is interned by its name (the sink sees names, not `gen << 8 | slot`); the file reader resolves `busRef`s of this
// kind through the `buses` table.
//
// **Frames.** A tap has no frame of its own: it is recorded at the newest STATUS frame (`recorder.newestStatusFrame`,
// "now"). `voiceStart`'s `atFrame` is the one stamp: a start at or before now is recorded at now, one within a second
// ahead at its frame, one further ahead (§5.3's disorder bound) at now with the `deferred` flag and the stamp leading the
// payload.
//
// **No allocation per event.** The payload is one reused `EventPayload` whose `args` array is picked from fixed arrays by
// length, written straight into the ring through `encodeEvent`; an f32 parameter value goes through one scratch pair of
// typed arrays. Only a first-use name (NAMES) and a marker (its text) allocate.
import type {
  ProfileEpochReason, ProfileGapReason, ProfileLoudnessControl, ProfileQueuedReason, ProfileRealReason, ProfileRefusedReason,
  ProfileSink, ProfileStealReason, ProfileStopReason, ProfileVirtualReason,
} from "../mix/profileSink";
import {
  CAPTURE_MAX_NAMES, CAPTURE_NAME_MAX_BYTES, EpochReason, EventKind, GapReason, NAME_TABLES, RECORD_FLAG_DEFERRED, RecordType,
  cutUtf8, encodeEvent, encodeNames, eventBytes, namesBytes, type EventPayload, type NameTable,
} from "./format";
import type { EpochPayload } from "./format";
import type { RecorderRing } from "./ring";

/** The context an EPOCH names (`recorder.ts`' `EpochContext`, restated: no file but `capture.ts` may import the recorder, even for a type). */
export type EpochContext = Omit<EpochPayload, "reason" | "perfMs">;

/** What the sink uses of a `Recorder` (`capture/recorder.ts`); the real one satisfies it. */
export interface EventSinkRecorder {
  readonly ring: Pick<RecorderRing, "view">;
  readonly newestStatusFrame: number;
  readonly sampleRate: number;
  readonly epochNumber: number;
  record(type: number, frame: number, len: number, flags?: number): number;
  begin(frame: number, context: EpochContext): void;
  epoch(reason: number, frame: number, context: EpochContext): void;
  gap(reason: number, frame: number, perfFrom: number, perfTo: number, firstSeq?: number, lastSeq?: number): void;
  marker(text: string, frame: number): void;
}

/** The id an absent name or instance carries (`null` instance, `null` bus or `from`, a name the ring couldn't take). */
export const NO_NAME = 0xffffffff;

/** EVENT `reason` codes (§5.6), by the sink's reason strings. */
export const STOP_REASON: Readonly<Record<ProfileStopReason, number>> = { ended: 1, stopped: 2, faded: 3, worldReleased: 4, failed: 5 };
export const STEAL_REASON: Readonly<Record<ProfileStealReason, number>> = { busMaxVoices: 1, globalLimit: 2, priority: 3 };
export const VIRTUAL_REASON: Readonly<Record<ProfileVirtualReason, number>> = { capDemoted: 1, belowAudibility: 2, paused: 3, worldInaudible: 4 };
export const REAL_REASON: Readonly<Record<ProfileRealReason, number>> = { promoted: 1, capRaised: 2 };
export const REFUSED_REASON: Readonly<Record<ProfileRefusedReason, number>> = { busFull: 1, poolFull: 2, neverFits: 3, loadFailed: 4, capRefused: 5 };
export const QUEUED_REASON: Readonly<Record<ProfileQueuedReason, number>> = { clipLoading: 1, streamPriming: 2 };
export const LOUDNESS_CONTROL_REASON: Readonly<Record<ProfileLoudnessControl, number>> = { reset: 1, pause: 2, resume: 3, target: 4 };
/** ladder: reason 2 `shed`, 3 `restored` (1 is §5.6's bare "step", not written by this sink). */
export const LADDER_REASON = { shed: 2, restored: 3 } as const;
/** busRamp `lane` arg: the lane's index in the KEYFRAME bus row's lane order; `NO_NAME` for a lane this build doesn't know. */
export const BUS_RAMP_LANES: Readonly<Record<string, number>> = { authored: 0, runtime: 1, snapshot: 2, monitor: 3, dip: 4 };

const TABLE: Readonly<Record<NameTable, number>> = { clips: 0, buses: 1, events: 2, parameters: 3, snapshots: 4, targets: 5 };
const T_CLIP = TABLE.clips, T_BUS = TABLE.buses, T_EVENT = TABLE.events, T_PARAM = TABLE.parameters, T_SNAPSHOT = TABLE.snapshots;

/** Options of `createEventSink`. */
export interface EventSinkOptions {
  /** `performance.now()` for `perfMs`; injectable for tests. */
  now?: () => number;
  /**
   * The context a new core's EPOCH names (and the `start` one when nothing was begun), read when `epoch` is called: the
   * rest of `EpochPayload` but `reason` and `perfMs`, and the new context's first frame (default 0). Default: the recorder's
   * sample rate and zeros. Rc4 wires the backend's real values.
   */
  epochContext?: () => EpochContext & { frame?: number };
}

/** The NAMES tables the sink has written, for the saver to merge beside META's (`table` index into `NAME_TABLES`). */
export type InternedNames = ReadonlyArray<ReadonlyMap<string, number>>;

export class EventSink implements ProfileSink {
  private readonly recorder: EventSinkRecorder;
  private readonly now: () => number;
  private readonly epochContext: (() => EpochContext & { frame?: number }) | undefined;

  /** One name -> id map per `NAME_TABLES` entry, and the next id to give. */
  private readonly ids: Map<string, number>[] = NAME_TABLES.map(() => new Map<string, number>());
  private readonly nextId: number[] = NAME_TABLES.map(() => 0);
  /** Name records the ring took (tests). */
  namesWritten = 0;
  /** Events written, and events the ring dropped (tests, debug). */
  eventsWritten = 0;
  eventsDropped = 0;

  // The scratch payload and its args arrays, one per length (the longest EVENT has 5 args).
  private readonly args: number[][] = [[], [0], [0, 0], [0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0, 0]];
  private readonly payload: EventPayload = { perfMs: 0, kind: 0, reason: 0, args: this.args[0]!, f32: 0 };
  private readonly f32 = new Float32Array(1);
  private readonly f32bits = new Uint32Array(this.f32.buffer);

  constructor(recorder: EventSinkRecorder, opts: EventSinkOptions = {}) {
    this.recorder = recorder;
    this.now = opts.now ?? (() => performance.now());
    this.epochContext = opts.epochContext;
  }

  // --- names ----------------------------------------------------------------------------------------------------------

  /** Loads a name META already holds, so its id is reused and the next new id of the table follows the largest seeded. */
  seed(table: NameTable, id: number, name: string): void {
    const t = TABLE[table];
    this.ids[t]!.set(name, id);
    if (id >= this.nextId[t]!) this.nextId[t] = id + 1;
  }

  /** Forgets every interned name (a new capture session starts its tables over). */
  reset(): void {
    for (let t = 0; t < this.ids.length; t++) {
      this.ids[t]!.clear();
      this.nextId[t] = 0;
    }
    this.namesWritten = this.eventsWritten = this.eventsDropped = 0;
  }

  /** The names interned so far, by table (live maps). */
  get interned(): InternedNames {
    return this.ids;
  }

  /** `name`'s id in `table`, writing its NAMES record on first use. `NO_NAME` when the ring can't take the record. */
  private intern(table: number, name: string): number {
    const map = this.ids[table]!;
    const known = map.get(name);
    if (known !== undefined) return known;
    const id = this.nextId[table]!;
    if (id >= CAPTURE_MAX_NAMES) return NO_NAME;
    const text = cutUtf8(name, CAPTURE_NAME_MAX_BYTES);
    const p = { table, id, name: text };
    const off = this.recorder.record(RecordType.NAMES, this.recorder.newestStatusFrame, namesBytes(p));
    if (off < 0) return NO_NAME;
    encodeNames(this.recorder.ring.view, off, p);
    this.nextId[table] = id + 1;
    map.set(name, id);
    this.namesWritten++;
    return id;
  }

  private nameOrNone(table: number, name: string | null): number {
    return name === null ? NO_NAME : this.intern(table, name);
  }

  // --- the event write --------------------------------------------------------------------------------------------------

  /** Writes the scratch payload as an EVENT at `frame`, with `stamp` leading it when `deferred`. */
  private write(kind: number, reason: number, args: number[], f32: number, frame: number, deferred: boolean, stamp: number): void {
    const p = this.payload;
    p.perfMs = this.now();
    p.kind = kind;
    p.reason = reason;
    p.args = args;
    p.f32 = f32;
    const len = eventBytes(p);
    const rec = this.recorder;
    const off = rec.record(RecordType.EVENT, frame, deferred ? len + 8 : len, deferred ? RECORD_FLAG_DEFERRED : 0);
    if (off < 0) {
      this.eventsDropped++;
      return;
    }
    const view = rec.ring.view;
    if (deferred) {
      view.setFloat64(off, stamp, true);
      encodeEvent(view, off + 8, p);
    } else {
      encodeEvent(view, off, p);
    }
    this.eventsWritten++;
  }

  private now1(kind: number, reason: number, a0: number, f32 = 0): void {
    const a = this.args[1]!;
    a[0] = a0;
    this.write(kind, reason, a, f32, this.recorder.newestStatusFrame, false, 0);
  }

  private now2(kind: number, reason: number, a0: number, a1: number, f32 = 0): void {
    const a = this.args[2]!;
    a[0] = a0;
    a[1] = a1;
    this.write(kind, reason, a, f32, this.recorder.newestStatusFrame, false, 0);
  }

  // --- ProfileSink: events ----------------------------------------------------------------------------------------------

  voiceStart(id: number, clip: string, bus: string, flags: number, atFrame: number, gain: number): void {
    const clipId = this.intern(T_CLIP, clip);
    const busId = this.intern(T_BUS, bus);
    const a = this.args[5]!;
    a[0] = id;
    a[1] = clipId;
    a[2] = busId;
    a[3] = flags;
    a[4] = atFrame; // `atFrameLo`: the low 32 bits (`setUint32` wraps)
    const rec = this.recorder;
    const now = rec.newestStatusFrame;
    let frame = now;
    let deferred = false;
    if (atFrame > now) {
      if (atFrame - now > rec.sampleRate) deferred = true;
      else frame = atFrame;
    }
    this.write(EventKind.voiceStart, 0, a, gain, frame, deferred, atFrame);
  }

  voiceStop(id: number, reason: ProfileStopReason): void {
    this.now1(EventKind.voiceStop, STOP_REASON[reason], id);
  }

  voiceSteal(victim: number, thief: number, reason: ProfileStealReason): void {
    this.now2(EventKind.voiceSteal, STEAL_REASON[reason], victim, thief);
  }

  voiceVirtual(id: number, reason: ProfileVirtualReason): void {
    this.now1(EventKind.voiceVirtual, VIRTUAL_REASON[reason], id);
  }

  voiceReal(id: number, reason: ProfileRealReason): void {
    this.now1(EventKind.voiceReal, REAL_REASON[reason], id);
  }

  voiceRefused(clip: string, bus: string, reason: ProfileRefusedReason): void {
    this.now2(EventKind.voiceRefused, REFUSED_REASON[reason], this.intern(T_CLIP, clip), this.intern(T_BUS, bus));
  }

  voiceQueued(clip: string, bus: string, reason: ProfileQueuedReason): void {
    this.now2(EventKind.voiceQueued, QUEUED_REASON[reason], this.intern(T_CLIP, clip), this.intern(T_BUS, bus));
  }

  eventStart(instance: number, asset: string): void {
    this.now2(EventKind.eventStart, 0, instance, this.intern(T_EVENT, asset));
  }

  eventStop(instance: number): void {
    this.now1(EventKind.eventStop, 0, instance);
  }

  /** args: parameter name id, instance (`NO_NAME` for a global one), then the value's f32 bits (kind 10 has no f32 tail). */
  parameter(name: string, value: number, instance: number | null): void {
    const a = this.args[3]!;
    this.f32[0] = value;
    a[0] = this.intern(T_PARAM, name);
    a[1] = instance === null ? NO_NAME : instance;
    a[2] = this.f32bits[0]!;
    this.write(EventKind.parameter, 0, a, 0, this.recorder.newestStatusFrame, false, 0);
  }

  snapshot(name: string, seconds: number): void {
    this.now1(EventKind.snapshot, 0, this.intern(T_SNAPSHOT, name), seconds);
  }

  /** args: parameter name id, label id (the label is interned in the `parameters` table too). */
  stateChange(parameter: string, label: string): void {
    this.now2(EventKind.stateChange, 0, this.intern(T_PARAM, parameter), this.intern(T_PARAM, label));
  }

  /** args: music instance, `from` segment id (`NO_NAME` when null), `to` segment id; segments are interned in the `events` table. */
  musicTransition(instance: number, from: string | null, to: string): void {
    const a = this.args[3]!;
    a[0] = instance;
    a[1] = this.nameOrNone(T_EVENT, from);
    a[2] = this.intern(T_EVENT, to);
    this.write(EventKind.musicTransition, 0, a, 0, this.recorder.newestStatusFrame, false, 0);
  }

  busRamp(bus: string, lane: string, frames: number, target: number): void {
    const a = this.args[3]!;
    a[0] = this.intern(T_BUS, bus);
    a[1] = BUS_RAMP_LANES[lane] ?? NO_NAME;
    a[2] = frames;
    this.write(EventKind.busRamp, 0, a, target, this.recorder.newestStatusFrame, false, 0);
  }

  monitor(mask: number): void {
    this.now1(EventKind.monitor, 0, mask);
  }

  loudnessControl(control: ProfileLoudnessControl, bus: string | null): void {
    this.now1(EventKind.loudnessControl, LOUDNESS_CONTROL_REASON[control], this.nameOrNone(T_BUS, bus));
  }

  ladder(step: number, shed: boolean): void {
    this.now1(EventKind.ladder, shed ? LADDER_REASON.shed : LADDER_REASON.restored, step);
  }

  masterChange(volume: number, muted: boolean): void {
    this.now1(EventKind.masterChange, 0, muted ? 1 : 0, volume);
  }

  hiddenTab(hidden: boolean): void {
    this.now1(EventKind.hiddenTab, 0, hidden ? 1 : 0);
  }

  // --- ProfileSink: epoch, gap, marker ----------------------------------------------------------------------------------

  /** `start` begins the recording when none was begun (else it is one more epoch); every other reason opens a new epoch. */
  epoch(reason: ProfileEpochReason): void {
    const rec = this.recorder;
    const c = this.epochContext?.();
    const frame = c?.frame ?? 0;
    const ctx: EpochContext = c ?? { sampleRate: rec.sampleRate || 48_000, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0 };
    if (reason === "start" && rec.epochNumber < 0) rec.begin(frame, ctx);
    else if (rec.epochNumber >= 0) rec.epoch(EpochReason[reason], frame, ctx);
  }

  /** A GAP from now: `perfFrom` and `perfTo` are both now (the sink can't know when the next block comes). */
  gap(reason: ProfileGapReason): void {
    const rec = this.recorder;
    if (rec.epochNumber < 0) return;
    const t = this.now();
    rec.gap(GapReason[reason], rec.newestStatusFrame, t, t);
  }

  marker(text: string): void {
    const rec = this.recorder;
    if (rec.epochNumber < 0) return;
    rec.marker(text, rec.newestStatusFrame);
  }
}

/** The sink for a recorder: set it with `backend.setProfileSink(sink)` (Rc4, once the recorder runs). */
export function createEventSink(recorder: EventSinkRecorder, opts: EventSinkOptions = {}): EventSink {
  return new EventSink(recorder, opts);
}
