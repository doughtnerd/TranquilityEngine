// The Generator editor's preview off the main thread (ADR 0360 §9): `requestPreview` sends the patch to a worker of
// its own (`preview.worker.ts`, which runs the reference render) and resolves to the waveform's peaks and envelope.
// Only the newest request for a key is answered (an older one resolves to null), so a drag's previews never pile up.
// Where workers don't exist (Node, the Storybook test runner without them) it renders here.
import type { GeneratorBody } from "../../../../engine/audio/generators/types";
import type { PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";
import { peaksFromBase, previewBase, renderGeneratorPreview, PREVIEW_RATE, PREVIEW_SECONDS } from "./referenceRender";

export interface PreviewRequestMessage {
  readonly id: number;
  readonly body: GeneratorBody;
  readonly maxSeconds: number;
}
export type PreviewReplyMessage =
  | {
      readonly id: number;
      readonly base: { binFrames: number; bins: number; data: Int16Array };
      readonly frames: number;
      readonly seconds: number;
      readonly keyOff: number | null;
      readonly endless: boolean;
      readonly envelope: readonly (readonly [number, number])[];
    }
  | { readonly id: number; readonly error: string };

/** What the preview draws. */
export interface PreviewPicture {
  readonly mips: PeakMips;
  readonly seconds: number;
  readonly keyOff: number | null;
  readonly endless: boolean;
  readonly envelope: readonly (readonly [number, number])[];
}

/** The picture of one render (`preview.worker.ts` sends the same parts). */
export function pictureOf(body: GeneratorBody, maxSeconds = PREVIEW_SECONDS): PreviewPicture {
  const r = renderGeneratorPreview(body, maxSeconds);
  return { mips: peaksFromBase(previewBase(r.samples), r.samples.length), seconds: r.seconds, keyOff: r.keyOff, endless: r.endless, envelope: r.envelope };
}

let worker: Worker | null = null;
let serial = 0;
const waiting = new Map<number, (r: PreviewPicture | null) => void>();
const newest = new Map<string, number>();

function previewWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  worker.onmessage = (ev: MessageEvent<PreviewReplyMessage>) => {
    const r = ev.data;
    const done = waiting.get(r.id);
    if (!done) return;
    waiting.delete(r.id);
    if ("error" in r) return done(null);
    done({ mips: peaksFromBase(r.base, r.frames, PREVIEW_RATE), seconds: r.seconds, keyOff: r.keyOff, endless: r.endless, envelope: r.envelope });
  };
  worker.onerror = () => {
    for (const done of waiting.values()) done(null);
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** The preview of `body` for `key` (the open generator); null when a newer request for the key replaced it. */
export function requestPreview(key: string, body: GeneratorBody, maxSeconds = PREVIEW_SECONDS): Promise<PreviewPicture | null> {
  const id = ++serial;
  newest.set(key, id);
  const w = previewWorker();
  if (!w) return Promise.resolve(newest.get(key) === id ? pictureOf(body, maxSeconds) : null);
  return new Promise((resolve) => {
    waiting.set(id, (r) => resolve(newest.get(key) === id ? r : null));
    w.postMessage({ id, body, maxSeconds } satisfies PreviewRequestMessage);
  });
}
