// The Generator editor's preview worker (ADR 0360 §9): runs the pure resolve and the JS reference render
// (`referenceRender.ts`) off the page and replies with the waveform's base peak level and the envelope
// (`previewClient.ts` is the client).
import type { PreviewReplyMessage, PreviewRequestMessage } from "./previewClient";
import { previewBase, renderGeneratorPreview } from "./referenceRender";

const scope = self as unknown as { onmessage: ((ev: MessageEvent<PreviewRequestMessage>) => void) | null; postMessage(reply: PreviewReplyMessage, transfer?: Transferable[]): void };

scope.onmessage = (ev) => {
  const { id, body, maxSeconds } = ev.data;
  try {
    const r = renderGeneratorPreview(body, maxSeconds);
    const base = previewBase(r.samples);
    scope.postMessage({ id, base, frames: r.samples.length, seconds: r.seconds, keyOff: r.keyOff, endless: r.endless, envelope: r.envelope }, [base.data.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
