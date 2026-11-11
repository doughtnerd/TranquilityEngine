// Zone impulse-response preparation, main's side (ADR 0162; architecture §2.2; C9; K0's `ZoneIrService`). The zone
// manager (`zones.ts`) asks for a kernel from an IR asset or a built-in preset at the context rate; the decoder worker
// fetches and keeps the encoded bytes, prepares the kernel, and sends it straight to the worklet as format-3 clip chunks
// under the kernel's id (`decoder/irPrepare.ts`). Main never holds kernels or time-domain IRs: it hears `irPrepared`
// (frames, truncation, timing) or `irFailed` and keeps only the request that made each kernel, to answer repeats and to
// ask again after a rate change or a hard rebuild (`reprepareAll`: the worker prepares from the bytes it kept, without
// fetching again).
import type { ZoneIrService } from "../backend";
import { createDecoderClient } from "../decoder/decoderClient";
import type { IrFailedMessage, IrPreparedMessage, IrRequest } from "../decoder/protocol";

/** What the service needs of the decoder worker: the client's IR half. */
export interface ZoneIrChannel {
  postIr(request: IrRequest): void;
  onIr(listener: (reply: IrPreparedMessage | IrFailedMessage) => void): () => void;
}

/** @internal What C2b's service is built on; the core backend passes what it has. */
export interface ZoneIrDeps {
  /** The context's rate now (kernels are prepared at it). */
  readonly sampleRate?: number;
  /** The decoder worker (default: the page's shared client, which spawns its worker on the first request). */
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
}

const same = (e: Entry, r: { assetUrl?: string; preset?: string; contextRate: number; maxFrames: number }) =>
  e.assetUrl === r.assetUrl && e.preset === r.preset && e.contextRate === r.contextRate && e.maxFrames === r.maxFrames;

/** @internal The zone IR service the core backend constructs. */
export function createZoneIrService(deps: ZoneIrDeps = {}): ZoneIrService {
  let channel: ZoneIrChannel | null = deps.decoder ?? null;
  let unsubscribe: (() => void) | null = null;
  let nextToken = 1;
  let disposed = false;
  const entries = new Map<number, Entry>();
  /** In-flight worker requests: token to kernel id. A reply whose token isn't here (released, asked again) is ignored. */
  const inflight = new Map<number, number>();

  const decoder = (): ZoneIrChannel => {
    if (!channel) channel = createDecoderClient();
    if (!unsubscribe) unsubscribe = channel.onIr(onReply);
    return channel;
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

  /** Sends the worker's request for `entry` under a new token (which supersedes any earlier one for the kernel). */
  const send = (kernelId: number, entry: Entry): number => {
    for (const [token, id] of inflight) if (id === kernelId) inflight.delete(token);
    const token = nextToken++;
    inflight.set(token, kernelId);
    const common = { token, kernelId, contextRate: entry.contextRate, maxFrames: entry.maxFrames };
    decoder().postIr(entry.assetUrl !== undefined ? { type: "prepareIr", assetUrl: entry.assetUrl, ...common } : { type: "generateIr", preset: entry.preset ?? "", ...common });
    return token;
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
      const entry: Entry = { assetUrl: request.assetUrl, preset: request.preset, contextRate: request.contextRate, maxFrames: request.maxFrames, state: "pending", frames: 0, truncated: false, waiters: [token] };
      // A changed request for a held id replaces it; requests still waiting on the old one are told so.
      const stale = have?.waiters ?? [];
      if (stale.length) queueMicrotask(() => stale.forEach((t) => service.onFailed?.({ token: t, kernelId: request.kernelId, code: ZONE_IR_NOT_AVAILABLE, message: "zone impulse response replaced by a newer request" })));
      entries.set(request.kernelId, entry);
      send(request.kernelId, entry);
      return token;
    },
    release(kernelId) {
      if (!entries.delete(kernelId)) return;
      for (const [token, id] of inflight) if (id === kernelId) inflight.delete(token);
      decoder().postIr({ type: "releaseIr", kernelId });
    },
    reprepareAll(contextRate) {
      if (disposed) return;
      for (const [kernelId, entry] of entries) {
        entry.contextRate = contextRate;
        entry.state = "pending";
        // The zone manager hears `onPrepared` again under this token once the kernel is back in the (new) worklet.
        entry.waiters.push(send(kernelId, entry));
      }
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      entries.clear();
      inflight.clear();
    },
  };
  return service;
}
