// Sample renders for the Samples screen (ADR 0342): `renderSample` on a worker of its own (`render.worker.ts`), so a
// long render never blocks the screen, and the project's render cache in `.myco/cache/samples/` (`renderCache.ts`), so
// a render of unchanged edits is read back instead of made again. Where workers don't exist (Node: tests, the
// exporter), the render runs here.
import { renderSample, type RenderedSample, type SamplePcm } from "../../../engine/audio/sample/sampleRender";
import type { RenderStore } from "../../../engine/audio/sample/renderCache";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { joinPath } from "../../../editor/projectPaths";
import type { EditorProject } from "../../../editor/projects";

export interface RenderRequest {
  readonly id: number;
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
  readonly edits: SampleEdits;
}
export type RenderReply =
  | { readonly id: number; readonly pcm: Float32Array; readonly channels: number; readonly rate: number; readonly frames: number; readonly warnings: string[] }
  | { readonly id: number; readonly error: string };

let worker: Worker | null = null;
let serial = 0;
const waiting = new Map<number, { resolve(r: RenderedSample): void; reject(e: Error): void }>();

function renderWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  worker = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<RenderReply>) => {
    const w = waiting.get(ev.data.id);
    if (!w) return;
    waiting.delete(ev.data.id);
    const r = ev.data;
    if ("error" in r) w.reject(new Error(r.error));
    else w.resolve({ pcm: r.pcm, channels: r.channels, rate: r.rate, frames: r.frames, warnings: r.warnings });
  };
  worker.onerror = (ev) => {
    for (const w of waiting.values()) w.reject(new Error(ev.message || "the render worker stopped"));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** `renderSample` on the render worker (a copy of the source PCM is sent). */
export function renderInBackground(pcm: SamplePcm, edits: SampleEdits): Promise<RenderedSample> {
  const w = renderWorker();
  if (!w) return renderSample(pcm, edits);
  const id = ++serial;
  const copy = pcm.pcm.slice();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, pcm: copy, channels: pcm.channels, rate: pcm.rate, edits } satisfies RenderRequest, [copy.buffer]);
  });
}

/** The project's render cache (`.myco/cache/samples/`, per machine), through its folder; reads miss without a folder. */
export function projectRenderStore(project: EditorProject): RenderStore {
  const fs = project.fileSystem, root = project.root;
  return {
    read: async (path) => {
      if (!fs || !root) return null;
      const abs = joinPath(root, path);
      return (await fs.exists(abs)) ? fs.readBinary(abs) : null;
    },
    write: async (path, bytes) => {
      if (!fs || !root) return;
      await fs.mkdir(joinPath(root, path.slice(0, path.lastIndexOf("/"))));
      await fs.writeBinary(joinPath(root, path), bytes);
    },
  };
}
