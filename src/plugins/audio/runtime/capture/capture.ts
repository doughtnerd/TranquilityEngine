// ADR 0171 amended by 0172 (M5, contract K0, H4; task Rc4; api-and-models §1.2, architecture §2.1, §3.1, §3.7):
// `Audio.capture`, a take over the shared recorder ring. The recorder (`capture/recorder.ts`) is a lazy chunk: this file is
// the only one that may load it, and only through a dynamic `import()` on the first `start()`, so a game that never captures
// loads no recorder. Nothing imports `recorder.ts` statically (a test checks every source file). The same goes for the other
// parts of the chunk (`events.ts`, `save.ts`, and through them `format.ts`): this file imports them by `import()` or as types
// only, so none of them is in a game that never captures.
//
// **Owners.** One ring serves every owner (record change 33): a **take** (`Audio.capture.start` .. `stop`, at most one) and
// any number of **panel** holds (`captureLiveHost.join()`, the Profiler panel open in Play). The first owner loads the
// chunk, makes the recorder and writes the first EPOCH and KEYFRAME; a later owner's join writes a marker. When the last
// owner lets go the ring is **Held** (the tap and the event sink are removed, the ring stays so `save()` after `stop()`
// works) if a take exists, and freed if none does (a panel that closes with no take leaves nothing). A `start()` from Held
// begins a new take after a GAP `held` (R16); `save()` writes the **latest** take only. **Released** (`releaseCapture()`, the
// Engine is disposed) frees the ring and the take with it. **Play stops** (`capturePlayStopped()`, called by the audio World
// service when the last Runtime World goes): the owners end, the ring is freed, except that a take (running or Held) is Held
// once so a `save()` after Stop still works; it is freed at the next Play stop (or by `releaseCapture()`).
//
// **Keyframes (G7b).** The recorder's keyframe source is the backend's own (`AudioCaptureSource.keyframe`, ADR 0179), wired to the event sink's
// name interning, so a keyframe and an EVENT name a clip by the same id. A backend with no STATUS (the Babylon fallback,
// `mainSideOnly`) has no block to drive the recorder's clock, so a **frame pump** reads the backend's audio clock in frames and
// calls `Recorder.advanceFrame`: events are stamped on it and the keyframe cadence runs on it, the tap's rule on the audio
// clock. The pump polls (`FRAME_PUMP_MS`) but the frames it reports are the audio clock's: nothing is timed by the poll.
//
// **A take is a (start, end) pair.** `start()` sets the take's start to the open segment's keyframe (the nearest at or before
// now). While another owner keeps the ring recording, `stop()` copies the take's span so the file ends where the take did;
// with no other owner the ring stops growing and is read in place.
import { onAudioSessionReleased } from "../audioSession";
import type { AudioBackend, AudioRecorderDebug } from "../backend";
import { audioBackend, onMixOpSent } from "../backend";
import { mixer } from "../../../../engine/audio/mixer";
import { loudnessTarget } from "../mix/loudnessHub";
import type { EpochContext } from "./events";
import type { CaptureHeaderInit, CaptureMetaInit, CaptureReplayOf, NameTable } from "./format";
import { NO_NAME } from "./keyframeLayout";
import { KeyframeRows } from "../audioRows";
import type { RingSpan } from "./ring";
import type { SaveTake } from "./save";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import type { MixOp, OpClass } from "../../../../engine/audio/mixOps";
import { currentMixOpOrigin } from "./mixOpOrigin";

/**
 * ADR 0348: what a take reads of the profile taps beside the capture's records: every effective parameter change (global
 * or instance, events and playlists, a label as its index), the one place they all pass.
 */
export interface CaptureTee {
  parameter(name: string, value: number, instance: number | null): void;
}

/** ADR 0348: a take's hold on the ring (`captureTakeRing`). */
export interface CaptureTakeRing {
  /** The next record's seq (taken from the ring's counter, so a take's requests merge with the ring's records by seq), its epoch and the frame "now". Null while the ring doesn't record. */
  stamp(): { seq: number; epoch: number; frame: number } | null;
  /** The ring's capacity (the profile's share of the take cap). */
  readonly ringBytes: number;
  /** A MARKER in the profile too (`Audio.take.mark`). */
  marker(text: string): void;
  /** The ring's records from the take's start (a copy), the header facts and META as the take began: what the take's file is built on. */
  freeze(): SaveTake;
  /** End the take's hold (the last owner's release holds or frees the ring, as a panel's does). */
  release(): void;
}

/** `Audio.capture` (§1.2). */
export interface AudioCapture {
  /** "idle" -> "loading" (recorder chunk fetching) -> "recording" -> "stopped" (a take exists to save). */
  readonly state: AudioCaptureState;
  /** The ring's content, seconds; 0 while idle. */
  readonly seconds: number;
  readonly bytes: number;
  /** True when the ring wrapped over the take's start: the file begins at a later keyframe and is marked truncated. */
  readonly truncated: boolean;
  /** Load the recorder (a lazy chunk) and begin a take. Resolves once recording; rejects with a message if the chunk or the core is unavailable. A second call while recording joins it, writes a marker and resolves at once. */
  start(): Promise<void>;
  /** End the caller's hold. The ring keeps recording while the Profiler panel is open (one ring, shared). */
  stop(): void;
  /** A timeline marker at the current frame, cut to `CAPTURE_MARK_BYTES` (120) UTF-8 bytes. No-op while no ring runs. */
  mark(text: string): void;
  /** Compress and save the take; resolves with the web file name or the app-data path. Rejects with "nothing recorded: call Audio.capture.start() first" when there is no take. */
  save(name?: string): Promise<string>;
}

/** `AudioCapture.state`. */
export type AudioCaptureState = "idle" | "loading" | "recording" | "stopped";

/** The empty-save rejection (§1.2). */
const NOTHING_RECORDED = "nothing recorded: call Audio.capture.start() first";

/** What the recorder chunk exports to this file (a type only: the module is reached by `import()` alone). */
type RecorderModule = typeof import("./recorder");
type Recorder = ReturnType<RecorderModule["createRecorder"]>;
type EventSink = ReturnType<(typeof import("./events"))["createEventSink"]>;

/** How often the Babylon fallback's frame pump reads the audio clock, ms (the clock's frames are what is recorded, not this period). */
const FRAME_PUMP_MS = 100;

/** Calls `tick` every `FRAME_PUMP_MS` until the returned stop runs. */
function framePump(tick: () => void): () => void {
  const id = setInterval(tick, FRAME_PUMP_MS);
  (id as { unref?: () => void }).unref?.();
  return () => clearInterval(id);
}

/** The project a capture's META names (§5.2, owner decision 6). The engine has no project record at run time, so the page title stands in until a shell says better. */
let projectInfo: () => { name: string; version: string } = () => ({ name: typeof document !== "undefined" ? document.title : "", version: "" });

/** @internal The project a capture's META names now (ADR 0410: the build audio index names it too). */
export function captureProject(): { name: string; version: string } {
  return projectInfo();
}

/** @internal Where a shell (the player, the editor) says which project a capture belongs to. */
export function setCaptureProject(info: () => { name: string; version: string }): void {
  projectInfo = info;
}

/** ADR 0348: the take the Studio is replaying while it records itself, named in the META of captures started meanwhile. */
let replayOf: CaptureReplayOf | null = null;

/**
 * @internal ADR 0348 "Profiling a take as it plays": the Studio says which take it replays (its path and `audio.json` hash)
 * before it starts a capture of its own runtime, and null when it stops; a capture started meanwhile names it in META
 * `replayOf`, so the Profiler shows which take the replay capture came from.
 */
export function setCaptureReplayOf(take: CaptureReplayOf | null): void {
  replayOf = take ? { path: String(take.path), audioHash: String(take.audioHash) } : null;
}

/** The seam `editor/mix/liveFollow.ts` calls (`LiveHost` and `LiveRecording`, restated: the runtime never imports the editor). */
export interface CaptureLiveRecording {
  /** The ring's 96 B header plus raw META with no records (`assembleCapture(header, meta, [])`). */
  head(): Uint8Array;
  /** `Recorder.startLive`: posts `open`, the take's sealed segments, then each segment as it seals. */
  startLive(opts: { post(request: import("./format").CaptureWorkerRequest, transfer: Transferable[]): void; head: Uint8Array; id: number }): void;
  stopLive(): void;
  /** A segment the ring evicted before it was posted ended the feed. */
  readonly liveLost: boolean;
  /** End this owner's hold; the last owner's release holds the ring (a take exists) or frees it (none does). */
  release(): void;
}

export interface CaptureLiveHost {
  join(): Promise<CaptureLiveRecording>;
}

interface FrozenTake {
  span: RingSpan;
  truncated: boolean;
  truncatedFromSeq: number;
  seconds: number;
  bytes: number;
  meta: CaptureMetaInit;
  startDateMs: number;
}

/** `NAME_TABLES` of `format.ts`, in its order (index = the table's number in a NAMES record and in `EventSink.interned`). */
const TABLES: readonly NameTable[] = ["clips", "buses", "events", "parameters", "snapshots", "targets"];

/** The `[id, name]` pairs of a META names table given as a `Map` or an object. */
function namesOf(table: CaptureMetaInit["names"][NameTable]): [number, string][] {
  if (!table) return [];
  return [...(table instanceof Map ? table.entries() : Object.entries(table))].map(([id, name]) => [Number(id), name]);
}

/** ADR 0260: each named slot of the backend's slot table (`Audio.debug().mix.slots`) through `EventSink.busName`, which writes a NAMES record only for a name the slot doesn't hold yet. */
function writeBusNames(sink: EventSink, backend: AudioBackend): void {
  for (const s of backend.debug().mix?.slots ?? []) if (s.name !== null && s.state !== "free") sink.busName(s.slot, s.name);
}

const finiteOr = (x: unknown, fallback: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The one `Audio.capture` object. */
class Capture implements AudioCapture {
  private rec: Recorder | null = null;
  private sink: EventSink | null = null;
  private backend: AudioBackend | null = null;
  private ringState: "none" | "recording" | "held" = "none";
  private creating: Promise<void> | null = null;
  private startFlight: Promise<void> | null = null;
  /** Bumped by `stop` and a release: a start that finds a different value was abandoned. */
  private startToken = 0;
  /** Rings being made (the chunk loading): `state` reads "loading" while a start waits for one. */
  private loading = 0;
  private takeActive = false;
  private hasTake = false;
  private panels = 0;
  /** Bumped when the ring is freed: a panel token from an earlier ring does nothing. */
  private ringGen = 0;
  private frozen: FrozenTake | null = null;
  private heldSince = 0;
  private head: Uint8Array | null = null;
  private headInit: CaptureHeaderInit | null = null;
  private takeMeta: CaptureMetaInit | null = null;
  private takeDate = 0;
  private mainSideOnly = false;
  /** Stops the Babylon frame pump; null while none runs. */
  private stopPump: (() => void) | null = null;
  /** A take was kept through a Play stop (Held for the save); the next Play stop frees it. */
  private keptAcrossStop = false;
  /** The frame the next EPOCH names (a start, or a core made while Held); null: 0, a rebuilt core's first frame. */
  private epochFrame: number | null = null;
  /** ADR 0348: the take's reader of the taps (a tee around the event sink while set). */
  private tee: CaptureTee | null = null;

  // --- the public surface ---------------------------------------------------------------------------------------------

  get state(): AudioCaptureState {
    if (this.takeActive) return "recording";
    if (this.loading > 0 && this.startFlight) return "loading";
    return this.hasTake ? "stopped" : "idle";
  }

  get seconds(): number {
    if (!this.hasTake) return 0;
    return this.frozen ? this.frozen.seconds : (this.rec?.seconds ?? 0);
  }

  get bytes(): number {
    if (!this.hasTake) return 0;
    return this.frozen ? this.frozen.bytes : (this.rec?.bytes ?? 0);
  }

  get truncated(): boolean {
    if (!this.hasTake) return false;
    return this.frozen ? this.frozen.truncated : (this.rec?.truncated ?? false);
  }

  start(): Promise<void> {
    if (this.takeActive) {
      this.markJoin("Audio.capture.start");
      return Promise.resolve();
    }
    if (this.startFlight) return this.startFlight.then(() => this.markJoin("Audio.capture.start"));
    const flight = this.doStart().finally(() => {
      if (this.startFlight === flight) this.startFlight = null;
    });
    this.startFlight = flight;
    return flight;
  }

  stop(): void {
    if (!this.takeActive) {
      if (this.startFlight) {
        this.startToken++; // a start still loading is abandoned, and the next start begins its own
        this.startFlight = null;
      }
      return;
    }
    this.takeActive = false;
    if (this.panels > 0) this.frozen = this.freeze(); // the ring goes on for the panel; the take ends here
    else this.hold();
  }

  mark(text: string): void {
    if (this.sink && this.ringState === "recording") this.sink.marker(String(text));
  }

  save(name?: string): Promise<string> {
    return this.withTake((s, take) => s.saveCapture(take, name));
  }

  /** The take as a `.sporesample` file's bytes, as `save` would write them (the Studio's save into its project). */
  fileBytes(): Promise<Uint8Array> {
    return this.withTake((s, take) => s.captureFileBytes(take));
  }

  /** `use` the save chunk on the take as of this call, or reject as `save` does when there is none. */
  private withTake<T>(use: (save: typeof import("./save"), take: SaveTake) => Promise<T>): Promise<T> {
    if (!this.hasTake || !(this.frozen || this.rec)) return Promise.reject(new Error(NOTHING_RECORDED));
    let take: SaveTake;
    try {
      take = this.snapshot(); // the span as of this call: a ring that goes on recording changes nothing
    } catch (e) {
      return Promise.reject(new Error(messageOf(e)));
    }
    return import("./save").then((s) => use(s, take));
  }


  // --- the seam and the debug view ------------------------------------------------------------------------------------

  /** The owners now: a take, and the panel holds (a take is distinguishable from a panel's hold). */
  owners(): { take: boolean; panels: number } {
    return { take: this.takeActive, panels: this.panels };
  }

  /** `Audio.debug().recorder` (§1.3): null while no ring exists. */
  debug(): AudioRecorderDebug | null {
    const rec = this.rec;
    if (!rec || this.ringState === "none") return null;
    const d = rec.debug();
    return { state: this.ringState === "held" ? "held" : "recording", owners: (this.takeActive ? 1 : 0) + this.panels, bytes: d.bytes, segments: d.segments, evicted: d.evicted, truncated: d.truncated };
  }

  join(): Promise<CaptureLiveRecording> {
    return this.doJoin();
  }

  /** Frees the ring and the take (Play stops, the Engine is disposed); owners' tokens stop working. */
  release(): void {
    this.startToken++;
    this.stopFramePump();
    this.keptAcrossStop = false;
    const rec = this.rec;
    if (rec) {
      try {
        rec.stopLive();
        rec.detach();
        this.backend?.capture?.setProfileSink(null);
      } catch {
        // The backend may already be disposed.
      }
    }
    this.rec = null;
    this.sink = null;
    this.backend = null;
    this.head = null;
    this.headInit = null;
    this.takeMeta = null;
    this.frozen = null;
    this.ringState = "none";
    this.takeActive = false;
    this.hasTake = false;
    this.panels = 0;
    this.ringGen++;
  }

  /**
   * Play stops (architecture §2.1): the owners end (a running take stops, panel holds are over), then the ring is freed,
   * unless a take exists that hasn't yet outlived a Play stop: that one is Held, so a `save()` after Stop still works.
   */
  playStopped(): void {
    for (const fn of playStopHooks) fn(); // ADR 0348: a running take stops and copies its span before the ring goes
    const rec = this.rec;
    if (!rec) {
      this.startToken++; // a start still loading is abandoned
      return;
    }
    rec.stopLive();
    this.panels = 0;
    this.ringGen++; // the panel's tokens from this ring do nothing from here
    this.takeActive = false;
    if (this.hasTake && !this.keptAcrossStop) {
      this.keptAcrossStop = true;
      this.hold();
      return;
    }
    this.release();
  }

  // --- start ----------------------------------------------------------------------------------------------------------

  private async doStart(): Promise<void> {
    const token = ++this.startToken;
    const loads = this.rec === null;
    if (loads) this.loading++;
    try {
      await this.ensureRing();
    } finally {
      if (loads) this.loading--;
    }
    if (token !== this.startToken) {
      this.settle(); // stopped while the chunk loaded: no take, so a ring nobody owns goes
      return;
    }
    const rec = this.rec!;
    if (this.ringState === "held") this.resume(false);
    else if (this.owners().panels > 0) this.markJoin("Audio.capture.start");
    rec.takeStart = rec.ring.openSegment; // the take starts at the nearest keyframe at or before now
    this.frozen = null;
    this.takeActive = true;
    this.hasTake = true;
    this.keptAcrossStop = false;
    this.beginTakeFacts();
  }

  /** The recorder, made once: the chunk, the ring, the first EPOCH and KEYFRAME, the tap and the sink. */
  private ensureRing(): Promise<void> {
    if (this.rec) return Promise.resolve();
    return (this.creating ??= this.createRing().finally(() => {
      this.creating = null;
    }));
  }

  private async createRing(): Promise<void> {
    const backend = this.target();
    // The only `import()` of `recorder.ts`.
    const [mod, events, save] = await Promise.all([import("./recorder"), import("./events"), import("./save")]);
    const rec = mod.createRecorder({});
    const sink = events.createEventSink(rec, { epochContext: () => this.epochContext(backend) });
    this.wireKeyframes(rec, sink, backend);
    const meta = this.buildMeta(backend, rec.ring.capacity);
    for (const table of TABLES) for (const [id, name] of namesOf(meta.names[table])) sink.seed(table, id, name);
    this.epochFrame = this.frameOf(backend);
    try {
      sink.epoch("start"); // begins the recording: EPOCH start, then a KEYFRAME
    } finally {
      this.epochFrame = null;
    }
    // ADR 0328: the header names the running core's ABI (its first STATUS), not a copy of the number.
    const abi = backend.debug().core.abiVersion;
    const init: CaptureHeaderInit = { sampleRate: rec.sampleRate, preset: this.presetOf(rec.ring.capacity), startDateMs: Date.now(), ringBytes: rec.ring.capacity, firstFrame: 0, mainSideOnly: this.mainSideOnly, ...(typeof abi === "number" && abi !== 0 ? { abiVersion: abi } : {}) };
    this.head = save.liveHead(init, meta);
    this.headInit = init;
    this.takeMeta = meta;
    this.takeDate = init.startDateMs;
    if (!this.mainSideOnly) rec.attach(backend.capture!);
    backend.capture!.setProfileSink(this.profileSinkOf(sink));
    this.rec = rec;
    this.sink = sink;
    this.backend = backend;
    this.ringState = "recording";
    this.startFramePump();
  }

  /**
   * The recorder's keyframe source: the backend's own with the event and music rows composed above the seam (ADR 0249),
   * interning its names through the sink (a backend without one leaves the recorder's empty keyframes).
   */
  private wireKeyframes(rec: Recorder, sink: EventSink, backend: AudioBackend): void {
    const source = backend.capture;
    if (!source) return;
    const nameId = (table: "clips" | "snapshots" | "events", name: string): number => sink.name(table, name);
    const rows = new KeyframeRows(source, backend);
    rec.setKeyframeSource(() => {
      writeBusNames(sink, backend); // a slot named since the last keyframe (a deferred add that found its slot) is named before the rows that use it
      return rows.read(nameId, NO_NAME);
    });
  }

  /** A backend with no STATUS (`mainSideOnly`) is clocked by its audio clock: poll it and report the frames the clock has reached. */
  private startFramePump(): void {
    if (!this.mainSideOnly || this.stopPump) return;
    this.stopPump = framePump(() => {
      const rec = this.rec;
      const backend = this.backend;
      if (!rec || !backend || this.ringState !== "recording") return;
      const frame = Math.floor(finiteOr(backend.time, 0) * rec.sampleRate);
      rec.advanceFrame(frame);
    });
  }

  private stopFramePump(): void {
    this.stopPump?.();
    this.stopPump = null;
  }

  /** The backend a ring can record from; rejects with a message when there is none (the core still loading, or a device without it). */
  private target(): AudioBackend {
    const backend = audioBackend();
    if (backend.capture) {
      // ADR 0179: what a capture records is the live mix's `capture` flag: everything (STATUS through the recorder's tap), or
      // main-side events and keyframes only (the Babylon fallback, which has no STATUS, §9).
      this.mainSideOnly = backend.mix?.mixCaps.capture === "mainSideOnly";
      return backend;
    }
    throw new Error("audio capture isn't available yet: the audio core hasn't started (play a sound or click the page first, then call Audio.capture.start() again)");
  }

  /** A start from Held (or a panel's join from Held): a GAP `held`, a fresh keyframe, the tap and sink back on. */
  private resume(keepOldTake: boolean): void {
    const rec = this.rec!;
    const sink = this.sink!;
    if (keepOldTake && this.hasTake && !this.frozen) this.frozen = this.freeze(); // the ring grows again: the old take ends here
    const backend = this.target();
    const frame = this.frameOf(backend);
    if (backend !== this.backend || frame < rec.newestStatusFrame) {
      // A core was made while nothing recorded: its frames restart, so the file needs the epoch the recovery couldn't write.
      this.epochFrame = frame;
      try {
        sink.epoch("device");
      } finally {
        this.epochFrame = null;
      }
    }
    rec.newTake(frame, this.heldSince);
    if (backend !== this.backend && this.backend) this.backend.capture?.setProfileSink(null);
    if (backend !== this.backend) this.wireKeyframes(rec, sink, backend);
    this.backend = backend;
    if (!this.mainSideOnly) rec.attach(backend.capture!);
    backend.capture!.setProfileSink(this.profileSinkOf(sink));
    this.ringState = "recording";
    this.startFramePump();
  }

  /** The facts of the new take: META as the project stands now and the start date. */
  private beginTakeFacts(): void {
    const backend = this.backend;
    const rec = this.rec;
    if (!backend || !rec) return;
    this.takeMeta = this.buildMeta(backend, rec.ring.capacity);
    this.takeDate = Date.now();
  }

  // --- the panel's hold -----------------------------------------------------------------------------------------------

  private async doJoin(): Promise<CaptureLiveRecording> {
    while (!this.rec) await this.ensureRing(); // a start abandoned while the chunk loaded may have freed what this join awaited
    if (this.ringState === "held") this.resume(true);
    else if (this.takeActive || this.panels > 0) this.markJoin("Profiler panel opened");
    this.panels++;
    const rec = this.rec!;
    const gen = this.ringGen;
    const head = this.head!;
    let done = false;
    const live = (): boolean => !done && gen === this.ringGen;
    return {
      head: () => head,
      startLive: (opts) => {
        if (live()) rec.startLive(opts);
      },
      stopLive: () => {
        if (live()) rec.stopLive();
      },
      get liveLost() {
        return rec.liveLost;
      },
      release: () => {
        if (!live()) return;
        done = true;
        this.panels--;
        rec.stopLive();
        this.settle();
      },
    };
  }

  // --- ADR 0348: a take's hold --------------------------------------------------------------------------------------

  /** A take joins the ring as an owner (a panel's kind of hold), with `tee` reading the taps while it holds. */
  async takeRing(tee: CaptureTee): Promise<CaptureTakeRing> {
    while (!this.rec) await this.ensureRing();
    if (this.ringState === "held") this.resume(true);
    else if (this.takeActive || this.panels > 0) this.markJoin("Take started");
    this.panels++;
    const rec = this.rec!;
    const gen = this.ringGen;
    const startSegment = rec.ring.openSegment;
    const meta = this.backend ? this.buildMeta(this.backend, rec.ring.capacity) : this.takeMeta!;
    const startDateMs = Date.now();
    const headInit = this.headInit!;
    const mainSideOnly = this.mainSideOnly;
    this.setTee(tee);
    let done = false;
    const live = (): boolean => !done && gen === this.ringGen;
    return {
      ringBytes: rec.ring.capacity,
      stamp: () => (live() && this.ringState === "recording" && rec.epochNumber >= 0 ? { seq: rec.ring.seq++, epoch: rec.epochNumber, frame: rec.newestStatusFrame } : null),
      marker: (text) => {
        if (live() && this.sink && this.ringState === "recording") this.sink.marker(String(text));
      },
      freeze: () => {
        const ring = rec.ring;
        const from = Math.max(startSegment, ring.firstSegment);
        const truncated = ring.firstSegment > startSegment;
        return {
          header: { ...headInit, startDateMs, truncated, mainSideOnly },
          meta: this.withInterned(meta),
          span: ring.copyRecords(from),
          truncatedFromSeq: truncated ? ring.segFirstSeq[ring.rowOf(ring.firstSegment)]! : 0,
        };
      },
      release: () => {
        if (done) return;
        done = true;
        if (this.tee === tee) this.setTee(null);
        if (gen !== this.ringGen) return;
        this.panels--;
        this.settle();
      },
    };
  }

  private setTee(tee: CaptureTee | null): void {
    this.tee = tee;
    if (this.sink && this.backend?.capture && this.ringState === "recording") this.backend.capture.setProfileSink(this.profileSinkOf(this.sink));
  }

  /** The sink the backend's taps reach: the event sink, or a tee that also hands parameter changes to the take. */
  private profileSinkOf(sink: EventSink): ProfileSink {
    const tee = this.tee;
    if (!tee) return sink;
    const out = {} as Record<string, unknown>;
    const src = sink as unknown as Record<string, unknown>;
    for (const k of Object.keys(NULL_PROFILE_SINK)) out[k] = (src[k] as (...a: unknown[]) => void).bind(sink);
    for (const k of ["pick", "loudnessWarning"]) if (typeof src[k] === "function") out[k] = (src[k] as (...a: unknown[]) => void).bind(sink);
    out.parameter = (name: string, value: number, instance: number | null): void => {
      sink.parameter(name, value, instance);
      tee.parameter(name, value, instance);
    };
    return out as unknown as ProfileSink;
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  /** An owner writes a marker when it joins a ring that other owners already use (architecture §4.2). */
  private markJoin(text: string): void {
    this.mark(text);
  }

  /** The last owner let go: hold the ring if a take exists to save, free it if none does. */
  private settle(): void {
    if (this.takeActive || this.panels > 0 || !this.rec) return;
    this.hold();
  }

  private hold(): void {
    const rec = this.rec;
    if (!rec || this.ringState === "held") return;
    rec.stopLive();
    rec.detach();
    this.stopFramePump();
    this.backend?.capture?.setProfileSink(null);
    this.ringState = "held";
    this.heldSince = performance.now();
    if (!this.hasTake) this.release();
  }

  /** Copies the take's span now (the ring goes on recording, or the save is asked for while it does). */
  private freeze(): FrozenTake {
    const rec = this.rec!;
    return {
      span: rec.takeSpan(), truncated: rec.truncated, truncatedFromSeq: rec.truncatedFromSeq, seconds: rec.seconds, bytes: rec.bytes,
      meta: this.takeMeta!, startDateMs: this.takeDate,
    };
  }

  private snapshot(): SaveTake {
    const f = this.frozen ?? this.freeze();
    const init = this.headInit!;
    return {
      header: { ...init, startDateMs: f.startDateMs, truncated: f.truncated, mainSideOnly: this.mainSideOnly },
      meta: this.withInterned(f.meta),
      span: f.span,
      truncatedFromSeq: f.truncatedFromSeq,
    };
  }

  /**
   * META with the names the event sink interned since the ring began, so a truncated file (whose NAMES records were evicted)
   * still names them. META's own names win: a bus slot is named as it was at the take's start, and a later name of that
   * slot is the NAMES record the file carries from its instant (ADR 0260).
   */
  private withInterned(meta: CaptureMetaInit): CaptureMetaInit {
    const sink = this.sink;
    if (!sink) return meta;
    const names: CaptureMetaInit["names"] = { ...meta.names };
    TABLES.forEach((table, t) => {
      const merged: Record<number, string> = {};
      for (const [name, id] of sink.interned[t]!) merged[id] = name;
      for (const [id, name] of namesOf(meta.names[table])) merged[id] = name;
      names[table] = merged;
    });
    return { ...meta, names };
  }

  /**
   * ADR 0348: the live mix sent an op: a MIXOP record, with the origin its caller named (`withMixOpOrigin`: the op log's
   * undo and redo, Compare), else `editor`.
   */
  mixOpSent(op: MixOp, cls: OpClass): void {
    const sink = this.sink;
    const backend = this.backend;
    if (!sink || !backend || this.ringState !== "recording") return;
    sink.mixOp(op, cls, currentMixOpOrigin(), (bus) => {
      for (const s of backend.debug().mix?.slots ?? []) if (s.name === bus && s.state !== "free") return s.slot;
      return NO_NAME;
    });
  }

  /** ADR 0260: the live mix sent an op (a bus added, removed or renamed among them): name the slots it changed now. */
  busNamesChanged(): void {
    if (this.sink && this.backend && this.ringState === "recording") writeBusNames(this.sink, this.backend);
  }

  private frameOf(backend: AudioBackend): number {
    return Math.max(0, finiteOr(backend.debug().core.currentFrame, 0));
  }

  private presetOf(capacity: number): number {
    const MiB = 1024 * 1024;
    return capacity <= 4 * MiB ? 0 : capacity <= 16 * MiB ? 1 : 2;
  }

  /** The context an EPOCH names: the core's rate, its latencies in frames, and where the epoch's frame 0 sits on the heard clock (§5.3, §5.4). */
  private epochContext(backend: AudioBackend): EpochContext & { frame: number } {
    const d = backend.debug();
    const rate = finiteOr(d.sampleRate, 48_000);
    const frame = this.epochFrame ?? 0;
    const lat = backend.clock?.latency();
    const sec = (x: unknown): number => Math.max(0, finiteOr(x, 0));
    return {
      sampleRate: rate,
      limiterLatencyFrames: Math.round(sec(lat?.limiter) * rate),
      outputLatencyFrames: Math.round((sec(lat?.base) + sec(lat?.output)) * rate),
      timeOffset: finiteOr(d.time, 0) - frame / rate,
      frame,
    };
  }

  /**
   * META (§5.2): the project, the engine, the device, the mix as it stands (the mixer's settings: `audio.json`'s runtime
   * view since ADR 0344), the target in force and the names known now.
   */
  private buildMeta(backend: AudioBackend, ringBytes: number): CaptureMetaInit {
    const d = backend.debug();
    const settings = mixer.audioSettings;
    let audio: unknown = {};
    try {
      audio = JSON.parse(JSON.stringify(settings));
    } catch {
      // Data only: an unserialisable section is left out.
    }
    const targets = settings.loudnessTargets ?? [];
    const inForce = loudnessTarget();
    const buses: Record<number, string> = {};
    if (d.mix?.slots?.length) {
      for (const s of d.mix.slots) if (s.name !== null && s.state !== "free") buses[s.slot] = s.name;
    } else {
      d.buses.forEach((b, i) => (buses[i] = b.name));
    }
    const nav = (globalThis as { navigator?: { userAgent?: string; deviceMemory?: number } }).navigator;
    const targetNames: Record<number, string> = {};
    targets.forEach((t, i) => (targetNames[i] = t.name));
    return {
      project: projectInfo(),
      engine: "myco",
      device: {
        preset: this.presetOf(ringBytes), sampleRate: finiteOr(d.sampleRate, 48_000),
        ...(typeof nav?.deviceMemory === "number" ? { deviceMemory: nav.deviceMemory } : {}), userAgent: nav?.userAgent ?? "",
      },
      audio,
      target: targets.find((t) => t.name === inForce) ?? null,
      names: { buses, targets: targetNames },
      ...(replayOf ? { replayOf: { ...replayOf } } : {}),
    };
  }
}

const playStopHooks: (() => void)[] = [];

/** @internal ADR 0348: `fn` runs when Play stops, before the ring is freed (`take.ts` stops a running take there). */
export function onCapturePlayStopped(fn: () => void): void {
  playStopHooks.push(fn);
}

const capture = new Capture();

/**
 * ADR 0260: a bus added, removed or renamed while recording is named in the capture from that instant. ADR 0348: the op
 * itself is written as a MIXOP record.
 */
onMixOpSent((op, cls) => {
  capture.busNamesChanged();
  capture.mixOpSent(op, cls);
});

/** `Audio.capture`: only the eight public members; the owners, the seam and the debug view stay behind this file's own exports. */
export const audioCapture: AudioCapture = {
  get state() {
    return capture.state;
  },
  get seconds() {
    return capture.seconds;
  },
  get bytes() {
    return capture.bytes;
  },
  get truncated() {
    return capture.truncated;
  },
  start: () => capture.start(),
  stop: () => capture.stop(),
  mark: (text) => capture.mark(text),
  save: (name) => capture.save(name),
};

/** @internal The Profiler panel's way onto the ring (Pf7's `LiveHost`): `join()` is an owner distinct from a take. Not part of `Audio.capture`'s public type. */
export const captureLiveHost: CaptureLiveHost = { join: () => capture.join() };

/**
 * @internal ADR 0348 (decision log D13): the latest take as a `.sporesample` file's bytes, compressed as `Audio.capture.save()`
 * writes them, for the Audio Studio to write into its project's `recordings/` on every platform (`save()` downloads in a
 * browser). Rejects as `save()` does when nothing was recorded. Not part of `Audio.capture`'s public type.
 */
export function captureFileBytes(): Promise<Uint8Array> {
  return capture.fileBytes();
}

/** @internal `Audio.debug().recorder` (§1.3): null while no ring exists. The coordinator wires it into `Audio.debug()`. */
export function captureDebug(): AudioRecorderDebug | null {
  return capture.debug();
}

/** @internal The Engine is disposed (architecture §2.1 "Released"): frees the ring and the take. */
export function releaseCapture(): void {
  capture.release();
}

/**
 * Released (architecture §2.1) follows the Engines (`audioSession.ts`, ADR 0218): the ring and the take are freed when the
 * editor's Engine is disposed (a project closed or switched) or when a game's Engine is disposed with no editor Engine
 * alive (an exported game exits). The editor's per-Play runtime Engine going is a Play stop instead (`capturePlayStopped`,
 * from the audio World service), which keeps the take Held for a save after Stop.
 */
onAudioSessionReleased(releaseCapture);

/** @internal ADR 0348: the editor's Record capture toggle: the capture's file bytes, to write into the project's `recordings/` folder itself. */
export function captureFileBytesNow(): Promise<Uint8Array> {
  return capture.fileBytes();
}

/** @internal ADR 0348: a take's hold on the shared ring (`capture/take.ts`), with its reader of the parameter taps. */
export function captureTakeRing(tee: CaptureTee): Promise<CaptureTakeRing> {
  return capture.takeRing(tee);
}

/** @internal Play stops (architecture §2.1; G7b): the owners end and the ring is freed, a take being Held once for a save after Stop. Called by `core/service.ts` when the last Runtime World releases the audio host. */
export function capturePlayStopped(): void {
  capture.playStopped();
}
