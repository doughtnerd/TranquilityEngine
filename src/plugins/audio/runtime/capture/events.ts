// ADR 0171 amended by 0172 (M5b, task Rc3, leaf L-Rc3a; api-and-models §5.3, §5.6): the real `ProfileSink`. Each tap of
// `mix/profileSink.ts` becomes one EVENT record (every §5.6 kind and reason code), `epoch`, `gap` and `marker` become the
// recorder's EPOCH, GAP and MARKER, and every string argument is interned once into a NAMES record.
//
// **Ids.** A clip, bus, event asset, parameter, snapshot, state label or music segment is named by a `u32` id from its
// NAMES table (`NAME_TABLES`): the first use writes a NAMES record (the one allocation, once per name) and a later use is
// a `Map` lookup. `seed` loads the ids the META chunk already holds so the sink continues after them. A name the ring
// couldn't take (no segment open, dropped) is not marked interned, so the next use retries; its event carries `NO_NAME`.
// A bus is never interned: the sink sees a `busRef` (`gen << 8 | slot`, §6.3) and writes it raw into the arg; the file
// reader takes `busRef & 0xff` as the slot and names it through the `buses` table, which is keyed by slot: META's slots at
// the take's start, then a NAMES record each time a slot takes a new name (an add, a recycle, a rename; `busNames`, ADR
// 0260), so the reader names a slot as it was at each instant (`names.ts`). `loudnessControl`'s bus arrives as a name (the
// sink has no slot for it), so it is interned into the `parameters` table, not `buses`.
//
// **Arg layouts** (§5.6): voiceStart `id, clip, busRef, flags, atFrameLo` + f32 gain; voiceRefused and voiceQueued `clip,
// busRef`; busRamp `busRef, lane, frames` + f32 target; monitor `mask` (mutes in the low 16 bits, solos in the high 16, as
// `mixerTapFor` packs it); snapshot `name` + f32 seconds (`NO_NAME` for the cleared snapshot, the empty name); parameter
// `name, instance, f32 bits` (instance `NO_NAME` for a global parameter; it is a group's id otherwise).
//
// **Frames.** A tap has no frame of its own: it is recorded at the newest STATUS frame (`recorder.newestStatusFrame`,
// "now"). `voiceStart`'s `atFrame` is the one stamp: a start at or before now is recorded at now, one within a second
// ahead at its frame, one further ahead (§5.3's disorder bound) at now with the `deferred` flag and the stamp leading the
// payload.
//
// **No allocation per event.** The payload is one reused `EventPayload` whose `args` array is picked from fixed arrays by
// length, written straight into the ring through `encodeEvent`; an f32 parameter value goes through one scratch pair of
// typed arrays. Only a first-use name (NAMES) and a marker (its text) allocate.
//
// **Reading back** (ADR 0227, 0260). `readCaptureEvent` is the inverse of the writes: it turns a decoded EVENT payload into a
// `CaptureEvent` by name (`NO_NAME` as null, `busRef` as slot and generation, the parameter's f32 bits as a number, the
// reason code as the sink's word, `reasons.ts`), so the arg layouts above are known here and nowhere else. The reader hands
// the Profiler only typed events.
import type {
  ProfileCause, ProfileEpochReason, ProfileGapReason, ProfileLoudnessControl, ProfileLoudnessState, ProfilePackageEvent, ProfilePick, ProfilePluginFault, ProfileQueuedReason, ProfileRealReason,
  ProfileRefusedReason, ProfileSink, ProfileStealReason, ProfileStopReason, ProfileVirtualReason,
} from "../mix/profileSink";
import { encodeMixOp } from "../../../../engine/audio/mixOpCodec";
import { OP_CLASS_CODES, type MixOp, type OpClass } from "../../../../engine/audio/mixOps";
import {
  CAPTURE_MAX_NAMES, CAPTURE_NAME_MAX_BYTES, EpochReason, EventKind, GapReason, NAME_TABLES, NO_NAME, RECORD_FLAG_DEFERRED, RecordType,
  MixOpOrigin, cutUtf8, encodeEvent, encodeMixOpRecord, encodeNames, eventBytes, mixOpBytes, namesBytes, type EventPayload, type NameTable,
} from "./format";
import type { EpochPayload } from "./format";
import type { RecorderRing } from "./ring";
import {
  LADDER_REASON, LOUDNESS_CONTROL_REASON, QUEUED_REASON, REAL_REASON, REFUSED_REASON, STEAL_REASON, STOP_REASON, VIRTUAL_REASON,
  loudnessControlOf, queuedReason, realReason, refusedReason, stealReason, stopReason, virtualReason,
} from "./reasons";

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

/** The id an absent name or instance carries (`null` instance, `null` bus or `from`, a name the ring couldn't take); `format.ts` declares it, beside the KEYFRAME rows that use it too. */
export { NO_NAME };

/** ADR 0348: a pick's `type` arg, the playlist type's index here. */
export const PICK_TYPES = ["clip", "queue", "switch", "blend", "layer", "sequence"] as const satisfies readonly ProfilePick["type"][];
/** ADR 0348: a loudness warning's `reason`. */
const LOUDNESS_STATE: Readonly<Record<ProfileLoudnessState, number>> = { high: 1, low: 2, ok: 3 };
const LOUDNESS_STATE_OF: readonly (ProfileLoudnessState | null)[] = [null, "high", "low", "ok"];
/** ADR 0351 §9: a `PKG` event's `reason`. */
const PACKAGE_EVENT: Readonly<Record<ProfilePackageEvent, number>> = { loadStart: 1, loaded: 2, failed: 3, unload: 4 };
const PACKAGE_EVENT_OF: readonly (ProfilePackageEvent | null)[] = [null, "loadStart", "loaded", "failed", "unload"];
/** ADR 0352 §6: a plugin fault's reason code (1-based). */
const PLUGIN_FAULT: Readonly<Record<ProfilePluginFault, number>> = { trap: 1, budget: 2, grow: 3, nonFinite: 4, range: 5 };
const PLUGIN_FAULT_OF: readonly (ProfilePluginFault | null)[] = [null, "trap", "budget", "grow", "nonFinite", "range"];

/** busRamp `lane` arg: the lane's index in the KEYFRAME bus row's lane order; `NO_NAME` for a lane this build doesn't know. */
export const BUS_RAMP_LANES: Readonly<Record<string, number>> = { authored: 0, runtime: 1, snapshot: 2, monitor: 3, dip: 4, duck: 5, automation: 6 };

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

  // The scratch payload and its args arrays, one per length (the longest EVENT has 10 args: a pick).
  private readonly args: number[][] = [[], [0], [0, 0], [0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [], [], [], new Array<number>(10).fill(0)];
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

  /**
   * `name`'s id in `table` (G7b): a KEYFRAME source interns the clips, snapshots and event assets it names through here, so a
   * keyframe row and an EVENT carry the same id. Writes the NAMES record on first use; `NO_NAME` when the ring can't take it.
   */
  name(table: NameTable, name: string): number {
    return this.intern(TABLE[table], name);
  }

  /**
   * ADR 0260: bus slot `slot` is called `name` from now (a bus added or recycled into it, or renamed). Writes a NAMES record
   * in the `buses` table, keyed by the slot as META's is, unless the slot already holds that name (seeded or written); a
   * record the ring can't take is retried at the next call.
   */
  busName(slot: number, name: string): void {
    const map = this.ids[T_BUS]!;
    if (map.get(name) === slot) return;
    const p = { table: T_BUS, id: slot, name: cutUtf8(name, CAPTURE_NAME_MAX_BYTES) };
    const off = this.recorder.record(RecordType.NAMES, this.recorder.newestStatusFrame, namesBytes(p));
    if (off < 0) return;
    encodeNames(this.recorder.ring.view, off, p);
    for (const [n, s] of map) if (s === slot) map.delete(n);
    map.set(name, slot);
    this.namesWritten++;
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

  voiceStart(id: number, clip: string, busRef: number, flags: number, atFrame: number, gain: number): void {
    const clipId = this.intern(T_CLIP, clip);
    const a = this.args[5]!;
    a[0] = id;
    a[1] = clipId;
    a[2] = busRef;
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

  voiceRefused(clip: string, busRef: number, reason: ProfileRefusedReason): void {
    this.now2(EventKind.voiceRefused, REFUSED_REASON[reason], this.intern(T_CLIP, clip), busRef);
  }

  voiceQueued(clip: string, busRef: number, reason: ProfileQueuedReason): void {
    this.now2(EventKind.voiceQueued, QUEUED_REASON[reason], this.intern(T_CLIP, clip), busRef);
  }

  /**
   * args: instance, asset (`events` table); with a cause (ADR 0435, appended within format 2: readers take ≥ 2 args) also
   * its trigger, node, behaviour and system (`parameters` table, `NO_NAME` for null).
   */
  eventStart(instance: number, asset: string, cause?: ProfileCause | null): void {
    if (!cause) {
      this.now2(EventKind.eventStart, 0, instance, this.intern(T_EVENT, asset));
      return;
    }
    const a = this.args[6]!;
    a[0] = instance;
    a[1] = this.intern(T_EVENT, asset);
    a[2] = this.intern(T_PARAM, cause.trigger);
    a[3] = this.nameOrNone(T_PARAM, cause.node);
    a[4] = this.nameOrNone(T_PARAM, cause.behaviour);
    a[5] = this.nameOrNone(T_PARAM, cause.system);
    this.write(EventKind.eventStart, 0, a, 0, this.recorder.newestStatusFrame, false, 0);
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

  /** The empty name is the cleared snapshot: it carries `NO_NAME`, no NAMES record. */
  snapshot(name: string, seconds: number): void {
    this.now1(EventKind.snapshot, 0, name === "" ? NO_NAME : this.intern(T_SNAPSHOT, name), seconds);
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

  busRamp(busRef: number, lane: string, frames: number, target: number): void {
    const a = this.args[3]!;
    a[0] = busRef;
    a[1] = BUS_RAMP_LANES[lane] ?? NO_NAME;
    a[2] = frames;
    this.write(EventKind.busRamp, 0, a, target, this.recorder.newestStatusFrame, false, 0);
  }

  monitor(mask: number): void {
    this.now1(EventKind.monitor, 0, mask);
  }

  loudnessControl(control: ProfileLoudnessControl, bus: string | null): void {
    this.now1(EventKind.loudnessControl, LOUDNESS_CONTROL_REASON[control], this.nameOrNone(T_PARAM, bus));
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

  // --- ADR 0348: pick paths, loudness warnings, mix ops --------------------------------------------------------------

  /**
   * args: instance, depth, playlist (`events` table), type (`PICK_TYPES` index), choice (`NO_NAME` for none), label
   * (`parameters` table, `NO_NAME` for none), then a Blend's two heaviest entries as entry and f32 weight bits each
   * (`NO_NAME` and 0 when absent).
   */
  pick(p: ProfilePick): void {
    const a = this.args[10]!;
    a[0] = p.instance;
    a[1] = p.depth;
    a[2] = this.intern(T_EVENT, p.playlist);
    a[3] = PICK_TYPES.indexOf(p.type);
    a[4] = p.choice >= 0 ? p.choice : NO_NAME;
    a[5] = this.nameOrNone(T_PARAM, p.label);
    for (let k = 0; k < 2; k++) {
      const w = p.weights?.[k];
      this.f32[0] = w ? w[1] : 0;
      a[6 + 2 * k] = w ? w[0] : NO_NAME;
      a[7 + 2 * k] = this.f32bits[0]!;
    }
    this.write(EventKind.pick, 0, a, 0, this.recorder.newestStatusFrame, false, 0);
  }

  /** args: the bus (`parameters` table, as `loudnessControl`'s; `NO_NAME` for the output); reason 1 high, 2 low, 3 ok. */
  loudnessWarning(bus: string | null, state: ProfileLoudnessState): void {
    this.now1(EventKind.loudnessWarning, LOUDNESS_STATE[state], this.nameOrNone(T_PARAM, bus));
  }

  /** ADR 0352 §6. args: the effect type (`parameters` table), the glue's instance handle; reason 1 trap .. 5 range. */
  pluginFault(type: string, reason: ProfilePluginFault, instance: number): void {
    this.now2(EventKind.pluginFault, PLUGIN_FAULT[reason], this.intern(T_PARAM, type), instance >>> 0);
  }

  /**
   * ADR 0351 §9 (`PKG`): args: the package's name (`parameters` table, as a bus name in `loudnessWarning`), its download
   * bytes (u32, saturating), and on `loaded` and `unload` the memory it holds resident (u32, saturating; ADR 0351 §6, an
   * optional third arg added within format 2); reason 1 load start, 2 loaded, 3 failed, 4 unload.
   */
  audioPackage(name: string, event: ProfilePackageEvent, bytes: number, memoryBytes?: number): void {
    const u32 = (n: number) => Math.min(0xffffffff, Math.max(0, Math.floor(n)));
    if (memoryBytes === undefined) {
      this.now2(EventKind.audioPackage, PACKAGE_EVENT[event], this.intern(T_PARAM, name), u32(bytes));
      return;
    }
    // ADR 0351 §6 (the Profiler's memory track): a third arg, appended within format 2 (readers take ≥ 2 args).
    const a = this.args[3]!;
    a[0] = this.intern(T_PARAM, name);
    a[1] = u32(bytes);
    a[2] = u32(memoryBytes);
    this.write(EventKind.audioPackage, PACKAGE_EVENT[event], a, 0, this.recorder.newestStatusFrame, false, 0);
  }

  /**
   * A live mix op the mixer sent (ADR 0348: MIXOP is written): the op's byte form (`engine/audio/mixOpCodec.ts`), strings
   * interned in the `parameters` table, buses as `busRef` from `busRef(name)` (`NO_NAME` when it has no slot).
   */
  mixOp(op: MixOp, cls: OpClass, origin: keyof typeof MixOpOrigin, busRef: (bus: string) => number): void {
    let bytes;
    try {
      bytes = encodeMixOp(op, cls, { nameId: (name) => this.intern(T_PARAM, name), busRef });
    } catch {
      return; // an op this build's codec can't write: left out rather than misrecorded
    }
    const p = { op: bytes.op, class: OP_CLASS_CODES[cls], words: bytes.words, perfMs: this.now(), origin: MixOpOrigin[origin] };
    const off = this.recorder.record(RecordType.MIXOP, this.recorder.newestStatusFrame, mixOpBytes(p));
    if (off < 0) {
      this.eventsDropped++;
      return;
    }
    encodeMixOpRecord(this.recorder.ring.view, off, p);
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

// --- reading an EVENT back (ADR 0227) ------------------------------------------------------------------------------------

/** What every typed EVENT carries: the main-thread clock. A kind with §5.6 reasons carries its `reason` as the sink's word (null for a code this build doesn't know). */
interface CaptureEventBase {
  readonly perfMs: number;
}

/**
 * One EVENT record read back by name: the inverse of the sink's writes above, so the arg layouts live in this one module.
 * Name fields are ids in the NAMES tables (`CaptureOpenSummary.names`); `null` stands for `NO_NAME`. A bus is its slot and
 * generation (the sink's `busRef`, `gen << 8 | slot`).
 */
export type CaptureEvent = CaptureEventBase & (
  | { readonly type: "voiceStart"; readonly voice: number; readonly clip: number; readonly slot: number; readonly busGen: number; readonly flags: number; readonly atFrameLo: number; readonly gain: number }
  | { readonly type: "voiceStop"; readonly voice: number; readonly reason: ProfileStopReason | null }
  | { readonly type: "voiceSteal"; readonly voice: number; readonly thief: number; readonly reason: ProfileStealReason | null }
  | { readonly type: "voiceVirtual"; readonly voice: number; readonly reason: ProfileVirtualReason | null }
  | { readonly type: "voiceReal"; readonly voice: number; readonly reason: ProfileRealReason | null }
  | { readonly type: "voiceRefused"; readonly clip: number; readonly slot: number; readonly busGen: number; readonly reason: ProfileRefusedReason | null }
  | { readonly type: "voiceQueued"; readonly clip: number; readonly slot: number; readonly busGen: number; readonly reason: ProfileQueuedReason | null }
  /** `cause` (ADR 0435): what in the game asked, as `parameters` table ids (null for unknown); absent in older captures. */
  | { readonly type: "eventStart"; readonly instance: number; readonly asset: number; readonly cause?: CaptureEventCause }
  | { readonly type: "eventStop"; readonly instance: number }
  /** `name` in the `parameters` table; `instance` null for a global parameter. */
  | { readonly type: "parameter"; readonly name: number; readonly instance: number | null; readonly value: number }
  /** `name` null for the cleared snapshot. */
  | { readonly type: "snapshot"; readonly name: number | null; readonly seconds: number }
  /** Both ids in the `parameters` table. */
  | { readonly type: "stateChange"; readonly parameter: number; readonly label: number }
  /** Segments are ids in the `events` table; `from` null for the first segment. */
  | { readonly type: "musicTransition"; readonly instance: number; readonly from: number | null; readonly to: number }
  /** `lane` the index in `BUS_RAMP_LANES` order, null for a lane the writer didn't know. */
  | { readonly type: "busRamp"; readonly slot: number; readonly busGen: number; readonly lane: number | null; readonly frames: number; readonly target: number }
  | { readonly type: "monitor"; readonly mutes: number; readonly solos: number }
  /** `bus` a name id in the `parameters` table, null for every meter; `control` null for a reason this build doesn't know. */
  | { readonly type: "loudnessControl"; readonly control: ProfileLoudnessControl | null; readonly bus: number | null }
  | { readonly type: "ladder"; readonly step: number; readonly shed: boolean }
  | { readonly type: "masterChange"; readonly muted: boolean; readonly volume: number }
  | { readonly type: "hiddenTab"; readonly hidden: boolean }
  /**
   * ADR 0348: one playlist decision of `instance` (its `eventStart` comes first). `playlist` an id in the `events` table,
   * `label` in the `parameters` table; `choice` null for none; `weights` a Blend's two heaviest entries, heaviest first.
   */
  | { readonly type: "pick"; readonly instance: number; readonly depth: number; readonly playlist: number; readonly playlistType: ProfilePick["type"] | null; readonly choice: number | null; readonly label: number | null; readonly weights: readonly { readonly entry: number; readonly weight: number }[] }
  /** ADR 0348: a metered bus's loudness against its target; `bus` a name id in the `parameters` table, null for the output. */
  | { readonly type: "loudnessWarning"; readonly bus: number | null; readonly state: ProfileLoudnessState | null }
  /** ADR 0351 §9 (`PKG`): a package's load start, load, failure or unload; `name` an id in the `parameters` table. */
  /** `memoryBytes`: what it holds resident (its third arg, written on loaded and unload by builds since ADR 0351 A6); null when absent. */
  | { readonly type: "audioPackage"; readonly name: number; readonly event: ProfilePackageEvent | null; readonly bytes: number; readonly memoryBytes: number | null }
  /** ADR 0352 §6: `effect` is the type's name id (`parameters` table). */
  | { readonly type: "pluginFault"; readonly effect: number; readonly instance: number; readonly reason: ProfilePluginFault | null }
);

/** ADR 0435: an `eventStart`'s cause: ids in the `parameters` table, null for unknown (`ProfileCause` read back). */
export interface CaptureEventCause {
  readonly trigger: number | null;
  readonly node: number | null;
  readonly behaviour: number | null;
  readonly system: number | null;
}

/** Every EVENT type name (one per §5.6 kind). */
export type CaptureEventType = CaptureEvent["type"];

const KIND_TYPE = Object.fromEntries(Object.entries(EventKind).map(([type, kind]) => [kind, type])) as Record<number, CaptureEventType>;
/** The fewest args each kind's layout has (a writer may append more; a record with fewer is not read). */
const MIN_ARGS: Readonly<Record<CaptureEventType, number>> = {
  voiceStart: 5, voiceStop: 1, voiceSteal: 2, voiceVirtual: 1, voiceReal: 1, voiceRefused: 2, voiceQueued: 2, eventStart: 2, eventStop: 1,
  parameter: 3, snapshot: 1, stateChange: 2, musicTransition: 3, busRamp: 3, monitor: 1, loudnessControl: 0, ladder: 1, masterChange: 1, hiddenTab: 1,
  pick: 10, loudnessWarning: 1, audioPackage: 2, pluginFault: 2,
};
const orNull = (id: number): number | null => (id === NO_NAME ? null : id);
const readF32 = new Float32Array(1);
const readF32Bits = new Uint32Array(readF32.buffer);

/**
 * A decoded EVENT payload (`format.ts`' `decodeEvent`) by name. Null for a record too short for its kind's layout: the open
 * accepts any arg count, so a malformed or foreign record is skipped rather than read as zeros.
 */
export function readCaptureEvent(p: EventPayload): CaptureEvent | null {
  const type = KIND_TYPE[p.kind];
  if (type === undefined || p.args.length < MIN_ARGS[type]) return null;
  const a = p.args;
  const base = { perfMs: p.perfMs };
  const r = p.reason;
  const f32 = p.f32 ?? 0;
  switch (type) {
    case "voiceStart": return { ...base, type, voice: a[0]!, clip: a[1]!, slot: a[2]! & 0xff, busGen: a[2]! >>> 8, flags: a[3]!, atFrameLo: a[4]!, gain: f32 };
    case "voiceStop": return { ...base, type, voice: a[0]!, reason: stopReason(r) };
    case "voiceVirtual": return { ...base, type, voice: a[0]!, reason: virtualReason(r) };
    case "voiceReal": return { ...base, type, voice: a[0]!, reason: realReason(r) };
    case "voiceSteal": return { ...base, type, voice: a[0]!, thief: a[1]!, reason: stealReason(r) };
    case "voiceRefused": return { ...base, type, clip: a[0]!, slot: a[1]! & 0xff, busGen: a[1]! >>> 8, reason: refusedReason(r) };
    case "voiceQueued": return { ...base, type, clip: a[0]!, slot: a[1]! & 0xff, busGen: a[1]! >>> 8, reason: queuedReason(r) };
    case "eventStart":
      if (a.length < 6) return { ...base, type, instance: a[0]!, asset: a[1]! };
      return { ...base, type, instance: a[0]!, asset: a[1]!, cause: { trigger: orNull(a[2]!), node: orNull(a[3]!), behaviour: orNull(a[4]!), system: orNull(a[5]!) } };
    case "eventStop": return { ...base, type, instance: a[0]! };
    case "parameter":
      readF32Bits[0] = a[2]!;
      return { ...base, type, name: a[0]!, instance: orNull(a[1]!), value: readF32[0]! };
    case "snapshot": return { ...base, type, name: orNull(a[0]!), seconds: f32 };
    case "stateChange": return { ...base, type, parameter: a[0]!, label: a[1]! };
    case "musicTransition": return { ...base, type, instance: a[0]!, from: orNull(a[1]!), to: a[2]! };
    case "busRamp": return { ...base, type, slot: a[0]! & 0xff, busGen: a[0]! >>> 8, lane: orNull(a[1]!), frames: a[2]!, target: f32 };
    case "monitor": return { ...base, type, mutes: a[0]! & 0xffff, solos: a[0]! >>> 16 };
    case "loudnessControl": return { ...base, type, control: loudnessControlOf(r), bus: orNull(a[0] ?? NO_NAME) };
    case "ladder": return { ...base, type, step: a[0]!, shed: r === LADDER_REASON.shed };
    case "masterChange": return { ...base, type, muted: a[0]! !== 0, volume: f32 };
    case "hiddenTab": return { ...base, type, hidden: a[0]! !== 0 };
    case "pick": {
      const weights: { entry: number; weight: number }[] = [];
      for (let k = 0; k < 2; k++) {
        if (a[6 + 2 * k] === NO_NAME) continue;
        readF32Bits[0] = a[7 + 2 * k]!;
        weights.push({ entry: a[6 + 2 * k]!, weight: readF32[0]! });
      }
      return { ...base, type, instance: a[0]!, depth: a[1]!, playlist: a[2]!, playlistType: PICK_TYPES[a[3]!] ?? null, choice: orNull(a[4]!), label: orNull(a[5]!), weights };
    }
    case "loudnessWarning": return { ...base, type, bus: orNull(a[0]!), state: LOUDNESS_STATE_OF[r] ?? null };
    case "audioPackage": return { ...base, type, name: a[0]!, event: PACKAGE_EVENT_OF[r] ?? null, bytes: a[1]! >>> 0, memoryBytes: a.length > 2 ? a[2]! >>> 0 : null };
    case "pluginFault": return { ...base, type, effect: a[0]!, instance: a[1]!, reason: PLUGIN_FAULT_OF[r] ?? null };
  }
}
