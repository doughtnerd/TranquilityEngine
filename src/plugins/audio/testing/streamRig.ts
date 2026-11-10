// The loopback rig for streams (B3, shared with B4's loop-seam test): the core backend on the loopback host (the real
// mixer wasm in Node) with the real decoder handler in process behind a WorkerLike, and a stream port straight from
// the "worker" to the shell. Test-only (imports vitest); moved here from streamLoopback.test.ts.
import { expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mixer } from "../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../engine/audio/settings";
import hash from "../runtime/wasm/hash.json";
import { createDecoderHandler } from "../runtime/decoder/handler";
import { createDecoderClient, type WorkerLike } from "../runtime/decoder/decoderClient";
import type { DecoderReply, StreamPortLike } from "../runtime/decoder/protocol";
import type { AudioHost, CoreLink } from "../runtime/core/context";
import { CoreBackend, type CoreBackendHost } from "../runtime/core/coreBackend";
import type { CoreDriver } from "../runtime/worklet/coreDriver";

const WASM = readFileSync(fileURLToPath(new URL("../runtime/wasm/myco_audio_decode.wasm", import.meta.url)));
export const decoderWasm = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
export const RATE = 48_000;
/** Quanta per frame (a 60 Hz frame is 6.25 quanta at 48 kHz; 4 keeps the arithmetic whole). */
export const QPF = 4;
export const FRAME_MS = (QPF * 128 * 1000) / RATE;
/** 5 ms at 48 kHz: the starvation fade. */
export const FADE = 240;

/** A queued two-ended port pair: `pump()` delivers what was posted, both ways, until both queues are empty. */
export function channel() {
  const toA: unknown[] = [];
  const toB: unknown[] = [];
  const a: StreamPortLike = { onmessage: null, postMessage: (m) => void toB.push(m) };
  const b: StreamPortLike = { onmessage: null, postMessage: (m) => void toA.push(m) };
  return {
    a,
    b,
    /** Delivers queued messages; `aStalled` holds those to `a` (the worker) back. */
    pump(aStalled = false) {
      for (let guard = 0; guard < 1000 && (toB.length || (!aStalled && toA.length)); guard++) {
        for (const m of toB.splice(0)) b.onmessage?.({ data: m });
        if (!aStalled) for (const m of toA.splice(0)) a.onmessage?.({ data: m });
      }
    },
  };
}

/** What `rig` takes besides the files (B4). */
export interface RigOptions {
  /** The decoder wasm's bytes (default the committed `myco_audio_decode.wasm`; B4 passes the AAC build). */
  readonly decoderWasm?: ArrayBuffer;
  /** The clip registry's format (default 0, f32). */
  readonly clipFormat?: number;
  /** Files the clip registry fetches (default: none, every clip fetch gives 8 bytes). */
  readonly clipFiles?: Record<string, ArrayBuffer>;
  /** `audio.codecs.aac` for the registry and the backend's settings (B4). */
  readonly aac?: boolean;
}

export async function rig(files: Record<string, ArrayBuffer>, options: RigOptions = {}) {
  const testing = await import("../runtime/testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const link = loop.link;
  // The decoder worker, in process: the real handler behind a WorkerLike, a fresh one per spawn (B6 respawns after a
  // crash); a terminated one says nothing more.
  let handler!: ReturnType<typeof createDecoderHandler>;
  let worker!: WorkerLike;
  let spawned = 0;
  const spawn = (): WorkerLike => {
    let dead = false;
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m) => void (dead || h.handle(m)),
      terminate() {
        dead = true;
      },
    };
    const h = createDecoderHandler({ post: (reply: DecoderReply) => void (dead || w.onmessage?.({ data: reply })), expectedSourceHash: hash.sourceHash, yieldToEvents: async () => {} });
    handler = h;
    worker = w;
    spawned++;
    return w;
  };
  const decoder = createDecoderClient({ workerFactory: spawn, wasmBytes: options.decoderWasm ?? decoderWasm() });
  let streamPort: ReturnType<typeof channel> | null = null;
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, maxMixed: 8 },
    worldCount: 1,
    sampleRate: RATE,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const settings = defaultAudioSettings();
  if (options.aac) settings.codecs = { aac: true };
  const mixer = new Mixer(settings);
  const backend = new CoreBackend(host, {
    clips: (await import("../runtime/core/clipRegistry")).createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async (path) => options.clipFiles?.[path]?.slice(0) ?? new ArrayBuffer(8),
      decodeWorker: decoder,
      clipFormat: options.clipFormat ?? 0,
      aac: options.aac,
    }),
    clock: loop.clock,
    mixer,
    streams: {
      decoder: () => decoder,
      channel: () => {
        streamPort = channel();
        return { worker: streamPort.a, worklet: streamPort.b };
      },
      connectWorklet: (port) => {
        const driver: CoreDriver = loop.driver;
        (port as StreamPortLike).onmessage = (e) => driver.onStreamMessage(e.data, loop.frame, loop.clock.dateNow());
        driver.setStreamPost((message, transfer) => (port as StreamPortLike).postMessage(message, transfer));
      },
      fetchBytes: async (path) => {
        const f = files[path];
        if (!f) throw new Error(`HTTP 404 (${path})`);
        return f.slice(0);
      },
    },
  });
  const left: number[] = [];
  const right: number[] = [];
  const settle = async () => {
    for (let k = 0; k < 4; k++) await new Promise((r) => setTimeout(r, 0));
  };
  /**
   * `n` frames of `QPF` quanta. `mainStalled`: no frame runs on main and main's `onmessage` holds STATUS (the stall);
   * `workerStalled`: the worker doesn't see credits (it can't decode). The worker→worklet port flows otherwise.
   */
  const step = async (n: number, opts: { mainStalled?: boolean; workerStalled?: boolean } = {}) => {
    const linkPort = (link as unknown as { port: { onmessage: ((e: { data: unknown }) => void) | null } }).port;
    const held: unknown[] = [];
    const saved = linkPort.onmessage;
    const blocks = backend.mirror.blocks;
    if (opts.mainStalled) linkPort.onmessage = (e) => void held.push(e.data);
    for (let f = 0; f < n; f++) {
      if (!opts.mainStalled) {
        mixer.update(FRAME_MS / 1000);
        backend.update(FRAME_MS / 1000);
      }
      for (let q = 0; q < QPF; q++) {
        const out = loop.renderQuanta(1);
        for (const s of out.left) left.push(s);
        for (const s of out.right) right.push(s);
        streamPort?.pump(opts.workerStalled);
      }
      await Promise.resolve();
    }
    /** STATUS blocks main applied during these frames (before the held messages are delivered). */
    const applied = backend.mirror.blocks - blocks;
    if (opts.mainStalled) {
      linkPort.onmessage = saved;
      for (const d of held) saved?.({ data: d });
    }
    return { applied, held: held.length };
  };
  /** Waits (real time: the wasm compiles, the fetch resolves) until the worklet holds `n` open streams. */
  const waitOpen = async (n: number) => {
    await vi.waitFor(
      () => {
        streamPort?.pump();
        expect(loop.driver.openStreams).toBe(n);
      },
      { timeout: 5_000, interval: 5 },
    );
  };
  await settle();
  return {
    loop,
    backend,
    decoder,
    get handler() {
      return handler;
    },
    /** The current "worker" and how many were spawned. */
    worker: () => worker,
    spawned: () => spawned,
    step,
    settle,
    waitOpen,
    left,
    right,
    mixer,
    streamPort: () => streamPort!,
  };
}
