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
// begins a new take after a GAP `held` (R16); `save()` writes the **latest** take only. **Released** (`releaseCapture()`, Play
// stops) frees the ring and the take with it.
//
// **A take is a (start, end) pair.** `start()` sets the take's start to the open segment's keyframe (the nearest at or before
// now). While another owner keeps the ring recording, `stop()` copies the take's span so the file ends where the take did;
// with no other owner the ring stops growing and is read in place.
import type { AudioBackend, AudioRecorderDebug } from "../backend";
import { audioBackend } from "../backend";
import { mixer } from "../../../../engine/audio/mixer";
import { loudnessTarget } from "../mix/loudnessHub";
import type { EpochContext } from "./events";
import type { CaptureHeaderInit, CaptureMetaInit, NameTable } from "./format";
import type { RingSpan } from "./ring";
import type { SaveEnv, SaveTake } from "./save";

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
export const NOTHING_RECORDED = "nothing recorded: call Audio.capture.start() first";

/** What the recorder chunk exports to this file (a type only: the module is reached by `import()` alone). */
export type RecorderModule = typeof import("./recorder");
type Recorder = ReturnType<RecorderModule["createRecorder"]>;
type EventSink = ReturnType<(typeof import("./events"))["createEventSink"]>;

/** Loads the recorder chunk: the only `import()` of `recorder.ts`. */
let loadRecorder: () => Promise<RecorderModule> = () => import("./recorder");

/** @internal Tests: replace the chunk loader (a spy proves a game that never starts loads nothing). Returns the previous one. */
export function _setRecorderLoader(load: () => Promise<RecorderModule>): () => Promise<RecorderModule> {
  const previous = loadRecorder;
  loadRecorder = load;
  return previous;
}

/** The platform, storage, clock and compressor `save` uses; null: the real ones (`save.ts` `defaultSaveEnv`). */
let saveEnv: SaveEnv | null = null;

/** @internal Tests: replace the save environment (fakes for the web and Tauri paths). Returns the previous one. */
export function _setSaveEnv(env: SaveEnv | null): SaveEnv | null {
  const previous = saveEnv;
  saveEnv = env;
  return previous;
}

/** The project a capture's META names (§5.2, owner decision 6). The engine has no project record at run time, so the page title stands in until a shell says better. */
let projectInfo: () => { name: string; version: string } = () => ({ name: typeof document !== "undefined" ? document.title : "", version: "" });

/** @internal Where a shell (the player, the editor) says which project a capture belongs to. */
export function setCaptureProject(info: () => { name: string; version: string }): void {
  projectInfo = info;
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
  /** The frame the next EPOCH names (a start, or a core made while Held); null: 0, a rebuilt core's first frame. */
  private epochFrame: number | null = null;

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
    if (!this.hasTake || !(this.frozen || this.rec)) return Promise.reject(new Error(NOTHING_RECORDED));
    let take: SaveTake;
    try {
      take = this.snapshot(); // the span as of this call: a ring that goes on recording changes nothing
    } catch (e) {
      return Promise.reject(new Error(messageOf(e)));
    }
    const env = saveEnv;
    return import("./save").then((s) => s.saveCapture(take, name, env ?? undefined));
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
    const rec = this.rec;
    if (rec) {
      try {
        rec.stopLive();
        rec.detach();
        this.backend?.setProfileSink?.(null);
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
    const [mod, events, save] = await Promise.all([loadRecorder(), import("./events"), import("./save")]);
    const rec = mod.createRecorder({});
    const sink = events.createEventSink(rec, { epochContext: () => this.epochContext(backend) });
    const meta = this.buildMeta(backend, rec.ring.capacity);
    for (const table of TABLES) for (const [id, name] of namesOf(meta.names[table])) sink.seed(table, id, name);
    this.epochFrame = this.frameOf(backend);
    try {
      sink.epoch("start"); // begins the recording: EPOCH start, then a KEYFRAME
    } finally {
      this.epochFrame = null;
    }
    const init: CaptureHeaderInit = { sampleRate: rec.sampleRate, preset: this.presetOf(rec.ring.capacity), startDateMs: Date.now(), ringBytes: rec.ring.capacity, firstFrame: 0, mainSideOnly: this.mainSideOnly };
    this.head = save.liveHead(init, meta);
    this.headInit = init;
    this.takeMeta = meta;
    this.takeDate = init.startDateMs;
    if (!this.mainSideOnly) rec.attach(backend);
    backend.setProfileSink?.(sink);
    this.rec = rec;
    this.sink = sink;
    this.backend = backend;
    this.ringState = "recording";
  }

  /** The backend a ring can record from; rejects with a message when there is none (the core still loading, or a device without it). */
  private target(): AudioBackend {
    const backend = audioBackend();
    if ("recorderTap" in backend) {
      this.mainSideOnly = false;
      return backend;
    }
    if (backend.mixCaps?.capture === "mainSideOnly") {
      this.mainSideOnly = true; // the Babylon fallback: main-side events and keyframes only (§9)
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
    if (backend !== this.backend && this.backend) this.backend.setProfileSink?.(null);
    this.backend = backend;
    if (!this.mainSideOnly) rec.attach(backend);
    backend.setProfileSink?.(sink);
    this.ringState = "recording";
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
    this.backend?.setProfileSink?.(null);
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

  /** META with the names the event sink interned since the ring began, so a truncated file (whose NAMES records were evicted) still names them. */
  private withInterned(meta: CaptureMetaInit): CaptureMetaInit {
    const sink = this.sink;
    if (!sink) return meta;
    const names: CaptureMetaInit["names"] = { ...meta.names };
    TABLES.forEach((table, t) => {
      const merged: Record<number, string> = {};
      for (const [id, name] of namesOf(meta.names[table])) merged[id] = name;
      for (const [name, id] of sink.interned[t]!) merged[id] = name;
      names[table] = merged;
    });
    return { ...meta, names };
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
    const lat = backend.latency?.();
    const sec = (x: unknown): number => Math.max(0, finiteOr(x, 0));
    return {
      sampleRate: rate,
      limiterLatencyFrames: Math.round(sec(lat?.limiter) * rate),
      outputLatencyFrames: Math.round((sec(lat?.base) + sec(lat?.output)) * rate),
      timeOffset: finiteOr(d.time, 0) - frame / rate,
      frame,
    };
  }

  /** META (§5.2): the project, the engine, the device, the audio section as it stands, the target in force and the names known now. */
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
    };
  }
}

const capture = new Capture();

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

/** @internal The ring's owners: whether a take runs and how many panel holds there are. */
export function captureOwners(): { take: boolean; panels: number } {
  return capture.owners();
}

/** @internal `Audio.debug().recorder` (§1.3): null while no ring exists. The coordinator wires it into `Audio.debug()`. */
export function captureDebug(): AudioRecorderDebug | null {
  return capture.debug();
}

/** @internal Play stops / the Engine is disposed (architecture §2.1 "Released"): frees the ring and the take. */
export function releaseCapture(): void {
  capture.release();
}
