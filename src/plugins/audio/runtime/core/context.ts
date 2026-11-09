// The AudioHost's context half (ADR 0157; architecture §1, §2.1, §3.1, §4.5): one AudioContext per page, the
// worklet node running the core, and the main side of the port protocol. `service.ts` starts it at scene load;
// A0.8 adds its lifecycle across Engines and Worlds, A1.4 the command writer and status reader on top of
// `CoreLink`, A3.4b the visibility hooks.
//
// `CoreLink` is the port protocol with no Web Audio in it, so Node tests wire it straight to a `CoreDriver`:
// STATUS is copied in `onmessage` and its buffer goes back at once as RECYCLE (never waiting for a frame, so
// STATUS keeps flowing with frames stopped, §4.5); returned BATCH buffers go back to the host's pool.
import type { AudioSettings } from "../../../../engine/audio/settings";
import type { StatusBlock } from "../wire.generated";
import type { CoreControlMessage, CorePreset, CoreShellEvent } from "../worklet/coreDriver";
import { createBatchPool, type BufferPool } from "./bufferPool";
import type { CoreWasm } from "./loader";
import type { Unlock } from "./unlock";

/** @internal §2.1's states as `Audio.status` reports them. */
export type HostStatus = "locked" | "running" | "failed";

/** @internal §4.7: Starting fails when no first STATUS arrives within 5 s of the context running. */
export const FIRST_STATUS_TIMEOUT_MS = 5_000;
/** @internal §5.1 default preset: the clip arena's initial reserve. */
export const ARENA_INITIAL_BYTES = 16 << 20;
/** @internal §5.3: the clip ceiling when `audio.clipMemoryMB` is absent (the default preset's). */
export const DEFAULT_CLIP_CEILING_MB = 128;

/** @internal The init preset from the project's `audio` settings (§2, architecture §5.3). */
export function presetFromSettings(settings: AudioSettings): CorePreset {
  throw new Error("not implemented: A0.3");
}

/** @internal The side of a `MessagePort` the link uses (the node's port, or a fake wired to a `CoreDriver`). */
export interface LinkPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

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

  constructor(private readonly port: LinkPort) {
    throw new Error("not implemented: A0.3");
  }

  /** Calls `listener` with every STATUS block, in `onmessage`; returns the unsubscribe. */
  onStatus(listener: (status: StatusBlock) => void): () => void {
    throw new Error("not implemented: A0.3");
  }

  /** Calls `listener` with every shell event (`error`, `trap`); returns the unsubscribe. */
  onShellEvent(listener: (event: CoreShellEvent) => void): () => void {
    throw new Error("not implemented: A0.3");
  }

  /** Sends a TIME_PING and returns its `pingSeq`; a later STATUS echoes it. */
  ping(): number {
    throw new Error("not implemented: A0.3");
  }

  /** Dev only: a sine of `hz` at `gain` mixed onto the core's output in the shell; `hz <= 0` stops it. */
  debugTone(hz: number, gain = 0.1): void {
    throw new Error("not implemented: A0.3");
  }

  /** The port's `onmessage`: STATUS (copy, then RECYCLE at once), returned buffers, shell events. */
  handleMessage(data: unknown): void {
    throw new Error("not implemented: A0.3");
  }

  /** Stops listening to the port. */
  dispose(): void {
    throw new Error("not implemented: A0.3");
  }
}

/** @internal The page's audio host (M1a.0): context, node, link and unlock. */
export class AudioHost {
  private constructor(
    readonly context: AudioContext,
    readonly node: AudioWorkletNode,
    readonly link: CoreLink,
    readonly unlock: Unlock,
  ) {
    throw new Error("not implemented: A0.3");
  }

  /**
   * §3.1: creates the AudioContext (`latencyHint: "interactive"`; suspended when autoplay is blocked), adds the
   * worklet module, creates the node with the wasm bytes and the preset, connects it, and arms the unlock layer on
   * `unlockTarget` when the context isn't running. Resolves once the node exists, before the first STATUS (a
   * locked context renders nothing until the gesture).
   */
  static async start(wasm: CoreWasm, moduleUrl: string, preset: CorePreset, unlockTarget: EventTarget): Promise<AudioHost> {
    throw new Error("not implemented: A0.3");
  }

  /** §2.1: Locked and Starting are `"locked"`, Failed `"failed"`, the rest `"running"`. */
  get status(): HostStatus {
    throw new Error("not implemented: A0.3");
  }

  /** Closes the context and stops listening. */
  async close(): Promise<void> {
    throw new Error("not implemented: A0.3");
  }
}

/** @internal Loads the core and starts the host for `settings` (the `myco.audio` service's `load`). */
export async function startAudioHost(settings: AudioSettings, unlockTarget: EventTarget = document): Promise<AudioHost> {
  throw new Error("not implemented: A0.3");
}

/** @internal Re-exported so the dev page and tests name one type. */
export type { CoreControlMessage };
