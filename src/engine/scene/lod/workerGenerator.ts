/**
 * LOD generation in a Web Worker (ADR 0446 §1): the editor's model load hands each mesh to one worker (`worker.ts`) and
 * awaits its levels, so meshoptimizer and the Hausdorff sampling stay off the main thread. Internal: not public API.
 *
 * The protocol is two ends of a message port: `lodGeneratorOver` (the editor's side) and `serveLodGeneration` (the
 * worker's). Requests copy the mesh; replies transfer the generated arrays.
 */
import type { LodSettings, OccluderSetting } from "./types";
import { generateLods, type GeneratedLods, type LodSource } from "./generate";
import type { LodGenerator } from "./cache";
import { streamArrays } from "./streams";

/** A request to the worker. */
interface LodRequest {
  readonly id: number;
  readonly source: LodSource;
  readonly settings: LodSettings;
  readonly occluder: OccluderSetting;
}

/** The worker's reply: the levels, or why it failed. */
type LodReply = { readonly id: number; readonly lods: GeneratedLods } | { readonly id: number; readonly error: string };

/** One end of a message channel (a Worker, the worker's own scope, or a `MessagePort`). */
export interface LodPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** Every buffer of `lods`, once each (the occluder shares its level's indices). */
function transferList(lods: GeneratedLods): Transferable[] {
  const buffers = new Set<ArrayBufferLike>();
  for (const a of streamArrays(lods.streams)) buffers.add(a.buffer);
  for (const l of lods.levels) buffers.add(l.indices.buffer);
  if (lods.occluder) buffers.add(lods.occluder.indices.buffer);
  return [...buffers] as Transferable[];
}

/** The worker's side: answers every request on `port` with `generateLods`. */
export function serveLodGeneration(port: LodPort): void {
  port.addEventListener("message", (event) => {
    const request = event.data as LodRequest;
    generateLods(request.source, request.settings, request.occluder).then(
      (lods) => port.postMessage({ id: request.id, lods } satisfies LodReply, transferList(lods)),
      (err: unknown) => port.postMessage({ id: request.id, error: (err as Error)?.message ?? String(err) } satisfies LodReply),
    );
  });
}

/** The editor's side: a generator that sends each mesh over `port` and resolves with the reply. */
export function lodGeneratorOver(port: LodPort): LodGenerator {
  let nextId = 1;
  const waiting = new Map<number, { resolve: (lods: GeneratedLods) => void; reject: (err: Error) => void }>();
  port.addEventListener("message", (event) => {
    const reply = event.data as LodReply;
    const w = waiting.get(reply.id);
    if (!w) return;
    waiting.delete(reply.id);
    if ("error" in reply) w.reject(new Error(reply.error));
    else w.resolve(reply.lods);
  });
  return (source, settings, occluder) =>
    new Promise<GeneratedLods>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      port.postMessage({ id, source, settings, occluder } satisfies LodRequest);
    });
}

/** The editor's generator: one module Worker running `worker.ts`, started on first use. */
export function workerLodGenerator(): LodGenerator {
  let generator: LodGenerator | null = null;
  return (source, settings, occluder) => {
    if (!generator) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      generator = lodGeneratorOver(worker);
    }
    return generator(source, settings, occluder);
  };
}
