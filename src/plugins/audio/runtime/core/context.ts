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
import { loadCoreWasm, workletModuleUrl, type CoreWasm } from "./loader";
import { Unlock } from "./unlock";

/** @internal §2.1's states as `Audio.status` reports them. */
export type HostStatus = "locked" | "running" | "failed";

/** @internal §4.7: Starting fails when no first STATUS arrives within 5 s of the context running. */
export const FIRST_STATUS_TIMEOUT_MS = 5_000;
/** @internal §5.1 default preset: the clip arena's initial reserve. */
export const ARENA_INITIAL_BYTES = 16 << 20;
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
  /** Resolves on the first STATUS with the ready flag and this ABI's major; rejects on a shell error or a mismatch. */
  readonly ready: Promise<void>;
  /** Whether `ready` settled, and how. */
  readyState: "pending" | "ready" | "failed" = "pending";

  private seq = 0;
  private pingSeq = 0;
  private settle!: (error?: Error) => void;
  private readonly statusListeners = new Set<(status: StatusBlock) => void>();
  private readonly shellListeners = new Set<(event: CoreShellEvent) => void>();

  constructor(private readonly port: LinkPort) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settle = (error) => {
        if (this.readyState !== "pending") return;
        this.readyState = error ? "failed" : "ready";
        if (error) reject(error);
        else resolve();
      };
    });
    // A failure is also reported through `readyState`; don't let an unobserved `ready` raise an unhandled rejection.
    this.ready.catch(() => {});
    port.onmessage = (event) => this.handleMessage(event.data);
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
        status = readStatus(data);
      } catch {
        // A block we can't read still goes back, or the shell's pool shrinks.
      }
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

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    return seq;
  }

  /** Stops listening to the port. */
  dispose(): void {
    this.port.onmessage = null;
    this.statusListeners.clear();
    this.shellListeners.clear();
  }
}

/** @internal The page's audio host (M1a.0): context, node, link and unlock. */
export class AudioHost {
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private readonly onStateChange = () => this.startTimeout();

  private constructor(
    readonly context: AudioContext,
    readonly node: AudioWorkletNode,
    readonly link: CoreLink,
    readonly unlock: Unlock,
  ) {
    context.addEventListener("statechange", this.onStateChange);
    this.startTimeout();
    void link.ready.then(
      () => this.clearTimeout(),
      () => this.clearTimeout(),
    );
  }

  /**
   * §3.1: creates the AudioContext (`latencyHint: "interactive"`; suspended when autoplay is blocked), adds the
   * worklet module, creates the node with the wasm bytes and the preset, connects it, and arms the unlock layer on
   * `unlockTarget` when the context isn't running. Resolves once the node exists, before the first STATUS (a
   * locked context renders nothing until the gesture).
   */
  static async start(wasm: CoreWasm, moduleUrl: string, preset: CorePreset, unlockTarget: EventTarget): Promise<AudioHost> {
    const context = new AudioContext({ latencyHint: "interactive" });
    try {
      await context.audioWorklet.addModule(moduleUrl);
      const processorOptions: CoreProcessorOptions = { wasm: wasm.bytes, preset };
      const node = new AudioWorkletNode(context, PROCESSOR_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions });
      node.connect(context.destination);
      const link = new CoreLink(node.port as unknown as LinkPort);
      // onUnlocked does nothing: the statechange listener above starts the first-STATUS clock.
      const unlock = new Unlock({ target: unlockTarget, context });
      if (context.state !== "running") unlock.arm();
      return new AudioHost(context, node, link, unlock);
    } catch (error) {
      void context.close().catch(() => {});
      throw error;
    }
  }

  /** §2.1: Locked and Starting are `"locked"`, Failed `"failed"`, the rest `"running"`. */
  get status(): HostStatus {
    if (this.link.readyState === "failed" || this.context.state === "closed") return "failed";
    if (this.link.readyState === "pending" || this.context.state !== "running") return "locked";
    return "running";
  }

  /** §4.7 Starting timeout: counted only while the context runs, since a locked context renders nothing. */
  private startTimeout(): void {
    if (this.timeout !== null || this.link.readyState !== "pending" || this.context.state !== "running") return;
    this.timeout = setTimeout(() => this.link.fail(new Error(`audio core: no STATUS within ${FIRST_STATUS_TIMEOUT_MS} ms`)), FIRST_STATUS_TIMEOUT_MS);
  }

  private clearTimeout(): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  /** Closes the context and stops listening. */
  async close(): Promise<void> {
    this.clearTimeout();
    this.context.removeEventListener("statechange", this.onStateChange);
    this.unlock.dispose();
    this.link.dispose();
    this.node.disconnect();
    if (this.context.state !== "closed") await this.context.close();
  }
}

/** @internal Loads the core and starts the host for `settings` (the `myco.audio` service's `load`). */
export async function startAudioHost(settings: AudioSettings, unlockTarget: EventTarget = document): Promise<AudioHost> {
  const [wasm, moduleUrl] = await Promise.all([loadCoreWasm(), workletModuleUrl()]);
  return AudioHost.start(wasm, moduleUrl, presetFromSettings(settings), unlockTarget);
}

/** @internal Re-exported so the dev page and tests name one type. */
export type { CoreControlMessage };
