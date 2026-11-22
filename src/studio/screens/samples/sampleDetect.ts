// Detection on the Samples screen (ADR 0328 "detection of what's missing"): the analysers (`engine/audio/sample/detect`)
// run on a worker of their own, so a long file never blocks the screen; the results land in the sidecar through the
// session's undoable commit (`sampleDetectModel.ts` decides what changes). Detect in the Tempo and Root note popovers
// and the import's "Detect what's missing" both come here.
import type { DetectKind, SampleDetection } from "../../../engine/audio/sample/detect/detect";
import { detectSample } from "../../../engine/audio/sample/detect/detect";
import { detectedEdit } from "./sampleDetectModel";
import type { SampleSession } from "./sampleSession";
import type { Pcm } from "./seam";

/** What the detect worker is sent (`detect.worker.ts`). */
export interface DetectRequest {
  readonly id: number;
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
  readonly what: readonly DetectKind[];
}
export type DetectReply = { readonly id: number; readonly result: SampleDetection } | { readonly id: number; readonly error: string };

let worker: Worker | null = null;
let serial = 0;
const waiting = new Map<number, { resolve(r: SampleDetection): void; reject(e: Error): void }>();

function detectWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  worker = new Worker(new URL("./detect.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<DetectReply>) => {
    const w = waiting.get(ev.data.id);
    if (!w) return;
    waiting.delete(ev.data.id);
    if ("error" in ev.data) w.reject(new Error(ev.data.error));
    else w.resolve(ev.data.result);
  };
  worker.onerror = (ev) => {
    // A worker that fails to load or crashes fails what it holds; the next request starts a new one.
    for (const w of waiting.values()) w.reject(new Error(ev.message || "the detection worker stopped"));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Analyse `pcm` for `what` on the detection worker (a copy of the audio is sent, so the caller's stays usable). Where
 * workers don't exist (Node: the exporter, tests), it runs here.
 */
export function detectInBackground(pcm: Pcm, what: readonly DetectKind[]): Promise<SampleDetection> {
  const w = detectWorker();
  if (!w) return Promise.resolve(detectSample(pcm, what));
  const id = ++serial;
  const copy = pcm.pcm.slice();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, pcm: copy, channels: pcm.channels, rate: pcm.rate, what } satisfies DetectRequest, [copy.buffer]);
  });
}

export interface DetectOutcome {
  readonly result: SampleDetection;
  /** True when the sidecar changed. */
  readonly applied: boolean;
  /** Why nothing changed, when nothing did. */
  readonly refused?: string;
}

/** Detect on an open sample: analyse `pcm` (its source audio) and commit what was found as one step ("Detect tempo"). */
export async function detectInto(session: SampleSession, pcm: Pcm, kind: DetectKind): Promise<DetectOutcome> {
  const result = await detectInBackground(pcm, [kind]);
  if (session.readOnly) return { result, applied: false, refused: "the sample is read-only" };
  const edit = detectedEdit(session.edits.peek(), result, [kind], "demand");
  if ("refused" in edit) return { result, applied: false, refused: edit.refused };
  return { result, applied: session.commit(edit) };
}
