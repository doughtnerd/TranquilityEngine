// The decoder worker ↔ worklet channel (B3; ADR 0162 C9): one `MessageChannel` with an end in the decoder worker
// (`connectWorklet`) and the other in the worklet (`CoreLink.connectStreamPort`). Streams' chunks and credits flow on it,
// and so do zone kernels (CLIP_BEGIN/CLIP_CHUNK format 3, `decoder/irPrepare.ts`), all without main. Both users go
// through `ensure()` before anything that needs the channel (a stream open, an IR request), so whichever comes first
// connects it. A channel is valid for one decoder worker (the client's `generation`, bumped by a spawn or a retire) and
// one worklet node: a respawned worker, a different client, or a node replaced by a hard rebuild (`disconnect()`)
// connects a new one on the next `ensure()`. `connections` counts them and `onConnect` tells each, so the zone IR
// service prepares its kernels again on a renewed channel (the worklet frees the kernels an old port brought).
import type { DecoderClient } from "../decoder/decoderClient";
import type { StreamPortLike } from "../decoder/protocol";

/** @internal What the channel needs of the decoder client. */
export type WorkletChannelDecoder = Pick<DecoderClient, "connectWorklet" | "generation">;

/** @internal The two ends of a channel. */
export interface StreamChannel {
  readonly worker: MessagePort | StreamPortLike;
  readonly worklet: MessagePort | StreamPortLike;
}

/** @internal What `WorkletChannel` takes. */
export interface WorkletChannelDeps<D extends WorkletChannelDecoder> {
  /** The decoder client (the page's shared one in the app; tests pass one on an in-process worker). */
  readonly decoder: () => D;
  /** Hands the worklet its end of a channel (`CoreLink.connectStreamPort`). */
  readonly connectWorklet: (port: MessagePort | StreamPortLike) => void;
  /** Makes a channel; default `new MessageChannel()`. */
  readonly channel?: () => StreamChannel;
}

/** @internal The one channel streams and zone IRs share (the core backend makes it). */
export class WorkletChannel<D extends WorkletChannelDecoder = WorkletChannelDecoder> {
  /** Channels connected so far (the current one's number; 0 before the first). */
  connections = 0;
  private connectedTo: D | null = null;
  private connectedGeneration = -1;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: WorkletChannelDeps<D>) {}

  /** The decoder, connected to the current worklet: a new channel first when its worker or the node changed. */
  ensure(): D {
    const decoder = this.deps.decoder();
    if (this.connectedTo !== decoder || this.connectedGeneration === -1 || this.connectedGeneration !== decoder.generation) {
      const channel = this.deps.channel?.() ?? defaultChannel();
      decoder.connectWorklet(channel.worker);
      this.deps.connectWorklet(channel.worklet);
      // Read after `connectWorklet`, which spawns the worker when there is none (and bumps the generation).
      this.connectedGeneration = decoder.generation;
      this.connectedTo = decoder;
      this.connections++;
      for (const listener of [...this.listeners]) listener();
    }
    return decoder;
  }

  /** `listener` runs after each new channel (inside the `ensure()` that made it); returns the unsubscribe. */
  onConnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The worklet node is being replaced (a hard rebuild): the next `ensure()` connects a new channel to the new node. */
  disconnect(): void {
    this.connectedGeneration = -1;
  }
}

function defaultChannel(): StreamChannel {
  const c = new MessageChannel();
  return { worker: c.port1, worklet: c.port2 };
}
