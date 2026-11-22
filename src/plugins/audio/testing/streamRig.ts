// The loopback rig for streams (B3, shared with B4's loop-seam test): the core as production assembles it
// (`loopbackAudio`, ADR 0221) with the real decoder handler in process behind a WorkerLike, and the backend's own channel
// from the "worker" to the shell. ADR 0223: the backend hands the shell its end with `CoreLink.connectStreamPort`, as in a
// page, and the loopback serves that `streamPort` control as `worklet/processor.ts` does; nothing here wires the driver.
// Test-only (imports vitest).
import { expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultAudioSettings } from "../../../engine/audio/settings";
import hash from "../runtime/wasm/hash.json";
import { createDecoderHandler } from "../runtime/decoder/handler";
import { createDecoderClient, type WorkerLike } from "../runtime/decoder/decoderClient";
import type { DecoderReply, PackRef, StreamPortLike } from "../runtime/decoder/protocol";

import { ClipFormat, CLIP_CHUNK_FIXED_END, Kind, readClipBegin, readClipChunk, readClipUnload, readEnvelope, readStreamChunk, readStreamClose, readStreamOpen } from "../runtime/wire.generated";

const WASM = readFileSync(fileURLToPath(new URL("../runtime/wasm/myco_audio_decode.wasm", import.meta.url)));
export const decoderWasm = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
export const RATE = 48_000;
/** Quanta per frame (a 60 Hz frame is 6.25 quanta at 48 kHz; 4 keeps the arithmetic whole). */
export const QPF = 4;
export const FRAME_MS = (QPF * 128 * 1000) / RATE;
/** 5 ms at 48 kHz: the starvation fade. */
export const FADE = 240;

/** What the worklet received on its port from the decoder worker (read off the channel: the wire between them). */
export interface WorkletReceived {
  /** Streams opened and not closed on the current port (a new port starts again at none, as the shell closes the old). */
  readonly open: number;
  /** STREAM_CHUNKs received, over every port. */
  readonly chunks: number;
  /** Stream frames those chunks carried. */
  readonly frames: number;
  /** Distinct chunk buffers among them: the worker's allocations (the rest came back with credits and were reused). */
  readonly buffers: number;
  /** Zone kernels begun (CLIP_BEGIN format 3) and not unloaded on the current port. */
  readonly kernels: number;
  /** Kernel bytes the CLIP_CHUNKs carried, over every port. */
  readonly kernelBytes: number;
}

/** A queued two-ended port pair: `pump()` delivers what was posted, both ways, until both queues are empty. */
export function channel(onDeliverToB?: (message: unknown) => void) {
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
        for (const m of toB.splice(0)) {
          onDeliverToB?.(m);
          b.onmessage?.({ data: m });
        }
        if (!aStalled) for (const m of toA.splice(0)) a.onmessage?.({ data: m });
      }
    },
  };
}

/** What `rig` takes besides the files (B4). */
export interface RigOptions {
  /** The decoder wasm's bytes (default the committed `myco_audio_decode.wasm`; B4 passes the AAC build). */
  readonly decoderWasm?: ArrayBuffer;
  /** The clip registry's format (default 0, f32; 1 is i16): `audio.clipFormat`. */
  readonly clipFormat?: number;
  /** Files the clip registry fetches (default: none, every clip fetch gives 8 bytes). */
  readonly clipFiles?: Record<string, ArrayBuffer>;
  /** `audio.codecs.aac` (B4). */
  readonly aac?: boolean;
  /** ADR 0162 zone slots for the core (default none). */
  readonly zones?: { readonly maxZoneSlots: number; readonly zoneMaxSeconds: number };
  /** ADR 0166 (R4b): the music ring pool (`audio.music.rings`) for the core (default 0: none). */
  readonly musicRings?: number;
  /** ADR 0337 A4: which paths are entries of a package the rig's decoder holds (`decoder.loadPack`), for clips and streams alike. */
  readonly packRef?: (path: string) => PackRef | null;
}

export async function rig(files: Record<string, ArrayBuffer>, options: RigOptions = {}) {
  const { loopbackAudio, closeLoopbackAudio } = await import("../runtime/testing");
  // The decoder worker, in process: the real handler behind a WorkerLike, a fresh one per spawn (B6 respawns after a
  // crash); a terminated one says nothing more.
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
    worker = w;
    spawned++;
    return w;
  };
  const decoder = createDecoderClient({ workerFactory: spawn, wasmBytes: options.decoderWasm ?? decoderWasm() });

  // What the worklet receives on its port, read off the channel.
  const open = new Set<number>();
  const kernels = new Set<number>();
  const chunkBuffers = new Set<ArrayBuffer>();
  const received = { chunks: 0, frames: 0, kernelBytes: 0 };
  const observe = (m: unknown) => {
    if (!(m instanceof ArrayBuffer) || m.byteLength < 16) return;
    const view = new DataView(m);
    const envelope = readEnvelope(view, 0);
    switch (envelope.kind) {
      case Kind.STREAM_OPEN:
        open.add(readStreamOpen(view, 0).streamId);
        return;
      case Kind.STREAM_CLOSE:
        open.delete(readStreamClose(view, 0).streamId);
        return;
      case Kind.STREAM_CHUNK:
        received.chunks++;
        received.frames += readStreamChunk(view, 0).frames;
        chunkBuffers.add(m);
        return;
      case Kind.CLIP_BEGIN: {
        const begin = readClipBegin(view, 0);
        if (begin.format === ClipFormat.ZoneKernel) kernels.add(begin.clipId);
        return;
      }
      case Kind.CLIP_CHUNK:
        if (kernels.has(readClipChunk(view, 0).clipId)) received.kernelBytes += 16 + envelope.bodyBytes - CLIP_CHUNK_FIXED_END;
        return;
      case Kind.CLIP_UNLOAD:
        kernels.delete(readClipUnload(view, 0).clipId);
        return;
    }
  };
  let streamPort: ReturnType<typeof channel> | null = null;
  /** `workerStalled`: the worker doesn't see the worklet's credits (it can't decode). The worker→worklet port flows otherwise. */
  let workerStalled = false;

  const settings = defaultAudioSettings();
  settings.clipFormat = (options.clipFormat ?? 0) === 0 ? "f32" : "i16";
  if (options.aac) settings.codecs = { aac: true };
  const audio = await loopbackAudio({
    mixer: "own",
    settings,
    preset: { limiterLookaheadMs: 0, ...options.zones, maxMusicRings: options.musicRings ?? 0 },
    quantaPerFrame: QPF,
    dt: FRAME_MS / 1000,
    clipRegistry: {
      fetchBytes: async (path) => options.clipFiles?.[path]?.slice(0) ?? new ArrayBuffer(8),
      decodeWorker: decoder,
      ...(options.packRef ? { packRef: options.packRef } : {}),
    },
    backend: {
      streams: {
        decoder: () => decoder,
        channel: () => {
          streamPort = channel(observe);
          open.clear();
          kernels.clear();
          return { worker: streamPort.a, worklet: streamPort.b };
        },
        fetchBytes: async (path) => {
          const f = files[path];
          if (!f) throw new Error(`HTTP 404 (${path})`);
          return f.slice(0);
        },
        ...(options.packRef ? { packRef: options.packRef } : {}),
      },
    },
    eachQuantum: () => streamPort?.pump(workerStalled),
  });
  if (!audio) return null;
  const { backend, link, mixer } = audio;
  const left: number[] = [];
  const right: number[] = [];
  const keep = (out: { left: Float32Array; right: Float32Array }) => {
    for (const s of out.left) left.push(s);
    for (const s of out.right) right.push(s);
  };
  const settle = async () => {
    for (let k = 0; k < 4; k++) await new Promise((r) => setTimeout(r, 0));
  };
  /**
   * `n` frames of `QPF` quanta. `mainStalled`: the loopback's main-thread stall (`stallMain`): no frame runs on main and
   * what the core sends main waits until the stall ends; `workerStalled`: the worker doesn't see credits.
   */
  const step = async (n: number, opts: { mainStalled?: boolean; workerStalled?: boolean } = {}) => {
    workerStalled = opts.workerStalled === true;
    try {
      if (!opts.mainStalled) {
        keep(await audio.step(n));
        return { applied: 0, held: 0 };
      }
      const blocks = link.statusCount;
      const stall = audio.stallMain();
      for (let f = 0; f < n; f++) {
        keep(audio.render(QPF));
        await Promise.resolve();
      }
      /** STATUS blocks main applied during these frames (before the held messages are delivered). */
      const applied = link.statusCount - blocks;
      const held = stall.held;
      stall.release();
      return { applied, held };
    } finally {
      workerStalled = false;
    }
  };
  /** Waits (real time: the wasm compiles, the fetch resolves) until the worklet's port has opened `n` streams. */
  const waitOpen = async (n: number) => {
    await vi.waitFor(
      () => {
        streamPort?.pump();
        expect(open.size).toBe(n);
      },
      { timeout: 5_000, interval: 5 },
    );
  };
  await settle();
  return {
    audio,
    link,
    backend,
    decoder,
    /** The current "worker" and how many were spawned. */
    worker: () => worker,
    spawned: () => spawned,
    /** What the worklet has received on its port so far. */
    worklet: (): WorkletReceived => ({ open: open.size, chunks: received.chunks, frames: received.frames, buffers: chunkBuffers.size, kernels: kernels.size, kernelBytes: received.kernelBytes }),
    step,
    settle,
    waitOpen,
    left,
    right,
    mixer,
    streamPort: () => streamPort!,
    /** Closes the backend and the host (also `closeLoopbackAudio` in an `afterEach`). */
    close: () => closeLoopbackAudio(),
  };
}
