// Zone impulse-response preparation, main's side (ADR 0162; architecture §2.2; C9; K0's `ZoneIrService`). The zone
// manager (`zones.ts`) asks for a kernel from an IR asset or a built-in preset at the context rate; the decoder worker
// fetches and keeps the encoded bytes, prepares the kernel, and sends it straight to the worklet as format-3 clip chunks
// under the kernel's id (`decoder/irPrepare.ts`). Main never holds kernels or time-domain IRs: it hears `irPrepared`
// (frames, truncation, timing) or `irFailed` and keeps only the request that made each kernel, to answer repeats and to
// ask again after a rate change or a hard rebuild (`reprepareAll`: the worker prepares from the bytes it kept, without
// fetching again).
//
// The kernel travels on the decoder worker ↔ worklet channel, the one streams use (`workletChannel.ts`): the core
// backend passes its `WorkletChannel`, and every request first `ensure()`s it, so a zone asked for before any stream
// opened connects the worker to the worklet itself. When the channel is renewed (a respawned decoder worker, a new
// worklet node, or another user reconnecting), the worklet frees the kernels the old channel brought, so every kernel
// sent on an older channel is prepared again on the new one (its waiters hear `onPrepared` again).
import type { ZoneIrService } from "../backend";
import { createDecoderClient } from "../decoder/decoderClient";
import type { IrFailedMessage, IrPreparedMessage, IrRequest } from "../decoder/protocol";

/** What the service needs of the decoder worker: the client's IR half. */
export interface ZoneIrChannel {
  postIr(request: IrRequest): void;
  onIr(listener: (reply: IrPreparedMessage | IrFailedMessage) => void): () => void;
}

/** @internal The worker ↔ worklet channel as the service uses it (the backend's `WorkletChannel`). */
export interface ZoneIrWorklet {
  /** The decoder, connected to the current worklet (a new channel first when needed; may throw when it can't). */
  ensure(): ZoneIrChannel;
  /** Channels connected so far: a change means the worklet holds none of the kernels sent before it. */
  readonly connections: number;
  /** Called after each new channel (the service re-sends what it sent on an older one); returns the unsubscribe. */
  onConnect(listener: () => void): () => void;
}

/** @internal What C2b's service is built on; the core backend passes what it has. */
export interface ZoneIrDeps {
  /** The context's rate now (kernels are prepared at it). */
  readonly sampleRate?: number;
  /**
   * The decoder worker connected to the worklet (the core backend's channel, shared with streams). Without it the
   * service posts to `decoder` (tests with a fake that answers itself) or the page's shared client, which nothing
   * connects to a worklet: a real worker then answers "no worklet port".
   */
  readonly worklet?: ZoneIrWorklet;
  /** The decoder worker when there is no `worklet` (default: the page's shared client). */
  readonly decoder?: ZoneIrChannel;
}

/** @internal `irFailed` code for a request the service itself refuses. */
export const ZONE_IR_NOT_AVAILABLE = 1;

/** One kernel main knows of: what it was asked for, and where it stands. */
interface Entry {
  assetUrl?: string;
  preset?: string;
  contextRate: number;
  maxFrames: number;
  state: "pending" | "ready";
  frames: number;
  truncated: boolean;
  /** Tokens to answer when the worker replies (the requests that wait on this kernel). */
  waiters: number[];
  /** The channel (`ZoneIrWorklet.connections`) its last request went out on; -1 while one is being sent. */
  sentOn: number;
}

const same = (e: Entry, r: { assetUrl?: string; preset?: string; contextRate: number; maxFrames: number }) =>
  e.assetUrl === r.assetUrl && e.preset === r.preset && e.contextRate === r.contextRate && e.maxFrames === r.maxFrames;

/** @internal The zone IR service the core backend constructs. */
export function createZoneIrService(deps: ZoneIrDeps = {}): ZoneIrService {
  let fallback: ZoneIrChannel | null = deps.decoder ?? null;
  let subscribed: ZoneIrChannel | null = null;
  let unsubscribe: (() => void) | null = null;
  const unlisten = deps.worklet?.onConnect(() => renewed());
  let nextToken = 1;
  let disposed = false;
  const entries = new Map<number, Entry>();
  /** In-flight worker requests: token to kernel id. A reply whose token isn't here (released, asked again) is ignored. */
  const inflight = new Map<number, number>();

  /** The decoder for a request, its replies subscribed: connected to the worklet first when there is a `worklet`. */
  const decoder = (): ZoneIrChannel => {
    let channel: ZoneIrChannel;
    if (deps.worklet) channel = deps.worklet.ensure();
    else channel = fallback ??= createDecoderClient();
    if (subscribed !== channel) {
      unsubscribe?.();
      subscribed = channel;
      unsubscribe = channel.onIr(onReply);
    }
    return channel;
  };

  /** A new channel: every kernel that went out on an older one is gone from the worklet, so it is asked for again. */
  const renewed = (): void => {
    if (disposed || !deps.worklet) return;
    const now = deps.worklet.connections;
    for (const [kernelId, entry] of entries) {
      if (entry.sentOn === -1 || entry.sentOn === now) continue;
      entry.state = "pending";
      send(kernelId, entry, true);
    }
  };

  const onReply = (reply: IrPreparedMessage | IrFailedMessage): void => {
    const kernelId = inflight.get(reply.token);
    if (kernelId === undefined) return;
    inflight.delete(reply.token);
    const entry = entries.get(kernelId);
    if (!entry || entry.state !== "pending") return;
    const waiters = entry.waiters;
    entry.waiters = [];
    if (reply.type === "irPrepared") {
      entry.state = "ready";
      entry.frames = reply.frames;
      entry.truncated = reply.truncated;
      waiters.forEach((token, i) => service.onPrepared?.({ token, kernelId, frames: reply.frames, truncated: reply.truncated, prepareMs: i === 0 ? reply.prepareMs : 0 }));
    } else {
      // Forget it, so asking again sends a fresh request.
      entries.delete(kernelId);
      for (const token of waiters) service.onFailed?.({ token, kernelId, code: reply.code, message: reply.message });
    }
  };

  /**
   * Sends the worker's request for `entry` under a new token (which supersedes any earlier one for the kernel);
   * `wait`: the token also waits for the reply (a re-preparation, whose `onPrepared` the zone manager hears again).
   * A channel that can't be connected fails the kernel's waiters.
   */
  const send = (kernelId: number, entry: Entry, wait: boolean): void => {
    for (const [token, id] of inflight) if (id === kernelId) inflight.delete(token);
    const token = nextToken++;
    if (wait) entry.waiters.push(token);
    // Not on any channel while this one connects (a renewal it triggers mustn't send it a second time).
    entry.sentOn = -1;
    let channel: ZoneIrChannel;
    try {
      channel = decoder();
    } catch (e) {
      const waiters = entry.waiters;
      entry.waiters = [];
      if (entries.get(kernelId) === entry) entries.delete(kernelId);
      const message = `zone impulse responses: no channel to the worklet (${e instanceof Error ? e.message : String(e)})`;
      queueMicrotask(() => waiters.forEach((t) => service.onFailed?.({ token: t, kernelId, code: ZONE_IR_NOT_AVAILABLE, message })));
      return;
    }
    inflight.set(token, kernelId);
    entry.sentOn = deps.worklet?.connections ?? 0;
    const common = { token, kernelId, contextRate: entry.contextRate, maxFrames: entry.maxFrames };
    channel.postIr(entry.assetUrl !== undefined ? { type: "prepareIr", assetUrl: entry.assetUrl, ...common } : { type: "generateIr", preset: entry.preset ?? "", ...common });
  };

  const service: ZoneIrService = {
    onPrepared: null,
    onFailed: null,
    prepare(request) {
      const token = nextToken++;
      if (disposed || (request.assetUrl === undefined) === (request.preset === undefined)) {
        const message = disposed ? "zone impulse responses: the service was disposed" : "zone impulse responses: a request names an asset or a preset, one of them";
        queueMicrotask(() => service.onFailed?.({ token, kernelId: request.kernelId, code: ZONE_IR_NOT_AVAILABLE, message }));
        return token;
      }
      const have = entries.get(request.kernelId);
      if (have && same(have, request)) {
        if (have.state === "pending") have.waiters.push(token);
        else {
          // Prepared at this rate already: answered at once (a microtask, never inside the caller's `prepare`).
          const { frames, truncated } = have;
          queueMicrotask(() => {
            if (entries.get(request.kernelId) === have) service.onPrepared?.({ token, kernelId: request.kernelId, frames, truncated, prepareMs: 0 });
          });
        }
        return token;
      }
      const entry: Entry = { assetUrl: request.assetUrl, preset: request.preset, contextRate: request.contextRate, maxFrames: request.maxFrames, state: "pending", frames: 0, truncated: false, waiters: [token], sentOn: -1 };
      // A changed request for a held id replaces it; requests still waiting on the old one are told so.
      const stale = have?.waiters ?? [];
      if (stale.length) queueMicrotask(() => stale.forEach((t) => service.onFailed?.({ token: t, kernelId: request.kernelId, code: ZONE_IR_NOT_AVAILABLE, message: "zone impulse response replaced by a newer request" })));
      entries.set(request.kernelId, entry);
      send(request.kernelId, entry, false);
      return token;
    },
    release(kernelId) {
      if (!entries.delete(kernelId)) return;
      for (const [token, id] of inflight) if (id === kernelId) inflight.delete(token);
      // The worker that holds it (none subscribed: nothing was ever sent). A worker since replaced holds nothing, and
      // the worklet frees what the old one sent when the next channel connects.
      (deps.worklet ? subscribed : decoder())?.postIr({ type: "releaseIr", kernelId });
    },
    reprepareAll(contextRate) {
      if (disposed) return;
      // Every one goes again, so none is re-sent by the renewal the first send may trigger.
      for (const entry of entries.values()) entry.sentOn = -1;
      for (const [kernelId, entry] of entries) {
        entry.contextRate = contextRate;
        entry.state = "pending";
        // The zone manager hears `onPrepared` again under this token once the kernel is back in the (new) worklet.
        send(kernelId, entry, true);
      }
    },
    dispose() {
      disposed = true;
      unlisten?.();
      unsubscribe?.();
      unsubscribe = null;
      entries.clear();
      inflight.clear();
    },
  };
  return service;
}
