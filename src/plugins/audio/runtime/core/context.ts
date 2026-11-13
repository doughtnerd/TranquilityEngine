// The AudioHost's context half (ADR 0157; architecture §1, §2.1, §3.1, §4.5): one AudioContext per page, the
// worklet node running the core, and the main side of the port protocol. `service.ts` starts it at scene load;
// A0.8 adds its lifecycle across Engines and Worlds, A1.4 the command writer and status reader on top of
// `CoreLink`, A3.4b the visibility hooks.
//
// `CoreLink` is the port protocol with no Web Audio in it, so Node tests wire it straight to a `CoreDriver`:
// STATUS is copied in `onmessage` and its buffer goes back at once as RECYCLE (never waiting for a frame, so
// STATUS keeps flowing with frames stopped, §4.5); returned BATCH buffers go back to the host's pool.
import { MAX_BUSES, type AudioSettings } from "../../../../engine/audio/settings";
import { Kind, MAGIC, readStatus, STATUS_FLAGS_READY, writeEnvelope, writeTimePing, type StatusBlock } from "../wire.generated";
import { CORE_ABI_MAJOR, PROCESSOR_NAME, type CoreControlMessage, type CorePreset, type CoreProcessorOptions, type CoreShellEvent } from "../worklet/coreDriver";
import { createBatchPool, type BufferPool } from "./bufferPool";
import { musicInitParams, spatialInitParams } from "./initParams";
import { loadCoreWasm, workletModuleUrl, type CoreWasm } from "./loader";
import { Unlock } from "./unlock";
import type { DeviceSnapshot } from "./deviceChange";
import type { RecorderTap } from "../backend";

/** @internal §2.1's states as `Audio.status` reports them. */
export type HostStatus = "locked" | "running" | "failed";

/** @internal §4.7: Starting fails when no first STATUS arrives within 5 s of the context running. */
export const FIRST_STATUS_TIMEOUT_MS = 5_000;
/** @internal §5.1 default preset: the clip arena's initial reserve. */
export const ARENA_INITIAL_BYTES = 16 << 20;
/**
 * @internal ADR 0166 §4.6 (Rh1): what `latencyHint` a context is made with. `"interactive"` normally; rhythm mode
 * (`audio.rhythmMode`) asks for `0` seconds, which the browser clamps to its smallest output buffer (Chromium's fake
 * sink: 2.9 ms base and 8 ms output, against 10 / 32 ms at `"interactive"`, S5). What it gave is read back
 * (`AudioHost.latency`), never warned about.
 */
export type LatencyHint = AudioContextLatencyCategory | number;
/** @internal §4.6: rhythm mode's numeric hint, seconds. */
export const RHYTHM_LATENCY_HINT = 0;
/** @internal §3.1: the hint outside rhythm mode. */
export const DEFAULT_LATENCY_HINT: AudioContextLatencyCategory = "interactive";
/** @internal §4.6: a change of `outputLatency` this soon (ms) after the context was made counts as evidence it is live. */
export const LATENCY_EVIDENCE_WINDOW_MS = 10_000;
/**
 * @internal §4.6 "rate-limited": a change of the rhythm-mode setting rebuilds the context at most once per this (ms);
 * a later change waits for the rest of it, and only the last one counts. Every rebuild also takes one from the
 * recovery limit (`recovery.ts`), but a mode rebuild never spends the last one: it waits instead.
 */
export const MODE_REBUILD_INTERVAL_MS = 1_000;
/** @internal A mode rebuild the recovery limit deferred is tried again after this (ms). */
export const MODE_REBUILD_RETRY_MS = 5_000;

/** @internal The `latencyHint` for a context in rhythm mode (`0`) or not (`"interactive"`). */
export function latencyHintFor(rhythmMode: boolean): LatencyHint {
  return rhythmMode ? RHYTHM_LATENCY_HINT : DEFAULT_LATENCY_HINT;
}

/** @internal How a context is made (`HostParts.recreate`'s argument). */
export interface ContextOptions {
  readonly latencyHint: LatencyHint;
}

/**
 * @internal §1.3, §4.6: the context's latency as read back, seconds. `base` and `output` are `baseLatency` and
 * `outputLatency` (0 where the browser reports none or nonsense). `reliable`: `output` is in (0, 0.5) s **and** either it
 * changed at least once within `LATENCY_EVIDENCE_WINDOW_MS` of the context's creation or `getOutputTimestamp()` is valid
 * (both times positive). A constant 0 or an absurd value is unreliable: the debug panel then says to calibrate.
 */
export interface ContextLatency {
  readonly base: number;
  readonly output: number;
  readonly reliable: boolean;
}

/** What the reliability rule remembers of one context's `outputLatency`. */
interface LatencyTrack {
  /** When the context was made (the host's clock, ms). */
  readonly since: number;
  /** The first `outputLatency` read, NaN before any. */
  first: number;
  /** It changed within the evidence window. */
  changed: boolean;
}

const finiteNonNegative = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/** @internal §5.3: the clip ceiling when `audio.clipMemoryMB` is absent (the default preset's). */
export const DEFAULT_CLIP_CEILING_MB = 128;

const MB = 1 << 20;

/** @internal The init preset from the project's `audio` settings (§2, architecture §5.3). */
export function presetFromSettings(settings: AudioSettings): CorePreset {
  const clipCeilingBytes = (settings.clipMemoryMB ?? DEFAULT_CLIP_CEILING_MB) * MB;
  return {
    maxLogical: settings.voices.logical,
    maxMixed: settings.voices.mixed,
    maxBuses: MAX_BUSES,
    arenaInitialBytes: Math.min(ARENA_INITIAL_BYTES, clipCeilingBytes),
    clipCeilingBytes,
    limiterLookaheadMs: settings.limiterLookaheadMs,
    // ADR 0162 C8: the ABI 2.0 parameters (`initParams.ts`: beds and zones 0 until their flips, wide from `audio.ambisonic.maxClips`).
    ...spatialInitParams(settings),
    // ADR 0166 W1 (ABI 3.0): `audio.music.rings`, the music ring pool.
    ...musicInitParams(settings),
  };
}

/** @internal The side of a `MessagePort` the link uses (the node's port, or a fake wired to a `CoreDriver`). */
export interface LinkPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const isShellEvent = (data: unknown): data is CoreShellEvent =>
  typeof data === "object" && data !== null && ((data as { type?: unknown }).type === "error" || (data as { type?: unknown }).type === "trap");

/** @internal The main side of the port protocol (api-and-models §4.1, §4.3). */
export class CoreLink {
  /** The host's BATCH pool (§4.7: 4 × 64 KB); returned BATCH buffers come back here. */
  readonly batchPool: BufferPool = createBatchPool();
  /** STATUS blocks received. */
  statusCount = 0;
  /** The newest STATUS block, or null before the first. */
  lastStatus: StatusBlock | null = null;
  /**
   * Resolves on the first STATUS with the ready flag and this ABI's major; rejects on a shell error or a mismatch.
   * A hard rebuild (`_rebind`, A3.4a) replaces it with the new core's.
   */
  ready: Promise<void>;
  /** Whether `ready` settled, and how. */
  readyState: "pending" | "ready" | "failed" = "pending";
  /**
   * How STATUS buffers are decoded. `readStatus` builds a new block per message; A1.4's `coreBackend` swaps in a
   * `StatusReader` that fills one preallocated block (the block is then reused: listeners must not keep it).
   */
  statusDecoder: (buffer: ArrayBuffer) => StatusBlock = readStatus;
  /**
   * ADR 0171 (K0; Rc2 sets it from `capture/recorder.ts` through `capture/capture.ts`): the recorder's raw copy of each
   * STATUS block, called after the decode and before the RECYCLE, with the envelope's total bytes. Null when no recorder
   * runs: a null check, no allocation. Never import the recorder here.
   */
  recorderTap: RecorderTap | null = null;

  private seq = 0;
  private pingSeq = 0;
  private settle!: (error?: Error) => void;
  private readonly statusListeners = new Set<(status: StatusBlock) => void>();
  private readonly shellListeners = new Set<(event: CoreShellEvent) => void>();

  constructor(private port: LinkPort) {
    this.ready = this.newReady();
    port.onmessage = (event) => this.handleMessage(event.data);
  }

  /** A pending `ready` and the `settle` that ends it. */
  private newReady(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.settle = (error) => {
        if (this.readyState !== "pending") return;
        this.readyState = error ? "failed" : "ready";
        if (error) reject(error);
        else resolve();
      };
    });
    // A failure is also reported through `readyState`; don't let an unobserved `ready` raise an unhandled rejection.
    ready.catch(() => {});
    return ready;
  }

  /**
   * A3.4a, the hard rebuild: tells the old node's processor to stop (`retire`), stops listening to its port and
   * listens to `port` (the new node's) instead. `ready` and `readyState` start again for the new core's first STATUS;
   * listeners, the decoder, `seq` and the counts stay, so everything holding this link carries over. BATCH buffers
   * still out with the old node never come back, so the pool is topped up with new ones.
   */
  _rebind(port: LinkPort): void {
    this.retire();
    this.port = port;
    this.readyState = "pending";
    this.ready = this.newReady();
    port.onmessage = (event) => this.handleMessage(event.data);
    const pool = this.batchPool;
    while (pool.available < pool.count) if (!pool.release(new ArrayBuffer(pool.bytes))) break;
  }

  /** A3.4a: asks the current node's processor to stop rendering (`retire`) and stops listening to its port. */
  retire(): void {
    const message: CoreControlMessage = { type: "retire" };
    try {
      this.port.postMessage(message);
    } catch {
      // A closed port: nothing to retire.
    }
    this.port.onmessage = null;
  }

  /** Fails `ready` (no first STATUS in time, §4.7). No effect once it settled. */
  fail(error: Error): void {
    this.settle(error);
  }

  /** Calls `listener` with every STATUS block, in `onmessage`; returns the unsubscribe. */
  onStatus(listener: (status: StatusBlock) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Calls `listener` with every shell event (`error`, `trap`); returns the unsubscribe. */
  onShellEvent(listener: (event: CoreShellEvent) => void): () => void {
    this.shellListeners.add(listener);
    return () => this.shellListeners.delete(listener);
  }

  /** Sends a TIME_PING and returns its `pingSeq`; a later STATUS echoes it. */
  ping(): number {
    this.pingSeq = (this.pingSeq + 1) >>> 0 || 1;
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.TIME_PING, seq: this.nextSeq(), bodyBytes: 4 });
    writeTimePing(view, 0, { pingSeq: this.pingSeq });
    this.port.postMessage(buffer, [buffer]);
    return this.pingSeq;
  }

  /**
   * B3: hands the worklet its end of the channel to the decoder worker (`port` transferred), over which streams flow
   * without main. Goes to the current node; after a hard rebuild the stream manager connects the new one.
   */
  connectStreamPort(port: MessagePort): void {
    const message: CoreControlMessage = { type: "streamPort", port };
    this.port.postMessage(message, [port as unknown as Transferable]);
  }

  /** Dev only: a sine of `hz` at `gain` mixed onto the core's output in the shell; `hz <= 0` stops it. */
  debugTone(hz: number, gain = 0.1): void {
    const message: CoreControlMessage = { type: "debugTone", hz, gain };
    this.port.postMessage(message);
  }

  /** The port's `onmessage`: STATUS (copy, then RECYCLE at once), returned buffers, shell events. */
  handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 16) return;
      const view = new DataView(data);
      if (view.getUint32(0, true) !== MAGIC) return;
      if (view.getUint16(6, true) !== Kind.STATUS) {
        this.batchPool.release(data);
        return;
      }
      let status: StatusBlock | null = null;
      try {
        status = this.statusDecoder(data);
      } catch {
        // A block we can't read still goes back, or the shell's pool shrinks.
      }
      // ADR 0171 (K0): the recorder copies the raw block here, before RECYCLE overwrites its envelope and transfers it.
      this.recorderTap?.(data, 16 + view.getUint32(12, true));
      // §4.3: return the buffer at once with RECYCLE (the transfer is the message), before anything else runs.
      writeEnvelope(view, 0, { kind: Kind.RECYCLE, seq: this.nextSeq(), bodyBytes: 0 });
      this.port.postMessage(data, [data]);
      if (status) this.receive(status);
      return;
    }
    if (isShellEvent(data)) {
      if (data.type === "error") this.settle(new Error(data.message));
      for (const listener of this.shellListeners) listener(data);
    }
  }

  private receive(status: StatusBlock): void {
    this.statusCount++;
    this.lastStatus = status;
    if (this.readyState === "pending" && status.flags & STATUS_FLAGS_READY) {
      const major = status.abiVersion >> 8;
      this.settle(major === CORE_ABI_MAJOR ? undefined : new Error(`audio core: ABI ${major} where ${CORE_ABI_MAJOR} was expected`));
    }
    for (const listener of this.statusListeners) listener(status);
  }

  /** The envelope `seq` for the next message (per sender, on this one port, wraps). BATCHes and clip messages share it. */
  nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    return seq;
  }

  /** Posts a finished message (BATCH, CLIP_BEGIN, CLIP_CHUNK, CLIP_UNLOAD, ...), transferring the buffer. */
  post(buffer: ArrayBuffer): void {
    this.port.postMessage(buffer, [buffer]);
  }

  /** Stops listening to the port. */
  dispose(): void {
    this.port.onmessage = null;
    this.statusListeners.clear();
    this.shellListeners.clear();
  }
}

// --- Lifecycle (A0.8; architecture §1, §3.9; api-and-models §3 "Bus state serialisation", §7) -----------------

/** @internal A World's key in the host: the voice table's `world` byte (api §3), 1..255; 0 means "no World". */
export type WorldKey = number;
/** @internal Keys 1..255 fit the voice table's `world: Uint8Array`. */
export const MAX_WORLD_KEYS = 255;

/** @internal One World's share of the page's host (§3.9): what `releaseWorld` frees. */
export interface WorldShare {
  readonly key: WorldKey;
  /** The World (any object: the host never looks inside it). */
  readonly owner: object;
  /** Set by `releaseWorld`; a released share's key may already belong to another World. */
  readonly released: boolean;
}

/**
 * @internal A bus remap (api §3): the bus tree changed (`Engine.ts` reconfigured the one mixer for another
 * Engine), so every live voice's `bus` index moves to the bus of the same name, unknown names to the root (0).
 */
export interface BusRemap {
  /** The host's `busEpoch` after the change. */
  readonly epoch: number;
  /** Bus names before, by index (root first). */
  readonly from: readonly string[];
  /** Bus names after, by index (root first). */
  readonly to: readonly string[];
  /** `map[oldIndex]` is the new index; `map.length === from.length`. */
  readonly map: Uint8Array;
}

/**
 * @internal The host's lifecycle seams. Nothing on the core holds voices or clips yet, so these are the hooks the
 * later owners attach to: A1.1's voice table (`onBusRemap`: `bus[i] = map[bus[i]]` for each live voice;
 * `onWorldReleased`: STOP that World's voices with 10 ms fades), A1.3a's clip registry (`onWorldReleased`: drop the
 * key from `holders`), A1.4's command writer (`onBusRemap`: send BUS_CONFIG; `onIdle`: `RESET 0` when no World
 * holds clips). Listeners run synchronously, in the order they were added.
 */
export interface HostLifecycleListener {
  /** The bus tree changed (`reconfigure` with different names). */
  onBusRemap?(remap: BusRemap): void;
  /** A World released its share; its key returns to the pool after every listener ran. */
  onWorldReleased?(key: WorldKey, owner: object): void;
  /** The last World released (play stopped and the editor's World gone too, or a lone game World torn down). */
  onIdle?(): void;
  /** The host closed (tests, or a future rebuild replacing it). */
  onClose?(): void;
  /**
   * A3.4a: a hard rebuild started (architecture §3.6): the old core is gone and a new node is being made. Until
   * `onRebuilt`, nothing sent reaches a core that keeps it; new plays should wait.
   */
  onRebuildStart?(reason: string): void;
  /**
   * A3.4a: the new core answered its first STATUS. Its state is a fresh init: the owner of the voices and clips (the
   * core backend) sends RESET 0, the buses, MASTER, the clips and the replay now.
   */
  onRebuilt?(): void;
  /** A3.4a: recovery gave up (the rate limit, or the new core never answered): the host is Failed and silent. */
  onRecoveryFailed?(): void;
  /**
   * A3.4c: the rebuild moved to a new AudioContext (architecture §3.7), at `sampleRate`: its frames start at 0 and
   * `host.context` is the new one. Runs after `onRebuildStart` and before `onRebuilt`, before the new core's first
   * STATUS, so whoever holds rate-dependent state (the core backend: clock map, writer, playheads, HRIR) moves it now.
   */
  onContextReplaced?(sampleRate: number): void;
}

/**
 * @internal The pure remap rule (api §3): for each old bus index, the index of the same name in `to`, else 0 (the
 * root). Names are unique within a tree (the settings parse guarantees it).
 */
export function busRemap(from: readonly string[], to: readonly string[]): Uint8Array {
  const map = new Uint8Array(from.length);
  for (let i = 0; i < from.length; i++) {
    const j = to.indexOf(from[i]!);
    map[i] = j < 0 ? 0 : j;
  }
  return map;
}

const presetsEqual = (a: CorePreset, b: CorePreset): boolean =>
  a.maxLogical === b.maxLogical &&
  a.maxMixed === b.maxMixed &&
  a.maxBuses === b.maxBuses &&
  a.arenaInitialBytes === b.arenaInitialBytes &&
  a.clipCeilingBytes === b.clipCeilingBytes &&
  a.limiterLookaheadMs === b.limiterLookaheadMs &&
  // ADR 0162 C8: each sizes a fixed region, so a change rebuilds the core.
  a.maxBeds === b.maxBeds &&
  a.maxZoneSlots === b.maxZoneSlots &&
  a.zoneMaxSeconds === b.zoneMaxSeconds &&
  a.maxWide === b.maxWide &&
  // ADR 0166 W1: the music ring pool sizes the `Streams` region (C1), so a change rebuilds the core.
  a.maxMusicRings === b.maxMusicRings;

const sameNames = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((n, i) => n === b[i]);

/** Runs `fn` for each listener; one that throws is logged and doesn't stop the others or the host. */
function each(listeners: Iterable<HostLifecycleListener>, fn: (l: HostLifecycleListener) => void): void {
  for (const l of [...listeners]) {
    try {
      fn(l);
    } catch (err) {
      console.error("[myco] audio host listener failed:", err);
    }
  }
}

/** A share whose `released` only the host sets. */
interface MutableShare {
  readonly key: WorldKey;
  readonly owner: object;
  released: boolean;
}

/** @internal What the host is made of: the browser's in `AudioHost._startNew`, fakes in Node tests. */
export interface HostParts {
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly link: CoreLink;
  readonly unlock: Unlock;
  /** The preset the core was initialised with. */
  readonly preset: CorePreset;
  /**
   * A3.4a: makes a new worklet node (a new core over a new Memory) in the same context, connected to the output, with
   * its port. Absent: the host can't rebuild (a rebuild then fails).
   */
  readonly respawn?: () => { readonly node: AudioWorkletNode; readonly port: LinkPort };
  /**
   * A3.4c: makes a new AudioContext at the device's rate (the browser's default), adds the worklet module, makes a
   * node (a new core initialised with the running preset at the new rate) connected to its output, and an unlock layer
   * on it. The host closes the old context first. Absent: device and rate rebuilds fail. ADR 0166 §4.6: `options` carry
   * the `latencyHint` for the rhythm mode the host wants now (fakes may ignore it).
   */
  readonly recreate?: (options: ContextOptions) => Promise<ContextParts>;
  /** ADR 0166 §4.6: whether `context` was made in rhythm mode (`latencyHint: 0`). Absent: false. */
  readonly rhythmMode?: boolean;
  /** The host's clock, ms (the latency evidence window and the mode rebuild interval); default `performance.now`. */
  readonly now?: () => number;
}

/** @internal A3.4c: what `HostParts.recreate` gives: a new context with its first node, port, unlock layer and `respawn`. */
export interface ContextParts {
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly port: LinkPort;
  readonly unlock: Unlock;
  /** Makes another node in this new context (a later same-context rebuild). */
  readonly respawn?: () => { readonly node: AudioWorkletNode; readonly port: LinkPort };
}

/** @internal Architecture §8 "Health": what the hard rebuild has done to the page's host (A3.4a). */
export interface HostHealth {
  /** Traps caught (the shell's catch, or `processorerror`), over every core this host ran. */
  traps: number;
  /** Rebuilds completed after a trap (§7's trap row). */
  recoveries: number;
  /** Rebuilds completed for another reason: a stall, a device or rate change (§7). */
  rebuilds: number;
}

/**
 * @internal The page's audio host (M1a.0; architecture §1): context, node, link and unlock, shared by every Engine
 * and World on the page. Worlds take a share (`attachWorld`) and give it back (`releaseWorld`); the context and core
 * stay for the page (§3.9).
 */
export class AudioHost {
  readonly link: CoreLink;
  /** True while the page's own background policy has suspended the context (A3.4b drives it); unlock won't re-arm then. */
  pageSuspended = false;

  private currentContext: AudioContext;
  private currentUnlock: Unlock;
  /** Every listener the host keeps on its context (its own `statechange`, `onDeviceEvent`'s): moved by a context swap. */
  private readonly contextListeners = new Set<{ readonly type: string; readonly fn: () => void }>();
  private readonly recreate: HostParts["recreate"];
  /** §4.7's first-STATUS timeout for the core being started (a stall rebuild waits less, A3.4c). */
  private statusTimeoutMs = FIRST_STATUS_TIMEOUT_MS;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private readonly onStateChange = () => this.startTimeout();
  private isClosed = false;
  private currentPreset: CorePreset;
  private nextPreset: CorePreset | null = null;
  private names: readonly string[] = [];
  private epoch = 0;
  private readonly shares = new Map<WorldKey, MutableShare>();
  private readonly byOwner = new Map<object, MutableShare>();
  private readonly listeners = new Set<HostLifecycleListener>();
  private readonly deviceRemovals = new Set<() => void>();
  private currentNode: AudioWorkletNode;
  private respawn: HostParts["respawn"];
  /** §2.1 Recovering (A3.4a): between `_beginRebuild` and `_endRebuild`. */
  private recovering = false;
  /** §2.1 Failed after recovery gave up (A3.4a): silent for the rest of the session. */
  private recoveryFailed = false;
  /** §8 health counters (A3.4a's `recovery.ts` writes them). */
  readonly health: HostHealth = { traps: 0, recoveries: 0, rebuilds: 0 };
  // --- ADR 0166 §4.6 rhythm mode (Rh1) ---
  private readonly now: () => number;
  /** The mode the current context was made with. */
  private contextRhythm: boolean;
  /** The mode the settings ask for (`reconfigure`); differs from `contextRhythm` until the mode rebuild lands. */
  private wantRhythm: boolean;
  private latencyTrack: LatencyTrack;
  /** Starts a mode rebuild (`recovery.ts` installs it with `watchForTraps`); null: a change waits until one is installed. */
  private modeRebuild: (() => Promise<string>) | null = null;
  /** A mode rebuild is queued (a microtask, or a timer for the interval's rest or a deferred retry). */
  private modeQueued: ReturnType<typeof setTimeout> | true | null = null;
  private lastModeRebuildAt = Number.NEGATIVE_INFINITY;
  /** Mode rebuilds started (tests and diagnostics). */
  modeRebuilds = 0;

  private constructor(parts: HostParts) {
    this.currentContext = parts.context;
    this.currentNode = parts.node;
    this.respawn = parts.respawn;
    this.recreate = parts.recreate;
    this.link = parts.link;
    this.currentUnlock = parts.unlock;
    this.currentPreset = parts.preset;
    this.now = parts.now ?? (() => performance.now());
    this.contextRhythm = parts.rhythmMode === true;
    this.wantRhythm = this.contextRhythm;
    this.latencyTrack = { since: this.now(), first: Number.NaN, changed: false };
    this.listenOnContext("statechange", this.onStateChange);
    this.startTimeout();
    void this.link.ready.then(
      () => this.clearTimeout(),
      () => this.clearTimeout(),
    );
    this.watchNode(parts.node);
  }

  /** The page's AudioContext. A rebuild into a new context (A3.4c, §3.7) replaces it: read it each time, never keep it. */
  get context(): AudioContext {
    return this.currentContext;
  }

  /** The unlock layer on the current context (a context swap makes a new one, A3.4c). */
  get unlock(): Unlock {
    return this.currentUnlock;
  }

  /** The worklet node running the core (a hard rebuild replaces it, A3.4a). */
  get node(): AudioWorkletNode {
    return this.currentNode;
  }

  /** Whether the context is closed (by the browser or the OS): a rebuild then needs a new one (A3.4c). */
  get contextClosed(): boolean {
    return this.currentContext.state === "closed";
  }

  /** Whether this host can rebuild into a new context (A3.4c). */
  get canRecreate(): boolean {
    return this.recreate !== undefined;
  }

  /** Adds `fn` for `type` on the current context, and keeps it there across a context swap; returns the removal. */
  private listenOnContext(type: string, fn: () => void): () => void {
    const entry = { type, fn };
    this.contextListeners.add(entry);
    this.currentContext.addEventListener(type, fn);
    return () => {
      if (!this.contextListeners.delete(entry)) return;
      this.currentContext.removeEventListener(type, fn);
    };
  }

  /**
   * @internal Builds a host from its parts (Node tests pass fakes). Arms the unlock layer when the context isn't
   * running, and keeps it watching for `interrupted` and unrequested suspends (A0.9).
   */
  static _create(parts: HostParts): AudioHost {
    const host = new AudioHost(parts);
    if (parts.context.state !== "running") parts.unlock.arm();
    parts.unlock.watch(() => host.pageSuspended); // true while the page's own background policy has suspended the context (A3.4b sets it)
    return host;
  }

  /**
   * §3.1: creates the AudioContext (`latencyHint: "interactive"`, `0` in rhythm mode; suspended when autoplay is blocked), adds the
   * worklet module, creates the node with the wasm bytes and the preset, connects it, and arms the unlock layer on
   * `unlockTarget` when the context isn't running. Resolves once the node exists, before the first STATUS (a
   * locked context renders nothing until the gesture).
   *
   * Every call makes a new AudioContext, so only `startAudioHost` calls it, through `acquireAudioHost` (the page's
   * one host, architecture §1). Get the host with `startAudioHost` or `currentAudioHost`, never with this.
   */
  static async _startNew(wasm: CoreWasm, moduleUrl: string, preset: CorePreset, unlockTarget: EventTarget, rhythmMode = false): Promise<AudioHost> {
    // A3.4c: a device or rate rebuild makes the next context the same way (no rate asked for: the device's), with the
    // hint for the rhythm mode wanted then (ADR 0166 §4.6).
    const recreate = (options: ContextOptions) => openCoreContext(wasm, moduleUrl, preset, unlockTarget, options.latencyHint);
    const { context, node, port, unlock, respawn } = await recreate({ latencyHint: latencyHintFor(rhythmMode) });
    const link = new CoreLink(port);
    return AudioHost._create({ context, node, link, unlock, preset, respawn, recreate, rhythmMode });
  }

  // --- Rhythm mode (ADR 0166 §1.5, §4.6; Rh1) ---

  /** Whether the running context was made in rhythm mode (`latencyHint: 0`). */
  get rhythmMode(): boolean {
    return this.contextRhythm;
  }

  /** The rhythm mode the settings ask for while it differs from the running context's (a mode rebuild is due), else null. */
  get pendingRhythmMode(): boolean | null {
    return this.wantRhythm === this.contextRhythm ? null : this.wantRhythm;
  }

  /** The `latencyHint` the running context was made with. */
  get latencyHint(): LatencyHint {
    return latencyHintFor(this.contextRhythm);
  }

  /**
   * §1.3, §4.6: the running context's `baseLatency` and `outputLatency` read back now, and the `reliable` rule
   * (`ContextLatency`). Each read also feeds the rule's evidence (a change of `outputLatency` within the first 10 s).
   * Allocates one small object.
   */
  latency(): ContextLatency {
    const c = this.currentContext as AudioContext & { baseLatency?: unknown; outputLatency?: unknown; getOutputTimestamp?: () => AudioTimestamp };
    const base = finiteNonNegative(c.baseLatency);
    const output = finiteNonNegative(c.outputLatency);
    const t = this.latencyTrack;
    if (Number.isNaN(t.first)) t.first = output;
    else if (!t.changed && output !== t.first && this.now() - t.since <= LATENCY_EVIDENCE_WINDOW_MS) t.changed = true;
    let stamped = false;
    try {
      const ts = typeof c.getOutputTimestamp === "function" ? c.getOutputTimestamp() : undefined;
      stamped = ts !== undefined && (ts.contextTime ?? 0) > 0 && (ts.performanceTime ?? 0) > 0;
    } catch {
      /* a closed context may throw: no evidence */
    }
    return { base, output, reliable: output > 0 && output < 0.5 && (t.changed || stamped) };
  }

  /**
   * @internal `recovery.ts` (`watchForTraps`) installs how a mode rebuild starts: `rebuildHost(host, "latency")`, a new
   * context on the device path, rate-limited. A change already waiting starts now.
   */
  _setModeRebuild(start: (() => Promise<string>) | null): void {
    this.modeRebuild = start;
    this.queueModeRebuild();
  }

  /**
   * §4.6 "toggling the setting rebuilds the context": queues a mode rebuild when the settings' mode differs from the
   * context's. The first one in `MODE_REBUILD_INTERVAL_MS` starts in a microtask (not inside the Engine's `create`); a
   * later one waits for the rest of the interval, and whatever the settings say then is what is built (toggling back
   * before it runs builds nothing). A host that can't make a new context, or has nobody to start the rebuild, waits.
   */
  private queueModeRebuild(): void {
    if (this.modeQueued !== null || this.isClosed || this.recoveryFailed || !this.recreate || !this.modeRebuild) return;
    if (this.wantRhythm === this.contextRhythm) return;
    const run = () => {
      this.modeQueued = null;
      const start = this.modeRebuild;
      if (!start || this.isClosed || this.recoveryFailed || this.wantRhythm === this.contextRhythm) return;
      this.lastModeRebuildAt = this.now();
      this.modeRebuilds++;
      void start().then((outcome) => {
        if (this.modeQueued !== null || this.isClosed || this.recoveryFailed) return;
        if (outcome === "deferred") {
          // The recovery limit had no room to spare: try again later (the context keeps its old hint meanwhile).
          this.modeQueued = setTimeout(() => {
            this.modeQueued = null;
            this.queueModeRebuild();
          }, MODE_REBUILD_RETRY_MS);
          return;
        }
        // The setting changed again meanwhile, or a rebuild already in flight kept the context: after the interval.
        this.queueModeRebuild();
      });
    };
    const wait = this.lastModeRebuildAt + MODE_REBUILD_INTERVAL_MS - this.now();
    if (wait > 0) this.modeQueued = setTimeout(run, wait);
    else {
      this.modeQueued = true;
      queueMicrotask(run);
    }
  }

  private cancelModeRebuild(): void {
    if (this.modeQueued !== null && this.modeQueued !== true) clearTimeout(this.modeQueued);
    this.modeQueued = null;
  }

  /** §2.1: Locked and Starting are `"locked"`, Failed `"failed"`, the rest `"running"`. */
  get status(): HostStatus {
    if (this.recoveryFailed) return "failed";
    // §2.1: Recovering reads as running (the new core's first STATUS is pending, but the context hasn't locked). A3.4c:
    // so does the old context closed under a rebuild into a new one, or a stalled core failing before the escalation.
    if (this.recovering) return this.context.state === "running" || this.context.state === "closed" ? "running" : "locked";
    if (this.link.readyState === "failed" || this.context.state === "closed") return "failed";
    if (this.link.readyState === "pending" || this.context.state !== "running") return "locked";
    return "running";
  }

  /** §2.1 Recovering (A3.4a): a hard rebuild is under way. */
  get rebuilding(): boolean {
    return this.recovering;
  }

  /** §2.1 Failed because recovery gave up (A3.4a). */
  get recoveryHasFailed(): boolean {
    return this.recoveryFailed;
  }

  /** Whether `close()` ran (the page singleton then starts a new host on the next acquire). */
  get closed(): boolean {
    return this.isClosed;
  }

  // --- Worlds (§3.9) ---

  /**
   * §3.9: a World registers with the host (its `myco.audio` service's `create`). Gives the lowest free key; the same
   * owner attached twice gets its existing share. Throws when all 255 keys are taken, or after `close()`.
   */
  attachWorld(owner: object): WorldShare {
    if (this.isClosed) throw new Error("audio core: the host is closed");
    const existing = this.byOwner.get(owner);
    if (existing) return existing;
    let key = 1;
    while (key <= MAX_WORLD_KEYS && this.shares.has(key)) key++;
    if (key > MAX_WORLD_KEYS) throw new Error(`audio core: more than ${MAX_WORLD_KEYS} Worlds hold the audio host`);
    const share: MutableShare = { key, owner, released: false };
    this.shares.set(key, share);
    this.byOwner.set(owner, share);
    return share;
  }

  /**
   * §3.9 / api §7: frees a World's share (its service's `dispose`, on play stop or World teardown). Marks the share
   * released, runs every `onWorldReleased`, returns the key to the pool, then runs `onIdle` if no World is left.
   * Returns false (and does nothing) for a key that isn't attached. The context and core stay alive.
   */
  releaseWorld(key: WorldKey): boolean {
    const share = this.shares.get(key);
    if (!share) return false;
    share.released = true;
    // The key stays taken while listeners run, so a listener attaching a World can't be handed it mid-release.
    each(this.listeners, (l) => l.onWorldReleased?.(key, share.owner));
    this.shares.delete(key);
    this.byOwner.delete(share.owner);
    if (this.shares.size === 0) each(this.listeners, (l) => l.onIdle?.());
    return true;
  }

  /** The live share for `key`, or null. */
  worldShare(key: WorldKey): WorldShare | null {
    return this.shares.get(key) ?? null;
  }

  /** How many Worlds hold a share. */
  get worldCount(): number {
    return this.shares.size;
  }

  /** Calls `fn(key, owner)` for every World holding a share (the audio system reports which of them has the view, A3.4b). */
  forEachWorld(fn: (key: WorldKey, owner: object) => void): void {
    for (const share of this.shares.values()) fn(share.key, share.owner);
  }

  // --- Visibility and device hooks (A3.4b; architecture §3.7, §3.8; `background.ts` decides, these touch the context) ---

  /** What the classifier (`deviceChange.ts`) reads of the context now. */
  snapshot(): DeviceSnapshot {
    const c = this.context as AudioContext & { sinkId?: unknown };
    return { state: c.state, rate: c.sampleRate, sink: typeof c.sinkId === "string" ? c.sinkId : "" };
  }

  /**
   * The rate a new context would get from the default output device, Hz, or null when it can't be told (no
   * `AudioContext`, or creating one failed). Makes and closes a throwaway context: call it only on a device event.
   */
  async probeDeviceRate(): Promise<number | null> {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) return null;
    let probe: AudioContext | null = null;
    try {
      probe = new Ctor();
      const rate = probe.sampleRate;
      return Number.isFinite(rate) && rate > 0 ? rate : null;
    } catch {
      return null;
    } finally {
      void probe?.close().catch(() => {});
    }
  }

  /**
   * Calls `listener` when the output device may have changed: the browser's `devicechange`, the context's `sinkchange`
   * (Chromium) and its `statechange`. Returns the removal; `close()` removes every one. The context's listeners follow
   * a rebuild onto a new context (A3.4c).
   */
  onDeviceEvent(listener: (kind: "device" | "state") => void): () => void {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const onDevice = () => listener("device");
    const onState = () => listener("state");
    md?.addEventListener?.("devicechange", onDevice);
    const offSink = this.listenOnContext("sinkchange", onDevice);
    const offState = this.listenOnContext("statechange", onState);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      md?.removeEventListener?.("devicechange", onDevice);
      offSink();
      offState();
      this.deviceRemovals.delete(remove);
    };
    this.deviceRemovals.add(remove);
    return remove;
  }

  /**
   * §3.8 `pause` policy: the page suspends the context. Sets `pageSuspended` first, so the unlock layer doesn't treat the
   * `statechange` as an outside suspend. Resolves true once the context is suspended; false (and the flag cleared) when
   * the suspend failed or the context isn't running.
   */
  async suspendForBackground(): Promise<boolean> {
    if (this.isClosed || this.context.state !== "running") return false;
    this.pageSuspended = true;
    try {
      await this.context.suspend();
    } catch {
      this.pageSuspended = false;
      return false;
    }
    if ((this.context.state as string) === "suspended") return true;
    this.pageSuspended = false;
    return false;
  }

  /**
   * §3.8 on becoming visible: ends the page's own suspend and resumes the context. A resume the browser refuses (no
   * gesture since) leaves the unlock layer armed, so the next gesture does it. Resolves true when the context runs.
   * A context the page hadn't suspended is only checked, never resumed here (`resumeContext` does that).
   */
  async resumeFromBackground(): Promise<boolean> {
    const mine = this.pageSuspended;
    this.pageSuspended = false;
    if (!mine) return this.context.state === "running";
    return this.resumeContext();
  }

  /** Resumes the context; when the browser refuses it, arms the unlock layer for the next gesture. True when it runs. */
  async resumeContext(): Promise<boolean> {
    if (this.isClosed) return false;
    try {
      await this.context.resume();
    } catch {
      /* needs a gesture: the unlock layer takes it */
    }
    if (this.context.state === "running") return true;
    this.unlock.arm();
    return false;
  }

  // --- Reconfigure (Engine.ts; api §3 "Bus state serialisation") ---

  /** The bus names the core was last configured with, by index (root first). Empty before the first `reconfigure`. */
  get busNames(): readonly string[] {
    return this.names;
  }

  /** Bumped by every `reconfigure` that changes the bus names; 0 before the first. */
  get busEpoch(): number {
    return this.epoch;
  }

  /** The preset the running core was initialised with. */
  get preset(): CorePreset {
    return this.currentPreset;
  }

  /**
   * A preset that differs from the running core's, set by `reconfigure`; null when they match. The core's memory is
   * laid out at init, so it applies at the next rebuild (A3.4a), never mid-session.
   */
  get pendingPreset(): CorePreset | null {
    return this.nextPreset;
  }

  /**
   * `Engine.ts` reconfigured the one mixer (each Engine's `create`: the editor's, then play mode's). Takes the bus
   * names from `settings.buses`; if they differ from `busNames`, bumps `busEpoch`, runs every `onBusRemap` with
   * `busRemap(old, new)` and returns the remap (the first call, from no names, remaps nothing but still bumps). Returns
   * null when the names are unchanged. Also sets `pendingPreset` from `presetFromSettings(settings)`, and queues a
   * mode rebuild when `audio.rhythmMode` differs from the running context's (ADR 0166 §4.6).
   */
  reconfigure(settings: AudioSettings): BusRemap | null {
    const preset = presetFromSettings(settings);
    this.nextPreset = presetsEqual(preset, this.currentPreset) ? null : preset;
    // ADR 0166 §4.6: a change of `audio.rhythmMode` rebuilds the context with the other hint (rate-limited).
    this.wantRhythm = settings.rhythmMode === true;
    this.queueModeRebuild();
    const to = settings.buses.map((b) => b.name);
    if (this.epoch > 0 && sameNames(this.names, to)) return null;
    const from = this.names;
    const remap: BusRemap = { epoch: ++this.epoch, from, to, map: busRemap(from, to) };
    this.names = to;
    each(this.listeners, (l) => l.onBusRemap?.(remap));
    return remap;
  }

  /** Adds lifecycle hooks (the seams for A1.1, A1.3a, A1.4); returns the removal. */
  addLifecycleListener(listener: HostLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** §4.7 Starting timeout: counted only while the context runs, since a locked context renders nothing. */
  private startTimeout(): void {
    if (this.timeout !== null || this.link.readyState !== "pending" || this.context.state !== "running") return;
    const ms = this.statusTimeoutMs;
    this.timeout = setTimeout(() => this.link.fail(new Error(`audio core: no STATUS within ${ms} ms`)), ms);
  }

  private clearTimeout(): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  // --- The hard rebuild (A3.4a; architecture §3.6). `recovery.ts` drives these; nothing else should call them. ---

  /**
   * `processorerror` (an error outside the shell's trap catch) on the current node is a trap like any other: it is
   * handed to the link's shell listeners as one. Fakes without `addEventListener` are skipped.
   */
  private watchNode(node: AudioWorkletNode): void {
    const target = node as unknown as Partial<Pick<EventTarget, "addEventListener">>;
    if (typeof target.addEventListener !== "function") return;
    target.addEventListener("processorerror", () => {
      if (node === this.currentNode && !this.isClosed) this.link.handleMessage({ type: "trap", message: "processorerror" } satisfies CoreShellEvent);
    });
  }

  /** @internal Enters Recovering and runs every `onRebuildStart`. */
  _beginRebuild(reason: string): void {
    this.recovering = true;
    each(this.listeners, (l) => l.onRebuildStart?.(reason));
  }

  /**
   * @internal Replaces the core: retires and disconnects the old node, makes a new one in the same context
   * (`respawn`: a new Memory, init with the running preset, which sets the limiter's look-ahead again), rebinds the
   * link to its port and resolves on its first ready STATUS. Rejects when the host can't rebuild, is closed, or the
   * new core fails (a shell error, an ABI mismatch, or no STATUS within `FIRST_STATUS_TIMEOUT_MS` of running).
   * `pendingPreset` is not applied: the voice table and the clock were sized for the running preset.
   * `timeoutMs` (A3.4c) shortens the first-STATUS wait (a stall rebuild escalates sooner).
   */
  async _replaceCore(timeoutMs = FIRST_STATUS_TIMEOUT_MS): Promise<void> {
    if (this.isClosed) throw new Error("audio core: the host is closed");
    if (!this.respawn) throw new Error("audio core: this host can't make a new node");
    this.currentNode.disconnect();
    const { node, port } = this.respawn();
    this.currentNode = node;
    this.watchNode(node);
    this.link._rebind(port);
    await this.awaitFirstStatus(timeoutMs);
  }

  /** The link's `ready` for the core just bound, with the first-STATUS timeout (counted while the context runs). */
  private async awaitFirstStatus(timeoutMs: number): Promise<void> {
    const ready = this.link.ready;
    this.clearTimeout();
    this.statusTimeoutMs = timeoutMs;
    this.startTimeout();
    void ready.then(
      () => this.clearTimeout(),
      () => this.clearTimeout(),
    );
    await ready;
  }

  /**
   * @internal A3.4c (architecture §3.7): replaces the context. Retires and disconnects the node, takes the host's
   * listeners off the old context and disposes its unlock layer, closes it, and makes a new one (`recreate`: at the
   * device's rate, the worklet module added, a new node and core initialised with the running preset at the new rate,
   * a new unlock layer). The host's `statechange` and `onDeviceEvent` listeners move to it, the unlock layer is armed
   * when it starts suspended (autoplay; it keeps watching with the same `pageSuspended` rule), every
   * `onContextReplaced` runs, and the link is rebound to the new node's port. Resolves on its first ready STATUS (the
   * timeout counts only while it runs, so a locked one waits for the gesture). If the page's background policy had
   * suspended the old context, the new one is suspended again once its core answered (`pageSuspended` stays set).
   * Rejects when the host can't recreate, is closed, or the new context or core fails.
   */
  async _replaceContext(timeoutMs = FIRST_STATUS_TIMEOUT_MS): Promise<void> {
    if (this.isClosed) throw new Error("audio core: the host is closed");
    if (!this.recreate) throw new Error("audio core: this host can't make a new context");
    const old = this.currentContext;
    this.clearTimeout();
    this.link.retire();
    this.currentNode.disconnect();
    for (const { type, fn } of this.contextListeners) old.removeEventListener(type, fn);
    this.currentUnlock.dispose();
    if (old.state !== "closed") await old.close().catch(() => {});
    // ADR 0166 §4.6: the new context gets the hint for the mode the settings ask for now (a device or rate rebuild too).
    const rhythm = this.wantRhythm;
    const parts = await this.recreate({ latencyHint: latencyHintFor(rhythm) });
    if (this.isClosed) {
      void parts.context.close().catch(() => {});
      throw new Error("audio core: the host is closed");
    }
    this.currentContext = parts.context;
    this.currentNode = parts.node;
    this.respawn = parts.respawn;
    this.currentUnlock = parts.unlock;
    this.contextRhythm = rhythm;
    this.latencyTrack = { since: this.now(), first: Number.NaN, changed: false };
    for (const { type, fn } of this.contextListeners) parts.context.addEventListener(type, fn);
    if (parts.context.state !== "running") parts.unlock.arm();
    parts.unlock.watch(() => this.pageSuspended);
    this.watchNode(parts.node);
    this.link._rebind(parts.port);
    each(this.listeners, (l) => l.onContextReplaced?.(parts.context.sampleRate));
    await this.awaitFirstStatus(timeoutMs);
    // §3.8 `pause`: the page had suspended the old context while hidden; the new one stays suspended too.
    if (this.pageSuspended && this.currentContext.state === "running") await this.currentContext.suspend().catch(() => {});
  }

  /** @internal Leaves Recovering (the new core runs) and runs every `onRebuilt`. */
  _endRebuild(): void {
    this.recovering = false;
    each(this.listeners, (l) => l.onRebuilt?.());
    // ADR 0166 §4.6: a mode change that arrived during a rebuild that kept the context (a trap) is built now.
    this.queueModeRebuild();
  }

  /**
   * @internal §2.1 Failed after recovery: silent for the session (the node is retired and disconnected; no switch to
   * another backend mid-session), `status` reads `"failed"`, every `onRecoveryFailed` runs. The host stays open, so
   * Worlds keep their shares. A second call does nothing.
   */
  _markRecoveryFailed(): void {
    if (this.recoveryFailed) return;
    this.recoveryFailed = true;
    this.recovering = false;
    this.clearTimeout();
    this.link.retire();
    this.currentNode.disconnect();
    each(this.listeners, (l) => l.onRecoveryFailed?.());
  }

  /**
   * Closes the context and stops listening. Marks the host closed, runs every `onClose` and drops every share
   * (without `onWorldReleased`: nothing is left to stop). A second call does nothing.
   */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const share of this.shares.values()) share.released = true;
    this.shares.clear();
    this.byOwner.clear();
    each(this.listeners, (l) => l.onClose?.());
    this.listeners.clear();
    for (const remove of [...this.deviceRemovals]) remove();
    this.clearTimeout();
    this.cancelModeRebuild();
    // A rebuild waiting for its new core's first STATUS ends now rather than never (A3.4a).
    if (this.recovering) this.link.fail(new Error("audio core: the host closed"));
    for (const { type, fn } of this.contextListeners) this.context.removeEventListener(type, fn);
    this.contextListeners.clear();
    this.unlock.dispose();
    this.link.dispose();
    this.node.disconnect();
    if (this.context.state !== "closed") await this.context.close();
  }
}

/**
 * §3.1 (and §3.7's new context, A3.4c): creates an AudioContext (`latencyHint` `"interactive"`, or `0` in rhythm mode,
 * ADR 0166 §4.6; no `sampleRate`: the output device's), adds the worklet module, makes the first node with the wasm
 * bytes and the preset, connected to the output, and an unlock layer on `unlockTarget` (armed by the host when the
 * context isn't running). Closes the context again when any step fails.
 */
async function openCoreContext(wasm: CoreWasm, moduleUrl: string, preset: CorePreset, unlockTarget: EventTarget, latencyHint: LatencyHint = DEFAULT_LATENCY_HINT): Promise<ContextParts> {
  const context = newAudioContext(latencyHint);
  try {
    await context.audioWorklet.addModule(moduleUrl);
    // The module stays added to the context, so a same-context rebuild (A3.4a) only makes another node:
    // `processorOptions` are cloned into the new processor, which instantiates the wasm over a new Memory (the same
    // running preset; init sets the limiter's look-ahead for the context's rate).
    const respawn = () => {
      const processorOptions: CoreProcessorOptions = { wasm: wasm.bytes, preset };
      const node = new AudioWorkletNode(context, PROCESSOR_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions });
      node.connect(context.destination);
      return { node, port: node.port as unknown as LinkPort };
    };
    const { node, port } = respawn();
    // onUnlocked does nothing: the host's statechange listener starts the first-STATUS clock.
    const unlock = new Unlock({ target: unlockTarget, context });
    return { context, node, port, unlock, respawn };
  } catch (error) {
    void context.close().catch(() => {});
    throw error;
  }
}

/**
 * An AudioContext with `latencyHint`. A browser that refuses a numeric hint (the spec allows one; an old engine may
 * throw) gets `"interactive"`, and `AudioHost.latency` reports what that gave.
 */
function newAudioContext(latencyHint: LatencyHint): AudioContext {
  if (typeof latencyHint === "number") {
    try {
      return new AudioContext({ latencyHint });
    } catch {
      return new AudioContext({ latencyHint: DEFAULT_LATENCY_HINT });
    }
  }
  return new AudioContext({ latencyHint });
}

// --- The page singleton (architecture §1: one host per page serves every Engine and World) ---

/**
 * @internal The page's host: returns the live one, or the start already under way, else calls `start` and keeps
 * what it resolves. A failed start isn't kept (the next acquire tries again), nor is a closed host. This holds even
 * when the World service is registered again (plugin re-activation), whose fresh `load` would otherwise make a
 * second AudioContext.
 */
export function acquireAudioHost(start: () => Promise<AudioHost>): Promise<AudioHost> {
  if (pageHost && !pageHost.closed) return Promise.resolve(pageHost);
  pageHost = null;
  if (pageStart) return pageStart;
  const pending: Promise<AudioHost> = start().then(
    (host) => {
      if (pageStart === pending) {
        pageStart = null;
        pageHost = host;
      }
      return host;
    },
    (error: unknown) => {
      if (pageStart === pending) pageStart = null;
      throw error;
    },
  );
  pageStart = pending;
  return pending;
}

/** @internal The page's live host, or null (none started, still starting, or closed). */
export function currentAudioHost(): AudioHost | null {
  return pageHost && !pageHost.closed ? pageHost : null;
}

/** @internal Tests: closes the page's host (if any) and forgets it and any pending start. */
export async function _resetAudioHostForTests(): Promise<void> {
  const host = pageHost;
  pageHost = null;
  pageStart = null;
  if (host) await host.close();
}

let pageHost: AudioHost | null = null;
let pageStart: Promise<AudioHost> | null = null;

/** @internal Loads the core and starts the host for `settings` (the `myco.audio` service's `load`), once per page. */
export async function startAudioHost(settings: AudioSettings, unlockTarget: EventTarget = document): Promise<AudioHost> {
  return acquireAudioHost(async () => {
    const [wasm, moduleUrl] = await Promise.all([loadCoreWasm(), workletModuleUrl()]);
    return AudioHost._startNew(wasm, moduleUrl, presetFromSettings(settings), unlockTarget, settings.rhythmMode === true);
  });
}

/** @internal Re-exported so the dev page and tests name one type. */
export type { CoreControlMessage };
